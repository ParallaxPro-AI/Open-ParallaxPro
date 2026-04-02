// Surf camera — smooth chase camera with dynamic FOV that increases with speed
class SurfCameraBehavior extends GameScript {
    _behaviorName = "camera_surf";
    _distance = 10;
    _height = 6;
    _lookAhead = 8;
    _smoothSpeed = 6;
    _fovBase = 65;
    _fovMax = 80;

    _camX = 0;
    _camY = 6;
    _camZ = 10;

    onStart() {
        var player = this.scene.findEntityByName("Runner");
        if (player) {
            var pp = player.transform.position;
            this._camX = pp.x;
            this._camY = pp.y + this._height;
            this._camZ = pp.z + this._distance;
        }
    }

    onUpdate(dt) {
        var player = this.scene.findEntityByName("Runner");
        if (!player) return;

        var pp = player.transform.position;

        // Target position: behind and above the runner
        var targetX = pp.x * 0.3;
        var targetY = pp.y + this._height;
        var targetZ = pp.z + this._distance;

        // Exponential smooth interpolation
        var t = 1 - Math.exp(-this._smoothSpeed * dt);
        this._camX += (targetX - this._camX) * t;
        this._camY += (targetY - this._camY) * t;
        this._camZ += (targetZ - this._camZ) * t;

        this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);

        // Look ahead of the runner
        var lookZ = pp.z - this._lookAhead;
        this.entity.transform.lookAt(pp.x * 0.5, pp.y + 1, lookZ);

        // Dynamic FOV based on speed
        var speed = this.scene._surfSpeed || 14;
        var maxSpeed = this.scene._surfMaxSpeed || 32;
        var speedRatio = (speed - 14) / (maxSpeed - 14);
        var fov = this._fovBase + (this._fovMax - this._fovBase) * Math.min(1, speedRatio);
        if (this.entity.camera) {
            this.entity.camera.fov = fov;
        }
    }
}
