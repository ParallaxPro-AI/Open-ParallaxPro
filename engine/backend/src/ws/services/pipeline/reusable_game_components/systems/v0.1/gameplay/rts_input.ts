// also: RTS input, unit selection, click commands, move-attack, marquee
// RTS input — virtual cursor + click handling for player commands.
//
// Left-click: select the nearest player unit / building under the cursor
//             (within a click radius). Holding shift on a unit adds it to
//             the selection (multi-select). Empty-space left-click clears.
// Right-click: command the current selection.
//   - If an enemy entity is under the cursor → emit `unit_command_attack`
//     with the target entity id.
//   - Else (open ground) → emit `unit_command_move` with the world point.
// The unit-side behaviors (unit_combat, worker_ai) listen for these
// events and override their autonomous targeting until the command is
// fulfilled or cleared.
class RTSInputSystem extends GameScript {
    _gameActive = false;
    _cursorX = 0;
    _cursorY = 0;
    _gotCursor = false;
    _selectedIds = [];
    _pickRadius = 1.8;
    _enemyPickRadius = 2.2;
    _shift = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() {
            self._gameActive = true;
            self._selectedIds = [];
            self._publishHud();
        });
        this.scene.events.game.on("battle_start", function() {
            self._gameActive = true;
        });
        this.scene.events.ui.on("cursor_move", function(d) {
            if (!d) return;
            self._cursorX = d.x;
            self._cursorY = d.y;
            self._gotCursor = true;
        });
        this.scene.events.game.on("entity_killed", function(d) {
            if (!d || !d.entityId) return;
            // Drop dead units from the selection list.
            for (var i = self._selectedIds.length - 1; i >= 0; i--) {
                if (self._selectedIds[i] === d.entityId) self._selectedIds.splice(i, 1);
            }
        });
    }

    onUpdate(dt) {
        if (!this._gameActive) return;
        if (!this.input || !this.scene.screenPointToGround) return;

        // Track shift state cheaply via key checks.
        this._shift = !!(this.input.isMouseButtonDown && false) ||
                      !!(this.input.isKeyDown && (this.input.isKeyDown("ShiftLeft") || this.input.isKeyDown("ShiftRight")));

        var leftClicked = !!(this.input.isKeyPressed && this.input.isKeyPressed("MouseLeft"));
        var rightClicked = !!(this.input.isKeyPressed && this.input.isKeyPressed("MouseRight"));

        if (!leftClicked && !rightClicked) {
            this._publishHud();
            return;
        }
        if (!this._gotCursor) return;

        var ground = this.scene.screenPointToGround(this._cursorX, this._cursorY, 0);
        if (!ground) return;

        if (leftClicked) this._handleLeftClick(ground);
        if (rightClicked) this._handleRightClick(ground);
        this._publishHud();
    }

    _handleLeftClick(ground) {
        var pick = this._pickPlayerEntity(ground.x, ground.z);
        if (pick) {
            if (this._shift) {
                if (this._selectedIds.indexOf(pick.id) < 0) this._selectedIds.push(pick.id);
            } else {
                this._selectedIds = [pick.id];
            }
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_001.ogg", 0.25);
        } else if (!this._shift) {
            // Clicking empty ground deselects.
            this._selectedIds = [];
        }
    }

    _handleRightClick(ground) {
        if (!this._selectedIds.length) return;

        // First try to hit an enemy.
        var enemy = this._pickEnemyEntity(ground.x, ground.z);
        if (enemy) {
            for (var i = 0; i < this._selectedIds.length; i++) {
                this.scene.events.game.emit("unit_command_attack", {
                    entityId: this._selectedIds[i],
                    targetId: enemy.id
                });
            }
            if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/forceField_001.ogg", 0.25);
            return;
        }

        // Else move-to-point.
        for (var j = 0; j < this._selectedIds.length; j++) {
            this.scene.events.game.emit("unit_command_move", {
                entityId: this._selectedIds[j],
                x: ground.x,
                z: ground.z
            });
        }
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/drop_002.ogg", 0.25);
    }

    _pickPlayerEntity(x, z) {
        // Player units, workers, buildings — the rts_battle template
        // tags player-side things as "player_unit", "worker", and
        // "player_building".
        var pools = [
            this.scene.findEntitiesByTag("player_unit") || [],
            this.scene.findEntitiesByTag("worker") || [],
            this.scene.findEntitiesByTag("player_building") || []
        ];
        return this._nearestActive(pools, x, z, this._pickRadius);
    }

    _pickEnemyEntity(x, z) {
        // Enemy units and buildings — the rts_battle template tags AI
        // entities as "enemy_unit" / "enemy_building".
        var pools = [
            this.scene.findEntitiesByTag("enemy_unit") || [],
            this.scene.findEntitiesByTag("enemy_building") || []
        ];
        return this._nearestActive(pools, x, z, this._enemyPickRadius);
    }

    _nearestActive(pools, x, z, radius) {
        var best = null;
        var bestD = radius * radius;
        var seen = {};
        for (var p = 0; p < pools.length; p++) {
            var arr = pools[p];
            for (var i = 0; i < arr.length; i++) {
                var e = arr[i];
                if (!e || !e.active || seen[e.id]) continue;
                seen[e.id] = true;
                var ep = e.transform.position;
                var dx = ep.x - x;
                var dz = ep.z - z;
                var d = dx * dx + dz * dz;
                if (d < bestD) {
                    bestD = d;
                    best = e;
                }
            }
        }
        return best;
    }

    _publishHud() {
        // Compact summary of the current selection for the HUD.
        var view = [];
        for (var i = 0; i < this._selectedIds.length && i < 12; i++) {
            view.push(this._selectedIds[i]);
        }
        this.scene.events.ui.emit("hud_update", {
            selectedUnits: view,
            selectedCount: this._selectedIds.length
        });
    }
}
