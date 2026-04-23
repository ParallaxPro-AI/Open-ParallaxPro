// also: frogger, dodging, procedural generation, movement mechanics, obstacle avoidance
// Lane Hopper — single-player endless lane-crossing.
//
// Procedurally extends a track of 2m-deep lanes ahead of the player
// and recycles lanes behind them. Each lane is one of:
//   grass  — safe, scattered static trees + occasional coin
//   road   — cars crossing at a fixed direction + speed
//   river  — logs drifting; player must ride them or drown
//   tracks — periodic train; light flashes a warning beforehand
//
// Runtime entity creation keeps the template lean: only the chicken
// player + camera + sky are pre-placed; every lane floor, tree, car,
// log, coin, and train is spawned as a primitive with tinted emissive
// at match start (or on-demand as the player advances).
//
// Dies on:
//   * overlap with a car
//   * standing in a river tile with no log under the chicken
//   * on tracks while a train is passing
//   * falling far behind the furthest reached lane (stay-still timeout)
//
// Emits:
//   score_changed   every time the player reaches a new furthest lane
//   hop_death       detailed death payload (reason + lane + score)
//   hop_coin        coin pickup (+10 score)
//   hop_reset       broadcast on restart so the player behavior snaps
//                   to tile (0, 0)
//
// Reusable for any lane-based hopper — lane-kind weights, traffic
// speed ranges, pool sizes, and aesthetic colours are all params.
class LaneHopperGameSystem extends GameScript {
    // ── Config ─────────────────────────────────────────────────────
    _tileSize = 2;
    _laneAheadCount = 14;          // lanes pre-generated ahead of player
    _laneBehindKeep = 6;           // lanes kept behind before recycling
    _safeStartLanes = 3;           // how many grass lanes at the start
    _laneHalfWidthTiles = 10;      // visible x tiles each side of origin
    _staleLaneSeconds = 8;         // sit too long → auto-scroll kills you
    _deathFreezeSec = 1.2;
    _introFreezeSec = 1.2;

    _roadSpeedRange = [4, 9];
    _riverSpeedRange = [2.5, 5];
    _trainSpeedRange = [18, 24];
    _roadCarsPerLane = [1, 3];
    _riverLogsPerLane = [2, 3];
    _trainCountdownRange = [4, 10]; // seconds between train passes

    // Lane weights (how often each type is picked after the safe zone).
    _laneWeights = { grass: 2, road: 3, river: 2, tracks: 1 };
    _treesPerGrassRange = [1, 4];
    _coinChance = 0.35;

    // Colours / visuals
    _colGrass = [0.14, 0.55, 0.22, 1];
    _colRoad = [0.10, 0.10, 0.14, 1];
    _colRoadStripe = [1.0, 0.85, 0.15, 1];
    _colRiver = [0.12, 0.55, 0.95, 0.9];
    _colTracks = [0.18, 0.14, 0.10, 1];
    _colTie = [0.28, 0.2, 0.14, 1];
    _colLog = [0.42, 0.24, 0.10, 1];
    _carPalettes = [
        [0.95, 0.25, 0.25], [0.95, 0.75, 0.15], [0.2, 0.7, 0.95],
        [0.95, 0.55, 0.12], [0.55, 0.9, 0.45], [0.85, 0.35, 0.95],
    ];

    // ── State ──────────────────────────────────────────────────────
    _lanes = [];                  // array of lane objects keyed by laneIndex
    _score = 0;
    _furthestTileZ = 0;           // most-negative tileZ reached (player)
    _highScore = 0;
    _coins = 0;
    _coinTotal = 0;                // lifetime across runs
    _attempts = 1;
    _introTimer = 0;
    _deathTimer = 0;
    _dead = false;
    _playerLastMoveAt = 0;
    _matchElapsed = 0;
    _rngSeed = 0;

    _entityCounter = 0;

