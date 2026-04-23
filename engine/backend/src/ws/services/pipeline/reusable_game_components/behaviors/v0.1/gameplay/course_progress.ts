// also: parkour, platformer, time trials, checkpoint system, respawn mechanics
// Course progress — checkpoint tracking, timer, finish/fall detection
class CourseProgressBehavior extends GameScript {
    _behaviorName = "course_progress";
    _checkpoints = [];
    _currentCheckpoint = 0;
    _respawnX = 0;
    _respawnZ = 0;
    _timeLimit = 90;
    _startTime = 0;
    _finished = false;
    _raceActive = false;

    onStart() {
        var pos = this.entity.transform.position;
        this._respawnX = pos.x;
        this._respawnZ = pos.z;
        this._finished = false;
        this._raceActive = false;
        this._currentCheckpoint = 0;

        var self = this;
        this.scene.events.game.on("race_start", function() {
            self._finished = false;
            self._raceActive = false;
            self._currentCheckpoint = 0;
            self._startTime = 0;
            var p = self.entity.transform.position;
            self._respawnX = p.x;
            self._respawnZ = p.z;
            self.scene.events.ui.emit("hud_update", {
                timeRemaining: self._timeLimit,
                checkpoint: 0,
                totalCheckpoints: self._checkpoints.length
            });
        });

        this.scene.events.game.on("race_started", function() {
            self._raceActive = true;
            self._startTime = Date.now();
        });
    }

    onUpdate(dt) {
        if (this._finished || !this._raceActive) return;

        var pos = this.entity.transform.position;

        // Fall detection — respawn at last checkpoint
        if (pos.y < -10) {
            this.scene.setPosition(this.entity.id, this._respawnX, 2, this._respawnZ);
            this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/impactMetal_000.ogg", 0.5);
        }

        // Checkpoint detection (course runs in -Z direction)
        if (this._checkpoints && this._currentCheckpoint < this._checkpoints.length) {
            var cpZ = this._checkpoints[this._currentCheckpoint];
            if (pos.z <= cpZ) {
                this._respawnX = pos.x;
                this._respawnZ = cpZ;
                this._currentCheckpoint++;

                // Last checkpoint = finish!
                if (this._currentCheckpoint >= this._checkpoints.length) {
                    this._finished = true;
                    var totalTime = (Date.now() - this._startTime) / 1000;
                    this.scene.events.ui.emit("hud_update", {
                        _gameOver: {
                            title: "YOU MADE IT!",
                            stats: {
                                "Time": this._formatTime(totalTime)
                            }
                        }
                    });
                    this.scene.events.game.emit("race_finished", {});
                    return;
                }

                if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_001.ogg", 0.6);
            }
        }

        // Timer
        var elapsed = (Date.now() - this._startTime) / 1000;
        var remaining = Math.max(0, this._timeLimit - elapsed);

        this.scene.events.ui.emit("hud_update", {
            timeRemaining: remaining,
            checkpoint: this._currentCheckpoint,
            totalCheckpoints: this._checkpoints.length
        });

        // Time's up
        if (remaining <= 0) {
            this._finished = true;
            this.scene.events.ui.emit("hud_update", {
                _gameOver: {
                    title: "TIME'S UP!",
                    stats: {
                        "Progress": this._currentCheckpoint + " / " + this._checkpoints.length + " checkpoints"
                    }
                }
            });
            this.scene.events.game.emit("race_finished", {});
        }
    }

    _formatTime(seconds) {
        var m = Math.floor(seconds / 60);
        var s = seconds % 60;
        return m + ":" + (s < 10 ? "0" : "") + s.toFixed(2);
    }
}
