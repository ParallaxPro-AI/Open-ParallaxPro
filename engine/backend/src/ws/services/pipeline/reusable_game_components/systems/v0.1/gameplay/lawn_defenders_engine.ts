// also: plant placement, tower defense, grid-based strategy, wave spawning, resource economy
// Lawn Defenders engine — single-player lane-defense game state.
//
// Owns:
//   - The 5×9 grid (rows × cols) of plant slots, including HP per cell
//     and per-plant cooldowns (sunflower produce timer, peashooter
//     fire timer, cherry-bomb fuse).
//   - The sun economy: sky drops every skyDropIntervalSec, sunflower
//     drops on their own timer, click-to-collect with proximity check
//     against scene mouse → ground projection.
//   - Plant placement: armed via UI card (ui_event from
//     lawn_defenders_hud) or number-key, then placed by clicking an
//     empty cell with enough sun banked.
//   - Wave spawner: totalWaves of progressively harder zombies, each
//     wave spaced waveIntervalSec apart with a brief buildup quiet.
//   - Zombie + projectile + cherry-bomb tick logic. Zombies are
//     plain entities — the engine drives their position, attacks, and
//     death directly so per-zombie behaviors aren't required.
//   - Win on surviving the last wave's final zombie. Lose the moment
//     a zombie crosses houseColX.
//
// Every entity (plants, zombies, projectiles, sun blobs, cherry FX) is
// spawned via scene.createEntity at runtime — the world placements
// only contain the static stage (lawn, fences, house, camera, sky).
class LawnDefendersEngineSystem extends GameScript {
    _rows = 5;
    _cols = 9;
    _cellSize = 1.4;
    _houseColX = -7;
    _spawnColX = 7;
    _startSun = 75;
    _skyDropIntervalSec = 11;
    _sunDropAmount = 25;
    _sunBlobLifetimeSec = 9;
    _sunFallSpeed = 1.8;
    _sunAutoCollectDelay = 1.5;     // sec a landed blob waits before auto-banking
    _sunfowerProduceIntervalSec = 22;
    _sunfowerSunAmount = 25;
    _totalWaves = 5;
    _waveIntervalSec = 22;
    _waveBuildupSec = 5;
    _zombieMoveSpeed = 0.45;
    _zombieAttackInterval = 0.8;
    _zombieAttackDamage = 12;
    _zombieWalkerHp = 100;
    _zombieConeHp = 280;
    _zombieBucketHp = 540;
    _peashooterFireInterval = 1.5;
    _peashooterDamage = 22;
    _peashooterRange = 14;
    _projectileSpeed = 9;
    _wallnutHp = 600;
    _sunflowerHp = 70;
    _peashooterHp = 100;
    _cherryHp = 60;
    _cherryDetonateDelay = 1.0;
    _cherryRadius = 2.4;
    _cherryDamage = 1800;
    _plantCardSunCost = [50, 100, 50, 150];
    _plantCardCooldown = [4, 6, 4, 16];
    _interactGroundY = 0.05;
    _clickRadius = 0.85;
    _sunPickupSound = "";
    _plantPlaceSound = "";
    _plantBlockedSound = "";
    _peaShootSound = "";
    _peaHitSound = "";
    _zombieMunchSound = "";
    _zombieDieSound = "";
    _cherryBoomSound = "";
    _waveStartSound = "";
    _winSound = "";
    _loseSound = "";

    // Per-game state
    _grid = null;            // _grid[col][row] = plantCell|null
    _zombies = [];
    _projectiles = [];
    _sunBlobs = [];
    _explosions = [];        // [{ id, life }]
    _waveIdx = 0;
    _waveQueue = [];
    _waveTimer = 0;
    _waveActive = false;
    _allWavesQueued = false;
    _sun = 75;
    _armedPlant = "";
    _cardCooldowns = [0, 0, 0, 0];
    _skyDropTimer = 0;
    _gameOver = false;
    _won = false;
    _initialized = false;
    _hoverCell = null;        // {col, row} under mouse, for HUD cursor preview
    _cursorX = 0;             // virtual-cursor screen pos from ui_bridge.
    _cursorY = 0;             //   Raw getMousePosition() is frozen under
    _gotCursor = false;       //   pointer lock, so we use cursor_move events.
    _plantKindToCardIdx = { sunflower: 0, peashooter: 1, wallnut: 2, cherry: 3 };

