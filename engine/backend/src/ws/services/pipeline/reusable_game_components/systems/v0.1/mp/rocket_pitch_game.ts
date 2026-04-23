// also: car-football, vehicle-sports, goal-scoring, boost-mechanics
// Rocket Pitch — peer-to-peer car-football match rules.
//
// Match flow (host-driven, echoed to peers via net_rocket_* events):
//   warmup         cars positioned, arena dressed; 1.2s settle.
//   kickoff        ball frozen at centre, cars frozen on their side;
//                  3-second countdown; "GO!" then → playing.
//   playing        free play until a goal is scored or timer runs out.
//   goal_celebration  ball explodes with a particle payload; 3-second
//                     pause; then → kickoff again (or ended).
//   ended          highest score wins; UI bridge flips to game_over.
//
// Authority:
//   Host owns kickoff sequencing, score, timer, goal detection, bot
//   boost refill, pad pickup arbitration, match end. Peers apply every
//   broadcast and drive their own car.
//
// Solo support: if the roster has exactly 1 peer, the pre-placed
// "BotCar" entity stays active and is driven by rocket_bot_ai. When a
// second peer joins, BotCar is deactivated — the remote peer's proxy
// takes the blue-team slot instead.
class RocketPitchGameSystem extends GameScript {
    // ── Config ─────────────────────────────────────────────────────
    _warmupSec = 1.2;
    _kickoffCountdownSec = 3;
    _matchDurationSec = 240;
    _goalCelebrationSec = 3.5;
    _boostMax = 100;
    _boostStart = 33;
    _boostRefillBig = 100;
    _boostRefillSmall = 12;
    _boostRegenPerSec = 0;       // pads only, no ambient regen by default
    _ballCenter = { x: 0, y: 3, z: 0 };
    _goalPosZ = 26;              // |z| of goal line (mirrored both sides)
    _goalHalfWidth = 6;          // x extent of goal opening
    _goalHeight = 6;
    _padPickupRadius = 1.6;
    _padRespawnSec = 5;

    _redSpawn = { x: 0, y: 1, z: -14 };
    _blueSpawn = { x: 0, y: 1, z: 14 };

    // ── Match state ────────────────────────────────────────────────
    _phase = "idle";
    _phaseTimer = 0;
    _matchTimeLeft = 240;
    _initialized = false;
    _matchEnded = false;
    _pendingMatchStartAt = 0;

    _teams = {};                 // peerId → "red" | "blue"
    _scores = { red: 0, blue: 0 };
    _boost = {};                 // peerId|bot → 0..100
    _pads = [];                  // runtime pad state
    _padRespawn = {};            // padId → seconds remaining
    _bots = [];                  // list of active bot keys (e.g. ["bot_blue"])
    _lastGoalBy = "";
    _lastGoalTeam = "";

