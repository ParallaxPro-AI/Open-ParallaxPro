// also: racing, kart racing, boost, drift, speed effects, FOV punch
// Kart camera — low-to-ground chase camera tuned for arcade kart races.
// Sits behind + above the kart with a soft FOV punch when boosting,
// gentle camera shake on a successful drift boost. Pulls back slightly
// at high speed for a "speed lines" feel.
//
// Reusable: any low-vehicle racing game. All offsets/lerps are params.
class CameraKartBehavior extends GameScript {
    _behaviorName = "camera_kart";
    _distance = 7.5;
    _height = 3.0;
    _lookHeight = 0.8;
    _smoothSpeed = 6.0;
    _baseFov = 60;
    _maxFov = 76;
    _fovLerp = 4.5;
    _boostShakeAmp = 0.12;
    _boostShakeDuration = 0.35;
    _camX = 0;
    _camY = 3;
    _camZ = 7.5;
    _curFov = 60;
    _shakeRemaining = 0;
    _lastBoostMs = 0;

    onStart() {
        var target = this._findLocalKart();
        if (target && target.transform) {
            var pp = target.transform.position;
            this._camX = pp.x;
            this._camY = (pp.y || 0) + this._height;
            this._camZ = pp.z + this._distance;
        }
        var cam = this.entity.getComponent ? this.entity.getComponent("CameraComponent") : null;
        if (cam) cam.fov = this._baseFov;
        this._curFov = this._baseFov;
    }

    onUpdate(dt) {
        var target = this._findLocalKart();
        if (!target || !target.transform) return;
        var pp = target.transform.position;
        var k = this.scene._kart || {};
        var yawDeg = k.yaw || 0;
        var yawRad = yawDeg * Math.PI / 180;

        // Pull back a touch at high speed.
        var pullBack = Math.min(2.5, (k.absSpeed || 0) * 0.05);
        var dist = this._distance + pullBack;

        var targetX = pp.x - Math.sin(yawRad) * dist;
        var targetY = (pp.y || 0) + this._height;
        var targetZ = pp.z + Math.cos(yawRad) * dist;

        var t = 1 - Math.exp(-this._smoothSpeed * dt);
        this._camX += (targetX - this._camX) * t;
        this._camY += (targetY - this._camY) * t;
        this._camZ += (targetZ - this._camZ) * t;

        // Trigger shake when boost just started.
        var boostMs = k.boostRemaining || 0;
        if (boostMs > this._lastBoostMs + 200) {
            this._shakeRemaining = this._boostShakeDuration;
        }
        this._lastBoostMs = boostMs;
        var shakeX = 0, shakeY = 0;
        if (this._shakeRemaining > 0) {
            this._shakeRemaining -= dt;
            var amp = this._boostShakeAmp * Math.max(0, this._shakeRemaining / this._boostShakeDuration);
            shakeX = (Math.random() - 0.5) * amp * 2;
            shakeY = (Math.random() - 0.5) * amp * 2;
        }

        if (this.scene.setPosition) this.scene.setPosition(this.entity.id, this._camX + shakeX, this._camY + shakeY, this._camZ);
        if (this.entity.transform.lookAt) this.entity.transform.lookAt(pp.x, (pp.y || 0) + this._lookHeight, pp.z);

        // FOV punch — slow lerp toward maxFov when boosting.
        var boostFrac = (boostMs > 0) ? Math.min(1, (k.boost || 1) - 1) : 0;
        var targetFov = this._baseFov + (this._maxFov - this._baseFov) * boostFrac;
        var ft = 1 - Math.exp(-this._fovLerp * dt);
        this._curFov += (targetFov - this._curFov) * ft;
        var cam = this.entity.getComponent ? this.entity.getComponent("CameraComponent") : null;
        if (cam) cam.fov = this._curFov;
    }

    _findLocalKart() {
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
