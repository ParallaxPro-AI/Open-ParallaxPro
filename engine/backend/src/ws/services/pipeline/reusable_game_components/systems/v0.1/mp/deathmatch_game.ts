// also: pvp, free-for-all, kills, ffa, multiplayer, combat
// Deathmatch FFA match rules — kill count + respawn.
//
// Diffs from coin_grab_game.ts worth calling out:
//   - No pickup entity. The "score" is kills, reported by each victim's
//     own player_health when it hits zero (the victim knows who last shot
//     them because net_player_shot carries the shooter's peerId).
//   - Respawn is client-local: player_health runs a 3s timer after death,
//     resets health, and emits player_respawned. We listen for that and
//     teleport our local player to a random spawn point.
//   - Scoreboard payload includes "scoreLabel: 'kills'" so the HUD shows
//     "First to N kills" instead of a bare number.
//
// Cheat resistance is deliberately none: a malicious client can claim
// kills or ignore death. That's acceptable for a friendly FFA template.
class DeathmatchGameSystem extends GameScript {
    _roundDurationSec = 300;
    _killsToWin = 3;
    _minPlayers = 1;

    _kills = {};
    _deaths = {};
    _elapsed = 0;
    _ended = false;
    _initialized = false;
    _killFeed = []; // [{ killer, victim, tsMs }], capped + auto-expires
    _spawnPoints = [
        { x: -12, z: -12 },
        { x:  12, z: -12 },
        { x: -12, z:  12 },
        { x:  12, z:  12 },
        { x:   0, z: -15 },
        { x:   0, z:  15 },
        { x: -15, z:   0 },
        { x:  15, z:   0 },
        { x:  -8, z:  -8 },
        { x:   8, z:   8 },
    ];

