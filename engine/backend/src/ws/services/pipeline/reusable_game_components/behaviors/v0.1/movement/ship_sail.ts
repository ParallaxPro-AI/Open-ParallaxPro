// also: nautical, ocean simulation, momentum physics, sail control, naval gameplay
// Ship sailing — physics-based sail/rudder model for a multiplayer captain.
//
// Ship holds two pieces of state — sail level (0..1 throttle) and rudder
// angle (-1..1 turn). W/S nudge sail level toward full/furled, A/D set
// the rudder. Velocity is derived from heading * sailLevel * maxSpeed
// with a slow lerp so the ship feels weighty: it doesn't snap to top
// speed and it carries momentum after you furl. Ships gently rock on
// their roll/pitch axes so the sea feels alive even when stationary.
//
// Multiplayer: only the local-owner peer reads input; remote proxies
// receive transform snapshots and skip the input/physics path entirely.
// Ship that's been sunk (ship_health._sunk) freezes in place.
class ShipSailBehavior extends GameScript {
    _behaviorName = "ship_sail";
    _maxSpeed = 12;
    _reverseMax = 4;
    _sailUpRate = 0.6;        // how fast W raises sail level
    _sailDownRate = 1.0;      // how fast S furls (faster than raising — drag)
    _accelLerp = 1.4;         // how aggressively current speed chases target speed
    _turnSpeed = 26;          // degrees/sec at full rudder, scaled by speedFactor
    _rudderRate = 2.4;        // how fast A/D push the rudder
    _rudderRecenter = 1.6;    // how fast rudder relaxes to 0 with no input
    _rollAmplitude = 4;       // degrees of side-to-side bob
    _pitchAmplitude = 2;      // degrees of bow rise/fall
    _bobFreq = 0.55;          // Hz of the wave bob
    _waterLine = 0.0;         // y-position the ship floats at when level
    _collisionLead = 5.0;     // distance ahead of origin to start the forward raycast (ship half-length)
    _collisionPadding = 0.5;  // extra distance past the proposed move to treat as a collision
    _sailUpSound = "";
    _sailDownSound = "";

    _sailLevel = 0;
    _rudder = 0;
    _curSpeed = 0;
    _yawDeg = 0;
    _bobPhase = 0;
    _matchOver = false;
    _initYawApplied = false;

    onStart() {
        var self = this;
        // Capture the spawn-time y as the resting water line so the bob /
        // sink animation can return to it predictably.
        var pos = this.entity.transform.position;
        if (pos && typeof pos.y === "number") this._waterLine = pos.y;
        this._bobPhase = Math.random() * Math.PI * 2;
        this.scene.events.game.on("match_started", function() {
            self._matchOver = false;
            self._sailLevel = 0;
            self._rudder = 0;
            self._curSpeed = 0;
        });
        this.scene.events.game.on("match_ended", function() {
            self._matchOver = true;
        });
    }

