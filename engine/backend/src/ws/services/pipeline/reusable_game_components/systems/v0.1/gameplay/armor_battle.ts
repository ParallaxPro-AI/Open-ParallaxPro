// Armor battle — wave-based tank combat with enemy AI, damage system, and repair
class ArmorBattleSystem extends GameScript {
    _totalWaves = 3;
    _mapHalf = 55;
    _hitConeThreshold = 0.82;

    // State
    _phase = "idle";
    _phaseTimer = 0;
    _wave = 0;
    _kills = 0;
    _totalKills = 0;
    _gameActive = false;
    _countdownVal = 3;

    // Player
    _playerTank = null;
    _playerHP = 250;
    _playerMaxHP = 250;

    // Enemies
    _enemies = [];
    _enemyDefs = {};
    _waveDefs = [];

    // Spawned scenery
    _spawned = [];

    onStart() {
        var self = this;

        this._enemyDefs = {
            light:  { entity: "enemy_tank_light",  hp: 100, speed: 8,  damage: 15, range: 35, fireRate: 2.5, detect: 40 },
            medium: { entity: "enemy_tank_medium", hp: 175, speed: 6,  damage: 25, range: 40, fireRate: 3.0, detect: 45 },
            heavy:  { entity: "enemy_tank_heavy",  hp: 300, speed: 4,  damage: 40, range: 50, fireRate: 4.0, detect: 50 }
        };

        this._waveDefs = [
            [{ type: "light", count: 3 }],
            [{ type: "light", count: 2 }, { type: "medium", count: 2 }],
            [{ type: "light", count: 2 }, { type: "medium", count: 2 }, { type: "heavy", count: 1 }]
        ];

        this.scene.events.game.on("game_ready", function() { self._fullReset(); });
        this.scene.events.game.on("restart_game", function() { self._fullReset(); });

        this.scene.events.game.on("tank_fired", function(data) {
            if (data.source === "player") self._playerFired(data);
        });

        this.scene.events.game.on("player_repair", function(data) {
            self._playerHP = Math.min(self._playerMaxHP, self._playerHP + (data.amount || 50));
        });

        this._playerTank = this.scene.findEntityByName("PlayerTank");
        this._fullReset();
    }

    _fullReset() {
        for (var i = 0; i < this._enemies.length; i++) {
            if (this._enemies[i].entity) this._enemies[i].entity.active = false;
        }
        this._enemies = [];
        this._wave = 0;
        this._kills = 0;
        this._totalKills = 0;
        this._playerHP = this._playerMaxHP;
        this._phase = "idle";
        this._phaseTimer = 0;
        this._gameActive = true;
        if (!this._playerTank) this._playerTank = this.scene.findEntityByName("PlayerTank");
        this._updateHud();
    }

    /* ==============================================================
     *  MAIN LOOP
     * ============================================================== */
    onUpdate(dt) {
        if (!this._gameActive) return;

        this._phaseTimer -= dt;

        switch (this._phase) {
            case "idle":
                this._startCountdown();
                break;
            case "countdown":
                var nv = Math.ceil(this._phaseTimer);
                if (nv !== this._countdownVal && nv > 0) {
                    this._countdownVal = nv;
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/select_006.ogg", 0.4);
                }
                if (this._phaseTimer <= 0) this._startWave();
                this._updateHud();
                break;
            case "battle":
                this._updateBattle(dt);
                this._updateHud();
                break;
            case "wave_clear":
                if (this._phaseTimer <= 0) {
                    if (this._wave >= this._totalWaves) {
                        this._victory();
                    } else {
                        this._startCountdown();
                    }
                }
                this._updateHud();
                break;
        }
    }

    /* ==============================================================
     *  PHASES
     * ============================================================== */
    _startCountdown() {
        this._wave++;
        this._phase = "countdown";
        this._phaseTimer = 3;
        this._countdownVal = 3;
        if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/round.ogg", 0.5);
    }

    _startWave() {
        this._phase = "battle";
        this._phaseTimer = -1;
        this._spawnWave();
        this.scene.events.game.emit("battle_start", {});
        this.scene.events.game.emit("wave_started", { wave: this._wave });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/go.ogg", 0.6);
    }

