// also: light cycle, boost meter, trail mechanics, racing, neon cycles, client-side prediction
// Bike player control — client-authoritative steering for a light cycle.
//
// Each peer drives its own bike with A/D (steer), W or Shift (boost),
// and S (brake). The bike auto-rolls forward at baseSpeed; players don't
// control throttle directly. This keeps round pacing predictable and
// makes trail-collision tactics — not lap-time optimisation — the game.
//
// Boost drains a per-bike meter (boostMax → 0) and regenerates while
// not boosting. Holding W AND being out of boost just rolls at base
// speed — the boost button is a tap-to-engage, not a hold-to-throttle.
//
// State for the camera / trail emitter / HUD is stashed on
// scene._neonCycles[ownerId] so other components can read it without
// hand-rolling per-bike lookups. Most cross-component coordination
// (round phase, alive flag, color) flows through that map.
//
// Remote proxies skip the input read but still participate in
// scene._neonCycles bookkeeping (alive flag, last-known yaw) so the
// camera can spectate-follow a fallen local player onto the leader.
class BikePlayerControlBehavior extends GameScript {
    _behaviorName = "bike_player_control";
    _baseSpeed = 12;
    _boostMultiplier = 1.7;
    _brakeMultiplier = 0.45;
    _turnRateDeg = 180;
    _boostMax = 100;
    _boostDrainPerSec = 35;
    _boostRegenPerSec = 18;
    _engineSound = "";
    _boostSound = "";
    _turnSound = "";
    _crashSound = "";

    _alive = true;
    _canControl = false;
    _yawDeg = 0;
    _boost = 100;
    _boosting = false;
    _braking = false;
    _peerId = "";
    _isLocal = false;
    _lastTurnSampleYaw = 0;
    _engineHandle = null;
    _engineCooldown = 0;
    _crashFx = 0;
    _speedRamp = 1;

    onStart() {
        var self = this;
        this._boost = this._boostMax;
        this._yawDeg = this._readYawDeg();
        this._lastTurnSampleYaw = this._yawDeg;

        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        this._peerId = (ni && ni.ownerId) || "";
        this._isLocal = !!(ni && ni.isLocalPlayer);
        this._registerSelf();

        // ── Round / match coordination ──
        this.scene.events.game.on("round_started", function() {
            self._alive = true;
            self._canControl = false;
            self._boost = self._boostMax;
            self._crashFx = 0;
            // Restore visible scale in case we shrunk on crash.
            self.scene.setScale && self.scene.setScale(self.entity.id, 1, 1, 1);
            // Re-read yaw — match system places the bike facing inward.
            var y = self._readYawDeg();
            self._yawDeg = y;
            self._lastTurnSampleYaw = y;
            self._registerSelf();
        });
        this.scene.events.game.on("countdown_done", function() {
            self._canControl = true;
        });
        this.scene.events.game.on("round_ended", function() {
            self._canControl = false;
        });
        this.scene.events.game.on("match_ended", function() {
            self._canControl = false;
        });

        // Both flavours: locally-emitted bike_crashed (host's collision check
        // raises this directly on the host's bus) AND net_bike_crashed
        // (everyone else gets it as a relayed net.* event). Treat them the
        // same — first one to land wins, the second is a no-op.
        this.scene.events.game.on("bike_crashed", function(d) {
            self._handleCrash((d && d.peerId) || "");
        });
        this.scene.events.game.on("net_bike_crashed", function(evt) {
            var d = (evt && evt.data) || {};
            self._handleCrash(d.peerId || "");
        });

        // Match restart from game-over screen → reset everything.
        this.scene.events.game.on("match_started", function() {
            self._alive = true;
            self._boost = self._boostMax;
            self._canControl = false;
            self.scene.setScale && self.scene.setScale(self.entity.id, 1, 1, 1);
        });
    }

