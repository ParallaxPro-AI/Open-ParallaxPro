// also: law_enforcement, bounty_system, wanted_mechanic, aggressive_pursuit, law
// Police AI — patrols when peaceful, chases and shoots when player is wanted
class PoliceAIBehavior extends GameScript {
    _behaviorName = "police_ai";
    _speed = 5;
    _detectionRange = 30;
    _fireRange = 15;
    _damage = 12;
    _fireRate = 1.2;
    _health = 150;
    _maxHealth = 150;
    _fireCooldown = 2;
    _dead = false;
    _currentAnim = "";
    _patrolDir = 1;
    _patrolTimer = 0;
    _startX = 0;
    _startZ = 0;
    _despawnTimer = null;
    _spawnY = 0;

    onStart() {
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._startZ = pos.z;
        this._spawnY = pos.y;
        this._patrolDir = Math.random() < 0.5 ? 1 : -1;

        var self = this;
        this.scene.events.game.on("entity_damaged", function(data) {
            if (self._dead || data.entityId !== self.entity.id) return;
            self._health -= data.amount || 10;
            if (self._health <= 0) {
                self._dead = true;
                self._playAnim("Death");
                self.scene.events.game.emit("entity_killed", { entityId: self.entity.id });
                if (self.audio) self.audio.playSound("/assets/kenney/audio/impact_sounds/impactSoft_heavy_002.ogg", 0.4);
                self._despawnTimer = setTimeout(function() { self.entity.active = false; }, 3000);
            } else {
                self._playAnim("RecieveHit");
                var s = self;
                setTimeout(function() { if (!s._dead) s._currentAnim = ""; }, 500);
                // Getting shot at? Increase wanted level via event
                self.scene.events.game.emit("crime_committed", {});
            }
        });

        this._playAnim("Idle");

        // Reset on Play Again. Without this, dead cops stay deactivated
        // for the entire next match.
        var resetFn = function() {
            if (self._despawnTimer) { clearTimeout(self._despawnTimer); self._despawnTimer = null; }
            self._dead = false;
            self._health = self._maxHealth;
            self._patrolTimer = 0;
            self._currentAnim = "";
            self.entity.active = true;
            if (self.scene.setPosition) {
                self.scene.setPosition(self.entity.id, self._startX, self._spawnY, self._startZ);
            }
            self._playAnim("Idle");
        };
        this.scene.events.game.on("game_ready", resetFn);
        this.scene.events.game.on("match_started", resetFn);
        this.scene.events.game.on("restart_game", resetFn);
    }

    onUpdate(dt) {
        if (this._dead) return;

        var wantedLevel = this.scene._wantedLevel || 0;
        var player = this.scene.findEntityByName("Player");
        if (!player) return;

        var pos = this.entity.transform.position;
        var pp = player.transform.position;

        if (this.scene._inVehicle && this.scene._vehicleEntity) {
            pp = this.scene._vehicleEntity.transform.position;
        }

        var dx = pp.x - pos.x;
        var dz = pp.z - pos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);

        this._fireCooldown -= dt;
        var isMoving = false;

        var effectiveRange = this._detectionRange + wantedLevel * 15;

        if (wantedLevel > 0 && dist < effectiveRange) {
            var angle = Math.atan2(-dx, -dz) * 180 / Math.PI;
            this.entity.transform.setRotationEuler(0, angle, 0);

            if (dist > this._fireRange * 0.6) {
                var chaseSpeed = this._speed + wantedLevel * 0.8;
                var ndx = dx / dist, ndz = dz / dist;
                this.scene.setPosition(this.entity.id,
                    pos.x + ndx * chaseSpeed * dt,
                    pos.y,
                    pos.z + ndz * chaseSpeed * dt
                );
                isMoving = true;
            }

            if (dist <= this._fireRange && this._fireCooldown <= 0) {
                var rateMultiplier = Math.max(0.4, 1 / wantedLevel);
                this._fireCooldown = this._fireRate * rateMultiplier;
                this._playAnim("Shoot_OneHanded");
                var self = this;
                setTimeout(function() { if (!self._dead) self._currentAnim = ""; }, 400);

                if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_000.ogg", 0.3);

                if (!this.scene._inVehicle) {
                    this.scene.events.game.emit("entity_damaged", {
                        entityId: player.id,
                        amount: this._damage,
                        source: "police"
                    });
                }
            }
        } else {
            this._patrolTimer += dt;
            if (this._patrolTimer > 4) {
                this._patrolTimer = 0;
                this._patrolDir *= -1;
            }
            var patrolSpeed = 1.5;
            this.scene.setPosition(this.entity.id,
                pos.x + this._patrolDir * patrolSpeed * dt,
                pos.y,
                pos.z
            );
            isMoving = true;
            var pAngle = this._patrolDir > 0 ? 90 : -90;
            this.entity.transform.setRotationEuler(0, pAngle, 0);
        }

        if (isMoving && this._currentAnim !== "Run") {
            this._playAnim("Run");
        } else if (!isMoving && this._currentAnim !== "Idle" && this._currentAnim !== "Shoot_OneHanded" && this._currentAnim !== "RecieveHit") {
            this._playAnim("Idle");
        }
    }

    _playAnim(name) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) {
            this.entity.playAnimation(name, { loop: name !== "Death" && name !== "Shoot_OneHanded" && name !== "RecieveHit" });
        }
    }
}
