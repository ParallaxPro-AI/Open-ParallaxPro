// also: arcade, fixed view, retro camera, static framing, playfield
// Camera for retro single-screen arcades — fixed position + look-at
// that frames the entire playfield. No follow logic so the view stays
// stable like classic fixed-screen shooters.
//
// Parameters let any arcade template reuse it:
//   _pos         world position of the camera
//   _lookAt      world target for lookAt()
//   _lockYaw     optional forced yaw (ignored if null)
class CameraInvaderFixedBehavior extends GameScript {
    _behaviorName = "camera_invader_fixed";
    _posX = 0;
    _posY = 26;
    _posZ = 28;
    _lookX = 0;
    _lookY = 0;
    _lookZ = -8;
    _initialized = false;

    onUpdate() {
        if (this._initialized) return;
        this.scene.setPosition(this.entity.id, this._posX, this._posY, this._posZ);
        this.entity.transform.lookAt(this._lookX, this._lookY, this._lookZ);
        this._initialized = true;
    }
}
