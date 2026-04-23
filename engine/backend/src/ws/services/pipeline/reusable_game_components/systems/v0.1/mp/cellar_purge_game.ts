// also: roguelike, twin-stick, dungeon, rooms, combat, projectiles
// Cellar Purge — single-player Isaac-style twin-stick roguelite.
//
// Floor layout: 4 rooms in a small cross — start (S), shop (W),
// arena (E), boss (N). Each is a self-contained square defined in
// the world JSON by an entity tagged "cp_room" whose `_room` meta
// labels it (`start`, `combat`, `shop`, `boss`). The match system
// reads the placements at boot to learn each room's centre + half-
// extents, then spawns enemies / pickups / doors per room kind.
//
// Combat: tear projectiles fly in the requested direction at a
// constant speed and despawn after _tearLifetime seconds (or on a
// hit). Enemies die from `cp_tear_hit` → `entity_damaged`. Rooms
// stay locked until every spawned enemy dies; on clear the system
// opens the connecting doors + drops a reward (coin/heart/key/item).
//
// Items modify scene-level stat fields the player behaviors read:
//   _cpFireRate     — secs between shots (lower = faster)
//   _cpTearDamage   — damage per tear
//   _cpTearSpeed    — tear flight speed
//   _cpMoveSpeed    — player walk speed (NOT yet wired into walker —
//                     left as a hook for items down the line)
//
// Reusable beyond Cellar Purge: any twin-stick room-based dungeon
// crawler can re-use the room/enemy/door wiring; just hand it your
// own room tags + enemy prefabs in the world JSON.
class CellarPurgeGameSystem extends GameScript {
    // ─── Tunable parameters ─────────────────────────────────────────
    _maxHealth = 6;             // half-hearts (3 full hearts)
    _startCoins = 0;
    _startBombs = 1;
    _startKeys = 0;
    _tearLifetime = 0.65;
    _tearSpeed = 14;
    _tearDamage = 4;
    _tearRadius = 0.20;
    _initialFireRate = 0.32;    // seconds between shots
    _pickupRadius = 0.85;
    _doorOpenY = 4.0;           // amount the door rises when open
    _doorSpeed = 6.0;
    _hudUpdateInterval = 0.12;
    _enemiesPerCombatRoom = 4;
    _enemiesPerBossRoom = 1;
    _hurtInvincibleSec = 1.2;
    _bossMaxHp = 80;
    _bossDamage = 2;

    // ─── Runtime state ──────────────────────────────────────────────
    _initialized = false;
    _matchOver = false;
    _phase = "playing";          // playing | victory | defeat
    _phaseClock = 0;

    _health = 6;
    _coins = 0;
    _bombs = 1;
    _keys = 0;
    _floor = 1;

    _hurtInvincibleUntil = 0;
    _hudTimer = 0;
    _enemyIdSeq = 1;

    // Room registry — built from placements at onStart.
    // { id, kind, centerX, centerZ, halfX, halfZ, cleared, spawned, enemies:[], pickups:[], doors:{n,s,e,w} }
    _rooms = {};
    _roomList = [];
    _currentRoomId = "";
    _floorComplete = false;
    _bossEntityId = null;
    _bossHp = 0;