    onUpdate(dt) {
        if (!this.entity || !this.entity.transform) return;

        // Speed ramp tunable lives on the match system; mirror it locally so
        // every peer sees the same pace even with intermittent host sync.
        var nc = this.scene._neonCycles || {};
        if (typeof nc.speedRamp === "number") this._speedRamp = nc.speedRamp;

        // Crash freeze frame — short pulse so the explosion VFX is readable
        // before the bike disappears entirely.
        if (this._crashFx > 0) {
            this._crashFx -= dt;
            if (this._crashFx <= 0) {
                this.scene.setScale && this.scene.setScale(this.entity.id, 0, 0, 0);
            }
        }

        if (!this._alive) {
            this._publishHud();
            return;
        }

        // Remote proxies don't read input but still need to publish their
        // alive/yaw state so the camera can fall back to a spectator target.
        if (!this._isLocal) {
            this._yawDeg = this._readYawDeg();
            this._registerSelf();
            return;
        }

        // ── Read input ──
        var steer = 0;
        var wantBoost = false;
        var wantBrake = false;
        if (this._canControl && this.input) {
            // A/D signs are set so the bike turns the way the player sees
            // on screen: the chase camera's view maps world +X to screen
            // left, so "left" = steer toward +X = positive yaw delta.
            if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft"))  steer += 1;
            if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) steer -= 1;
            wantBoost = this.input.isKeyDown("ShiftLeft") || this.input.isKeyDown("ShiftRight") || this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp");
            wantBrake = this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown");
        }

        // ── Steering ──
        if (steer !== 0) {
            this._yawDeg += steer * this._turnRateDeg * dt;
            // Wrap to [-180, 180] so trig stays in-range over long rounds.
            if (this._yawDeg > 180) this._yawDeg -= 360;
            else if (this._yawDeg < -180) this._yawDeg += 360;

            // Pulse a turn sound + fire bike_turned every ~25° so audio is
            // a feedback for the player, not a constant whine.
            var dY = this._yawDeg - this._lastTurnSampleYaw;
            while (dY > 180) dY -= 360;
            while (dY < -180) dY += 360;
            if (Math.abs(dY) >= 25) {
                this._lastTurnSampleYaw = this._yawDeg;
                if (this.audio && this._turnSound) this.audio.playSound(this._turnSound, 0.18);
                this.scene.events.game.emit("bike_turned", { peerId: this._peerId });
            }
        }

        // ── Boost meter ──
        this._boosting = false;
        if (this._canControl && wantBoost && this._boost > 0) {
            this._boost -= this._boostDrainPerSec * dt;
            if (this._boost < 0) this._boost = 0;
            this._boosting = true;
            // Soft engine spin-up — only kick the boost sound if we just
            // engaged (not every frame), tracked by a tiny cooldown.
            this._engineCooldown -= dt;
            if (this._engineCooldown <= 0) {
                if (this.audio && this._boostSound) this.audio.playSound(this._boostSound, 0.22);
                this._engineCooldown = 0.6;
            }
        } else {
            // Regen only while not actively boosting; lets a player who
            // emptied the bar get a top-up if they coast for a moment.
            this._boost += this._boostRegenPerSec * dt;
            if (this._boost > this._boostMax) this._boost = this._boostMax;
            if (this._engineCooldown > 0) this._engineCooldown -= dt;
        }
        this._braking = wantBrake;

        // ── Forward motion ──
        // Gate on _canControl too — the bike auto-rolls, so without this
        // it would drift through the pre-round countdown and wall itself
        // before the player ever got to steer.
        // Dynamic body + setVelocity so Rapier auto-resolves against the
        // arena walls and corner pylons (the old kinematic + pos+= write
        // teleported through them). Gravity + the ground entity keep the
        // bike at rest on the floor; no manual Y lock needed.
        var yawRad = this._yawDeg * Math.PI / 180;
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = (rb && rb.getLinearVelocity) ? (rb.getLinearVelocity().y || 0) : 0;
        if (this._canControl) {
            var speedMult = 1;
            if (this._boosting) speedMult = this._boostMultiplier;
            else if (this._braking) speedMult = this._brakeMultiplier;
            var speed = this._baseSpeed * this._speedRamp * speedMult;
            this.scene.setVelocity(this.entity.id, {
                x: Math.sin(yawRad) * speed,
                y: vy,
                z: Math.cos(yawRad) * speed,
            });
        } else {
            // Pre-round / dead — kill horizontal motion so the bike doesn't
            // coast forward into walls during the countdown.
            this.scene.setVelocity(this.entity.id, { x: 0, y: vy, z: 0 });
        }

