// also: currency, income generation, score, economy, player progression
// Gold system — tracks player gold from kills and passive income
class GoldSystem extends GameScript {
    _gold = 0;
    _kills = 0;
    _passiveRate = 2;
    _passiveTimer = 0;

    onStart() {
        var self = this;

        this.scene.events.game.on("add_score", function(data) {
            self._gold += data.amount || 0;
            self._sendHUD();
        });

        this.scene.events.game.on("minion_killed", function() {
            self._kills++;
            self._sendHUD();
        });

        this.scene.events.game.on("entity_killed", function() {
            self._kills++;
            self._sendHUD();
        });

        this.scene.events.game.on("game_ready", function() {
            self._gold = 0;
            self._kills = 0;
            self._passiveTimer = 0;
            self._sendHUD();
        });
    }

    onUpdate(dt) {
        this._passiveTimer += dt;
        if (this._passiveTimer >= 1) {
            this._passiveTimer -= 1;
            this._gold += this._passiveRate;
            this._sendHUD();
        }
    }

    _sendHUD() {
        this.scene.events.ui.emit("hud_update", {
            gold: this._gold,
            kills: this._kills
        });
    }
}
