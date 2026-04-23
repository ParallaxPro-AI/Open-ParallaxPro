// also: 2.5D-platformer, parallax-view, tilt-bias, isometric-tilt
// Sidescroll camera — rides at fixed Z offset off the action plane and
// tracks the local player on XY. Smooth-follow with a soft "look-ahead"
// in the direction of motion so the player can see what's coming. A tiny
// vertical bias keeps the view tilted slightly downward for that classic
// 2.5D platformer parallax read.
//
// Reusable by any 2.5D side-view game. Tune `_distance` for zoom level,
// `_lookAhead` for predictive framing, `_tiltDegrees` for how isometric
// the view feels.
class CameraSidescrollBehavior extends GameScript {
    _behaviorName = "camera_sidescroll";

    _distance = 16;          // camera Z offset from the action plane
    _smoothSpeed = 5.0;
    _lookAhead = 2.5;        // how far ahead of the player to push the framing
    _verticalOffset = 1.5;   // bias the camera slightly above the player
    _tiltDegrees = 6;        // 0 = pure side-on; positive tilts down
    _zLockAtValue = 0;       // matches the player's locked Z

    onStart() {
        this._currentX = 0;
        this._currentY = 0;
        this._lookOffset = 0;
        this._initialized = false;
    }

    onUpdate(dt) {
        var target = this._findLocalPlayer();
        if (!target) return;
        var tpos = target.transform ? target.transform.position : null;
        if (!tpos) return;

        // Estimate player horizontal velocity for look-ahead. Using
        // physics is the cheapest read; if the rigidbody isn't there,
        // fall back to zero (still tracks, just no preview).
        var vx = 0;
        var rb = target.getComponent ? target.getComponent("RigidbodyComponent") : null;
        if (rb && rb.getLinearVelocity) vx = rb.getLinearVelocity().x || 0;
        var desiredLook = Math.max(-this._lookAhead, Math.min(this._lookAhead, vx * 0.3));

        var desiredX = tpos.x + desiredLook;
        var desiredY = tpos.y + this._verticalOffset;

        if (!this._initialized) {
            this._currentX = desiredX;
            this._currentY = desiredY;
            this._lookOffset = desiredLook;
            this._initialized = true;
        } else {
            // Frame-rate independent lerp via 1-exp(-k*dt). Snappier than
            // a fixed alpha, no mass-spring oscillation.
            var t = 1 - Math.exp(-this._smoothSpeed * dt);
            this._currentX += (desiredX - this._currentX) * t;
            this._currentY += (desiredY - this._currentY) * t;
            this._lookOffset += (desiredLook - this._lookOffset) * t;
        }

        // Park camera off the action plane on +Z, tilted slightly so the
        // ground reads as foreshortened — feels less flat than 0-degree
        // orthographic side view.
        var tiltRad = this._tiltDegrees * Math.PI / 180;
        var camZ = this._zLockAtValue + this._distance;
        var camY = this._currentY + Math.sin(tiltRad) * this._distance;
        this.scene.setPosition(this.entity.id, this._currentX, camY, camZ);

        // Look back at the player's plane — this auto-handles the orient
        // so we don't have to wrestle with Euler conventions.
        this.entity.transform.lookAt(this._currentX, this._currentY, this._zLockAtValue);
    }

    _findLocalPlayer() {
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
