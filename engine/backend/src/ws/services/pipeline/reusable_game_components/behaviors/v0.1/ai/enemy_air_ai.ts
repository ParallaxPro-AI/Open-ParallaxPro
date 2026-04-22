// also: aerial unit, flying creature, airborne threat, sky patrol, drone
// Enemy air AI — flying enemy that attacks from above
class EnemyAirAIBehavior extends GameScript {
    _behaviorName = "enemy_air_ai"; _speed = 6; _damage = 12; _attackRange = 12; _attackRate = 2; _detectRange = 30; _health = 60; _flyHeight = 8; _dead = false; _cooldown = 0;
    onStart() { var s = this; this.scene.events.game.on("entity_damaged", function(d) { if(d.targetId!==s.entity.id)return; s._health-=d.damage||0; if(s._health<=0){s._dead=true;s.entity.active=false;s.scene.events.game.emit("entity_killed",{entityId:s.entity.id,team:"enemy"});} }); }
    onUpdate(dt) { if(this._dead) return; this._cooldown-=dt;
        var p=this.entity.transform.position,targets=this.scene.findEntitiesByTag("military")||[],best=null,bestD=this._detectRange+1;
        for(var i=0;i<targets.length;i++){if(!targets[i].active)continue;var tags=targets[i].tags||[];var isP=false;for(var t=0;t<tags.length;t++){if(tags[t]==="player")isP=true;}if(!isP)continue;
            var ap=targets[i].transform.position,d=Math.sqrt((p.x-ap.x)*(p.x-ap.x)+(p.z-ap.z)*(p.z-ap.z));if(d<bestD){bestD=d;best=targets[i];}}
        if(best){var ep=best.transform.position,dx=ep.x-p.x,dz=ep.z-p.z;
            if(bestD>this._attackRange*0.5){this.scene.setPosition(this.entity.id,p.x+(dx/bestD)*this._speed*dt,this._flyHeight,p.z+(dz/bestD)*this._speed*dt);}
            if(bestD<=this._attackRange&&this._cooldown<=0){this._cooldown=this._attackRate;this.scene.events.game.emit("entity_damaged",{targetId:best.id,damage:this._damage,source:"enemy"});
                if(this.audio)this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserLarge_001.ogg",0.25);}}
        else { var wX=p.x+Math.sin(Date.now()*0.001)*0.5*dt, wZ=p.z+Math.cos(Date.now()*0.001)*0.5*dt; this.scene.setPosition(this.entity.id,wX,this._flyHeight,wZ); }
    }
}
