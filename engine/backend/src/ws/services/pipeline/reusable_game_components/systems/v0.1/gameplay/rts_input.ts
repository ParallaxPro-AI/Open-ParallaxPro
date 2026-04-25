// also: RTS input, unit selection, click commands, move-attack, marquee
// RTS input — consume the ui_bridge virtual-cursor click events so picking
// stays in sync with what the player sees on screen (raw mouse position is
// frozen by pointer-lock; only ui_bridge knows the visible cursor's
// canvas-relative coords).
//
// Left-click:  pick the nearest player unit / worker / building under the
//              cursor and select it. Empty-space click clears.
// Right-click: command the current selection.
//   - If an enemy entity is under the cursor → emit `unit_command_attack`
//     with a direct entity ref (script_api only exposes findEntityByName,
//     not findEntityById, so we hand the behavior the ref it needs).
//   - Else (open ground) → emit `unit_command_move` with the world point.
//
// Behaviors that move units (unit_combat, worker_ai) listen for those
// events and override their autonomous targeting.
class RTSInputSystem extends GameScript {
    _selectedIds = [];
    _pickRadius = 1.8;
    _enemyPickRadius = 2.2;

    onStart() {
        var self = this;
        // No gameActive gate: membership in the battle state's
        // active_systems already means the FSM intends this system to
        // run. A game_ready handler subscribed here would miss the
        // event because gameplay.on_enter fires it BEFORE the battle
        // substate spins up its active_systems — that race is what was
        // silently swallowing every click.

        // ui_bridge emits these on every left/right click with the
        // virtual cursor's canvas-relative position baked in.
        this.scene.events.ui.on("cursor_click", function(d) {
            if (!d) return;
            self._handleLeftClick(d.x, d.y);
        });
        this.scene.events.ui.on("cursor_right_click", function(d) {
            if (!d) return;
            self._handleRightClick(d.x, d.y);
        });

        this.scene.events.game.on("entity_killed", function(d) {
            if (!d || !d.entityId) return;
            for (var i = self._selectedIds.length - 1; i >= 0; i--) {
                if (self._selectedIds[i] === d.entityId) self._selectedIds.splice(i, 1);
            }
        });

        // Publish an initial empty selection so the selection HUD shows
        // its tip immediately.
        self._publishHud();
    }

    _shiftHeld() {
        if (!this.input || !this.input.isKeyDown) return false;
        return !!(this.input.isKeyDown("ShiftLeft") || this.input.isKeyDown("ShiftRight"));
    }

    _handleLeftClick(sx, sy) {
        if (!this.scene.screenPointToGround) return;
        var ground = this.scene.screenPointToGround(sx, sy, 0);
        if (!ground) return;

        var pick = this._pickPlayerEntity(ground.x, ground.z);
        if (pick) {
            if (this._shiftHeld()) {
                if (this._selectedIds.indexOf(pick.id) < 0) this._selectedIds.push(pick.id);
            } else {
                this._selectedIds = [pick.id];
            }
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_001.ogg", 0.25);
        } else if (!this._shiftHeld()) {
            this._selectedIds = [];
        }
        this._publishHud();
    }

    _handleRightClick(sx, sy) {
        if (!this._selectedIds.length) return;
        if (!this.scene.screenPointToGround) return;
        var ground = this.scene.screenPointToGround(sx, sy, 0);
        if (!ground) return;

        var enemy = this._pickEnemyEntity(ground.x, ground.z);
        if (enemy) {
            for (var i = 0; i < this._selectedIds.length; i++) {
                this.scene.events.game.emit("unit_command_attack", {
                    entityId: this._selectedIds[i],
                    targetId: enemy.id,
                    target: enemy
                });
            }
            if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/forceField_001.ogg", 0.25);
            return;
        }

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
        var pools = [
            this.scene.findEntitiesByTag("player_unit") || [],
            this.scene.findEntitiesByTag("worker") || [],
            this.scene.findEntitiesByTag("player_building") || []
        ];
        return this._nearestActive(pools, x, z, this._pickRadius);
    }

    _pickEnemyEntity(x, z) {
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
                if (!e || !e.active) continue;
                var key = "k" + e.id;
                if (seen[key]) continue;
                seen[key] = true;
                var ep = e.transform.position;
                var dx = ep.x - x;
                var dz = ep.z - z;
                var d = dx * dx + dz * dz;
                if (d < bestD) { bestD = d; best = e; }
            }
        }
        return best;
    }

    onUpdate(dt) {
        // Empty — driven entirely by cursor_click / cursor_right_click events.
    }

    _publishHud() {
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
