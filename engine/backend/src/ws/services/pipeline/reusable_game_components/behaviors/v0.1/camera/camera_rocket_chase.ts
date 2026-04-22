// also: car-following, arcade-racer, speed-biased, cinematic-zoom
// Rocket-style chase camera.
//
// Third-person trailing camera that keeps the car centered but also
// biases its aim toward the ball so the player can see both at once.
// Height + distance scale slightly with speed so high-speed play feels
// cinematic without the car clipping the near-plane.
//
// Parameters let it re-skin for other follow-behind arcade games:
//   _distance / _height    baseline trailing offset
//   _speedZoomMax          extra pull-back when the car moves fast
//   _ballBias              0..1 blend between car-forward and car→ball
//   _smoothSpeed           responsiveness
class CameraRocketChaseBehavior extends GameScript {
    _behaviorName = "camera_rocket_chase";
    _distance = 9;
    _height = 4.2;
    _lookHeight = 1.2;
    _speedZoomMax = 4;
    _ballBias = 0.0;        // pure "butt of car" chase, like camera_kart
    _smoothSpeed = 6;

    _x = 0; _y = 0; _z = 0;
    _initialized = false;

    onUpdate(dt) {
        var car = this._findLocalCar();
        if (!car) return;
        var cp = car.transform.position;
        // Read yaw from the shared scene cache (rocket_car_control
        // publishes it each frame). Derive from the quaternion as a
        // fallback before the control script has ticked once.
        var yawDeg = 0;
        var shared = this.scene._rocketCar;
        if (shared && typeof shared.yawDeg === "number") {
            yawDeg = shared.yawDeg;
        } else {
            var q = car.transform.rotation;
            if (q) {
                var engineYaw = Math.atan2(
                    2 * (q.w * q.y + q.x * q.z),
                    1 - 2 * (q.y * q.y + q.z * q.z),
                );
                yawDeg = -engineYaw * 180 / Math.PI;
            }
        }
        var yaw = yawDeg * Math.PI / 180;

        // Forward direction matches rocket_car_control (GLTF default
        // -Z forward; modelRotationY=0).
        var forwardX = Math.sin(yaw);
        var forwardZ = -Math.cos(yaw);

        // Blend forward with (car → ball) direction so the camera peeks
        // at the ball a little — helps with aerials + shots on goal.
        var ball = this.scene.findEntityByName && this.scene.findEntityByName("Ball");
        var aimX = forwardX, aimZ = forwardZ;
        if (ball && ball.transform) {
            var bp = ball.transform.position;
            var dx = bp.x - cp.x, dz = bp.z - cp.z;
            var L = Math.sqrt(dx * dx + dz * dz) || 1;
            aimX = forwardX * (1 - this._ballBias) + (dx / L) * this._ballBias;
            aimZ = forwardZ * (1 - this._ballBias) + (dz / L) * this._ballBias;
            var Al = Math.sqrt(aimX * aimX + aimZ * aimZ) || 1;
            aimX /= Al; aimZ /= Al;
        }

        // Zoom out a touch with speed.
        var stateSpeed = (this.scene._rocketCarLocalState && this.scene._rocketCarLocalState.speed) || 0;
        var speedZoom = Math.min(this._speedZoomMax, stateSpeed * 0.12);

        var dist = this._distance + speedZoom * 0.8;
        var targetX = cp.x - aimX * dist;
        var targetY = cp.y + this._height + speedZoom * 0.2;
        var targetZ = cp.z - aimZ * dist;

        if (!this._initialized) {
            this._x = targetX; this._y = targetY; this._z = targetZ;
            this._initialized = true;
        } else {
            var a = Math.min(1, (this._smoothSpeed || 6) * (dt || 0));
            this._x += (targetX - this._x) * a;
            this._y += (targetY - this._y) * a;
            this._z += (targetZ - this._z) * a;
        }

        this.scene.setPosition(this.entity.id, this._x, this._y, this._z);
        this.entity.transform.lookAt(cp.x, cp.y + this._lookHeight, cp.z);
    }

    _findLocalCar() {
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("car") : [];
        for (var i = 0; i < all.length; i++) {
            var e = all[i];
            var ni = e.getComponent ? e.getComponent("NetworkIdentityComponent") : null;
            if (ni && ni.isLocalPlayer) return e;
            if (!ni && !e._isBot) return e; // singleplayer fallback
        }
        return all[0] || null;
    }
}
