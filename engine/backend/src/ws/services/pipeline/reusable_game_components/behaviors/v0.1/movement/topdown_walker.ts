// Top-down walker — WASD movement on the XZ plane, no jumping, no
// vertical input. Designed for twin-stick shooters and dungeon crawlers
// where the camera looks straight down. Movement is camera-relative
// only on the horizontal axes — Y is left to physics (cube colliders
// + gravity will keep the player resting on the floor).
//
// Reusable beyond Cellar Purge: any top-down game can drop this on a
// player prefab. Tune `_speed`/`_acceleration` for game feel — higher
// acceleration is snappier, lower is slidier.
class TopdownWalkerBehavior extends GameScript {
    _behaviorName = "topdown_walker";

    _speed = 7.0;
    _acceleration = 32;       // m/s^2 — high = snappy
    _deceleration = 22;
    _frictionCoef = 8;        // applied when no input
    _matchOver = false;
    _stunUntil = 0;           // scene clock; controlled by match system

    _vx = 0;
    _vz = 0;
    _currentAnim = "";

    onStart() {
        var self = this;
        this.scene.events.game.on("match_ended",   function() { self._matchOver = true; });
        this.scene.events.game.on("match_started", function() { self._matchOver = false; });
        this.scene.events.game.on("cp_player_hurt", function() {
            // Brief stun on hit so the player visibly recoils.
            var t = (self.scene.time && self.scene.time.time) || 0;
            self._stunUntil = t + 0.18;
        });
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

        var nowT = (this.scene.time && this.scene.time.time) || 0;
        var stunned = nowT < this._stunUntil;

        var ix = 0, iz = 0;
        if (!stunned) {
            if (this.input.isKeyDown("KeyW")) iz -= 1;
            if (this.input.isKeyDown("KeyS")) iz += 1;
            if (this.input.isKeyDown("KeyA")) ix -= 1;
            if (this.input.isKeyDown("KeyD")) ix += 1;
        }
        var iLen = Math.sqrt(ix * ix + iz * iz);
        if (iLen > 1e-3) { ix /= iLen; iz /= iLen; }

        // Read current physics velocity so we keep the Y-component for
        // gravity. We control X/Z here.
        var vy = 0;
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        if (rb && rb.getLinearVelocity) {
            var v = rb.getLinearVelocity();
            this._vx = v.x || 0;
            this._vz = v.z || 0;
            vy = v.y || 0;
        }

        // Steer toward the input direction with bounded acceleration.
        if (iLen > 1e-3) {
            var targetVx = ix * this._speed;
            var targetVz = iz * this._speed;
            var dxv = targetVx - this._vx;
            var dzv = targetVz - this._vz;
            var step = this._acceleration * dt;
            var len = Math.sqrt(dxv * dxv + dzv * dzv);
            if (len > step) { dxv = dxv * step / len; dzv = dzv * step / len; }
            this._vx += dxv;
            this._vz += dzv;
        } else {
            // Friction when idle.
            var fk = Math.exp(-this._frictionCoef * dt);
            this._vx *= fk;
            this._vz *= fk;
            if (Math.abs(this._vx) < 0.01) this._vx = 0;
            if (Math.abs(this._vz) < 0.01) this._vz = 0;
        }

        if (stunned) {
            // Stunned — let velocity decay quickly.
            this._vx *= Math.max(0, 1 - dt * 8);
            this._vz *= Math.max(0, 1 - dt * 8);
        }

        this.scene.setVelocity(this.entity.id, { x: this._vx, y: vy, z: this._vz });

        // Face direction of motion (top-down, model rotates around Y).
        var sp = Math.sqrt(this._vx * this._vx + this._vz * this._vz);
        if (sp > 0.5) {
            var ang = Math.atan2(this._vx, this._vz) * 180 / Math.PI;
            this.entity.transform.setRotationEuler(0, ang, 0);
        }

        // Animation hint (optional — many top-down games skip it).
        var anim = sp > 0.5 ? "Run" : "Idle";
        if (anim !== this._currentAnim) {
            this._currentAnim = anim;
            if (this.entity.playAnimation) {
                try { this.entity.playAnimation(anim, { loop: true }); } catch (e) { /* missing clip */ }
            }
        }
    }
}
