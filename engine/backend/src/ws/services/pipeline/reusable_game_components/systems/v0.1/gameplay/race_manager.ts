// Race manager — tracks race positions based on waypoint progress
class RaceManagerSystem extends GameScript {
    _waypoints = [];
    _raceActive = false;

    onStart() {
        var self = this;
        this._raceActive = true;

        this.scene.events.game.on("race_finished", function() {
            self._raceActive = false;
        });
    }

    _getProgress(pos) {
        if (!this._waypoints || this._waypoints.length === 0) return 0;
        var bestDist = 999999;
        var bestIdx = 0;
        for (var i = 0; i < this._waypoints.length; i++) {
            var wp = this._waypoints[i];
            var dx = wp[0] - pos.x;
            var dz = wp[1] - pos.z;
            var dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < bestDist) {
                bestDist = dist;
                bestIdx = i;
            }
        }
        return bestIdx * 1000 - bestDist;
    }

    onUpdate(dt) {
        if (!this._raceActive) return;

        var player = this.scene.findEntityByName("Player Car");
        if (!player) return;

        var playerProgress = this._getProgress(player.transform.position);
        var position = 1;

        var opponents = this.scene.findEntitiesByTag("opponent");
        var totalRacers = 1;
        if (opponents) {
            totalRacers += opponents.length;
            for (var i = 0; i < opponents.length; i++) {
                var opp = opponents[i];
                if (!opp || !opp.active) continue;
                var oppProgress = this._getProgress(opp.transform.position);
                if (oppProgress > playerProgress) position++;
            }
        }

        this.scene.events.ui.emit("hud_update", {
            position: position,
            totalRacers: totalRacers
        });
    }
}