    onStart() {
        var self = this;
        this._highScore = 0;
        this._coinTotal = 0;
        this._attempts = 1;

        this.scene._hopFrozen = true;
        this.scene._hopPlatformV = { x: 0, z: 0 };
        this._introTimer = this._introFreezeSec;

        this.scene.events.game.on("game_ready", function() { self._startRun(true); });
        this.scene.events.game.on("restart_game", function() {
            self._highScore = 0; self._coinTotal = 0; self._attempts = 0;
            self._startRun(true);
        });
        this.scene.events.game.on("hop_landed", function(data) {
            var d = data || {};
            self._playerLastMoveAt = self._matchElapsed;
            if (typeof d.tz === "number" && d.tz < self._furthestTileZ) {
                var delta = self._furthestTileZ - d.tz;
                self._furthestTileZ = d.tz;
                self._score += delta;
                self._ensureLanesAhead(d.tz);
                self._recycleLanesBehind(d.tz);
                self.scene.events.game.emit("score_changed", { score: self._score });
                if (self.audio && self._score % 10 === 0) {
                    self.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_002.ogg", 0.3);
                }
            }
        });
        this.scene.events.game.on("hop_start", function() {
            self._playerLastMoveAt = self._matchElapsed;
        });

        this._startRun(true);
    }

    onUpdate(dt) {
        this._matchElapsed += dt;

        if (this._introTimer > 0) {
            this._introTimer -= dt;
            if (this._introTimer <= 0) {
                this.scene._hopFrozen = false;
                if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/go.ogg", 0.55);
            }
            this._pushHud();
            return;
        }

        if (this._deathTimer > 0) {
            this._deathTimer -= dt;
            if (this._deathTimer <= 0) {
                // Hand off to the FSM so it swaps to the game-over panel
                // with Play Again / Main Menu buttons. restart_game will
                // come back in if the player retries.
                this.scene.events.game.emit("game_over", { score: this._score });
            }
            this._pushHud();
            return;
        }

        if (this._dead) return;

        // Update traffic actors.
        this._updateTraffic(dt);
        // Advance each active train's countdown.
        this._updateTrains(dt);

        // Collision detection with hazards.
        var player = this._findPlayer();
        if (!player) return;
        var pp = player.transform.position;
        var tileX = Math.round(pp.x / this._tileSize);
        var tileZ = Math.round(pp.z / this._tileSize);

        // Determine lane the player stands on.
        var lane = this._laneByTileZ(tileZ);
        if (lane) {
            // River drift: if on a log, apply log velocity; if not on log, drown.
            if (lane.kind === "river") {
                var onLog = this._findLogUnder(lane, pp);
                if (onLog) {
                    this.scene._hopPlatformV = { x: onLog.vx, z: 0 };
                } else if (!this._isHopping()) {
                    this.scene._hopPlatformV = { x: 0, z: 0 };
                    // Only die when the hop has landed (not mid-arc).
                    this._onPlayerDeath("water");
                    return;
                } else {
                    this.scene._hopPlatformV = { x: 0, z: 0 };
                }
            } else {
                this.scene._hopPlatformV = { x: 0, z: 0 };
            }

            // Road: check any car overlap.
            if (lane.kind === "road" && !this._isHopping()) {
                for (var i = 0; i < lane.actors.length; i++) {
                    var a = lane.actors[i];
                    if (!a || !a.ent) continue;
                    var ax = a.ent.transform.position.x;
                    if (Math.abs(ax - pp.x) < 1.3) {
                        this._onPlayerDeath("car");
                        return;
                    }
                }
            }

            // Tracks: check if train is active and near.
            if (lane.kind === "tracks" && lane.trainActive && !this._isHopping()) {
                var tx = lane.trainX || 0;
                if (Math.abs(tx - pp.x) < 6) {
                    this._onPlayerDeath("train");
                    return;
                }
            }
        }

        // Clamp player so they can't walk off the rim x.
        if (pp.x > this._laneHalfWidthTiles * this._tileSize) {
            this._onPlayerDeath("edge");
            return;
        }
        if (pp.x < -this._laneHalfWidthTiles * this._tileSize) {
            this._onPlayerDeath("edge");
            return;
        }

        // Falling-off check for river drift (pushed off side by a log).
        if (lane && lane.kind === "river") {
            if (pp.x > (this._laneHalfWidthTiles + 0.8) * this._tileSize ||
                pp.x < -(this._laneHalfWidthTiles + 0.8) * this._tileSize) {
                this._onPlayerDeath("drift_off");
                return;
            }
        }

        // Coin pickup.
        this._checkCoinPickup(pp);

        // Stale check (camera auto-scroll kill).
        if (this._matchElapsed - this._playerLastMoveAt > this._staleLaneSeconds) {
            this._onPlayerDeath("eagle");
            return;
        }

        this._pushHud();
    }

