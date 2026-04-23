// also: basic enemy, standard mob, minion, combat encounter, patrol unit
// Hostile mob — basic enemy that patrols and attacks the player
class HostileMobBehavior extends GameScript {
    _behaviorName = "hostile_mob"; _speed = 3; _damage = 10; _detectRange = 15; _attackRange = 2.5; _attackRate = 1.2; _health = 60; _xpReward = 20;
    _dead = false; _cooldown = 0; _patrolTimer = 0; _tX = 0; _tZ = 0; _startX = 0; _startZ = 0; _currentAnim = "";
    onStart() { var p=this.entity.transform.position; this._startX=p.x; this._startZ=p.z; this._pickT(); var s=this;
        this.scene.events.game.on("entity_damaged",function(d){if(d.targetId!==s.entity.id)return;s._health-=d.damage||0;if(s._health<=0){s._dead=true;s.entity.active=false;s.scene.events.game.emit("entity_killed",{entityId:s.entity.id});s.scene.events.game.emit("xp_gained",{amount:s._xpReward});}});}
    _pickT(){this._tX=this._startX+(Math.random()-0.5)*16;this._tZ=this._startZ+(Math.random()-0.5)*16;this._patrolTimer=4+Math.random()*4;}
    onUpdate(dt){if(this._dead)return;this._cooldown-=dt;var pos=this.entity.transform.position;var player=this.scene.findEntityByName("Hero");
        if(player){var pp=player.transform.position;var dx=pp.x-pos.x,dz=pp.z-pos.z,dist=Math.sqrt(dx*dx+dz*dz);
            if(dist<this._detectRange){this.entity.transform.setRotationEuler(0,Math.atan2(dx,dz)*180/Math.PI,0);
                if(dist>this._attackRange){this.scene.setPosition(this.entity.id,pos.x+(dx/dist)*this._speed*dt,pos.y,pos.z+(dz/dist)*this._speed*dt);this._playAnim("Run");}
                else if(this._cooldown<=0){this._cooldown=this._attackRate;this.scene.events.game.emit("entity_damaged",{targetId:player.id,damage:this._damage,source:"mob"});this._playAnim("Idle");}
                return;}}
        this._patrolTimer-=dt;if(this._patrolTimer<=0)this._pickT();
        var pdx=this._tX-pos.x,pdz=this._tZ-pos.z,pdist=Math.sqrt(pdx*pdx+pdz*pdz);
        if(pdist>1.5){this.scene.setPosition(this.entity.id,pos.x+(pdx/pdist)*this._speed*0.4*dt,pos.y,pos.z+(pdz/pdist)*this._speed*0.4*dt);this._playAnim("Walk");}else{this._playAnim("Idle");}}
    _playAnim(n){if(this._currentAnim===n)return;this._currentAnim=n;if(this.entity.playAnimation)this.entity.playAnimation(n,{loop:true});}
}
