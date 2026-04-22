// also: tower-defense, isometric-view, grid-based, tactical
// Tower defense camera — top-down isometric view with WASD panning
class TDCameraBehavior extends GameScript {
    _behaviorName = "camera_td";
    _height = 38;
    _offsetZ = 22;
    _panSpeed = 25;
    _lookX = 0;
    _lookZ = 0;

    onStart() {
        this.scene.setPosition(this.entity.id, this._lookX, this._height, this._lookZ + this._offsetZ);
        this.entity.transform.lookAt(this._lookX, 0, this._lookZ);
    }

    onUpdate(dt) {
        // WASD to pan
        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) this._lookZ -= this._panSpeed * dt;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) this._lookZ += this._panSpeed * dt;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft")) this._lookX -= this._panSpeed * dt;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) this._lookX += this._panSpeed * dt;

        // Clamp
        this._lookX = Math.max(-30, Math.min(30, this._lookX));
        this._lookZ = Math.max(-25, Math.min(25, this._lookZ));

        this.scene.setPosition(this.entity.id, this._lookX, this._height, this._lookZ + this._offsetZ);
        this.entity.transform.lookAt(this._lookX, 0, this._lookZ);
    }
}
