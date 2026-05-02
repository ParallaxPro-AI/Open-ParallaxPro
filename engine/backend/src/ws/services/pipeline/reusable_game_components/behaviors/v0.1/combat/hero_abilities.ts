// also: ability system, skill tree, spellcasting, mana management, cooldowns
// Hero abilities — Q/E/R ability attacks with cooldowns. Triggered by
// keyboard OR by clicking the matching key in the ability_bar HUD.
class HeroAbilitiesBehavior extends GameScript {
    _behaviorName = "hero_abilities"; _q_damage = 30; _q_range = 8; _q_cooldown = 3; _q_mana = 15;
    _e_heal = 25; _e_cooldown = 8; _e_mana = 20; _r_damage = 60; _r_range = 12; _r_cooldown = 15; _r_mana = 40;
    _qTimer = 0; _eTimer = 0; _rTimer = 0;
    _qClick = false; _eClick = false; _rClick = false;
    // Visible AoE tracers — short-lived spheres that lerp from caster
    // toward each enemy hit by the burst. Damage is still applied at
    // fire-time; the tracer is purely cosmetic.
    _tracers = [];
    onStart() { var s = this;
        this.scene.events.ui.on("ui_event:hud/ability_bar:cast_ability", function(d) {
            var p = ((d && d.data) || {}).payload || {};
            if (p.key === "q") s._qClick = true;
            else if (p.key === "e") s._eClick = true;
            else if (p.key === "r") s._rClick = true;
        });
    }
    onUpdate(dt) { this._updateTracers(dt); this._qTimer-=dt; this._eTimer-=dt; this._rTimer-=dt;
        var qFire = (this.input.isKeyPressed("KeyQ") || this._qClick) && this._qTimer<=0;
        var eFire = (this.input.isKeyPressed("KeyE") || this._eClick) && this._eTimer<=0;
        var rFire = (this.input.isKeyPressed("KeyR") || this._rClick) && this._rTimer<=0;
        this._qClick = false; this._eClick = false; this._rClick = false;
        if(qFire){this._qTimer=this._q_cooldown;this._aoeAttack(this._q_damage,this._q_range,[0.30,0.85,1.0,1]);
            if(this.audio)this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserLarge_000.ogg",0.35);}
        if(eFire){this._eTimer=this._e_cooldown;
            this.scene.events.game.emit("entity_healed",{targetId:this.entity.id,amount:this._e_heal});
            if(this.audio)this.audio.playSound("/assets/kenney/audio/digital_audio/powerUp4.ogg",0.4);}
        if(rFire){this._rTimer=this._r_cooldown;this._aoeAttack(this._r_damage,this._r_range,[1.0,0.40,0.20,1]);
            if(this.audio)this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/explosionCrunch_002.ogg",0.45);}
        this.scene.events.ui.emit("hud_update",{qCooldown:Math.max(0,Math.ceil(this._qTimer)),qMaxCooldown:this._q_cooldown,eCooldown:Math.max(0,Math.ceil(this._eTimer)),eMaxCooldown:this._e_cooldown,rCooldown:Math.max(0,Math.ceil(this._rTimer)),rMaxCooldown:this._r_cooldown});
    }
    _aoeAttack(dmg,range,color){var pos=this.entity.transform.position;var enemies=this.scene.findEntitiesByTag("hostile")||[];
        for(var i=0;i<enemies.length;i++){if(!enemies[i].active)continue;var ep=enemies[i].transform.position;
            var d=Math.sqrt((pos.x-ep.x)*(pos.x-ep.x)+(pos.z-ep.z)*(pos.z-ep.z));
            if(d<range){this.scene.events.game.emit("entity_damaged",{targetId:enemies[i].id,damage:dmg,source:"player"});
                this._spawnTracer(pos.x, pos.y + 1.0, pos.z, ep.x, ep.y + 1.0, ep.z, color);}}}

    _spawnTracer(fromX, fromY, fromZ, toX, toY, toZ, color) {
        if (!this.scene.createEntity) return;
        var name = "tr_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
        var id = this.scene.createEntity(name);
        if (id == null || id === -1) return;
        this.scene.setScale && this.scene.setScale(id, 0.32, 0.32, 0.32);
        this.scene.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: color
        });
        this.scene.setPosition(id, fromX, fromY, fromZ);
        if (this.scene.addTag) this.scene.addTag(id, "tracer");
        var dx = toX - fromX, dy = toY - fromY, dz = toZ - fromZ;
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        var duration = Math.max(0.05, dist / 26);
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
