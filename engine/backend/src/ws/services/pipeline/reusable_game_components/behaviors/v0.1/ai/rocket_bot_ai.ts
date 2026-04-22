// also: soccer_bot, vehicle_soccer, goal_defense, ball_chasing, sports_ai
// Rocket car AI bot — a simple chase-the-ball-and-shoot-at-the-opponent-goal
// driver for solo play / 1v1-with-bot modes.
//
// Strategy (intentionally easy to beat so the template feels fair):
//   1. Drive toward a point just behind the ball so a hit sends it
//      toward the opponent goal.
//   2. If the ball is heading toward our goal, try to reach the ball
//      between it and our goal (rudimentary defense).
//   3. Boost when distant, brake if overshooting, jump occasionally at
//      the ball for "aerial" feel.
//
// Lives alongside rocket_car_control: that script bails on entities
// flagged `_isBot`, so putting both behaviours on the entity is safe.
//
// Parameters (all overridable in 02_entities.json):
//   _ownGoalZ           z of our goal line (so we know what we defend)
//   _oppGoalZ           z of opponent goal
//   _aggressiveness     0..1 — how often to commit to a swing vs set up
//   _boostMin           boost reserve below which we stop boosting
class RocketBotAiBehavior extends GameScript {
    _behaviorName = "rocket_bot_ai";

    _maxSpeed = 20;
    _boostForce = 16;
    _steerRate = 2.4;
    _aggressiveness = 0.75;
    _jumpWindow = 3.4;
    _boostMin = 12;
    _ownGoalZ = 28;             // default: bot defends the +z goal
    _oppGoalZ = -28;

    _jumpCd = 0;
    _boostTimer = 0;

    onUpdate(dt) {
        if (!this.entity._isBot) return;
        if (this.scene._rocketFrozen) {
            this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
            return;
        }

        var ball = this.scene.findEntityByName && this.scene.findEntityByName("Ball");
        if (!ball) return;
        var bp = ball.transform.position;
        var cp = this.entity.transform.position;

        // Desired target: point behind the ball relative to opponent's
        // goal. Behind = on the bot's side of the ball.
        var goalDir = Math.sign(this._oppGoalZ - bp.z) || -1;
        var targetX = bp.x;
        var targetZ = bp.z - goalDir * 2.4;

        // If the ball is barrelling toward our goal, go defend by aiming
        // between the ball and our goal instead.
        var ballVx = ball._rocketBallVx || 0;
        var ballVz = ball._rocketBallVz || 0;
        if ((this._ownGoalZ - bp.z) * ballVz > 0 && Math.abs(ballVz) > 4) {
            // Swap the target to be between ball and own goal.
            targetX = bp.x;
            targetZ = (bp.z + this._ownGoalZ) * 0.5;
        }

        var dx = targetX - cp.x;
        var dz = targetZ - cp.z;
        var dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < 0.001) dist = 0.001;
        var desiredYaw = Math.atan2(dx, -dz);

        var curYaw = this.entity.transform.getRotationEuler ? this.entity.transform.getRotationEuler().y : 0;
        var dy = desiredYaw - curYaw;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        curYaw += Math.max(-this._steerRate * dt, Math.min(this._steerRate * dt, dy));
        this.entity.transform.setRotationEuler(0, curYaw, 0);

        var fx = Math.sin(curYaw);
        var fz = -Math.cos(curYaw);

        // Rev harder when far from the target, coast when close. Boost if
        // we have enough in reserve and are not already flat-out.
        var speed = this._maxSpeed * Math.min(1, dist / 6 + 0.35 * this._aggressiveness);
        var boost = this.scene._rocketBoost || {};
        var myBoost = boost[this._botBoostKey()] || 0;
        if (myBoost > this._boostMin && dist > 8) {
            speed += this._boostForce;
            this.scene.events.game.emit("rocket_boost_tick", {
                amount: 25 * dt, peerId: this._botBoostKey(),
            });
        }

        var vy = 0;
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        if (rb && rb.getLinearVelocity) vy = rb.getLinearVelocity().y;

        // Jump toward the ball when close and the ball is airborne.
        this._jumpCd = Math.max(0, this._jumpCd - dt);
        var airDist = Math.sqrt(dx * dx + dz * dz + (bp.y - cp.y) * (bp.y - cp.y));
        if (this._jumpCd <= 0 && airDist < this._jumpWindow && bp.y > 1.8 && Math.abs(vy) < 0.4) {
            vy = 8.5;
            this._jumpCd = 0.9;
        }

        this.scene.setVelocity(this.entity.id, {
            x: fx * speed,
            y: vy,
            z: fz * speed,
        });
    }

    _botBoostKey() {
        // Bots share a single key so the match system can track their boost
        // reserve alongside peer reserves. Each bot gets a stable key set
        // at spawn by the system (e.g. "bot_1").
        return this.entity._rocketBotId || "bot";
    }
}
