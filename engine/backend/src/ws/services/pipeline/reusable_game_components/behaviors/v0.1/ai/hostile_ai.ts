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
                this._tryMoveWithSlide(pos, dx / dist, dz / dist, this._speed * dt);
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
            var moved = this._tryMoveWithSlide(pos, dx / dist, dz / dist, this._speed * 0.4 * dt);
            this.entity.transform.setRotationEuler(0, Math.atan2(-dx, -dz) * 180 / Math.PI, 0);
            // If every direction is blocked, pick a fresh wander target
            // so we don't sit pressed into the wall.
            if (!moved) this._pickPatrol();
            this._playAnim("Walk");
        } else {
            this._playAnim("Idle");
        }
    }

    // Try the desired direction, then five fallback angles: 45° and 90°
    // off either side. Five attempts is enough to follow most wall and
    // corner shapes without real pathfinding. If everything is blocked,
    // the entity is jammed (capsule inside geometry) — let the move
    // through anyway as an escape hatch so the mob doesn't stay welded
    // to the wall forever.
    _tryMoveWithSlide(pos, ux, uz, step) {
        // Direct.
        if (this._stepIfClear(pos, ux, uz, step)) return true;
        // ±45° — diagonals catch most "almost-aligned" wall hits.
        var c = 0.7071, s = 0.7071;
        var lx = ux * c - uz * s, lz = ux * s + uz * c;   // +45° left
        if (this._stepIfClear(pos, lx, lz, step)) return true;
        var rx = ux * c + uz * s, rz = -ux * s + uz * c;  // -45° right
        if (this._stepIfClear(pos, rx, rz, step)) return true;
        // ±90° — pure sideways slide.
        if (this._stepIfClear(pos, -uz, ux, step)) return true;
        if (this._stepIfClear(pos, uz, -ux, step)) return true;
        // All five blocked — assume capsule is inside geometry. Force
        // the original step so the mob can claw its way back out
        // instead of vibrating in place.
        this.scene.setPosition(this.entity.id, pos.x + ux * step, pos.y, pos.z + uz * step);
        return false;
    }

    // Capsule-aware horizontal cast. Slack is 1.4m: kenney/quaternius
    // mob capsules are ~0.4m radius, and the proposed step has to clear
    // not just the centerline ray but the capsule edges too. A snug
    // 0.9m slack let the mob shoulder-clip into walls on angled
    // approaches; 1.4m leaves enough daylight that the body stops with
    // visible space between it and the wall. Also short-circuits
    // "blocked" when the hit is < 0.15m away (we're already inside the
    // wall — let the move through so we can escape).
    _stepIfClear(pos, ux, uz, step) {
        if (step <= 0) return false;
        if (this.scene.raycast) {
            var hit = this.scene.raycast(pos.x, pos.y + 1.0, pos.z, ux, 0, uz, step + 1.4);
            if (hit && hit.entityId !== this.entity.id && hit.distance > 0.15) return false;
        }
        this.scene.setPosition(this.entity.id, pos.x + ux * step, pos.y, pos.z + uz * step);
        return true;
    }

    _playAnim(name) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity.playAnimation) this.entity.playAnimation(name, { loop: true });
    }
}
