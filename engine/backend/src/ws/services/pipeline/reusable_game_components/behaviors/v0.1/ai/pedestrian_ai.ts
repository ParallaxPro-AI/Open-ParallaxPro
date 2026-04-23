// also: civilian, npc_crowd, escape_behavior, panic_reaction, ambient_population
// Pedestrian AI — wanders randomly, flees from nearby gunshots
class PedestrianAIBehavior extends GameScript {
    _behaviorName = "pedestrian_ai";
    _walkSpeed = 2;
    _health = 50;
    _targetX = 0;
    _targetZ = 0;
    _waitTimer = 0;
    _fleeing = false;
    _dead = false;
    _currentAnim = "";
    _startX = 0;
    _startZ = 0;

    onStart() {
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._startZ = pos.z;
        this._pickNewTarget(pos.x, pos.z);
        this._waitTimer = Math.random() * 2;

        var self = this;

        this.scene.events.game.on("weapon_fired", function() {
            if (self._dead || !self.entity.active) return;
            var pos = self.entity.transform.position;
            var player = self.scene.findEntityByName("Player");
            if (!player) return;
            var pp = player.transform.position;
            if (self.scene._inVehicle && self.scene._vehicleEntity) {
                pp = self.scene._vehicleEntity.transform.position;
            }
            var dx = pos.x - pp.x;
            var dz = pos.z - pp.z;
            var dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < 30) {
                self._fleeing = true;
                var nd = dist > 0.1 ? dist : 1;
                self._targetX = pos.x + (dx / nd) * 35;
                self._targetZ = pos.z + (dz / nd) * 35;
                self._waitTimer = 0;
            }
        });

        this.scene.events.game.on("entity_damaged", function(data) {
            if (self._dead || data.entityId !== self.entity.id) return;
            self._health -= data.amount || 10;
            if (self._health <= 0) {
                self._dead = true;
                self._playAnim("Death");
                self.scene.events.game.emit("entity_killed", { entityId: self.entity.id });
                if (self.audio) self.audio.playSound("/assets/kenney/audio/impact_sounds/impactSoft_heavy_000.ogg", 0.4);
                setTimeout(function() { self.entity.active = false; }, 3000);
            } else {
                self._playAnim("RecieveHit");
                setTimeout(function() {
                    if (!self._dead) self._currentAnim = "";
                }, 500);
            }
        });

        this._playAnim("Idle");
    }

    _pickNewTarget(cx, cz) {
        this._targetX = this._startX + (Math.random() - 0.5) * 25;
        this._targetZ = this._startZ + (Math.random() - 0.5) * 25;
        this._waitTimer = Math.random() * 4 + 1;
    }

    onUpdate(dt) {
        if (this._dead) return;

        if (this._waitTimer > 0) {
            this._waitTimer -= dt;
            if (this._currentAnim !== "RecieveHit") {
                this._playAnim("Idle");
            }
            return;
        }

        var pos = this.entity.transform.position;
        var dx = this._targetX - pos.x;
        var dz = this._targetZ - pos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < 1.5) {
            this._fleeing = false;
            this._pickNewTarget(pos.x, pos.z);
            return;
        }

        var speed = this._fleeing ? this._walkSpeed * 2.5 : this._walkSpeed;
        var ndx = dx / dist;
        var ndz = dz / dist;

        this.scene.setPosition(this.entity.id,
            pos.x + ndx * speed * dt,
            pos.y,
            pos.z + ndz * speed * dt
        );

        var angle = Math.atan2(-dx, -dz) * 180 / Math.PI;
        this.entity.transform.setRotationEuler(0, angle, 0);

        this._playAnim(this._fleeing ? "Run" : "Walk");
    }

    _playAnim(name) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) {
            this.entity.playAnimation(name, { loop: name !== "Death" && name !== "RecieveHit" });
        }
    }
}
