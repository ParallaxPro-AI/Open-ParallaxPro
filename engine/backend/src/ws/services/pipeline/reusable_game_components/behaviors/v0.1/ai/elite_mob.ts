// also: rare enemy, powerful minion, tough opponent, high-tier mob, champion
// Elite mob — strong enemy with high health and damage
class EliteMobBehavior extends GameScript {
    _behaviorName = "elite_mob"; _speed = 3.5; _damage = 25; _detectRange = 18; _attackRange = 3; _attackRate = 1.5; _health = 200; _xpReward = 80;
    _dead = false; _cooldown = 0; _currentAnim = "";
    onStart() { var s=this; this.scene.events.game.on("entity_damaged",function(d){if(d.targetId!==s.entity.id)return;s._health-=d.damage||0;if(s._health<=0){s._dead=true;s.entity.active=false;s.scene.events.game.emit("entity_killed",{entityId:s.entity.id});s.scene.events.game.emit("xp_gained",{amount:s._xpReward});}});}
    onUpdate(dt){if(this._dead)return;this._cooldown-=dt;var pos=this.entity.transform.position;var player=this.scene.findEntityByName("Hero");if(!player)return;
        var pp=player.transform.position;var dx=pp.x-pos.x,dz=pp.z-pos.z,dist=Math.sqrt(dx*dx+dz*dz);
        if(dist<this._detectRange){this.entity.transform.setRotationEuler(0,Math.atan2(-dx,-dz)*180/Math.PI,0);
            if(dist>this._attackRange){this.scene.setPosition(this.entity.id,pos.x+(dx/dist)*this._speed*dt,pos.y,pos.z+(dz/dist)*this._speed*dt);this._playAnim("Run");}
            else if(this._cooldown<=0){this._cooldown=this._attackRate;this.scene.events.game.emit("entity_damaged",{targetId:player.id,damage:this._damage,source:"elite"});
                if(this.audio)this.audio.playSound("/assets/kenney/audio/impact_sounds/impactPunch_heavy_003.ogg",0.4);this._playAnim("Idle");}}
        else{this._playAnim("Idle");}}
    _playAnim(n){if(this._currentAnim===n)return;this._currentAnim=n;if(this.entity.playAnimation)this.entity.playAnimation(n,{loop:true});}
}