    // Wave composition (kind names map to spawn fns below). Builds up
    // from light walker pressure to mixed cone+bucket finale.
    _waveDefs = [
        ["walker","walker","walker","walker","walker","walker"],
        ["walker","walker","walker","cone","walker","walker","cone","walker"],
        ["walker","cone","walker","cone","walker","cone","walker","cone","walker","walker"],
        ["walker","cone","cone","walker","bucket","walker","cone","walker","bucket","walker","cone","walker"],
        ["walker","cone","bucket","walker","cone","bucket","walker","cone","bucket","walker","cone","bucket","walker","walker"],
    ];

    onStart() {
        var self = this;
        this._fullReset();
        this._initialized = true;

        this.scene.events.game.on("game_ready", function() { self._fullReset(); });
        this.scene.events.game.on("restart_game", function() { self._fullReset(); });

        // Track the virtual cursor from ui_bridge. Pointer lock is
        // engaged in play mode, which freezes the raw mouse reading,
        // so cell hover/click must be driven by the visible cursor.
        this.scene.events.ui.on("cursor_move", function(d) {
            if (!d) return;
            self._cursorX = d.x;
            self._cursorY = d.y;
            self._gotCursor = true;
        });

        // Click handling is event-driven so the click coords match what
        // the user actually touched. ui_bridge emits cursor_move and then
        // cursor_click in the same scope on the press frame — the click
        // handler is guaranteed to see the freshest pointer position even
        // if our system updates before ui_bridge in the frame. Polling
        // MouseLeft here would miss the tap-frame coords on touch devices,
        // where a tap is the only event that moves the cursor and would
        // place at the previous tap location.
        this.scene.events.ui.on("cursor_click", function(d) {
            if (!d) return;
            self._handleClick(d.x, d.y);
        });
        this.scene.events.ui.on("cursor_right_click", function() {
            self._clearArmed();
        });

        // Plant card clicked in the HUD palette → arm placement. Card
        // index drives plant kind via the cardIdx → kind map below; the
        // HUD also offers a number-key shortcut so this isn't the only path.
        this.scene.events.ui.on("ui_event:hud/lawn_defenders_hud:select_plant", function(d) {
            var p = (d && d.payload) || {};
            self._armPlant(p.plant || "");
        });
        this.scene.events.ui.on("ui_event:hud/lawn_defenders_hud:cancel_plant", function() {
            self._clearArmed();
        });
    }

    onUpdate(dt) {
        if (!this._initialized || this._gameOver) return;

        // Tick cooldowns + timers.
        for (var i = 0; i < this._cardCooldowns.length; i++) {
            if (this._cardCooldowns[i] > 0) this._cardCooldowns[i] -= dt;
        }
        this._skyDropTimer += dt;
        if (this._skyDropTimer >= this._skyDropIntervalSec) {
            this._skyDropTimer = 0;
            this._spawnSkySun();
        }

        // Number-key plant arming as a keyboard shortcut.
        if (this.input) {
            if (this.input.isKeyPressed && this.input.isKeyPressed("Digit1")) this._armPlant("sunflower");
            if (this.input.isKeyPressed && this.input.isKeyPressed("Digit2")) this._armPlant("peashooter");
            if (this.input.isKeyPressed && this.input.isKeyPressed("Digit3")) this._armPlant("wallnut");
            if (this.input.isKeyPressed && this.input.isKeyPressed("Digit4")) this._armPlant("cherry");
            if (this.input.isKeyPressed && this.input.isKeyPressed("Escape")) this._clearArmed();
        }

        // Refresh the HUD ghost-cell preview from the latest cursor pos.
        this._tickHover();

        // Wave spawning.
        this._tickWaves(dt);

        // Plant ticks (sunflowers produce, peashooters shoot, cherry fuse).
        this._tickPlants(dt);

        // Zombie + projectile + cherry / sun blob world ticks.
        this._tickZombies(dt);
        this._tickProjectiles(dt);
        this._tickSunBlobs(dt);
        this._tickExplosions(dt);

        // Win check — final wave drained AND zombies cleared.
        if (this._allWavesQueued && this._waveQueue.length === 0 && this._zombies.length === 0 && !this._gameOver) {
            this._endGame(true, "all waves cleared");
        }

        this._publishHud();
    }

    // ─── Reset / state ──────────────────────────────────────────────────

