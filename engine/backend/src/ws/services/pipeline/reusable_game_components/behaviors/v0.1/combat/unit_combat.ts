// also: NPC behavior, AI pathfinding, enemy detection, autonomous fighter
// Unit combat — melee fighter that moves to and attacks nearest enemy.
// Honours player-issued commands from rts_input: a move-to point or a
// specific attack target overrides autonomous targeting until completed.
class UnitCombatBehavior extends GameScript {
    _behaviorName = "unit_combat"; _damage = 15; _attackRange = 3; _attackRate = 0.8; _speed = 4; _detectRange = 20; _health = 100; _dead = false; _cooldown = 0; _currentAnim = "";
    _cmdMoveX = 0; _cmdMoveZ = 0; _cmdHasMove = false; _cmdTargetId = "";
    onStart() {
        var self = this;
        this.scene.events.game.on("entity_damaged", function(d) {
            if (d.targetId !== self.entity.id) return;
            self._health -= d.damage || 0;
            if (self._health <= 0) {
                self._dead = true;
                self.entity.active = false;
                self.scene.events.game.emit("entity_killed", { entityId: self.entity.id, team: "player" });
            }
        });
        this.scene.events.game.on("unit_command_move", function(d) {
            if (!d || d.entityId !== self.entity.id) return;
            self._cmdMoveX = d.x;
            self._cmdMoveZ = d.z;
            self._cmdHasMove = true;
            self._cmdTargetId = "";
        });
        this.scene.events.game.on("unit_command_attack", function(d) {
            if (!d || d.entityId !== self.entity.id) return;
            self._cmdTargetId = d.targetId || "";
            self._cmdHasMove = false;
        });
    }
    onUpdate(dt) {
        if (this._dead) return;
        this._cooldown -= dt;
        var p = this.entity.transform.position;

        // 1) Player attack-command — chase the assigned target until dead.
        if (this._cmdTargetId) {
            var tgt = this.scene.findEntityById ? this.scene.findEntityById(this._cmdTargetId) : null;
            if (!tgt || !tgt.active) {
                this._cmdTargetId = "";
            } else {
                var tp = tgt.transform.position;
                var dx = tp.x - p.x, dz = tp.z - p.z;
                var dist = Math.sqrt(dx * dx + dz * dz);
                this.entity.transform.setRotationEuler(0, Math.atan2(-dx, -dz) * 180 / Math.PI, 0);
                if (dist > this._attackRange) {
                    this.scene.setPosition(this.entity.id, p.x + (dx / dist) * this._speed * dt, p.y, p.z + (dz / dist) * this._speed * dt);
                    this._playAnim("Run");
                } else if (this._cooldown <= 0) {
                    this._cooldown = this._attackRate;
                    this.scene.events.game.emit("entity_damaged", { targetId: tgt.id, damage: this._damage, source: "player" });
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/knifeSlice.ogg", 0.3);
                    this._playAnim("Idle");
                }
                return;
            }
        }

        // 2) Player move-command — walk to point, then drop the command.
        if (this._cmdHasMove) {
            var mdx = this._cmdMoveX - p.x, mdz = this._cmdMoveZ - p.z;
            var mdist = Math.sqrt(mdx * mdx + mdz * mdz);
            if (mdist < 0.6) {
                this._cmdHasMove = false;
                this._playAnim("Idle");
            } else {
                this.scene.setPosition(this.entity.id, p.x + (mdx / mdist) * this._speed * dt, p.y, p.z + (mdz / mdist) * this._speed * dt);
                this.entity.transform.setRotationEuler(0, Math.atan2(-mdx, -mdz) * 180 / Math.PI, 0);
                this._playAnim("Run");
            }
            return;
        }

        // 3) Autonomous: chase nearest enemy in detect range.
        var enemies = this.scene.findEntitiesByTag("enemy") || [];
        var best = null, bestD = this._detectRange + 1;
        for (var i = 0; i < enemies.length; i++) {
            if (!enemies[i].active) continue;
            var ep = enemies[i].transform.position;
            var d = Math.sqrt((p.x - ep.x) * (p.x - ep.x) + (p.z - ep.z) * (p.z - ep.z));
            if (d < bestD) { bestD = d; best = enemies[i]; }
        }
        if (best) {
            var ep2 = best.transform.position;
            var dx2 = ep2.x - p.x, dz2 = ep2.z - p.z;
            this.entity.transform.setRotationEuler(0, Math.atan2(-dx2, -dz2) * 180 / Math.PI, 0);
            if (bestD > this._attackRange) {
                this.scene.setPosition(this.entity.id, p.x + (dx2 / bestD) * this._speed * dt, p.y, p.z + (dz2 / bestD) * this._speed * dt);
                this._playAnim("Run");
            } else if (this._cooldown <= 0) {
                this._cooldown = this._attackRate;
                this.scene.events.game.emit("entity_damaged", { targetId: best.id, damage: this._damage, source: "player" });
                if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/knifeSlice.ogg", 0.3);
                this._playAnim("Idle");
            }
        } else {
            this._playAnim("Idle");
        }
    }
    _playAnim(n) { if (this._currentAnim === n) return; this._currentAnim = n; if (this.entity.playAnimation) this.entity.playAnimation(n, { loop: true }); }
}
