// also: tower, defense mechanism, targeting, projectile, enemy detection
// Turret defense — stationary defense that auto-targets and fires at enemies
class TurretDefenseBehavior extends GameScript {
    _behaviorName = "turret_defense";
    _damage = 15; _range = 15; _fireRate = 1.5; _cooldown = 0; _team = "player";
    // Visible bullet tracers — short-lived spheres that lerp from turret
    // to target. Damage is applied at fire-time; the tracer is purely
    // cosmetic.
    _tracers = [];
    onUpdate(dt) { this._updateTracers(dt); this._cooldown -= dt; if (this._cooldown > 0) return;
        var pos = this.entity.transform.position; var enemies = this.scene.findEntitiesByTag("enemy") || [];
        var best = null, bestD = this._range + 1;
        for (var i = 0; i < enemies.length; i++) { if (!enemies[i].active) continue; var ep = enemies[i].transform.position; var d = Math.sqrt((pos.x-ep.x)*(pos.x-ep.x)+(pos.z-ep.z)*(pos.z-ep.z)); if (d < bestD) { bestD = d; best = enemies[i]; } }
        if (best) { this._cooldown = this._fireRate; this.entity.transform.lookAt(best.transform.position.x, best.transform.position.y, best.transform.position.z);
            this.scene.events.game.emit("entity_damaged", { targetId: best.id, damage: this._damage, source: this._team });
            var bp = best.transform.position;
            this._spawnTracer(pos.x, pos.y + 1.2, pos.z, bp.x, bp.y + 0.8, bp.z);
            if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_000.ogg", 0.25); }
    }

    _spawnTracer(fromX, fromY, fromZ, toX, toY, toZ) {
        if (!this.scene.createEntity) return;
        var name = "tr_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
        var id = this.scene.createEntity(name);
        if (id == null || id === -1) return;
        this.scene.setScale && this.scene.setScale(id, 0.16, 0.16, 0.16);
        this.scene.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: [1.0, 0.95, 0.40, 1]
        });
        this.scene.setPosition(id, fromX, fromY, fromZ);
        if (this.scene.addTag) this.scene.addTag(id, "tracer");
        var dx = toX - fromX, dy = toY - fromY, dz = toZ - fromZ;
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        var duration = Math.max(0.05, dist / 40);
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
