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
        // Heartbeat in onStart so the diagnostic strip moves off
        // "waiting…" the moment the system loads, even before game_ready.
        this.scene.events.ui.emit("hud_update", {
            healthBarsDebug: {
                running: true, gameActive: false,
                hasWorldToScreen: !!(this.scene && this.scene.worldToScreen),
                allies: 0, enemies: 0, tracked: 0, onscreen: 0, offscreen: 0,
                phase: "onStart"
            }
        });
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
        // Membership in the FSM's active_systems list already gates this
        // — onUpdate only runs when the battle state is active. A
        // separate _gameActive flag based on game_ready/battle_start was
        // a redundant gate AND a footgun: gameplay.on_enter emits
        // game.game_ready BEFORE the battle substate's active_systems
        // are spun up, so onStart subscribed too late and the handler
        // never fired. Just always run.
        var debug = {
            running: true,
            gameActive: true,
            hasWorldToScreen: !!(this.scene && this.scene.worldToScreen),
            allies: 0, enemies: 0,
            tracked: 0, onscreen: 0, offscreen: 0
        };

        if (!this.scene || !this.scene.worldToScreen) {
            this.scene.events.ui.emit("hud_update", { healthBars: [], healthBarsDebug: debug });
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
        var stats = { tracked: 0, onscreen: 0, offscreen: 0 };
        this._project(allies, bars, stats);
        this._project(enemies, bars, stats);

        debug.allies = allies.length;
        debug.enemies = enemies.length;
        debug.tracked = stats.tracked;
        debug.onscreen = stats.onscreen;
        debug.offscreen = stats.offscreen;
        if (stats.canvasW) debug.canvasW = stats.canvasW;
        if (stats.scale) debug.scale = stats.scale;

        this.scene.events.ui.emit("hud_update", { healthBars: bars, healthBarsDebug: debug });
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

    _project(entities, out, stats) {
        // The HUD iframe gets transform:scale(canvas_w/1920) applied by
        // html_ui_manager when the canvas is narrower than 1920px (always
        // is, in practice). Its internal coordinate space stays 1920-wide,
        // so a worldToScreen result in canvas pixels has to be remapped to
        // iframe pixels = canvas_px * 1920 / canvas_w. Compute the scale
        // here once per frame and pass it to the HUD as a multiplier.
        var canvasW = 1920;
        if (typeof document !== "undefined") {
            var c = document.querySelector(".viewport-canvas-container canvas");
            if (c && c.clientWidth) canvasW = c.clientWidth;
        }
        // applyScale only kicks in when the canvas is narrower than 1920;
        // at >=1920 the iframe is 1:1 with the canvas. transform:scale is
        // uniform, so the same scale applies to both axes.
        var scale = (canvasW < 1920) ? (1920 / canvasW) : 1;
        stats.canvasW = canvasW;
        stats.scale = scale;

        for (var i = 0; i < entities.length; i++) {
            var e = entities[i];
            var row = this._hp[e.id];
            if (!row) continue;
            if (row.current <= 0) continue;
            stats.tracked++;
            var pos = e.transform.position;
            var sp = this.scene.worldToScreen(pos.x, pos.y + this._heightAbove, pos.z);
            if (!sp) { stats.offscreen++; continue; }
            stats.onscreen++;
            var pct = row.current / row.max;
            out.push({
                id: String(e.id),
                x: sp.x * scale,
                y: sp.y * scale,
                pct: pct,
                hp: Math.ceil(row.current),
                max: Math.ceil(row.max),
                isEnemy: row.isEnemy
            });
        }
    }
}
