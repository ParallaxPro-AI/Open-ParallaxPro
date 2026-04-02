// Sandbox world — block mining, inventory, resource tracking, item drops/pickup
class SandboxWorldSystem extends GameScript {
    _inventorySlots = 9;
    _pickupRadius = 2.5;
    _blockMineTime = 1.2;
    _oreMineTime = 2.0;
    _treeMineTime = 1.8;
    _dropLifetime = 60;
    _startTools = [];

    _inventory = [];
    _selectedSlot = 0;
    _gameActive = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() { self._reset(); });
        this.scene.events.game.on("player_respawned", function() { self._reset(); });
        this.scene.events.game.on("block_mined", function(data) { self._onBlockMined(data); });
        this.scene.events.game.on("entity_killed", function(data) {
            if (data.dropItem) {
                self._addToInventory(data.dropItem, data.dropAmount || 1);
            }
        });
        this._reset();
    }

    _reset() {
        this._inventory = [];
        for (var i = 0; i < this._inventorySlots; i++) {
            this._inventory.push({ item: "", count: 0 });
        }
        if (this._startTools) {
            for (var t = 0; t < this._startTools.length && t < this._inventorySlots; t++) {
                this._inventory[t] = { item: this._startTools[t], count: 1 };
            }
        }
        this._selectedSlot = 0;
        this._gameActive = true;
        this._updateHud();
    }

    _onBlockMined(data) {
        var resourceMap = {
            grass_block: "dirt", dirt_block: "dirt", stone_block: "stone",
            coal_block: "coal", diamond_block: "diamond", coal_ore: "coal",
            diamond_ore: "diamond", wood_log: "wood", oak_tree: "wood",
            pine_tree: "wood", birch_tree: "wood", dead_tree: "wood"
        };
        // Try to determine resource type from entity tags
        var resource = "stone";
        for (var key in resourceMap) {
            if (data.entityId && data.entityId.toString().indexOf(key) >= 0) {
                resource = resourceMap[key];
                break;
            }
        }
        this._addToInventory(resource, 1);
        if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/chop.ogg", 0.35);
    }

    _addToInventory(item, count) {
        // Try to stack
        for (var i = 0; i < this._inventory.length; i++) {
            if (this._inventory[i].item === item) {
                this._inventory[i].count += count;
                this._updateHud();
                return true;
            }
        }
        // Find empty slot
        for (var i = 0; i < this._inventory.length; i++) {
            if (!this._inventory[i].item) {
                this._inventory[i] = { item: item, count: count };
                this._updateHud();
                return true;
            }
        }
        return false;
    }

    onUpdate(dt) {
        if (!this._gameActive) return;

        // Hotbar slot selection with 1-9
        for (var k = 1; k <= 9; k++) {
            if (this.input.isKeyPressed("Digit" + k)) {
                this._selectedSlot = k - 1;
                if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/click_001.ogg", 0.2);
            }
        }

        this._updateHud();
    }

    _updateHud() {
        this.scene.events.ui.emit("hud_update", {
            inventory: this._inventory,
            selectedSlot: this._selectedSlot,
            currentItem: this._inventory[this._selectedSlot] ? this._inventory[this._selectedSlot].item : ""
        });
    }
}
