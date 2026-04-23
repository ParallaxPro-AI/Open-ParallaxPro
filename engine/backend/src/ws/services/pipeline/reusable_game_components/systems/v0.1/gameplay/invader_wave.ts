// also: space invaders, arcade, bullet hell, waves, fixed-screen shooter
// Alien Invasion — single-player retro fixed-screen shooter rules.
//
// A grid of aliens marches across the playfield, dropping a row + reversing
// direction every time one of them kisses the side bounds. As the alien
// count drops, the step timer accelerates so the last few are always the
// frantic ones. Every so often an alien fires a bullet toward the player,
// a UFO zips across the top worth big points, and the player has three
// lives to wipe the grid clean.
//
// The system owns every runtime-spawned entity (aliens, bullets, bunker
// segments, UFO) so the template's world file only has to pre-place the
// player ship + decorations. Entities are stored in authoritative lists
// and destroyed/recycled as needed.
//
// Dies on:
//   * alien bullet hits player
//   * alien row descends to the player's row (doomsday)
// Wins on:
//   * all aliens destroyed in a wave → advance wave
//   * reach `wavesToWin` waves cleared → game_won
//
// Reusable for any fixed-screen shooter — grid size, march speeds,
// fire rates, lives, and scoring are all params.
class InvaderWaveSystem extends GameScript {
    // ── Config ─────────────────────────────────────────────────────
    _gridCols = 10;
    _gridRows = 5;
    _colSpacing = 2.6;
    _rowSpacing = 2.2;
    _gridStartZ = -15;       // Aliens start at this z (top of the screen)
    _playerRowZ = 4;         // Aliens reaching this z = game over
    _marchStepX = 1.0;
    _marchDropZ = 1.6;
    _marchSpeedStart = 0.7;  // seconds between steps at start
    _marchSpeedMin = 0.08;
    _alienFireRateStart = 0.38;  // expected fires per second across the whole grid
    _alienFireRateMax = 1.5;
    _bulletSpeed = 28;
    _playerBulletCap = 3;
    _lives = 3;
    _wavesToWin = 3;
    _ufoChancePerSec = 0.01;
    _ufoSpeed = 18;
    _ufoScore = 150;

    _bunkerCount = 4;
    _bunkerSegmentsPerBunker = 6;
    _bunkerStartZ = 2.2;
    _bunkerSegmentSize = 0.55;

    _alienRowScores = [10, 10, 20, 20, 30];  // indexed by row (0 = bottom row)
    _alienRowColors = [
        [0.3, 0.95, 0.5, 1],     // row 0: green
        [0.3, 0.9, 0.95, 1],     // row 1: cyan
        [0.95, 0.9, 0.3, 1],     // row 2: gold
        [0.95, 0.4, 0.95, 1],    // row 3: magenta
        [0.95, 0.35, 0.35, 1],   // row 4 (top): red
    ];

    // ── State ──────────────────────────────────────────────────────
    _aliens = [];           // [{ ent, row, col, alive, x, z }]
    _playerBullets = [];    // [{ ent, x, z }]
    _alienBullets = [];     // [{ ent, x, z, vx, vz }]
    _bunkers = [];          // flat list of segment ents
    _ufo = null;            // { ent, x, z, vx, alive, score }
    _marchDir = 1;
    _marchTimer = 0;
    _marchSpeed = 0.7;
    _alienCount = 0;
    _score = 0;
    _highScore = 0;
    _livesLeft = 3;
    _wave = 1;
    _dead = false;
    _deathTimer = 0;
    _introTimer = 0;
    _waveCompleteTimer = 0;
    _waveComplete = false;
    _pendingNextWave = false;
    _matchElapsed = 0;
    _gameEnded = false;
    _alienFireAccumulator = 0;

