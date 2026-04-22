// also: ship control, artillery targeting, free orbit, naval combat
// Galleon orbit camera — chase camera that hovers behind the ship and
// can be orbited freely with the mouse for cannon aiming. Uses the ship
// yaw as a base orientation but lets the player drift the camera off-
// axis so they can sight a port/starboard target without turning.
//
// Multiplayer: targets the LOCAL player's ship via NetworkIdentity. In
// single-player templates the entity tagged "player" wins.
class CameraGalleonBehavior extends GameScript {
    _behaviorName = "camera_galleon";
    _distance = 13;
    _height = 6.2;
    _lookHeight = 1.3;
    _smoothSpeed = 5.5;
    _sensitivity = 0.18;
    _minPitchDeg = -25;
    _maxPitchDeg = 60;
    _yawDeg = 0;          // mouse-driven yaw offset relative to ship yaw
    _pitchDeg = 18;       // mouse-driven pitch
    _camX = 0;
    _camY = 6.2;
    _camZ = 13;
    _bound = false;
    _initX = 0;
    _initZ = 0;

    onStart() {
        var ship = this._findLocalShip();
        if (ship && ship.transform) {
            var pp = ship.transform.position;
            this._initX = pp.x;
            this._initZ = pp.z;
            this._camX = pp.x;
            this._camY = (pp.y || 0) + this._height;
            this._camZ = pp.z + this._distance;
        }
    }

    onUpdate(dt) {
        var ship = this._findLocalShip();
        if (!ship || !ship.transform) return;

        // Mouse orbit — only when pointer is locked or gameplay is active.
        var delta = this.input && this.input.getMouseDelta ? this.input.getMouseDelta() : { x: 0, y: 0 };
        // Right click is reserved for starboard cannons — orbit always.
        this._yawDeg += delta.x * this._sensitivity;
        this._pitchDeg += delta.y * this._sensitivity;
        if (this._pitchDeg < this._minPitchDeg) this._pitchDeg = this._minPitchDeg;
        if (this._pitchDeg > this._maxPitchDeg) this._pitchDeg = this._maxPitchDeg;
        // Wrap yaw to keep numbers bounded.
        while (this._yawDeg > 360) this._yawDeg -= 360;
        while (this._yawDeg < -360) this._yawDeg += 360;

        var shipYaw = (this.scene._shipYaw || 0);
        var combinedYaw = (shipYaw + this._yawDeg) * Math.PI / 180;
        var pitchRad = this._pitchDeg * Math.PI / 180;

        var sp = ship.transform.position;
        // Target camera position: behind the combined yaw, lifted by pitch.
        var targetX = sp.x - Math.sin(combinedYaw) * this._distance * Math.cos(pitchRad);
        var targetZ = sp.z + Math.cos(combinedYaw) * this._distance * Math.cos(pitchRad);
        var targetY = (sp.y || 0) + this._height + Math.sin(pitchRad) * this._distance;

        // Exponential smooth lerp toward target.
        var t = 1 - Math.exp(-this._smoothSpeed * dt);
        this._camX += (targetX - this._camX) * t;
        this._camY += (targetY - this._camY) * t;
        this._camZ += (targetZ - this._camZ) * t;

        if (this.scene.setPosition) this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);
        if (this.entity.transform.lookAt) this.entity.transform.lookAt(sp.x, (sp.y || 0) + this._lookHeight, sp.z);

        // Share for cannon aiming logic that needs the look direction.
        this.scene._cameraShipYawDeg = shipYaw + this._yawDeg;
        this.scene._cameraShipPitchDeg = this._pitchDeg;
    }

    _findLocalShip() {
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < all.length; i++) {
            var e = all[i];
            var ni = e.getComponent ? e.getComponent("NetworkIdentityComponent") : null;
            if (!ni) return e;
            if (ni.isLocalPlayer) return e;
        }
        return all[0] || null;
    }
}
