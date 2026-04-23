// also: unit control, military strategy, victory defeat, base defense
// Combat system — manages damage, kills, morale for RTS battles
class CombatSystemInstance extends GameScript {
    _playerKills = 0; _enemyKills = 0; _gameActive = false;
    onStart() { var s = this;
        this.scene.events.game.on("game_ready", function() { s._playerKills=0; s._enemyKills=0; s._gameActive=true; });
        this.scene.events.game.on("entity_killed", function(d) {
            if (d.team==="enemy") { s._playerKills++; }
            if (d.team==="player") { s._enemyKills++; }
            s._checkVictory();
        }); }
    _checkVictory() {
        var enemies = this.scene.findEntitiesByTag("enemy") || []; var alive = 0;
        for (var e = 0; e < enemies.length; e++) { if (enemies[e].active) alive++; }
        if (alive === 0 && this._playerKills > 0) {
            this.scene.events.ui.emit("hud_update", { _gameOver: { title: "VICTORY!", score: this._playerKills*100, stats: { "Enemies Destroyed": ""+this._playerKills, "Units Lost": ""+this._enemyKills } } });
            this.scene.events.game.emit("victory", {}); this._gameActive = false; }
        var playerUnits = this.scene.findEntitiesByTag("military") || []; var pAlive = 0;
        for (var p = 0; p < playerUnits.length; p++) { if (!playerUnits[p].active) continue; var tags = playerUnits[p].tags||[]; for(var t=0;t<tags.length;t++){if(tags[t]==="player")pAlive++;} }
        if (pAlive === 0 && this._enemyKills > 0) {
            this.scene.events.ui.emit("hud_update", { _gameOver: { title: "DEFEAT", score: 0, stats: { "Units Lost": "All" } } });
            this.scene.events.game.emit("defeat", {}); this._gameActive = false; }
    }
    onUpdate(dt) { if(!this._gameActive) return;
        this.scene.events.ui.emit("hud_update", { playerKills: this._playerKills, enemyKills: this._enemyKills }); }
}
