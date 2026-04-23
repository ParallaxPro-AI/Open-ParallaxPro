// also: food prep, recipe progression, time management, cooking mechanics, stage transitions
// Kitchen Master engine — single-player cooking-mini-game state machine.
//
// Owns:
//   - The four-stage recipe state machine (chop → mix → fry → plate),
//     including per-stage countdown timers, target counters, and the
//     short transition pause between stages where the next instruction
//     panel slides in.
//   - Mouse-driven mini-game logic. All four stages share the same
//     screen→ground projection (scene.screenPointToGround) so a single
//     input pipeline handles cutting board clicks, bowl rotations,
//     pan flips, and plate placements.
//   - Tool animations (knife slam, spoon spin, spatula flip) and
//     ingredient lifecycle (carrot chunks splitting on chop, batter
//     forming on mix, patty browning on fry, garnish landing on
//     plate). Every visual is created via scene.createEntity at
//     runtime — the world placements are just the static workstation.
//   - Scoring: each stage banks its own sub-score (target hit + time
//     bonus + perfect bonus), and the run total reveals 1-3 stars on
//     the game-over screen.
//
// State machine: scene._kitchen.stage holds the current stage so the
// HUD knows which instruction panel + visualisation to show.
class KitchenMasterEngineSystem extends GameScript {
    _groundY = 0.05;
    _stages = ["chop", "mix", "fry", "plate"];
    _chopTarget = 8;
    _chopDurationSec = 14;
    _chopBoardCenterX = -5;
    _chopBoardCenterZ = -1;
    _chopBoardHalfWidth = 1.6;
    _chopBoardHalfDepth = 1.2;
    _mixTarget = 6;
    _mixDurationSec = 16;
    _mixBowlCenterX = 0;
    _mixBowlCenterZ = -1;
    _mixBowlRadius = 1.2;
    _fryTarget = 3;
    _fryDurationSec = 18;
    _fryCookSpeed = 0.42;
    _fryPerfectMin = 0.7;
    _fryPerfectMax = 0.93;
    _fryBurnAt = 1.05;
    _fryEarlyMin = 0.3;
    _frySpatulaCenterX = 5;
    _frySpatulaCenterZ = -1;
    _frySpatulaHalfRadius = 1.6;
    _plateTarget = 4;
    _plateDurationSec = 12;
    _plateCenterX = 0;
    _plateCenterZ = 2.6;
    _plateRadius = 1.6;
    _stageTransitionSec = 1.2;
    _starThresholds = [350, 700, 1050];
    _perfectBonus = 200;
    _chopSound = "";
    _mixSound = "";
    _frySuccessSound = "";
    _fryFailSound = "";
    _fryBurnSound = "";
    _platePlaceSound = "";
    _stageStartSound = "";
    _stageCompleteSound = "";
    _winSound = "";
    _loseSound = "";

    // Per-run state
    _stageIdx = -1;
    _stage = "";
    _stageTimer = 0;
    _stageElapsed = 0;
    _stageTargetMet = false;
    _stageScore = 0;
    _totalScore = 0;
    _perfectFlags = [];
    _ended = false;
    _won = false;
    _initialized = false;
    _transitionTimer = 0;

    // Stage-specific state
    _chopCount = 0;
    _chopChunkIds = [];
    _knifeAnimT = 0;

    _mixRotations = 0;
    _mixLastAngle = 0;
    _mixAccumAngle = 0;
    _mixHeadId = -1;
    _mixContentIds = [];

    _fryCookness = 0;
    _fryFlipsDone = 0;
    _fryBurned = false;
    _fryPattyId = -1;
    _fryFlipFx = 0;

    _plateCount = 0;
    _platePlacedIds = [];

    // Virtual cursor tracking — the gameplay state enables the ui_bridge
    // virtual cursor, which means input.getMousePosition() returns the
    // real mouse (possibly pointer-locked) not where the player "sees"
    // their cursor. Mirror the ui_bridge's canvas-relative cursor here
    // and treat cursor_click events as the authoritative click signal.
    _cursorScreenX = 0;
    _cursorScreenY = 0;
    _cursorHasPos = false;
    _justClicked = false;