    _spawnWave() {
        var waveDef = this._waveDefs[this._wave - 1];
        var spawnAngles = [];
        var total = 0;
        for (var g = 0; g < waveDef.length; g++) total += waveDef[g].count;
        for (var a = 0; a < total; a++) spawnAngles.push((a / total) * Math.PI * 2 + Math.random() * 0.5);

        var idx = 0;
        for (var g = 0; g < waveDef.length; g++) {
            var def = this._enemyDefs[waveDef[g].type];
            for (var e = 0; e < waveDef[g].count; e++) {
                var ent = this.scene.spawnEntity(def.entity);
                if (!ent) continue;

                var angle = spawnAngles[idx];
                var dist = 35 + Math.random() * 15;
                var sx = Math.cos(angle) * dist;
                var sz = Math.sin(angle) * dist;
                this.scene.setPosition(ent.id, sx, 1, sz);
                ent.transform.setRotationEuler(0, 0, 0);

                this._enemies.push({
                    entity: ent,
                    health: def.hp,
                    maxHealth: def.hp,
                    speed: def.speed,
                    damage: def.damage,
                    range: def.range,
                    fireRate: def.fireRate,
                    detect: def.detect,
                    cooldown: def.fireRate,
                    yaw: 0,
                    state: "patrol",
                    patrolX: (Math.random() - 0.5) * this._mapHalf,
                    patrolZ: (Math.random() - 0.5) * this._mapHalf,
                    patrolTimer: 3 + Math.random() * 4
                });
                idx++;
            }
        }
        this._totalKills = this._kills + this._enemies.length;
    }

    /* ==============================================================
     *  BATTLE UPDATE
     * ============================================================== */
    _updateBattle(dt) {
        if (!this._playerTank) return;
        var pp = this._playerTank.transform.position;

        // Update each enemy
        for (var i = this._enemies.length - 1; i >= 0; i--) {
            var e = this._enemies[i];
            if (!e.entity || !e.entity.active) {
                this._enemies.splice(i, 1);
                continue;
            }

            e.cooldown -= dt;
            var ep = e.entity.transform.position;
            var dx = pp.x - ep.x;
            var dz = pp.z - ep.z;
            var dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < e.detect) {
                // Chase / attack
                var faceAngle = Math.atan2(dx, -dz) * 180 / Math.PI;
                e.yaw = faceAngle;
                e.entity.transform.setRotationEuler(0, -e.yaw, 0);

                if (dist > e.range * 0.6) {
                    // Move toward player
                    var moveSpeed = e.speed;
                    var yawRad = e.yaw * Math.PI / 180;
                    var mx = Math.sin(yawRad) * moveSpeed * dt;
                    var mz = -Math.cos(yawRad) * moveSpeed * dt;
                    this.scene.setPosition(e.entity.id, ep.x + mx, ep.y, ep.z + mz);
                    e.state = "chase";
                } else {
                    e.state = "attack";
                }

                // Fire at player
                if (dist <= e.range && e.cooldown <= 0) {
                    e.cooldown = e.fireRate;
                    this._enemyFired(e, ep, pp);
                }
            } else {
                // Patrol
                e.state = "patrol";
                e.patrolTimer -= dt;
                if (e.patrolTimer <= 0) {
                    e.patrolX = (Math.random() - 0.5) * this._mapHalf;
                    e.patrolZ = (Math.random() - 0.5) * this._mapHalf;
                    e.patrolTimer = 4 + Math.random() * 5;
                }

                var pdx = e.patrolX - ep.x;
                var pdz = e.patrolZ - ep.z;
                var pdist = Math.sqrt(pdx * pdx + pdz * pdz);
                if (pdist > 2) {
                    e.yaw = Math.atan2(pdx, -pdz) * 180 / Math.PI;
                    e.entity.transform.setRotationEuler(0, -e.yaw, 0);
                    var yawRad = e.yaw * Math.PI / 180;
                    this.scene.setPosition(e.entity.id,
                        ep.x + Math.sin(yawRad) * e.speed * 0.5 * dt,
                        ep.y,
                        ep.z - Math.cos(yawRad) * e.speed * 0.5 * dt
                    );
                }
            }

            // Clamp to map bounds
            var cep = e.entity.transform.position;
            var cx = Math.max(-this._mapHalf, Math.min(this._mapHalf, cep.x));
            var cz = Math.max(-this._mapHalf, Math.min(this._mapHalf, cep.z));
            if (cx !== cep.x || cz !== cep.z) {
                this.scene.setPosition(e.entity.id, cx, cep.y, cz);
            }
        }

        // Check player death
        if (this._playerHP <= 0) {
            this._defeat();
            return;
        }

        // Check wave clear
        if (this._enemies.length === 0) {
            this._phase = "wave_clear";
            this._phaseTimer = 3;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_004.ogg", 0.5);
            if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/objective_achieved.ogg", 0.5);
        }

