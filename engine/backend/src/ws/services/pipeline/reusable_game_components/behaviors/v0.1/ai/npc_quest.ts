// also: dialogue, interaction, adventure_hook, progression, narrative_hook
// NPC quest giver — stands in place, can give quests when interacted with
class NPCQuestBehavior extends GameScript {
    _behaviorName = "npc_quest"; _questId = ""; _questName = ""; _rewardXP = 50; _rewardGold = 25;
    onStart() { if(this.entity.playAnimation) this.entity.playAnimation("Idle",{loop:true}); }
    onUpdate(dt) {}
}
