// also: platform_hazard, jumping_obstacle, stomp_target, platformer_foe, bouncing
// Patrol enemy — walks back and forth on a platform, can be stomped
class PatrolEnemyBehavior extends GameScript {
    _behaviorName = "patrol_enemy";
    _speed = 2;
    _range = 3;
    _dir = 1;
    _startX = 0;
    _currentAnim = "";

    onStart() {
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._dir = Math.random() < 0.5 ? 1 : -1;
        this._playAnim("Walk");
    }

    onUpdate(dt) {
        if (!this.entity.active) return;

        var pos = this.entity.transform.position;
        var newX = pos.x + this._dir * this._speed * dt;

        if (Math.abs(newX - this._startX) > this._range) {
            this._dir *= -1;
            newX = pos.x + this._dir * this._speed * dt;
        }

        this.scene.setPosition(this.entity.id, newX, pos.y, pos.z);

        var angle = this._dir > 0 ? 90 : -90;
        this.entity.transform.setRotationEuler(0, angle, 0);

        this._playAnim("Walk");
    }

    _playAnim(name) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) {
            this.entity.playAnimation(name, { loop: true });
        }
    }
}
