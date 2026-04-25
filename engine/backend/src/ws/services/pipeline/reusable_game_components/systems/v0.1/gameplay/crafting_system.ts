// also: inventory, items, recipes, building, workshop, construction
// Crafting system — recipe-based crafting near crafting stations
class CraftingSystemInstance extends GameScript {
    _recipes = {};
    _craftingRange = 5;
    _craftSound = "";

    _gameActive = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() { self._gameActive = true; });
    }

    _craft(recipeId) {
        if (!this._gameActive) return;
        var recipe = this._recipes[recipeId];
        if (!recipe) return;

        // Check if near crafting station
        var player = this.scene.findEntityByName("Player");
        if (!player) return;
        var pp = player.transform.position;
        var stations = this.scene.findEntitiesByTag("crafting") || [];
        var nearStation = false;
        for (var s = 0; s < stations.length; s++) {
            if (!stations[s].active) continue;
            var sp = stations[s].transform.position;
            var dist = Math.sqrt((pp.x - sp.x) * (pp.x - sp.x) + (pp.z - sp.z) * (pp.z - sp.z));
            if (dist < this._craftingRange) { nearStation = true; break; }
        }
        if (!nearStation) return;

        // Crafting happens — emit event for inventory system to consume materials
        this.scene.events.game.emit("item_crafted", { item: recipeId, recipe: recipe });
        if (this.audio) this.audio.playSound(this._craftSound || "/assets/kenney/audio/rpg_audio/metalClick.ogg", 0.4);
    }

    onUpdate(dt) {}
}