    _fullReset() {
        // Clear any leftovers from the previous run. Visuals get
        // shrunken so they vanish instantly without cluttering the scene.
        if (this._grid) {
            for (var c = 0; c < this._cols; c++) {
                for (var r = 0; r < this._rows; r++) {
                    var cell = this._grid[c] && this._grid[c][r];
                    if (cell && cell.entityIds) this._destroyAll(cell.entityIds);
                }
            }
        }
        for (var z = 0; z < this._zombies.length; z++) this._destroyAll(this._zombies[z].entityIds || []);
        for (var p = 0; p < this._projectiles.length; p++) this._destroyEntity(this._projectiles[p].id);
        for (var s = 0; s < this._sunBlobs.length; s++) this._destroyEntity(this._sunBlobs[s].id);
        for (var x = 0; x < this._explosions.length; x++) this._destroyEntity(this._explosions[x].id);

        this._grid = [];
        for (var c2 = 0; c2 < this._cols; c2++) {
            var col = [];
            for (var r2 = 0; r2 < this._rows; r2++) col.push(null);
            this._grid.push(col);
        }
        this._zombies = [];
        this._projectiles = [];
        this._sunBlobs = [];
        this._explosions = [];
        this._waveIdx = 0;
        this._waveQueue = [];
        this._waveTimer = -this._waveBuildupSec; // brief intro pause
        this._waveActive = false;
        this._allWavesQueued = false;
        this._sun = this._startSun;
        this._armedPlant = "";
        this._cardCooldowns = [0, 0, 0, 0];
        this._skyDropTimer = 0;
        this._gameOver = false;
        this._won = false;
        this._hoverCell = null;

        this.scene.events.game.emit("sun_changed", { sun: this._sun, delta: 0 });
        this.scene.events.game.emit("plant_armed_cleared", {});
    }

    // ─── Wave logic ─────────────────────────────────────────────────────

    _tickWaves(dt) {
        this._waveTimer += dt;
        // Pull next wave queue when the timer crosses the interval.
        if (!this._waveActive && this._waveIdx < this._totalWaves && this._waveTimer >= this._waveIntervalSec) {
            this._waveTimer = 0;
            this._waveIdx++;
            this._waveQueue = (this._waveDefs[this._waveIdx - 1] || []).slice();
            this._waveActive = true;
            if (this._waveIdx >= this._totalWaves) this._allWavesQueued = true;
            if (this.audio && this._waveStartSound) this.audio.playSound(this._waveStartSound, 0.45);
            this.scene.events.game.emit("wave_started", { wave: this._waveIdx });
        }
        // Drain the active wave at a rate of one per ~1.5s so the lane
        // doesn't get steamrolled in the first second of the wave.
        if (this._waveActive) {
            this._waveSpawnTimer = (this._waveSpawnTimer || 0) + dt;
            if (this._waveSpawnTimer >= 1.4) {
                this._waveSpawnTimer = 0;
                if (this._waveQueue.length > 0) {
                    var kind = this._waveQueue.shift();
                    this._spawnZombie(kind);
                }
                if (this._waveQueue.length === 0) this._waveActive = false;
            }
        }
    }

    // ─── Mouse input ────────────────────────────────────────────────────

    _tickHover() {
        if (!this.scene.screenPointToGround) return;
        if (!this._gotCursor) return;
        var ground = this.scene.screenPointToGround(this._cursorX, this._cursorY, this._interactGroundY);
        if (!ground) return;
        this._hoverCell = this._worldToCell(ground.x, ground.z);
    }

    _handleClick(x, y) {
        if (!this._initialized || this._gameOver) return;
        if (!this.scene.screenPointToGround) return;
        var ground = this.scene.screenPointToGround(x, y, this._interactGroundY);
        if (!ground) return;

        // Priority 1: collecting sun blobs that overlap the click point.
        var clickR2 = this._clickRadius * this._clickRadius;
        for (var i = 0; i < this._sunBlobs.length; i++) {
            var s = this._sunBlobs[i];
            var dx = s.x - ground.x, dz = s.z - ground.z;
            if (dx * dx + dz * dz < clickR2) {
                this._collectSunBlob(i);
                return; // single click, single blob
            }
        }

        // Priority 2: place an armed plant on the cell under the click.
        if (this._armedPlant) {
            var cell = this._worldToCell(ground.x, ground.z);
            if (cell) this._tryPlace(this._armedPlant, cell.col, cell.row);
        }
    }

    // ─── Plant arming + placement ──────────────────────────────────────

    _armPlant(plant) {
        if (!plant) return;
        var idx = this._plantKindToCardIdx[plant];
        if (idx == null) return;
        if (this._cardCooldowns[idx] > 0) return;
        if (this._sun < this._plantCardSunCost[idx]) return;
        this._armedPlant = plant;
        this.scene.events.game.emit("plant_armed", { plant: plant, cost: this._plantCardSunCost[idx] });
    }

    _clearArmed() {
        if (!this._armedPlant) return;
        this._armedPlant = "";
        this.scene.events.game.emit("plant_armed_cleared", {});
    }

