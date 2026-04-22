// also: mana regen, experience points, leveling system, health pool expansion
// Player stats — health, mana, XP, level tracking for RPG
class PlayerStatsBehavior extends GameScript {
    _behaviorName = "player_stats"; _maxHealth = 200; _maxMana = 100; _health = 200; _mana = 100;
    _manaRegen = 3; _healthRegen = 1; _xp = 0; _level = 1; _xpToLevel = 100;
    onStart() { var s = this;
        this.scene.events.game.on("entity_damaged",function(d){if(d.targetId!==s.entity.id)return;s._health-=d.damage||0;if(s._health<=0){s._health=0;s.scene.events.game.emit("player_died",{});}});
        this.scene.events.game.on("entity_healed",function(d){if(d.targetId!==s.entity.id)return;s._health=Math.min(s._maxHealth,s._health+(d.amount||0));});
        this.scene.events.game.on("xp_gained",function(d){s._xp+=d.amount||0;while(s._xp>=s._xpToLevel){s._xp-=s._xpToLevel;s._level++;s._xpToLevel=Math.floor(s._xpToLevel*1.5);s._maxHealth+=20;s._health=s._maxHealth;s._maxMana+=10;s._mana=s._maxMana;
            if(s.audio)s.audio.playSound("/assets/kenney/audio/voiceover_pack/female/level_up.ogg",0.5);}});
        this.scene.events.game.on("player_respawned",function(){s._health=s._maxHealth;s._mana=s._maxMana;});
    }
    onUpdate(dt) { this._mana=Math.min(this._maxMana,this._mana+this._manaRegen*dt);
        if(this._health>0&&this._health<this._maxHealth)this._health=Math.min(this._maxHealth,this._health+this._healthRegen*dt);
        this.scene.events.ui.emit("hud_update",{health:Math.floor(this._health),maxHealth:this._maxHealth,mana:Math.floor(this._mana),maxMana:this._maxMana,xp:this._xp,xpToLevel:this._xpToLevel,level:this._level});}
}