    onStart() {
        var self = this;
        // Scratchpad for behaviors (fire rate buff lands here).
        this.scene._cpFireRate = this._initialFireRate;
        this.scene._cpTearDamage = this._tearDamage;
        this.scene._cpTearSpeed = this._tearSpeed;

        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });

        this.scene.events.game.on("cp_tear_fired", function(d) { self._spawnTear(d); });
        this.scene.events.game.on("cp_player_hurt", function(d) { self._takeDamage(Number((d && d.amount)) || 1, d && d.source); });
        this.scene.events.game.on("cp_enemy_killed", function(d) { self._onEnemyKilled(d && d.enemyId); });
    }

    onUpdate(dt) {
        if (!this._initialized || this._matchOver) return;
        this._phaseClock += dt;
        this._hudTimer += dt;

        this._tickTears(dt);
        this._tickRoomMembership();
        this._tickRoomClearState();
        this._tickPickups();
        this._tickFloorExit();

        if (this._hudTimer >= this._hudUpdateInterval) {
            this._hudTimer = 0;
            this._pushHud();
        }

        if (this._phase === "victory") {
            if (this._phaseClock >= 4.0) this._endMatch("complete");
        } else if (this._phase === "defeat") {
            if (this._phaseClock >= 3.0) this._endMatch("defeat");
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Match lifecycle
    // ═══════════════════════════════════════════════════════════════════

    _initMatch() {
        this._matchOver = false;
        this._phase = "playing";
        this._phaseClock = 0;
        this._health = this._maxHealth;
        this._coins = this._startCoins;
        this._bombs = this._startBombs;
        this._keys = this._startKeys;
        this._floor = 1;
        this._floorComplete = false;
        this._hurtInvincibleUntil = 0;
        this.scene._cpFireRate = this._initialFireRate;
        this.scene._cpTearDamage = this._tearDamage;
        this.scene._cpTearSpeed = this._tearSpeed;
        this._tears = [];
        this._activePickups = [];
        this._enemiesAlive = {};

        this._buildRoomRegistry();
        this._spawnInitialContents();
        this._currentRoomId = "";
        this._initialized = true;
        this._pushHud();
    }

    _endMatch(reason) {
        this._matchOver = true;
        var mp = this.scene._mp;
        var payload = { winner: mp ? mp.localPeerId : "", reason: reason };
        if (mp) mp.sendNetworkedEvent("match_ended", payload);
        this.scene.events.game.emit("match_ended", { winner: payload.winner, reason: reason });
        this._pushGameOver(reason);
        if (mp && mp.isHost && mp.endMatch) mp.endMatch();
    }

    _pushGameOver(reason) {
        var stats = {};
        stats["Coins"] = String(this._coins);
        stats["Floor reached"] = String(this._floor);
        if (reason === "complete") stats["Outcome"] = "Cleared the cellar — boss down";
        else if (reason === "defeat") stats["Outcome"] = "You fell. Try again.";
        var title = reason === "complete" ? "CELLAR PURGED" : "RUN ENDED";
        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: this._coins * 10, stats: stats },
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    // Room registry + content
    // ═══════════════════════════════════════════════════════════════════

    _buildRoomRegistry() {
        this._rooms = {};
        this._roomList = [];
        var roomEnts = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("cp_room") : [];
        for (var i = 0; i < roomEnts.length; i++) {
            var r = roomEnts[i];
            var pos = r.transform.position;
            var sc = r.transform.scale;
            // Read room kind: start | combat | shop | boss. Stored on
            // the EntityLabel script as _room (set by placement.meta).
            var kind = "combat";
            if (r.getScript) {
                var lbl = r.getScript("EntityLabel");
                if (lbl && lbl._room) kind = lbl._room;
            }
            var id = r.name || ("Room_" + i);
            this._rooms[id] = {
                id: id,
                kind: kind,
                centerX: pos.x,
                centerZ: pos.z,
                halfX: (sc && sc.x ? sc.x : 14) * 0.5,
                halfZ: (sc && sc.z ? sc.z : 14) * 0.5,
                cleared: kind === "start" || kind === "shop",
                spawned: kind === "start" || kind === "shop",
                enemies: [],
                pickups: [],
            };
            this._roomList.push(id);
        }
    }

    _spawnInitialContents() {
        // Start room: drop a "guidance" pickup so the player has
        // something to grab. Combat rooms stay empty until entered.
        // Boss room: empty until entered. Shop: drop a heart pickup.
        for (var i = 0; i < this._roomList.length; i++) {
            var rid = this._roomList[i];
            var r = this._rooms[rid];
            if (r.kind === "shop") {
                this._spawnPickup(r.centerX,        0.4, r.centerZ - 1.0, "coin");
                this._spawnPickup(r.centerX - 1.5,  0.4, r.centerZ + 0.5, "heart");
                this._spawnPickup(r.centerX + 1.5,  0.4, r.centerZ + 0.5, "fire_rate");
            }
        }
    }

    _tickRoomMembership() {
        var p = this._findLocalPlayer();
        if (!p) return;
        var pp = p.transform.position;
        for (var i = 0; i < this._roomList.length; i++) {
            var rid = this._roomList[i];
            var r = this._rooms[rid];
            var dx = pp.x - r.centerX;
            var dz = pp.z - r.centerZ;
            if (Math.abs(dx) <= r.halfX && Math.abs(dz) <= r.halfZ) {
                if (this._currentRoomId !== rid) {
                    this._onEnterRoom(rid);
                }
                return;
            }
        }
    }

    _onEnterRoom(rid) {
        this._currentRoomId = rid;
        var r = this._rooms[rid];
        this.scene.events.game.emit("cp_room_entered", { roomId: rid, kind: r.kind });
        if (r.spawned) return;
        r.spawned = true;
        if (r.kind === "combat") {
            this._spawnEnemiesInRoom(r, this._enemiesPerCombatRoom);
        } else if (r.kind === "boss") {
            this._spawnBossInRoom(r);
            this.scene.events.game.emit("cp_boss_engaged", { name: "The Cellar Wretch" });
        }
    }

    _tickRoomClearState() {
        for (var i = 0; i < this._roomList.length; i++) {
            var rid = this._roomList[i];
            var r = this._rooms[rid];
            if (r.cleared) continue;
            if (!r.spawned) continue;
            if (r.kind === "boss" && this._bossEntityId) {
                // Boss is alive if its entity still exists. Use entity
                // lookup; if gone, mark cleared.
                var bent = this.scene.getEntity ? this.scene.getEntity(this._bossEntityId) : null;
                if (!bent) {
                    this._bossEntityId = null;
                    r.cleared = true;
                    this._onRoomCleared(rid);
                }
            } else {
                // Combat room: cleared when all spawned enemies are dead.
                var alive = 0;
                for (var j = 0; j < r.enemies.length; j++) {
                    var eid = r.enemies[j];
                    if (this.scene.getEntity && this.scene.getEntity(eid)) alive++;
                }
                if (alive === 0) {
                    r.cleared = true;
                    this._onRoomCleared(rid);
                }
            }
        }
    }

    _onRoomCleared(rid) {
        var r = this._rooms[rid];
        this.scene.events.game.emit("cp_room_cleared", { roomId: rid });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_004.ogg", 0.5);
        // Drop loot.
        if (r.kind === "combat") {
            // Coin + 50% chance heart.
            this._spawnPickup(r.centerX,       0.4, r.centerZ, "coin");
            if (Math.random() < 0.5) this._spawnPickup(r.centerX + 1.2, 0.4, r.centerZ, "heart");
        } else if (r.kind === "boss") {
            // Boss drops a key + heart + the "exit" pickup that triggers
            // floor complete on touch.
            this._spawnPickup(r.centerX,       0.4, r.centerZ, "key");
            this._spawnPickup(r.centerX + 1.2, 0.4, r.centerZ, "heart");
            this._spawnPickup(r.centerX - 1.2, 0.4, r.centerZ, "exit");
            this._floorComplete = true;
            this.scene.events.game.emit("cp_floor_complete", { floor: this._floor });
            this.scene.events.game.emit("cp_boss_defeated", { name: "The Cellar Wretch" });
        }
        // Open all doors of this room (visual sync — we don't enforce
        // per-direction door state, the game is small enough that one
        // pull-up animation per door looks fine).
        this._openAllDoors(rid);
    }

    _openAllDoors(roomId) {
        // Doors are rc-style sliding cubes tagged "cp_door" with a
        // _room meta matching this roomId. Slide them up.
        var doors = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("cp_door") : [];
        for (var i = 0; i < doors.length; i++) {
            var d = doors[i];
            var lbl = d.getScript && d.getScript("EntityLabel");
            var rmAttr = lbl && lbl._room;
            if (rmAttr && rmAttr !== roomId) continue;
            // Slide up by raising Y.
            var pos = d.transform.position;
            // Use a small per-frame interpolation; easier to do
            // immediate teleport here since we don't need a real
            // animation curve to feel decent.
            this.scene.setPosition(d.id, pos.x, pos.y + this._doorOpenY, pos.z);
            this.scene.events.game.emit("cp_door_opened", { doorId: d.name || ("Door_" + i) });
        }
    }

    _spawnEnemiesInRoom(r, count) {
        for (var i = 0; i < count; i++) {
            var ang = (i / count) * Math.PI * 2;
            var rad = Math.min(r.halfX, r.halfZ) * 0.55;
            var x = r.centerX + Math.cos(ang) * rad;
            var z = r.centerZ + Math.sin(ang) * rad;
            this._spawnEnemy("zombie", x, z, r.id);
        }
    }

    _spawnEnemy(kind, x, z, roomId) {
        var scene = this.scene;
        if (!scene.createEntity) return;
        var id = this._enemyIdSeq++;
        var entId = scene.createEntity("Enemy_" + kind + "_" + id);
        if (entId == null) return;
        scene.setPosition(entId, x, 0.6, z);
        // Use a Quaternius cube_world Zombie for a low-poly cute baddie.
        scene.setScale && scene.setScale(entId, 1.0, 1.0, 1.0);
        scene.addComponent(entId, "MeshRendererComponent", {
            meshType: "custom",
            meshAsset: "/assets/quaternius/3d_models/cube_world/Zombie.glb",
            baseColor: [0.55, 0.85, 0.55, 1],
        });
        scene.addComponent(entId, "RigidbodyComponent", {
            bodyType: "kinematic",
            mass: 50,
            freezeRotation: true,
        });
        scene.addComponent(entId, "ColliderComponent", {
            shapeType: "capsule",
            radius: 0.4,
            height: 1.0,
        });
        if (scene.addTag) scene.addTag(entId, "cp_enemy");

        // Attach the dungeon_walker behavior script via component data.
        // We can't dynamically attach a script class at runtime in this
        // engine, so instead the system itself acts as the AI — see
        // _tickEnemyAI. Leaving the prefab-side dungeon_walker available
        // for placements that need it.
        this._enemiesAlive = this._enemiesAlive || {};
        this._enemiesAlive[entId] = { hp: 12, kind: kind, attackCooldown: 0 };
        this._rooms[roomId].enemies.push(entId);
        this.scene.events.game.emit("cp_enemy_spawned", { enemyId: entId, kind: kind });
    }

    _spawnBossInRoom(r) {
        var scene = this.scene;
        if (!scene.createEntity) return;
        var id = this._enemyIdSeq++;
        var entId = scene.createEntity("Enemy_boss_" + id);
        if (entId == null) return;
        scene.setPosition(entId, r.centerX, 1.0, r.centerZ);
        scene.setScale && scene.setScale(entId, 2.2, 2.2, 2.2);
        scene.addComponent(entId, "MeshRendererComponent", {
            meshType: "custom",
            meshAsset: "/assets/quaternius/3d_models/cube_world/Demon.glb",
            baseColor: [0.95, 0.30, 0.25, 1],
        });
        scene.addComponent(entId, "RigidbodyComponent", {
            bodyType: "kinematic",
            mass: 250,
            freezeRotation: true,
        });
        scene.addComponent(entId, "ColliderComponent", {
            shapeType: "capsule",
            radius: 0.85,
            height: 1.8,
        });
        if (scene.addTag) {
            scene.addTag(entId, "cp_enemy");
            scene.addTag(entId, "cp_boss");
        }
        this._enemiesAlive[entId] = { hp: this._bossMaxHp, kind: "boss", attackCooldown: 0 };
        this._bossEntityId = entId;
        this._bossHp = this._bossMaxHp;
        this._rooms[r.id].enemies.push(entId);
    }

    // Enemy AI — runs centrally instead of per-entity behavior so we
    // can sidestep the engine's lack of runtime-script-attach API. Walk
    // toward the player; deal contact damage on touch.
    _tickEnemies(dt) {
        var p = this._findLocalPlayer();
        if (!p) return;
        var pp = p.transform.position;
        for (var id in this._enemiesAlive) {
            var st = this._enemiesAlive[id];
            var ent = this.scene.getEntity ? this.scene.getEntity(Number(id)) : null;
            if (!ent) { delete this._enemiesAlive[id]; continue; }
            var ep = ent.transform.position;
            var dx = pp.x - ep.x;
            var dz = pp.z - ep.z;
            var d = Math.sqrt(dx * dx + dz * dz);
            var spd = st.kind === "boss" ? 1.6 : 2.6;
            if (d > 0.05) {
                this.scene.setVelocity && this.scene.setVelocity(ent.id, {
                    x: (dx / d) * spd, y: 0, z: (dz / d) * spd,
                });
                ent.transform.setRotationEuler && ent.transform.setRotationEuler(0, Math.atan2(-dx, -dz) * 180 / Math.PI, 0);
            }
            st.attackCooldown -= dt;
            var contact = st.kind === "boss" ? 1.6 : 1.0;
            if (d < contact && st.attackCooldown <= 0) {
                st.attackCooldown = 0.9;
                var dmg = st.kind === "boss" ? this._bossDamage : 1;
                this._takeDamage(dmg, st.kind === "boss" ? "boss" : "contact");
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Tears (projectiles)
    // ═══════════════════════════════════════════════════════════════════

    _spawnTear(d) {
        if (this._matchOver) return;
        var p = this._findLocalPlayer();
        if (!p) return;
        var pp = p.transform.position;
        var dx = Number(d.dirX) || 0;
        var dz = Number(d.dirZ) || 0;
        var dlen = Math.sqrt(dx * dx + dz * dz);
        if (dlen < 0.01) return;
        dx /= dlen; dz /= dlen;
        var scene = this.scene;
        if (!scene.createEntity) return;
        var entId = scene.createEntity("Tear_" + (this._tearIdSeq = (this._tearIdSeq || 0) + 1));
        if (entId == null) return;
        scene.setPosition(entId, pp.x + dx * 0.6, pp.y + 0.5, pp.z + dz * 0.6);
        scene.setScale && scene.setScale(entId, 0.34, 0.34, 0.34);
        scene.addComponent(entId, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: [0.85, 0.92, 1.0, 0.95],
        });
        if (scene.addTag) scene.addTag(entId, "cp_tear");
        this._tears = this._tears || [];
        this._tears.push({
            entityId: entId,
            x: pp.x + dx * 0.6,
            z: pp.z + dz * 0.6,
            vx: dx * (this.scene._cpTearSpeed || this._tearSpeed),
            vz: dz * (this.scene._cpTearSpeed || this._tearSpeed),
            life: this._tearLifetime,
        });
        this.scene.events.game.emit("cp_tear_fired", { dirX: dx, dirZ: dz });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/click_001.ogg", 0.25);
    }

    _tickTears(dt) {
        if (!this._tears || !this._tears.length) {
            this._tickEnemies(dt);
            return;
        }
        var kept = [];
        for (var i = 0; i < this._tears.length; i++) {
            var t = this._tears[i];
            t.life -= dt;
            t.x += t.vx * dt;
            t.z += t.vz * dt;
            // Hit-check against enemies.
            var hit = false;
            for (var id in this._enemiesAlive) {
                var ent = this.scene.getEntity ? this.scene.getEntity(Number(id)) : null;
                if (!ent) continue;
                var ep = ent.transform.position;
                var dx = ep.x - t.x;
                var dz = ep.z - t.z;
                var hr = (this._enemiesAlive[id].kind === "boss") ? 0.95 : 0.55;
                if (dx * dx + dz * dz < hr * hr) {
                    hit = true;
                    var dmg = this.scene._cpTearDamage || this._tearDamage;
                    this._enemiesAlive[id].hp -= dmg;
                    this.scene.events.game.emit("cp_tear_hit", { entityId: ent.id });
                    this.scene.events.game.emit("entity_damaged", { entityId: ent.id, amount: dmg, source: "tear" });
                    if (this._enemiesAlive[id].hp <= 0) {
                        var kind = this._enemiesAlive[id].kind;
                        delete this._enemiesAlive[id];
                        try { this.scene.destroyEntity && this.scene.destroyEntity(Number(id)); } catch (e) {}
                        this.scene.events.game.emit("cp_enemy_killed", { enemyId: Number(id), kind: kind });
                    } else {
                        // Hurt flash: tint the enemy briefly white.
                        if (ent.setMaterialColor) ent.setMaterialColor(1, 1, 1, 1);
                    }
                    break;
                }
            }
            if (hit || t.life <= 0) {
                try { this.scene.destroyEntity && this.scene.destroyEntity(t.entityId); } catch (e) {}
            } else {
                this.scene.setPosition(t.entityId, t.x, 0.6, t.z);
                kept.push(t);
            }
        }
        this._tears = kept;
        this._tickEnemies(dt);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Pickups
    // ═══════════════════════════════════════════════════════════════════

    _spawnPickup(x, y, z, kind) {
        var scene = this.scene;
        if (!scene.createEntity) return;
        var entId = scene.createEntity("Pickup_" + kind + "_" + ((this._pickupSeq = (this._pickupSeq || 0) + 1)));
        if (entId == null) return;
        scene.setPosition(entId, x, y, z);
        var color = [1, 1, 1, 1];
        var shape = "sphere";
        var scale = [0.45, 0.45, 0.45];
        if (kind === "coin")      { color = [1.0, 0.82, 0.20, 1]; shape = "cylinder"; scale = [0.45, 0.10, 0.45]; }
        else if (kind === "heart") { color = [1.0, 0.30, 0.40, 1]; }
        else if (kind === "key")  { color = [0.95, 0.85, 0.55, 1]; scale = [0.30, 0.55, 0.30]; }
        else if (kind === "fire_rate") { color = [0.45, 0.85, 1.0, 1]; }
        else if (kind === "exit") { color = [0.30, 0.92, 0.45, 1]; shape = "cylinder"; scale = [1.0, 0.10, 1.0]; }
        scene.setScale && scene.setScale(entId, scale[0], scale[1], scale[2]);
        scene.addComponent(entId, "MeshRendererComponent", {
            meshType: shape,
            baseColor: color,
        });
        if (scene.addTag) {
            scene.addTag(entId, "cp_pickup");
            scene.addTag(entId, "cp_pickup_" + kind);
        }
        this._activePickups = this._activePickups || [];
        this._activePickups.push({ entityId: entId, kind: kind, x: x, z: z });
    }

    _tickPickups() {
        if (!this._activePickups || !this._activePickups.length) return;
        var p = this._findLocalPlayer();
        if (!p) return;
        var pp = p.transform.position;
        var kept = [];
        for (var i = 0; i < this._activePickups.length; i++) {
            var pk = this._activePickups[i];
            var dx = pp.x - pk.x;
            var dz = pp.z - pk.z;
            if (dx * dx + dz * dz < this._pickupRadius * this._pickupRadius) {
                this._collectPickup(pk);
            } else {
                kept.push(pk);
            }
        }
        this._activePickups = kept;
    }

    _collectPickup(pk) {
        try { this.scene.destroyEntity && this.scene.destroyEntity(pk.entityId); } catch (e) {}
        var amt = 1;
        if (pk.kind === "coin") {
            this._coins += 1;
        } else if (pk.kind === "heart") {
            this._health = Math.min(this._maxHealth, this._health + 2);
            this.scene.events.game.emit("cp_player_healed", { amount: 2 });
        } else if (pk.kind === "key") {
            this._keys += 1;
        } else if (pk.kind === "bomb") {
            this._bombs += 1;
        } else if (pk.kind === "fire_rate") {
            // Buff: cut fire rate cooldown by 18%, capped at 0.10s floor.
            var newRate = Math.max(0.10, (this.scene._cpFireRate || this._initialFireRate) * 0.82);
            this.scene._cpFireRate = newRate;
        } else if (pk.kind === "damage") {
            this.scene._cpTearDamage = (this.scene._cpTearDamage || this._tearDamage) + 2;
        } else if (pk.kind === "exit") {
            this._phase = "victory";
            this._phaseClock = 0;
            return;
        }
        this.scene.events.game.emit("cp_pickup_collected", { kind: pk.kind, amount: amt });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_001.ogg", 0.4);
    }

    _tickFloorExit() {
        // Currently handled inline by the "exit" pickup. Hook left here
        // for future expansion (per-floor stairs entity).
    }

    // ═══════════════════════════════════════════════════════════════════
    // Damage + death
    // ═══════════════════════════════════════════════════════════════════

    _takeDamage(amount, source) {
        var nowT = (this.scene.time && this.scene.time.time) || 0;
        if (nowT < this._hurtInvincibleUntil) return;
        this._hurtInvincibleUntil = nowT + this._hurtInvincibleSec;
        this._health = Math.max(0, this._health - (Number(amount) || 1));
        this.scene.events.game.emit("cp_player_hurt", { amount: amount, source: source });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/error_006.ogg", 0.45);
        if (this._health <= 0) {
            this._phase = "defeat";
            this._phaseClock = 0;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════════════════════════

    _findLocalPlayer() {
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < all.length; i++) {
            var p = all[i];
            var ni = p.getComponent ? p.getComponent("NetworkIdentityComponent") : null;
            if (ni && ni.isLocalPlayer) return p;
            if (!ni) return p;
        }
        return all[0] || null;
    }

    // ═══════════════════════════════════════════════════════════════════
    // HUD payload
    // ═══════════════════════════════════════════════════════════════════

    _pushHud() {
        var room = this._rooms[this._currentRoomId] || null;
        var roomCleared = room && room.cleared;
        var roomHint = "";
        if (this._phase === "victory") roomHint = "You escaped the cellar.";
        else if (this._phase === "defeat") roomHint = "You fell in the dark.";
        else if (room) {
            if (room.kind === "start") roomHint = "Pick a door — the cellar awaits.";
            else if (room.kind === "shop") roomHint = "Take what you need.";
            else if (room.kind === "boss") roomHint = roomCleared ? "Step on the green pad to escape." : "The Cellar Wretch.";
            else if (room.kind === "combat") roomHint = roomCleared ? "Cleared. Press onward." : "Clear the room to open doors.";
        }

        var aliveCount = 0;
        for (var k in this._enemiesAlive) aliveCount++;

        this.scene.events.ui.emit("hud_update", {
            cellarPurge: {
                health: this._health,
                maxHealth: this._maxHealth,
                coins: this._coins,
                bombs: this._bombs,
                keys: this._keys,
                floor: this._floor,
                fireRate: this.scene._cpFireRate || this._initialFireRate,
                tearDamage: this.scene._cpTearDamage || this._tearDamage,
                roomKind: room ? room.kind : "",
                roomHint: roomHint,
                phase: this._phase,
                aliveEnemies: aliveCount,
                bossActive: !!this._bossEntityId,
                bossHp: this._bossEntityId && this._enemiesAlive[this._bossEntityId] ? this._enemiesAlive[this._bossEntityId].hp : 0,
                bossMaxHp: this._bossMaxHp,
            },
        });
    }
}