    onStart() {
        var self = this;
        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });

        // Local death → broadcast a kill event + tally locally so the
        // scoreboard updates without waiting for the event to echo back.
        // player_died is a LOCAL event (emitted via scene.events.game.emit
        // with the data object passed directly), so the handler receives
        // the payload as its first arg — NOT wrapped in { from, data }
        // like net_* events are.
        this.scene.events.game.on("player_died", function(data) {
            var mp = self.scene._mp;
            if (!mp) return;
            var d = data || {};
            var killerPeerId = d.killerPeerId || "";
            var victimPeerId = mp.localPeerId;
            if (killerPeerId && killerPeerId !== victimPeerId) {
                self._kills[killerPeerId] = (self._kills[killerPeerId] || 0) + 1;
            }
            self._deaths[victimPeerId] = (self._deaths[victimPeerId] || 0) + 1;
            self._pushScoreboard();
            self._pushKillFeed(killerPeerId, victimPeerId);
            mp.sendNetworkedEvent("player_killed", {
                killerPeerId: killerPeerId,
                victimPeerId: victimPeerId,
            });
        });

        // player_health emits player_respawned after its 3s timer.
        // Teleport our local player to a fresh spawn point and tell
        // other peers so they can swap our proxy's Death anim back to
        // Idle — otherwise the body just jumps to the new spawn point
        // still face-down on the floor.
        this.scene.events.game.on("player_respawned", function() {
            self._teleportLocalToSpawn();
            var mp = self.scene._mp;
            if (mp) {
                mp.sendNetworkedEvent("player_respawn", {
                    peerId: mp.localPeerId,
                });
            }
        });

        // Another peer reported a kill. Apply to our local tallies, but
        // skip events that originated from us (already tallied above on
        // player_died so the UI doesn't flash).
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
                self._pushScoreboard();
                self._pushKillFeed(d.killerPeerId, d.victimPeerId);
            }
            // Animation on the victim's proxy plays on every peer.
            self._playAnimOnPeer(d.victimPeerId, "Death", false);
        });

        // Peer respawned — clear the Death pose on their proxy.
        this.scene.events.game.on("net_player_respawn", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.peerId) return;
            self._playAnimOnPeer(d.peerId, "Idle", true);
        });

        this.scene.events.game.on("net_match_ended", function(evt) {
            if (self._ended) return;
            self._ended = true;
            var d = (evt && evt.data) || {};
            if (d.kills)  self._kills  = d.kills;
            if (d.deaths) self._deaths = d.deaths;
            self.scene.events.game.emit("match_ended", d);
            self._pushGameOver(d.winner, d.reason);
        });

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
            self._elapsed = 0;
        });
        this.scene.events.game.on("mp_below_min_players", function() {
            if (self._ended) return;
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            self._endMatch(self._findLeader(), "abandoned");
        });
        this.scene.events.game.on("mp_phase_in_lobby", function() { self._pruneScoresFromRoster(); });
        this.scene.events.game.on("mp_phase_in_game", function() { self._pruneScoresFromRoster(); });
        this.scene.events.game.on("mp_roster_changed", function() { self._pruneScoresFromRoster(); });
    }

    onUpdate(dt) {
        var mp = this.scene._mp;
        if (!mp || !this._initialized || this._ended) return;

        this._tickRemoteAnimations(dt);

        // Expire kill-feed entries older than ~5s so the overlay doesn't
        // accumulate forever. Pushes a refreshed list only when something
        // actually left to keep UI traffic quiet during idle moments.
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

        // Win check runs host-only (one source of truth for the round end).
        if (!mp.isHost) return;
        this._elapsed += dt;
        var bestKills = -1;
        var bestPeer = null;
        for (var p in this._kills) {
            if (this._kills[p] > bestKills) { bestKills = this._kills[p]; bestPeer = p; }
        }
        if (bestKills >= this._killsToWin) {
            this._endMatch(bestPeer, "score");
        } else if (this._elapsed >= this._roundDurationSec) {
            this._endMatch(bestPeer, "time");
        }
    }

    // ─── Match setup ────────────────────────────────────────────────────

    _initMatch() {
        var mp = this.scene._mp;
        if (!mp) return;

        this._elapsed = 0;
        this._ended = false;
        this._kills = {};
        this._deaths = {};

        this._positionLocalPlayer();

        var roster = mp.roster;
        if (roster && roster.peers) {
            for (var i = 0; i < roster.peers.length; i++) {
                this._kills[roster.peers[i].peerId] = 0;
                this._deaths[roster.peers[i].peerId] = 0;
            }
        }

        this._initialized = true;
        this._pushScoreboard();
    }

    _positionLocalPlayer() {
        var mp = this.scene._mp;
        if (!mp) return;
        var player = this._findLocalPlayerEntity();
        if (!player) return;
        var sp = this._randomSpawnPoint();
        this.scene.setPosition(player.id, sp.x, 1, sp.z);
        var ni = player.getComponent("NetworkIdentityComponent");
        if (ni) {
            ni.networkId = this._hashPeerId(mp.localPeerId);
            ni.ownerId = mp.localPeerId;
            ni.isLocalPlayer = true;
        }
    }

    _teleportLocalToSpawn() {
        var player = this._findLocalPlayerEntity();
        if (!player) return;
        var sp = this._randomSpawnPoint();
        this.scene.setPosition(player.id, sp.x, 1, sp.z);
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

    _randomSpawnPoint() {
        var sp = this._spawnPoints[Math.floor(Math.random() * this._spawnPoints.length)];
        return { x: sp.x, y: 1, z: sp.z };
    }

    // ─── Match end ──────────────────────────────────────────────────────

    _endMatch(winnerPeerId, reason) {
        this._ended = true;
        var mp = this.scene._mp;
        var payload = { winner: winnerPeerId, reason: reason, kills: this._kills, deaths: this._deaths };
        if (mp) mp.sendNetworkedEvent("match_ended", payload);
        this.scene.events.game.emit("match_ended", payload);
        this._pushGameOver(winnerPeerId, reason);
        // Host tells the server the lobby is no longer playing so the
        // next Start click actually fires a state transition (and
        // everyone's isReady resets so the UI doesn't show stale flags).
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

        var myKills = (mp && this._kills[localPeerId]) || 0;

        var stats = {};
        if (roster && roster.peers) {
            var self2 = this;
            var ranked = roster.peers.slice().sort(function(a, b) {
                return (self2._kills[b.peerId] || 0) - (self2._kills[a.peerId] || 0);
            });
            for (var j = 0; j < ranked.length; j++) {
                var pr = ranked[j];
                var label = pr.username + (pr.peerId === localPeerId ? " (you)" : "");
                var k = this._kills[pr.peerId] || 0;
                var d = this._deaths[pr.peerId] || 0;
                stats[label] = k + " kills · " + d + " deaths";
            }
        }
        if (reason === "time")      stats["Reason"] = "Time up";
        else if (reason === "score")     stats["Reason"] = "Reached " + this._killsToWin + " kills";
        else if (reason === "abandoned") stats["Reason"] = "Too few players";

        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: myKills, stats: stats },
        });
    }

    // ─── UI ─────────────────────────────────────────────────────────────

    // ─── Kill feed ──────────────────────────────────────────────────────

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
        // Cap at 6 entries so the overlay never grows unboundedly.
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
        return peerId.slice(0, 6);
    }

    // ─── Remote proxy animations ────────────────────────────────────────

    _playAnimOnPeer(peerId, animName, loop) {
        if (!peerId) return;
        var ent = this._findPlayerByPeerId(peerId);
        if (ent && ent.playAnimation) {
            try { ent.playAnimation(animName, { loop: !!loop }); } catch (e) { /* no anim */ }
        }
    }

    // Drive Idle/Walk/Run/Jump on every remote player proxy. fps_movement
    // calls _playAnim for the local player but bails on !isLocalPlayer,
    // and the network adapter spawns proxies with skipBehaviors=true so
    // no behavior runs on them. Without this loop other peers see the
    // moving proxy stuck in T-pose / last clip. Velocity is derived from
    // observed position deltas because the owner's velocity isn't a
    // networkedVar; speed thresholds mirror fps_movement (~6 walk, ~10
    // sprint with a small margin) so the choice matches what the local
    // peer would have picked.
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
            // Vertical-velocity grounded check. The previous raycast version
            // started at `pos.y - 0.3` going downward — for Quaternius
            // characters (feet-at-origin pivot), that's BELOW the floor, so
            // the raycast always missed and stationary remote players were
            // stuck looping the Jump anim. Reading the collider's bottom
            // didn't help either: scene.raycast's exclusion is hard-coded to
            // the entity named "Player" so the proxy isn't excluded, and a
            // raycast starting inside its own capsule self-hits at distance
            // 0. Using `|dy|` instead is mesh- and pivot-agnostic: the
            // proxy's transform.position is fed by snapshots from the owner,
            // who sees |vy| ≈ 7 when jumping (jumpForce), |vy| ≤ 0.2 when
            // standing or walking on flat ground. Threshold 1.5 m/s catches
            // jumps + falls, leaves a wide margin for stair-step bobbing
            // and snapshot interpolation noise.
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

    _findPlayerByPeerId(peerId) {
        var players = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            var ni = p.getComponent("NetworkIdentityComponent");
            if (ni && ni.ownerId === peerId) return p;
        }
        return null;
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
                    score: this._kills[pr.peerId] || 0,
                    deaths: this._deaths[pr.peerId] || 0,
                    isLocal: pr.peerId === mp.localPeerId,
                });
            }
        }
        list.sort(function(a, b) { return b.score - a.score; });
        this.scene.events.ui.emit("hud_update", {
            scoreboard: { players: list, scoreToWin: this._killsToWin, scoreLabel: "kills" },
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

    _findLeader() {
        var bestKills = -1;
        var bestPeer = null;
        for (var p in this._kills) {
            if (this._kills[p] > bestKills) { bestKills = this._kills[p]; bestPeer = p; }
        }
        return bestPeer;
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
                changed = true;
            }
        }
        if (changed) this._pushScoreboard();
    }
}
