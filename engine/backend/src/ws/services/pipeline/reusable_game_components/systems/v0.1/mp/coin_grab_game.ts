// Coin Grab match rules — host-authoritative.
//
// On match_started, every peer:
//   - Patches its local player entity with a stable networkId (hashed from
//     peerId) and ownerId (the peerId itself) so remote peers can tell the
//     snapshots apart.
//   - Teleports its local player to a unique spawn position on a ring so
//     the arena doesn't start with everyone stacked at the origin.
//
// The lobby host additionally:
//   - Spawns a single coin at a random point in the arena.
//   - Every tick, checks whether any player's capsule is within
//     pickupRadius of the coin. The first one (per frame) scores +1, the
//     coin relocates, and "coin_collected" is broadcast as a net.* event.
//   - Runs the round timer and checks the win condition.
//
// Clients see the coin + score purely via snapshots and net_coin_collected
// events. Nothing here is security-critical — host trust is accepted.
class CoinGrabGameSystem extends GameScript {
    _roundDurationSec = 180;
    _scoreToWin = 10;
    _pickupRadius = 1.5;

    _scores = {};
    _elapsed = 0;
    _ended = false;
    _initialized = false;
    _coinCheckTimer = 0;
    _coinEntityName = "Coin";
    _lastLocalGrabAt = 0;

