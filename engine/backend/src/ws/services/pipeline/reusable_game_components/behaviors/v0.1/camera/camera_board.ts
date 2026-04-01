// Board camera — angled view from behind white, right-click orbit
class CameraBoardBehavior extends GameScript {
    _behaviorName = "board_camera";
    _height = 10;
    _tilt = 65;
    _centerX = 3.5;
    _centerZ = 3.5;
    _yaw = 0;

    onStart() {
        var self = this;
        // Allow other systems to set the camera yaw (e.g. for multiplayer color swap)
        this.scene.events.game.on("set_camera_yaw", function(data) {
            if (data.yaw !== undefined) self._yaw = data.yaw;
        });
    }

    onUpdate(dt) {

        // Right-click drag to orbit
        if (this.input.isKeyDown("MouseRight")) {
            var delta = this.input.getMouseDelta();
            this._yaw -= delta.x * 0.3;
        }

        var tiltRad = this._tilt * Math.PI / 180;
        var yawRad = this._yaw * Math.PI / 180;

        var cx = this._centerX + Math.sin(yawRad) * Math.cos(tiltRad) * this._height;
        var cy = Math.sin(tiltRad) * this._height;
        var cz = this._centerZ + Math.cos(yawRad) * Math.cos(tiltRad) * this._height;

        this.scene.setPosition(this.entity.id, cx, cy, cz);
        this.entity.transform.lookAt(this._centerX, 0, this._centerZ);
    }
}
