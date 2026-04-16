// Shooter Royale — peer-to-peer top-down battle royale match rules.
//
// Match flow:
//   warmup      host generates loot layout + broadcasts; 1-2s settle time.
//   playing     players shoot, loot, dodge the shrinking storm; host
//               ticks the storm + damage-outside check on a cadence.
//   ended       last alive reported; UI bridge flips to game_over.
//
// Authority model (similar to the other mp systems in this folder):
//   Host owns: initial loot layout, storm radius/center over time,
//              match start/end decisions, final placements.
//   All peers: apply every broadcast authoritatively (loot pickups,
//              damage tallies, kill resolutions). Peers are trusted to
//              report their own damage taken — fine for friendly MP.
//
// Most game knobs are params on the system (see 04_systems.json) so a
// different top-down shooter can reuse this system unchanged.
class ShooterRoyaleGameSystem extends GameScript {
    // ── Config (from 04_systems.json params) ───────────────────────
    _warmupSec = 2.0;
    _maxMatchSec = 420; // hard safety cap
    _stormStartDelaySec = 18;
    _stormShrinkSec = 160;
    _stormMinRadius = 6;
    _stormStartRadius = 60;
    _stormDamagePerTick = 6;
    _stormTickInterval = 1.0;
    _maxHealth = 100;
    _maxArmor = 100;
    _spawnRadius = 50;
    _lootCrateBaseEntity = "loot_crate_weapon";
    _fistLoadout = null;
    _killFeedMaxLines = 8;
    _startingWeapon = null;
    _lootPool = [];   // pool of pickups the host spawns (see params)
    _lootCount = 60;
    _bandageHeal = 18;
    _medkitHeal = 60;
    _armorVestValue = 50;

    // ── Match state (mirrored on every peer) ───────────────────────
    _phase = "idle";
    _phaseTimer = 0;
    _matchElapsed = 0;
    _initialized = false;
    _matchEnded = false;
    _pendingMatchStartAt = 0;

    _hp = {};       // peerId → health
    _armor = {};    // peerId → armor
    _alive = {};    // peerId → bool
    _deathTime = {}; // peerId → match elapsed at death (for placement ranking)
    _loadouts = {}; // peerId → { slots, index, reserve }
    _peerStats = {};// peerId → { kills, damage }
    _killFeed = []; // [{ killer, victim, weapon, t }]

    _lootSpawned = false;
    _lootEntityNames = {}; // lootId → entity name spawned locally

    _stormCenter = { x: 0, z: 0 };
    _stormRadius = 60;
    _stormNextTickAt = 0;
    _stormPhase = "idle";     // "idle" | "warning" | "shrinking" | "final"
    _stormShrinkFrom = 60;
    _stormShrinkTo = 6;
    _stormShrinkStart = 0;

    _shotVisualQueue = [];    // [{ originX, originZ, endX, endZ, expireAt }]

    onStart() {
        var self = this;

        this.scene.events.game.on("match_started", function() {
            self._pendingMatchStartAt = 0.2;
        });

        // ── Host broadcasts the loot layout + match params; peers apply.
        this.scene.events.game.on("net_royale_loot_layout", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyLootLayout(d);
        });

