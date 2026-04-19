// Deadly games — three-round elimination: Red Light Green Light, Glass Bridge, Floor Collapse
class DeadlyGamesSystem extends GameScript {
    _totalRounds = 3;
    _roundNames = ["Red Light Green Light", "Glass Bridge", "Floor Collapse"];

    // Phase
    _phase = "idle";
    _phaseTimer = 0;
    _round = 0;
    _gameActive = false;
    _countdownVal = 3;

    // Contestants: index 0 = human, 1-15 = AI
    _contestants = [];
    _humanPlayer = null;
    _aiTypes = ["contestant_a", "contestant_b", "contestant_c", "contestant_d", "contestant_e"];
    _aiNames = ["Ana", "Ben", "Cara", "Dan", "Eve", "Finn", "Gia", "Hiro", "Ivy", "Jake", "Kai", "Luna", "Max", "Nia", "Omar"];

    // Spawned arena items
    _spawned = [];

    // RLGL state
    _lightState = "green";
    _lightTimer = 0;
    _finishZ = -42;
    _redStartPositions = [];
    _redGraceTimer = 0;

    // Glass Bridge state
    _bridgePairs = [];
    _currentPanel = 0;
    _choiceTimer = 0;
    _panelZ = [];

    // Floor Collapse state
    _tiles = [];
    _collapseTimer = 0;
    _collapseWave = 0;

    onStart() {
        var self = this;
        this.scene._deadlyPlayerActive = false;
        this.scene._deadlyRound = 0;
        this.scene._deadlyBridgeZ = 20;

        this.scene.events.game.on("game_ready", function() { self._fullReset(); });
        this.scene.events.game.on("restart_game", function() { self._fullReset(); });

        this._humanPlayer = this.scene.findEntityByName("Contestant");
        this._fullReset();
    }

    _fullReset() {
        this._cleanup();
        // Destroy old AI
        for (var i = 1; i < this._contestants.length; i++) {
            if (this._contestants[i] && this._contestants[i].entity) {
                this._contestants[i].entity.active = false;
            }
        }
        this._contestants = [];
        this._round = 0;
        this._phase = "idle";
        this._phaseTimer = 0;
        this._gameActive = true;
        this.scene._deadlyPlayerActive = false;
        this.scene._deadlyRound = 0;

        // Register human player
        if (!this._humanPlayer) this._humanPlayer = this.scene.findEntityByName("Contestant");
        this._contestants.push({ entity: this._humanPlayer, name: "You", alive: true, isHuman: true });

        // Spawn 15 AI contestants
        for (var i = 0; i < 15; i++) {
            var type = this._aiTypes[i % 5];
            var ent = this.scene.spawnEntity(type);
            if (ent) {
                if (ent.playAnimation) ent.playAnimation("Idle", { loop: true });
                this._contestants.push({ entity: ent, name: this._aiNames[i], alive: true, isHuman: false });
            }
        }
        this._updateHud();
    }

    /* ==============================================================
     *  MAIN LOOP
     * ============================================================== */
    onUpdate(dt) {
        if (!this._gameActive) return;

        this._phaseTimer -= dt;

        switch (this._phase) {
            case "idle":
                this._startRoundIntro();
                break;
            case "round_intro":
                if (this._phaseTimer <= 0) this._startCountdown();
                this._updateHud();
                break;
            case "countdown":
                var nv = Math.ceil(this._phaseTimer);
                if (nv !== this._countdownVal && nv > 0) {
                    this._countdownVal = nv;
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/select_006.ogg", 0.4);
                }
                if (this._phaseTimer <= 0) this._startRound();
                this._updateHud();
                break;
            case "round_active":
                this._updateRound(dt);
                this._checkFallen();
                this._updateHud();
                break;
            case "round_results":
                if (this._phaseTimer <= 0) {
                    if (this._round >= this._totalRounds || !this._contestants[0].alive) {
                        this._endGame();
                    } else {
                        this._startRoundIntro();
                    }
                }
                this._updateHud();
                break;
        }
    }

