// Jelly Jam — multiplayer party-elimination minigame bracket.
//
// Match structure: a sequence of N short minigame ROUNDS. Each round is
// a sprint race across an obstacle course with rotating spinner beams.
// At the end of a round the bottom half of the field is eliminated; the
// survivors advance to the next, harder round. Last 1-3 jellies win.
//
// Match phase machine:
//   intro    → camera pan, "Round X — sprint race" banner, 3-2-1 countdown
//   live     → race active, players run + qualify by crossing the finish
//   results  → "Qualified!" banner, eliminated peers transition to
//              spectator mode, then the next round starts (or podium).
//   podium   → top finishers crowned; UI shows victory card
//
// Authority: host owns round transitions, obstacle layout, the qualify/
// eliminate decisions, and broadcasts each step. Each peer's player is
// driven locally; transforms sync as snapshots.
//
// Course generation: deterministic by round number — same layout for
// every peer in the same round, regenerated host-side and broadcast
// at round start. Spinners are kinematic colliders that the system
// rotates each frame; impact is detected by per-peer distance check
// against each spinner's swept arc and applied as a knockback impulse.
class JellyJamGameSystem extends GameScript {
    // ─── Tunable parameters ──────────────────────────────────────────
    _totalRounds = 3;
    _roundDurationSec = 75;
    _introDurationSec = 4.5;
    _resultsDurationSec = 5.0;
    _qualifierFraction = 0.5;        // top 50% advance per round
    _minQualifiers = 1;
    _winnerCount = 1;                // crown top 1 at the end (set 2-3 for shared)
    _spectateOrbitSpeed = 18;        // deg/sec when spectating mode
    _spinnerLength = 7;              // long axis of the beam
    _spinnerThickness = 0.4;
    _spinnerHeight = 0.9;
    _spinnerHitArcDeg = 35;          // half-arc the bar's tip swings through
    _spinnerKnockback = 14;          // horizontal velocity injected on hit
    _spinnerKnockbackUp = 4;
    _spinnerHitCooldownSec = 0.6;    // per-peer cooldown so we don't double-bump
    _courseLength = 80;              // along +X
    _courseHalfWidth = 8;            // ±Z
    _hudUpdateInterval = 0.15;
    _enemyUpdateInterval = 0.2;      // unused (no enemies) — left for symmetry
    _minPlayers = 1;

    // ─── Runtime state ──────────────────────────────────────────────
    _phase = "warmup";        // warmup → intro → live → results → podium → done
    _phaseClock = 0;
    _roundIndex = 0;
    _matchOver = false;
    _initialized = false;
    _hudTimer = 0;

    _course = null;           // current course config { spinners, finishX, startX, palette }
    _activePlayers = {};      // peerId → { qualified:false, eliminated:false, place: 0 }
    _qualifyingThisRound = 0;
    _qualifiedOrder = [];     // peerId list, in qualify order this round
    _eliminatedThisRound = []; // peerId list
    _allTimeResults = {};     // peerId → { rounds:0, eliminations:0, finalPlace:null }

    _spinners = [];           // [{ entityId, x, z, angleDeg, speedDeg, lastHit:{peerId:t}, length }]
    _finishLineEntityId = null;
    _startGateEntityId = null;
    _decorEntityIds = [];
    _hitCooldowns = {};       // "spinnerIdx:peerId" → world clock at which we can hit again

