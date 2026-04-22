// also: vehicle combat, ammunition system, fire rate, turret control, artillery mechanics
// Tank control — WASD treads with acceleration physics, cannon firing with reload
class TankControlBehavior extends GameScript {
    _behaviorName = "tank_control";
    _acceleration = 25;
    _maxSpeed = 12;
    _reverseMax = 5;
    _brakeForce = 40;
    _turnSpeed = 80;
    _friction = 8;
    _fireRate = 2.0;
    _range = 50;
    _damage = 35;
    _maxAmmo = 5;
    _repairAmount = 50;
    _repairCooldown = 15;

    _speed = 0;
    _yawDeg = 0;
    _fireCooldown = 0;
    _ammo = 5;
    _reloading = false;
    _reloadTimer = 0;
    _repairTimer = 0;
    _active = false;
    _startX = 0;
    _startZ = 0;

    onStart() {
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._startZ = pos.z;
        this._yawDeg = 0;
        this._speed = 0;

        var self = this;
        this.scene.events.game.on("battle_start", function() {
            self._active = true;
            self._ammo = self._maxAmmo;
            self._fireCooldown = 0;
            self._reloading = false;
            self._repairTimer = 0;
        });
        this.scene.events.game.on("restart_game", function() {
            self._reset();
        });
    }

    _reset() {
        this._speed = 0;
        this._yawDeg = 0;
        this._fireCooldown = 0;
        this._ammo = this._maxAmmo;
        this._reloading = false;
        this._reloadTimer = 0;
        this._repairTimer = 0;
        this._active = false;
        this.scene.setPosition(this.entity.id, this._startX, 1, this._startZ);
        this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
    }

    onUpdate(dt) {
        if (!this._active) return;

        var throttle = 0, steer = 0;
        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) throttle += 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) throttle -= 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft")) steer -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) steer += 1;

        // Speed
        if (throttle > 0) {
            this._speed += this._acceleration * dt;
        } else if (throttle < 0) {
            this._speed -= this._brakeForce * dt;
        } else {
            if (this._speed > 0) this._speed = Math.max(0, this._speed - this._friction * dt);
            if (this._speed < 0) this._speed = Math.min(0, this._speed + this._friction * dt);
        }
        this._speed = Math.max(-this._reverseMax, Math.min(this._maxSpeed, this._speed));

        // Steering — flip direction when reversing
        var speedFactor = Math.min(1, Math.abs(this._speed) / 3);
        var steerDir = this._speed >= 0 ? 1 : -1;
        this._yawDeg += steer * steerDir * this._turnSpeed * speedFactor * dt;

        // Velocity
        var yawRad = this._yawDeg * Math.PI / 180;
        var vx = Math.sin(yawRad) * this._speed;
        var vz = -Math.cos(yawRad) * this._speed;

        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = 0;
        if (rb && rb.getLinearVelocity) vy = rb.getLinearVelocity().y || 0;

        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });
        this.entity.transform.setRotationEuler(0, -this._yawDeg, 0);

        // Cooldowns
        this._fireCooldown -= dt;
        this._repairTimer -= dt;

        // Fire cannon
        if (this.input.isKeyPressed("Space") && this._fireCooldown <= 0 && !this._reloading && this._ammo > 0) {
            this._ammo--;
            this._fireCooldown = this._fireRate;
            var pos = this.entity.transform.position;
            this.scene.events.game.emit("tank_fired", {
                x: pos.x, z: pos.z, yaw: this._yawDeg,
                damage: this._damage, range: this._range, source: "player"
            });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/explosionCrunch_001.ogg", 0.5);
            if (this._ammo <= 0) {
                this._reloading = true;
                this._reloadTimer = 3.0;
            }
        }

        // Reload
        if (this._reloading) {
            this._reloadTimer -= dt;
            if (this._reloadTimer <= 0) {
                this._ammo = this._maxAmmo;
                this._reloading = false;
                if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/engineCircular_002.ogg", 0.4);
            }
        }

        // Repair (R key)
        if (this.input.isKeyPressed("KeyR") && this._repairTimer <= 0) {
            this._repairTimer = this._repairCooldown;
            this.scene.events.game.emit("player_repair", { amount: this._repairAmount });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/forceField_002.ogg", 0.45);
        }

        // Share state
        this.scene._tankYaw = this._yawDeg;
        this.scene._tankSpeed = this._speed;

        // HUD
        this.scene.events.ui.emit("hud_update", {
            speed: Math.floor(Math.abs(this._speed) * 3.6),
            ammo: this._ammo,
            maxAmmo: this._maxAmmo,
            reloading: this._reloading,
            reloadPct: this._reloading ? Math.floor((1 - this._reloadTimer / 3.0) * 100) : 100,
            repairReady: this._repairTimer <= 0
        });
    }
}
