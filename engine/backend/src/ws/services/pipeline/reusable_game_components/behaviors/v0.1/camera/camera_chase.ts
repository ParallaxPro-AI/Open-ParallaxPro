// Chase camera — follows player car from behind with smooth interpolation
class ChaseCameraBehavior extends GameScript {
    _behaviorName = "chase_camera";
    _distance = 12;
    _height = 6;
    _lookHeight = 2;
    _smoothSpeed = 4;
    _camX = 0;
    _camY = 6;
    _camZ = 12;

    onStart() {
        var player = this.scene.findEntityByName("Player Car");
        if (player) {
            var pp = player.transform.position;
            this._camX = pp.x;
            this._camY = pp.y + this._height;
            this._camZ = pp.z + this._distance;
        }
    }

    onUpdate(dt) {
        var player = this.scene.findEntityByName("Player Car");
        if (!player) return;

        var pp = player.transform.position;
        var yaw = (this.scene._carYaw || 0) * Math.PI / 180;

        // Target position: behind and above the car
        var targetX = pp.x - Math.sin(yaw) * this._distance;
        var targetY = pp.y + this._height;
        var targetZ = pp.z + Math.cos(yaw) * this._distance;

        // Exponential smooth interpolation
        var t = 1 - Math.exp(-this._smoothSpeed * dt);
        this._camX += (targetX - this._camX) * t;
        this._camY += (targetY - this._camY) * t;
        this._camZ += (targetZ - this._camZ) * t;

        this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);

        // Look at a point above the car
        this.entity.transform.lookAt(pp.x, pp.y + this._lookHeight, pp.z);
    }
}
