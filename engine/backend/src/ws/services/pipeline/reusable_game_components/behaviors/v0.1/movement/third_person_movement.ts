// also: camera-relative movement, animation states, vehicle exit, character controller, third-person camera
// Third-person movement — WASD relative to camera, sprint with Shift, jump with Space
class ThirdPersonMovementBehavior extends GameScript {
    _behaviorName = "third_person_movement";
    _speed = 5;
    _sprintSpeed = 9;
    _jumpForce = 6;
    _currentAnim = "";

    onUpdate(dt) {
        if (this.scene._inVehicle) {
            this._playAnim("Idle");
            return;
        }

        var yaw = (this.scene._tpYaw || 0) * Math.PI / 180;
        var forward = 0, strafe = 0;

        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) forward += 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) forward -= 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft")) strafe -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) strafe += 1;

        var sprinting = this.input.isKeyDown("ShiftLeft");
        var speed = sprinting ? this._sprintSpeed : this._speed;
        var vx = (Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * speed;
        var vz = (-Math.cos(yaw) * forward + Math.sin(yaw) * strafe) * speed;

        var vy = 0;
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        if (rb && rb.getLinearVelocity) {
            vy = rb.getLinearVelocity().y || 0;
        }

        var pos = this.entity.transform.position;
        if (this.input.isKeyPressed("Space") && pos.y < 1.0) {
            vy = this._jumpForce;
        }

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });

        var moving = Math.abs(vx) > 0.1 || Math.abs(vz) > 0.1;
        // Body always faces the camera direction so the player visibly
        // looks at whatever they're shooting at — both hip-fire and aim
        // mode. Strafing now produces sideways motion past a fixed-facing
        // body instead of the body rotating to follow the strafe.
        // Negate _tpYaw because setRotationEuler's Y arg uses the
        // opposite sign convention from the camera's tracked yaw.
        this.entity.transform.setRotationEuler(0, -(this.scene._tpYaw || 0), 0);

        if (moving && sprinting) {
            this._playAnim("Run");
        } else if (moving) {
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