    onStart() {
        var self = this;

        this.scene.events.game.on("match_started", function() {
            self._pendingMatchStartAt = 0.2;
        });

        // Host broadcasts mirror.
        this.scene.events.game.on("net_rocket_kickoff", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyKickoffStart(d);
        });
        this.scene.events.game.on("net_rocket_go", function() {
            self._applyKickoffGo();
        });
        this.scene.events.game.on("net_rocket_goal", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyGoalScored(d);
        });
        this.scene.events.game.on("net_rocket_score_update", function(evt) {
            var d = (evt && evt.data) || {};
            if (d.scores) self._scores = d.scores;
            if (d.timeLeft !== undefined) self._matchTimeLeft = d.timeLeft;
            if (d.boost) self._boost = d.boost;
            self._pushHud();
        });
        this.scene.events.game.on("net_rocket_boost_pickup", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyBoostPickup(d);
        });
        this.scene.events.game.on("net_rocket_match_ended", function(evt) {
            var d = (evt && evt.data) || {};
            self._endMatchOnPeers(d);
        });
        this.scene.events.game.on("net_rocket_team_assign", function(evt) {
            var d = (evt && evt.data) || {};
            if (d.teams) self._teams = d.teams;
            self._applyTeamColors();
            // Non-host peers call _resetCarPositions during _initMatch
            // before teams arrive, so the car ends up facing the wrong
            // way on the red-default yaw. Redo it once teams are known.
            self._resetCarPositions();
            self._pushHud();
        });

        // Local intents.
        this.scene.events.game.on("rocket_boost_tick", function(data) {
            var mp = self.scene._mp;
            if (!mp) return;
            var who = (data && data.peerId) || mp.localPeerId;
            var cur = self._boost[who] || 0;
            self._boost[who] = Math.max(0, cur - (data.amount || 0));
            // Throttle-broadcast boost drain so the opponent HUD sees it.
            self._boostBroadcastTimer = (self._boostBroadcastTimer || 0);
            self._boostBroadcastTimer += 1 / 30;
            if (self._boostBroadcastTimer >= 0.2) {
                self._boostBroadcastTimer = 0;
                mp.sendNetworkedEvent("rocket_score_update", {
                    scores: self._scores,
                    timeLeft: self._matchTimeLeft,
                    boost: self._boost,
                });
            }
        });
        this.scene.events.game.on("rocket_ball_hit_local", function() {
            // cosmetic — nothing to do on the system side yet
        });

        // MP lifecycle.
        this.scene.events.game.on("mp_host_changed", function() { self._pushHud(); });
        this.scene.events.game.on("mp_roster_changed", function() {
            self._pruneDeparted();
            self._reassessBots();
            self._pushHud();
        });
    }

    onUpdate(dt) {
        if (this._pendingMatchStartAt > 0) {
            this._pendingMatchStartAt -= dt;
            if (this._pendingMatchStartAt <= 0) {
                this._pendingMatchStartAt = 0;
                this._initMatch();
            }
        }
        if (!this._initialized || this._matchEnded) return;

        this._phaseTimer -= dt;

        var mp = this.scene._mp;
        var isHost = !mp || mp.isHost;

        if (this._phase === "warmup" && this._phaseTimer <= 0) {
            if (isHost) this._startKickoffAsHost();
        } else if (this._phase === "kickoff" && this._phaseTimer <= 0) {
            if (isHost) this._kickoffGoAsHost();
        } else if (this._phase === "playing") {
            this._tickPlaying(dt);
        } else if (this._phase === "goal" && this._phaseTimer <= 0) {
            if (isHost) {
                if (this._matchTimeLeft <= 0) {
                    this._endMatchAsHost({ reason: "Time" });
                } else {
                    this._startKickoffAsHost();
                }
            }
        }

        this._tickBoostPads(dt);
        this._pushHudTick(dt);
    }

    // ─── Init ────────────────────────────────────────────────────────
    _initMatch() {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        if (!roster || !roster.peers || roster.peers.length === 0) return;

        this._resetState();
        this._applyNetworkIdentity();
        this._reassessBots();
        this._assignTeamsAsHost();
        this._resetCarPositions();

        this._initialized = true;
        this.scene._rocketFrozen = true;
        this._enterPhase("warmup", this._warmupSec);
        this._pushHud();
    }

    _resetState() {
        this._phase = "warmup";
        this._phaseTimer = this._warmupSec;
        this._matchTimeLeft = this._matchDurationSec;
        this._matchEnded = false;
        this._scores = { red: 0, blue: 0 };
        this._boost = {};
        this._pads = [];
        this._padRespawn = {};
        this._lastGoalBy = "";
        this._lastGoalTeam = "";

        // Discover boost pads from the world so the system stays
        // templating-agnostic — any entity tagged "boost_pad" counts.
        var pads = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("boost_pad") : [];
        for (var i = 0; i < pads.length; i++) {
            var e = pads[i];
            if (!e) continue;
            var isBig = false;
            if (e.tags && (typeof e.tags.has === "function" ? e.tags.has("boost_big") : e.tags.indexOf && e.tags.indexOf("boost_big") >= 0)) {
                isBig = true;
            }
            this._pads.push({ id: "pad_" + i, entityId: e.id, big: isBig, active: true });
            e.active = true;
        }

        // Reset ball.
        this.scene.events.game.emit("rocket_ball_reset", {
            x: this._ballCenter.x, y: this._ballCenter.y, z: this._ballCenter.z,
        });
        this.scene.events.game.emit("rocket_match_reset", {});
    }

    _applyNetworkIdentity() {
        var mp = this.scene._mp;
        if (!mp) return;
        var localPeerId = mp.localPeerId;
        if (!localPeerId) return;
        var car = this._findLocalCar();
        if (!car) return;
        var ni = car.getComponent("NetworkIdentityComponent");
        if (ni) {
            ni.networkId = this._hashPeerId(localPeerId);
            ni.ownerId = localPeerId;
            ni.isLocalPlayer = true;
        }
    }

    _reassessBots() {
        var mp = this.scene._mp;
        if (!mp) return;
        var numPeers = (mp.roster && mp.roster.peers) ? mp.roster.peers.length : 1;
        var botCar = this.scene.findEntityByName && this.scene.findEntityByName("BotCar");
        if (!botCar) return;
        if (numPeers >= 2) {
            // Deactivate the bot — a second human takes its slot.
            botCar.active = false;
            this._bots = [];
        } else {
            botCar.active = true;
            botCar._isBot = true;
            botCar._rocketBotId = "bot_blue";
            this._bots = ["bot_blue"];
            this._boost["bot_blue"] = this._boostStart;
        }
    }

    _assignTeamsAsHost() {
        var mp = this.scene._mp;
        if (!mp) return;
        if (!mp.isHost) return;
        var teams = {};
        var roster = mp.roster;
        var peers = (roster && roster.peers) ? roster.peers.slice() : [];
        // Sort for determinism across peers.
        peers.sort(function(a, b) { return a.peerId < b.peerId ? -1 : 1; });
        for (var i = 0; i < peers.length; i++) {
            teams[peers[i].peerId] = (i % 2 === 0) ? "red" : "blue";
            this._boost[peers[i].peerId] = this._boostStart;
        }
        this._teams = teams;
        mp.sendNetworkedEvent("rocket_team_assign", { teams: teams });
        this._applyTeamColors();
    }

    _applyTeamColors() {
        // Tint each car's mesh by team so peers can tell friend from foe.
        var cars = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("car") : [];
        for (var i = 0; i < cars.length; i++) {
            var c = cars[i];
            if (!c || !c.getComponent) continue;
            var ni = c.getComponent("NetworkIdentityComponent");
            var ownerId = ni && ni.ownerId;
            var team = null;
            if (ownerId && this._teams[ownerId]) team = this._teams[ownerId];
            else if (c._isBot) team = "blue";  // bot defaults to blue
            if (!team) continue;
            var mr = c.getComponent("MeshRendererComponent");
            if (!mr) continue;
            var col = (team === "red") ? [1.0, 0.25, 0.28, 1] : [0.25, 0.45, 1.0, 1];
            if (mr.baseColor) {
                mr.baseColor[0] = col[0]; mr.baseColor[1] = col[1];
                mr.baseColor[2] = col[2]; mr.baseColor[3] = col[3];
            }
            if (mr.emissive) {
                mr.emissive[0] = col[0] * 0.3;
                mr.emissive[1] = col[1] * 0.3;
                mr.emissive[2] = col[2] * 0.3;
                mr.emissiveIntensity = 0.4;
            }
        }
    }

    _resetCarPositions() {
        var cars = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("car") : [];
        for (var i = 0; i < cars.length; i++) {
            var c = cars[i];
            if (!c || !c.transform) continue;
            var ni = c.getComponent ? c.getComponent("NetworkIdentityComponent") : null;
            var team = null;
            if (ni && ni.ownerId && this._teams[ni.ownerId]) team = this._teams[ni.ownerId];
            else if (c._isBot) team = "blue";
            var spawn = (team === "blue") ? this._blueSpawn : this._redSpawn;
            // Red sits at -Z and needs to face +Z (transform Y=180);
            // blue sits at +Z and keeps the default -Z forward (Y=0).
            // setRotationEuler takes DEGREES.
            var yawDeg = (team === "blue") ? 0 : 180;
            this.scene.setPosition(c.id, spawn.x, spawn.y, spawn.z);
            c.transform.setRotationEuler && c.transform.setRotationEuler(0, yawDeg, 0);
            this.scene.setVelocity && this.scene.setVelocity(c.id, { x: 0, y: 0, z: 0 });
            c.transform.markDirty && c.transform.markDirty();
        }
    }

    // ─── Kickoff ─────────────────────────────────────────────────────
    _startKickoffAsHost() {
        var mp = this.scene._mp;
        if (!mp || !mp.isHost) return;
        this._resetCarPositions();
        this.scene.events.game.emit("rocket_ball_reset", {
            x: this._ballCenter.x, y: this._ballCenter.y, z: this._ballCenter.z,
        });
        var payload = { countdown: this._kickoffCountdownSec, timeLeft: this._matchTimeLeft, scores: this._scores };
        mp.sendNetworkedEvent("rocket_kickoff", payload);
        this._applyKickoffStart(payload);
    }

    _applyKickoffStart(d) {
        this._enterPhase("kickoff", d.countdown || this._kickoffCountdownSec);
        this.scene._rocketFrozen = true;
        if (d.scores) this._scores = d.scores;
        if (d.timeLeft !== undefined) this._matchTimeLeft = d.timeLeft;
        this._pushHud();
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/bong_001.ogg", 0.45);
    }

    _kickoffGoAsHost() {
        var mp = this.scene._mp;
        if (!mp || !mp.isHost) return;
        mp.sendNetworkedEvent("rocket_go", {});
        this._applyKickoffGo();
    }

    _applyKickoffGo() {
        this._enterPhase("playing", -1);
        this.scene._rocketFrozen = false;
        if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/go.ogg", 0.55);
    }

    // ─── Playing tick ────────────────────────────────────────────────
    _tickPlaying(dt) {
        var mp = this.scene._mp;
        var isHost = !mp || mp.isHost;
        if (!isHost) return;

        // Match clock.
        this._matchTimeLeft = Math.max(0, this._matchTimeLeft - dt);

        // Goal detection.
        var ball = this.scene.findEntityByName && this.scene.findEntityByName("Ball");
        if (ball && ball.transform) {
            var bp = ball.transform.position;
            if (bp.z < -this._goalPosZ && Math.abs(bp.x) < this._goalHalfWidth && bp.y < this._goalHeight) {
                this._goalScoredAsHost("blue", bp);
                return;
            }
            if (bp.z > this._goalPosZ && Math.abs(bp.x) < this._goalHalfWidth && bp.y < this._goalHeight) {
                this._goalScoredAsHost("red", bp);
                return;
            }
        }

        // Match timeout → resolve.
        if (this._matchTimeLeft <= 0) {
            // Let the current goal window close, then end.
            var reason = this._scores.red === this._scores.blue ? "Draw" : "Time";
            this._endMatchAsHost({ reason: reason });
        }

        // Periodic score sync so everyone's timer stays aligned.
        this._syncTick = (this._syncTick || 0) + dt;
        if (this._syncTick >= 0.25 && mp) {
            this._syncTick = 0;
            mp.sendNetworkedEvent("rocket_score_update", {
                scores: this._scores,
                timeLeft: this._matchTimeLeft,
                boost: this._boost,
            });
        }
    }

    // ─── Goals ───────────────────────────────────────────────────────
    _goalScoredAsHost(scoringTeam, ballPos) {
        var mp = this.scene._mp;
        if (!mp || !mp.isHost) return;
        this._scores[scoringTeam] = (this._scores[scoringTeam] || 0) + 1;
        var payload = {
            team: scoringTeam,
            scores: this._scores,
            ballX: ballPos.x, ballY: ballPos.y, ballZ: ballPos.z,
        };
        mp.sendNetworkedEvent("rocket_goal", payload);
        this._applyGoalScored(payload);

        // Match end condition: first to N? We don't cap by score — only
        // time caps. But we still announce a "Mercy Rule" if the lead
        // gets huge. Skipping for simplicity; the timer resolves it.
    }

    _applyGoalScored(d) {
        this._lastGoalTeam = d.team || "";
        if (d.scores) this._scores = d.scores;
        this._enterPhase("goal", this._goalCelebrationSec);
        this.scene._rocketFrozen = true;
        // Stop the ball in place for the celebration.
        this.scene.events.game.emit("rocket_ball_reset", {
            x: d.ballX, y: d.ballY, z: d.ballZ,
        });
        this._pushHud();
        if (this.audio) {
            this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/explosionCrunch_000.ogg", 0.65);
            this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/congratulations.ogg", 0.5);
        }
    }

    // ─── Boost pads ──────────────────────────────────────────────────
    _tickBoostPads(dt) {
        var mp = this.scene._mp;
        if (!mp) return;
        var isHost = !mp || mp.isHost;

        // Respawn timers (host-authoritative).
        if (isHost) {
            for (var padId in this._padRespawn) {
                this._padRespawn[padId] -= dt;
                if (this._padRespawn[padId] <= 0) {
                    delete this._padRespawn[padId];
                    for (var i = 0; i < this._pads.length; i++) {
                        if (this._pads[i].id === padId) {
                            this._pads[i].active = true;
                            var ent = this.scene.findEntityById && this.scene.findEntityById(this._pads[i].entityId);
                            if (ent) ent.active = true;
                            break;
                        }
                    }
                }
            }
        }

        // Local pickup check for the local player car.
        var me = mp.localPeerId;
        var car = this._findLocalCar();
        if (!car) return;
        var cp = car.transform.position;
        var r2 = this._padPickupRadius * this._padPickupRadius;
        for (var j = 0; j < this._pads.length; j++) {
            var pad = this._pads[j];
            if (!pad.active) continue;
            var pe = this.scene.findEntityById && this.scene.findEntityById(pad.entityId);
            if (!pe || !pe.transform) continue;
            var pp = pe.transform.position;
            var dx = cp.x - pp.x, dz = cp.z - pp.z;
            if (dx * dx + dz * dz > r2) continue;

            // Claim the pad.
            pad.active = false;
            pe.active = false;
            var amount = pad.big ? this._boostRefillBig : this._boostRefillSmall;
            this._boost[me] = Math.min(this._boostMax, (this._boost[me] || 0) + amount);
            mp.sendNetworkedEvent("rocket_boost_pickup", {
                padId: pad.id,
                peerId: me,
                amount: amount,
                total: this._boost[me],
                big: pad.big,
            });
            if (isHost) this._padRespawn[pad.id] = this._padRespawnSec;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_001.ogg", 0.4);
            break;
        }
    }

    _applyBoostPickup(d) {
        for (var i = 0; i < this._pads.length; i++) {
            if (this._pads[i].id === d.padId) {
                this._pads[i].active = false;
                var ent = this.scene.findEntityById && this.scene.findEntityById(this._pads[i].entityId);
                if (ent) ent.active = false;
                break;
            }
        }
        if (d.peerId) {
            this._boost[d.peerId] = d.total || ((this._boost[d.peerId] || 0) + (d.amount || 0));
        }
        // Host schedules respawn; peers mirror via the score_update → pad
        // becomes active again when host includes a refreshed list (we
        // keep it implicit: pad visually reappears when host deactivates
        // and re-activates ent.active; clients will see a later hit).
        var mp = this.scene._mp;
        if (mp && mp.isHost) this._padRespawn[d.padId] = this._padRespawnSec;
        this._pushHud();
    }

    // ─── Match end ───────────────────────────────────────────────────
    _endMatchAsHost(d) {
        if (this._matchEnded) return;
        var mp = this.scene._mp;
        if (!mp) return;
        var winner = "draw";
        if (this._scores.red > this._scores.blue) winner = "red";
        else if (this._scores.blue > this._scores.red) winner = "blue";
        var payload = {
            winner: winner,
            reason: d.reason || "",
            scores: this._scores,
            teams: this._teams,
        };
        mp.sendNetworkedEvent("rocket_match_ended", payload);
        this._endMatchOnPeers(payload);
        if (mp.isHost && mp.endMatch) mp.endMatch();
    }

    _endMatchOnPeers(d) {
        if (this._matchEnded) return;
        this._matchEnded = true;
        this._enterPhase("ended", -1);
        this.scene._rocketFrozen = true;
        this._pushGameOver(d);
        this.scene.events.game.emit("match_ended", { reason: d.reason, winner: d.winner });
    }

    // ─── HUD ─────────────────────────────────────────────────────────
    _pushHud() {
        var mp = this.scene._mp;
        if (!mp) return;
        var me = mp.localPeerId;
        var myTeam = this._teams[me] || "red";

        var localState = this.scene._rocketCarLocalState || {};
        var boost = Math.round(this._boost[me] || 0);
        var speedKph = Math.round((localState.speed || 0) * 3.6);

        var mm = Math.floor(this._matchTimeLeft / 60);
        var ss = Math.floor(this._matchTimeLeft - mm * 60);
        var clock = mm + ":" + (ss < 10 ? "0" : "") + ss;

        var payload = {
            _rocket: {
                phase: this._phase,
                phaseTimer: Math.max(0, Math.ceil(this._phaseTimer)),
                scoreRed: this._scores.red || 0,
                scoreBlue: this._scores.blue || 0,
                myTeam: myTeam,
                boost: boost,
                boostMax: this._boostMax,
                speedKph: speedKph,
                grounded: !!localState.grounded,
                boosting: !!localState.boosting,
                clock: clock,
                clockSec: Math.round(this._matchTimeLeft),
                lastGoalTeam: this._lastGoalTeam,
                bots: this._bots,
                kickoffCountdown: this._phase === "kickoff" ? Math.max(0, Math.ceil(this._phaseTimer)) : 0,
            },
        };
        this.scene.events.ui.emit("hud_update", payload);
    }

    _pushHudTick(dt) {
        this._hudT = (this._hudT || 0) + dt;
        if (this._hudT < 0.12) return;
        this._hudT = 0;
        this._pushHud();
    }

    _pushGameOver(d) {
        var mp = this.scene._mp;
        var me = mp && mp.localPeerId;
        var myTeam = (mp && this._teams[me]) || "red";
        var iWon = d.winner === myTeam;
        var title = d.winner === "draw"
            ? "DRAW"
            : (iWon ? (myTeam.toUpperCase() + " VICTORY") : (d.winner.toUpperCase() + " WINS"));
        this.scene.events.ui.emit("hud_update", {
            _gameOver: {
                title: title,
                score: iWon ? 1 : 0,
                stats: {
                    "Red": String((d.scores && d.scores.red) || 0),
                    "Blue": String((d.scores && d.scores.blue) || 0),
                    "Your team": myTeam,
                    "Reason": d.reason || "",
                },
            },
        });
    }

    // ─── Helpers ─────────────────────────────────────────────────────
    _findLocalCar() {
        var players = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("car") : [];
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            var ni = p.getComponent("NetworkIdentityComponent");
            if (ni && ni.isLocalPlayer) return p;
        }
        return null;
    }

    _hashPeerId(peerId) {
        var h = 2166136261;
        for (var i = 0; i < peerId.length; i++) {
            h ^= peerId.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return ((h >>> 0) % 1000000) + 1000;
    }

    _pruneDeparted() {
        var mp = this.scene._mp;
        if (!mp || !mp.roster) return;
        var present = {};
        for (var i = 0; i < mp.roster.peers.length; i++) present[mp.roster.peers[i].peerId] = true;
        for (var id in this._boost) {
            if (!present[id] && id.indexOf("bot_") !== 0) delete this._boost[id];
        }
        for (var t in this._teams) {
            if (!present[t]) delete this._teams[t];
        }
    }

    _enterPhase(phase, seconds) {
        this._phase = phase;
        this._phaseTimer = seconds;
        this.scene.events.game.emit("phase_changed", { phase: phase });
    }
}

// Store ball velocity on the ball entity for the bot AI to peek at.
// The rocket_ball behavior does this itself in its _applyRemoteBallState
// on remote peers; on the host we mirror the same fields so a local
// bot can read without re-deriving position deltas.
