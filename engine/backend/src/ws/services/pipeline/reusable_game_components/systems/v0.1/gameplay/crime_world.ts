// also: GTA-like, law enforcement, vehicle mechanics, theft, sandbox
// Crime world — wanted system, money, vehicle enter/exit, driving, respawn
class CrimeWorldSystem extends GameScript {
    _startMoney = 500;
    _wantedDecayDelay = 15;
    _carAccel = 35;
    _carMaxSpeed = 25;
    _carBrake = 50;
    _carTurn = 100;
    _enterDistance = 4;

    _wantedLevel = 0;
    _wantedDecayTimer = 0;
    _money = 500;
    _inVehicle = false;
    _vehicleEntity = null;
    _vehicleYaw = 0;
    _vehicleSpeed = 0;
    _nearVehicle = false;

    onStart() {
        var self = this;
        this.scene._wantedLevel = 0;
        this.scene._inVehicle = false;
        this.scene._vehicleEntity = null;

        this.scene.events.game.on("weapon_fired", function() {
            self._addWanted(0.4);
        });

        this.scene.events.game.on("entity_killed", function(data) {
            self._addWanted(1);
            self._money += 50;
            self._updateHud();
        });

        this.scene.events.game.on("crime_committed", function() {
            self._addWanted(1.5);
        });

        this.scene.events.game.on("game_ready", function() {
            self._fullReset();
        });

        this.scene.events.game.on("player_respawned", function() {
            self._respawn();
        });
    }

    _fullReset() {
        this._money = this._startMoney;
        this._wantedLevel = 0;
        this._wantedDecayTimer = 0;
        this.scene._wantedLevel = 0;
        this._exitVehicleInternal();
        this._resetPlayer();
        this._updateHud();
    }

    _respawn() {
        this._money = Math.max(0, this._money - Math.floor(this._money * 0.1));
        this._wantedLevel = 0;
        this._wantedDecayTimer = 0;
        this.scene._wantedLevel = 0;
        this._exitVehicleInternal();
        this._resetPlayer();
        this._updateHud();
    }

    _resetPlayer() {
        var player = this.scene.findEntityByName("Player");
        if (player) {
            player.active = true;
            this.scene.setPosition(player.id, 0, 1.5, 0);
            this.scene.setVelocity(player.id, { x: 0, y: 0, z: 0 });
            this.scene.events.game.emit("entity_healed", { entityId: player.id, amount: 999 });
        }
    }

    _addWanted(amount) {
        this._wantedLevel = Math.min(5, this._wantedLevel + amount);
        this._wantedDecayTimer = 0;
        this.scene._wantedLevel = Math.floor(this._wantedLevel);
        this._updateHud();
    }

    _updateHud() {
        this.scene.events.ui.emit("hud_update", {
            wantedLevel: Math.floor(this._wantedLevel),
            money: this._money,
            inVehicle: this._inVehicle,
            vehicleSpeed: this._inVehicle ? Math.round(Math.abs(this._vehicleSpeed) * 3.6) : 0,
            nearVehicle: this._nearVehicle
        });
    }

    _findNearestVehicle(pos) {
        var cars = this.scene.findEntitiesByTag("vehicle") || [];
        var nearest = null;
        var nearDist = this._enterDistance;
        for (var i = 0; i < cars.length; i++) {
            if (!cars[i].active) continue;
            var cp = cars[i].transform.position;
            var dx = cp.x - pos.x;
            var dz = cp.z - pos.z;
            var dist = Math.sqrt(dx * dx + dz * dz); // position separation
            if (dist < nearDist) {
                nearDist = dist;
                nearest = cars[i];
            }
        }
        return nearest;
    }

    _enterVehicle(player, car) {
        this._inVehicle = true;
        this._vehicleEntity = car;
        this._vehicleSpeed = 0;
        this._vehicleYaw = 0;
        this._vehiclePitch = 0;
        this._vehicleRoll = 0;
        this.scene._inVehicle = true;
        this.scene._vehicleEntity = car;
        this.scene._carYaw = 0;
        player.active = false;

        if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/doorOpen_1.ogg", 0.5);
        this.scene.events.game.emit("vehicle_entered", {});
        this._updateHud();
    }

