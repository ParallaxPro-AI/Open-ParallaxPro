// also: bowling, alley game, throw mechanics, projectile tracking, pins
// Lane-view camera — sits behind the throw line of a long alley
// (bowling, skee-ball, shuffleboard) and looks down toward the
// target end. Optionally tracks a focus entity (the rolling ball)
// after the player commits a throw, so the player can see the ball
// arrive at the pins without having to manually pan.
//
// Reusable beyond Pin Pal: any "throw at distant target" sport can
// drop this on the camera prefab. Tune `_followFocusTag` to the
// projectile's tag and the camera will track once it appears.
class CameraLaneViewBehavior extends GameScript {
    _behaviorName = "camera_lane_view";

    // Throw-line position (world) — camera anchors to the back of the
    // alley above this point.
    _throwX = 0;
    _throwZ = 0;
    _throwY = 0;
    _heightAtThrow = 4.0;     // camera Y above throw line
    _heightAtFar = 6.0;       // camera Y when watching the projectile
    _backOffset = 4.0;        // metres behind the throw line (along -lane axis)
    _laneAxisX = 1;           // unit vector along the lane direction (defaults +X)
    _laneAxisZ = 0;
    _smoothSpeed = 5.0;
    _focusTag = "pp_ball";    // the projectile entity to track when present
    _focusFollowMul = 0.45;   // 0 = camera stays anchored, 1 = camera follows fully

    _curX = 0;
    _curY = 0;
    _curZ = 0;
    _initialized = false;

    onUpdate(dt) {
        // Resting position: behind the throw line, looking down the lane.
        var anchorX = this._throwX - this._laneAxisX * this._backOffset;
        var anchorZ = this._throwZ - this._laneAxisZ * this._backOffset;
        var anchorY = this._throwY + this._heightAtThrow;
        var lookX = this._throwX + this._laneAxisX * 12;
        var lookZ = this._throwZ + this._laneAxisZ * 12;
        var lookY = this._throwY + 0.5;

        // If a focus entity exists, blend toward following it. We keep
        // the camera anchored partially so the framing stays consistent
        // even when the ball curves to the side.
        var focus = this._findFocus();
        if (focus && focus.transform) {
            var fp = focus.transform.position;
            var alongLane = (fp.x - this._throwX) * this._laneAxisX + (fp.z - this._throwZ) * this._laneAxisZ;
            // Once the ball is well down the lane, lift the camera and
            // pan a little to track it.
            var t = Math.max(0, Math.min(1, alongLane / 16)) * this._focusFollowMul;
            anchorX = anchorX * (1 - t) + (fp.x - this._laneAxisX * this._backOffset) * t;
            anchorZ = anchorZ * (1 - t) + (fp.z - this._laneAxisZ * this._backOffset) * t;
            anchorY = anchorY * (1 - t) + (this._heightAtFar) * t;
            lookX = lookX * (1 - t) + fp.x * t;
            lookZ = lookZ * (1 - t) + fp.z * t;
            lookY = lookY * (1 - t) + (fp.y + 0.4) * t;
        }

        if (!this._initialized) {
            this._curX = anchorX;
            this._curY = anchorY;
            this._curZ = anchorZ;
            this._initialized = true;
        } else {
            var k = 1 - Math.exp(-this._smoothSpeed * dt);
            this._curX += (anchorX - this._curX) * k;
            this._curY += (anchorY - this._curY) * k;
            this._curZ += (anchorZ - this._curZ) * k;
        }

        this.scene.setPosition(this.entity.id, this._curX, this._curY, this._curZ);
        this.entity.transform.lookAt(lookX, lookY, lookZ);
    }

    _findFocus() {
        if (!this._focusTag) return null;
        var ents = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag(this._focusTag) : [];
        return ents && ents.length > 0 ? ents[0] : null;
    }
}
