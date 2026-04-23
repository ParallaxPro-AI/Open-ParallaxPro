// also: RTS construction, queue-based spawning, resource cost, building system, unit training
// Production system — unit training and building construction for RTS
class ProductionSystemInstance extends GameScript {
    _unitCosts = {}; _buildTime = 5; _gameActive = false;
    onStart() { var s = this; this.scene.events.game.on("game_ready", function() { s._gameActive = true; });
        this.scene.events.game.on("train_unit", function(d) { if(!d||!d.unitType) return;
            s.scene.events.game.emit("spend_resources", { minerals: 50, gas: 0 }); /* simplified */
            var ent = s.scene.spawnEntity(d.unitType);
            if (ent) { s.scene.setPosition(ent.id, d.x||0, 1, d.z||0); if(ent.playAnimation) ent.playAnimation("Idle",{loop:true}); }
        }); }
    onUpdate(dt) {}
}