    // ─── Run lifecycle ───────────────────────────────────────────────
    _startRun(fresh) {
        // Tear down old lanes.
        this._clearAllSpawned();
        this._lanes = [];
        this._score = 0;
        this._coins = 0;
        this._dead = false;
        this._deathTimer = 0;
        this._introTimer = fresh ? this._introFreezeSec : 0.4;
        this._furthestTileZ = 0;
        this._playerLastMoveAt = 0;
        this._matchElapsed = 0;
        this._attempts += 1;
        this._rngSeed = Math.floor(Math.random() * 1e9);

        // Generate starting lanes around the player.
        for (var i = -2; i <= this._laneAheadCount; i++) {
            this._generateLane(i);
        }

        // Reset player.
        this.scene.events.game.emit("hop_reset", { tx: 0, tz: 0 });
        this.scene._hopFrozen = true;
        this.scene._hopPlatformV = { x: 0, z: 0 };
        this._pushHud();
    }

    _onPlayerDeath(reason) {
        if (this._dead) return;
        this._dead = true;
        this._deathTimer = this._deathFreezeSec;
        this.scene._hopFrozen = true;
        if (this._score > this._highScore) this._highScore = this._score;
        this._coinTotal += this._coins;
        this.scene.events.game.emit("hop_death", {
            reason: reason,
            score: this._score,
            coins: this._coins,
            attempts: this._attempts,
        });
        this.scene.events.game.emit("player_died", {});
        if (this.audio) {
            var path = "/assets/kenney/audio/sci_fi_sounds/explosionCrunch_000.ogg";
            if (reason === "water") path = "/assets/kenney/audio/impact_sounds/impactSoft_heavy_001.ogg";
            else if (reason === "train") path = "/assets/kenney/audio/sci_fi_sounds/forceField_003.ogg";
            else if (reason === "eagle") path = "/assets/kenney/audio/voiceover_pack/male/mission_failed.ogg";
            this.audio.playSound(path, 0.55);
        }
        this._pushHud();
    }

