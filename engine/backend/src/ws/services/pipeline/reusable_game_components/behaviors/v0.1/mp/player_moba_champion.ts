// MOBA champion movement + input — click-to-move with ability intents.
//
// Right-click to queue a move order (or auto-attack the enemy beneath
// the cursor). Q / E / R fire abilities at the mouse aim point. The
// match system owns damage, cooldowns, death, and respawn — this
// behavior only forwards intents and drives the champion toward its
// current move target.
//
// Scene contract:
//   scene._riftMouseAim  = { x, z }   world-space cursor
//   scene._riftFrozen     = boolean   true during intro / death /
//                                     game-over overlays
//   entity._riftAlive     = boolean   system owns this; the behavior
//                                     bails on movement while dead
//
// Fires:
//   rift_move_order       target-point click
//   rift_ability_pressed  { slot, aimX, aimZ }
//
// Reusable for any click-to-move top-down action game — tune speed,
// attack range, ability slot count via params.
class PlayerMobaChampionBehavior extends GameScript {
    _behaviorName = "player_moba_champion";

    _moveSpeed = 6.2;
    _turnSpeed = 12;
    _attackRange = 5.5;
    _attackCooldown = 0.55;
    _cameraHeight = 22;
    _cameraDepth = 14;

    _targetX = null;
    _targetZ = null;
    _attackCd = 0;
    _prevQ = false;
    _prevE = false;
    _prevR = false;
    _prevRightClick = false;
    _prevLeftClick = false;
    _prevShop = false;
    _cursorX = 0;
    _cursorY = 0;
    _gotCursor = false;

    onStart() {
        var self = this;
        // Play mode runs pointer-locked, so this.input.mouseX/Y stay
        // frozen at the lock origin. The ui_bridge integrates mouse
        // deltas into a visible virtual cursor and emits cursor_move
        // with canvas-relative screen coords; that's what we project
        // onto the ground plane for aim.
        this.scene.events.ui.on("cursor_move", function(d) {
            if (!d) return;
            self._cursorX = d.x;
            self._cursorY = d.y;
            self._gotCursor = true;
        });
    }

    onUpdate(dt) {
        var ni = this.entity.getComponent
            ? this.entity.getComponent("NetworkIdentityComponent")
            : null;
        if (ni && !ni.isLocalPlayer) return;

        if (this._attackCd > 0) this._attackCd = Math.max(0, this._attackCd - dt);

        var alive = this.entity._riftAlive !== false;
        var pos = this.entity.transform.position;

        if (this.scene._riftFrozen || !alive) {
            this._targetX = null;
            this._targetZ = null;
            this._prevRightClick = false;
            this._prevLeftClick = false;
            this._prevQ = this._prevE = this._prevR = false;
            return;
        }

        // Project the mouse onto the ground plane for targeting.
        var aim = this._resolveMouseWorld(pos);
        this.scene._riftMouseAim = aim;

        // Right-click issues a move order or an auto-attack if it lands
        // on an enemy entity. Left-click could also issue move orders,
        // but we keep that intent open for UI clicks elsewhere.
        var rmb = this.input && this.input.isKeyDown("MouseRight");
        if (rmb && !this._prevRightClick) {
            this._targetX = aim.x;
            this._targetZ = aim.z;
            this.scene.events.game.emit("rift_move_order", {
                x: aim.x, z: aim.z,
            });
        }
        this._prevRightClick = rmb;

        // Drive toward target if one is set.
        if (this._targetX !== null) {
            var dx = this._targetX - pos.x;
            var dz = this._targetZ - pos.z;
            var d = Math.sqrt(dx * dx + dz * dz);
            if (d < 0.25) {
                this._targetX = null;
                this._targetZ = null;
            } else {
                var step = Math.min(d, this._moveSpeed * dt);
                pos.x += (dx / d) * step;
                pos.z += (dz / d) * step;
                var targetYaw = Math.atan2(dx, -dz);
                var curYaw = this.entity.transform.getRotationEuler
                    ? this.entity.transform.getRotationEuler().y
                    : 0;
                var dy = targetYaw - curYaw;
                while (dy > Math.PI) dy -= 2 * Math.PI;
                while (dy < -Math.PI) dy += 2 * Math.PI;
                curYaw += dy * Math.min(1, this._turnSpeed * dt);
                this.entity.transform.setRotationEuler(0, curYaw, 0);
                this.entity.transform.markDirty && this.entity.transform.markDirty();
            }
        }

        // Ability inputs — Q / E / R fire as skillshots at the cursor.
        this._abilityTap("KeyQ", "_prevQ", "Q", aim);
        this._abilityTap("KeyE", "_prevE", "E", aim);
        this._abilityTap("KeyR", "_prevR", "R", aim);

        // Auto-attack: single left-click as an emulation for basic attack
        // toward the mouse cursor (the system validates range + damages).
        var lmb = this.input && this.input.isKeyDown("MouseLeft");
        if (lmb && !this._prevLeftClick && this._attackCd <= 0) {
            this._attackCd = this._attackCooldown;
            this.scene.events.game.emit("rift_basic_attack", {
                aimX: aim.x, aimZ: aim.z,
            });
        }
        this._prevLeftClick = lmb;

        // B opens the shop overlay. The UI bridges it through; the system
        // honours open/close via its own handler.
        var shopKey = this.input && this.input.isKeyDown("KeyB");
        if (shopKey && !this._prevShop) {
            this.scene.events.game.emit("rift_shop_toggle", {});
        }
        this._prevShop = shopKey;
    }

    _abilityTap(keyName, prevProp, slot, aim) {
        var now = this.input && this.input.isKeyDown(keyName);
        if (now && !this[prevProp]) {
            this.scene.events.game.emit("rift_ability_pressed", {
                slot: slot, aimX: aim.x, aimZ: aim.z,
            });
        }
        this[prevProp] = now;
    }

    _resolveMouseWorld(pos) {
        // Use the scene's screen→ground projection against the virtual
        // cursor position. Falls back to the champion's own position
        // when the cursor hasn't been heard from yet (fresh spawn).
        if (this._gotCursor && this.scene.screenPointToGround) {
            var g = this.scene.screenPointToGround(this._cursorX, this._cursorY, 0);
            if (g) return { x: g.x, z: g.z };
        }
        return { x: pos.x, z: pos.z };
    }
}
