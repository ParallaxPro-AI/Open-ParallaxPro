// also: sentry, guard_route, stationary_defense, boundary_patrol, access_control
// Patrol AI — guard NPC that patrols between waypoints
class PatrolAIBehavior extends GameScript {
    _behaviorName = "patrol_ai";
    _speed = 2;
    _range = 10;
    _dir = 1;
    _startX = 0;

    onStart() { this._startX = this.entity.transform.position.x; this._dir = Math.random() < 0.5 ? 1 : -1; }

    onUpdate(dt) {
        if (!this.entity.active) return;
        var p = this.entity.transform.position;
        var newX = p.x + this._dir * this._speed * dt;
        if (Math.abs(newX - this._startX) > this._range) { this._dir *= -1; newX = p.x + this._dir * this._speed * dt; }
        this.scene.setPosition(this.entity.id, newX, p.y, p.z);
        this.entity.transform.setRotationEuler(0, this._dir > 0 ? 90 : -90, 0);
        if (this.entity.playAnimation) this.entity.playAnimation("Walk", { loop: true });
    }
}
