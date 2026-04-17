// Rift 1v1 — peer-to-peer MOBA lane rules.
//
// Host-authoritative match with a single mid lane:
//   * 2 champions (one per peer, or one peer + one bot)
//   * 2 towers per side along the lane
//   * 1 nexus per side — destroy the enemy's to win
//   * Minion waves spawn every `waveIntervalSec` at each base and
//     march down the lane attacking whatever comes first
//
// Authority:
//   Host owns every damage tick, minion spawn, minion AI, tower AI,
//   champion kill/respawn, projectile update, and win check. Peers
//   authoritatively drive their own champion's movement and cast
//   intents; the host validates and applies the result.
//
// The system works with rift_1v1_game.params overrides for every knob
// (HP values, damage, ability cooldowns, wave interval, etc.) so a
// different 2-lane MOBA variant can reuse the same scaffold.
//
// Solo support: the roster is checked each roster change; if < 2
// peers, the pre-placed "BotChampion" entity stays active and is
// driven by the internal bot AI.
class Rift1v1GameSystem extends GameScript {
    // ── Config ─────────────────────────────────────────────────────
    _warmupSec = 2.0;
    _championHp = 520;
    _championRegenPerSec = 3;
    _championAttackRange = 5.5;
    _championAttackCd = 0.55;
    _championAttackDamage = 24;
    _abilityQCd = 6;
    _abilityQDamage = 90;
    _abilityQRange = 12;
    _abilityQSpeed = 22;
    _abilityECd = 12;
    _abilityEDash = 5;
    _abilityEDamage = 50;
    _respawnSec = 8;
    _championKillGold = 250;

    _waveIntervalSec = 28;
    _minionsPerWave = 3;
    _minionHp = 120;
    _minionDamage = 12;
    _minionMoveSpeed = 3.2;
    _minionAttackRange = 2.0;
    _minionAttackCd = 0.8;
    _minionGoldReward = 18;

    _towerHp = 900;
    _towerDamage = 60;
    _towerAttackCd = 0.9;
    _towerRange = 7.5;
    _towerGoldReward = 150;

    _nexusHp = 1500;

    _blueSpawn = { x: 0, y: 1, z:  38 };
    _redSpawn  = { x: 0, y: 1, z: -38 };
    _lanePathY = 1;
    _towerPositions = {
        blue: [{ x: 0, z:  20 }, { x: 0, z:  30 }],
        red:  [{ x: 0, z: -20 }, { x: 0, z: -30 }],
    };
    _nexusPositions = {
        blue: { x: 0, z:  38 },
        red:  { x: 0, z: -38 },
    };

    // ── Match state ────────────────────────────────────────────────
    _phase = "idle";
    _phaseTimer = 0;
    _matchEnded = false;
    _pendingMatchStartAt = 0;
    _matchElapsed = 0;

    _teams = {};            // championKey → "blue" | "red"  (championKey = peerId or bot id)
    _hp = {};               // key → current HP
    _gold = {};
    _kills = {};
    _deaths = {};
    _cs = {};               // minion kills
    _alive = {};
    _respawnAt = {};
    _cooldowns = {};        // key → { Q, E, basic }
    _attackCdLocal = 0;
    _bots = [];

    _minions = [];          // [{ id, ent, team, hp, ax, az, targetEntity, attackCd }]
    _towers = [];           // [{ id, ent, team, hp, x, z, attackCd }]
    _nexuses = {};          // { blue: {ent, hp}, red: {ent, hp} }
    _projectiles = [];      // host-authoritative skillshots

    _waveTimer = 0;
    _waveNumber = 0;
    _minionIdCounter = 0;
    _projIdCounter = 0;

    _hudTickTimer = 0;

