// World spawner — respawns killed mobs after a delay to keep the world populated
class WorldSpawnerSystem extends GameScript {
    _respawnDelay = 30; _maxMobs = 15; _spawnRadius = 40;
    _deadMobs = []; _gameActive = false;
    onStart() { var s=this;
        this.scene.events.game.on("game_ready",function(){s._deadMobs=[];s._gameActive=true;});
        this.scene.events.game.on("entity_killed",function(d){
            s._deadMobs.push({timer:s._respawnDelay,x:(Math.random()-0.5)*s._spawnRadius*2,z:(Math.random()-0.5)*s._spawnRadius*2});});
    }
    onUpdate(dt){if(!this._gameActive)return;
        for(var i=this._deadMobs.length-1;i>=0;i--){this._deadMobs[i].timer-=dt;
            if(this._deadMobs[i].timer<=0){
                var hostiles=this.scene.findEntitiesByTag("hostile")||[];var alive=0;for(var h=0;h<hostiles.length;h++){if(hostiles[h].active)alive++;}
                if(alive<this._maxMobs){var mob=this.scene.spawnEntity("hostile_mob_spawn");
                    if(mob){this.scene.setPosition(mob.id,this._deadMobs[i].x,1,this._deadMobs[i].z);if(mob.playAnimation)mob.playAnimation("Idle",{loop:true});}}
                this._deadMobs.splice(i,1);}}
    }
}
