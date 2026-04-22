// also: timing-meter, charge-release, shot-power, arcade-sports
// Baller shot — charge-and-release shot meter for a basketball / arcade
// shooting game.
//
// Hold Space to charge: a meter ticks UP from 0 to 1 over chargeTime,
// then bounces back DOWN to 0, then up again, in a triangular wave.
// Releasing freezes the meter at the current value and emits a
// "baller_shot_release" intent the court system catches. The system
// owns shot resolution (distance check + hit/miss logic + scoring).
//
// While charging, scene._shotCharging is true so the dribble script
// freezes the player. scene._shotMeter exposes the meter value for the
// HUD; the green sweet-spot zone bounds are computed from params.
//
// Reusable: any timing-meter mechanic (golf swing, bow draw, fishing
// reel) — just relabel the action emitted on release.
class BallerShotBehavior extends GameScript {
    _behaviorName = "baller_shot";
    _chargeTime = 0.85;            // seconds for one full up-down cycle (so 0..1 in 0.425s)
    _greenLow = 0.78;              // sweet-spot lower bound (0..1)
    _greenHigh = 0.92;             // sweet-spot upper bound (0..1)
    _yellowLow = 0.55;             // good-but-not-perfect band lower
    _yellowHigh = 0.97;            // good-but-not-perfect band upper
    _chargeKey = "Space";
    _chargeStartSound = "";
    _chargeReleaseSound = "";

    _charging = false;
    _t = 0;                        // 0..1 meter value
    _direction = 1;                // 1 ascending, -1 descending
    _holdAccum = 0;
    _matchOver = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("match_started", function() {
            self._matchOver = false;
            self._charging = false;
            self._t = 0;
            self._direction = 1;
        });
        this.scene.events.game.on("match_ended", function() { self._matchOver = true; });
    }

    onUpdate(dt) {
        if (!this.entity || !this.entity.transform) return;
        if (this._matchOver) return;
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        if (ni && !ni.isLocalPlayer) return;

        var hasBall = this._iHaveBall();
        var keyDown = this.input && this.input.isKeyDown && this.input.isKeyDown(this._chargeKey);
        var keyPressed = this.input && this.input.isKeyPressed && this.input.isKeyPressed(this._chargeKey);

        // Start charging only on a fresh press, only while we hold the ball.
        if (!this._charging && keyPressed && hasBall) {
            this._charging = true;
            this._t = 0;
            this._direction = 1;
            this._holdAccum = 0;
            if (this._chargeStartSound && this.audio) {
                try { this.audio.playSound(this._chargeStartSound, 0.32); } catch (e) { /* nop */ }
            }
        }

        if (this._charging) {
            // Tick the meter as a triangle wave.
            this._holdAccum += dt;
            // Half period = chargeTime / 2 → travel 0→1 and back.
            var halfP = Math.max(0.05, this._chargeTime * 0.5);
            this._t += this._direction * (dt / halfP);
            if (this._t >= 1) { this._t = 1; this._direction = -1; }
            if (this._t <= 0) { this._t = 0; this._direction = 1; }

            this.scene._shotCharging = true;
            this.scene._shotMeter = {
                value: this._t,
                greenLow: this._greenLow,
                greenHigh: this._greenHigh,
                yellowLow: this._yellowLow,
                yellowHigh: this._yellowHigh,
                charging: true,
            };

            // Released?
            if (!keyDown) {
                // Force loss of ball state if we no longer hold the ball
                // (got stolen mid-charge) — skip the shot.
                if (!hasBall) {
                    this._charging = false;
                    this.scene._shotCharging = false;
                    this.scene._shotMeter = { value: 0, charging: false };
                    return;
                }
                // Compute zone classification.
                var zone = "miss";
                if (this._t >= this._greenLow && this._t <= this._greenHigh) zone = "perfect";
                else if (this._t >= this._yellowLow && this._t <= this._yellowHigh) zone = "good";
                this._fireRelease(this._t, zone);
                this._charging = false;
                this.scene._shotCharging = false;
                this.scene._shotMeter = { value: this._t, charging: false, finalZone: zone };
            }
        }
    }

    _fireRelease(value, zone) {
        if (this._chargeReleaseSound && this.audio) {
            try { this.audio.playSound(this._chargeReleaseSound, 0.32); } catch (e) { /* nop */ }
        }
        // The court system listens for player_action and reads scene._shotMeter
        // to find the value + zone; we forward the intent via the bus.
        this.scene.events.game.emit("player_action", { action: "baller_shoot" });
    }

    _iHaveBall() {
        var ct = this.scene._court;
        var mp = this.scene._mp;
        var localPeerId = (mp && mp.localPeerId) || "local";
        return !!(ct && ct.ballHolder === localPeerId);
    }
}