    onStart() {
        var self = this;
        this._highScore = 0;
        this._livesLeft = this._lives;
        this._score = 0;

        this.scene.events.game.on("game_ready", function() {
            self._highScore = 0;
            self._livesLeft = self._lives;
            self._score = 0;
            self._wave = 1;
            self._gameEnded = false;
            self._resetWave(true);
        });
        this.scene.events.game.on("restart_game", function() {
            self._highScore = Math.max(self._highScore, self._score);
            self._livesLeft = self._lives;
            self._score = 0;
            self._wave = 1;
            self._gameEnded = false;
            self._resetWave(true);
        });
        this.scene.events.game.on("invader_fire_pressed", function(data) {
            self._onPlayerFire(data || {});
        });

        // Kick things off in case game_ready was already emitted by the
        // flow before we subscribed (happens because game_ready is
        // emitted from on_enter of the playing state).
        this._resetWave(true);
    }

    onUpdate(dt) {
        this._matchElapsed += dt;

        if (this._introTimer > 0) {
            this._introTimer -= dt;
            if (this._introTimer <= 0) {
                this.scene._invaderFrozen = false;
                if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/go.ogg", 0.55);
            }
            this._pushHud();
            return;
        }

        if (this._dead) {
            this._deathTimer -= dt;
            if (this._deathTimer <= 0) {
                if (this._livesLeft > 0) this._resetWave(false);
                else this._gameOver();
            }
            this._pushHud();
            return;
        }

        if (this._waveComplete) {
            this._waveCompleteTimer -= dt;
            if (this._waveCompleteTimer <= 0) {
                if (this._wave >= this._wavesToWin) this._gameWon();
                else {
                    this._wave += 1;
                    this._resetWave(false);
                }
            }
            this._pushHud();
            return;
        }

        if (this._gameEnded) return;

        this._tickAlienMarch(dt);
        this._tickAlienFire(dt);
        this._tickBullets(dt);
        this._tickUfo(dt);
        this._checkWaveComplete();

        this._pushHud();
    }

    // ─── Reset / wave lifecycle ──────────────────────────────────────
    _resetWave(fresh) {
        this._clearRuntimeEntities();
        this._playerBullets = [];
        this._alienBullets = [];
        this._bunkers = [];
        this._ufo = null;
        this._aliens = [];
        this._marchDir = 1;
        // March interval shrinks slightly per wave so later waves feel punchier.
        this._marchSpeed = Math.max(this._marchSpeedMin, this._marchSpeedStart - (this._wave - 1) * 0.12);
        this._marchTimer = this._marchSpeed;
        this._alienFireAccumulator = 0;
        this._dead = false;
        this._waveComplete = false;
        this._introTimer = fresh ? 1.6 : 1.1;
        this._pendingNextWave = false;
        this.scene._invaderFrozen = true;

        this._spawnAlienGrid();
        this._spawnBunkers();
        this._resetPlayer();
        this.scene.events.game.emit("invader_wave_reset", { wave: this._wave, lives: this._livesLeft });
        this._pushHud();
    }

    _clearRuntimeEntities() {
        var tags = ["invader_alien", "invader_bullet_player", "invader_bullet_alien", "invader_bunker", "invader_ufo", "invader_fx"];
        for (var i = 0; i < tags.length; i++) {
            var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag(tags[i]) : [];
            for (var j = 0; j < all.length; j++) {
                if (all[j] && this.scene.destroyEntity) this.scene.destroyEntity(all[j].id);
            }
        }
    }

    _spawnAlienGrid() {
        // Grid start z depends on wave (pushing lower each wave for extra pressure).
        var startZ = this._gridStartZ + (this._wave - 1) * 1.2;
        var leftX = -((this._gridCols - 1) * this._colSpacing) / 2;
        this._alienCount = 0;
        this._aliens = [];
        for (var row = 0; row < this._gridRows; row++) {
            var color = this._alienRowColors[row] || [1, 1, 1, 1];
            for (var col = 0; col < this._gridCols; col++) {
                var x = leftX + col * this._colSpacing;
                var z = startZ + row * this._rowSpacing;
                var ent = this._spawnPrim("Alien_" + row + "_" + col, "cube", {
                    x: x, y: 1.2, z: z,
                    sx: 1.3, sy: 1.0, sz: 1.3,
                    color: color,
                    emissive: [color[0], color[1], color[2]],
                    emissiveIntensity: 1.2,
                    tag: "invader_alien",
                });
                if (ent) this._alienCount++;
                this._aliens.push({ ent: ent, row: row, col: col, alive: !!ent, x: x, z: z });
            }
        }
    }

