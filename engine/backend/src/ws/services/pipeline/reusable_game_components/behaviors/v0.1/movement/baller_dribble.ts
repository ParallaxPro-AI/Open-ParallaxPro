// also: sports, ball-control, passing, court, basketball
// Baller dribble — top-down WASD basketball movement.
//
// Kinematic position integration with smooth turning + sprint, soft
// court boundary, and a tiny "ball-handling" yaw lean when carrying.
// The player's hasBall flag is owned by the court system and read off
// scene._court.ballHolder. When holding the ball the script halves
// sprint speed (you can't dunk-sprint) and forwards the cur direction
// to scene._court.ballHolderHeading so passes can fire forward.
//
// Multiplayer: only the local owner reads input. Remote proxies
// receive transform via snapshots.
//
// Reusable: any top-down WASD ball-game where you carry an item that
// sits in your hands. Speed/turn/sprint are all params.
class BallerDribbleBehavior extends GameScript {
    _behaviorName = "baller_dribble";
    _speed = 6.5;
    _sprintSpeed = 9.5;
    _ballSpeedFactor = 0.85;       // slowed when carrying the ball
    _turnRate = 12;                // visual yaw lerp toward movement dir
    _arenaHalfX = 22;
    _arenaHalfZ = 11;
    _passKey = "KeyE";
    _stealKey = "KeyF";
    _shootKey = "Space";
    _stepSound = "";
    _stepCadence = 0.34;

    _xVel = 0;
    _zVel = 0;
    _facing = 0;                   // visual yaw radians
    _moveYaw = 0;
    _stepTimer = 0;
    _matchOver = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("match_started", function() {
            self._matchOver = false;
        });
        this.scene.events.game.on("match_ended", function() {
            self._matchOver = true;
        });
    }

    onUpdate(dt) {
        if (!this.entity || !this.entity.transform) return;
        if (this._matchOver) return;
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        if (ni && !ni.isLocalPlayer) return;

        var fwd = 0, strafe = 0;
        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp"))    fwd    += 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown"))  fwd    -= 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft"))  strafe -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) strafe += 1;
        var sprint = this.input.isKeyDown && this.input.isKeyDown("ShiftLeft");

        var hasBall = this._iHaveBall();
        var maxSpeed = sprint ? this._sprintSpeed : this._speed;
        if (hasBall) maxSpeed *= this._ballSpeedFactor;

        // No movement while charging a shot — locks the player so the
        // shot meter is satisfying. baller_shot writes scene._shotCharging.
        var charging = !!this.scene._shotCharging;
        if (charging) {
            fwd = 0;
            strafe = 0;
        }

        var moveLen = Math.sqrt(fwd * fwd + strafe * strafe);
        if (moveLen > 0.01) {
            var nfwd = fwd / moveLen, nstrafe = strafe / moveLen;
            this._xVel = nstrafe * maxSpeed;
            this._zVel = -nfwd * maxSpeed;
            // Negate both args so the model faces the direction of motion
            // (engine Y-rotation is CCW-from-above; the unnegated form
            // points the player 180° opposite the velocity vector).
            this._moveYaw = Math.atan2(-nstrafe, nfwd);
        } else {
            this._xVel = 0;
            this._zVel = 0;
        }

        // Dynamic body + setVelocity so Rapier auto-resolves vs hoops /
        // court structures. Soft velocity clamp at the court edge replaces
        // the old hard pos clamp so we don't fight physics. vy preserved
        // from the rigidbody so gravity holds the baller on the court.
        var pos = this.entity.transform.position;
        var vx = this._xVel, vz = this._zVel;
        if (pos.x >  this._arenaHalfX && vx > 0) vx = 0;
        if (pos.x < -this._arenaHalfX && vx < 0) vx = 0;
        if (pos.z >  this._arenaHalfZ && vz > 0) vz = 0;
        if (pos.z < -this._arenaHalfZ && vz < 0) vz = 0;
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = (rb && rb.getLinearVelocity) ? (rb.getLinearVelocity().y || 0) : 0;
        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });

        // Smooth visual yaw toward movement direction.
        if (moveLen > 0.01) {
            var d = this._moveYaw - this._facing;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            this._facing += d * Math.min(1, this._turnRate * dt);
        }
        if (this.entity.transform.setRotationEuler) {
            this.entity.transform.setRotationEuler(0, this._facing * 180 / Math.PI, 0);
        }

        // Footstep cadence.
        if (this._stepSound && this.audio && (Math.abs(this._xVel) + Math.abs(this._zVel)) > 0.5) {
            this._stepTimer -= dt;
            if (this._stepTimer <= 0) {
                this._stepTimer = this._stepCadence * (sprint ? 0.7 : 1);
                try { this.audio.playSound(this._stepSound, 0.18); } catch (e) { /* nop */ }
            }
        } else {
            this._stepTimer = 0;
        }

        // Forward action key intents — the court system listens.
        if (this.input.isKeyPressed) {
            if (this.input.isKeyPressed(this._passKey)) {
                this.scene.events.game.emit("player_action", { action: "baller_pass" });
            }
            if (this.input.isKeyPressed(this._stealKey)) {
                this.scene.events.game.emit("player_action", { action: "baller_steal" });
            }
        }

        // Share local heading + position for the court system.
        this.scene._court = this.scene._court || {};
        this.scene._court.ballHolderHeading = this._facing;
        this.scene._court.localPos = { x: nx, z: nz };
        this.scene._court.localFacing = this._facing;
    }

    _iHaveBall() {
        var ct = this.scene._court;
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        return !!(ct && ct.ballHolder === localPeerId);
    }
}
