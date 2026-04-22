// also: environment, climate, season, time progression, lighting
// Biome weather — day/night cycle and weather management for voxel survival
class BiomeWeatherSystem extends GameScript {
    _dayDuration = 180;
    _nightDuration = 120;
    _timeOfDay = 0;
    _isNight = false;
    _dayCount = 1;
    _gameActive = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() { self._timeOfDay = 0; self._dayCount = 1; self._gameActive = true; });
    }

    onUpdate(dt) {
        if (!this._gameActive) return;
        this._timeOfDay += dt;
        var cycle = this._dayDuration + this._nightDuration;
        if (this._timeOfDay >= cycle) { this._timeOfDay -= cycle; this._dayCount++; }
        var wasNight = this._isNight;
        this._isNight = this._timeOfDay >= this._dayDuration;
        if (this._isNight && !wasNight) this.scene.events.game.emit("nightfall", {});
        if (!this._isNight && wasNight) this.scene.events.game.emit("daybreak", {});
        this.scene.events.ui.emit("hud_update", { isNight: this._isNight, dayCount: this._dayCount, timePhase: this._isNight ? "Night" : "Day" });
    }
}