    _spawnBunkers() {
        // Stretch 4 bunkers across the playfield between aliens and player.
        var leftX = -((this._bunkerCount - 1) * 7.5) / 2;
        for (var b = 0; b < this._bunkerCount; b++) {
            var cx = leftX + b * 7.5;
            // Each bunker is a small 5-cube arch.
            var segPositions = [
                [-1.1, 0], [-0.55, 0.55], [0, 0], [0.55, 0.55], [1.1, 0],
                [-0.55, -0.55], [0.55, -0.55],
            ];
            for (var s = 0; s < segPositions.length; s++) {
                var sp = segPositions[s];
                var ent = this._spawnPrim("Bunker_" + b + "_" + s, "cube", {
                    x: cx + sp[0], y: 1 + sp[1] * 0.5 + 0.4, z: this._bunkerStartZ - sp[1] * 0.3,
                    sx: this._bunkerSegmentSize, sy: this._bunkerSegmentSize, sz: this._bunkerSegmentSize,
                    color: [0.25, 0.85, 0.55, 1],
                    emissive: [0.25, 0.9, 0.55],
                    emissiveIntensity: 0.5,
                    tag: "invader_bunker",
                });
                if (ent) this._bunkers.push({ ent: ent, hp: 3 });
            }
        }
    }

    _resetPlayer() {
        var player = this.scene.findEntityByName && this.scene.findEntityByName("Player");
        if (!player) return;
        this.scene.setPosition(player.id, 0, 1, this._playerRowZ);
        player._invaderAlive = true;
        player.transform.markDirty && player.transform.markDirty();
    }

    // ─── March ───────────────────────────────────────────────────────
    _tickAlienMarch(dt) {
        this._marchTimer -= dt;
        if (this._marchTimer > 0) return;
        this._marchTimer = this._marchSpeed;

        // Determine the collective extent of the alive aliens.
        var aliveAliens = this._aliens.filter(function(a) { return a.alive; });
        if (!aliveAliens.length) return;
        var minX = 1e9, maxX = -1e9;
        for (var i = 0; i < aliveAliens.length; i++) {
            var a = aliveAliens[i];
            if (a.x < minX) minX = a.x;
            if (a.x > maxX) maxX = a.x;
        }
        // Would the next step push us off the edge?
        var lip = 16;
        var drop = false;
        if (this._marchDir > 0 && maxX + this._marchStepX > lip) {
            this._marchDir = -1;
            drop = true;
        } else if (this._marchDir < 0 && minX - this._marchStepX < -lip) {
            this._marchDir = 1;
            drop = true;
        }
        for (var j = 0; j < aliveAliens.length; j++) {
            var al = aliveAliens[j];
            if (drop) {
                al.z += this._marchDropZ;
            } else {
                al.x += this._marchStepX * this._marchDir;
            }
            if (al.ent && al.ent.transform) {
                al.ent.transform.position.x = al.x;
                al.ent.transform.position.z = al.z;
                al.ent.transform.markDirty && al.ent.transform.markDirty();
                // Pulse the alien subtly on each march step.
                this._pulseEmissive(al.ent, 1.8);
            }
            // Alien reached the player's row → game over.
            if (al.z >= this._playerRowZ - 0.5) {
                this._onPlayerDeath("overrun");
                return;
            }
        }
        // Speed up as aliens die: remaining / total → interval scale.
        var remaining = aliveAliens.length;
        var total = this._gridRows * this._gridCols;
        var frac = remaining / total;
        this._marchSpeed = Math.max(this._marchSpeedMin, this._marchSpeedStart * frac + 0.1 * frac + 0.05);
        if (this.audio) {
            var marchTone = remaining > total * 0.75 ? 1
                          : remaining > total * 0.5  ? 2
                          : remaining > total * 0.25 ? 3
                          : 4;
            this.audio.playSound("/assets/kenney/audio/digital_audio/lowThreeTone.ogg", 0.08 + marchTone * 0.02);
        }
    }

