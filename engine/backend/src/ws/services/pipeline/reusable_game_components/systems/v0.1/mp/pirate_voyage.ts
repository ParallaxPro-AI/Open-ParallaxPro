// also: treasure-hunt, maritime-adventure, collection-scoring, ship-racing
// Pirate Voyage match rules — multiplayer treasure-hunt scoring.
//
// Loop per match:
//   - On match_started, every peer:
//       • Repositions its local ship to a unique spawn ring slot so
//         captains don't all start stacked at the origin.
//       • Stamps its NetworkIdentity with stable networkId + ownerId
//         so remote peers' snapshots can identify each ship.
//       • Resets local gold to 0.
//   - The lobby host additionally:
//       • Spawns N floating treasure barrels at random sea positions.
//       • Tracks the round timer + win condition.
//       • Re-spawns a treasure each time one is collected so the
//         seas don't run dry mid-match.
//   - Every peer runs a local pickup loop on their own ship: when its
//     hull touches a treasure, score it locally + broadcast so all
//     peers' scoreboards stay in sync.
//
// Scoring: gold per treasure (configurable). Win at scoreToWin gold or
// highest-gold captain when the round timer expires (host-arbitrated).
class PirateVoyageSystem extends GameScript {
    _roundDurationSec = 360;
    _scoreToWin = 200;
    _pickupRadius = 3.5;
    _treasureValue = 25;
    _treasureCount = 8;
    _treasurePrefab = "treasure_barrel";
    _treasureRadius = 70;
    _spawnRingRadius = 22;
    _treasurePickupSound = "";
    _voyageStartSound = "";
    _winSound = "";

    _gold = {};
    _elapsed = 0;
    _ended = false;
    _initialized = false;
    _pickupTimer = 0;
    _treasureIds = [];
    _lastLocalPickupAt = 0;
    _nextNetIdSeed = 50000;

