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
    _startY = 0;
    _startZ = 0;
    _currentAnim = "";
    _lastX = 0;
    _lastZ = 0;
    _stuckFrames = 0;

    onStart() {
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._startY = pos.y;
        this._startZ = pos.z;
        this._lastX = pos.x;
        this._lastZ = pos.z;
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
        if (!player) { this._patrol(dt); this._tickStuck(pos, true); return; }

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
                // Only count "stuck" while we're actively trying to
                // close distance — standing in melee range to attack
                // isn't stuck, it's working as intended.
                this._tickStuck(pos, true);
            } else if (this._cooldown <= 0) {
                this._cooldown = this._attackRate;
                this.scene.events.game.emit("entity_damaged", { targetId: player.id, damage: this._damage, source: "hostile" });
                if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/knifeSlice2.ogg", 0.35);
                this._playAnim("Idle");
                this._stuckFrames = 0;
            }
        } else {
            this._patrol(dt);
            this._tickStuck(pos, false);
        }
    }

    // setPosition is a teleport that bypasses collision response, so a
    // mob can end up inside a wall — player builds blocks around it,
    // slack misses an angled hit, world-gen places a tree on top of a
    // spawn point. From inside the wall the raycast reads the wall's
    // back face as a normal hit and the mob freezes there. Detect "I
    // wanted to move and didn't actually translate" for 1.5s and yank
    // the mob back to its spawn point — known-safe ground.
    _tickStuck(pos, urgent) {
        var dxLast = pos.x - this._lastX;
        var dzLast = pos.z - this._lastZ;
        if (dxLast * dxLast + dzLast * dzLast < 0.01) {
            this._stuckFrames++;
            // Urgent (chasing) → teleport sooner; patrol → wait longer
            // since standing for a tick is normal between wander targets.
            var threshold = urgent ? 90 : 240;
            if (this._stuckFrames > threshold) {
                this.scene.setPosition(this.entity.id, this._startX, this._startY, this._startZ);
                this._lastX = this._startX;
                this._lastZ = this._startZ;
                this._stuckFrames = 0;
            }
        } else {
            this._stuckFrames = 0;
            this._lastX = pos.x;
            this._lastZ = pos.z;
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

    // Try the desired direction, then four fallback angles: ±45° and
    // ±90°. Five attempts is enough to follow most wall + corner shapes
    // without real pathfinding. If every angle is blocked, the mob just
    // stands still this frame — that's a real "I can't reach you"
    // situation, e.g. the player is inside an enclosed room. Forcing
    // movement through would be a wallhack.
    _tryMoveWithSlide(pos, ux, uz, step) {
        if (this._stepIfClear(pos, ux, uz, step)) return true;
        var c = 0.7071, s = 0.7071;
        var lx = ux * c - uz * s, lz = ux * s + uz * c;   // +45°
        if (this._stepIfClear(pos, lx, lz, step)) return true;
        var rx = ux * c + uz * s, rz = -ux * s + uz * c;  // -45°
        if (this._stepIfClear(pos, rx, rz, step)) return true;
        if (this._stepIfClear(pos, -uz, ux, step)) return true;  // +90°
        if (this._stepIfClear(pos, uz, -ux, step)) return true;  // -90°
        return false;
    }

    // Capsule-aware horizontal cast at chest height. Slack of 0.7m
    // covers a typical capsule radius (~0.4m) plus a small margin so
    // the body stops a few centimetres short of the wall instead of
    // shoulder-clipping into it. Going much wider made mobs read as
    // standoffish, and going much narrower let capsule edges sneak
    // past on angled approaches.
    _stepIfClear(pos, ux, uz, step) {
        if (step <= 0) return false;
        if (this.scene.raycast) {
            var hit = this.scene.raycast(pos.x, pos.y + 1.0, pos.z, ux, 0, uz, step + 0.7);
            if (hit && hit.entityId !== this.entity.id) return false;
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
