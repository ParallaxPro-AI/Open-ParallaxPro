// also: infinite, procedural, obstacles, collectibles, power-ups, endless
// Surf spawner — procedural track, obstacle, coin, and power-up generation for endless runner
class SurfSpawnerSystem extends GameScript {
    _trackSegLen = 40;
    _spawnAhead = 140;
    _despawnBehind = 50;
    _obMinGap = 22;
    _obMaxGap = 38;
    _coinSpacing = 2.2;
    _powerupChance = 0.09;
    _buildingSpacing = 28;
    _laneWidth = 2.5;
    _collectRadius = 2.0;
    _obstacleRadius = 1.3;

    _player = null;
    _spawned = [];
    _score = 0;
    _coins = 0;
    _distance = 0;
    _multiplier = 1;
    _shieldActive = false;
    _magnetActive = false;
    _magnetTimer = 0;
    _shieldTimer = 0;
    _multiplierTimer = 0;
    _gameActive = false;
    _lastTrackZ = 40;
    _nextObZ = -35;
    _lastBuildZ = 0;
    _highScore = 0;
    _coinBobTimer = 0;
    _crashed = false;

    onStart() {
        var self = this;

        this.scene.events.game.on("game_ready", function() {
            self._fullReset();
        });

        this.scene.events.game.on("race_start", function() {
            self._fullReset();
        });

        this.scene.events.game.on("race_started", function() {
            self._gameActive = true;
        });

        this.scene.events.game.on("runner_crash", function() {
            self._crashed = true;
        });

        this.scene.events.game.on("game_over", function() {
            self._gameActive = false;
            self._ended = true;
            if (self._score > self._highScore) self._highScore = self._score;
            self.scene.events.ui.emit("hud_update", {
                _gameOver: {
                    title: "BUSTED!",
                    score: self._score,
                    stats: {
                        "Distance": Math.floor(self._distance) + "m",
                        "Coins": "" + self._coins,
                        "Score": "" + self._score,
                        "Best": "" + self._highScore
                    }
                }
            });
        });

        this.scene.events.game.on("restart_game", function() {
            self._fullReset();
        });

        // Initial track pre-spawn
        this._spawnInitialTrack();
    }

    _fullReset() {
        // Destroy all spawned entities
        for (var i = 0; i < this._spawned.length; i++) {
            var ent = this._spawned[i].entity;
            if (ent && ent.active !== undefined) ent.active = false;
        }
        this._spawned = [];

        this._score = 0;
        this._coins = 0;
        this._distance = 0;
        this._multiplier = 1;
        this._shieldActive = false;
        this._magnetActive = false;
        this._magnetTimer = 0;
        this._shieldTimer = 0;
        this._multiplierTimer = 0;
        this._gameActive = false;
        this._crashed = false;
        this._lastTrackZ = 40;
        this._nextObZ = -35;
        this._lastBuildZ = 0;
        this._coinBobTimer = 0;

        this._spawnInitialTrack();
        this._updateHud();
    }

    _spawnInitialTrack() {
        // _spawnAhead/_trackSegLen don't divide cleanly (140/40=3.5), so
        // the loop's final spawn lands somewhere short of -_spawnAhead.
        // Track the actual last spawned z and feed it back into
        // _lastTrackZ so the streaming spawner continues contiguously
        // — otherwise there's a half-segment gap (~20m of invisible
        // road) where the player runs after the initial chunks end.
        var lastSpawnedZ = 40;
        for (var z = 40; z >= -this._spawnAhead; z -= this._trackSegLen) {
            this._spawnTrack(z);
            lastSpawnedZ = z;
        }
        this._lastTrackZ = lastSpawnedZ;

        // Spawn initial scenery
        for (var sz = 0; sz >= -this._spawnAhead; sz -= this._buildingSpacing) {
            this._spawnScenery(sz);
        }
        this._lastBuildZ = -this._spawnAhead;
    }

