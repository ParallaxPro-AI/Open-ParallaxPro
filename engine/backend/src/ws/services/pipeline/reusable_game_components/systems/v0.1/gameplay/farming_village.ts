// also: agriculture, simulation, NPC AI, economic system, village simulation
// Farming village — manages NPC village life, crop growth, trade
class FarmingVillageSystem extends GameScript {
    _cropGrowthTime = 60;
    _villagerCount = 0;
    _gameActive = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() { self._gameActive = true; self._countVillagers(); });
    }

    _countVillagers() {
        var villagers = this.scene.findEntitiesByTag("villager") || [];
        this._villagerCount = 0;
        for (var v = 0; v < villagers.length; v++) { if (villagers[v].active) this._villagerCount++; }
    }

    onUpdate(dt) {
        if (!this._gameActive) return;
        this.scene.events.ui.emit("hud_update", { villagerCount: this._villagerCount });
    }
}
