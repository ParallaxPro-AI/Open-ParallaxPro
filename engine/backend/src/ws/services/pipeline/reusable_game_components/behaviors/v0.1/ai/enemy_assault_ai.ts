// Enemy assault AI — heavy armored enemy with strong attacks
class EnemyAssaultAIBehavior extends GameScript {
    _behaviorName = "enemy_assault_ai"; _speed = 3; _damage = 20; _attackRange = 3; _attackRate = 1.2; _detectRange = 22; _health = 150; _dead = false; _cooldown = 0;
    onStart() { var s = this; this.scene.events.game.on("entity_damaged", function(d) { if(d.targetId!==s.entity.id)return; s._health-=d.damage||0; if(s._health<=0){s._dead=true;s.entity.active=false;s.scene.events.game.emit("entity_killed",{entityId:s.entity.id,team:"enemy"});} }); }
    onUpdate(dt) { if(this._dead) return; this._cooldown-=dt;
        var p=this.entity.transform.position,targets=this.scene.findEntitiesByTag("military")||[],best=null,bestD=this._detectRange+1;
        for(var i=0;i<targets.length;i++){if(!targets[i].active)continue;var tags=targets[i].tags||[];var isP=false;for(var t=0;t<tags.length;t++){if(tags[t]==="player")isP=true;}if(!isP)continue;
            var ap=targets[i].transform.position,d=Math.sqrt((p.x-ap.x)*(p.x-ap.x)+(p.z-ap.z)*(p.z-ap.z));if(d<bestD){bestD=d;best=targets[i];}}
        if(best){var ep=best.transform.position,dx=ep.x-p.x,dz=ep.z-p.z;this.entity.transform.setRotationEuler(0,Math.atan2(dx,dz)*180/Math.PI,0);
            if(bestD>this._attackRange){this.scene.setPosition(this.entity.id,p.x+(dx/bestD)*this._speed*dt,p.y,p.z+(dz/bestD)*this._speed*dt);}
            else if(this._cooldown<=0){this._cooldown=this._attackRate;this.scene.events.game.emit("entity_damaged",{targetId:best.id,damage:this._damage,source:"enemy"});
                if(this.audio)this.audio.playSound("/assets/kenney/audio/impact_sounds/impactPunch_heavy_002.ogg",0.35);}}
    }
}
