// Sandbox movement — FPS-style WASD with sprint and jump for survival games
class SandboxMovementBehavior extends GameScript {
    _behaviorName = "sandbox_movement";
    _speed = 5;
    _sprintSpeed = 8;
    _jumpForce = 7;
    _currentAnim = "";

    onUpdate(dt) {
        var fwd = 0, strafe = 0;
        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) fwd += 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) fwd -= 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft")) strafe -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) strafe += 1;

        var sprint = this.input.isKeyDown("ShiftLeft") || this.input.isKeyDown("ShiftRight");
        var speed = sprint ? this._sprintSpeed : this._speed;

        var yaw = (this.scene._fpsYaw || 0) * Math.PI / 180;
        var vx = (Math.sin(yaw) * fwd + Math.cos(yaw) * strafe) * speed;
        var vz = (-Math.cos(yaw) * fwd + Math.sin(yaw) * strafe) * speed;

        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = 0;
        if (rb && rb.getLinearVelocity) vy = rb.getLinearVelocity().y || 0;

        var pos = this.entity.transform.position;
        if (this.input.isKeyPressed("Space") && pos.y < 1.5 && Math.abs(vy) < 0.5) {
            vy = this._jumpForce;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/footstep_concrete_000.ogg", 0.3);
        }

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });

        if (Math.abs(vx) > 0.5 || Math.abs(vz) > 0.5) {
            this._playAnim(sprint ? "Run" : "Walk");
            this.entity.transform.setRotationEuler(0, -(this.scene._fpsYaw || 0), 0);
        } else {
            this._playAnim("Idle");
        }
    }

    _playAnim(name) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) this.entity.playAnimation(name, { loop: true });
    }
}
