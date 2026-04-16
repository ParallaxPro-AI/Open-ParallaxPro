// Multiplayer hitscan weapon behavior — per-player loadout + fire loop.
//
// Attaches to the local player; stores an inventory of weapon slots
// where each slot is a parameterized weapon definition (rpm, damage,
// spread, range, magCapacity, reloadSeconds, projectileSpeed, sound).
//
// Responsibilities:
//   - Track equipped slot, ammo per slot, reserve ammo per caliber,
//     reload timer, fire cooldown.
//   - On royale_fire_start + while held: fire at scene._shooterMouseAim
//     at the weapon's cadence; broadcast net_royale_shot with tracer
//     endpoints so every peer renders the beam + plays the bang.
//   - On hit, resolve victim locally (find nearest player entity along
//     the ray) and emit royale_damage_local for the match system. The
//     match system owns the authoritative tally and broadcasts the
//     final kill resolution.
//   - Handle reload (R) and slot-switch (royale_switch_slot).
//
// Reusable: every weapon is parameterizable (see defaultLoadout). A
// game that wants a different feel just passes a different loadout in
// the behavior params.
class MpHitscanWeaponBehavior extends GameScript {
    _behaviorName = "mp_hitscan_weapon";

    _defaultLoadout = null; // injected via params — see 02_entities.json

    _slots = [];
    _slotIndex = 0;
    _reserveAmmo = {};
    _fireTimer = 0;
    _reloadTimer = 0;
    _reloadingSlot = -1;
    _firing = false;
    _initialized = false;

    onStart() {
        var self = this;
        // Only the local player's weapon behavior owns input → network.
        // Remote proxies keep an instance too so they can play the fire
        // sound for remote shots received via net_royale_shot without
        // involving the system.
        this._loadLoadout();

        this.scene.events.game.on("royale_fire_start", function() {
            if (!self._isLocal()) return;
            if (self._shouldBlockInput()) return;
            self._firing = true;
        });
        this.scene.events.game.on("royale_fire_stop", function() {
            self._firing = false;
        });
        this.scene.events.game.on("royale_reload_pressed", function() {
            if (!self._isLocal()) return;
            if (self._shouldBlockInput()) return;
            self._startReload();
        });
        this.scene.events.game.on("royale_switch_slot", function(data) {
            if (!self._isLocal()) return;
            if (self._shouldBlockInput()) return;
            var d = data || {};
            self._switchSlot(typeof d.slot === "number" ? d.slot : 0);
        });
        // Match system sets a new loadout after loot pickup.
        this.scene.events.game.on("royale_loadout_set", function(data) {
            if (!self._isLocal()) return;
            var d = data || {};
            if (d.slots) self._slots = d.slots;
            if (typeof d.index === "number") self._slotIndex = d.index;
            if (d.reserveAmmo) self._reserveAmmo = d.reserveAmmo;
            self._pushHud();
        });
        // Remote peer fired — play the sound + emit a fire-visual event
        // the system can render as a tracer.
        this.scene.events.game.on("net_royale_shot", function(evt) {
            var d = (evt && evt.data) || {};
            // Play bang if the shot came from someone else.
            if (self.audio && d.weaponSound) {
                self.audio.playSound(d.weaponSound, 0.4);
            }
        });
        this.scene.events.game.on("royale_match_reset", function() {
            self._loadLoadout();
            self._firing = false;
            self._reloadingSlot = -1;
            self._reloadTimer = 0;
            self._fireTimer = 0;
        });
    }

    onUpdate(dt) {
        if (!this._initialized) return;
        if (!this._isLocal()) return;

        if (this._fireTimer > 0) this._fireTimer = Math.max(0, this._fireTimer - dt);

        // Reload in progress → tick timer, finish when done.
        if (this._reloadingSlot >= 0) {
            this._reloadTimer -= dt;
            if (this._reloadTimer <= 0) this._finishReload();
            this._pushHud();
        }

        if (this._shouldBlockInput()) return;
        if (!this._firing) return;
        if (this._reloadingSlot >= 0) return;

        var slot = this._slots[this._slotIndex];
        if (!slot) return;
        if (this._fireTimer > 0) return;

        if (slot.ammo <= 0 && slot.magCapacity > 0) {
            // Auto-reload when trying to fire empty, like most shooters.
            this._startReload();
            return;
        }
        // Fire a single shot. Rate of fire is enforced by _fireTimer.
        this._fireOnce(slot);
        this._fireTimer = 60 / Math.max(30, slot.rpm || 400);
    }

