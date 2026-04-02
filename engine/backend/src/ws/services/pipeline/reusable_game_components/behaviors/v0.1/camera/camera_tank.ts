// Tank camera — chase camera behind the player tank with smooth follow
class TankCameraBehavior extends GameScript {
    _behaviorName = "camera_tank";
    _distance = 14;
    _height = 8;
    _lookHeight = 2;
    _smoothSpeed = 4;
    _camX = 0;
    _camY = 8;
    _camZ = 14;

    onStart() {
        var player = this.scene.findEntityByName("PlayerTank");
        if (player) {
            var pp = player.transform.position;
            this._camX = pp.x;
            this._camY = pp.y + this._height;
            this._camZ = pp.z + this._distance;
        }
    }

    onUpdate(dt) {
        var player = this.scene.findEntityByName("PlayerTank");
        if (!player) return;

        var pp = player.transform.position;
        var yaw = (this.scene._tankYaw || 0) * Math.PI / 180;

        var targetX = pp.x - Math.sin(yaw) * this._distance;
        var targetY = pp.y + this._height;
        var targetZ = pp.z + Math.cos(yaw) * this._distance;

        var t = 1 - Math.exp(-this._smoothSpeed * dt);
        this._camX += (targetX - this._camX) * t;
        this._camY += (targetY - this._camY) * t;
        this._camZ += (targetZ - this._camZ) * t;

        this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);
        this.entity.transform.lookAt(pp.x, pp.y + this._lookHeight, pp.z);
    }
}
