// also: strategy, waves, enemies, gold, rounds, economy
// Tower defense engine — wave spawning, tower placement/targeting, economy, lives
class TDEngineSystem extends GameScript {
    _startGold = 500;
    _startLives = 20;
    _totalWaves = 10;

    // State
    _gold = 500;
    _lives = 20;
    _wave = 0;
    _waveActive = false;
    _gameActive = false;
    _gameWon = false;
    _gameLost = false;

    // Tower spots
    _spots = [];
    _selectedSpot = 0;
    _cursorEntity = null;

    // Click-to-place state
    _armedTower = "";  // tower type the user has "armed" via the HUD palette
    _spotClickRadius = 5; // world-units tolerance for clicking near a spot center

    // Active enemies and towers
    _enemies = [];
    _towers = [];

    // Waypoints
    _waypoints = [];

    // Wave spawning
    _waveData = [];
    _spawnQueue = [];
    _spawnTimer = 0;
    _spawnInterval = 0.8;

    // Tower definitions
    _towerDefs = {};
    _enemyStats = {};

    onStart() {
        var self = this;

        // S-shaped path waypoints
        this._waypoints = [
            [-25, 0, 12],
            [12, 0, 12],
            [12, 0, 0],
            [-12, 0, 0],
            [-12, 0, -12],
            [12, 0, -12],
            [27, 0, -12]
        ];

        // 12 buildable tower spots between path segments
        this._spots = [
            { x: -8, z: 8, towerId: null, towerType: null, towerLevel: 0 },
            { x: 2, z: 8, towerId: null, towerType: null, towerLevel: 0 },
            { x: 8, z: 16, towerId: null, towerType: null, towerLevel: 0 },
            { x: 16, z: 6, towerId: null, towerType: null, towerLevel: 0 },
            { x: 6, z: 4, towerId: null, towerType: null, towerLevel: 0 },
            { x: -2, z: 4, towerId: null, towerType: null, towerLevel: 0 },
            { x: -8, z: 4, towerId: null, towerType: null, towerLevel: 0 },
            { x: -16, z: -6, towerId: null, towerType: null, towerLevel: 0 },
            { x: -6, z: -8, towerId: null, towerType: null, towerLevel: 0 },
            { x: 2, z: -8, towerId: null, towerType: null, towerLevel: 0 },
            { x: 6, z: -16, towerId: null, towerType: null, towerLevel: 0 },
            { x: 16, z: -6, towerId: null, towerType: null, towerLevel: 0 }
        ];

        // Tower type definitions
        this._towerDefs = {
            arrow:     { cost: 100, damage: 8,  range: 8,  fireRate: 0.6, upgradeCost: 75,  upgDmg: 4,  upgRange: 2, entity: "tower_arrow",     special: "single" },
            cannon:    { cost: 200, damage: 20, range: 6,  fireRate: 1.5, upgradeCost: 150, upgDmg: 10, upgRange: 1, entity: "tower_cannon",    special: "splash",    splashRadius: 3 },
            ice:       { cost: 150, damage: 3,  range: 7,  fireRate: 1.0, upgradeCost: 100, upgDmg: 1,  upgRange: 1, entity: "tower_ice",       special: "slow",      slowFactor: 0.5, slowDuration: 2 },
            lightning: { cost: 300, damage: 15, range: 10, fireRate: 2.0, upgradeCost: 200, upgDmg: 10, upgRange: 1, entity: "tower_lightning", special: "chain",     chainCount: 3 }
        };

        // Enemy type stats
        this._enemyStats = {
            enemy_goblin:   { health: 30,  speed: 5,   reward: 10,  liveCost: 1 },
            enemy_slime:    { health: 80,  speed: 2.5, reward: 20,  liveCost: 2 },
            enemy_skeleton: { health: 120, speed: 3.5, reward: 30,  liveCost: 3 },
            enemy_dragon:   { health: 500, speed: 2,   reward: 100, liveCost: 5 }
        };

        // 10 escalating waves
        this._waveData = [
            [{ type: "enemy_goblin", count: 6 }],
            [{ type: "enemy_goblin", count: 10 }],
            [{ type: "enemy_goblin", count: 8 }, { type: "enemy_slime", count: 3 }],
            [{ type: "enemy_slime", count: 8 }],
            [{ type: "enemy_goblin", count: 10 }, { type: "enemy_slime", count: 5 }],
            [{ type: "enemy_skeleton", count: 5 }, { type: "enemy_goblin", count: 8 }],
            [{ type: "enemy_skeleton", count: 8 }, { type: "enemy_slime", count: 6 }],
            [{ type: "enemy_goblin", count: 12 }, { type: "enemy_skeleton", count: 8 }, { type: "enemy_slime", count: 4 }],
            [{ type: "enemy_skeleton", count: 12 }, { type: "enemy_slime", count: 8 }],
            [{ type: "enemy_dragon", count: 2 }, { type: "enemy_skeleton", count: 10 }, { type: "enemy_goblin", count: 15 }]
        ];

        this.scene.events.game.on("game_ready", function() {
            self._fullReset();
        });

        this.scene.events.game.on("restart_game", function() {
            self._fullReset();
        });

        // World-click handling is event-driven so the click coords match
        // what the user actually touched. ui_bridge emits cursor_click /
        // cursor_right_click with the freshest canvas-relative pointer
        // position; polling MouseLeft against a cached _cursorX/Y from
        // cursor_move loses the tap-frame coords on touch devices, where
        // a tap is the only event that moves the cursor.
        this.scene.events.ui.on("cursor_click", function(d) {
            if (!d) return;
            self._handleWorldClick(d.x, d.y);
        });
        this.scene.events.ui.on("cursor_right_click", function() {
            self._clearArmed();
        });

        // HUD click handlers — mirror keyboard shortcuts so the game is
        // fully playable with the mouse alone.
        this.scene.events.ui.on("ui_event:hud/td_hud:select_spot", function(d) {
            var p = (d && d.payload) || {};
            if (typeof p.index === "number" && p.index >= 0 && p.index < self._spots.length) {
                self._selectedSpot = p.index;
                self._moveCursor();
                if (self.audio) self.audio.playSound("/assets/kenney/audio/interface_sounds/drop_002.ogg", 0.2);
            }
        });
        this.scene.events.ui.on("ui_event:hud/td_hud:spot_prev", function() {
            self._selectedSpot = (self._selectedSpot - 1 + self._spots.length) % self._spots.length;
            self._moveCursor();
            if (self.audio) self.audio.playSound("/assets/kenney/audio/interface_sounds/drop_002.ogg", 0.2);
        });
        this.scene.events.ui.on("ui_event:hud/td_hud:spot_next", function() {
            self._selectedSpot = (self._selectedSpot + 1) % self._spots.length;
            self._moveCursor();
            if (self.audio) self.audio.playSound("/assets/kenney/audio/interface_sounds/drop_002.ogg", 0.2);
        });
        // Clicking a tower card "arms" the type — the next world click on a
        // spot will place it there. Clicking the same card again disarms.
        // If no spot click follows, the keyboard 1-4 path still works.
        this.scene.events.ui.on("ui_event:hud/td_hud:build_tower", function(d) {
            var p = (d && d.payload) || {};
            if (!p.type) return;
            if (self._armedTower === p.type) {
                self._clearArmed();
            } else {
                self._armTower(p.type);
            }
        });
        this.scene.events.ui.on("ui_event:hud/td_hud:upgrade_tower", function() {
            self._upgradeTower();
        });
        this.scene.events.ui.on("ui_event:hud/td_hud:sell_tower", function() {
            self._sellTower();
        });
        this.scene.events.ui.on("ui_event:hud/td_hud:start_wave", function() {
            if (!self._waveActive) self._startWave();
        });

        this._cursorEntity = this.scene.findEntityByName("TowerCursor");
        this._fullReset();
    }

