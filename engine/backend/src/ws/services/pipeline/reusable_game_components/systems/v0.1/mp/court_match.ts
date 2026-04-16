// Court Match — NBA 2K style 1v1..4v4 multiplayer basketball.
//
// Two teams (home / away), full-court layout with a hoop at each end.
// Quarters of fixed length; team with most points after the final
// quarter wins. Ball is always attached to a single peer (the holder)
// and follows them visually; on a shot it flies through an arc to the
// hoop, hit-or-miss is rolled from the shot meter zone + distance
// difficulty, and possession transfers cleanly afterward.
//
// Per-tick host responsibilities:
//   - Auto-balance teams from sorted peer ids (alternating).
//   - Tick the quarter timer and advance quarters / end the game.
//   - Move the visible ball entity to the holder's hand position.
//   - Route shoot / pass / steal player_action intents.
//   - Resolve the shot arc, decide score (with audio cues), and hand
//     possession to the closest opposing player on miss.
//
// Architecture: full state-sync pattern via net_cm_state_sync. Animation
// cues for shot in-flight + made/missed bucket fan out separately so
// every peer's HUD pulse + ball flight align.
class CourtMatchSystem extends GameScript {
    _quarters = 4;
    _quarterDurationSec = 90;
    _intermissionSec = 4;
    _shotResolveSec = 1.4;          // ball arc duration
    _stealRange = 1.6;
    _stealCooldownMs = 700;
    _passSpeed = 18;                // m/s on a pass
    _passMaxRange = 28;
    _threePointDistance = 7.5;      // 2D distance from hoop center
    _maxShotDistance = 18;          // shots beyond this can't go in
    _greenMakeRate = 0.95;
    _yellowMakeRate = 0.55;
    _missMakeRate = 0.10;
    _distanceFalloffStart = 6;      // beyond this distance % starts falling
    _ballAttachOffset = { x: 0.4, y: 1.1, z: 0.3 };
    _hoopRimY = 3.05;
    _spawnRingRadius = 6;
    _homeColor = [0.96, 0.30, 0.30, 1];
    _awayColor = [0.30, 0.55, 0.96, 1];
    _ballColor = [0.95, 0.55, 0.20, 1];
    _shotMakeSound = "";
    _shotMissSound = "";
    _bucketFanfareSound = "";
    _passSound = "";
    _stealSound = "";
    _bounceSound = "";
    _quarterEndSound = "";
    _matchEndSound = "";

    // State (host-authoritative)
    _phase = "warmup";              // warmup | playing | intermission | match_end
    _quarter = 1;
    _quarterRemaining = 90;
    _intermissionRemaining = 0;
    _initialized = false;
    _ended = false;
    _scores = { home: 0, away: 0 };
    _teamByPeer = {};               // peerId -> "home" | "away"
    _stats = {};                    // peerId -> { points, made, attempts, steals, passes }
    _ballHolder = "";               // peerId
    _ballEntityId = null;
    _ballX = 0; _ballY = 1; _ballZ = 0;
    _ballMode = "held";             // held | passing | shooting | loose
    _ballAnim = null;               // { from, to, t, duration, kind, shooterPeerId, shotZone, made, distance }
    _hoops = { home: { x: -22, z: 0 }, away: { x: 22, z: 0 } };
    _lastStealAt = 0;
    _stateAccum = 0;

