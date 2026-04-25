// also: round-based competition, local multiplayer, AI opponents, fairness balancing, turn rotation
// Party engine — minigame rotation, AI players, scoring, round management
class PartyEngineSystem extends GameScript {
    _totalRounds = 5;
    _arenaHalf = 10;

    // Phase state
    _phase = "idle";
    _phaseTimer = 0;
    _round = 0;
    _currentMG = -1;
    _mgNames = ["Crown Chase", "Bumper Bash", "Coin Frenzy"];
    _mgDurations = [30, 40, 30];
    _gameActive = false;
    _countdownVal = 3;

    // Scores
    _scores = [0, 0, 0, 0];
    _roundData = [0, 0, 0, 0];

    // Players: index 0 = human, 1-3 = AI
    _players = [];
    _playerNames = ["Penguin", "Panda", "Mushroom", "Chicken"];
    _playerEntityNames = ["P_Penguin", "P_Panda", "P_Mushroom", "P_Chicken"];
    _startPositions = [[-5, 1, -5], [5, 1, -5], [-5, 1, 5], [5, 1, 5]];
    _aiSpeeds = [0, 5.5, 6.0, 6.5];
    _alive = [true, true, true, true];

    // Spawned items
    _items = [];
    _hazardAngles = [0, 0];
    _hazardSpeeds = [50, -65];
    _hazardLengths = [18, 14];
    _crownTimer = 0;
    _coinTimers = [];
    _lastMGs = [];

    // Idempotent animation set: only call playAnimation when the
    // requested clip differs from the AnimatorComponent's currentClip.
    // play() resets currentTime=0 on every call, so calling it every
    // frame from _updateAI's per-frame chase loop froze the AI on the
    // first frame of "Run". Same fix shape as deadly_games (53c19f6).
    _setAnim(entity, name) {
        if (!entity || !entity.playAnimation) return;
        var animator = entity.getComponent && entity.getComponent("AnimatorComponent");
        if (animator && animator.currentClip === name && animator.isPlaying) return;
        entity.playAnimation(name, { loop: true });
    }

    onStart() {
        var self = this;
        this.scene._partyMinigameActive = false;

        this.scene.events.game.on("game_ready", function() {
            self._fullReset();
        });
        this.scene.events.game.on("restart_game", function() {
            self._fullReset();
        });

        this._findPlayers();
        this._fullReset();
    }

    _findPlayers() {
        this._players = [];
        for (var i = 0; i < 4; i++) {
            var ent = this.scene.findEntityByName(this._playerEntityNames[i]);
            this._players.push(ent);
        }
    }

    _fullReset() {
        this._cleanup();
        this._scores = [0, 0, 0, 0];
        this._roundData = [0, 0, 0, 0];
        this._round = 0;
        this._currentMG = -1;
        this._phase = "idle";
        this._phaseTimer = 0;
        this._gameActive = true;
        this._lastMGs = [];
        this.scene._partyMinigameActive = false;
        this._resetPlayers();
        this._updateHud();
    }

    /* =================================================================
     *  MAIN LOOP
     * ================================================================= */
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
                var newVal = Math.ceil(this._phaseTimer);
                if (newVal !== this._countdownVal && newVal > 0) {
                    this._countdownVal = newVal;
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/select_006.ogg", 0.4);
                }
                if (this._phaseTimer <= 0) this._startMinigame();
                this._updateHud();
                break;

            case "minigame":
                this._updateMinigame(dt);
                if (this._phaseTimer <= 0) this._endMinigame();
                this._updateHud();
                break;

