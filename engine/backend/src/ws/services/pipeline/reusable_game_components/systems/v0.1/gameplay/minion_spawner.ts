// also: troop generation, AI spawning, competitive waves, team units, periodic intervals
// Minion spawner — spawns waves of minions for both teams periodically
class MinionSpawnerSystem extends GameScript {
    _spawnInterval = 25;
    _firstWaveDelay = 5;
    _waveSize = 3;
    _spawnTimer = 5;
    _waveCount = 0;
    _started = false;

    onStart() {
        this._spawnTimer = this._firstWaveDelay;
        this._waveCount = 0;
        this._started = true;

        var self = this;
        var resetFn = function() {
            // Despawn leftover minions from the previous match so they
            // don't pile up over Play Again cycles. spawnEntity always
            // creates a fresh instance, but the dead inactive minions
            // are still in the scene unless we destroy them.
            var blueLeft = self.scene.findEntitiesByTag && self.scene.findEntitiesByTag("blue_team");
            var redLeft = self.scene.findEntitiesByTag && self.scene.findEntitiesByTag("red_team");
            var leftover = [].concat(blueLeft || []).concat(redLeft || []);
            for (var i = 0; i < leftover.length; i++) {
                var e = leftover[i];
                if (!e || !e.tags) continue;
                var isMinion = false;
                for (var t = 0; t < e.tags.length; t++) {
                    if (e.tags[t] === "minion") { isMinion = true; break; }
                }
                if (isMinion && self.scene.destroyEntity) {
                    self.scene.destroyEntity(e.id);
                }
            }
            self._spawnTimer = self._firstWaveDelay;
            self._waveCount = 0;
        };
        this.scene.events.game.on("game_ready", resetFn);
        // Without the restart_game listener the moba flow's Play Again
        // (game_over → playing emits game.restart_game only) left the
        // spawner with whatever timer/wave state the previous match
        // ended on, and dead minions from that match piled up.
        this.scene.events.game.on("restart_game", resetFn);
    }

    onUpdate(dt) {
        if (!this._started) return;

        this._spawnTimer -= dt;
        if (this._spawnTimer > 0) return;

        this._spawnTimer = this._spawnInterval;
        this._waveCount++;
        this.scene.events.game.emit("wave_started", { wave: this._waveCount });

        // Spawn blue minions near blue base
        for (var i = 0; i < this._waveSize; i++) {
            var blue = this.scene.spawnEntity("blue_minion");
            if (blue) {
                var zOff = (i - 1) * 1.5;
                this.scene.setPosition(blue.id, -50, 0, zOff);
            }
        }

        // Spawn red minions near red base
        for (var j = 0; j < this._waveSize; j++) {
            var red = this.scene.spawnEntity("red_minion");
            if (red) {
                var zOff2 = (j - 1) * 1.5;
                this.scene.setPosition(red.id, 50, 0, zOff2);
            }
        }
    }
}
