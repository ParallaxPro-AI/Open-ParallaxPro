// also: harvester, gatherer, resource farming, npc laborer, automated collector
// Enemy worker AI — gathers resources for enemy side
class EnemyWorkerAIBehavior extends GameScript {
    _behaviorName = "enemy_worker_ai"; _speed = 2.5; _health = 30; _dead = false; _tX = 0; _tZ = 0; _mt = 0;
    onStart() { var s = this; this._pickT(); this.scene.events.game.on("entity_damaged", function(d) { if(d.targetId!==s.entity.id)return; s._health-=d.damage||0; if(s._health<=0){s._dead=true;s.entity.active=false;s.scene.events.game.emit("entity_killed",{entityId:s.entity.id,team:"enemy"});} }); }
    _pickT() { var p=this.entity.transform.position; this._tX=p.x+(Math.random()-0.5)*20; this._tZ=p.z+(Math.random()-0.5)*20; this._mt=4+Math.random()*4; }
    onUpdate(dt) { if(this._dead) return; this._mt-=dt; if(this._mt<=0)this._pickT();
        var p=this.entity.transform.position,dx=this._tX-p.x,dz=this._tZ-p.z,d=Math.sqrt(dx*dx+dz*dz);
        if(d>1){this.scene.setPosition(this.entity.id,p.x+(dx/d)*this._speed*dt,p.y,p.z+(dz/d)*this._speed*dt);this.entity.transform.setRotationEuler(0,Math.atan2(-dx,-dz)*180/Math.PI,0);}
    }
}