        // setRotationEuler takes DEGREES (scriptTransform adapter). Passing
        // radians here is what was making A/D feel like a translate instead
        // of a steer — the visual rotation was clamped to tiny angles while
        // the motion math used the full radian value.
        // +180 visual offset: motion math uses forward = (sin, cos) (+Z at
        // yaw 0), but the GLB's native forward is -Z. Without the offset
        // the bike's nose points opposite the direction of travel — looks
        // like the rider is going in reverse. _yawDeg stays as the logical
        // motion-direction yaw so camera/trail/match math is unchanged.
        this.entity.transform.setRotationEuler(0, this._yawDeg + 180, 0);
        this.entity.transform.markDirty && this.entity.transform.markDirty();

        this._registerSelf();
        this._publishHud();
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    _handleCrash(peerId) {
        if (!peerId || peerId !== this._peerId) return;
        if (!this._alive) return;
        this._alive = false;
        this._canControl = false;
        // Brief on-screen freeze (mesh stays for ~0.3s) so the VFX reads
        // before the entity collapses to scale 0. Shrink — not destroy —
        // because round_started restores it without re-spawning.
        this._crashFx = 0.3;
        if (this.audio && this._crashSound) this.audio.playSound(this._crashSound, 0.5);
        this._registerSelf();
        this._publishHud();
    }

    _readYawDeg() {
        // scriptTransform exposes rotation as a quaternion but has no
        // getRotationEuler, so derive yaw from the quat directly. Assumes
        // yaw-dominant rotations (no significant pitch/roll on the bike).
        // The visual rotation carries a +180 offset vs the logical motion
        // yaw (see onUpdate), so subtract it back out and re-wrap so all
        // callers receive a value in the same convention as _yawDeg.
        if (!this.entity.transform) return 0;
        var q = this.entity.transform.rotation;
        if (!q) return 0;
        var qx = q.x || 0, qy = q.y || 0, qz = q.z || 0, qw = q.w != null ? q.w : 1;
        var yawRad = Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qx * qx));
        var deg = yawRad * 180 / Math.PI - 180;
        if (deg > 180) deg -= 360;
        else if (deg < -180) deg += 360;
        return deg;
    }

    _registerSelf() {
        if (!this.scene._neonCycles) this.scene._neonCycles = {};
        if (!this.scene._neonCycles.bikes) this.scene._neonCycles.bikes = {};
        var entry = this.scene._neonCycles.bikes[this._peerId] || {};
        entry.alive = !!this._alive;
        entry.yawDeg = this._yawDeg;
        entry.boosting = !!this._boosting;
        entry.isLocal = !!this._isLocal;
        entry.entityId = this.entity ? this.entity.id : null;
        if (this.entity && this.entity.transform) {
            var p = this.entity.transform.position;
            entry.x = p.x; entry.y = p.y; entry.z = p.z;
        }
        this.scene._neonCycles.bikes[this._peerId] = entry;
    }

    _publishHud() {
        if (!this._isLocal) return;
        // Boost meter HUD reads pct (0..1). Alive flag drives the wasted overlay.
        this.scene.events.ui.emit("hud_update", {
            neonBoost: {
                pct: this._boostMax > 0 ? (this._boost / this._boostMax) : 0,
                boosting: this._boosting,
                alive: this._alive,
            },
        });
    }
}
