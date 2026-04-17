// Neon Cycles match rules — host-authoritative best-of-N rounds with
// trail-wall collision detection.
//
// Match shape:
//   - On match_started, every peer positions its local bike on a ring
//     facing the centre and patches NetworkIdentity so remotes can tell
//     the snapshots apart (same pattern as coin_grab_game).
//   - The host runs a 3-2-1 countdown (round_started → countdown ticks
//     → countdown_done) and then opens the round. Bike control gates on
//     countdown_done so nobody starts moving early.
//   - Each tick the host samples every bike's position. Once a bike
//     has moved more than `minSegmentLen` from its last sample, the
//     host appends a wall segment to that bike's trail list. The host
//     then checks every alive bike against every wall (skipping its
//     own most-recent few segments — the immune-zone window), plus the
//     arena perimeter. First crash → bike_crashed locally + broadcast
//     net_bike_crashed.
//   - Round ends when ≤1 bike is alive (last survivor scores; mutual
//     destruction awards no point). After roundsToWin or maxRounds the
//     match ends and the leaderboard goes to the game-over UI.
//
// Trail rendering is handled per-bike by light_trail_emitter — separate
// from this collision list so render and physics can drift slightly
// without breaking the match. Visuals on each peer track local-observed
// positions; canonical "did you crash" only fires from the host's list.
class NeonCyclesMatchSystem extends GameScript {
    _roundsToWin = 3;
    _maxRounds = 9;
    _roundCountdownSec = 3;
    _roundIntermissionSec = 4;
    _matchTimeoutSec = 540;
    _bikeRadius = 0.7;
    _selfImmuneSec = 0.6;
    _speedRampPerSec = 0.04;
    _spawnRingRadius = 22;

    // Per-match state (host-authoritative for everything that matters)
    _scores = {};
    _alive = {};
    _round = 0;
    _phase = "idle";    // idle | countdown | running | intermission | match_over
    _phaseTimer = 0;
    _countdownLast = -1;
    _matchElapsed = 0;
    _ended = false;
    _initialized = false;
    _trails = {};       // peerId → [{x1,z1,x2,z2,t}]
    _sampleTimer = 0;
    _killFeed = [];
    _arenaHalf = 39.0;  // inside-edge of the perimeter walls
    _hostCollisionTimer = 0;
    _localCrashSent = {}; // peerId → ts so we don't re-broadcast our own

    // Player palette — index by sorted-roster slot. 8 distinct neon hues
    // chosen to stay legible on a near-black background under bloom.
    _palette = [
        [0.30, 1.00, 1.00, 1.0],  // 0 cyan
        [1.00, 0.30, 0.95, 1.0],  // 1 magenta
        [1.00, 0.95, 0.30, 1.0],  // 2 yellow
        [0.40, 1.00, 0.40, 1.0],  // 3 green
        [1.00, 0.55, 0.15, 1.0],  // 4 orange
        [0.65, 0.40, 1.00, 1.0],  // 5 violet
        [1.00, 0.40, 0.55, 1.0],  // 6 pink
        [0.40, 0.70, 1.00, 1.0],  // 7 sky
    ];