    _pulseEmissive(ent, intensity) {
        if (!ent || !ent.getComponent) return;
        var mr = ent.getComponent("MeshRendererComponent");
        if (!mr) return;
        mr.emissiveIntensity = intensity;
        setTimeout(function() {
            if (mr) mr.emissiveIntensity = 1.2;
        }, 120);
    }

    // ─── Alien firing ────────────────────────────────────────────────
    _tickAlienFire(dt) {
        var aliveAliens = this._aliens.filter(function(a) { return a.alive; });
        if (!aliveAliens.length) return;
        // Scale fire rate with wave and (inversely) with remaining count.
        var baseRate = this._alienFireRateStart + (this._wave - 1) * 0.18;
        var rate = Math.min(this._alienFireRateMax, baseRate + (1 - aliveAliens.length / (this._gridRows * this._gridCols)) * 0.7);
        this._alienFireAccumulator += dt * rate;
        while (this._alienFireAccumulator >= 1) {
            this._alienFireAccumulator -= 1;
            // Random alive alien fires; prefer front-row aliens (largest z).
            var shooter = null;
            // Group aliens by column, pick the front-most in each column, then
            // pick randomly from those — mimics classic front-row fire pattern.
            var frontByCol = {};
            for (var i = 0; i < aliveAliens.length; i++) {
                var a = aliveAliens[i];
                if (!frontByCol[a.col] || a.z > frontByCol[a.col].z) frontByCol[a.col] = a;
            }
            var cols = Object.keys(frontByCol);
            if (!cols.length) return;
            shooter = frontByCol[cols[Math.floor(Math.random() * cols.length)]];
            if (!shooter || !shooter.ent) continue;
            this._spawnAlienBullet(shooter.x, shooter.z);
        }
    }

    _spawnAlienBullet(x, z) {
        var ent = this._spawnPrim("AlienBullet_" + this._matchElapsed.toFixed(3) + "_" + Math.random().toFixed(3), "cube", {
            x: x, y: 1.3, z: z + 0.6,
            sx: 0.2, sy: 0.5, sz: 0.6,
            color: [1, 0.3, 0.35, 1],
            emissive: [1, 0.3, 0.35],
            emissiveIntensity: 2.2,
            tag: "invader_bullet_alien",
        });
        this._alienBullets.push({
            ent: ent, x: x, z: z + 0.6,
            vx: 0, vz: this._bulletSpeed * 0.65,
        });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_003.ogg", 0.25);
    }

    // ─── Player firing ───────────────────────────────────────────────
    _onPlayerFire(data) {
        if (this.scene._invaderFrozen) return;
        if (this._dead || this._waveComplete || this._gameEnded) return;
        if (this._playerBullets.length >= this._playerBulletCap) return;
        var player = this.scene.findEntityByName && this.scene.findEntityByName("Player");
        if (!player) return;
        var pp = player.transform.position;
        var ent = this._spawnPrim("PlayerBullet_" + this._matchElapsed.toFixed(3) + "_" + Math.random().toFixed(3), "cube", {
            x: pp.x, y: 1.3, z: pp.z - 0.8,
            sx: 0.2, sy: 0.5, sz: 0.9,
            color: [0.3, 1, 0.9, 1],
            emissive: [0.3, 1, 0.95],
            emissiveIntensity: 2.6,
            tag: "invader_bullet_player",
        });
        this._playerBullets.push({ ent: ent, x: pp.x, z: pp.z - 0.8 });
        this.scene.events.game.emit("invader_fire_emitted", {});
        if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_000.ogg", 0.4);
    }

