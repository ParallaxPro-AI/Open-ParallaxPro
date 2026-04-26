// also: minigame, couch-coop, party-game, local-multiplayer, casual
// Party player — WASD movement for human player in party minigames
class PartyPlayerBehavior extends GameScript {
    _behaviorName = "party_player";
    _speed = 7;
    _jumpForce = 9;
    _currentAnim = "";
    _startPos = [0, 0, 0];

    onStart() {
        var pos = this.entity.transform.position;
        this._startPos = [pos.x, pos.y, pos.z];
        this._playAnim("Idle");
    }

    onUpdate(dt) {
        // Only accept input when the minigame is active
        if (!this.scene._partyMinigameActive) {
            return;
        }

        var fwd = 0, strafe = 0;
        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) fwd += 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) fwd -= 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft")) strafe -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) strafe += 1;

        var vx = strafe * this._speed;
        var vz = -fwd * this._speed;

        // Vertical velocity from physics
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = 0;
        if (rb && rb.getLinearVelocity) {
            vy = rb.getLinearVelocity().y || 0;
        }

        // Jump — only near ground
        var pos = this.entity.transform.position;
        if (this.input.isKeyPressed("Space") && pos.y < 1.3 && Math.abs(vy) < 0.5) {
            vy = this._jumpForce;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaseJump1.ogg", 0.35);
        }

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });

        // Animation and facing
        if (Math.abs(vx) > 0.5 || Math.abs(vz) > 0.5) {
            this._playAnim("Run");
            var angle = Math.atan2(vx, -vz) * 180 / Math.PI;
            this.entity.transform.setRotationEuler(0, angle, 0);
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
