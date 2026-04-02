// Loot and XP — manages experience distribution, loot drops, gold
class LootXPSystem extends GameScript {
    _goldPerKill = 10; _totalGold = 0; _gameActive = false;
    onStart() { var s=this;
        this.scene.events.game.on("game_ready",function(){s._totalGold=0;s._gameActive=true;});
        this.scene.events.game.on("entity_killed",function(d){s._totalGold+=s._goldPerKill;});
    }
    onUpdate(dt){if(!this._gameActive)return;this.scene.events.ui.emit("hud_update",{gold:this._totalGold});}
}
