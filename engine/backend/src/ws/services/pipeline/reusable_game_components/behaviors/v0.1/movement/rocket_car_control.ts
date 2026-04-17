// Rocket Car control — arcade vehicle driving for car-football games.
//
// WASD accelerate/steer/reverse, Space jump, Shift boost (consumes the
// boost meter owned by the match system). Designed to pair with a
// floating ball entity and the rocket_pitch_game match system.
//
// The movement is physics-based: we read the current rigidbody velocity
// and drive toward a target vector each tick, so the car can go off
// jumps, get bumped by the ball, and land without us fighting the
// engine.
//
// Reusable: every knob (max speed, boost multiplier, steer rate, jump
// impulse, etc.) is a behavior param so an off-road driver / kart
// racer variant can reuse the same script with different numbers.
//
// Ownership rules (mirrors the other mp behaviors):
//   - isLocalPlayer → read input, drive the car, emit boost/jump events
//   - remote players → proxy entities driven by transform snapshots
//   - bots → entity has `_isBot = true`; this script bails and the
//     rocket_bot_ai behavior takes over
class RocketCarControlBehavior extends GameScript {
    _behaviorName = "rocket_car_control";

    _maxSpeed = 22;
    _accel = 28;
    _reverseMult = 0.55;
    _brakeForce = 46;
    _steerRate = 2.6;
    _airSteerRate = 1.8;
    _jumpImpulse = 9;
    _doubleJumpImpulse = 7;
    _boostForce = 18;
    _boostMax = 100;
    _boostDrainPerSec = 30;
    _boostCooldown = 0;
    _groundSnapY = 0.6;
    _hitRecoveryDamp = 0.92;

    _grounded = true;
    _groundedFrames = 0;
    _jumpsUsed = 0;
    _prevJump = false;
    _boosting = false;
    _prevBoost = false;
    _yawDeg = 0;            // internal yaw in degrees (kart_drive convention)

