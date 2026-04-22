// also: racing, kart, circuit, lap, multiplayer, items
// Kart Race — mario-kart style multiplayer circuit racer.
//
// Players race a fixed circuit defined by N "checkpoint_<i>" tagged
// entities placed in the world (also discovered via tag); each player
// must hit each checkpoint in order to complete a lap. After lapsToWin
// laps the player crosses the finish (checkpoint 0 again) and is
// "finished"; final ranking is by finish order, and unfinished racers
// are ordered by lap-progress when the timer expires.
//
// Item boxes (tagged "item_box") respawn at fixed positions; on
// collection a random power-up is granted to the player. Press E to
// fire it. Power-ups:
//   boost   — instant boost multiplier on the kart
//   missile — homing volume aimed at the racer just ahead
//   banana  — drops a hazard at your position; first kart to touch
//             spins out for a beat
//   shield  — blocks the next incoming hazard
//   bolt    — slows every other racer for a few seconds
//
// Architecture: host-authoritative for laps + power-ups + hazards;
// re-broadcasts the full state on every change via `kr_state_sync`.
// Animation cues for boost / missile / banana spawn / hit fan out as
// separate net_kr_* events so visuals fire in lockstep.
class KartRaceSystem extends GameScript {
    _lapsToWin = 3;
    _maxRoundDurationSec = 360;
    _itemBoxRespawnSec = 6;
    _itemBoxPickupRange = 3.0;
    _checkpointHitRange = 8.0;
    _missileSpeed = 30;
    _missileLifeSec = 4;
    _missileDamageBoost = 0;       // we just spin the target out instead
    _bananaLifeSec = 60;
    _bananaHitRange = 1.6;
    _hazardHitFreezeSec = 1.4;
    _shieldDurationSec = 12;
    _boltDurationSec = 3;
    _boltSpeedMultiplier = 0.55;
    _powerupKinds = ["boost", "missile", "banana", "shield", "bolt"];
    _powerupWeights = [3, 2, 3, 2, 1];
    _spawnRingRadius = 6;
    _palette = [
        [0.96, 0.30, 0.30, 1], [0.30, 0.55, 0.96, 1], [0.96, 0.85, 0.20, 1],
        [0.30, 0.85, 0.45, 1], [0.85, 0.30, 0.96, 1], [1.00, 0.65, 0.20, 1],
        [0.20, 0.96, 0.85, 1], [0.96, 0.45, 0.65, 1],
    ];
    _hudTickSec = 0.4;
    _itemBoxColor = [1.00, 0.85, 0.20, 1];
    _bananaColor = [1.00, 0.95, 0.20, 1];
    _missileColor = [0.96, 0.30, 0.30, 1];
    _shieldColor = [0.50, 0.85, 1.00, 1];
    _boltColor = [0.85, 0.85, 1.00, 1];
    _itemBoxSound = "";
    _powerupGetSound = "";
    _missileFireSound = "";
    _missileHitSound = "";
    _bananaDropSound = "";
    _bananaHitSound = "";
    _shieldUseSound = "";
    _boltUseSound = "";
    _lapCompleteSound = "";
    _winSound = "";
    _loseSound = "";

    // State (host-authoritative, mirrored on clients)
    _phase = "warmup";              // warmup | racing | finished
    _initialized = false;
    _ended = false;
    _elapsed = 0;
    _checkpoints = [];              // [{ x, z, idx }]
    _itemBoxes = [];                // [{ entityId, x, z, respawnAt | 0 }]
    _bananas = [];                  // [{ entityId, networkId, x, z, ownerPeerId, life }]
    _missiles = [];                 // [{ entityId, networkId, x, z, vx, vz, life, ownerPeerId, targetPeerId }]
    _stats = {};                    // peerId -> { lap, lastCp, finishedAt, finishOrder, color }
    _holding = {};                  // peerId -> "boost" | "missile" | ... | ""
    _shields = {};                  // peerId -> expireAt (ms)
    _spinUntil = {};                // peerId -> ms timestamp until which they're frozen
    _boltSlowedUntil = 0;           // global ms timestamp where everyone except the bolt user is slowed
    _boltUser = "";                 // peerId who used the bolt (immune)
    _hudAccum = 0;
    _stateAccum = 0;
    _lastFinishOrder = 0;
    _bananaNetIdSeed = 50000;
    _missileNetIdSeed = 60000;

