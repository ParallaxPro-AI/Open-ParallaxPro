// also: creep, wave, moba_unit, enemy_spawn, economic_reward, lane_push
// Minion AI — walks down lane, attacks nearest enemy, grants gold on death
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
        // Determine team and lane direction from tags
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
                // Grant gold if this is a red team minion (enemy kill)
                if (self._team === "red") {
                    self.scene.events.game.emit("add_score", { amount: self._goldValue });
                }
                self.scene.setVelocity(self.entity.id, { x: 0, y: 0, z: 0 });
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

        // Find nearest enemy
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

        // Attack if in range
        if (nearest && nearestDist <= this._attackRange && this._attackCooldown <= 0) {
            this._attackCooldown = this._attackRate;
            this.scene.events.game.emit("entity_damaged", { entityId: nearest.id, amount: this._damage, source: "minion" });
            this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
            return;
        }

        // Chase if nearby enemy detected
        if (nearest && nearestDist <= 15) {
            var ep = nearest.transform.position;
            var dx = ep.x - pos.x, dz = ep.z - pos.z;
            var len = Math.sqrt(dx * dx + dz * dz);
            if (len > 0) {
                this.scene.setVelocity(this.entity.id, {
                    x: (dx / len) * this._moveSpeed,
                    y: 0,
                    z: (dz / len) * this._moveSpeed
                });
            }
            return;
        }

        // Walk down lane toward enemy base
        this.scene.setVelocity(this.entity.id, {
            x: this._direction * this._moveSpeed,
            y: 0,
            z: 0
        });
    }
}