    /* ==============================================================
     *  PHASES
     * ============================================================== */
    _startRoundIntro() {
        this._round++;
        this.scene._deadlyRound = this._round;
        this._cleanup();
        this._spawnArena();
        this._positionPlayers();
        this._phase = "round_intro";
        this._phaseTimer = 3.5;
        this.scene._deadlyPlayerActive = false;
        if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/female/round.ogg", 0.5);
    }

    _startCountdown() {
        this._phase = "countdown";
        this._phaseTimer = 3;
        this._countdownVal = 3;
    }

    _startRound() {
        this._phase = "round_active";
        this.scene._deadlyPlayerActive = true;

        if (this._round === 1) {
            this._phaseTimer = 60;
            this._lightState = "green";
            this._lightTimer = 4;
        } else if (this._round === 2) {
            this._phaseTimer = 90;
            this._currentPanel = 0;
            this._choiceTimer = 5;
            this._positionPlayersForBridge();
        } else if (this._round === 3) {
            this._phaseTimer = 45;
            this._collapseTimer = 4;
            this._collapseWave = 0;
        }

        if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/female/go.ogg", 0.6);
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_002.ogg", 0.45);
    }

    _endRound() {
        this.scene._deadlyPlayerActive = false;
        this._phase = "round_results";
        this._phaseTimer = 4;

        // Eliminate anyone who didn't finish RLGL
        if (this._round === 1) {
            for (var i = 0; i < this._contestants.length; i++) {
                if (!this._contestants[i].alive) continue;
                var pp = this._contestants[i].entity.transform.position;
                if (pp.z > this._finishZ) {
                    this._eliminate(i);
                }
            }
        }

        var alive = this._countAlive();
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_004.ogg", 0.5);
        if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/female/objective_achieved.ogg", 0.4);
    }

    _endGame() {
        this._gameActive = false;
        this.scene._deadlyPlayerActive = false;
        var alive = this._countAlive();
        var humanAlive = this._contestants[0].alive;

        var stats = {
            "Survived": humanAlive ? "Yes" : "No",
            "Final Round": "" + Math.min(this._round, this._totalRounds),
            "Contestants Remaining": "" + alive + " / 16"
        };

        this.scene.events.ui.emit("hud_update", {
            _gameOver: {
                title: humanAlive ? "YOU SURVIVED!" : "ELIMINATED",
                score: humanAlive ? this._round * 100 : 0,
                stats: stats
            }
        });

        if (humanAlive) {
            if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/female/congratulations.ogg", 0.6);
            this.scene.events.game.emit("game_won", {});
        } else {
            if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/female/game_over.ogg", 0.6);
            this.scene.events.game.emit("game_over", {});
        }
    }

    /* ==============================================================
     *  ROUND DISPATCH
     * ============================================================== */
    _updateRound(dt) {
        if (this._round === 1) this._updateRLGL(dt);
        else if (this._round === 2) this._updateGlassBridge(dt);
        else if (this._round === 3) this._updateFloorCollapse(dt);

        if (this._phaseTimer <= 0) this._endRound();
    }

