// also: conveyor, oscillation, sine_motion, traversal, dynamic_geometry
// Moving platform — oscillates entity position along an axis.
//
// Also carries rigidbodies standing on top so the player rides with the
// platform instead of sliding off. The engine's PhysicsSystem (Rapier) has
// no built-in kinematic-platform-rider constraint, so this behavior handles
// it explicitly: each frame, compute the platform's own delta position,
// find any dynamic rigidbody whose XZ bounds overlap the platform and whose
// feet are within one step above the platform top, and translate that body
// by the same delta. Simple, no physics-system coupling.
class MovingPlatformBehavior extends GameScript {
    _behaviorName = "moving_platform";
    _range = 5;
    _speed = 1.5;
    _axis = "x";
    // "Rider" detection box, relative to the platform top. Bodies whose
    // center sits inside this slab are treated as standing on the platform.
    // The slab is deliberately a bit wider than the platform's visible
    // footprint so slightly-overhanging feet still count.
    _riderSlabHeight = 1.5;
    _riderPadXZ = 0.3;
    _startX = 0;
    _startY = 0;
    _startZ = 0;
    _timer = 0;
    _lastX = 0;
    _lastY = 0;
    _lastZ = 0;

    onStart() {
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._startY = pos.y;
        this._startZ = pos.z;
        this._timer = 0;
        this._lastX = pos.x;
        this._lastY = pos.y;
        this._lastZ = pos.z;

        var self = this;
        this.scene.events.game.on("restart_game", function () {
            self._timer = 0;
            self.scene.setPosition(self.entity.id, self._startX, self._startY, self._startZ);
            self._lastX = self._startX;
            self._lastY = self._startY;
            self._lastZ = self._startZ;
        });
    }

    onUpdate(dt) {
        this._timer += dt;
        var offset = Math.sin(this._timer * this._speed) * this._range;

        // Snapshot pre-move position — we need it AFTER the move to compute
        // the delta to apply to riders.
        var beforeX = this._lastX;
        var beforeY = this._lastY;
        var beforeZ = this._lastZ;

        var targetX = this._startX;
        var targetY = this._startY;
        var targetZ = this._startZ;
        if (this._axis === "x") targetX = this._startX + offset;
        else if (this._axis === "z") targetZ = this._startZ + offset;
        else targetY = this._startY + offset;

        // Move via setPosition — makes the platform feel solid when the
        // player jumps on it, which setVelocity alone doesn't. Kinematic
        // body so Rapier treats it as immovable by dynamic collisions.
        this.scene.setPosition(this.entity.id, targetX, targetY, targetZ);

        var dx = targetX - beforeX;
        var dy = targetY - beforeY;
        var dz = targetZ - beforeZ;

        // Only bother with rider transfer if we actually moved.
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-5) {
            this._carryRiders(targetX, targetY, targetZ, dx, dy, dz);
        }

        this._lastX = targetX;
        this._lastY = targetY;
        this._lastZ = targetZ;
    }

    _carryRiders(px, py, pz, dx, dy, dz) {
        // Figure out our half-extents so we know the rider-detection slab.
        // Read the collider component directly; we're a kinematic body so
        // halfExtents is authoritative.
        var col = this.entity.getComponent
            ? this.entity.getComponent("ColliderComponent")
            : null;
        var he = col && col.halfExtents ? col.halfExtents : { x: 0.5, y: 0.5, z: 0.5 };
        var scale = this.entity.transform && this.entity.transform.scale
            ? this.entity.transform.scale
            : { x: 1, y: 1, z: 1 };
        var hx = Math.abs(he.x) * Math.abs(scale.x) + this._riderPadXZ;
        var hy = Math.abs(he.y) * Math.abs(scale.y);
        var hz = Math.abs(he.z) * Math.abs(scale.z) + this._riderPadXZ;
        var topY = py + hy;

        // Iterate all entities — cheap at generated-game scales (< 1k ents).
        var all = this.scene.getAllEntities ? this.scene.getAllEntities() : [];
        for (var i = 0; i < all.length; i++) {
            var e = all[i];
            if (!e || e.id === this.entity.id) continue;
            var rb = e.getComponent ? e.getComponent("RigidbodyComponent") : null;
            if (!rb) continue;
            // Only carry dynamic bodies. Static/kinematic don't need it.
            var bodyType = rb.bodyType || rb.type;
            if (bodyType !== "dynamic" && bodyType !== 2) continue;

            var t = e.transform;
            if (!t) continue;
            var ep = t.position;
            // XZ bounds check (ignore Y for width — rider can be tall).
            if (ep.x < px - hx || ep.x > px + hx) continue;
            if (ep.z < pz - hz || ep.z > pz + hz) continue;
            // Vertical: rider's feet roughly at ep.y - ec.halfExtents.y.
            // Treat as riding if the rider's center is within riderSlabHeight
            // above the platform top. (A jumping player above the slab is NOT
            // carried, which is correct.)
            if (ep.y < topY - 0.1) continue;
            if (ep.y > topY + this._riderSlabHeight) continue;

            // Translate the rider by the same delta. For horizontal motion
            // we also nudge velocity so the rider keeps drifting for one
            // frame after they step off — avoids a visible hitch.
            var newVel;
            if (rb.getLinearVelocity) newVel = rb.getLinearVelocity();
            else newVel = rb.velocity || { x: 0, y: 0, z: 0 };
            this.scene.setPosition(e.id, ep.x + dx, ep.y + dy, ep.z + dz);
            // Don't overwrite Y velocity — the player may be in the middle
            // of gravity integration; just transfer XZ so motion feels one-to-one.
            if (dx !== 0 || dz !== 0) {
                this.scene.setVelocity(e.id, {
                    x: newVel.x + dx / (1 / 60),
                    y: newVel.y,
                    z: newVel.z + dz / (1 / 60),
                });
            }
        }
    }
}