    _exitVehicle() {
        var player = this.scene.findEntityByName("Player");
        if (player && this._vehicleEntity) {
            var cp = this._vehicleEntity.transform.position;
            var yawRad = this._vehicleYaw * Math.PI / 180;
            var exitX = cp.x + Math.cos(yawRad) * 2.5;
            var exitZ = cp.z + Math.sin(yawRad) * 2.5;
            player.active = true;
            this.scene.setPosition(player.id, exitX, cp.y, exitZ);
            this.scene.setVelocity(player.id, { x: 0, y: 0, z: 0 });
        }

        if (this._vehicleEntity) {
            this.scene.setVelocity(this._vehicleEntity.id, { x: 0, y: 0, z: 0 });
        }

        this._inVehicle = false;
        this._vehicleEntity = null;
        this._vehicleSpeed = 0;
        this.scene._inVehicle = false;
        this.scene._vehicleEntity = null;

        if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/doorClose_4.ogg", 0.5);
        this.scene.events.game.emit("vehicle_exited", {});
        this._updateHud();
    }

    _exitVehicleInternal() {
        if (!this._inVehicle) return;
        if (this._vehicleEntity) {
            this.scene.setVelocity(this._vehicleEntity.id, { x: 0, y: 0, z: 0 });
        }
        this._inVehicle = false;
        this._vehicleEntity = null;
        this._vehicleSpeed = 0;
        this.scene._inVehicle = false;
        this.scene._vehicleEntity = null;
    }

