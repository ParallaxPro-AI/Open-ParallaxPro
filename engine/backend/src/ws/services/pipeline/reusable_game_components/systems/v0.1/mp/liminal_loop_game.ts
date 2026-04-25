// also: observation-puzzle, anomaly-spotting, hallway-gauntlet, perceptual-test
// Liminal Loop — single-player anomaly-detection corridor walker.
//
// Each iteration the player walks down a fluorescent-lit subway-style
// corridor. The system silently rolls a die: ~50% of the time an
// "anomaly" appears somewhere in the hallway — a tipped trashcan,
// a stranger standing in the middle distance, doors yawning open
// where they shouldn't be, the wrong number on the exit sign. The
// player has to spot it (or confirm there's nothing) and then commit
// at the end of the hallway:
//
//   * walking out the FAR end  = "no anomaly, continue"   (correct
//                                  iff hasAnomaly === false)
//   * walking back through the NEAR end = "anomaly, turn back"
//                                  (correct iff hasAnomaly === true)
//
// Wrong choice resets the exit number to 0; right choice advances it
// by one. Reach _targetExitNumber to win.
//
// Designed single-player but multiplayer-tolerant: only the host's
// player position drives the iteration, other peers (if any) just
// ride along watching the same hallway.
class LiminalLoopGameSystem extends GameScript {
    // ─── Tunable parameters ──────────────────────────────────────────
    _corridorHalfLength = 14;     // X = -half..+half along the hallway
    _corridorHalfWidth = 1.8;     // Z = ±half along the side-step axis
    _spawnX = 0;                  // player respawn point along corridor
    _spawnY = 1.0;
    _spawnZ = 0;
    _farEndX =  13.5;             // walking past x >= farEndX → "continue"
    _nearEndX = -13.5;            // walking past x <= nearEndX → "turn back"
    _decisionCooldownSec = 1.0;
    _targetExitNumber = 8;
    _anomalyChance = 0.55;
    _hudUpdateInterval = 0.15;
    _resetFlashSec = 1.6;
    _winFlashSec = 4.0;

    // ─── Anomaly catalog ─────────────────────────────────────────────
    // Each entry produces one runtime entity (or set of overrides) when
    // active, and self-cleans on revert. Adding new anomalies is a
    // matter of pushing another { kind, apply, revert } pair into this
    // table — the rest of the system doesn't care.
    _anomalyKinds = [
        "figure_present",      // a stranger standing mid-corridor
        "door_swing",          // one of the side doors hangs open
        "lights_red",          // ceiling lights tinted blood red
        "pillar_extra",        // an extra pillar appears mid-corridor
        "trashcan_tipped",     // trashcan rotated on its side
        "exit_wrong_number",   // exit sign reads a different number
        "ceiling_low",         // ceiling sags down ominously
        "mirror_dim",          // mirror reflects nothing (color-shifted)
    ];

    // ─── Runtime state ──────────────────────────────────────────────
    _exitNumber = 0;
    _iteration = 0;
    _hasAnomaly = false;
    _activeAnomalyKind = "";
    _anomalyEntityIds = [];        // entities created for current anomaly
    _anomalyOverrides = [];        // [{entityId, applied:{prop,old,new}}]
    _phase = "active";             // active | reset_flash | win_flash | gameover
    _phaseClock = 0;
    _initialized = false;
    _decisionCooldown = 0;
    _hudTimer = 0;
    _lastChoice = "";              // for HUD echo
    _hint = "Walk forward — turn back if something feels off.";
    _signEntityId = null;          // host might spawn a custom number sign

