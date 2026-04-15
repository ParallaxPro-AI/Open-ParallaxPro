// Arena match rules: a round timer, score tracking, and a winner check.
// Host-authoritative — only the lobby host ticks this system and emits
// `match_ended`. Clients react via the networked event stream.
class ArenaGameSystem extends GameScript {
    _roundDurationSec = 180;
    _scoreToWin = 10;
    _elapsed = 0;
    _ended = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("match_started", function() {
            self._elapsed = 0;
            self._ended = false;
        });
        // Networked event from host → "net_" prefix arrives on clients too.
        this.scene.events.game.on("net_match_ended", function(data) {
            if (self._ended) return;
            self._ended = true;
            self.scene.events.game.emit("match_ended", data && data.data || {});
        });
    }

    onUpdate(dt) {
        var mp = this.scene._mp;
        if (!mp || !mp.isHost || this._ended) return;

        this._elapsed += dt;
        if (this._elapsed >= this._roundDurationSec) {
            this._ended = true;
            var winner = this._computeWinner();
            // Broadcast to all peers then emit locally so the flow transitions.
            mp.sendNetworkedEvent("match_ended", { reason: "time", winner: winner });
            this.scene.events.game.emit("match_ended", { reason: "time", winner: winner });
        }
    }

    _computeWinner() {
        // Walk player entities, pick the highest score.
        var players = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        var bestScore = -Infinity;
        var bestPeer = null;
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            var ni = p.getComponent ? p.getComponent("NetworkIdentityComponent") : null;
            var score = ni ? (ni.getNetworkedVar ? ni.getNetworkedVar("score") : 0) : 0;
            if (typeof score === "number" && score > bestScore) {
                bestScore = score;
                bestPeer = ni ? ni.ownerId : null;
            }
        }
        return { peerId: bestPeer, score: bestScore };
    }
}
