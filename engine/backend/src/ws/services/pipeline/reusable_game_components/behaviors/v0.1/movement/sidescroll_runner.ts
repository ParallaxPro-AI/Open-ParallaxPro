// also: variable jump height, stomp mechanic, power-ups, Super Mario Bros, auto-run
// Sidescroll runner — arcade SMB-style 2.5D character control with
// run, variable-height jump, and Z-locked movement.
//
// Reusable: any 2.5D side-scroller wanting tight platformer feel can
// drop this on a dynamic-rigidbody capsule. Differs from
// metroidvania_player in three ways:
//   - no double-jump (single jump only — pure SMB)
//   - variable jump height (hold space for the first 0.18s for extra
//     upward thrust)
//   - registers stomp-readiness on scene._runnerPlayer so the engine
//     can tell when a downward-moving player overlapped an enemy from
//     above (vs side hit which would damage instead)
//
// Power-up state is owned by the engine, but the visual scale is
// driven here based on scene._runnerPlayer.poweredUp so a single
// capsule can read as both small and big without entity respawn.
class SidescrollRunnerBehavior extends GameScript {
    _behaviorName = "sidescroll_runner";
    _moveSpeed = 7.0;
    _runMultiplier = 1.55;
    _jumpForce = 13;
    _jumpHoldExtraSec = 0.18;
    _jumpHoldExtraForce = 9;
    _constrainZ = 0;
    _fallKillY = -16;
    _stompBouncePower = 8.5;
    _hitInvincibleSec = 1.2;
    _powerUpScale = 1.5;
    _jumpSound = "";
    _stompSound = "";
    _powerUpSound = "";
    _powerDownSound = "";
    _deathSound = "";

    _facing = 1;
    _grounded = false;
    _jumpCooldown = 0;
    _jumpHoldTimer = 0;
    _wasJumping = false;
    _alive = true;
    _iframeTimer = 0;
    _poweredUp = false;
    _currentScale = 1.0;

    onStart() {
        var self = this;
        this._registerSelf();
        // The engine raises these to set/clear our power-up state and
        // grant invincibility frames after a hit. We mirror locally so
        // the visual scale + stomp-bounce + i-frame check don't have
        // to poll engine state every frame.
        this.scene.events.game.on("runner_powered_up", function(d) {
            self._poweredUp = true;
            self._iframeTimer = 0.5;
            if (self.audio && self._powerUpSound) self.audio.playSound(self._powerUpSound, 0.5);
            self._registerSelf();
        });
        this.scene.events.game.on("runner_powered_down", function() {
            self._poweredUp = false;
            self._iframeTimer = self._hitInvincibleSec;
            if (self.audio && self._powerDownSound) self.audio.playSound(self._powerDownSound, 0.42);
            self._registerSelf();
        });
        this.scene.events.game.on("runner_life_lost", function() {
            self._alive = false;
            if (self.audio && self._deathSound) self.audio.playSound(self._deathSound, 0.6);
        });
        this.scene.events.game.on("game_ready", function() { self._reset(); });
        this.scene.events.game.on("restart_game", function() { self._reset(); });
        this.scene.events.game.on("player_respawned", function() { self._reset(); });
        // Engine-issued bounce after a successful stomp.
        this.scene.events.game.on("runner_stomped", function() {
            // Add a small upward bounce so the player springs off the
            // squashed enemy (the SMB-feel pop). Read the rigidbody to
            // preserve the existing horizontal velocity.
            var rb = self.entity.getComponent ? self.entity.getComponent("RigidbodyComponent") : null;
            var vx = (rb && rb.getLinearVelocity) ? (rb.getLinearVelocity().x || 0) : 0;
            self.scene.setVelocity(self.entity.id, { x: vx, y: self._stompBouncePower, z: 0 });
            if (self.audio && self._stompSound) self.audio.playSound(self._stompSound, 0.32);
        });
    }

    onUpdate(dt) {
        if (!this.entity || !this.entity.transform) return;
        if (this._jumpCooldown > 0) this._jumpCooldown -= dt;
        if (this._iframeTimer > 0) this._iframeTimer -= dt;

        var pos = this.entity.transform.position;
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = (rb && rb.getLinearVelocity) ? (rb.getLinearVelocity().y || 0) : 0;

        var wasGrounded = this._grounded;
        this._grounded = Math.abs(vy) < 0.5 && this._jumpCooldown <= 0;
        if (this._grounded && !wasGrounded) {
            this._jumpHoldTimer = 0;
            this._wasJumping = false;
        }

        // Defensive fall-kill — engine also detects via per-tick scan,
        // but firing the lose event from both sides keeps the drop
        // feeling instant even on a slow tick.
        if (pos.y < this._fallKillY && this._alive) {
            this._alive = false;
            this.scene.events.game.emit("player_died", {});
        }

        if (!this._alive) {
            this.scene.setVelocity(this.entity.id, { x: 0, y: vy, z: 0 });
            this._registerSelf();
            return;
        }

        // ── Read input ──
        var moveDir = 0;
        var pressJump = false;
        var holdJump = false;
        var holdRun = false;
        if (this.input) {
            if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft"))  moveDir -= 1;
            if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) moveDir += 1;
            pressJump = this.input.isKeyPressed && this.input.isKeyPressed("Space");
            holdJump  = this.input.isKeyDown && this.input.isKeyDown("Space");
            holdRun   = this.input.isKeyDown && (this.input.isKeyDown("ShiftLeft") || this.input.isKeyDown("ShiftRight"));
        }
        if (moveDir !== 0) this._facing = moveDir > 0 ? 1 : -1;

