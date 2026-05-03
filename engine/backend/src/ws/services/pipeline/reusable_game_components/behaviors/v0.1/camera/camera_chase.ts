// also: third person, vehicle follow, rear view, smoothing, interpolation
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
    _lookX = 0;
    _lookY = 2;
    _lookZ = 0;

    onStart() {
        var player = this.scene.findEntityByName("Player Car");
        if (player) {
            var pp = player.transform.position;
            this._camX = pp.x;
            this._camY = pp.y + this._height;
            this._camZ = pp.z + this._distance;
            this._lookX = pp.x;
            this._lookY = pp.y + this._lookHeight;
            this._lookZ = pp.z;
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

        // Horizontal follows at configured speed; vertical uses a slower
        // rate so physics micro-bounces don't transfer to camera shake.
        var tXZ = 1 - Math.exp(-this._smoothSpeed * dt);
        var tY = 1 - Math.exp(-this._smoothSpeed * 0.3 * dt);
        this._camX += (targetX - this._camX) * tXZ;
        this._camY += (targetY - this._camY) * tY;
        this._camZ += (targetZ - this._camZ) * tXZ;

        this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);

        // Smooth look target to prevent rotational jitter
        var lookTargetX = pp.x;
        var lookTargetY = pp.y + this._lookHeight;
        var lookTargetZ = pp.z;
        var tLook = 1 - Math.exp(-this._smoothSpeed * 0.6 * dt);
        this._lookX += (lookTargetX - this._lookX) * tLook;
        this._lookY += (lookTargetY - this._lookY) * tLook;
        this._lookZ += (lookTargetZ - this._lookZ) * tLook;

        this.entity.transform.lookAt(this._lookX, this._lookY, this._lookZ);
    }
}
