// Spinning obstacle — rotates entity continuously around an axis
class SpinningObstacleBehavior extends GameScript {
    _behaviorName = "spinning_obstacle";
    _rotationSpeed = 60;
    _axis = "y";
    _angle = 0;
    _originX = 0;
    _originY = 0;
    _originZ = 0;

    onStart() {
        var pos = this.entity.transform.position;
        this._originX = pos.x;
        this._originY = pos.y;
        this._originZ = pos.z;
        this._angle = 0;
    }

    onUpdate(dt) {
        this._angle += this._rotationSpeed * dt;

        // Keep position locked (counteract any physics drift)
        this.scene.setPosition(this.entity.id, this._originX, this._originY, this._originZ);
        this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });

        if (this._axis === "y") {
            this.entity.transform.setRotationEuler(0, this._angle, 0);
        } else if (this._axis === "x") {
            this.entity.transform.setRotationEuler(this._angle, 0, 0);
        } else {
            this.entity.transform.setRotationEuler(0, 0, this._angle);
        }
    }
}