    onStart() {
        var self = this;
        this.scene._jjSpectateTargetId = null;
        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });

        // ── Network broadcasts from host ──
        this.scene.events.game.on("net_jj_round_start", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyRoundStart(d);
        });
        this.scene.events.game.on("net_jj_round_end", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyRoundEnd(d);
        });
        this.scene.events.game.on("net_jj_course_init", function(evt) {
            var d = (evt && evt.data) || {};
            if (d.course) self._buildCourseLocally(d.course);
        });
        this.scene.events.game.on("net_jj_qualify", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.peerId) return;
            self._applyQualify(d.peerId, Number(d.place) || 0);
        });
        this.scene.events.game.on("net_jj_eliminate", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.peerId) return;
            self._applyEliminate(d.peerId);
        });
        this.scene.events.game.on("net_jj_dive", function(evt) {
            // Local fanout so other peers' proxy animation can react.
            var d = (evt && evt.data) || {};
            if (d.peerId) self.scene.events.game.emit("jj_dive_started", { peerId: d.peerId });
        });

        // Match-end fan-in (host broadcasts via match_ended).
        this.scene.events.game.on("net_match_ended", function(evt) {
            if (self._matchOver) return;
            self._matchOver = true;
            var d = (evt && evt.data) || {};
            self.scene.events.game.emit("match_ended", { winner: d.winner || "", reason: d.reason || "" });
            self._pushPodium(d);
        });

        // ── Session lifecycle ──
        this.scene.events.game.on("mp_host_changed", function() {
            if (self._matchOver || !self._initialized) return;
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            // Re-broadcast current course + state so any new host-elected
            // peer's view stays consistent.
            self._broadcastCurrentRound();
        });
        this.scene.events.game.on("mp_below_min_players", function() {
            if (self._matchOver) return;
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            self._endMatch(self._currentLeaderPeerId(), "abandoned");
        });

        this.scene.events.game.on("mp_phase_in_lobby", function() { self._pruneFromRoster(); });
        this.scene.events.game.on("mp_phase_in_game", function() { self._pruneFromRoster(); });
        this.scene.events.game.on("mp_roster_changed", function() {
            self._pruneFromRoster();
            if (!self._initialized) return;
            self._ensureRemoteProxies();
            // Late joiners have no course locally because the original
            // jj_course_init fired before they connected. Re-broadcast
            // so their scene spawns spinners + rails.
            //
            // mp_roster_changed fires the moment the server reports the
            // new peer, which is BEFORE the host's WebRTC data channel
            // to that peer has opened. A broadcast right now would be
            // dropped by the unopened channel. Retry a few times over
            // ~3s to cover channel handshake latency.
            var mp3 = self.scene._mp;
            if (!mp3 || !mp3.isHost) return;
            self._broadcastCurrentRound();
            setTimeout(function() { self._broadcastCurrentRound(); }, 800);
            setTimeout(function() { self._broadcastCurrentRound(); }, 2000);
            setTimeout(function() { self._broadcastCurrentRound(); }, 3500);
        });
    }

    onUpdate(dt) {
        if (!this._initialized || this._matchOver) return;
        this._phaseClock += dt;

        // Spinner rotation + collision (every peer).
        this._tickSpinners(dt);

        // Spectator camera target — pick the highest-place not-yet-
        // eliminated player if local is eliminated.
        this._updateSpectateTarget();

        // HUD push throttled.
        this._hudTimer += dt;
        if (this._hudTimer >= this._hudUpdateInterval) {
            this._hudTimer = 0;
            this._pushHud();
        }

        // Host-only phase machine.
        var mp = this.scene._mp;
        if (!mp || mp.isHost) {
            this._tickHostPhase(dt);
        } else {
            // Non-host peers still need finish-line detection so the
            // first-to-cross feels instant. They broadcast a qualify
            // intent; host applies and re-broadcasts as authority.
            this._checkLocalFinishLine();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Match init
    // ═══════════════════════════════════════════════════════════════════

    _initMatch() {
        var mp = this.scene._mp;
        if (!mp) return;

        this._phase = "warmup";
        this._phaseClock = 0;
        this._roundIndex = 0;
        this._matchOver = false;
        this._activePlayers = {};
        this._qualifiedOrder = [];
        this._eliminatedThisRound = [];
        this._allTimeResults = {};
        this._wipeCourse();

        var roster = mp.roster;
        if (roster && roster.peers) {
            for (var i = 0; i < roster.peers.length; i++) {
                var pid = roster.peers[i].peerId;
                this._activePlayers[pid] = { qualified: false, eliminated: false, place: 0 };
                this._allTimeResults[pid] = { rounds: 0, eliminations: 0, finalPlace: null };
            }
        }

        this._stampLocalNetworkIdentity();
        this._ensureRemoteProxies();
        this._initialized = true;

        // Host kicks off the first round immediately.
        if (mp.isHost) {
            this._hostStartRound(0);
        }
        this._pushHud();
    }

    _stampLocalNetworkIdentity() {
        var mp = this.scene._mp;
        if (!mp) return;
        var p = this._findLocalPlayerEntity();
        if (!p) return;
        var ni = p.getComponent("NetworkIdentityComponent");
        if (ni) {
            ni.networkId = this._hashPeerId(mp.localPeerId);
            ni.ownerId = mp.localPeerId;
            ni.isLocalPlayer = true;
        }
    }

    // Pre-spawn a scene entity per remote peer with a matching networkId
    // so the adapter's snapshot flow binds to our entity (which carries
    // the real player GLB) rather than falling back to a blue capsule.
    _ensureRemoteProxies() {
        var mp = this.scene._mp;
        if (!mp || !mp.roster || !mp.roster.peers) return;
        for (var i = 0; i < mp.roster.peers.length; i++) {
            var peerId = mp.roster.peers[i].peerId;
            if (!peerId || peerId === mp.localPeerId) continue;
            var netId = this._hashPeerId(peerId);
            var existing = this._findRemoteProxyEntity(netId);
            if (existing) {
                var mr = existing.getComponent ? existing.getComponent("MeshRendererComponent") : null;
                if (mr && mr.meshType === "custom") continue;
                if (this.scene.destroyEntity) this.scene.destroyEntity(existing.id);
            }
            this._createRemotePlayerProxy(peerId, netId);
        }
    }

    _findRemoteProxyEntity(netId) {
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("networked") : [];
        for (var i = 0; i < all.length; i++) {
            var ni = all[i].getComponent("NetworkIdentityComponent");
            if (ni && ni.networkId === netId && !ni.isLocalPlayer) return all[i];
        }
        return null;
    }

    _createRemotePlayerProxy(peerId, netId) {
        if (!this.scene.createEntity) return;
        var entId = this.scene.createEntity("RemotePlayer_" + peerId);
        if (entId == null) return;
        this.scene.setPosition(entId, 0, 2, 0);
        this.scene.setScale && this.scene.setScale(entId, 1.1, 1.1, 1.1);
        this.scene.addComponent(entId, "MeshRendererComponent", {
            meshType: "custom",
            meshAsset: "/assets/quaternius/3d_models/cube_world/Character_Female_2.glb",
            baseColor: [1, 1, 1, 1],
        });
        this.scene.addComponent(entId, "RigidbodyComponent", {
            bodyType: "kinematic",
            mass: 60,
            freezeRotation: true,
        });
        this.scene.addComponent(entId, "ColliderComponent", {
            shapeType: "capsule",
            radius: 0.5,
            height: 1.0,
        });
        this.scene.addComponent(entId, "NetworkIdentityComponent", {
            networkId: netId,
            ownerId: peerId,
            isLocalPlayer: false,
            syncTransform: true,
        });
        if (this.scene.addTag) {
            this.scene.addTag(entId, "player");
            this.scene.addTag(entId, "remote");
            this.scene.addTag(entId, "networked");
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Host phase machine
    // ═══════════════════════════════════════════════════════════════════

    _tickHostPhase(dt) {
        var mp = this.scene._mp;
        if (!mp) return;

        if (this._phase === "intro") {
            if (this._phaseClock >= this._introDurationSec) {
                this._phase = "live";
                this._phaseClock = 0;
                this.scene.events.game.emit("jj_round_started", { round: this._roundIndex + 1 });
                mp.sendNetworkedEvent("jj_round_start", { phase: "live", round: this._roundIndex });
            }
        } else if (this._phase === "live") {
            // Host owns the finish-line detection authoritatively.
            this._checkAllFinishLines();
            // Round end conditions: reached qualifier target OR timeout.
            var liveCount = this._countActive();
            if (this._qualifiedOrder.length >= this._qualifyingThisRound
                || liveCount === 0
                || this._phaseClock >= this._roundDurationSec) {
                this._endRoundHost();
            }
        } else if (this._phase === "results") {
            if (this._phaseClock >= this._resultsDurationSec) {
                if (this._roundIndex + 1 >= this._totalRounds || this._countAlive() <= this._winnerCount) {
                    this._enterPodium();
                } else {
                    this._hostStartRound(this._roundIndex + 1);
                }
            }
        } else if (this._phase === "podium") {
            // Stay on podium for a few seconds, then fire match_ended.
            if (this._phaseClock >= 6.0) {
                this._endMatch(this._podiumLeader(), "complete");
            }
        }
    }

    _hostStartRound(roundIdx) {
        this._roundIndex = roundIdx;
        this._phase = "intro";
        this._phaseClock = 0;
        this._qualifiedOrder = [];
        this._eliminatedThisRound = [];
        // Reset per-round flags on every still-alive player.
        for (var pid in this._activePlayers) {
            var ap = this._activePlayers[pid];
            if (!ap.eliminated) ap.qualified = false;
        }

        var aliveCount = this._countAlive();
        var goal = Math.max(this._minQualifiers, Math.ceil(aliveCount * this._qualifierFraction));
        if (goal > aliveCount) goal = aliveCount;
        if (roundIdx === this._totalRounds - 1) goal = this._winnerCount;
        this._qualifyingThisRound = goal;

        this._course = this._generateCourse(roundIdx);
        this._buildCourseLocally(this._course);
        this._teleportLocalToStart();

        var mp = this.scene._mp;
        if (mp) {
            mp.sendNetworkedEvent("jj_course_init", { course: this._course });
            mp.sendNetworkedEvent("jj_round_start", {
                phase: "intro",
                round: roundIdx,
                totalRounds: this._totalRounds,
                courseName: this._course.name,
                qualifyingThisRound: goal,
            });
        }
        this.scene.events.game.emit("jj_round_starting", {
            round: roundIdx + 1,
            totalRounds: this._totalRounds,
            name: this._course.name,
        });
    }

    _endRoundHost() {
        // Mark non-qualifiers as eliminated for the round + all time.
        var mp = this.scene._mp;
        var elim = [];
        for (var pid in this._activePlayers) {
            var ap = this._activePlayers[pid];
            if (ap.eliminated) continue;
            if (!ap.qualified) {
                ap.eliminated = true;
                this._allTimeResults[pid].eliminations++;
                elim.push(pid);
            } else {
                this._allTimeResults[pid].rounds++;
            }
        }

        this._phase = "results";
        this._phaseClock = 0;
        for (var i = 0; i < elim.length; i++) {
            this.scene.events.game.emit("jj_player_eliminated", { peerId: elim[i] });
            if (mp) mp.sendNetworkedEvent("jj_eliminate", { peerId: elim[i] });
        }
        this.scene.events.game.emit("jj_round_ended", { round: this._roundIndex + 1 });
        if (mp) mp.sendNetworkedEvent("jj_round_end", {
            round: this._roundIndex,
            qualified: this._qualifiedOrder,
            eliminated: elim,
        });
    }

    _enterPodium() {
        this._phase = "podium";
        this._phaseClock = 0;
        // Assign final places: latest qualifiers first, then earlier
        // eliminations by reverse round count.
        var ranked = [];
        for (var pid in this._activePlayers) {
            ranked.push({
                peerId: pid,
                rounds: this._allTimeResults[pid].rounds,
                eliminated: this._activePlayers[pid].eliminated,
            });
        }
        ranked.sort(function(a, b) {
            if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
            return b.rounds - a.rounds;
        });
        for (var i = 0; i < ranked.length; i++) {
            this._allTimeResults[ranked[i].peerId].finalPlace = i + 1;
        }
        var mp = this.scene._mp;
        if (mp) mp.sendNetworkedEvent("jj_round_end", { phase: "podium", finalPlaces: this._allTimeResults });
    }

    _endMatch(winnerPeerId, reason) {
        this._matchOver = true;
        var mp = this.scene._mp;
        var payload = {
            winner: winnerPeerId || "",
            reason: reason,
            results: this._allTimeResults,
        };
        if (mp) mp.sendNetworkedEvent("match_ended", payload);
        this.scene.events.game.emit("match_ended", { winner: winnerPeerId || "", reason: reason });
        this._pushPodium(payload);
        if (mp && mp.isHost && mp.endMatch) mp.endMatch();
    }

    _podiumLeader() {
        var best = null, bestPlace = 999;
        for (var pid in this._allTimeResults) {
            var p = this._allTimeResults[pid].finalPlace;
            if (p && p < bestPlace) { bestPlace = p; best = pid; }
        }
        return best;
    }

    _currentLeaderPeerId() {
        // Tie-breaker for early end: most rounds survived, then earliest
        // qualifier order in the active round.
        var best = null, bestRounds = -1;
        for (var pid in this._allTimeResults) {
            if (this._activePlayers[pid] && !this._activePlayers[pid].eliminated) {
                var r = this._allTimeResults[pid].rounds;
                if (r > bestRounds) { bestRounds = r; best = pid; }
            }
        }
        return best;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Round / qualify / eliminate state application
    // ═══════════════════════════════════════════════════════════════════

    _applyRoundStart(d) {
        this._roundIndex = Number(d.round) || 0;
        this._phase = (d.phase === "live") ? "live" : "intro";
        this._phaseClock = 0;
        this._qualifiedOrder = [];
        this._eliminatedThisRound = [];
        if (d.qualifyingThisRound) this._qualifyingThisRound = Number(d.qualifyingThisRound);
        for (var pid in this._activePlayers) {
            var ap = this._activePlayers[pid];
            if (!ap.eliminated) ap.qualified = false;
        }
        this.scene.events.game.emit("jj_round_starting", {
            round: this._roundIndex + 1,
            totalRounds: this._totalRounds,
            name: d.courseName || "",
        });
        if (this._phase === "live") {
            this.scene.events.game.emit("jj_round_started", { round: this._roundIndex + 1 });
        }
        this._teleportLocalToStart();
    }

    _applyRoundEnd(d) {
        this._phase = d.phase === "podium" ? "podium" : "results";
        this._phaseClock = 0;
        if (Array.isArray(d.eliminated)) {
            for (var i = 0; i < d.eliminated.length; i++) {
                this._applyEliminate(d.eliminated[i]);
            }
        }
    }

    _applyQualify(peerId, place) {
        var ap = this._activePlayers[peerId];
        if (!ap || ap.eliminated || ap.qualified) return;
        ap.qualified = true;
        ap.place = place || (this._qualifiedOrder.length + 1);
        if (this._qualifiedOrder.indexOf(peerId) < 0) this._qualifiedOrder.push(peerId);
        this.scene.events.game.emit("jj_player_qualified", { peerId: peerId, place: ap.place });
    }

    _applyEliminate(peerId) {
        var ap = this._activePlayers[peerId];
        if (!ap) return;
        ap.eliminated = true;
        this.scene.events.game.emit("jj_player_eliminated", { peerId: peerId });
        if (this._eliminatedThisRound.indexOf(peerId) < 0) this._eliminatedThisRound.push(peerId);
    }

    _countActive() {
        var n = 0;
        for (var pid in this._activePlayers) {
            if (!this._activePlayers[pid].eliminated && !this._activePlayers[pid].qualified) n++;
        }
        return n;
    }

    _countAlive() {
        var n = 0;
        for (var pid in this._activePlayers) {
            if (!this._activePlayers[pid].eliminated) n++;
        }
        return n;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Course generation + spawning
    // ═══════════════════════════════════════════════════════════════════

    _generateCourse(roundIdx) {
        // Difficulty curve: more spinners, faster rotation, narrower
        // course as rounds progress.
        var base = roundIdx + 1;
        var spinnerCount = 2 + base * 2;
        var spinners = [];
        var spacing = this._courseLength / (spinnerCount + 1);
        for (var i = 0; i < spinnerCount; i++) {
            var x = -this._courseLength / 2 + spacing * (i + 1);
            // Alternate Z offsets so beams stagger across the course.
            var zOff = (i % 3 === 0) ? 0 : (i % 2 === 0 ? 2 : -2);
            // Faster as rounds progress; alternate spin direction.
            var speed = (40 + base * 22) * (i % 2 === 0 ? 1 : -1);
            spinners.push({ x: x, z: zOff, angleDeg: i * 30, speedDeg: speed });
        }
        var palette = ["#ffd166", "#ef476f", "#06d6a0", "#118ab2", "#a78bfa"];
        return {
            roundIndex: roundIdx,
            name: roundIdx === 0 ? "GUMDROP DASH"
                : roundIdx === 1 ? "WHISKED AWAY"
                : roundIdx === 2 ? "FROSTING FALL"
                : "JELLY FINALS",
            startX: -this._courseLength / 2 + 4,
            finishX: this._courseLength / 2 - 3,
            spinners: spinners,
            palette: palette,
        };
    }

    _buildCourseLocally(course) {
        this._wipeCourse();
        this._course = course;
        var scene = this.scene;

        // Spinners — long thin cubes, kinematic so the player is pushed
        // by our manual knockback. Using a simple cube primitive keeps
        // the entity count low and the GPU happy.
        var palette = course.palette || ["#ffd166"];
        for (var i = 0; i < course.spinners.length; i++) {
            var s = course.spinners[i];
            var entId = scene.createEntity ? scene.createEntity("Spinner_" + i) : null;
            if (entId == null) continue;
            scene.setPosition(entId, s.x, this._spinnerHeight, s.z);
            scene.setScale && scene.setScale(entId, this._spinnerLength, this._spinnerHeight, this._spinnerThickness);
            var hex = palette[i % palette.length];
            scene.addComponent(entId, "MeshRendererComponent", {
                meshType: "cube",
                baseColor: this._hexToRGBA(hex),
            });
            scene.addComponent(entId, "RigidbodyComponent", {
                bodyType: "kinematic",
                mass: 1,
                freezeRotation: false,
            });
            // Collider size=1 unit — physics multiplies halfExtents by
            // the entity's transform scale, so the visible cuboid
            // dimensions come from setScale above. Passing the scaled
            // dimensions here would double them.
            scene.addComponent(entId, "ColliderComponent", {
                shapeType: "cuboid",
                size: { x: 1, y: 1, z: 1 },
            });
            if (scene.addTag) scene.addTag(entId, "jj_spinner");
            this._spinners.push({
                entityId: entId,
                x: s.x, z: s.z,
                angleDeg: Number(s.angleDeg) || 0,
                speedDeg: Number(s.speedDeg) || 60,
                length: this._spinnerLength,
            });
        }

        // Finish-line gate — wide colored slab the system tests against.
        var fid = scene.createEntity ? scene.createEntity("FinishLine") : null;
        if (fid != null) {
            scene.setPosition(fid, course.finishX, 1.5, 0);
            scene.setScale && scene.setScale(fid, 1.0, 3, this._courseHalfWidth * 2);
            scene.addComponent(fid, "MeshRendererComponent", {
                meshType: "cube",
                baseColor: [0.3, 0.92, 0.5, 0.6],
            });
            if (scene.addTag) scene.addTag(fid, "jj_finish");
            this._finishLineEntityId = fid;
        }

        // Start gate — visual marker so players see where to spawn.
        var sid = scene.createEntity ? scene.createEntity("StartGate") : null;
        if (sid != null) {
            scene.setPosition(sid, course.startX - 1, 1.5, 0);
            scene.setScale && scene.setScale(sid, 0.5, 3, this._courseHalfWidth * 2);
            scene.addComponent(sid, "MeshRendererComponent", {
                meshType: "cube",
                baseColor: [1.0, 0.83, 0.35, 0.55],
            });
            if (scene.addTag) scene.addTag(sid, "jj_start");
            this._startGateEntityId = sid;
        }

        // Side rails so players can't fall off the course — at +Z and -Z.
        for (var dir = 0; dir < 2; dir++) {
            var rid = scene.createEntity ? scene.createEntity("Rail_" + dir) : null;
            if (rid == null) continue;
            scene.setPosition(rid, 0, 0.6, (dir === 0 ? 1 : -1) * (this._courseHalfWidth + 0.4));
            scene.setScale && scene.setScale(rid, this._courseLength, 1.2, 0.6);
            scene.addComponent(rid, "MeshRendererComponent", {
                meshType: "cube",
                baseColor: [0.65, 0.42, 0.85, 1],
            });
            scene.addComponent(rid, "RigidbodyComponent", {
                bodyType: "static",
                mass: 1,
                freezeRotation: true,
            });
            scene.addComponent(rid, "ColliderComponent", {
                shapeType: "cuboid",
                size: { x: 1, y: 1, z: 1 },
            });
            this._decorEntityIds.push(rid);
        }

        // Now that the course (and spawn gates) exist locally, place
        // the local player at their slot. Safe to always run here — if
        // they were already teleported by _applyRoundStart, this just
        // re-affirms the same position.
        this._teleportLocalToStart();
    }

    _wipeCourse() {
        for (var i = 0; i < this._spinners.length; i++) {
            try { this.scene.destroyEntity && this.scene.destroyEntity(this._spinners[i].entityId); } catch (e) {}
        }
        for (var j = 0; j < this._decorEntityIds.length; j++) {
            try { this.scene.destroyEntity && this.scene.destroyEntity(this._decorEntityIds[j]); } catch (e) {}
        }
        if (this._finishLineEntityId) try { this.scene.destroyEntity && this.scene.destroyEntity(this._finishLineEntityId); } catch (e) {}
        if (this._startGateEntityId) try { this.scene.destroyEntity && this.scene.destroyEntity(this._startGateEntityId); } catch (e) {}
        this._spinners = [];
        this._decorEntityIds = [];
        this._finishLineEntityId = null;
        this._startGateEntityId = null;
    }

    _broadcastCurrentRound() {
        var mp = this.scene._mp;
        if (!mp || !this._course) return;
        mp.sendNetworkedEvent("jj_course_init", { course: this._course });
        mp.sendNetworkedEvent("jj_round_start", {
            phase: this._phase,
            round: this._roundIndex,
            totalRounds: this._totalRounds,
            courseName: this._course.name,
            qualifyingThisRound: this._qualifyingThisRound,
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Spinner rotation + collision
    // ═══════════════════════════════════════════════════════════════════

    _tickSpinners(dt) {
        // Just advance rotation and lock position + velocity. The
        // spinners are kinematic bodies with real box colliders
        // (created in _buildCourseLocally) — rapier handles pushing
        // the dynamic player capsule away when the bar sweeps through,
        // same pattern stumble_dash uses. Locking position/velocity
        // every frame counteracts any drift the physics integrator
        // might introduce on a kinematic body.
        for (var i = 0; i < this._spinners.length; i++) {
            var s = this._spinners[i];
            s.angleDeg += s.speedDeg * dt;
            this.scene.setPosition && this.scene.setPosition(s.entityId, s.x, this._spinnerHeight, s.z);
            this.scene.setVelocity && this.scene.setVelocity(s.entityId, { x: 0, y: 0, z: 0 });
            this.scene.setRotationEuler && this.scene.setRotationEuler(s.entityId, 0, s.angleDeg, 0);
        }
    }

    _wrapAngle(a) {
        while (a > 180)  a -= 360;
        while (a < -180) a += 360;
        return a;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Finish-line detection
    // ═══════════════════════════════════════════════════════════════════

    _checkAllFinishLines() {
        // Host scans every player entity and qualifies anyone past the
        // finish line who isn't already qualified or eliminated.
        if (!this._course) return;
        var finishX = this._course.finishX;
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < all.length; i++) {
            var p = all[i];
            var ni = p.getComponent ? p.getComponent("NetworkIdentityComponent") : null;
            if (!ni || !ni.ownerId) continue;
            var ap = this._activePlayers[ni.ownerId];
            if (!ap || ap.qualified || ap.eliminated) continue;
            var pos = p.transform ? p.transform.position : null;
            if (!pos) continue;
            if (pos.x >= finishX) {
                this._applyQualify(ni.ownerId, this._qualifiedOrder.length + 1);
                var mp = this.scene._mp;
                if (mp) mp.sendNetworkedEvent("jj_qualify", {
                    peerId: ni.ownerId,
                    place: this._qualifiedOrder.length,
                });
            }
        }
    }

    _checkLocalFinishLine() {
        if (!this._course) return;
        var mp = this.scene._mp;
        if (!mp) return;
        var ap = this._activePlayers[mp.localPeerId];
        if (!ap || ap.qualified || ap.eliminated) return;
        var local = this._findLocalPlayerEntity();
        if (!local) return;
        var pos = local.transform.position;
        if (pos.x >= this._course.finishX) {
            // Optimistic local apply for snappy UI; host will echo back.
            this._applyQualify(mp.localPeerId, this._qualifiedOrder.length + 1);
            mp.sendNetworkedEvent("jj_qualify", {
                peerId: mp.localPeerId,
                place: this._qualifiedOrder.length,
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Spawning + spectator camera
    // ═══════════════════════════════════════════════════════════════════

    _teleportLocalToStart() {
        if (!this._course) return;
        var mp = this.scene._mp;
        if (!mp) return;
        var local = this._findLocalPlayerEntity();
        if (!local) return;
        var roster = mp.roster;
        var peers = (roster && roster.peers ? roster.peers.map(function(p) { return p.peerId; }) : []).sort();
        var slot = peers.indexOf(mp.localPeerId);
        if (slot < 0) slot = 0;
        // Spread spawns across Z at the start gate.
        var n = Math.max(peers.length, 4);
        var z = -this._courseHalfWidth + 1 + (this._courseHalfWidth * 2 - 2) * (slot + 0.5) / n;
        this.scene.setPosition(local.id, this._course.startX, 1.0, z);
        this.scene.setVelocity && this.scene.setVelocity(local.id, { x: 0, y: 0, z: 0 });
    }

    _updateSpectateTarget() {
        var mp = this.scene._mp;
        if (!mp) {
            this.scene._jjSpectateTargetId = null;
            return;
        }
        var ap = this._activePlayers[mp.localPeerId];
        if (!ap || !ap.eliminated) {
            this.scene._jjSpectateTargetId = null;
            return;
        }
        // Pick the still-alive leader by qualified order, falling back to
        // any still-alive peer.
        var aliveCandidates = [];
        for (var pid in this._activePlayers) {
            if (!this._activePlayers[pid].eliminated) aliveCandidates.push(pid);
        }
        if (aliveCandidates.length === 0) {
            this.scene._jjSpectateTargetId = null;
            return;
        }
        var pickPid = aliveCandidates[0];
        for (var i = 0; i < aliveCandidates.length; i++) {
            if (this._allTimeResults[aliveCandidates[i]].rounds >
                this._allTimeResults[pickPid].rounds) {
                pickPid = aliveCandidates[i];
            }
        }
        var ent = this._findPlayerByPeerId(pickPid);
        this.scene._jjSpectateTargetId = ent ? ent.id : null;
    }

    _findLocalPlayerEntity() {
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < all.length; i++) {
            var p = all[i];
            var ni = p.getComponent("NetworkIdentityComponent");
            if (ni && ni.isLocalPlayer) return p;
        }
        return all[0] || null;
    }

    _findPlayerByPeerId(peerId) {
        if (!peerId) return null;
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < all.length; i++) {
            var p = all[i];
            var ni = p.getComponent("NetworkIdentityComponent");
            if (ni && ni.ownerId === peerId) return p;
        }
        return null;
    }

    _pruneFromRoster() {
        var mp = this.scene._mp;
        if (!mp || !mp.roster) return;
        var current = {};
        for (var i = 0; i < mp.roster.peers.length; i++) {
            current[mp.roster.peers[i].peerId] = true;
        }
        for (var p in this._activePlayers) {
            if (!current[p]) {
                delete this._activePlayers[p];
                delete this._allTimeResults[p];
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // HUD payloads
    // ═══════════════════════════════════════════════════════════════════

    _pushHud() {
        var mp = this.scene._mp;
        if (!mp) return;
        var pid = mp.localPeerId;
        var roster = mp.roster;
        var ap = this._activePlayers[pid];
        var youStatus = "racing";
        if (ap && ap.eliminated)      youStatus = "eliminated";
        else if (ap && ap.qualified)  youStatus = "qualified";

        var phaseLabel = this._phase;
        var bigText = "";
        var bigSub = "";
        if (this._phase === "intro") {
            var cd = Math.max(0, Math.ceil(this._introDurationSec - this._phaseClock));
            bigText = "ROUND " + (this._roundIndex + 1) + " · " + (this._course ? this._course.name : "");
            bigSub = "Starting in " + cd + "…";
        } else if (this._phase === "results") {
            bigText = "ROUND " + (this._roundIndex + 1) + " RESULTS";
            bigSub = (this._roundIndex + 1 < this._totalRounds && this._countAlive() > this._winnerCount)
                ? "Next round in " + Math.max(0, Math.ceil(this._resultsDurationSec - this._phaseClock)) + "s"
                : "Tallying podium…";
        } else if (this._phase === "podium") {
            bigText = "PODIUM";
            bigSub = "";
        }

        var qualifiedNames = [];
        var roster_peers = roster ? roster.peers : [];
        for (var i = 0; i < this._qualifiedOrder.length; i++) {
            var qpid = this._qualifiedOrder[i];
            qualifiedNames.push({
                place: i + 1,
                name: this._peerName(roster_peers, qpid),
                isLocal: qpid === pid,
            });
        }

        var leaderboard = [];
        for (var k = 0; k < roster_peers.length; k++) {
            var prr = roster_peers[k];
            var apr = this._activePlayers[prr.peerId];
            var rr = this._allTimeResults[prr.peerId] || { rounds: 0, eliminations: 0, finalPlace: null };
            leaderboard.push({
                peerId: prr.peerId,
                name: prr.username,
                isLocal: prr.peerId === pid,
                rounds: rr.rounds,
                eliminated: !!(apr && apr.eliminated),
                qualified: !!(apr && apr.qualified),
            });
        }
        leaderboard.sort(function(a, b) {
            if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
            return b.rounds - a.rounds;
        });

        var timeRemaining = 0;
        if (this._phase === "live") {
            timeRemaining = Math.max(0, Math.ceil(this._roundDurationSec - this._phaseClock));
        }

        this.scene.events.ui.emit("hud_update", {
            jellyJam: {
                phase: this._phase,
                phaseClock: this._phaseClock,
                round: this._roundIndex + 1,
                totalRounds: this._totalRounds,
                courseName: this._course ? this._course.name : "",
                youStatus: youStatus,
                qualifyingThisRound: this._qualifyingThisRound,
                qualifiedSoFar: this._qualifiedOrder.length,
                qualifiedList: qualifiedNames,
                leaderboard: leaderboard,
                timeRemaining: timeRemaining,
                bigText: bigText,
                bigSub: bigSub,
            },
        });
    }

    _pushPodium(payload) {
        var mp = this.scene._mp;
        var pid = mp ? mp.localPeerId : "";
        var winner = payload.winner;
        var roster = mp && mp.roster;
        var winnerName = "Nobody";
        if (roster && winner) {
            for (var i = 0; i < roster.peers.length; i++) {
                if (roster.peers[i].peerId === winner) { winnerName = roster.peers[i].username; break; }
            }
        }
        var iWon = winner && winner === pid;
        var title = iWon ? "CHAMPION!" : (winner ? winnerName + " WINS" : "DRAW");
        var stats = {};
        var results = (payload && payload.results) || this._allTimeResults || {};
        if (roster && roster.peers) {
            var keys = Object.keys(results).slice().sort(function(a, b) {
                return (results[a].finalPlace || 999) - (results[b].finalPlace || 999);
            });
            for (var k = 0; k < keys.length; k++) {
                var p = keys[k];
                var name = this._peerName(roster.peers, p) + (p === pid ? " (you)" : "");
                stats[name] = "place " + (results[p].finalPlace || "—") + " · " + results[p].rounds + " rounds";
            }
        }
        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: results[pid] ? results[pid].rounds : 0, stats: stats },
        });
    }

    _peerName(peers, peerId) {
        if (peers) {
            for (var i = 0; i < peers.length; i++) {
                if (peers[i].peerId === peerId) return peers[i].username;
            }
        }
        return peerId ? peerId.slice(0, 6) : "";
    }

    _hashPeerId(peerId) {
        var h = 2166136261;
        for (var i = 0; i < peerId.length; i++) {
            h ^= peerId.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return ((h >>> 0) % 1000000) + 1000;
    }

    _hexToRGBA(hex) {
        var h = hex.replace("#", "");
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        var r = parseInt(h.substring(0, 2), 16) / 255;
        var g = parseInt(h.substring(2, 4), 16) / 255;
        var b = parseInt(h.substring(4, 6), 16) / 255;
        return [r, g, b, 1];
    }
}
