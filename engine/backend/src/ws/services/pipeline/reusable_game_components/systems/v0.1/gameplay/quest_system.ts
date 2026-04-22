// also: objective tracking, progression system, achievement rewards, quest completion, missions
// Quest system — tracks active quests, objectives, completion, and rewards
class QuestSystemInstance extends GameScript {
    _quests = {}; _activeQuests = []; _completedQuests = []; _gameActive = false;
    onStart() { var s=this;
        this.scene.events.game.on("game_ready",function(){s._activeQuests=[];s._completedQuests=[];s._gameActive=true;});
        this.scene.events.game.on("accept_quest",function(d){if(d&&d.questId)s._activeQuests.push(d.questId);});
        this.scene.events.game.on("entity_killed",function(d){s._checkObjectives("kill",1);});
    }
    _checkObjectives(type,count){
        for(var i=this._activeQuests.length-1;i>=0;i--){var q=this._quests[this._activeQuests[i]];
            if(q&&q.objective===type){q.progress=(q.progress||0)+count;
                if(q.progress>=q.required){this._completedQuests.push(this._activeQuests[i]);this._activeQuests.splice(i,1);
                    this.scene.events.game.emit("xp_gained",{amount:q.rewardXP||50});
                    if(this.audio)this.audio.playSound("/assets/kenney/audio/voiceover_pack/female/objective_achieved.ogg",0.5);}}}
        this._updateHud();
    }
    _updateHud(){this.scene.events.ui.emit("hud_update",{activeQuests:this._activeQuests.length,completedQuests:this._completedQuests.length});}
    onUpdate(dt){if(!this._gameActive)return;this._updateHud();}
}