    // ─── Bullet tick ─────────────────────────────────────────────────
    _tickBullets(dt) {
        // Player bullets go -z.
        for (var i = this._playerBullets.length - 1; i >= 0; i--) {
            var b = this._playerBullets[i];
            if (!b) { this._playerBullets.splice(i, 1); continue; }
            b.z -= this._bulletSpeed * dt;
            if (b.ent && b.ent.transform) {
                b.ent.transform.position.x = b.x;
                b.ent.transform.position.z = b.z;
                b.ent.transform.markDirty && b.ent.transform.markDirty();
            }
            // Off-screen.
            if (b.z < -24) {
                if (b.ent && this.scene.destroyEntity) this.scene.destroyEntity(b.ent.id);
                this._playerBullets.splice(i, 1);
                continue;
            }
            // Hit checks vs aliens, bunker, UFO.
            var hit = this._playerBulletHit(b);
            if (hit) {
                if (b.ent && this.scene.destroyEntity) this.scene.destroyEntity(b.ent.id);
                this._playerBullets.splice(i, 1);
            }
        }

        // Alien bullets go +z.
        for (var j = this._alienBullets.length - 1; j >= 0; j--) {
            var ab = this._alienBullets[j];
            if (!ab) { this._alienBullets.splice(j, 1); continue; }
            ab.prevZ = ab.z;
            ab.z += ab.vz * dt;
            if (ab.ent && ab.ent.transform) {
                ab.ent.transform.position.x = ab.x;
                ab.ent.transform.position.z = ab.z;
                ab.ent.transform.markDirty && ab.ent.transform.markDirty();
            }
            if (ab.z > this._playerRowZ + 6) {
                if (ab.ent && this.scene.destroyEntity) this.scene.destroyEntity(ab.ent.id);
                this._alienBullets.splice(j, 1);
                continue;
            }
            // Hit bunker segment.
            if (this._alienBulletVsBunker(ab)) {
                if (ab.ent && this.scene.destroyEntity) this.scene.destroyEntity(ab.ent.id);
                this._alienBullets.splice(j, 1);
                continue;
            }
            // Hit player.
            if (this._alienBulletVsPlayer(ab)) {
                if (ab.ent && this.scene.destroyEntity) this.scene.destroyEntity(ab.ent.id);
                this._alienBullets.splice(j, 1);
                this._onPlayerDeath("shot");
                return;
            }
        }
    }

    _playerBulletHit(b) {
        // vs aliens
        for (var i = 0; i < this._aliens.length; i++) {
            var a = this._aliens[i];
            if (!a.alive || !a.ent) continue;
            if (Math.abs(a.x - b.x) < 0.9 && Math.abs(a.z - b.z) < 1.0) {
                a.alive = false;
                if (a.ent && this.scene.destroyEntity) this.scene.destroyEntity(a.ent.id);
                a.ent = null;
                this._score += this._alienRowScores[a.row] || 10;
                this.scene.events.game.emit("invader_alien_killed", {
                    row: a.row, col: a.col, score: this._score,
                });
                if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/explosionCrunch_002.ogg", 0.3);
                return true;
            }
        }
        // vs bunker
        for (var b2 = 0; b2 < this._bunkers.length; b2++) {
            var seg = this._bunkers[b2];
            if (!seg || !seg.ent) continue;
            var p = seg.ent.transform.position;
            if (Math.abs(p.x - b.x) < 0.45 && Math.abs(p.z - b.z) < 0.45) {
                seg.hp -= 1;
                if (seg.hp <= 0) {
                    if (seg.ent && this.scene.destroyEntity) this.scene.destroyEntity(seg.ent.id);
                    this._bunkers[b2] = null;
                } else {
                    // fade the segment color.
                    var mr = seg.ent.getComponent("MeshRendererComponent");
                    if (mr) {
                        var factor = seg.hp / 3;
                        if (mr.baseColor) {
                            mr.baseColor[0] *= 0.8; mr.baseColor[1] *= 0.8; mr.baseColor[2] *= 0.8;
                        }
                        if (mr.emissive) mr.emissiveIntensity = 0.3 * factor;
                    }
                }
                return true;
            }
        }
        // vs UFO
        if (this._ufo && this._ufo.alive && this._ufo.ent) {
            var up = this._ufo.ent.transform.position;
            if (Math.abs(up.x - b.x) < 1.6 && Math.abs(up.z - b.z) < 0.9) {
                this._ufo.alive = false;
                this._score += this._ufo.score || this._ufoScore;
                if (this._ufo.ent && this.scene.destroyEntity) this.scene.destroyEntity(this._ufo.ent.id);
                this.scene.events.game.emit("invader_ufo_killed", { score: this._ufoScore });
                this._ufo = null;
                if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/explosionCrunch_003.ogg", 0.55);
                return true;
            }
        }
        return false;
    }