    /* ==============================================================
     *  ROUND 1: RED LIGHT GREEN LIGHT
     * ============================================================== */
    _updateRLGL(dt) {
        this._lightTimer -= dt;

        if (this._lightTimer <= 0) {
            if (this._lightState === "green") {
                // Switch to RED — 300ms grace before velocity detection
                this._lightState = "red";
                this._lightTimer = 2 + Math.random() * 2;
                this._redGraceTimer = 0.3;
                // Snapshot AI positions for delta detection
                this._redStartPositions = [];
                for (var rsi = 0; rsi < this._contestants.length; rsi++) {
                    if (!this._contestants[rsi].alive) { this._redStartPositions.push(null); continue; }
                    var rp = this._contestants[rsi].entity.transform.position;
                    this._redStartPositions.push({ x: rp.x, z: rp.z });
                }
                // Rotate sentinel toward players
                this._rotateSentinel(180);
                if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/error_006.ogg", 0.5);
            } else {
                // Switch to GREEN
                this._lightState = "green";
                this._lightTimer = 3 + Math.random() * 3;
                this.scene._deadlyPlayerActive = true;
                // Rotate sentinel away
                this._rotateSentinel(0);
                if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_001.ogg", 0.4);
            }
        }

        // During RED — 300ms grace, then anyone with velocity dies (but movement stays enabled)
        if (this._lightState === "red") {
            if (this._redGraceTimer > 0) {
                this._redGraceTimer -= dt;
            } else {
                // Past grace — any player with velocity is eliminated
                for (var i = 0; i < this._contestants.length; i++) {
                    if (!this._contestants[i].alive) continue;
                    var c = this._contestants[i];

                    if (c.isHuman) {
                        // Check physics velocity
                        var rb = c.entity.getComponent ? c.entity.getComponent("RigidbodyComponent") : null;
                        if (rb && rb.getLinearVelocity) {
                            var vel = rb.getLinearVelocity();
                            var speed = Math.sqrt((vel.x || 0) * (vel.x || 0) + (vel.z || 0) * (vel.z || 0));
                            if (speed > 0.5) {
                                this._eliminate(i);
                            }
                        }
                    } else {
                        // AI: check position delta from last frame
                        var sp = this._redStartPositions[i];
                        if (!sp) continue;
                        var cp = c.entity.transform.position;
                        var delta = Math.sqrt((cp.x - sp.x) * (cp.x - sp.x) + (cp.z - sp.z) * (cp.z - sp.z));
                        if (delta > 0.35) {
                            this._eliminate(i);
                        }
                    }
                }
            }
        }

        // AI movement during GREEN
        if (this._lightState === "green") {
            for (var i = 1; i < this._contestants.length; i++) {
                if (!this._contestants[i].alive) continue;
                var c = this._contestants[i];
                var pp = c.entity.transform.position;
                if (pp.z <= this._finishZ) continue; // Already finished
                var speed = 4 + Math.random() * 3;
                this.scene.setPosition(c.entity.id, pp.x + (Math.random() - 0.5) * 0.3, pp.y, pp.z - speed * dt);
                c.entity.transform.setRotationEuler(0, 180, 0);
                if (c.entity.playAnimation) c.entity.playAnimation("Run", { loop: true });
            }
        } else {
            // During RED, some AI fail to stop (10% chance per second)
            for (var i = 1; i < this._contestants.length; i++) {
                if (!this._contestants[i].alive) continue;
                if (Math.random() < 0.003) {
                    // AI "flinches" — moves slightly
                    var c = this._contestants[i];
                    var pp = c.entity.transform.position;
                    this.scene.setPosition(c.entity.id, pp.x + (Math.random() - 0.5) * 0.5, pp.y, pp.z - 0.3);
                }
                if (this._contestants[i].entity.playAnimation) {
                    this._contestants[i].entity.playAnimation("Idle", { loop: true });
                }
            }
        }

        // Check if all alive players finished
        var allFinished = true;
        for (var i = 0; i < this._contestants.length; i++) {
            if (!this._contestants[i].alive) continue;
            if (this._contestants[i].entity.transform.position.z > this._finishZ) {
                allFinished = false;
                break;
            }
        }
        if (allFinished) this._phaseTimer = 0;
    }

    _rotateSentinel(yaw) {
        for (var i = 0; i < this._spawned.length; i++) {
            if (this._spawned[i].type === "sentinel" && this._spawned[i].entity) {
                this._spawned[i].entity.transform.setRotationEuler(0, yaw, 0);
            }
        }
    }

