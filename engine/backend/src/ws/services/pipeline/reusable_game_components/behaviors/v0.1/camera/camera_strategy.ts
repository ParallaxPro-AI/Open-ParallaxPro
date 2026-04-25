// also: RTS-camera, edge-panning, zoom-control, strategy-game
// Strategy camera — top-down RTS camera with WASD pan and zoom
class StrategyCameraBehavior extends GameScript {
    _behaviorName = "strategy_camera";
    _height = 40;
    _angle = 55;
    _panSpeed = 35;
    _zoomSpeed = 10;
    _minZoom = 20;
    _maxZoom = 65;
    _edgeScrollSpeed = 25;
    _edgeScrollMargin = 25;
    _smoothSpeed = 8;
    _boundsX = [-85, 85];
    _boundsZ = [-85, 85];
    _rotateSpeed = 60;
    _lookX = 0;
    _lookZ = 0;

    onStart() {
        this._updateCamera();
    }

    onUpdate(dt) {
        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) this._lookZ -= this._panSpeed * dt;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) this._lookZ += this._panSpeed * dt;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft")) this._lookX -= this._panSpeed * dt;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) this._lookX += this._panSpeed * dt;

        // Zoom
        if (this.input.isKeyDown("Equal") || this.input.isKeyDown("NumpadAdd")) this._height = Math.max(this._minZoom, this._height - this._zoomSpeed * dt);
        if (this.input.isKeyDown("Minus") || this.input.isKeyDown("NumpadSubtract")) this._height = Math.min(this._maxZoom, this._height + this._zoomSpeed * dt);

        this._lookX = Math.max(this._boundsX[0], Math.min(this._boundsX[1], this._lookX));
        this._lookZ = Math.max(this._boundsZ[0], Math.min(this._boundsZ[1], this._lookZ));

        this._updateCamera();
    }

    _updateCamera() {
        var rad = this._angle * Math.PI / 180;
        var offsetZ = Math.cos(rad) * this._height;
        var offsetY = Math.sin(rad) * this._height;
        this.scene.setPosition(this.entity.id, this._lookX, offsetY, this._lookZ + offsetZ);
        this.entity.transform.lookAt(this._lookX, 0, this._lookZ);
        // Expose the camera's ground-plane center so other systems (e.g.
        // civilization_core's M-to-move fallback) can read it. Without
        // this they default to (0,0,0) and the unit always walks to the
        // map origin no matter where the camera was panned.
        this.scene._stratCamX = this._lookX;
        this.scene._stratCamZ = this._lookZ;
    }
}
