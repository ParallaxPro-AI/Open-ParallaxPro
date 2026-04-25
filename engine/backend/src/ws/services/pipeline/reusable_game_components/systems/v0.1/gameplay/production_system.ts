// also: RTS construction, queue-based spawning, resource cost, building system, unit training
// Production system — unit training and building construction for RTS
class ProductionSystemInstance extends GameScript {
    _unitCosts = {}; _buildTime = 5; _gameActive = false;
    onStart() { var s = this; this.scene.events.game.on("game_ready", function() { s._gameActive = true; }); }
    onUpdate(dt) {}
}
