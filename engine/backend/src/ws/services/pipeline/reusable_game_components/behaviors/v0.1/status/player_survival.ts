// also: starvation, hunger meter, food mechanic, survival mechanics, attrition
// Player survival — health, hunger, damage, death, respawn for survival games
class PlayerSurvivalBehavior extends GameScript {
    _behaviorName = "player_survival";
    _maxHealth = 100;
    _health = 100;
    _maxHunger = 100;
    _hunger = 100;
    _hungerRate = 0.5;
    _starveDamage = 2;
    _regenRate = 1;
    _regenHungerThreshold = 60;

    onStart() {
        this._health = this._maxHealth;
        this._hunger = this._maxHunger;
        var self = this;

        this.scene.events.game.on("entity_damaged", function(data) {
            if (data.targetId !== self.entity.id && data.source !== "player_hit") return;
            if (data.targetId === self.entity.id) {
                self._health -= data.damage || 0;
                if (self.audio) self.audio.playSound("/assets/kenney/audio/impact_sounds/impactSoft_heavy_002.ogg", 0.4);
                if (self._health <= 0) {
                    self._health = 0;
                    self.scene.events.game.emit("player_died", {});
                }
            }
        });

        this.scene.events.game.on("player_respawned", function() {
            self._health = self._maxHealth;
            self._hunger = self._maxHunger;
        });

    }

    onUpdate(dt) {
        // Hunger depletion
        this._hunger -= this._hungerRate * dt;
        if (this._hunger < 0) this._hunger = 0;

        // Starve damage
        if (this._hunger <= 0) {
            this._health -= this._starveDamage * dt;
            if (this._health <= 0) {
                this._health = 0;
                this.scene.events.game.emit("player_died", {});
            }
        }

        // Health regen when well-fed
        if (this._hunger > this._regenHungerThreshold && this._health < this._maxHealth) {
            this._health = Math.min(this._maxHealth, this._health + this._regenRate * dt);
        }

        this.scene.events.ui.emit("hud_update", {
            health: Math.floor(this._health),
            maxHealth: this._maxHealth,
            hunger: Math.floor(this._hunger),
            maxHunger: this._maxHunger
        });
    }
}