    _fullReset() {
        // Destroy spawned entities
        var i;
        for (i = 0; i < this._enemies.length; i++) {
            if (this._enemies[i].entity) this._enemies[i].entity.active = false;
        }
        for (i = 0; i < this._towers.length; i++) {
            if (this._towers[i].entity) this._towers[i].entity.active = false;
        }
        this._enemies = [];
        this._towers = [];

        // Reset spots
        for (i = 0; i < this._spots.length; i++) {
            this._spots[i].towerId = null;
            this._spots[i].towerType = null;
            this._spots[i].towerLevel = 0;
        }

        this._gold = this._startGold;
        this._lives = this._startLives;
        this._wave = 0;
        this._waveActive = false;
        this._gameActive = true;
        this._gameWon = false;
        this._gameLost = false;
        this._spawnQueue = [];
        this._spawnTimer = 0;
        this._selectedSpot = 0;

        this._moveCursor();
        this._updateHud();
    }

    /* ================================================================
     *  MAIN LOOP
     * ================================================================ */
    onUpdate(dt) {
        if (!this._gameActive) return;

        this._handleInput();

        // Wave spawning
        if (this._waveActive && this._spawnQueue.length > 0) {
            this._spawnTimer -= dt;
            if (this._spawnTimer <= 0) {
                this._spawnNextEnemy();
                this._spawnTimer = this._spawnInterval;
            }
        }

        this._updateEnemies(dt);
        this._updateTowers(dt);

        // Wave complete check
        if (this._waveActive && this._spawnQueue.length === 0 && this._enemies.length === 0) {
            this._waveActive = false;
            if (this._wave >= this._totalWaves) {
                this._winGame();
                return;
            }
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_004.ogg", 0.5);
        }

        // Lives check
        if (this._lives <= 0 && !this._gameLost) {
            this._loseGame();
            return;
        }

        this._updateHud();
    }

