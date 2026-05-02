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
    // Captured at first onStart so Play Again can restore the enemy
    // exactly where it was placed in 03_worlds.json. Without this, dead
    // enemies stay deactivated forever after the player hits Play Again
    // and the survival_zone game ends instantly (battle_tracker counts
    // alive enemies and immediately fires victory).
    _spawnX = 0;
    _spawnY = 0;
    _spawnZ = 0;
    _spawnCaptured = false;
    // Visible bullet tracers — short-lived red spheres lerping from the
    // enemy's gun toward the player so the player can see who is
    // shooting them. Damage is still applied at fire-time; the tracer
    // is purely cosmetic.
    _tracers = [];

    onStart() {
        var self = this;
        if (!this._spawnCaptured) {
            var p = this.entity.transform.position;
            this._spawnX = p.x; this._spawnY = p.y; this._spawnZ = p.z;
            this._spawnCaptured = true;
        }
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
        // Reset on Play Again (FSM emits match_started + game_ready when
        // returning to gameplay from game_over). Reactivate, full HP,
        // back to spawn.
        var resetFn = function() {
            self._dead = false;
            self._health = self._maxHealth;
            self._currentAnim = "";
            self.entity.active = true;
            if (self.scene.setPosition) {
                self.scene.setPosition(self.entity.id, self._spawnX, self._spawnY, self._spawnZ);
            }
            if (self.scene.setVelocity) {
                self.scene.setVelocity(self.entity.id, { x: 0, y: 0, z: 0 });
            }
            self._playAnim("Idle", { loop: true });
        };
        this.scene.events.game.on("match_started", resetFn);
        this.scene.events.game.on("game_ready", resetFn);
        this.scene.events.game.on("restart_game", resetFn);
        this._playAnim("Idle", { loop: true });
    }

    onUpdate(dt) {
        this._updateTracers(dt);
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

        // Preserve the rigidbody's vertical velocity so gravity keeps
        // pulling the enemy down — they're now dynamic, not kinematic,
        // so writing a fresh setVelocity each frame would cancel the
        // gravity tick if we passed y:0 instead of the current vy.
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = (rb && rb.getLinearVelocity) ? (rb.getLinearVelocity().y || 0) : 0;
        var vx = 0, vz = 0;

        if (dist < this._detectionRange) {
            var angle = Math.atan2(-dx, -dz) * 180 / Math.PI;
            this.entity.transform.setRotationEuler(0, angle, 0);

            if (dist > this._fireRange) {
                var ndx = dx / dist, ndz = dz / dist;
                vx = ndx * this._moveSpeed;
                vz = ndz * this._moveSpeed;
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
                // Spawn a red bullet from the enemy's chest toward the
                // player's chest. Player's fps_combat tracer is yellow;
                // red here makes "incoming fire" obvious.
                this._spawnTracer(pos.x, pos.y + 1.2, pos.z, pp.x, pp.y + 1.2, pp.z);
            }
        } else {
            this._patrolTimer += dt;
            if (this._patrolTimer > 3) {
                this._patrolTimer = 0;
                this._patrolDir *= -1;
            }
            vx = this._patrolDir * this._moveSpeed * 0.5;
            isMoving = true;
        }
        if (this.scene.setVelocity) {
            this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });
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

    _spawnTracer(fromX, fromY, fromZ, toX, toY, toZ) {
        if (!this.scene.createEntity) return;
        var name = "tr_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
        var id = this.scene.createEntity(name);
        if (id == null || id === -1) return;
        this.scene.setScale && this.scene.setScale(id, 0.14, 0.14, 0.14);
        this.scene.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: [1.0, 0.30, 0.20, 1]
        });
        this.scene.setPosition(id, fromX, fromY, fromZ);
        if (this.scene.addTag) this.scene.addTag(id, "tracer");
        var dx = toX - fromX, dy = toY - fromY, dz = toZ - fromZ;
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        var duration = Math.max(0.05, dist / 60);
        this._tracers.push({
            id: id, t: 0, duration: duration,
            fromX: fromX, fromY: fromY, fromZ: fromZ,
            toX: toX, toY: toY, toZ: toZ
        });
    }

    _updateTracers(dt) {
        for (var i = this._tracers.length - 1; i >= 0; i--) {
            var pr = this._tracers[i];
            pr.t += dt;
            var alpha = pr.t / pr.duration;
            if (alpha >= 1) {
                try { this.scene.destroyEntity && this.scene.destroyEntity(pr.id); } catch (e) {}
                this._tracers.splice(i, 1);
                continue;
            }
            this.scene.setPosition(pr.id,
                pr.fromX + (pr.toX - pr.fromX) * alpha,
                pr.fromY + (pr.toY - pr.fromY) * alpha,
                pr.fromZ + (pr.toZ - pr.fromZ) * alpha);
        }
    }
}
