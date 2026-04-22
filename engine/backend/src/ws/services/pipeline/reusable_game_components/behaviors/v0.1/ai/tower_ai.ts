// also: base_structure, strategic_defense, moba_objective, faction_asset, game_objective
// Tower/Nexus AI — attacks nearest enemy in range, takes damage, handles win/lose
class TowerAIBehavior extends GameScript {
    _behaviorName = "tower_ai";
    _health = 2000;
    _maxHealth = 2000;
    _damage = 50;
    _attackRange = 12;
    _attackRate = 1.0;
    _attackCooldown = 0;
    _dead = false;
    _team = "";
    _isNexus = false;

    onStart() {
        var tags = this.entity.tags || [];
        for (var i = 0; i < tags.length; i++) {
            if (tags[i] === "blue_team") this._team = "blue";
            if (tags[i] === "red_team") this._team = "red";
            if (tags[i] === "nexus") this._isNexus = true;
        }

        var self = this;

        this.scene.events.game.on("entity_damaged", function(data) {
            if (data.entityId !== self.entity.id || self._dead) return;
            self._health -= data.amount || 0;
            if (self._health <= 0) {
                self._health = 0;
                self._dead = true;

                if (self._isNexus) {
                    if (self._team === "red") {
                        self.scene.events.ui.emit("hud_update", {
                            _gameOver: {
                                title: "VICTORY",
                                stats: { "Result": "Enemy Nexus Destroyed" }
                            }
                        });
                        self.scene.events.game.emit("nexus_destroyed", {});
                    } else {
                        self.scene.events.ui.emit("hud_update", {
                            _gameOver: {
                                title: "DEFEAT",
                                stats: { "Result": "Your Nexus Destroyed" }
                            }
                        });
                        self.scene.events.game.emit("player_nexus_destroyed", {});
                    }
                } else {
                    // Tower destroyed — grant gold for enemy towers
                    if (self._team === "red") {
                        self.scene.events.game.emit("add_score", { amount: 150 });
                    }
                    self.scene.events.game.emit("entity_killed", { entityId: self.entity.id });
                }
            }
        });

        this.scene.events.game.on("game_ready", function() {
            self._health = self._maxHealth;
            self._dead = false;
            self._attackCooldown = 0;
            self.entity.active = true;
        });
    }

    onUpdate(dt) {
        if (this._dead) return;
        if (this._attackRange <= 0) return;

        this._attackCooldown -= dt;
        if (this._attackCooldown > 0) return;

        // Find nearest enemy
        var pos = this.entity.transform.position;
        var enemyTag = this._team === "blue" ? "red_team" : "blue_team";
        var enemies = this.scene.findEntitiesByTag(enemyTag);
        if (!enemies) return;

        var nearest = null;
        var nearestDist = this._attackRange;
        for (var i = 0; i < enemies.length; i++) {
            var e = enemies[i];
            if (!e || !e.active) continue;
            var ep = e.transform.position;
            var dx = ep.x - pos.x, dz = ep.z - pos.z;
            var d = Math.sqrt(dx * dx + dz * dz);
            if (d < nearestDist) { nearestDist = d; nearest = e; }
        }

        if (nearest) {
            this._attackCooldown = this._attackRate;
            this.scene.events.game.emit("entity_damaged", { entityId: nearest.id, amount: this._damage, source: "tower" });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_001.ogg", 0.3);
        }
    }
}
