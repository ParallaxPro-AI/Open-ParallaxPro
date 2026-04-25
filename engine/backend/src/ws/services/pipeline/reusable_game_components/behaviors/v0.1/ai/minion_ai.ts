// also: creep, wave, moba_unit, enemy_spawn, economic_reward, lane_push
// Minion AI — walks down lane, attacks nearest enemy, grants gold on death.
// The minion body is kinematic, so movement is driven by setPosition each
// frame with the original y preserved — that's what keeps the minion
// glued to the ground (dynamic + setVelocity drifts down through gravity
// integration between ticks).
class MinionAIBehavior extends GameScript {
    _behaviorName = "minion_ai";
    _health = 200;
    _maxHealth = 200;
    _damage = 15;
    _attackRange = 3;
    _attackRate = 1.0;
    _moveSpeed = 3;
    _goldValue = 20;
    _attackCooldown = 0;
    _dead = false;
    _team = "";
    _direction = 1;

    onStart() {
        var tags = this.entity.tags || [];
        for (var i = 0; i < tags.length; i++) {
            if (tags[i] === "blue_team") { this._team = "blue"; this._direction = 1; break; }
            if (tags[i] === "red_team") { this._team = "red"; this._direction = -1; break; }
        }

        var self = this;
        this.scene.events.game.on("entity_damaged", function(data) {
            if (data.entityId !== self.entity.id || self._dead) return;
            self._health -= data.amount || 0;
            if (self._health <= 0) {
                self._health = 0;
                self._dead = true;
                self.scene.events.game.emit("minion_killed", {});
                if (self._team === "red") {
                    self.scene.events.game.emit("add_score", { amount: self._goldValue });
                }
                setTimeout(function() { self.entity.active = false; }, 500);
            }
        });
    }

    onUpdate(dt) {
        if (this._dead) return;
        this._attackCooldown -= dt;

        var pos = this.entity.transform.position;
        var enemyTag = this._team === "blue" ? "red_team" : "blue_team";
        var enemies = this.scene.findEntitiesByTag(enemyTag);

        // Find nearest enemy.
        var nearest = null;
        var nearestDist = 99999;
        if (enemies) {
            for (var i = 0; i < enemies.length; i++) {
                var e = enemies[i];
                if (!e || !e.active) continue;
                var ep = e.transform.position;
                var dx = ep.x - pos.x, dz = ep.z - pos.z;
                var d = Math.sqrt(dx * dx + dz * dz);
                if (d < nearestDist) { nearestDist = d; nearest = e; }
            }
        }

        // In range — face the target and attack on cooldown, no position change.
        if (nearest && nearestDist <= this._attackRange) {
            var ep = nearest.transform.position;
            var fdx = ep.x - pos.x, fdz = ep.z - pos.z;
            this.entity.transform.setRotationEuler(0, Math.atan2(-fdx, -fdz) * 180 / Math.PI, 0);
            if (this._attackCooldown <= 0) {
                this._attackCooldown = this._attackRate;
                this.scene.events.game.emit("entity_damaged", { entityId: nearest.id, amount: this._damage, source: "minion" });
            }
            return;
        }

        // Chase a nearby enemy or walk down the lane. Either way: setPosition
        // with the original y preserved, so the minion can't drift through
        // the ground.
        var vx = 0, vz = 0;
        if (nearest && nearestDist <= 15) {
            var cep = nearest.transform.position;
            var cdx = cep.x - pos.x, cdz = cep.z - pos.z;
            var len = Math.sqrt(cdx * cdx + cdz * cdz);
            if (len > 0) {
                vx = (cdx / len) * this._moveSpeed;
                vz = (cdz / len) * this._moveSpeed;
            }
        } else {
            vx = this._direction * this._moveSpeed;
        }

        if (vx !== 0 || vz !== 0) {
            this.scene.setPosition(this.entity.id, pos.x + vx * dt, pos.y, pos.z + vz * dt);
            this.entity.transform.setRotationEuler(0, Math.atan2(-vx, -vz) * 180 / Math.PI, 0);
        }
    }
}