    /* ==============================================================
     *  ROUND 2: GLASS BRIDGE
     * ============================================================== */
    _updateGlassBridge(dt) {
        this.scene._deadlyPlayerActive = true;
        this._choiceTimer -= dt;

        if (this._currentPanel >= this._bridgePairs.length) { this._phaseTimer = 0; return; }
        var pz = this._panelZ[this._currentPanel];
        this.scene._deadlyBridgeZ = pz;

        // Clamp players between current pair and next
        this._clampBridgePlayers();

        if (this._choiceTimer <= 0) {
            // Reveal: break the weak panel
            var pair = this._bridgePairs[this._currentPanel];
            var weakSide = pair.safe === "left" ? "right" : "left";

            // Break weak panel
            for (var s = this._spawned.length - 1; s >= 0; s--) {
                var sp = this._spawned[s];
                if (sp.type === "panel" && sp.pairIdx === this._currentPanel && sp.side === weakSide) {
                    if (sp.entity) sp.entity.active = false;
                    break;
                }
            }

            // Check who's on the weak side
            var weakX = weakSide === "left" ? -2 : 2;
            for (var i = 0; i < this._contestants.length; i++) {
                if (!this._contestants[i].alive) continue;
                var pp = this._contestants[i].entity.transform.position;
                var onPanel = Math.abs(pp.z - pz) < 3;
                if (!onPanel) continue;
                var playerSide = pp.x < 0 ? "left" : "right";
                if (playerSide === weakSide) {
                    // Push them down
                    if (this._contestants[i].isHuman) {
                        this.scene.setVelocity(this._contestants[i].entity.id, { x: 0, y: -8, z: 0 });
                    } else {
                        this.scene.setPosition(this._contestants[i].entity.id, pp.x, -5, pp.z);
                    }
                    this._eliminate(i);
                }
            }

            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/glass_004.ogg", 0.5);

            this._currentPanel++;
            if (this._currentPanel >= this._bridgePairs.length) {
                this._phaseTimer = 0; // Round over
            } else {
                this._choiceTimer = 4.5;
                // Move survivors forward to next panel pair
                this._advanceBridgePlayers();
            }
        }

        // AI: move to random side during choice phase
        for (var i = 1; i < this._contestants.length; i++) {
            if (!this._contestants[i].alive) continue;
            var c = this._contestants[i];
            var pp = c.entity.transform.position;
            // AI picks a side (stored or new)
            if (!c._bridgeChoice) {
                c._bridgeChoice = Math.random() < 0.5 ? -2 : 2;
            }
            var tx = c._bridgeChoice;
            var dx = tx - pp.x;
            if (Math.abs(dx) > 0.3) {
                this.scene.setPosition(c.entity.id, pp.x + dx * 0.05, pp.y, pp.z);
            }
        }
    }

    _positionPlayersForBridge() {
        var idx = 0;
        var pz = this._panelZ[0];
        for (var i = 0; i < this._contestants.length; i++) {
            if (!this._contestants[i].alive) continue;
            var row = Math.floor(idx / 4);
            var col = idx % 4;
            var x = (col - 1.5) * 1.2;
            this.scene.setPosition(this._contestants[i].entity.id, x, 3.5, pz + 3 + row * 1.5);
            if (this._contestants[i].isHuman) {
                this.scene.setVelocity(this._contestants[i].entity.id, { x: 0, y: 0, z: 0 });
            }
            this._contestants[i]._bridgeChoice = null;
            idx++;
        }
    }

    _advanceBridgePlayers() {
        var pz = this._panelZ[this._currentPanel];
        for (var i = 0; i < this._contestants.length; i++) {
            if (!this._contestants[i].alive) continue;
            var pp = this._contestants[i].entity.transform.position;
            this.scene.setPosition(this._contestants[i].entity.id, 0, pp.y, pz + 2);
            if (this._contestants[i].isHuman) {
                this.scene.setVelocity(this._contestants[i].entity.id, { x: 0, y: 0, z: 0 });
            }
            this._contestants[i]._bridgeChoice = null;
        }
    }

    _clampBridgePlayers() {
        for (var i = 0; i < this._contestants.length; i++) {
            if (!this._contestants[i].alive || !this._contestants[i].isHuman) continue;
            var pp = this._contestants[i].entity.transform.position;
            var cx = Math.max(-4, Math.min(4, pp.x));
            if (cx !== pp.x) {
                this.scene.setPosition(this._contestants[i].entity.id, cx, pp.y, pp.z);
            }
        }
    }

