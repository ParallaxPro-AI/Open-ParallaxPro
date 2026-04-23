// also: real-time-strategy, WASD-panning, top-down, isometric-view
// RTS camera — top-down with WASD pan and zoom
class RTSCameraBehavior extends GameScript {
    _behaviorName = "camera_rts";
    _height = 30; _offsetZ = 18; _panSpeed = 30; _zoomSpeed = 8; _minZoom = 15; _maxZoom = 50;
    _lookX = 0; _lookZ = 0;
    onStart() { this.scene.setPosition(this.entity.id, this._lookX, this._height, this._lookZ + this._offsetZ); this.entity.transform.lookAt(this._lookX, 0, this._lookZ); }
    onUpdate(dt) {
        if (this.input.isKeyDown("KeyW")||this.input.isKeyDown("ArrowUp")) this._lookZ -= this._panSpeed*dt;
        if (this.input.isKeyDown("KeyS")||this.input.isKeyDown("ArrowDown")) this._lookZ += this._panSpeed*dt;
        if (this.input.isKeyDown("KeyA")||this.input.isKeyDown("ArrowLeft")) this._lookX -= this._panSpeed*dt;
        if (this.input.isKeyDown("KeyD")||this.input.isKeyDown("ArrowRight")) this._lookX += this._panSpeed*dt;
        if (this.input.isKeyDown("Equal")) this._height = Math.max(this._minZoom, this._height - this._zoomSpeed*dt);
        if (this.input.isKeyDown("Minus")) this._height = Math.min(this._maxZoom, this._height + this._zoomSpeed*dt);
        this._lookX = Math.max(-60, Math.min(60, this._lookX));
        this._lookZ = Math.max(-60, Math.min(60, this._lookZ));
        this.scene.setPosition(this.entity.id, this._lookX, this._height, this._lookZ + this._offsetZ);
        this.entity.transform.lookAt(this._lookX, 0, this._lookZ);
    }
}
