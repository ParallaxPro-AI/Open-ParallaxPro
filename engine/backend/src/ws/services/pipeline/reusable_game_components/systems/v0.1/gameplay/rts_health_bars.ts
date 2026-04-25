// also: RTS HUD, world-space health bars, ally/enemy indicators, on-screen HP
// RTS health bars — tracks current/max HP for every active player- and
// enemy-side entity and projects each to screen-space so the
// rts_health_bars HUD can render a coloured bar above the unit.
//
// The engine has no built-in HealthComponent, so health is reconstructed
// from the existing event stream: each entity is initialised to a
// per-tag default max on first sight, `entity_damaged` decrements the
// current HP, and `entity_killed` drops the row. This stays in sync
// with the per-behavior _health values that unit_combat / worker_ai /
// hostile_mob already maintain because every damage / death goes
// through the same events bus.
class RTSHealthBarsSystem extends GameScript {
    _gameActive = false;
    _hp = {};       // { id: { current, max, isEnemy, yOffset } }
    _heightAbove = 2.4; // world-units to lift the bar above the entity origin
    _publishEvery = 0;  // frames since last publish
    _publishInterval = 1; // publish every frame; raise to throttle if 50+ units

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() {
            self._gameActive = true;
            self._hp = {};
        });
        this.scene.events.game.on("battle_start", function() {
            self._gameActive = true;
        });
        this.scene.events.game.on("entity_damaged", function(d) {
            if (!d || d.targetId == null) return;
            var row = self._hp[d.targetId];
            if (!row) return; // not tracked yet — will be picked up next frame
            row.current = Math.max(0, row.current - (d.damage || 0));
        });
        this.scene.events.game.on("entity_healed", function(d) {
            if (!d || d.targetId == null) return;
            var row = self._hp[d.targetId];
            if (!row) return;
            row.current = Math.min(row.max, row.current + (d.amount || 0));
        });
        this.scene.events.game.on("entity_killed", function(d) {
            if (!d) return;
            var id = d.entityId != null ? d.entityId : d.targetId;
            if (id == null) return;
            delete self._hp[id];
        });
    }

    onUpdate(dt) {
        if (!this._gameActive) return;
        if (!this.scene.worldToScreen) return;

        // Re-scan every frame so newly produced units / spawned enemies pick
        // up bars without needing a custom spawn event.
        var allies = this._collect([
            this.scene.findEntitiesByTag("player_unit") || [],
            this.scene.findEntitiesByTag("worker") || [],
            this.scene.findEntitiesByTag("player_building") || []
        ], false);
        var enemies = this._collect([
            this.scene.findEntitiesByTag("enemy_unit") || [],
            this.scene.findEntitiesByTag("enemy_building") || []
        ], true);

        var bars = [];
        this._project(allies, bars);
        this._project(enemies, bars);

        this.scene.events.ui.emit("hud_update", { healthBars: bars });
    }

    // Build a flat, de-duplicated list of {entity, isEnemy} from tag pools,
    // initialising HP rows with a default-max keyed on entity tags.
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
                    this._hp[e.id] = {
                        current: this._defaultMax(e),
                        max: this._defaultMax(e),
                        isEnemy: isEnemy
                    };
                }
                out.push(e);
            }
        }
        return out;
    }

    _defaultMax(entity) {
        var tags = entity.tags || [];
        var hasTag = function(t) {
            for (var i = 0; i < tags.length; i++) if (tags[i] === t) return true;
            return false;
        };
        // Tag-based defaults — match the per-behavior _health initial values
        // already set in unit_combat / worker_ai / hostile_mob / boss_ai.
        if (hasTag("worker")) return 40;
        if (hasTag("player_building") || hasTag("enemy_building")) return 500;
        if (hasTag("siege_tank") || hasTag("battle_mech")) return 200;
        if (hasTag("tank") || hasTag("mech")) return 150;
        if (hasTag("medic")) return 80;
        return 100;
    }

    _project(entities, out) {
        for (var i = 0; i < entities.length; i++) {
            var e = entities[i];
            var row = this._hp[e.id];
            if (!row) continue;
            if (row.current <= 0) continue;
            var pos = e.transform.position;
            var sp = this.scene.worldToScreen(pos.x, pos.y + this._heightAbove, pos.z);
            if (!sp) continue;          // off-camera or behind frustum
            // Only show partial-HP bars for allies' workers / enemies that
            // haven't been touched yet, to keep the screen quieter — but
            // always show enemies and damaged allies.
            var pct = row.current / row.max;
            if (!row.isEnemy && pct >= 0.999) continue;
            out.push({
                id: String(e.id),
                x: sp.x,
                y: sp.y,
                pct: pct,
                hp: Math.ceil(row.current),
                max: Math.ceil(row.max),
                isEnemy: row.isEnemy
            });
        }
    }
}
