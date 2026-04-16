// Sea monster — surfacing kraken tentacle that menaces nearby ships.
//
// State machine: hidden (below water) → surfacing → swiping (damages
// ships in range) → submerging → hidden. Repeats on a slow cycle so
// players notice the eyes first, get a chance to maneuver, then have
// to weather a brief attack window. Damage is broadcast via the
// standard entity_damaged event so player ship_health applies it (or,
// in multiplayer, via net_player_shot when the target is a remote
// captain so the target peer is authoritative).
class SeaMonsterBehavior extends GameScript {
    _behaviorName = "sea_monster";
    _detectionRange = 22;
    _attackRange = 8;
    _damage = 22;
    _hiddenY = -2.5;
    _surfacedY = 1.0;
    _surfaceDuration = 1.4;
    _swipeDuration = 1.1;
    _submergeDuration = 1.6;
    _idleDuration = 6;
    _attackInterval = 1.0;       // seconds between damage ticks while swiping
    _maxHealth = 120;
    _spawnSound = "";
    _swipeSound = "";
    _deathSound = "";

    _state = "hidden";
    _stateTimer = 6;
    _attackTimer = 0;
    _health = 120;
    _baseX = 0;
    _baseZ = 0;
    _dead = false;

    onStart() {
        var pos = this.entity.transform && this.entity.transform.position;
        if (pos) {
            this._baseX = pos.x;
            this._baseZ = pos.z;
            if (this.scene.setPosition) this.scene.setPosition(this.entity.id, this._baseX, this._hiddenY, this._baseZ);
        }
        this._health = this._maxHealth;

        var self = this;
        this.scene.events.game.on("entity_damaged", function(data) {
            if (self._dead) return;
            if (!data || data.entityId !== self.entity.id) return;
            self._health -= data.amount || 0;
            if (self._health <= 0) {
                self._dead = true;
                self.entity.active = false;
                if (self._deathSound && self.audio) self.audio.playSound(self._deathSound, 0.55);
                self.scene.events.game.emit("entity_killed", { entityId: self.entity.id });
            }
        });
    }

    onUpdate(dt) {
        if (this._dead || !this.entity.active) return;
        // Sea monsters are deterministic on every peer — picking a target
        // separately on each peer is fine because the behavior is purely
        // visual + emits damage events that the target ships handle on
        // their own side anyway.
        this._stateTimer -= dt;

        switch (this._state) {
            case "hidden":
                if (this._stateTimer <= 0 && this._nearbyTargetExists()) this._enterState("surfacing");
                break;
            case "surfacing": {
                var t = 1 - (this._stateTimer / this._surfaceDuration);
                var y = this._hiddenY + (this._surfacedY - this._hiddenY) * Math.min(1, Math.max(0, t));
                if (this.scene.setPosition) this.scene.setPosition(this.entity.id, this._baseX, y, this._baseZ);
                if (this._stateTimer <= 0) this._enterState("swiping");
                break;
            }
            case "swiping":
                this._attackTimer -= dt;
                if (this._attackTimer <= 0) {
                    this._attackTimer = this._attackInterval;
                    this._swipeOnce();
                }
                if (this._stateTimer <= 0) this._enterState("submerging");
                break;
            case "submerging": {
                var st = 1 - (this._stateTimer / this._submergeDuration);
                var ny = this._surfacedY + (this._hiddenY - this._surfacedY) * Math.min(1, Math.max(0, st));
                if (this.scene.setPosition) this.scene.setPosition(this.entity.id, this._baseX, ny, this._baseZ);
                if (this._stateTimer <= 0) this._enterState("hidden");
                break;
            }
        }
    }

    _enterState(next) {
        this._state = next;
        if (next === "surfacing") {
            this._stateTimer = this._surfaceDuration;
            if (this._spawnSound && this.audio) this.audio.playSound(this._spawnSound, 0.45);
        } else if (next === "swiping") {
            this._stateTimer = this._swipeDuration;
            this._attackTimer = 0;
        } else if (next === "submerging") {
            this._stateTimer = this._submergeDuration;
        } else if (next === "hidden") {
            this._stateTimer = this._idleDuration + Math.random() * 4;
            if (this.scene.setPosition) this.scene.setPosition(this.entity.id, this._baseX, this._hiddenY, this._baseZ);
        }
    }

    _swipeOnce() {
        if (this._swipeSound && this.audio) this.audio.playSound(this._swipeSound, 0.5);
        var ships = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < ships.length; i++) {
            var s = ships[i];
            if (!s || !s.transform) continue;
            var sp = s.transform.position;
            var dx = sp.x - this._baseX;
            var dz = sp.z - this._baseZ;
            if (dx * dx + dz * dz > this._attackRange * this._attackRange) continue;

            // Target is in range. Push the standard local damage event.
            // For multiplayer remote captains we additionally broadcast
            // a net_player_shot so the target peer applies damage to
            // their own authoritative hull.
            this.scene.events.game.emit("entity_damaged", {
                entityId: s.id, amount: this._damage, source: "kraken",
            });
            var ni = s.getComponent ? s.getComponent("NetworkIdentityComponent") : null;
            var mp = this.scene._mp;
            if (mp && ni && typeof ni.ownerId === "string" && ni.ownerId && !ni.isLocalPlayer) {
                mp.sendNetworkedEvent("player_shot", {
                    targetPeerId: ni.ownerId,
                    damage: this._damage,
                    shooterPeerId: "kraken",
                });
            }
        }
    }

    _nearbyTargetExists() {
        var ships = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < ships.length; i++) {
            var s = ships[i];
            if (!s || !s.transform) continue;
            var dx = s.transform.position.x - this._baseX;
            var dz = s.transform.position.z - this._baseZ;
            if (dx * dx + dz * dz <= this._detectionRange * this._detectionRange) return true;
        }
        return false;
    }
}
