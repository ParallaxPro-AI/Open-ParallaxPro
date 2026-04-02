// Hero abilities — Q/E/R ability attacks with cooldowns and mana cost
class HeroAbilitiesBehavior extends GameScript {
    _behaviorName = "hero_abilities"; _q_damage = 30; _q_range = 8; _q_cooldown = 3; _q_mana = 15;
    _e_heal = 25; _e_cooldown = 8; _e_mana = 20; _r_damage = 60; _r_range = 12; _r_cooldown = 15; _r_mana = 40;
    _qTimer = 0; _eTimer = 0; _rTimer = 0;
    onUpdate(dt) { this._qTimer-=dt; this._eTimer-=dt; this._rTimer-=dt;
        if(this.input.isKeyPressed("KeyQ")&&this._qTimer<=0){this._qTimer=this._q_cooldown;this._aoeAttack(this._q_damage,this._q_range);
            if(this.audio)this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserLarge_000.ogg",0.35);}
        if(this.input.isKeyPressed("KeyE")&&this._eTimer<=0){this._eTimer=this._e_cooldown;
            this.scene.events.game.emit("entity_healed",{targetId:this.entity.id,amount:this._e_heal});
            if(this.audio)this.audio.playSound("/assets/kenney/audio/digital_audio/powerUp4.ogg",0.4);}
        if(this.input.isKeyPressed("KeyR")&&this._rTimer<=0){this._rTimer=this._r_cooldown;this._aoeAttack(this._r_damage,this._r_range);
            if(this.audio)this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/explosionCrunch_002.ogg",0.45);}
        this.scene.events.ui.emit("hud_update",{qCooldown:Math.max(0,Math.ceil(this._qTimer)),eCooldown:Math.max(0,Math.ceil(this._eTimer)),rCooldown:Math.max(0,Math.ceil(this._rTimer))});
    }
    _aoeAttack(dmg,range){var pos=this.entity.transform.position;var enemies=this.scene.findEntitiesByTag("hostile")||[];
        for(var i=0;i<enemies.length;i++){if(!enemies[i].active)continue;var ep=enemies[i].transform.position;
            var d=Math.sqrt((pos.x-ep.x)*(pos.x-ep.x)+(pos.z-ep.z)*(pos.z-ep.z));
            if(d<range)this.scene.events.game.emit("entity_damaged",{targetId:enemies[i].id,damage:dmg,source:"player"});}}
}