    onStart() {
        var self = this;
        this._initOnce();
        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });

        this.scene.events.game.on("net_kr_state_sync", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyStateSync(d);
        });
        this.scene.events.game.on("net_kr_item_pickup", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyItemPickup(d.boxIdx, d.peerId, d.kind);
        });
        this.scene.events.game.on("net_kr_powerup_used", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyPowerupUsed(d.peerId, d.kind, d.x, d.z, d.targetPeerId, d.networkId);
        });
        this.scene.events.game.on("net_kr_hazard_hit", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyHazardHit(d.peerId, d.kind);
        });
        this.scene.events.game.on("net_kr_lap_complete", function(evt) {
            var d = (evt && evt.data) || {};
            self._showLapBanner(d.peerId, d.lap);
        });

        this.scene.events.game.on("player_action", function(d) {
            if (!d || d.action !== "kart_use_powerup") return;
            self._localUsePowerup();
        });

        this.scene.events.game.on("net_kr_request_use", function(evt) {
            var mp = self.scene._mp;
            if (!mp || !mp.isHost) return;
            var d = (evt && evt.data) || {};
            self._handleUseRequest(d.peerId || (evt && evt.from));
        });

        this.scene.events.game.on("net_match_ended", function(evt) {
            if (self._ended) return;
            self._ended = true;
            var d = (evt && evt.data) || {};
            self.scene.events.game.emit("match_ended", d);
            self._pushGameOver(d.winner, d.reason);
        });
        this.scene.events.game.on("mp_host_changed", function() {
            if (self._ended || !self._initialized) return;
            var mp = self.scene._mp;
            if (!mp || !mp.isHost) return;
            self._broadcastState();
        });
        this.scene.events.game.on("mp_below_min_players", function() {
            if (self._ended) return;
            var mp = self.scene._mp;
            if (!mp || !mp.isHost) return;
            self._endMatch(self._currentLeaderPeer(), "abandoned");
        });
        this.scene.events.game.on("mp_phase_in_lobby", function() { self._pruneFromRoster(); });
        this.scene.events.game.on("mp_phase_in_game", function() { self._pruneFromRoster(); });
        this.scene.events.game.on("mp_roster_changed", function() { self._pruneFromRoster(); });
    }

    onUpdate(dt) {
        if (!this._initialized || this._ended) return;
        var mp = this.scene._mp;
        var amBoss = !mp || mp.isHost;

        // Local checks (every peer): spin lockout, bolt slow.
        this._tickLocalLockout();
        // Local checkpoint progression — every peer tracks its own lap progress.
        this._tickLocalCheckpoints();
        // Local item box pickup detection — first peer to touch claims it.
        this._tickLocalItemBoxes();
        // Local hazard collision — bananas anyone can hit.
        this._tickLocalHazards();

        // HUD push.
        this._hudAccum += dt;
        if (this._hudAccum >= this._hudTickSec) {
            this._hudAccum = 0;
            this._pushFullHUD();
        }

        if (!amBoss) return;

        // Host-only: timers + missile flight + box respawn + state broadcast.
        this._elapsed += dt;
        if (this._elapsed >= this._maxRoundDurationSec) {
            this._endMatch(this._currentLeaderPeer(), "time");
            return;
        }
        // Item box respawn.
        var now = Date.now();
        for (var i = 0; i < this._itemBoxes.length; i++) {
            var box = this._itemBoxes[i];
            if (box.entityId == null && box.respawnAt && now >= box.respawnAt) {
                this._spawnItemBoxEntity(i);
            }
        }
        // Missiles fly and seek.
        if (this._missiles.length > 0) this._tickMissiles(dt);
        // Banana lifetime.
        if (this._bananas.length > 0) this._tickBananaLifetimes(dt);

        // Bolt slow expiry.
        if (this._boltSlowedUntil && Date.now() >= this._boltSlowedUntil) {
            this._boltSlowedUntil = 0;
            this._boltUser = "";
        }

        // Periodic state broadcast.
        this._stateAccum += dt;
        if (this._stateAccum >= 0.4) {
            this._stateAccum = 0;
            this._broadcastState();
        }

        // Win check: every player has finished?
        var allDone = true;
        for (var pid in this._stats) {
            if (!this._stats[pid].finishedAt) { allDone = false; break; }
        }
        if (allDone && Object.keys(this._stats).length > 0) {
            // Top of the pile is whoever finished first.
            var first = this._currentLeaderPeer();
            this._endMatch(first, "finished");
        }
    }

    // ─── Init ─────────────────────────────────────────────────────────

    _initOnce() {
        // Discover checkpoints by tag, ordered by name suffix.
        var cps = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("checkpoint") : [];
        cps = cps.slice().sort(function(a, b) {
            var ai = parseInt((a.name || "").replace(/[^\d]/g, ""), 10) || 0;
            var bi = parseInt((b.name || "").replace(/[^\d]/g, ""), 10) || 0;
            return ai - bi;
        });
        this._checkpoints = [];
        for (var i = 0; i < cps.length; i++) {
            var p = cps[i].transform.position;
            this._checkpoints.push({ idx: i, x: p.x, z: p.z });
        }
        // Discover item boxes.
        var boxes = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("item_box") : [];
        this._itemBoxes = boxes.map(function(b, i) {
            return { idx: i, x: b.transform.position.x, z: b.transform.position.z, entityId: b.id, respawnAt: 0 };
        });
    }

    _initMatch() {
        this._phase = "racing";
        this._elapsed = 0;
        this._stats = {};
        this._holding = {};
        this._shields = {};
        this._spinUntil = {};
        this._boltSlowedUntil = 0;
        this._boltUser = "";
        this._missiles = [];
        this._bananas = [];
        this._lastFinishOrder = 0;
        this._initialized = false;
        this._ended = false;
        this._stateAccum = 0;
        this._hudAccum = 0;

        // Reset item box visuals.
        for (var i = 0; i < this._itemBoxes.length; i++) {
            this._itemBoxes[i].respawnAt = 0;
            // If entity was destroyed in a prior match, recreate it.
            var ent = this._itemBoxes[i].entityId != null ? (this.scene.getEntity ? this.scene.getEntity(this._itemBoxes[i].entityId) : null) : null;
            if (!ent) this._spawnItemBoxEntity(i);
        }

        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        var peerIds;
        if (roster && roster.peers && roster.peers.length > 0) {
            peerIds = roster.peers.map(function(p) { return p.peerId; });
        } else {
            peerIds = ["local"];
        }
        peerIds.sort();
        for (var k = 0; k < peerIds.length; k++) {
            var pid = peerIds[k];
            this._stats[pid] = {
                lap: 0,
                lastCp: -1,                 // last checkpoint successfully passed
                finishedAt: 0,
                finishOrder: 0,
                color: this._palette[k % this._palette.length].slice(),
            };
            this._holding[pid] = "";
        }
        this._teleportLocalToSpawn();
        this._initialized = true;
        this._broadcastState();
        this._pushFullHUD();
        this._showLapBanner("", 0, "Race start!");
    }

    _teleportLocalToSpawn() {
        var mp = this.scene._mp;
        var car = this._findLocalPlayer();
        if (!car) return;
        var slot = 0, count = 1;
        if (mp && mp.roster) {
            var ids = mp.roster.peers.map(function(p) { return p.peerId; }).sort();
            slot = Math.max(0, ids.indexOf(mp.localPeerId));
            count = Math.max(2, ids.length);
        }
        // Spawn near checkpoint 0 in a small grid.
        var cp0 = this._checkpoints[0] || { x: 0, z: 0 };
        var sx = cp0.x + (slot % 4) * 2.5 - 4;
        var sz = cp0.z + Math.floor(slot / 4) * 2.5 - 4;
        if (this.scene.setPosition) this.scene.setPosition(car.id, sx, car.transform.position.y, sz);
        var ni = car.getComponent ? car.getComponent("NetworkIdentityComponent") : null;
        if (ni && mp) {
            ni.networkId = this._hashPeerId(mp.localPeerId);
            ni.ownerId = mp.localPeerId;
            ni.isLocalPlayer = true;
        }
        // Tint by team color.
        var color = this._stats[(mp && mp.localPeerId) || "local"];
        color = color ? color.color : [1, 1, 1, 1];
        var mesh = car.getComponent ? car.getComponent("MeshRendererComponent") : null;
        if (mesh && mesh.baseColor) {
            mesh.baseColor[0] = color[0]; mesh.baseColor[1] = color[1];
            mesh.baseColor[2] = color[2]; mesh.baseColor[3] = color[3] != null ? color[3] : 1;
        }
    }

    _findLocalPlayer() {
        var ents = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < ents.length; i++) {
            var e = ents[i];
            var tags = e.tags;
            var isRemote = false;
            if (tags) {
                if (typeof tags.has === "function") isRemote = tags.has("remote");
                else if (tags.indexOf) isRemote = tags.indexOf("remote") >= 0;
            }
            if (isRemote) continue;
            var ni = e.getComponent ? e.getComponent("NetworkIdentityComponent") : null;
            if (!ni) return e;
            if (ni.isLocalPlayer) return e;
        }
        return ents[0] || null;
    }

    _findPlayerByPeer(peerId) {
        var ents = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < ents.length; i++) {
            var e = ents[i];
            var ni = e.getComponent ? e.getComponent("NetworkIdentityComponent") : null;
            if (ni && ni.ownerId === peerId) return e;
        }
        return null;
    }

    // ─── Per-tick (every peer) ────────────────────────────────────────

    _tickLocalLockout() {
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        var spinTs = this._spinUntil[localPeerId] || 0;
        var nowMs = Date.now();
        var isSpun = nowMs < spinTs;
        // Bolt: slows everyone except the bolt user, while active.
        var boltActive = this._boltSlowedUntil > 0 && nowMs < this._boltSlowedUntil && this._boltUser !== localPeerId;
        var car = this._findLocalPlayer();
        if (!car) return;
        var drive = car.getScript ? car.getScript("KartDriveBehavior") : null;
        if (!drive) return;
        if (drive._origMaxSpeed == null) drive._origMaxSpeed = drive._maxSpeed;
        if (isSpun) {
            // Cap forward speed near 0 + jitter the visual yaw lightly.
            drive._speed = drive._speed * Math.exp(-6 * 0.016);
            drive._maxSpeed = 0.5;
        } else if (boltActive) {
            drive._maxSpeed = drive._origMaxSpeed * this._boltSpeedMultiplier;
        } else {
            drive._maxSpeed = drive._origMaxSpeed;
        }
    }

    _tickLocalCheckpoints() {
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        var stat = this._stats[localPeerId];
        if (!stat || stat.finishedAt) return;
        var car = this._findLocalPlayer();
        if (!car || !car.transform) return;
        var pp = car.transform.position;
        // Next checkpoint to hit:
        var nextIdx = (stat.lastCp + 1) % Math.max(1, this._checkpoints.length);
        var cp = this._checkpoints[nextIdx];
        if (!cp) return;
        var dx = pp.x - cp.x, dz = pp.z - cp.z;
        if (dx * dx + dz * dz > this._checkpointHitRange * this._checkpointHitRange) return;
        // Hit it!
        stat.lastCp = nextIdx;
        // If we just hit checkpoint 0 and we already had a lastCp > 0, that's a lap.
        if (nextIdx === 0 && stat.lap > 0) {
            // Already counted by the wrap below.
        }
        if (nextIdx === this._checkpoints.length - 1) {
            // We hit the last checkpoint — next one (idx 0) crosses finish line.
        }
        if (nextIdx === 0 && stat.lap >= 0) {
            // Crossed start/finish line again (only count if we passed the last cp first)
            // We use a separate marker: only +1 lap if stat.lastCp WAS the last index.
            // The way this is structured: nextIdx=0 only fires here if stat.lastCp was -1
            // (very start) OR was the previous-last index. So we always +1 except on the
            // very first hit at race start.
            if (stat.lap === 0 && this._totalCheckpointsCrossedSinceStart(localPeerId) < this._checkpoints.length) {
                // First crossing of the start line — counts as starting lap 1.
                stat.lap = 1;
            } else {
                stat.lap++;
                if (this._lapCompleteSound && this.audio) {
                    try { this.audio.playSound(this._lapCompleteSound, 0.4); } catch (e) { /* nop */ }
                }
                this._showLapBanner(localPeerId, stat.lap);
                if (stat.lap > this._lapsToWin) {
                    // Finish.
                    if (mp && mp.isHost) this._completeFinish(localPeerId);
                    else if (mp) mp.sendNetworkedEvent("kr_request_use", { peerId: localPeerId, finished: true });
                }
            }
            var mp2 = this.scene._mp;
            if (mp2) mp2.sendNetworkedEvent("kr_lap_complete", { peerId: localPeerId, lap: stat.lap });
        }
    }

    _totalCheckpointsCrossedSinceStart(_peerId) { return 0; }

    _tickLocalItemBoxes() {
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        if (!this._stats[localPeerId] || this._stats[localPeerId].finishedAt) return;
        if (this._holding[localPeerId]) return;
        var car = this._findLocalPlayer();
        if (!car || !car.transform) return;
        var pp = car.transform.position;
        var R2 = this._itemBoxPickupRange * this._itemBoxPickupRange;
        for (var i = 0; i < this._itemBoxes.length; i++) {
            var b = this._itemBoxes[i];
            if (b.entityId == null) continue;
            var dx = pp.x - b.x, dz = pp.z - b.z;
            if (dx * dx + dz * dz > R2) continue;
            // Claim locally + broadcast.
            var kind = this._rollPowerup();
            this._applyItemPickup(i, localPeerId, kind);
            if (mp) mp.sendNetworkedEvent("kr_item_pickup", { boxIdx: i, peerId: localPeerId, kind: kind });
            break;
        }
    }

    _tickLocalHazards() {
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        var spinTs = this._spinUntil[localPeerId] || 0;
        if (Date.now() < spinTs) return;
        var car = this._findLocalPlayer();
        if (!car || !car.transform) return;
        var pp = car.transform.position;
        var R2 = this._bananaHitRange * this._bananaHitRange;
        for (var i = 0; i < this._bananas.length; i++) {
            var b = this._bananas[i];
            if (!b || b.ownerPeerId === localPeerId) continue;
            var dx = pp.x - b.x, dz = pp.z - b.z;
            if (dx * dx + dz * dz > R2) continue;
            // Hit. If we have a shield, consume it instead.
            var nowMs = Date.now();
            if (this._shields[localPeerId] && nowMs < this._shields[localPeerId]) {
                this._shields[localPeerId] = 0;
            } else {
                this._spinUntil[localPeerId] = nowMs + this._hazardHitFreezeSec * 1000;
                if (this._bananaHitSound && this.audio) {
                    try { this.audio.playSound(this._bananaHitSound, 0.4); } catch (e) { /* nop */ }
                }
            }
            // Tell the host so the banana entity is removed everywhere.
            if (mp) mp.sendNetworkedEvent("kr_hazard_hit", { peerId: localPeerId, kind: "banana", networkId: b.networkId });
            // Locally remove it too.
            this._removeBanana(b.networkId);
            break;
        }
    }

    // ─── State application (host + replays on every peer) ────────────

    _applyItemPickup(boxIdx, peerId, kind) {
        var box = this._itemBoxes[boxIdx];
        if (!box) return;
        if (box.entityId != null && this.scene.destroyEntity) {
            try { this.scene.destroyEntity(box.entityId); } catch (e) { /* nop */ }
        }
        box.entityId = null;
        box.respawnAt = Date.now() + this._itemBoxRespawnSec * 1000;
        if (peerId && this._stats[peerId]) {
            this._holding[peerId] = kind || "boost";
        }
        if (this._powerupGetSound && this.audio) {
            try { this.audio.playSound(this._powerupGetSound, 0.45); } catch (e) { /* nop */ }
        }
    }

    _spawnItemBoxEntity(idx) {
        var box = this._itemBoxes[idx];
        if (!box) return;
        var sceneRef = this.scene;
        if (!sceneRef.createEntity) return;
        var name = "ItemBox_" + idx + "_" + Date.now();
        var id = sceneRef.createEntity(name);
        if (id == null) return;
        sceneRef.setPosition(id, box.x, 1.0, box.z);
        sceneRef.setScale && sceneRef.setScale(id, 1.0, 1.0, 1.0);
        sceneRef.addComponent(id, "MeshRendererComponent", {
            meshType: "cube",
            baseColor: this._itemBoxColor,
        });
        if (sceneRef.addTag) sceneRef.addTag(id, "item_box");
        box.entityId = id;
        box.respawnAt = 0;
        if (this._itemBoxSound && this.audio) {
            try { this.audio.playSound(this._itemBoxSound, 0.18); } catch (e) { /* nop */ }
        }
    }

    _localUsePowerup() {
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        if (!this._holding[localPeerId]) return;
        if (mp && mp.isHost) this._handleUseRequest(localPeerId);
        else if (mp) mp.sendNetworkedEvent("kr_request_use", { peerId: localPeerId });
        else this._handleUseRequest(localPeerId);
    }

    _handleUseRequest(peerId) {
        if (!peerId) return;
        var kind = this._holding[peerId];
        if (!kind) return;
        var car = this._findPlayerByPeer(peerId);
        if (!car || !car.transform) return;
        var pp = car.transform.position;
        var x = pp.x, z = pp.z;
        var targetPeerId = "";
        var netId = -1;
        if (kind === "boost") {
            // Apply locally via player_repair convention.
            this.scene.events.game.emit("player_repair", { amount: 0.5 });
        } else if (kind === "missile") {
            // Pick the player just ahead in race order.
            targetPeerId = this._racerJustAhead(peerId);
            netId = this._nextMissileNetId();
            this._spawnMissile(x, z, peerId, targetPeerId, netId);
        } else if (kind === "banana") {
            netId = this._nextBananaNetId();
            this._spawnBanana(x - Math.sin(((this._kartYawOf(peerId)) || 0) * Math.PI / 180) * 2.0,
                              z + Math.cos(((this._kartYawOf(peerId)) || 0) * Math.PI / 180) * 2.0,
                              peerId, netId);
        } else if (kind === "shield") {
            this._shields[peerId] = Date.now() + this._shieldDurationSec * 1000;
        } else if (kind === "bolt") {
            this._boltSlowedUntil = Date.now() + this._boltDurationSec * 1000;
            this._boltUser = peerId;
        }
        this._holding[peerId] = "";
        var mp = this.scene._mp;
        if (mp) mp.sendNetworkedEvent("kr_powerup_used", {
            peerId: peerId, kind: kind, x: x, z: z, targetPeerId: targetPeerId, networkId: netId,
        });
        this._broadcastState();
    }

    _applyPowerupUsed(peerId, kind, x, z, targetPeerId, networkId) {
        if (kind === "boost") {
            // Audio cue everyone hears when a peer hits boost.
            if (peerId && peerId === ((this.scene._mp && this.scene._mp.localPeerId) || "local")) {
                this.scene.events.game.emit("player_repair", { amount: 0.5 });
            }
        } else if (kind === "missile") {
            this._spawnMissile(x, z, peerId, targetPeerId, networkId);
            if (this._missileFireSound && this.audio) {
                try { this.audio.playSound(this._missileFireSound, 0.4); } catch (e) { /* nop */ }
            }
        } else if (kind === "banana") {
            this._spawnBanana(x, z, peerId, networkId);
            if (this._bananaDropSound && this.audio) {
                try { this.audio.playSound(this._bananaDropSound, 0.32); } catch (e) { /* nop */ }
            }
        } else if (kind === "shield") {
            this._shields[peerId] = Date.now() + this._shieldDurationSec * 1000;
            if (this._shieldUseSound && this.audio) {
                try { this.audio.playSound(this._shieldUseSound, 0.4); } catch (e) { /* nop */ }
            }
        } else if (kind === "bolt") {
            this._boltSlowedUntil = Date.now() + this._boltDurationSec * 1000;
            this._boltUser = peerId;
            if (this._boltUseSound && this.audio) {
                try { this.audio.playSound(this._boltUseSound, 0.45); } catch (e) { /* nop */ }
            }
        }
        this._holding[peerId] = "";
    }

    _applyHazardHit(peerId, kind) {
        // Spin out the hit player on every peer's mirror.
        if (peerId) this._spinUntil[peerId] = Date.now() + this._hazardHitFreezeSec * 1000;
    }

    _spawnBanana(x, z, ownerPeerId, networkId) {
        var sceneRef = this.scene;
        if (!sceneRef.createEntity) return;
        var name = "Banana_" + (networkId || Math.floor(Math.random() * 1e9));
        var id = sceneRef.createEntity(name);
        if (id == null) return;
        sceneRef.setPosition(id, x, 0.4, z);
        sceneRef.setScale && sceneRef.setScale(id, 0.5, 0.5, 0.5);
        sceneRef.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: this._bananaColor,
        });
        if (sceneRef.addTag) sceneRef.addTag(id, "banana");
        this._bananas.push({
            entityId: id,
            networkId: networkId,
            x: x, z: z,
            ownerPeerId: ownerPeerId,
            life: this._bananaLifeSec,
        });
    }

    _removeBanana(networkId) {
        var keep = [];
        for (var i = 0; i < this._bananas.length; i++) {
            var b = this._bananas[i];
            if (b.networkId === networkId) {
                if (this.scene.destroyEntity && b.entityId != null) {
                    try { this.scene.destroyEntity(b.entityId); } catch (e) { /* nop */ }
                }
            } else {
                keep.push(b);
            }
        }
        this._bananas = keep;
    }

    _tickBananaLifetimes(dt) {
        for (var i = 0; i < this._bananas.length; i++) {
            this._bananas[i].life -= dt;
        }
        var keep = [];
        for (var j = 0; j < this._bananas.length; j++) {
            var b = this._bananas[j];
            if (b.life > 0) keep.push(b);
            else if (this.scene.destroyEntity && b.entityId != null) {
                try { this.scene.destroyEntity(b.entityId); } catch (e) { /* nop */ }
            }
        }
        this._bananas = keep;
    }

    _spawnMissile(x, z, ownerPeerId, targetPeerId, networkId) {
        var sceneRef = this.scene;
        if (!sceneRef.createEntity) return;
        var name = "Missile_" + (networkId || Math.floor(Math.random() * 1e9));
        var id = sceneRef.createEntity(name);
        if (id == null) return;
        sceneRef.setPosition(id, x, 1.2, z);
        sceneRef.setScale && sceneRef.setScale(id, 0.5, 0.5, 1.0);
        sceneRef.addComponent(id, "MeshRendererComponent", {
            meshType: "cube",
            baseColor: this._missileColor,
        });
        if (sceneRef.addTag) sceneRef.addTag(id, "missile");
        // Initial direction toward target if known.
        var vx = 1, vz = 0;
        if (targetPeerId) {
            var tgt = this._findPlayerByPeer(targetPeerId);
            if (tgt && tgt.transform) {
                var dx = tgt.transform.position.x - x;
                var dz = tgt.transform.position.z - z;
                var len = Math.sqrt(dx * dx + dz * dz) || 1;
                vx = dx / len; vz = dz / len;
            }
        }
        this._missiles.push({
            entityId: id, networkId: networkId,
            x: x, z: z, vx: vx * this._missileSpeed, vz: vz * this._missileSpeed,
            life: this._missileLifeSec,
            ownerPeerId: ownerPeerId, targetPeerId: targetPeerId,
        });
    }

    _tickMissiles(dt) {
        var keep = [];
        for (var i = 0; i < this._missiles.length; i++) {
            var m = this._missiles[i];
            m.life -= dt;
            // Seek target.
            if (m.targetPeerId) {
                var tgt = this._findPlayerByPeer(m.targetPeerId);
                if (tgt && tgt.transform) {
                    var dx = tgt.transform.position.x - m.x;
                    var dz = tgt.transform.position.z - m.z;
                    var len = Math.sqrt(dx * dx + dz * dz) || 1;
                    var sx = dx / len, sz = dz / len;
                    var t = Math.min(1, 4 * dt);
                    var nvx = m.vx * (1 - t) + sx * this._missileSpeed * t;
                    var nvz = m.vz * (1 - t) + sz * this._missileSpeed * t;
                    var nlen = Math.sqrt(nvx * nvx + nvz * nvz) || 1;
                    m.vx = nvx / nlen * this._missileSpeed;
                    m.vz = nvz / nlen * this._missileSpeed;
                    // Hit check.
                    if (len < 1.5) {
                        // Missile hit.
                        var spinned = m.targetPeerId;
                        // Honor shields.
                        var nowMs = Date.now();
                        if (this._shields[spinned] && nowMs < this._shields[spinned]) {
                            this._shields[spinned] = 0;
                        } else {
                            this._spinUntil[spinned] = nowMs + this._hazardHitFreezeSec * 1000;
                        }
                        var mp = this.scene._mp;
                        if (mp) mp.sendNetworkedEvent("kr_hazard_hit", { peerId: spinned, kind: "missile" });
                        if (this._missileHitSound && this.audio) {
                            try { this.audio.playSound(this._missileHitSound, 0.4); } catch (e) { /* nop */ }
                        }
                        if (this.scene.destroyEntity && m.entityId != null) {
                            try { this.scene.destroyEntity(m.entityId); } catch (e) { /* nop */ }
                        }
                        continue;
                    }
                }
            }
            // Move.
            m.x += m.vx * dt;
            m.z += m.vz * dt;
            if (this.scene.setPosition && m.entityId != null) {
                this.scene.setPosition(m.entityId, m.x, 1.2, m.z);
            }
            if (m.life > 0) keep.push(m);
            else if (this.scene.destroyEntity && m.entityId != null) {
                try { this.scene.destroyEntity(m.entityId); } catch (e) { /* nop */ }
            }
        }
        this._missiles = keep;
    }

    // ─── Race progress helpers ───────────────────────────────────────

    _racerJustAhead(peerId) {
        var me = this._stats[peerId];
        if (!me) return "";
        var meProgress = me.lap * 1000 + (me.lastCp + 1);
        var bestId = "";
        var bestGap = Infinity;
        for (var pid in this._stats) {
            if (pid === peerId) continue;
            var s = this._stats[pid];
            var p = s.lap * 1000 + (s.lastCp + 1);
            if (p > meProgress) {
                var gap = p - meProgress;
                if (gap < bestGap) { bestGap = gap; bestId = pid; }
            }
        }
        return bestId;
    }

    _kartYawOf(peerId) {
        // Best effort: read the local kart's published yaw if it's us; for
        // other peers approximate by their most recent transform rotation
        // — for simplicity we just return 0.
        var mp = this.scene._mp;
        if (peerId === ((mp && mp.localPeerId) || "local")) return (this.scene._kart && this.scene._kart.yaw) || 0;
        return 0;
    }

    _completeFinish(peerId) {
        var s = this._stats[peerId];
        if (!s || s.finishedAt) return;
        this._lastFinishOrder++;
        s.finishOrder = this._lastFinishOrder;
        s.finishedAt = Date.now();
        if (this._winSound && this.audio && s.finishOrder === 1) {
            try { this.audio.playSound(this._winSound, 0.55); } catch (e) { /* nop */ }
        }
        this._broadcastState();
    }

    _rollPowerup() {
        var total = 0;
        for (var i = 0; i < this._powerupWeights.length; i++) total += this._powerupWeights[i];
        var roll = Math.random() * total;
        var acc = 0;
        for (var j = 0; j < this._powerupWeights.length; j++) {
            acc += this._powerupWeights[j];
            if (roll <= acc) return this._powerupKinds[j];
        }
        return this._powerupKinds[0];
    }

    _currentLeaderPeer() {
        // Already-finished racers ranked by finishOrder.
        var bestFinished = null;
        for (var pid in this._stats) {
            var s = this._stats[pid];
            if (s.finishedAt && (!bestFinished || s.finishOrder < bestFinished.order)) {
                bestFinished = { peerId: pid, order: s.finishOrder };
            }
        }
        if (bestFinished) return bestFinished.peerId;
        // Otherwise highest progress.
        var bestPid = null;
        var bestProgress = -1;
        for (var pid2 in this._stats) {
            var s2 = this._stats[pid2];
            var p = s2.lap * 1000 + (s2.lastCp + 1);
            if (p > bestProgress) { bestProgress = p; bestPid = pid2; }
        }
        return bestPid;
    }

    // ─── Sync + HUD ───────────────────────────────────────────────────

    _broadcastState() {
        var bananasOut = this._bananas.map(function(b) {
            return { networkId: b.networkId, x: b.x, z: b.z, ownerPeerId: b.ownerPeerId };
        });
        var missilesOut = this._missiles.map(function(m) {
            return { networkId: m.networkId, x: m.x, z: m.z, vx: m.vx, vz: m.vz, ownerPeerId: m.ownerPeerId, targetPeerId: m.targetPeerId };
        });
        var state = {
            phase: this._phase,
            elapsed: this._elapsed,
            duration: this._maxRoundDurationSec,
            stats: this._stats,
            holding: this._holding,
            shields: this._shields,
            spinUntil: this._spinUntil,
            boltSlowedUntil: this._boltSlowedUntil,
            boltUser: this._boltUser,
            bananas: bananasOut,
            missiles: missilesOut,
            checkpoints: this._checkpoints.length,
            lapsToWin: this._lapsToWin,
        };
        var mp = this.scene._mp;
        if (mp && mp.isHost) mp.sendNetworkedEvent("kr_state_sync", state);
        this._pushFullHUD();
    }

    _applyStateSync(state) {
        if (!state) return;
        if (state.phase) this._phase = state.phase;
        if (typeof state.elapsed === "number") this._elapsed = state.elapsed;
        if (state.stats) this._stats = state.stats;
        if (state.holding) this._holding = state.holding;
        if (state.shields) this._shields = state.shields;
        if (state.spinUntil) this._spinUntil = state.spinUntil;
        if (typeof state.boltSlowedUntil === "number") this._boltSlowedUntil = state.boltSlowedUntil;
        if (typeof state.boltUser === "string") this._boltUser = state.boltUser;
        if (typeof state.lapsToWin === "number") this._lapsToWin = state.lapsToWin;
        this._initialized = true;
        this._pushFullHUD();
    }

    _pushFullHUD() {
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        var roster = mp && mp.roster;
        // Position (1st, 2nd, …) — sort all peers by progress + finish.
        var entries = [];
        for (var pid in this._stats) {
            var s = this._stats[pid];
            entries.push({
                peerId: pid,
                lap: s.lap,
                cp: s.lastCp,
                finishedAt: s.finishedAt || 0,
                finishOrder: s.finishOrder || 0,
                color: s.color,
            });
        }
        entries.sort(function(a, b) {
            var fa = a.finishOrder, fb = b.finishOrder;
            if (fa && fb) return fa - fb;
            if (fa) return -1;
            if (fb) return 1;
            // Higher progress wins.
            var pa = a.lap * 1000 + (a.cp + 1);
            var pb = b.lap * 1000 + (b.cp + 1);
            return pb - pa;
        });
        var myRank = -1;
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].peerId === localPeerId) { myRank = i + 1; break; }
        }
        var myStat = this._stats[localPeerId] || { lap: 0, lastCp: -1 };
        var displayLap = Math.max(1, Math.min(this._lapsToWin, myStat.lap || 1));
        this.scene.events.ui.emit("hud_update", {
            racePosition: {
                rank: myRank > 0 ? myRank : 1,
                totalRacers: entries.length || 1,
                lap: displayLap,
                lapsToWin: this._lapsToWin,
                finished: myStat.finishedAt > 0,
                finishOrder: myStat.finishOrder || 0,
                colors: entries.map(function(e) { return e.color; }),
            },
        });

        // Power-up inventory.
        this.scene.events.ui.emit("hud_update", {
            powerupInventory: {
                holding: this._holding[localPeerId] || "",
                shielded: !!(this._shields[localPeerId] && Date.now() < this._shields[localPeerId]),
                spinUntil: this._spinUntil[localPeerId] || 0,
                boltActive: this._boltSlowedUntil > 0 && Date.now() < this._boltSlowedUntil && this._boltUser !== localPeerId,
            },
        });

        // Lap timer.
        var elapsed = this._elapsed;
        var duration = this._maxRoundDurationSec;
        this.scene.events.ui.emit("hud_update", {
            lapTimer: {
                elapsed: elapsed,
                duration: duration,
                lap: displayLap,
                lapsToWin: this._lapsToWin,
            },
        });

        // Scoreboard (for the existing scoreboard.html).
        var list = [];
        if (roster && roster.peers) {
            for (var k = 0; k < roster.peers.length; k++) {
                var pr = roster.peers[k];
                var s2 = this._stats[pr.peerId] || { lap: 0, lastCp: -1, finishOrder: 0 };
                // Score = (laps * 1000) + (cps+1) + finish bonus.
                var score = (s2.finishOrder ? (10000 - s2.finishOrder * 100) : 0) + s2.lap * 100 + (s2.lastCp + 1);
                list.push({
                    peerId: pr.peerId,
                    username: pr.username,
                    score: score,
                    isLocal: pr.peerId === localPeerId,
                });
            }
        } else {
            list.push({ peerId: "local", username: "You", score: (myStat.lap || 0) * 100 + (myStat.lastCp + 1), isLocal: true });
        }
        list.sort(function(a, b) { return b.score - a.score; });
        this.scene.events.ui.emit("hud_update", {
            scoreboard: { players: list, scoreToWin: this._lapsToWin * 100, scoreLabel: "lap" },
        });
    }

    _showLapBanner(peerId, lap, override) {
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        var name = peerId === localPeerId ? "You" : (peerId ? this._peerName(peerId) : "");
        var title = override ? override : (lap > this._lapsToWin ? "FINISHED!" : "Lap " + Math.min(lap, this._lapsToWin) + " / " + this._lapsToWin);
        this.scene.events.ui.emit("hud_update", {
            racePosition: {
                banner: { title: title, subtitle: name, color: peerId && this._stats[peerId] ? this._stats[peerId].color : null, tsMs: Date.now() },
            },
        });
    }

    // ─── Match end ───────────────────────────────────────────────────

    _endMatch(winnerPeerId, reason) {
        if (this._ended) return;
        this._ended = true;
        var mp = this.scene._mp;
        var payload = { winner: winnerPeerId, reason: reason, stats: this._stats };
        if (mp) mp.sendNetworkedEvent("match_ended", payload);
        this.scene.events.game.emit("match_ended", payload);
        this._pushGameOver(winnerPeerId, reason);
        var snd = (winnerPeerId === ((mp && mp.localPeerId) || "local")) ? this._winSound : this._loseSound;
        if (snd && this.audio) {
            try { this.audio.playSound(snd, 0.55); } catch (e) { /* nop */ }
        }
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
                if (roster.peers[i].peerId === winnerPeerId) { winnerName = roster.peers[i].username; break; }
            }
        }
        var title;
        if (!winnerPeerId) title = "Tied at the line";
        else if (iWon) title = "1ST PLACE!";
        else title = winnerName + " took the trophy";
        var stats = {};
        if (roster && roster.peers) {
            var self2 = this;
            var ranked = roster.peers.slice().sort(function(a, b) {
                var sa = self2._stats[a.peerId] || {}; var sb = self2._stats[b.peerId] || {};
                if (sa.finishOrder && sb.finishOrder) return sa.finishOrder - sb.finishOrder;
                if (sa.finishOrder) return -1;
                if (sb.finishOrder) return 1;
                var pa = (sa.lap || 0) * 1000 + ((sa.lastCp || -1) + 1);
                var pb = (sb.lap || 0) * 1000 + ((sb.lastCp || -1) + 1);
                return pb - pa;
            });
            for (var j = 0; j < ranked.length; j++) {
                var pr = ranked[j];
                var s = this._stats[pr.peerId] || { lap: 0, lastCp: -1, finishOrder: 0 };
                var label = (s.finishOrder ? ("#" + s.finishOrder + " ") : "") + pr.username + (pr.peerId === localPeerId ? " (you)" : "");
                stats[label] = "lap " + (s.lap || 0) + "  ·  cp " + ((s.lastCp || -1) + 1);
            }
        }
        if (reason === "finished") stats["Reason"] = "All racers finished";
        else if (reason === "time") stats["Reason"] = "Time up";
        else if (reason === "abandoned") stats["Reason"] = "Field abandoned";

        var meStat = this._stats[localPeerId] || { lap: 0, finishOrder: 0 };
        var meScore = meStat.finishOrder ? (10000 - meStat.finishOrder * 100) : (meStat.lap || 0) * 100;
        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: meScore, stats: stats },
        });
    }

    // ─── Helpers ──────────────────────────────────────────────────────

    _peerName(peerId) {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        if (roster && roster.peers) {
            for (var i = 0; i < roster.peers.length; i++) {
                if (roster.peers[i].peerId === peerId) return roster.peers[i].username;
            }
        }
        if (peerId === "local") return "You";
        return peerId ? peerId.slice(0, 6) : "—";
    }

    _hashPeerId(peerId) {
        var h = 2166136261;
        for (var i = 0; i < peerId.length; i++) {
            h ^= peerId.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return ((h >>> 0) % 1000000) + 1000;
    }

    _pruneFromRoster() {
        var mp = this.scene._mp;
        if (!mp || !mp.roster) return;
        var current = {};
        for (var i = 0; i < mp.roster.peers.length; i++) current[mp.roster.peers[i].peerId] = true;
        var changed = false;
        for (var pid in this._stats) {
            if (!current[pid]) {
                delete this._stats[pid];
                delete this._holding[pid];
                changed = true;
            }
        }
        if (changed) this._broadcastState();
    }

    _nextBananaNetId() {
        this._bananaNetIdSeed = (this._bananaNetIdSeed + 1) | 0;
        return this._bananaNetIdSeed;
    }
    _nextMissileNetId() {
        this._missileNetIdSeed = (this._missileNetIdSeed + 1) | 0;
        return this._missileNetIdSeed;
    }
}
