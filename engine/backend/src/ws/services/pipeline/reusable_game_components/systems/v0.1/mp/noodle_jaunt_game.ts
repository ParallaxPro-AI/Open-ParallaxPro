// also: co-op-platformer, checkpoint-progression, puzzle-gauntlet, ragdoll
// Noodle Jaunt — Human-Fall-Flat-style floppy puzzle platformer.
//
// 1-4 player co-op (or solo). Players spawn at the start pad and
// jaunt across an obstacle course of bridges, button-doors, push
// blocks, and climbing walls until they reach the goal flag. The
// course is a single linear stage broken into "checkpoints" that
// each player can finish individually — first to the flag wins,
// but everyone gets a finish time. Death = fall off the edge,
// auto-respawn at the last checkpoint reached.
//
// Authority model: host owns puzzle state (button down? door
// open? plate weighted?) so all peers' worlds stay aligned. Each
// peer's player ragdoll is dynamic and synced via the standard
// snapshot pathway. Carry-objects are host-authoritative — only
// the host actually moves them when a peer grabs one (the system
// listens for `nj_grab_started` with kind="carry" and snaps the
// cube to the carrier's chest).
//
// Reusable beyond Noodle Jaunt: any physics-puzzle / co-op
// platformer can use the button/plate/door state machine and the
// checkpoint progression — just point the system at differently
// tagged props in the world JSON.
class NoodleJauntGameSystem extends GameScript {
    // ─── Tunable parameters ─────────────────────────────────────────
    _stageCount = 4;
    _fallY = -8;                  // below this Y → respawn at last checkpoint
    _respawnDelaySec = 1.2;
    _doorOpenY = 4.0;
    _doorSpeed = 5.0;
    _buttonPressRadius = 1.2;
    _plateActivationRadius = 1.0;
    _checkpointRadius = 2.5;
    _goalRadius = 2.0;
    _carryHoldHeight = 1.1;
    _carryHoldDistance = 1.3;
    _carryFollowSpeed = 14;
    _hudUpdateInterval = 0.15;
    _matchDurationSec = 600;       // soft cap
    _winnerHoldSec = 6;             // podium duration

    // ─── Runtime state ──────────────────────────────────────────────
    _initialized = false;
    _matchOver = false;
    _phase = "playing";             // playing | finished
    _phaseClock = 0;
    _hudTimer = 0;
    _elapsed = 0;

    _checkpoints = [];              // [{ id, x, z }]
    _checkpointReached = {};        // peerId → highest cp index
    _finishOrder = [];              // [{ peerId, time }]
    _respawnTimers = {};            // peerId → secs

    _buttonState = {};              // buttonId → pressed
    _plateState = {};
    _doorState = {};                // doorId → { entityId, baseY, openY, target, open }
    _carries = {};                  // peerId → { entityId, kind }

