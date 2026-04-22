// also: overhead, top down, fixed view, arena camera, bird's eye
// Party camera — fixed overhead view centered on the arena
class PartyCameraBehavior extends GameScript {
    _behaviorName = "camera_party";
    _height = 25;
    _offsetZ = 16;
    _lookX = 0;
    _lookZ = 0;

    onStart() {
        this.scene.setPosition(this.entity.id, this._lookX, this._height, this._lookZ + this._offsetZ);
        this.entity.transform.lookAt(this._lookX, 0, this._lookZ);
    }

    onUpdate(dt) {
        // Steady overhead shot — no panning needed for compact arena
        this.scene.setPosition(this.entity.id, this._lookX, this._height, this._lookZ + this._offsetZ);
        this.entity.transform.lookAt(this._lookX, 0, this._lookZ);
    }
}