    onStart() {
        var self = this;
        this._initOnce();
        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });

        // State sync.
        this.scene.events.game.on("net_cm_state_sync", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyStateSync(d);
        });
        // Animation cues.
        this.scene.events.game.on("net_cm_shot_anim", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyShotAnim(d);
        });
        this.scene.events.game.on("net_cm_pass_anim", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyPassAnim(d);
        });
        this.scene.events.game.on("net_cm_made", function(evt) {
            var d = (evt && evt.data) || {};
            self._showBucket(d.shooterPeerId, d.points);
        });
        this.scene.events.game.on("net_cm_missed", function(evt) { self._showMiss(); });
        this.scene.events.game.on("net_cm_quarter_change", function(evt) {
            var d = (evt && evt.data) || {};
            self._showBanner("END OF Q" + (d.from || 1), "Quarter " + (d.to || 1) + " in " + this._intermissionSec + "s");
        });

        // Host receives action requests.
        this.scene.events.game.on("net_cm_request_pass", function(evt) {
            var mp = self.scene._mp;
            if (!mp || !mp.isHost) return;
            var d = (evt && evt.data) || {};
            self._handlePass(d.peerId || (evt && evt.from), d.heading || 0);
        });
        this.scene.events.game.on("net_cm_request_shoot", function(evt) {
            var mp = self.scene._mp;
            if (!mp || !mp.isHost) return;
            var d = (evt && evt.data) || {};
            self._handleShoot(d.peerId || (evt && evt.from), d.zone || "miss", d.value || 0);
        });
        this.scene.events.game.on("net_cm_request_steal", function(evt) {
            var mp = self.scene._mp;
            if (!mp || !mp.isHost) return;
            var d = (evt && evt.data) || {};
            self._handleSteal(d.peerId || (evt && evt.from));
        });

        // Local intents from baller behaviors.
        this.scene.events.game.on("player_action", function(d) {
            if (!d) return;
            if (d.action === "baller_pass")  self._localActionPass();
            if (d.action === "baller_shoot") self._localActionShoot();
            if (d.action === "baller_steal") self._localActionSteal();
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
            self._endMatch(self._scoreLeader(), "abandoned");
        });
        this.scene.events.game.on("mp_phase_in_lobby", function() { self._pruneFromRoster(); });
        this.scene.events.game.on("mp_phase_in_game", function() { self._pruneFromRoster(); });
        this.scene.events.game.on("mp_roster_changed", function() { self._pruneFromRoster(); });
    }

    onUpdate(dt) {
        if (!this._initialized || this._ended) return;
        var mp = this.scene._mp;
        var amBoss = !mp || mp.isHost;

        // Always update visible ball position.
        this._updateBallVisual(dt);

        if (!amBoss) {
            // Clients still tick state hud.
            this._pushFullHUD();
            return;
        }

        // Phase timers.
        if (this._phase === "playing") {
            this._quarterRemaining -= dt;
            if (this._quarterRemaining <= 0) this._endQuarter();
        } else if (this._phase === "intermission") {
            this._intermissionRemaining -= dt;
            if (this._intermissionRemaining <= 0) this._beginQuarter();
        }

        // Periodic state broadcast (twice per second).
        this._stateAccum += dt;
        if (this._stateAccum >= 0.5) {
            this._stateAccum = 0;
            this._broadcastState();
        }

        // Resolve in-flight shots.
        if (this._ballAnim && this._ballMode === "shooting") {
            this._tickShotResolve(dt);
        }
        if (this._ballAnim && this._ballMode === "passing") {
            this._tickPassResolve(dt);
        }
    }

    // ─── Init ────────────────────────────────────────────────────────

    _initOnce() {
        // Discover hoops by tag (optional). Falls back to defaults.
        var hoops = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("hoop_home") : [];
        if (hoops.length > 0) this._hoops.home = { x: hoops[0].transform.position.x, z: hoops[0].transform.position.z };
        var hoopsA = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("hoop_away") : [];
        if (hoopsA.length > 0) this._hoops.away = { x: hoopsA[0].transform.position.x, z: hoopsA[0].transform.position.z };
    }

    _initMatch() {
        this._phase = "playing";
        this._quarter = 1;
        this._quarterRemaining = this._quarterDurationSec;
        this._intermissionRemaining = 0;
        this._scores = { home: 0, away: 0 };
        this._teamByPeer = {};
        this._stats = {};
        this._ballMode = "held";
        this._ballAnim = null;
        this._ended = false;
        this._lastStealAt = 0;
        this._stateAccum = 0;

        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        var peerIds;
        if (roster && roster.peers && roster.peers.length > 0) {
            peerIds = roster.peers.map(function(p) { return p.peerId; });
        } else {
            peerIds = ["local"];
        }
        peerIds.sort();
        for (var i = 0; i < peerIds.length; i++) {
            this._teamByPeer[peerIds[i]] = (i % 2 === 0) ? "home" : "away";
            this._stats[peerIds[i]] = { points: 0, made: 0, attempts: 0, steals: 0, passes: 0 };
        }

        this._teleportLocalToSpawn();
        // Initial possession: first home player gets the ball.
        var homers = this._peersOnTeam("home");
        this._ballHolder = homers[0] || peerIds[0];
        this._spawnBallEntity();
        this._initialized = true;
        this._broadcastState();
        this._pushFullHUD();
        this._showBanner("TIP-OFF", "Quarter 1 — " + this._quarterDurationSec + "s");
    }

    _peersOnTeam(team) {
        var out = [];
        for (var pid in this._teamByPeer) if (this._teamByPeer[pid] === team) out.push(pid);
        return out.sort();
    }

    _teleportLocalToSpawn() {
        var mp = this.scene._mp;
        var car = this._findLocalPlayer();
        if (!car) return;
        var team = this._teamByPeer[(mp && mp.localPeerId) || "local"] || "home";
        var towardHoop = (team === "home") ? this._hoops.away : this._hoops.home;
        // Spawn at half court, slight offset by team.
        var sx = (team === "home") ? -3 : 3;
        var slot = Math.max(0, this._peersOnTeam(team).indexOf((mp && mp.localPeerId) || "local"));
        var sz = (slot - 1.5) * 3;
        if (this.scene.setPosition) this.scene.setPosition(car.id, sx, car.transform.position.y, sz);
        var ni = car.getComponent ? car.getComponent("NetworkIdentityComponent") : null;
        if (ni && mp) {
            ni.networkId = this._hashPeerId(mp.localPeerId);
            ni.ownerId = mp.localPeerId;
            ni.isLocalPlayer = true;
        }
        // Tint to team color.
        var color = (team === "home") ? this._homeColor : this._awayColor;
        var mesh = car.getComponent ? car.getComponent("MeshRendererComponent") : null;
        if (mesh && mesh.baseColor) {
            mesh.baseColor[0] = color[0]; mesh.baseColor[1] = color[1];
            mesh.baseColor[2] = color[2]; mesh.baseColor[3] = color[3] != null ? color[3] : 1;
        }
        // Stash for the camera.
        this.scene._court = this.scene._court || {};
        this.scene._court.localTeam = team;
        this.scene._court.hoops = this._hoops;
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

    _spawnBallEntity() {
        var sceneRef = this.scene;
        if (!sceneRef.createEntity) return;
        if (this._ballEntityId != null) return;
        var id = sceneRef.createEntity("Ball");
        if (id == null) return;
        sceneRef.setPosition(id, this._ballX, 1.0, this._ballZ);
        sceneRef.setScale && sceneRef.setScale(id, 0.34, 0.34, 0.34);
        sceneRef.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: this._ballColor,
        });
        sceneRef.addComponent(id, "NetworkIdentityComponent", {
            networkId: 999000,
            ownerId: "",
            isLocalPlayer: false,
            syncTransform: true,
        });
        if (sceneRef.addTag) sceneRef.addTag(id, "ball");
        this._ballEntityId = id;
    }

    // ─── Quarters ────────────────────────────────────────────────────

    _endQuarter() {
        if (this._quarter >= this._quarters) {
            // Final quarter ended → end the match.
            var winner = this._scoreLeader();
            this._endMatch(winner, "final");
            return;
        }
        var mp = this.scene._mp;
        if (mp) mp.sendNetworkedEvent("cm_quarter_change", { from: this._quarter, to: this._quarter + 1 });
        if (this._quarterEndSound && this.audio) {
            try { this.audio.playSound(this._quarterEndSound, 0.45); } catch (e) { /* nop */ }
        }
        this._showBanner("END OF Q" + this._quarter, "Quarter " + (this._quarter + 1) + " in " + this._intermissionSec + "s");
        this._phase = "intermission";
        this._intermissionRemaining = this._intermissionSec;
    }

    _beginQuarter() {
        this._quarter++;
        this._quarterRemaining = this._quarterDurationSec;
        this._phase = "playing";
        // Possession alternates each quarter.
        var newTeam = (this._quarter % 2 === 0) ? "away" : "home";
        var pids = this._peersOnTeam(newTeam);
        if (pids.length > 0) this._ballHolder = pids[0];
        this._showBanner("Q" + this._quarter, this._quarterDurationSec + "s");
        this._broadcastState();
    }

    // ─── Action handling ─────────────────────────────────────────────

    _localActionPass() {
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        if (this._ballHolder !== localPeerId) return;
        var heading = (this.scene._court && this.scene._court.localFacing) || 0;
        if (mp && mp.isHost) this._handlePass(localPeerId, heading);
        else if (mp) mp.sendNetworkedEvent("cm_request_pass", { peerId: localPeerId, heading: heading });
        else this._handlePass(localPeerId, heading);
    }

    _localActionShoot() {
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        if (this._ballHolder !== localPeerId) return;
        var meter = this.scene._shotMeter || { value: 0 };
        var zone = meter.finalZone || "miss";
        if (mp && mp.isHost) this._handleShoot(localPeerId, zone, meter.value || 0);
        else if (mp) mp.sendNetworkedEvent("cm_request_shoot", { peerId: localPeerId, zone: zone, value: meter.value || 0 });
        else this._handleShoot(localPeerId, zone, meter.value || 0);
    }

    _localActionSteal() {
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        if (Date.now() - this._lastStealAt < this._stealCooldownMs) return;
        if (mp && mp.isHost) this._handleSteal(localPeerId);
        else if (mp) mp.sendNetworkedEvent("cm_request_steal", { peerId: localPeerId });
        else this._handleSteal(localPeerId);
    }

    _handlePass(peerId, heading) {
        if (this._ballHolder !== peerId) return;
        var passer = this._findPlayerByPeer(peerId);
        if (!passer || !passer.transform) return;
        var fromTeam = this._teamByPeer[peerId];
        // Find best teammate "in front of" the passer.
        var teammates = this._peersOnTeam(fromTeam);
        var best = null;
        var bestScore = -Infinity;
        for (var i = 0; i < teammates.length; i++) {
            var pid = teammates[i];
            if (pid === peerId) continue;
            var ent = this._findPlayerByPeer(pid);
            if (!ent || !ent.transform) continue;
            var dx = ent.transform.position.x - passer.transform.position.x;
            var dz = ent.transform.position.z - passer.transform.position.z;
            var dist = Math.sqrt(dx * dx + dz * dz);
            if (dist > this._passMaxRange) continue;
            // Direction alignment with the passer's heading vector.
            var hx = Math.sin(heading);
            var hz = -Math.cos(heading);
            var align = (hx * dx + hz * dz) / Math.max(0.01, dist);
            // Prefer aligned + closer.
            var score = align - dist * 0.05;
            if (score > bestScore) { bestScore = score; best = { peerId: pid, x: ent.transform.position.x, z: ent.transform.position.z }; }
        }
        if (!best) return;
        // Stats.
        if (!this._stats[peerId]) this._stats[peerId] = { points: 0, made: 0, attempts: 0, steals: 0, passes: 0 };
        this._stats[peerId].passes++;
        // Animate the ball arc.
        var fromX = passer.transform.position.x;
        var fromZ = passer.transform.position.z;
        var dur = Math.max(0.25, this._distanceTo(fromX, fromZ, best.x, best.z) / this._passSpeed);
        this._ballMode = "passing";
        this._ballAnim = {
            from: { x: fromX, z: fromZ }, to: { x: best.x, z: best.z },
            t: 0, duration: dur, kind: "pass", targetPeerId: best.peerId,
        };
        var mp = this.scene._mp;
        if (mp) mp.sendNetworkedEvent("cm_pass_anim", { from: this._ballAnim.from, to: this._ballAnim.to, duration: dur });
        if (this._passSound && this.audio) {
            try { this.audio.playSound(this._passSound, 0.4); } catch (e) { /* nop */ }
        }
        this._ballHolder = "";    // ball in flight; nobody holds it
        this._broadcastState();
    }

    _handleShoot(peerId, zone, value) {
        if (this._ballHolder !== peerId) return;
        var shooter = this._findPlayerByPeer(peerId);
        if (!shooter || !shooter.transform) return;
        var team = this._teamByPeer[peerId];
        var hoop = (team === "home") ? this._hoops.away : this._hoops.home;
        var distance = this._distanceTo(shooter.transform.position.x, shooter.transform.position.z, hoop.x, hoop.z);
        var pts = (distance >= this._threePointDistance) ? 3 : 2;
        // Roll make / miss.
        var baseRate = (zone === "perfect") ? this._greenMakeRate
                      : (zone === "good") ? this._yellowMakeRate
                      : this._missMakeRate;
        if (distance > this._maxShotDistance) baseRate *= 0.05;
        else if (distance > this._distanceFalloffStart) {
            var falloff = 1 - ((distance - this._distanceFalloffStart) / (this._maxShotDistance - this._distanceFalloffStart));
            baseRate *= Math.max(0.05, falloff);
        }
        var made = Math.random() < baseRate;
        if (!this._stats[peerId]) this._stats[peerId] = { points: 0, made: 0, attempts: 0, steals: 0, passes: 0 };
        this._stats[peerId].attempts++;
        if (made) {
            this._stats[peerId].made++;
            this._stats[peerId].points += pts;
            this._scores[team] += pts;
        }
        // Ball anim toward hoop. On miss the ball still arcs to the rim,
        // then bounces away — we just pop it to the loose state and the
        // possession transfer below handles it.
        var fromX = shooter.transform.position.x;
        var fromZ = shooter.transform.position.z;
        this._ballMode = "shooting";
        this._ballAnim = {
            from: { x: fromX, z: fromZ }, to: { x: hoop.x, z: hoop.z },
            t: 0, duration: this._shotResolveSec, kind: "shot",
            shooterPeerId: peerId, shotZone: zone, made: made, points: pts, distance: distance,
        };
        var mp = this.scene._mp;
        if (mp) mp.sendNetworkedEvent("cm_shot_anim", {
            from: this._ballAnim.from, to: this._ballAnim.to,
            duration: this._shotResolveSec,
            shooterPeerId: peerId, made: made, points: pts, zone: zone,
        });
        this._ballHolder = "";
        this._broadcastState();
    }

    _handleSteal(peerId) {
        if (!this._ballHolder) return;
        var holder = this._findPlayerByPeer(this._ballHolder);
        var stealer = this._findPlayerByPeer(peerId);
        if (!holder || !stealer || !holder.transform || !stealer.transform) return;
        if (this._teamByPeer[peerId] === this._teamByPeer[this._ballHolder]) return;
        var dx = holder.transform.position.x - stealer.transform.position.x;
        var dz = holder.transform.position.z - stealer.transform.position.z;
        if (dx * dx + dz * dz > this._stealRange * this._stealRange) return;
        // 50% chance to steal.
        if (Math.random() < 0.5) {
            this._lastStealAt = Date.now();
            if (!this._stats[peerId]) this._stats[peerId] = { points: 0, made: 0, attempts: 0, steals: 0, passes: 0 };
            this._stats[peerId].steals++;
            this._ballHolder = peerId;
            if (this._stealSound && this.audio) {
                try { this.audio.playSound(this._stealSound, 0.45); } catch (e) { /* nop */ }
            }
            this._broadcastState();
        }
    }

    _tickShotResolve(dt) {
        var anim = this._ballAnim;
        anim.t += dt;
        if (anim.t < anim.duration) return;
        // Arc complete → resolve.
        if (anim.made) {
            var mp = this.scene._mp;
            if (mp) mp.sendNetworkedEvent("cm_made", { shooterPeerId: anim.shooterPeerId, points: anim.points });
            this._showBucket(anim.shooterPeerId, anim.points);
            if (this._shotMakeSound && this.audio) {
                try { this.audio.playSound(this._shotMakeSound, 0.55); } catch (e) { /* nop */ }
            }
            // After a basket: opposing team gets the ball at center court.
            var opposite = (this._teamByPeer[anim.shooterPeerId] === "home") ? "away" : "home";
            var pids = this._peersOnTeam(opposite);
            this._ballHolder = pids[0] || anim.shooterPeerId;
        } else {
            var mp2 = this.scene._mp;
            if (mp2) mp2.sendNetworkedEvent("cm_missed", {});
            this._showMiss();
            if (this._shotMissSound && this.audio) {
                try { this.audio.playSound(this._shotMissSound, 0.4); } catch (e) { /* nop */ }
            }
            // Rebound to closest opposing player.
            var opp = (this._teamByPeer[anim.shooterPeerId] === "home") ? "away" : "home";
            var hoop = (this._teamByPeer[anim.shooterPeerId] === "home") ? this._hoops.away : this._hoops.home;
            var rebPids = this._peersOnTeam(opp);
            var bestPid = rebPids[0] || anim.shooterPeerId;
            var bestD2 = Infinity;
            for (var i = 0; i < rebPids.length; i++) {
                var ent = this._findPlayerByPeer(rebPids[i]);
                if (!ent || !ent.transform) continue;
                var dx = ent.transform.position.x - hoop.x;
                var dz = ent.transform.position.z - hoop.z;
                var d2 = dx * dx + dz * dz;
                if (d2 < bestD2) { bestD2 = d2; bestPid = rebPids[i]; }
            }
            this._ballHolder = bestPid;
        }
        this._ballMode = "held";
        this._ballAnim = null;
        this._broadcastState();
    }

    _tickPassResolve(dt) {
        var anim = this._ballAnim;
        anim.t += dt;
        if (anim.t < anim.duration) return;
        // Pass complete → target receives.
        this._ballHolder = anim.targetPeerId || this._ballHolder;
        this._ballMode = "held";
        this._ballAnim = null;
        this._broadcastState();
    }

    // ─── Visuals (every peer) ────────────────────────────────────────

    _updateBallVisual(dt) {
        if (this._ballEntityId == null) return;
        var x = this._ballX, y = this._ballY, z = this._ballZ;
        if (this._ballMode === "shooting" || this._ballMode === "passing") {
            var anim = this._ballAnim;
            if (anim) {
                var t = Math.min(1, anim.t / Math.max(0.01, anim.duration));
                x = anim.from.x + (anim.to.x - anim.from.x) * t;
                z = anim.from.z + (anim.to.z - anim.from.z) * t;
                // Parabolic arc — peak based on distance.
                var dist = this._distanceTo(anim.from.x, anim.from.z, anim.to.x, anim.to.z);
                var peak = (anim.kind === "shot") ? Math.max(4.5, 2.0 + dist * 0.18) : Math.max(2.5, 1.0 + dist * 0.10);
                y = 1.0 + 4 * peak * t * (1 - t);
                // Rim height correction at end of shot.
                if (anim.kind === "shot" && t > 0.92) y = this._hoopRimY + (1 - t) * 1.5;
            }
        } else if (this._ballHolder) {
            // Attached to holder.
            var ent = this._findPlayerByPeer(this._ballHolder);
            if (ent && ent.transform) {
                var p = ent.transform.position;
                x = p.x + this._ballAttachOffset.x;
                y = (p.y || 0) + this._ballAttachOffset.y;
                z = p.z + this._ballAttachOffset.z;
            }
        }
        this._ballX = x; this._ballY = y; this._ballZ = z;
        if (this.scene.setPosition) this.scene.setPosition(this._ballEntityId, x, y, z);
        // Keep a neat status the dribble script can see.
        this.scene._court = this.scene._court || {};
        this.scene._court.ballHolder = this._ballHolder;
        this.scene._court.hoops = this._hoops;
    }

    // ─── Sync + HUD ─────────────────────────────────────────────────

    _broadcastState() {
        var state = {
            phase: this._phase,
            quarter: this._quarter,
            quarterRemaining: this._quarterRemaining,
            intermissionRemaining: this._intermissionRemaining,
            scores: this._scores,
            teamByPeer: this._teamByPeer,
            stats: this._stats,
            ballHolder: this._ballHolder,
            ballMode: this._ballMode,
            ballAnim: this._ballAnim,
        };
        var mp = this.scene._mp;
        if (mp && mp.isHost) mp.sendNetworkedEvent("cm_state_sync", state);
        this._pushFullHUD();
    }

    _applyStateSync(state) {
        if (!state) return;
        if (state.phase) this._phase = state.phase;
        if (typeof state.quarter === "number") this._quarter = state.quarter;
        if (typeof state.quarterRemaining === "number") this._quarterRemaining = state.quarterRemaining;
        if (typeof state.intermissionRemaining === "number") this._intermissionRemaining = state.intermissionRemaining;
        if (state.scores) this._scores = state.scores;
        if (state.teamByPeer) this._teamByPeer = state.teamByPeer;
        if (state.stats) this._stats = state.stats;
        if (typeof state.ballHolder === "string") this._ballHolder = state.ballHolder;
        if (state.ballMode) this._ballMode = state.ballMode;
        if (state.ballAnim) this._ballAnim = state.ballAnim;
        else if (state.ballAnim === null) this._ballAnim = null;
        this._initialized = true;
        // Make sure local team registration is correct after assignment.
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        var team = this._teamByPeer[localPeerId];
        if (team) {
            this.scene._court = this.scene._court || {};
            this.scene._court.localTeam = team;
            this.scene._court.hoops = this._hoops;
        }
        this._pushFullHUD();
    }

    _applyShotAnim(d) {
        this._ballMode = "shooting";
        this._ballAnim = {
            from: d.from, to: d.to, t: 0, duration: d.duration || this._shotResolveSec,
            kind: "shot", made: !!d.made, points: d.points || 2, shooterPeerId: d.shooterPeerId,
        };
    }

    _applyPassAnim(d) {
        this._ballMode = "passing";
        this._ballAnim = {
            from: d.from, to: d.to, t: 0, duration: d.duration || 0.4,
            kind: "pass",
        };
    }

    _showBucket(shooterPeerId, points) {
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        var name = this._peerName(shooterPeerId);
        var team = this._teamByPeer[shooterPeerId] || "home";
        var color = (team === "home") ? this._homeColor : this._awayColor;
        this._showBanner((points || 2) + "PT " + (points === 3 ? "TRIPLE!" : "BUCKET"), name + " — " + (team === "home" ? "Home" : "Away"), color);
        if (this._bucketFanfareSound && this.audio) {
            try { this.audio.playSound(this._bucketFanfareSound, 0.55); } catch (e) { /* nop */ }
        }
    }

    _showMiss() {
        this._showBanner("Miss!", "Rebound up for grabs", null);
    }

    _showBanner(title, subtitle, color) {
        this.scene.events.ui.emit("hud_update", {
            courtScoreboard: {
                banner: { title: title, subtitle: subtitle || "", color: color || null, tsMs: Date.now() },
            },
        });
    }

    _pushFullHUD() {
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        var localTeam = this._teamByPeer[localPeerId] || "home";

        // Court scoreboard.
        this.scene.events.ui.emit("hud_update", {
            courtScoreboard: {
                home: this._scores.home,
                away: this._scores.away,
                quarter: this._quarter,
                quarters: this._quarters,
                quarterRemaining: Math.max(0, Math.ceil(this._quarterRemaining || 0)),
                intermission: this._phase === "intermission",
                intermissionRemaining: Math.max(0, Math.ceil(this._intermissionRemaining || 0)),
                homeColor: this._homeColor,
                awayColor: this._awayColor,
                localTeam: localTeam,
            },
        });

        // Possession indicator.
        var holderName = this._ballHolder ? this._peerName(this._ballHolder) : "—";
        var holderTeam = this._ballHolder ? this._teamByPeer[this._ballHolder] : "";
        this.scene.events.ui.emit("hud_update", {
            possessionIndicator: {
                holderName: holderName,
                team: holderTeam,
                teamColor: holderTeam === "home" ? this._homeColor : this._awayColor,
                isLocal: this._ballHolder === localPeerId,
                ballMode: this._ballMode,
            },
        });

        // Shot meter — read scene-level state populated by baller_shot.
        var meter = this.scene._shotMeter || { value: 0, charging: false };
        this.scene.events.ui.emit("hud_update", {
            shotMeter: {
                value: meter.value || 0,
                charging: !!meter.charging,
                greenLow: meter.greenLow != null ? meter.greenLow : 0.78,
                greenHigh: meter.greenHigh != null ? meter.greenHigh : 0.92,
                yellowLow: meter.yellowLow != null ? meter.yellowLow : 0.55,
                yellowHigh: meter.yellowHigh != null ? meter.yellowHigh : 0.97,
                finalZone: meter.finalZone || "",
                hasBall: this._ballHolder === localPeerId,
            },
        });

        // Scoreboard (per-peer points).
        var roster = mp && mp.roster;
        var list = [];
        if (roster && roster.peers) {
            for (var i = 0; i < roster.peers.length; i++) {
                var pr = roster.peers[i];
                var s = this._stats[pr.peerId] || { points: 0 };
                list.push({
                    peerId: pr.peerId,
                    username: pr.username,
                    score: s.points || 0,
                    isLocal: pr.peerId === localPeerId,
                });
            }
        } else {
            var s2 = this._stats["local"] || { points: 0 };
            list.push({ peerId: "local", username: "You", score: s2.points || 0, isLocal: true });
        }
        list.sort(function(a, b) { return b.score - a.score; });
        this.scene.events.ui.emit("hud_update", {
            scoreboard: { players: list, scoreToWin: 0, scoreLabel: "PTS" },
        });
    }

    // ─── Match end ───────────────────────────────────────────────────

    _scoreLeader() {
        if (this._scores.home > this._scores.away) return "home";
        if (this._scores.away > this._scores.home) return "away";
        return null;
    }

    _endMatch(winnerTeam, reason) {
        if (this._ended) return;
        this._ended = true;
        var mp = this.scene._mp;
        var payload = { winner: winnerTeam, reason: reason, scores: this._scores, teamByPeer: this._teamByPeer };
        if (mp) mp.sendNetworkedEvent("match_ended", payload);
        this.scene.events.game.emit("match_ended", payload);
        this._pushGameOver(winnerTeam, reason);
        if (this._matchEndSound && this.audio) {
            try { this.audio.playSound(this._matchEndSound, 0.55); } catch (e) { /* nop */ }
        }
        if (mp && mp.isHost && mp.endMatch) mp.endMatch();
    }

    _pushGameOver(winnerTeam, reason) {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        var localPeerId = mp && mp.localPeerId;
        var iWon = winnerTeam && this._teamByPeer[localPeerId] === winnerTeam;
        var title;
        if (!winnerTeam) title = "OVERTIME-LESS DRAW";
        else if (iWon) title = (winnerTeam === "home") ? "HOME COURT VICTORY" : "AWAY UPSET";
        else title = (winnerTeam === "home") ? "Home wins" : "Away wins";

        var stats = {};
        stats["Home"] = String(this._scores.home);
        stats["Away"] = String(this._scores.away);
        if (roster && roster.peers) {
            for (var i = 0; i < roster.peers.length; i++) {
                var pr = roster.peers[i];
                var s = this._stats[pr.peerId] || { points: 0, made: 0, attempts: 0, steals: 0 };
                var team = this._teamByPeer[pr.peerId] || "—";
                var label = pr.username + " (" + team[0].toUpperCase() + ")";
                stats[label] = (s.points || 0) + " pts · " + (s.made || 0) + "/" + (s.attempts || 0) + " · " + (s.steals || 0) + " stl";
            }
        }
        if (reason === "final") stats["Reason"] = "Final buzzer";
        else if (reason === "abandoned") stats["Reason"] = "Crowd dispersed";

        var meScore = (this._stats[localPeerId] && this._stats[localPeerId].points) || 0;
        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: meScore, stats: stats },
        });
    }

    _pruneFromRoster() {
        var mp = this.scene._mp;
        if (!mp || !mp.roster) return;
        var current = {};
        for (var i = 0; i < mp.roster.peers.length; i++) current[mp.roster.peers[i].peerId] = true;
        var changed = false;
        for (var pid in this._teamByPeer) {
            if (!current[pid]) {
                delete this._teamByPeer[pid];
                delete this._stats[pid];
                changed = true;
            }
        }
        if (changed) this._broadcastState();
    }

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

    _distanceTo(x1, z1, x2, z2) {
        var dx = x1 - x2, dz = z1 - z2;
        return Math.sqrt(dx * dx + dz * dz);
    }
}