    onStart() {
        var self = this;
        // Mirror coin_grab — both onStart and the match_started event run
        // on the first frame, so init eagerly and idempotently.
        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });

        // Bike crash from any source — local detection or networked echo.
        // The bike control behavior listens for the same events, so we
        // don't have to call into it; just bookkeep here.
        this.scene.events.game.on("bike_crashed", function(d) {
            self._handleCrash((d && d.peerId) || "", (d && d.killedBy) || "");
        });
        this.scene.events.game.on("net_bike_crashed", function(evt) {
            var d = (evt && evt.data) || {};
            self._handleCrash(d.peerId || "", d.killedBy || "");
        });

        this.scene.events.game.on("net_match_ended", function(evt) {
            if (self._ended) return;
            self._ended = true;
            var d = (evt && evt.data) || {};
            if (d.scores) self._scores = d.scores;
            self.scene.events.game.emit("match_ended", d);
            self._pushGameOver(d.winner, d.reason);
        });

        // Host migration — claim authority and reseed timers cleanly.
        this.scene.events.game.on("mp_host_changed", function() {
            if (self._ended || !self._initialized) return;
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            var roster = mp2.roster;
            var minP = (roster && roster.minPlayers) || 1;
            if (roster && roster.peers.length < minP) {
                self._endMatch(self._findLeader(), "abandoned");
                return;
            }
            // Re-baseline the round so the new host doesn't double-tick
            // the countdown / inter-round timer mid-phase.
            self._phaseTimer = 0;
            self._sampleTimer = 0;
            self._hostCollisionTimer = 0;
        });

        this.scene.events.game.on("mp_below_min_players", function() {
            if (self._ended) return;
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            self._endMatch(self._findLeader(), "abandoned");
        });

        // Networked round transitions — non-host peers learn about phase
        // changes here and mirror them locally so HUDs stay in sync.
        this.scene.events.game.on("net_round_started", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyRoundStartedRemote(d);
        });
        this.scene.events.game.on("net_round_ended", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyRoundEndedRemote(d);
        });

        this.scene.events.game.on("mp_phase_in_lobby", function() { self._pruneScoresFromRoster(); });
        this.scene.events.game.on("mp_phase_in_game", function() { self._pruneScoresFromRoster(); });
        this.scene.events.game.on("mp_roster_changed", function() { self._pruneScoresFromRoster(); });
    }

    onUpdate(dt) {
        var mp = this.scene._mp;
        if (!mp || !this._initialized || this._ended) return;

        // Maintain trail samples + collision check on the host. The trails
        // map is populated only on the host because remote peers don't
        // need authoritative collisions — their bike control mirrors the
        // crash via net_bike_crashed.
        if (mp.isHost && this._phase === "running") {
            this._sampleTimer += dt;
            this._hostCollisionTimer += dt;
            this._matchElapsed += dt;

            // Speed ramp — gently accelerates over the round so stalled
            // mutual-trapping endgames resolve themselves.
            var ramp = 1 + this._speedRampPerSec * Math.min(this._matchElapsed, 60);
            this.scene._neonCycles = this.scene._neonCycles || {};
            this.scene._neonCycles.speedRamp = ramp;

            if (this._sampleTimer >= 0.12) {
                this._sampleTimer = 0;
                this._sampleTrails();
            }
            if (this._hostCollisionTimer >= 0.06) {
                this._hostCollisionTimer = 0;
                this._checkCollisions();
            }

            if (this._matchElapsed >= this._matchTimeoutSec) {
                this._endMatch(this._findLeader(), "time");
                return;
            }
        }

        // Phase timer advances on every peer for HUD smoothness, but
        // only the host fires the transitions (broadcast to others).
        this._phaseTimer += dt;
        if (mp.isHost) this._tickHostPhase();

        // Push the round HUD frequently enough for the countdown to feel
        // crisp without spamming the iframe — once every ~100ms.
        if (this._round > 0) this._pushRoundStatus();
    }

    // ─── Per-peer init ──────────────────────────────────────────────────

    _initMatch() {
        var mp = this.scene._mp;
        if (!mp) return;

        this._scores = {};
        this._alive = {};
        this._trails = {};
        this._round = 0;
        this._phase = "idle";
        this._phaseTimer = 0;
        this._matchElapsed = 0;
        this._ended = false;
        this._sampleTimer = 0;
        this._hostCollisionTimer = 0;
        this._countdownLast = -1;
        this._killFeed = [];
        this._localCrashSent = {};

        var roster = mp.roster;
        if (roster && roster.peers) {
            // Sort once to derive deterministic slot indices for colour
            // and spawn position.
            var sorted = roster.peers.slice().sort(function(a, b) {
                return a.peerId < b.peerId ? -1 : (a.peerId > b.peerId ? 1 : 0);
            });
            var colorByPeer = {};
            var slotByPeer = {};
            for (var i = 0; i < sorted.length; i++) {
                var pid = sorted[i].peerId;
                this._scores[pid] = 0;
                this._alive[pid] = true;
                this._trails[pid] = [];
                colorByPeer[pid] = this._palette[i % this._palette.length];
                slotByPeer[pid] = i;
            }
            this.scene._neonCycles = this.scene._neonCycles || {};
            this.scene._neonCycles.colorByPeer = colorByPeer;
            this.scene._neonCycles.slotByPeer = slotByPeer;
            this.scene._neonCycles.bikes = this.scene._neonCycles.bikes || {};
        }

        this._positionLocalPlayer();
        this._initialized = true;
        this._pushScoreboard();
        this._pushKillFeedState();

        // Host kicks off round 1 immediately — every peer's onStart and
        // event handlers will be live by the next tick.
        if (mp.isHost) {
            this._startRound(1);
        }
    }

    _positionLocalPlayer() {
        var mp = this.scene._mp;
        if (!mp) return;
        var roster = mp.roster;
        var slot = (this.scene._neonCycles && this.scene._neonCycles.slotByPeer && this.scene._neonCycles.slotByPeer[mp.localPeerId]) || 0;
        var count = (roster && roster.peers && roster.peers.length) || 2;
        var sp = this._spawnPointForSlot(slot, count);

        var bike = this._findLocalBike();
        if (!bike) return;
        this.scene.setPosition(bike.id, sp.x, 0.6, sp.z);
        if (bike.transform && bike.transform.setRotationEuler) {
            bike.transform.setRotationEuler(0, sp.yaw, 0);
            bike.transform.markDirty && bike.transform.markDirty();
        }
        var ni = bike.getComponent ? bike.getComponent("NetworkIdentityComponent") : null;
        if (ni) {
            ni.networkId = this._hashPeerId(mp.localPeerId);
            ni.ownerId = mp.localPeerId;
            ni.isLocalPlayer = true;
        }
    }

    _spawnPointForSlot(slot, count) {
        // Even spread around a ring inside the arena, all bikes facing the
        // centre. Distinct yaw per slot keeps the opening seconds from
        // funnelling everyone into the same lane.
        var safeCount = Math.max(2, count);
        var angle = (slot / safeCount) * Math.PI * 2;
        var R = this._spawnRingRadius;
        var x = Math.cos(angle) * R;
        var z = Math.sin(angle) * R;
        // Yaw (in degrees) such that the bike's +Z faces the centre.
        // setRotationEuler expects degrees, not radians.
        var yaw = Math.atan2(-x, -z) * 180 / Math.PI;
        return { x: x, z: z, yaw: yaw };
    }

    _findLocalBike() {
        var bikes = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("bike") : [];
        for (var i = 0; i < bikes.length; i++) {
            var b = bikes[i];
            var tags = b.tags || [];
            var hasRemote = false;
            if (tags) {
                if (typeof tags.has === "function") hasRemote = tags.has("remote");
                else if (tags.indexOf) hasRemote = tags.indexOf("remote") >= 0;
            }
            if (hasRemote) continue;
            var ni = b.getComponent ? b.getComponent("NetworkIdentityComponent") : null;
            if (ni && ni.isLocalPlayer) return b;
        }
        return bikes[0] || null;
    }

    // ─── Round lifecycle (host-authoritative) ───────────────────────────

    _startRound(roundIdx) {
        var mp = this.scene._mp;
        if (!mp || !mp.isHost) return;

        this._round = roundIdx;
        this._phase = "countdown";
        this._phaseTimer = 0;
        this._matchElapsed = 0;
        this._countdownLast = -1;
        for (var pid in this._alive) this._alive[pid] = true;
        for (var pid2 in this._trails) this._trails[pid2] = [];
        this._localCrashSent = {};

        // Broadcast spawn points so every peer rearranges its own local bike
        // identically — the host controls slot assignment via roster order.
        var spawns = this._buildSpawnTable();
        var payload = { round: roundIdx, spawns: spawns };
        this.scene.events.game.emit("round_started", { round: roundIdx });
        if (mp.sendNetworkedEvent) mp.sendNetworkedEvent("round_started", payload);
        // Apply locally too (host is also a player on hostPlaysGame:true).
        this._applyRoundStartedRemote(payload);
    }

    _applyRoundStartedRemote(d) {
        // Repositions the local bike using the host's spawn table so every
        // peer agrees on opening positions even if roster ordering drifts.
        if (!d) return;
        if (typeof d.round === "number") this._round = d.round;

        // Two flavours of round_started:
        //   • normal: the host just kicked off a countdown — enter countdown
        //     phase, reset state, reposition local bike.
        //   • go:true: the host's countdown hit 0 — flip to running and fire
        //     countdown_done locally so bike_player_control unlocks input.
        //     Without this branch remote peers would sit at "1" forever.
        if (d.go) {
            this._phase = "running";
            this._phaseTimer = 0;
            this._matchElapsed = 0;
            this._countdownLast = -1;
            this.scene.events.game.emit("countdown_done", {});
            return;
        }

        this._phase = "countdown";
        this._phaseTimer = 0;
        this._countdownLast = -1;
        for (var pid in this._alive) this._alive[pid] = true;
        for (var pid2 in this._trails) this._trails[pid2] = [];
        this._localCrashSent = {};

        var mp = this.scene._mp;
        if (!mp) return;
        var spawns = d.spawns || null;
        var localSpawn = null;
        if (spawns && spawns[mp.localPeerId]) localSpawn = spawns[mp.localPeerId];
        if (!localSpawn) {
            // Fallback: derive from local slot map. Keeps things working
            // even if the host's payload was missing the field.
            var slot = (this.scene._neonCycles && this.scene._neonCycles.slotByPeer && this.scene._neonCycles.slotByPeer[mp.localPeerId]) || 0;
            var count = (mp.roster && mp.roster.peers && mp.roster.peers.length) || 2;
            localSpawn = this._spawnPointForSlot(slot, count);
        }
        var bike = this._findLocalBike();
        if (bike) {
            this.scene.setPosition(bike.id, localSpawn.x, 0.6, localSpawn.z);
            if (bike.transform && bike.transform.setRotationEuler) {
                bike.transform.setRotationEuler(0, localSpawn.yaw, 0);
                bike.transform.markDirty && bike.transform.markDirty();
            }
        }
        // Re-emit the local game event so behaviors (light_trail_emitter,
        // bike_player_control) reset their per-round state. The networked
        // listener for net_round_started re-fires it for those subscribers.
        this.scene.events.game.emit("round_started", { round: this._round });
        this._pushRoundStatus();
    }

    _buildSpawnTable() {
        var mp = this.scene._mp;
        if (!mp || !mp.roster) return {};
        var slotMap = (this.scene._neonCycles && this.scene._neonCycles.slotByPeer) || {};
        var count = mp.roster.peers.length || 2;
        var out = {};
        for (var i = 0; i < mp.roster.peers.length; i++) {
            var pid = mp.roster.peers[i].peerId;
            var slot = slotMap[pid] != null ? slotMap[pid] : i;
            out[pid] = this._spawnPointForSlot(slot, count);
        }
        return out;
    }

    _tickHostPhase() {
        if (this._phase === "countdown") {
            // Tick down 3,2,1,GO and emit countdown_tick on each integer
            // boundary so HUDs and audio cues stay in sync. countdown_done
            // fires once when the bar hits 0.
            var remaining = Math.max(0, this._roundCountdownSec - this._phaseTimer);
            var whole = Math.ceil(remaining);
            if (whole !== this._countdownLast) {
                this._countdownLast = whole;
                this.scene.events.game.emit("countdown_tick", { remaining: whole });
            }
            if (remaining <= 0) {
                this._phase = "running";
                this._phaseTimer = 0;
                this._matchElapsed = 0;
                this.scene.events.game.emit("countdown_done", {});
                var mp = this.scene._mp;
                if (mp && mp.sendNetworkedEvent) {
                    // Wrap the bare countdown_done in a net_round_started
                    // refresh so a peer who joined late still flips into
                    // running mode without waiting for the next round.
                    mp.sendNetworkedEvent("round_started", { round: this._round, spawns: null, go: true });
                }
            }
            return;
        }
        if (this._phase === "intermission") {
            if (this._phaseTimer >= this._roundIntermissionSec) {
                if (this._round >= this._maxRounds) {
                    this._endMatch(this._findLeader(), "rounds");
                } else {
                    this._startRound(this._round + 1);
                }
            }
        }
    }

    // ─── Trail sampling + collision detection (host-only) ───────────────

    _sampleTrails() {
        var bikes = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("bike") : [];
        for (var i = 0; i < bikes.length; i++) {
            var b = bikes[i];
            var ni = b.getComponent ? b.getComponent("NetworkIdentityComponent") : null;
            var pid = ni && ni.ownerId;
            if (!pid || typeof pid !== "string") continue;
            // Admit late-joining peers whose pid isn't in _alive yet.
            if (!(pid in this._alive)) this._alive[pid] = true;
            if (!this._alive[pid]) continue;
            if (!b.transform) continue;
            var p = b.transform.position;
            var arr = this._trails[pid] || (this._trails[pid] = []);
            var last = arr.length > 0 ? arr[arr.length - 1] : null;
            if (!last) {
                // Prime the trail with a zero-length sentinel at the bike's
                // current position. Without this, the "barely moved" guard
                // below fires on every sample when arr is empty (because
                // x1/z1 would default to the current position, so dx/dz are
                // always 0), and the array never grows — collision checks
                // silently skip since they bail on `arr.length === 0`.
                arr.push({ x1: p.x, z1: p.z, x2: p.x, z2: p.z, t: Date.now() });
                continue;
            }
            var x1 = last.x2;
            var z1 = last.z2;
            var dx = p.x - x1, dz = p.z - z1;
            // Skip if barely moved — keeps us from littering tiny segments
            // when a bike is parked or rotation-jitters.
            if (dx * dx + dz * dz < 0.04) continue;
            arr.push({ x1: x1, z1: z1, x2: p.x, z2: p.z, t: Date.now() });
        }
    }

    _checkCollisions() {
        var nowMs = Date.now();
        var immuneCutoff = nowMs - this._selfImmuneSec * 1000;
        var bikes = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("bike") : [];
        var bikeRsq = this._bikeRadius * this._bikeRadius;

        for (var i = 0; i < bikes.length; i++) {
            var b = bikes[i];
            var ni = b.getComponent ? b.getComponent("NetworkIdentityComponent") : null;
            var pid = ni && ni.ownerId;
            if (!pid || typeof pid !== "string" || !b.transform) continue;
            // Admit late-joining peers whose pid isn't in _alive yet.
            if (!(pid in this._alive)) this._alive[pid] = true;
            if (!this._alive[pid]) continue;

            var pos = b.transform.position;
            // Arena edge collision — fastest possible bail.
            if (Math.abs(pos.x) >= this._arenaHalf || Math.abs(pos.z) >= this._arenaHalf) {
                this._broadcastCrash(pid, "");
                continue;
            }

            // Trail-wall collision. First hit wins; killedBy stays "" for
            // self-crashes (own old segment) so the kill feed reads as a
            // solo crash instead of attributing the kill to the victim.
            var crashed = false;
            var killedBy = "";
            for (var otherPid in this._trails) {
                if (crashed) break;
                var arr = this._trails[otherPid];
                if (!arr || arr.length === 0) continue;
                var isSelf = (otherPid === pid);
                for (var s = 0; s < arr.length; s++) {
                    var seg = arr[s];
                    // Self-trail: ignore freshly-laid segments (still
                    // under the bike) so we don't self-crash on emission.
                    if (isSelf && seg.t > immuneCutoff) continue;
                    if (pointSegDistSq(pos.x, pos.z, seg.x1, seg.z1, seg.x2, seg.z2) < bikeRsq) {
                        crashed = true;
                        killedBy = isSelf ? "" : otherPid;
                        break;
                    }
                }
            }
            if (crashed) this._broadcastCrash(pid, killedBy);
        }
    }

    _broadcastCrash(victimPeerId, killerPeerId) {
        if (!this._alive[victimPeerId]) return;
        // Locally fire so this peer (who is host + maybe also victim) and
        // every behavior listening on the same bus reacts in this frame.
        // Net replication carries it to remotes.
        this.scene.events.game.emit("bike_crashed", { peerId: victimPeerId, killedBy: killerPeerId });
        var mp = this.scene._mp;
        if (mp && mp.sendNetworkedEvent) {
            mp.sendNetworkedEvent("bike_crashed", { peerId: victimPeerId, killedBy: killerPeerId });
        }
    }

    _handleCrash(victimPeerId, killerPeerId) {
        if (!victimPeerId) return;
        if (!this._alive[victimPeerId]) return;
        this._alive[victimPeerId] = false;
        this._pushKillFeed(killerPeerId, victimPeerId);

        // Round-end check — only host advances the phase, and only when
        // the round is actually running.
        var mp = this.scene._mp;
        if (mp && mp.isHost && this._phase === "running") {
            var aliveCount = 0;
            var lastPid = null;
            for (var pid in this._alive) {
                if (this._alive[pid]) { aliveCount++; lastPid = pid; }
            }
            if (aliveCount <= 1) {
                this._endRound(aliveCount === 1 ? lastPid : null);
            }
        }
    }

    _endRound(winnerPeerId) {
        var mp = this.scene._mp;
        if (!mp || !mp.isHost) return;
        if (winnerPeerId) {
            this._scores[winnerPeerId] = (this._scores[winnerPeerId] || 0) + 1;
        }
        this._phase = "intermission";
        this._phaseTimer = 0;
        this.scene.events.game.emit("round_ended", { round: this._round, winner: winnerPeerId || "" });
        if (mp.sendNetworkedEvent) {
            mp.sendNetworkedEvent("round_ended", { round: this._round, winner: winnerPeerId || "", scores: this._scores });
        }
        this._pushScoreboard();
        this._pushRoundStatus();

        // Match-end check: someone hit roundsToWin → close out after a
        // short fanfare so HUDs render the final round result before the
        // game-over banner takes over the screen.
        if (winnerPeerId && this._scores[winnerPeerId] >= this._roundsToWin) {
            var self = this;
            setTimeout(function() {
                if (!self._ended) self._endMatch(winnerPeerId, "score");
            }, 2500);
        }
    }

    _applyRoundEndedRemote(d) {
        if (!d) return;
        this._phase = "intermission";
        this._phaseTimer = 0;
        if (d.scores) this._scores = d.scores;
        this._pushScoreboard();
        this._pushRoundStatus();
        this.scene.events.game.emit("round_ended", { round: d.round || this._round, winner: d.winner || "" });
    }

    // ─── Match end ──────────────────────────────────────────────────────

    _endMatch(winnerPeerId, reason) {
        this._ended = true;
        var mp = this.scene._mp;
        var payload = { winner: winnerPeerId || "", reason: reason, scores: this._scores };
        if (mp) mp.sendNetworkedEvent("match_ended", payload);
        this.scene.events.game.emit("match_ended", payload);
        this._pushGameOver(winnerPeerId, reason);
        if (mp && mp.isHost && mp.endMatch) mp.endMatch();
    }

    _pushGameOver(winnerPeerId, reason) {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        var localPeerId = mp && mp.localPeerId;
        var iWon = winnerPeerId && winnerPeerId === localPeerId;

        var winnerName = "Nobody";
        if (roster && winnerPeerId) {
            for (var i = 0; i < roster.peers.length; i++) {
                if (roster.peers[i].peerId === winnerPeerId) {
                    winnerName = roster.peers[i].username;
                    break;
                }
            }
        }
        var title;
        if (!winnerPeerId) title = "Draw!";
        else if (iWon) title = "VICTORY!";
        else title = winnerName + " wins";

        var myWins = (mp && this._scores[localPeerId]) || 0;
        var stats = {};
        if (roster && roster.peers) {
            var self2 = this;
            var ranked = roster.peers.slice().sort(function(a, b) {
                return (self2._scores[b.peerId] || 0) - (self2._scores[a.peerId] || 0);
            });
            for (var j = 0; j < ranked.length; j++) {
                var pr = ranked[j];
                var label = pr.username + (pr.peerId === localPeerId ? " (you)" : "");
                stats[label] = (this._scores[pr.peerId] || 0) + " round wins";
            }
        }
        if (reason === "time")        stats["Reason"] = "Time up";
        else if (reason === "rounds") stats["Reason"] = "All " + this._maxRounds + " rounds played";
        else if (reason === "score")  stats["Reason"] = "Reached " + this._roundsToWin + " round wins";
        else if (reason === "abandoned") stats["Reason"] = "Too few players";

        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: myWins, stats: stats },
        });
    }

    // ─── HUD ────────────────────────────────────────────────────────────

    _pushScoreboard() {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        var list = [];
        var slotMap = (this.scene._neonCycles && this.scene._neonCycles.slotByPeer) || {};
        var palette = this._palette;
        if (roster && roster.peers) {
            for (var i = 0; i < roster.peers.length; i++) {
                var pr = roster.peers[i];
                var slot = slotMap[pr.peerId] != null ? slotMap[pr.peerId] : i;
                var col = palette[slot % palette.length];
                list.push({
                    peerId: pr.peerId,
                    username: pr.username,
                    score: this._scores[pr.peerId] || 0,
                    isLocal: pr.peerId === mp.localPeerId,
                    color: col,
                });
            }
        }
        list.sort(function(a, b) { return b.score - a.score; });
        this.scene.events.ui.emit("hud_update", {
            scoreboard: { players: list, scoreToWin: this._roundsToWin, scoreLabel: "round wins" },
        });
    }

    _pushRoundStatus() {
        var aliveCount = 0;
        for (var pid in this._alive) if (this._alive[pid]) aliveCount++;
        var remaining = -1;
        if (this._phase === "countdown") remaining = Math.max(0, Math.ceil(this._roundCountdownSec - this._phaseTimer));
        else if (this._phase === "intermission") remaining = Math.max(0, Math.ceil(this._roundIntermissionSec - this._phaseTimer));

        this.scene.events.ui.emit("hud_update", {
            neonRound: {
                round: this._round,
                roundsToWin: this._roundsToWin,
                phase: this._phase,
                aliveCount: aliveCount,
                countdown: remaining,
            },
        });
    }

    _pushKillFeed(killerPeerId, victimPeerId) {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        if (!victimPeerId) return;
        var killerName = killerPeerId ? this._peerNameOrId(roster, killerPeerId) : "";
        var victimName = this._peerNameOrId(roster, victimPeerId);
        this._killFeed.push({
            killer: killerName,
            victim: victimName,
            killerIsLocal: !!(mp && killerPeerId === mp.localPeerId),
            victimIsLocal: !!(mp && victimPeerId === mp.localPeerId),
            tsMs: Date.now(),
        });
        if (this._killFeed.length > 6) this._killFeed = this._killFeed.slice(-6);
        this._pushKillFeedState();
    }

    _pushKillFeedState() {
        // Trim entries older than 5s — same lifetime convention as
        // deathmatch_game so the kill_feed iframe behaves consistently.
        var cutoff = Date.now() - 5000;
        var kept = [];
        for (var i = 0; i < this._killFeed.length; i++) {
            if (this._killFeed[i].tsMs > cutoff) kept.push(this._killFeed[i]);
        }
        this._killFeed = kept;
        this.scene.events.ui.emit("hud_update", {
            killFeed: { entries: this._killFeed.slice() },
        });
    }

    _peerNameOrId(roster, peerId) {
        if (roster && roster.peers) {
            for (var i = 0; i < roster.peers.length; i++) {
                if (roster.peers[i].peerId === peerId) return roster.peers[i].username;
            }
        }
        return peerId.slice(0, 6);
    }

    _findLeader() {
        var bestScore = -1;
        var bestPeer = null;
        for (var p in this._scores) {
            if (this._scores[p] > bestScore) { bestScore = this._scores[p]; bestPeer = p; }
        }
        return bestPeer;
    }

    _hashPeerId(peerId) {
        var h = 2166136261;
        for (var i = 0; i < peerId.length; i++) {
            h ^= peerId.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return ((h >>> 0) % 1000000) + 1000;
    }

    _pruneScoresFromRoster() {
        // Sync the per-peer state maps with the current roster. This runs on
        // lobby/game/roster transitions and also admits peers who joined
        // AFTER _initMatch — without this the host skips them in
        // _sampleTrails / _checkCollisions (both gate on _alive[pid]), which
        // means collisions for late joiners never register.
        var mp = this.scene._mp;
        if (!mp || !mp.roster) return;
        var sorted = mp.roster.peers.slice().sort(function(a, b) {
            return a.peerId < b.peerId ? -1 : (a.peerId > b.peerId ? 1 : 0);
        });
        var current = {};
        var nc = this.scene._neonCycles = this.scene._neonCycles || {};
        nc.colorByPeer = nc.colorByPeer || {};
        nc.slotByPeer = nc.slotByPeer || {};
        var changed = false;
        for (var i = 0; i < sorted.length; i++) {
            var pid = sorted[i].peerId;
            current[pid] = true;
            if (!(pid in this._scores)) { this._scores[pid] = 0; changed = true; }
            if (!(pid in this._alive)) { this._alive[pid] = true; changed = true; }
            if (!(pid in this._trails)) this._trails[pid] = [];
            if (!nc.colorByPeer[pid]) nc.colorByPeer[pid] = this._palette[i % this._palette.length];
            if (nc.slotByPeer[pid] == null) nc.slotByPeer[pid] = i;
        }
        for (var k in this._scores) {
            if (!current[k]) {
                delete this._scores[k];
                delete this._alive[k];
                delete this._trails[k];
                changed = true;
            }
        }
        if (changed) this._pushScoreboard();
    }
}

// ── Pure-function helpers (hoisted; reachable inside the class) ──

function pointSegDistSq(px, pz, x1, z1, x2, z2) {
    var dx = x2 - x1, dz = z2 - z1;
    var lenSq = dx * dx + dz * dz;
    if (lenSq < 0.0001) {
        var ddx = px - x1, ddz = pz - z1;
        return ddx * ddx + ddz * ddz;
    }
    var t = ((px - x1) * dx + (pz - z1) * dz) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    var cx = x1 + dx * t, cz = z1 + dz * t;
    var rx = px - cx, rz = pz - cz;
    return rx * rx + rz * rz;
}

