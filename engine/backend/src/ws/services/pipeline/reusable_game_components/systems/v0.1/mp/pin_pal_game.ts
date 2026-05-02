// also: bowling, turn-based-sports, pin-scoring, projectile-sports
// Pin Pal — Wii Sports-style multiplayer turn-based 10-pin bowling.
//
// 1-4 players take turns rolling a ball at a 10-pin triangle. Aim
// is set with the cursor (left/right slide along the throw line),
// power is set by holding LMB to fill a meter, and releasing fires
// the ball. Standard 10-frame scoring: strike on the first throw
// of a frame ends the frame and bonuses with the next two throws;
// spare bonuses with the next one; otherwise just the pins down.
// Frame 10 grants a bonus throw on a strike or spare.
//
// Authority: host owns the rack reset, scoring, and turn rotation.
// Throw input is read locally on the active player's machine, then
// broadcast — so the host can simulate authoritatively while the
// thrower's tab still gets snappy feedback. Ball physics are local
// + sync'd via the standard syncTransform pathway.
//
// Reusable beyond Pin Pal: any "throw at static targets" sport (10
// pin, candlepin, skee-ball, lawn bowls) can re-use the turn /
// frame / score machine; just retag your projectiles + targets.
class PinPalGameSystem extends GameScript {
    // ─── Tunable parameters ─────────────────────────────────────────
    _laneAxisX = 1;             // unit vector down the lane (defaults +X)
    _laneAxisZ = 0;
    _laneStartX = -10;          // X of the throw line (ball spawns here)
    _laneStartZ = 0;
    _laneEndX = 12;             // X where pins are racked (head pin)
    _laneEndZ = 0;
    _laneHalfWidth = 1.0;       // gutter inside lane is ±this
    _aimRange = 0.85;           // ±this on Z (aim band cursor sweeps)
    _ballRadius = 0.18;
    _ballMass = 7.0;
    _maxThrowSpeed = 22;
    _minThrowSpeed = 8;
    _ballRestY = 0.20;
    _restThresholdSpeed = 0.10;
    _restWaitFrames = 30;
    _rollingTimeoutSec = 10;     // hard cap on a throw — catches stuck/drifting balls
    _pinFallTiltDeg = 30;
    _hudUpdateInterval = 0.15;
    _aimUpdateInterval = 0.06;
    _pinResetDelay = 0.7;
    _turnFrames = 10;
    _winnerHoldSec = 5;

    // ─── Runtime state ──────────────────────────────────────────────
    _initialized = false;
    _matchOver = false;
    _phase = "warmup";          // warmup | aiming | charging | rolling | resolving | between | complete
    _phaseClock = 0;
    _hudTimer = 0;
    _aimSendTimer = 0;

    // Per-player score sheet — frame[i] = { throws:[n1,n2,(n3)?], bonus:n }
    _scores = {};               // peerId → array of frame objects
    _frameTotals = {};          // peerId → array of running totals (one per frame)
    _orderedPeerIds = [];

    _activeIdx = 0;             // index into _orderedPeerIds
    _frameIdx = 0;              // 0..9
    _throwIdx = 0;              // 0 or 1 (or 2 in 10th)
    _restCounter = 0;
    _ballEntityId = null;
    _pinEntityIds = [];         // populated from world tags at init
    _pinHomePositions = [];     // [{x,y,z}] — for resets
    _knockedThisFrame = {};     // pinIndex → true (during current frame)

    _aim = 0;                   // -1..+1 along Z (aim slider)
    _power = 0;                 // 0..1 charge fraction
    _charging = false;
    _remoteAim = 0;             // latest broadcast values — not shown in UI,
    _remotePower = 0;           //   tracked for potential spectator use
    _cursorX = 0;               // virtual-cursor screen pos from ui_bridge —
    _cursorY = 0;               //   needed because pointer lock freezes the
    _gotCursor = false;         //   raw getMousePosition().
    _pendingChargeStart = null; // queued cursor_click event ({x,y}) — drives
                                //   the press-frame charge transition with
                                //   coords that match the actual touch.
    _aimTargetX = 12;           // world-space ground point the cursor is on
    _aimTargetZ = 0;            //   — the ball is thrown straight at this
    _hasAimTarget = false;      //   so "shoot where I point" is literal.
    _rollingElapsed = 0;        // time since ball was thrown, resets each throw
    _pinResetTimer = 0;
    _justScoredFrame = null;    // for HUD pulse

