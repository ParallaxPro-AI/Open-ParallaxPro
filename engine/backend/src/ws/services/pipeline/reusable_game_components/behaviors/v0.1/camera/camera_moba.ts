// MOBA camera — fixed-angle top-down view following the hero
class MobaCameraBehavior extends GameScript {
    _behaviorName = "moba_camera";
    _height = 20;
    _offsetZ = 14;
    _smoothSpeed = 6;
    _camX = 0;
    _camY = 20;
    _camZ = 14;

    onStart() {
        var player = this.scene.findEntityByName("Hero");
        if (player) {
            var pp = player.transform.position;
            this._camX = pp.x;
            this._camY = pp.y + this._height;
            this._camZ = pp.z + this._offsetZ;
        }
    }

    onUpdate(dt) {
        var player = this.scene.findEntityByName("Hero");
        if (!player) return;

        var pp = player.transform.position;
        var targetX = pp.x;
        var targetY = pp.y + this._height;
        var targetZ = pp.z + this._offsetZ;

        this.scene.setPosition(this.entity.id, targetX, targetY, targetZ);
        this.entity.transform.lookAt(pp.x, pp.y, pp.z);
    }
}