    // ─── Lane generation ─────────────────────────────────────────────
    _generateLane(idx) {
        if (this._laneAt(idx)) return;

        var kind = (idx <= this._safeStartLanes && idx >= 0) ? "grass" : this._pickLaneKind();
        var laneZ = -idx * this._tileSize;

        var lane = {
            idx: idx,
            kind: kind,
            z: laneZ,
            actors: [],
            trees: [],
            coins: [],
            floor: null,
            trainActive: false,
            trainNextAt: 0,
            trainX: 0,
            trainVx: 0,
            decor: [],
        };

        // Floor tile per lane: a wide cube spanning the lane.
        var floorColor = this._kindColor(kind);
        var floorW = (this._laneHalfWidthTiles * 2 + 4) * this._tileSize;
        var floorDepth = this._tileSize;
        var floorY = (kind === "river") ? -0.3 : 0;
        var floor = this._spawnPrim("Lane_" + idx, "cube", {
            x: 0, y: floorY, z: laneZ,
            sx: floorW, sy: 0.4, sz: floorDepth,
            color: floorColor,
            emissive: kind === "road" ? [0.03, 0.03, 0.05] : [0, 0, 0],
            emissiveIntensity: 0.0,
            tag: "hop_lane",
        });
        lane.floor = floor;

        if (kind === "road") {
            // Yellow stripe down the middle.
            var stripe = this._spawnPrim("LaneStripe_" + idx, "cube", {
                x: 0, y: floorY + 0.25, z: laneZ,
                sx: floorW, sy: 0.04, sz: 0.18,
                color: this._colRoadStripe,
                emissive: [1.0, 0.85, 0.15], emissiveIntensity: 1.8,
                tag: "hop_decor",
            });
            lane.decor.push(stripe);
            this._populateRoad(lane);
        } else if (kind === "river") {
            // Glowing water line on the surface.
            var water = this._spawnPrim("LaneWater_" + idx, "cube", {
                x: 0, y: floorY + 0.25, z: laneZ,
                sx: floorW, sy: 0.04, sz: floorDepth * 0.9,
                color: [0.2, 0.7, 1.0, 0.7],
                emissive: [0.2, 0.8, 1.0], emissiveIntensity: 1.2,
                tag: "hop_decor",
            });
            lane.decor.push(water);
            this._populateRiver(lane);
        } else if (kind === "tracks") {
            // Wooden ties across the tracks.
            for (var tx = -this._laneHalfWidthTiles; tx <= this._laneHalfWidthTiles; tx += 1.5) {
                var tie = this._spawnPrim("Tie_" + idx + "_" + tx.toFixed(1), "cube", {
                    x: tx * this._tileSize * 0.5, y: floorY + 0.22, z: laneZ,
                    sx: 0.6, sy: 0.06, sz: floorDepth * 0.85,
                    color: this._colTie,
                    tag: "hop_decor",
                });
                lane.decor.push(tie);
            }
            // Two rails along the lane.
            var railOffs = [-0.35, 0.35];
            for (var r = 0; r < 2; r++) {
                var rail = this._spawnPrim("Rail_" + idx + "_" + r, "cube", {
                    x: 0, y: floorY + 0.28, z: laneZ + railOffs[r],
                    sx: floorW, sy: 0.04, sz: 0.1,
                    color: [0.7, 0.7, 0.75, 1],
                    emissive: [0.85, 0.85, 0.9], emissiveIntensity: 1.4,
                    tag: "hop_decor",
                });
                lane.decor.push(rail);
            }
            lane.trainVx = (Math.random() < 0.5 ? -1 : 1) * this._randBetween(this._trainSpeedRange[0], this._trainSpeedRange[1]);
            lane.trainNextAt = this._randBetween(this._trainCountdownRange[0], this._trainCountdownRange[1]);
            // Warning light marker on the side.
            var warn = this._spawnPrim("TrackWarn_" + idx, "cube", {
                x: -(this._laneHalfWidthTiles + 1.5) * this._tileSize, y: 2.4, z: laneZ,
                sx: 0.4, sy: 1.0, sz: 0.4,
                color: [0.7, 0.1, 0.1, 1],
                emissive: [0.8, 0.1, 0.1], emissiveIntensity: 0.6,
                tag: "hop_decor",
            });
            lane.decor.push(warn);
            lane.warnLight = warn;
        } else {
            // grass
            this._populateGrass(lane);
        }

        this._lanes.push(lane);
    }

    _pickLaneKind() {
        // Weighted pick with some adjacency constraints — avoid river
        // next to tracks (hard), avoid two rivers flowing opposite too close.
        var last = this._lanes[this._lanes.length - 1];
        var lastKind = last ? last.kind : "grass";
        var weights = Object.assign({}, this._laneWeights);
        if (lastKind === "tracks") { weights.tracks = 0; weights.river = Math.max(0, weights.river - 1); }
        if (lastKind === "river") weights.river = Math.max(0, weights.river - 1);
        if (lastKind === "road") weights.road = Math.max(0, weights.road - 0.5);
        var total = weights.grass + weights.road + weights.river + weights.tracks;
        if (total <= 0) return "grass";
        var r = Math.random() * total;
        if ((r -= weights.grass) < 0) return "grass";
        if ((r -= weights.road) < 0) return "road";
        if ((r -= weights.river) < 0) return "river";
        return "tracks";
    }