    _alienBulletVsBunker(ab) {
        for (var i = 0; i < this._bunkers.length; i++) {
            var seg = this._bunkers[i];
            if (!seg || !seg.ent) continue;
            var p = seg.ent.transform.position;
            if (Math.abs(p.x - ab.x) < 0.45 && Math.abs(p.z - ab.z) < 0.45) {
                seg.hp -= 1;
                if (seg.hp <= 0) {
                    if (seg.ent && this.scene.destroyEntity) this.scene.destroyEntity(seg.ent.id);
                    this._bunkers[i] = null;
                }
                return true;
            }
        }
        return false;
    }

    _alienBulletVsPlayer(ab) {
        var player = this.scene.findEntityByName && this.scene.findEntityByName("Player");
        if (!player) return false;
        if (player._invaderAlive === false) return false;
        var pp = player.transform.position;
        if (Math.abs(pp.x - ab.x) >= 1.1) return false;
        // Swept check: bullet swept the ship's z this frame, even if a slow
        // tick stepped it past the point-window in one go.
        var prevZ = (typeof ab.prevZ === 'number') ? ab.prevZ : (ab.z - ab.vz * 0.05);
        var lo = Math.min(prevZ, ab.z) - 0.5;
        var hi = Math.max(prevZ, ab.z) + 0.5;
        return pp.z >= lo && pp.z <= hi;
    }

    // ─── UFO ────────────────────────────────────────────────────────
    _tickUfo(dt) {
        if (!this._ufo) {
            if (Math.random() < this._ufoChancePerSec * dt * 60) this._spawnUfo();
            return;
        }
        var u = this._ufo;
        u.x += u.vx * dt;
        if (u.ent && u.ent.transform) {
            u.ent.transform.position.x = u.x;
            u.ent.transform.markDirty && u.ent.transform.markDirty();
        }
        if (Math.abs(u.x) > 22) {
            if (u.ent && this.scene.destroyEntity) this.scene.destroyEntity(u.ent.id);
            this._ufo = null;
        }
    }

    _spawnUfo() {
        var side = Math.random() < 0.5 ? -1 : 1;
        var x = side * 22;
        var z = this._gridStartZ - 5;  // above the alien grid
        var ent = this._spawnPrim("UFO_" + this._matchElapsed.toFixed(2), "cube", {
            x: x, y: 1.5, z: z,
            sx: 2.0, sy: 0.6, sz: 1.1,
            color: [0.95, 0.25, 0.45, 1],
            emissive: [1.0, 0.3, 0.5],
            emissiveIntensity: 2.8,
            tag: "invader_ufo",
        });
        this._ufo = {
            ent: ent, x: x, z: z, vx: -side * this._ufoSpeed,
            alive: true, score: this._ufoScore + Math.floor(Math.random() * 3) * 50,
        };
        if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/forceField_003.ogg", 0.35);
    }

