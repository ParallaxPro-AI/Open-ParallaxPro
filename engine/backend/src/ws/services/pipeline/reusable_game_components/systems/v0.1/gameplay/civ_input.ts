// also: 4X tile input, unit selection, click-to-move, civilization input
// Civ input — virtual cursor + click handling for the player's turn.
//   Left-click on a player unit → emits `select_unit` (unit_control toggles selection).
//   Left-click on an enemy unit while one is selected → emits `attack_unit`
//     (military_system handles combat resolution).
//   Left-click on empty ground while a unit is selected → emits
//     `move_unit` (unit_control walks the unit, deducting movement points).
class CivInputSystem extends GameScript {
    _gameActive = false;
    _cursorX = 0;
    _cursorY = 0;
    _gotCursor = false;
    _selectedId = "";
    _pickRadius = 1.6;

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() {
            self._gameActive = true;
            self._selectedId = "";
            self._publishHud();
        });
        this.scene.events.ui.on("cursor_move", function(d) {
            if (!d) return;
            self._cursorX = d.x;
            self._cursorY = d.y;
            self._gotCursor = true;
        });
        this.scene.events.game.on("entity_killed", function(d) {
            if (d && d.entityId === self._selectedId) {
                self._selectedId = "";
            }
        });
    }

    onUpdate(dt) {
        if (!this._gameActive) return;
        if (!this.input || !this.scene.screenPointToGround) return;

        var leftClicked = !!(this.input.isKeyPressed && this.input.isKeyPressed("MouseLeft"));
        if (!leftClicked) {
            this._publishHud();
            return;
        }
        if (!this._gotCursor) return;

        var ground = this.scene.screenPointToGround(this._cursorX, this._cursorY, 0);
        if (!ground) return;

        // Priority 1: click on a player unit → select.
        var player = this._nearestActive(this.scene.findEntitiesByTag("player") || [], ground.x, ground.z, this._pickRadius, "unit");
        if (player) {
            this._selectedId = player.id;
            this.scene.events.game.emit("select_unit", { entityId: player.id });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_001.ogg", 0.3);
            this._publishHud();
            return;
        }

        // Priority 2: click on enemy AI unit → attack with current selection.
        if (this._selectedId) {
            var ai = this._nearestActive(this.scene.findEntitiesByTag("ai") || [], ground.x, ground.z, this._pickRadius, "unit");
            if (ai) {
                this.scene.events.game.emit("attack_unit", {
                    attackerId: this._selectedId,
                    defenderId: ai.id
                });
                if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/knifeSlice.ogg", 0.4);
                this._publishHud();
                return;
            }
        }

        // Priority 3: click on empty ground with a selected unit → move.
        if (this._selectedId) {
            this.scene.events.game.emit("move_unit", {
                entityId: this._selectedId,
                x: ground.x,
                z: ground.z
            });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/footstep00.ogg", 0.35);
            return;
        }
    }

    // Nearest active entity, optionally filtered by an additional tag.
    _nearestActive(arr, x, z, radius, filterTag) {
        var best = null;
        var bestD = radius * radius;
        for (var i = 0; i < arr.length; i++) {
            var e = arr[i];
            if (!e || !e.active) continue;
            if (filterTag) {
                var tags = e.tags || [];
                var ok = false;
                for (var t = 0; t < tags.length; t++) { if (tags[t] === filterTag) { ok = true; break; } }
                if (!ok) continue;
            }
            var ep = e.transform.position;
            var dx = ep.x - x;
            var dz = ep.z - z;
            var d = dx * dx + dz * dz;
            if (d < bestD) {
                bestD = d;
                best = e;
            }
        }
        return best;
    }

    _publishHud() {
        this.scene.events.ui.emit("hud_update", {
            selectedUnitId: this._selectedId
        });
    }
}
