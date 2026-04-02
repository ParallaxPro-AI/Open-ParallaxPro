// Sandbox camera — first-person camera with mouse look for survival games
class SandboxCameraBehavior extends GameScript {
    _behaviorName = "camera_sandbox";
    _sensitivity = 0.15;
    _eyeHeight = 1.6;
    _yaw = 0;
    _pitch = 0;

    onStart() {
        this._yaw = 0;
        this._pitch = 0;
    }

    onUpdate(dt) {
        var player = this.scene.findEntityByName("Player");
        if (!player) return;

        var delta = this.input.getMouseDelta ? this.input.getMouseDelta() : { x: 0, y: 0 };
        this._yaw += delta.x * this._sensitivity;
        this._pitch += delta.y * this._sensitivity;
        this._pitch = Math.max(-80, Math.min(80, this._pitch));

        var pp = player.transform.position;
        this.scene.setPosition(this.entity.id, pp.x, pp.y + this._eyeHeight, pp.z);

        var yawRad = this._yaw * Math.PI / 180;
        var pitchRad = this._pitch * Math.PI / 180;
        var lookX = pp.x + Math.sin(yawRad) * Math.cos(pitchRad) * 10;
        var lookY = pp.y + this._eyeHeight - Math.sin(pitchRad) * 10;
        var lookZ = pp.z - Math.cos(yawRad) * Math.cos(pitchRad) * 10;

        this.entity.transform.lookAt(lookX, lookY, lookZ);

        this.scene._fpsYaw = this._yaw;
        this.scene._fpsPitch = this._pitch;
    }
}
