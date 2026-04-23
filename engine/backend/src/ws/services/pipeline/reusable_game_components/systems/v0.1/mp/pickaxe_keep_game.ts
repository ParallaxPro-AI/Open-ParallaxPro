// also: mining-sandbox, crafting, inventory, grid-based, procedural-terrain
// Pickaxe Keep — 2.5D sidescroll mining + crafting + survival sandbox.
//
// World model: a sparse grid of 1m cubes living on the z=0 action plane.
// Block coordinates are integer (x, y) cells; the system maintains a
// `cellId(x,y) -> { type, entityId }` map and resolves clicks against it.
// Block entities are spawned at runtime via scene.createEntity so we
// don't pre-allocate thousands of placements in the world JSON.
//
// Authority model:
//   - Host generates the opening world (terrain + ore pockets) on
//     match_started and broadcasts it as net_pk_world_init. Late joiners
//     get a re-broadcast on mp_host_changed / mp_roster_changed.
//   - Block mutations (mine / place) fire local-first on the acting
//     peer and broadcast as net_pk_block_*; every peer's grid follows.
//     Inventory is per-peer, never broadcast — your items are yours.
//   - Enemies are host-authoritative: spawning, movement, death. Hosts
//     send periodic position snapshots (net_pk_enemy_update) and one-off
//     spawn / kill events.
//   - Day / night clock is host-driven; net_pk_time_sync at 1 Hz keeps
//     every peer's HUD + ambient color aligned without dead reckoning.
//
// Single-player works without changes: the !mp branches just don't fire,
// and onStart self-elects as the authority since there are no peers to
// coordinate with.
class PickaxeKeepGameSystem extends GameScript {
    // ─── Tunable parameters ──────────────────────────────────────────
    _worldHalfWidth = 32;     // grid spans x in [-half, +half]
    _worldHeight = 30;        // grid spans y in [0, height]
    _surfaceMid = 18;         // average ground height
    _surfaceVar = 3;          // amplitude of surface roll
    _bedrockY = 1;            // unbreakable bottom row
    _hotbarSlots = 9;
    _maxHealth = 100;
    _enemyMaxHealth = 30;
    _enemyDamage = 12;
    _enemyContactRange = 1.6;
    _enemySpeed = 2.4;
    _maxEnemies = 8;
    _nightSpawnInterval = 4.0;
    _dayDurationSec = 180;
    _nightDurationSec = 120;
    _twilightDurationSec = 12;
    _interactRange = 5;
    _attackDamage = 18;
    _respawnDelaySec = 4.0;
    _treeChance = 0.06;
    _torchLightRadius = 5;
    _matchDurationSec = 1200; // soft cap — game just keeps going past this
    _winScore = 5000;         // points threshold for victory
    _enemyUpdateInterval = 0.2;
    _hudUpdateInterval = 0.15;
    _timeSyncInterval = 1.0;

    // Block tier metadata. `tier` controls what pickaxe is needed; mining
    // a block adds the named drop (defaults to the same name) to the
    // miner's inventory. unbreakable blocks (tier=99) form the bedrock.
    _blockTypes = {
        air:       { tier: 0,  drop: "",         hardness: 0,   color: [0,0,0,0],         hp: 0   },
        grass:     { tier: 1,  drop: "dirt",     hardness: 0.6, color: [0.30,0.62,0.27,1], hp: 1  },
        dirt:      { tier: 1,  drop: "dirt",     hardness: 0.5, color: [0.45,0.30,0.22,1], hp: 1  },
        stone:     { tier: 1,  drop: "stone",    hardness: 1.4, color: [0.42,0.42,0.46,1], hp: 3  },
        coal:      { tier: 2,  drop: "coal",     hardness: 1.6, color: [0.18,0.18,0.20,1], hp: 4  },
        iron:      { tier: 2,  drop: "iron",     hardness: 2.0, color: [0.78,0.62,0.42,1], hp: 5  },
        gold:      { tier: 3,  drop: "gold",     hardness: 2.4, color: [1.00,0.82,0.20,1], hp: 6  },
        diamond:   { tier: 4,  drop: "diamond",  hardness: 3.0, color: [0.30,0.85,0.95,1], hp: 8  },
        wood:      { tier: 1,  drop: "wood",     hardness: 0.8, color: [0.43,0.27,0.16,1], hp: 2  },
        leaf:      { tier: 0,  drop: "wood",     hardness: 0.3, color: [0.18,0.45,0.18,1], hp: 1  },
        plank:     { tier: 1,  drop: "plank",    hardness: 0.9, color: [0.62,0.43,0.24,1], hp: 2  },
        brick:     { tier: 1,  drop: "brick",    hardness: 1.2, color: [0.62,0.30,0.25,1], hp: 3  },
        torch:     { tier: 0,  drop: "torch",    hardness: 0.2, color: [1.00,0.85,0.40,1], hp: 1  },
        bedrock:   { tier: 99, drop: "",         hardness: 99,  color: [0.20,0.20,0.22,1], hp: 999 },
    };
    _toolTier = {
        "":               1,
        "wood_pickaxe":   1,
        "stone_pickaxe":  2,
        "iron_pickaxe":   3,
        "gold_pickaxe":   3,
        "diamond_pickaxe":4,
        "wood_sword":     1,
        "stone_sword":    1,
        "iron_sword":     1,
    };
    _placeable = {  // hotbar items that drop a block when right-clicked
        dirt:  "dirt",
        stone: "stone",
        wood:  "wood",
        plank: "plank",
        brick: "brick",
        coal:  "coal",
        iron:  "iron",
        gold:  "gold",
        diamond:"diamond",
        torch: "torch",
    };
    _recipes = {
        plank:           { wood: 1, _yields: 4 },
        wood_pickaxe:    { wood: 3, _yields: 1 },
        wood_sword:      { wood: 2, _yields: 1 },
        stone_pickaxe:   { wood: 2, stone: 3, _yields: 1 },
        stone_sword:     { wood: 1, stone: 2, _yields: 1 },
        iron_pickaxe:    { wood: 2, iron: 3, _yields: 1 },
        iron_sword:      { wood: 1, iron: 2, _yields: 1 },
        gold_pickaxe:    { wood: 2, gold: 3, _yields: 1 },
        diamond_pickaxe: { wood: 2, diamond: 3, _yields: 1 },
        torch:           { wood: 1, coal: 1, _yields: 4 },
        brick:           { stone: 4, _yields: 1 },
    };

