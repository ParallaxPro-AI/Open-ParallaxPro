// Superman movement — physics-free free flight, camera-relative WASD,
// Space ascends, Ctrl/C descends, Shift sprints. No gravity, no collisions.
class SupermanMovementBehavior extends GameScript {
    _behaviorName = "superman_movement";
    _speed = 20;
    _sprintSpeed = 60;
    _verticalSpeed = 15;
    _currentAnim = "";

    onUpdate(dt) {
        var yaw = (this.scene._tpYaw || 0) * Math.PI / 180;

        var forward = 0, strafe = 0, vertical = 0;
        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) forward += 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) forward -= 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft")) strafe -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) strafe += 1;
        if (this.input.isKeyDown("Space")) vertical += 1;
        if (this.input.isKeyDown("ControlLeft") || this.input.isKeyDown("KeyC")) vertical -= 1;

        var sprinting = this.input.isKeyDown("ShiftLeft");
        var speed = sprinting ? this._sprintSpeed : this._speed;

        var dx = (Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * speed * dt;
        var dz = (-Math.cos(yaw) * forward + Math.sin(yaw) * strafe) * speed * dt;
        var dy = vertical * this._verticalSpeed * dt;

        var pos = this.entity.transform.position;
        if (dx !== 0 || dy !== 0 || dz !== 0) {
            this.scene.setPosition(this.entity.id, pos.x + dx, pos.y + dy, pos.z + dz);
        }

        var moving = Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001;
        if (moving) {
            var moveAngle = Math.atan2(-dx, -dz) * 180 / Math.PI;
            this.entity.transform.setRotationEuler(0, moveAngle, 0);
        }

        if (moving && sprinting) {
            this._playAnim("Run");
        } else if (moving || dy !== 0) {
            this._playAnim("Walk");
        } else {
            this._playAnim("Idle");
        }
    }

    _playAnim(name) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) {
            this.entity.playAnimation(name, { loop: true });
        }
    }
}
