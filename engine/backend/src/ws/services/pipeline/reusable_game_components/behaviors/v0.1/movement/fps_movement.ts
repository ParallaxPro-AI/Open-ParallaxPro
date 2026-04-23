// also: locomotion, first-person, sprint, gravity, physics-based
// FPS movement — WASD via physics velocity, gravity handled by physics engine
class FPSMovementBehavior extends GameScript {
    _behaviorName = "fps_movement";
    _speed = 6;
    _sprintSpeed = 10;
    _jumpForce = 7;
    _canJump = true;
    _matchOver = false;
    _currentAnim = "";

    onStart() {
        var self = this;
        this.scene.events.game.on("match_ended", function() { self._matchOver = true; });
        this.scene.events.game.on("match_started", function() { self._matchOver = false; });
        // Kick off Idle so the model isn't stuck in T-pose at spawn.
        this._playAnim("Idle");
    }

    // Switch animation only on change so the engine doesn't restart from
    // frame 0 every tick. No-op if the model lacks the named clip.
    _playAnim(name) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) {
            try { this.entity.playAnimation(name, { loop: true }); } catch (e) {}
        }
    }

    onUpdate(dt) {
        if (this._matchOver) {
            if (this.scene.setVelocity) this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
            return;
        }
        // Multiplayer: remote player proxies carry the same behavior but
        // must not run input — their transform comes from snapshots.
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        if (ni && !ni.isLocalPlayer) return;

        // Dead players freeze in place until their respawn timer fires.
        // Velocity is zeroed so physics momentum doesn't keep sliding them.
        var health = this.entity.getScript ? this.entity.getScript("PlayerHealthBehavior") : null;
        if (health && health._dead) {
            if (this.scene.setVelocity) this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
            return;
        }

        var yaw = (this.scene._fpsYaw || 0) * Math.PI / 180;
        var forward = 0, strafe = 0;

        if (this.input.isKeyDown("KeyW")) forward += 1;
        if (this.input.isKeyDown("KeyS")) forward -= 1;
        if (this.input.isKeyDown("KeyA")) strafe -= 1;
        if (this.input.isKeyDown("KeyD")) strafe += 1;

        var speed = this.input.isKeyDown("ShiftLeft") ? this._sprintSpeed : this._speed;
        var vx = (Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * speed;
        var vz = (-Math.cos(yaw) * forward + Math.sin(yaw) * strafe) * speed;

        // Get current vertical velocity from physics, keep it (gravity)
        var pos = this.entity.transform.position;
        var vy = 0;
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        if (rb && rb.getLinearVelocity) {
            var vel = rb.getLinearVelocity();
            vy = vel.y || 0;
        }

        // Jump when grounded (close to ground)
        if (this.input.isKeyPressed("Space") && pos.y < 1.0) {
            vy = this._jumpForce;
        }

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });

        // Rotate player to face the camera yaw. The entity rotation has
        // to be negated because Quat.fromEuler rotates -Z to -X under a
        // positive Y turn, while the camera's lookAt formula (used
        // by camera_fps) rotates -Z to +X under the same yaw. Without
        // the sign flip the model faces opposite the camera's aim — so
        // other peers see a soldier running backwards relative to where
        // they're looking.
        this.entity.transform.setRotationEuler(0, -(this.scene._fpsYaw || 0), 0);

        // Animation state: Jump while airborne, Run when sprinting and
        // moving, Walk when moving normally, Idle otherwise. Names match
        // the standard Quaternius animated character pack.
        var moving = (forward !== 0 || strafe !== 0);
        var airborne = pos.y > 1.0;
        if (airborne)                                this._playAnim("Jump");
        else if (moving && speed === this._sprintSpeed) this._playAnim("Run");
        else if (moving)                             this._playAnim("Walk");
        else                                         this._playAnim("Idle");
    }
}
