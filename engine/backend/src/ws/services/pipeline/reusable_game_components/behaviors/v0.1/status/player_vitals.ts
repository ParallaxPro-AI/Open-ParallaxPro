// Player vitals — health, hunger, stamina tracking for survival
class PlayerVitalsBehavior extends GameScript {
    _behaviorName = "player_vitals";
    _maxHealth = 100;
    _maxHunger = 100;
    _maxStamina = 100;
    _health = 100;
    _hunger = 100;
    _stamina = 100;
    _hungerRate = 0.4;
    _staminaRegen = 8;
    _starveDamage = 1.5;
    _regenRate = 1;

    onStart() {
        this._health = this._maxHealth;
        this._hunger = this._maxHunger;
        this._stamina = this._maxStamina;
        var self = this;
        this.scene.events.game.on("entity_damaged", function(d) {
            if (d.targetId !== self.entity.id) return;
            self._health -= d.damage || 0;
            if (self._health <= 0) { self._health = 0; self.scene.events.game.emit("player_died", {}); }
        });
        this.scene.events.game.on("player_respawned", function() {
            self._health = self._maxHealth; self._hunger = self._maxHunger; self._stamina = self._maxStamina;
        });
    }

    onUpdate(dt) {
        this._hunger = Math.max(0, this._hunger - this._hungerRate * dt);
        if (this._hunger <= 0) this._health = Math.max(0, this._health - this._starveDamage * dt);
        if (this._hunger > 50 && this._health < this._maxHealth) this._health = Math.min(this._maxHealth, this._health + this._regenRate * dt);
        var sprinting = this.input.isKeyDown("ShiftLeft");
        if (sprinting) this._stamina = Math.max(0, this._stamina - 12 * dt);
        else this._stamina = Math.min(this._maxStamina, this._stamina + this._staminaRegen * dt);
        this.scene.events.ui.emit("hud_update", {
            health: Math.floor(this._health), maxHealth: this._maxHealth,
            hunger: Math.floor(this._hunger), maxHunger: this._maxHunger,
            stamina: Math.floor(this._stamina), maxStamina: this._maxStamina
        });
    }
}
