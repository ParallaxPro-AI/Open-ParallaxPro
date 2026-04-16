// Chase camera that follows the local bike — or spectates the leader
// once the local player is out — and always sits directly behind and
// above the bike, looking at its rear.
//
// Position is recomputed from scratch every frame from the bike's yaw:
//   camera = bike_pos - forward * distance + up * height
// No lerping: smoothing on yaw in particular made the camera orbit
// through the air on turns instead of tracking the bike's back.
class BikeChaseCameraBehavior extends GameScript {
    _behaviorName = "bike_chase_camera";
    _distance = 11;
    _height = 8;
    _lookHeight = 1.2;
    _fovBoost = 8;

    _baseFov = 0;

    onStart() {
        // Cache the configured FOV so the boost bump is a clean additive.
        var cam = this.entity.getComponent ? this.entity.getComponent("CameraComponent") : null;
        this._baseFov = (cam && (cam.fov || cam.fieldOfView)) || 60;
    }

    onUpdate(dt) {
        var target = this._findFocusBike();
        if (!target) return;
        var pos = target.transform ? target.transform.position : null;
        if (!pos) return;

        var entry = this._registryEntry(target);
        var yawDeg = (entry && typeof entry.yawDeg === "number") ? entry.yawDeg : this._readYawDeg(target);
        var boosting = !!(entry && entry.boosting);

        // Bike's forward at this yaw is (sin, 0, cos) — motion math uses
        // +cos on Z (see bike_player_control). "Behind" is negated forward.
        var yawRad = yawDeg * Math.PI / 180;
        var fx = Math.sin(yawRad);
        var fz = Math.cos(yawRad);
        var camX = pos.x - fx * this._distance;
        var camY = pos.y + this._height;
        var camZ = pos.z - fz * this._distance;

        this.scene.setPosition(this.entity.id, camX, camY, camZ);
        this.entity.transform.lookAt(pos.x, pos.y + this._lookHeight, pos.z);

        // FOV nudge while boosting — sells the speed without a particle FX.
        var cam = this.entity.getComponent ? this.entity.getComponent("CameraComponent") : null;
        if (cam) {
            var wantFov = this._baseFov + (boosting ? this._fovBoost : 0);
            var curFov = cam.fov || cam.fieldOfView || this._baseFov;
            var nextFov = curFov + (wantFov - curFov) * Math.min(1, dt * 4);
            if (cam.fov !== undefined) cam.fov = nextFov;
            else if (cam.fieldOfView !== undefined) cam.fieldOfView = nextFov;
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    _findFocusBike() {
        var scene = this.scene;
        var bikes = scene.findEntitiesByTag ? scene.findEntitiesByTag("bike") : [];
        if (!bikes || bikes.length === 0) {
            // Fallback so the camera doesn't black-screen pre-init.
            return scene.findEntitiesByTag ? (scene.findEntitiesByTag("player")[0] || null) : null;
        }
        // Prefer the local bike. If it's dead, spectate the first alive bike
        // (deterministic — sorted by entity id so all peers keep watching
        // the same survivor across multiple peers' viewpoints).
        var localBike = null;
        var aliveBikes = [];
        for (var i = 0; i < bikes.length; i++) {
            var b = bikes[i];
            var ni = b.getComponent ? b.getComponent("NetworkIdentityComponent") : null;
            var entry = this._registryEntry(b);
            var isAlive = entry ? !!entry.alive : true;
            if (ni && ni.isLocalPlayer) {
                localBike = b;
                if (isAlive) return b;  // happy path — follow our own bike
            }
            if (isAlive) aliveBikes.push(b);
        }
        if (aliveBikes.length > 0) {
            aliveBikes.sort(function(a, b) { return (a.id || 0) - (b.id || 0); });
            return aliveBikes[0];
        }
        // Round just ended — keep watching whoever was the last local bike.
        return localBike || bikes[0];
    }

    _registryEntry(entity) {
        var nc = this.scene._neonCycles;
        if (!nc || !nc.bikes) return null;
        var ni = entity.getComponent ? entity.getComponent("NetworkIdentityComponent") : null;
        var ownerId = ni && ni.ownerId;
        if (!ownerId) return null;
        return nc.bikes[ownerId] || null;
    }

    _readYawDeg(entity) {
        // scriptTransform has no getRotationEuler, so derive yaw from the
        // rotation quaternion. Assumes yaw-dominant rotations (no real
        // pitch/roll on a bike).
        if (!entity.transform) return 0;
        var q = entity.transform.rotation;
        if (!q) return 0;
        var qx = q.x || 0, qy = q.y || 0, qz = q.z || 0, qw = q.w != null ? q.w : 1;
        var yawRad = Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qx * qx));
        return yawRad * 180 / Math.PI;
    }
}
