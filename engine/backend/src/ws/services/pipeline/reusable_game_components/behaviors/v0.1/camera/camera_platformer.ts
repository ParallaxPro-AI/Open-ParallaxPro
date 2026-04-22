// also: side scroller, mouse control, third person, smooth follow, orbit
// Platformer camera — smooth follow with mouse orbit
class PlatformerCameraBehavior extends GameScript {
    _behaviorName = "camera_platformer";
    _distance = 14;
    _height = 7;
    _lookHeight = 2;
    _smoothSpeed = 4;
    _sensitivity = 0.12;
    _yawDeg = 0;
    _pitchDeg = 15;
    _camX = 0;
    _camY = 7;
    _camZ = 14;

    onStart() {
        var player = this.scene.findEntityByName("Player");
        if (player) {
            var pp = player.transform.position;
            this._camX = pp.x;
            this._camY = pp.y + this._height;
            this._camZ = pp.z + this._distance;
        }
    }

    onUpdate(dt) {
        // Mouse orbit
        var delta = this.input.getMouseDelta();
        this._yawDeg += delta.x * this._sensitivity;
        this._pitchDeg += delta.y * this._sensitivity;
        if (this._pitchDeg > 50) this._pitchDeg = 50;
        if (this._pitchDeg < -5) this._pitchDeg = -5;

        this.scene._tpYaw = this._yawDeg;

        var player = this.scene.findEntityByName("Player");
        if (!player) return;

        var pp = player.transform.position;
        var yawRad = this._yawDeg * Math.PI / 180;
        var pitchRad = this._pitchDeg * Math.PI / 180;

        var targetX = pp.x - Math.sin(yawRad) * Math.cos(pitchRad) * this._distance;
        var targetY = pp.y + this._height + Math.sin(pitchRad) * this._distance * 0.4;
        var targetZ = pp.z + Math.cos(yawRad) * Math.cos(pitchRad) * this._distance;

        var t = 1 - Math.exp(-this._smoothSpeed * dt);
        this._camX += (targetX - this._camX) * t;
        this._camY += (targetY - this._camY) * t;
        this._camZ += (targetZ - this._camZ) * t;

        this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);
        this.entity.transform.lookAt(pp.x, pp.y + this._lookHeight, pp.z);
    }
}
