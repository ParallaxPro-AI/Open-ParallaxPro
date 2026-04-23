// also: conveyor, oscillation, sine_motion, traversal, dynamic_geometry
// Moving platform — oscillates entity position along an axis
class MovingPlatformBehavior extends GameScript {
    _behaviorName = "moving_platform";
    _range = 5;
    _speed = 1.5;
    _axis = "x";
    _startX = 0;
    _startY = 0;
    _startZ = 0;
    _timer = 0;

    onStart() {
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._startY = pos.y;
        this._startZ = pos.z;
        this._timer = 0;
    }

    onUpdate(dt) {
        this._timer += dt;
        var offset = Math.sin(this._timer * this._speed) * this._range;

        // Compute velocity from derivative of sin (cos)
        var vel = Math.cos(this._timer * this._speed) * this._range * this._speed;

        if (this._axis === "x") {
            this.scene.setVelocity(this.entity.id, { x: vel, y: 0, z: 0 });
            // Correct position drift
            var pos = this.entity.transform.position;
            var targetX = this._startX + offset;
            var error = targetX - pos.x;
            if (Math.abs(error) > 0.5) {
                this.scene.setPosition(this.entity.id, targetX, this._startY, this._startZ);
            }
        } else if (this._axis === "z") {
            this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: vel });
            var pos2 = this.entity.transform.position;
            var targetZ = this._startZ + offset;
            var error2 = targetZ - pos2.z;
            if (Math.abs(error2) > 0.5) {
                this.scene.setPosition(this.entity.id, this._startX, this._startY, targetZ);
            }
        } else {
            this.scene.setVelocity(this.entity.id, { x: 0, y: vel, z: 0 });
            var pos3 = this.entity.transform.position;
            var targetY = this._startY + offset;
            var error3 = targetY - pos3.y;
            if (Math.abs(error3) > 0.5) {
                this.scene.setPosition(this.entity.id, this._startX, targetY, this._startZ);
            }
        }
    }
}