    _tryPlace(plant, col, row) {
        if (col < 0 || col >= this._cols || row < 0 || row >= this._rows) {
            if (this.audio && this._plantBlockedSound) this.audio.playSound(this._plantBlockedSound, 0.35);
            return;
        }
        if (this._grid[col][row]) {
            if (this.audio && this._plantBlockedSound) this.audio.playSound(this._plantBlockedSound, 0.35);
            return;
        }
        var idx = this._plantKindToCardIdx[plant];
        if (idx == null) return;
        if (this._cardCooldowns[idx] > 0 || this._sun < this._plantCardSunCost[idx]) {
            if (this.audio && this._plantBlockedSound) this.audio.playSound(this._plantBlockedSound, 0.35);
            return;
        }
        // Spend, place, cooldown.
        this._sun -= this._plantCardSunCost[idx];
        this._cardCooldowns[idx] = this._plantCardCooldown[idx];
        this.scene.events.game.emit("sun_changed", { sun: this._sun, delta: -this._plantCardSunCost[idx] });
        this._spawnPlant(plant, col, row);
        this.scene.events.game.emit("plant_placed", { plant: plant, col: col, row: row });
        if (this.audio && this._plantPlaceSound) this.audio.playSound(this._plantPlaceSound, 0.45);
        this._clearArmed();
    }

    // ─── Plant spawning ────────────────────────────────────────────────

    _spawnPlant(plant, col, row) {
        var w = this._cellToWorld(col, row);
        var ids = [];
        var hp = this._sunflowerHp;
        if (plant === "sunflower") {
            hp = this._sunflowerHp;
            ids.push(this._spawnPart("Sun_stem_" + col + "_" + row, w.x, 0.6, w.z, [0.25, 1.2, 0.25], "cylinder", [0.18, 0.55, 0.20, 1]));
            ids.push(this._spawnPart("Sun_head_" + col + "_" + row, w.x, 1.4, w.z, [0.85, 0.85, 0.4], "sphere", [1.0, 0.85, 0.20, 1]));
        } else if (plant === "peashooter") {
            hp = this._peashooterHp;
            ids.push(this._spawnPart("Pea_stem_" + col + "_" + row, w.x, 0.75, w.z, [0.30, 1.5, 0.30], "cylinder", [0.16, 0.62, 0.22, 1]));
            ids.push(this._spawnPart("Pea_head_" + col + "_" + row, w.x, 1.7, w.z, [0.85, 0.85, 0.85], "sphere", [0.20, 0.75, 0.30, 1]));
        } else if (plant === "wallnut") {
            hp = this._wallnutHp;
            ids.push(this._spawnPart("Wall_body_" + col + "_" + row, w.x, 0.55, w.z, [1.0, 1.05, 1.0], "sphere", [0.65, 0.42, 0.22, 1]));
        } else if (plant === "cherry") {
            hp = this._cherryHp;
            ids.push(this._spawnPart("Cherry_a_" + col + "_" + row, w.x - 0.18, 0.6, w.z, [0.65, 0.65, 0.65], "sphere", [0.92, 0.20, 0.18, 1]));
            ids.push(this._spawnPart("Cherry_b_" + col + "_" + row, w.x + 0.18, 0.6, w.z, [0.65, 0.65, 0.65], "sphere", [0.85, 0.16, 0.14, 1]));
            ids.push(this._spawnPart("Cherry_stem_" + col + "_" + row, w.x, 1.0, w.z, [0.10, 0.6, 0.10], "cylinder", [0.30, 0.42, 0.20, 1]));
        }
        this._grid[col][row] = {
            kind: plant,
            entityIds: ids,
            hp: hp,
            maxHp: hp,
            lastFireT: 0,
            lastProduceT: 0,
            fuseT: plant === "cherry" ? this._cherryDetonateDelay : 0,
        };
    }

    _spawnPart(name, x, y, z, scale, meshType, color) {
        var id = this.scene.createEntity ? this.scene.createEntity(name) : null;
        if (id == null) return -1;
        this.scene.setPosition(id, x, y, z);
        this.scene.setScale && this.scene.setScale(id, scale[0], scale[1], scale[2]);
        this.scene.addComponent(id, "MeshRendererComponent", {
            meshType: meshType,
            baseColor: color,
        });
        if (this.scene.addTag) this.scene.addTag(id, "plant_part");
        return id;
    }

    // ─── Plant tick ─────────────────────────────────────────────────────

