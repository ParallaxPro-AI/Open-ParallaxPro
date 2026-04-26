// also: tactical unit, command formation, strategic positioning, attack logic
// AI unit control — AI unit movement and combat during AI turn
class AIUnitControlBehavior extends GameScript {
    _behaviorName = "ai_unit_control";
    _unitType = "warrior";
    _attack = 20;
    _defense = 15;
    _health = 100;
    _maxHealth = 100;
    _movement = 2;
    _vision = 2;
    _moveSpeed = 4;
    _range = 0;
    _canFoundCity = false;

    _targetX = 0;
    _targetZ = 0;
    _moving = false;
    _dead = false;
    _currentAnim = "";
    _spawnX = 0; _spawnY = 0; _spawnZ = 0;
    _spawnHealth = 0;
    _spawnCaptured = false;

    onStart() {
        var self = this;
        if (!this._spawnCaptured) {
            var p = this.entity.transform.position;
            this._spawnX = p.x; this._spawnY = p.y; this._spawnZ = p.z;
            this._spawnHealth = this._health;
            this._spawnCaptured = true;
        }
        this.scene.events.game.on("ai_move_unit", function(data) {
            if (data.entityId !== self.entity.id) return;
            self._targetX = data.x;
            self._targetZ = data.z;
            self._moving = true;
        });
        this.scene.events.game.on("entity_damaged", function(data) {
            if (data.targetId !== self.entity.id) return;
            self._health -= data.damage || 0;
            if (self._health <= 0) {
                self._dead = true;
                self.entity.active = false;
                self.scene.events.game.emit("entity_killed", { entityId: self.entity.id, team: "ai" });
            }
        });
        // Restore on Play Again — without this, every dead AI unit
        // stayed deactivated and the player's "next match" had only the
        // surviving handful of enemies left from the previous one.
        var resetFn = function() {
            self._dead = false;
            self._health = self._spawnHealth;
            self._moving = false;
            self._currentAnim = "";
            self.entity.active = true;
            if (self.scene.setPosition) {
                self.scene.setPosition(self.entity.id, self._spawnX, self._spawnY, self._spawnZ);
            }
        };
        this.scene.events.game.on("game_ready", resetFn);
        this.scene.events.game.on("restart_game", resetFn);
    }

    onUpdate(dt) {
        if (this._dead || !this.entity.active) return;
        if (!this._moving) return;

        var pos = this.entity.transform.position;
        var dx = this._targetX - pos.x;
        var dz = this._targetZ - pos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < 0.5) {
            this._moving = false;
            this._playAnim("Idle");
        } else {
            this.scene.setPosition(this.entity.id,
                pos.x + (dx / dist) * this._moveSpeed * dt,
                pos.y,
                pos.z + (dz / dist) * this._moveSpeed * dt
            );
            this.entity.transform.setRotationEuler(0, Math.atan2(-dx, -dz) * 180 / Math.PI, 0);
            this._playAnim("Walk");
        }
    }

    _playAnim(name) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) this.entity.playAnimation(name, { loop: true });
    }
}
