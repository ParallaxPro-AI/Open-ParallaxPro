// also: ragdoll, physics, platformer, party-game, gravity-based
// Floppy walker — Human-Fall-Flat-style physics-driven movement.
// Camera-relative WASD applies horizontal acceleration to a dynamic
// rigidbody capsule; gravity does the falling. Jump is an upward
// impulse with a small forward kicker so it feels weighty. There's
// no air control beyond a gentle steering pull, so jumps still land
// roughly where the body's momentum was carrying you — that's the
// "floppy" feel.
//
// While `_grabbing` is set on the scene by grab_arms, walking force
// is reduced and a small upward "climb" pull is added so the player
// can scramble up a ledge when one hand catches.
//
// Reusable beyond Noodle Jaunt: any physics-puzzle / party platformer
// that wants weighty arcade movement instead of crisp fps movement.
class FloppyWalkerBehavior extends GameScript {
    _behaviorName = "floppy_walker";

    _walkForce = 70;          // N applied horizontally
    _maxSpeed = 5.5;
    _jumpImpulse = 7.5;
    _airControlMul = 0.35;
    _climbAssistForce = 24;   // upward pull while a hand is grabbing a ledge
    _climbAssistMaxVy = 4.5;
    _coyoteTime = 0.12;
    _jumpBufferTime = 0.15;
    _matchOver = false;

    _timeSinceGrounded = 99;
    _jumpRequestTime = 99;
    _jumpCooldown = 0;
    _grounded = false;
    _currentAnim = "";

    onStart() {
        var self = this;
        this.scene.events.game.on("match_ended",   function() { self._matchOver = true; });
        this.scene.events.game.on("match_started", function() { self._matchOver = false; });
    }

    onUpdate(dt) {
        if (this._matchOver) return;
        var ni = this.entity.getComponent
            ? this.entity.getComponent("NetworkIdentityComponent")
            : null;
        if (ni && !ni.isLocalPlayer) return;

        // Camera-relative input. Camera writes its yaw to scene._tpYaw
        // so we transform WASD into world-aligned XZ direction.
        var yawDeg = (this.scene._tpYaw != null) ? this.scene._tpYaw : 0;
        var yaw = yawDeg * Math.PI / 180;
        var forward = 0, strafe = 0;
        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp"))    forward += 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown"))  forward -= 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft"))  strafe -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) strafe += 1;
        var iLen = Math.sqrt(forward * forward + strafe * strafe);
        if (iLen > 1e-3) { forward /= iLen; strafe /= iLen; }

        // Camera-aligned world direction.
        var dirX = Math.sin(yaw) * forward + Math.cos(yaw) * strafe;
        var dirZ = -Math.cos(yaw) * forward + Math.sin(yaw) * strafe;

        // Ground probe — raycast straight down a short distance.
        this._grounded = this._probeGrounded();
        if (this._grounded) this._timeSinceGrounded = 0;
        else this._timeSinceGrounded += dt;

        // Read current velocity — we apply force, but cap horizontal
        // speed so the body doesn't overshoot.
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vx = 0, vy = 0, vz = 0;
        if (rb && rb.getLinearVelocity) {
            var v = rb.getLinearVelocity();
            vx = v.x || 0;
            vy = v.y || 0;
            vz = v.z || 0;
        }
        var horiz = Math.sqrt(vx * vx + vz * vz);

        var grabbing = !!this.scene._njGrabbing;
        var ctlMul = this._grounded ? 1.0 : this._airControlMul;
        if (grabbing) ctlMul *= 0.5;

        if (iLen > 1e-3) {
            // Blend horizontal velocity toward a target at walkForce
            // m/s² (treated as acceleration, not Newtonian force — the
            // old F/m path produced ~1 m/s² and felt broken).
            var tvx = dirX * this._maxSpeed;
            var tvz = dirZ * this._maxSpeed;
            var accel = this._walkForce * ctlMul;
            var dv = accel * dt;
            var ex = tvx - vx, ez = tvz - vz;
            var elen = Math.sqrt(ex * ex + ez * ez);
            var newVx, newVz;
            if (elen <= dv || elen < 1e-4) {
                newVx = tvx;
                newVz = tvz;
            } else {
                newVx = vx + ex / elen * dv;
                newVz = vz + ez / elen * dv;
            }
            this.scene.setVelocity && this.scene.setVelocity(this.entity.id, { x: newVx, y: vy, z: newVz });
        } else if (this._grounded) {
            // Idle friction — let horizontal velocity bleed off so the
            // body actually stops instead of sliding on smooth floors.
            var fk = Math.exp(-6 * dt);
            this.scene.setVelocity && this.scene.setVelocity(this.entity.id, {
                x: vx * fk, y: vy, z: vz * fk,
            });
        }

        // Climb assist while grabbing a ledge — gentle upward pull,
        // capped so we don't shoot to orbit.
        if (grabbing && vy < this._climbAssistMaxVy) {
            var addUp = (this._climbAssistForce / Math.max(1, this._mass())) * dt;
            var nv = this.scene.getVelocity ? this.scene.getVelocity(this.entity.id) : { x: vx, y: vy + addUp, z: vz };
            this.scene.setVelocity && this.scene.setVelocity(this.entity.id, { x: nv.x, y: (nv.y || 0) + addUp, z: nv.z });
        }

        // Jump — coyote + jump-buffer.
        this._jumpCooldown -= dt;
        if (this.input.isKeyPressed && this.input.isKeyPressed("Space")) {
            this._jumpRequestTime = 0;
        } else {
            this._jumpRequestTime += dt;
        }
        if (this._timeSinceGrounded < this._coyoteTime
            && this._jumpRequestTime < this._jumpBufferTime
            && this._jumpCooldown <= 0) {
            // Replace vy with jump impulse, keep horizontal momentum.
            var v2 = this.scene.getVelocity ? this.scene.getVelocity(this.entity.id) : null;
            var hx = v2 ? v2.x : vx;
            var hz = v2 ? v2.z : vz;
            this.scene.setVelocity && this.scene.setVelocity(this.entity.id, { x: hx, y: this._jumpImpulse, z: hz });
            this._jumpCooldown = 0.22;
            this._timeSinceGrounded = 99;
            this._jumpRequestTime = 99;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaseJump1.ogg", 0.4);
        }

        // Face direction of motion so the model isn't always facing
        // its initial orientation. Use velocity sign for the choice
        // — input dir would jitter at low input.
        var spd = Math.sqrt(vx * vx + vz * vz);
        if (spd > 0.6) {
            var ang = Math.atan2(vx, vz) * 180 / Math.PI;
            this.entity.transform.setRotationEuler(0, ang, 0);
        }

        // Animation hint.
        var anim = !this._grounded ? "Jump_Start"
                 : (spd > 1 ? "Run" : "Idle");
        if (anim !== this._currentAnim) {
            this._currentAnim = anim;
            if (this.entity.playAnimation) {
                try { this.entity.playAnimation(anim, { loop: anim !== "Jump_Start" }); } catch (e) { /* missing clip */ }
            }
        }
    }

    _mass() {
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        if (rb && typeof rb.mass === "number") return rb.mass;
        return 60;
    }

    _probeGrounded() {
        if (!this.scene.raycast) return false;
        var p = this.entity.transform.position;
        var hit = this.scene.raycast(p.x, p.y - 0.3, p.z, 0, -1, 0, 0.55, this.entity.id);
        return !!(hit && hit.entityId);
    }
}
