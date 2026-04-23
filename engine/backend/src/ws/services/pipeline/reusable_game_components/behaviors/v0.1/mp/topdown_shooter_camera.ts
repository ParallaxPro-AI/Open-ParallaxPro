// also: surviv.io style, aim bias, cursor offset, smooth follow, bounds clamp
// Top-down shooter camera with subtle mouse lean.
//
// Sits above the local player and offsets slightly toward the cursor so
// the player sees more of the area they're aiming at (classic
// surviv.io-style vision-biased view). The lean is capped so the
// player never goes off-screen. Smooth follow + clamp like
// deduction_camera.
class TopdownShooterCameraBehavior extends GameScript {
    _behaviorName = "topdown_shooter_camera";
    _height = 26;
    _tiltOffsetZ = 8;
    _leanStrength = 0.35;
    _maxLean = 7;
    _followSmooth = 8;
    _boundsHalf = 54;

    _x = 0;
    _z = 0;
    _initialized = false;

    onUpdate(dt) {
        var target = this._findLocalPlayer();
        if (!target) return;
        var tpos = target.transform ? target.transform.position : null;
        if (!tpos) return;

        var aim = this.scene._shooterMouseAim;
        var leanX = 0, leanZ = 0;
        if (aim) {
            leanX = (aim.dx || 0) * this._maxLean * this._leanStrength;
            leanZ = (aim.dz || 0) * this._maxLean * this._leanStrength;
        }

        var want = { x: tpos.x + leanX, z: tpos.z + leanZ };
        if (!this._initialized) {
            this._x = want.x; this._z = want.z; this._initialized = true;
        } else {
            var a = Math.min(1, (this._followSmooth || 6) * (dt || 0));
            this._x += (want.x - this._x) * a;
            this._z += (want.z - this._z) * a;
        }

        var cx = this._x, cz = this._z;
        var h = this._boundsHalf;
        if (cx < -h) cx = -h; if (cx > h) cx = h;
        if (cz < -h) cz = -h; if (cz > h) cz = h;

        this.scene.setPosition(this.entity.id, cx, this._height, cz + this._tiltOffsetZ);
        this.entity.transform.lookAt(cx, tpos.y, cz);
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
