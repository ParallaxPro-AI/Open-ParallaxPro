// Racing AI — follows waypoints around the track at a set speed
class RacingAIBehavior extends GameScript {
    _behaviorName = "racing_ai";
    _speed = 20;
    _turnSpeed = 3;
    _waypoints = [];
    _waypointIndex = 0;
    _yawDeg = 0;
    _startX = 0;
    _startZ = 0;

    onStart() {
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._startZ = pos.z;
        this._waypointIndex = 0;
        this._yawDeg = 0;

        var self = this;
        this.scene.events.game.on("race_start", function() {
            self._waypointIndex = 0;
            self._yawDeg = 0;
            self.scene.setPosition(self.entity.id, self._startX, 0, self._startZ);
            self.scene.setVelocity(self.entity.id, { x: 0, y: 0, z: 0 });
            self.entity.transform.setRotationEuler(0, 0, 0);
        });
    }

    onUpdate(dt) {
        if (!this._waypoints || this._waypoints.length === 0) return;

        var wp = this._waypoints[this._waypointIndex];
        var pos = this.entity.transform.position;
        var dx = wp[0] - pos.x;
        var dz = wp[1] - pos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);

        // Reached waypoint — advance to next
        if (dist < 5) {
            this._waypointIndex++;
            if (this._waypointIndex >= this._waypoints.length) {
                this._waypointIndex = 0;
            }
            return;
        }

        // Smooth turn towards waypoint
        var targetYaw = Math.atan2(dx, -dz) * 180 / Math.PI;
        var diff = targetYaw - this._yawDeg;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        this._yawDeg += diff * this._turnSpeed * dt;

        // Move forward at constant speed
        var yawRad = this._yawDeg * Math.PI / 180;
        var vx = Math.sin(yawRad) * this._speed;
        var vz = -Math.cos(yawRad) * this._speed;

        // Preserve vertical velocity for gravity
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = 0;
        if (rb && rb.getLinearVelocity) {
            vy = rb.getLinearVelocity().y || 0;
        }

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });
        this.entity.transform.setRotationEuler(0, -this._yawDeg, 0);
    }
}
