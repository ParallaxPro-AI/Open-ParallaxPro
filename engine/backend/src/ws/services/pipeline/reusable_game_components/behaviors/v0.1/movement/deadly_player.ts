// also: elimination, battle-royale, combat, phase-gated, death-match
// Deadly player — WASD movement gated by game phase, used in elimination rounds
class DeadlyPlayerBehavior extends GameScript {
    _behaviorName = "deadly_player";
    _speed = 7;
    _jumpForce = 8;
    _currentAnim = "";

    onUpdate(dt) {
        if (!this.scene._deadlyPlayerActive) {
            // Make sure player is fully stopped when disabled
            return;
        }

        var fwd = 0, strafe = 0;
        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) fwd += 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) fwd -= 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft")) strafe -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) strafe += 1;

        var vx = strafe * this._speed;
        var vz = -fwd * this._speed;

        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = 0;
        if (rb && rb.getLinearVelocity) {
            vy = rb.getLinearVelocity().y || 0;
        }

        var pos = this.entity.transform.position;
        if (this.input.isKeyPressed("Space") && pos.y < 1.5) {
            vy = this._jumpForce;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaseJump1.ogg", 0.3);
        }

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });

        if (Math.abs(vx) > 0.5 || Math.abs(vz) > 0.5) {
            this._playAnim("Run");
            this.entity.transform.setRotationEuler(0, Math.atan2(-vx, -vz) * 180 / Math.PI, 0);
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