        // Clamp player to map bounds
        var cx2 = Math.max(-this._mapHalf, Math.min(this._mapHalf, pp.x));
        var cz2 = Math.max(-this._mapHalf, Math.min(this._mapHalf, pp.z));
        if (cx2 !== pp.x || cz2 !== pp.z) {
            this.scene.setPosition(this._playerTank.id, cx2, pp.y, cz2);
        }
    }

    /* ==============================================================
     *  COMBAT
     * ============================================================== */
    _playerFired(data) {
        // Cone-based hit detection against enemies
        var yawRad = data.yaw * Math.PI / 180;
        var dirX = Math.sin(yawRad);
        var dirZ = -Math.cos(yawRad);

        var bestDist = data.range + 1;
        var bestEnemy = null;

        for (var i = 0; i < this._enemies.length; i++) {
            var e = this._enemies[i];
            if (!e.entity || !e.entity.active) continue;
            var ep = e.entity.transform.position;
            var dx = ep.x - data.x;
            var dz = ep.z - data.z;
            var dist = Math.sqrt(dx * dx + dz * dz);
            if (dist > data.range || dist < 1) continue;
            var dot = (dx * dirX + dz * dirZ) / dist;
            if (dot > this._hitConeThreshold && dist < bestDist) {
                bestDist = dist;
                bestEnemy = e;
            }
        }

        if (bestEnemy) {
            bestEnemy.health -= data.damage;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactMetal_heavy_001.ogg", 0.5);
            if (bestEnemy.health <= 0) {
                bestEnemy.entity.active = false;
                this._kills++;
                if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/lowFrequency_explosion_000.ogg", 0.55);
            }
        }
    }

    _enemyFired(enemy, fromPos, targetPos) {
        var dx = targetPos.x - fromPos.x;
        var dz = targetPos.z - fromPos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > enemy.range) return;

        // Accuracy check — 70% chance to hit
        if (Math.random() > 0.70) return;

        this._playerHP -= enemy.damage;
        if (this._playerHP < 0) this._playerHP = 0;

        if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserLarge_002.ogg", 0.3);
        if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactPlate_heavy_002.ogg", 0.4);

        this.scene.events.ui.emit("hud_update", {
            playerHP: this._playerHP,
            playerMaxHP: this._playerMaxHP
        });
    }

    /* ==============================================================
     *  END CONDITIONS
     * ============================================================== */
    _victory() {
        this._gameActive = false;
        this.scene.events.ui.emit("hud_update", {
            _gameOver: {
                title: "VICTORY!",
                score: this._kills * 100 + this._playerHP,
                stats: {
                    "Tanks Destroyed": "" + this._kills,
                    "Waves Cleared": this._wave + " / " + this._totalWaves,
                    "Hull Integrity": Math.floor(this._playerHP / this._playerMaxHP * 100) + "%"
                }
            }
        });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/congratulations.ogg", 0.6);
        this.scene.events.game.emit("game_won", {});
    }

    _defeat() {
        this._gameActive = false;
        this.scene.events.ui.emit("hud_update", {
            _gameOver: {
                title: "DESTROYED",
                score: this._kills * 100,
                stats: {
                    "Tanks Destroyed": "" + this._kills,
                    "Reached Wave": "" + this._wave
                }
            }
        });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/lowFrequency_explosion_001.ogg", 0.6);
        if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/game_over.ogg", 0.6);
        this.scene.events.game.emit("game_over", {});
    }

    /* ==============================================================
     *  HUD
     * ============================================================== */
    _updateHud() {
        var announce = "";
        var subtext = "";

        if (this._phase === "countdown") {
            var cv = Math.ceil(this._phaseTimer);
            announce = cv > 0 ? "WAVE " + this._wave : "ENGAGE!";
            if (cv > 0) subtext = this._describeWave();
        } else if (this._phase === "wave_clear") {
            announce = "WAVE CLEAR";
            subtext = this._wave < this._totalWaves ? "Prepare for next assault" : "All hostiles eliminated";
        }

        this.scene.events.ui.emit("hud_update", {
            playerHP: this._playerHP,
            playerMaxHP: this._playerMaxHP,
            wave: this._wave,
            totalWaves: this._totalWaves,
            kills: this._kills,
            enemiesAlive: this._enemies.length,
            battlePhase: this._phase,
            announce: announce,
            subtext: subtext
        });
    }

    _describeWave() {
        var wd = this._waveDefs[this._wave - 1];
        var parts = [];
        for (var i = 0; i < wd.length; i++) {
            parts.push(wd[i].count + " " + wd[i].type);
        }
        return parts.join(" + ") + " tanks";
    }
}