    onStart() {
        var self = this;
        this._fullReset();
        this._initialized = true;

        this.scene.events.game.on("game_ready", function() { self._fullReset(); });
        this.scene.events.game.on("restart_game", function() { self._fullReset(); });

        this.scene.events.ui.on("cursor_move", function(d) {
            self._cursorScreenX = d.x;
            self._cursorScreenY = d.y;
            self._cursorHasPos = true;
        });
        this.scene.events.ui.on("cursor_click", function(d) {
            self._cursorScreenX = d.x;
            self._cursorScreenY = d.y;
            self._cursorHasPos = true;
            self._justClicked = true;
        });
    }

    onUpdate(dt) {
        if (!this._initialized || this._ended) {
            this._justClicked = false;
            return;
        }

        // Tools — knife / spoon / spatula visuals always animate so
        // their idle positions remain coherent with the active stage.
        this._tickToolAnimations(dt);

        // Stage transition pause.
        if (this._transitionTimer > 0) {
            this._transitionTimer -= dt;
            if (this._transitionTimer <= 0) this._beginNextStage();
            this._publishHud();
            this._justClicked = false;
            return;
        }

        if (!this._stage) {
            this._justClicked = false;
            return;
        }

        this._stageElapsed += dt;
        var remaining = this._stageTimer - this._stageElapsed;

        if (this._stage === "chop")  this._tickChop(dt, remaining);
        if (this._stage === "mix")   this._tickMix(dt, remaining);
        if (this._stage === "fry")   this._tickFry(dt, remaining);
        if (this._stage === "plate") this._tickPlate(dt, remaining);

        if (remaining <= 0 && !this._stageTargetMet) {
            this._endStage(/*targetMet=*/false);
        }

        this._publishHud();
        // One cursor_click event fires one in-game click. Clear so the next
        // frame's tick doesn't re-consume the same click.
        this._justClicked = false;
    }

    // ── Reset / state ──────────────────────────────────────────────────

    _fullReset() {
        // Clear any leftover ingredients / FX from the previous run.
        this._destroyAll(this._chopChunkIds);
        this._destroyAll(this._mixContentIds);
        this._destroyAll(this._platePlacedIds);
        this._destroyEntity(this._fryPattyId);
        this._destroyEntity(this._mixHeadId);
        this._chopChunkIds = [];
        this._mixContentIds = [];
        this._platePlacedIds = [];
        this._fryPattyId = -1;
        this._mixHeadId = -1;

        this._stageIdx = -1;
        this._stage = "";
        this._stageTimer = 0;
        this._stageElapsed = 0;
        this._stageTargetMet = false;
        this._stageScore = 0;
        this._totalScore = 0;
        this._perfectFlags = [];
        this._ended = false;
        this._won = false;
        this._transitionTimer = 0;

        this._chopCount = 0;
        this._knifeAnimT = 0;
        this._mixRotations = 0;
        this._mixAccumAngle = 0;
        this._mixLastAngle = 0;
        this._fryCookness = 0;
        this._fryFlipsDone = 0;
        this._fryBurned = false;
        this._fryFlipFx = 0;
        this._plateCount = 0;

        if (!this.scene._kitchen) this.scene._kitchen = {};
        this.scene._kitchen.stage = "";
        this.scene._kitchen.totalScore = 0;

        // Begin the first stage on a short delay so the game-ready
        // splash isn't blown past instantly.
        this._transitionTimer = 0.6;
    }