    onUpdate(dt) {
        if (!this._gameActive || this._crashed) return;

        this._player = this.scene.findEntityByName("Runner");
        if (!this._player) return;

        var pp = this._player.transform.position;
        var playerZ = pp.z;

        // Update distance and score
        this._distance = Math.abs(playerZ);
        this._score = Math.floor(this._distance) + this._coins * 10 * this._multiplier;
        this._coinBobTimer += dt;

        // Update power-up timers
        this._updatePowerups(dt);

        // Spawn track ahead
        while (this._lastTrackZ > playerZ - this._spawnAhead) {
            this._lastTrackZ -= this._trackSegLen;
            this._spawnTrack(this._lastTrackZ);
        }

        // Spawn obstacles
        while (this._nextObZ > playerZ - this._spawnAhead) {
            this._spawnObstacleGroup(this._nextObZ);
            var gap = this._obMinGap + Math.random() * (this._obMaxGap - this._obMinGap);
            // Gap decreases slightly as speed increases for difficulty
            var speedFactor = Math.max(0.65, 1 - this._distance * 0.0001);
            this._nextObZ -= gap * speedFactor;
        }

        // Spawn scenery
        while (this._lastBuildZ > playerZ - this._spawnAhead) {
            this._lastBuildZ -= this._buildingSpacing;
            this._spawnScenery(this._lastBuildZ);
        }

        // Collision detection
        this._checkCollisions(pp);

        // Magnet: attract nearby coins
        if (this._magnetActive) {
            this._attractCoins(pp, dt);
        }

        // Bob coins
        this._bobCoins();

        // Cleanup behind player
        this._cleanupBehind(playerZ + this._despawnBehind);

        // Update HUD
        this._updateHud();
    }

    _spawnTrack(z) {
        // Main road surface
        var ground = this.scene.spawnEntity("track_road");
        if (ground) {
            this.scene.setPosition(ground.id, 0, -0.25, z);
            this._spawned.push({ entity: ground, z: z, type: "track" });
        }
        // Side walls
        var wallL = this.scene.spawnEntity("track_wall");
        if (wallL) {
            this.scene.setPosition(wallL.id, -5.5, 0.75, z);
            this._spawned.push({ entity: wallL, z: z, type: "track" });
        }
        var wallR = this.scene.spawnEntity("track_wall");
        if (wallR) {
            this.scene.setPosition(wallR.id, 5.5, 0.75, z);
            this._spawned.push({ entity: wallR, z: z, type: "track" });
        }
    }

    _spawnObstacleGroup(z) {
        var lanes = [-this._laneWidth, 0, this._laneWidth];
        var pattern = Math.floor(Math.random() * 7);

        switch (pattern) {
            case 0: {
                // Single vehicle in one lane
                var lane = Math.floor(Math.random() * 3);
                this._spawn("obstacle_van", lanes[lane], 0, z, "obstacle");
                // Coins in a free lane
                var freeLane = (lane + 1 + Math.floor(Math.random() * 2)) % 3;
                this._spawnCoinLine(lanes[freeLane], z + 6, z - 6);
                break;
            }
            case 1: {
                // Two vehicles — one lane free
                var free = Math.floor(Math.random() * 3);
                for (var i = 0; i < 3; i++) {
                    if (i !== free) {
                        var obType = Math.random() > 0.5 ? "obstacle_truck" : "obstacle_van";
                        this._spawn(obType, lanes[i], 0, z, "obstacle");
                    }
                }
                this._spawnCoinLine(lanes[free], z + 4, z - 4);
                break;
            }
            case 2: {
                // Low barrier — jump over
                var jLane = Math.floor(Math.random() * 3);
                this._spawn("obstacle_barrier_low", lanes[jLane], 0.4, z, "obstacle_low");
                // Coins in jump arc above the barrier
                this._spawnCoinArc(lanes[jLane], z);
                break;
            }
            case 3: {
                // High barrier — slide under
                var sLane = Math.floor(Math.random() * 3);
                this._spawn("obstacle_barrier_high", lanes[sLane], 1.8, z, "obstacle_high");
                // Coins on the ground in the slide lane
                this._spawnCoinLine(lanes[sLane], z + 3, z - 3);
                break;
            }
            case 4: {
                // Vehicle + barrier combo
                var vLane = Math.floor(Math.random() * 3);
                this._spawn("obstacle_van", lanes[vLane], 0, z, "obstacle");
                var bLane = (vLane + 1) % 3;
                this._spawn("obstacle_barrier_low", lanes[bLane], 0.4, z, "obstacle_low");
                // Free lane has coins
                var cLane = (vLane + 2) % 3;
                this._spawnCoinLine(lanes[cLane], z + 5, z - 5);
                break;
            }
            case 5: {
                // Staggered obstacles — two at different Z
                var lane1 = Math.floor(Math.random() * 3);
                var lane2 = (lane1 + 1 + Math.floor(Math.random() * 2)) % 3;
                this._spawn("obstacle_truck", lanes[lane1], 0, z, "obstacle");
                this._spawn("obstacle_van", lanes[lane2], 0, z - 8, "obstacle");
                break;
            }
            case 6: {
                // Full row of cones — jump or slide between gaps
                for (var c = 0; c < 3; c++) {
                    this._spawn("obstacle_cone", lanes[c], 0.3, z, "obstacle_low");
                }
                // Coins behind the cones
                var coinLane = Math.floor(Math.random() * 3);
                this._spawnCoinLine(lanes[coinLane], z - 3, z - 10);
                break;
            }
        }

        // Power-up chance
        if (Math.random() < this._powerupChance) {
            var puLane = Math.floor(Math.random() * 3);
            var puRand = Math.random();
            var puType = "powerup_magnet";
            if (puRand > 0.66) puType = "powerup_shield";
            else if (puRand > 0.33) puType = "powerup_multiplier";
            this._spawn(puType, lanes[puLane], 1.8, z - 12, "powerup");
        }
    }

