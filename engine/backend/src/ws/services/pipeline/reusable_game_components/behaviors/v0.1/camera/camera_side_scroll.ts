// Side-scroll camera — locks Z, follows the player on X/Y with mild
// look-ahead in the direction of motion. Hard X clamps keep the camera
// from peeking past the level's logical bounds (set per-level via
// constrainMinX / constrainMaxX so the same behavior works for short
// tutorials and long stages).
//
// Reusable by any 2.5D game that registers a player position in
// scene._mvPlayer (the metroidvania_player behavior does this). Falls
// back to scanning by the "player" tag if that registry isn't filled.
class CameraSideScrollBehavior extends GameScript {
    _behaviorName = "camera_side_scroll";
    _distance = 22;
    _heightOffset = 3.4;
    _lookAheadX = 3.5;
    _smoothPos = 5;
    _constrainMinX = -8;
    _constrainMaxX = 96;

    _camX = 0;
    _camY = 4;
    _camZ = 22;
    _initialised = false;

    onStart() {
        var target = this._findPlayer();
        if (target && target.transform) {
            var p = target.transform.position;
            this._camX = p.x;
            this._camY = p.y + this._heightOffset;
            this._camZ = this._distance;
            this._initialised = true;
            this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);
            this.entity.transform.lookAt(p.x, p.y, 0);
        }
    }

    onUpdate(dt) {
        var target = this._findPlayer();
        if (!target || !target.transform) return;
        var p = target.transform.position;
        var nc = this.scene._mvPlayer || {};
        var lookAhead = (nc.facing || 0) * this._lookAheadX;

        var targetX = p.x + lookAhead;
        var targetY = p.y + this._heightOffset;
        // Hard X clamps so the camera doesn't reveal void past the
        // configured level bounds.
        if (targetX < this._constrainMinX) targetX = this._constrainMinX;
        if (targetX > this._constrainMaxX) targetX = this._constrainMaxX;

        if (!this._initialised) {
            this._camX = targetX;
            this._camY = targetY;
            this._initialised = true;
        } else {
            var t = 1 - Math.exp(-this._smoothPos * dt);
            this._camX += (targetX - this._camX) * t;
            this._camY += (targetY - this._camY) * t;
        }

        this.scene.setPosition(this.entity.id, this._camX, this._camY, this._distance);
        // Look at the player's position (not the camera target) so the
        // framing tilts naturally as the player jumps without the camera
        // panning awkwardly.
        this.entity.transform.lookAt(p.x, p.y, 0);
    }

    _findPlayer() {
        var nc = this.scene._mvPlayer;
        if (nc && nc.entityId != null) {
            // Scan by tag and match id — we don't have a direct id-lookup API.
            var list = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
            for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === nc.entityId) return list[i];
        }
        var fallback = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        return fallback[0] || null;
    }
}