    onStart() {
        var self = this;
        // The FSM activates this system when entering gameplay, which also
        // fires game.match_started in the same frame. onStart runs one
        // frame later, so by the time we'd subscribe via .on the event is
        // already gone. Init directly instead.
        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });

        this.scene.events.game.on("net_coin_collected", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.peerId) return;
            self._scores[d.peerId] = d.score || 0;
            if (typeof d.coinX === "number" && typeof d.coinZ === "number") {
                self._relocateCoinLocally(d.coinX, d.coinZ);
            }
            self._pushScoreboard();
        });
        this.scene.events.game.on("net_match_ended", function(evt) {
            if (self._ended) return;
            self._ended = true;
            var d = (evt && evt.data) || {};
            if (d.scores) self._scores = d.scores;
            self.scene.events.game.emit("match_ended", d);
            self._pushGameOver(d.winner, d.reason);
        });
    }

    onUpdate(dt) {
        var mp = this.scene._mp;
        if (!mp || !this._initialized || this._ended) return;

        // Pickup detection runs on EVERY peer for their own local player —
        // host-only would stall when the host's tab is backgrounded (rAF
        // throttling). Whoever's collision check fires first wins the coin
        // and tells everyone via a networked event.
        this._coinCheckTimer += dt;
        if (this._coinCheckTimer >= 0.05) {
            this._coinCheckTimer = 0;
            this._checkLocalPickup();
        }

        // Win check + round timer still host-only (one source of truth).
        if (!mp.isHost) return;
        this._elapsed += dt;
        var bestScore = -1;
        var bestPeer = null;
        for (var p in this._scores) {
            if (this._scores[p] > bestScore) { bestScore = this._scores[p]; bestPeer = p; }
        }
        if (bestScore >= this._scoreToWin) {
            this._endMatch(bestPeer, "score");
        } else if (this._elapsed >= this._roundDurationSec) {
            this._endMatch(bestPeer, "time");
        }
    }

    // ─── Per-peer setup ─────────────────────────────────────────────────

    _initMatch() {
        var mp = this.scene._mp;
        if (!mp) return;

        this._elapsed = 0;
        this._ended = false;
        this._scores = {};
        this._coinCheckTimer = 0;

        this._positionLocalPlayer();

        var roster = mp.roster;
        if (roster && roster.peers) {
            for (var i = 0; i < roster.peers.length; i++) {
                this._scores[roster.peers[i].peerId] = 0;
            }
        }

        if (mp.isHost) this._spawnCoin();

        this._initialized = true;
        this._pushScoreboard();
    }

    _positionLocalPlayer() {
        var mp = this.scene._mp;
        var roster = mp.roster;
        var localPeerId = mp.localPeerId;
        if (!roster || !localPeerId) return;

        var peerIds = roster.peers.map(function(p) { return p.peerId; }).sort();
        var slot = peerIds.indexOf(localPeerId);
        if (slot < 0) slot = 0;
        var count = Math.max(peerIds.length, 2);
        var angle = (slot / count) * Math.PI * 2;
        var R = 6;

        var player = this._findLocalPlayerEntity();
        if (!player) return;
        this.scene.setPosition(player.id, Math.cos(angle) * R, 1, Math.sin(angle) * R);

        var ni = player.getComponent("NetworkIdentityComponent");
        if (ni) {
            ni.networkId = this._hashPeerId(localPeerId);
            ni.ownerId = localPeerId;
            ni.isLocalPlayer = true;
        }
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

    // ─── Coin ────────────────────────────────────────────────────────────

    _spawnCoin() {
        // Idempotent — onStart + match_started both call _initMatch on the
        // first frame, so we'd double-spawn without this guard.
        var existing = this.scene.findEntityByName && this.scene.findEntityByName(this._coinEntityName);
        if (existing) {
            var rp = this._randomCoinPosition();
            this.scene.setPosition(existing.id, rp.x, rp.y, rp.z);
            return;
        }
        var scene = this.scene;
        var id = scene.createEntity ? scene.createEntity(this._coinEntityName) : null;
        if (id == null) return;
        var pos = this._randomCoinPosition();
        scene.setPosition(id, pos.x, pos.y, pos.z);
        scene.setScale && scene.setScale(id, 0.6, 0.6, 0.6);
        scene.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: [1, 0.82, 0.2, 1],
        });
        scene.addComponent(id, "NetworkIdentityComponent", {
            networkId: 1,
            ownerId: -1,
            isLocalPlayer: false,
            syncTransform: true,
        });
        if (scene.addTag) {
            scene.addTag(id, "coin");
            scene.addTag(id, "networked");
        }
        // Tell other peers to spawn their own coin visual at the same spot.
        // Subsequent transform changes flow via the host's snapshot broadcast.
        var mp = this.scene._mp;
        if (mp && mp.spawnEntity) {
            mp.spawnEntity({
                networkId: 1,
                prefab: "coin",
                owner: "",
                pos: [pos.x, pos.y, pos.z],
                rot: [0, 0, 0, 1],
            });
        }
    }

    _relocateCoinLocally(x, z) {
        var coin = this.scene.findEntityByName && this.scene.findEntityByName(this._coinEntityName);
        if (!coin) return;
        this.scene.setPosition(coin.id, x, 1, z);
    }

    _checkLocalPickup() {
        var mp = this.scene._mp;
        if (!mp) return;
        // Cooldown after a successful local grab so we don't double-claim a
        // coin while the relocation event is in flight.
        if (this._lastLocalGrabAt && (Date.now() - this._lastLocalGrabAt) < 250) return;

        var coin = this.scene.findEntityByName && this.scene.findEntityByName(this._coinEntityName);
        if (!coin) return;

        var player = this._findLocalPlayerEntity();
        if (!player) return;
        var ni = player.getComponent("NetworkIdentityComponent");
        if (!ni || !ni.isLocalPlayer) return;

        var pp = player.transform.position;
        var coinPos = coin.transform.position;
        var dx = pp.x - coinPos.x;
        var dz = pp.z - coinPos.z;
        if (dx * dx + dz * dz >= this._pickupRadius * this._pickupRadius) return;

        // I touched the coin — claim it. Pick the next coin position locally
        // so all peers see the same teleport (everyone receives the event
        // and applies the position from the payload).
        var peerId = mp.localPeerId;
        this._scores[peerId] = (this._scores[peerId] || 0) + 1;
        var np = this._randomCoinPosition();
        this.scene.setPosition(coin.id, np.x, np.y, np.z);
        this._lastLocalGrabAt = Date.now();
        mp.sendNetworkedEvent("coin_collected", {
            peerId: peerId,
            score: this._scores[peerId],
            coinX: np.x,
            coinZ: np.z,
        });
        this._pushScoreboard();
    }

    _randomCoinPosition() {
        return {
            x: (Math.random() - 0.5) * 30,
            y: 1,
            z: (Math.random() - 0.5) * 30,
        };
    }

    // ─── Match end ───────────────────────────────────────────────────────

    _endMatch(winnerPeerId, reason) {
        this._ended = true;
        var mp = this.scene._mp;
        var payload = { winner: winnerPeerId, reason: reason, scores: this._scores };
        if (mp) mp.sendNetworkedEvent("match_ended", payload);
        this.scene.events.game.emit("match_ended", payload);
        this._pushGameOver(winnerPeerId, reason);
    }

    _pushGameOver(winnerPeerId, reason) {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        var localPeerId = mp && mp.localPeerId;
        var iWon = winnerPeerId && winnerPeerId === localPeerId;

        // Look up the winner's display name from the roster.
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

        var myScore = (mp && this._scores[localPeerId]) || 0;

        // Stats — show every player's score, leader first.
        var stats = {};
        if (roster && roster.peers) {
            var ranked = roster.peers.slice().sort(function(a, b) {
                return (this._scores[b.peerId] || 0) - (this._scores[a.peerId] || 0);
            }.bind(this));
            for (var j = 0; j < ranked.length; j++) {
                var pr = ranked[j];
                var label = pr.username + (pr.peerId === localPeerId ? " (you)" : "");
                stats[label] = String(this._scores[pr.peerId] || 0);
            }
        }
        if (reason === "time") stats["Reason"] = "Time up";
        else if (reason === "score") stats["Reason"] = "Reached " + this._scoreToWin;

        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: myScore, stats: stats },
        });
    }

    // ─── UI ──────────────────────────────────────────────────────────────

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
                    score: this._scores[pr.peerId] || 0,
                    isLocal: pr.peerId === mp.localPeerId,
                });
            }
        }
        list.sort(function(a, b) { return b.score - a.score; });
        this.scene.events.ui.emit("hud_update", {
            scoreboard: { players: list, scoreToWin: this._scoreToWin },
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
}
