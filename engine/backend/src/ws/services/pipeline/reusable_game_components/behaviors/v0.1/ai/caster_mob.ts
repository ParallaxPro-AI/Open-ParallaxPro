// also: mage, spellcaster, projectile attacker, magic damage, ranged threat
// Caster mob — ranged hostile that attacks from distance
class CasterMobBehavior extends GameScript {
    _behaviorName = "caster_mob"; _speed = 2; _damage = 15; _detectRange = 20; _attackRange = 12; _attackRate = 2; _health = 50; _xpReward = 30;
    _dead = false; _cooldown = 0; _currentAnim = "";
    // Visible spell tracers — short-lived purple spheres lerping from
    // caster toward player. Damage is still applied at fire-time; the
    // tracer is purely cosmetic.
    _tracers = [];
    onStart() { var s=this; this.scene.events.game.on("entity_damaged",function(d){if(d.targetId!==s.entity.id)return;s._health-=d.damage||0;if(s._health<=0){s._dead=true;s.entity.active=false;s.scene.events.game.emit("entity_killed",{entityId:s.entity.id});s.scene.events.game.emit("xp_gained",{amount:s._xpReward});}});}
    onUpdate(dt){this._updateTracers(dt);if(this._dead)return;this._cooldown-=dt;var pos=this.entity.transform.position;var player=this.scene.findEntityByName("Hero");if(!player)return;
        var pp=player.transform.position;var dx=pp.x-pos.x,dz=pp.z-pos.z,dist=Math.sqrt(dx*dx+dz*dz);
        if(dist<this._detectRange){this.entity.transform.setRotationEuler(0,Math.atan2(-dx,-dz)*180/Math.PI,0);
            if(dist<this._attackRange&&this._cooldown<=0){this._cooldown=this._attackRate;this.scene.events.game.emit("entity_damaged",{targetId:player.id,damage:this._damage,source:"caster"});
                this._spawnTracer(pos.x, pos.y + 1.4, pos.z, pp.x, pp.y + 1.0, pp.z);
                if(this.audio)this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_003.ogg",0.3);}}
        this._playAnim("Idle");}
    _playAnim(n){if(this._currentAnim===n)return;this._currentAnim=n;if(this.entity.playAnimation)this.entity.playAnimation(n,{loop:true});}

    _spawnTracer(fromX, fromY, fromZ, toX, toY, toZ) {
        if (!this.scene.createEntity) return;
        var name = "tr_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
        var id = this.scene.createEntity(name);
        if (id == null || id === -1) return;
        this.scene.setScale && this.scene.setScale(id, 0.30, 0.30, 0.30);
        this.scene.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: [0.65, 0.30, 0.95, 1]
        });
        this.scene.setPosition(id, fromX, fromY, fromZ);
        if (this.scene.addTag) this.scene.addTag(id, "tracer");
        var ddx = toX - fromX, ddy = toY - fromY, ddz = toZ - fromZ;
        var dd = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        var duration = Math.max(0.05, dd / 22);
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