    /* ================================================================
     *  INPUT
     * ================================================================ */
    _handleInput() {
        // Cycle tower spots with Q / E
        if (this.input.isKeyPressed("KeyQ")) {
            this._selectedSpot = (this._selectedSpot - 1 + this._spots.length) % this._spots.length;
            this._moveCursor();
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/drop_002.ogg", 0.2);
        }
        if (this.input.isKeyPressed("KeyE")) {
            this._selectedSpot = (this._selectedSpot + 1) % this._spots.length;
            this._moveCursor();
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/drop_002.ogg", 0.2);
        }

        // Build towers 1-4 (immediate at currently selected spot — keeps
        // keyboard play snappy without going through arm/aim).
        if (this.input.isKeyPressed("Digit1")) this._buildTower("arrow");
        if (this.input.isKeyPressed("Digit2")) this._buildTower("cannon");
        if (this.input.isKeyPressed("Digit3")) this._buildTower("ice");
        if (this.input.isKeyPressed("Digit4")) this._buildTower("lightning");

        // Upgrade with U
        if (this.input.isKeyPressed("KeyU")) this._upgradeTower();

        // Sell with X
        if (this.input.isKeyPressed("KeyX")) this._sellTower();

        // Start wave with Space
        if (this.input.isKeyPressed("Space") && !this._waveActive) {
            this._startWave();
        }

        // Cancel armed placement.
        if (this.input.isKeyPressed("Escape")) {
            this._clearArmed();
        }
    }

    _handleWorldClick(sx, sy) {
        if (!this.scene.screenPointToGround) return;
        var ground = this.scene.screenPointToGround(sx, sy, 0);
        if (!ground) return;

        var spot = this._findSpotNear(ground.x, ground.z);
        if (spot < 0) {
            // Empty-space click while armed — disarm so the player isn't
            // stuck in placement mode after a stray miss.
            if (this._armedTower) this._clearArmed();
            return;
        }

        this._selectedSpot = spot;
        this._moveCursor();

        if (this._armedTower) {
            var t = this._armedTower;
            // Single-shot arm: clear before building so a failed build
            // (occupied / unaffordable) doesn't leave a stale armed state.
            this._clearArmed();
            this._buildTower(t);
        }
    }

