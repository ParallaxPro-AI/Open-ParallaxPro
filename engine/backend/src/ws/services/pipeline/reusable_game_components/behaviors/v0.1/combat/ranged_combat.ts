// also: AI targeting, distance-based detection, auto-attack, archer, projectile
class RangedCombatBehavior extends GameScript {
    _behaviorName = "ranged_combat"; _damage = 12; _range = 20; _fireRate = 1.0; _cooldown = 0; _health = 80; _speed = 3; _dead = false; _currentAnim = "";
    // Visible arrow tracers — short-lived spheres that lerp from the
    // archer toward the target. Damage is still applied at fire-time;
    // the tracer is purely cosmetic.
    _tracers = [];
    onStart() { var self = this; this.scene.events.game.on("entity_damaged", function(d) { if (d.targetId!==self.entity.id) return; self._health-=d.damage||0; if (self._health<=0) { self._dead=true; self.entity.active=false; self.scene.events.game.emit("entity_killed",{entityId:self.entity.id,team:"player"}); } }); }
    onUpdate(dt) { this._updateTracers(dt); if (this._dead) return; this._cooldown -= dt;
        var p = this.entity.transform.position; var enemies = this.scene.findEntitiesByTag("enemy") || [];
        var best = null, bestD = this._range + 1;
        for (var i = 0; i < enemies.length; i++) { if (!enemies[i].active) continue; var ep = enemies[i].transform.position; var d = Math.sqrt((p.x-ep.x)*(p.x-ep.x)+(p.z-ep.z)*(p.z-ep.z)); if (d < bestD) { bestD = d; best = enemies[i]; } }
        if (best) { this.entity.transform.lookAt(best.transform.position.x, p.y, best.transform.position.z);
            if (this._cooldown <= 0) { this._cooldown = this._fireRate; this.scene.events.game.emit("entity_damaged", { targetId: best.id, damage: this._damage, source: "player" });
                var bp = best.transform.position;
                this._spawnTracer(p.x, p.y + 1.0, p.z, bp.x, bp.y + 1.0, bp.z);
                if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_002.ogg", 0.25); } this._playAnim("Idle"); }
        else { this._playAnim("Idle"); }
    }
    _playAnim(n) { if (this._currentAnim===n) return; this._currentAnim=n; if (this.entity.playAnimation) this.entity.playAnimation(n,{loop:true}); }

    _spawnTracer(fromX, fromY, fromZ, toX, toY, toZ) {
        if (!this.scene.createEntity) return;
        var name = "tr_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
        var id = this.scene.createEntity(name);
        if (id == null || id === -1) return;
        this.scene.setScale && this.scene.setScale(id, 0.18, 0.18, 0.18);
        this.scene.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: [0.85, 0.70, 0.30, 1]
        });
        this.scene.setPosition(id, fromX, fromY, fromZ);
        if (this.scene.addTag) this.scene.addTag(id, "tracer");
        var dx = toX - fromX, dy = toY - fromY, dz = toZ - fromZ;
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        var duration = Math.max(0.05, dist / 32);
        this._tracers.push({
            id: id, t: 0, duration: duration,
            fromX: fromX, fromY: fromY, fromZ: fromZ,
            toX: toX, toY: toY, toZ: toZ
        });
    }

    _updateTracers(dt) {
        for (var i = this._tracers.length - 1; i >= 0; i--) {
            var pr = this._tracers[i];
            pr.t += dt;
            var alpha = pr.t / pr.duration;
            if (alpha >= 1) {
                try { this.scene.destroyEntity && this.scene.destroyEntity(pr.id); } catch (e) {}
                this._tracers.splice(i, 1);
                continue;
            }
            this.scene.setPosition(pr.id,
                pr.fromX + (pr.toX - pr.fromX) * alpha,
                pr.fromY + (pr.toY - pr.fromY) * alpha,
                pr.fromZ + (pr.toZ - pr.fromZ) * alpha);
        }
    }
}