    // ─── Runtime state ──────────────────────────────────────────────
    _grid = {};               // "x,y" -> { type, entityId }
    _enemies = {};            // enemyId -> { entityId, type, x, y, vx, hp, target }
    _nextEnemyId = 1;
    _inventory = [];          // 27-slot grid: each cell { item, count } or null
    _hotbarSelected = 0;
    _health = 100;
    _dead = false;
    _respawnTimer = 0;
    _score = 0;               // simple "wealth" score from mining + kills
    _initialized = false;
    _ended = false;
    _elapsed = 0;
    _enemyUpdateTimer = 0;
    _hudTimer = 0;
    _timeSyncTimer = 0;
    _spawnTimer = 0;
    _phaseClock = 0;          // seconds into current day or night phase
    _phase = "day";
    _localPos = null;

    onStart() {
        var self = this;

        // Stash on scene so other scripts can read shared state.
        this.scene._pkGrid = this._grid;
        this.scene._pkPhase = this._phase;
        this.scene._pkBlockTypes = this._blockTypes;

        this._initInventory();
        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });

        // ── Player intents from block_interactor ──
        this.scene.events.game.on("pk_intent_mine",  function(data) { self._onMineIntent(data || {}); });
        this.scene.events.game.on("pk_intent_place", function(data) { self._onPlaceIntent(data || {}); });
        this.scene.events.game.on("pk_intent_attack", function(data) { self._onAttackIntent(data || {}); });
        this.scene.events.game.on("pk_hotbar_selected", function(data) {
            var s = (data && typeof data.slot === "number") ? data.slot : 0;
            if (s < 0) s = 0;
            if (s >= self._hotbarSlots) s = self._hotbarSlots - 1;
            self._hotbarSelected = s;
            self._pushHud();
        });
        // Inventory toggle simply tracked here — the HUD listens too.
        this.scene.events.game.on("pk_toggle_inventory", function() {
            self._inventoryOpen = !self._inventoryOpen;
            self._pushHud();
        });

        // Crafting UI lives in hud/pickaxe_inventory.html. Each recipe
        // button postMessages { action: "craft", recipe: "..." }, which
        // the html_ui_manager tags with panel and ui_bridge re-emits as
        // ui_event:hud/pickaxe_inventory:craft.
        this.scene.events.ui.on("ui_event:hud/pickaxe_inventory:craft", function(data) {
            self._onCraftRequest(data && data.recipe);
        });
        // Also accept a slot-swap drag from the inventory panel: drag from
        // bag slot A to hotbar slot B. Useful for promoting a freshly
        // crafted pickaxe into a hotbar slot without reopening the panel.
        this.scene.events.ui.on("ui_event:hud/pickaxe_inventory:swap", function(data) {
            if (!data) return;
            self._swapSlots(Number(data.from), Number(data.to));
        });
        // Inventory close button on the panel itself.
        this.scene.events.ui.on("ui_event:hud/pickaxe_inventory:close", function() {
            self._inventoryOpen = false;
            self.scene.events.game.emit("pk_toggle_inventory", {});
        });

        // ── Networked events ──
        this.scene.events.game.on("net_pk_world_init", function(evt) {
            var d = (evt && evt.data) || {};
            if (Array.isArray(d.blocks)) self._applyWorldInit(d.blocks);
        });
        this.scene.events.game.on("net_pk_block_mined", function(evt) {
            var d = (evt && evt.data) || {};
            if (typeof d.x !== "number" || typeof d.y !== "number") return;
            self._removeBlockLocally(d.x, d.y);
        });
        this.scene.events.game.on("net_pk_block_placed", function(evt) {
            var d = (evt && evt.data) || {};
            if (typeof d.x !== "number" || typeof d.y !== "number" || !d.blockType) return;
            self._spawnBlockLocally(d.x, d.y, d.blockType);
        });
        this.scene.events.game.on("net_pk_enemy_spawned", function(evt) {
            var d = (evt && evt.data) || {};
            if (d.enemyId == null || !d.enemyType) return;
            self._spawnEnemyLocally(d.enemyId, d.enemyType, Number(d.x) || 0, Number(d.y) || 0);
        });
        this.scene.events.game.on("net_pk_enemy_killed", function(evt) {
            var d = (evt && evt.data) || {};
            if (d.enemyId == null) return;
            self._removeEnemyLocally(d.enemyId);
        });
        this.scene.events.game.on("net_pk_enemy_update", function(evt) {
            var d = (evt && evt.data) || {};
            if (Array.isArray(d.updates)) self._applyEnemyUpdates(d.updates);
        });
        this.scene.events.game.on("net_pk_time_sync", function(evt) {
            var d = (evt && evt.data) || {};
            if (typeof d.phaseClock === "number") self._phaseClock = d.phaseClock;
            if (typeof d.phase === "string")      self._phase = d.phase;
            self.scene._pkPhase = self._phase;
            self._applyAmbient();
        });
        this.scene.events.game.on("net_pk_player_damaged", function(evt) {
            var d = (evt && evt.data) || {};
            var mp2 = self.scene._mp;
            if (!mp2) return;
            if (d.targetPeerId !== mp2.localPeerId) return;
            self._takeDamage(Number(d.damage) || self._enemyDamage, d.source || "enemy");
        });

        // ── Session lifecycle ──
        this.scene.events.game.on("mp_host_changed", function() {
            if (self._ended || !self._initialized) return;
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            self._broadcastWorldInit();  // catch up other peers
        });
        this.scene.events.game.on("mp_roster_changed", function() {
            if (self._initialized) self._ensureRemoteProxies();
            var mp2 = self.scene._mp;
            if (!mp2 || !mp2.isHost) return;
            // Re-broadcast world init to catch a brand-new joiner.
            self._broadcastWorldInit();
            self._broadcastEnemiesSnapshot();
        });
    }

    onUpdate(dt) {
        if (!this._initialized) return;
        this._elapsed += dt;
        this._localPos = this._readLocalPos();

        // Day / night clock — host owns the canonical clock; clients
        // tick locally between syncs so the HUD stays smooth.
        this._phaseClock += dt;
        var phaseLen = (this._phase === "day") ? this._dayDurationSec : this._nightDurationSec;
        if (this._phaseClock >= phaseLen) {
            this._phaseClock -= phaseLen;
            this._phase = (this._phase === "day") ? "night" : "day";
            this.scene._pkPhase = this._phase;
            this._applyAmbient();
            this.scene.events.game.emit("pk_time_changed", { time: this._phaseClock, phase: this._phase });
        }

        // Local death + respawn
        if (this._dead) {
            this._respawnTimer -= dt;
            if (this._respawnTimer <= 0) this._respawnLocal();
        }

        // Host-only logic: enemies, time sync, win check
        var mp = this.scene._mp;
        if (!mp || mp.isHost) {
            this._tickEnemies(dt);
            this._spawnTimer -= dt;
            if (this._phase === "night" && this._spawnTimer <= 0 && this._enemyCount() < this._maxEnemies) {
                this._spawnTimer = this._nightSpawnInterval;
                this._hostSpawnNightEnemy();
            }
            this._enemyUpdateTimer += dt;
            if (this._enemyUpdateTimer >= this._enemyUpdateInterval) {
                this._enemyUpdateTimer = 0;
                this._broadcastEnemiesSnapshot();
            }
            this._timeSyncTimer += dt;
            if (this._timeSyncTimer >= this._timeSyncInterval) {
                this._timeSyncTimer = 0;
                this._broadcastTimeSync();
            }
            if (!this._ended && this._score >= this._winScore) {
                this._endMatch("score");
            }
        }

        this._hudTimer += dt;
        if (this._hudTimer >= this._hudUpdateInterval) {
            this._hudTimer = 0;
            this._pushHud();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Match lifecycle
    // ═══════════════════════════════════════════════════════════════════

    _initMatch() {
        var mp = this.scene._mp;

        // Reset bookkeeping but leave behaviors in place.
        this._wipeWorld();
        this._wipeEnemies();
        this._initInventory();
        this._giveStarterKit();
        this._health = this._maxHealth;
        this._dead = false;
        this._respawnTimer = 0;
        this._score = 0;
        this._elapsed = 0;
        this._spawnTimer = this._nightSpawnInterval;
        this._phaseClock = 0;
        this._phase = "day";
        this.scene._pkPhase = this._phase;
        this._ended = false;
        this._inventoryOpen = false;

        if (!mp || mp.isHost) {
            this._hostGenerateWorld();
            this._broadcastWorldInit();
        }

        this._teleportLocalToSpawn();
        this._stampLocalNetworkIdentity();
        this._ensureRemoteProxies();
        this._applyAmbient();
        this._initialized = true;
        this._pushHud();
    }

    _endMatch(reason) {
        this._ended = true;
        var mp = this.scene._mp;
        var payload = { reason: reason, score: this._score, peerId: mp ? mp.localPeerId : "" };
        if (mp) mp.sendNetworkedEvent("match_ended", payload);
        this.scene.events.game.emit("match_ended", { reason: reason });
        this._pushGameOver(reason);
        if (mp && mp.isHost && mp.endMatch) mp.endMatch();
    }

    _pushGameOver(reason) {
        var stats = {};
        stats["Score"] = String(this._score);
        stats["Time alive"] = this._formatTime(this._elapsed);
        stats["Reason"] = reason === "score" ? "Reached " + this._winScore + " points"
                       : reason === "death" ? "Died for good"
                       : "Stopped";
        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: reason === "score" ? "STRONGHOLD ESTABLISHED" : "RUN ENDED", score: this._score, stats: stats },
        });
    }

    _formatTime(sec) {
        var m = Math.floor(sec / 60);
        var s = Math.floor(sec % 60);
        return m + ":" + (s < 10 ? "0" : "") + s;
    }

    // ═══════════════════════════════════════════════════════════════════
    // World generation
    // ═══════════════════════════════════════════════════════════════════

    _hostGenerateWorld() {
        // Surface curve: gentle sine + per-column random jitter so each
        // column lands in a believable rolling-hills profile.
        for (var x = -this._worldHalfWidth; x <= this._worldHalfWidth; x++) {
            var surface = Math.round(this._surfaceMid + Math.sin(x * 0.18) * this._surfaceVar + (Math.random() * 2 - 1));
            for (var y = this._bedrockY; y <= surface; y++) {
                var type;
                if (y === this._bedrockY) type = "bedrock";
                else if (y >= surface)    type = "grass";
                else if (y >= surface - 3) type = "dirt";
                else                      type = this._oreOrStone(y);
                this._placeBlock(x, y, type);
            }

            // Surface trees. Skip if the spawn area or where it would
            // collide with another tree's leaves.
            if (Math.random() < this._treeChance && Math.abs(x) > 4) {
                this._plantTree(x, surface + 1);
            }
        }
    }

    _oreOrStone(y) {
        // Deeper = rarer + better ore. Probabilities tuned so the
        // backfill is ~94% stone with the rest as ores.
        var depth = this._surfaceMid - y;
        var r = Math.random();
        if (depth > 12 && r < 0.012) return "diamond";
        if (depth > 8  && r < 0.025) return "gold";
        if (depth > 4  && r < 0.055) return "iron";
        if (depth > 2  && r < 0.085) return "coal";
        return "stone";
    }

    _plantTree(x, baseY) {
        var height = 3 + Math.floor(Math.random() * 3);
        for (var h = 0; h < height; h++) this._placeBlock(x, baseY + h, "wood");
        // Crown of leaves — small cluster around the top.
        var crownY = baseY + height;
        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = 0; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                this._placeBlock(x + dx, crownY + dy, "leaf");
            }
        }
        this._placeBlock(x, crownY + 1, "leaf");
    }

    // Internal place that bypasses authority + range checks — used by
    // host worldgen, peer net broadcasts, and the placement ack path.
    _placeBlock(x, y, type) {
        var key = x + "," + y;
        if (this._grid[key]) return;
        var entId = this._spawnBlockEntity(x, y, type);
        this._grid[key] = { type: type, entityId: entId };
    }

    _spawnBlockEntity(x, y, type) {
        var meta = this._blockTypes[type];
        if (!meta) return null;
        var scene = this.scene;
        if (!scene.createEntity) return null;
        var entId = scene.createEntity("Block_" + x + "_" + y);
        if (entId == null) return null;
        scene.setPosition(entId, x, y, 0);
        scene.setScale && scene.setScale(entId, 1, 1, 1);
        scene.addComponent(entId, "MeshRendererComponent", {
            meshType: "cube",
            baseColor: meta.color,
        });
        // Bedrock + dirt + stone get static colliders so the player
        // can stand on them. Leaves + torches are passable.
        if (type !== "leaf" && type !== "torch") {
            scene.addComponent(entId, "RigidbodyComponent", {
                bodyType: "static",
                mass: 1,
                freezeRotation: true,
            });
            scene.addComponent(entId, "ColliderComponent", {
                shapeType: "cuboid",
                size: { x: 1, y: 1, z: 1 },
            });
        }
        if (scene.addTag) {
            scene.addTag(entId, "pk_block");
            scene.addTag(entId, "pk_block_" + type);
        }
        return entId;
    }

    _removeBlockLocally(x, y) {
        var key = x + "," + y;
        var b = this._grid[key];
        if (!b) return;
        try { this.scene.destroyEntity && this.scene.destroyEntity(b.entityId); } catch (e) {}
        delete this._grid[key];
    }

    _spawnBlockLocally(x, y, type) {
        var key = x + "," + y;
        if (this._grid[key]) return;
        this._placeBlock(x, y, type);
    }

    _wipeWorld() {
        for (var key in this._grid) {
            try { this.scene.destroyEntity && this.scene.destroyEntity(this._grid[key].entityId); } catch (e) {}
        }
        this._grid = {};
        this.scene._pkGrid = this._grid;
    }

    _broadcastWorldInit() {
        var mp = this.scene._mp;
        if (!mp) return;
        var blocks = [];
        for (var key in this._grid) {
            var parts = key.split(",");
            blocks.push({ x: Number(parts[0]), y: Number(parts[1]), type: this._grid[key].type });
        }
        mp.sendNetworkedEvent("pk_world_init", { blocks: blocks });
    }

    _applyWorldInit(blocks) {
        this._wipeWorld();
        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            if (typeof b.x !== "number" || typeof b.y !== "number" || !b.type) continue;
            this._placeBlock(b.x, b.y, b.type);
        }
        var mp = this.scene._mp;
        if (mp && !mp.isHost) this._teleportLocalToSpawn();
    }

    // ═══════════════════════════════════════════════════════════════════
    // Mining + placing
    // ═══════════════════════════════════════════════════════════════════

    _onMineIntent(data) {
        if (this._dead) return;
        var x = Math.round(data.x), y = Math.round(data.y);
        var key = x + "," + y;
        var b = this._grid[key];
        if (!b) return;

        var meta = this._blockTypes[b.type];
        if (!meta) return;
        if (meta.tier >= 99) return;  // bedrock / unbreakable

        // Range check — distance from our local player to the block center.
        if (!this._withinInteractRange(x, y)) return;

        // Tier check — what's our equipped tool?
        var tool = this._activeHotbarItem();
        var toolTier = this._toolTier[tool] != null ? this._toolTier[tool] : 1;
        if (meta.tier > toolTier) return;  // need a stronger pickaxe

        // Apply locally + broadcast.
        this._removeBlockLocally(x, y);
        if (meta.drop) {
            this._addToInventory(meta.drop, 1);
            this._score += this._scoreForBlock(b.type);
        }
        var mp = this.scene._mp;
        if (mp) mp.sendNetworkedEvent("pk_block_mined", {
            x: x, y: y, peerId: mp.localPeerId, blockType: b.type,
        });
        this.scene.events.game.emit("pk_block_mined", {
            x: x, y: y, blockType: b.type, peerId: mp ? mp.localPeerId : "",
        });

        // Pleasing impact sound — tier-tinted so iron clinks heavier.
        this._playMineSfx(b.type);
        this._pushHud();
    }

    _onPlaceIntent(data) {
        if (this._dead) return;
        var x = Math.round(data.x), y = Math.round(data.y);
        if (x < -this._worldHalfWidth || x > this._worldHalfWidth) return;
        if (y < this._bedrockY || y > this._worldHeight) return;
        if (this._grid[x + "," + y]) return;        // already occupied
        if (!this._withinInteractRange(x, y)) return;

        // Don't let the player wall themselves in — block must not be
        // inside our hitbox.
        if (this._localPos) {
            var dx = (x + 0.5) - this._localPos.x;
            var dy = (y + 0.5) - this._localPos.y;
            if (dx * dx + dy * dy < 0.9 * 0.9) return;
        }

        var item = this._activeHotbarItem();
        var blockType = this._placeable[item];
        if (!blockType) return;
        if (!this._consumeFromInventory(item, 1)) return;

        this._spawnBlockLocally(x, y, blockType);
        var mp = this.scene._mp;
        if (mp) mp.sendNetworkedEvent("pk_block_placed", {
            x: x, y: y, blockType: blockType, peerId: mp.localPeerId,
        });
        this.scene.events.game.emit("pk_block_placed", {
            x: x, y: y, blockType: blockType, peerId: mp ? mp.localPeerId : "",
        });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaserDown1.ogg", 0.4);
        this._pushHud();
    }

    _onAttackIntent(data) {
        if (this._dead) return;
        // Find any enemy whose cell matches the click. We scan O(N) — at
        // _maxEnemies = 8 that's nothing.
        var tx = data.x, ty = data.y;
        var nearestId = null, nearestDist = Infinity;
        for (var id in this._enemies) {
            var e = this._enemies[id];
            var dx = e.x - tx;
            var dy = e.y - ty;
            var d2 = dx * dx + dy * dy;
            if (d2 < 1.5 * 1.5 && d2 < nearestDist) {
                nearestDist = d2;
                nearestId = id;
            }
        }
        if (!nearestId) return;
        // Range check vs our local player position.
        if (!this._withinInteractRange(this._enemies[nearestId].x, this._enemies[nearestId].y)) return;
        // Attack damage scaled if we hold a sword.
        var tool = this._activeHotbarItem();
        var dmg = this._attackDamage;
        if (tool === "iron_sword")   dmg = 30;
        if (tool === "stone_sword")  dmg = 24;
        if (tool === "wood_sword")   dmg = 20;
        this._damageEnemy(nearestId, dmg);
    }

    _scoreForBlock(type) {
        if (type === "diamond") return 60;
        if (type === "gold")    return 25;
        if (type === "iron")    return 12;
        if (type === "coal")    return 6;
        if (type === "stone")   return 2;
        return 1;
    }

    _playMineSfx(type) {
        if (!this.audio) return;
        var sfx;
        if (type === "wood" || type === "leaf" || type === "plank") {
            sfx = "/assets/kenney/audio/impact_sounds/footstep_carpet_001.ogg";
        } else {
            sfx = "/assets/kenney/audio/impact_sounds/footstep_concrete_001.ogg";
        }
        this.audio.playSound(sfx, 0.45);
    }

    _withinInteractRange(x, y) {
        if (!this._localPos) return false;
        var dx = (x + 0.5) - this._localPos.x;
        var dy = (y + 0.5) - this._localPos.y;
        return (dx * dx + dy * dy) <= this._interactRange * this._interactRange;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Inventory + crafting
    // ═══════════════════════════════════════════════════════════════════

    _initInventory() {
        this._inventory = [];
        for (var i = 0; i < 27; i++) this._inventory.push(null);
    }

    _giveStarterKit() {
        this._addToInventory("wood_pickaxe", 1);
        this._addToInventory("wood_sword", 1);
        this._addToInventory("torch", 4);
        this._hotbarSelected = 0;
    }

    _addToInventory(item, count) {
        if (!item || !count) return;
        // Stack with an existing slot first, then fill empty slots.
        for (var i = 0; i < this._inventory.length; i++) {
            var slot = this._inventory[i];
            if (slot && slot.item === item && slot.count < 99) {
                var spare = 99 - slot.count;
                var add = Math.min(spare, count);
                slot.count += add;
                count -= add;
                if (count <= 0) break;
            }
        }
        for (var j = 0; j < this._inventory.length && count > 0; j++) {
            if (!this._inventory[j]) {
                var add2 = Math.min(99, count);
                this._inventory[j] = { item: item, count: add2 };
                count -= add2;
            }
        }
        this.scene.events.game.emit("pk_item_collected", { item: item, count: count });
        this.scene.events.game.emit("pk_inventory_changed", {});
    }

    _consumeFromInventory(item, need) {
        // Count first — only consume if we have enough.
        var have = 0;
        for (var i = 0; i < this._inventory.length; i++) {
            var s = this._inventory[i];
            if (s && s.item === item) have += s.count;
            if (have >= need) break;
        }
        if (have < need) return false;
        var rem = need;
        for (var j = 0; j < this._inventory.length && rem > 0; j++) {
            var s2 = this._inventory[j];
            if (s2 && s2.item === item) {
                var take = Math.min(s2.count, rem);
                s2.count -= take;
                rem -= take;
                if (s2.count <= 0) this._inventory[j] = null;
            }
        }
        this.scene.events.game.emit("pk_inventory_changed", {});
        return true;
    }

    _activeHotbarItem() {
        var slot = this._inventory[this._hotbarSelected];
        if (!slot) return "";
        return slot.item || "";
    }

    // Crafting — driven by ui_event:pickaxe_crafting:craft messages from
    // the inventory HUD. The HUD button posts { action:"craft", recipe }.
    _onCraftRequest(recipe) {
        var rec = this._recipes[recipe];
        if (!rec) return;
        // Verify materials.
        for (var ing in rec) {
            if (ing === "_yields") continue;
            var have = this._countItem(ing);
            if (have < rec[ing]) {
                this.scene.events.game.emit("pk_craft_attempted", { recipe: recipe });
                return;
            }
        }
        for (var ing2 in rec) {
            if (ing2 === "_yields") continue;
            this._consumeFromInventory(ing2, rec[ing2]);
        }
        this._addToInventory(recipe, rec._yields || 1);
        this.scene.events.game.emit("pk_craft_succeeded", { recipe: recipe });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_004.ogg", 0.5);
    }

    _countItem(item) {
        var n = 0;
        for (var i = 0; i < this._inventory.length; i++) {
            var s = this._inventory[i];
            if (s && s.item === item) n += s.count;
        }
        return n;
    }

    _swapSlots(from, to) {
        if (!isFinite(from) || !isFinite(to)) return;
        if (from < 0 || to < 0 || from >= this._inventory.length || to >= this._inventory.length) return;
        var tmp = this._inventory[from];
        this._inventory[from] = this._inventory[to];
        this._inventory[to] = tmp;
        this.scene.events.game.emit("pk_inventory_changed", {});
        this._pushHud();
    }

    // ═══════════════════════════════════════════════════════════════════
    // Player position + damage + respawn
    // ═══════════════════════════════════════════════════════════════════

    _readLocalPos() {
        var p = this._findLocalPlayerEntity();
        if (!p) return null;
        var pos = p.transform.position;
        return { x: pos.x, y: pos.y, z: pos.z };
    }

    _findLocalPlayerEntity() {
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < all.length; i++) {
            var p = all[i];
            var ni = p.getComponent("NetworkIdentityComponent");
            if (ni && ni.isLocalPlayer) return p;
        }
        return all[0] || null;
    }

    _stampLocalNetworkIdentity() {
        var mp = this.scene._mp;
        if (!mp) return;
        var p = this._findLocalPlayerEntity();
        if (!p) return;
        var ni = p.getComponent("NetworkIdentityComponent");
        if (ni) {
            ni.networkId = this._hashPeerId(mp.localPeerId);
            ni.ownerId = mp.localPeerId;
            ni.isLocalPlayer = true;
        }
    }

    // Pre-spawn a scene entity per remote peer with a matching networkId so
    // the adapter's snapshot flow binds to our entity (which uses the real
    // player model) instead of falling back to the blue capsule proxy that
    // its prefab-resolution path drops to on the host.
    _ensureRemoteProxies() {
        var mp = this.scene._mp;
        if (!mp || !mp.roster || !mp.roster.peers) return;
        for (var i = 0; i < mp.roster.peers.length; i++) {
            var peerId = mp.roster.peers[i].peerId;
            if (!peerId || peerId === mp.localPeerId) continue;
            var netId = this._hashPeerId(peerId);
            var existing = this._findRemoteProxyEntity(netId);
            if (existing) {
                var mr = existing.getComponent ? existing.getComponent("MeshRendererComponent") : null;
                if (mr && mr.meshType === "custom") continue;
                // Adapter raced ahead and spawned a plain capsule — replace it.
                if (this.scene.destroyEntity) this.scene.destroyEntity(existing.id);
            }
            this._createRemotePlayerProxy(peerId, netId);
        }
    }

    _findRemoteProxyEntity(netId) {
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("networked") : [];
        for (var i = 0; i < all.length; i++) {
            var ni = all[i].getComponent("NetworkIdentityComponent");
            if (ni && ni.networkId === netId && !ni.isLocalPlayer) return all[i];
        }
        return null;
    }

    _createRemotePlayerProxy(peerId, netId) {
        if (!this.scene.createEntity) return;
        var entId = this.scene.createEntity("RemotePlayer_" + peerId);
        if (entId == null) return;
        var spawnY = this._surfaceMid + this._surfaceVar + 8;
        this.scene.setPosition(entId, 0, spawnY, 0);
        this.scene.addComponent(entId, "MeshRendererComponent", {
            meshType: "custom",
            meshAsset: "/assets/quaternius/3d_models/cube_world/Character_Male_1.glb",
            baseColor: [1, 1, 1, 1],
        });
        this.scene.addComponent(entId, "RigidbodyComponent", {
            bodyType: "kinematic",
            mass: 70,
            freezeRotation: true,
        });
        this.scene.addComponent(entId, "ColliderComponent", {
            shapeType: "capsule",
            radius: 0.5,
            height: 1.0,
        });
        this.scene.addComponent(entId, "NetworkIdentityComponent", {
            networkId: netId,
            ownerId: peerId,
            isLocalPlayer: false,
            syncTransform: true,
        });
        if (this.scene.addTag) {
            this.scene.addTag(entId, "player");
            this.scene.addTag(entId, "remote");
            this.scene.addTag(entId, "networked");
        }
    }

    _teleportLocalToSpawn() {
        var p = this._findLocalPlayerEntity();
        if (!p) return;
        var pos = this._computeSpawnPos();
        this.scene.setPosition(p.id, pos.x, pos.y, 0);
    }

    // Spread players along x using roster slot so they don't stack, and
    // drop them from well above max surface/tree height so they land on
    // terrain even if the block grid hasn't streamed in yet. Non-host
    // peers start with an empty grid — the world_floor_plate at y=0
    // still catches them while they wait for net_pk_world_init.
    _computeSpawnPos() {
        var mp = this.scene._mp;
        var slot = 0, count = 1;
        if (mp && mp.roster && mp.roster.peers) {
            var ids = mp.roster.peers.map(function(pp) { return pp.peerId; }).sort();
            var idx = ids.indexOf(mp.localPeerId);
            if (idx >= 0) { slot = idx; count = Math.max(1, ids.length); }
        }
        var x = (slot - (count - 1) / 2) * 2;
        var y = this._surfaceMid + this._surfaceVar + 8;
        return { x: x, y: y };
    }

    _takeDamage(amount, source) {
        if (this._dead) return;
        this._health -= amount;
        if (this._health <= 0) {
            this._health = 0;
            this._dead = true;
            this._respawnTimer = this._respawnDelaySec;
            this.scene.events.game.emit("player_died", {});
            // Drop a small fraction of inventory? Skip for now — keep
            // sandbox feel forgiving; just reset health on respawn.
        }
        this.scene.events.game.emit("pk_player_hurt", { amount: amount, source: source });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/footstep_concrete_004.ogg", 0.4);
    }

    _respawnLocal() {
        this._dead = false;
        this._health = this._maxHealth;
        this._teleportLocalToSpawn();
        this.scene.events.game.emit("player_respawned", {});
    }

    // ═══════════════════════════════════════════════════════════════════
    // Enemies (host-authoritative)
    // ═══════════════════════════════════════════════════════════════════

    _enemyCount() {
        var n = 0;
        for (var k in this._enemies) n++;
        return n;
    }

    _hostSpawnNightEnemy() {
        // Spawn off the player's view, on the surface.
        var px = this._localPos ? this._localPos.x : 0;
        var side = Math.random() < 0.5 ? -1 : 1;
        var x = px + side * (12 + Math.random() * 4);
        if (x < -this._worldHalfWidth + 1) x = -this._worldHalfWidth + 1;
        if (x >  this._worldHalfWidth - 1) x =  this._worldHalfWidth - 1;
        // Find ground at that column.
        var y = this._surfaceAtColumn(Math.round(x)) + 1.2;
        var id = this._nextEnemyId++;
        this._spawnEnemyLocally(id, "zombie", x, y);
        var mp = this.scene._mp;
        if (mp) mp.sendNetworkedEvent("pk_enemy_spawned", {
            enemyId: id, enemyType: "zombie", x: x, y: y,
        });
    }

    _surfaceAtColumn(x) {
        for (var y = this._worldHeight; y >= this._bedrockY; y--) {
            if (this._grid[x + "," + y]) return y;
        }
        return this._bedrockY;
    }

    _spawnEnemyLocally(id, type, x, y) {
        if (this._enemies[id]) return;
        var entId = this.scene.createEntity ? this.scene.createEntity("Enemy_" + id) : null;
        if (entId == null) return;
        this.scene.setPosition(entId, x, y, 0);
        var color = type === "zombie" ? [0.35, 0.55, 0.32, 1] : [0.85, 0.85, 0.78, 1];
        this.scene.setScale && this.scene.setScale(entId, 0.8, 1.6, 0.8);
        this.scene.addComponent(entId, "MeshRendererComponent", {
            meshType: "cube",
            baseColor: color,
        });
        this.scene.addComponent(entId, "RigidbodyComponent", {
            bodyType: "kinematic",
            mass: 50,
            freezeRotation: true,
        });
        this.scene.addComponent(entId, "ColliderComponent", {
            shapeType: "cuboid",
            size: { x: 0.8, y: 1.6, z: 0.8 },
        });
        if (this.scene.addTag) {
            this.scene.addTag(entId, "pk_enemy");
            this.scene.addTag(entId, "pk_enemy_" + type);
        }
        this._enemies[id] = {
            entityId: entId,
            type: type,
            x: x, y: y, vx: 0,
            hp: this._enemyMaxHealth,
            attackCooldown: 0,
        };
        this.scene.events.game.emit("pk_enemy_spawned", { enemyId: id, enemyType: type });
    }

    _removeEnemyLocally(id) {
        var e = this._enemies[id];
        if (!e) return;
        try { this.scene.destroyEntity && this.scene.destroyEntity(e.entityId); } catch (ex) {}
        delete this._enemies[id];
        this.scene.events.game.emit("pk_enemy_killed", { enemyId: id });
    }

    _wipeEnemies() {
        for (var id in this._enemies) {
            try { this.scene.destroyEntity && this.scene.destroyEntity(this._enemies[id].entityId); } catch (e) {}
        }
        this._enemies = {};
    }

    _damageEnemy(id, amount) {
        var e = this._enemies[id];
        if (!e) return;
        e.hp -= amount;
        if (e.hp <= 0) {
            // Loot drop into our inventory + score.
            this._addToInventory("coal", 1);
            if (Math.random() < 0.25) this._addToInventory("iron", 1);
            this._score += 35;
            var mp = this.scene._mp;
            if (mp) mp.sendNetworkedEvent("pk_enemy_killed", { enemyId: id });
            this._removeEnemyLocally(id);
            if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/phaserDown2.ogg", 0.5);
        }
    }

    _tickEnemies(dt) {
        var px = this._localPos ? this._localPos.x : 0;
        var py = this._localPos ? this._localPos.y : 0;
        for (var id in this._enemies) {
            var e = this._enemies[id];
            // Walk toward player, simple gravity drop to ground.
            var dx = px - e.x;
            var ay = this._surfaceAtColumn(Math.round(e.x)) + 1.0;
            var move = Math.sign(dx) * this._enemySpeed * dt;
            // Don't overshoot.
            if (Math.abs(move) > Math.abs(dx)) move = dx;
            e.x += move;
            // Smooth-snap to surface above current column.
            e.y += (ay - e.y) * Math.min(1, dt * 6);
            this.scene.setPosition(e.entityId, e.x, e.y, 0);

            // Contact damage
            e.attackCooldown -= dt;
            var d2 = (px - e.x) * (px - e.x) + (py - e.y) * (py - e.y);
            if (d2 < this._enemyContactRange * this._enemyContactRange && e.attackCooldown <= 0) {
                e.attackCooldown = 1.0;
                // Single-player vs multiplayer: in MP host damages a
                // specific peer; in SP we damage ourselves directly.
                var mp = this.scene._mp;
                if (mp) {
                    mp.sendNetworkedEvent("pk_player_damaged", {
                        targetPeerId: this._closestPeerId(e.x, e.y),
                        damage: this._enemyDamage,
                        source: "zombie",
                    });
                    this._takeDamage(this._enemyDamage, "zombie");
                } else {
                    this._takeDamage(this._enemyDamage, "zombie");
                }
            }

            // Sun damage: zombies burn during the day.
            if (this._phase === "day") {
                e.hp -= dt * 8;
                if (e.hp <= 0) {
                    var mp2 = this.scene._mp;
                    if (mp2) mp2.sendNetworkedEvent("pk_enemy_killed", { enemyId: id });
                    this._removeEnemyLocally(id);
                }
            }
        }
    }

    _closestPeerId(x, y) {
        // We only know our own player's exact position; remote proxies
        // sync via transforms. For damage routing we approximate by the
        // nearest player tag.
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        var bestId = null;
        var bestD = Infinity;
        for (var i = 0; i < all.length; i++) {
            var p = all[i];
            var ni = p.getComponent("NetworkIdentityComponent");
            var pos = p.transform.position;
            var dx = pos.x - x, dy = pos.y - y;
            var d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; bestId = ni && ni.ownerId; }
        }
        return bestId;
    }

    _broadcastEnemiesSnapshot() {
        var mp = this.scene._mp;
        if (!mp) return;
        var updates = [];
        for (var id in this._enemies) {
            var e = this._enemies[id];
            updates.push({ enemyId: Number(id), x: e.x, y: e.y });
        }
        if (updates.length > 0) mp.sendNetworkedEvent("pk_enemy_update", { updates: updates });
    }

    _applyEnemyUpdates(updates) {
        for (var i = 0; i < updates.length; i++) {
            var u = updates[i];
            var e = this._enemies[u.enemyId];
            if (!e) continue;
            e.x = Number(u.x) || e.x;
            e.y = Number(u.y) || e.y;
            this.scene.setPosition(e.entityId, e.x, e.y, 0);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // Day / night ambient
    // ═══════════════════════════════════════════════════════════════════

    _broadcastTimeSync() {
        var mp = this.scene._mp;
        if (!mp) return;
        mp.sendNetworkedEvent("pk_time_sync", { phase: this._phase, phaseClock: this._phaseClock });
    }

    _applyAmbient() {
        // The HUD shows the icon; the actual lighting is tinted via the
        // ambient settings in 03_worlds.json that the editor honors. We
        // poke a property here so anything listening can react.
        this.scene._pkPhase = this._phase;
    }

    // ═══════════════════════════════════════════════════════════════════
    // HUD payload
    // ═══════════════════════════════════════════════════════════════════

    _pushHud() {
        var hotbar = [];
        for (var i = 0; i < this._hotbarSlots; i++) {
            var slot = this._inventory[i];
            hotbar.push(slot ? { item: slot.item, count: slot.count } : null);
        }
        var bag = [];
        for (var j = this._hotbarSlots; j < this._inventory.length; j++) {
            var s = this._inventory[j];
            bag.push(s ? { item: s.item, count: s.count } : null);
        }
        // Recipe affordability map for the crafting panel.
        var recipes = [];
        for (var name in this._recipes) {
            var rec = this._recipes[name];
            var ings = [];
            var ok = true;
            for (var ing in rec) {
                if (ing === "_yields") continue;
                var have = this._countItem(ing);
                ings.push({ item: ing, need: rec[ing], have: have });
                if (have < rec[ing]) ok = false;
            }
            recipes.push({ name: name, ingredients: ings, yields: rec._yields || 1, available: ok });
        }
        var phaseLen = (this._phase === "day") ? this._dayDurationSec : this._nightDurationSec;
        var phaseProgress = Math.min(1, this._phaseClock / phaseLen);
        var depth = this._localPos ? Math.max(0, this._surfaceMid - Math.round(this._localPos.y)) : 0;

        this.scene.events.ui.emit("hud_update", {
            pickaxeKeep: {
                hotbar: hotbar,
                hotbarSelected: this._hotbarSelected,
                inventory: bag,
                recipes: recipes,
                inventoryOpen: this._inventoryOpen === true,
                health: Math.round(this._health),
                maxHealth: this._maxHealth,
                dead: this._dead,
                respawnIn: Math.max(0, this._respawnTimer),
                phase: this._phase,
                phaseProgress: phaseProgress,
                score: this._score,
                winScore: this._winScore,
                depth: depth,
                enemyCount: this._enemyCount(),
            },
        });
    }

    _hashPeerId(peerId) {
        var h = 2166136261;
        for (var i = 0; i < peerId.length; i++) {
            h ^= peerId.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return ((h >>> 0) % 1000000) + 1000;
    }
}
