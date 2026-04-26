// also: raid encounter, final boss, elite threat, powerful enemy, champion
// Boss AI — powerful boss enemy with high health, multiple attack patterns
class BossAIBehavior extends GameScript {
    _behaviorName = "boss_ai"; _speed = 2.5; _damage = 35; _detectRange = 25; _attackRange = 4; _attackRate = 2; _health = 500; _maxHealth = 500; _xpReward = 200;
    _dead = false; _cooldown = 0; _aoeTimer = 0; _currentAnim = "";
    _spawnX = 0; _spawnY = 0; _spawnZ = 0;
    onStart() { var s=this;
        var p=this.entity.transform.position; this._spawnX=p.x; this._spawnY=p.y; this._spawnZ=p.z;
        this.scene.events.game.on("entity_damaged",function(d){if(d.targetId!==s.entity.id)return;s._health-=d.damage||0;if(s._health<=0){s._dead=true;s.entity.active=false;
        s.scene.events.game.emit("entity_killed",{entityId:s.entity.id});s.scene.events.game.emit("xp_gained",{amount:s._xpReward});
        s.scene.events.game.emit("final_boss_defeated",{});
        if(s.audio)s.audio.playSound("/assets/kenney/audio/sci_fi_sounds/lowFrequency_explosion_000.ogg",0.6);}});
        // Reset on Play Again — without this, the boss stays dead.
        var resetFn=function(){s._dead=false;s._health=s._maxHealth;s._cooldown=0;s._aoeTimer=0;s._currentAnim="";s.entity.active=true;
            if(s.scene.setPosition)s.scene.setPosition(s.entity.id,s._spawnX,s._spawnY,s._spawnZ);};
        this.scene.events.game.on("game_ready",resetFn);
        this.scene.events.game.on("match_started",resetFn);
        this.scene.events.game.on("restart_game",resetFn);}
    onUpdate(dt){if(this._dead)return;this._cooldown-=dt;this._aoeTimer-=dt;var pos=this.entity.transform.position;var player=this.scene.findEntityByName("Hero");if(!player)return;
        var pp=player.transform.position;var dx=pp.x-pos.x,dz=pp.z-pos.z,dist=Math.sqrt(dx*dx+dz*dz);
        if(dist<this._detectRange){this.entity.transform.setRotationEuler(0,Math.atan2(-dx,-dz)*180/Math.PI,0);
            if(dist>this._attackRange){this.scene.setPosition(this.entity.id,pos.x+(dx/dist)*this._speed*dt,pos.y,pos.z+(dz/dist)*this._speed*dt);this._playAnim("Run");}
            else if(this._cooldown<=0){this._cooldown=this._attackRate;this.scene.events.game.emit("entity_damaged",{targetId:player.id,damage:this._damage,source:"boss"});
                if(this.audio)this.audio.playSound("/assets/kenney/audio/impact_sounds/impactPunch_heavy_004.ogg",0.5);this._playAnim("Idle");}}
        this.scene.events.ui.emit("hud_update",{bossHealth:this._health,bossMaxHealth:this._maxHealth});}
    _playAnim(n){if(this._currentAnim===n)return;this._currentAnim=n;if(this.entity.playAnimation)this.entity.playAnimation(n,{loop:true});}
}
