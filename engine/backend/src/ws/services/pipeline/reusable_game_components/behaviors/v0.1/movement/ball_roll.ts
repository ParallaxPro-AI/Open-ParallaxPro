// also: roll-a-ball, marble, sphere-roll, ball-movement, roll-physics
// Camera-relative WASD rolls a physics sphere/ball. Space jumps when grounded.
// Assumes a companion camera behavior writes `scene._ballCamYaw` every frame
// (see camera/ball_chase.ts). The ball is kinematic — this script owns its
// motion directly via setPosition / setVelocity.
//
// ─── Control axis convention ───────────────────────────────────────────────
// Camera yaw 0 with a standard "look-at the ball from behind" setup places the
// camera so that the camera's forward is world -Z. From the camera's POV, the
// player's RIGHT corresponds to world -X. This is the opposite of what the
// naive right-vector formula `(cos yaw, -sin yaw)` would suggest, because the
// camera's view frustum flips handedness relative to world space.
//
// **Rule: KeyD (player's right) must SUBTRACT the (cos,-sin) vector, and KeyA
// must ADD it.** Getting this wrong is why roll-a-ball games ship with A/D
// swapped — the math agrees with itself but disagrees with the user's hand.
class BallRollBehavior extends GameScript {
    _behaviorName = "ball_roll";

    _accel = 26;
    _maxSpeed = 14;
    _friction = 3.0;
    _jumpForce = 8;

    _velX = 0;
    _velZ = 0;
    _spawnX = 0;
    _spawnY = 0;
    _spawnZ = 0;

    onStart() {
        var p = this.entity.transform.position;
        this._spawnX = p.x;
        this._spawnY = p.y;
        this._spawnZ = p.z;

        var self = this;
        this.scene.events.game.on("restart_game", function () {
            self._velX = 0;
            self._velZ = 0;
            self.scene.setPosition(self.entity.id, self._spawnX, self._spawnY, self._spawnZ);
            self.scene.setVelocity(self.entity.id, { x: 0, y: 0, z: 0 });
        });
    }

    onUpdate(dt) {
        var input = this.input;
        if (!input) return;

        // Camera yaw is written by the chase camera each frame. Without it
        // we use yaw=0 and hope for the best.
        var yawDeg = (this.scene._ballCamYaw || 0);
        var yawRad = yawDeg * Math.PI / 180;
        // Camera-forward in world (engine convention: -Z forward at yaw 0).
        var fx = Math.sin(yawRad);
        var fz = Math.cos(yawRad);
        // Camera-right in world — derived from forward rotated -90° on Y.
        var rx = Math.cos(yawRad);
        var rz = -Math.sin(yawRad);

        var ix = 0, iz = 0;
        if (input.isKeyDown("KeyW") || input.isKeyDown("ArrowUp"))    { ix += fx; iz += fz; }
        if (input.isKeyDown("KeyS") || input.isKeyDown("ArrowDown"))  { ix -= fx; iz -= fz; }
        // A/D signs below are the load-bearing detail. See header comment.
        if (input.isKeyDown("KeyA") || input.isKeyDown("ArrowLeft"))  { ix += rx; iz += rz; }
        if (input.isKeyDown("KeyD") || input.isKeyDown("ArrowRight")) { ix -= rx; iz -= rz; }

        var len = Math.sqrt(ix * ix + iz * iz);
        if (len > 0.001) { ix /= len; iz /= len; }

        if (len > 0.001) {
            this._velX += ix * this._accel * dt;
            this._velZ += iz * this._accel * dt;
        } else {
            // Friction when no input.
            var f = this._friction * dt;
            if (Math.abs(this._velX) <= f) this._velX = 0; else this._velX -= f * Math.sign(this._velX);
            if (Math.abs(this._velZ) <= f) this._velZ = 0; else this._velZ -= f * Math.sign(this._velZ);
        }

        // Cap horizontal speed.
        var sp = Math.sqrt(this._velX * this._velX + this._velZ * this._velZ);
        if (sp > this._maxSpeed) {
            this._velX = (this._velX / sp) * this._maxSpeed;
            this._velZ = (this._velZ / sp) * this._maxSpeed;
        }

        // Preserve Y velocity from physics (gravity + any active jump).
        var vy = 0;
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        if (rb && rb.getLinearVelocity) vy = rb.getLinearVelocity().y || 0;

        // Jump — uses rb.isGrounded which is authoritative after the engine's
        // contact-manifold + short-downray check (no apex false-positive).
        var grounded = !!(rb && rb.isGrounded === true);
        if (input.isKeyPressed("Space") && grounded) {
            vy = this._jumpForce;
        }

        this.scene.setVelocity(this.entity.id, { x: this._velX, y: vy, z: this._velZ });
    }
}
