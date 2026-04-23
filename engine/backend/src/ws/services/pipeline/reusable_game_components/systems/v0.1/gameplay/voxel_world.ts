// also: mining, voxels, cube, blocks, survival, gathering
// Voxel world — block mining, inventory, resource tracking for voxel survival
class VoxelWorldSystem extends GameScript {
    _inventorySlots = 9;
    _pickupRadius = 2.5;
    _blockMineTime = 1.0;
    _inventory = [];
    _selectedSlot = 0;
    _gameActive = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() { self._reset(); });
        this.scene.events.game.on("block_mined", function(d) { self._addToInventory("block", 1); });
        this.scene.events.game.on("entity_killed", function(d) { if (d.dropItem) self._addToInventory(d.dropItem, d.dropAmount || 1); });
        this._reset();
    }
    _reset() {
        this._inventory = [];
        for (var i = 0; i < this._inventorySlots; i++) this._inventory.push({ item: "", count: 0 });
        this._selectedSlot = 0; this._gameActive = true; this._updateHud();
    }
    _addToInventory(item, count) {
        for (var i = 0; i < this._inventory.length; i++) { if (this._inventory[i].item === item) { this._inventory[i].count += count; this._updateHud(); return; } }
        for (var i = 0; i < this._inventory.length; i++) { if (!this._inventory[i].item) { this._inventory[i] = { item: item, count: count }; this._updateHud(); return; } }
    }
    onUpdate(dt) {
        if (!this._gameActive) return;
        for (var k = 1; k <= 9; k++) { if (this.input.isKeyPressed("Digit"+k)) { this._selectedSlot = k-1; } }
        this._updateHud();
    }
    _updateHud() { this.scene.events.ui.emit("hud_update", { inventory: this._inventory, selectedSlot: this._selectedSlot }); }
}