    _fireOnce(slot) {
        var aim = this.scene._shooterMouseAim;
        if (!aim) return;

        // Slight spread — random jitter inside a cone.
        var spread = (slot.spread || 0) * (Math.PI / 180);
        var jitter = (Math.random() - 0.5) * spread;
        var cos = Math.cos(jitter), sin = Math.sin(jitter);
        var dx = aim.dx * cos - aim.dz * sin;
        var dz = aim.dx * sin + aim.dz * cos;

        var pos = this.entity.transform.position;
        var originX = pos.x + dx * 0.6;
        var originZ = pos.z + dz * 0.6;
        var range = slot.range || 25;
        var hitX = originX + dx * range;
        var hitZ = originZ + dz * range;

        // Local hit resolution — find closest enemy in the ray segment.
        var hit = this._rayPlayers(originX, originZ, dx, dz, range);
        var victimPeerId = "";
        var dealtDamage = 0;
        if (hit) {
            hitX = hit.x; hitZ = hit.z;
            victimPeerId = hit.ownerId || "";
            dealtDamage = slot.damage || 0;
            this.scene.events.game.emit("royale_damage_local", {
                victimPeerId: victimPeerId,
                damage: dealtDamage,
                weapon: slot.id || "",
                x: hitX, z: hitZ,
            });
        }

        // Consume ammo.
        if (slot.magCapacity > 0) slot.ammo = Math.max(0, slot.ammo - 1);

        // Broadcast the shot so peers render the tracer + play sound.
        var mp = this.scene._mp;
        if (mp) {
            mp.sendNetworkedEvent("royale_shot", {
                originX: originX, originZ: originZ,
                endX: hitX, endZ: hitZ,
                weapon: slot.id || "",
                weaponSound: slot.fireSound || "",
                shooterPeerId: mp.localPeerId,
                victimPeerId: victimPeerId,
                damage: dealtDamage,
            });
        }

        if (this.audio && slot.fireSound) {
            this.audio.playSound(slot.fireSound, slot.fireVolume || 0.45);
        }

        this.scene.events.game.emit("weapon_fired", {
            ammo: slot.ammo,
            reserve: this._reserveAmmo[slot.caliber] || 0,
            weapon: slot.id,
        });
        this._pushHud();
    }

