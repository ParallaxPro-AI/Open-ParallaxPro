// also: racing, drift, boost, power-up, arcade-racer
// Kart drive — arcade kart-racing controls with drift-boost.
//
// W/S accel + brake, A/D steer. Hold Space while turning to enter
// "drift" mode: rear-end slips, drift charge accumulates over time.
// Release Space to fire a mini-boost whose strength scales with the
// drift charge (no boost on a tap, blue spark mid, orange spark max).
// Hold E to fire the currently-held power-up — the kart_race system
// owns the power-up behavior, this script just publishes the intent.
//
// Multiplayer: only the local owner reads input. Remote proxies share
// the script but skip the input path; their transform comes from
// snapshots.
//
// Reusable: any arcade kart racer / hover-racer wanting drift-boost.
// All physics tunables (accel, max speed, turn rate, drift slip,
// charge thresholds, boost strengths) are parameters.
class KartDriveBehavior extends GameScript {
    _behaviorName = "kart_drive";
    _acceleration = 28;
    _maxSpeed = 26;
    _reverseMax = 9;
    _baseFriction = 7;
    _coastFriction = 4;
    _brakeForce = 42;
    _turnSpeed = 95;              // degrees/sec at full input + max speed
    _driftTurnBonus = 35;         // extra deg/sec while drifting
    _driftSlide = 0.55;           // sideways carry during a drift
    _driftMinSpeed = 6;           // need this much forward to enter drift
    _driftLevelMidSec = 0.9;      // hold this long for a mid (blue) boost
    _driftLevelMaxSec = 1.7;      // hold this long for a max (orange) boost
    _midBoostMs = 700;
    _maxBoostMs = 1200;
    _midBoostMul = 1.25;
    _maxBoostMul = 1.45;
    _boostMul = 1.0;              // current boost multiplier (1 = none)
    _boostMs = 0;                 // remaining boost duration
    _arenaRadius = 250;
    _spawnY = 0.6;
    _engineSound = "";
    _driftStartSound = "";
    _driftBoostSound = "";
    _powerupUseSound = "";

    // State
    _speed = 0;
    _yawDeg = 0;
    _slip = 0;
    _drifting = false;
    _driftHold = 0;               // seconds held in drift
    _driftDir = 0;                // -1 left, +1 right
    _matchOver = false;
    _interactCooldownMs = 0;

    onStart() {
        var self = this;
        var pos = this.entity.transform && this.entity.transform.position;
        this.scene.events.game.on("match_started", function() {
            self._matchOver = false;
            self._speed = 0;
            self._slip = 0;
            self._drifting = false;
            self._driftHold = 0;
            self._boostMul = 1.0;
            self._boostMs = 0;
        });
        this.scene.events.game.on("match_ended", function() { self._matchOver = true; });

        // Kart_race grants boost rewards via the existing player_repair
        // event (reused as "give the local kart a boost")
        this.scene.events.game.on("player_repair", function(d) {
            if (!d) return;
            var amount = d.amount || 0.5;
            self._boostMul = Math.max(self._boostMul, 1.0 + amount);
            self._boostMs = Math.max(self._boostMs, 1500 + amount * 1000);
        });
    }