    onUpdate(dt) {
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        // Remote proxies or bots ignore input; their movement comes from
        // snapshots / AI respectively.
        if (ni && !ni.isLocalPlayer) return;
        if (this.entity._isBot) return;

        if (this.scene._rocketFrozen) {
            this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
            return;
        }

        var forward = (this.input.isKeyDown("KeyW") ? 1 : 0) - (this.input.isKeyDown("KeyS") ? 1 : 0);
        var steer   = (this.input.isKeyDown("KeyD") ? 1 : 0) - (this.input.isKeyDown("KeyA") ? 1 : 0);
        var jumping = this.input.isKeyDown("Space");
        var boosting = this.input.isKeyDown("ShiftLeft") || this.input.isKeyDown("ShiftRight");
        var braking  = this.input.isKeyDown("KeyQ");  // optional handbrake

        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var curV = rb && rb.getLinearVelocity ? rb.getLinearVelocity() : { x: 0, y: 0, z: 0 };

        // Grounded detection via a vertical-velocity window. We relax a
        // couple of frames after a jump so the double-jump window reads
        // cleanly.
        var wasGrounded = this._grounded;
        this._grounded = Math.abs(curV.y) < 0.7;
        if (this._grounded) {
            this._groundedFrames++;
            if (this._groundedFrames > 3) this._jumpsUsed = 0;
        } else {
            this._groundedFrames = 0;
        }
        if (this._grounded && !wasGrounded) {
            // Landing sfx is cheap — small chance it overlaps; the UI
            // layer can debounce if needed.
            if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactMetal_light_000.ogg", 0.3);
        }

        // Steering — track yaw in degrees (kart_drive convention). Sync
        // from the transform's quaternion each frame so external
        // rotation writes (kickoff _resetCarPositions, round resets)
        // propagate into our forward math. The engine's Y euler is the
        // negative of our logical yaw, mirroring how setRotationEuler
        // maps a -Z-facing model to +X/+Z world directions.
        var q = this.entity.transform.rotation;
        if (q) {
            var engineYawRad = Math.atan2(
                2 * (q.w * q.y + q.x * q.z),
                1 - 2 * (q.y * q.y + q.z * q.z),
            );
            this._yawDeg = -engineYawRad * 180 / Math.PI;
        }
        var steerRate = (this._grounded ? this._steerRate : this._airSteerRate);
        if (Math.abs(steer) > 0.01) {
            var turnDegPerSec = steerRate * 180 / Math.PI;
            this._yawDeg += steer * turnDegPerSec * dt * (forward < 0 ? -1 : 1);
            this.entity.transform.setRotationEuler(0, -this._yawDeg, 0);
        }

        // Forward vector from yaw. The car mesh uses the GLTF default
        // -Z forward (modelRotationY=0), and we negate our _yawDeg when
        // writing the transform, so at _yawDeg=0 engineY=0 and visual
        // forward is -Z. Logical forward matches the kart_drive math.
        var yawRad = this._yawDeg * Math.PI / 180;
        var fx = Math.sin(yawRad);
        var fz = -Math.cos(yawRad);

        // Boost eats the meter; available only if we have any left.
        var boostAvail = this.scene._rocketBoost || {};
        var me = this._myPeerId();
        var myBoost = boostAvail[me] || 0;
        var canBoost = boosting && myBoost > 0;

        // Target velocity along the forward axis (accel/decel), preserving
        // vertical for gravity + jumps. Handbrake bleeds forward speed fast.
        var curForwardSpeed = curV.x * fx + curV.z * fz;
        var targetForward = forward * this._maxSpeed * (forward < 0 ? this._reverseMult : 1);
        if (canBoost) targetForward += this._boostForce;
        var accel = braking ? -this._brakeForce * Math.sign(curForwardSpeed || 1) : (targetForward - curForwardSpeed) * this._accel / this._maxSpeed;

        // Integrate the forward speed change, then recompose velocity.
        var newForwardSpeed = curForwardSpeed + accel * dt;
        // Clamp speed including boost overspill.
        var cap = this._maxSpeed + (canBoost ? this._boostForce : 0);
        if (newForwardSpeed > cap) newForwardSpeed = cap;
        if (newForwardSpeed < -this._maxSpeed * this._reverseMult) newForwardSpeed = -this._maxSpeed * this._reverseMult;

        var vx = fx * newForwardSpeed;
        var vz = fz * newForwardSpeed;
        // Drain lateral velocity toward zero so the car doesn't ice-skate.
        vx = vx * 1.0;
        vz = vz * 1.0;

        // Jumps: first on the ground, second within air window.
        var vy = curV.y;
        if (jumping && !this._prevJump) {
            if (this._grounded) {
                vy = this._jumpImpulse;
                this._jumpsUsed = 1;
                this.scene.events.game.emit("rocket_jump_pressed", {});
                if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaseJump1.ogg", 0.45);
            } else if (this._jumpsUsed < 2) {
                // Double jump — add to current vy up to the double jump impulse.
                vy = Math.max(vy + this._doubleJumpImpulse, this._doubleJumpImpulse);
                this._jumpsUsed = 2;
                this.scene.events.game.emit("rocket_jump_pressed", {});
                if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaseJump3.ogg", 0.4);
            }
        }
        this._prevJump = jumping;

        // Boost emits only on press-transition + while held the match
        // system ticks the drain. That keeps the behavior ignorant of how
        // the meter actually refills.
        if (canBoost) {
            this.scene.events.game.emit("rocket_boost_tick", { amount: this._boostDrainPerSec * dt });
            if (boosting && !this._prevBoost && this.audio) {
                this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/forceField_002.ogg", 0.35);
            }
        }
        this._prevBoost = boosting;

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });

        // Report speed + state for the HUD (speedo + boost bar refresh).
        this.scene._rocketCarLocalState = {
            speed: Math.sqrt(vx * vx + vz * vz),
            grounded: this._grounded,
            boosting: canBoost,
        };
        // Publish yaw + position so the chase camera can sit behind
        // the car without reading the non-existent getRotationEuler.
        this.scene._rocketCar = this.scene._rocketCar || {};
        this.scene._rocketCar.yawDeg = this._yawDeg;
        this.scene._rocketCar.absSpeed = Math.abs(newForwardSpeed);
    }

    _myPeerId() {
        var mp = this.scene._mp;
        return mp && mp.localPeerId || "";
    }
}
