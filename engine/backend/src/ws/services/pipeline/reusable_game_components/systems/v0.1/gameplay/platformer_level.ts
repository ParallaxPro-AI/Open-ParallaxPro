// also: movement-based challenge, enemy stomping, hazard avoidance, jumping mechanics, level completion
// Platformer level — score, collectibles, lives, stomping, goal, moving platforms, hazards
class PlatformerLevelSystem extends GameScript {
    _startLives = 3;
    _killPlane = -10;
    _collectRadius = 1.8;
    _stompRadius = 1.2;
    _damageRadius = 1.0;
    _goalRadius = 2.5;

    _score = 0;
    _coins = 0;
    _lives = 3;
    _dead = false;
    _levelComplete = false;
    _invincibleTimer = 0;
    _spawnX = 0;
    _spawnY = 2;
    _spawnZ = 0;
    _movers = [];
    _moversInit = false;

    onStart() {
        var self = this;

        this.scene.events.game.on("game_ready", function() {
            self._fullReset();
        });

        this.scene.events.game.on("player_respawned", function() {
            if (self._lives <= 0 || self._levelComplete) {
                self._fullReset();
            } else {
                self._softReset();
            }
        });
    }

    _fullReset() {
        this._score = 0;
        this._coins = 0;
        this._lives = this._startLives;
        this._dead = false;
        this._levelComplete = false;
        this._invincibleTimer = 2;

        var player = this.scene.findEntityByName("Player");
        if (player) {
            this._spawnX = 0;
            this._spawnY = 2;
            this._spawnZ = 0;
        }

        this._resetPlayer();
        this._reactivateAll();
        this._updateHud();
    }

    _softReset() {
        this._dead = false;
        this._invincibleTimer = 2;
        this._resetPlayer();
        this._updateHud();
    }

    _resetPlayer() {
        var player = this.scene.findEntityByName("Player");
        if (player) {
            player.active = true;
            this.scene.setPosition(player.id, this._spawnX, this._spawnY, this._spawnZ);
            this.scene.setVelocity(player.id, { x: 0, y: 0, z: 0 });
        }
    }

    _reactivateAll() {
        var collectibles = this.scene.findEntitiesByTag("collectible") || [];
        for (var i = 0; i < collectibles.length; i++) {
            collectibles[i].active = true;
        }
        var hearts = this.scene.findEntitiesByTag("heart_pickup") || [];
        for (var i = 0; i < hearts.length; i++) {
            hearts[i].active = true;
        }
        var enemies = this.scene.findEntitiesByTag("enemy") || [];
        for (var i = 0; i < enemies.length; i++) {
            enemies[i].active = true;
        }
    }

    _die() {
        if (this._dead || this._levelComplete) return;
        this._dead = true;
        this._lives--;
        this._updateHud();

        if (this._lives <= 0) {
            this.scene.events.ui.emit("hud_update", {
                _gameOver: {
                    title: "GAME OVER",
                    score: this._score,
                    stats: { "Coins": "" + this._coins, "Score": "" + this._score }
                }
            });
            this.scene.events.game.emit("game_over", {});
        } else {
            this.scene.events.game.emit("player_died", {});
        }
    }

    _updateHud() {
        this.scene.events.ui.emit("hud_update", {
            score: this._score,
            coins: this._coins,
            lives: this._lives
        });
    }