    _findSpotNear(x, z) {
        var nearest = -1;
        var nearDist = this._spotClickRadius * this._spotClickRadius;
        for (var i = 0; i < this._spots.length; i++) {
            var sp = this._spots[i];
            var dx = sp.x - x;
            var dz = sp.z - z;
            var d = dx * dx + dz * dz;
            if (d < nearDist) {
                nearDist = d;
                nearest = i;
            }
        }
        return nearest;
    }

    _armTower(type) {
        var def = this._towerDefs[type];
        if (!def) return;
        // Soft-arm even if unaffordable so the HUD can show the cost
        // gating; the actual build call will reject and disarm.
        this._armedTower = type;
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_001.ogg", 0.25);
    }

    _clearArmed() {
        if (!this._armedTower) return;
        this._armedTower = "";
    }

    _moveCursor() {
        if (!this._cursorEntity) {
            this._cursorEntity = this.scene.findEntityByName("TowerCursor");
        }
        if (!this._cursorEntity) return;
        var spot = this._spots[this._selectedSpot];
        this.scene.setPosition(this._cursorEntity.id, spot.x, 0.15, spot.z);
    }

    /* ================================================================
     *  TOWER MANAGEMENT
     * ================================================================ */
    _buildTower(type) {
        var spot = this._spots[this._selectedSpot];
        if (spot.towerId !== null) {
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/error_004.ogg", 0.3);
            return;
        }

        var def = this._towerDefs[type];
        if (!def) return;
        if (this._gold < def.cost) {
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/error_004.ogg", 0.35);
            return;
        }

        this._gold -= def.cost;

        var tower = this.scene.spawnEntity(def.entity);
        if (tower) {
            this.scene.setPosition(tower.id, spot.x, 0, spot.z);

            spot.towerId = tower.id;
            spot.towerType = type;
            spot.towerLevel = 1;

            this._towers.push({
                entity: tower,
                spotIndex: this._selectedSpot,
                type: type,
                level: 1,
                damage: def.damage,
                range: def.range,
                fireRate: def.fireRate,
                cooldown: 0,
                special: def.special,
                splashRadius: def.splashRadius || 0,
                slowFactor: def.slowFactor || 1,
                slowDuration: def.slowDuration || 0,
                chainCount: def.chainCount || 1
            });

            if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/metalClick.ogg", 0.5);
            this.scene.events.game.emit("tower_placed", { towerType: type });
        }
    }

    _upgradeTower() {
        var spot = this._spots[this._selectedSpot];
        if (spot.towerId === null || spot.towerLevel >= 2) {
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/error_004.ogg", 0.3);
            return;
        }

        var def = this._towerDefs[spot.towerType];
        if (!def || this._gold < def.upgradeCost) {
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/error_004.ogg", 0.35);
            return;
        }

        this._gold -= def.upgradeCost;
        spot.towerLevel = 2;

        for (var i = 0; i < this._towers.length; i++) {
            if (this._towers[i].entity && this._towers[i].entity.id === spot.towerId) {
                this._towers[i].level = 2;
                this._towers[i].damage += def.upgDmg;
                this._towers[i].range += def.upgRange;
                // Upgrade slow/chain if applicable
                if (this._towers[i].special === "slow") this._towers[i].slowFactor = 0.35;
                if (this._towers[i].special === "chain") this._towers[i].chainCount = 4;
                break;
            }
        }

        if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/metalLatch.ogg", 0.5);
        this.scene.events.game.emit("tower_upgraded", {});
    }

