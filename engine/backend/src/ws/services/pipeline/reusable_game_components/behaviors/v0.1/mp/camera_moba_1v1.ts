// MOBA 1v1 isometric camera — locked 3/4 top-down view of the local
// champion with an optional peek toward the mouse cursor so the
// player can see more of the lane they're aiming at.
//
// Parameters let any iso-action game reuse this:
//   _height / _tiltOffsetZ   overall angle + lean behind the champion
//   _cursorLean              how much the frame shifts toward the mouse
//   _followSmooth            responsiveness
class CameraMoba1v1Behavior extends GameScript {
    _behaviorName = "camera_moba_1v1";
    _height = 22;
    _tiltOffsetZ = 14;
    _cursorLean = 3;
    _followSmooth = 6;
    _boundsHalfX = 64;
    _boundsHalfZ = 64;

    _x = 0;
    _z = 0;
    _initialized = false;

    onUpdate(dt) {
        var player = this._findLocalChampion();
        if (!player) return;
        var pp = player.transform.position;

        var aim = this.scene._riftMouseAim;
        var leanX = 0, leanZ = 0;
        if (aim) {
            var dx = aim.x - pp.x, dz = aim.z - pp.z;
            var L = Math.sqrt(dx * dx + dz * dz) || 1;
            leanX = (dx / L) * this._cursorLean * 0.4;
            leanZ = (dz / L) * this._cursorLean * 0.4;
        }
        var tx = pp.x + leanX;
        var tz = pp.z + leanZ;

        if (!this._initialized) {
            this._x = tx; this._z = tz; this._initialized = true;
        } else {
            var a = Math.min(1, (this._followSmooth || 6) * (dt || 0));
            this._x += (tx - this._x) * a;
            this._z += (tz - this._z) * a;
        }
        if (this._x < -this._boundsHalfX) this._x = -this._boundsHalfX;
        if (this._x >  this._boundsHalfX) this._x =  this._boundsHalfX;
        if (this._z < -this._boundsHalfZ) this._z = -this._boundsHalfZ;
        if (this._z >  this._boundsHalfZ) this._z =  this._boundsHalfZ;

        this.scene.setPosition(this.entity.id, this._x, this._height, this._z + this._tiltOffsetZ);
        this.entity.transform.lookAt(this._x, 0, this._z);
    }

    _findLocalChampion() {
        var players = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("champion") : [];
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            var ni = p.getComponent("NetworkIdentityComponent");
            if (ni && ni.isLocalPlayer) return p;
        }
        // Fallbacks.
        var tagPlayers = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var j = 0; j < tagPlayers.length; j++) {
            var p2 = tagPlayers[j];
            var ni2 = p2.getComponent("NetworkIdentityComponent");
            if (ni2 && ni2.isLocalPlayer) return p2;
        }
        return tagPlayers[0] || null;
    }
}
