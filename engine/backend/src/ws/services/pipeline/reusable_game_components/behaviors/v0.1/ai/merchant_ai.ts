// Merchant AI — friendly NPC that stays near a shop area
class MerchantAIBehavior extends GameScript {
    _behaviorName = "merchant_ai"; _items = [];
    onStart() { if(this.entity.playAnimation) this.entity.playAnimation("Idle",{loop:true}); }
    onUpdate(dt) {}
}
