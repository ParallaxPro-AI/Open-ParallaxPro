// also: aggressive monster, combat encounter, predator behavior, threat system
// Hostile AI — aggressive mob that patrols, detects, chases, and attacks the player
class HostileAIBehavior extends GameScript {
    _behaviorName = "hostile_ai";
    _health = 80;
    _damage = 10;
    _speed = 3;
    _detectRange = 18;
    _attackRange = 2.5;
    _attackRate = 1.2;
    _wanderRadius = 12;
    _dropItem = "bone";
    _dropAmount = 1;

    _dead = false;
    _cooldown = 0;
    _targetX = 0;
    _targetZ = 0;
    _patrolTimer = 0;
    _startX = 0;
    _startZ = 0;
    _currentAnim = "";

    onStart() {
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._startZ = pos.z;
        this._pickPatrol();

        var self = this;
        this.scene.events.game.on("entity_damaged", function(data) {
            if (data.targetId !== self.entity.id) return;
            self._health -= data.damage || 0;
            if (self._health <= 0) {
                self._dead = true;
                self.entity.active = false;
                self.scene.events.game.emit("entity_killed", { entityId: self.entity.id, dropItem: self._dropItem });
                if (self.audio) self.audio.playSound("/assets/kenney/audio/impact_sounds/impactPunch_heavy_000.ogg", 0.4);
            }
        });
    }

    _pickPatrol() {
        this._targetX = this._startX + (Math.random() - 0.5) * this._wanderRadius * 2;
        this._targetZ = this._startZ + (Math.random() - 0.5) * this._wanderRadius * 2;
        this._patrolTimer = 4 + Math.random() * 4;
    }

    onUpdate(dt) {
        if (this._dead || !this.entity.active) return;
        this._cooldown -= dt;

        var pos = this.entity.transform.position;
        var player = this.scene.findEntityByName("Player");
        if (!player) { this._patrol(dt); return; }

        var pp = player.transform.position;
        var dx = pp.x - pos.x;
        var dz = pp.z - pos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < this._detectRange) {
            // Chase player
            this.entity.transform.setRotationEuler(0, Math.atan2(-dx, -dz) * 180 / Math.PI, 0);

            if (dist > this._attackRange) {
                this.scene.setPosition(this.entity.id, pos.x + (dx / dist) * this._speed * dt, pos.y, pos.z + (dz / dist) * this._speed * dt);
                this._playAnim("Run");
            } else if (this._cooldown <= 0) {
                // Attack!
                this._cooldown = this._attackRate;
                this.scene.events.game.emit("entity_damaged", { targetId: player.id, damage: this._damage, source: "hostile" });
                if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/knifeSlice2.ogg", 0.35);
                this._playAnim("Idle");
            }
        } else {
            this._patrol(dt);
        }
    }

    _patrol(dt) {
        this._patrolTimer -= dt;
        if (this._patrolTimer <= 0) this._pickPatrol();

        var pos = this.entity.transform.position;
        var dx = this._targetX - pos.x;
        var dz = this._targetZ - pos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > 1.5) {
            this.scene.setPosition(this.entity.id, pos.x + (dx / dist) * this._speed * 0.4 * dt, pos.y, pos.z + (dz / dist) * this._speed * 0.4 * dt);
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