    _spawnCoinLine(x, startZ, endZ) {
        for (var z = startZ; z >= endZ; z -= this._coinSpacing) {
            this._spawn("coin", x, 1.3, z, "coin");
        }
    }

    _spawnCoinArc(x, z) {
        for (var i = -2; i <= 2; i++) {
            var arcHeight = 1.3 + 2.5 * (1 - (i * i) / 4);
            this._spawn("coin", x, arcHeight, z + i * 1.5, "coin");
        }
    }

    _spawnScenery(z) {
        // Buildings on both sides of the track
        var buildTypes = ["building_a", "building_b", "building_c", "building_d", "building_e"];
        if (Math.random() > 0.2) {
            var bLeft = buildTypes[Math.floor(Math.random() * buildTypes.length)];
            this._spawn(bLeft, -14 - Math.random() * 4, 0, z + Math.random() * 8, "scenery");
        }
        if (Math.random() > 0.2) {
            var bRight = buildTypes[Math.floor(Math.random() * buildTypes.length)];
            this._spawn(bRight, 14 + Math.random() * 4, 0, z + Math.random() * 8, "scenery");
        }
        // Trees
        if (Math.random() > 0.4) {
            this._spawn("tree_scenery", -7.5, 0, z + Math.random() * 10, "scenery");
        }
        if (Math.random() > 0.4) {
            this._spawn("tree_scenery", 7.5, 0, z + Math.random() * 10, "scenery");
        }
    }

    _spawn(defName, x, y, z, type) {
        var ent = this.scene.spawnEntity(defName);
        if (ent) {
            this.scene.setPosition(ent.id, x, y, z);
            this._spawned.push({ entity: ent, z: z, type: type });
        }
        return ent;
    }

    _checkCollisions(pp) {
        for (var i = this._spawned.length - 1; i >= 0; i--) {
            var s = this._spawned[i];
            if (!s.entity || !s.entity.active) continue;

            var ep = s.entity.transform.position;
            var dx = pp.x - ep.x;
            var dy = pp.y - ep.y;
            var dz = pp.z - ep.z;
            var distXZ = Math.sqrt(dx * dx + dz * dz);

            // Coins
            if (s.type === "coin") {
                var coinDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (coinDist < this._collectRadius) {
                    s.entity.active = false;
                    this._coins++;
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/pepSound1.ogg", 0.35);
                    this._spawned.splice(i, 1);
                    continue;
                }
            }

            // Power-ups
            if (s.type === "powerup") {
                var puDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (puDist < this._collectRadius) {
                    s.entity.active = false;
                    this._activatePowerup(s.entity);
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/powerUp5.ogg", 0.5);
                    this._spawned.splice(i, 1);
                    continue;
                }
            }

            // Obstacles
            if (s.type === "obstacle" || s.type === "obstacle_low" || s.type === "obstacle_high") {
                // Only check close obstacles for performance
                if (Math.abs(dz) > 3) continue;
                if (distXZ > this._obstacleRadius + 0.5) continue;

                // Low barrier — player can jump over (y > 2.0 means above it)
                if (s.type === "obstacle_low" && pp.y > 2.0) continue;

                // High barrier — player must slide under
                if (s.type === "obstacle_high") {
                    var sliding = this.scene._surfSliding || false;
                    if (sliding) continue;
                }

                // Full obstacle — check lateral distance more carefully
                if (s.type === "obstacle") {
                    if (distXZ > this._obstacleRadius) continue;
                    if (Math.abs(dy) > 1.5) continue;
                }

                // Hit!
                if (this._shieldActive) {
                    this._shieldActive = false;
                    this._shieldTimer = 0;
                    s.entity.active = false;
                    this._spawned.splice(i, 1);
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaserDown2.ogg", 0.5);
                    continue;
                }

                this.scene.events.game.emit("runner_crash", {});
                return;
            }
        }
    }

