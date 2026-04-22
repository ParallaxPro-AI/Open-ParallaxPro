// also: time-of-day cycling, weather effects, ambient visuals, immersive environment, day-night
// Ocean atmosphere — drives the slow background mood of a sea-faring
// game: ambient light shifts across an in-game day, optional fog roll-
// in for stormy passages, and a far-field wave plane that gently
// bobs to give the horizon some life. Doesn't own gameplay state;
// pure presentation.
//
// Day length, sky tints, fog distances are all parameterized so the
// same system serves a calm-day template (no fog, full saturation) or
// a stormy-night variant (heavy fog, low saturation, dim sun).
class OceanAtmosphereSystem extends GameScript {
    _dayLength = 360;          // seconds for a full day → 6-min cycles
    _ambientDay = [0.55, 0.65, 0.75];
    _ambientDusk = [0.40, 0.30, 0.45];
    _ambientNight = [0.10, 0.12, 0.20];
    _sunDayColor = [1.00, 0.95, 0.85];
    _sunDuskColor = [1.00, 0.55, 0.30];
    _sunNightColor = [0.30, 0.35, 0.55];
    _fogDay = { color: [0.65, 0.80, 0.95], near: 60, far: 220, enabled: true };
    _fogNight = { color: [0.05, 0.08, 0.18], near: 25, far: 120, enabled: true };
    _ambientPulseFreq = 0.12;
    _ambientPulseAmp = 0.04;
    _waveAmbientSound = "";
    _stormSound = "";
    _stormChancePerMinute = 0;
    _stormDuration = 30;

    _time = 60;             // start near morning so first frames look bright
    _stormTimer = 0;
    _stormActive = false;
    _ambientSoundLoopHandle = null;

    onStart() {
        var self = this;
        // Seed with a small phase shift so two co-located sessions don't
        // synchronize to the exact same day.
        this._time = 60 + Math.random() * 30;
        // Optional ambient sound — start once, let it loop. If not provided
        // we just skip to keep this system silent for templates that don't
        // want ambience.
        if (this._waveAmbientSound && this.audio && this.audio.playSound) {
            try { this.audio.playSound(this._waveAmbientSound, 0.18); } catch (e) { /* no audio */ }
        }
        this.scene.events.game.on("match_started", function() {
            self._time = 60;
            self._stormTimer = 0;
            self._stormActive = false;
        });
    }

    onUpdate(dt) {
        this._time += dt;
        if (this._time >= this._dayLength) this._time -= this._dayLength;

        // Optional storms — drawn once per minute as a Bernoulli trial.
        if (this._stormChancePerMinute > 0 && !this._stormActive) {
            // Convert per-minute probability to per-frame.
            var perFrame = (this._stormChancePerMinute / 60) * dt;
            if (Math.random() < perFrame) {
                this._stormActive = true;
                this._stormTimer = this._stormDuration;
                if (this._stormSound && this.audio) {
                    try { this.audio.playSound(this._stormSound, 0.4); } catch (e) { /* no audio */ }
                }
            }
        } else if (this._stormActive) {
            this._stormTimer -= dt;
            if (this._stormTimer <= 0) this._stormActive = false;
        }

        var phase = this._time / this._dayLength;       // 0..1 across the day
        // Build a smooth lerp around three anchors:
        //   morning  (phase ≈ 0.25): full day
        //   dusk     (phase ≈ 0.55): warm horizon
        //   night    (phase ≈ 0.85): cool dim
        var ambient, sun;
        if (phase < 0.5) {
            // Day → dusk transition (0..0.5)
            var t = this._smooth(phase / 0.5);
            ambient = this._lerpRGB(this._ambientDay, this._ambientDusk, t * 0.5);
            sun = this._lerpRGB(this._sunDayColor, this._sunDuskColor, t * 0.4);
        } else if (phase < 0.8) {
            // Dusk → night (0.5..0.8)
            var t2 = this._smooth((phase - 0.5) / 0.3);
            ambient = this._lerpRGB(this._ambientDusk, this._ambientNight, t2);
            sun = this._lerpRGB(this._sunDuskColor, this._sunNightColor, t2);
        } else {
            // Night → next morning (0.8..1)
            var t3 = this._smooth((phase - 0.8) / 0.2);
            ambient = this._lerpRGB(this._ambientNight, this._ambientDay, t3);
            sun = this._lerpRGB(this._sunNightColor, this._sunDayColor, t3);
        }

        // A subtle ambient pulse that mimics light playing on water.
        var pulse = 1 + Math.sin(this._time * this._ambientPulseFreq * Math.PI * 2) * this._ambientPulseAmp;
        ambient = [ambient[0] * pulse, ambient[1] * pulse, ambient[2] * pulse];

        // Stormy override — desaturate and dim so a passing squall reads
        // as "rough seas" without changing geometry.
        if (this._stormActive) {
            var avg = (ambient[0] + ambient[1] + ambient[2]) / 3;
            ambient = [avg * 0.7, avg * 0.7, avg * 0.85];
            sun = [sun[0] * 0.55, sun[1] * 0.55, sun[2] * 0.65];
        }

        if (this.scene && this.scene.setAmbientLight) this.scene.setAmbientLight(ambient[0], ambient[1], ambient[2]);
        if (this.scene && this.scene.setSunColor) this.scene.setSunColor(sun[0], sun[1], sun[2]);

        // Fog — pick the day or night profile and lerp by phase. Storm
        // shrinks the fog distance dramatically.
        var fog = this._stormActive
            ? { color: [0.20, 0.22, 0.30], near: 12, far: 60, enabled: true }
            : (phase >= 0.6 && phase <= 0.95 ? this._fogNight : this._fogDay);
        if (this.scene && this.scene.setFog && fog && fog.enabled) {
            this.scene.setFog(fog.color[0], fog.color[1], fog.color[2], fog.near, fog.far);
        }

        // Tell the day/time HUD what hour it is. Convert phase (0..1) to
        // 24h with phase=0 = midnight.
        var hour = Math.floor((phase * 24 + 6) % 24);     // shift so phase 0 reads "06:00"
        var mins = Math.floor((((phase * 24 + 6) % 1) * 60));
        this.scene.events.ui.emit("hud_update", {
            atmosphere: {
                hour: hour,
                minute: mins,
                phase: phase,
                stormy: this._stormActive,
            },
        });
    }

    _lerpRGB(a, b, t) {
        var ct = Math.min(1, Math.max(0, t));
        return [
            a[0] + (b[0] - a[0]) * ct,
            a[1] + (b[1] - a[1]) * ct,
            a[2] + (b[2] - a[2]) * ct,
        ];
    }

    _smooth(t) {
        return t * t * (3 - 2 * t);
    }
}