    onStart() {
        var self = this;
        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });

        // Local grab → if it's a carry-tagged cube, the system pulls
        // the cube to the carrier's chest each frame. We track the
        // current carry per peer so multiple peers don't fight over
        // the same cube (last-grabber wins).
        this.scene.events.game.on("nj_grab_started", function(d) {
            var mp = self.scene._mp;
            if (!d || !d.peerId || !d.kind) return;
            if (d.kind !== "carry") return;
            // We don't get the entity ID over the wire; resolve it
            // ourselves by finding the closest carryable to the
            // grabbing peer's player.
            var carrier = self._findPlayerByPeerId(d.peerId);
            if (!carrier) return;
            var nearest = self._findNearestCarryable(carrier.transform.position);
            if (!nearest) return;
            self._carries[d.peerId] = { entityId: nearest.id };
        });
        this.scene.events.game.on("nj_grab_released", function(d) {
            if (!d || !d.peerId) return;
            // Only release if BOTH hands are released — we use a single
            // entry per peer rather than per hand. To keep things
            // simple, treat any grab_released as full release. Real-
            // game refinements (one hand still gripping) can ship
            // later.
            if (self._carries[d.peerId]) delete self._carries[d.peerId];
        });

        // Net broadcasts from host.
        this.scene.events.game.on("net_nj_button_state", function(evt) {
            var d = (evt && evt.data) || {};
            if (d.buttonId) self._applyButtonState(d.buttonId, !!d.pressed);
        });
        this.scene.events.game.on("net_nj_door_state", function(evt) {
            var d = (evt && evt.data) || {};
            if (d.doorId) self._applyDoorState(d.doorId, !!d.open);
        });
        this.scene.events.game.on("net_nj_plate_state", function(evt) {
            var d = (evt && evt.data) || {};
            if (d.plateId) self._applyPlateState(d.plateId, !!d.pressed);
        });
        this.scene.events.game.on("net_nj_player_finished", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.peerId) return;
            if (!self._finishOrder.find(function(f) { return f.peerId === d.peerId; })) {
                self._finishOrder.push({ peerId: d.peerId, time: Number(d.time) || 0 });
                self.scene.events.game.emit("nj_player_finished", {
                    peerId: d.peerId, place: self._finishOrder.length, time: Number(d.time) || 0,
                });
            }
        });
        this.scene.events.game.on("net_nj_match_ended", function(evt) {
            if (self._matchOver) return;
            var d = (evt && evt.data) || {};
            self._matchOver = true;
            self.scene.events.game.emit("match_ended", { winner: d.winner || "", reason: d.reason || "" });
            self._pushGameOver(d.winner, d.reason);
        });

        // Session lifecycle.
        this.scene.events.game.on("mp_below_min_players", function() {
            if (self._matchOver) return;
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            self._endMatch(self._winnerPeerId(), "abandoned");
        });
        this.scene.events.game.on("mp_host_changed", function() {
            if (!self._initialized || self._matchOver) return;
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            self._broadcastFullState();
        });
    }

    onUpdate(dt) {
        if (!this._initialized || this._matchOver) return;
        this._phaseClock += dt;
        this._elapsed += dt;
        this._hudTimer += dt;

        this._tickRespawns(dt);
        this._tickCheckpoints();
        this._tickCarries(dt);
        this._tickButtons();
        this._tickPlates();
        this._tickDoors(dt);
        this._tickGoal();
        this._tickRemoteAnimations(dt);

        if (this._hudTimer >= this._hudUpdateInterval) {
            this._hudTimer = 0;
            this._pushHud();
        }

        if (this._phase === "finished") {
            if (this._phaseClock >= this._winnerHoldSec) {
                this._endMatch(this._winnerPeerId(), "complete");
            }
        }

        // Safety net: if everyone has finished, end the match.
        var mp = this.scene._mp;
        if (mp && mp.roster && this._finishOrder.length >= mp.roster.peers.length && this._phase !== "finished") {
            this._phase = "finished";
            this._phaseClock = 0;
        }

        // Time hard-cap.
        if (this._elapsed >= this._matchDurationSec && this._phase !== "finished") {
            this._endMatch(this._winnerPeerId(), "time");
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Match lifecycle
    // ═══════════════════════════════════════════════════════════════════

    _initMatch() {
        this._matchOver = false;
        this._phase = "playing";
        this._phaseClock = 0;
        this._elapsed = 0;
        this._checkpointReached = {};
        this._finishOrder = [];
        this._respawnTimers = {};
        this._carries = {};
        this._buildCheckpointTable();
        this._buildButtonTable();
        this._buildPlateTable();
        this._buildDoorTable();
        this._teleportLocalToSpawn();
        this._stampLocalNetworkIdentity();
        this._initialized = true;
        this._pushHud();
    }

    _endMatch(winnerPeerId, reason) {
        this._matchOver = true;
        var mp = this.scene._mp;
        var payload = { winner: winnerPeerId || "", reason: reason || "complete" };
        if (mp) mp.sendNetworkedEvent("match_ended", payload);
        this.scene.events.game.emit("match_ended", { winner: payload.winner, reason: payload.reason });
        this._pushGameOver(winnerPeerId, reason);
        if (mp && mp.isHost && mp.endMatch) mp.endMatch();
    }

    _pushGameOver(winnerPeerId, reason) {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        var localPid = mp && mp.localPeerId;
        var iWon = winnerPeerId && winnerPeerId === localPid;
        var winnerName = "Nobody";
        if (roster && winnerPeerId) {
            for (var i = 0; i < roster.peers.length; i++) {
                if (roster.peers[i].peerId === winnerPeerId) { winnerName = roster.peers[i].username; break; }
            }
        }
        var title;
        if (!winnerPeerId) title = "Time's up";
        else if (iWon)      title = "FIRST TO THE FLAG!";
        else                title = winnerName + " reached it first";
        var stats = {};
        for (var i = 0; i < this._finishOrder.length; i++) {
            var f = this._finishOrder[i];
            var name = this._peerName(roster, f.peerId);
            stats[(i + 1) + ". " + name + (f.peerId === localPid ? " (you)" : "")] = this._formatTime(f.time);
        }
        if (reason === "time")      stats["Reason"] = "Time up";
        else if (reason === "abandoned") stats["Reason"] = "Too few players";
        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: this._finishOrder.length, stats: stats },
        });
    }

    _winnerPeerId() {
        if (this._finishOrder.length > 0) return this._finishOrder[0].peerId;
        // Tie-breaker: highest checkpoint reached.
        var best = -1, bestPid = "";
        for (var pid in this._checkpointReached) {
            if (this._checkpointReached[pid] > best) {
                best = this._checkpointReached[pid];
                bestPid = pid;
            }
        }
        return bestPid;
    }

    _formatTime(sec) {
        var m = Math.floor(sec / 60);
        var s = Math.floor(sec % 60);
        return m + ":" + (s < 10 ? "0" : "") + s;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Checkpoints + spawn
    // ═══════════════════════════════════════════════════════════════════

    _buildCheckpointTable() {
        this._checkpoints = [];
        var ents = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("nj_checkpoint") : [];
        // Sort by name so the world can declare Cp_1, Cp_2, ... in order.
        ents.sort(function(a, b) {
            var na = (a.name || ""), nb = (b.name || "");
            return na < nb ? -1 : na > nb ? 1 : 0;
        });
        for (var i = 0; i < ents.length; i++) {
            var e = ents[i];
            var p = e.transform.position;
            this._checkpoints.push({ id: e.name || ("Cp_" + i), x: p.x, z: p.z });
        }
        if (this._checkpoints.length === 0) {
            // Fallback: a virtual checkpoint at world origin so respawns
            // don't NaN out when a designer forgets to place any.
            this._checkpoints.push({ id: "Cp_0", x: 0, z: 0 });
        }
    }

    _tickCheckpoints() {
        var mp = this.scene._mp;
        if (!mp || !mp.roster) return;
        for (var i = 0; i < mp.roster.peers.length; i++) {
            var pid = mp.roster.peers[i].peerId;
            var ent = this._findPlayerByPeerId(pid);
            if (!ent) continue;
            var p = ent.transform.position;
            var cur = this._checkpointReached[pid] || 0;
            for (var c = this._checkpoints.length - 1; c > cur; c--) {
                var cp = this._checkpoints[c];
                var dx = p.x - cp.x, dz = p.z - cp.z;
                if (dx * dx + dz * dz < this._checkpointRadius * this._checkpointRadius) {
                    this._checkpointReached[pid] = c;
                    break;
                }
            }
        }
    }

    _tickRespawns(dt) {
        // Player fell off the edge → start respawn timer; teleport
        // back to last checkpoint when it expires.
        var mp = this.scene._mp;
        if (!mp || !mp.roster) return;
        for (var i = 0; i < mp.roster.peers.length; i++) {
            var pid = mp.roster.peers[i].peerId;
            var ent = this._findPlayerByPeerId(pid);
            if (!ent) continue;
            var pos = ent.transform.position;
            if (pos.y < this._fallY) {
                if (!this._respawnTimers[pid]) {
                    this._respawnTimers[pid] = this._respawnDelaySec;
                }
                this._respawnTimers[pid] -= dt;
                if (this._respawnTimers[pid] <= 0) {
                    var cp = this._checkpoints[this._checkpointReached[pid] || 0];
                    if (cp) {
                        this.scene.setPosition(ent.id, cp.x, 1.5, cp.z);
                        this.scene.setVelocity && this.scene.setVelocity(ent.id, { x: 0, y: 0, z: 0 });
                    }
                    delete this._respawnTimers[pid];
                    this.scene.events.game.emit("nj_player_respawned", {
                        peerId: pid, x: cp ? cp.x : 0, z: cp ? cp.z : 0,
                    });
                }
            } else {
                if (this._respawnTimers[pid]) delete this._respawnTimers[pid];
            }
        }
    }

    _teleportLocalToSpawn() {
        var mp = this.scene._mp;
        if (!mp) return;
        var ent = this._findLocalPlayerEntity();
        if (!ent) return;
        var cp = this._checkpoints[0];
        var roster = mp.roster;
        var slot = 0;
        if (roster && roster.peers) {
            var ids = roster.peers.map(function(p) { return p.peerId; }).sort();
            slot = Math.max(0, ids.indexOf(mp.localPeerId));
        }
        var offsetZ = (slot - 1.5) * 1.2;
        this.scene.setPosition(ent.id, cp.x, 1.5, cp.z + offsetZ);
        this.scene.setVelocity && this.scene.setVelocity(ent.id, { x: 0, y: 0, z: 0 });
    }

    _stampLocalNetworkIdentity() {
        var mp = this.scene._mp;
        if (!mp) return;
        var ent = this._findLocalPlayerEntity();
        if (!ent) return;
        var ni = ent.getComponent("NetworkIdentityComponent");
        if (ni) {
            ni.networkId = this._hashPeerId(mp.localPeerId);
            ni.ownerId = mp.localPeerId;
            ni.isLocalPlayer = true;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Buttons (player presses by stepping on)
    // ═══════════════════════════════════════════════════════════════════

    _buildButtonTable() {
        this._buttonState = {};
        var btns = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("nj_button") : [];
        for (var i = 0; i < btns.length; i++) {
            this._buttonState[btns[i].name || ("Btn_" + i)] = false;
        }
    }

    _tickButtons() {
        var mp = this.scene._mp;
        if (mp && !mp.isHost) return;
        var btns = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("nj_button") : [];
        var players = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < btns.length; i++) {
            var btn = btns[i];
            var bp = btn.transform.position;
            var name = btn.name || ("Btn_" + i);
            var pressed = false;
            for (var j = 0; j < players.length; j++) {
                var pp = players[j].transform.position;
                var dx = pp.x - bp.x, dz = pp.z - bp.z, dy = pp.y - bp.y;
                if (dx * dx + dz * dz < this._buttonPressRadius * this._buttonPressRadius
                    && dy < 1.5 && dy > -0.5) {
                    pressed = true;
                    break;
                }
            }
            if (pressed !== !!this._buttonState[name]) {
                this._applyButtonState(name, pressed);
                if (mp) mp.sendNetworkedEvent("nj_button_state", { buttonId: name, pressed: pressed });
            }
        }
    }

    _applyButtonState(name, pressed) {
        if (!!this._buttonState[name] === !!pressed) return;
        this._buttonState[name] = pressed;
        // Visual: tint button green when pressed, white when released.
        var ents = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("nj_button") : [];
        for (var i = 0; i < ents.length; i++) {
            if ((ents[i].name || "") === name) {
                if (ents[i].setMaterialColor) {
                    if (pressed) ents[i].setMaterialColor(0.30, 0.92, 0.55, 1);
                    else         ents[i].setMaterialColor(0.85, 0.85, 0.90, 1);
                }
                break;
            }
        }
        this.scene.events.game.emit(pressed ? "nj_button_pressed" : "nj_button_released",
            { buttonId: name });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Pressure plates (player OR a carryable cube triggers)
    // ═══════════════════════════════════════════════════════════════════

    _buildPlateTable() {
        this._plateState = {};
        var plates = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("nj_plate") : [];
        for (var i = 0; i < plates.length; i++) {
            this._plateState[plates[i].name || ("Plate_" + i)] = false;
        }
    }

    _tickPlates() {
        var mp = this.scene._mp;
        if (mp && !mp.isHost) return;
        var plates = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("nj_plate") : [];
        var players = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        var cubes = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("nj_carryable") : [];
        for (var i = 0; i < plates.length; i++) {
            var pl = plates[i];
            var pp = pl.transform.position;
            var name = pl.name || ("Plate_" + i);
            var pressed = false;
            for (var j = 0; j < players.length; j++) {
                var ep = players[j].transform.position;
                var dx = ep.x - pp.x, dz = ep.z - pp.z, dy = ep.y - pp.y;
                if (dx * dx + dz * dz < this._plateActivationRadius * this._plateActivationRadius
                    && dy < 1.5 && dy > -0.4) { pressed = true; break; }
            }
            if (!pressed) {
                for (var k = 0; k < cubes.length; k++) {
                    var cp = cubes[k].transform.position;
                    var dx2 = cp.x - pp.x, dz2 = cp.z - pp.z, dy2 = cp.y - pp.y;
                    if (dx2 * dx2 + dz2 * dz2 < this._plateActivationRadius * this._plateActivationRadius
                        && dy2 < 1.0 && dy2 > -0.4) { pressed = true; break; }
                }
            }
            if (pressed !== !!this._plateState[name]) {
                this._applyPlateState(name, pressed);
                if (mp) mp.sendNetworkedEvent("nj_plate_state", { plateId: name, pressed: pressed });
            }
        }
    }

    _applyPlateState(name, pressed) {
        if (!!this._plateState[name] === !!pressed) return;
        this._plateState[name] = pressed;
        var ents = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("nj_plate") : [];
        for (var i = 0; i < ents.length; i++) {
            if ((ents[i].name || "") === name) {
                if (ents[i].setMaterialColor) {
                    if (pressed) ents[i].setMaterialColor(0.30, 0.92, 0.55, 1);
                    else         ents[i].setMaterialColor(0.85, 0.85, 0.90, 1);
                }
                break;
            }
        }
        this.scene.events.game.emit(pressed ? "nj_plate_pressed" : "nj_plate_released",
            { plateId: name });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Doors (open when their linked button OR plate is active)
    // ═══════════════════════════════════════════════════════════════════

    _buildDoorTable() {
        this._doorState = {};
        var doors = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("nj_door") : [];
        for (var i = 0; i < doors.length; i++) {
            var d = doors[i];
            var name = d.name || ("Door_" + i);
            var baseY = d.transform.position.y;
            this._doorState[name] = {
                entityId: d.id, baseY: baseY, openY: baseY + this._doorOpenY,
                target: baseY, open: false,
            };
        }
    }

    _tickDoors(dt) {
        var mp = this.scene._mp;
        var doors = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("nj_door") : [];
        for (var i = 0; i < doors.length; i++) {
            var d = doors[i];
            var name = d.name || ("Door_" + i);
            var st = this._doorState[name];
            if (!st) continue;
            // Naming convention: "Door_X" looks for "Btn_X" or "Plate_X"
            // — open if either is active.
            var idx = name.replace("Door_", "");
            var btn = !!this._buttonState["Btn_" + idx];
            var pl  = !!this._plateState["Plate_" + idx];
            var open = btn || pl;
            // Host-authoritative state — broadcast on transition.
            if ((!mp || mp.isHost) && open !== st.open) {
                this._applyDoorState(name, open);
                if (mp) mp.sendNetworkedEvent("nj_door_state", { doorId: name, open: open });
            }
            // Slide toward target (every peer animates locally).
            var pos = d.transform.position;
            var target = st.target;
            if (Math.abs(pos.y - target) > 0.001) {
                var step = this._doorSpeed * dt * (target > pos.y ? 1 : -1);
                var newY = pos.y + step;
                if ((step > 0 && newY > target) || (step < 0 && newY < target)) newY = target;
                this.scene.setPosition(d.id, pos.x, newY, pos.z);
            }
        }
    }

    _applyDoorState(name, open) {
        var st = this._doorState[name];
        if (!st) return;
        if (st.open === !!open) return;
        st.open = !!open;
        st.target = open ? st.openY : st.baseY;
        this.scene.events.game.emit(open ? "nj_door_opened" : "nj_door_closed", { doorId: name });
        if (this.audio) this.audio.playSound(
            open ? "/assets/kenney/audio/digital_audio/phaserUp4.ogg"
                 : "/assets/kenney/audio/digital_audio/phaserDown1.ogg", 0.4);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Carryable objects (held by players)
    // ═══════════════════════════════════════════════════════════════════

    _findNearestCarryable(playerPos) {
        var cubes = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("nj_carryable") : [];
        var best = null, bestD = 4 * 4;  // 4m max grab range
        for (var i = 0; i < cubes.length; i++) {
            var c = cubes[i];
            var p = c.transform.position;
            var dx = p.x - playerPos.x, dz = p.z - playerPos.z, dy = p.y - playerPos.y;
            var d = dx * dx + dy * dy + dz * dz;
            if (d < bestD) { bestD = d; best = c; }
        }
        return best;
    }

    _tickCarries(dt) {
        for (var pid in this._carries) {
            var info = this._carries[pid];
            if (!info) continue;
            var carrier = this._findPlayerByPeerId(pid);
            var cube = this.scene.getEntity ? this.scene.getEntity(info.entityId) : null;
            if (!carrier || !cube) {
                delete this._carries[pid];
                continue;
            }
            // Pull cube to a position in front of the carrier's chest.
            var cp = carrier.transform.position;
            var yawDeg = (this.scene._tpYaw != null && pid === (this.scene._mp && this.scene._mp.localPeerId))
                ? this.scene._tpYaw : 0;
            // For remote peers we can't read their yaw, so just pull
            // the cube into their chest position — close enough.
            var yaw = yawDeg * Math.PI / 180;
            var fwdX =  Math.sin(yaw);
            var fwdZ = -Math.cos(yaw);
            var tx = cp.x + fwdX * this._carryHoldDistance;
            var ty = cp.y + this._carryHoldHeight;
            var tz = cp.z + fwdZ * this._carryHoldDistance;
            var pos = cube.transform.position;
            var t = 1 - Math.exp(-this._carryFollowSpeed * dt);
            var nx = pos.x + (tx - pos.x) * t;
            var ny = pos.y + (ty - pos.y) * t;
            var nz = pos.z + (tz - pos.z) * t;
            this.scene.setPosition(cube.id, nx, ny, nz);
            this.scene.setVelocity && this.scene.setVelocity(cube.id, { x: 0, y: 0, z: 0 });
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Goal flag
    // ═══════════════════════════════════════════════════════════════════

    _tickGoal() {
        var mp = this.scene._mp;
        var goal = this.scene.findEntityByName ? this.scene.findEntityByName("Nj Goal") : null;
        if (!goal) return;
        var gp = goal.transform.position;
        if (!mp || !mp.roster) return;
        for (var i = 0; i < mp.roster.peers.length; i++) {
            var pid = mp.roster.peers[i].peerId;
            if (this._finishOrder.find(function(f) { return f.peerId === pid; })) continue;
            var ent = this._findPlayerByPeerId(pid);
            if (!ent) continue;
            var p = ent.transform.position;
            var dx = p.x - gp.x, dz = p.z - gp.z, dy = p.y - gp.y;
            if (dx * dx + dz * dz < this._goalRadius * this._goalRadius && dy < 2.0 && dy > -1.0) {
                this._finishOrder.push({ peerId: pid, time: this._elapsed });
                this.scene.events.game.emit("nj_player_finished", {
                    peerId: pid, place: this._finishOrder.length, time: this._elapsed,
                });
                if (mp) mp.sendNetworkedEvent("nj_player_finished", { peerId: pid, time: this._elapsed });
                if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_001.ogg", 0.55);
                if (this._finishOrder.length === 1) {
                    // First finisher kicks off the podium hold timer.
                    this._phase = "finished";
                    this._phaseClock = 0;
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════

    _findLocalPlayerEntity() {
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < all.length; i++) {
            var p = all[i];
            var ni = p.getComponent ? p.getComponent("NetworkIdentityComponent") : null;
            if (ni && ni.isLocalPlayer) return p;
            if (!ni) return p;
        }
        return all[0] || null;
    }

    // Drive Idle/Run/Jump_Start on every remote player proxy. The scene
    // strips ScriptComponent off proxies (skipBehaviors=true in the
    // network adapter), so floppy_walker — which would normally pick
    // the anim — never runs on them. Without this loop the proxy mesh
    // stays in T-pose / last-played clip on other peers' screens even
    // as the synced transform moves it around. Heuristic mirrors
    // floppy_walker's: speed > 1 → Run, airborne → Jump_Start, else
    // Idle. Velocity comes from frame-to-frame position deltas because
    // the owner's velocity isn't a networkedVar.
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
            // stuck in Jump_Start. See deathmatch_game for the full write-up.
            var airborne = Math.abs(dy) > 1.5;
            var anim = airborne ? "Jump_Start" : (spd > 1 ? "Run" : "Idle");
            if (anim !== st.anim) {
                st.anim = anim;
                try { p.playAnimation(anim, { loop: anim !== "Jump_Start" }); } catch (e) { /* missing clip */ }
            }
        }
    }

    _findPlayerByPeerId(pid) {
        if (!pid) return null;
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < all.length; i++) {
            var p = all[i];
            var ni = p.getComponent ? p.getComponent("NetworkIdentityComponent") : null;
            if (ni && ni.ownerId === pid) return p;
        }
        return null;
    }

    _peerName(roster, pid) {
        if (!pid) return "—";
        if (roster) {
            for (var i = 0; i < roster.peers.length; i++) {
                if (roster.peers[i].peerId === pid) return roster.peers[i].username;
            }
        }
        return pid.slice(0, 6);
    }

    _broadcastFullState() {
        var mp = this.scene._mp;
        if (!mp) return;
        for (var name in this._buttonState) {
            mp.sendNetworkedEvent("nj_button_state", { buttonId: name, pressed: !!this._buttonState[name] });
        }
        for (var pn in this._plateState) {
            mp.sendNetworkedEvent("nj_plate_state", { plateId: pn, pressed: !!this._plateState[pn] });
        }
        for (var dn in this._doorState) {
            mp.sendNetworkedEvent("nj_door_state", { doorId: dn, open: !!this._doorState[dn].open });
        }
    }

    _hashPeerId(peerId) {
        var h = 2166136261;
        for (var i = 0; i < peerId.length; i++) {
            h ^= peerId.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return ((h >>> 0) % 1000000) + 1000;
    }

    // ═══════════════════════════════════════════════════════════════════
    // HUD payload
    // ═══════════════════════════════════════════════════════════════════

    _pushHud() {
        var mp = this.scene._mp;
        var pid = mp && mp.localPeerId;
        var roster = mp && mp.roster;
        var myStage = (this._checkpointReached[pid] || 0) + 1;
        var totalStages = Math.max(1, this._checkpoints.length);
        var hint = "";
        if (this._phase === "finished") hint = "Hold tight — final tally coming up.";
        else if (myStage === 1)         hint = "Run, leap, grab — get to the flag.";
        else if (myStage >= totalStages) hint = "The flag is just ahead!";
        else                             hint = "Stage " + myStage + " of " + totalStages;
        var leaderboard = [];
        if (roster && roster.peers) {
            for (var i = 0; i < roster.peers.length; i++) {
                var pr = roster.peers[i];
                var fin = null;
                for (var j = 0; j < this._finishOrder.length; j++) {
                    if (this._finishOrder[j].peerId === pr.peerId) { fin = this._finishOrder[j]; break; }
                }
                leaderboard.push({
                    name: pr.username,
                    isLocal: pr.peerId === pid,
                    stage: (this._checkpointReached[pr.peerId] || 0) + 1,
                    finished: !!fin,
                    finishTime: fin ? this._formatTime(fin.time) : "",
                });
            }
            // Finished first → pinned to top; otherwise sort by stage desc.
            leaderboard.sort(function(a, b) {
                if (a.finished !== b.finished) return a.finished ? -1 : 1;
                return b.stage - a.stage;
            });
        }
        this.scene.events.ui.emit("hud_update", {
            noodleJaunt: {
                stage: myStage,
                totalStages: totalStages,
                hint: hint,
                phase: this._phase,
                grabbing: !!this.scene._njGrabbing,
                respawnIn: this._respawnTimers[pid] || 0,
                elapsed: this._formatTime(this._elapsed),
                leaderboard: leaderboard,
            },
        });
    }
}
