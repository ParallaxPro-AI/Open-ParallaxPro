// also: flag, ctf, team, capture, base, multiplayer
// Banner Siege — capture-the-flag match rules.
//
// Two teams (red, blue) each with a banner parked on a pedestal at their
// base. Pick up the enemy banner, carry it to your own base while YOUR
// banner is still home, and touch the capture pedestal to score. First
// team to capturesToWin captures (or highest score when the round timer
// expires) wins.
//
// Authority model: host assigns teams + spawn slots on match_started and
// broadcasts once via net_team_assignment; the result is cached so peers
// that arrive late (rare in our lobbies) still have something to apply.
// Pickup / capture / drop detection runs on EVERY peer for its own local
// player — instant feedback, same pattern as coin_grab_game. The deciding
// peer broadcasts the transition as a networked event so everyone's state
// stays in sync. Win condition + round timer are host-only (single source
// of truth).
//
// Flag entities are placed in 03_worlds.json at base positions with tags
// like "flag" + "flag_red" / "flag_blue". Each frame, for every flag, the
// system computes where it should be based on its logical state (in base,
// carried, or dropped) and slams the transform. No physics sync required —
// everyone derives the same visual from the same shared logical state, so
// it's effectively free.
class BannerSiegeGameSystem extends GameScript {
    // ─── Tunable parameters (injected from 04_systems.json params) ─────
    _roundDurationSec = 300;
    _capturesToWin = 3;
    _flagReturnTimeoutSec = 30;
    _captureRadius = 2.5;
    _pickupRadius = 1.8;
    _flagCarryHeight = 2.2;
    _flagBaseY = 1.2;
    _redBaseX = -25;
    _redBaseZ = 0;
    _blueBaseX = 25;
    _blueBaseZ = 0;

    // ─── Runtime state ─────────────────────────────────────────────────
    _redScore = 0;
    _blueScore = 0;
    _kills = {};
    _deaths = {};
    _captures = {};  // per-peer capture count for scoreboard
    _elapsed = 0;
    _ended = false;
    _initialized = false;
    _teamAssignments = {};  // peerId → "red" | "blue"
    _teamSlots = {};        // peerId → slot index within their team (for spawn points)
    _myTeam = "";
    _flags = null;          // { red: {...}, blue: {...} } — set in _initMatch
    _redSpawnPoints = [
        { x: -28, z: -4 },
        { x: -28, z:  4 },
        { x: -25, z: -7 },
        { x: -25, z:  7 },
        { x: -22, z:  0 },
    ];
    _blueSpawnPoints = [
        { x:  28, z: -4 },
        { x:  28, z:  4 },
        { x:  25, z: -7 },
        { x:  25, z:  7 },
        { x:  22, z:  0 },
    ];
    _checkTimer = 0;
    _lastLocalPickupAt = 0;
    _lastLocalCaptureAt = 0;
    _killFeed = [];
    _announceText = "";
    _announceTimer = 0;
    _captureFlashTimer = 0;
    _captureFlashTeam = "";

