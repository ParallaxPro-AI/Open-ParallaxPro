// also: circle, damage, radius, battle royale, storm, ring
// Zone system — shrinking safe zone that damages entities outside the ring
class ZoneSystem extends GameScript {
    _startRadius = 55;
    _zoneRadius = 55;
    _targetRadius = 55;
    _shrinkSpeed = 0;
    _damageRate = 5;
    _damageTick = 0;
    _phase = 0;
    _phaseTimer = 0;
    // Phases: [[waitSeconds, targetRadius, shrinkDuration], ...]
    _phases = [[50, 35, 30], [40, 18, 25], [30, 6, 20]];
    _shrinking = false;
    _shrinkTimer = 0;

    onStart() {
        this._zoneRadius = this._startRadius;
        this._targetRadius = this._startRadius;
        this._phase = 0;
        this._phaseTimer = 0;
        this._shrinking = false;

        var self = this;
        this.scene.events.game.on("game_ready", function() {
            self._zoneRadius = self._startRadius;
            self._targetRadius = self._startRadius;
            self._phase = 0;
            self._phaseTimer = 0;
            self._shrinking = false;
            self._shrinkSpeed = 0;
        });
    }

    onUpdate(dt) {
        // Phase timer
        if (!this._shrinking && this._phase < this._phases.length) {
            this._phaseTimer += dt;
            var phaseCfg = this._phases[this._phase];
            if (this._phaseTimer >= phaseCfg[0]) {
                // Begin shrinking
                this._shrinking = true;
                this._targetRadius = phaseCfg[1];
                this._shrinkSpeed = (this._zoneRadius - phaseCfg[1]) / phaseCfg[2];
                this._shrinkTimer = phaseCfg[2];
            }
        }

        // Shrink zone
        if (this._shrinking) {
            this._zoneRadius -= this._shrinkSpeed * dt;
            this._shrinkTimer -= dt;
            if (this._zoneRadius <= this._targetRadius || this._shrinkTimer <= 0) {
                this._zoneRadius = this._targetRadius;
                this._shrinking = false;
                this._phase++;
                this._phaseTimer = 0;
            }
        }

        // Damage entities outside zone (once per second)
        this._damageTick -= dt;
        if (this._damageTick <= 0) {
            this._damageTick = 1.0;

            // Damage player
            var player = this.scene.findEntityByName("Player");
            if (player && player.active) {
                var pp = player.transform.position;
                if (Math.sqrt(pp.x * pp.x + pp.z * pp.z) > this._zoneRadius) {
                    this.scene.events.game.emit("entity_damaged", { entityId: player.id, amount: this._damageRate, source: "zone" });
                }
            }

            // Damage enemies outside zone
            var enemies = this.scene.findEntitiesByTag("enemy");
            if (enemies) {
                for (var i = 0; i < enemies.length; i++) {
                    var e = enemies[i];
                    if (!e || !e.active) continue;
                    var ep = e.transform.position;
                    if (Math.sqrt(ep.x * ep.x + ep.z * ep.z) > this._zoneRadius) {
                        this.scene.events.game.emit("entity_damaged", { entityId: e.id, amount: this._damageRate, source: "zone" });
                    }
                }
            }
        }

        // Send zone state to HUD
        var nextShrink = 0;
        if (!this._shrinking && this._phase < this._phases.length) {
            nextShrink = this._phases[this._phase][0] - this._phaseTimer;
        }

        this.scene.events.ui.emit("hud_update", {
            zoneRadius: Math.round(this._zoneRadius),
            zonePhase: this._phase + 1,
            zoneMaxPhases: this._phases.length,
            zoneShrinkIn: Math.max(0, Math.round(nextShrink)),
            zoneShrinking: this._shrinking
        });
    }
}