    _beginNextStage() {
        this._stageIdx++;
        if (this._stageIdx >= this._stages.length) {
            this._winRun();
            return;
        }
        var stage = this._stages[this._stageIdx];
        this._stage = stage;
        this._stageElapsed = 0;
        this._stageTargetMet = false;
        this._stageScore = 0;

        var target = 0;
        var dur = 0;
        if (stage === "chop")  { this._beginChop();  target = this._chopTarget;  dur = this._chopDurationSec; }
        if (stage === "mix")   { this._beginMix();   target = this._mixTarget;   dur = this._mixDurationSec; }
        if (stage === "fry")   { this._beginFry();   target = this._fryTarget;   dur = this._fryDurationSec; }
        if (stage === "plate") { this._beginPlate(); target = this._plateTarget; dur = this._plateDurationSec; }
        this._stageTimer = dur;

        if (this.audio && this._stageStartSound) this.audio.playSound(this._stageStartSound, 0.5);
        this.scene.events.game.emit("recipe_stage_started", { stage: stage, target: target, durationSec: dur });

        if (!this.scene._kitchen) this.scene._kitchen = {};
        this.scene._kitchen.stage = stage;
    }

    _endStage(targetMet) {
        if (this._stageTargetMet) return;
        this._stageTargetMet = true;
        var stage = this._stage;
        var perfect = !!targetMet;
        // Time bonus: scale 0..1 based on how much time is left at the
        // moment the target is met (or zero if we ran out the clock).
        var timeLeft = Math.max(0, this._stageTimer - this._stageElapsed);
        var timeBonus = Math.round(150 * (timeLeft / this._stageTimer));
        var base = targetMet ? 200 : 0;
        var perfectBonus = perfect ? this._perfectBonus : 0;
        var stageScore = base + timeBonus + perfectBonus + (this._stageScore || 0);
        this._totalScore += stageScore;
        this._perfectFlags.push(perfect);

        if (this.audio && this._stageCompleteSound && targetMet) this.audio.playSound(this._stageCompleteSound, 0.45);
        this.scene.events.game.emit("recipe_stage_completed", { stage: stage, score: stageScore, perfect: perfect });
        if (!this.scene._kitchen) this.scene._kitchen = {};
        this.scene._kitchen.totalScore = this._totalScore;

        // Brief pause then advance.
        this._transitionTimer = this._stageTransitionSec;
    }

