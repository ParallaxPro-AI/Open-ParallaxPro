// also: naval enemy, pirate ship, sea encounter, broadside combat, vessel
// Ghost ship — NPC enemy galleon. Wanders the open sea by default,
// detects player ships within range, then steers toward them and fires
// broadside cannons at intervals. Fully owned by the lobby host in
// multiplayer (one source of truth) — every other peer receives the
// ship transform via host snapshots and skips this behavior's update
// path entirely.
class GhostShipBehavior extends GameScript {
    _behaviorName = "ghost_ship";
    _maxHealth = 80;
    _speed = 5;
    _detectionRange = 26;
    _attackRange = 18;
    _attackInterval = 2.4;
    _damage = 18;
    _wanderRadius = 18;
    _wanderRetargetTime = 6;
    _hostOnly = true;
    _bobAmplitude = 3;
    _bobFreq = 0.4;
    _collisionLead = 4.0;     // distance ahead of origin for the collision raycast (ship half-length)
    _collisionPadding = 0.5;
    _hitSound = "";
    _fireSound = "";
    _sinkSound = "";

    _health = 80;
    _dead = false;
    _yawDeg = 0;
    _attackTimer = 0;
    _wanderTimer = 0;
    _wanderTargetX = 0;
    _wanderTargetZ = 0;
    _baseX = 0;
    _baseZ = 0;
    _bobPhase = 0;

    onStart() {
        var pos = this.entity.transform && this.entity.transform.position;
        this._baseX = pos ? pos.x : 0;
        this._baseZ = pos ? pos.z : 0;
        this._wanderTargetX = this._baseX;
        this._wanderTargetZ = this._baseZ;
        this._bobPhase = Math.random() * Math.PI * 2;
        this._health = this._maxHealth;

        var self = this;
        this.scene.events.game.on("entity_damaged", function(data) {
            if (self._dead) return;
            if (!data || data.entityId !== self.entity.id) return;
            self._health -= data.amount || 0;
            if (self._hitSound && self.audio) self.audio.playSound(self._hitSound, 0.4);
            if (self._health <= 0) {
                self._dead = true;
                self.entity.active = false;
                if (self._sinkSound && self.audio) self.audio.playSound(self._sinkSound, 0.5);
                self.scene.events.game.emit("entity_killed", { entityId: self.entity.id });
            }
        });
    }

    onUpdate(dt) {
        if (this._dead || !this.entity.active) return;
        // Host-only AI in multiplayer; everyone else just sees the
        // transform via snapshots. Single-player templates have no _mp,
        // so the AI runs on the only peer.
        var mp = this.scene._mp;
        if (this._hostOnly && mp && !mp.isHost) return;

        // Always apply a gentle wave bob locally so even non-authoritative
        // peers feel the ocean motion (this just rotates the model).
        this._bobPhase += dt * this._bobFreq * Math.PI * 2;
        if (this._bobPhase > Math.PI * 2) this._bobPhase -= Math.PI * 2;

        var pos = this.entity.transform.position;
        var target = this._findClosestPlayer(pos);
        var inRange = false;
        if (target) {
            var dx = target.transform.position.x - pos.x;
            var dz = target.transform.position.z - pos.z;
            var d2 = dx * dx + dz * dz;
            inRange = d2 < this._detectionRange * this._detectionRange;
        }

        if (inRange) {
            this._chase(dt, target, pos);
        } else {
            this._wander(dt, pos);
        }

        // Apply rotation: yaw + wave-roll. Keep pitch tiny so the ship
        // doesn't look seasick.
        var roll = Math.sin(this._bobPhase) * this._bobAmplitude;
        if (this.entity.transform.setRotationEuler) {
            this.entity.transform.setRotationEuler(0, -this._yawDeg, roll);
        }
    }

    _chase(dt, target, pos) {
        var tp = target.transform.position;
        var dx = tp.x - pos.x;
        var dz = tp.z - pos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < 0.001) return;

        // Steer toward the target. Yaw lerps slowly toward desired so the
        // ghost ship banks like a real galleon instead of snapping.
        var desiredYaw = Math.atan2(dx, -dz) * 180 / Math.PI;
        this._yawDeg = this._lerpAngle(this._yawDeg, desiredYaw, 1.5 * dt);

