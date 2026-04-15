// FPS movement — WASD via physics velocity, gravity handled by physics engine
class FPSMovementBehavior extends GameScript {
    _behaviorName = "fps_movement";
    _speed = 6;
    _sprintSpeed = 10;
    _jumpForce = 7;
    _canJump = true;

    onUpdate(dt) {
        // Multiplayer: remote player proxies carry the same behavior but
        // must not run input — their transform comes from snapshots.
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        if (ni && !ni.isLocalPlayer) return;

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

        // Rotate player to face camera yaw
        this.entity.transform.setRotationEuler(0, this.scene._fpsYaw || 0, 0);
    }
}