    _sellTower() {
        var spot = this._spots[this._selectedSpot];
        if (spot.towerId === null) return;

        var def = this._towerDefs[spot.towerType];
        var refund = Math.floor(def.cost * 0.5);
        if (spot.towerLevel >= 2) refund += Math.floor(def.upgradeCost * 0.5);

        this._gold += refund;

        for (var i = this._towers.length - 1; i >= 0; i--) {
            if (this._towers[i].entity && this._towers[i].entity.id === spot.towerId) {
                this._towers[i].entity.active = false;
                this._towers.splice(i, 1);
                break;
            }
        }

        spot.towerId = null;
        spot.towerType = null;
        spot.towerLevel = 0;

        if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/handleCoins.ogg", 0.5);
        this.scene.events.game.emit("tower_sold", {});
    }

    /* ================================================================
     *  WAVE SPAWNING
     * ================================================================ */
    _startWave() {
        if (this._wave >= this._totalWaves) return;
        this._wave++;
        this._waveActive = true;
        this._spawnQueue = [];
        this._spawnTimer = 0.6;

        var waveDef = this._waveData[this._wave - 1];
        for (var g = 0; g < waveDef.length; g++) {
            for (var e = 0; e < waveDef[g].count; e++) {
                this._spawnQueue.push(waveDef[g].type);
            }
        }

        // Shuffle for variety
        for (var i = this._spawnQueue.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = this._spawnQueue[i];
            this._spawnQueue[i] = this._spawnQueue[j];
            this._spawnQueue[j] = tmp;
        }

        // Speed up spawn rate in later waves
        this._spawnInterval = Math.max(0.35, 0.8 - this._wave * 0.04);

        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_002.ogg", 0.5);
        this.scene.events.game.emit("wave_started", { wave: this._wave });
    }

    _spawnNextEnemy() {
        if (this._spawnQueue.length === 0) return;

        var type = this._spawnQueue.shift();
        var stats = this._enemyStats[type];
        if (!stats) return;

        var enemy = this.scene.spawnEntity(type);
        if (!enemy) return;

        var sp = this._waypoints[0];
        // Slight random offset to avoid stacking
        var offsetZ = (Math.random() - 0.5) * 1.5;
        this.scene.setPosition(enemy.id, sp[0], 0, sp[2] + offsetZ);

        if (enemy.playAnimation) {
            enemy.playAnimation("Walk", { loop: true });
        }

        this._enemies.push({
            entity: enemy,
            health: stats.health,
            maxHealth: stats.health,
            speed: stats.speed,
            reward: stats.reward,
            liveCost: stats.liveCost,
            waypointIndex: 1,
            slowed: false,
            slowTimer: 0,
            slowFactor: 1
        });
    }

    /* ================================================================
     *  ENEMY UPDATE — waypoint movement
     * ================================================================ */
    _updateEnemies(dt) {
        for (var i = this._enemies.length - 1; i >= 0; i--) {
            var e = this._enemies[i];
            if (!e.entity || !e.entity.active) {
                this._enemies.splice(i, 1);
                continue;
            }

            // Slow timer
            if (e.slowed) {
                e.slowTimer -= dt;
                if (e.slowTimer <= 0) {
                    e.slowed = false;
                    e.slowFactor = 1;
                }
            }

            var pos = e.entity.transform.position;
            var wp = this._waypoints[e.waypointIndex];

            var dx = wp[0] - pos.x;
            var dz = wp[2] - pos.z;
            var dist = Math.sqrt(dx * dx + dz * dz);

            // Reached waypoint?
            if (dist < 1.0) {
                e.waypointIndex++;
                if (e.waypointIndex >= this._waypoints.length) {
                    // Enemy reached exit — lose lives
                    this._lives -= e.liveCost;
                    e.entity.active = false;
                    this._enemies.splice(i, 1);
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaserDown1.ogg", 0.4);
                    this.scene.events.game.emit("enemy_reached_end", {});
                    continue;
                }
                wp = this._waypoints[e.waypointIndex];
                dx = wp[0] - pos.x;
                dz = wp[2] - pos.z;
                dist = Math.sqrt(dx * dx + dz * dz);
            }

            // Move
            if (dist > 0.01) {
                var speed = e.speed * e.slowFactor;
                this.scene.setPosition(e.entity.id,
                    pos.x + (dx / dist) * speed * dt,
                    pos.y,
                    pos.z + (dz / dist) * speed * dt
                );
                // Face direction
                e.entity.transform.setRotationEuler(0, Math.atan2(-dx, -dz) * 180 / Math.PI, 0);
            }
        }
    }