    _populateGrass(lane) {
        var n = Math.floor(this._randBetween(this._treesPerGrassRange[0], this._treesPerGrassRange[1] + 1));
        var taken = {};
        for (var i = 0; i < n; i++) {
            var tx = Math.floor(Math.random() * (this._laneHalfWidthTiles * 2 + 1)) - this._laneHalfWidthTiles;
            if (tx === 0 && lane.idx === 0) continue; // don't block spawn
            if (taken[tx]) continue;
            taken[tx] = true;
            var palette = Math.random() < 0.35 ? [0.22, 0.42, 0.18] : [0.18, 0.48, 0.22];
            var tree = this._spawnPrim("Tree_" + (this._entityCounter++), "cylinder", {
                x: tx * this._tileSize, y: 1.1, z: lane.z,
                sx: 0.85, sy: 2.1, sz: 0.85,
                color: [palette[0], palette[1], palette[2], 1],
                tag: "hop_obstacle",
            });
            var trunk = this._spawnPrim("Trunk_" + (this._entityCounter++), "cube", {
                x: tx * this._tileSize, y: 0.3, z: lane.z,
                sx: 0.5, sy: 0.6, sz: 0.5,
                color: [0.32, 0.18, 0.08, 1],
                tag: "hop_decor",
            });
            lane.trees.push({ ent: tree, tx: tx });
            lane.decor.push(trunk);
        }
        // Maybe spawn a coin on this lane.
        if (Math.random() < this._coinChance) {
            var cx;
            var tries = 0;
            do {
                cx = Math.floor(Math.random() * (this._laneHalfWidthTiles * 2 + 1)) - this._laneHalfWidthTiles;
                tries++;
            } while (taken[cx] && tries < 6);
            if (!taken[cx]) {
                var coin = this._spawnPrim("Coin_" + (this._entityCounter++), "sphere", {
                    x: cx * this._tileSize, y: 1.2, z: lane.z,
                    sx: 0.5, sy: 0.5, sz: 0.5,
                    color: [1.0, 0.82, 0.22, 1],
                    emissive: [1.0, 0.82, 0.2], emissiveIntensity: 1.8,
                    tag: "hop_coin",
                });
                lane.coins.push({ ent: coin, tx: cx, collected: false });
            }
        }
    }

    _populateRoad(lane) {
        var dir = Math.random() < 0.5 ? -1 : 1;
        var speed = this._randBetween(this._roadSpeedRange[0], this._roadSpeedRange[1]) * dir;
        var count = Math.floor(this._randBetween(this._roadCarsPerLane[0], this._roadCarsPerLane[1] + 1));
        var span = (this._laneHalfWidthTiles + 2) * this._tileSize * 2;
        var spacing = span / Math.max(count, 1);
        for (var i = 0; i < count; i++) {
            var x0 = -(this._laneHalfWidthTiles + 2) * this._tileSize + spacing * i + Math.random() * (spacing * 0.35);
            var col = this._carPalettes[Math.floor(Math.random() * this._carPalettes.length)];
            var car = this._spawnPrim("Car_" + (this._entityCounter++), "cube", {
                x: x0, y: 0.6, z: lane.z,
                sx: 1.7, sy: 0.9, sz: 1.2,
                color: [col[0], col[1], col[2], 1],
                emissive: [col[0] * 0.35, col[1] * 0.35, col[2] * 0.35],
                emissiveIntensity: 0.7,
                tag: "hop_car",
            });
            // Headlight block on the front.
            var light = this._spawnPrim("CarLight_" + (this._entityCounter++), "cube", {
                x: x0 + (dir > 0 ? 0.9 : -0.9), y: 0.55, z: lane.z,
                sx: 0.15, sy: 0.3, sz: 0.9,
                color: [1, 1, 0.7, 1],
                emissive: [1, 1, 0.6], emissiveIntensity: 2.4,
                tag: "hop_decor",
            });
            lane.actors.push({ ent: car, light: light, vx: speed, wrapMin: -(this._laneHalfWidthTiles + 2) * this._tileSize, wrapMax: (this._laneHalfWidthTiles + 2) * this._tileSize });
        }
    }

