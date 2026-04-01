// FPS camera — attached to the camera entity, follows the player in first person
class CameraFPSBehavior extends GameScript {
    _behaviorName = "fps_camera";
    _active = false;
    _pitchDeg = 0;
    _yawDeg = 0;
    _sensitivity = 0.15;
    _eyeHeight = 1.6;

    onStart() {
        var self = this;
        this.scene.events.game.on("active_behaviors", function(d) {
            self._active = d.behaviors && d.behaviors.indexOf(self._behaviorName) >= 0;
        });
    }

    onUpdate(dt) {
        if (!this._active) return;
        var player = this.scene.findEntityByName("Player");
        if (!player) return;

        var delta = this.input.getMouseDelta();
        this._yawDeg += delta.x * this._sensitivity;
        this._pitchDeg -= delta.y * this._sensitivity;
        if (this._pitchDeg > 89) this._pitchDeg = 89;
        if (this._pitchDeg < -89) this._pitchDeg = -89;

        var pp = player.transform.position;
        this.scene.setPosition(this.entity.id, pp.x, pp.y + this._eyeHeight, pp.z);

        var pitchRad = this._pitchDeg * Math.PI / 180;
        var yawRad = this._yawDeg * Math.PI / 180;
        var lookX = pp.x + Math.sin(yawRad) * Math.cos(pitchRad);
        var lookY = pp.y + this._eyeHeight + Math.sin(pitchRad);
        var lookZ = pp.z - Math.cos(yawRad) * Math.cos(pitchRad);
        this.entity.transform.lookAt(lookX, lookY, lookZ);

        // Share yaw with player movement
        this.scene._fpsYaw = this._yawDeg;
    }
}