    _rayPlayers(ox, oz, dx, dz, range) {
        // Naive O(n) scan across all player entities — small peer count
        // makes the simpler code worthwhile. We check distance from the
        // player to the ray, then along the ray so we get the nearest
        // actual intersection.
        var players = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        var hitRadius = 0.6; // approximate player capsule radius
        var bestT = range;
        var best = null;
        var mp = this.scene._mp;
        var myPid = mp && mp.localPeerId;
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            var ni = p.getComponent ? p.getComponent("NetworkIdentityComponent") : null;
            if (!ni) continue;
            if (ni.isLocalPlayer) continue;
            if (p._shooterAlive === false) continue;
            var pp = p.transform.position;
            var vx = pp.x - ox;
            var vz = pp.z - oz;
            var t = vx * dx + vz * dz;
            if (t < 0 || t > range) continue;
            // Distance from player center to the ray segment at t.
            var px = ox + dx * t, pz = oz + dz * t;
            var ex = pp.x - px, ez = pp.z - pz;
            var dist = Math.sqrt(ex * ex + ez * ez);
            if (dist > hitRadius) continue;
            if (t < bestT) {
                bestT = t;
                best = { x: px, z: pz, ownerId: ni.ownerId || "" };
            }
        }
        return best;
    }

    _startReload() {
        var slot = this._slots[this._slotIndex];
        if (!slot) return;
        if (slot.magCapacity <= 0) return;
        if (slot.ammo >= slot.magCapacity) return;
        var reserve = this._reserveAmmo[slot.caliber] || 0;
        if (reserve <= 0) return;
        if (this._reloadingSlot >= 0) return;
        this._reloadingSlot = this._slotIndex;
        this._reloadTimer = slot.reloadSeconds || 1.5;
        if (this.audio && slot.reloadSound) {
            this.audio.playSound(slot.reloadSound, 0.4);
        }
    }

    _finishReload() {
        var slot = this._slots[this._reloadingSlot];
        this._reloadingSlot = -1;
        this._reloadTimer = 0;
        if (!slot) return;
        var reserve = this._reserveAmmo[slot.caliber] || 0;
        var want = Math.max(0, (slot.magCapacity || 0) - slot.ammo);
        var give = Math.min(reserve, want);
        slot.ammo = slot.ammo + give;
        this._reserveAmmo[slot.caliber] = reserve - give;
        this.scene.events.game.emit("reload_complete", { ammo: slot.ammo });
        this._pushHud();
    }

    _switchSlot(idx) {
        if (idx < 0 || idx >= this._slots.length) return;
        if (idx === this._slotIndex) return;
        this._slotIndex = idx;
        // Cancel any in-progress reload on the old slot.
        this._reloadingSlot = -1;
        this._reloadTimer = 0;
        this._firing = false;
        this._fireTimer = 0.2;
        var slot = this._slots[idx];
        if (slot) {
            this.scene.events.game.emit("weapon_swapped", { weapon: slot.id || "" });
            if (this.audio && slot.swapSound) {
                this.audio.playSound(slot.swapSound, 0.35);
            }
        }
        this._pushHud();
    }

    _pushHud() {
        var slot = this._slots[this._slotIndex];
        var slotsOut = [];
        for (var i = 0; i < this._slots.length; i++) {
            var s = this._slots[i];
            if (!s) { slotsOut.push(null); continue; }
            slotsOut.push({
                id: s.id || "",
                label: s.label || s.id || "",
                ammo: s.ammo,
                magCapacity: s.magCapacity,
                caliber: s.caliber || "",
                reserve: this._reserveAmmo[s.caliber] || 0,
            });
        }
        this.scene.events.ui.emit("hud_update", {
            _royaleWeapon: {
                slots: slotsOut,
                active: this._slotIndex,
                reloading: this._reloadingSlot >= 0,
                reloadTimer: this._reloadTimer,
                currentLabel: slot ? (slot.label || slot.id) : "Fists",
            },
        });
    }

    _isLocal() {
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        return !ni || ni.isLocalPlayer;
    }

    _shouldBlockInput() {
        return !!this.scene._shooterFrozen || this.entity._shooterAlive === false;
    }

    _loadLoadout() {
        // Build a concrete runtime loadout from the default spec.
        var src = this._defaultLoadout || [];
        var slots = [];
        var reserve = {};
        for (var i = 0; i < src.length; i++) {
            var w = src[i];
            if (!w) { slots.push(null); continue; }
            slots.push({
                id: w.id || "slot" + i,
                label: w.label || w.id || "",
                rpm: w.rpm || 300,
                damage: w.damage || 8,
                spread: w.spread || 3,
                range: w.range || 22,
                magCapacity: w.magCapacity || 0,
                ammo: (typeof w.ammo === "number") ? w.ammo : (w.magCapacity || 0),
                caliber: w.caliber || "",
                reloadSeconds: w.reloadSeconds || 1.2,
                fireSound: w.fireSound || "",
                reloadSound: w.reloadSound || "",
                swapSound: w.swapSound || "",
                fireVolume: w.fireVolume || 0.45,
            });
        }
        this._slots = slots;
        this._slotIndex = 0;
        this._reserveAmmo = reserve;
        this._initialized = true;
        this._pushHud();
    }
}
