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
    _killsToWin = 20;
    _minPlayers = 1;

    _kills = {};
    _deaths = {};
    _elapsed = 0;
    _ended = false;
    _initialized = false;
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
        this.scene.events.game.on("player_died", function(evt) {
            var mp = self.scene._mp;
            if (!mp) return;
            var d = (evt && evt.data) || {};
            var killerPeerId = d.killerPeerId || "";
            var victimPeerId = mp.localPeerId;
            if (killerPeerId && killerPeerId !== victimPeerId) {
                self._kills[killerPeerId] = (self._kills[killerPeerId] || 0) + 1;
            }
            self._deaths[victimPeerId] = (self._deaths[victimPeerId] || 0) + 1;
            self._pushScoreboard();
            mp.sendNetworkedEvent("player_killed", {
                killerPeerId: killerPeerId,
                victimPeerId: victimPeerId,
            });
        });

        // player_health emits player_respawned after its 3s timer.
        // Teleport our local player to a fresh spawn point.
        this.scene.events.game.on("player_respawned", function() {
            self._teleportLocalToSpawn();
        });

        // Another peer reported a kill. Apply to our local tallies, but
        // skip events that originated from us (already tallied above on
        // player_died so the UI doesn't flash).
        this.scene.events.game.on("net_player_killed", function(evt) {
            var d = (evt && evt.data) || {};
            var mp2 = self.scene._mp;
            if (mp2 && d.victimPeerId === mp2.localPeerId) return;
            if (d.killerPeerId && d.killerPeerId !== d.victimPeerId) {
                self._kills[d.killerPeerId] = (self._kills[d.killerPeerId] || 0) + 1;
            }
            if (d.victimPeerId) {
                self._deaths[d.victimPeerId] = (self._deaths[d.victimPeerId] || 0) + 1;
            }
            self._pushScoreboard();
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