    /* ================================================================
     *  TOWER UPDATE — targeting & shooting
     * ================================================================ */
    _updateTowers(dt) {
        for (var t = 0; t < this._towers.length; t++) {
            var tw = this._towers[t];
            if (!tw.entity || !tw.entity.active) continue;

            tw.cooldown -= dt;
            if (tw.cooldown > 0) continue;

            var tp = tw.entity.transform.position;

            // Find target
            var target = this._findNearest(tp.x, tp.z, tw.range, null);
            if (!target) continue;

            tw.cooldown = tw.fireRate;

            // Rotate tower toward target
            var tdx = target.entity.transform.position.x - tp.x;
            var tdz = target.entity.transform.position.z - tp.z;
            tw.entity.transform.setRotationEuler(0, Math.atan2(-tdx, -tdz) * 180 / Math.PI, 0);

            // Apply damage by tower type
            switch (tw.special) {
                case "single":
                    this._damageEnemy(target, tw.damage);
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_000.ogg", 0.2);
                    break;

                case "splash":
                    this._damageEnemy(target, tw.damage);
                    var ep = target.entity.transform.position;
                    for (var s = 0; s < this._enemies.length; s++) {
                        if (this._enemies[s] === target) continue;
                        if (!this._enemies[s].entity || !this._enemies[s].entity.active) continue;
                        var sp = this._enemies[s].entity.transform.position;
                        var sd = Math.sqrt((ep.x - sp.x) * (ep.x - sp.x) + (ep.z - sp.z) * (ep.z - sp.z));
                        if (sd < tw.splashRadius) {
                            this._damageEnemy(this._enemies[s], Math.floor(tw.damage * 0.5));
                        }
                    }
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/explosionCrunch_000.ogg", 0.25);
                    break;

                case "slow":
                    this._damageEnemy(target, tw.damage);
                    target.slowed = true;
                    target.slowTimer = tw.slowDuration;
                    target.slowFactor = tw.slowFactor;
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/forceField_000.ogg", 0.18);
                    break;

                case "chain":
                    var chainHit = [target];
                    this._damageEnemy(target, tw.damage);
                    var last = target;
                    for (var c = 1; c < tw.chainCount; c++) {
                        var next = this._findNearest(
                            last.entity.transform.position.x,
                            last.entity.transform.position.z,
                            6, chainHit
                        );
                        if (!next) break;
                        this._damageEnemy(next, Math.floor(tw.damage * 0.7));
                        chainHit.push(next);
                        last = next;
                    }
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserLarge_000.ogg", 0.25);
                    break;
            }
        }
    }

    _findNearest(x, z, range, exclude) {
        var nearest = null;
        var nearDist = range + 1;
        for (var i = 0; i < this._enemies.length; i++) {
            var e = this._enemies[i];
            if (!e.entity || !e.entity.active) continue;
            if (exclude) {
                var skip = false;
                for (var ex = 0; ex < exclude.length; ex++) {
                    if (e === exclude[ex]) { skip = true; break; }
                }
                if (skip) continue;
            }
            var ep = e.entity.transform.position;
            var d = Math.sqrt((x - ep.x) * (x - ep.x) + (z - ep.z) * (z - ep.z));
            if (d < nearDist) {
                nearDist = d;
                nearest = e;
            }
        }
        return nearest;
    }

    _damageEnemy(enemyData, damage) {
        enemyData.health -= damage;
        if (enemyData.health <= 0 && enemyData.entity && enemyData.entity.active) {
            enemyData.entity.active = false;
            this._gold += enemyData.reward;
            this.scene.events.game.emit("entity_killed", {});
            if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/pepSound3.ogg", 0.25);
        }
    }

