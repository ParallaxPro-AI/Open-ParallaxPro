// also: side-scroller mechanics, item collection, life system, classic arcade, respawn logic
// Pipe Runner engine — single-player 2.5D arcade-platformer game state.
//
// Owns:
//   - Lives, coins, time-remaining, score, power-up state. The HUD
//     reads these straight off scene state via the per-event pulses
//     (runner_coin_grabbed, runner_life_lost, etc.).
//   - Per-tick scans: coin proximity (despawn + score), mushroom
//     proximity (apply power-up), enemy overlap (stomp if player is
//     above + falling, otherwise damage), question-block bump (player
//     head collides with a question_block from below → spawn coin or
//     mushroom on top, mark block spent), flagpole reach (player x >=
//     flagReachX → bank time/score → game_won).
//   - Mushroom item physics: spawned items walk right slowly, fall
//     under gravity, despawn off the kill plane, picked up on player
//     overlap.
//   - Lives + respawn flow: on hit-while-not-powered or fall-kill,
//     decrement lives, reset every coin/enemy back to its placement,
//     teleport player to spawn. Lives reaching zero → game_over.
//
// Reusable: any 2.5D arcade-platformer template can swap in this
// engine by tagging entities `coin` / `powerup` / `question_block`
// / `pipe` / `flag` and providing a player with the sidescroll_runner
// behavior. All numeric tunables (lives, time, kill plane, scoring)
// live in 04_systems.json params.
class PipeRunnerEngineSystem extends GameScript {
    _startingLives = 3;
    _matchTimeoutSec = 300;
    _killPlaneY = -16;
    _coinPickupRadius = 1.0;
    _mushroomPickupRadius = 1.2;
    _questionBlockHitMargin = 0.65;
    _questionBlockSpentColor = [0.45, 0.32, 0.18, 1];
    _questionBlockItemSequence = ["coin", "mushroom", "coin", "coin", "mushroom"];
    _flagReachX = 113.5;
    _spawnX = 2;
    _spawnY = 2.5;
    _scorePerCoin = 200;
    _scorePerStomp = 100;
    _scorePerSecondLeft = 50;
    _extraLifeAtCoins = 50;
    _timeWarningAt = 60;
    _fastTimeBelow = 60;
    _coinSound = "";
    _blockHitSound = "";
    _blockBumpSound = "";
    _extraLifeSound = "";
    _flagSound = "";
    _winSound = "";
    _loseSound = "";
    _timeWarningSound = "";

    // Per-run state
    _lives = 3;
    _coins = 0;
    _coinsForExtraLife = 0;
    _score = 0;
    _timeRemaining = 300;
    _timeWarningFired = false;
    _ended = false;
    _won = false;
    _initialized = false;
    _poweredUp = false;
    _hitCooldown = 0;
    _stompCombo = 0;
    _stompComboTimer = 0;
    _spawnedItems = []; // [{id, kind, vx, vy}]
    _questionBlocksSpent = {};
    _questionBlockItemIdx = 0;

    onStart() {
        var self = this;
        this._fullReset();
        this._initialized = true;

        this.scene.events.game.on("game_ready", function() { self._fullReset(); });
        this.scene.events.game.on("restart_game", function() { self._fullReset(); });
        this.scene.events.game.on("player_died", function() { self._loseLife("fall"); });
    }

