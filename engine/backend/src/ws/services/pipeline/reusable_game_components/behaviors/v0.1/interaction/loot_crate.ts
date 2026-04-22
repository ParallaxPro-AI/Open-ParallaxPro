// also: item-pickup, collectible, drop, rewards, inventory
// Loot crate — on-ground pickup that triggers when the local player
// overlaps its radius.
//
// Used for weapons, ammo, medkits, armor, etc. in top-down action
// games. The actual gameplay effect is owned by the match system —
// this behavior only detects overlap, plays a pickup sound, and emits
// a local + networked event with the loot payload.
//
// Behavior params:
//   lootId       — stable id the system uses for dedupe & tracking.
//   lootKind     — "weapon" | "ammo" | "medkit" | "bandage" | "armor"
//   lootPayload  — arbitrary object forwarded to the system on pickup
//                  (e.g. { weaponId: "pistol", ammo: 12 }).
//   radius       — pickup radius in world units.
//   autoPickup   — if true, overlap alone triggers; if false, requires
//                  the player to press E near the crate.
//
// Crates live on every peer; to keep them in sync after pickup we
// listen for net_royale_loot_picked and deactivate the same lootId.
class LootCrateBehavior extends GameScript {
    _behaviorName = "loot_crate";

    _lootId = "";
    _lootKind = "ammo";
    _lootPayload = null;
    _radius = 1.4;
    _autoPickup = true;

    _consumed = false;
    _lookupTimer = 0;
    _localPlayer = null;
    _pulseT = 0;
    _prevPickupPressed = false;

    onStart() {
        var self = this;
        this.entity._royaleLootId = this._lootId;
        this.scene.events.game.on("net_royale_loot_picked", function(evt) {
            var d = (evt && evt.data) || {};
            if (d.lootId && d.lootId === self._lootId) self._markConsumed();
        });
        this.scene.events.game.on("royale_loot_picked_local", function(data) {
            var d = data || {};
            if (d.lootId && d.lootId === self._lootId) self._markConsumed();
        });
        this.scene.events.game.on("royale_match_reset", function() {
            self._consumed = false;
            self.entity.active = true;
        });
    }

    onUpdate(dt) {
        if (this._consumed) return;
        this._pulseT += dt;
        this._pulse();

        this._lookupTimer -= dt;
        if (!this._localPlayer || this._lookupTimer <= 0) {
            this._localPlayer = this._findLocalPlayer();
            this._lookupTimer = 0.5;
        }
        var p = this._localPlayer;
        if (!p) return;
        if (p._shooterAlive === false) return;

        var a = this.entity.transform.position;
        var b = p.transform.position;
        var dx = a.x - b.x, dz = a.z - b.z;
        var distSq = dx * dx + dz * dz;
        if (distSq > this._radius * this._radius) {
            this._prevPickupPressed = false;
            return;
        }

        // Either overlap or explicit E press, per params.
        if (this._autoPickup) {
            this._requestPickup();
            return;
        }

        var nowE = this.input && this.input.isKeyDown && (this.input.isKeyDown("KeyE") || this.input.isKeyDown("KeyF"));
        if (nowE && !this._prevPickupPressed) {
            this._requestPickup();
        }
        this._prevPickupPressed = nowE;
    }

    _requestPickup() {
        if (this._consumed) return;
        this._consumed = true; // optimistic — match system may reject
        this.scene.events.game.emit("royale_pickup_request", {
            lootId: this._lootId,
            lootKind: this._lootKind,
            payload: this._lootPayload,
            x: this.entity.transform.position.x,
            z: this.entity.transform.position.z,
        });
    }

    _markConsumed() {
        this._consumed = true;
        if (this.entity) this.entity.active = false;
    }

    _pulse() {
        // Gentle bob + glow pulse so crates are visible at distance.
        var mr = this.entity.getComponent ? this.entity.getComponent("MeshRendererComponent") : null;
        if (!mr) return;
        var k = 0.6 + 0.3 * Math.sin(this._pulseT * 3);
        if (mr.emissiveIntensity !== undefined) {
            mr.emissiveIntensity = 0.6 + 0.4 * k;
        }
        // Vertical bob on y — keeps the crate readable on a busy map.
        var pos = this.entity.transform.position;
        if (pos && this.entity._royaleBaseY === undefined) this.entity._royaleBaseY = pos.y;
        if (pos && this.entity._royaleBaseY !== undefined) {
            pos.y = this.entity._royaleBaseY + 0.12 * Math.sin(this._pulseT * 2.4);
            this.entity.transform.markDirty && this.entity.transform.markDirty();
        }
    }

    _findLocalPlayer() {
        var all = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < all.length; i++) {
            var e = all[i];
            var ni = e.getComponent ? e.getComponent("NetworkIdentityComponent") : null;
            if (!ni) return e;
            if (ni.isLocalPlayer) return e;
        }
        return null;
    }
}
