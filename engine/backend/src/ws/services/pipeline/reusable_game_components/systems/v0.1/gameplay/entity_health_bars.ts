// also: world-space HP bars, ally/enemy indicators, on-screen health, generic
// Entity health bars — generic world-anchored HP overlay driven by the
// existing entity_damaged / entity_healed / entity_killed event stream.
//
// Each template configures which tag pools are friendly vs hostile, and
// the system tracks current/max HP per entity, projects each origin to
// screen-space via worldToScreen, and publishes a flat array of bar
// records that the entity_health_bars HUD renders. Output coords are
// pre-scaled by 1920/canvas_w so the iframe's transform:scale (applied
// by html_ui_manager whenever the canvas is narrower than 1920px) lands
// each bar at the correct visual position.
//
// Params (set in 04_systems.json):
//   allyTags        — string[] of tags whose entities count as allies
//   enemyTags       — string[] of tags whose entities count as enemies
//   showAllies      — render bars over ally entities too (default false).
//   defaultMax      — fallback max HP if neither name nor tag matches
//                     (default 100).
//   hpOverrides     — { key: hp } map. Lookup priority is:
//                     entity.name → each tag in entity.tags → defaultMax.
//                     Use entity-name keys (e.g. "blue_minion": 200) for
//                     exact matches when same-tag entities have different
//                     HPs; fall back to tag keys (e.g. "tower": 2000) when
//                     a whole group of units share the same value.
//   heightAbove     — world-units to lift the bar above origin (default 2.4).
class EntityHealthBarsSystem extends GameScript {
    _allyTags = [];
    _enemyTags = [];
    _showAllies = false;
    _defaultMax = 100;
    _hpOverrides = {};
    _heightAbove = 2.4;

    _hp = {};

    onStart() {
        var self = this;
        // The codebase emits damage events under two shapes:
        //   { targetId, damage } — used by ~17 behaviors (unit_combat,
        //     hero_combat, fps_combat, melee_combat, ranged_combat …).
        //   { entityId, amount } — used by ~7 behaviors (minion_ai,
        //     hostile_mob, caster_mob, boss_ai …) and matches the
        //     event_definitions.ts declared schema.
        // Same split exists for entity_killed (entityId vs targetId) and
        // for entity_healed. Read whichever is present so per-behavior HP
        // stays in sync with the bars regardless of which dialect a given
        // behavior happens to use.
        this.scene.events.game.on("game_ready", function() { self._hp = {}; });
        this.scene.events.game.on("entity_damaged", function(d) {
            if (!d) return;
            var id = d.targetId != null ? d.targetId : d.entityId;
            if (id == null) return;
            var row = self._hp[id];
            if (!row) return;
            var dmg = (d.damage != null) ? d.damage : (d.amount || 0);
            row.current = Math.max(0, row.current - dmg);
        });
        this.scene.events.game.on("entity_healed", function(d) {
            if (!d) return;
            var id = d.targetId != null ? d.targetId : d.entityId;
            if (id == null) return;
            var row = self._hp[id];
            if (!row) return;
            row.current = Math.min(row.max, row.current + (d.amount || 0));
        });
        this.scene.events.game.on("entity_killed", function(d) {
            if (!d) return;
            var id = d.entityId != null ? d.entityId : d.targetId;
            if (id == null) return;
            delete self._hp[id];
        });

        // Respawn events: hero_combat / player_vitals reset their internal
        // _health to _maxHealth and re-emit player_respawned (or
        // entity_respawned) without deactivating the entity. From this
        // system's POV the row stayed at current=0 since lethal damage
        // landed, so the bar would never come back. Drop every tracked
        // row on respawn — _collect re-initialises each entity at full
        // HP on the next frame.
        var resetAll = function() {
            self._hp = {};
        };
        this.scene.events.game.on("player_respawned", resetAll);
        this.scene.events.game.on("entity_respawned", resetAll);
    }

    onUpdate(dt) {
        if (!this.scene || !this.scene.worldToScreen) {
            this.scene.events.ui.emit("hud_update", { healthBars: [] });
            return;
        }

        var enemyPools = [];
        for (var ei = 0; ei < this._enemyTags.length; ei++) {
            enemyPools.push(this.scene.findEntitiesByTag(this._enemyTags[ei]) || []);
        }
        var allyPools = [];
        if (this._showAllies) {
            for (var ai = 0; ai < this._allyTags.length; ai++) {
                allyPools.push(this.scene.findEntitiesByTag(this._allyTags[ai]) || []);
            }
        }

        var enemies = this._collect(enemyPools, true);
        var allies = this._showAllies ? this._collect(allyPools, false) : [];

        var bars = [];
        var canvasW = 1920;
        if (typeof document !== "undefined") {
            var c = document.querySelector(".viewport-canvas-container canvas");
            if (c && c.clientWidth) canvasW = c.clientWidth;
        }
        var scale = (canvasW < 1920) ? (1920 / canvasW) : 1;

        this._project(enemies, bars, scale);
        if (this._showAllies) this._project(allies, bars, scale);

        this.scene.events.ui.emit("hud_update", { healthBars: bars });
    }

    _collect(pools, isEnemy) {
        var out = [];
        var seen = {};
        for (var p = 0; p < pools.length; p++) {
            var arr = pools[p];
            for (var i = 0; i < arr.length; i++) {
                var e = arr[i];
                if (!e || !e.active) continue;
                var key = "k" + e.id;
                if (seen[key]) continue;
                seen[key] = true;
                if (!this._hp[e.id]) {
                    var max = this._maxFor(e);
                    this._hp[e.id] = { current: max, max: max, isEnemy: isEnemy };
                }
                out.push(e);
            }
        }
        return out;
    }

    _maxFor(entity) {
        // Most-specific match first: entity name (def key) → tags → default.
        // Engine sets entity.name from the def key (e.g. "blue_minion").
        // Some entity types may use a different name field; cover the
        // common ones defensively.
        var name = entity.name || (entity.def && entity.def.name) || "";
        if (name) {
            var v = this._hpOverrides[name];
            if (typeof v === "number") return v;
        }
        var tags = entity.tags || [];
        for (var i = 0; i < tags.length; i++) {
            var t = this._hpOverrides[tags[i]];
            if (typeof t === "number") return t;
        }
        return this._defaultMax;
    }

    _project(entities, out, scale) {
        for (var i = 0; i < entities.length; i++) {
            var e = entities[i];
            var row = this._hp[e.id];
            if (!row) continue;
            if (row.current <= 0) continue;
            var pos = e.transform.position;
            var sp = this.scene.worldToScreen(pos.x, pos.y + this._heightAbove, pos.z);
            if (!sp) continue;
            out.push({
                id: String(e.id),
                x: sp.x * scale,
                y: sp.y * scale,
                pct: row.current / row.max,
                hp: Math.ceil(row.current),
                max: Math.ceil(row.max),
                isEnemy: row.isEnemy
            });
        }
    }
}