    _driveVehicle(dt) {
        var throttle = 0, steer = 0;

        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) throttle += 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) throttle -= 1;
        if (this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft")) steer -= 1;
        if (this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight")) steer += 1;

        if (throttle > 0) {
            this._vehicleSpeed += this._carAccel * dt;
            if (this._vehicleSpeed > this._carMaxSpeed) this._vehicleSpeed = this._carMaxSpeed;
        } else if (throttle < 0) {
            this._vehicleSpeed -= this._carBrake * dt;
            if (this._vehicleSpeed < -this._carMaxSpeed * 0.3) this._vehicleSpeed = -this._carMaxSpeed * 0.3;
        } else {
            if (this._vehicleSpeed > 0) {
                this._vehicleSpeed -= 12 * dt;
                if (this._vehicleSpeed < 0) this._vehicleSpeed = 0;
            } else if (this._vehicleSpeed < 0) {
                this._vehicleSpeed += 12 * dt;
                if (this._vehicleSpeed > 0) this._vehicleSpeed = 0;
            }
        }

        // Flip steering direction in reverse so D/A always rotates the car
        // toward the camera-relative right/left (arcade convention — physically,
        // reversing makes the rear "lead" so a right turn of the wheel sends
        // the front left). Without this the car steers opposite when backing up.
        var speedFactor = Math.abs(this._vehicleSpeed) / this._carMaxSpeed;
        if (speedFactor > 0.05) {
            var reverseSign = this._vehicleSpeed < 0 ? -1 : 1;
            this._vehicleYaw += steer * this._carTurn * dt * Math.min(speedFactor * 2, 1) * reverseSign;
        }

        var yawRad = this._vehicleYaw * Math.PI / 180;
        var vx = Math.sin(yawRad) * this._vehicleSpeed;
        var vz = -Math.cos(yawRad) * this._vehicleSpeed;

        var rb = this._vehicleEntity.getComponent ? this._vehicleEntity.getComponent("RigidbodyComponent") : null;
        var vy = 0;
        if (rb && rb.getLinearVelocity) {
            vy = rb.getLinearVelocity().y || 0;
        }

        this.scene.setVelocity(this._vehicleEntity.id, { x: vx, y: vy, z: vz });

        // Pitch + roll the car along the slope under it so it tilts on
        // hills instead of clipping/floating with a perfectly horizontal
        // body. Sample terrain heights at four points around the car and
        // derive Euler angles. Rotation order is (pitch, yaw, roll) so the
        // yaw stays driver-controlled and pitch/roll come from the surface.
        // No-op (smoothly degrades to 0,0) when there's no heightmap.
        var cp = this._vehicleEntity.transform.position;
        var halfWheelBase = 1.4;   // ~front-rear distance / 2 for a sedan
        var halfTrackWidth = 0.9;  // ~left-right distance / 2
        var fwdX = Math.sin(yawRad), fwdZ = -Math.cos(yawRad);
        var rightX = Math.cos(yawRad), rightZ = Math.sin(yawRad);
        var hF = this.scene.getTerrainHeight ? this.scene.getTerrainHeight(cp.x + fwdX * halfWheelBase, cp.z + fwdZ * halfWheelBase) : 0;
        var hB = this.scene.getTerrainHeight ? this.scene.getTerrainHeight(cp.x - fwdX * halfWheelBase, cp.z - fwdZ * halfWheelBase) : 0;
        var hR = this.scene.getTerrainHeight ? this.scene.getTerrainHeight(cp.x + rightX * halfTrackWidth, cp.z + rightZ * halfTrackWidth) : 0;
        var hL = this.scene.getTerrainHeight ? this.scene.getTerrainHeight(cp.x - rightX * halfTrackWidth, cp.z - rightZ * halfTrackWidth) : 0;
        var pitchDeg = Math.atan2(hF - hB, halfWheelBase * 2) * 180 / Math.PI;
        var rollDeg = Math.atan2(hL - hR, halfTrackWidth * 2) * 180 / Math.PI;
        // Lerp toward target tilt each frame (~10 Hz response) so curb hops
        // and terrain quantization don't make the car snap-jitter.
        if (typeof this._vehiclePitch !== 'number') this._vehiclePitch = 0;
        if (typeof this._vehicleRoll !== 'number') this._vehicleRoll = 0;
        var lerp = Math.min(1, dt * 10);
        this._vehiclePitch += (pitchDeg - this._vehiclePitch) * lerp;
        this._vehicleRoll += (rollDeg - this._vehicleRoll) * lerp;
        this._vehicleEntity.transform.setRotationEuler(this._vehiclePitch, -this._vehicleYaw, this._vehicleRoll);

        this.scene._carYaw = this._vehicleYaw;

        this.scene.events.ui.emit("hud_update", {
            vehicleSpeed: Math.round(Math.abs(this._vehicleSpeed) * 3.6),
            inVehicle: true
        });
    }

    onUpdate(dt) {
        // Wanted decay
        if (this._wantedLevel > 0) {
            this._wantedDecayTimer += dt;
            if (this._wantedDecayTimer > this._wantedDecayDelay) {
                this._wantedLevel -= dt * 0.3;
                if (this._wantedLevel < 0) this._wantedLevel = 0;
                this.scene._wantedLevel = Math.floor(this._wantedLevel);
                this._updateHud();
            }
        }

        // Proximity check for vehicle prompt
        var player = this.scene.findEntityByName("Player");
        if (player && !this._inVehicle && player.active) {
            var nearCar = this._findNearestVehicle(player.transform.position);
            var wasNear = this._nearVehicle;
            this._nearVehicle = nearCar !== null;
            if (wasNear !== this._nearVehicle) this._updateHud();
        }

        // Vehicle enter/exit
        if (this.input.isKeyPressed("KeyE") || this.input.isKeyPressed("KeyF")) {
            if (this._inVehicle) {
                this._exitVehicle();
            } else if (player && player.active) {
                var car = this._findNearestVehicle(player.transform.position);
                if (car) {
                    this._enterVehicle(player, car);
                }
            }
        }

        // Driving
        if (this._inVehicle && this._vehicleEntity) {
            this._driveVehicle(dt);
        }
    }
}
