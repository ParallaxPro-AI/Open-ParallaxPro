// MOBA movement — right-click to move, hero walks to target position
class MobaMovementBehavior extends GameScript {
    _behaviorName = "moba_movement";
    _speed = 8;
    _yawDeg = 90;
    _targetX = -45;
    _targetZ = 0;
    _hasTarget = false;
    _arriveThreshold = 0.5;
    _indicatorId = null;
    _indicatorTimer = 0;

    onStart() {
        var pos = this.entity.transform.position;
        this._targetX = pos.x;
        this._targetZ = pos.z;
        this._hasTarget = false;

        var self = this;

        // Listen for right-click from virtual cursor system
        this.scene.events.ui.on("cursor_right_click", function(data) {
            if (self.scene._heroDead) return;
            var ground = self.scene.screenPointToGround(data.x, data.y, 0);
            if (ground) {
                self._targetX = ground.x;
                self._targetZ = ground.z;
                self._hasTarget = true;
                self._spawnIndicator(ground.x, ground.z);
            }
        });

        this.scene.events.game.on("game_ready", function() {
            self._yawDeg = 90;
            self._hasTarget = false;
            var p = self.entity.transform.position;
            self._targetX = p.x;
            self._targetZ = p.z;
        });
    }

    _spawnIndicator(x, z) {
        // Remove old indicator
        if (this._indicatorId) {
            try { this.scene.destroyEntity(this._indicatorId); } catch(e) {}
            this._indicatorId = null;
        }
        // Spawn a small green ring on the ground
        try {
            var ind = this.scene.spawnEntity("move_indicator");
            if (ind) {
                this._indicatorId = ind.id;
                this.scene.setPosition(ind.id, x, 0.05, z);
                this._indicatorTimer = 1.0;
            }
        } catch(e) {}
    }

    onUpdate(dt) {
        if (this.scene._heroDead) {
            this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
            this._hasTarget = false;
            return;
        }

        // Fade out indicator
        if (this._indicatorTimer > 0) {
            this._indicatorTimer -= dt;
            if (this._indicatorTimer <= 0 && this._indicatorId) {
                try { this.scene.destroyEntity(this._indicatorId); } catch(e) {}
                this._indicatorId = null;
            }
        }

        if (!this._hasTarget) {
            this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
            return;
        }

        var pos = this.entity.transform.position;
        var dx = this._targetX - pos.x;
        var dz = this._targetZ - pos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);

        // Arrived at target
        if (dist < this._arriveThreshold) {
            this._hasTarget = false;
            this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
            return;
        }

        // Move toward target
        var vx = (dx / dist) * this._speed;
        var vz = (dz / dist) * this._speed;
        this._yawDeg = Math.atan2(vx, -vz) * 180 / Math.PI;

        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = 0;
        if (rb && rb.getLinearVelocity) {
            vy = rb.getLinearVelocity().y || 0;
        }

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });
        this.entity.transform.setRotationEuler(0, -this._yawDeg, 0);

        // Share yaw for dash direction
        this.scene._heroYaw = this._yawDeg;
    }
}
