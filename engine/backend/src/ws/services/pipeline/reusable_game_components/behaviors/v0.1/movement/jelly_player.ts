// also: physics, party-game, bouncy, third-person, weighty
// Jelly Player movement — wobbly, bouncy, party-game-feel third-person
// movement. WASD relative to camera yaw, Space for a slightly-floaty
// jump, Shift to sprint, Q to dive (commit a forward lunge that stuns
// you briefly on landing). Built around getting bumped a lot — when the
// match system sets _stunUntil, the player is locked out of input for
// a moment so spinners feel meaningful.
//
// Reusable beyond Jelly Jam: any 3rd-person party / battle-royale /
// platformer where the player should feel chunky and weighty rather
// than crisp-twitchy. Tune `_acceleration` higher for snappier feel.
class JellyPlayerBehavior extends GameScript {
    _behaviorName = "jelly_player";

    _speed = 7.0;
    _sprintSpeed = 10.5;
    _acceleration = 22;       // higher = snappier, lower = floatier
    _airAcceleration = 7;
    _jumpForce = 9.5;
    _diveForwardImpulse = 11; // forward shove on dive
    _diveUpImpulse = 4.0;
    _diveCooldown = 1.2;
    _diveStunDuration = 0.55;
    _coyoteTime = 0.12;
    _jumpBufferTime = 0.12;
    _spectator = false;       // set by match system on elimination
    _matchOver = false;
    _airborne = false;

    _vx = 0;
    _vz = 0;
    _grounded = false;
    _timeSinceGrounded = 99;
    _jumpRequestTime = 99;
    _jumpCooldown = 0;
    _diving = false;
    _diveCooldownLeft = 0;
    _stunUntil = 0;          // scene clock; while > 0 → frozen velocity
    _currentAnim = "";

    onStart() {
        var self = this;
        this._stunUntil = 0;
        this.scene.events.game.on("match_ended",   function() { self._matchOver = true; });
        this.scene.events.game.on("match_started", function() { self._matchOver = false; });

        // Match system tells us we got bumped by a spinner / hit by an
        // obstacle. We freeze input for `force * stunPerForce` seconds.
        this.scene.events.game.on("jj_obstacle_hit", function(data) {
            var mp = self.scene._mp;
            if (!mp || !data || data.peerId !== mp.localPeerId) return;
            // Stun length scales with bump force; cap at 1s so it's
            // unpleasant but never frustrating.
            var s = Math.min(1.0, 0.25 + (Number(data.force) || 1) * 0.15);
            self._stunUntil = (self.scene.time && self.scene.time.time || 0) + s;
        });

        // Eliminated → spectator-only.
        this.scene.events.game.on("jj_player_eliminated", function(data) {
            var mp2 = self.scene._mp;
            if (!mp2 || !data || data.peerId !== mp2.localPeerId) return;
            self._spectator = true;
        });
        this.scene.events.game.on("match_started", function() {
            self._spectator = false;
            self._stunUntil = 0;
            self._diveCooldownLeft = 0;
        });
    }

    onUpdate(dt) {
        var ni = this.entity.getComponent
            ? this.entity.getComponent("NetworkIdentityComponent")
            : null;
        if (ni && !ni.isLocalPlayer) {
            // Remote proxy — drive its facing animation off horizontal
            // velocity since input is absent here.
            this._driveProxyAnimation();
            return;
        }
        if (this._spectator || this._matchOver) {
            this._currentAnim = "";  // freeze
            this.scene.setVelocity && this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
            return;
        }

        var nowT = (this.scene.time && this.scene.time.time) || 0;
        var stunned = nowT < this._stunUntil;

        // Camera yaw — third-person camera writes the working yaw onto
        // the scene each frame so we don't need to look it up.
        var yawDeg = this.scene._tpYaw != null ? this.scene._tpYaw : 0;
        var yaw = yawDeg * Math.PI / 180;

        var forward = 0, strafe = 0;
        if (!stunned && !this._diving) {
            if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp"))    forward += 1;
            if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown"))  forward -= 1;
            if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft"))  strafe -= 1;
            if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) strafe += 1;
        }

        var sprinting = !stunned && this.input.isKeyDown && this.input.isKeyDown("ShiftLeft");
        var maxSpeed = sprinting ? this._sprintSpeed : this._speed;

        // Camera-relative input → world axes. Camera looks toward -Z by
        // default (yaw 0), so forward = -Z. With camera yaw, forward
        // rotates around Y.
        var targetVx = (Math.sin(yaw) * forward + Math.cos(yaw) * strafe) * maxSpeed;
        var targetVz = (-Math.cos(yaw) * forward + Math.sin(yaw) * strafe) * maxSpeed;

        // Read current velocity from the rigidbody so we keep gravity-
        // accumulated Y component.
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = 0;
        if (rb && rb.getLinearVelocity) {
            var vel = rb.getLinearVelocity();
            this._vx = vel.x || 0;
            this._vz = vel.z || 0;
            vy = vel.y || 0;
        }