    _populateRiver(lane) {
        var dir = Math.random() < 0.5 ? -1 : 1;
        var speed = this._randBetween(this._riverSpeedRange[0], this._riverSpeedRange[1]) * dir;
        var count = Math.floor(this._randBetween(this._riverLogsPerLane[0], this._riverLogsPerLane[1] + 1));
        var span = (this._laneHalfWidthTiles + 2) * this._tileSize * 2;
        var spacing = span / Math.max(count, 1);
        for (var i = 0; i < count; i++) {
            var x0 = -(this._laneHalfWidthTiles + 2) * this._tileSize + spacing * i + Math.random() * (spacing * 0.3);
            var log = this._spawnPrim("Log_" + (this._entityCounter++), "cube", {
                x: x0, y: 0.25, z: lane.z,
                sx: 3.2, sy: 0.45, sz: 1.5,
                color: this._colLog,
                emissive: [0.18, 0.1, 0.04], emissiveIntensity: 0.15,
                tag: "hop_log",
            });
            lane.actors.push({
                ent: log, vx: speed,
                wrapMin: -(this._laneHalfWidthTiles + 3) * this._tileSize,
                wrapMax: (this._laneHalfWidthTiles + 3) * this._tileSize,
                halfX: 1.6,
                isPlatform: true,
            });
        }
    }

    _updateTraffic(dt) {
        for (var i = 0; i < this._lanes.length; i++) {
            var lane = this._lanes[i];
            if (!lane) continue;
            for (var j = 0; j < lane.actors.length; j++) {
                var a = lane.actors[j];
                if (!a || !a.ent || !a.ent.transform) continue;
                var p = a.ent.transform.position;
                p.x += a.vx * dt;
                var span = a.wrapMax - a.wrapMin;
                if (p.x > a.wrapMax) p.x -= span;
                else if (p.x < a.wrapMin) p.x += span;
                a.ent.transform.markDirty && a.ent.transform.markDirty();
                // Move headlight along with the car.
                if (a.light && a.light.transform) {
                    var lp = a.light.transform.position;
                    lp.x = p.x + (a.vx > 0 ? 0.9 : -0.9);
                    lp.z = p.z;
                    a.light.transform.markDirty && a.light.transform.markDirty();
                }
            }
        }
    }

    _updateTrains(dt) {
        for (var i = 0; i < this._lanes.length; i++) {
            var lane = this._lanes[i];
            if (!lane || lane.kind !== "tracks") continue;
            if (lane.trainActive) {
                lane.trainX += lane.trainVx * dt;
                if (lane.train && lane.train.transform) {
                    var p = lane.train.transform.position;
                    p.x = lane.trainX;
                    lane.train.transform.markDirty && lane.train.transform.markDirty();
                }
                var edge = (this._laneHalfWidthTiles + 4) * this._tileSize;
                if (Math.abs(lane.trainX) > edge) {
                    // Train exited — despawn and reset cooldown.
                    if (lane.train && this.scene.destroyEntity) this.scene.destroyEntity(lane.train.id);
                    lane.train = null;
                    lane.trainActive = false;
                    lane.trainNextAt = this._randBetween(this._trainCountdownRange[0], this._trainCountdownRange[1]);
                    if (lane.warnLight) this._setEmissive(lane.warnLight, [0.8, 0.1, 0.1], 0.6);
                }
            } else {
                lane.trainNextAt -= dt;
                // Blink the warning light starting 1.5s before arrival.
                if (lane.trainNextAt < 1.5 && lane.warnLight) {
                    var on = (Math.floor(lane.trainNextAt * 6) % 2) === 0;
                    this._setEmissive(lane.warnLight, [1.0, 0.2, 0.2], on ? 2.4 : 0.4);
                }
                if (lane.trainNextAt <= 0) {
                    lane.trainActive = true;
                    lane.trainX = (lane.trainVx > 0 ? -1 : 1) * (this._laneHalfWidthTiles + 3) * this._tileSize;
                    var trainColors = [0.18, 0.22, 0.35, 1];
                    var train = this._spawnPrim("Train_" + lane.idx, "cube", {
                        x: lane.trainX, y: 1.3, z: lane.z,
                        sx: 8, sy: 2.0, sz: 1.4,
                        color: trainColors,
                        emissive: [0.22, 0.3, 0.45], emissiveIntensity: 1.4,
                        tag: "hop_train",
                    });
                    // Train headlight.
                    var light = this._spawnPrim("TrainLight_" + lane.idx, "cube", {
                        x: lane.trainX + (lane.trainVx > 0 ? 4.2 : -4.2), y: 1.3, z: lane.z,
                        sx: 0.2, sy: 0.5, sz: 1.0,
                        color: [1, 1, 0.7, 1],
                        emissive: [1, 1, 0.6], emissiveIntensity: 3.2,
                        tag: "hop_decor",
                    });
                    lane.train = train;
                    lane.trainLight = light;
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/forceField_001.ogg", 0.6);
                }
            }
        }
    }