            case "round_results":
                if (this._phaseTimer <= 0) {
                    if (this._round >= this._totalRounds) {
                        this._endGame();
                    } else {
                        this._startRoundIntro();
                    }
                }
                this._updateHud();
                break;
        }
    }

    /* =================================================================
     *  PHASE MANAGEMENT
     * ================================================================= */
    _startRoundIntro() {
        this._round++;
        this._pickMinigame();
        this._resetPlayers();
        this._cleanup();
        this._roundData = [0, 0, 0, 0];
        this._alive = [true, true, true, true];
        this._phase = "round_intro";
        this._phaseTimer = 3;
        this.scene._partyMinigameActive = false;

        if (this.audio) this.audio.playSound("/assets/kenney/audio/casino_audio/dice-throw-1.ogg", 0.5);
        if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/round.ogg", 0.5);
    }

    _startCountdown() {
        this._phase = "countdown";
        this._phaseTimer = 3;
        this._countdownVal = 3;
    }

    _startMinigame() {
        this._phase = "minigame";
        this._phaseTimer = this._mgDurations[this._currentMG];
        this.scene._partyMinigameActive = true;

        // Start animations for all players
        for (var i = 0; i < 4; i++) {
            if (this._players[i] && this._players[i].playAnimation) {
                this._players[i].playAnimation("Idle", { loop: true });
            }
        }

        // Setup minigame-specific entities
        if (this._currentMG === 0) this._setupCrownChase();
        if (this._currentMG === 1) this._setupBumperBash();
        if (this._currentMG === 2) this._setupCoinFrenzy();

        if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/go.ogg", 0.6);
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_002.ogg", 0.5);
    }

    _endMinigame() {
        this.scene._partyMinigameActive = false;
        this._phase = "round_results";
        this._phaseTimer = 4;

        // Award points based on minigame type
        this._awardPoints();
        this._cleanup();

        // Stop all player animations
        for (var i = 0; i < 4; i++) {
            if (this._players[i] && this._players[i].playAnimation) {
                this._players[i].playAnimation("Idle", { loop: true });
            }
        }

        if (this.audio) this.audio.playSound("/assets/kenney/audio/casino_audio/chips-stack-1.ogg", 0.5);
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_004.ogg", 0.5);
    }

    _endGame() {
        this._gameActive = false;
        this.scene._partyMinigameActive = false;

        // Find winner
        var maxScore = -1;
        var winner = 0;
        for (var i = 0; i < 4; i++) {
            if (this._scores[i] > maxScore) {
                maxScore = this._scores[i];
                winner = i;
            }
        }

        var stats = {};
        for (var i = 0; i < 4; i++) {
            stats[this._playerNames[i]] = "" + this._scores[i] + " pts";
        }

        this.scene.events.ui.emit("hud_update", {
            _gameOver: {
                title: this._playerNames[winner] + " WINS!",
                score: maxScore,
                stats: stats
            }
        });

        if (winner === 0) {
            if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/congratulations.ogg", 0.6);
            this.scene.events.game.emit("game_won", {});
        } else {
            if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/game_over.ogg", 0.6);
            this.scene.events.game.emit("game_over", {});
        }
    }

    /* =================================================================
     *  MINIGAME SELECTION
     * ================================================================= */
    _pickMinigame() {
        // Avoid repeating the same minigame twice in a row
        var options = [0, 1, 2];
        if (this._lastMGs.length > 0) {
            var last = this._lastMGs[this._lastMGs.length - 1];
            options = [];
            for (var i = 0; i < 3; i++) {
                if (i !== last) options.push(i);
            }
        }
        this._currentMG = options[Math.floor(Math.random() * options.length)];
        this._lastMGs.push(this._currentMG);
    }

    /* =================================================================
     *  MINIGAME UPDATE DISPATCH
     * ================================================================= */
    _updateMinigame(dt) {
        // Bounds enforcement (except bumper bash where falling off is the game)
        if (this._currentMG !== 1) {
            this._clampPlayers();
        }

        switch (this._currentMG) {
            case 0: this._updateCrownChase(dt); break;
            case 1: this._updateBumperBash(dt); break;
            case 2: this._updateCoinFrenzy(dt); break;
        }

        this._updateAI(dt);
    }

    /* =================================================================
     *  MINIGAME 0: CROWN CHASE
     * ================================================================= */
    _setupCrownChase() {
        this._crownTimer = 0;
        this._spawnCrown();
    }

    _updateCrownChase(dt) {
        // Check if any player touches the crown
        for (var i = this._items.length - 1; i >= 0; i--) {
            var item = this._items[i];
            if (item.type !== "crown" || !item.entity || !item.entity.active) continue;

            var cp = item.entity.transform.position;
            for (var p = 0; p < 4; p++) {
                if (!this._players[p]) continue;
                var pp = this._players[p].transform.position;
                var dx = pp.x - cp.x;
                var dz = pp.z - cp.z;
                if (Math.sqrt(dx * dx + dz * dz) < 1.8) {
                    // Grabbed!
                    this._roundData[p]++;
                    item.entity.active = false;
                    this._items.splice(i, 1);
                    this._crownTimer = 2.5;
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/powerUp8.ogg", 0.5);
                    break;
                }
            }
        }

        // Spawn new crown after delay
        var hasCrown = false;
        for (var j = 0; j < this._items.length; j++) {
            if (this._items[j].type === "crown" && this._items[j].entity && this._items[j].entity.active) {
                hasCrown = true;
                // Bob the crown
                var cEnt = this._items[j].entity;
                var cPos = cEnt.transform.position;
                var bobY = 1.5 + Math.sin(Date.now() * 0.005) * 0.3;
                this.scene.setPosition(cEnt.id, cPos.x, bobY, cPos.z);
                cEnt.transform.setRotationEuler(0, (Date.now() * 0.1) % 360, 0);
                break;
            }
        }
        if (!hasCrown) {
            this._crownTimer -= dt;
            if (this._crownTimer <= 0) {
                this._spawnCrown();
            }
        }
    }

    _spawnCrown() {
        var x = (Math.random() - 0.5) * (this._arenaHalf * 2 - 4);
        var z = (Math.random() - 0.5) * (this._arenaHalf * 2 - 4);
        var crown = this.scene.spawnEntity("crown");
        if (crown) {
            this.scene.setPosition(crown.id, x, 1.5, z);
            this._items.push({ entity: crown, type: "crown" });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/maximize_008.ogg", 0.35);
        }
    }

    /* =================================================================
     *  MINIGAME 1: BUMPER BASH
     * ================================================================= */
    _setupBumperBash() {
        this._hazardAngles = [0, Math.PI * 0.7];
        // Spawn 2 spinning bars
        for (var b = 0; b < 2; b++) {
            var bar = this.scene.spawnEntity("hazard_bar");
            if (bar) {
                this.scene.setPosition(bar.id, 0, 0.5, 0);
                this._items.push({ entity: bar, type: "hazard", index: b });
            }
        }
    }

    _updateBumperBash(dt) {
        // Rotate hazard bars
        for (var i = 0; i < this._items.length; i++) {
            var item = this._items[i];
            if (item.type !== "hazard" || !item.entity || !item.entity.active) continue;
            var idx = item.index;
            this._hazardAngles[idx] += this._hazardSpeeds[idx] * dt * Math.PI / 180;
            var angle = this._hazardAngles[idx];
            item.entity.transform.setRotationEuler(0, angle * 180 / Math.PI, 0);
            // Lock position at center
            this.scene.setPosition(item.entity.id, 0, 0.5, 0);
        }

        // Check player vs hazard collision
        for (var p = 0; p < 4; p++) {
            if (!this._alive[p] || !this._players[p]) continue;
            var pp = this._players[p].transform.position;

            // Check fall
            if (pp.y < -3 || Math.abs(pp.x) > this._arenaHalf + 2 || Math.abs(pp.z) > this._arenaHalf + 2) {
                this._eliminatePlayer(p);
                continue;
            }

            // Check bar collision
            for (var b = 0; b < 2; b++) {
                var angle = this._hazardAngles[b];
                var dirX = Math.cos(angle);
                var dirZ = Math.sin(angle);
                var perpDist = Math.abs(pp.x * (-dirZ) + pp.z * dirX);
                var alongDist = Math.abs(pp.x * dirX + pp.z * dirZ);

                if (perpDist < 1.0 && alongDist < this._hazardLengths[b] / 2) {
                    // Hit! Push player outward
                    var pushX = pp.x;
                    var pushZ = pp.z;
                    var pushDist = Math.sqrt(pushX * pushX + pushZ * pushZ);
                    if (pushDist < 0.5) { pushX = 1; pushZ = 0; pushDist = 1; }
                    var force = 12;
                    var nx = (pushX / pushDist) * force;
                    var nz = (pushZ / pushDist) * force;

                    if (p === 0) {
                        // Human player — use velocity
                        this.scene.setVelocity(this._players[p].id, { x: nx, y: 5, z: nz });
                    } else {
                        // AI — nudge position
                        this.scene.setPosition(this._players[p].id, pp.x + nx * 0.3, pp.y + 1, pp.z + nz * 0.3);
                    }
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactPlate_heavy_004.ogg", 0.35);
                    break;
                }
            }
        }

        // Check if only 1 player alive
        var aliveCount = 0;
        for (var a = 0; a < 4; a++) {
            if (this._alive[a]) aliveCount++;
        }
        if (aliveCount <= 1) {
            this._phaseTimer = 0; // End minigame
        }
    }

    _eliminatePlayer(idx) {
        this._alive[idx] = false;
        // Count remaining alive for scoring
        var stillAlive = 0;
        for (var i = 0; i < 4; i++) {
            if (this._alive[i]) stillAlive++;
        }
        // Score based on elimination order: earlier elimination = fewer points
        this._roundData[idx] = 0;
        if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaserDown1.ogg", 0.4);
        // Move eliminated player away
        if (this._players[idx]) {
            this.scene.setPosition(this._players[idx].id, 0, -10, 0);
            if (idx === 0) {
                this.scene.setVelocity(this._players[idx].id, { x: 0, y: 0, z: 0 });
            }
        }
    }

    /* =================================================================
     *  MINIGAME 2: COIN FRENZY
     * ================================================================= */
    _setupCoinFrenzy() {
        this._coinTimers = [];
        // Spawn 12 coins scattered around
        for (var c = 0; c < 12; c++) {
            this._spawnCoin();
        }
    }

    _updateCoinFrenzy(dt) {
        // Check player vs coin pickup
        for (var i = this._items.length - 1; i >= 0; i--) {
            var item = this._items[i];
            if (item.type !== "coin" || !item.entity || !item.entity.active) continue;

            var cp = item.entity.transform.position;
            for (var p = 0; p < 4; p++) {
                if (!this._players[p]) continue;
                var pp = this._players[p].transform.position;
                var dx = pp.x - cp.x;
                var dz = pp.z - cp.z;
                if (Math.sqrt(dx * dx + dz * dz) < 1.6) {
                    this._roundData[p]++;
                    item.entity.active = false;
                    // Queue respawn
                    this._coinTimers.push(2.5);
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/pepSound1.ogg", 0.3);
                    break;
                }
            }

            // Bob coins
            if (item.entity && item.entity.active) {
                var cPos = item.entity.transform.position;
                item.entity.transform.setRotationEuler(0, (Date.now() * 0.15 + i * 60) % 360, 0);
            }
        }

        // Remove collected items
        for (var r = this._items.length - 1; r >= 0; r--) {
            if (this._items[r].entity && !this._items[r].entity.active) {
                this._items.splice(r, 1);
            }
        }

        // Respawn coins
        for (var t = this._coinTimers.length - 1; t >= 0; t--) {
            this._coinTimers[t] -= dt;
            if (this._coinTimers[t] <= 0) {
                this._coinTimers.splice(t, 1);
                this._spawnCoin();
            }
        }
    }

    _spawnCoin() {
        var x = (Math.random() - 0.5) * (this._arenaHalf * 2 - 3);
        var z = (Math.random() - 0.5) * (this._arenaHalf * 2 - 3);
        var coin = this.scene.spawnEntity("coin_party");
        if (coin) {
            this.scene.setPosition(coin.id, x, 1.0, z);
            this._items.push({ entity: coin, type: "coin" });
        }
    }

    /* =================================================================
     *  SCORING
     * ================================================================= */
    _awardPoints() {
        if (this._currentMG === 0) {
            // Crown Chase — most crowns gets bonus
            var best = -1;
            for (var i = 0; i < 4; i++) {
                this._scores[i] += this._roundData[i];
                if (this._roundData[i] > best) best = this._roundData[i];
            }
            // +2 bonus for winner
            for (var i = 0; i < 4; i++) {
                if (this._roundData[i] === best && best > 0) this._scores[i] += 2;
            }
        } else if (this._currentMG === 1) {
            // Bumper Bash — last alive gets most
            var positions = [];
            for (var i = 0; i < 4; i++) {
                positions.push({ idx: i, alive: this._alive[i] });
            }
            // Alive players share top points
            var aliveCount = 0;
            for (var i = 0; i < 4; i++) {
                if (this._alive[i]) aliveCount++;
            }
            var pointPool = [3, 2, 1, 0];
            var pIdx = 0;
            for (var i = 0; i < 4; i++) {
                if (this._alive[i]) {
                    this._scores[i] += aliveCount <= 1 ? 3 : 2;
                }
            }
        } else if (this._currentMG === 2) {
            // Coin Frenzy — rank by coins
            var ranked = [];
            for (var i = 0; i < 4; i++) {
                ranked.push({ idx: i, coins: this._roundData[i] });
            }
            ranked.sort(function(a, b) { return b.coins - a.coins; });
            var pts = [3, 2, 1, 0];
            for (var r = 0; r < 4; r++) {
                this._scores[ranked[r].idx] += pts[r];
                // Add coin count too
                this._scores[ranked[r].idx] += Math.floor(ranked[r].coins / 3);
            }
        }
    }

    /* =================================================================
     *  AI LOGIC
     * ================================================================= */
    _updateAI(dt) {
        for (var i = 1; i < 4; i++) {
            if (!this._players[i] || !this._alive[i]) continue;
            var pp = this._players[i].transform.position;
            var speed = this._aiSpeeds[i];
            var tx = 0, tz = 0;
            var hasTarget = false;

            if (this._currentMG === 0) {
                // Crown Chase: move toward crown
                for (var j = 0; j < this._items.length; j++) {
                    if (this._items[j].type === "crown" && this._items[j].entity && this._items[j].entity.active) {
                        var cp = this._items[j].entity.transform.position;
                        tx = cp.x;
                        tz = cp.z;
                        hasTarget = true;
                        break;
                    }
                }
            } else if (this._currentMG === 1) {
                // Bumper Bash: stay near center, dodge bars
                tx = (Math.random() - 0.5) * 4;
                tz = (Math.random() - 0.5) * 4;
                // Check if near a bar, move away
                for (var b = 0; b < 2; b++) {
                    var angle = this._hazardAngles[b];
                    var dirX = Math.cos(angle);
                    var dirZ = Math.sin(angle);
                    var perpDist = Math.abs(pp.x * (-dirZ) + pp.z * dirX);
                    var alongDist = Math.abs(pp.x * dirX + pp.z * dirZ);
                    if (perpDist < 2.5 && alongDist < this._hazardLengths[b] / 2) {
                        // Dodge! Move perpendicular to bar
                        tx = pp.x + (-dirZ) * 5 * (pp.x * (-dirZ) + pp.z * dirX > 0 ? 1 : -1);
                        tz = pp.z + dirX * 5 * (pp.x * (-dirZ) + pp.z * dirX > 0 ? 1 : -1);
                    }
                }
                hasTarget = true;
            } else if (this._currentMG === 2) {
                // Coin Frenzy: move toward nearest coin
                var nearDist = 999;
                for (var j = 0; j < this._items.length; j++) {
                    if (this._items[j].type !== "coin" || !this._items[j].entity || !this._items[j].entity.active) continue;
                    var cp = this._items[j].entity.transform.position;
                    var d = Math.sqrt((pp.x - cp.x) * (pp.x - cp.x) + (pp.z - cp.z) * (pp.z - cp.z));
                    if (d < nearDist) {
                        nearDist = d;
                        tx = cp.x;
                        tz = cp.z;
                        hasTarget = true;
                    }
                }
            }

            if (!hasTarget) continue;

            var dx = tx - pp.x + (Math.random() - 0.5) * 1.5;
            var dz = tz - pp.z + (Math.random() - 0.5) * 1.5;
            var dist = Math.sqrt(dx * dx + dz * dz);

            if (dist > 0.5) {
                var mx = (dx / dist) * speed * dt;
                var mz = (dz / dist) * speed * dt;
                this.scene.setPosition(this._players[i].id, pp.x + mx, pp.y, pp.z + mz);
                // Face direction
                this._players[i].transform.setRotationEuler(0, Math.atan2(dx, -dz) * 180 / Math.PI, 0);
                this._setAnim(this._players[i], "Run");
            }
        }
    }

    /* =================================================================
     *  UTILITIES
     * ================================================================= */
    _resetPlayers() {
        for (var i = 0; i < 4; i++) {
            if (!this._players[i]) {
                this._findPlayers();
                if (!this._players[i]) continue;
            }
            var sp = this._startPositions[i];
            this._players[i].active = true;
            this.scene.setPosition(this._players[i].id, sp[0], sp[1], sp[2]);
            if (i === 0) {
                this.scene.setVelocity(this._players[i].id, { x: 0, y: 0, z: 0 });
            }
            this._alive[i] = true;
            if (this._players[i].playAnimation) {
                this._players[i].playAnimation("Idle", { loop: true });
            }
        }
    }

    _clampPlayers() {
        var half = this._arenaHalf - 0.5;
        for (var i = 0; i < 4; i++) {
            if (!this._players[i] || !this._alive[i]) continue;
            var pp = this._players[i].transform.position;
            var clamped = false;
            var cx = pp.x, cz = pp.z;
            if (cx < -half) { cx = -half; clamped = true; }
            if (cx > half) { cx = half; clamped = true; }
            if (cz < -half) { cz = -half; clamped = true; }
            if (cz > half) { cz = half; clamped = true; }
            if (clamped) {
                this.scene.setPosition(this._players[i].id, cx, pp.y, cz);
            }
        }
    }

    _cleanup() {
        for (var i = 0; i < this._items.length; i++) {
            if (this._items[i].entity) this._items[i].entity.active = false;
        }
        this._items = [];
        this._coinTimers = [];
    }

    _updateHud() {
        var announce = "";
        var subtext = "";
        var timer = -1;

        if (this._phase === "round_intro") {
            announce = "ROUND " + this._round;
            subtext = this._mgNames[this._currentMG];
        } else if (this._phase === "countdown") {
            var cv = Math.ceil(this._phaseTimer);
            announce = cv > 0 ? "" + cv : "GO!";
        } else if (this._phase === "minigame") {
            timer = Math.ceil(this._phaseTimer);
        } else if (this._phase === "round_results") {
            announce = "ROUND OVER";
            // Find round winner
            var bestScore = -1;
            var bestIdx = 0;
            for (var i = 0; i < 4; i++) {
                if (this._roundData[i] > bestScore) {
                    bestScore = this._roundData[i];
                    bestIdx = i;
                }
            }
            if (this._currentMG === 1) {
                // Bumper bash: alive = winner
                for (var i = 0; i < 4; i++) {
                    if (this._alive[i]) { bestIdx = i; break; }
                }
            }
            subtext = this._playerNames[bestIdx] + " takes the round!";
        }

        this.scene.events.ui.emit("hud_update", {
            round: this._round,
            totalRounds: this._totalRounds,
            minigameName: this._currentMG >= 0 ? this._mgNames[this._currentMG] : "",
            battlePhase: this._phase,
            announce: announce,
            subtext: subtext,
            timer: timer,
            scores: this._scores,
            roundData: this._roundData,
            playerNames: this._playerNames,
            alive: this._alive,
            currentMG: this._currentMG
        });
    }
}