    /* ==============================================================
     *  ROUND 3: FLOOR COLLAPSE
     * ============================================================== */
    _updateFloorCollapse(dt) {
        this._collapseTimer -= dt;

        if (this._collapseTimer <= 0) {
            this._collapseWave++;
            // Mark 3-5 safe tiles for collapse warning
            var safeTiles = [];
            for (var i = 0; i < this._tiles.length; i++) {
                if (this._tiles[i].state === "safe") safeTiles.push(i);
            }
            // Always keep at least 5 tiles safe
            var numCollapse = Math.min(safeTiles.length - 5, 3 + Math.floor(Math.random() * 3));
            if (numCollapse < 1) numCollapse = 1;
            if (safeTiles.length <= 5) numCollapse = 0;

            // Shuffle and pick
            for (var s = safeTiles.length - 1; s > 0; s--) {
                var j = Math.floor(Math.random() * (s + 1));
                var tmp = safeTiles[s]; safeTiles[s] = safeTiles[j]; safeTiles[j] = tmp;
            }
            for (var c = 0; c < numCollapse; c++) {
                this._tiles[safeTiles[c]].state = "warning";
                this._tiles[safeTiles[c]].warnTimer = 2.0;
            }

            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/error_003.ogg", 0.4);
            this._collapseTimer = 3.5 + Math.random() * 2;
        }

        // Update warning timers
        for (var i = 0; i < this._tiles.length; i++) {
            var tile = this._tiles[i];
            if (tile.state === "warning") {
                tile.warnTimer -= dt;
                // Flash red
                if (tile.entity) {
                    // Keep visible, system tracks state
                }
                if (tile.warnTimer <= 0) {
                    // COLLAPSE!
                    tile.state = "collapsed";
                    if (tile.entity) tile.entity.active = false;
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/glass_002.ogg", 0.35);
                    // Check who was standing on this tile
                    this._checkTileElimination(tile);
                }
            }
        }

        // AI: move toward nearest safe tile
        for (var i = 1; i < this._contestants.length; i++) {
            if (!this._contestants[i].alive) continue;
            var c = this._contestants[i];
            var pp = c.entity.transform.position;
            // Find nearest safe tile not in warning
            var bestDist = 999;
            var bestTile = null;
            for (var t = 0; t < this._tiles.length; t++) {
                if (this._tiles[t].state !== "safe") continue;
                var dx = this._tiles[t].x - pp.x;
                var dz = this._tiles[t].z - pp.z;
                var d = Math.sqrt(dx * dx + dz * dz);
                if (d < bestDist) {
                    bestDist = d;
                    bestTile = this._tiles[t];
                }
            }
            if (bestTile && bestDist > 0.8) {
                var speed = 5 + Math.random() * 2;
                var dx = bestTile.x - pp.x;
                var dz = bestTile.z - pp.z;
                var dist = Math.sqrt(dx * dx + dz * dz);
                this.scene.setPosition(c.entity.id, pp.x + (dx / dist) * speed * dt, pp.y, pp.z + (dz / dist) * speed * dt);
                c.entity.transform.setRotationEuler(0, Math.atan2(dx, -dz) * 180 / Math.PI, 0);
                if (c.entity.playAnimation) c.entity.playAnimation("Run", { loop: true });
            } else {
                if (c.entity.playAnimation) c.entity.playAnimation("Idle", { loop: true });
            }
        }
    }

    _checkTileElimination(tile) {
        var half = 1.75;
        for (var i = 0; i < this._contestants.length; i++) {
            if (!this._contestants[i].alive) continue;
            var pp = this._contestants[i].entity.transform.position;
            if (Math.abs(pp.x - tile.x) < half && Math.abs(pp.z - tile.z) < half) {
                if (this._contestants[i].isHuman) {
                    this.scene.setVelocity(this._contestants[i].entity.id, { x: 0, y: -5, z: 0 });
                } else {
                    this.scene.setPosition(this._contestants[i].entity.id, pp.x, -5, pp.z);
                }
                this._eliminate(i);
            }
        }
    }

