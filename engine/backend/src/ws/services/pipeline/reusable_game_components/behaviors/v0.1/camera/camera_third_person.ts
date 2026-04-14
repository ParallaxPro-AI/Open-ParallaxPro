// Third-person camera — orbit with mouse on foot, chase camera in vehicles
class ThirdPersonCameraBehavior extends GameScript {
    _behaviorName = "camera_third_person";
    _distance = 8;
    _height = 4;
    _lookHeight = 1.5;
    _smoothSpeed = 6;
    _sensitivity = 0.15;
    _yawDeg = 0;
    _pitchDeg = 15;
    _camX = 0;
    _camY = 4;
    _camZ = 8;

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
        var delta = this.input.getMouseDelta();

        if (this.scene._inVehicle && this.scene._vehicleEntity) {
            this._updateVehicleCamera(dt, delta);
        } else {
            this._updateOrbitCamera(dt, delta);
        }
    }

    _updateOrbitCamera(dt, delta) {
        this._yawDeg += delta.x * this._sensitivity;
        this._pitchDeg += delta.y * this._sensitivity;
        if (this._pitchDeg > 89) this._pitchDeg = 89;
        if (this._pitchDeg < -89) this._pitchDeg = -89;

        this.scene._tpYaw = this._yawDeg;

        var target = this.scene.findEntityByName("Player");
        if (!target) return;

        var tp = target.transform.position;
        var yawRad = this._yawDeg * Math.PI / 180;
        var pitchRad = this._pitchDeg * Math.PI / 180;

        var targetX = tp.x - Math.sin(yawRad) * Math.cos(pitchRad) * this._distance;
        var targetY = tp.y + this._height + Math.sin(pitchRad) * this._distance;
        var targetZ = tp.z + Math.cos(yawRad) * Math.cos(pitchRad) * this._distance;

        var t = 1 - Math.exp(-this._smoothSpeed * dt);
        this._camX += (targetX - this._camX) * t;
        this._camY += (targetY - this._camY) * t;
        this._camZ += (targetZ - this._camZ) * t;

        this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);
        this.entity.transform.lookAt(tp.x, tp.y + this._lookHeight, tp.z);
    }

    _updateVehicleCamera(dt, delta) {
        var vehicle = this.scene._vehicleEntity;
        var vp = vehicle.transform.position;
        var vehicleYaw = (this.scene._carYaw || 0) * Math.PI / 180;

        var vDist = this._distance * 1.4;
        var vHeight = this._height * 1.3;

        var targetX = vp.x - Math.sin(vehicleYaw) * vDist;
        var targetY = vp.y + vHeight;
        var targetZ = vp.z + Math.cos(vehicleYaw) * vDist;

        var t = 1 - Math.exp(-this._smoothSpeed * 0.7 * dt);
        this._camX += (targetX - this._camX) * t;
        this._camY += (targetY - this._camY) * t;
        this._camZ += (targetZ - this._camZ) * t;

        this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);
        this.entity.transform.lookAt(vp.x, vp.y + 1.5, vp.z);

        this.scene._tpYaw = this.scene._carYaw || 0;
    }
}