    onUpdate(dt) {
        // Skip remote proxies — their transform comes from snapshots.
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        var isProxy = ni && !ni.isLocalPlayer;
        if (isProxy) {
            // Proxy still gets the bob so the ship visually rocks even
            // though the snapshot only carries the base transform.
            this._applyWaveBob(dt, /*driveYaw*/false);
            return;
        }

        if (this._matchOver) {
            // Match-end freeze — kinematic ships don't carry momentum so
            // there's nothing to zero out; we just stop reading input.
            return;
        }

        // Frozen if sunk — ship_health flips _sunk on hull <= 0 and runs
        // the sink animation by directly setting the transform y.
        var hull = this.entity.getScript ? this.entity.getScript("ShipHealthBehavior") : null;
        if (hull && hull._sunk) return;

        var sailUp = this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp");
        var sailDown = this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown");
        var turnLeft = this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft");
        var turnRight = this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight");
        var fullSail = this.input.isKeyDown("ShiftLeft");

        // Sail level — W raises, S furls. Shift snaps full sail.
        var prevSail = this._sailLevel;
        if (fullSail) {
            this._sailLevel = Math.min(1, this._sailLevel + this._sailUpRate * 1.5 * dt);
        } else if (sailUp) {
            this._sailLevel = Math.min(1, this._sailLevel + this._sailUpRate * dt);
        } else if (sailDown) {
            // Reverse only kicks in when sails are fully furled.
            if (this._sailLevel > 0.05) {
                this._sailLevel = Math.max(0, this._sailLevel - this._sailDownRate * dt);
            } else {
                this._sailLevel = Math.max(-1, this._sailLevel - this._sailDownRate * 0.5 * dt);
            }
        }
        // Audio nudges only when crossing meaningful thresholds.
        if (this._sailUpSound && this.audio && prevSail < 0.6 && this._sailLevel >= 0.6) {
            this.audio.playSound(this._sailUpSound, 0.35);
        }
        if (this._sailDownSound && this.audio && prevSail > 0.05 && this._sailLevel <= 0.05) {
            this.audio.playSound(this._sailDownSound, 0.3);
        }

        // Rudder lerp — relax to 0 when neither held.
        var rudderInput = (turnRight ? 1 : 0) - (turnLeft ? 1 : 0);
        if (rudderInput !== 0) {
            this._rudder += rudderInput * this._rudderRate * dt;
            if (this._rudder > 1) this._rudder = 1;
            if (this._rudder < -1) this._rudder = -1;
        } else {
            // Recenter
            if (this._rudder > 0) this._rudder = Math.max(0, this._rudder - this._rudderRecenter * dt);
            else if (this._rudder < 0) this._rudder = Math.min(0, this._rudder + this._rudderRecenter * dt);
        }

        // Target speed = sailLevel * maxSpeed. Reverse maxes at _reverseMax.
        var targetSpeed = this._sailLevel * (this._sailLevel >= 0 ? this._maxSpeed : this._reverseMax);
        var t = 1 - Math.exp(-this._accelLerp * dt);
        this._curSpeed += (targetSpeed - this._curSpeed) * t;

        // Steering — only effective when underway. Speed factor lets sharp
        // ships still pivot a bit in dead water but mostly need momentum.
        var speedFactor = Math.min(1, Math.abs(this._curSpeed) / 2);
        var dir = this._curSpeed >= 0 ? 1 : -1;
        this._yawDeg += this._rudder * dir * this._turnSpeed * speedFactor * dt;
        // Wrap so we don't drift toward huge values.
        while (this._yawDeg > 180) this._yawDeg -= 360;
        while (this._yawDeg < -180) this._yawDeg += 360;

        // Move via setPosition because the ship is kinematic — no physics
        // velocity to integrate. Vertical y stays at the water line; the
        // bob animation tweaks rotation only.
        var yawRad = this._yawDeg * Math.PI / 180;
        var pos = this.entity.transform.position;
        var nx = pos.x + Math.sin(yawRad) * this._curSpeed * dt;
        var nz = pos.z + (-Math.cos(yawRad)) * this._curSpeed * dt;
        // Soft bay boundary so ships can't sail into infinity. The visible
        // border buoys sit at ±150; clamp slightly inside that.
        var bound = 145;
        if (nx < -bound) nx = -bound;
        if (nx > bound) nx = bound;
        if (nz < -bound) nz = -bound;
        if (nz > bound) nz = bound;
        // Collision: cast a ray from the entity origin along the motion
        // vector. Length = halfLength + per-frame move + small padding.
        // Our own collider is excluded via entity.id, so the ray flies
        // through us. We only block when the hit is past the bow
        // (distance >= _collisionLead): hits at smaller distances mean
        // we're already overlapping something and need to escape, not
        // get pinned harder. _curSpeed is zeroed so a held-W throttle
        // doesn't re-ram the obstacle every frame.
        var moveDx = nx - pos.x;
        var moveDz = nz - pos.z;
        var moveDist = Math.sqrt(moveDx * moveDx + moveDz * moveDz);
        if (moveDist > 0.001 && this.scene.raycast) {
            var dxN = moveDx / moveDist;
            var dzN = moveDz / moveDist;
            var rayLen = this._collisionLead + moveDist + this._collisionPadding;
            var hit = this.scene.raycast(pos.x, this._waterLine + 0.5, pos.z,
                                         dxN, 0, dzN,
                                         rayLen,
                                         this.entity.id);
            if (hit && hit.distance >= this._collisionLead) {
                nx = pos.x; nz = pos.z;
                this._curSpeed = 0;
            }
        }
        if (this.scene.setPosition) this.scene.setPosition(this.entity.id, nx, this._waterLine, nz);

        // Apply yaw + wave bob. Wave bob rolls the hull side-to-side and
        // pitches the bow so the ship reads as floating instead of skating.
        this._applyWaveBob(dt, /*driveYaw*/true);

        // Share state for camera + cannon behaviors.
        this.scene._shipYaw = this._yawDeg;
        this.scene._shipSailLevel = this._sailLevel;
        this.scene._shipSpeed = this._curSpeed;

        // HUD updates
        if (this.scene.events && this.scene.events.ui) {
            var pct = Math.round(Math.max(0, this._sailLevel) * 100);
            this.scene.events.ui.emit("hud_update", {
                shipStatus: {
                    sailPct: pct,
                    rudder: Math.round(this._rudder * 100),
                    speedKmh: Math.round(Math.abs(this._curSpeed) * 3.6),
                    reverse: this._curSpeed < 0,
                },
            });
        }
    }

    _applyWaveBob(dt, driveYaw) {
        this._bobPhase += dt * (this._bobFreq * Math.PI * 2);
        if (this._bobPhase > Math.PI * 2) this._bobPhase -= Math.PI * 2;
        var roll = Math.sin(this._bobPhase) * this._rollAmplitude;
        var pitch = Math.cos(this._bobPhase * 0.7) * this._pitchAmplitude;
        var yaw = driveYaw ? -this._yawDeg : 0;
        if (this.entity.transform && this.entity.transform.setRotationEuler) {
            // Convention: setRotationEuler(pitch_x, yaw_y, roll_z). Pitch
            // is around the world X axis, roll around world Z, yaw is
            // around world Y. Sign of yaw matches camera_galleon's
            // expectation (player faces -Z when yaw=0).
            this.entity.transform.setRotationEuler(pitch, yaw, roll);
        }
    }
}
