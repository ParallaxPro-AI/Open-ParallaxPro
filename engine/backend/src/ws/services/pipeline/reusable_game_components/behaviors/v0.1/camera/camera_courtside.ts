// Courtside camera — broadcast-style follow camera for a basketball
// court. Sits high on one side of the court and pans along it as the
// local player moves, keeping both the player and the active basket
// in frame. Optionally swings to face whichever hoop is the local
// player's offensive target (read from scene._court.localTeam).
//
// Reusable: any wide-arena game (soccer, basketball, hockey) where the
// camera should slide along one axis instead of orbiting.
class CameraCourtsideBehavior extends GameScript {
    _behaviorName = "camera_courtside";
    _height = 14;
    _zOffset = 22;                 // distance off the long edge
    _xLerp = 4.5;
    _yLerp = 5.0;
    _trackHoop = true;             // bias the lookAt toward the player's offensive hoop
    _hoopBias = 0.45;              // 0=look at player only, 1=look at hoop only
    _camX = 0;
    _camY = 14;
    _camZ = 22;

    onStart() {
        var target = this._findLocalPlayer();
        if (target && target.transform) {
            var pp = target.transform.position;
            this._camX = pp.x;
            this._camY = (pp.y || 0) + this._height;
            this._camZ = pp.z + this._zOffset;
        }
    }

    onUpdate(dt) {
        var target = this._findLocalPlayer();
        if (!target || !target.transform) return;
        var pp = target.transform.position;

        var targetX = pp.x;
        var targetY = (pp.y || 0) + this._height;
        var targetZ = pp.z + this._zOffset;
        var t = 1 - Math.exp(-this._xLerp * dt);
        var ty = 1 - Math.exp(-this._yLerp * dt);
        this._camX += (targetX - this._camX) * t;
        this._camY += (targetY - this._camY) * ty;
        this._camZ += (targetZ - this._camZ) * t;
        if (this.scene.setPosition) this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);

        // Look at point biased toward the offensive hoop.
        var lookX = pp.x;
        var lookY = pp.y + 1.0;
        var lookZ = pp.z;
        var ct = this.scene._court;
        if (this._trackHoop && ct && ct.hoops) {
            var team = (ct.localTeam) || "home";
            var hoop = (team === "home") ? ct.hoops.away : ct.hoops.home;
            if (hoop) {
                lookX = pp.x + (hoop.x - pp.x) * this._hoopBias;
                lookZ = pp.z + (hoop.z - pp.z) * this._hoopBias;
                lookY = 2.0;
            }
        }
        if (this.entity.transform.lookAt) this.entity.transform.lookAt(lookX, lookY, lookZ);
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