    onStart() {
        var self = this;
        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });

        this.scene.events.game.on("mp_below_min_players", function() {
            // Single-player so this rarely fires, but keep the cleanup
            // path so the scene doesn't get stuck on host migration.
            if (self._phase === "gameover") return;
            self._phase = "gameover";
            self._endMatch("abandoned");
        });
    }

    onUpdate(dt) {
        if (!this._initialized) return;
        this._phaseClock += dt;
        this._decisionCooldown -= dt;
        this._hudTimer += dt;
        if (this._hudTimer >= this._hudUpdateInterval) {
            this._hudTimer = 0;
            this._pushHud();
        }

        if (this._phase === "active") {
            // Only the host (or a single-player) decides what counts as
            // a choice. Watching peers just see the hallway.
            var mp = this.scene._mp;
            if (mp && !mp.isHost) return;

            var p = this._readPlayerPos();
            if (!p) return;
            if (this._decisionCooldown > 0) return;

            if (p.x >= this._farEndX) {
                this._commitChoice("continue");
            } else if (p.x <= this._nearEndX) {
                this._commitChoice("turn_back");
            }
        } else if (this._phase === "reset_flash") {
            if (this._phaseClock >= this._resetFlashSec) {
                this._phase = "active";
                this._phaseClock = 0;
                this._teleportPlayerToSpawn();
                this._beginNewIteration();
            }
        } else if (this._phase === "win_flash") {
            if (this._phaseClock >= this._winFlashSec) {
                this._endMatch("complete");
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Match lifecycle
    // ═══════════════════════════════════════════════════════════════════

    _initMatch() {
        this._exitNumber = 0;
        this._iteration = 0;
        this._hasAnomaly = false;
        this._activeAnomalyKind = "";
        this._phase = "active";
        this._phaseClock = 0;
        this._decisionCooldown = 0;
        this._lastChoice = "";
        this._wipeAnomaly();

        this._teleportPlayerToSpawn();
        this._initialized = true;
        this._beginNewIteration();
        this._pushHud();
    }

    _endMatch(reason) {
        this._phase = "gameover";
        var mp = this.scene._mp;
        var payload = { winner: mp ? mp.localPeerId : "", reason: reason || "complete" };
        if (mp) mp.sendNetworkedEvent("match_ended", payload);
        this.scene.events.game.emit("match_ended", { winner: payload.winner, reason: payload.reason });
        this._pushGameOver(reason);
        if (mp && mp.isHost && mp.endMatch) mp.endMatch();
    }

    _pushGameOver(reason) {
        var stats = {};
        stats["Reached"] = "Exit " + this._exitNumber;
        stats["Iterations"] = String(this._iteration);
        if (reason === "complete") stats["Outcome"] = "Found Exit " + this._targetExitNumber + " — escaped";
        else if (reason === "abandoned") stats["Outcome"] = "Walked away";
        var title = reason === "complete" ? "EXIT FOUND" : "RUN ENDED";
        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: this._exitNumber, stats: stats },
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Iteration management
    // ═══════════════════════════════════════════════════════════════════

    _beginNewIteration() {
        this._iteration++;
        this._wipeAnomaly();
        this._hasAnomaly = Math.random() < this._anomalyChance;
        this._activeAnomalyKind = "";
        if (this._hasAnomaly) {
            var pickIdx = Math.floor(Math.random() * this._anomalyKinds.length);
            this._activeAnomalyKind = this._anomalyKinds[pickIdx];
            this._applyAnomaly(this._activeAnomalyKind);
            this.scene.events.game.emit("ll_anomaly_appeared", { kind: this._activeAnomalyKind });
        }
        this._refreshExitSign();
        this.scene.events.game.emit("ll_iteration_started", {
            iteration: this._iteration,
            anomalyKind: this._activeAnomalyKind,
            hasAnomaly: this._hasAnomaly,
        });
        this._decisionCooldown = this._decisionCooldownSec;
        this._lastChoice = "";
    }

    _commitChoice(choice) {
        if (this._phase !== "active") return;
        // continue = walked out far end, turn_back = walked out near end.
        // Correct iff matches hasAnomaly: anomaly→turn_back, none→continue.
        var correct = (choice === "turn_back") ? this._hasAnomaly : !this._hasAnomaly;
        this._lastChoice = choice;
        this.scene.events.game.emit("ll_choice_committed", { choice: choice, correct: correct });
        if (correct) {
            this._exitNumber++;
            this.scene.events.game.emit("ll_choice_correct", { newExitNumber: this._exitNumber });
            this.scene.events.game.emit("ll_progress_changed", { exitNumber: this._exitNumber, target: this._targetExitNumber });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_002.ogg", 0.4);
            if (this._exitNumber >= this._targetExitNumber) {
                this.scene.events.game.emit("ll_exit_reached", { exitNumber: this._exitNumber });
                this._phase = "win_flash";
                this._phaseClock = 0;
                return;
            }
            this._teleportPlayerToSpawn();
            this._beginNewIteration();
        } else {
            // Wrong — reset exit number to 0 and restart the loop.
            var reason = this._hasAnomaly
                ? "Should have turned back — anomaly was " + this._humanizeKind(this._activeAnomalyKind)
                : "Nothing was wrong — should have kept going";
            this._exitNumber = 0;
            this.scene.events.game.emit("ll_choice_wrong", { reason: reason });
            this.scene.events.game.emit("ll_progress_changed", { exitNumber: 0, target: this._targetExitNumber });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/error_006.ogg", 0.45);
            this._phase = "reset_flash";
            this._phaseClock = 0;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Anomaly application + revert
    // ═══════════════════════════════════════════════════════════════════

    _applyAnomaly(kind) {
        var scene = this.scene;
        if (!scene) return;
        if (kind === "figure_present") {
            // A motionless humanoid standing 7m down the corridor. Uses
            // the cube_world Character_Male_1 mesh — distinctive without
            // needing an extra animation rig.
            var id = scene.createEntity ? scene.createEntity("ll_figure") : null;
            if (id != null) {
                scene.setPosition(id, 4.5, 0, 0.6);
                scene.setScale && scene.setScale(id, 1.1, 1.1, 1.1);
                scene.addComponent(id, "MeshRendererComponent", {
                    meshType: "custom",
                    meshAsset: "/assets/quaternius/3d_models/cube_world/Character_Male_2.glb",
                    baseColor: [0.65, 0.65, 0.7, 1],
                });
                // REMOVED (registry handles facing now): scene.setRotationEuler && scene.setRotationEuler(id, 0, 180, 0);
                if (scene.addTag) scene.addTag(id, "ll_anomaly");
                this._anomalyEntityIds.push(id);
            }
        } else if (kind === "door_swing") {
            // Rotate the named "ll_side_door" 75° open. We do it via the
            // overrides table so revert can put it back exactly.
            var door = this._findByName("Ll Side Door");
            if (door) {
                this._captureRotation(door);
                door.transform.setRotationEuler && door.transform.setRotationEuler(0, 75, 0);
            }
        } else if (kind === "lights_red") {
            // Tint every "ll_ceiling_lamp" tagged entity red. Same revert
            // pathway — cache color, swap, restore.
            var lamps = scene.findEntitiesByTag ? scene.findEntitiesByTag("ll_ceiling_lamp") : [];
            for (var i = 0; i < lamps.length; i++) {
                this._captureColor(lamps[i], [0.9, 0.10, 0.12, 1]);
            }
        } else if (kind === "pillar_extra") {
            // Spawn an extra column blocking the right side ~halfway.
            var pid = scene.createEntity ? scene.createEntity("ll_extra_pillar") : null;
            if (pid != null) {
                scene.setPosition(pid, 2.5, 1.3, 1.2);
                scene.setScale && scene.setScale(pid, 0.4, 2.6, 0.4);
                scene.addComponent(pid, "MeshRendererComponent", {
                    meshType: "cube",
                    baseColor: [0.85, 0.85, 0.9, 1],
                });
                scene.addComponent(pid, "RigidbodyComponent", {
                    bodyType: "static", mass: 1, freezeRotation: true,
                });
                scene.addComponent(pid, "ColliderComponent", {
                    shapeType: "cuboid",
                    size: { x: 0.4, y: 2.6, z: 0.4 },
                });
                if (scene.addTag) scene.addTag(pid, "ll_anomaly");
                this._anomalyEntityIds.push(pid);
            }
        } else if (kind === "trashcan_tipped") {
            // Tip the named "ll_trashcan" onto its side and slide it
            // toward the center of the corridor.
            var can = this._findByName("Ll Trashcan");
            if (can) {
                this._captureRotation(can);
                this._capturePosition(can);
                can.transform.setRotationEuler && can.transform.setRotationEuler(0, 0, 90);
                this.scene.setPosition && this.scene.setPosition(can.id, can.transform.position.x, 0.25, can.transform.position.z - 0.6);
            }
        } else if (kind === "exit_wrong_number") {
            // Recolor the exit sign so the green "8" reads visibly off.
            // Simple visual cue without text rendering — we tint the
            // sign panel itself.
            var sign = this._findByName("Ll Exit Sign");
            if (sign) this._captureColor(sign, [0.92, 0.18, 0.10, 1]);
        } else if (kind === "ceiling_low") {
            // Drop the ceiling 0.6m to crowd the player. Caches transform
            // for revert.
            var ceil = this._findByName("Ll Ceiling");
            if (ceil) {
                this._capturePosition(ceil);
                this.scene.setPosition && this.scene.setPosition(ceil.id, ceil.transform.position.x, ceil.transform.position.y - 0.6, ceil.transform.position.z);
            }
        } else if (kind === "mirror_dim") {
            // Tint the mirror nearly-black — it's lost its reflection.
            var mir = this._findByName("Ll Mirror");
            if (mir) this._captureColor(mir, [0.04, 0.05, 0.07, 1]);
        }
    }

    _wipeAnomaly() {
        // Revert color/position/rotation overrides first.
        for (var i = 0; i < this._anomalyOverrides.length; i++) {
            var ov = this._anomalyOverrides[i];
            var ent = this.scene.getEntity ? this.scene.getEntity(ov.entityId) : null;
            if (!ent) continue;
            if (ov.kind === "color") {
                ent.setMaterialColor && ent.setMaterialColor(ov.old[0], ov.old[1], ov.old[2], ov.old[3]);
            } else if (ov.kind === "rotation") {
                ent.transform.setRotationEuler && ent.transform.setRotationEuler(ov.old.x, ov.old.y, ov.old.z);
            } else if (ov.kind === "position") {
                this.scene.setPosition && this.scene.setPosition(ent.id, ov.old.x, ov.old.y, ov.old.z);
            }
        }
        this._anomalyOverrides = [];
        // Destroy any spawned-by-anomaly entities.
        for (var j = 0; j < this._anomalyEntityIds.length; j++) {
            try { this.scene.destroyEntity && this.scene.destroyEntity(this._anomalyEntityIds[j]); } catch (e) {}
        }
        this._anomalyEntityIds = [];
    }

    _captureColor(entity, newColor) {
        var mr = entity.getComponent ? entity.getComponent("MeshRendererComponent") : null;
        if (!mr) return;
        var old = (mr.baseColor || [1, 1, 1, 1]).slice();
        this._anomalyOverrides.push({ entityId: entity.id, kind: "color", old: old });
        if (entity.setMaterialColor) {
            entity.setMaterialColor(newColor[0], newColor[1], newColor[2], newColor[3]);
        }
    }

    _captureRotation(entity) {
        var euler = entity.transform.getRotationEuler ? entity.transform.getRotationEuler() : { x: 0, y: 0, z: 0 };
        this._anomalyOverrides.push({
            entityId: entity.id, kind: "rotation",
            old: { x: euler.x || 0, y: euler.y || 0, z: euler.z || 0 },
        });
    }

    _capturePosition(entity) {
        var pos = entity.transform.position;
        this._anomalyOverrides.push({
            entityId: entity.id, kind: "position",
            old: { x: pos.x, y: pos.y, z: pos.z },
        });
    }

    _findByName(name) {
        if (this.scene.findEntityByName) return this.scene.findEntityByName(name);
        return null;
    }

    _humanizeKind(kind) {
        var map = {
            figure_present:    "a stranger in the hall",
            door_swing:        "the side door was open",
            lights_red:        "the lights were red",
            pillar_extra:      "an extra pillar",
            trashcan_tipped:   "the trashcan was knocked over",
            exit_wrong_number: "the exit sign was off",
            ceiling_low:       "the ceiling sagged",
            mirror_dim:        "the mirror was dead",
        };
        return map[kind] || kind || "something";
    }

    _refreshExitSign() {
        // Revert color happens via _wipeAnomaly → captured overrides.
        // No additional work here; placeholder hook for future variants
        // (e.g. swap in a different sign mesh per iteration).
    }

    // ═══════════════════════════════════════════════════════════════════
    // Player position / spawn
    // ═══════════════════════════════════════════════════════════════════

    _readPlayerPos() {
        var p = this._findLocalPlayerEntity();
        if (!p) return null;
        return p.transform.position;
    }

    _findLocalPlayerEntity() {
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < all.length; i++) {
            var p = all[i];
            var ni = p.getComponent("NetworkIdentityComponent");
            if (ni && ni.isLocalPlayer) return p;
            if (!ni) return p;
        }
        return all[0] || null;
    }

    _teleportPlayerToSpawn() {
        var p = this._findLocalPlayerEntity();
        if (!p) return;
        // Place at center of corridor, facing the far end.
        this.scene.setPosition(p.id, this._spawnX, this._spawnY, this._spawnZ);
        this.scene.setVelocity && this.scene.setVelocity(p.id, { x: 0, y: 0, z: 0 });
        // Reset the FPS yaw so the camera faces +X (toward the far end).
        // FPS camera writes to scene._fpsYaw — overwriting it here gives
        // the player a clean orientation each iteration.
        this.scene._fpsYaw = 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    // HUD payload
    // ═══════════════════════════════════════════════════════════════════

    _pushHud() {
        var atTip;
        if (this._phase === "active") {
            var p = this._readPlayerPos();
            if (p) {
                if (p.x > this._farEndX - 3) atTip = "Almost at the FAR end (continuing).";
                else if (p.x < this._nearEndX + 3) atTip = "Almost back at the NEAR end (turning back).";
                else atTip = this._hint;
            } else {
                atTip = this._hint;
            }
        } else if (this._phase === "reset_flash") {
            atTip = "Reset to Exit 0";
        } else if (this._phase === "win_flash") {
            atTip = "You found Exit " + this._targetExitNumber;
        } else {
            atTip = "";
        }

        this.scene.events.ui.emit("hud_update", {
            liminalLoop: {
                exitNumber: this._exitNumber,
                target: this._targetExitNumber,
                iteration: this._iteration,
                hint: atTip,
                phase: this._phase,
                lastChoice: this._lastChoice,
                resetFlash: this._phase === "reset_flash",
                winFlash: this._phase === "win_flash",
            },
        });
    }
}