        // Drift to a stand-off range so the ghost isn't ramming the player.
        if (dist > this._attackRange * 0.85) {
            var ux = dx / dist;
            var uz = dz / dist;
            var step = this._speed * dt;
            if (this._isPathBlocked(pos, ux, uz, step)) return;
            if (this.scene.setPosition) {
                this.scene.setPosition(this.entity.id, pos.x + ux * step, pos.y, pos.z + uz * step);
            }
        }

        // Fire broadside if in range.
        this._attackTimer -= dt;
        if (dist <= this._attackRange && this._attackTimer <= 0) {
            this._attackTimer = this._attackInterval;
            this._fireBroadside(target);
        }
    }

    _wander(dt, pos) {
        this._wanderTimer -= dt;
        if (this._wanderTimer <= 0) {
            this._wanderTimer = this._wanderRetargetTime + Math.random() * 4;
            this._wanderTargetX = this._baseX + (Math.random() - 0.5) * this._wanderRadius * 2;
            this._wanderTargetZ = this._baseZ + (Math.random() - 0.5) * this._wanderRadius * 2;
        }
        var dx = this._wanderTargetX - pos.x;
        var dz = this._wanderTargetZ - pos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 1) {
            var ux = dx / dist;
            var uz = dz / dist;
            var desiredYaw = Math.atan2(dx, -dz) * 180 / Math.PI;
            this._yawDeg = this._lerpAngle(this._yawDeg, desiredYaw, 0.8 * dt);
            var step = this._speed * 0.5 * dt;
            if (this._isPathBlocked(pos, ux, uz, step)) {
                // Blocked while wandering — pick a new wander target so we
                // don't stall against the obstacle for the rest of the timer.
                this._wanderTimer = 0;
                return;
            }
            if (this.scene.setPosition) {
                this.scene.setPosition(this.entity.id, pos.x + ux * step, pos.y, pos.z + uz * step);
            }
        }
    }

    _isPathBlocked(pos, ux, uz, step) {
        if (!this.scene.raycast || step <= 0.001) return false;
        // Cast from origin (ship body excluded via entity.id). Ignore hits
        // within _collisionLead — those are existing overlaps; only block
        // on genuine obstacles past the bow. Same logic as ship_sail to
        // avoid a stuck-against-collider deadlock.
        var rayLen = this._collisionLead + step + this._collisionPadding;
        var hit = this.scene.raycast(pos.x, (pos.y || 0) + 0.5, pos.z,
                                     ux, 0, uz,
                                     rayLen,
                                     this.entity.id);
        return !!(hit && hit.distance >= this._collisionLead);
    }

    _fireBroadside(target) {
        if (this._fireSound && this.audio) this.audio.playSound(this._fireSound, 0.5);
        // Broadcast hit on the target player. In single-player this lands
        // on ship_health directly. In multiplayer the host's emit reaches
        // every peer locally; we additionally forward via net_player_shot
        // so the target peer is authoritative for its own damage.
        this.scene.events.game.emit("entity_damaged", {
            entityId: target.id, amount: this._damage, source: "ghost_ship",
        });
        var ni = target.getComponent ? target.getComponent("NetworkIdentityComponent") : null;
        var mp = this.scene._mp;
        if (mp && ni && typeof ni.ownerId === "string" && ni.ownerId) {
            mp.sendNetworkedEvent("player_shot", {
                targetPeerId: ni.ownerId,
                damage: this._damage,
                shooterPeerId: "ghost_ship",
            });
        }
    }

    _findClosestPlayer(pos) {
        var ships = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        var best = null;
        var bestD2 = Infinity;
        for (var i = 0; i < ships.length; i++) {
            var s = ships[i];
            if (!s || !s.transform || !s.active) continue;
            var dx = s.transform.position.x - pos.x;
            var dz = s.transform.position.z - pos.z;
            var d2 = dx * dx + dz * dz;
            if (d2 < bestD2) { bestD2 = d2; best = s; }
        }
        return best;
    }

    _lerpAngle(cur, target, amt) {
        var d = target - cur;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        return cur + d * Math.min(1, Math.max(0, amt));
    }
}
