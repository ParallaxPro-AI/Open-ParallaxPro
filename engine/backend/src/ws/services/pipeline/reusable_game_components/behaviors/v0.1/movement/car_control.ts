// Arcade car control — WASD/Arrow keys, physics-based velocity
class CarControlBehavior extends GameScript {
    _behaviorName = "car_control";
    _acceleration = 40;
    _maxSpeed = 30;
    _brakeForce = 60;
    _turnSpeed = 120;
    _currentSpeed = 0;
    _yawDeg = 0;
    _startX = 0;
    _startZ = 0;
    _engineSound = "";

    onStart() {
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._startZ = pos.z;
        this._currentSpeed = 0;
        this._yawDeg = 0;

        var self = this;
        this.scene.events.game.on("race_start", function() {
            self._currentSpeed = 0;
            self._yawDeg = 0;
            self.scene.setPosition(self.entity.id, self._startX, 0, self._startZ);
            self.scene.setVelocity(self.entity.id, { x: 0, y: 0, z: 0 });
            self.entity.transform.setRotationEuler(0, 0, 0);
        });
    }

    onUpdate(dt) {
        var throttle = 0;
        var steer = 0;

        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) throttle += 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) throttle -= 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft")) steer -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) steer += 1;

        // Acceleration and braking
        if (throttle > 0) {
            this._currentSpeed += this._acceleration * dt;
            if (this._currentSpeed > this._maxSpeed) this._currentSpeed = this._maxSpeed;
        } else if (throttle < 0) {
            this._currentSpeed -= this._brakeForce * dt;
            if (this._currentSpeed < -this._maxSpeed * 0.3) this._currentSpeed = -this._maxSpeed * 0.3;
        } else {
            // Natural friction deceleration
            if (this._currentSpeed > 0) {
                this._currentSpeed -= 15 * dt;
                if (this._currentSpeed < 0) this._currentSpeed = 0;
            } else if (this._currentSpeed < 0) {
                this._currentSpeed += 15 * dt;
                if (this._currentSpeed > 0) this._currentSpeed = 0;
            }
        }

        // Steering — only effective when moving. Flip sign in reverse so
        // pressing D/A always rotates the car toward the camera-relative
        // right/left, matching arcade-driving expectations (see also
        // tank_control / kart_drive / rocket_car_control / ship_sail).
        var speedFactor = Math.abs(this._currentSpeed) / this._maxSpeed;
        if (speedFactor > 0.05) {
            var reverseSign = this._currentSpeed < 0 ? -1 : 1;
            this._yawDeg += steer * this._turnSpeed * dt * Math.min(speedFactor * 2, 1) * reverseSign;
        }

        // Convert to world-space velocity
        var yawRad = this._yawDeg * Math.PI / 180;
        var vx = Math.sin(yawRad) * this._currentSpeed;
        var vz = -Math.cos(yawRad) * this._currentSpeed;

        // Preserve vertical velocity for gravity
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = 0;
        if (rb && rb.getLinearVelocity) {
            vy = rb.getLinearVelocity().y || 0;
        }

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });
        this.entity.transform.setRotationEuler(0, -this._yawDeg, 0);

        // Share yaw for chase camera
        this.scene._carYaw = this._yawDeg;
        this.scene._carSpeed = Math.abs(this._currentSpeed);

        // Send speed to HUD (convert to km/h)
        var speedKmh = Math.round(Math.abs(this._currentSpeed) * 3.6);
        this.scene.events.ui.emit("hud_update", {
            speed: speedKmh
        });
    }
}
