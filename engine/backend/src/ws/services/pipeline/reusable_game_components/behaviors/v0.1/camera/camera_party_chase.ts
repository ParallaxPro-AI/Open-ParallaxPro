// also: party game, spectator, elimination, multiplayer, third person orbit
// Party-game chase camera — orbit around the local player on RMB drag,
// auto-orbit toward the player's facing when idle, and switch to a
// "spectator drift" mode that orbits the leader once the local peer is
// eliminated. Writes its working yaw to scene._tpYaw so movement
// behaviors can transform input into camera-relative axes.
//
// Reusable beyond Jelly Jam: any 3rd-person party / battle-royale /
// race game. The spectator mode picks the highest-scoring still-alive
// player (the match system pins them on scene._jjSpectateTargetId) so
// eliminated peers still have something to watch.
class CameraPartyChaseBehavior extends GameScript {
    _behaviorName = "camera_party_chase";

    _distance = 7.5;
    _height = 3.5;
    _lookHeight = 1.5;
    _smoothSpeed = 6;
    _sensitivity = 0.16;
    _autoOrbitSpeed = 80;     // deg/sec — how fast the camera trails behind motion
    _minPitch = -25;
    _maxPitch = 60;

    _yawDeg = 0;
    _pitchDeg = 18;
    _camX = 0;
    _camY = 0;
    _camZ = 0;
    _initialized = false;
    _shakeMag = 0;
    _shakeT = 0;

    onStart() {
    }

    onUpdate(dt) {
        // Right-mouse drag → orbit; otherwise the camera auto-trails the
        // player's velocity direction. Feels less robotic than a fully-
        // rigid follow.
        var rDrag = this.input.isKeyDown && this.input.isKeyDown("MouseRight");
        if (rDrag) {
            var d = this.input.getMouseDelta ? this.input.getMouseDelta() : { x: 0, y: 0 };
            this._yawDeg += d.x * this._sensitivity;
            this._pitchDeg -= d.y * this._sensitivity;
            if (this._pitchDeg < this._minPitch) this._pitchDeg = this._minPitch;
            if (this._pitchDeg > this._maxPitch) this._pitchDeg = this._maxPitch;
        }

        var target = this._pickTarget();
        if (!target) return;
        var tpos = target.transform ? target.transform.position : null;
        if (!tpos) return;

        // Auto-orbit: if the player is moving, gently rotate the yaw
        // toward facing-behind-the-player so the camera trails motion.
        if (!rDrag) {
            var rb = target.getComponent ? target.getComponent("RigidbodyComponent") : null;
            var vx = 0, vz = 0;
            if (rb && rb.getLinearVelocity) { var v = rb.getLinearVelocity(); vx = v.x || 0; vz = v.z || 0; }
            var sp = Math.sqrt(vx * vx + vz * vz);
            if (sp > 1) {
                var desiredYaw = Math.atan2(vx, -vz) * 180 / Math.PI;
                var dyaw = this._wrapAngle(desiredYaw - this._yawDeg);
                var maxStep = this._autoOrbitSpeed * dt * Math.min(1, sp / 6);
                if (Math.abs(dyaw) > maxStep) dyaw = Math.sign(dyaw) * maxStep;
                this._yawDeg += dyaw;
            }
        }

        // Compute desired camera position on a sphere around the player.
        var yawRad = this._yawDeg * Math.PI / 180;
        var pitchRad = this._pitchDeg * Math.PI / 180;
        var horiz = Math.cos(pitchRad) * this._distance;
        var dx = -Math.sin(yawRad) * horiz;
        var dz =  Math.cos(yawRad) * horiz;
        var dy = Math.sin(pitchRad) * this._distance + this._height;
        var desiredX = tpos.x + dx;
        var desiredY = tpos.y + dy;
        var desiredZ = tpos.z + dz;

        if (!this._initialized) {
            this._camX = desiredX;
            this._camY = desiredY;
            this._camZ = desiredZ;
            this._initialized = true;
        } else {
            var t = 1 - Math.exp(-this._smoothSpeed * dt);
            this._camX += (desiredX - this._camX) * t;
            this._camY += (desiredY - this._camY) * t;
            this._camZ += (desiredZ - this._camZ) * t;
        }

        // Apply camera shake decay.
        var shakeOff = { x: 0, y: 0, z: 0 };
        if (this._shakeT > 0) {
            this._shakeT -= dt;
            var k = Math.max(0, this._shakeT) / 0.35;
            var amp = this._shakeMag * k;
            shakeOff.x = (Math.random() * 2 - 1) * amp;
            shakeOff.y = (Math.random() * 2 - 1) * amp;
        }

        this.scene.setPosition(this.entity.id,
            this._camX + shakeOff.x,
            this._camY + shakeOff.y,
            this._camZ + shakeOff.z
        );
        this.entity.transform.lookAt(tpos.x, tpos.y + this._lookHeight, tpos.z);

        // Publish camera yaw for movement behaviors.
        this.scene._tpYaw = this._yawDeg;
    }

    _wrapAngle(a) {
        while (a > 180)  a -= 360;
        while (a < -180) a += 360;
        return a;
    }

    _pickTarget() {
        // Spectator mode override: match system pins the active spectate
        // target on the scene. Falls back to local player.
        var spectateId = this.scene._jjSpectateTargetId;
        if (spectateId) {
            var ent = this.scene.getEntity ? this.scene.getEntity(spectateId) : null;
            if (ent) return ent;
        }
        return this._findLocalPlayer();
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