    _winRun() {
        this._ended = true;
        this._won = true;
        var stars = 0;
        for (var i = 0; i < this._starThresholds.length; i++) {
            if (this._totalScore >= this._starThresholds[i]) stars = i + 1;
        }
        this.scene.events.game.emit("recipe_completed", { totalScore: this._totalScore, stars: stars });
        this.scene.events.game.emit("game_won", { score: this._totalScore });
        if (this.audio && this._winSound) this.audio.playSound(this._winSound, 0.7);
        var stats = {
            "Score": String(this._totalScore),
            "Rating": (stars > 0 ? this._starString(stars) : "Try Again"),
            "Stages Cleared": this._perfectFlags.length + " / " + this._stages.length,
        };
        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: "DISH SERVED", score: this._totalScore, stats: stats },
        });
    }

    _starString(n) {
        return "★".repeat(n) + "☆".repeat(Math.max(0, 3 - n));
    }

    // ── Tool animations ────────────────────────────────────────────────

    _tickToolAnimations(dt) {
        // Knife: idle hovers above the cutting board, dips slightly on
        // each chop. The animation timer ramps to 1 immediately on chop
        // and decays back to 0.
        var knifeBlade = this.scene.findEntityByName ? this.scene.findEntityByName("Knife Blade") : null;
        var knifeHandle = this.scene.findEntityByName ? this.scene.findEntityByName("Knife Handle") : null;
        if (this._knifeAnimT > 0) this._knifeAnimT -= dt * 6;
        if (this._knifeAnimT < 0) this._knifeAnimT = 0;
        var knifeY = 1.6 - 1.0 * Math.max(0, Math.sin(this._knifeAnimT * Math.PI));
        if (knifeBlade) this.scene.setPosition(knifeBlade.id, this._chopBoardCenterX, knifeY, this._chopBoardCenterZ + 0.4);
        if (knifeHandle) this.scene.setPosition(knifeHandle.id, this._chopBoardCenterX, knifeY, this._chopBoardCenterZ - 1.2);

        // Spoon: gentle spin while mixing.
        var spoonHead = this.scene.findEntityByName ? this.scene.findEntityByName("Spoon Head") : null;
        var spoonHandle = this.scene.findEntityByName ? this.scene.findEntityByName("Spoon Handle") : null;
        if (this._stage === "mix" && spoonHead && spoonHandle) {
            var t = (Date.now() / 220) + this._mixAccumAngle * 0.3;
            var sx = this._mixBowlCenterX + Math.cos(t) * 0.6;
            var sz = this._mixBowlCenterZ + Math.sin(t) * 0.6;
            this.scene.setPosition(spoonHead.id, sx, 0.95, sz);
            this.scene.setPosition(spoonHandle.id, this._mixBowlCenterX + Math.cos(t) * 1.6, 0.95, this._mixBowlCenterZ + Math.sin(t) * 1.6);
        }

        // Frying flip FX: brief spark sphere when the player pulls off a
        // perfect flip.
        if (this._fryFlipFx > 0) this._fryFlipFx -= dt;
    }

    // ── Stage 1: Chop ──────────────────────────────────────────────────

    _beginChop() {
        // Spawn `chopTarget` carrot chunks across the cutting board in a
        // staggered grid so each chop has a clear visual target.
        this._destroyAll(this._chopChunkIds);
        this._chopChunkIds = [];
        this._chopCount = 0;
        for (var i = 0; i < this._chopTarget; i++) {
            var fx = (i / Math.max(1, this._chopTarget - 1)) - 0.5;
            var x = this._chopBoardCenterX + fx * (this._chopBoardHalfWidth * 1.6);
            var z = this._chopBoardCenterZ + ((i % 2 === 0) ? -0.3 : 0.3);
            var name = "Chunk_" + i;
            var id = this.scene.createEntity ? this.scene.createEntity(name) : null;
            if (id == null) continue;
            this.scene.setPosition(id, x, 0.45, z);
            this.scene.setScale && this.scene.setScale(id, 0.55, 0.55, 0.55);
            this.scene.addComponent(id, "MeshRendererComponent", {
                meshType: "cube",
                baseColor: [1.0, 0.55, 0.20, 1],
            });
            if (this.scene.addTag) this.scene.addTag(id, "carrot_chunk");
            this._chopChunkIds.push(id);
        }
    }

    _tickChop(dt, remaining) {
        var ground = this._mouseGround();
        if (!ground) return;
        if (!this._justClicked) return;
        // Check the click landed inside the cutting board's footprint.
        if (Math.abs(ground.x - this._chopBoardCenterX) > this._chopBoardHalfWidth) return;
        if (Math.abs(ground.z - this._chopBoardCenterZ) > this._chopBoardHalfDepth) return;
        this._chopCount++;
        this._knifeAnimT = 1.0;
        if (this.audio && this._chopSound) this.audio.playSound(this._chopSound, 0.42);
        // Visually shrink the most-rightmost remaining chunk so each
        // click reads as "that piece is now sliced".
        if (this._chopChunkIds.length >= this._chopCount) {
            var idx = this._chopChunkIds.length - this._chopCount;
            if (idx >= 0 && this._chopChunkIds[idx] != null) {
                this.scene.setScale && this.scene.setScale(this._chopChunkIds[idx], 0.32, 0.32, 0.32);
            }
        }
        this.scene.events.game.emit("chop_made", { count: this._chopCount, target: this._chopTarget });
        if (this._chopCount >= this._chopTarget) this._endStage(true);
    }

    // ── Stage 2: Mix ───────────────────────────────────────────────────

    _beginMix() {
        // A simple cylinder of "batter" appears in the bowl as a visual
        // anchor for the mixing stage.
        this._mixRotations = 0;
        this._mixAccumAngle = 0;
        this._mixLastAngle = 0;
        this._destroyEntity(this._mixHeadId);
        var name = "BatterDisc";
        var id = this.scene.createEntity ? this.scene.createEntity(name) : null;
        if (id != null) {
            this.scene.setPosition(id, this._mixBowlCenterX, 0.55, this._mixBowlCenterZ);
            this.scene.setScale && this.scene.setScale(id, 1.6, 0.18, 1.6);
            this.scene.addComponent(id, "MeshRendererComponent", {
                meshType: "cylinder",
                baseColor: [0.96, 0.92, 0.74, 1],
            });
            if (this.scene.addTag) this.scene.addTag(id, "ingredient");
            this._mixHeadId = id;
        }
    }

    _tickMix(dt, remaining) {
        var ground = this._mouseGround();
        if (!ground) return;
        // Track angle from the bowl centre to the cursor; accumulate
        // signed delta. Whenever we've swept ≥2π in the same direction
        // (positive = clockwise from above), count it as a mix.
        var dx = ground.x - this._mixBowlCenterX;
        var dz = ground.z - this._mixBowlCenterZ;
        var dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < 0.2) return;  // ignore jitter near centre
        if (dist > this._mixBowlRadius * 2.5) return; // too far from bowl
        var angle = Math.atan2(dz, dx);
        if (this._mixLastAngle === 0 && this._mixAccumAngle === 0) {
            this._mixLastAngle = angle;
            return;
        }
        var d = angle - this._mixLastAngle;
        // Wrap the delta into (-π, π] so a sweep across the discontinuity
        // doesn't register as a near-2π jump.
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        // Throw out implausibly large deltas (mouse teleport) so a single
        // frame can't credit a full rotation.
        if (Math.abs(d) > 0.9) {
            this._mixLastAngle = angle;
            return;
        }
        this._mixAccumAngle += d;
        this._mixLastAngle = angle;
        var rotations = Math.abs(this._mixAccumAngle) / (2 * Math.PI);
        if (rotations > this._mixRotations + 1) {
            this._mixRotations = Math.floor(rotations);
            if (this.audio && this._mixSound) this.audio.playSound(this._mixSound, 0.20);
            this.scene.events.game.emit("mix_progress", { rotations: this._mixRotations, target: this._mixTarget });
            // Each completed rotation visually settles the batter — the
            // disc gets a hair brighter as it incorporates.
            var t = Math.min(1, this._mixRotations / this._mixTarget);
            if (this._mixHeadId != null && this.scene.addComponent) {
                var color = [
                    0.96 + 0 * t,
                    0.92 - 0.18 * t,
                    0.74 - 0.32 * t,
                    1,
                ];
                this.scene.addComponent(this._mixHeadId, "MeshRendererComponent", {
                    meshType: "cylinder",
                    baseColor: color,
                });
            }
            if (this._mixRotations >= this._mixTarget) this._endStage(true);
        }
    }

    // ── Stage 3: Fry ───────────────────────────────────────────────────

    _beginFry() {
        this._fryCookness = 0;
        this._fryFlipsDone = 0;
        this._fryBurned = false;
        this._destroyEntity(this._fryPattyId);
        var id = this.scene.createEntity ? this.scene.createEntity("Patty") : null;
        if (id != null) {
            this.scene.setPosition(id, this._frySpatulaCenterX, 0.85, this._frySpatulaCenterZ);
            this.scene.setScale && this.scene.setScale(id, 1.4, 0.30, 1.4);
            this.scene.addComponent(id, "MeshRendererComponent", {
                meshType: "cylinder",
                baseColor: [0.96, 0.85, 0.55, 1],
            });
            if (this.scene.addTag) this.scene.addTag(id, "patty");
            this._fryPattyId = id;
        }
    }

    _tickFry(dt, remaining) {
        if (this._fryBurned) return;
        // Cookness rises until the player flips. Past burnAt the dish
        // burns (fail the stage early).
        this._fryCookness += this._fryCookSpeed * dt;
        // Update patty colour as it browns.
        var c = Math.min(1, this._fryCookness);
        var color = [
            0.96 - 0.55 * c,
            0.85 - 0.55 * c,
            0.55 - 0.45 * c,
            1,
        ];
        if (this._fryPattyId != null && this.scene.addComponent) {
            this.scene.addComponent(this._fryPattyId, "MeshRendererComponent", {
                meshType: "cylinder",
                baseColor: color,
            });
        }
        if (this._fryCookness >= this._fryBurnAt) {
            this._fryBurned = true;
            this.scene.events.game.emit("fry_burnt", {});
            if (this.audio && this._fryBurnSound) this.audio.playSound(this._fryBurnSound, 0.5);
            this._endStage(false);
            return;
        }

        // Click to flip — only count when over the spatula zone.
        if (!this._justClicked) return;
        var ground = this._mouseGround();
        if (!ground) return;
        var dx = ground.x - this._frySpatulaCenterX;
        var dz = ground.z - this._frySpatulaCenterZ;
        if (Math.sqrt(dx * dx + dz * dz) > this._frySpatulaHalfRadius) return;

        var inSweet = this._fryCookness >= this._fryPerfectMin && this._fryCookness <= this._fryPerfectMax;
        if (inSweet) {
            this._fryFlipsDone++;
            this._stageScore += 80;
            if (this.audio && this._frySuccessSound) this.audio.playSound(this._frySuccessSound, 0.4);
            this.scene.events.game.emit("fry_flipped", { successful: true, count: this._fryFlipsDone, target: this._fryTarget });
            // Reset cookness for next flip — final flip just locks the
            // perfect colour at burnAt - 0.1 so it looks done.
            this._fryCookness = this._fryFlipsDone >= this._fryTarget ? (this._fryBurnAt - 0.15) : 0;
            this._fryFlipFx = 0.4;
            if (this._fryFlipsDone >= this._fryTarget) this._endStage(true);
        } else if (this._fryCookness >= this._fryEarlyMin) {
            // A merely-OK flip gets a small reset and partial score.
            this._stageScore += 20;
            if (this.audio && this._fryFailSound) this.audio.playSound(this._fryFailSound, 0.32);
            this.scene.events.game.emit("fry_flipped", { successful: false, count: this._fryFlipsDone, target: this._fryTarget });
            this._fryCookness *= 0.4;
        } else {
            // Too early — light penalty. The cookness barely moves so
            // the player doesn't get punished for one mis-time.
            if (this.audio && this._fryFailSound) this.audio.playSound(this._fryFailSound, 0.25);
        }
    }

    // ── Stage 4: Plate ─────────────────────────────────────────────────

    _beginPlate() {
        this._plateCount = 0;
        this._destroyAll(this._platePlacedIds);
        this._platePlacedIds = [];
    }

    _tickPlate(dt, remaining) {
        if (!this._justClicked) return;
        var ground = this._mouseGround();
        if (!ground) return;
        var dx = ground.x - this._plateCenterX;
        var dz = ground.z - this._plateCenterZ;
        if (Math.sqrt(dx * dx + dz * dz) > this._plateRadius) return;
        // Each click drops the next ingredient in a circular pattern on
        // the plate. The order rotates through carrot → garnish → patty
        // → sauce so the final plating reads as a composed dish.
        var idx = this._plateCount;
        if (idx >= this._plateTarget) return;
        var angle = (idx / this._plateTarget) * Math.PI * 2;
        var r = 0.7;
        var px = this._plateCenterX + Math.cos(angle) * r;
        var pz = this._plateCenterZ + Math.sin(angle) * r;
        var meshType = "cube";
        var color = [1.0, 0.55, 0.20, 1];
        var scale = [0.5, 0.4, 0.5];
        if (idx === 0)      { meshType = "cube";     color = [1.0, 0.55, 0.20, 1]; scale = [0.5, 0.4, 0.5]; }
        else if (idx === 1) { meshType = "cube";     color = [0.30, 0.75, 0.30, 1]; scale = [0.5, 0.10, 0.5]; }
        else if (idx === 2) { meshType = "cylinder"; color = [0.55, 0.30, 0.16, 1]; scale = [0.9, 0.20, 0.9]; }
        else                { meshType = "sphere";   color = [0.85, 0.18, 0.16, 1]; scale = [0.4, 0.25, 0.4]; }
        var name = "Plated_" + idx;
        var id = this.scene.createEntity ? this.scene.createEntity(name) : null;
        if (id != null) {
            this.scene.setPosition(id, px, 0.34, pz);
            this.scene.setScale && this.scene.setScale(id, scale[0], scale[1], scale[2]);
            this.scene.addComponent(id, "MeshRendererComponent", {
                meshType: meshType,
                baseColor: color,
            });
            if (this.scene.addTag) this.scene.addTag(id, "ingredient");
            this._platePlacedIds.push(id);
        }
        this._plateCount++;
        if (this.audio && this._platePlaceSound) this.audio.playSound(this._platePlaceSound, 0.35);
        this.scene.events.game.emit("plate_added", { count: this._plateCount, target: this._plateTarget });
        if (this._plateCount >= this._plateTarget) this._endStage(true);
    }

    // ── Mouse → ground projection ──────────────────────────────────────

    _mouseGround() {
        if (!this.scene.screenPointToGround) return null;
        if (!this._cursorHasPos) return null;
        return this.scene.screenPointToGround(this._cursorScreenX, this._cursorScreenY, this._groundY);
    }

    // ── HUD ────────────────────────────────────────────────────────────

    _publishHud() {
        var stage = this._stage;
        var progress = 0;
        var target = 0;
        var current = 0;
        var inSweetZone = false;
        var fryCook = 0;
        if (stage === "chop")  { current = this._chopCount; target = this._chopTarget; progress = current / Math.max(1, target); }
        if (stage === "mix")   { current = this._mixRotations; target = this._mixTarget; progress = current / Math.max(1, target); }
        if (stage === "fry")   {
            current = this._fryFlipsDone; target = this._fryTarget; progress = current / Math.max(1, target);
            fryCook = this._fryCookness;
            inSweetZone = (this._fryCookness >= this._fryPerfectMin && this._fryCookness <= this._fryPerfectMax);
        }
        if (stage === "plate") { current = this._plateCount; target = this._plateTarget; progress = current / Math.max(1, target); }

        var remaining = Math.max(0, this._stageTimer - this._stageElapsed);
        this.scene.events.ui.emit("hud_update", {
            kitchenHud: {
                stage: stage,
                stageIdx: this._stageIdx,
                totalStages: this._stages.length,
                current: current,
                target: target,
                progress: progress,
                remaining: Math.ceil(remaining * 10) / 10,
                totalScore: this._totalScore,
                fryCook: fryCook,
                fryBurnAt: this._fryBurnAt,
                fryPerfectMin: this._fryPerfectMin,
                fryPerfectMax: this._fryPerfectMax,
                inSweetZone: inSweetZone,
                transitionPause: this._transitionTimer > 0,
            },
        });
    }

    // ── Helpers ────────────────────────────────────────────────────────

    _destroyAll(ids) {
        if (!ids) return;
        for (var i = 0; i < ids.length; i++) this._destroyEntity(ids[i]);
    }

    _destroyEntity(id) {
        if (id == null || id === -1) return;
        var s = this.scene;
        try {
            if (s.deleteEntity) s.deleteEntity(id);
            else if (s.removeEntity) s.removeEntity(id);
            else if (s.destroyEntity) s.destroyEntity(id);
            else if (s.setScale) s.setScale(id, 0, 0, 0);
        } catch (e) { /* may already be gone */ }
    }
}