    _activatePowerup(entity) {
        var tags = entity.tags || [];
        for (var t = 0; t < tags.length; t++) {
            if (tags[t] === "magnet") {
                this._magnetActive = true;
                this._magnetTimer = 8;
            }
            if (tags[t] === "shield") {
                this._shieldActive = true;
                this._shieldTimer = 12;
            }
            if (tags[t] === "score_multi") {
                this._multiplier = 2;
                this._multiplierTimer = 10;
            }
        }
    }

    _updatePowerups(dt) {
        if (this._magnetTimer > 0) {
            this._magnetTimer -= dt;
            if (this._magnetTimer <= 0) {
                this._magnetActive = false;
                this._magnetTimer = 0;
            }
        }
        if (this._shieldTimer > 0) {
            this._shieldTimer -= dt;
            if (this._shieldTimer <= 0) {
                this._shieldActive = false;
                this._shieldTimer = 0;
            }
        }
        if (this._multiplierTimer > 0) {
            this._multiplierTimer -= dt;
            if (this._multiplierTimer <= 0) {
                this._multiplier = 1;
                this._multiplierTimer = 0;
            }
        }
    }

    _attractCoins(pp, dt) {
        var magnetRange = 10;
        for (var i = 0; i < this._spawned.length; i++) {
            var s = this._spawned[i];
            if (s.type !== "coin" || !s.entity || !s.entity.active) continue;
            var ep = s.entity.transform.position;
            var dx = pp.x - ep.x;
            var dy = pp.y - ep.y;
            var dz = pp.z - ep.z;
            var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist < magnetRange && dist > 0.3) {
                var pull = 15 * dt / dist;
                this.scene.setPosition(s.entity.id, ep.x + dx * pull, ep.y + dy * pull, ep.z + dz * pull);
            }
        }
    }

    _bobCoins() {
        var t = this._coinBobTimer;
        for (var i = 0; i < this._spawned.length; i++) {
            var s = this._spawned[i];
            if (s.type !== "coin" || !s.entity || !s.entity.active) continue;
            // Gentle spin via rotation
            if (s.entity.transform && s.entity.transform.setRotationEuler) {
                s.entity.transform.setRotationEuler(0, (t * 180 + i * 45) % 360, 0);
            }
        }
    }

    _cleanupBehind(maxZ) {
        for (var i = this._spawned.length - 1; i >= 0; i--) {
            var s = this._spawned[i];
            if (!s.entity) {
                this._spawned.splice(i, 1);
                continue;
            }
            var ep = s.entity.transform ? s.entity.transform.position : null;
            if (!ep) continue;
            if (ep.z > maxZ) {
                s.entity.active = false;
                this._spawned.splice(i, 1);
            }
        }
    }

    _updateHud() {
        if (!this._gameActive || this._ended) return;
        this.scene.events.ui.emit("hud_update", {
            score: this._score,
            coins: this._coins,
            distance: Math.floor(this._distance),
            multiplier: this._multiplier,
            shieldActive: this._shieldActive,
            magnetActive: this._magnetActive,
            shieldTime: Math.ceil(this._shieldTimer),
            magnetTime: Math.ceil(this._magnetTimer),
            multiplierTime: Math.ceil(this._multiplierTimer)
        });
    }
}