    /* ================================================================
     *  WIN / LOSE
     * ================================================================ */
    _winGame() {
        this._gameActive = false;
        this._gameWon = true;
        var towersBuilt = 0;
        for (var i = 0; i < this._spots.length; i++) {
            if (this._spots[i].towerId !== null) towersBuilt++;
        }
        this.scene.events.ui.emit("hud_update", {
            _gameOver: {
                title: "VICTORY!",
                score: this._gold + this._lives * 50,
                stats: {
                    "Waves Cleared": this._wave + " / " + this._totalWaves,
                    "Lives Remaining": "" + this._lives,
                    "Towers Built": "" + towersBuilt,
                    "Gold": "" + this._gold
                }
            }
        });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/congratulations.ogg", 0.6);
        this.scene.events.game.emit("game_won", {});
    }

    _loseGame() {
        this._gameActive = false;
        this._gameLost = true;
        this.scene.events.ui.emit("hud_update", {
            _gameOver: {
                title: "DEFEAT",
                score: 0,
                stats: {
                    "Reached Wave": "" + this._wave,
                    "Gold": "" + this._gold
                }
            }
        });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/game_over.ogg", 0.6);
        this.scene.events.game.emit("game_over", {});
    }

    /* ================================================================
     *  HUD UPDATE
     * ================================================================ */
    _updateHud() {
        var spot = this._spots[this._selectedSpot];
        var towerInfo = null;
        if (spot.towerType) {
            var def = this._towerDefs[spot.towerType];
            towerInfo = {
                type: spot.towerType,
                level: spot.towerLevel,
                canUpgrade: spot.towerLevel < 2,
                upgradeCost: def.upgradeCost,
                sellValue: Math.floor(def.cost * 0.5 + (spot.towerLevel >= 2 ? def.upgradeCost * 0.5 : 0))
            };
        }

        var spotsView = [];
        for (var s = 0; s < this._spots.length; s++) {
            spotsView.push({
                index: s,
                occupied: this._spots[s].towerId !== null,
                type: this._spots[s].towerType,
                level: this._spots[s].towerLevel
            });
        }

        this.scene.events.ui.emit("hud_update", {
            gold: this._gold,
            lives: this._lives,
            wave: this._wave,
            totalWaves: this._totalWaves,
            waveActive: this._waveActive,
            selectedSpot: this._selectedSpot + 1,
            selectedSpotIndex: this._selectedSpot,
            totalSpots: this._spots.length,
            spotOccupied: spot.towerId !== null,
            towerInfo: towerInfo,
            enemyCount: this._enemies.length,
            spawnRemaining: this._spawnQueue.length,
            armedTower: this._armedTower,
            spots: spotsView,
            towers: [
                { type: "arrow",     cost: this._towerDefs.arrow.cost,     affordable: this._gold >= this._towerDefs.arrow.cost },
                { type: "cannon",    cost: this._towerDefs.cannon.cost,    affordable: this._gold >= this._towerDefs.cannon.cost },
                { type: "ice",       cost: this._towerDefs.ice.cost,       affordable: this._gold >= this._towerDefs.ice.cost },
                { type: "lightning", cost: this._towerDefs.lightning.cost, affordable: this._gold >= this._towerDefs.lightning.cost }
            ],
            arrowCost: this._towerDefs.arrow.cost,
            cannonCost: this._towerDefs.cannon.cost,
            iceCost: this._towerDefs.ice.cost,
            lightningCost: this._towerDefs.lightning.cost
        });
    }
}

// Static-validator manifest — see engine headless invariant
// . Never called at runtime; the literal
// spawnEntity calls here let the invariant know these prefabs ARE used
// (the real spawn site uses a variable, e.g. spawnEntity(def.entity)).
function __spawnManifest() {
    this.scene.spawnEntity("enemy_goblin");
    this.scene.spawnEntity("enemy_slime");
    this.scene.spawnEntity("enemy_skeleton");
    this.scene.spawnEntity("enemy_dragon");
}