    _tickPlants(dt) {
        for (var c = 0; c < this._cols; c++) {
            for (var r = 0; r < this._rows; r++) {
                var cell = this._grid[c][r];
                if (!cell) continue;
                if (cell.hp <= 0) {
                    this._destroyPlant(c, r);
                    continue;
                }
                if (cell.kind === "sunflower") {
                    cell.lastProduceT += dt;
                    if (cell.lastProduceT >= this._sunfowerProduceIntervalSec) {
                        cell.lastProduceT = 0;
                        var w = this._cellToWorld(c, r);
                        this._spawnSunBlob(w.x, w.z, /*fromSky=*/false);
                    }
                } else if (cell.kind === "peashooter") {
                    cell.lastFireT += dt;
                    if (cell.lastFireT >= this._peashooterFireInterval) {
                        // Only fire if there's a zombie ahead in this row.
                        var hasTarget = this._hasZombieInRowAheadOf(r, this._cellToWorld(c, r).x);
                        if (hasTarget) {
                            cell.lastFireT = 0;
                            this._fireProjectile(c, r);
                        }
                    }
                } else if (cell.kind === "cherry") {
                    cell.fuseT -= dt;
                    if (cell.fuseT <= 0) this._detonateCherry(c, r);
                }
            }
        }
    }

    _hasZombieInRowAheadOf(row, x) {
        var laneZ = this._rowToZ(row);
        for (var i = 0; i < this._zombies.length; i++) {
            var z = this._zombies[i];
            if (z.row !== row) continue;
            if (z.x > x - 0.4) return true; // small bias so the very-edge zombie still counts
        }
        return false;
    }