    onUpdate(dt) {
        if (this._dead || this._levelComplete) return;
        this._invincibleTimer -= dt;

        var player = this.scene.findEntityByName("Player");
        if (!player || !player.active) return;
        var pp = player.transform.position;

        // Kill plane
        if (pp.y < this._killPlane) {
            if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaserDown1.ogg", 0.5);
            this._die();
            return;
        }

        // Player velocity for stomp
        var rb = player.getComponent ? player.getComponent("RigidbodyComponent") : null;
        var vy = 0;
        if (rb && rb.getLinearVelocity) {
            vy = rb.getLinearVelocity().y || 0;
        }

        // Collectibles
        var collectibles = this.scene.findEntitiesByTag("collectible") || [];
        for (var c = 0; c < collectibles.length; c++) {
            if (!collectibles[c].active) continue;
            var cp = collectibles[c].transform.position;
            var cdx = pp.x - cp.x, cdy = pp.y - cp.y, cdz = pp.z - cp.z;
            var cdist = Math.sqrt(cdx * cdx + cdy * cdy + cdz * cdz);
            if (cdist < this._collectRadius) {
                collectibles[c].active = false;
                var tags = collectibles[c].tags || [];
                var isGem = false;
                for (var t = 0; t < tags.length; t++) {
                    if (tags[t] === "gem") isGem = true;
                }
                if (isGem) {
                    this._score += 50;
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/powerUp4.ogg", 0.5);
                } else {
                    this._score += 10;
                    this._coins++;
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/pepSound1.ogg", 0.5);
                }
                this._updateHud();
            }
        }

        // Heart pickups
        var hearts = this.scene.findEntitiesByTag("heart_pickup") || [];
        for (var h = 0; h < hearts.length; h++) {
            if (!hearts[h].active) continue;
            var hp = hearts[h].transform.position;
            var hdx = pp.x - hp.x, hdy = pp.y - hp.y, hdz = pp.z - hp.z;
            var hdist = Math.sqrt(hdx * hdx + hdy * hdy + hdz * hdz);
            if (hdist < this._collectRadius) {
                hearts[h].active = false;
                this._lives = Math.min(5, this._lives + 1);
                if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/powerUp8.ogg", 0.6);
                this._updateHud();
            }
        }

        // Enemy interaction
        if (this._invincibleTimer <= 0) {
            var enemies = this.scene.findEntitiesByTag("enemy") || [];
            for (var e = 0; e < enemies.length; e++) {
                if (!enemies[e].active) continue;
                var ep = enemies[e].transform.position;
                var edx = pp.x - ep.x, edz = pp.z - ep.z;
                var ehdist = Math.sqrt(edx * edx + edz * edz);
                var eyDiff = pp.y - ep.y;

                if (ehdist < this._stompRadius && eyDiff > 0.3 && vy < -1) {
                    // Stomp!
                    enemies[e].active = false;
                    this._score += 25;
                    var curVx = rb && rb.getLinearVelocity ? rb.getLinearVelocity().x : 0;
                    var curVz = rb && rb.getLinearVelocity ? rb.getLinearVelocity().z : 0;
                    this.scene.setVelocity(player.id, { x: curVx, y: 8, z: curVz });
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactPunch_heavy_000.ogg", 0.5);
                    this._updateHud();
                    break;
                } else if (ehdist < this._damageRadius && Math.abs(eyDiff) < 1.0) {
                    // Hit by enemy
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactSoft_heavy_002.ogg", 0.5);
                    this._die();
                    return;
                }
            }
        }

        // Hazards
        var hazards = this.scene.findEntitiesByTag("hazard") || [];
        for (var z = 0; z < hazards.length; z++) {
            if (!hazards[z].active) continue;
            var zp = hazards[z].transform.position;
            var zdx = pp.x - zp.x, zdy = pp.y - zp.y, zdz = pp.z - zp.z;
            var zdist = Math.sqrt(zdx * zdx + zdy * zdy + zdz * zdz);
            if (zdist < 1.5 && this._invincibleTimer <= 0) {
                if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactMetal_light_001.ogg", 0.4);
                this._die();
                return;
            }
        }

        // Goal detection
        var goals = this.scene.findEntitiesByTag("goal") || [];
        for (var g = 0; g < goals.length; g++) {
            var gp = goals[g].transform.position;
            var gdx = pp.x - gp.x, gdy = pp.y - gp.y, gdz = pp.z - gp.z;
            var gdist = Math.sqrt(gdx * gdx + gdy * gdy + gdz * gdz);
            if (gdist < this._goalRadius) {
                this._levelComplete = true;
                this._score += 200;
                this.scene.events.ui.emit("hud_update", {
                    score: this._score,
                    _gameOver: {
                        title: "LEVEL COMPLETE!",
                        score: this._score,
                        stats: { "Coins": "" + this._coins, "Lives": "" + this._lives, "Score": "" + this._score }
                    }
                });
                this.scene.events.game.emit("game_won", {});
                return;
            }
        }

        // Moving platforms
        if (!this._moversInit) {
            this._moversInit = true;
            var movers = this.scene.findEntitiesByTag("moving_platform") || [];
            for (var m = 0; m < movers.length; m++) {
                var mp = movers[m].transform.position;
                this._movers.push({ id: movers[m].id, startX: mp.x, startY: mp.y, startZ: mp.z, timer: Math.random() * 6 });
            }
        }
        for (var m = 0; m < this._movers.length; m++) {
            var md = this._movers[m];
            md.timer += dt;
            var newMX = md.startX + Math.sin(md.timer * 1.0) * 5;
            this.scene.setPosition(md.id, newMX, md.startY, md.startZ);
        }

        // Spin collectibles
        for (var s = 0; s < collectibles.length; s++) {
            if (!collectibles[s].active) continue;
            var cPos = collectibles[s].transform.position;
            var bobY = Math.sin(Date.now() * 0.003 + s) * 0.15;
            this.scene.setPosition(collectibles[s].id, cPos.x, cPos.y + bobY * dt, cPos.z);
        }
    }
}
