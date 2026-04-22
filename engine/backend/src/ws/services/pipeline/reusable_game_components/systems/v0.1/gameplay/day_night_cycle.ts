// also: ambient lighting, atmosphere, time of day, darkness, environment
// Day-night cycle — manages lighting transitions, night danger, time tracking
class DayNightCycleSystem extends GameScript {
    _dayDuration = 180;
    _nightDuration = 120;
    _dawnDuration = 15;
    _duskDuration = 15;
    _dayAmbient = [0.5, 0.55, 0.6];
    _nightAmbient = [0.08, 0.08, 0.15];
    _daySunColor = [1.0, 0.97, 0.88];
    _nightSunColor = [0.15, 0.15, 0.3];

    _timeOfDay = 0;
    _cycleDuration = 0;
    _isNight = false;
    _dayCount = 1;
    _gameActive = false;

    onStart() {
        this._cycleDuration = this._dayDuration + this._nightDuration + this._dawnDuration + this._duskDuration;
        this._timeOfDay = 0;
        this._dayCount = 1;

        var self = this;
        this.scene.events.game.on("game_ready", function() {
            self._timeOfDay = 0;
            self._dayCount = 1;
            self._gameActive = true;
        });
    }

    onUpdate(dt) {
        if (!this._gameActive) return;

        this._timeOfDay += dt;
        if (this._timeOfDay >= this._cycleDuration) {
            this._timeOfDay -= this._cycleDuration;
            this._dayCount++;
        }

        // Determine phase
        var wasNight = this._isNight;
        if (this._timeOfDay < this._dayDuration) {
            this._isNight = false;
        } else if (this._timeOfDay < this._dayDuration + this._duskDuration) {
            this._isNight = false; // dusk transition
        } else if (this._timeOfDay < this._dayDuration + this._duskDuration + this._nightDuration) {
            this._isNight = true;
        } else {
            this._isNight = false; // dawn transition
        }

        if (this._isNight && !wasNight) {
            this.scene.events.game.emit("nightfall", {});
            if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/forceField_003.ogg", 0.3);
        }
        if (!this._isNight && wasNight) {
            this.scene.events.game.emit("daybreak", {});
        }

        // Calculate time percentage for HUD
        var dayPct = this._isNight ? 0 : Math.min(100, (this._timeOfDay / this._dayDuration) * 100);
        var phaseName = this._isNight ? "Night" : "Day";
        if (this._timeOfDay >= this._dayDuration && this._timeOfDay < this._dayDuration + this._duskDuration) phaseName = "Dusk";
        if (this._timeOfDay >= this._dayDuration + this._duskDuration + this._nightDuration) phaseName = "Dawn";

        this.scene.events.ui.emit("hud_update", {
            isNight: this._isNight,
            dayCount: this._dayCount,
            timePhase: phaseName,
            dayProgress: Math.floor(dayPct)
        });
    }
}
