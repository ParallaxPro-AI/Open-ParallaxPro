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
//
// Output coords are remapped from canvas pixels (worldToScreen output)
// to iframe pixels (1920-wide internal) — html_ui_manager's
// transform:scale takes them back to the visually correct canvas px.
class RTSHealthBarsSystem extends GameScript {
    _hp = {};       // { id: { current, max, isEnemy } }
    _heightAbove = 2.4; // world-units to lift the bar above the entity origin

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() { self._hp = {}; });
        this.scene.events.game.on("entity_damaged", function(d) {
            if (!d || d.targetId == null) return;
            var row = self._hp[d.targetId];
            if (!row) return; // not tracked yet — picked up next frame
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
        if (!this.scene || !this.scene.worldToScreen) {
            this.scene.events.ui.emit("hud_update", { healthBars: [] });
            return;
        }

        // Re-scan every frame so newly produced units / spawned enemies
        // pick up bars without needing a custom spawn event.
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
        // html_ui_manager applies transform:scale(canvas_w/1920) when the
        // canvas is narrower than 1920px and stretches the iframe layout
        // box to keep its internal coordinate space at 1920. worldToScreen
        // returns canvas-pixel coords, so we have to scale them back up to
        // iframe coords; the iframe's transform then renders them at the
        // correct visual position.
        var canvasW = 1920;
        if (typeof document !== "undefined") {
            var c = document.querySelector(".viewport-canvas-container canvas");
            if (c && c.clientWidth) canvasW = c.clientWidth;
        }
        var scale = (canvasW < 1920) ? (1920 / canvasW) : 1;

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