    // ─── Wave completion ────────────────────────────────────────────
    _checkWaveComplete() {
        var any = false;
        for (var i = 0; i < this._aliens.length; i++) {
            if (this._aliens[i].alive) { any = true; break; }
        }
        if (!any && !this._waveComplete) {
            this._waveComplete = true;
            this._waveCompleteTimer = 2.4;
            this.scene._invaderFrozen = true;
            this.scene.events.game.emit("invader_wave_cleared", { wave: this._wave });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/objective_achieved.ogg", 0.55);
        }
    }

    // ─── Death ──────────────────────────────────────────────────────
    _onPlayerDeath(reason) {
        if (this._dead || this._gameEnded) return;
        this._livesLeft -= 1;
        this._dead = true;
        this._deathTimer = reason === "overrun" ? 2.8 : 1.6;
        this.scene._invaderFrozen = true;
        var player = this.scene.findEntityByName && this.scene.findEntityByName("Player");
        if (player) player._invaderAlive = false;
        this.scene.events.game.emit("invader_player_died", {
            reason: reason, livesLeft: this._livesLeft, score: this._score,
        });
        this.scene.events.game.emit("player_died", {});
        if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/explosionCrunch_004.ogg", 0.6);
        // For overrun deaths (aliens reached the bottom), force immediate game over.
        if (reason === "overrun") this._livesLeft = 0;
    }

    _gameOver() {
        this._gameEnded = true;
        this._highScore = Math.max(this._highScore, this._score);
        this.scene._invaderFrozen = true;
        this.scene.events.game.emit("invader_game_over", {
            score: this._score, highScore: this._highScore, wave: this._wave,
        });
        this.scene.events.game.emit("game_over", { score: this._score });
    }

    _gameWon() {
        this._gameEnded = true;
        this._highScore = Math.max(this._highScore, this._score);
        this.scene._invaderFrozen = true;
        this.scene.events.game.emit("invader_game_won", {
            score: this._score, highScore: this._highScore,
        });
        this.scene.events.game.emit("game_won", { score: this._score });
    }

    // ─── HUD ────────────────────────────────────────────────────────
    _pushHud() {
        var aliveAliens = 0;
        for (var i = 0; i < this._aliens.length; i++) if (this._aliens[i].alive) aliveAliens++;
        this.scene.events.ui.emit("hud_update", {
            _invader: {
                score: this._score,
                highScore: this._highScore,
                lives: this._livesLeft,
                maxLives: this._lives,
                wave: this._wave,
                maxWave: this._wavesToWin,
                aliensAlive: aliveAliens,
                aliensTotal: this._gridRows * this._gridCols,
                intro: this._introTimer > 0,
                dead: this._dead,
                waveComplete: this._waveComplete,
                gameEnded: this._gameEnded,
                ufoActive: !!(this._ufo && this._ufo.alive),
            },
        });
    }

    // ─── Helpers ────────────────────────────────────────────────────
    _spawnPrim(name, meshType, cfg) {
        var scene = this.scene;
        var id = scene.createEntity && scene.createEntity(name);
        if (id == null) return null;
        scene.setPosition && scene.setPosition(id, cfg.x || 0, cfg.y || 0, cfg.z || 0);
        scene.setScale && scene.setScale(id, cfg.sx || 1, cfg.sy || 1, cfg.sz || 1);
        scene.addComponent(id, "MeshRendererComponent", {
            meshType: meshType,
            baseColor: cfg.color || [0.6, 0.6, 0.6, 1],
            emissive: cfg.emissive || [0, 0, 0],
            emissiveIntensity: cfg.emissiveIntensity || 0,
        });
        if (cfg.tag && scene.addTag) scene.addTag(id, cfg.tag);
        return scene.findEntityByName && scene.findEntityByName(name);
    }
}