    onStart() {
        var self = this;
        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });

        // Net broadcasts.
        this.scene.events.game.on("net_pp_throw", function(evt) {
            var d = (evt && evt.data) || {};
            var mp = self.scene._mp;
            // Our own throw was already applied locally — skip.
            if (mp && d.peerId === mp.localPeerId) return;
            // Every other peer (host + remote clients) spawns their own
            // ball with the broadcast initial conditions. Physics runs
            // independently on each peer; the host's simulation is the
            // authority for pin counts. Non-shooters would otherwise be
            // watching pins fall over with no visible projectile.
            self._applyRemoteThrow(d);
        });
        this.scene.events.game.on("net_pp_aim", function(evt) {
            var d = (evt && evt.data) || {};
            var mp = self.scene._mp;
            if (!mp || d.peerId === mp.localPeerId) return;
            self._remoteAim = Number(d.aim) || 0;
            self._remotePower = Number(d.power) || 0;
        });
        this.scene.events.game.on("net_pp_pin_count", function(evt) {
            var d = (evt && evt.data) || {};
            var throwIdx = Number(d.throwIdx) || 0;
            self._applyPinCount(d.peerId, Number(d.count) || 0, throwIdx);
            // Host authoritatively resolved this throw. Every peer
            // clears its local ball so the camera stops fixating on a
            // stale projectile once the next thrower's turn starts.
            self._removeBall();
            // Reopen input for the next throw. If the frame ended the
            // host will follow up with net_pp_turn which reassigns the
            // active player — that's fine, it just reaffirms aiming.
            // Without this, a player stuck in "rolling" can't click to
            // start charging their second throw. Leave the phase alone
            // if the match has ended so we don't flicker past the
            // game-over UI.
            if (self._phase !== "complete" && !self._matchOver) {
                self._throwIdx = throwIdx + 1;
                self._phase = "aiming";
                self._charging = false;
                self._power = 0;
                self._restCounter = 0;
                self._rollingElapsed = 0;
            }
        });
        this.scene.events.game.on("net_pp_frame_score", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.peerId || typeof d.frame !== "number") return;
            // Refresh local frame totals from broadcast.
            if (d.totals && Array.isArray(d.totals)) self._frameTotals[d.peerId] = d.totals;
            self._justScoredFrame = { peerId: d.peerId, frame: d.frame };
            self.scene.events.game.emit("pp_frame_complete", {
                peerId: d.peerId,
                frame: d.frame + 1,
                frameScore: Number(d.frameScore) || 0,
                total: Number(d.total) || 0,
            });
        });
        this.scene.events.game.on("net_pp_turn", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyTurnChange(d);
        });
        this.scene.events.game.on("net_pp_pins_reset", function() {
            self._resetPinsLocally();
        });
        this.scene.events.game.on("net_pp_match_ended", function(evt) {
            if (self._matchOver) return;
            self._matchOver = true;
            var d = (evt && evt.data) || {};
            self.scene.events.game.emit("match_ended", { winner: d.winner || "", reason: d.reason || "" });
            self._pushGameOver(d);
        });

        // Track the virtual cursor. Play mode runs pointer-locked, so
        // getMousePosition() sticks at the lock origin; ui_bridge is
        // what integrates mouse delta into a visible cursor and emits
        // this event. The ground-projection for aim reads its coords.
        this.scene.events.ui.on("cursor_move", function(d) {
            if (!d) return;
            self._cursorX = d.x;
            self._cursorY = d.y;
            self._gotCursor = true;
        });
        // Charge starts on tap. Coords come from the cursor_click event
        // payload so the initial aim point matches the actual touch on
        // the press frame; polling MouseLeft against cached _cursorX/Y
        // would land the first-frame aim at the previous cursor location
        // on touch (where a tap is the only event that moves the cursor).
        this.scene.events.ui.on("cursor_click", function(d) {
            if (!d) return;
            self._pendingChargeStart = d;
        });

        // Session lifecycle.
        this.scene.events.game.on("mp_below_min_players", function() {
            if (self._matchOver) return;
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            self._endMatch(self._winnerPeerId(), "abandoned");
        });
    }

    onUpdate(dt) {
        if (!this._initialized || this._matchOver) return;
        this._phaseClock += dt;
        this._hudTimer += dt;
        this._aimSendTimer += dt;

        // Local input — only the active player drives aim/charge.
        if (this._isMyTurn()) this._tickInput(dt);

        // Pin reset timer (between throws when pins need a fresh rack).
        if (this._pinResetTimer > 0) {
            this._pinResetTimer -= dt;
            if (this._pinResetTimer <= 0) {
                var mp = this.scene._mp;
                if (!mp || mp.isHost) {
                    this._resetPinsLocally();
                    if (mp) mp.sendNetworkedEvent("pp_pins_reset", {});
                }
            }
        }

        // Host: rest detection after a throw. A hard timeout guards
        // against a ball that rolls forever (got wedged, spinning in
        // the gutter, drifting off the lane edge) so the turn still
        // advances.
        var mp2 = this.scene._mp;
        if ((!mp2 || mp2.isHost) && this._phase === "rolling") {
            this._rollingElapsed += dt;
            if (this._rollingElapsed >= this._rollingTimeoutSec) {
                this._resolveThrowHost();
            } else if (this._allPhysicsAtRest()) {
                this._restCounter++;
                if (this._restCounter >= this._restWaitFrames) {
                    this._resolveThrowHost();
                }
            } else {
                this._restCounter = 0;
            }
        }

        if (this._phase === "complete") {
            if (this._phaseClock >= this._winnerHoldSec) {
                this._endMatch(this._winnerPeerId(), "complete");
            }
        }

        // Aim broadcast at low frequency for non-host peers viewing.
        if (this._aimSendTimer >= this._aimUpdateInterval && this._isMyTurn()
            && (this._phase === "aiming" || this._phase === "charging")) {
            this._aimSendTimer = 0;
            var mp3 = this.scene._mp;
            if (mp3) mp3.sendNetworkedEvent("pp_aim", {
                peerId: mp3.localPeerId, aim: this._aim, power: this._power,
            });
        }

        if (this._hudTimer >= this._hudUpdateInterval) {
            this._hudTimer = 0;
            this._pushHud();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Match lifecycle
    // ═══════════════════════════════════════════════════════════════════

    _initMatch() {
        var mp = this.scene._mp;
        this._matchOver = false;
        this._phase = "aiming";
        this._phaseClock = 0;
        this._activeIdx = 0;
        this._frameIdx = 0;
        this._throwIdx = 0;
        this._restCounter = 0;
        this._rollingElapsed = 0;
        this._knockedThisFrame = {};
        this._pinResetTimer = 0;
        this._aim = 0;
        this._power = 0;
        this._charging = false;

        this._orderedPeerIds = [];
        this._scores = {};
        this._frameTotals = {};
        if (mp && mp.roster) {
            // Sort peerIds for deterministic turn order.
            var ids = mp.roster.peers.map(function(p) { return p.peerId; }).sort();
            for (var i = 0; i < ids.length; i++) {
                this._orderedPeerIds.push(ids[i]);
                this._scores[ids[i]] = [];
                this._frameTotals[ids[i]] = [];
                for (var f = 0; f < this._turnFrames; f++) {
                    this._scores[ids[i]].push({ throws: [], frameScore: 0 });
                    this._frameTotals[ids[i]].push(null);
                }
            }
        }
        if (this._orderedPeerIds.length === 0) {
            // Single-player practice — fake one entry.
            this._orderedPeerIds = [""];
            this._scores[""] = [];
            this._frameTotals[""] = [];
            for (var f2 = 0; f2 < this._turnFrames; f2++) {
                this._scores[""].push({ throws: [], frameScore: 0 });
                this._frameTotals[""].push(null);
            }
        }

        this._cachePinHomes();
        this._resetPinsLocally();
        this._removeBall();

        if (!mp || mp.isHost) this._broadcastTurn();
        this._initialized = true;
        this._pushHud();
    }

    _endMatch(winnerPeerId, reason) {
        this._matchOver = true;
        var mp = this.scene._mp;
        var payload = {
            winner: winnerPeerId || "",
            reason: reason || "complete",
            scores: this._frameTotals,
        };
        if (mp) mp.sendNetworkedEvent("match_ended", payload);
        this.scene.events.game.emit("match_ended", { winner: payload.winner, reason: payload.reason });
        this.scene.events.game.emit("pp_match_won", { peerId: payload.winner, score: this._totalFor(payload.winner) });
        this._pushGameOver(payload);
        if (mp && mp.isHost && mp.endMatch) mp.endMatch();
    }

    _pushGameOver(payload) {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        var localPid = mp && mp.localPeerId;
        var winner = payload && payload.winner;
        var winnerName = "Nobody";
        if (roster && winner) {
            for (var i = 0; i < roster.peers.length; i++) {
                if (roster.peers[i].peerId === winner) { winnerName = roster.peers[i].username; break; }
            }
        }
        var iWon = winner && winner === localPid;
        var title = iWon ? "STRIKE OUT VICTORY" : (winner ? winnerName + " takes the alley" : "Tied alley");
        var stats = {};
        if (this._orderedPeerIds && this._orderedPeerIds.length) {
            for (var k = 0; k < this._orderedPeerIds.length; k++) {
                var pid = this._orderedPeerIds[k];
                var name = this._peerName(roster, pid) + (pid === localPid ? " (you)" : "");
                stats[name] = String(this._totalFor(pid));
            }
        }
        if (payload.reason === "abandoned") stats["Reason"] = "Opponents left";
        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: this._totalFor(localPid || ""), stats: stats },
        });
    }

    _winnerPeerId() {
        var bestPid = "", best = -1;
        for (var pid in this._frameTotals) {
            var t = this._totalFor(pid);
            if (t > best) { best = t; bestPid = pid; }
        }
        return bestPid;
    }

    _totalFor(pid) {
        var arr = this._frameTotals[pid] || [];
        for (var i = arr.length - 1; i >= 0; i--) {
            if (arr[i] != null) return arr[i];
        }
        return 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Pins + ball
    // ═══════════════════════════════════════════════════════════════════

    _cachePinHomes() {
        var pins = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("pp_pin") : [];
        // Sort by name for deterministic indices (Pin_1, Pin_2, ...).
        pins.sort(function(a, b) {
            var na = (a.name || ""), nb = (b.name || "");
            return na < nb ? -1 : na > nb ? 1 : 0;
        });
        this._pinEntityIds = [];
        this._pinHomePositions = [];
        for (var i = 0; i < pins.length; i++) {
            var p = pins[i];
            var pos = p.transform.position;
            this._pinEntityIds.push(p.id);
            this._pinHomePositions.push({ x: pos.x, y: pos.y, z: pos.z });
        }
    }

    _resetPinsLocally() {
        for (var i = 0; i < this._pinEntityIds.length; i++) {
            var id = this._pinEntityIds[i];
            var home = this._pinHomePositions[i];
            this.scene.setPosition(id, home.x, home.y, home.z);
            this.scene.setRotationEuler && this.scene.setRotationEuler(id, 0, 0, 0);
            this.scene.setVelocity && this.scene.setVelocity(id, { x: 0, y: 0, z: 0 });
        }
        this._knockedThisFrame = {};
    }

    _countStandingPins() {
        var standing = 0;
        for (var i = 0; i < this._pinEntityIds.length; i++) {
            var id = this._pinEntityIds[i];
            var ent = this.scene.getEntity ? this.scene.getEntity(id) : null;
            if (!ent) continue;
            // Check tilt: cross-product of local up vs world up. Using
            // entity.transform.getRotationEuler — if pitch or roll
            // exceed _pinFallTiltDeg, count as down. Also count off-y
            // (below floor) as down.
            var rot = ent.transform.getRotationEuler ? ent.transform.getRotationEuler() : { x: 0, y: 0, z: 0 };
            var tiltX = Math.abs(this._wrapDeg(rot.x || 0));
            var tiltZ = Math.abs(this._wrapDeg(rot.z || 0));
            if (tiltX > this._pinFallTiltDeg || tiltZ > this._pinFallTiltDeg) continue;
            if (ent.transform.position.y < this._pinHomePositions[i].y - 0.4) continue;
            standing++;
        }
        return standing;
    }

    _wrapDeg(d) {
        while (d > 180)  d -= 360;
        while (d < -180) d += 360;
        return d;
    }

    _spawnBall(spawnZ) {
        this._removeBall();
        var scene = this.scene;
        if (!scene.createEntity) return;
        var id = scene.createEntity("pp_ball");
        if (id == null) return;
        scene.setPosition(id, this._laneStartX, this._ballRestY, this._laneStartZ + spawnZ);
        scene.setScale && scene.setScale(id, this._ballRadius * 2, this._ballRadius * 2, this._ballRadius * 2);
        scene.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: [0.18, 0.42, 0.85, 1],
        });
        scene.addComponent(id, "RigidbodyComponent", {
            bodyType: "dynamic",
            mass: this._ballMass,
            freezeRotation: false,
        });
        scene.addComponent(id, "ColliderComponent", {
            shapeType: "sphere",
            radius: this._ballRadius,
        });
        if (scene.addTag) scene.addTag(id, "pp_ball");
        this._ballEntityId = id;
    }

    _removeBall() {
        if (!this._ballEntityId) return;
        try { this.scene.destroyEntity && this.scene.destroyEntity(this._ballEntityId); } catch (e) {}
        this._ballEntityId = null;
    }

    _allPhysicsAtRest() {
        // Ball + every pin must be moving below threshold for N frames.
        var thresh2 = this._restThresholdSpeed * this._restThresholdSpeed;
        var checks = this._pinEntityIds.slice();
        if (this._ballEntityId) checks.push(this._ballEntityId);
        for (var i = 0; i < checks.length; i++) {
            var v = this.scene.getVelocity ? this.scene.getVelocity(checks[i]) : null;
            if (!v) continue;
            if ((v.x * v.x + v.y * v.y + v.z * v.z) > thresh2) return false;
        }
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Aim + throw input
    // ═══════════════════════════════════════════════════════════════════

    _tickInput(dt) {
        if (this._matchOver) return;
        if (this._phase === "rolling" || this._phase === "resolving" || this._phase === "complete") {
            this._charging = false;
            return;
        }

        // Virtual cursor → world-space aim target. Project the cursor
        // onto the lane plane (Y=0); that world point is exactly where
        // the ball will be sent when the user releases. (Raw
        // getMousePosition is frozen under pointer lock — use the
        // ui_bridge cursor position instead.) Clamp the target to
        // stay in front of the throw line so the ball can't fire
        // backwards when the cursor hovers over UI or the horizon.
        if (this._gotCursor && this.scene.screenPointToGround) {
            var g = this.scene.screenPointToGround(this._cursorX, this._cursorY, 0);
            if (g) {
                var tx = g.x, tz = g.z;
                if (tx < this._laneStartX + 1) tx = this._laneStartX + 1;
                this._aimTargetX = tx;
                this._aimTargetZ = tz;
                this._hasAimTarget = true;
                // Keep _aim populated as a normalized value for the
                // HUD power/aim readout (not used for the throw).
                var raw = (tz - this._laneStartZ) / this._aimRange;
                if (raw < -1) raw = -1;
                if (raw > 1)  raw = 1;
                this._aim = raw;
            }
        }

        var lDown = this.input.isKeyDown && this.input.isKeyDown("MouseLeft");
        // Charge start consumed from the cursor_click event (set in
        // onStart). Releasing is held-state, so the existing isKeyDown
        // poll handles the throw on release.
        if (this._pendingChargeStart) {
            this._charging = true;
            this._pendingChargeStart = null;
        }
        if (this._charging && lDown) {
            this._phase = "charging";
            this._power = Math.min(1, this._power + dt * 0.85);
        } else if (this._charging && !lDown) {
            this._charging = false;
            var p = Math.max(0.18, this._power);
            var tx = this._hasAimTarget ? this._aimTargetX : this._laneEndX;
            var tz = this._hasAimTarget ? this._aimTargetZ : 0;
            this._executeThrowLocal(p, this._aim, tx, tz);
            this._power = 0;
        } else {
            this._phase = "aiming";
            this._power = 0;
        }
    }

    _executeThrowLocal(power, aim, targetX, targetZ) {
        var mp = this.scene._mp;
        var localPid = mp ? mp.localPeerId : "";
        // Ball spawns at the throw line (center). Velocity aims
        // straight at the cursor's ground point so the throw goes
        // exactly where the player pointed.
        this._spawnBall(0);
        var speed = this._minThrowSpeed + (this._maxThrowSpeed - this._minThrowSpeed) * power;
        var vel = this._throwVelocityToward(targetX, targetZ, 0, speed);
        if (this.scene.setVelocity) this.scene.setVelocity(this._ballEntityId, vel);
        this._phase = "rolling";
        this._restCounter = 0;
        this._rollingElapsed = 0;
        this._playThrowSfx(power);
        this.scene.events.game.emit("pp_throw_taken", { peerId: localPid, power: power, aim: aim });
        if (mp) mp.sendNetworkedEvent("pp_throw", {
            peerId: localPid, power: power, aim: aim, tx: targetX, tz: targetZ,
        });
    }

    _applyRemoteThrow(d) {
        var power = Number(d.power) || 0.5;
        var aim = Number(d.aim) || 0;
        // Fall back to aim-slider geometry when the sender didn't
        // include a target (older clients, or a broadcast loss).
        var targetX = (typeof d.tx === "number") ? d.tx : this._laneEndX;
        var targetZ = (typeof d.tz === "number") ? d.tz : aim * this._aimRange;
        this._spawnBall(0);
        var speed = this._minThrowSpeed + (this._maxThrowSpeed - this._minThrowSpeed) * power;
        var vel = this._throwVelocityToward(targetX, targetZ, 0, speed);
        if (this.scene.setVelocity) this.scene.setVelocity(this._ballEntityId, vel);
        this._phase = "rolling";
        this._restCounter = 0;
        this._rollingElapsed = 0;
        this._playThrowSfx(power);
    }

    _throwVelocityToward(targetX, targetZ, spawnZ, speed) {
        var dirX = targetX - this._laneStartX;
        var dirZ = targetZ - (this._laneStartZ + spawnZ);
        if (dirX <= 0) dirX = 0.01;  // never shoot backwards
        var dirLen = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
        return {
            x: (dirX / dirLen) * speed,
            y: 0,
            z: (dirZ / dirLen) * speed,
        };
    }

    _playThrowSfx(power) {
        if (!this.audio) return;
        this.audio.playSound("/assets/kenney/audio/impact_sounds/footstep_concrete_004.ogg",
            0.4 + 0.3 * power);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Score resolution (host)
    // ═══════════════════════════════════════════════════════════════════

    _resolveThrowHost() {
        var mp = this.scene._mp;
        var pid = this._activePeerId();
        if (!pid) return;

        // Count newly-knocked pins this throw.
        var standing = this._countStandingPins();
        // We don't track per-pin which fell on this throw vs last — we
        // rely on the throws-array to express the difference: pins
        // standing now = pins.length - sum(throws so far in this frame).
        var sheet = this._scores[pid][this._frameIdx];
        var beforeKnocked = 0;
        for (var i = 0; i < sheet.throws.length; i++) beforeKnocked += sheet.throws[i];
        var totalKnocked = this._pinEntityIds.length - standing;
        var pinsThisThrow = Math.max(0, totalKnocked - beforeKnocked);

        sheet.throws.push(pinsThisThrow);
        this.scene.events.game.emit("pp_pin_count", {
            peerId: pid, count: pinsThisThrow, throwIdx: this._throwIdx,
        });
        if (mp) mp.sendNetworkedEvent("pp_pin_count", {
            peerId: pid, count: pinsThisThrow, throwIdx: this._throwIdx,
        });
        if (pinsThisThrow === 0) this.scene.events.game.emit("pp_gutter", { peerId: pid });

        this._removeBall();

        var frameOver = this._isFrameOver(sheet);
        // Strike + spare events for HUD pulse.
        if (this._frameIdx < 9) {
            if (sheet.throws.length === 1 && sheet.throws[0] === 10) {
                this.scene.events.game.emit("pp_strike", { peerId: pid, frame: this._frameIdx + 1 });
            } else if (sheet.throws.length === 2 && sheet.throws[0] + sheet.throws[1] === 10) {
                this.scene.events.game.emit("pp_spare", { peerId: pid, frame: this._frameIdx + 1 });
            }
        }

        // Refresh running totals for everyone (frame closure only firms
        // up later frames once their bonuses are known).
        this._recomputeAllTotals();
        if (mp) mp.sendNetworkedEvent("pp_frame_score", {
            peerId: pid,
            frame: this._frameIdx,
            frameScore: sheet.throws.reduce(function(a, b) { return a + b; }, 0),
            total: this._totalFor(pid),
            totals: this._frameTotals[pid],
        });

        if (!frameOver) {
            // Reset pins ONLY if we're going for the second throw and
            // not a strike. Pins should remain standing-as-they-are
            // for the second throw (so player sees the leftover pins).
            // The throw counter advances; another throw is queued.
            this._throwIdx++;
            this._phase = "aiming";
            this._restCounter = 0;
            return;
        }

        // Frame ended. Move to next thrower / next frame.
        this._frameIdx++;
        this._throwIdx = 0;
        // Reset pins for next frame after a short delay (lets the
        // player see the result before the rack springs back).
        this._pinResetTimer = this._pinResetDelay;

        // Did everyone finish the last frame?
        if (this._frameIdx >= this._turnFrames) {
            // Match complete. Best score wins.
            this._phase = "complete";
            this._phaseClock = 0;
            return;
        }

        // Rotate to next player.
        this._activeIdx = (this._activeIdx + 1) % this._orderedPeerIds.length;
        // If we wrapped back to the first player but they've already
        // played frameIdx, advance frame counter for them too — easier
        // to think of as "everyone plays frame N before anyone plays
        // frame N+1." We've already incremented frameIdx above; that's
        // global, so the next player's sheet[frameIdx] is the right
        // slot.
        this._broadcastTurn();
        this._phase = "aiming";
        this._restCounter = 0;
    }

    _isFrameOver(sheet) {
        var t = sheet.throws;
        if (this._frameIdx < 9) {
            if (t.length === 0) return false;
            if (t.length === 1) return t[0] === 10;  // strike
            return true;                              // 2 throws done
        }
        // Frame 10: strike OR spare grants a 3rd throw.
        if (t.length === 0) return false;
        if (t.length === 1) return false;
        if (t.length === 2) {
            if (t[0] === 10) return false;             // strike → bonus
            if (t[0] + t[1] === 10) return false;      // spare → bonus
            return true;
        }
        return true;  // 3 throws — done
    }

    _recomputeAllTotals() {
        for (var p = 0; p < this._orderedPeerIds.length; p++) {
            var pid = this._orderedPeerIds[p];
            var sheets = this._scores[pid];
            var run = 0;
            for (var f = 0; f < sheets.length; f++) {
                var sheet = sheets[f];
                var inc = this._frameScore(pid, f);
                if (inc == null) {
                    this._frameTotals[pid][f] = null;
                    continue;
                }
                run += inc;
                this._frameTotals[pid][f] = run;
            }
        }
    }

    // Returns the value of frame f for peerId pid, or null if not yet
    // resolvable (e.g. pending strike bonus throws).
    _frameScore(pid, f) {
        var sheets = this._scores[pid];
        var sheet = sheets[f];
        if (!sheet || sheet.throws.length === 0) return null;
        if (f < 9) {
            if (sheet.throws[0] === 10) {
                // Strike — needs next 2 throws.
                var b1 = this._nthThrowAfter(pid, f, 1);
                var b2 = this._nthThrowAfter(pid, f, 2);
                if (b1 == null || b2 == null) return null;
                return 10 + b1 + b2;
            }
            if (sheet.throws.length < 2) return null;
            var sum = sheet.throws[0] + sheet.throws[1];
            if (sum === 10) {
                var bsp = this._nthThrowAfter(pid, f, 1);
                if (bsp == null) return null;
                return 10 + bsp;
            }
            return sum;
        }
        // Frame 10 — sum of all throws (up to 3).
        if (!this._isFrameOver(sheet)) return null;
        var s = 0;
        for (var i = 0; i < sheet.throws.length; i++) s += sheet.throws[i];
        return s;
    }

    _nthThrowAfter(pid, fromFrame, n) {
        // Walk forward through frames, return the n-th individual throw.
        var sheets = this._scores[pid];
        var seen = 0;
        for (var f = fromFrame + 1; f < sheets.length; f++) {
            var t = sheets[f].throws;
            for (var i = 0; i < t.length; i++) {
                seen++;
                if (seen === n) return t[i];
            }
        }
        return null;
    }

    _activePeerId() {
        return this._orderedPeerIds[this._activeIdx] || "";
    }

    _isMyTurn() {
        var mp = this.scene._mp;
        if (!mp) return true;
        return mp.localPeerId === this._activePeerId();
    }

    _broadcastTurn() {
        var mp = this.scene._mp;
        var pid = this._activePeerId();
        var payload = { peerId: pid, frame: this._frameIdx, throwIdx: this._throwIdx };
        if (mp) mp.sendNetworkedEvent("pp_turn", payload);
        this.scene.events.game.emit("pp_turn_changed", payload);
    }

    _applyTurnChange(d) {
        if (!d) return;
        var pid = d.peerId || "";
        var idx = this._orderedPeerIds.indexOf(pid);
        if (idx >= 0) this._activeIdx = idx;
        if (typeof d.frame === "number")    this._frameIdx = d.frame;
        if (typeof d.throwIdx === "number") this._throwIdx = d.throwIdx;
        this._phase = "aiming";
        this._restCounter = 0;
        // Defensive: if the prior throw's pin_count event was dropped
        // or otherwise missed, ensure no ball lingers into a new turn.
        this._removeBall();
    }

    _applyPinCount(pid, count, throwIdx) {
        if (!pid) return;
        var sheet = this._scores[pid][this._frameIdx];
        if (!sheet) return;
        // Only push if our local count for this throw doesn't already
        // exist (avoids double-counting host's local apply).
        if (sheet.throws.length > throwIdx) return;
        sheet.throws.push(count);
        this._recomputeAllTotals();
    }

    // ═══════════════════════════════════════════════════════════════════
    // HUD payload
    // ═══════════════════════════════════════════════════════════════════

    _peerName(roster, pid) {
        if (!pid) return "—";
        if (roster) {
            for (var i = 0; i < roster.peers.length; i++) {
                if (roster.peers[i].peerId === pid) return roster.peers[i].username;
            }
        }
        return pid.slice(0, 6);
    }

    _pushHud() {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        var localPid = mp && mp.localPeerId;
        var rows = [];
        for (var i = 0; i < this._orderedPeerIds.length; i++) {
            var pid = this._orderedPeerIds[i];
            var name = this._peerName(roster, pid);
            rows.push({
                peerId: pid,
                name: name,
                isLocal: pid === localPid,
                isActive: pid === this._activePeerId(),
                frames: (this._scores[pid] || []).map(function(f) { return f.throws.slice(); }),
                totals: (this._frameTotals[pid] || []).slice(),
                total: this._totalFor(pid),
            });
        }
        var standing = this._countStandingPins();
        var amActive = this._isMyTurn();
        this.scene.events.ui.emit("hud_update", {
            pinPal: {
                phase: this._phase,
                frame: this._frameIdx + 1,
                throwIdx: this._throwIdx + 1,
                rows: rows,
                // Only the active thrower sees the aim reticle + power
                // meter for their own throw. Non-active peers would
                // otherwise see the charging UI mirror the shooter,
                // which reads as "I can shoot too" when they can't.
                aim: amActive ? this._aim : 0,
                power: amActive ? this._power : 0,
                charging: amActive && this._charging,
                youAreActive: amActive,
                activeName: this._peerName(roster, this._activePeerId()),
                pinsStanding: standing,
                pinsTotal: this._pinEntityIds.length,
            },
        });
    }
}