    _fireProjectile(col, row) {
        var w = this._cellToWorld(col, row);
        var name = "Pea_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        var id = this.scene.createEntity ? this.scene.createEntity(name) : null;
        if (id == null) return;
        this.scene.setPosition(id, w.x + 0.4, 1.4, w.z);
        this.scene.setScale && this.scene.setScale(id, 0.3, 0.3, 0.3);
        this.scene.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: [0.20, 0.85, 0.30, 1],
        });
        if (this.scene.addTag) this.scene.addTag(id, "projectile");
        this._projectiles.push({
            id: id, x: w.x + 0.4, y: 1.4, z: w.z,
            vx: this._projectileSpeed, damage: this._peashooterDamage,
            row: row, life: this._peashooterRange / this._projectileSpeed,
        });
        if (this.audio && this._peaShootSound) this.audio.playSound(this._peaShootSound, 0.18);
    }

    _detonateCherry(col, row) {
        var w = this._cellToWorld(col, row);
        // Hit every zombie within radius — kill counts apply via the
        // generic damage path.
        var r2 = this._cherryRadius * this._cherryRadius;
        for (var i = this._zombies.length - 1; i >= 0; i--) {
            var z = this._zombies[i];
            var dx = z.x - w.x, dz = (this._rowToZ(z.row)) - w.z;
            if (dx * dx + dz * dz < r2) {
                this._damageZombie(i, this._cherryDamage);
            }
        }
        // Big explosion FX — bright orange sphere expanding briefly.
        var name = "Boom_" + col + "_" + row;
        var id = this.scene.createEntity ? this.scene.createEntity(name) : null;
        if (id != null) {
            this.scene.setPosition(id, w.x, 1.0, w.z);
            this.scene.setScale && this.scene.setScale(id, this._cherryRadius * 0.8, this._cherryRadius * 0.8, this._cherryRadius * 0.8);
            this.scene.addComponent(id, "MeshRendererComponent", {
                meshType: "sphere",
                baseColor: [1.0, 0.55, 0.18, 1],
            });
            if (this.scene.addTag) this.scene.addTag(id, "fx");
            this._explosions.push({ id: id, life: 0.5 });
        }
        if (this.audio && this._cherryBoomSound) this.audio.playSound(this._cherryBoomSound, 0.7);
        this.scene.events.game.emit("cherry_detonated", { col: col, row: row });
        this._destroyPlant(col, row);
    }

    _destroyPlant(col, row) {
        var cell = this._grid[col][row];
        if (!cell) return;
        this._destroyAll(cell.entityIds);
        this._grid[col][row] = null;
        this.scene.events.game.emit("plant_destroyed", { col: col, row: row });
    }

    // ─── Zombie spawn + tick ───────────────────────────────────────────

    _spawnZombie(kind) {
        var row = Math.floor(Math.random() * this._rows);
        var z = this._rowToZ(row);
        var hp = this._zombieWalkerHp;
        if (kind === "cone") hp = this._zombieConeHp;
        else if (kind === "bucket") hp = this._zombieBucketHp;

        var ids = [];
        var bodyName = "Zombie_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        var bodyId = this.scene.createEntity ? this.scene.createEntity(bodyName) : null;
        if (bodyId == null) return;
        this.scene.setPosition(bodyId, this._spawnColX, 0.0, z);
        this.scene.setScale && this.scene.setScale(bodyId, 0.7, 0.7, 0.7);
        // Custom mesh asset path set via meshAsset for the GLB; falls back
        // to a tinted capsule if the asset isn't loaded yet.
        this.scene.addComponent(bodyId, "MeshRendererComponent", {
            meshType: "custom",
            meshAsset: "/assets/quaternius/characters/zombie/Zombie.glb",
        });
        if (this.scene.addTag) {
            this.scene.addTag(bodyId, "zombie");
            this.scene.addTag(bodyId, "hostile");
        }
        // Face left (toward -X) so the zombie is walking the right way.
        var bodyEnt = this.scene.findEntityByName ? this.scene.findEntityByName(bodyName) : null;
        if (bodyEnt && bodyEnt.transform && bodyEnt.transform.setRotationEuler) {
            bodyEnt.transform.setRotationEuler(0, 90, 0);
            bodyEnt.transform.markDirty && bodyEnt.transform.markDirty();
        }
        ids.push(bodyId);

        // Optional hat for cone / bucket variants — tracks the body's
        // x/z each frame.
        var hatId = null;
        if (kind === "cone") {
            hatId = this.scene.createEntity ? this.scene.createEntity("Hat_" + bodyName) : null;
            if (hatId != null) {
                this.scene.setPosition(hatId, this._spawnColX, 1.1, z);
                this.scene.setScale && this.scene.setScale(hatId, 0.35, 0.5, 0.35);
                this.scene.addComponent(hatId, "MeshRendererComponent", {
                    meshType: "cone",
                    baseColor: [1.0, 0.55, 0.20, 1],
                });
                if (this.scene.addTag) this.scene.addTag(hatId, "fx");
                ids.push(hatId);
            }
        } else if (kind === "bucket") {
            hatId = this.scene.createEntity ? this.scene.createEntity("Hat_" + bodyName) : null;
            if (hatId != null) {
                this.scene.setPosition(hatId, this._spawnColX, 1.0, z);
                this.scene.setScale && this.scene.setScale(hatId, 0.42, 0.35, 0.42);
                this.scene.addComponent(hatId, "MeshRendererComponent", {
                    meshType: "cylinder",
                    baseColor: [0.62, 0.62, 0.65, 1],
                });
                if (this.scene.addTag) this.scene.addTag(hatId, "fx");
                ids.push(hatId);
            }
        }

        this._zombies.push({
            id: bodyId,
            entityIds: ids,
            hatId: hatId,
            kind: kind,
            row: row,
            x: this._spawnColX,
            hp: hp,
            maxHp: hp,
            lastAttackT: 0,
            attacking: false,
        });
        this.scene.events.game.emit("zombie_spawned", { kind: kind, row: row });
    }

    _tickZombies(dt) {
        for (var i = this._zombies.length - 1; i >= 0; i--) {
            var z = this._zombies[i];
            // Look for a plant in the same row immediately ahead. If
            // present, stop and chew it; otherwise keep marching left.
            var blockingCol = this._plantImmediatelyAhead(z.x, z.row);
            if (blockingCol != null) {
                z.attacking = true;
                z.lastAttackT += dt;
                if (z.lastAttackT >= this._zombieAttackInterval) {
                    z.lastAttackT = 0;
                    var cell = this._grid[blockingCol][z.row];
                    if (cell) {
                        cell.hp -= this._zombieAttackDamage;
                        if (this.audio && this._zombieMunchSound) this.audio.playSound(this._zombieMunchSound, 0.22);
                        if (cell.hp <= 0) this._destroyPlant(blockingCol, z.row);
                    }
                }
            } else {
                z.attacking = false;
                z.x -= this._zombieMoveSpeed * dt;
            }
            // Keep entity transforms in sync — body + optional hat ride
            // along the same x. y stays 0 for body, hat above.
            this.scene.setPosition(z.id, z.x, 0.0, this._rowToZ(z.row));
            if (z.hatId != null) {
                var hatY = z.kind === "cone" ? 1.1 : 1.0;
                this.scene.setPosition(z.hatId, z.x, hatY, this._rowToZ(z.row));
            }
            // House crossed → instant loss.
            if (z.x <= this._houseColX) {
                this.scene.events.game.emit("zombie_reached_house", { row: z.row });
                this._endGame(false, "overrun");
                return;
            }
        }
    }

    _plantImmediatelyAhead(zombieX, row) {
        // The "ahead" check fires when the zombie's x is within ~half a
        // cell of a plant's x. Plants live at world positions derived
        // from their grid cell, so it's a per-row scan.
        for (var c = 0; c < this._cols; c++) {
            var cell = this._grid[c][row];
            if (!cell) continue;
            var px = this._cellToWorld(c, row).x;
            if (Math.abs(zombieX - px) < 0.65 && zombieX >= px - 0.05) return c;
        }
        return null;
    }

    _damageZombie(idx, amount) {
        var z = this._zombies[idx];
        if (!z) return;
        z.hp -= amount;
        if (z.hp <= 0) {
            this._killZombie(idx);
        }
    }

    _killZombie(idx) {
        var z = this._zombies[idx];
        if (!z) return;
        this._destroyAll(z.entityIds);
        this._zombies.splice(idx, 1);
        if (this.audio && this._zombieDieSound) this.audio.playSound(this._zombieDieSound, 0.32);
        this.scene.events.game.emit("zombie_killed", { kind: z.kind, row: z.row });
    }

    // ─── Projectiles ───────────────────────────────────────────────────

    _tickProjectiles(dt) {
        for (var i = this._projectiles.length - 1; i >= 0; i--) {
            var p = this._projectiles[i];
            p.life -= dt;
            p.x += p.vx * dt;
            this.scene.setPosition(p.id, p.x, p.y, p.z);
            // Out of range — despawn quietly.
            if (p.life <= 0 || p.x > this._spawnColX + 1) {
                this._destroyEntity(p.id);
                this._projectiles.splice(i, 1);
                continue;
            }
            // Hit check against zombies in the same row.
            var hit = -1;
            for (var z = 0; z < this._zombies.length; z++) {
                var zz = this._zombies[z];
                if (zz.row !== p.row) continue;
                if (Math.abs(zz.x - p.x) < 0.55) { hit = z; break; }
            }
            if (hit >= 0) {
                if (this.audio && this._peaHitSound) this.audio.playSound(this._peaHitSound, 0.25);
                this._damageZombie(hit, p.damage);
                this._destroyEntity(p.id);
                this._projectiles.splice(i, 1);
            }
        }
    }

    // ─── Sun blobs ─────────────────────────────────────────────────────

    _spawnSkySun() {
        // Pick a random column to drop on, then random row jitter so it
        // doesn't always land in the same spot.
        var col = Math.floor(Math.random() * this._cols);
        var row = Math.floor(Math.random() * this._rows);
        var w = this._cellToWorld(col, row);
        this._spawnSunBlob(w.x, w.z, /*fromSky=*/true);
    }

    _spawnSunBlob(x, z, fromSky) {
        var startY = fromSky ? 9.0 : 1.4;
        var name = "Sun_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        var id = this.scene.createEntity ? this.scene.createEntity(name) : null;
        if (id == null) return;
        this.scene.setPosition(id, x, startY, z);
        this.scene.setScale && this.scene.setScale(id, 1.1, 1.1, 1.1);
        this.scene.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: [1.0, 0.88, 0.18, 1],
        });
        if (this.scene.addTag) this.scene.addTag(id, "sun_blob");
        this._sunBlobs.push({
            id: id, x: x, z: z, y: startY, vy: 0, age: 0, landedAge: 0, fromSky: !!fromSky,
        });
        this.scene.events.game.emit("sun_blob_spawned", { x: x, z: z, fromSky: !!fromSky });
    }

    _tickSunBlobs(dt) {
        for (var i = this._sunBlobs.length - 1; i >= 0; i--) {
            var s = this._sunBlobs[i];
            s.age += dt;
            // Fall to ground if from-sky; sunflower-produced ones already
            // at near-ground.
            if (s.y > 0.45) {
                s.y -= this._sunFallSpeed * dt;
                if (s.y < 0.45) s.y = 0.45;
                this.scene.setPosition(s.id, s.x, s.y, s.z);
            } else {
                // Auto-collect a short moment after landing so sunflower
                // income actually lands in the bank even if the player
                // never reaches the blob with the cursor. Click-to-
                // collect still works instantly via the cursor_click handler.
                s.landedAge += dt;
                if (s.landedAge >= this._sunAutoCollectDelay) {
                    this._collectSunBlob(i);
                    continue;
                }
            }
            if (s.age >= this._sunBlobLifetimeSec) {
                this._destroyEntity(s.id);
                this._sunBlobs.splice(i, 1);
            }
        }
    }

    _collectSunBlob(idx) {
        var s = this._sunBlobs[idx];
        if (!s) return;
        this._destroyEntity(s.id);
        this._sunBlobs.splice(idx, 1);
        this._sun += this._sunDropAmount;
        this.scene.events.game.emit("sun_blob_collected", { amount: this._sunDropAmount, x: s.x, z: s.z });
        this.scene.events.game.emit("sun_changed", { sun: this._sun, delta: this._sunDropAmount });
        if (this.audio && this._sunPickupSound) this.audio.playSound(this._sunPickupSound, 0.32);
    }

    // ─── Explosions ────────────────────────────────────────────────────

    _tickExplosions(dt) {
        for (var i = this._explosions.length - 1; i >= 0; i--) {
            var e = this._explosions[i];
            e.life -= dt;
            if (e.life <= 0) {
                this._destroyEntity(e.id);
                this._explosions.splice(i, 1);
            }
        }
    }

    // ─── Game over ─────────────────────────────────────────────────────

    _endGame(victory, reason) {
        if (this._gameOver) return;
        this._gameOver = true;
        this._won = !!victory;
        var title = victory ? "GARDEN HELD" : "OVERRUN";
        var stats = {
            "Wave Reached": this._waveIdx + " / " + this._totalWaves,
            "Sun Banked": String(this._sun),
            "Reason": reason,
        };
        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: this._waveIdx, stats: stats },
        });
        if (victory) {
            this.scene.events.game.emit("game_won", { score: this._waveIdx });
            if (this.audio && this._winSound) this.audio.playSound(this._winSound, 0.6);
        } else {
            this.scene.events.game.emit("game_over", { score: this._waveIdx });
            if (this.audio && this._loseSound) this.audio.playSound(this._loseSound, 0.6);
        }
    }

    // ─── HUD push ──────────────────────────────────────────────────────

    _publishHud() {
        var costs = this._plantCardSunCost;
        var cds = this._cardCooldowns;
        var aliveZombies = this._zombies.length;
        var queueRemaining = this._waveQueue.length;
        this.scene.events.ui.emit("hud_update", {
            lawnHud: {
                sun: this._sun,
                wave: this._waveIdx,
                totalWaves: this._totalWaves,
                aliveZombies: aliveZombies,
                queueRemaining: queueRemaining,
                armed: this._armedPlant || "",
                cards: [
                    { kind: "sunflower",  cost: costs[0], cooldown: Math.max(0, cds[0]), maxCooldown: this._plantCardCooldown[0], affordable: this._sun >= costs[0] && cds[0] <= 0 },
                    { kind: "peashooter", cost: costs[1], cooldown: Math.max(0, cds[1]), maxCooldown: this._plantCardCooldown[1], affordable: this._sun >= costs[1] && cds[1] <= 0 },
                    { kind: "wallnut",    cost: costs[2], cooldown: Math.max(0, cds[2]), maxCooldown: this._plantCardCooldown[2], affordable: this._sun >= costs[2] && cds[2] <= 0 },
                    { kind: "cherry",     cost: costs[3], cooldown: Math.max(0, cds[3]), maxCooldown: this._plantCardCooldown[3], affordable: this._sun >= costs[3] && cds[3] <= 0 },
                ],
                hover: this._hoverCell ? { col: this._hoverCell.col, row: this._hoverCell.row, valid: !this._grid[this._hoverCell.col][this._hoverCell.row] } : null,
            },
        });
    }

    // ─── Helpers ───────────────────────────────────────────────────────

    _cellToWorld(col, row) {
        // 9 cols centered around x=0 (so col 4 lands at x=0). Actually
        // we want col=0 at x = -(cols-1)*cellSize/2 + 0.5*cellSize. For
        // cols=9, cellSize=1.4 → col 0 at x=-5.6, col 4 at x=0.
        var midCol = (this._cols - 1) * 0.5;
        var midRow = (this._rows - 1) * 0.5;
        return {
            x: (col - midCol) * this._cellSize,
            z: (row - midRow) * this._cellSize,
        };
    }

    _worldToCell(x, z) {
        var midCol = (this._cols - 1) * 0.5;
        var midRow = (this._rows - 1) * 0.5;
        var col = Math.round(x / this._cellSize + midCol);
        var row = Math.round(z / this._cellSize + midRow);
        if (col < 0 || col >= this._cols) return null;
        if (row < 0 || row >= this._rows) return null;
        return { col: col, row: row };
    }

    _rowToZ(row) {
        return ((row - (this._rows - 1) * 0.5) * this._cellSize);
    }

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