    /* ==============================================================
     *  ARENA SPAWNING
     * ============================================================== */
    _spawnArena() {
        // Hide/show pre-placed RLGL walls based on round
        this._toggleWorldWalls(this._round === 1);

        if (this._round === 1) this._spawnRLGL();
        else if (this._round === 2) this._spawnBridge();
        else if (this._round === 3) this._spawnFloor();
    }

    _toggleWorldWalls(visible) {
        // Toggle pre-placed corridor walls, finish marker, sentinel
        var walls = this.scene.findEntitiesByTag("wall") || [];
        for (var w = 0; w < walls.length; w++) walls[w].active = visible;
        var finishes = this.scene.findEntitiesByTag("finish") || [];
        for (var f = 0; f < finishes.length; f++) finishes[f].active = visible;
        var sentinels = this.scene.findEntitiesByTag("sentinel") || [];
        for (var s = 0; s < sentinels.length; s++) sentinels[s].active = visible;
    }

    _spawnRLGL() {
        // Round 1 uses pre-placed world geometry — nothing extra to spawn
        // Just reset the sentinel rotation
        var sentinels = this.scene.findEntitiesByTag("sentinel") || [];
        for (var s = 0; s < sentinels.length; s++) {
            sentinels[s].transform.setRotationEuler(0, 0, 0);
        }
    }

    _spawnBridge() {
        // Spawn ground for bridge area
        var ground = this.scene.spawnEntity("arena_ground");
        if (ground) { this.scene.setPosition(ground.id, 0, -0.1, 18); this._spawned.push({ entity: ground, type: "ground" }); }

        // Elevated platform at start/end
        var startPlat = this.scene.spawnEntity("bridge_platform");
        if (startPlat) { this.scene.setPosition(startPlat.id, 0, 2.5, 38); this._spawned.push({ entity: startPlat, type: "platform" }); }
        var endPlat = this.scene.spawnEntity("bridge_platform");
        if (endPlat) { this.scene.setPosition(endPlat.id, 0, 2.5, -2); this._spawned.push({ entity: endPlat, type: "platform" }); }

        // 8 panel pairs
        this._bridgePairs = [];
        this._panelZ = [];
        for (var p = 0; p < 8; p++) {
            var pz = 32 - p * 4.5;
            this._panelZ.push(pz);
            var safe = Math.random() < 0.5 ? "left" : "right";
            this._bridgePairs.push({ safe: safe });

            var pl = this.scene.spawnEntity("glass_panel");
            if (pl) {
                this.scene.setPosition(pl.id, -2, 3, pz);
                this._spawned.push({ entity: pl, type: "panel", pairIdx: p, side: "left" });
            }
            var pr = this.scene.spawnEntity("glass_panel");
            if (pr) {
                this.scene.setPosition(pr.id, 2, 3, pz);
                this._spawned.push({ entity: pr, type: "panel", pairIdx: p, side: "right" });
            }
        }
    }

    _spawnFloor() {
        // Spawn ground below tiles
        var ground = this.scene.spawnEntity("arena_ground");
        if (ground) { this.scene.setPosition(ground.id, 0, -3, 0); this._spawned.push({ entity: ground, type: "ground" }); }

        this._tiles = [];
        var spacing = 4;
        for (var gx = -2; gx <= 2; gx++) {
            for (var gz = -2; gz <= 2; gz++) {
                var x = gx * spacing;
                var z = gz * spacing;
                var tile = this.scene.spawnEntity("floor_tile");
                if (tile) {
                    this.scene.setPosition(tile.id, x, -0.15, z);
                    this._spawned.push({ entity: tile, type: "tile" });
                    this._tiles.push({ x: x, z: z, entity: tile, state: "safe", warnTimer: 0 });
                }
            }
        }
    }

