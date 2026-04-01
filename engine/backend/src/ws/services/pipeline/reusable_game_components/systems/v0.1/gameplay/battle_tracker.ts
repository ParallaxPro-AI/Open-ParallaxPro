// Battle tracker — tracks alive count, kills, and triggers victory/defeat
class BattleTracker extends GameScript {
    _totalEnemies = 0;
    _aliveCount = 0;
    _kills = 0;

    onStart() {
        var self = this;

        this.scene.events.game.on("game_ready", function() {
            var enemies = self.scene.findEntitiesByTag("enemy");
            self._totalEnemies = enemies ? enemies.length : 0;
            self._aliveCount = self._totalEnemies + 1;
            self._kills = 0;
            self._sendHUD();
        });

        this.scene.events.game.on("entity_killed", function() {
            self._kills++;
            self._aliveCount--;
            self._sendHUD();

            // Check for victory — player is last one standing
            if (self._aliveCount <= 1) {
                self.scene.events.ui.emit("hud_update", {
                    _gameOver: {
                        title: "WINNER WINNER",
                        score: self._kills * 100,
                        stats: {
                            "Kills": "" + self._kills,
                            "Opponents": "" + self._totalEnemies
                        }
                    }
                });
                self.scene.events.game.emit("game_won", {});
            }
        });

        this.scene.events.game.on("player_died", function() {
            self.scene.events.ui.emit("hud_update", {
                _gameOver: {
                    title: "ELIMINATED",
                    stats: {
                        "Placement": "#" + self._aliveCount + " of " + (self._totalEnemies + 1),
                        "Kills": "" + self._kills
                    }
                }
            });
        });

        // Initial count
        var enemies = this.scene.findEntitiesByTag("enemy");
        this._totalEnemies = enemies ? enemies.length : 0;
        this._aliveCount = this._totalEnemies + 1;
        this._sendHUD();
    }

    _sendHUD() {
        this.scene.events.ui.emit("hud_update", {
            alive: this._aliveCount,
            totalPlayers: this._totalEnemies + 1,
            kills: this._kills
        });
    }
}
