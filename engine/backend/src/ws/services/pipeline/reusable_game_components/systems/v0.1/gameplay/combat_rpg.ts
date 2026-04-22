// also: health, experience, character stats, battle system, action RPG
// Combat RPG — manages combat interactions, damage calculation, healing
class CombatRPGSystem extends GameScript {
    _damageMultiplier = 1; _healMultiplier = 1; _gameActive = false; _kills = 0;
    onStart() { var s=this;
        this.scene.events.game.on("game_ready",function(){s._gameActive=true;s._kills=0;});
        this.scene.events.game.on("entity_killed",function(d){s._kills++;});
        this.scene.events.game.on("player_died",function(){
            s.scene.events.ui.emit("hud_update",{_gameOver:{title:"YOU DIED",score:s._kills*50,stats:{"Enemies Slain":""+s._kills}}});
            s.scene.events.game.emit("game_over",{});});
    }
    onUpdate(dt){if(!this._gameActive)return;this.scene.events.ui.emit("hud_update",{kills:this._kills});}
}