    // ─── Player-on-log ───────────────────────────────────────────────
    _findLogUnder(lane, pp) {
        for (var i = 0; i < lane.actors.length; i++) {
            var a = lane.actors[i];
            if (!a || !a.isPlatform || !a.ent) continue;
            var ax = a.ent.transform.position.x;
            if (Math.abs(ax - pp.x) <= (a.halfX || 1.6)) return a;
        }
        return null;
    }

    _isHopping() {
        var s = this.scene._tileHopperState;
        return !!(s && s.hopping);
    }

    // ─── Coin pickup ─────────────────────────────────────────────────
    _checkCoinPickup(pp) {
        for (var i = 0; i < this._lanes.length; i++) {
            var lane = this._lanes[i];
            if (!lane || !lane.coins.length) continue;
            for (var j = 0; j < lane.coins.length; j++) {
                var c = lane.coins[j];
                if (!c || c.collected || !c.ent) continue;
                var cp = c.ent.transform.position;
                var dx = cp.x - pp.x, dz = cp.z - pp.z;
                if (dx * dx + dz * dz > 1.0) continue;
                c.collected = true;
                if (this.scene.destroyEntity) this.scene.destroyEntity(c.ent.id);
                c.ent = null;
                this._coins += 1;
                this._score += 5;
                this.scene.events.game.emit("hop_coin", { total: this._coins });
                this.scene.events.game.emit("score_changed", { score: this._score });
                if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_003.ogg", 0.45);
            }
        }
    }

    // ─── Lane recycle ────────────────────────────────────────────────
    _ensureLanesAhead(playerTileZ) {
        var idxNeed = (-playerTileZ) + this._laneAheadCount;
        var maxIdx = -1e9;
        for (var i = 0; i < this._lanes.length; i++) {
            if (this._lanes[i].idx > maxIdx) maxIdx = this._lanes[i].idx;
        }
        for (var k = maxIdx + 1; k <= idxNeed; k++) this._generateLane(k);
    }

    _recycleLanesBehind(playerTileZ) {
        var minIdxKeep = (-playerTileZ) - this._laneBehindKeep;
        var keep = [];
        for (var i = 0; i < this._lanes.length; i++) {
            var L = this._lanes[i];
            if (L.idx < minIdxKeep) this._tearDownLane(L);
            else keep.push(L);
        }
        this._lanes = keep;
    }

