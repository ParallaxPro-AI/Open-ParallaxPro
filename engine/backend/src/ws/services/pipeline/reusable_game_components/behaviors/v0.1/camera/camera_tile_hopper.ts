// also: lane-runner, 3/4-angle, auto-scroll, endless-lane
// Tile hopper isometric chase camera.
//
// Sits behind-and-above the player at a 3/4 angle so lanes read clearly.
// Follows the player's x with smoothing and latches the z to the
// furthest point the player has reached (so backtracking doesn't
// retreat the camera — that's how the match system's "auto-scroll
// kill" works).
//
// Reusable for any 3/4 top-down hopper by tuning params:
//   _distance, _height, _xTrack, _forwardLockZ (forward-bias)
class CameraTileHopperBehavior extends GameScript {
    _behaviorName = "camera_tile_hopper";
    _distance = 9;
    _height = 9;
    _lookForward = 2;
    _xTrack = 0.55;
    _zLockBias = 0.8;
    _followSmooth = 5;

    _x = 0;
    _y = 9;
    _z = 9;
    _furthestZ = 0;
    _initialized = false;

    onStart() {
        // Play Again: hop_reset moves the player back to (0,0) but the
        // camera's _furthestZ otherwise still holds the previous run's
        // depth, so the camera stays parked at the old far end and
        // slowly lerps back. Clear the lock + the smoothing initialiser
        // so the next tick snaps to the new player.
        var self = this;
        var resetCamera = function() {
            self._furthestZ = 0;
            self._initialized = false;
        };
        this.scene.events.game.on("hop_reset", resetCamera);
        this.scene.events.game.on("game_ready", resetCamera);
        this.scene.events.game.on("restart_game", resetCamera);
    }

    onUpdate(dt) {
        var player = this._findPlayer();
        if (!player || !player.transform) return;
        var pp = player.transform.position;

        if (pp.z < this._furthestZ) this._furthestZ = pp.z;

        // Target: x follows player, z sits a bit behind the furthest z
        // reached (so camera never recedes once advanced).
        var targetX = pp.x * this._xTrack;
        var anchorZ = Math.min(pp.z, this._furthestZ + this._zLockBias);
        var targetZ = anchorZ + this._distance;
        var targetY = this._height;

        if (!this._initialized) {
            this._x = targetX; this._y = targetY; this._z = targetZ;
            this._initialized = true;
        } else {
            var a = Math.min(1, (this._followSmooth || 4) * (dt || 0));
            this._x += (targetX - this._x) * a;
            this._y += (targetY - this._y) * a;
            this._z += (targetZ - this._z) * a;
        }

        this.scene.setPosition(this.entity.id, this._x, this._y, this._z);
        // Aim the camera at a point just ahead of the player (forward = -z),
        // not at a point behind the camera's own position. This is what
        // gives the hopper its forward sightline over upcoming lanes.
        this.entity.transform.lookAt(this._x, 0, this._z - this._distance - this._lookForward);
    }

    _findPlayer() {
        var tagged = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        if (tagged && tagged.length) return tagged[0];
        return this.scene.findEntityByName && this.scene.findEntityByName("Player");
    }
}
