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
    // Visible energy-bolt tracers — short-lived spheres lerping from
    // the tower toward each shot's target. Damage is applied at fire-
    // time; the tracer is purely cosmetic.
    _tracers = [];

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
        this._updateTracers(dt);
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
            var np = nearest.transform.position;
            // Blue towers fire blue bolts, red fire red. Spawn from the
            // tower's mid-height (~2u) toward enemy chest (~1u).
            var color = this._team === "red" ? [1.0, 0.30, 0.30, 1] : [0.35, 0.70, 1.0, 1];
            this._spawnTracer(pos.x, pos.y + 2.0, pos.z, np.x, np.y + 1.0, np.z, color);
            if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_001.ogg", 0.3);
        }
    }

    _spawnTracer(fromX, fromY, fromZ, toX, toY, toZ, color) {
        if (!this.scene.createEntity) return;
        var name = "tr_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
        var id = this.scene.createEntity(name);
        if (id == null || id === -1) return;
        this.scene.setScale && this.scene.setScale(id, 0.28, 0.28, 0.28);
        this.scene.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: color
        });
        this.scene.setPosition(id, fromX, fromY, fromZ);
        if (this.scene.addTag) this.scene.addTag(id, "tracer");
        var dx = toX - fromX, dy = toY - fromY, dz = toZ - fromZ;
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        var duration = Math.max(0.05, dist / 32);
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
