// also: parkour, racing, agility, endless-runner, obstacle-course
// Obstacle runner — WASD movement with turning, sprint, and jump
class ObstacleRunnerBehavior extends GameScript {
    _behaviorName = "obstacle_runner";
    _speed = 8;
    _sprintSpeed = 12;
    _jumpForce = 10;
    _turnSpeed = 150;
    _yawDeg = 0;
    _startX = 0;
    _startZ = 0;

    onStart() {
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._startZ = pos.z;
        this._yawDeg = 0;

        var self = this;
        this.scene.events.game.on("race_start", function() {
            self._yawDeg = 0;
            self.scene.setPosition(self.entity.id, self._startX, 1, self._startZ);
            self.scene.setVelocity(self.entity.id, { x: 0, y: 0, z: 0 });
        });
    }

    onUpdate(dt) {
        var forward = 0, turn = 0;
        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) forward += 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) forward -= 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft")) turn -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) turn += 1;

        // Turn only when moving or strafing
        this._yawDeg += turn * this._turnSpeed * dt;

        // Speed (hold shift to sprint)
        var speed = this.input.isKeyDown("ShiftLeft") ? this._sprintSpeed : this._speed;

        var yawRad = this._yawDeg * Math.PI / 180;
        var vx = Math.sin(yawRad) * forward * speed;
        var vz = -Math.cos(yawRad) * forward * speed;

        // Strafing when turning without forward input
        if (forward === 0 && turn !== 0) {
            vx = Math.cos(yawRad) * turn * speed * 0.5;
            vz = Math.sin(yawRad) * turn * speed * 0.5;
        }

        // Get current vertical velocity (gravity)
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = 0;
        if (rb && rb.getLinearVelocity) {
            vy = rb.getLinearVelocity().y || 0;
        }

        // Jump — only when actually grounded. A short downward raycast from
        // just above the feet detects whether anything is directly under us;
        // the previous `pos.y < 1.5` heuristic let the player re-jump at the
        // top of an arc when y was on its way back through the threshold,
        // which felt like flying. The vy <= 0.5 guard rejects re-fires while
        // still rising in case the ray briefly misses (slope edges).
        var pos = this.entity.transform.position;
        var grounded = false;
        if (this.scene.raycast) {
            var hit = this.scene.raycast(pos.x, pos.y + 0.1, pos.z, 0, -1, 0, 0.4);
            if (hit && hit.entityId !== this.entity.id) grounded = true;
        }
        if (this.input.isKeyPressed("Space") && grounded && vy <= 0.5) {
            vy = this._jumpForce;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/drop_002.ogg", 0.4);
        }

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });
        this.entity.transform.setRotationEuler(0, -this._yawDeg, 0);

        // Share yaw for chase camera
        this.scene._carYaw = this._yawDeg;
    }
}