    _tearDownLane(lane) {
        var self = this;
        var toDestroy = [];
        if (lane.floor) toDestroy.push(lane.floor);
        for (var i = 0; i < lane.actors.length; i++) {
            if (lane.actors[i] && lane.actors[i].ent) toDestroy.push(lane.actors[i].ent);
            if (lane.actors[i] && lane.actors[i].light) toDestroy.push(lane.actors[i].light);
        }
        for (var j = 0; j < lane.trees.length; j++) if (lane.trees[j].ent) toDestroy.push(lane.trees[j].ent);
        for (var k = 0; k < lane.coins.length; k++) if (lane.coins[k].ent) toDestroy.push(lane.coins[k].ent);
        for (var m = 0; m < lane.decor.length; m++) if (lane.decor[m]) toDestroy.push(lane.decor[m]);
        if (lane.train) toDestroy.push(lane.train);
        if (lane.trainLight) toDestroy.push(lane.trainLight);
        for (var n = 0; n < toDestroy.length; n++) {
            if (toDestroy[n] && self.scene.destroyEntity) self.scene.destroyEntity(toDestroy[n].id);
        }
    }

    _clearAllSpawned() {
        // Destroy everything we spawned via tags.
        var tags = ["hop_lane", "hop_decor", "hop_car", "hop_log", "hop_train", "hop_coin", "hop_obstacle"];
        for (var i = 0; i < tags.length; i++) {
            var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag(tags[i]) : [];
            for (var j = 0; j < all.length; j++) {
                if (all[j] && this.scene.destroyEntity) this.scene.destroyEntity(all[j].id);
            }
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────
    _laneByTileZ(tileZ) {
        var idx = -tileZ;
        return this._laneAt(idx);
    }

    _laneAt(idx) {
        for (var i = 0; i < this._lanes.length; i++) {
            if (this._lanes[i].idx === idx) return this._lanes[i];
        }
        return null;
    }

    _kindColor(kind) {
        switch (kind) {
            case "grass":  return this._colGrass;
            case "road":   return this._colRoad;
            case "river":  return this._colRiver;
            case "tracks": return this._colTracks;
        }
        return [0.3, 0.3, 0.3, 1];
    }

    _spawnPrim(name, meshType, cfg) {
        var scene = this.scene;
        var id = scene.createEntity && scene.createEntity(name);
        if (id == null) return null;
        scene.setPosition && scene.setPosition(id, cfg.x || 0, cfg.y || 0, cfg.z || 0);
        scene.setScale && scene.setScale(id, cfg.sx || 1, cfg.sy || 1, cfg.sz || 1);
        scene.addComponent(id, "MeshRendererComponent", {
            meshType: meshType,
            baseColor: cfg.color || [0.5, 0.5, 0.5, 1],
            emissive: cfg.emissive || [0, 0, 0],
            emissiveIntensity: cfg.emissiveIntensity || 0,
        });
        if (cfg.tag && scene.addTag) scene.addTag(id, cfg.tag);
        return scene.findEntityByName && scene.findEntityByName(name);
    }

    _setEmissive(ent, col, intensity) {
        if (!ent || !ent.getComponent) return;
        var mr = ent.getComponent("MeshRendererComponent");
        if (!mr) return;
        if (mr.emissive) {
            mr.emissive[0] = col[0]; mr.emissive[1] = col[1]; mr.emissive[2] = col[2];
        }
        mr.emissiveIntensity = intensity;
    }

    _findPlayer() {
        var tagged = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        if (tagged && tagged.length) return tagged[0];
        return this.scene.findEntityByName && this.scene.findEntityByName("Player");
    }

    _randBetween(a, b) {
        return a + Math.random() * (b - a);
    }

    // ─── HUD ─────────────────────────────────────────────────────────
    _pushHud() {
        var pp = { x: 0, y: 1, z: 0 };
        var p = this._findPlayer();
        if (p && p.transform) pp = p.transform.position;
        var currentLane = this._laneByTileZ(Math.round(pp.z / this._tileSize));
        this.scene.events.ui.emit("hud_update", {
            _hop: {
                score: this._score,
                highScore: this._highScore,
                coins: this._coins,
                coinTotal: this._coinTotal,
                attempts: this._attempts,
                lane: currentLane ? currentLane.kind : "grass",
                dead: this._dead,
                intro: this._introTimer > 0,
                staleTimer: Math.max(0, this._staleLaneSeconds - (this._matchElapsed - this._playerLastMoveAt)),
                staleLimit: this._staleLaneSeconds,
            },
        });
    }
}