    onUpdate(dt) {
        if (!this.entity || !this.entity.transform) return;
        if (this._matchOver) return;
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        if (ni && !ni.isLocalPlayer) return;

        var throttle = 0, steer = 0;
        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp"))    throttle += 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown"))  throttle -= 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft"))  steer    -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) steer    += 1;

        var driftKeyDown = this.input.isKeyDown && this.input.isKeyDown("Space");

        // Speed integration.
        if (throttle > 0) {
            this._speed += this._acceleration * dt;
        } else if (throttle < 0) {
            if (this._speed > 0) this._speed -= this._brakeForce * dt;
            else                 this._speed -= this._acceleration * 0.5 * dt;
        } else {
            if (this._speed > 0) this._speed = Math.max(0, this._speed - this._coastFriction * dt);
            if (this._speed < 0) this._speed = Math.min(0, this._speed + this._coastFriction * dt);
        }
        // Apply boost decay.
        if (this._boostMs > 0) {
            this._boostMs -= dt * 1000;
            if (this._boostMs <= 0) {
                this._boostMs = 0;
                this._boostMul = 1.0;
            }
        }
        var maxFwd = this._maxSpeed * this._boostMul;
        this._speed = Math.max(-this._reverseMax, Math.min(maxFwd, this._speed));

        // Drift entry: must be moving forward fast enough + Space pressed + steering.
        if (!this._drifting && driftKeyDown && this._speed > this._driftMinSpeed && Math.abs(steer) > 0.05) {
            this._drifting = true;
            this._driftHold = 0;
            this._driftDir = (steer > 0) ? 1 : -1;
            if (this._driftStartSound && this.audio) {
                try { this.audio.playSound(this._driftStartSound, 0.32); } catch (e) { /* nop */ }
            }
        }
        // Drift exit on key release → grant boost based on hold time.
        if (this._drifting && !driftKeyDown) {
            if (this._driftHold >= this._driftLevelMaxSec) {
                this._boostMul = this._maxBoostMul;
                this._boostMs = this._maxBoostMs;
                if (this._driftBoostSound && this.audio) {
                    try { this.audio.playSound(this._driftBoostSound, 0.4); } catch (e) { /* nop */ }
                }
            } else if (this._driftHold >= this._driftLevelMidSec) {
                this._boostMul = this._midBoostMul;
                this._boostMs = this._midBoostMs;
                if (this._driftBoostSound && this.audio) {
                    try { this.audio.playSound(this._driftBoostSound, 0.32); } catch (e) { /* nop */ }
                }
            }
            this._drifting = false;
            this._driftHold = 0;
        }
        if (this._drifting) {
            this._driftHold += dt;
            // While drifting force steer toward drift dir (matches kart feel)
            steer = this._driftDir;
        }

        // Steering proportional to ground speed.
        var speedFactor = Math.min(1, Math.abs(this._speed) / 4);
        var steerDir = this._speed >= 0 ? 1 : -1;
        var turnRate = this._turnSpeed + (this._drifting ? this._driftTurnBonus : 0);
        this._yawDeg += steer * steerDir * turnRate * speedFactor * dt;

        // Slip lerp (drift slide).
        var targetSlip = this._drifting ? this._driftDir * 0.85 : steer * 0.18;
        this._slip += (targetSlip - this._slip) * Math.min(1, 7 * dt);

        // World-space velocity.
        var yawRad = this._yawDeg * Math.PI / 180;
        var fwdX = Math.sin(yawRad), fwdZ = -Math.cos(yawRad);
        var rightX = Math.cos(yawRad), rightZ = Math.sin(yawRad);
        var vx = fwdX * this._speed + rightX * this._slip * Math.abs(this._speed) * this._driftSlide;
        var vz = fwdZ * this._speed + rightZ * this._slip * Math.abs(this._speed) * this._driftSlide;

        var pos = this.entity.transform.position;
        var nx = pos.x + vx * dt;
        var nz = pos.z + vz * dt;
        var r2 = nx * nx + nz * nz;
        if (r2 > this._arenaRadius * this._arenaRadius) {
            var ang = Math.atan2(nx, nz);
            nx = Math.sin(ang) * this._arenaRadius;
            nz = Math.cos(ang) * this._arenaRadius;
            this._speed *= 0.5;
        }
        if (this.scene.setPosition) this.scene.setPosition(this.entity.id, nx, this._spawnY, nz);
        if (this.entity.transform.setRotationEuler) {
            this.entity.transform.setRotationEuler(0, -this._yawDeg, 0);
        }

        // Power-up use (E key) — emit intent the system handles.
        if (this.input.isKeyPressed && this.input.isKeyPressed("KeyE")) {
            this.scene.events.game.emit("player_action", { action: "kart_use_powerup" });
            if (this._powerupUseSound && this.audio) {
                try { this.audio.playSound(this._powerupUseSound, 0.32); } catch (e) { /* nop */ }
            }
        }

        // Share state for the camera + race system.
        this.scene._kart = this.scene._kart || {};
        this.scene._kart.yaw = this._yawDeg;
        this.scene._kart.speed = this._speed;
        this.scene._kart.absSpeed = Math.abs(this._speed);
        this.scene._kart.boost = this._boostMul;
        this.scene._kart.boostRemaining = this._boostMs;
        this.scene._kart.drifting = this._drifting;
        this.scene._kart.driftHold = this._driftHold;
        this.scene._kart.driftLevel = this._driftLevelOf(this._driftHold);
        this.scene._kart.position = { x: nx, z: nz };

        // Speedometer HUD.
        var kmh = Math.round(Math.abs(this._speed) * 3.6);
        this.scene.events.ui.emit("hud_update", {
            speed: kmh,
            kartDriver: {
                speedKmh: kmh,
                drifting: this._drifting,
                driftLevel: this.scene._kart.driftLevel,
                boostMs: this._boostMs,
            },
        });
    }

    _driftLevelOf(hold) {
        if (hold >= this._driftLevelMaxSec) return "max";
        if (hold >= this._driftLevelMidSec) return "mid";
        return "none";
    }
}
