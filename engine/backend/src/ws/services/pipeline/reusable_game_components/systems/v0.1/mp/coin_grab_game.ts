// also: pickup, collectible, multiplayer, deathmatch, scoring
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
    _coinSpinRadPerSec = 3.5;
    _coinSound = "";
    _winSound = "";

    _scores = {};
    _elapsed = 0;
    _ended = false;
    _initialized = false;
    _coinCheckTimer = 0;
    _coinEntityName = "Coin";
    _coinAsset = "/assets/quaternius/3d_models/platformer_game_kit/Coin.glb";
    _coinYaw = 0;
    _lastLocalGrabAt = 0;
    _winSoundPlayed = false;

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
            // Quieter than the local grab so the player can still hear
            // their own pickups dominate.
            if (self._coinSound && self.audio) {
                try { self.audio.playSound(self._coinSound, 0.25); } catch (e) { /* missing clip */ }
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

        // Host migrated mid-match — if I'm the new host, claim the coin
        // and resume the loop. Other peers keep their scoreboard as-is.
        // Also re-checks the below-min-players condition: peer_left fires
        // before host_changed, so when the old host was the one who left,
        // the below-min event arrived while I wasn't host yet and bounced
        // off the !isHost guard. Re-evaluate now that I am.
        this.scene.events.game.on("mp_host_changed", function() {
            if (self._ended || !self._initialized) return;
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            var roster = mp2.roster;
            var minP = (roster && roster.minPlayers) || 1;
            if (roster && roster.peers.length < minP) {
                self._endMatch(self._findHighestScorer(), "abandoned");
                return;
            }
            // Best-effort: re-spawn (idempotent — relocates if already there)
            // and reset the round timer so the new host has a clean count.
            self._spawnCoin();
            self._elapsed = 0;
        });

        // Game can't continue with too few players — host abandons.
        this.scene.events.game.on("mp_below_min_players", function() {
            if (self._ended) return;
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            self._endMatch(self._findHighestScorer(), "abandoned");
        });

        // Prune scores for players who left so the scoreboard doesn't keep
        // ghost rows.
        this.scene.events.game.on("mp_phase_in_lobby", function() { self._pruneScoresFromRoster(); });
        this.scene.events.game.on("mp_phase_in_game", function() { self._pruneScoresFromRoster(); });
        this.scene.events.game.on("mp_roster_changed", function() { self._pruneScoresFromRoster(); });
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

        // Cosmetic-only: spin the local copy of the coin so it reads as a
        // pickup. Each peer ticks its own copy (no network sync needed —
        // the host's syncTransform pushes Y-rotation but doesn't matter
        // because every peer applies the same constant spin).
        this._spinCoin(dt);

        // Drive Idle/Walk/Run on every remote player proxy. The network
        // adapter spawns proxies with skipBehaviors=true so
        // player_arena_movement never runs on them, leaving other peers'
        // Knights stuck in the bind pose.
        this._tickRemoteAnimations(dt);

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
        this._winSoundPlayed = false;

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
        // y=0 puts the Knight's feet on the ground (the GLB's origin is
        // at the feet). The kinematic capsule collider is centered at
        // y=0 too — kinematicPositionBased doesn't auto-resolve against
        // statics so the under-floor overlap is harmless.
        this.scene.setPosition(player.id, Math.cos(angle) * R, 0, Math.sin(angle) * R);

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
        var existing = this._findCoinEntity();
        if (existing) {
            var rp = this._randomCoinPosition();
            this.scene.setPosition(existing.id, rp.x, rp.y, rp.z);
            return;
        }
        var scene = this.scene;
        var pos = this._randomCoinPosition();

        // Use the prefab path on both sides (host inline + remote-peer
        // adapter spawn) so every peer renders the same Coin.glb mesh.
        // Inlining a custom-mesh MeshRendererComponent at runtime via
        // addComponent doesn't pull in the GLB the same way the prefab
        // pipeline does (asset registration happens at level build), so
        // the host saw a fallback sphere while remotes saw the prefab.
        var coinEnt = scene.spawnEntity ? scene.spawnEntity("coin") : null;
        if (!coinEnt) return;
        var id = coinEnt.id;
        if (coinEnt.name !== this._coinEntityName) coinEnt.name = this._coinEntityName;
        scene.setPosition(id, pos.x, pos.y, pos.z);
        scene.addComponent(id, "NetworkIdentityComponent", {
            networkId: 1,
            ownerId: -1,
            isLocalPlayer: false,
            syncTransform: true,
        });
        if (scene.addTag) {
            scene.addTag(id, "networked");
            // "coin" tag already on the prefab.
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

    _findCoinEntity() {
        if (this.scene.findEntityByName) {
            var byName = this.scene.findEntityByName(this._coinEntityName);
            if (byName) return byName;
        }
        // Fallback: prefab-spawned entity may carry the prefab key as its
        // default name until we rename it; tag lookup catches both cases.
        if (this.scene.findEntitiesByTag) {
            var byTag = this.scene.findEntitiesByTag("coin");
            if (byTag && byTag.length > 0) return byTag[0];
        }
        return null;
    }

    _relocateCoinLocally(x, z) {
        var coin = this._findCoinEntity();
        if (!coin) return;
        this.scene.setPosition(coin.id, x, 1, z);
    }

    _checkLocalPickup() {
        var mp = this.scene._mp;
        if (!mp) return;
        // Cooldown after a successful local grab so we don't double-claim a
        // coin while the relocation event is in flight.
        if (this._lastLocalGrabAt && (Date.now() - this._lastLocalGrabAt) < 250) return;

        var coin = this._findCoinEntity();
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
        if (this._coinSound && this.audio) {
            try { this.audio.playSound(this._coinSound, 0.5); } catch (e) { /* missing clip */ }
        }
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
        // Host flips the server lobby back to 'waiting' so Play Again
        // can re-Start the round without stale ready-state baggage.
        if (mp && mp.isHost && mp.endMatch) mp.endMatch();
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

        // One-shot win cheer (guarded so a duplicate _pushGameOver call
        // — match_ended fires both locally via _endMatch and via the
        // net_match_ended relay — doesn't double-play the sound).
        if (!this._winSoundPlayed && this._winSound && this.audio) {
            this._winSoundPlayed = true;
            try { this.audio.playSound(this._winSound, 0.55); } catch (e) { /* missing clip */ }
        }
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

    _findHighestScorer() {
        var bestScore = -1;
        var bestPeer = null;
        for (var p in this._scores) {
            if (this._scores[p] > bestScore) { bestScore = this._scores[p]; bestPeer = p; }
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
        for (var k in this._scores) {
            if (!current[k]) { delete this._scores[k]; changed = true; }
        }
        if (changed) this._pushScoreboard();
    }

    _spinCoin(dt) {
        var coin = this._findCoinEntity();
        if (!coin || !coin.transform || !coin.transform.setRotationEuler) return;
        this._coinYaw += this._coinSpinRadPerSec * dt;
        if (this._coinYaw > Math.PI * 2) this._coinYaw -= Math.PI * 2;
        coin.transform.setRotationEuler(0, this._coinYaw, 0);
    }

    // Drive Idle/Walk/Run on every remote player proxy. The network
    // adapter spawns proxies with skipBehaviors=true so
    // player_arena_movement never runs on them — without this loop,
    // other peers see this player's Knight stuck in the bind pose
    // while their synced transform glides around. Velocity is derived
    // from observed position deltas (owner velocity isn't a
    // networkedVar). Threshold mirrors player_arena_movement (base
    // ~6, sprint ×1.6 → ~9.6).
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
            var dz = (pos.z - st.z) / step;
            st.x = pos.x; st.y = pos.y; st.z = pos.z;

            var spd = Math.sqrt(dx * dx + dz * dz);
            var anim;
            if (spd > 7.5)      anim = "Run";
            else if (spd > 0.5) anim = "Walk";
            else                anim = "Idle";
            if (anim !== st.anim) {
                st.anim = anim;
                try { p.playAnimation(anim, { loop: true }); } catch (e) { /* missing clip */ }
            }
        }
    }
}

// Static-validator manifest — see engine headless invariant
// . Never called at runtime; the literal
// spawnEntity calls here let the invariant know these prefabs ARE used
// (the real spawn site uses a variable, e.g. spawnEntity(def.entity)).
function __spawnManifest() {
    this.scene.spawnEntity("coin");
}
