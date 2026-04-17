// Sidescroll platformer movement — A/D horizontal, Space to jump, Z axis
// locked to zero so the player stays on the 2D action plane. Gravity is
// delivered by the physics engine on a dynamic rigidbody; we just drive
// horizontal velocity and apply impulses on jump.
//
// Reusable outside Pickaxe Keep: any 2.5D side-view game (metroidvania,
// platformer, sandbox, beat-em-up) can drop this on the player prefab.
// Tune `_speed`/`_jumpForce` for the feel you want; `_zLockAtValue`
// controls which 2D slice the action lives on (use 0 by default).
class SidescrollPlatformerBehavior extends GameScript {
    _behaviorName = "sidescroll_platformer";

    _speed = 6.0;
    _jumpForce = 9.5;
    _airControl = 0.75;     // 0..1 — fraction of _speed reachable mid-air
    _zLockAtValue = 0;      // forces this.entity.transform.position.z to this
    _facingDeg = 90;        // sprite yaw when facing right (camera looks down -Z)
    _coyoteTime = 0.12;     // ms of forgiveness between leaving ground and jump
    _jumpBufferTime = 0.12; // press Space slightly early and still jump on land
    _inventoryOpen = false;

    _grounded = false;
    _timeSinceGrounded = 99;
    _jumpRequestTime = 99;
    _jumpCooldown = 0;
    _currentAnim = "";

    onStart() {
        var self = this;
        this.scene.events.game.on("pk_toggle_inventory", function() {
            self._inventoryOpen = !self._inventoryOpen;
        });
        this.scene.events.game.on("match_ended", function() { self._matchOver = true; });
        this.scene.events.game.on("match_started", function() { self._matchOver = false; });
    }

    onUpdate(dt) {
        if (this._matchOver) {
            if (this.scene.setVelocity) this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
            return;
        }
        var ni = this.entity.getComponent
            ? this.entity.getComponent("NetworkIdentityComponent")
            : null;
        if (ni && !ni.isLocalPlayer) return;

        // Lock Z — the action plane is 2D, so any drift on Z becomes a
        // gameplay bug (blocks stop registering clicks, camera flips).
        var pos = this.entity.transform.position;
        if (pos.z !== this._zLockAtValue) {
            this.scene.setPosition(this.entity.id, pos.x, pos.y, this._zLockAtValue);
        }

        // While the inventory overlay is open, pause input so the player
        // doesn't keep running off-screen while typing crafting queries.
        var inputLocked = this._inventoryOpen === true;

        // Current velocity from the rigidbody so we can keep the Y
        // component that gravity is already producing.
        var vy = 0;
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        if (rb && rb.getLinearVelocity) vy = rb.getLinearVelocity().y || 0;

        // Ground detection — a short downward raycast from the player's
        // center finds the next block below within 0.5m. Works even when
        // the player is stationary on a slope where |vy| > 0.
        this._grounded = this._probeGrounded();
        if (this._grounded) this._timeSinceGrounded = 0;
        else this._timeSinceGrounded += dt;

        var strafe = 0;
        if (!inputLocked) {
            if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft"))  strafe -= 1;
            if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) strafe += 1;
        }

        // Air control — mid-air you still get *some* horizontal authority
        // so you can tweak a jump, but not full ground speed.
        var targetVx = strafe * this._speed * (this._grounded ? 1 : this._airControl);

        // Jump with coyote time + jump buffer — standard platformer feel.
        if (!inputLocked && this.input.isKeyPressed && this.input.isKeyPressed("Space")) {
            this._jumpRequestTime = 0;
        } else {
            this._jumpRequestTime += dt;
        }
        this._jumpCooldown -= dt;

        var canJump = (this._timeSinceGrounded < this._coyoteTime)
                   && (this._jumpRequestTime < this._jumpBufferTime)
                   && (this._jumpCooldown <= 0);
        if (canJump) {
            vy = this._jumpForce;
            this._jumpCooldown = 0.18;
            this._timeSinceGrounded = 99;  // consume coyote
            this._jumpRequestTime = 99;    // consume buffer
            if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaseJump1.ogg", 0.45);
        }

        this.scene.setVelocity(this.entity.id, { x: targetVx, y: vy, z: 0 });

        // Face the movement direction. Camera looks along -Z, so yaw 90
        // faces +X (right) and yaw -90 faces -X (left). This keeps the
        // model visually consistent when dashing in either direction.
        if (strafe > 0.01)      this.entity.transform.setRotationEuler(0,  this._facingDeg, 0);
        else if (strafe < -0.01) this.entity.transform.setRotationEuler(0, -this._facingDeg, 0);

        // Animation — Run / Jump_Start / Idle. No-op if the mesh has no
        // matching clip; wrapped in try/catch to survive unknown clips.
        var moving = Math.abs(strafe) > 0.01;
        var anim;
        if (!this._grounded)      anim = "Jump_Start";
        else if (moving)          anim = "Run";
        else                      anim = "Idle";
        if (anim !== this._currentAnim) {
            this._currentAnim = anim;
            if (this.entity.playAnimation) {
                try { this.entity.playAnimation(anim, { loop: anim !== "Jump_Start" }); } catch (e) { /* no anim */ }
            }
        }
    }

    _probeGrounded() {
        if (!this.scene.raycast) return false;
        var p = this.entity.transform.position;
        // Start just below the hip, fire downward 0.65 m. Offset to avoid
        // self-hits — raycast takes an excludeId for our own collider.
        var hit = this.scene.raycast(p.x, p.y - 0.35, p.z, 0, -1, 0, 0.55, this.entity.id);
        return !!(hit && hit.entityId);
    }
}
