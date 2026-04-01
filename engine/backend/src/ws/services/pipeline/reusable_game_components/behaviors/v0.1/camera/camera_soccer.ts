// Soccer camera — TV broadcast angle following ball movement
class SoccerCameraBehavior extends GameScript {
    _behaviorName = "camera_soccer";
    _height = 32;
    _zOffset = 42;
    _smoothSpeed = 3;
    _camX = 0;
    _camY = 32;
    _camZ = 42;

    onStart() {
        this._camX = 0;
        this._camY = this._height;
        this._camZ = this._zOffset;
    }

    onUpdate(dt) {
        var balls = this.scene.findEntitiesByTag("ball");
        if (!balls || balls.length === 0) return;
        var bp = balls[0].transform.position;

        // Follow ball X smoothly, clamp so we don't go past the pitch
        var targetX = bp.x;
        if (targetX > 30) targetX = 30;
        if (targetX < -30) targetX = -30;

        var t = 1 - Math.exp(-this._smoothSpeed * dt);
        this._camX += (targetX - this._camX) * t;

        this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);
        this.entity.transform.lookAt(this._camX, 0, bp.z * 0.2);
    }
}
