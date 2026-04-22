// also: turn-based strategy, unit stats, selection system, grid-based movement
// Unit control — player unit behavior with selection, movement, and combat
class UnitControlBehavior extends GameScript {
    _behaviorName = "unit_control";
    _unitType = "warrior";
    _attack = 20;
    _defense = 15;
    _health = 100;
    _maxHealth = 100;
    _movement = 2;
    _vision = 2;
    _range = 0;
    _moveSpeed = 4;
    _siegeBonus = 1;
    _canFoundCity = false;

    _selected = false;
    _moving = false;
    _targetX = 0;
    _targetZ = 0;
    _movesLeft = 2;
    _currentAnim = "";
    _dead = false;

    onStart() {
        this._movesLeft = this._movement;
        var self = this;

        this.scene.events.game.on("turn_start", function() {
            self._movesLeft = self._movement;
            self._moving = false;
        });

        this.scene.events.game.on("select_unit", function(data) {
            if (data && data.entityId === self.entity.id) {
                self._selected = true;
            } else {
                self._selected = false;
            }
        });

        this.scene.events.game.on("move_unit", function(data) {
            if (!self._selected || self._movesLeft <= 0) return;
            self._targetX = data.x;
            self._targetZ = data.z;
            self._moving = true;
            self._movesLeft--;
        });

        this.scene.events.game.on("entity_damaged", function(data) {
            if (data.targetId !== self.entity.id) return;
            self._health -= data.damage || 0;
            if (self._health <= 0) {
                self._dead = true;
                self.entity.active = false;
                self.scene.events.game.emit("entity_killed", { entityId: self.entity.id, team: "player" });
            }
        });
    }

    onUpdate(dt) {
        if (this._dead || !this.entity.active) return;

        if (this._moving) {
            var pos = this.entity.transform.position;
            var dx = this._targetX - pos.x;
            var dz = this._targetZ - pos.z;
            var dist = Math.sqrt(dx * dx + dz * dz);

            if (dist < 0.5) {
                this._moving = false;
                this._playAnim("Idle");
            } else {
                var speed = this._moveSpeed;
                this.scene.setPosition(this.entity.id,
                    pos.x + (dx / dist) * speed * dt,
                    pos.y,
                    pos.z + (dz / dist) * speed * dt
                );
                this.entity.transform.setRotationEuler(0, Math.atan2(dx, dz) * 180 / Math.PI, 0);
                this._playAnim("Run");
            }
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