        // ── Jump (variable height) ──
        if (pressJump && this._grounded) {
            vy = this._jumpForce;
            this._jumpCooldown = 0.15;
            this._jumpHoldTimer = this._jumpHoldExtraSec;
            this._wasJumping = true;
            this._grounded = false;
            this.scene.events.game.emit("runner_jumped", {});
            if (this.audio && this._jumpSound) this.audio.playSound(this._jumpSound, 0.32);
        } else if (this._wasJumping && holdJump && this._jumpHoldTimer > 0 && vy > 0) {
            // Hold jump to add extra upward thrust for a brief window —
            // SMB's variable-height jump.
            vy += this._jumpHoldExtraForce * dt;
            this._jumpHoldTimer -= dt;
        } else {
            this._wasJumping = false;
        }

        // ── Horizontal velocity ──
        var speed = this._moveSpeed * (holdRun ? this._runMultiplier : 1);
        var vx = moveDir * speed;

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: 0 });

        // Z-lock — prevent any kinematic enemy collider from drifting us
        // out of the playfield plane. Snap rather than constrain via
        // physics because dynamic bodies can pick up tiny lateral nudges.
        if (Math.abs(pos.z - this._constrainZ) > 0.01) {
            this.scene.setPosition(this.entity.id, pos.x, pos.y, this._constrainZ);
        }

        // Face direction — yaw only.
        this.entity.transform.setRotationEuler && this.entity.transform.setRotationEuler(0, this._facing > 0 ? -90 : 90, 0);
        this.entity.transform.markDirty && this.entity.transform.markDirty();

        // Visual scale — power-up makes us bigger.
        var targetScale = this._poweredUp ? this._powerUpScale : 1.0;
        if (Math.abs(this._currentScale - targetScale) > 0.01) {
            this._currentScale += (targetScale - this._currentScale) * Math.min(1, dt * 8);
            var s = this._currentScale;
            this.scene.setScale && this.scene.setScale(this.entity.id, 0.85 * s, 1.0 * s, 0.85 * s);
        }

        this._registerSelf();
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    _reset() {
        this._alive = true;
        this._grounded = false;
        this._jumpCooldown = 0;
        this._jumpHoldTimer = 0;
        this._wasJumping = false;
        this._iframeTimer = 0;
        this._poweredUp = false;
        this._currentScale = 1.0;
        this.scene.setScale && this.scene.setScale(this.entity.id, 0.85, 1.0, 0.85);
        this._registerSelf();
    }

    _registerSelf() {
        if (!this.scene._runnerPlayer) this.scene._runnerPlayer = {};
        this.scene._runnerPlayer.alive = !!this._alive;
        this.scene._runnerPlayer.facing = this._facing;
        this.scene._runnerPlayer.poweredUp = !!this._poweredUp;
        this.scene._runnerPlayer.invincible = this._iframeTimer > 0;
        this.scene._runnerPlayer.entityId = this.entity ? this.entity.id : null;
        if (this.entity && this.entity.transform) {
            var p = this.entity.transform.position;
            this.scene._runnerPlayer.x = p.x;
            this.scene._runnerPlayer.y = p.y;
            this.scene._runnerPlayer.z = p.z;
            // Surface vy so the engine's stomp check can require a
            // downward-moving player to count an enemy overlap as a stomp
            // rather than a side hit.
            var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
            if (rb && rb.getLinearVelocity) {
                var v = rb.getLinearVelocity();
                this.scene._runnerPlayer.vy = v.y || 0;
                this.scene._runnerPlayer.vx = v.x || 0;
            }
        }
        // Mirror the metroidvania key so camera_side_scroll (the
        // hallowed_depths / cliffside_climber camera) can follow us
        // without a second behavior reference.
        if (!this.scene._mvPlayer) this.scene._mvPlayer = {};
        this.scene._mvPlayer.alive = !!this._alive;
        this.scene._mvPlayer.facing = this._facing;
        this.scene._mvPlayer.entityId = this.entity ? this.entity.id : null;
        if (this.entity && this.entity.transform) {
            this.scene._mvPlayer.x = this.entity.transform.position.x;
            this.scene._mvPlayer.y = this.entity.transform.position.y;
            this.scene._mvPlayer.z = this.entity.transform.position.z;
        }
    }
}
