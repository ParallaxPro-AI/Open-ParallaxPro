// also: sinking animation, hull damage, respawn delay, vehicle health, water line
// Ship health — hull HP for a player-captained ship. Listens for
// entity_damaged + net_player_shot events that target this entity, sinks
// the ship when hull <= 0, and respawns after a delay (multiplayer).
//
// Sinking emits player_died (so the match system can tally) and animates
// the ship dropping below the water-line by tweaking transform.position
// over a few seconds. On respawn the ship is repositioned to a fresh
// spawn point, hull refills, _sunk flips false, and player_respawned
// fires for the match system to teleport us cleanly.
class ShipHealthBehavior extends GameScript {
    _behaviorName = "ship_health";
    _hull = 200;
    _maxHull = 200;
    _respawnDelay = 5;
    _sinkDuration = 3;
    _sinkSound = "";
    _hitSound = "";
    _hull0Y = 0;             // remembered initial y so we can rise on respawn
    _sunk = false;
    _sinkTimer = 0;
    _respawnTimer = 0;
    _lastShooterPeerId = "";

    onStart() {
        var self = this;
        var ni0 = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        if (ni0 && !ni0.isLocalPlayer) return;   // proxies don't manage hull

        var pos = this.entity.transform && this.entity.transform.position;
        this._hull0Y = pos ? (pos.y || 0) : 0;

        this.scene.events.game.on("entity_damaged", function(data) {
            if (self._sunk) return;
            if (!data || data.entityId !== self.entity.id) return;
            self._applyDamage(data.amount || 10, "");
        });
        this.scene.events.game.on("net_player_shot", function(evt) {
            if (self._sunk) return;
            var d = (evt && evt.data) || {};
            var mp = self.scene._mp;
            if (!mp) return;
            if (d.targetPeerId !== mp.localPeerId) return;
            self._applyDamage(Number(d.damage) || 10, d.shooterPeerId || "");
        });
        this.scene.events.game.on("entity_healed", function(data) {
            if (data && data.entityId && data.entityId !== self.entity.id) return;
            self._hull = Math.min(self._maxHull, self._hull + (data && data.amount || 10));
            self._sendHUD();
        });
        this.scene.events.game.on("match_started", function() {
            self._hull = self._maxHull;
            self._sunk = false;
            self._sinkTimer = 0;
            self._respawnTimer = 0;
            // Reset to floating Y in case match_end left the hull underwater.
            if (self.scene.setPosition) {
                var p = self.entity.transform.position;
                self.scene.setPosition(self.entity.id, p.x, self._hull0Y, p.z);
            }
            self._sendHUD();
        });
        this._sendHUD();
    }

    _applyDamage(amount, sourcePeerId) {
        this._hull -= amount;
        if (sourcePeerId) this._lastShooterPeerId = sourcePeerId;
        if (this._hitSound && this.audio) this.audio.playSound(this._hitSound, 0.45);
        if (this._hull <= 0) {
            this._hull = 0;
            this._sunk = true;
            this._sinkTimer = this._sinkDuration;
            this._respawnTimer = this._respawnDelay;
            if (this._sinkSound && this.audio) this.audio.playSound(this._sinkSound, 0.55);
            this.scene.events.game.emit("player_died", { killerPeerId: this._lastShooterPeerId });
        }
        this._sendHUD();
    }

    onUpdate(dt) {
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        if (ni && !ni.isLocalPlayer) return;

        if (this._sunk) {
            // Sink animation — ease the hull underwater over _sinkDuration.
            if (this._sinkTimer > 0) {
                this._sinkTimer -= dt;
                if (this._sinkTimer < 0) this._sinkTimer = 0;
                var t = 1 - (this._sinkTimer / this._sinkDuration);
                var p = this.entity.transform.position;
                var newY = this._hull0Y - t * 4;
                if (this.scene.setPosition) this.scene.setPosition(this.entity.id, p.x, newY, p.z);
            }
            // Respawn timer — multiplayer only. Single-player flow can
            // transition to game_over on player_died before this fires.
            this._respawnTimer -= dt;
            if (this._respawnTimer <= 0 && this.scene._mp) {
                this._sunk = false;
                this._hull = this._maxHull;
                this._sinkTimer = 0;
                this._respawnTimer = 0;
                this._lastShooterPeerId = "";
                // Lift back to the water line at the same x/z; the match
                // system listens for player_respawned to teleport us to a
                // fresh spawn point.
                var p2 = this.entity.transform.position;
                if (this.scene.setPosition) this.scene.setPosition(this.entity.id, p2.x, this._hull0Y, p2.z);
                this.scene.events.game.emit("player_respawned", {});
                this._sendHUD();
            }
            return;
        }
    }

    _sendHUD() {
        this.scene.events.ui.emit("hud_update", {
            shipStatus: {
                hull: Math.round(this._hull),
                maxHull: this._maxHull,
                sunk: this._sunk,
            },
            // Also push to the standard health HUD shape for templates
            // that re-use ui/hud/health.html as a hull bar.
            health: Math.round(this._hull),
            maxHealth: this._maxHull,
        });
    }
}
