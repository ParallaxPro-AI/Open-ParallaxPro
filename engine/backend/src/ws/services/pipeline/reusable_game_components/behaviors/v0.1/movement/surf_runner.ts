// also: lane switching, auto-run, slide mechanic, rhythm-action, endless runner
// Surf runner — auto-run forward with lane switching, jump, and slide
class SurfRunnerBehavior extends GameScript {
    _behaviorName = "surf_runner";
    _baseSpeed = 14;
    _maxSpeed = 32;
    _speedIncrease = 0.18;
    _laneWidth = 2.5;
    _laneSwitchSpeed = 12;
    _jumpForce = 12;
    _slideDuration = 0.7;
    _gravity = 35;

    _currentLane = 0;
    _targetX = 0;
    _currentSpeed = 14;
    _isJumping = false;
    _isSliding = false;
    _slideTimer = 0;
    _verticalVel = 0;
    _active = false;
    _dead = false;
    _currentAnim = "";
    _runTimer = 0;
    _startPos = [0, 0, 0];

    onStart() {
        var pos = this.entity.transform.position;
        this._startPos = [pos.x, pos.y, pos.z];
        this._currentLane = 0;
        this._targetX = 0;
        this._currentSpeed = this._baseSpeed;
        this._active = false;
        this._dead = false;
        this._runTimer = 0;

        var self = this;
        this.scene.events.game.on("race_start", function() {
            self._reset();
        });

        this.scene.events.game.on("race_started", function() {
            self._active = true;
        });

        this.scene.events.game.on("runner_crash", function() {
            self._dead = true;
            self._active = false;
            self._playAnim("Death", false);
            if (self.audio) self.audio.playSound("/assets/kenney/audio/impact_sounds/impactPlate_heavy_004.ogg", 0.6);
        });

        this.scene.events.game.on("restart_game", function() {
            self._reset();
        });
    }

    _reset() {
        this._currentLane = 0;
        this._targetX = 0;
        this._currentSpeed = this._baseSpeed;
        this._isJumping = false;
        this._isSliding = false;
        this._slideTimer = 0;
        this._verticalVel = 0;
        this._dead = false;
        this._active = false;
        this._runTimer = 0;
        this._currentAnim = "";
        this.scene.setPosition(this.entity.id, this._startPos[0], this._startPos[1], this._startPos[2]);
        this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
        this._playAnim("Idle", true);
    }

    onUpdate(dt) {
        if (this._dead) {
            this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
            return;
        }
        if (!this._active) return;

        this._runTimer += dt;

        // Increase speed over time
        this._currentSpeed = Math.min(this._maxSpeed, this._baseSpeed + this._speedIncrease * this._runTimer);

        // Lane switching — press to switch one lane
        var switchLeft = this.input.isKeyPressed("KeyA") || this.input.isKeyPressed("ArrowLeft");
        var switchRight = this.input.isKeyPressed("KeyD") || this.input.isKeyPressed("ArrowRight");

        if (switchLeft && this._currentLane > -1) {
            this._currentLane--;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/drop_002.ogg", 0.25);
        }
        if (switchRight && this._currentLane < 1) {
            this._currentLane++;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/drop_002.ogg", 0.25);
        }

        this._targetX = this._currentLane * this._laneWidth;

        // Jump — only when on ground
        var pos = this.entity.transform.position;
        var onGround = pos.y <= 1.05;

        var jumpPressed = this.input.isKeyPressed("Space") || this.input.isKeyPressed("KeyW") || this.input.isKeyPressed("ArrowUp");
        if (jumpPressed && onGround && !this._isSliding) {
            this._isJumping = true;
            this._verticalVel = this._jumpForce;
            this._playAnim("Jump_Start", false);
            if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaseJump1.ogg", 0.4);
        }

        // Slide — only when on ground and not jumping
        var slidePressed = this.input.isKeyPressed("KeyS") || this.input.isKeyPressed("ArrowDown");
        if (slidePressed && onGround && !this._isJumping) {
            this._isSliding = true;
            this._slideTimer = this._slideDuration;
            this._playAnim("Roll", false);
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/drop_003.ogg", 0.3);
        }

        // Update slide timer
        if (this._isSliding) {
            this._slideTimer -= dt;
            if (this._slideTimer <= 0) {
                this._isSliding = false;
            }
        }

        // Vertical physics
        if (!onGround || this._verticalVel > 0) {
            this._verticalVel -= this._gravity * dt;
        } else {
            this._verticalVel = 0;
            if (this._isJumping) {
                this._isJumping = false;
            }
        }

        // Smooth lane transition
        var lateralVel = (this._targetX - pos.x) * this._laneSwitchSpeed;

        // Clamp Y to ground
        var newY = pos.y + this._verticalVel * dt;
        if (newY < 1.0) {
            newY = 1.0;
            this._verticalVel = 0;
            if (this._isJumping) this._isJumping = false;
        }

        // Set velocity: forward (-Z), lateral (X), vertical (Y) managed manually
        this.scene.setVelocity(this.entity.id, { x: lateralVel, y: 0, z: -this._currentSpeed });
        this.scene.setPosition(this.entity.id, pos.x + lateralVel * dt, newY, pos.z - this._currentSpeed * dt);

        // Animation state
        if (!this._isJumping && !this._isSliding && onGround) {
            this._playAnim("Run", true);
        }

        // Face forward (-Z)
        this.entity.transform.setRotationEuler(0, 0, 0);

        // Share speed for camera FOV effect
        this.scene._surfSpeed = this._currentSpeed;
        this.scene._surfMaxSpeed = this._maxSpeed;
        this.scene._surfSliding = this._isSliding;
    }

    _playAnim(name, loop) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) {
            this.entity.playAnimation(name, { loop: loop !== false });
        }
    }
}
