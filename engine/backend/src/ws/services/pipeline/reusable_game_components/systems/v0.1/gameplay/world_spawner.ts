// World spawner — respawns killed mobs after a delay to keep the world populated.
// Records the dying entity's name (== entity-def key) so the respawn uses the
// same type, avoiding a hardcoded fallback name that the validator can't
// resolve. The spawnEntity call is dynamic (variable), so each consumer
// template doesn't need a manifest as long as the killed mob's name matches a
// real entity def.
class WorldSpawnerSystem extends GameScript {
    _respawnDelay = 30; _maxMobs = 15; _spawnRadius = 40;
    _deadMobs = []; _gameActive = false;
    onStart() { var s=this;
        this.scene.events.game.on("game_ready",function(){s._deadMobs=[];s._gameActive=true;});
        this.scene.events.game.on("entity_killed",function(d){
            var ent = (d && d.entityId != null) ? s.scene.getEntity(d.entityId) : null;
            var defName = ent && ent.name ? ent.name : null;
            if (!defName) return;  // Can't respawn what we can't identify.
            s._deadMobs.push({timer:s._respawnDelay,defName:defName,x:(Math.random()-0.5)*s._spawnRadius*2,z:(Math.random()-0.5)*s._spawnRadius*2});});
    }
    onUpdate(dt){if(!this._gameActive)return;
        for(var i=this._deadMobs.length-1;i>=0;i--){this._deadMobs[i].timer-=dt;
            if(this._deadMobs[i].timer<=0){
                var hostiles=this.scene.findEntitiesByTag("hostile")||[];var alive=0;for(var h=0;h<hostiles.length;h++){if(hostiles[h].active)alive++;}
                if(alive<this._maxMobs){
                    try {
                        var mob=this.scene.spawnEntity(this._deadMobs[i].defName);
                        if(mob){this.scene.setPosition(mob.id,this._deadMobs[i].x,1,this._deadMobs[i].z);if(mob.playAnimation)mob.playAnimation("Idle",{loop:true});}
                    } catch(e) { /* unknown def — skip respawn this cycle */ }
                }
                this._deadMobs.splice(i,1);}}
    }
}
