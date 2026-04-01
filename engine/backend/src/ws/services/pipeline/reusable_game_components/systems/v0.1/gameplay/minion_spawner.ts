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
        this.scene.events.game.on("game_ready", function() {
            self._spawnTimer = self._firstWaveDelay;
            self._waveCount = 0;
        });
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
