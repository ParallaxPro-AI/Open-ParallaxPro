// also: points, leaderboard, stats, metrics, counter
// Scoring system — tracks kills and score, sends to HUD
class ScoringSystem extends GameScript {
    _kills = 0;
    _score = 0;

    onStart() {
        var self = this;
        this.scene.events.game.on("entity_killed", function() {
            self._kills++;
            self._score += 100;
            self.scene.events.ui.emit("hud_update", {
                kills: self._kills,
                score: self._score
            });
        });
    }
}
