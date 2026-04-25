// also: currency farming, supply management, worker production, economy simulation, resource balancing
// Resource system — tracks minerals, gas, supply for RTS
class ResourceSystemInstance extends GameScript {
    _startMinerals = 500; _startGas = 200; _maxSupply = 100;
    _minerals = 500; _gas = 200; _supply = 0; _supplyMax = 100; _gameActive = false;
    onStart() { var s = this; this.scene.events.game.on("game_ready", function() { s._minerals=s._startMinerals; s._gas=s._startGas; s._supply=0; s._gameActive=true; });
        this.scene.events.game.on("entity_killed", function(d) { if(d.team==="enemy") { s._minerals+=d.bounty||10; } }); }
    onUpdate(dt) { if(!this._gameActive) return;
        var workers = this.scene.findEntitiesByTag("worker") || []; var wCount = 0;
        for (var w = 0; w < workers.length; w++) { if (workers[w].active) wCount++; }
        this._minerals += wCount * 2 * dt;
        this.scene.events.ui.emit("hud_update", { minerals: Math.floor(this._minerals), gas: Math.floor(this._gas), supply: this._supply, supplyMax: this._supplyMax }); }
}
