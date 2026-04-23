// also: pursuit mechanic, chase mechanic, persistent threat, runner escape, cop
// Guard chase — inspector character that runs behind the player as a constant threat
class GuardChaseBehavior extends GameScript {
    _behaviorName = "guard_chase";
    _followDistance = 8;
    _laneWidth = 2.5;
    _catchUpDelay = 1.5;
    _catchUpSpeed = 4;

    _active = false;
    _catching = false;
    _catchTimer = 0;
    _currentAnim = "";
    _startPos = [0, 0, 0];

    onStart() {
        var pos = this.entity.transform.position;
        this._startPos = [pos.x, pos.y, pos.z];

        var self = this;
        this.scene.events.game.on("race_start", function() {
            self._reset();
        });

        this.scene.events.game.on("race_started", function() {
            self._active = true;
            self._playAnim("Run");
        });

        this.scene.events.game.on("runner_crash", function() {
            self._catching = true;
            self._catchTimer = 0;
        });

        this.scene.events.game.on("restart_game", function() {
            self._reset();
        });
    }

    _reset() {
        this._active = false;
        this._catching = false;
        this._catchTimer = 0;
        this._currentAnim = "";
        this.scene.setPosition(this.entity.id, this._startPos[0], this._startPos[1], this._startPos[2]);
        this._playAnim("Idle");
    }

    onUpdate(dt) {
        if (!this._active) return;

        var player = this.scene.findEntityByName("Runner");
        if (!player) return;

        var pp = player.transform.position;
        var pos = this.entity.transform.position;

        if (this._catching) {
            // Guard catches up to player after crash
            this._catchTimer += dt;
            var targetZ = pp.z + 2;
            var moveZ = pos.z + (targetZ - pos.z) * Math.min(1, this._catchUpSpeed * dt);
            this.scene.setPosition(this.entity.id, 0, 1, moveZ);
            this._playAnim("Run");

            // When guard reaches player, trigger game over
            if (Math.abs(pos.z - pp.z) < 3 && this._catchTimer > 0.3) {
                this.scene.events.game.emit("game_over", {});
                this._playAnim("Idle");
                this._active = false;
            }
            return;
        }

        // Follow behind player at fixed distance
        var targetX = 0;
        var targetY = 1;
        var targetZ = pp.z + this._followDistance;

        // Smooth follow
        var t = 1 - Math.exp(-3 * dt);
        var newX = pos.x + (targetX - pos.x) * t;
        var newZ = pos.z + (targetZ - pos.z) * t;

        this.scene.setPosition(this.entity.id, newX, targetY, newZ);

        // Face forward (-Z)
        this.entity.transform.setRotationEuler(0, 180, 0);
        this._playAnim("Run");
    }

    _playAnim(name) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) {
            this.entity.playAnimation(name, { loop: true });
        }
    }
}
