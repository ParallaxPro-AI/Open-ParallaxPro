// also: mage, spellcaster, projectile attacker, magic damage, ranged threat
// Caster mob — ranged hostile that attacks from distance
class CasterMobBehavior extends GameScript {
    _behaviorName = "caster_mob"; _speed = 2; _damage = 15; _detectRange = 20; _attackRange = 12; _attackRate = 2; _health = 50; _xpReward = 30;
    _dead = false; _cooldown = 0; _currentAnim = "";
    onStart() { var s=this; this.scene.events.game.on("entity_damaged",function(d){if(d.targetId!==s.entity.id)return;s._health-=d.damage||0;if(s._health<=0){s._dead=true;s.entity.active=false;s.scene.events.game.emit("entity_killed",{entityId:s.entity.id});s.scene.events.game.emit("xp_gained",{amount:s._xpReward});}});}
    onUpdate(dt){if(this._dead)return;this._cooldown-=dt;var pos=this.entity.transform.position;var player=this.scene.findEntityByName("Hero");if(!player)return;
        var pp=player.transform.position;var dx=pp.x-pos.x,dz=pp.z-pos.z,dist=Math.sqrt(dx*dx+dz*dz);
        if(dist<this._detectRange){this.entity.transform.setRotationEuler(0,Math.atan2(-dx,-dz)*180/Math.PI,0);
            if(dist<this._attackRange&&this._cooldown<=0){this._cooldown=this._attackRate;this.scene.events.game.emit("entity_damaged",{targetId:player.id,damage:this._damage,source:"caster"});
                if(this.audio)this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_003.ogg",0.3);}}
        this._playAnim("Idle");}
    _playAnim(n){if(this._currentAnim===n)return;this._currentAnim=n;if(this.entity.playAnimation)this.entity.playAnimation(n,{loop:true});}
}
