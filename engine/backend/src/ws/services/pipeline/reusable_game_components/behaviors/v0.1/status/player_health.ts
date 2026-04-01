// Player health — takes damage, regenerates, emits player_died
class PlayerHealthBehavior extends GameScript {
    _behaviorName = "player_health";
    _active = false;
    _health = 100;
    _maxHealth = 100;
    _regenDelay = 5;
    _regenRate = 20;
    _timeSinceDamage = 0;
    _dead = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("active_behaviors", function(d) {
            self._active = d.behaviors && d.behaviors.indexOf(self._behaviorName) >= 0;
        });
        this.scene.events.game.on("entity_damaged", function(data) {
            if (!self._active || self._dead) return;
            if (data.entityId !== self.entity.id) return;
            self._health -= data.amount || 10;
            self._timeSinceDamage = 0;
            if (self._health <= 0) {
                self._health = 0;
                self._dead = true;
                self.scene.events.game.emit("player_died", {});
            }
            self._sendHUD();
        });
        this.scene.events.game.on("entity_healed", function(data) {
            if (data.entityId && data.entityId !== self.entity.id) return;
            self._health = Math.min(self._maxHealth, self._health + (data.amount || 10));
            self._dead = false;
            self._sendHUD();
        });
        this._sendHUD();
    }

    onUpdate(dt) {
        if (!this._active || this._dead) return;
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
