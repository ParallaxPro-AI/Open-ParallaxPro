// Combat survival — tracks kills, manages mob threats, player death
class CombatSurvivalSystem extends GameScript {
    _kills = 0;
    _gameActive = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() { self._kills = 0; self._gameActive = true; });
        this.scene.events.game.on("entity_killed", function(d) { if (d.team !== "player") self._kills++; });
        this.scene.events.game.on("player_died", function() {
            self.scene.events.ui.emit("hud_update", { _gameOver: { title: "YOU DIED", score: self._kills, stats: { "Mobs Slain": ""+self._kills } } });
            self.scene.events.game.emit("game_over", {});
        });
    }

    onUpdate(dt) {
        if (!this._gameActive) return;
        this.scene.events.ui.emit("hud_update", { kills: this._kills });
    }
}
