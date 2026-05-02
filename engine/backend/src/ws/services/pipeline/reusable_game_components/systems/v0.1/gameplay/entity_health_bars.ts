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
//   occlusionCheck  — if true, raycast from the camera to each entity's
//                     bar position and skip bars that are blocked by
//                     world geometry (walls, terrain). Important for
//                     first-person games so health bars don't act as
//                     wallhacks. Off by default — top-down / 3rd-person
//                     games rarely need it and the per-frame raycast
//                     adds cost.
class EntityHealthBarsSystem extends GameScript {
    _allyTags = [];
    _enemyTags = [];
    _showAllies = false;
    _defaultMax = 100;
    _hpOverrides = {};
    _heightAbove = 2.4;
    _occlusionCheck = false;
    _hideLocalPlayer = false; // skip the local player's own bar (MOBA convention — own HP is on the top HUD, floating bar would just clutter the screen).

    _hp = {};
    _camera = null;

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
        // Bar map clears on Play Again. Templates use either "game_ready"
        // (most), "match_started" (buccaneer_bay), or "restart_game" — wire
        // all three so old bars don't persist into the next match no matter
        // which flow convention the template follows.
        var clearBars = function() { self._hp = {}; };
        this.scene.events.game.on("game_ready", clearBars);
        this.scene.events.game.on("match_started", clearBars);
        this.scene.events.game.on("restart_game", clearBars);
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
            // Pin to 0 instead of deleting. Many AI behaviors keep the
            // entity active for a couple of seconds while a death
            // animation plays — if we delete the row, _collect on the
            // next frame sees the still-active entity, doesn't find a
            // row, and creates a fresh one with current=max. The bar
            // flashes back to full above the dying corpse. Setting
            // current=0 keeps _project skipping the bar (its `if
            // (row.current <= 0) continue` guard fires) until the entity
            // actually deactivates or Play Again clears the table.
            var row = self._hp[id];
            if (row) row.current = 0;
        });

        // Respawn events: hero_combat / player_vitals reset their internal
        // _health to _maxHealth and re-emit player_respawned (or
        // entity_respawned) without deactivating the entity. From this
        // system's POV the row stayed at current=0 since lethal damage
        // landed, so the bar would never come back. Refill every row
        // whose current is 0 — the affected entity's HP is now max
        // again, while partially-damaged enemies keep their state so
        // they don't visibly "heal" for one frame.
        var refillDeadRows = function() {
            for (var id in self._hp) {
                var row = self._hp[id];
                if (row && row.current <= 0) row.current = row.max;
            }
        };
        this.scene.events.game.on("player_respawned", refillDeadRows);
        // entity_respawned was authored speculatively but no script in the
        // codebase emits it — listener was permanently dead. Drop it; the
        // player_respawned event above covers the only live respawn path.
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
        // Look up the camera lazily once so first-person occlusion checks
        // have somewhere to ray from. Cache it so we don't query scene.find
        // every frame.
        var cam = this._occlusionCheck ? this._getCamera() : null;
        var cp = cam ? cam.transform.position : null;
        // Dedup pushes — _collect runs twice (enemyPools then allyPools)
        // and templates with overlapping ally/enemy tags (e.g. rift_1v1
        // listing "champion" in both) end up projecting each entity
        // twice. The HTML pool keys by id so only one element survives,
        // but the wasted work compounds in larger matches.
        var seenIds = out.__seenIds || (out.__seenIds = {});

        for (var i = 0; i < entities.length; i++) {
            var e = entities[i];
            var row = this._hp[e.id];
            if (!row) continue;
            if (row.current <= 0) continue;
            if (seenIds[e.id]) continue;
            // MOBA-style template: hide the floating bar above your own
            // champion so the player's own HP only shows on the top HUD.
            if (this._hideLocalPlayer) {
                var niSelf = e.getComponent ? e.getComponent("NetworkIdentityComponent") : null;
                if (niSelf && niSelf.isLocalPlayer) continue;
            }
            seenIds[e.id] = true;
            var pos = e.transform.position;
            var by = pos.y + this._heightAbove;

            // Wall-hack guard: cast a ray from the camera to the chest
            // point and only render the bar if the first thing the ray
            // hits is this entity (or nothing — in which case the path
            // is clear). Skips bars that would otherwise show through
            // walls in fps games.
            if (cp && this.scene.raycast) {
                var rdx = pos.x - cp.x;
                var rdy = by - cp.y;
                var rdz = pos.z - cp.z;
                var rdist = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
                if (rdist > 0.05) {
                    var inv = 1 / rdist;
                    var hit = this.scene.raycast(cp.x, cp.y, cp.z, rdx * inv, rdy * inv, rdz * inv, rdist + 0.5);
                    if (hit && hit.entityId !== e.id && hit.distance < rdist - 0.25) continue;
                }
            }

            var sp = this.scene.worldToScreen(pos.x, by, pos.z);
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

    _getCamera() {
        if (this._camera && this._camera.active) return this._camera;
        this._camera = this.scene.findEntityByName("Camera") || null;
        return this._camera;
    }
}