    /* ==============================================================
     *  PLAYER POSITIONING
     * ============================================================== */
    _positionPlayers() {
        var idx = 0;
        for (var i = 0; i < this._contestants.length; i++) {
            if (!this._contestants[i].alive) continue;
            var c = this._contestants[i];
            var row = Math.floor(idx / 5);
            var col = idx % 5;

            if (this._round === 1) {
                var x = (col - 2) * 2.5;
                var z = 42 + row * 2;
                this.scene.setPosition(c.entity.id, x, 1, z);
            } else if (this._round === 3) {
                var x = (col - 2) * 3;
                var z = (row - 1) * 3;
                this.scene.setPosition(c.entity.id, x, 1, z);
            }

            if (c.isHuman) {
                this.scene.setVelocity(c.entity.id, { x: 0, y: 0, z: 0 });
            }
            if (c.entity.playAnimation) c.entity.playAnimation("Idle", { loop: true });
            idx++;
        }
    }

    /* ==============================================================
     *  UTILITIES
     * ============================================================== */
    _eliminate(idx) {
        if (!this._contestants[idx].alive) return;
        this._contestants[idx].alive = false;
        if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaserDown1.ogg", 0.4);
        // Move off screen
        if (this._contestants[idx].entity) {
            this.scene.setPosition(this._contestants[idx].entity.id, 100, -10, 100);
            if (this._contestants[idx].isHuman) {
                this.scene.setVelocity(this._contestants[idx].entity.id, { x: 0, y: 0, z: 0 });
                this.scene._deadlyPlayerActive = false;
            }
        }
    }

    _checkFallen() {
        for (var i = 0; i < this._contestants.length; i++) {
            if (!this._contestants[i].alive) continue;
            var pp = this._contestants[i].entity.transform.position;
            if (pp.y < -3) {
                this._eliminate(i);
            }
        }

        // Check if human eliminated → can end early
        if (!this._contestants[0].alive && this._phase === "round_active") {
            this._phaseTimer = Math.min(this._phaseTimer, 2);
        }
    }

    _countAlive() {
        var count = 0;
        for (var i = 0; i < this._contestants.length; i++) {
            if (this._contestants[i].alive) count++;
        }
        return count;
    }

    _cleanup() {
        for (var i = 0; i < this._spawned.length; i++) {
            if (this._spawned[i].entity) this._spawned[i].entity.active = false;
        }
        this._spawned = [];
        this._tiles = [];
    }

    _updateHud() {
        var announce = "";
        var subtext = "";
        var timer = -1;
        var lightState = "";

        if (this._phase === "round_intro") {
            announce = "ROUND " + this._round;
            subtext = this._roundNames[this._round - 1];
        } else if (this._phase === "countdown") {
            var cv = Math.ceil(this._phaseTimer);
            announce = cv > 0 ? "" + cv : "GO!";
        } else if (this._phase === "round_active") {
            timer = Math.ceil(this._phaseTimer);
            if (this._round === 1) lightState = this._lightState;
            if (this._round === 2) subtext = "Panel " + (this._currentPanel + 1) + " / " + this._bridgePairs.length;
        } else if (this._phase === "round_results") {
            announce = "ROUND OVER";
            subtext = this._countAlive() + " contestants remain";
        }

        // Count warning tiles
        var warningCount = 0;
        for (var t = 0; t < this._tiles.length; t++) {
            if (this._tiles[t].state === "warning") warningCount++;
        }

        this.scene.events.ui.emit("hud_update", {
            round: this._round,
            totalRounds: this._totalRounds,
            roundName: this._round > 0 ? this._roundNames[this._round - 1] : "",
            battlePhase: this._phase,
            announce: announce,
            subtext: subtext,
            timer: timer,
            alive: this._countAlive(),
            total: this._contestants.length,
            humanAlive: this._contestants.length > 0 ? this._contestants[0].alive : false,
            lightState: lightState,
            currentPanel: this._currentPanel + 1,
            totalPanels: this._bridgePairs ? this._bridgePairs.length : 0,
            choiceTimer: Math.ceil(this._choiceTimer),
            warningTiles: warningCount
        });
    }
}
