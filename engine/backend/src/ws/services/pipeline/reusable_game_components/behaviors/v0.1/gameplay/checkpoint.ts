// also: race system, lap timing, progress tracking, speedrun mechanics
// Checkpoint — tracks player progress through checkpoints and laps
class CheckpointBehavior extends GameScript {
    _behaviorName = "checkpoint";
    _checkpoints = [];
    _currentCheckpoint = 0;
    _lapCount = 0;
    _maxLaps = 3;
    _lapStartTime = 0;
    _raceStartTime = 0;
    _bestLapTime = 999;
    _checkpointRadius = 12;
    _raceActive = false;

    onStart() {
        this._lapCount = 0;
        this._currentCheckpoint = 0;
        this._raceActive = false;

        var self = this;
        this.scene.events.game.on("race_start", function() {
            self._lapCount = 0;
            self._currentCheckpoint = 0;
            self._raceStartTime = 0;
            self._lapStartTime = 0;
            self._bestLapTime = 999;
            self._raceActive = false;
            self.scene.events.ui.emit("hud_update", {
                lap: 0,
                maxLaps: self._maxLaps,
                lapTime: 0,
                raceTime: 0,
                bestLap: 0
            });
        });

        this.scene.events.game.on("race_started", function() {
            self._raceActive = true;
            self._raceStartTime = Date.now();
            self._lapStartTime = Date.now();
        });
    }

    onUpdate(dt) {
        if (!this._checkpoints || this._checkpoints.length === 0) return;
        if (!this._raceActive) return;

        var pos = this.entity.transform.position;
        var cp = this._checkpoints[this._currentCheckpoint];
        var dx = cp[0] - pos.x;
        var dz = cp[1] - pos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < this._checkpointRadius) {
            this._currentCheckpoint++;

            if (this._currentCheckpoint >= this._checkpoints.length) {
                // Completed a lap
                this._currentCheckpoint = 0;
                this._lapCount++;

                var lapTime = (Date.now() - this._lapStartTime) / 1000;
                if (lapTime < this._bestLapTime) this._bestLapTime = lapTime;
                this._lapStartTime = Date.now();

                if (this._lapCount >= this._maxLaps) {
                    // Race finished
                    this._raceActive = false;
                    var totalTime = (Date.now() - this._raceStartTime) / 1000;
                    this.scene.events.ui.emit("hud_update", {
                        lap: this._maxLaps,
                        maxLaps: this._maxLaps,
                        raceTime: totalTime,
                        bestLap: this._bestLapTime,
                        _gameOver: {
                            title: "RACE COMPLETE",
                            stats: {
                                "Total Time": this._formatTime(totalTime),
                                "Best Lap": this._formatTime(this._bestLapTime),
                                "Laps": "" + this._maxLaps
                            }
                        }
                    });
                    this.scene.events.game.emit("race_finished", {});
                    return;
                }

                // Lap completion sound
                if (this.audio) {
                    this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_001.ogg", 0.6);
                }
            }
        }

        // Update HUD each frame
        var currentLapTime = (Date.now() - this._lapStartTime) / 1000;
        var totalTime = (Date.now() - this._raceStartTime) / 1000;
        this.scene.events.ui.emit("hud_update", {
            lapTime: currentLapTime,
            raceTime: totalTime,
            lap: this._lapCount,
            maxLaps: this._maxLaps
        });
    }

    _formatTime(seconds) {
        var mins = Math.floor(seconds / 60);
        var secs = seconds % 60;
        return mins + ":" + (secs < 10 ? "0" : "") + secs.toFixed(2);
    }
}