    onStart() {
        var self = this;

        this.scene.events.game.on("match_started", function() {
            self._pendingMatchStartAt = 0.2;
        });

        // Host → peer broadcasts.
        this.scene.events.game.on("net_rift_state_sync", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyStateSync(d);
        });
        this.scene.events.game.on("net_rift_damage", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyDamagePing(d);
        });
        this.scene.events.game.on("net_rift_kill", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyKillPing(d);
        });
        this.scene.events.game.on("net_rift_minion_spawn", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyMinionSpawn(d);
        });
        this.scene.events.game.on("net_rift_minion_despawn", function(evt) {
            var d = (evt && evt.data) || {};
            if (d.minionId) self._despawnMinion(d.minionId);
        });
        this.scene.events.game.on("net_rift_projectile", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyRemoteProjectile(d);
        });
        this.scene.events.game.on("net_rift_ability_cast", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyAbilityCast(d);
        });
        this.scene.events.game.on("net_rift_match_ended", function(evt) {
            var d = (evt && evt.data) || {};
            self._endMatchOnPeers(d);
        });
        this.scene.events.game.on("net_rift_teams", function(evt) {
            var d = (evt && evt.data) || {};
            if (d.teams) self._teams = d.teams;
            self._applyTeamColors();
            // Non-host peers run _placeChampions before teams arrive, so
            // the champion ends up at the blue default. Reposition once
            // the team assignment lands.
            self._placeChampions();
        });

        // Local intents.
        this.scene.events.game.on("rift_ability_pressed", function(data) {
            self._onLocalAbility(data || {});
        });
        this.scene.events.game.on("rift_basic_attack", function(data) {
            self._onLocalBasicAttack(data || {});
        });
        this.scene.events.game.on("rift_move_order", function() {
            // Purely informational — movement applied in behavior.
        });
        this.scene.events.game.on("rift_shop_toggle", function() {
            self.scene.events.ui.emit("hud_update", { _riftShopToggle: true });
        });
        this.scene.events.ui.on("ui_event:hud/rift_hud:buy_item", function(d) {
            var p = (d && d.payload) || {};
            self._tryBuyItem(p.itemId);
        });

        // MP lifecycle.
        this.scene.events.game.on("mp_host_changed", function() { self._pushHud(); });
        this.scene.events.game.on("mp_roster_changed", function() {
            self._reassessBot();
            self._pushHud();
        });
        this.scene.events.game.on("mp_below_min_players", function() {
            // Solo OK (bot takes the other side) — do nothing.
        });
    }

    onUpdate(dt) {
        if (this._pendingMatchStartAt > 0) {
            this._pendingMatchStartAt -= dt;
            if (this._pendingMatchStartAt <= 0) {
                this._pendingMatchStartAt = 0;
                this._initMatch();
            }
        }
        if (!this._phase || this._phase === "idle") return;
        if (this._matchEnded) return;

        this._matchElapsed += dt;
        this._phaseTimer -= dt;
        if (this._phase === "warmup" && this._phaseTimer <= 0) {
            this._phase = "playing";
            this.scene._riftFrozen = false;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/go.ogg", 0.55);
        }

        // Host-only ticks.
        var mp = this.scene._mp;
        var isHost = !mp || mp.isHost;
        if (isHost) {
            this._tickMinionWavesHost(dt);
            this._tickMinionsHost(dt);
            this._tickTowersHost(dt);
            this._tickProjectilesHost(dt);
            this._tickRespawnsHost(dt);
            this._tickGoldRegenHost(dt);
            this._tickChampionRegenHost(dt);
            this._tickBotHost(dt);
            this._maybeEndMatchHost();
            // Periodic state sync for peers.
            this._syncTimer = (this._syncTimer || 0) + dt;
            if (this._syncTimer >= 0.25) {
                this._syncTimer = 0;
                this._broadcastStateSync();
            }
        } else {
            // Non-host still renders projectile visuals from sync.
            this._tickProjectilesVisual(dt);
            this._tickMinionsVisualOnly(dt);
        }

        this._tickLocalCooldowns(dt);
        this._pushHudTick(dt);
    }

    // ─── Init ────────────────────────────────────────────────────────
    _initMatch() {
        var mp = this.scene._mp;
        if (!mp) return;
        var roster = mp.roster;
        if (!roster || !roster.peers || roster.peers.length === 0) return;

        this._resetState();
        this._applyNetworkIdentity();
        this._reassessBot();
        this._assignTeamsHost();
        this._spawnTowersAndNexuses();
        this._placeChampions();

        this._phase = "warmup";
        this._phaseTimer = this._warmupSec;
        this.scene._riftFrozen = true;
        this._pushHud();
    }

    _resetState() {
        this._phase = "warmup";
        this._phaseTimer = this._warmupSec;
        this._matchEnded = false;
        this._matchElapsed = 0;
        this._teams = {};
        this._hp = {};
        this._gold = {};
        this._kills = {};
        this._deaths = {};
        this._cs = {};
        this._alive = {};
        this._respawnAt = {};
        this._cooldowns = {};
        this._bots = [];
        this._clearRuntimeEntities();
        this._minions = [];
        this._towers = [];
        this._nexuses = {};
        this._projectiles = [];
        this._waveTimer = this._waveIntervalSec;
        this._waveNumber = 0;
    }

    _clearRuntimeEntities() {
        var tags = ["rift_minion", "rift_tower", "rift_nexus", "rift_projectile"];
        for (var i = 0; i < tags.length; i++) {
            var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag(tags[i]) : [];
            for (var j = 0; j < all.length; j++) {
                if (all[j] && this.scene.destroyEntity) this.scene.destroyEntity(all[j].id);
            }
        }
    }

    _applyNetworkIdentity() {
        var mp = this.scene._mp;
        if (!mp) return;
        var localPeerId = mp.localPeerId;
        if (!localPeerId) return;
        var ent = this._findLocalChampion();
        if (!ent) return;
        var ni = ent.getComponent("NetworkIdentityComponent");
        if (ni) {
            ni.networkId = this._hashPeerId(localPeerId);
            ni.ownerId = localPeerId;
            ni.isLocalPlayer = true;
        }
        ent._riftAlive = true;
    }

    _reassessBot() {
        var mp = this.scene._mp;
        if (!mp) return;
        var numPeers = (mp.roster && mp.roster.peers) ? mp.roster.peers.length : 1;
        var bot = this.scene.findEntityByName && this.scene.findEntityByName("BotChampion");
        if (!bot) return;
        if (numPeers >= 2) {
            bot.active = false;
            this._bots = [];
        } else {
            bot.active = true;
            bot._isBot = true;
            bot._riftBotId = "bot_red";
            bot._riftAlive = true;
            this._bots = ["bot_red"];
        }
    }

    _assignTeamsHost() {
        var mp = this.scene._mp;
        if (!mp || !mp.isHost) return;
        var peers = (mp.roster && mp.roster.peers) ? mp.roster.peers.slice() : [];
        peers.sort(function(a, b) { return a.peerId < b.peerId ? -1 : 1; });
        var teams = {};
        for (var i = 0; i < peers.length; i++) {
            teams[peers[i].peerId] = (i === 0) ? "blue" : "red";
        }
        // Solo assigns bot to red.
        if (this._bots.length) teams["bot_red"] = "red";
        this._teams = teams;

        // Initialize champion-state mirrors.
        for (var k in teams) {
            this._hp[k] = this._championHp;
            this._gold[k] = 300;
            this._kills[k] = 0;
            this._deaths[k] = 0;
            this._cs[k] = 0;
            this._alive[k] = true;
            this._cooldowns[k] = { Q: 0, E: 0, basic: 0 };
        }

        mp.sendNetworkedEvent("rift_teams", { teams: teams });
        this._applyTeamColors();
    }

    _applyTeamColors() {
        var champs = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("champion") : [];
        for (var i = 0; i < champs.length; i++) {
            var c = champs[i];
            if (!c || !c.getComponent) continue;
            var ni = c.getComponent("NetworkIdentityComponent");
            var key = ni && ni.ownerId;
            var team = null;
            if (key && this._teams[key]) team = this._teams[key];
            else if (c._isBot) team = this._teams[c._riftBotId] || "red";
            if (!team) continue;
            var mr = c.getComponent("MeshRendererComponent");
            if (!mr) continue;
            var col = (team === "blue") ? [0.3, 0.55, 1.0, 1] : [1.0, 0.35, 0.35, 1];
            if (mr.baseColor) {
                mr.baseColor[0] = col[0]; mr.baseColor[1] = col[1];
                mr.baseColor[2] = col[2]; mr.baseColor[3] = col[3];
            }
            if (mr.emissive) {
                mr.emissive[0] = col[0] * 0.35;
                mr.emissive[1] = col[1] * 0.35;
                mr.emissive[2] = col[2] * 0.35;
                mr.emissiveIntensity = 0.4;
            }
        }
    }

    _placeChampions() {
        var champs = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("champion") : [];
        for (var i = 0; i < champs.length; i++) {
            var c = champs[i];
            if (!c || !c.transform) continue;
            var ni = c.getComponent ? c.getComponent("NetworkIdentityComponent") : null;
            var key = ni && ni.ownerId;
            var team = null;
            if (key && this._teams[key]) team = this._teams[key];
            else if (c._isBot) team = this._teams[c._riftBotId] || "red";
            var spawn = (team === "red") ? this._redSpawn : this._blueSpawn;
            var yaw = (team === "red") ? 0 : Math.PI;
            this.scene.setPosition(c.id, spawn.x, spawn.y, spawn.z);
            c.transform.setRotationEuler && c.transform.setRotationEuler(0, yaw, 0);
            c.transform.markDirty && c.transform.markDirty();
            c._riftAlive = true;
        }
    }

    _spawnTowersAndNexuses() {
        var self = this;
        function spawnTower(team, pos) {
            var ent = self._spawnPrim("Tower_" + team + "_" + pos.z, "cylinder", {
                x: pos.x, y: 2, z: pos.z,
                sx: 2.2, sy: 4, sz: 2.2,
                color: team === "blue" ? [0.3, 0.55, 1.0, 1] : [1.0, 0.35, 0.35, 1],
                emissive: team === "blue" ? [0.25, 0.5, 1.0] : [1.0, 0.3, 0.3],
                emissiveIntensity: 1.4,
                tag: "rift_tower",
            });
            self._towers.push({
                ent: ent, team: team,
                x: pos.x, z: pos.z,
                hp: self._towerHp, attackCd: 0,
            });
        }
        var blueT = this._towerPositions.blue;
        for (var i = 0; i < blueT.length; i++) spawnTower("blue", blueT[i]);
        var redT = this._towerPositions.red;
        for (var j = 0; j < redT.length; j++) spawnTower("red",  redT[j]);

        // Nexuses.
        var bn = this._nexusPositions.blue;
        var nexusBlue = this._spawnPrim("Nexus_blue", "cube", {
            x: bn.x, y: 2.6, z: bn.z,
            sx: 4.2, sy: 5, sz: 4.2,
            color: [0.35, 0.6, 1.0, 1],
            emissive: [0.3, 0.6, 1.0],
            emissiveIntensity: 2.2,
            tag: "rift_nexus",
        });
        var rn = this._nexusPositions.red;
        var nexusRed = this._spawnPrim("Nexus_red", "cube", {
            x: rn.x, y: 2.6, z: rn.z,
            sx: 4.2, sy: 5, sz: 4.2,
            color: [1.0, 0.4, 0.4, 1],
            emissive: [1.0, 0.35, 0.35],
            emissiveIntensity: 2.2,
            tag: "rift_nexus",
        });
        this._nexuses = {
            blue: { ent: nexusBlue, hp: this._nexusHp },
            red:  { ent: nexusRed,  hp: this._nexusHp },
        };
    }

    // ─── Minion waves ────────────────────────────────────────────────
    _tickMinionWavesHost(dt) {
        this._waveTimer -= dt;
        if (this._waveTimer > 0) return;
        this._waveTimer = this._waveIntervalSec;
        this._waveNumber += 1;
        this._spawnWave("blue");
        this._spawnWave("red");
        if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/forceField_001.ogg", 0.35);
    }

    _spawnWave(team) {
        var mp = this.scene._mp;
        if (!mp || !mp.isHost) return;
        var start = (team === "blue") ? this._blueSpawn : this._redSpawn;
        var dir = (team === "blue") ? -1 : 1;
        for (var i = 0; i < this._minionsPerWave; i++) {
            this._minionIdCounter += 1;
            var id = "m" + this._minionIdCounter;
            var x = start.x + (i - (this._minionsPerWave - 1) / 2) * 1.5;
            var z = start.z + dir * 2.0;
            var payload = { minionId: id, team: team, x: x, z: z };
            mp.sendNetworkedEvent("rift_minion_spawn", payload);
            this._applyMinionSpawn(payload);
        }
    }

    _applyMinionSpawn(d) {
        if (!d.minionId) return;
        var ent = this._spawnPrim("Minion_" + d.minionId, "cube", {
            x: d.x || 0, y: 0.8, z: d.z || 0,
            sx: 0.9, sy: 1.6, sz: 0.9,
            color: d.team === "blue" ? [0.4, 0.7, 1.0, 1] : [1.0, 0.5, 0.45, 1],
            emissive: d.team === "blue" ? [0.3, 0.55, 0.9] : [1.0, 0.45, 0.4],
            emissiveIntensity: 0.7,
            tag: "rift_minion",
        });
        if (!ent) return;
        ent._minionId = d.minionId;
        this._minions.push({
            id: d.minionId, ent: ent, team: d.team,
            hp: this._minionHp, attackCd: 0,
        });
    }

    _tickMinionsHost(dt) {
        for (var i = 0; i < this._minions.length; i++) {
            var m = this._minions[i];
            if (!m || m.hp <= 0 || !m.ent) continue;
            var pos = m.ent.transform.position;

            // Find a target: nearest enemy champion or minion in sight
            // range; if none, march toward the opposing base.
            var target = this._findMinionTarget(m, pos);
            if (target && target.dist <= this._minionAttackRange) {
                // Attack.
                m.attackCd -= dt;
                if (m.attackCd <= 0) {
                    m.attackCd = this._minionAttackCd;
                    this._applyDamageHost(target.key, this._minionDamage, "minion", m.id);
                }
            } else if (target && target.dist <= 8) {
                this._stepTowards(pos, target.x, target.z, this._minionMoveSpeed * dt);
                m.ent.transform.markDirty && m.ent.transform.markDirty();
            } else {
                // March toward the opposing nexus.
                var goal = (m.team === "blue") ? this._nexusPositions.red : this._nexusPositions.blue;
                this._stepTowards(pos, goal.x, goal.z, this._minionMoveSpeed * dt);
                m.ent.transform.markDirty && m.ent.transform.markDirty();
            }
        }
    }

    _tickMinionsVisualOnly(dt) {
        // Non-hosts just let positions settle via state sync; nothing to do.
    }

    _findMinionTarget(m, pos) {
        // Look for enemy champions within 6, then enemy minions within 4.
        var bestKey = null, bestDist = 1e9, bestX = 0, bestZ = 0;
        var champs = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("champion") : [];
        for (var i = 0; i < champs.length; i++) {
            var c = champs[i];
            if (!c || !c.active) continue;
            if (!c._riftAlive) continue;
            var tKey = this._championKey(c);
            if (!tKey) continue;
            if (this._teams[tKey] === m.team) continue;
            var cp = c.transform.position;
            var d = Math.hypot(cp.x - pos.x, cp.z - pos.z);
            if (d < 6 && d < bestDist) {
                bestDist = d; bestKey = tKey; bestX = cp.x; bestZ = cp.z;
            }
        }
        for (var j = 0; j < this._minions.length; j++) {
            var mm = this._minions[j];
            if (!mm || mm === m || mm.hp <= 0 || mm.team === m.team) continue;
            var mp2 = mm.ent.transform.position;
            var d2 = Math.hypot(mp2.x - pos.x, mp2.z - pos.z);
            if (d2 < 5 && d2 < bestDist) {
                bestDist = d2; bestKey = "minion:" + mm.id; bestX = mp2.x; bestZ = mp2.z;
            }
        }
        // Towers (minion will attack towers too).
        for (var k = 0; k < this._towers.length; k++) {
            var t = this._towers[k];
            if (!t || t.hp <= 0 || t.team === m.team) continue;
            var d3 = Math.hypot(t.x - pos.x, t.z - pos.z);
            if (d3 < 5 && d3 < bestDist) {
                bestDist = d3; bestKey = "tower:" + (this._towers.indexOf(t));
                bestX = t.x; bestZ = t.z;
            }
        }
        if (!bestKey) return null;
        return { key: bestKey, dist: bestDist, x: bestX, z: bestZ };
    }

    _despawnMinion(minionId) {
        for (var i = 0; i < this._minions.length; i++) {
            var m = this._minions[i];
            if (m && m.id === minionId) {
                if (m.ent && this.scene.destroyEntity) this.scene.destroyEntity(m.ent.id);
                this._minions.splice(i, 1);
                return;
            }
        }
    }

    // ─── Tower AI ────────────────────────────────────────────────────
    _tickTowersHost(dt) {
        for (var i = 0; i < this._towers.length; i++) {
            var t = this._towers[i];
            if (!t || t.hp <= 0) continue;
            t.attackCd -= dt;
            if (t.attackCd > 0) continue;

            var target = this._findTowerTarget(t);
            if (!target) continue;
            t.attackCd = this._towerAttackCd;
            this._applyDamageHost(target.key, this._towerDamage, "tower", "tower_" + i);
            // Fire a tracer projectile for visuals.
            this._spawnTracerHost({
                x: t.x, z: t.z,
                tx: target.x, tz: target.z,
                team: t.team, instant: true,
            });
        }
    }

    _findTowerTarget(t) {
        // Priority: enemy minions > enemy champion.
        var bestKey = null, bestDist = this._towerRange + 0.01, bestX = 0, bestZ = 0;
        for (var i = 0; i < this._minions.length; i++) {
            var m = this._minions[i];
            if (!m || m.hp <= 0 || m.team === t.team) continue;
            var mp2 = m.ent.transform.position;
            var d = Math.hypot(mp2.x - t.x, mp2.z - t.z);
            if (d < bestDist) { bestDist = d; bestKey = "minion:" + m.id; bestX = mp2.x; bestZ = mp2.z; }
        }
        if (bestKey) return { key: bestKey, dist: bestDist, x: bestX, z: bestZ };
        // No minion in range — target a champion if one is within range.
        var champs = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("champion") : [];
        for (var j = 0; j < champs.length; j++) {
            var c = champs[j];
            if (!c || !c.active || !c._riftAlive) continue;
            var cKey = this._championKey(c);
            if (!cKey || this._teams[cKey] === t.team) continue;
            var cp = c.transform.position;
            var d2 = Math.hypot(cp.x - t.x, cp.z - t.z);
            if (d2 < this._towerRange) return { key: cKey, dist: d2, x: cp.x, z: cp.z };
        }
        return null;
    }

    // ─── Projectiles (skillshots) ────────────────────────────────────
    _spawnTracerHost(opts) {
        var mp = this.scene._mp;
        if (!mp) return;
        var id = "p" + (++this._projIdCounter);
        var dx = opts.tx - opts.x, dz = opts.tz - opts.z;
        var L = Math.hypot(dx, dz) || 1;
        var payload = {
            projId: id, x: opts.x, z: opts.z,
            vx: (dx / L) * (opts.speed || 40),
            vz: (dz / L) * (opts.speed || 40),
            lifeTime: 0.25,
            damage: 0,
            team: opts.team,
            shooterKey: "",
            instant: !!opts.instant,
        };
        mp.sendNetworkedEvent("rift_projectile", payload);
        this._applyRemoteProjectile(payload);
    }

    _spawnAbilityProjectileHost(shooterKey, team, aimX, aimZ, damage) {
        var shooter = this._findChampionByKey(shooterKey);
        if (!shooter) return;
        var p = shooter.transform.position;
        var dx = aimX - p.x, dz = aimZ - p.z;
        var L = Math.hypot(dx, dz) || 1;
        var mp = this.scene._mp;
        if (!mp) return;
        var id = "p" + (++this._projIdCounter);
        var payload = {
            projId: id,
            x: p.x + (dx / L) * 0.8,
            z: p.z + (dz / L) * 0.8,
            vx: (dx / L) * this._abilityQSpeed,
            vz: (dz / L) * this._abilityQSpeed,
            lifeTime: this._abilityQRange / this._abilityQSpeed,
            damage: damage,
            team: team,
            shooterKey: shooterKey,
        };
        mp.sendNetworkedEvent("rift_projectile", payload);
        this._applyRemoteProjectile(payload);
    }

    _applyRemoteProjectile(d) {
        if (!d || !d.projId) return;
        var color = d.team === "blue" ? [0.4, 0.7, 1.0, 1] : [1.0, 0.5, 0.5, 1];
        var thin = !!d.instant;
        var ent = this._spawnPrim("Proj_" + d.projId, "sphere", {
            x: d.x, y: 1.2, z: d.z,
            sx: thin ? 0.25 : 0.6, sy: thin ? 0.25 : 0.6, sz: thin ? 0.25 : 0.6,
            color: color,
            emissive: [color[0], color[1], color[2]],
            emissiveIntensity: thin ? 3.0 : 2.4,
            tag: "rift_projectile",
        });
        this._projectiles.push({
            id: d.projId, ent: ent,
            x: d.x, z: d.z,
            vx: d.vx || 0, vz: d.vz || 0,
            life: d.lifeTime || 0.2,
            damage: d.damage || 0,
            team: d.team,
            shooterKey: d.shooterKey || "",
        });
    }

    _tickProjectilesHost(dt) {
        for (var i = this._projectiles.length - 1; i >= 0; i--) {
            var p = this._projectiles[i];
            if (!p) continue;
            p.x += p.vx * dt;
            p.z += p.vz * dt;
            p.life -= dt;
            if (p.ent && p.ent.transform) {
                p.ent.transform.position.x = p.x;
                p.ent.transform.position.z = p.z;
                p.ent.transform.markDirty && p.ent.transform.markDirty();
            }
            // Damage check (champions + minions opposite team).
            if (p.damage > 0) {
                var hit = this._projectileHit(p);
                if (hit) {
                    this._applyDamageHost(hit.key, p.damage, "ability", p.shooterKey);
                    if (p.ent && this.scene.destroyEntity) this.scene.destroyEntity(p.ent.id);
                    this._projectiles.splice(i, 1);
                    continue;
                }
            }
            if (p.life <= 0) {
                if (p.ent && this.scene.destroyEntity) this.scene.destroyEntity(p.ent.id);
                this._projectiles.splice(i, 1);
            }
        }
    }

    _tickProjectilesVisual(dt) {
        for (var i = this._projectiles.length - 1; i >= 0; i--) {
            var p = this._projectiles[i];
            if (!p) continue;
            p.x += p.vx * dt;
            p.z += p.vz * dt;
            p.life -= dt;
            if (p.ent && p.ent.transform) {
                p.ent.transform.position.x = p.x;
                p.ent.transform.position.z = p.z;
                p.ent.transform.markDirty && p.ent.transform.markDirty();
            }
            if (p.life <= 0) {
                if (p.ent && this.scene.destroyEntity) this.scene.destroyEntity(p.ent.id);
                this._projectiles.splice(i, 1);
            }
        }
    }

    _projectileHit(p) {
        var champs = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("champion") : [];
        for (var i = 0; i < champs.length; i++) {
            var c = champs[i];
            if (!c || !c.active || !c._riftAlive) continue;
            var k = this._championKey(c);
            if (!k || this._teams[k] === p.team) continue;
            var cp = c.transform.position;
            if (Math.abs(cp.x - p.x) < 0.9 && Math.abs(cp.z - p.z) < 0.9) return { key: k };
        }
        for (var j = 0; j < this._minions.length; j++) {
            var m = this._minions[j];
            if (!m || m.hp <= 0 || m.team === p.team) continue;
            var mp2 = m.ent.transform.position;
            if (Math.abs(mp2.x - p.x) < 0.7 && Math.abs(mp2.z - p.z) < 0.7) return { key: "minion:" + m.id };
        }
        return null;
    }

    // ─── Damage / death ─────────────────────────────────────────────
    _applyDamageHost(targetKey, damage, source, attackerKey) {
        if (!targetKey) return;

        // Champion target.
        if (this._hp[targetKey] !== undefined && this._alive[targetKey]) {
            var newHp = Math.max(0, this._hp[targetKey] - damage);
            this._hp[targetKey] = newHp;
            this._broadcastDamagePing({ targetKey: targetKey, damage: damage, source: source, attackerKey: attackerKey || "", hp: newHp });
            if (newHp <= 0) {
                this._onChampionKill(targetKey, attackerKey || "");
            }
            return;
        }
        // Minion target.
        if (targetKey.indexOf("minion:") === 0) {
            var mid = targetKey.substring(7);
            for (var i = 0; i < this._minions.length; i++) {
                var m = this._minions[i];
                if (m && m.id === mid) {
                    m.hp -= damage;
                    if (m.hp <= 0) {
                        this._broadcastMinionDespawn(mid);
                        this._despawnMinion(mid);
                        // CS + gold to attacker if it's a champion.
                        if (attackerKey && this._teams[attackerKey]) {
                            this._cs[attackerKey] = (this._cs[attackerKey] || 0) + 1;
                            this._gold[attackerKey] = (this._gold[attackerKey] || 0) + this._minionGoldReward;
                        }
                    }
                    return;
                }
            }
        }
        // Tower target.
        if (targetKey.indexOf("tower:") === 0) {
            var ti = parseInt(targetKey.substring(6));
            var t = this._towers[ti];
            if (t && t.hp > 0) {
                t.hp -= damage;
                if (t.hp <= 0) {
                    // Award gold to killer's team if champion-attributable.
                    if (attackerKey && this._teams[attackerKey]) {
                        this._gold[attackerKey] = (this._gold[attackerKey] || 0) + this._towerGoldReward;
                    }
                    if (t.ent && this.scene.destroyEntity) this.scene.destroyEntity(t.ent.id);
                    t.ent = null;
                }
            }
            return;
        }
        // Nexus target.
        if (targetKey === "nexus:blue" || targetKey === "nexus:red") {
            var nt = targetKey.substring(6);
            var nexus = this._nexuses[nt];
            if (nexus && nexus.hp > 0) {
                nexus.hp = Math.max(0, nexus.hp - damage);
                if (nexus.hp <= 0 && nexus.ent) {
                    if (this.scene.destroyEntity) this.scene.destroyEntity(nexus.ent.id);
                    nexus.ent = null;
                }
            }
        }
    }

    _onChampionKill(targetKey, attackerKey) {
        this._alive[targetKey] = false;
        this._deaths[targetKey] = (this._deaths[targetKey] || 0) + 1;
        this._respawnAt[targetKey] = this._matchElapsed + this._respawnSec;
        if (attackerKey && this._teams[attackerKey] && attackerKey !== targetKey) {
            this._kills[attackerKey] = (this._kills[attackerKey] || 0) + 1;
            this._gold[attackerKey] = (this._gold[attackerKey] || 0) + this._championKillGold;
        }
        var ent = this._findChampionByKey(targetKey);
        if (ent) ent._riftAlive = false;
        var mp = this.scene._mp;
        if (mp) mp.sendNetworkedEvent("rift_kill", {
            targetKey: targetKey, attackerKey: attackerKey || "",
            kills: this._kills, deaths: this._deaths, gold: this._gold,
        });
        this._applyKillPing({
            targetKey: targetKey, attackerKey: attackerKey || "",
            kills: this._kills, deaths: this._deaths, gold: this._gold,
        });
        this.scene.events.game.emit("champion_died", {});
    }

    _applyKillPing(d) {
        if (d.kills) this._kills = d.kills;
        if (d.deaths) this._deaths = d.deaths;
        if (d.gold) this._gold = d.gold;
        if (d.targetKey) {
            this._alive[d.targetKey] = false;
            var ent = this._findChampionByKey(d.targetKey);
            if (ent) ent._riftAlive = false;
        }
        if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/explosionCrunch_000.ogg", 0.45);
        this._pushHud();
    }

    _tickRespawnsHost(dt) {
        for (var key in this._alive) {
            if (this._alive[key]) continue;
            if (this._matchEnded) continue;
            if (!this._respawnAt[key]) continue;
            if (this._matchElapsed >= this._respawnAt[key]) {
                this._alive[key] = true;
                this._hp[key] = this._championHp;
                delete this._respawnAt[key];
                var ent = this._findChampionByKey(key);
                if (ent) {
                    ent._riftAlive = true;
                    var spawn = this._teams[key] === "red" ? this._redSpawn : this._blueSpawn;
                    this.scene.setPosition(ent.id, spawn.x, spawn.y, spawn.z);
                    ent.transform.markDirty && ent.transform.markDirty();
                }
            }
        }
    }

    _tickChampionRegenHost(dt) {
        for (var k in this._hp) {
            if (!this._alive[k]) continue;
            this._hp[k] = Math.min(this._championHp, this._hp[k] + this._championRegenPerSec * dt);
        }
    }

    _tickGoldRegenHost(dt) {
        for (var k in this._gold) {
            this._gold[k] = (this._gold[k] || 0) + 2 * dt;
        }
    }

    // ─── Ability casting ────────────────────────────────────────────
    _onLocalAbility(data) {
        var mp = this.scene._mp;
        if (!mp) return;
        var me = mp.localPeerId;
        if (!this._alive[me]) return;
        var slot = data.slot || "Q";
        var cds = this._cooldowns[me] || (this._cooldowns[me] = { Q: 0, E: 0, basic: 0 });
        if (slot === "Q" && cds.Q > 0) return;
        if (slot === "E" && cds.E > 0) return;
        if (slot === "R" && (cds.R || 0) > 0) return;
        if (slot === "Q") cds.Q = this._abilityQCd;
        if (slot === "E") cds.E = this._abilityECd;

        var payload = {
            key: me, slot: slot,
            aimX: data.aimX || 0, aimZ: data.aimZ || 0,
        };
        mp.sendNetworkedEvent("rift_ability_cast", payload);
        this._applyAbilityCast(payload);
    }

    _onLocalBasicAttack(data) {
        var mp = this.scene._mp;
        if (!mp) return;
        var me = mp.localPeerId;
        if (!this._alive[me]) return;
        // Snap toward the nearest target within attack range.
        var ent = this._findChampionByKey(me);
        if (!ent) return;
        var pp = ent.transform.position;
        var target = this._findBasicAttackTarget(me, pp);
        if (!target) return;
        var payload = {
            key: me, slot: "basic",
            aimX: target.x, aimZ: target.z,
            victimKey: target.key,
        };
        mp.sendNetworkedEvent("rift_ability_cast", payload);
        this._applyAbilityCast(payload);
    }

    _findBasicAttackTarget(fromKey, fromPos) {
        var team = this._teams[fromKey];
        var best = null;
        var bestDist = this._championAttackRange + 0.01;
        // Enemy champion.
        var champs = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("champion") : [];
        for (var i = 0; i < champs.length; i++) {
            var c = champs[i];
            if (!c || !c._riftAlive) continue;
            var key = this._championKey(c);
            if (!key || this._teams[key] === team) continue;
            var cp = c.transform.position;
            var d = Math.hypot(cp.x - fromPos.x, cp.z - fromPos.z);
            if (d < bestDist) { bestDist = d; best = { key: key, x: cp.x, z: cp.z }; }
        }
        // Enemy minions.
        for (var j = 0; j < this._minions.length; j++) {
            var m = this._minions[j];
            if (!m || m.hp <= 0 || m.team === team) continue;
            var mp2 = m.ent.transform.position;
            var d2 = Math.hypot(mp2.x - fromPos.x, mp2.z - fromPos.z);
            if (d2 < bestDist) { bestDist = d2; best = { key: "minion:" + m.id, x: mp2.x, z: mp2.z }; }
        }
        // Enemy towers.
        for (var t = 0; t < this._towers.length; t++) {
            var tw = this._towers[t];
            if (!tw || tw.hp <= 0 || tw.team === team) continue;
            var d3 = Math.hypot(tw.x - fromPos.x, tw.z - fromPos.z);
            if (d3 < bestDist) { bestDist = d3; best = { key: "tower:" + t, x: tw.x, z: tw.z }; }
        }
        // Enemy nexus (if all towers down).
        var enemyTeam = team === "blue" ? "red" : "blue";
        var nx = this._nexuses[enemyTeam];
        if (nx && nx.hp > 0) {
            var np = this._nexusPositions[enemyTeam];
            var d4 = Math.hypot(np.x - fromPos.x, np.z - fromPos.z);
            if (d4 < bestDist) { bestDist = d4; best = { key: "nexus:" + enemyTeam, x: np.x, z: np.z }; }
        }
        return best;
    }

    _applyAbilityCast(d) {
        var mp = this.scene._mp;
        var isHost = !mp || mp.isHost;
        var slot = d.slot;
        var team = this._teams[d.key];

        // Flash a tiny visual on the caster.
        if (this.audio) {
            if (slot === "Q") this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserLarge_000.ogg", 0.5);
            else if (slot === "E") this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/phaseJump2.ogg", 0.45);
            else if (slot === "basic") this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_002.ogg", 0.32);
        }

        if (slot === "E") {
            // Blink/dash: teleport ~5m toward aim.
            var ent = this._findChampionByKey(d.key);
            if (ent) {
                var p = ent.transform.position;
                var dx = d.aimX - p.x, dz = d.aimZ - p.z;
                var L = Math.hypot(dx, dz) || 1;
                var step = Math.min(this._abilityEDash, L);
                this.scene.setPosition(ent.id, p.x + (dx / L) * step, p.y, p.z + (dz / L) * step);
                ent.transform.markDirty && ent.transform.markDirty();
            }
            if (isHost) {
                // Damage champions/minions at landing point.
                var target = this._findAoeHit(d.key, d.aimX, d.aimZ, 2.0);
                if (target) this._applyDamageHost(target.key, this._abilityEDamage, "ability", d.key);
            }
            return;
        }
        if (slot === "Q") {
            if (isHost) this._spawnAbilityProjectileHost(d.key, team, d.aimX, d.aimZ, this._abilityQDamage);
            return;
        }
        if (slot === "basic") {
            // Fire a fast tracer + instant damage on the target.
            if (isHost && d.victimKey) {
                this._applyDamageHost(d.victimKey, this._championAttackDamage, "basic", d.key);
                this._spawnTracerHost({ x: this._keyX(d.key), z: this._keyZ(d.key), tx: d.aimX, tz: d.aimZ, team: team, instant: true });
            }
            return;
        }
    }

    _findAoeHit(fromKey, x, z, radius) {
        var team = this._teams[fromKey];
        var best = null;
        var bestDist = radius + 0.01;
        var champs = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("champion") : [];
        for (var i = 0; i < champs.length; i++) {
            var c = champs[i];
            if (!c || !c._riftAlive) continue;
            var key = this._championKey(c);
            if (!key || this._teams[key] === team) continue;
            var cp = c.transform.position;
            var d = Math.hypot(cp.x - x, cp.z - z);
            if (d < bestDist) { bestDist = d; best = { key: key }; }
        }
        for (var j = 0; j < this._minions.length; j++) {
            var m = this._minions[j];
            if (!m || m.hp <= 0 || m.team === team) continue;
            var mp2 = m.ent.transform.position;
            var d2 = Math.hypot(mp2.x - x, mp2.z - z);
            if (d2 < bestDist) { bestDist = d2; best = { key: "minion:" + m.id }; }
        }
        return best;
    }

    // ─── Bot AI ──────────────────────────────────────────────────────
    _tickBotHost(dt) {
        if (!this._bots.length) return;
        var botKey = this._bots[0];
        if (!this._alive[botKey]) return;
        var ent = this._findChampionByKey(botKey);
        if (!ent) return;
        var pos = ent.transform.position;

        // Pick a target: lowest-HP enemy in range, else nearest enemy
        // minion in range, else push toward enemy nexus.
        var team = this._teams[botKey];
        var target = this._findBasicAttackTarget(botKey, pos);
        if (target) {
            // Move to attack range of the target.
            var step = this._moveSpeedForBot() * dt;
            var dx = target.x - pos.x, dz = target.z - pos.z;
            var d = Math.hypot(dx, dz);
            if (d > this._championAttackRange * 0.9) {
                pos.x += (dx / (d || 1)) * step;
                pos.z += (dz / (d || 1)) * step;
                ent.transform.markDirty && ent.transform.markDirty();
            } else {
                // Auto-basic-attack on cooldown.
                var cds = this._cooldowns[botKey] || (this._cooldowns[botKey] = { Q: 0, E: 0, basic: 0 });
                if ((cds.basic || 0) <= 0) {
                    cds.basic = this._championAttackCd;
                    this._applyDamageHost(target.key, this._championAttackDamage, "basic", botKey);
                }
                // Cast Q at the enemy champion once in a while.
                if (cds.Q <= 0 && target.key.indexOf("minion:") !== 0 && target.key.indexOf("tower:") !== 0) {
                    cds.Q = this._abilityQCd;
                    this._spawnAbilityProjectileHost(botKey, team, target.x, target.z, this._abilityQDamage);
                }
            }
        } else {
            // Push toward the enemy nexus slowly.
            var goal = (team === "blue") ? this._nexusPositions.red : this._nexusPositions.blue;
            var step2 = this._moveSpeedForBot() * dt;
            var dxg = goal.x - pos.x, dzg = goal.z - pos.z;
            var dg = Math.hypot(dxg, dzg);
            if (dg > 0.5) {
                pos.x += (dxg / dg) * step2;
                pos.z += (dzg / dg) * step2;
                ent.transform.markDirty && ent.transform.markDirty();
            }
        }
    }

    _moveSpeedForBot() { return 5.2; }

    // ─── Shop ────────────────────────────────────────────────────────
    _tryBuyItem(itemId) {
        var mp = this.scene._mp;
        if (!mp) return;
        var me = mp.localPeerId;
        if (!this._alive[me]) return;
        var costs = { blade: 350, shield: 400, staff: 400, boots: 300 };
        var cost = costs[itemId] || 0;
        if (cost <= 0) return;
        if ((this._gold[me] || 0) < cost) return;
        this._gold[me] -= cost;
        // Items boost stats (simple: damage, hp, ability damage, move speed).
        if (itemId === "blade") this._championAttackDamage += 6;
        else if (itemId === "shield") {
            this._hp[me] = Math.min(this._championHp + 120, (this._hp[me] || 0) + 120);
        } else if (itemId === "staff") this._abilityQDamage += 20;
        else if (itemId === "boots") { /* no direct per-champion speed field in this demo */ }
        this.scene.events.game.emit("inventory_changed", {});
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_002.ogg", 0.45);
    }

    // ─── Win check ───────────────────────────────────────────────────
    _maybeEndMatchHost() {
        if (this._matchEnded) return;
        var mp = this.scene._mp;
        if (!mp || !mp.isHost) return;
        var nb = this._nexuses.blue;
        var nr = this._nexuses.red;
        if (nb && nb.hp <= 0) this._endMatchHost("red");
        else if (nr && nr.hp <= 0) this._endMatchHost("blue");
    }

    _endMatchHost(winnerTeam) {
        if (this._matchEnded) return;
        var mp = this.scene._mp;
        if (!mp) return;
        var payload = {
            winnerTeam: winnerTeam,
            kills: this._kills,
            deaths: this._deaths,
            cs: this._cs,
            gold: this._gold,
            teams: this._teams,
        };
        mp.sendNetworkedEvent("rift_match_ended", payload);
        this._endMatchOnPeers(payload);
        if (mp.isHost && mp.endMatch) mp.endMatch();
    }

    _endMatchOnPeers(d) {
        if (this._matchEnded) return;
        this._matchEnded = true;
        this._phase = "ended";
        this.scene._riftFrozen = true;
        this._pushGameOver(d);
        this.scene.events.game.emit("match_ended", {
            reason: "Nexus destroyed",
            winner: d.winnerTeam,
        });
    }

    // ─── Sync ────────────────────────────────────────────────────────
    _broadcastStateSync() {
        var mp = this.scene._mp;
        if (!mp || !mp.isHost) return;
        // Minion positions (compact array).
        var minionsOut = [];
        for (var i = 0; i < this._minions.length; i++) {
            var m = this._minions[i];
            if (!m || !m.ent) continue;
            var p = m.ent.transform.position;
            minionsOut.push({ id: m.id, x: p.x, z: p.z, hp: m.hp });
        }
        var towersOut = [];
        for (var j = 0; j < this._towers.length; j++) {
            var t = this._towers[j];
            towersOut.push({ team: t.team, x: t.x, z: t.z, hp: t.hp });
        }
        var nexusOut = {
            blue: this._nexuses.blue ? this._nexuses.blue.hp : 0,
            red:  this._nexuses.red  ? this._nexuses.red.hp  : 0,
        };
        mp.sendNetworkedEvent("rift_state_sync", {
            minions: minionsOut, towers: towersOut, nexus: nexusOut,
            hp: this._hp, alive: this._alive, gold: this._gold,
            kills: this._kills, deaths: this._deaths, cs: this._cs,
            respawnAt: this._respawnAt, matchElapsed: this._matchElapsed,
        });
    }

    _applyStateSync(d) {
        // Mirror authoritative fields.
        if (d.hp) this._hp = d.hp;
        if (d.alive) this._alive = d.alive;
        if (d.gold) this._gold = d.gold;
        if (d.kills) this._kills = d.kills;
        if (d.deaths) this._deaths = d.deaths;
        if (d.cs) this._cs = d.cs;
        if (d.respawnAt) this._respawnAt = d.respawnAt;
        if (typeof d.matchElapsed === "number") this._matchElapsed = d.matchElapsed;
        if (d.nexus) {
            if (this._nexuses.blue) this._nexuses.blue.hp = d.nexus.blue;
            if (this._nexuses.red)  this._nexuses.red.hp  = d.nexus.red;
        }
        // Minion positions.
        if (d.minions) {
            for (var i = 0; i < d.minions.length; i++) {
                var md = d.minions[i];
                var existing = this._minionById(md.id);
                if (!existing) continue;  // new minions come via rift_minion_spawn
                var pos = existing.ent.transform.position;
                pos.x = md.x; pos.z = md.z;
                existing.ent.transform.markDirty && existing.ent.transform.markDirty();
                existing.hp = md.hp;
            }
        }
        // Tower HPs.
        if (d.towers) {
            for (var j = 0; j < d.towers.length && j < this._towers.length; j++) {
                var t = this._towers[j];
                if (!t) continue;
                if (t.hp > 0 && d.towers[j].hp <= 0 && t.ent && this.scene.destroyEntity) {
                    this.scene.destroyEntity(t.ent.id);
                    t.ent = null;
                }
                t.hp = d.towers[j].hp;
            }
        }
        // Champion alive flags → entity active flip.
        for (var k in this._alive) {
            var ent = this._findChampionByKey(k);
            if (ent) ent._riftAlive = !!this._alive[k];
        }
    }

    _broadcastDamagePing(payload) {
        var mp = this.scene._mp;
        if (mp) mp.sendNetworkedEvent("rift_damage", payload);
        this._applyDamagePing(payload);
    }

    _applyDamagePing(d) {
        if (!d) return;
        // Flash + update HP mirror; authoritative value comes in via
        // the periodic state sync.
        if (d.targetKey && this._hp[d.targetKey] !== undefined && typeof d.hp === "number") {
            this._hp[d.targetKey] = d.hp;
        }
        // Play a soft hit sfx.
        if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactMetal_light_002.ogg", 0.25);
    }

    _broadcastMinionDespawn(minionId) {
        var mp = this.scene._mp;
        if (mp) mp.sendNetworkedEvent("rift_minion_despawn", { minionId: minionId });
    }

    // ─── HUD ─────────────────────────────────────────────────────────
    _pushHud() {
        var mp = this.scene._mp;
        if (!mp) return;
        var me = mp.localPeerId;
        var roster = mp.roster;
        var peers = (roster && roster.peers) || [];
        var myTeam = this._teams[me] || "blue";
        var players = [];
        var allKeys = Object.keys(this._teams);
        for (var i = 0; i < allKeys.length; i++) {
            var k = allKeys[i];
            var name = k.indexOf("bot_") === 0 ? "Bot" : this._displayName(k);
            players.push({
                key: k,
                name: name,
                team: this._teams[k],
                hp: Math.round(this._hp[k] || 0),
                maxHp: this._championHp,
                gold: Math.round(this._gold[k] || 0),
                kills: this._kills[k] || 0,
                deaths: this._deaths[k] || 0,
                cs: this._cs[k] || 0,
                alive: this._alive[k] !== false,
                respawnIn: Math.max(0, Math.round((this._respawnAt[k] || 0) - this._matchElapsed)),
                isLocal: k === me,
            });
        }
        var cds = this._cooldowns[me] || {};
        var payload = {
            _rift: {
                phase: this._phase,
                phaseTimer: Math.max(0, Math.round(this._phaseTimer)),
                matchElapsed: Math.round(this._matchElapsed),
                myTeam: myTeam,
                myHp: Math.round(this._hp[me] || 0),
                myMaxHp: this._championHp,
                myGold: Math.round(this._gold[me] || 0),
                myKills: this._kills[me] || 0,
                myDeaths: this._deaths[me] || 0,
                myCs: this._cs[me] || 0,
                myAlive: this._alive[me] !== false,
                myRespawnIn: Math.max(0, Math.round((this._respawnAt[me] || 0) - this._matchElapsed)),
                cdQ: Math.max(0, Math.round(cds.Q || 0)),
                cdE: Math.max(0, Math.round(cds.E || 0)),
                nexusBlue: this._nexuses.blue ? this._nexuses.blue.hp : 0,
                nexusRed:  this._nexuses.red  ? this._nexuses.red.hp  : 0,
                nexusMaxHp: this._nexusHp,
                towersBlueAlive: this._towers.filter(function(t) { return t.team === "blue" && t.hp > 0; }).length,
                towersRedAlive:  this._towers.filter(function(t) { return t.team === "red"  && t.hp > 0; }).length,
                players: players,
                waveTimer: Math.max(0, Math.round(this._waveTimer)),
                waveNumber: this._waveNumber,
            },
        };
        this.scene.events.ui.emit("hud_update", payload);
    }

    _pushHudTick(dt) {
        this._hudTickTimer = (this._hudTickTimer || 0) + dt;
        if (this._hudTickTimer < 0.15) return;
        this._hudTickTimer = 0;
        this._pushHud();
    }

    _pushGameOver(d) {
        var mp = this.scene._mp;
        var me = mp && mp.localPeerId;
        var myTeam = (mp && this._teams[me]) || "blue";
        var iWon = d.winnerTeam === myTeam;
        var title = iWon ? "VICTORY" : (d.winnerTeam ? d.winnerTeam.toUpperCase() + " WINS" : "Match Over");
        var stats = {
            "Winner": d.winnerTeam ? d.winnerTeam.toUpperCase() : "—",
            "Kills": String(this._kills[me] || 0),
            "Deaths": String(this._deaths[me] || 0),
            "Minions": String(this._cs[me] || 0),
            "Gold": String(Math.round(this._gold[me] || 0)),
        };
        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: iWon ? 1 : 0, stats: stats },
        });
    }

    // ─── Helpers ─────────────────────────────────────────────────────
    _findLocalChampion() {
        var champs = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("champion") : [];
        for (var i = 0; i < champs.length; i++) {
            var c = champs[i];
            var ni = c.getComponent("NetworkIdentityComponent");
            if (ni && ni.isLocalPlayer) return c;
        }
        return null;
    }

    _findChampionByKey(key) {
        var champs = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("champion") : [];
        for (var i = 0; i < champs.length; i++) {
            var c = champs[i];
            if (!c) continue;
            if (c._riftBotId === key) return c;
            var ni = c.getComponent("NetworkIdentityComponent");
            if (ni && ni.ownerId === key) return c;
        }
        return null;
    }

    _championKey(ent) {
        if (ent._riftBotId) return ent._riftBotId;
        var ni = ent.getComponent ? ent.getComponent("NetworkIdentityComponent") : null;
        return (ni && ni.ownerId) || "";
    }

    _keyX(key) {
        var ent = this._findChampionByKey(key);
        return ent ? ent.transform.position.x : 0;
    }
    _keyZ(key) {
        var ent = this._findChampionByKey(key);
        return ent ? ent.transform.position.z : 0;
    }

    _stepTowards(pos, tx, tz, step) {
        var dx = tx - pos.x, dz = tz - pos.z;
        var L = Math.hypot(dx, dz);
        if (L < 0.001) return;
        var s = Math.min(L, step);
        pos.x += (dx / L) * s;
        pos.z += (dz / L) * s;
    }

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

    _minionById(id) {
        for (var i = 0; i < this._minions.length; i++) {
            if (this._minions[i] && this._minions[i].id === id) return this._minions[i];
        }
        return null;
    }

    _displayName(key) {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        if (!roster) return key;
        for (var i = 0; i < roster.peers.length; i++) {
            if (roster.peers[i].peerId === key) return roster.peers[i].username;
        }
        return key;
    }

    _hashPeerId(peerId) {
        var h = 2166136261;
        for (var i = 0; i < peerId.length; i++) {
            h ^= peerId.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return ((h >>> 0) % 1000000) + 1000;
    }

    _tickLocalCooldowns(dt) {
        var mp = this.scene._mp;
        if (!mp) return;
        var me = mp.localPeerId;
        var cds = this._cooldowns[me] || (this._cooldowns[me] = { Q: 0, E: 0, basic: 0 });
        cds.Q = Math.max(0, (cds.Q || 0) - dt);
        cds.E = Math.max(0, (cds.E || 0) - dt);
        cds.basic = Math.max(0, (cds.basic || 0) - dt);
    }
}
