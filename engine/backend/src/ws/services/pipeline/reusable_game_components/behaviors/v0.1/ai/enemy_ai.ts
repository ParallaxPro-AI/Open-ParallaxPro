// also: sentinel, sentry patrol, pursuit behavior, guard system, threat detection
// Enemy AI — patrols, chases player when in range, fires at player
class EnemyAIBehavior extends GameScript {
    _behaviorName = "enemy_ai";
    _health = 100;
    _maxHealth = 100;
    _detectionRange = 20;
    _fireRange = 15;
    _damage = 10;
    _fireRate = 1.0;
    _moveSpeed = 3;
    _fireCooldown = 2;
    _dead = false;
    _patrolDir = 1;
    _patrolTimer = 0;
    _currentAnim = "";

    onStart() {
        var self = this;
        this.scene.events.game.on("entity_damaged", function(data) {
            if (self._dead || data.entityId !== self.entity.id) return;
            self._health -= data.amount || 10;
            if (self._health <= 0) {
                self._health = 0;
                self._dead = true;
                self._playAnim("Death", { loop: false });
                self.scene.events.game.emit("entity_killed", { entityId: self.entity.id });
                setTimeout(function() { self.entity.active = false; }, 2000);
            } else {
                self._playAnim("RecieveHit", { loop: false });
                setTimeout(function() { if (!self._dead) self._currentAnim = ""; }, 500);
            }
        });
        this._playAnim("Idle", { loop: true });
    }

    onUpdate(dt) {
        if (this._dead) return;
        var player = this.scene.findEntityByName("Player");
        if (!player) return;

        var pos = this.entity.transform.position;
        var pp = player.transform.position;
        var dx = pp.x - pos.x;
        var dz = pp.z - pos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);

        this._fireCooldown -= dt;
        var isMoving = false;

        if (dist < this._detectionRange) {
            var angle = Math.atan2(-dx, -dz) * 180 / Math.PI;
            this.entity.transform.setRotationEuler(0, angle, 0);

            if (dist > this._fireRange) {
                var ndx = dx / dist, ndz = dz / dist;
                this.scene.setPosition(this.entity.id,
                    pos.x + ndx * this._moveSpeed * dt,
                    pos.y,
                    pos.z + ndz * this._moveSpeed * dt
                );
                isMoving = true;
            }

            if (dist <= this._fireRange && this._fireCooldown <= 0) {
                this._fireCooldown = this._fireRate;
                this._playAnim("Shoot_OneHanded", { loop: false });
                var self = this;
                setTimeout(function() { if (!self._dead) self._currentAnim = ""; }, 400);
                this.scene.events.game.emit("entity_damaged", {
                    entityId: player.id,
                    amount: this._damage,
                    source: "enemy"
                });
            }
        } else {
            this._patrolTimer += dt;
            if (this._patrolTimer > 3) {
                this._patrolTimer = 0;
                this._patrolDir *= -1;
            }
            this.scene.setPosition(this.entity.id,
                pos.x + this._patrolDir * this._moveSpeed * 0.5 * dt,
                pos.y,
                pos.z
            );
            isMoving = true;
        }

        // Animation
        if (isMoving && this._currentAnim !== "Run") {
            this._playAnim("Run", { loop: true });
        } else if (!isMoving && this._currentAnim !== "Idle" && this._currentAnim !== "Shoot_OneHanded" && this._currentAnim !== "RecieveHit") {
            this._playAnim("Idle", { loop: true });
        }
    }

    _playAnim(name, options) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) {
            this.entity.playAnimation(name, options || {});
        }
    }
}
