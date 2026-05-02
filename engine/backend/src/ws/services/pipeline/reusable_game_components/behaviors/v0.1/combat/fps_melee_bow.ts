// also: first-person, dual-weapon, projectile, sword, archery, swinging
// FPS melee and bow — left click for melee swing, Q for bow shot
class FPSMeleeBowBehavior extends GameScript {
    _behaviorName = "fps_melee_bow";
    _meleeDamage = 12;
    _meleeRange = 3;
    _meleeRate = 0.4;
    _bowDamage = 25;
    _bowRange = 30;
    _bowRate = 1.5;
    _meleeCooldown = 0;
    _bowCooldown = 0;
    // Visible arrow tracers — short-lived spheres lerping from the
    // player toward the bow shot's endpoint. Damage is applied at
    // fire-time; the tracer is purely cosmetic.
    _tracers = [];

    onUpdate(dt) {
        this._updateTracers(dt);
        this._meleeCooldown -= dt;
        this._bowCooldown -= dt;
        if (this.input.isKeyPressed("MouseLeft") && this._meleeCooldown <= 0) {
            this._meleeCooldown = this._meleeRate;
            this._attack(this._meleeDamage, this._meleeRange);
            if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/knifeSlice.ogg", 0.35);
        }
        if (this.input.isKeyPressed("KeyQ") && this._bowCooldown <= 0) {
            this._bowCooldown = this._bowRate;
            var hit = this._attack(this._bowDamage, this._bowRange);
            // Tracer flies along the look direction. Lands at the hit
            // target if there was one, else at max range — same shape
            // as fps_combat's hitscan tracer.
            var pos = this.entity.transform.position;
            var yaw = (this.scene._fpsYaw || 0) * Math.PI / 180;
            var dX = Math.sin(yaw), dZ = -Math.cos(yaw);
            var endX, endY, endZ;
            if (hit) {
                var ep = hit.transform.position;
                endX = ep.x; endY = ep.y + 1.0; endZ = ep.z;
            } else {
                endX = pos.x + dX * this._bowRange;
                endY = pos.y + 1.5;
                endZ = pos.z + dZ * this._bowRange;
            }
            this._spawnTracer(pos.x + dX * 0.6, pos.y + 1.4, pos.z + dZ * 0.6, endX, endY, endZ);
            if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/drawKnife1.ogg", 0.4);
        }
    }

    _attack(dmg, range) {
        if (this.entity.playAnimation) this.entity.playAnimation("Attack", { loop: false });
        var pos = this.entity.transform.position;
        var yaw = (this.scene._fpsYaw || 0) * Math.PI / 180;
        var dX = Math.sin(yaw), dZ = -Math.cos(yaw);
        var enemies = this.scene.findEntitiesByTag("hostile") || [];
        for (var i = 0; i < enemies.length; i++) {
            if (!enemies[i].active) continue;
            var ep = enemies[i].transform.position;
            var dx = ep.x-pos.x, dz = ep.z-pos.z;
            var dist = Math.sqrt(dx*dx+dz*dz);
            if (dist > range) continue;
            var dot = dist>0.1?(dx*dX+dz*dZ)/dist:1;
            if (dot > 0.5) {
                this.scene.events.game.emit("entity_damaged", { targetId: enemies[i].id, damage: dmg, source: "player" });
                return enemies[i];
            }
        }
        return null;
    }

    _spawnTracer(fromX, fromY, fromZ, toX, toY, toZ) {
        if (!this.scene.createEntity) return;
        var name = "tr_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
        var id = this.scene.createEntity(name);
        if (id == null || id === -1) return;
        this.scene.setScale && this.scene.setScale(id, 0.16, 0.16, 0.16);
        this.scene.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: [0.85, 0.70, 0.30, 1]
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