    onUpdate(dt) {
        if (!this._initialized || this._ended) return;
        if (this._hitCooldown > 0) this._hitCooldown -= dt;
        if (this._stompComboTimer > 0) {
            this._stompComboTimer -= dt;
            if (this._stompComboTimer <= 0) this._stompCombo = 0;
        }

        // Time tick.
        this._timeRemaining -= dt;
        if (!this._timeWarningFired && this._timeRemaining <= this._timeWarningAt) {
            this._timeWarningFired = true;
            this.scene.events.game.emit("runner_time_warning", { time: Math.ceil(this._timeRemaining) });
            if (this.audio && this._timeWarningSound) this.audio.playSound(this._timeWarningSound, 0.55);
        }
        if (this._timeRemaining <= 0) {
            this._endGame(false, "time");
            return;
        }

        // Pull player state from the runner behavior.
        var pp = this.scene._runnerPlayer;
        if (!pp || !pp.alive) {
            this._tickItems(dt); // items keep falling even during death frame
            this._publishHud();
            return;
        }

        // Fall kill (defensive — runner behavior also raises this).
        if (typeof pp.y === "number" && pp.y < this._killPlaneY && this._hitCooldown <= 0) {
            this._loseLife("fall");
            return;
        }

        // Per-tick world scans.
        this._scanCoinPickups(pp.x, pp.y);
        this._scanMushroomPickups(pp.x, pp.y);
        this._scanEnemyOverlaps(pp);
        this._scanQuestionBlocks(pp);
        this._scanFlagReach(pp.x);
        this._tickItems(dt);

        this._publishHud();
    }

    // ── Reset / state ──────────────────────────────────────────────────

    _fullReset() {
        this._lives = this._startingLives;
        this._coins = 0;
        this._coinsForExtraLife = 0;
        this._score = 0;
        this._timeRemaining = this._matchTimeoutSec;
        this._timeWarningFired = false;
        this._ended = false;
        this._won = false;
        this._poweredUp = false;
        this._hitCooldown = 0;
        this._stompCombo = 0;
        this._stompComboTimer = 0;
        this._questionBlocksSpent = {};
        this._questionBlockItemIdx = 0;

        // Despawn any leftover spawned mushrooms / spawned items from
        // the prior run so they don't haunt the new course.
        for (var i = 0; i < this._spawnedItems.length; i++) this._destroyEntity(this._spawnedItems[i].id);
        this._spawnedItems = [];

        // Reactivate every collectible / enemy / question block so a
        // post-game-over restart plays from a clean slate.
        this._reactivateTagged("coin");
        this._reactivateTagged("powerup");
        this._reactivateTagged("enemy");
        this._reactivateTagged("question_block");

        // Snap the player to the spawn point.
        this._respawnPlayer();
    }

    _respawnPlayer() {
        var p = this.scene.findEntityByName ? this.scene.findEntityByName("Runner Player") : null;
        if (!p) {
            // Try by tag if name lookup miss (the assembler picks names
            // from the placement's ref; the default for "runner_player"
            // is "Runner Player" with a single placement).
            var list = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
            p = list[0] || null;
        }
        if (!p) return;
        this.scene.setPosition(p.id, this._spawnX, this._spawnY, 0);
        if (this.scene.setVelocity) this.scene.setVelocity(p.id, { x: 0, y: 0, z: 0 });
        this.scene.events.game.emit("player_respawned", {});
    }

