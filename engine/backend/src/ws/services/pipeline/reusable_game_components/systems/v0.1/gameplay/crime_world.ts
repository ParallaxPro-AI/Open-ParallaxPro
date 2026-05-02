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
    // Anti-stuck state: time spent commanding throttle while the
    // rigidbody barely moved. Crossing _stuckThreshold triggers a
    // one-shot reversed nudge so a head-on crash can't pin the car.
    _stuckTimer = 0;
    _stuckThreshold = 1.0;

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

        // Read actual physics velocity. vy is preserved as before so
        // gravity isn't cancelled by our setVelocity. Lateral magnitude
        // tells us if the rigidbody is actually moving — if it's much
        // slower than we're commanding, the car is pressing into an
        // obstacle and Rapier's separation impulse is being erased by
        // the next setVelocity call.
        var rb = this._vehicleEntity.getComponent ? this._vehicleEntity.getComponent("RigidbodyComponent") : null;
        var vy = 0;
        var actualLat = Math.abs(this._vehicleSpeed);
        if (rb && rb.getLinearVelocity) {
            var av = rb.getLinearVelocity();
            vy = av.y || 0;
            actualLat = Math.sqrt((av.x || 0) * (av.x || 0) + (av.z || 0) * (av.z || 0));
        }

        // Soft-clamp commanded speed to the physics speed + small
        // headroom. When the car is rolling free this is a no-op; when
        // it's pinned against a tree/wall the commanded speed bleeds
        // down so setVelocity stops fighting Rapier's separation push.
        // The 3 m/s buffer is enough to keep the car gently pressing
        // forward in case the obstacle is something it can climb /
        // slide off, while leaving room for steering to redirect the
        // car (steering still applies as long as speedFactor > 0.05,
        // i.e. ~1.25 m/s of script speed).
        var commandedAbs = Math.abs(this._vehicleSpeed);
        var maxAllowed = actualLat + 3;
        if (commandedAbs > maxAllowed) {
            var clampSign = this._vehicleSpeed >= 0 ? 1 : -1;
            this._vehicleSpeed = maxAllowed * clampSign;
        }

        // Stuck detection — backup safety net when the player's holding
        // throttle but the car isn't moving even with the soft-clamp
        // (perfectly head-on collision, can't steer out). After ~1s of
        // throttle-but-no-progress, briefly reverse so the player can
        // re-aim. Self-resets every frame the car is moving normally.
        if (throttle !== 0 && actualLat < 0.5) {
            this._stuckTimer += dt;
            if (this._stuckTimer >= this._stuckThreshold) {
                this._stuckTimer = 0;
                this._vehicleSpeed = -4 * (throttle > 0 ? 1 : -1);
            }
        } else {
            this._stuckTimer = 0;
        }

        var yawRad = this._vehicleYaw * Math.PI / 180;
        var vx = Math.sin(yawRad) * this._vehicleSpeed;
        var vz = -Math.cos(yawRad) * this._vehicleSpeed;

        this.scene.setVelocity(this._vehicleEntity.id, { x: vx, y: vy, z: vz });
        this._vehicleEntity.transform.setRotationEuler(0, -this._vehicleYaw, 0);

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