    onStart() {
        var self = this;

        // Mirror the coin_grab approach: the FSM fires match_started the
        // same frame it activates this system, so onStart runs one frame
        // later and misses the event. Init immediately.
        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });

        // ── Local player died → if carrying a flag, drop it at their pos ──
        this.scene.events.game.on("player_died", function(data) {
            var mp = self.scene._mp;
            if (!mp) return;
            var localPeerId = mp.localPeerId;
            var d = data || {};
            var killerPeerId = d.killerPeerId || "";

            // Tally kills/deaths locally so the scoreboard updates immediately.
            if (killerPeerId && killerPeerId !== localPeerId) {
                self._kills[killerPeerId] = (self._kills[killerPeerId] || 0) + 1;
            }
            self._deaths[localPeerId] = (self._deaths[localPeerId] || 0) + 1;
            self._pushKillFeed(killerPeerId, localPeerId);
            self._pushScoreboard();
            mp.sendNetworkedEvent("player_killed", {
                killerPeerId: killerPeerId,
                victimPeerId: localPeerId,
            });

            // Drop whichever flag I was holding, at my current position.
            var carriedTeam = self._whichFlagLocalCarries();
            if (carriedTeam) {
                var p = self._findLocalPlayerEntity();
                var dropX = 0, dropZ = 0;
                if (p) { dropX = p.transform.position.x; dropZ = p.transform.position.z; }
                self._applyFlagDrop(carriedTeam, localPeerId, dropX, dropZ);
                mp.sendNetworkedEvent("flag_dropped", {
                    flagTeam: carriedTeam,
                    peerId: localPeerId,
                    x: dropX,
                    z: dropZ,
                });
                self.scene.events.game.emit("flag_dropped", {
                    peerId: localPeerId,
                    flagTeam: carriedTeam,
                    x: dropX,
                    z: dropZ,
                });
            }
        });

        // Respawn handler → teleport to team spawn point. Also tell remote
        // peers so they can swap our proxy's Death anim back to Idle.
        this.scene.events.game.on("player_respawned", function() {
            self._teleportLocalToSpawn();
            var mp = self.scene._mp;
            if (mp) {
                mp.sendNetworkedEvent("player_respawn", {
                    peerId: mp.localPeerId,
                });
            }
        });

        // ── Networked events from other peers ──
        this.scene.events.game.on("net_team_assignment", function(evt) {
            var d = (evt && evt.data) || {};
            if (d.assignments) {
                self._teamAssignments = d.assignments;
                if (d.slots) self._teamSlots = d.slots;
                self._updateMyTeam();
                self._teleportLocalToSpawn();
                self._pushScoreboard();
                self._pushHud();
            }
        });

        this.scene.events.game.on("net_flag_picked_up", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.flagTeam || !d.peerId) return;
            self._applyFlagPickup(d.flagTeam, d.peerId);
        });

        this.scene.events.game.on("net_flag_dropped", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.flagTeam) return;
            self._applyFlagDrop(d.flagTeam, d.peerId || "", Number(d.x) || 0, Number(d.z) || 0);
        });

        this.scene.events.game.on("net_flag_returned", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.flagTeam) return;
            self._applyFlagReturn(d.flagTeam, d.reason || "auto");
        });

        this.scene.events.game.on("net_flag_captured", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.flagTeam || !d.team || !d.peerId) return;
            self._applyFlagCapture(d.team, d.flagTeam, d.peerId);
        });

        this.scene.events.game.on("net_player_killed", function(evt) {
            var d = (evt && evt.data) || {};
            var mp2 = self.scene._mp;
            var ownKill = (mp2 && d.victimPeerId === mp2.localPeerId);
            if (!ownKill) {
                if (d.killerPeerId && d.killerPeerId !== d.victimPeerId) {
                    self._kills[d.killerPeerId] = (self._kills[d.killerPeerId] || 0) + 1;
                }
                if (d.victimPeerId) {
                    self._deaths[d.victimPeerId] = (self._deaths[d.victimPeerId] || 0) + 1;
                }
                self._pushKillFeed(d.killerPeerId, d.victimPeerId);
                self._pushScoreboard();
            }
            self._playAnimOnPeer(d.victimPeerId, "Death", false);
        });

        this.scene.events.game.on("net_player_respawn", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.peerId) return;
            self._playAnimOnPeer(d.peerId, "Idle", true);
        });

        this.scene.events.game.on("net_match_ended", function(evt) {
            if (self._ended) return;
            self._ended = true;
            var d = (evt && evt.data) || {};
            if (typeof d.redScore === "number")  self._redScore  = d.redScore;
            if (typeof d.blueScore === "number") self._blueScore = d.blueScore;
            if (d.kills)  self._kills  = d.kills;
            if (d.deaths) self._deaths = d.deaths;
            self.scene.events.game.emit("match_ended", { winner: d.winner, reason: d.reason });
            self._pushGameOver(d.winner, d.reason);
        });

        // ── Session lifecycle ──
        this.scene.events.game.on("mp_host_changed", function() {
            if (self._ended || !self._initialized) return;
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            var roster = mp2.roster;
            if (roster && roster.peers.length < ((roster.minPlayers) || 1)) {
                self._endMatch(self._decideWinner(), "abandoned");
                return;
            }
            // Re-broadcast current team assignments so late joiners / new
            // host resyncs have a fresh copy.
            self._broadcastTeamAssignments();
            self._elapsed = 0;
        });

        this.scene.events.game.on("mp_below_min_players", function() {
            if (self._ended) return;
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            self._endMatch(self._decideWinner(), "abandoned");
        });

        this.scene.events.game.on("mp_phase_in_lobby",  function() { self._pruneScoresFromRoster(); });
        this.scene.events.game.on("mp_phase_in_game",   function() { self._pruneScoresFromRoster(); });
        this.scene.events.game.on("mp_roster_changed",  function() { self._pruneScoresFromRoster(); });
    }

    onUpdate(dt) {
        var mp = this.scene._mp;
        if (!mp || !this._initialized || this._ended) return;

        this._tickRemoteAnimations(dt);

        // Kill-feed expiry (same 5s cutoff as deathmatch).
        if (this._killFeed.length > 0) {
            var now = Date.now();
            var cutoff = now - 5000;
            var kept = [];
            for (var kf = 0; kf < this._killFeed.length; kf++) {
                if (this._killFeed[kf].tsMs > cutoff) kept.push(this._killFeed[kf]);
            }
            if (kept.length !== this._killFeed.length) {
                this._killFeed = kept;
                this._pushKillFeedState();
            }
        }

        // Announce banner ("Banner captured!" etc.) ticks down so the HUD
        // can clear it after a couple of seconds.
        if (this._announceTimer > 0) {
            this._announceTimer -= dt;
            if (this._announceTimer <= 0) {
                this._announceText = "";
                this._pushHud();
            }
        }
        if (this._captureFlashTimer > 0) {
            this._captureFlashTimer -= dt;
            if (this._captureFlashTimer <= 0) {
                this._captureFlashTeam = "";
                this._pushHud();
            }
        }

        // Update flag entity positions every frame — carrier follow or
        // static base/drop position.
        this._updateFlagPositions();

        // Local pickup / capture / return detection (20 Hz, same cadence
        // as coin_grab's check loop — avoids spamming the physics bus).
        this._checkTimer += dt;
        if (this._checkTimer >= 0.05) {
            this._checkTimer = 0;
            this._checkLocalFlagInteractions();
        }

        // Round timer + dropped-flag auto-return + win check → host only.
        if (!mp.isHost) return;
        this._elapsed += dt;
        this._tickFlagReturnTimers(dt);

        // Timer HUD update (once per second is plenty).
        var prevTimeUpdate = this._elapsed - dt;
        if (Math.floor(prevTimeUpdate) !== Math.floor(this._elapsed)) {
            this._pushHud();
        }

        if (this._redScore >= this._capturesToWin) {
            this._endMatch("red", "score");
        } else if (this._blueScore >= this._capturesToWin) {
            this._endMatch("blue", "score");
        } else if (this._elapsed >= this._roundDurationSec) {
            this._endMatch(this._decideWinner(), "time");
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Match init + teardown
    // ═══════════════════════════════════════════════════════════════════

    _initMatch() {
        var mp = this.scene._mp;
        if (!mp) return;

        this._elapsed = 0;
        this._ended = false;
        this._redScore = 0;
        this._blueScore = 0;
        this._kills = {};
        this._deaths = {};
        this._captures = {};
        this._killFeed = [];
        this._announceText = "";
        this._announceTimer = 0;
        this._captureFlashTimer = 0;
        this._captureFlashTeam = "";
        this._teamAssignments = {};
        this._teamSlots = {};
        this._myTeam = "";

        // Reset flag logical state.
        this._flags = {
            red:  { carrier: null, droppedAt: null, droppedTimer: 0, inBase: true },
            blue: { carrier: null, droppedAt: null, droppedTimer: 0, inBase: true },
        };

        // Host assigns teams deterministically: sort peerIds, alternate.
        var roster = mp.roster;
        if (roster && roster.peers) {
            for (var i = 0; i < roster.peers.length; i++) {
                var pid = roster.peers[i].peerId;
                this._kills[pid] = 0;
                this._deaths[pid] = 0;
                this._captures[pid] = 0;
            }
        }

        this._stampLocalNetworkIdentity();

        if (mp.isHost) {
            this._computeTeamAssignments();
            this._broadcastTeamAssignments();
        }
        this._updateMyTeam();
        this._teleportLocalToSpawn();

        this._initialized = true;
        this._pushScoreboard();
        this._pushHud();
    }

    _stampLocalNetworkIdentity() {
        var mp = this.scene._mp;
        if (!mp) return;
        var player = this._findLocalPlayerEntity();
        if (!player) return;
        var ni = player.getComponent("NetworkIdentityComponent");
        if (ni) {
            ni.networkId = this._hashPeerId(mp.localPeerId);
            ni.ownerId = mp.localPeerId;
            ni.isLocalPlayer = true;
        }
    }

    _computeTeamAssignments() {
        var mp = this.scene._mp;
        if (!mp || !mp.roster) return;
        var peerIds = mp.roster.peers.map(function(p) { return p.peerId; }).sort();
        var assignments = {};
        var slots = {};
        var redCount = 0, blueCount = 0;
        for (var i = 0; i < peerIds.length; i++) {
            if (i % 2 === 0) {
                assignments[peerIds[i]] = "red";
                slots[peerIds[i]] = redCount++;
            } else {
                assignments[peerIds[i]] = "blue";
                slots[peerIds[i]] = blueCount++;
            }
        }
        this._teamAssignments = assignments;
        this._teamSlots = slots;
    }

    _broadcastTeamAssignments() {
        var mp = this.scene._mp;
        if (!mp) return;
        mp.sendNetworkedEvent("team_assignment", {
            assignments: this._teamAssignments,
            slots: this._teamSlots,
        });
    }

    _updateMyTeam() {
        var mp = this.scene._mp;
        if (!mp) return;
        this._myTeam = this._teamAssignments[mp.localPeerId] || "";
    }

    // ═══════════════════════════════════════════════════════════════════
    // Flag state transitions
    // ═══════════════════════════════════════════════════════════════════

    _applyFlagPickup(flagTeam, peerId) {
        var f = this._flags && this._flags[flagTeam];
        if (!f) return;
        f.carrier = peerId;
        f.droppedAt = null;
        f.droppedTimer = 0;
        f.inBase = false;
        var carrierTeam = this._teamAssignments[peerId] || "";
        this._setAnnounce((flagTeam === "red" ? "RED" : "BLUE") + " BANNER TAKEN", 2.0);
        this._pushHud();
    }

    _applyFlagDrop(flagTeam, peerId, x, z) {
        var f = this._flags && this._flags[flagTeam];
        if (!f) return;
        f.carrier = null;
        f.droppedAt = { x: x, z: z };
        f.droppedTimer = this._flagReturnTimeoutSec;
        f.inBase = false;
        this._pushHud();
    }

    _applyFlagReturn(flagTeam, reason) {
        var f = this._flags && this._flags[flagTeam];
        if (!f) return;
        f.carrier = null;
        f.droppedAt = null;
        f.droppedTimer = 0;
        f.inBase = true;
        var text = (flagTeam === "red" ? "RED" : "BLUE") + " BANNER RETURNED";
        this._setAnnounce(text, 1.8);
        this._pushHud();
    }

    _applyFlagCapture(scoringTeam, flagTeam, peerId) {
        if (scoringTeam === "red")  this._redScore++;
        if (scoringTeam === "blue") this._blueScore++;
        this._captures[peerId] = (this._captures[peerId] || 0) + 1;

        // Reset the captured flag back to its base.
        this._applyFlagReturn(flagTeam, "captured");

        // Fire the flashy "CAPTURE!" overlay + short announce text.
        this._captureFlashTeam = scoringTeam;
        this._captureFlashTimer = 2.5;
        this._setAnnounce((scoringTeam === "red" ? "RED" : "BLUE") + " SCORES!", 2.5);
        this._pushScoreboard();
        this._pushHud();
    }

    // ═══════════════════════════════════════════════════════════════════
    // Local interaction checks (pickup, capture, return)
    // ═══════════════════════════════════════════════════════════════════

    _checkLocalFlagInteractions() {
        var mp = this.scene._mp;
        if (!mp) return;
        var localPeerId = mp.localPeerId;
        if (!localPeerId || !this._myTeam) return;

        var player = this._findLocalPlayerEntity();
        if (!player) return;
        var ni = player.getComponent("NetworkIdentityComponent");
        if (!ni || !ni.isLocalPlayer) return;

        // No pickup while dead.
        var health = player.getScript ? player.getScript("PlayerHealthBehavior") : null;
        if (health && health._dead) return;

        var pp = player.transform.position;
        var now = Date.now();

        var enemyTeam = (this._myTeam === "red") ? "blue" : "red";

        // ── Capture check: standing on own base pedestal with enemy flag ──
        if (this._flags[enemyTeam].carrier === localPeerId) {
            if (now - this._lastLocalCaptureAt > 500) {
                var myBase = this._teamBasePos(this._myTeam);
                var dxC = pp.x - myBase.x;
                var dzC = pp.z - myBase.z;
                if (dxC * dxC + dzC * dzC < this._captureRadius * this._captureRadius) {
                    // Must have own flag home to score. This is classic CTF
                    // rules — no "score while enemy has your flag" cheese.
                    if (this._flags[this._myTeam].inBase) {
                        this._lastLocalCaptureAt = now;
                        this._applyFlagCapture(this._myTeam, enemyTeam, localPeerId);
                        mp.sendNetworkedEvent("flag_captured", {
                            team: this._myTeam,
                            flagTeam: enemyTeam,
                            peerId: localPeerId,
                        });
                        this.scene.events.game.emit("flag_captured", {
                            peerId: localPeerId,
                            team: this._myTeam,
                            flagTeam: enemyTeam,
                        });
                        this.scene.events.game.emit("team_score_changed", {
                            red: this._redScore,
                            blue: this._blueScore,
                        });
                        return;
                    }
                }
            }
        }

        // ── Pickup check: touching enemy banner (in base or dropped) ──
        if (now - this._lastLocalPickupAt > 300) {
            var enemyFlag = this._flags[enemyTeam];
            if (!enemyFlag.carrier) {
                var ef = this._flagPosition(enemyTeam);
                var dxP = pp.x - ef.x;
                var dzP = pp.z - ef.z;
                if (dxP * dxP + dzP * dzP < this._pickupRadius * this._pickupRadius) {
                    this._lastLocalPickupAt = now;
                    this._applyFlagPickup(enemyTeam, localPeerId);
                    mp.sendNetworkedEvent("flag_picked_up", {
                        flagTeam: enemyTeam,
                        peerId: localPeerId,
                        team: this._myTeam,
                    });
                    this.scene.events.game.emit("flag_picked_up", {
                        peerId: localPeerId,
                        team: this._myTeam,
                        flagTeam: enemyTeam,
                    });
                    return;
                }
            }
        }

        // ── Touch own team's dropped flag → returns it ──
        var ownFlag = this._flags[this._myTeam];
        if (ownFlag.droppedAt && !ownFlag.carrier) {
            var dx = pp.x - ownFlag.droppedAt.x;
            var dz = pp.z - ownFlag.droppedAt.z;
            if (dx * dx + dz * dz < this._pickupRadius * this._pickupRadius) {
                this._applyFlagReturn(this._myTeam, "touch");
                mp.sendNetworkedEvent("flag_returned", {
                    flagTeam: this._myTeam,
                    reason: "touch",
                });
                this.scene.events.game.emit("flag_returned", {
                    flagTeam: this._myTeam,
                    reason: "touch",
                });
            }
        }
    }

    _whichFlagLocalCarries() {
        var mp = this.scene._mp;
        if (!mp || !this._flags) return "";
        var lp = mp.localPeerId;
        if (this._flags.red.carrier === lp)  return "red";
        if (this._flags.blue.carrier === lp) return "blue";
        return "";
    }

    // ═══════════════════════════════════════════════════════════════════
    // Flag visual positioning + timers
    // ═══════════════════════════════════════════════════════════════════

    _updateFlagPositions() {
        if (!this._flags) return;
        this._moveFlagEntity("red");
        this._moveFlagEntity("blue");
    }

    _moveFlagEntity(team) {
        var flagEnts = this.scene.findEntitiesByTag
            ? this.scene.findEntitiesByTag("flag_" + team)
            : [];
        if (!flagEnts || flagEnts.length === 0) return;
        var f = this._flags[team];
        var p = this._flagPosition(team);
        var y = f.carrier ? this._flagCarryHeight : this._flagBaseY;
        for (var i = 0; i < flagEnts.length; i++) {
            this.scene.setPosition(flagEnts[i].id, p.x, y, p.z);
        }
    }

    _flagPosition(team) {
        var f = this._flags[team];
        if (f.carrier) {
            var ent = this._findPlayerByPeerId(f.carrier);
            if (ent) {
                var p = ent.transform.position;
                return { x: p.x, z: p.z };
            }
        }
        if (f.droppedAt) return { x: f.droppedAt.x, z: f.droppedAt.z };
        return this._teamBasePos(team);
    }

    _tickFlagReturnTimers(dt) {
        var mp = this.scene._mp;
        if (!mp || !mp.isHost || !this._flags) return;
        for (var team in this._flags) {
            var f = this._flags[team];
            if (f.droppedAt && f.droppedTimer > 0) {
                f.droppedTimer -= dt;
                if (f.droppedTimer <= 0) {
                    this._applyFlagReturn(team, "timeout");
                    mp.sendNetworkedEvent("flag_returned", {
                        flagTeam: team,
                        reason: "timeout",
                    });
                    this.scene.events.game.emit("flag_returned", {
                        flagTeam: team,
                        reason: "timeout",
                    });
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Match end
    // ═══════════════════════════════════════════════════════════════════

    _endMatch(winnerTeam, reason) {
        this._ended = true;
        var mp = this.scene._mp;
        var payload = {
            winner: winnerTeam || "",
            reason: reason,
            redScore: this._redScore,
            blueScore: this._blueScore,
            kills: this._kills,
            deaths: this._deaths,
        };
        if (mp) mp.sendNetworkedEvent("match_ended", payload);
        this.scene.events.game.emit("match_ended", { winner: winnerTeam || "", reason: reason });
        this._pushGameOver(winnerTeam, reason);
        if (mp && mp.isHost && mp.endMatch) mp.endMatch();
    }

    _decideWinner() {
        if (this._redScore > this._blueScore)  return "red";
        if (this._blueScore > this._redScore)  return "blue";
        return "";
    }

    _pushGameOver(winnerTeam, reason) {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        var localPeerId = mp && mp.localPeerId;
        var iWon = winnerTeam && this._myTeam === winnerTeam;

        var title;
        if (!winnerTeam) title = "Draw!";
        else if (iWon) title = "VICTORY!";
        else title = (winnerTeam === "red" ? "RED" : "BLUE") + " WINS";

        var myCaptures = (mp && this._captures[localPeerId]) || 0;

        var stats = {};
        stats["Red"]  = this._redScore + " captures";
        stats["Blue"] = this._blueScore + " captures";
        if (roster && roster.peers) {
            var self2 = this;
            var ranked = roster.peers.slice().sort(function(a, b) {
                return ((self2._captures[b.peerId] || 0) * 100 + (self2._kills[b.peerId] || 0))
                     - ((self2._captures[a.peerId] || 0) * 100 + (self2._kills[a.peerId] || 0));
            });
            for (var j = 0; j < ranked.length; j++) {
                var pr = ranked[j];
                var tag = self2._teamAssignments[pr.peerId] === "red" ? "R" : (self2._teamAssignments[pr.peerId] === "blue" ? "B" : "?");
                var label = "[" + tag + "] " + pr.username + (pr.peerId === localPeerId ? " (you)" : "");
                var cap = self2._captures[pr.peerId] || 0;
                var k = self2._kills[pr.peerId] || 0;
                var d = self2._deaths[pr.peerId] || 0;
                stats[label] = cap + " caps · " + k + "k · " + d + "d";
            }
        }
        if      (reason === "time")      stats["Reason"] = "Time up";
        else if (reason === "score")     stats["Reason"] = "Reached " + this._capturesToWin + " captures";
        else if (reason === "abandoned") stats["Reason"] = "Too few players";

        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: myCaptures, stats: stats },
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Spawning / entity lookup
    // ═══════════════════════════════════════════════════════════════════

    _teleportLocalToSpawn() {
        var mp = this.scene._mp;
        if (!mp) return;
        var player = this._findLocalPlayerEntity();
        if (!player) return;
        var sp = this._localSpawnPoint();
        this.scene.setPosition(player.id, sp.x, 1, sp.z);
    }

    _localSpawnPoint() {
        var mp = this.scene._mp;
        if (!mp) return { x: 0, z: 0 };
        var team = this._teamAssignments[mp.localPeerId] || "";
        var slot = this._teamSlots[mp.localPeerId] || 0;
        var points = (team === "blue") ? this._blueSpawnPoints : this._redSpawnPoints;
        var sp = points[slot % points.length];
        return { x: sp.x, z: sp.z };
    }

    _teamBasePos(team) {
        if (team === "red")  return { x: this._redBaseX,  z: this._redBaseZ };
        if (team === "blue") return { x: this._blueBaseX, z: this._blueBaseZ };
        return { x: 0, z: 0 };
    }

    _findLocalPlayerEntity() {
        var players = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            var tags = p.tags;
            var hasRemote = false;
            if (tags) {
                if (typeof tags.has === "function") hasRemote = tags.has("remote");
                else if (tags.indexOf) hasRemote = tags.indexOf("remote") >= 0;
            }
            if (hasRemote) continue;
            var ni = p.getComponent("NetworkIdentityComponent");
            if (ni && ni.isLocalPlayer) return p;
        }
        return players[0] || null;
    }

    _findPlayerByPeerId(peerId) {
        var players = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            var ni = p.getComponent("NetworkIdentityComponent");
            if (ni && ni.ownerId === peerId) return p;
        }
        return null;
    }

    _playAnimOnPeer(peerId, animName, loop) {
        if (!peerId) return;
        var ent = this._findPlayerByPeerId(peerId);
        if (ent && ent.playAnimation) {
            try { ent.playAnimation(animName, { loop: !!loop }); } catch (e) { /* no anim */ }
        }
    }

    // Drive Idle/Walk/Run/Jump on every remote player proxy. fps_movement
    // gates _playAnim on isLocalPlayer and the network adapter spawns
    // proxies with skipBehaviors=true, so without this loop other peers
    // see the moving proxy stuck in T-pose / last clip. Velocity is
    // derived from observed position deltas because the owner's velocity
    // isn't a networkedVar; speed thresholds mirror fps_movement (~6
    // walk, ~10 sprint with a small margin).
    _tickRemoteAnimations(dt) {
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        if (!all || all.length === 0) return;
        if (!this._remoteAnimState) this._remoteAnimState = {};
        var step = dt > 0 ? dt : 1 / 60;
        for (var i = 0; i < all.length; i++) {
            var p = all[i];
            if (!p || !p.transform || !p.playAnimation) continue;
            var ni = p.getComponent ? p.getComponent("NetworkIdentityComponent") : null;
            if (!ni || ni.isLocalPlayer) continue;
            var key = String(ni.ownerId || ni.networkId || p.id);
            var st = this._remoteAnimState[key];
            var pos = p.transform.position;
            if (!st) {
                this._remoteAnimState[key] = { x: pos.x, y: pos.y, z: pos.z, anim: "" };
                continue;
            }
            var dx = (pos.x - st.x) / step;
            var dy = (pos.y - st.y) / step;
            var dz = (pos.z - st.z) / step;
            st.x = pos.x; st.y = pos.y; st.z = pos.z;

            var spd = Math.sqrt(dx * dx + dz * dz);
            // Vertical-velocity grounded check; the prior raycast version
            // started below the feet on Quaternius models (origin at the
            // feet) and missed the floor, so stationary remote players were
            // stuck looping the Jump anim. See deathmatch_game for the full
            // write-up. |dy| > 1.5 m/s is the same threshold used there.
            var airborne = Math.abs(dy) > 1.5;
            var anim;
            if (airborne)       anim = "Jump";
            else if (spd > 7.5) anim = "Run";
            else if (spd > 0.5) anim = "Walk";
            else                anim = "Idle";
            if (anim !== st.anim) {
                st.anim = anim;
                try { p.playAnimation(anim, { loop: true }); } catch (e) { /* missing clip */ }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // UI feed / HUD payloads
    // ═══════════════════════════════════════════════════════════════════

    _pushHud() {
        var mp = this.scene._mp;
        var localPeerId = mp && mp.localPeerId;
        var carriedFlagTeam = this._whichFlagLocalCarries();
        var remaining = Math.max(0, Math.floor(this._roundDurationSec - this._elapsed));
        var mins = Math.floor(remaining / 60);
        var secs = remaining % 60;
        var timeStr = mins + ":" + (secs < 10 ? "0" : "") + secs;

        this.scene.events.ui.emit("hud_update", {
            bannerSiege: {
                redScore: this._redScore,
                blueScore: this._blueScore,
                capturesToWin: this._capturesToWin,
                matchTime: timeStr,
                myTeam: this._myTeam,
                carrying: carriedFlagTeam,   // "" | "red" | "blue"
                redFlag:  this._flagHudStatus("red"),
                blueFlag: this._flagHudStatus("blue"),
                announce: this._announceText,
                captureFlash: this._captureFlashTeam,
            },
        });
    }

    _flagHudStatus(team) {
        var f = this._flags && this._flags[team];
        if (!f) return "base";
        if (f.carrier) return "carried";
        if (f.droppedAt) return "dropped";
        return "base";
    }

    _setAnnounce(text, seconds) {
        this._announceText = text;
        this._announceTimer = seconds;
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
        return peerId ? peerId.slice(0, 6) : "";
    }

    _pushScoreboard() {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        var list = [];
        if (roster && roster.peers) {
            for (var i = 0; i < roster.peers.length; i++) {
                var pr = roster.peers[i];
                list.push({
                    peerId: pr.peerId,
                    username: pr.username,
                    score: this._captures[pr.peerId] || 0,
                    kills: this._kills[pr.peerId] || 0,
                    deaths: this._deaths[pr.peerId] || 0,
                    team: this._teamAssignments[pr.peerId] || "",
                    isLocal: pr.peerId === mp.localPeerId,
                });
            }
        }
        list.sort(function(a, b) { return (b.score - a.score) || (b.kills - a.kills); });
        this.scene.events.ui.emit("hud_update", {
            scoreboard: {
                players: list,
                scoreToWin: this._capturesToWin,
                scoreLabel: "captures",
            },
        });
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
        var mp = this.scene._mp;
        if (!mp || !mp.roster) return;
        var current = {};
        for (var i = 0; i < mp.roster.peers.length; i++) {
            current[mp.roster.peers[i].peerId] = true;
        }
        var changed = false;
        for (var k in this._kills) {
            if (!current[k]) {
                delete this._kills[k];
                delete this._deaths[k];
                delete this._captures[k];
                delete this._teamAssignments[k];
                delete this._teamSlots[k];
                changed = true;
            }
        }
        // If a carrier disconnected, drop their flag at their last position
        // (approx — just at the base's zone for simplicity, since we no
        // longer have the proxy).
        if (this._flags) {
            for (var team in this._flags) {
                var f = this._flags[team];
                if (f.carrier && !current[f.carrier]) {
                    var mp2 = this.scene._mp;
                    if (mp2 && mp2.isHost) {
                        var basePos = this._teamBasePos(team === "red" ? "blue" : "red");
                        this._applyFlagDrop(team, "", basePos.x, basePos.z);
                        mp2.sendNetworkedEvent("flag_dropped", {
                            flagTeam: team,
                            peerId: "",
                            x: basePos.x,
                            z: basePos.z,
                        });
                    }
                }
            }
        }
        if (changed) this._pushScoreboard();
    }
}