    _reactivateTagged(tag) {
        var list = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag(tag) : [];
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            if (!e) continue;
            e.active = true;
            // Reset visual scale + colour. Question blocks get re-tinted
            // gold; coins / powerups / enemies use their default scale.
            if (tag === "question_block") {
                this.scene.setScale && this.scene.setScale(e.id, 1.2, 1.2, 1.2);
                this.scene.addComponent(e.id, "MeshRendererComponent", {
                    meshType: "cube",
                    baseColor: [1.0, 0.78, 0.20, 1],
                });
            } else {
                // Generic restore. Coins were 0.6 cylinders; if we got
                // here from a previous shrink-to-zero, reset to that.
                var defaultScale = (tag === "coin") ? [0.6, 0.20, 0.6] : (tag === "powerup" ? [0.7, 0.7, 0.7] : [1.6, 1.6, 1.6]);
                this.scene.setScale && this.scene.setScale(e.id, defaultScale[0], defaultScale[1], defaultScale[2]);
            }
        }
    }

    // ── Pickup scans ───────────────────────────────────────────────────

    _scanCoinPickups(px, py) {
        var list = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("coin") : [];
        var r2 = this._coinPickupRadius * this._coinPickupRadius;
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            if (!e || !e.transform) continue;
            if (e.active === false) continue;
            var ep = e.transform.position;
            var dx = ep.x - px, dy = ep.y - py;
            if (dx * dx + dy * dy < r2) {
                e.active = false;
                this.scene.setScale && this.scene.setScale(e.id, 0, 0, 0);
                this._addCoin();
            }
        }
    }

    _scanMushroomPickups(px, py) {
        var list = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("powerup") : [];
        var r2 = this._mushroomPickupRadius * this._mushroomPickupRadius;
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            if (!e || !e.transform) continue;
            if (e.active === false) continue;
            var ep = e.transform.position;
            var dx = ep.x - px, dy = ep.y - py;
            if (dx * dx + dy * dy < r2) {
                e.active = false;
                this.scene.setScale && this.scene.setScale(e.id, 0, 0, 0);
                this._applyPowerUp("mushroom");
            }
        }
        // Also check spawned items (mushrooms that came from question
        // blocks — they're tracked separately because they have item
        // physics, not just static placements).
        for (var s = this._spawnedItems.length - 1; s >= 0; s--) {
            var it = this._spawnedItems[s];
            if (it.kind !== "mushroom") continue;
            var entAfter = this._findSpawnedEntity(it.id);
            if (!entAfter || !entAfter.transform) continue;
            var p = entAfter.transform.position;
            var dx2 = p.x - px, dy2 = p.y - py;
            if (dx2 * dx2 + dy2 * dy2 < r2) {
                this._destroyEntity(it.id);
                this._spawnedItems.splice(s, 1);
                this._applyPowerUp("mushroom");
            }
        }
    }

    _scanEnemyOverlaps(pp) {
        var list = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("enemy") : [];
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            if (!e || !e.transform) continue;
            if (e.active === false) continue;
            var ep = e.transform.position;
            var dx = ep.x - pp.x;
            var dy = ep.y - pp.y;
            var dist = Math.sqrt(dx * dx + dy * dy); // position separation
            // Loose AABB-ish proximity — enemies are about 1m wide and
            // 1m tall after their default scale.
            if (Math.abs(dx) > 0.95 || Math.abs(dy) > 1.05) continue;
            // Stomp: player above the enemy AND falling. The behavior
            // surfaces vy via scene._runnerPlayer.vy.
            var playerAbove = (pp.y - ep.y) > 0.35;
            var falling = (typeof pp.vy === "number") ? pp.vy < -0.4 : false;
            if (playerAbove && falling) {
                this._stompEnemy(e.id);
            } else if (this._hitCooldown <= 0 && !pp.invincible) {
                this._takeHit("enemy");
                return; // one hit per tick
            }
        }
    }

    _stompEnemy(enemyId) {
        // Tell the enemy behavior it died — it does its own squish.
        this.scene.events.game.emit("entity_killed", { entityId: enemyId });
        // Score combo: each stomp within 0.6s of the previous doubles.
        this._stompCombo++;
        this._stompComboTimer = 0.6;
        var combo = this._stompCombo;
        var pts = this._scorePerStomp * combo;
        this._score += pts;
        // Tell the runner behavior to bounce off the squashed enemy.
        this.scene.events.game.emit("runner_stomped", { enemyId: enemyId, combo: combo });
    }

    _scanQuestionBlocks(pp) {
        var list = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("question_block") : [];
        var margin = this._questionBlockHitMargin;
        var vy = (typeof pp.vy === "number") ? pp.vy : 0;
        if (vy <= 0) return; // only counts when player is moving up
        for (var i = 0; i < list.length; i++) {
            var e = list[i];
            if (!e || !e.transform) continue;
            if (this._questionBlocksSpent[e.id]) continue;
            var ep = e.transform.position;
            // Hit when the player's head is just under the block and
            // horizontally aligned. Block is 1.2 tall so its bottom is
            // at ep.y - 0.6. Player is ~1.0 tall (small) or 1.5 (big);
            // we use a generous margin.
            var dx = ep.x - pp.x;
            if (Math.abs(dx) > margin) continue;
            var headY = pp.y + 0.6;
            var blockBottom = ep.y - 0.6;
            if (headY < blockBottom - margin || headY > blockBottom + margin) continue;
            this._spawnQuestionBlockItem(e, ep);
            return; // only one block per tick
        }
    }

    _spawnQuestionBlockItem(blockEnt, blockPos) {
        this._questionBlocksSpent[blockEnt.id] = true;
        // Re-tint the block to "spent" brown. addComponent merges the
        // new MeshRendererComponent data over the existing one (same
        // pattern coin_grab_game / lawn_defenders use to recolour
        // entities at runtime).
        this.scene.addComponent(blockEnt.id, "MeshRendererComponent", {
            meshType: "cube",
            baseColor: this._questionBlockSpentColor,
        });
        if (this.audio && this._blockHitSound) this.audio.playSound(this._blockHitSound, 0.45);
        var kind = this._nextBlockItem();
        this.scene.events.game.emit("runner_block_hit", { blockId: blockEnt.id, kind: kind });
        if (kind === "coin") {
            // Spawn a coin that floats up + auto-collects (SMB feel).
            this._addCoin();
        } else if (kind === "mushroom") {
            // Spawn a mushroom on top of the block with horizontal
            // walking velocity. Falls under gravity, picks up on
            // player overlap.
            var name = "MushroomItem_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
            var id = this.scene.createEntity ? this.scene.createEntity(name) : null;
            if (id == null) return;
            this.scene.setPosition(id, blockPos.x, blockPos.y + 1.0, 0);
            this.scene.setScale && this.scene.setScale(id, 0.7, 0.7, 0.7);
            this.scene.addComponent(id, "MeshRendererComponent", {
                meshType: "sphere",
                baseColor: [0.95, 0.30, 0.30, 1],
            });
            if (this.scene.addTag) {
                this.scene.addTag(id, "spawned_mushroom");
                this.scene.addTag(id, "powerup");
            }
            this._spawnedItems.push({ id: id, kind: "mushroom", vx: 2.5, vy: 4 });
        }
    }

    _nextBlockItem() {
        var seq = this._questionBlockItemSequence;
        var kind = seq[this._questionBlockItemIdx % seq.length];
        this._questionBlockItemIdx++;
        return kind;
    }

    _scanFlagReach(px) {
        if (px >= this._flagReachX && !this._ended) {
            // Bank time-bonus into score.
            var timeBonus = Math.floor(this._timeRemaining) * this._scorePerSecondLeft;
            this._score += timeBonus;
            this.scene.events.game.emit("runner_flag_reached", { time: Math.ceil(this._timeRemaining), score: this._score });
            if (this.audio && this._flagSound) this.audio.playSound(this._flagSound, 0.55);
            this._endGame(true, "flag");
        }
    }

    // ── Spawned items physics (mushroom etc.) ─────────────────────────

    _tickItems(dt) {
        for (var i = this._spawnedItems.length - 1; i >= 0; i--) {
            var it = this._spawnedItems[i];
            var ent = this._findSpawnedEntity(it.id);
            if (!ent || !ent.transform) {
                this._spawnedItems.splice(i, 1);
                continue;
            }
            var p = ent.transform.position;
            it.vy -= 28 * dt;
            if (it.vy < -22) it.vy = -22;
            var newX = p.x + it.vx * dt;
            var newY = p.y + it.vy * dt;
            // Crude ground stop — when the item is above what would be
            // the platform's top (y >= 0.5), let it sit. We have no
            // physics for the item, so this is a heuristic. If the item
            // lands on top of a brick / question block the block isn't
            // checked; it'll fall off and despawn off the kill plane.
            if (newY < 0.55) { newY = 0.55; it.vy = 0; }
            this.scene.setPosition(it.id, newX, newY, 0);
            if (newX > 130 || newX < -10 || newY < this._killPlaneY) {
                this._destroyEntity(it.id);
                this._spawnedItems.splice(i, 1);
            }
        }
    }

    _findSpawnedEntity(id) {
        var list = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("spawned_mushroom") : [];
        for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
        return null;
    }

    // ── Pickup outcomes ────────────────────────────────────────────────

    _addCoin() {
        this._coins++;
        this._coinsForExtraLife++;
        this._score += this._scorePerCoin;
        if (this.audio && this._coinSound) this.audio.playSound(this._coinSound, 0.32);
        this.scene.events.game.emit("runner_coin_grabbed", { total: this._coins });
        if (this._coinsForExtraLife >= this._extraLifeAtCoins) {
            this._coinsForExtraLife -= this._extraLifeAtCoins;
            this._lives++;
            if (this.audio && this._extraLifeSound) this.audio.playSound(this._extraLifeSound, 0.6);
            this.scene.events.game.emit("runner_extra_life", { lives: this._lives });
        }
    }

    _applyPowerUp(kind) {
        if (this._poweredUp) return;
        this._poweredUp = true;
        this.scene.events.game.emit("runner_powered_up", { kind: kind });
    }

    _takeHit(source) {
        if (this._poweredUp) {
            this._poweredUp = false;
            this._hitCooldown = 1.2;
            this.scene.events.game.emit("runner_powered_down", {});
            return;
        }
        this._loseLife(source);
    }

    _loseLife(reason) {
        this._lives--;
        this._hitCooldown = 1.2;
        this.scene.events.game.emit("runner_life_lost", { lives: this._lives, reason: reason });
        if (this._lives <= 0) {
            this._endGame(false, "no_lives");
        } else {
            // Reset coins/blocks/enemies per SMB convention so the run
            // continues from the spawn with a fresh course state.
            for (var i = 0; i < this._spawnedItems.length; i++) this._destroyEntity(this._spawnedItems[i].id);
            this._spawnedItems = [];
            this._questionBlocksSpent = {};
            this._reactivateTagged("coin");
            this._reactivateTagged("powerup");
            this._reactivateTagged("enemy");
            this._reactivateTagged("question_block");
            this._respawnPlayer();
        }
    }

    // ── Game over ─────────────────────────────────────────────────────

    _endGame(victory, reason) {
        if (this._ended) return;
        this._ended = true;
        this._won = !!victory;
        var stats = {
            "Score": String(this._score),
            "Coins": String(this._coins),
            "Lives Left": String(Math.max(0, this._lives)),
            "Time": (Math.max(0, Math.floor(this._timeRemaining))) + "s",
        };
        if (reason === "flag")     stats["Outcome"] = "Flag captured";
        else if (reason === "no_lives") stats["Outcome"] = "Out of lives";
        else if (reason === "time")     stats["Outcome"] = "Time up";

        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: victory ? "FLAG GET" : "GAME OVER", score: this._score, stats: stats },
        });
        if (victory) {
            this.scene.events.game.emit("game_won", { score: this._score });
            if (this.audio && this._winSound) this.audio.playSound(this._winSound, 0.7);
        } else {
            this.scene.events.game.emit("game_over", { score: this._score });
            if (this.audio && this._loseSound) this.audio.playSound(this._loseSound, 0.7);
        }
    }

    // ── HUD ────────────────────────────────────────────────────────────

    _publishHud() {
        var pp = this.scene._runnerPlayer || {};
        var distFlagPct = pp.x != null ? Math.max(0, Math.min(1, pp.x / this._flagReachX)) : 0;
        var fastTime = this._timeRemaining < this._fastTimeBelow;
        this.scene.events.ui.emit("hud_update", {
            runnerHud: {
                lives: this._lives,
                coins: this._coins,
                score: this._score,
                time: Math.max(0, Math.ceil(this._timeRemaining)),
                fastTime: fastTime,
                poweredUp: !!this._poweredUp,
                distancePct: distFlagPct,
                stompCombo: this._stompCombo,
            },
        });
    }

    // ── Helpers ────────────────────────────────────────────────────────

    _destroyEntity(id) {
        if (id == null) return;
        var s = this.scene;
        try {
            if (s.deleteEntity) s.deleteEntity(id);
            else if (s.removeEntity) s.removeEntity(id);
            else if (s.destroyEntity) s.destroyEntity(id);
            else if (s.setScale) s.setScale(id, 0, 0, 0);
        } catch (e) { /* may be gone */ }
    }
}
