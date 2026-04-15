// Player health — takes damage, regenerates, emits player_died. In
// multiplayer templates also listens to net_player_shot so remote peers
// can apply damage to our local player, and runs a respawn timer on
// death that flips us back to full health and emits player_respawned
// (deathmatch_game teleports us to a spawn point on that event).
class PlayerHealthBehavior extends GameScript {
    _behaviorName = "player_health";
    _health = 100;
    _maxHealth = 100;
    _regenDelay = 5;
    _regenRate = 20;
    _respawnDelay = 3;
    _timeSinceDamage = 0;
    _respawnTimer = 0;
    _dead = false;
    _lastShooterPeerId = "";

    onStart() {
        var self = this;
        // Remote player proxies share this behavior but track a different
        // peer's health; skip entirely so we only manage our own hull.
        var ni0 = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        if (ni0 && !ni0.isLocalPlayer) return;

        this.scene.events.game.on("entity_damaged", function(data) {
            if (self.entity.active === false || self._dead) return;
            if (data.entityId !== self.entity.id) return;
            self._applyDamage(data.amount || 10, "");
        });
        this.scene.events.game.on("net_player_shot", function(evt) {
            if (self._dead) return;
            var d = (evt && evt.data) || {};
            var mp = self.scene._mp;
            if (!mp) return;
            if (d.targetPeerId !== mp.localPeerId) return;
            self._applyDamage(Number(d.damage) || 10, d.shooterPeerId || "");
        });
        this.scene.events.game.on("entity_healed", function(data) {
            if (data.entityId && data.entityId !== self.entity.id) return;
            self._health = Math.min(self._maxHealth, self._health + (data.amount || 10));
            self._dead = false;
            self._sendHUD();
        });
        // Reset state at the start of each match (for multiplayer "play again").
        this.scene.events.game.on("match_started", function() {
            self._health = self._maxHealth;
            self._dead = false;
            self._respawnTimer = 0;
            self._timeSinceDamage = 0;
            self._sendHUD();
        });
        this._sendHUD();
    }

    _applyDamage(amount, sourcePeerId) {
        this._health -= amount;
        this._timeSinceDamage = 0;
        if (sourcePeerId) this._lastShooterPeerId = sourcePeerId;
        if (this._health <= 0) {
            this._health = 0;
            this._dead = true;
            this._respawnTimer = this._respawnDelay;
            this.scene.events.game.emit("player_died", { killerPeerId: this._lastShooterPeerId });
        }
        this._sendHUD();
    }

    onUpdate(dt) {
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        if (ni && !ni.isLocalPlayer) return;

        if (this._dead) {
            // Multiplayer respawn: countdown then refill + emit so the
            // match system can pick a spawn point. Single-player flows
            // transition to the game_over substate on player_died before
            // the timer fires, so this branch is harmless there.
            this._respawnTimer -= dt;
            if (this._respawnTimer <= 0 && this.scene._mp) {
                this._dead = false;
                this._health = this._maxHealth;
                this._respawnTimer = 0;
                this._lastShooterPeerId = "";
                this.scene.events.game.emit("player_respawned", {});
                this._sendHUD();
            }
            return;
        }
        this._timeSinceDamage += dt;
        if (this._timeSinceDamage >= this._regenDelay && this._health < this._maxHealth) {
            this._health = Math.min(this._maxHealth, this._health + this._regenRate * dt);
            this._sendHUD();
        }
    }

    _sendHUD() {
        this.scene.events.ui.emit("hud_update", {
            health: Math.round(this._health),
            maxHealth: this._maxHealth
        });
    }
}
