// also: 2D-platformer, jumping, air-control, level-based, double-jump
// Platformer movement — WASD relative to camera, jump, double-jump
class PlatformerMovementBehavior extends GameScript {
    _behaviorName = "platformer_movement";
    _speed = 7;
    _jumpForce = 10;
    _doubleJumpForce = 8;
    _grounded = false;
    _hasDoubleJumped = false;
    _jumpCooldown = 0;
    _currentAnim = "";

    onUpdate(dt) {
        var yaw = (this.scene._tpYaw || 0) * Math.PI / 180;
        var forward = 0, strafe = 0;

        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) forward += 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) forward -= 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft")) strafe -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) strafe += 1;

        var vx = (Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * this._speed;
        var vz = (-Math.cos(yaw) * forward + Math.sin(yaw) * strafe) * this._speed;

        var vy = 0;
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        if (rb && rb.getLinearVelocity) {
            vy = rb.getLinearVelocity().y || 0;
        }

        this._jumpCooldown -= dt;

        // Ground detection uses rb.isGrounded EXCLUSIVELY (contact
        // manifolds + engine downray fallback in PhysicsSystem). Earlier
        // versions fell back on `|vy| < 0.5 && cooldown` to catch a
        // just-landed edge case — but since the engine already does a
        // short downray on the same frame, the fallback is redundant AND
        // it fires at the APEX of every jump (vy crosses zero there).
        // With the cooldown expired (jumps last longer than 0.2s), the
        // fallback lit up mid-air and granted another jump, producing
        // the "spam space forever" infinite-jump bug from platformer run
        // 3c887c49. Trust the engine; no vy-based shortcut.
        var wasGrounded = this._grounded;
        this._grounded = !!(rb && rb.isGrounded);

        if (this._grounded && !wasGrounded) {
            this._hasDoubleJumped = false;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/footstep_concrete_000.ogg", 0.25);
        }

        // Jump / double jump
        if (this.input.isKeyPressed("Space")) {
            if (this._grounded) {
                vy = this._jumpForce;
                this._jumpCooldown = 0.2;
                this._grounded = false;
                if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaseJump1.ogg", 0.5);
            } else if (!this._hasDoubleJumped) {
                vy = this._doubleJumpForce;
                this._hasDoubleJumped = true;
                this._jumpCooldown = 0.15;
                if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaseJump3.ogg", 0.4);
            }
        }

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });

        // Face movement direction using engine's canonical -Z forward.
        // faceDirection handles the rotation math from a single source of
        // truth so this behaviour stays correct on any GLB.
        var moving = Math.abs(vx) > 0.1 || Math.abs(vz) > 0.1;
        if (moving) {
            this.entity.transform.faceDirection(vx, vz);
        }

        // Animations
        if (!this._grounded) {
            this._playAnim("Jump_Start");
        } else if (moving) {
            this._playAnim("Run");
        } else {
            this._playAnim("Idle");
        }
    }

    _playAnim(name) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) {
            this.entity.playAnimation(name, { loop: name !== "Jump_Start" });
        }
    }
}