        // Periodic storm tick broadcast from host.
        this.scene.events.game.on("net_royale_storm_tick", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyStormTick(d);
        });

        // Peer loot pickup — first-come-first-served by the emit order;
        // every peer applies the dedupe via its _lootEntityNames map.
        this.scene.events.game.on("net_royale_loot_picked", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.lootId || !d.pickerPeerId) return;
            self._applyLootPicked(d.pickerPeerId, d.lootId, d.kind, d.payload);
        });

        // Shot broadcasts → render tracer + shooter tracking.
        this.scene.events.game.on("net_royale_shot", function(evt) {
            var d = (evt && evt.data) || {};
            self._queueShotVisual(d);
        });

        // Kill resolution — after a peer's local damage computation
        // kills a victim, the victim's peer broadcasts their death;
        // every peer applies it to the leaderboard / kill feed.
        this.scene.events.game.on("net_royale_player_died", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.victimPeerId) return;
            self._applyPlayerDeath(d.victimPeerId, d.killerPeerId || "", d.weapon || "", d.storm === true);
        });

        // Damage ping — shooters broadcast damage after a local hitscan
        // resolves a victim. Each peer applies damage to its own hp
        // mirror so the scoreboard + kill feed stay consistent; the
        // victim's peer is the one that actually broadcasts death.
        this.scene.events.game.on("net_royale_damage", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.victimPeerId) return;
            self._applyIncomingDamage(d.victimPeerId, d.shooterPeerId || "", d.damage || 0, d.weapon || "", false);
        });

        // Heal broadcast — doubles as a "peer used a medkit/bandage" sync.
        this.scene.events.game.on("net_royale_heal", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.peerId) return;
            self._hp[d.peerId] = Math.min(self._maxHealth, (self._hp[d.peerId] || 0) + (d.amount || 0));
            self._pushScoreboard();
        });

        // Armor gain broadcast.
        this.scene.events.game.on("net_royale_armor", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.peerId) return;
            self._armor[d.peerId] = Math.max(self._armor[d.peerId] || 0, d.amount || 0);
            self._pushScoreboard();
        });

        // End-of-match authoritative broadcast.
        this.scene.events.game.on("net_royale_match_ended", function(evt) {
            var d = (evt && evt.data) || {};
            self._endMatchOnPeers(d);
        });

        // ── Local input intents ──
        this.scene.events.game.on("royale_damage_local", function(data) {
            self._onLocalDamageDealt(data || {});
        });
        this.scene.events.game.on("royale_heal_pressed", function() {
            self._tryHealSelf();
        });
        this.scene.events.game.on("royale_pickup_request", function(data) {
            self._onPickupRequest(data || {});
        });
        this.scene.events.game.on("royale_pickup_pressed", function(data) {
            // Manual "E/F grab" is also just a pickup_request after the
            // loot_crate behavior forwards its chosen loot. We don't do
            // anything special here — the behavior's auto overlap will
            // still handle the nearest crate. Kept for future use.
        });

        // ── MP lifecycle ──
        this.scene.events.game.on("mp_host_changed", function() {
            self._pushScoreboard();
        });
        this.scene.events.game.on("mp_roster_changed", function() {
            self._pruneDeparted();
            self._pushScoreboard();
            self._maybeCheckWinConditions();
        });
        this.scene.events.game.on("mp_below_min_players", function() {
            if (self._matchEnded) return;
            var mp = self.scene._mp;
            if (!mp || !mp.isHost) return;
            self._endMatchAsHost({ winner: "", reason: "Not enough players" });
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
        if (!this._initialized || this._matchEnded) return;

        this._matchElapsed += dt;
        this._phaseTimer -= dt;

        if (this._phase === "warmup" && this._phaseTimer <= 0) {
            this._enterPhase("playing", -1);
            this.scene._shooterFrozen = false;
        }

        if (this._phase === "playing") {
            this._updateStormHost(dt);
            this._fadeShotVisuals();
            this._advanceStormVisual(dt);
            // Auto-pickup loot when the local player walks over a crate.
            // Runtime-spawned loot entities don't carry the loot_crate
            // behavior (no script-attach API at runtime), so this proximity
            // check lives here.
            this._checkLocalLootPickup();
            var mp = this.scene._mp;
            if (mp && mp.isHost) this._maybeCheckWinConditions();
            if (this._matchElapsed >= this._maxMatchSec && mp && mp.isHost) {
                // Safety net — end by most damage dealt.
                this._endMatchAsHost({ winner: this._findMostDamage(), reason: "Match time elapsed" });
            }
        }

        this._pushHudTick(dt);
    }

    // ─── Match init ──────────────────────────────────────────────────
    _initMatch() {
        var mp = this.scene._mp;
        if (!mp) return;
        var roster = mp.roster;
        if (!roster || !roster.peers || roster.peers.length === 0) return;

        this._resetState();
        // Seed every roster peer as alive so the host's win-condition
        // check (aliveIds.length <= 1) doesn't fire on frame 1. Without
        // this, only the local peer ever lands in `_alive` and the host
        // immediately "wins" at match start.
        for (var rpi = 0; rpi < roster.peers.length; rpi++) {
            var rpid = roster.peers[rpi].peerId;
            this._hp[rpid] = this._maxHealth;
            this._armor[rpid] = 0;
            this._alive[rpid] = true;
            this._peerStats[rpid] = { kills: 0, damage: 0 };
        }
        this._applyNetworkIdentities();
        this._positionLocalPlayer();

        if (mp.isHost) {
            // Host composes the loot layout and broadcasts.
            var layout = this._buildLootLayout();
            mp.sendNetworkedEvent("royale_loot_layout", layout);
            this._applyLootLayout(layout);
            // Start the storm clock.
            this._stormPhase = "warning";
            this._stormShrinkFrom = this._stormStartRadius;
            this._stormShrinkTo = this._stormMinRadius;
        }

        this._initialized = true;
        this.scene._shooterFrozen = true;
        this._enterPhase("warmup", this._warmupSec);
        this._pushScoreboard();
    }

    _resetState() {
        this._phase = "warmup";
        this._phaseTimer = this._warmupSec;
        this._matchElapsed = 0;
        this._matchEnded = false;
        this._hp = {};
        this._armor = {};
        this._alive = {};
        this._deathTime = {};
        this._loadouts = {};
        this._peerStats = {};
        this._killFeed = [];
        this._lootSpawned = false;
        this._clearAllLocalLoot();
        this._lootEntityNames = {};
        this._shotVisualQueue = [];
        this._stormPhase = "idle";
        this._stormRadius = this._stormStartRadius;
        this._stormCenter = { x: 0, z: 0 };
        this._stormNextTickAt = 0;
        this._stormShrinkFrom = this._stormStartRadius;
        this._stormShrinkTo = this._stormMinRadius;
        this._stormShrinkStart = 0;
        this.scene.events.game.emit("royale_match_reset", {});
    }

    _applyNetworkIdentities() {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        var localPeerId = mp && mp.localPeerId;
        if (!roster || !localPeerId) return;
        var player = this._findLocalPlayerEntity();
        if (!player) return;
        var ni = player.getComponent("NetworkIdentityComponent");
        if (ni) {
            ni.networkId = this._hashPeerId(localPeerId);
            ni.ownerId = localPeerId;
            ni.isLocalPlayer = true;
        }
    }

    _positionLocalPlayer() {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        var localPeerId = mp && mp.localPeerId;
        if (!roster || !localPeerId) return;
        var peerIds = roster.peers.map(function(p) { return p.peerId; }).sort();
        var slot = peerIds.indexOf(localPeerId);
        if (slot < 0) slot = 0;
        var count = Math.max(peerIds.length, 4);
        var angle = (slot / count) * Math.PI * 2;
        var R = this._spawnRadius;
        var cx = Math.cos(angle) * R;
        var cz = Math.sin(angle) * R;
        var player = this._findLocalPlayerEntity();
        if (!player) return;
        this.scene.setPosition(player.id, cx, 1, cz);
        player._shooterAlive = true;

        // Initialize local state.
        this._hp[localPeerId] = this._maxHealth;
        this._armor[localPeerId] = 0;
        this._alive[localPeerId] = true;
        this._peerStats[localPeerId] = { kills: 0, damage: 0 };

        // Seed initial loadout (fists slot + optional starting weapon slot).
        var slots = [];
        if (this._fistLoadout) slots.push(this._cloneWeapon(this._fistLoadout));
        if (this._startingWeapon) slots.push(this._cloneWeapon(this._startingWeapon));
        this._loadouts[localPeerId] = {
            slots: slots,
            index: 0,
            reserve: {},
        };
        this.scene.events.game.emit("royale_loadout_set", this._loadouts[localPeerId]);
    }

    _findLocalPlayerEntity() {
        var players = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            var ni = p.getComponent("NetworkIdentityComponent");
            if (ni && ni.isLocalPlayer) return p;
        }
        return players[0] || null;
    }

    _findPlayerEntityByPeer(peerId) {
        var mp = this.scene._mp;
        if (mp && mp.localPeerId === peerId) return this._findLocalPlayerEntity();
        var players = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < players.length; i++) {
            var ni = players[i].getComponent("NetworkIdentityComponent");
            if (ni && ni.ownerId === peerId) return players[i];
        }
        return null;
    }

    // ─── Loot layout ──────────────────────────────────────────────────
    _buildLootLayout() {
        var pool = (this._lootPool && this._lootPool.length) ? this._lootPool : this._defaultLootPool();
        var layout = [];
        var n = this._lootCount || 48;
        for (var i = 0; i < n; i++) {
            var pick = pool[Math.floor(Math.random() * pool.length)];
            var ang = Math.random() * Math.PI * 2;
            // Concentrate loot between the initial storm radius and the
            // map edge so early-game travel feels rewarding.
            var r = 8 + Math.random() * (this._stormStartRadius - 10);
            var x = Math.cos(ang) * r;
            var z = Math.sin(ang) * r;
            layout.push({
                lootId: "L" + i + "_" + (pick.id || pick.kind),
                kind: pick.kind || "ammo",
                payload: pick.payload || pick,
                x: x, z: z,
                entity: pick.entity || this._lootCrateBaseEntity,
                label: pick.label || "",
            });
        }
        return { items: layout };
    }

    _defaultLootPool() {
        // Deliberately tiny fallback so a misconfigured system still
        // produces a playable match. Templates should override via params.
        return [
            { kind: "ammo",   payload: { caliber: "9mm", amount: 40 }, entity: "loot_crate_ammo", label: "9mm Ammo" },
            { kind: "medkit", payload: { heal: 60 },                   entity: "loot_crate_medkit", label: "Medkit" },
        ];
    }

    _applyLootLayout(layout) {
        if (!layout || !layout.items) return;
        if (this._lootSpawned) return;
        this._lootSpawned = true;
        for (var i = 0; i < layout.items.length; i++) {
            this._spawnLootCrate(layout.items[i]);
        }
    }

    _spawnLootCrate(item) {
        var scene = this.scene;
        var name = "RoyaleLoot_" + item.lootId;
        if (scene.findEntityByName && scene.findEntityByName(name)) return;
        var id = scene.createEntity && scene.createEntity(name);
        if (id == null) return;

        var color = this._kindColor(item.kind);
        scene.setPosition(id, item.x, 0.55, item.z);
        scene.setScale && scene.setScale(id, 0.55, 0.55, 0.55);
        scene.addComponent(id, "MeshRendererComponent", {
            meshType: "cube",
            baseColor: [color[0], color[1], color[2], 1],
            emissive: [color[0], color[1], color[2]],
            emissiveIntensity: 1.0,
        });
        // Attach loot metadata on a system-side table — the engine has
        // no `LootMetaComponent` and addComponent throws on unknown
        // types. Lookups happen through this map keyed by lootId, with
        // the entity name as the secondary index so pickup detection
        // can resolve back to the metadata.
        this._lootMeta = this._lootMeta || {};
        this._lootMeta[item.lootId] = {
            lootId: item.lootId,
            kind: item.kind,
            payload: item.payload,
            label: item.label,
            entityName: name,
        };
        if (scene.addTag) {
            scene.addTag(id, "loot");
            scene.addTag(id, "royale_loot");
        }
        // Stash a handle so we can deactivate on pickup.
        this._lootEntityNames[item.lootId] = name;
    }

    _clearAllLocalLoot() {
        var scene = this.scene;
        if (!scene.findEntitiesByTag) return;
        var all = scene.findEntitiesByTag("royale_loot") || [];
        for (var i = 0; i < all.length; i++) {
            if (scene.destroyEntity) scene.destroyEntity(all[i].id);
        }
    }

    _kindColor(kind) {
        switch (kind) {
            case "weapon_pistol":   return [0.9, 0.85, 0.35];
            case "weapon_smg":      return [0.35, 0.85, 0.95];
            case "weapon_shotgun":  return [0.95, 0.45, 0.35];
            case "weapon_rifle":    return [0.55, 0.95, 0.55];
            case "weapon_sniper":   return [0.95, 0.35, 0.95];
            case "ammo":            return [0.9, 0.9, 0.9];
            case "medkit":          return [0.95, 0.25, 0.25];
            case "bandage":         return [0.95, 0.65, 0.65];
            case "armor":           return [0.4, 0.9, 0.95];
            default:                return [0.6, 0.6, 0.6];
        }
    }

    // ─── Pickup + loadout ────────────────────────────────────────────
    _checkLocalLootPickup() {
        var mp = this.scene._mp;
        if (!mp) return;
        var me = mp.localPeerId;
        if (!this._alive[me]) return;
        var player = this._findLocalPlayerEntity();
        if (!player) return;
        var pp = player.transform.position;
        var radiusSq = 1.6 * 1.6; // generous "walked over the crate" zone
        // _lootMeta was populated on spawn (see _spawnLootCrate). Iterate
        // it instead of querying tagged entities so we have the kind +
        // payload right here without an extra lookup table.
        var meta = this._lootMeta || {};
        for (var lootId in meta) {
            var info = meta[lootId];
            if (!info) continue;
            var ent = this.scene.findEntityByName && this.scene.findEntityByName(info.entityName);
            if (!ent || ent.active === false) continue;
            var ep = ent.transform.position;
            var dx = ep.x - pp.x, dz = ep.z - pp.z;
            if (dx * dx + dz * dz > radiusSq) continue;
            // Pickup! Re-use the same path the original behavior would have hit.
            this._onPickupRequest({
                lootId: info.lootId,
                lootKind: info.kind,
                payload: info.payload,
                x: ep.x,
                z: ep.z,
            });
            // Stop after one pickup per tick so we don't grab a stack.
            break;
        }
    }

    _onPickupRequest(data) {
        var mp = this.scene._mp;
        if (!mp) return;
        var me = mp.localPeerId;
        if (!this._alive[me]) return;
        if (this._phase !== "playing" && this._phase !== "warmup") return;
        if (!data.lootId) return;
        // Apply locally + broadcast.
        var ok = this._applyLootPicked(me, data.lootId, data.lootKind || data.kind, data.payload);
        if (ok) {
            mp.sendNetworkedEvent("royale_loot_picked", {
                pickerPeerId: me,
                lootId: data.lootId,
                kind: data.lootKind || data.kind,
                payload: data.payload || null,
            });
            this.scene.events.game.emit("royale_loot_picked_local", {
                lootId: data.lootId,
            });
            if (this.audio) {
                this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_001.ogg", 0.5);
            }
        }
    }

    _applyLootPicked(pickerPeerId, lootId, kind, payload) {
        var name = this._lootEntityNames[lootId];
        if (!name) return false;
        // Deactivate the crate locally (other peers already did or will).
        var ent = this.scene.findEntityByName && this.scene.findEntityByName(name);
        if (ent) ent.active = false;
        delete this._lootEntityNames[lootId];

        // Only the local picker gets inventory changes — other peers just
        // see the crate disappear.
        var mp = this.scene._mp;
        if (!mp || mp.localPeerId !== pickerPeerId) return true;

        var loadout = this._loadouts[pickerPeerId] || { slots: [], index: 0, reserve: {} };
        var changed = false;

        if (kind && kind.indexOf && kind.indexOf("weapon_") === 0) {
            // Replace/insert into the first empty non-fist slot, or
            // overwrite current slot if fully loaded already.
            var newSlot = this._cloneWeapon(payload || {});
            // Try to put into empty slot.
            var placed = false;
            for (var i = 1; i < loadout.slots.length; i++) {
                if (!loadout.slots[i]) { loadout.slots[i] = newSlot; placed = true; loadout.index = i; break; }
            }
            if (!placed) {
                // Append a new slot (cap at 3 total + fists).
                var maxSlots = 4;
                if (loadout.slots.length < maxSlots) {
                    loadout.slots.push(newSlot);
                    loadout.index = loadout.slots.length - 1;
                    placed = true;
                } else {
                    // Replace current non-fist slot.
                    loadout.slots[Math.max(1, loadout.index)] = newSlot;
                    placed = true;
                }
            }
            changed = true;
        } else if (kind === "ammo") {
            var cal = (payload && payload.caliber) || "9mm";
            var amt = (payload && payload.amount) || 20;
            loadout.reserve[cal] = (loadout.reserve[cal] || 0) + amt;
            changed = true;
        } else if (kind === "medkit" || kind === "bandage") {
            var heal = (payload && payload.heal) || (kind === "medkit" ? this._medkitHeal : this._bandageHeal);
            // Store in reserve pool under "_heal"; consumed via H.
            loadout.reserve._heals = (loadout.reserve._heals || 0) + 1;
            loadout.reserve._healAmt = Math.max(loadout.reserve._healAmt || 0, heal);
            changed = true;
        } else if (kind === "armor") {
            var armorAmt = (payload && payload.amount) || this._armorVestValue;
            this._armor[pickerPeerId] = Math.max(this._armor[pickerPeerId] || 0, armorAmt);
            mp.sendNetworkedEvent("royale_armor", {
                peerId: pickerPeerId, amount: this._armor[pickerPeerId],
            });
            changed = true;
        }
        if (changed) {
            this._loadouts[pickerPeerId] = loadout;
            this.scene.events.game.emit("royale_loadout_set", loadout);
            this.scene.events.game.emit("inventory_changed", {});
            this._pushScoreboard();
        }
        return true;
    }

    _cloneWeapon(src) {
        var s = src || {};
        return {
            id: s.id || "weapon",
            label: s.label || s.id || "Weapon",
            rpm: s.rpm || 300,
            damage: s.damage || 10,
            spread: s.spread || 3,
            range: s.range || 22,
            magCapacity: s.magCapacity || 10,
            ammo: (typeof s.ammo === "number") ? s.ammo : (s.magCapacity || 10),
            caliber: s.caliber || "9mm",
            reloadSeconds: s.reloadSeconds || 1.4,
            fireSound: s.fireSound || "",
            reloadSound: s.reloadSound || "",
            swapSound: s.swapSound || "",
            fireVolume: s.fireVolume || 0.45,
        };
    }

    // ─── Heal ─────────────────────────────────────────────────────────
    _tryHealSelf() {
        var mp = this.scene._mp;
        if (!mp) return;
        var me = mp.localPeerId;
        if (!this._alive[me]) return;
        if (this._phase !== "playing") return;
        var loadout = this._loadouts[me];
        if (!loadout || !loadout.reserve) return;
        var heals = loadout.reserve._heals || 0;
        if (heals <= 0) return;
        var amt = loadout.reserve._healAmt || this._bandageHeal;
        if (this._hp[me] >= this._maxHealth) return;
        loadout.reserve._heals = heals - 1;
        if (loadout.reserve._heals <= 0) loadout.reserve._healAmt = 0;
        var prev = this._hp[me];
        this._hp[me] = Math.min(this._maxHealth, prev + amt);
        this.scene.events.game.emit("health_changed", {
            health: this._hp[me], maxHealth: this._maxHealth,
        });
        mp.sendNetworkedEvent("royale_heal", { peerId: me, amount: (this._hp[me] - prev) });
        this.scene.events.game.emit("royale_loadout_set", loadout);
        this._pushScoreboard();
        if (this.audio) {
            this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_003.ogg", 0.45);
        }
    }

    // ─── Damage + kill ───────────────────────────────────────────────
    _onLocalDamageDealt(data) {
        var mp = this.scene._mp;
        if (!mp) return;
        var me = mp.localPeerId;
        if (!this._alive[me]) return;
        if (!data || !data.victimPeerId) return;
        if (!this._alive[data.victimPeerId]) return;
        // Track stats locally.
        this._peerStats[me] = this._peerStats[me] || { kills: 0, damage: 0 };
        this._peerStats[me].damage += (data.damage || 0);

        // Send damage to victim + everyone as a "damage_ping". Each peer
        // resolves their own damage, but we share so the HUD/hit-feed
        // can show feedback on the shooter's side immediately.
        mp.sendNetworkedEvent("royale_damage", {
            shooterPeerId: me,
            victimPeerId: data.victimPeerId,
            damage: data.damage,
            weapon: data.weapon || "",
        });
        // Local damage application if we're the victim (shouldn't happen
        // because friendly fire is allowed but local shouldn't shoot
        // themselves with the hitscan filter — still safe to guard).
        if (data.victimPeerId === me) {
            this._applyIncomingDamage(data.victimPeerId, me, data.damage, data.weapon, false);
        } else {
            // Victim will receive net_royale_damage and apply it.
        }
        this._pushScoreboard();
    }

    _applyIncomingDamage(victimPeerId, shooterPeerId, damage, weapon, fromStorm) {
        if (!this._alive[victimPeerId]) return;
        var remaining = damage;
        var armor = this._armor[victimPeerId] || 0;
        if (armor > 0) {
            var absorbed = Math.min(armor, Math.round(damage * 0.6));
            this._armor[victimPeerId] = armor - absorbed;
            remaining = Math.max(0, damage - absorbed);
        }
        this._hp[victimPeerId] = Math.max(0, (this._hp[victimPeerId] || this._maxHealth) - remaining);
        this._peerStats[shooterPeerId] = this._peerStats[shooterPeerId] || { kills: 0, damage: 0 };
        if (shooterPeerId && shooterPeerId !== victimPeerId) {
            this._peerStats[shooterPeerId].damage += remaining;
        }

        this.scene.events.game.emit("health_changed", {
            health: this._hp[victimPeerId], maxHealth: this._maxHealth,
        });

        if (this._hp[victimPeerId] <= 0) {
            // Victim pronounces their own death to keep consistent
            // placement ranking (death time = receiver-local).
            var mp = this.scene._mp;
            if (mp && mp.localPeerId === victimPeerId) {
                var payload = {
                    victimPeerId: victimPeerId,
                    killerPeerId: shooterPeerId || "",
                    weapon: weapon || "",
                    storm: !!fromStorm,
                };
                mp.sendNetworkedEvent("royale_player_died", payload);
                this._applyPlayerDeath(victimPeerId, shooterPeerId || "", weapon || "", !!fromStorm);
            }
        }
        this._pushScoreboard();
    }

    _applyPlayerDeath(victimPeerId, killerPeerId, weapon, fromStorm) {
        if (!this._alive[victimPeerId]) return;
        this._alive[victimPeerId] = false;
        this._deathTime[victimPeerId] = this._matchElapsed;
        if (killerPeerId && killerPeerId !== victimPeerId) {
            this._peerStats[killerPeerId] = this._peerStats[killerPeerId] || { kills: 0, damage: 0 };
            this._peerStats[killerPeerId].kills += 1;
        }
        var ent = this._findPlayerEntityByPeer(victimPeerId);
        if (ent) ent._shooterAlive = false;

        this._killFeed.unshift({
            killer: this._displayName(killerPeerId) || (fromStorm ? "Storm" : "—"),
            victim: this._displayName(victimPeerId),
            weapon: weapon || (fromStorm ? "storm" : ""),
            t: Math.round(this._matchElapsed),
        });
        if (this._killFeed.length > this._killFeedMaxLines) {
            this._killFeed.length = this._killFeedMaxLines;
        }

        this.scene.events.game.emit("entity_killed", { entityId: ent ? ent.id : 0 });
        var mp = this.scene._mp;
        if (mp && mp.localPeerId === victimPeerId) {
            this.scene.events.game.emit("player_died", { killerPeerId: killerPeerId });
        }
        this._pushScoreboard();
        if (mp && mp.isHost) this._maybeCheckWinConditions();
    }

    // ─── Storm ────────────────────────────────────────────────────────
    _updateStormHost(dt) {
        var mp = this.scene._mp;
        if (!mp || !mp.isHost) return;

        if (this._stormPhase === "warning") {
            if (this._matchElapsed >= this._stormStartDelaySec) {
                this._stormPhase = "shrinking";
                this._stormShrinkStart = this._matchElapsed;
            }
        } else if (this._stormPhase === "shrinking") {
            var t = Math.min(1, (this._matchElapsed - this._stormShrinkStart) / this._stormShrinkSec);
            this._stormRadius = this._stormShrinkFrom + (this._stormShrinkTo - this._stormShrinkFrom) * t;
            if (t >= 1) this._stormPhase = "final";
        }

        this._stormNextTickAt -= dt;
        if (this._stormNextTickAt <= 0) {
            this._stormNextTickAt = this._stormTickInterval;
            // Broadcast tick state so every peer's storm visual + HUD
            // timer stays in sync with the host clock.
            mp.sendNetworkedEvent("royale_storm_tick", {
                phase: this._stormPhase,
                radius: this._stormRadius,
                center: { x: this._stormCenter.x, z: this._stormCenter.z },
                elapsed: this._matchElapsed,
                shrinkStart: this._stormShrinkStart,
                shrinkDuration: this._stormShrinkSec,
                startDelay: this._stormStartDelaySec,
            });
            this._applyStormTick({
                phase: this._stormPhase,
                radius: this._stormRadius,
                center: { x: this._stormCenter.x, z: this._stormCenter.z },
                elapsed: this._matchElapsed,
                shrinkStart: this._stormShrinkStart,
                shrinkDuration: this._stormShrinkSec,
                startDelay: this._stormStartDelaySec,
            });
            // Damage players outside the storm radius.
            this._damageStormOutside();
        }
    }

    _applyStormTick(d) {
        if (!d) return;
        if (d.phase) this._stormPhase = d.phase;
        if (typeof d.radius === "number") this._stormRadius = d.radius;
        if (d.center) this._stormCenter = d.center;
        if (typeof d.shrinkStart === "number") this._stormShrinkStart = d.shrinkStart;
        if (typeof d.shrinkDuration === "number") this._stormShrinkSec = d.shrinkDuration;
        if (typeof d.startDelay === "number") this._stormStartDelaySec = d.startDelay;
    }

    _advanceStormVisual(dt) {
        // Drive the visual storm cylinder scale to match _stormRadius.
        var storm = this.scene.findEntityByName && this.scene.findEntityByName("StormRing");
        if (!storm) return;
        // Base entity scale is (1,1,1); we scale to radius*2 on XZ.
        // Y is kept short so the disc just marks the ground boundary —
        // a tall cylinder fills the top-down camera's view from above
        // when the player is anywhere inside it.
        var r = Math.max(4, this._stormRadius);
        this.scene.setScale && this.scene.setScale(storm.id, r * 2, 0.1, r * 2);
        this.scene.setPosition && this.scene.setPosition(storm.id, this._stormCenter.x, 0.06, this._stormCenter.z);
    }

    _damageStormOutside() {
        var mp = this.scene._mp;
        if (!mp) return;
        var me = mp.localPeerId;
        if (!this._alive[me]) return;
        var player = this._findLocalPlayerEntity();
        if (!player) return;
        var pp = player.transform.position;
        var dx = pp.x - this._stormCenter.x;
        var dz = pp.z - this._stormCenter.z;
        var dist = Math.sqrt(dx * dx + dz * dz);
        if (dist <= this._stormRadius) return;
        // Apply storm damage to ourselves and let the normal death path
        // broadcast if we fall. Storm damage ignores armor (authentic BR).
        var prev = this._hp[me] || 0;
        this._hp[me] = Math.max(0, prev - this._stormDamagePerTick);
        this.scene.events.game.emit("health_changed", {
            health: this._hp[me], maxHealth: this._maxHealth,
        });
        if (this._hp[me] <= 0) {
            var payload = {
                victimPeerId: me,
                killerPeerId: "",
                weapon: "storm",
                storm: true,
            };
            mp.sendNetworkedEvent("royale_player_died", payload);
            this._applyPlayerDeath(me, "", "storm", true);
        }
        this._pushScoreboard();
    }

    // ─── Shot visuals ────────────────────────────────────────────────
    _queueShotVisual(d) {
        if (!d) return;
        var now = Date.now();
        this._shotVisualQueue.push({
            originX: d.originX || 0, originZ: d.originZ || 0,
            endX: d.endX || 0, endZ: d.endZ || 0,
            expireAt: now + 180,
        });
        if (this._shotVisualQueue.length > 48) this._shotVisualQueue.splice(0, 24);
        // Push to HUD as part of the state payload — the HUD renders
        // tracers into its minimap at map-space coordinates.
        this._pushScoreboard();
    }

    _fadeShotVisuals() {
        var now = Date.now();
        while (this._shotVisualQueue.length > 0 && this._shotVisualQueue[0].expireAt < now) {
            this._shotVisualQueue.shift();
        }
    }

    // ─── Win / end ───────────────────────────────────────────────────
    _maybeCheckWinConditions() {
        var mp = this.scene._mp;
        if (!mp || !mp.isHost) return;
        if (this._matchEnded) return;
        if (this._phase === "warmup") return;

        var aliveIds = [];
        var ids = Object.keys(this._alive);
        for (var i = 0; i < ids.length; i++) {
            if (this._alive[ids[i]]) aliveIds.push(ids[i]);
        }
        if (aliveIds.length <= 1) {
            this._endMatchAsHost({
                winner: aliveIds[0] || "",
                reason: aliveIds.length === 1 ? "Last survivor" : "No survivors",
            });
        }
    }

    _findMostDamage() {
        var best = ""; var bestDmg = -1;
        for (var id in this._peerStats) {
            var d = this._peerStats[id].damage || 0;
            if (d > bestDmg) { bestDmg = d; best = id; }
        }
        return best;
    }

    _endMatchAsHost(d) {
        if (this._matchEnded) return;
        var mp = this.scene._mp;
        if (!mp) return;
        var payload = {
            winner: d.winner || "",
            reason: d.reason || "",
            stats: this._peerStats,
            deathTime: this._deathTime,
            aliveAtEnd: this._alive,
        };
        mp.sendNetworkedEvent("royale_match_ended", payload);
        this._endMatchOnPeers(payload);
        if (mp.isHost && mp.endMatch) mp.endMatch();
    }

    _endMatchOnPeers(d) {
        if (this._matchEnded) return;
        this._matchEnded = true;
        this._enterPhase("ended", -1);
        this.scene._shooterFrozen = true;
        this._pushGameOver(d);
        this.scene.events.game.emit("match_ended", {
            reason: d.reason,
            winner: d.winner,
        });
    }

    // ─── HUD / scoreboard ─────────────────────────────────────────────
    _pushScoreboard() {
        var mp = this.scene._mp;
        if (!mp) return;
        var me = mp.localPeerId;
        var roster = mp.roster;
        var peers = (roster && roster.peers) || [];

        var aliveCount = 0;
        var players = [];
        for (var i = 0; i < peers.length; i++) {
            var pr = peers[i];
            var alive = this._alive[pr.peerId] !== false;
            if (alive) aliveCount++;
            players.push({
                peerId: pr.peerId,
                username: pr.username,
                alive: alive,
                kills: (this._peerStats[pr.peerId] || {}).kills || 0,
                damage: Math.round((this._peerStats[pr.peerId] || {}).damage || 0),
                isLocal: pr.peerId === me,
            });
        }
        players.sort(function(a, b) { return b.kills - a.kills || b.damage - a.damage; });

        var stormCountdown = 0;
        if (this._stormPhase === "warning") {
            stormCountdown = Math.max(0, Math.round(this._stormStartDelaySec - this._matchElapsed));
        } else if (this._stormPhase === "shrinking") {
            stormCountdown = Math.max(0, Math.round((this._stormShrinkStart + this._stormShrinkSec) - this._matchElapsed));
        }

        var loadout = this._loadouts[me] || { slots: [], index: 0, reserve: {} };
        var heals = (loadout.reserve && loadout.reserve._heals) || 0;
        var healAmt = (loadout.reserve && loadout.reserve._healAmt) || 0;

        var slotsOut = [];
        for (var j = 0; j < loadout.slots.length; j++) {
            var s = loadout.slots[j];
            if (!s) { slotsOut.push(null); continue; }
            slotsOut.push({
                id: s.id || "",
                label: s.label || s.id || "",
                ammo: s.ammo,
                magCapacity: s.magCapacity,
                caliber: s.caliber || "",
                reserve: (loadout.reserve && loadout.reserve[s.caliber]) || 0,
            });
        }

        var shots = [];
        for (var k = 0; k < this._shotVisualQueue.length; k++) {
            var sh = this._shotVisualQueue[k];
            shots.push({ ox: sh.originX, oz: sh.originZ, ex: sh.endX, ez: sh.endZ });
        }

        // Minimap dots — players, loot count, storm ring.
        var minimap = {
            storm: {
                cx: this._stormCenter.x,
                cz: this._stormCenter.z,
                r: this._stormRadius,
                phase: this._stormPhase,
            },
            players: players.map(function(p) {
                var ent = me && p.peerId === me ? null : null;
                return { peerId: p.peerId, alive: p.alive, isLocal: p.isLocal };
            }),
        };
        // Attach local player world position for the HUD's minimap
        // centering — we skip remote positions (would need per-tick sync).
        var lp = this._findLocalPlayerEntity();
        if (lp && lp.transform) {
            minimap.localX = lp.transform.position.x;
            minimap.localZ = lp.transform.position.z;
        }

        var payload = {
            _royale: {
                phase: this._phase,
                phaseTimer: Math.max(0, Math.round(this._phaseTimer)),
                matchElapsed: Math.round(this._matchElapsed),
                aliveCount: aliveCount,
                totalPlayers: peers.length,
                myHealth: this._hp[me] || 0,
                maxHealth: this._maxHealth,
                myArmor: this._armor[me] || 0,
                maxArmor: this._maxArmor,
                myKills: (this._peerStats[me] || {}).kills || 0,
                myDamage: Math.round((this._peerStats[me] || {}).damage || 0),
                myAlive: this._alive[me] !== false,
                heals: heals,
                healAmt: healAmt,
                players: players,
                killFeed: this._killFeed,
                storm: {
                    phase: this._stormPhase,
                    radius: this._stormRadius,
                    center: this._stormCenter,
                    countdown: stormCountdown,
                },
                loadout: {
                    slots: slotsOut,
                    active: loadout.index,
                },
                shots: shots,
                minimap: minimap,
            },
        };
        this.scene.events.ui.emit("hud_update", payload);
    }

    _pushHudTick(dt) {
        this._hudTickTimer = (this._hudTickTimer || 0) + dt;
        if (this._hudTickTimer < 0.2) return;
        this._hudTickTimer = 0;
        this._pushScoreboard();
    }

    _pushGameOver(d) {
        var mp = this.scene._mp;
        var me = mp && mp.localPeerId;
        var iWon = (d.winner && d.winner === me);
        var winnerName = d.winner ? this._displayName(d.winner) : "No one";
        var title;
        if (iWon) title = "CHICKEN ROYALE";
        else if (d.winner) title = winnerName + " wins the zone";
        else title = "Match Ended";

        // Build placement order: alive at end first, then by reverse
        // death time (later deaths = better placement).
        var mp2 = this.scene._mp;
        var roster = mp2 && mp2.roster;
        var peers = (roster && roster.peers) || [];
        var ranked = peers.slice().sort(function(a, b) {
            var aDead = !(d.aliveAtEnd && d.aliveAtEnd[a.peerId]);
            var bDead = !(d.aliveAtEnd && d.aliveAtEnd[b.peerId]);
            if (aDead !== bDead) return aDead ? 1 : -1;
            var aT = (d.deathTime && d.deathTime[a.peerId]) || 0;
            var bT = (d.deathTime && d.deathTime[b.peerId]) || 0;
            return bT - aT;
        });
        var myPlace = -1;
        for (var i = 0; i < ranked.length; i++) {
            if (ranked[i].peerId === me) { myPlace = i + 1; break; }
        }

        var myStats = (d.stats && d.stats[me]) || {};
        var stats = {
            "Placement": myPlace > 0 ? ("#" + myPlace + " of " + peers.length) : "—",
            "Kills": String(myStats.kills || 0),
            "Damage": String(Math.round(myStats.damage || 0)),
            "Winner": winnerName,
            "Reason": d.reason || "",
        };
        this.scene.events.ui.emit("hud_update", {
            _gameOver: { title: title, score: myPlace > 0 ? (peers.length - myPlace + 1) : 0, stats: stats },
        });
    }

    // ─── Helpers ─────────────────────────────────────────────────────
    _displayName(peerId) {
        var mp = this.scene._mp;
        var roster = mp && mp.roster;
        if (!roster) return String(peerId || "");
        for (var i = 0; i < roster.peers.length; i++) {
            if (roster.peers[i].peerId === peerId) return roster.peers[i].username;
        }
        return String(peerId || "");
    }

    _pruneDeparted() {
        var mp = this.scene._mp;
        if (!mp || !mp.roster) return;
        var present = {};
        for (var i = 0; i < mp.roster.peers.length; i++) present[mp.roster.peers[i].peerId] = true;
        var removed = [];
        for (var id in this._alive) {
            if (!present[id]) removed.push(id);
        }
        for (var r = 0; r < removed.length; r++) {
            this._alive[removed[r]] = false;
        }
    }

    _hashPeerId(peerId) {
        var h = 2166136261;
        for (var i = 0; i < peerId.length; i++) {
            h ^= peerId.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return ((h >>> 0) % 1000000) + 1000;
    }

    _enterPhase(phase, seconds) {
        this._phase = phase;
        this._phaseTimer = seconds;
        this.scene.events.game.emit("phase_changed", { phase: phase });
    }
}
