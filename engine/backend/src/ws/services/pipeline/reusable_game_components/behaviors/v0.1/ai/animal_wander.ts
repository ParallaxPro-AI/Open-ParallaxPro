// also: creature behavior, livestock, wildlife roaming, autonomous motion
// Animal wander — passive animal AI that roams randomly, flees from damage
class AnimalWanderBehavior extends GameScript {
    _behaviorName = "animal_wander";
    _speed = 2;
    _wanderRadius = 15;
    _health = 30;
    _dropItem = "food";
    _dropAmount = 1;

    _targetX = 0;
    _targetZ = 0;
    _moveTimer = 0;
    _startX = 0;
    _startZ = 0;
    _dead = false;
    _fleeing = false;
    _fleeTimer = 0;
    _currentAnim = "";

    onStart() {
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._startZ = pos.z;
        this._pickTarget();

        var self = this;
        this.scene.events.game.on("entity_damaged", function(data) {
            if (data.targetId !== self.entity.id) return;
            self._health -= data.damage || 0;
            if (self._health <= 0) {
                self._dead = true;
                self.entity.active = false;
                self.scene.events.game.emit("entity_killed", { entityId: self.entity.id, dropItem: self._dropItem, dropAmount: self._dropAmount });
            } else {
                self._fleeing = true;
                self._fleeTimer = 3;
                var pp = self.scene.findEntityByName("Player");
                if (pp) {
                    var pPos = pp.transform.position;
                    var ePos = self.entity.transform.position;
                    self._targetX = ePos.x + (ePos.x - pPos.x) * 2;
                    self._targetZ = ePos.z + (ePos.z - pPos.z) * 2;
                }
            }
        });
    }

    _pickTarget() {
        this._targetX = this._startX + (Math.random() - 0.5) * this._wanderRadius * 2;
        this._targetZ = this._startZ + (Math.random() - 0.5) * this._wanderRadius * 2;
        this._moveTimer = 3 + Math.random() * 5;
    }

    onUpdate(dt) {
        if (this._dead || !this.entity.active) return;

        if (this._fleeing) {
            this._fleeTimer -= dt;
            if (this._fleeTimer <= 0) { this._fleeing = false; this._pickTarget(); }
        }

        this._moveTimer -= dt;
        if (this._moveTimer <= 0 && !this._fleeing) this._pickTarget();

        var pos = this.entity.transform.position;
        var dx = this._targetX - pos.x;
        var dz = this._targetZ - pos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > 1) {
            var speed = this._fleeing ? this._speed * 2 : this._speed;
            var step = speed * dt;
            var ux = dx / dist;
            var uz = dz / dist;
            // Wall guard: kinematic colliders don't push back on
            // setPosition teleports, so without this raycast the animal
            // walks straight through stone/wood walls. Cast horizontally
            // a bit further than the step we're about to take and skip
            // the move if we'd cross a wall. Picks a new wander target
            // on the next tick if blocked.
            var blocked = false;
            if (this.scene.raycast) {
                var hit = this.scene.raycast(pos.x, pos.y + 0.6, pos.z, ux, 0, uz, step + 0.8);
                if (hit && hit.entityId !== this.entity.id) {
                    blocked = true;
                    this._moveTimer = 0;
                }
            }
            if (!blocked) {
                this.scene.setPosition(this.entity.id, pos.x + ux * step, pos.y, pos.z + uz * step);
            }
            this.entity.transform.setRotationEuler(0, Math.atan2(-dx, -dz) * 180 / Math.PI, 0);
            this._playAnim("Walk");
        } else {
            this._playAnim("Idle");
        }
    }

    _playAnim(name) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) this.entity.playAnimation(name, { loop: true });
    }
}