    onStart() {
        var self = this;
        // FSM activates this system on entering gameplay; match_started
        // fires the same frame, so by the time .on subscribes the event
        // is gone — init directly to be safe.
        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });

        this.scene.events.game.on("net_treasure_collected", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.peerId) return;
            self._gold[d.peerId] = d.score || 0;
            // Despawn the visual locally so it disappears for everyone.
            if (typeof d.treasureNetId === "number") self._removeTreasureByNetId(d.treasureNetId);
            // Host respawns a fresh one elsewhere and tells everyone.
            self._pushScoreboard();
        });
        this.scene.events.game.on("net_treasure_spawned", function(evt) {
            var d = (evt && evt.data) || {};
            if (typeof d.x !== "number") return;
            self._spawnTreasureAt(d.x, d.z, d.networkId);
        });
        this.scene.events.game.on("net_match_ended", function(evt) {
            if (self._ended) return;
            self._ended = true;
            var d = (evt && evt.data) || {};
            if (d.scores) self._gold = d.scores;
            self.scene.events.game.emit("match_ended", d);
            self._pushGameOver(d.winner, d.reason);
        });

        // Host migration — if I'm the new host, claim authority over the
        // round timer and treasure population. Idempotent re-spawn fills
        // any gaps if my treasure list went stale during the handoff.
        this.scene.events.game.on("mp_host_changed", function() {
            if (self._ended || !self._initialized) return;
            var mp = self.scene._mp;
            if (!mp || !mp.isHost) return;
            var roster = mp.roster;
            var minP = (roster && roster.minPlayers) || 1;
            if (roster && roster.peers.length < minP) {
                self._endMatch(self._findLeader(), "abandoned");
                return;
            }
            // Top up treasure count.
            self._refillTreasureToTarget();
        });
        this.scene.events.game.on("mp_below_min_players", function() {
            if (self._ended) return;
            var mp = self.scene._mp;
            if (!mp || !mp.isHost) return;
            self._endMatch(self._findLeader(), "abandoned");
        });

        // Drop scores for peers who left so the scoreboard doesn't keep
        // ghost rows hanging around.
        this.scene.events.game.on("mp_phase_in_lobby", function() { self._pruneScoresFromRoster(); });
        this.scene.events.game.on("mp_phase_in_game", function() { self._pruneScoresFromRoster(); });
        this.scene.events.game.on("mp_roster_changed", function() { self._pruneScoresFromRoster(); });

        // Local respawn — match system teleports our ship to a fresh
        // spawn point when ship_health emits player_respawned.
        this.scene.events.game.on("player_respawned", function() {
            self._teleportLocalToSpawn();
            var mp = self.scene._mp;
            if (mp) mp.sendNetworkedEvent("ship_respawn", { peerId: mp.localPeerId });
        });

        // Player_died from ship_health — broadcast so other peers tally
        // sinks and the kill feed shows it.
        this.scene.events.game.on("player_died", function(data) {
            var mp = self.scene._mp;
            if (!mp) return;
            var d = data || {};
            mp.sendNetworkedEvent("ship_sunk", {
                victimPeerId: mp.localPeerId,
                killerPeerId: d.killerPeerId || "",
            });
        });
        this.scene.events.game.on("net_ship_sunk", function() { /* no-op for now */ });
        this.scene.events.game.on("net_ship_respawn", function() { /* no-op for now */ });
    }

    onUpdate(dt) {
        var mp = this.scene._mp;
        if (!this._initialized || this._ended) return;

        // Pickup detection runs on every peer for its own ship — host-
        // only would stall when the host's tab is backgrounded.
        this._pickupTimer += dt;
        if (this._pickupTimer >= 0.06) {
            this._pickupTimer = 0;
            this._checkLocalPickups();
        }

        // Spyglass compass — show ship heading + bearing/distance to the
        // nearest treasure so captains have something to chase.
        this._pushSpyglass();

        // Win check + round timer host-only (one source of truth).
        if (mp && !mp.isHost) return;
        this._elapsed += dt;
        var bestGold = -1;
        var bestPeer = null;
        for (var p in this._gold) {
            if (this._gold[p] > bestGold) { bestGold = this._gold[p]; bestPeer = p; }
        }
        if (bestGold >= this._scoreToWin) {
            this._endMatch(bestPeer, "score");
        } else if (this._elapsed >= this._roundDurationSec) {
            this._endMatch(bestPeer, "time");
        }

        // Top up treasure if any have lingered as despawned (host-only).
        if (mp && mp.isHost) {
            if (this._treasureIds.length < this._treasureCount * 0.6) {
                this._refillTreasureToTarget();
            }
        }
    }

    // ─── Per-peer setup ─────────────────────────────────────────────────

    _initMatch() {
        this._elapsed = 0;
        this._ended = false;
        this._gold = {};
        this._pickupTimer = 0;
        this._treasureIds = [];
        this._lastLocalPickupAt = 0;

        this._positionLocalPlayer();

        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        if (roster && roster.peers) {
            for (var i = 0; i < roster.peers.length; i++) {
                this._gold[roster.peers[i].peerId] = 0;
            }
        } else {
            // Single-player fallback so the scoreboard works without _mp.
            this._gold["local"] = 0;
        }

        if (!mp || mp.isHost) {
            this._refillTreasureToTarget();
        }
        if (this._voyageStartSound && this.audio) this.audio.playSound(this._voyageStartSound, 0.4);

        this._initialized = true;
        this._pushScoreboard();
        this._pushGoldHUD();
    }

    _positionLocalPlayer() {
        var mp = this.scene._mp;
        var ship = this._findLocalShip();
        if (!ship) return;
        var slot = 0;
        var count = 1;
        if (mp && mp.roster) {
            var peerIds = mp.roster.peers.map(function(p) { return p.peerId; }).sort();
            slot = Math.max(0, peerIds.indexOf(mp.localPeerId));
            count = Math.max(2, peerIds.length);
        }
        var angle = (slot / count) * Math.PI * 2;
        var R = this._spawnRingRadius;
        if (this.scene.setPosition) {
            this.scene.setPosition(ship.id, Math.cos(angle) * R, 0, Math.sin(angle) * R);
        }
        var ni = ship.getComponent ? ship.getComponent("NetworkIdentityComponent") : null;
        if (ni && mp) {
            ni.networkId = this._hashPeerId(mp.localPeerId);
            ni.ownerId = mp.localPeerId;
            ni.isLocalPlayer = true;
        }
    }

    _teleportLocalToSpawn() {
        var ship = this._findLocalShip();
        if (!ship) return;
        // Pick a random spawn around the ring instead of always the slot
        // angle so respawning ships scatter rather than cluster.
        var angle = Math.random() * Math.PI * 2;
        var R = this._spawnRingRadius * (0.7 + Math.random() * 0.5);
        if (this.scene.setPosition) {
            this.scene.setPosition(ship.id, Math.cos(angle) * R, 0, Math.sin(angle) * R);
        }
    }

    _findLocalShip() {
        var ships = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < ships.length; i++) {
            var s = ships[i];
            var tags = s.tags;
            var isRemote = false;
            if (tags) {
                if (typeof tags.has === "function") isRemote = tags.has("remote");
                else if (tags.indexOf) isRemote = tags.indexOf("remote") >= 0;
            }
            if (isRemote) continue;
            var ni = s.getComponent ? s.getComponent("NetworkIdentityComponent") : null;
            if (ni && ni.isLocalPlayer) return s;
            if (!ni) return s;
        }
        return ships[0] || null;
    }

    // ─── Treasure ───────────────────────────────────────────────────────

    _refillTreasureToTarget() {
        var mp = this.scene._mp;
        var amBoss = !mp || mp.isHost;
        if (!amBoss) return;
        while (this._treasureIds.length < this._treasureCount) {
            this._spawnTreasureAtRandom();
        }
    }

    _spawnTreasureAtRandom() {
        var p = this._randomTreasurePosition();
        var netId = this._nextNetId();
        this._spawnTreasureAt(p.x, p.z, netId);
        var mp = this.scene._mp;
        if (mp) {
            mp.sendNetworkedEvent("treasure_spawned", { x: p.x, z: p.z, networkId: netId });
        }
    }

    _spawnTreasureAt(x, z, networkId) {
        if (!this.scene.createEntity) return;
        var id = this.scene.createEntity("Treasure");
        if (id == null) return;
        if (this.scene.setPosition) this.scene.setPosition(id, x, 0.4, z);
        if (this.scene.setScale) this.scene.setScale(id, 0.9, 0.9, 0.9);
        // Use a barrel-ish sphere so it stands out on the ocean. Flagged
        // gold so it visually reads as treasure.
        this.scene.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: [0.92, 0.78, 0.18, 1],
        });
        if (typeof networkId === "number") {
            this.scene.addComponent(id, "NetworkIdentityComponent", {
                networkId: networkId,
                ownerId: "",
                isLocalPlayer: false,
                syncTransform: false,
            });
        }
        if (this.scene.addTag) {
            this.scene.addTag(id, "treasure");
            this.scene.addTag(id, "networked");
        }
        this._treasureIds.push({ entityId: id, networkId: networkId, x: x, z: z });
    }

    _removeTreasureByNetId(netId) {
        var keep = [];
        for (var i = 0; i < this._treasureIds.length; i++) {
            var t = this._treasureIds[i];
            if (t.networkId === netId) {
                if (this.scene.destroyEntity) this.scene.destroyEntity(t.entityId);
            } else {
                keep.push(t);
            }
        }
        this._treasureIds = keep;
    }

    _checkLocalPickups() {
        var ship = this._findLocalShip();
        if (!ship) return;
        var ni = ship.getComponent ? ship.getComponent("NetworkIdentityComponent") : null;
        if (ni && !ni.isLocalPlayer) return;
        // Sunk ships don't gather loot.
        var hull = ship.getScript ? ship.getScript("ShipHealthBehavior") : null;
        if (hull && hull._sunk) return;
        // Cooldown so we don't double-claim while the network event is in flight.
        if (this._lastLocalPickupAt && (Date.now() - this._lastLocalPickupAt) < 220) return;

        var sp = ship.transform.position;
        var R2 = this._pickupRadius * this._pickupRadius;
        for (var i = 0; i < this._treasureIds.length; i++) {
            var t = this._treasureIds[i];
            var dx = sp.x - t.x;
            var dz = sp.z - t.z;
            if (dx * dx + dz * dz < R2) {
                this._claimTreasure(t);
                break;
            }
        }
    }

    _claimTreasure(t) {
        var mp = this.scene._mp;
        var peerId = (mp && mp.localPeerId) || "local";
        this._gold[peerId] = (this._gold[peerId] || 0) + this._treasureValue;
        this._lastLocalPickupAt = Date.now();
        if (this._treasurePickupSound && this.audio) this.audio.playSound(this._treasurePickupSound, 0.55);
        // Local visual remove + UI refresh.
        if (this.scene.destroyEntity) this.scene.destroyEntity(t.entityId);
        var keep = [];
        for (var i = 0; i < this._treasureIds.length; i++) {
            if (this._treasureIds[i].entityId !== t.entityId) keep.push(this._treasureIds[i]);
        }
        this._treasureIds = keep;
        // Tell the world we got it. Host respawns elsewhere.
        if (mp) {
            mp.sendNetworkedEvent("treasure_collected", {
                peerId: peerId,
                score: this._gold[peerId],
                treasureNetId: t.networkId,
            });
        }
        // Give the host a moment to broadcast a fresh treasure.
        if (!mp || mp.isHost) {
            this._spawnTreasureAtRandom();
        }
        this._pushScoreboard();
        this._pushGoldHUD();
        this.scene.events.game.emit("pickup_collected", { entityId: t.entityId });
    }

    _randomTreasurePosition() {
        // Random point inside the treasure radius (square sample, easy & cheap).
        var x, z, tries = 0;
        do {
            x = (Math.random() - 0.5) * this._treasureRadius * 2;
            z = (Math.random() - 0.5) * this._treasureRadius * 2;
            tries++;
        } while ((x * x + z * z) < (this._spawnRingRadius * 0.6) * (this._spawnRingRadius * 0.6) && tries < 8);
        return { x: x, z: z };
    }

    // ─── Match end ──────────────────────────────────────────────────────

    _endMatch(winnerPeerId, reason) {
        this._ended = true;
        if (this._winSound && this.audio) this.audio.playSound(this._winSound, 0.5);
        var mp = this.scene._mp;
        var payload = { winner: winnerPeerId, reason: reason, scores: this._gold };
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
        if (!winnerPeerId) title = "Davy Jones won!";
        else if (iWon) title = "Captain of the Seas!";
        else title = "Captain " + winnerName + " plunders all";

        var myGold = (this._gold[localPeerId] || this._gold["local"] || 0);
        var stats = {};
        if (roster && roster.peers) {
            var self2 = this;
            var ranked = roster.peers.slice().sort(function(a, b) {
                return (self2._gold[b.peerId] || 0) - (self2._gold[a.peerId] || 0);
            });
            for (var j = 0; j < ranked.length; j++) {
                var pr = ranked[j];
                var label = pr.username + (pr.peerId === localPeerId ? " (you)" : "");
                stats[label] = (this._gold[pr.peerId] || 0) + " gold";
            }
        } else {
            stats["You"] = myGold + " gold";
        }
        if (reason === "time") stats["Reason"] = "Sunset on the seas";
        else if (reason === "score") stats["Reason"] = "Reached " + this._scoreToWin + " gold";
        else if (reason === "abandoned") stats["Reason"] = "Crew abandoned ship";

        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: myGold, stats: stats },
        });
    }

    // ─── HUD ─────────────────────────────────────────────────────────────

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
                    score: this._gold[pr.peerId] || 0,
                    isLocal: pr.peerId === mp.localPeerId,
                });
            }
        } else {
            list.push({ peerId: "local", username: "You", score: this._gold["local"] || 0, isLocal: true });
        }
        list.sort(function(a, b) { return b.score - a.score; });
        this.scene.events.ui.emit("hud_update", {
            scoreboard: { players: list, scoreToWin: this._scoreToWin, scoreLabel: "gold" },
        });
    }

    _pushGoldHUD() {
        var mp = this.scene._mp;
        var peerId = (mp && mp.localPeerId) || "local";
        var gold = this._gold[peerId] || 0;
        this.scene.events.ui.emit("hud_update", {
            goldPurse: { gold: gold, target: this._scoreToWin },
        });
    }

    _pushSpyglass() {
        var ship = this._findLocalShip();
        if (!ship || !ship.transform) return;
        var sp = ship.transform.position;
        var shipYaw = this.scene._shipYaw || 0;

        // Find nearest treasure.
        var bestD2 = Infinity;
        var best = null;
        for (var i = 0; i < this._treasureIds.length; i++) {
            var t = this._treasureIds[i];
            var dx = t.x - sp.x;
            var dz = t.z - sp.z;
            var d2 = dx * dx + dz * dz;
            if (d2 < bestD2) { bestD2 = d2; best = t; }
        }

        var payload = { shipYawDeg: shipYaw, targetAngleDeg: null, targetDistance: 0 };
        if (best) {
            var dx2 = best.x - sp.x;
            var dz2 = best.z - sp.z;
            // Bearing from world north (+z forward), then convert into the
            // bow-relative angle (positive = treasure to starboard).
            var worldBearing = Math.atan2(dx2, -dz2) * 180 / Math.PI;
            var rel = worldBearing - shipYaw;
            while (rel > 180) rel -= 360;
            while (rel < -180) rel += 360;
            payload.targetAngleDeg = rel;
            payload.targetDistance = Math.sqrt(bestD2);
        }
        this.scene.events.ui.emit("hud_update", { spyglassCompass: payload });
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
        var bestGold = -1;
        var bestPeer = null;
        for (var p in this._gold) {
            if (this._gold[p] > bestGold) { bestGold = this._gold[p]; bestPeer = p; }
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
        for (var k in this._gold) {
            if (!current[k]) { delete this._gold[k]; changed = true; }
        }
        if (changed) this._pushScoreboard();
    }

    _nextNetIdSeed = 50000;
    _nextNetId() {
        this._nextNetIdSeed = (this._nextNetIdSeed + 1) | 0;
        return this._nextNetIdSeed;
    }
}
