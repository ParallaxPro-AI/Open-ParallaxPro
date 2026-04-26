// also: sports gameplay, ball interaction, world-relative, directional input, field games
// Soccer player — WASD world-axis movement for player-controlled character, sprint with Shift
class SoccerPlayerBehavior extends GameScript {
    _behaviorName = "soccer_player";
    _speed = 8;
    _sprintSpeed = 12;
    _currentAnim = "";

    onUpdate(dt) {
        var vx = 0, vz = 0;

        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) vz -= 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) vz += 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft")) vx -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) vx += 1;

        // Normalize diagonal
        var len = Math.sqrt(vx * vx + vz * vz);
        if (len > 0) { vx /= len; vz /= len; }

        var sprinting = this.input.isKeyDown("ShiftLeft");
        var speed = sprinting ? this._sprintSpeed : this._speed;
        vx *= speed;
        vz *= speed;

        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = 0;
        if (rb && rb.getLinearVelocity) {
            vy = rb.getLinearVelocity().y || 0;
        }

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });

        // Clamp to pitch bounds
        var pos = this.entity.transform.position;
        if (pos.x < -52) this.scene.setPosition(this.entity.id, -52, pos.y, pos.z);
        if (pos.x > 52) this.scene.setPosition(this.entity.id, 52, pos.y, pos.z);
        if (pos.z < -32) this.scene.setPosition(this.entity.id, pos.x, pos.y, -32);
        if (pos.z > 32) this.scene.setPosition(this.entity.id, pos.x, pos.y, 32);

        // Face movement direction
        var moving = Math.abs(vx) > 0.1 || Math.abs(vz) > 0.1;
        if (moving) {
            // Engine Y-rotation is CCW-from-above (rpg_movement
            // convention). The original atan2(vx, -vz) got W/S right but
            // flipped strafe — matches motion in only one axis. Negate
            // just the vx arg so both axes face the velocity vector.
            var angle = Math.atan2(-vx, -vz) * 180 / Math.PI;
            this.entity.transform.setRotationEuler(0, angle, 0);
            this.scene._playerFacingRad = Math.atan2(-vx, -vz);
        }

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
