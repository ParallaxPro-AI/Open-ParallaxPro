// also: RTS combat, terrain tactics, unit advancement, strategy mechanics, promotion leveling
// Military system — unit combat resolution, terrain bonuses, XP, promotions
class MilitarySystem extends GameScript {
    _gridSize = 12;
    _terrainMoveCost = {};
    _terrainDefenseBonus = {};
    _unitStats = {};
    _promotions = {};
    _combatXPGain = 5;
    _attackSound = "";
    _moveSound = "";
    _deathSound = "";
    _siegeSound = "";
    _selectSound = "";
    _promotionSound = "";

    // State
    _gameActive = false;
    _combatLog = [];

    onStart() {
        var self = this;
        // Seed defensively — game_ready fires before this substate boots
        // its systems, so the handler below races (see 5a29bbe).
        this._gameActive = true;
        this._combatLog = [];
        this.scene.events.game.on("game_ready", function() {
            self._gameActive = true;
            self._combatLog = [];
        });

        this.scene.events.game.on("attack_unit", function(data) {
            if (!data || !data.attackerId || !data.defenderId) return;
            self._resolveCombat(data.attackerId, data.defenderId);
        });
    }

    _resolveCombat(attackerId, defenderId) {
        var attacker = null, defender = null;
        var units = this.scene.findEntitiesByTag("unit") || [];
        for (var u = 0; u < units.length; u++) {
            if (units[u].id === attackerId) attacker = units[u];
            if (units[u].id === defenderId) defender = units[u];
        }
        if (!attacker || !defender || !attacker.active || !defender.active) return;

        // Get attack/defense values from tags (simplified)
        var atkPower = 20;
        var defPower = 15;
        var aTags = attacker.tags || [];
        var dTags = defender.tags || [];

        // Check if ranged
        var isRanged = false;
        for (var t = 0; t < aTags.length; t++) { if (aTags[t] === "ranged") isRanged = true; }

        // Calculate damage
        var damage = Math.max(5, atkPower - defPower + Math.floor(Math.random() * 10));

        // Apply damage to defender
        this.scene.events.game.emit("entity_damaged", { targetId: defenderId, damage: damage, source: attackerId });

        // Counter-attack if melee and defender survives
        if (!isRanged && defender.active) {
            var counterDmg = Math.max(3, defPower - atkPower + Math.floor(Math.random() * 8));
            this.scene.events.game.emit("entity_damaged", { targetId: attackerId, damage: counterDmg, source: defenderId });
        }

        if (this.audio) this.audio.playSound(this._attackSound || "/assets/kenney/audio/rpg_audio/knifeSlice.ogg", 0.5);

        this._combatLog.push("Combat: " + damage + " dmg dealt");
        this.scene.events.ui.emit("hud_update", { lastCombat: damage });
    }

    onUpdate(dt) {}
}
