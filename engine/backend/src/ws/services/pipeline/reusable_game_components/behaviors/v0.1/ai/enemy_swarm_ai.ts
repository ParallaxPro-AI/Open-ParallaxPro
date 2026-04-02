// Enemy swarm AI — fast melee enemy that rushes player units
class EnemySwarmAIBehavior extends GameScript {
    _behaviorName = "enemy_swarm_ai"; _speed = 5; _damage = 8; _attackRange = 2.5; _attackRate = 0.6; _detectRange = 25; _health = 40; _dead = false; _cooldown = 0;
    onStart() { var s = this; this.scene.events.game.on("entity_damaged", function(d) { if(d.targetId!==s.entity.id)return; s._health-=d.damage||0; if(s._health<=0){s._dead=true;s.entity.active=false;s.scene.events.game.emit("entity_killed",{entityId:s.entity.id,team:"enemy"});} }); }
    onUpdate(dt) { if(this._dead) return; this._cooldown-=dt;
        var p=this.entity.transform.position,allies=this.scene.findEntitiesByTag("military")||[],best=null,bestD=this._detectRange+1;
        for(var i=0;i<allies.length;i++){if(!allies[i].active)continue;var tags=allies[i].tags||[];var isPlayer=false;for(var t=0;t<tags.length;t++){if(tags[t]==="player")isPlayer=true;}if(!isPlayer)continue;
            var ap=allies[i].transform.position,d=Math.sqrt((p.x-ap.x)*(p.x-ap.x)+(p.z-ap.z)*(p.z-ap.z));if(d<bestD){bestD=d;best=allies[i];}}
        if(best){var ep=best.transform.position,dx=ep.x-p.x,dz=ep.z-p.z;this.entity.transform.setRotationEuler(0,Math.atan2(dx,dz)*180/Math.PI,0);
            if(bestD>this._attackRange){this.scene.setPosition(this.entity.id,p.x+(dx/bestD)*this._speed*dt,p.y,p.z+(dz/bestD)*this._speed*dt);}
            else if(this._cooldown<=0){this._cooldown=this._attackRate;this.scene.events.game.emit("entity_damaged",{targetId:best.id,damage:this._damage,source:"enemy"});}}
    }
}