        // Smoothly steer toward target velocity — feels chunkier than a
        // hard set. Air control is reduced.
        var accel = this._grounded ? this._acceleration : this._airAcceleration;
        var dxv = targetVx - this._vx;
        var dzv = targetVz - this._vz;
        var step = accel * dt;
        var len = Math.sqrt(dxv * dxv + dzv * dzv);
        if (len > step) {
            dxv = dxv * step / len;
            dzv = dzv * step / len;
        }
        if (!stunned) {
            this._vx += dxv;
            this._vz += dzv;
        }

        // Ground probe — short downward raycast from the hip.
        this._grounded = this._probeGrounded();
        if (this._grounded) this._timeSinceGrounded = 0;
        else this._timeSinceGrounded += dt;

        // Jump (coyote + jump buffer).
        this._jumpCooldown -= dt;
        if (!stunned && this.input.isKeyPressed && this.input.isKeyPressed("Space")) {
            this._jumpRequestTime = 0;
        } else {
            this._jumpRequestTime += dt;
        }
        if (!stunned && !this._diving
            && this._timeSinceGrounded < this._coyoteTime
            && this._jumpRequestTime < this._jumpBufferTime
            && this._jumpCooldown <= 0) {
            vy = this._jumpForce;
            this._jumpCooldown = 0.18;
            this._timeSinceGrounded = 99;
            this._jumpRequestTime = 99;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaseJump1.ogg", 0.4);
        }

        // Dive (Q) — single-shot forward lunge with recovery stun.
        this._diveCooldownLeft -= dt;
        if (!stunned && !this._diving && this._diveCooldownLeft <= 0
            && this.input.isKeyPressed && this.input.isKeyPressed("KeyQ")) {
            this._diving = true;
            this._diveCooldownLeft = this._diveCooldown;
            this._stunUntil = nowT + this._diveStunDuration;
            // Lunge forward in the direction we're currently facing.
            var faceX = Math.sin(yaw);
            var faceZ = -Math.cos(yaw);
            this._vx = faceX * this._diveForwardImpulse;
            this._vz = faceZ * this._diveForwardImpulse;
            vy = this._diveUpImpulse;
            this.scene.events.game.emit("jj_dive_started", { peerId: this.scene._mp ? this.scene._mp.localPeerId : "" });
            var mp = this.scene._mp;
            if (mp) mp.sendNetworkedEvent("jj_dive", { peerId: mp.localPeerId });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaserUp1.ogg", 0.45);
        }
        // Dive ends when we touch the ground after the airborne phase.
        if (this._diving && this._grounded && nowT >= this._stunUntil) {
            this._diving = false;
            this.scene.events.game.emit("jj_dive_landed", { peerId: this.scene._mp ? this.scene._mp.localPeerId : "" });
        }

        if (stunned && !this._diving) {
            // Stunned: damp horizontal velocity quickly so the player
            // doesn't slide forever after a hit.
            this._vx *= Math.max(0, 1 - dt * 4);
            this._vz *= Math.max(0, 1 - dt * 4);
        }

        this.scene.setVelocity(this.entity.id, { x: this._vx, y: vy, z: this._vz });

        // Face the movement direction (or keep last facing if not moving).
        var horizSpeed = Math.sqrt(this._vx * this._vx + this._vz * this._vz);
        if (horizSpeed > 0.5) {
            var faceAngle = Math.atan2(this._vx, this._vz) * 180 / Math.PI;
            this.entity.transform.setRotationEuler(0, faceAngle, 0);
        }

        // Animation
        var anim;
        if (this._diving)         anim = "Jump_Start";  // dive-roll lookalike
        else if (!this._grounded) anim = "Jump_Start";
        else if (horizSpeed > 1)  anim = sprinting ? "Run" : "Run";
        else                      anim = "Idle";
        this._setAnim(anim);
    }

    _setAnim(name) {
        if (name === this._currentAnim) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) {
            try { this.entity.playAnimation(name, { loop: name !== "Jump_Start" }); } catch (e) { /* missing clip */ }
        }
    }

    _driveProxyAnimation() {
        // Best-effort animation for remote proxies — pick Idle / Run by
        // horizontal velocity. Air state isn't reliable from proxies, so
        // we don't bother distinguishing jumps for them.
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vx = 0, vz = 0;
        if (rb && rb.getLinearVelocity) { var v = rb.getLinearVelocity(); vx = v.x || 0; vz = v.z || 0; }
        var s = Math.sqrt(vx * vx + vz * vz);
        var anim = s > 1 ? "Run" : "Idle";
        if (anim === this._currentAnim) return;
        this._currentAnim = anim;
        if (this.entity.playAnimation) {
            try { this.entity.playAnimation(anim, { loop: true }); } catch (e) { /* missing */ }
        }
    }

    _probeGrounded() {
        if (!this.scene.raycast) return false;
        var p = this.entity.transform.position;
        var hit = this.scene.raycast(p.x, p.y - 0.1, p.z, 0, -1, 0, 0.65, this.entity.id);
        return !!(hit && hit.entityId);
    }
}
