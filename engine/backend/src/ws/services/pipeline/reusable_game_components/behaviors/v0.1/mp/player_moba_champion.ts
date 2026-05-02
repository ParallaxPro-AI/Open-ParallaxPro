// also: click-to-move, Q/E/R abilities, auto-attack, mouse aim, intent system
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
    _prevShop = false;
    _cursorX = 0;
    _cursorY = 0;
    _gotCursor = false;
    // One-shot click intents queued by ui_bridge. The press-frame coords
    // baked into the events match what the user actually clicked —
    // polling MouseLeft / MouseRight against cached _cursorX/Y from
    // cursor_move loses the press-frame coords on touch devices, where
    // a tap is the only event that moves the cursor and would issue a
    // move order at the previous click location.
    _pendingLeftClick = null;
    _pendingRightClick = null;

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
        this.scene.events.ui.on("cursor_click", function(d) {
            if (!d) return;
            self._pendingLeftClick = d;
        });
        this.scene.events.ui.on("cursor_right_click", function(d) {
            if (!d) return;
            self._pendingRightClick = d;
        });
    }

    onUpdate(dt) {
        // Capture and clear pending click events at the top so any
        // early-return path drops them rather than letting them queue.
        var pendingLeft = this._pendingLeftClick;
        var pendingRight = this._pendingRightClick;
        this._pendingLeftClick = null;
        this._pendingRightClick = null;

        var ni = this.entity.getComponent
            ? this.entity.getComponent("NetworkIdentityComponent")
            : null;
        if (ni && !ni.isLocalPlayer) return;

        if (this._attackCd > 0) this._attackCd = Math.max(0, this._attackCd - dt);

        var alive = this.entity._riftAlive !== false;
        var pos = this.entity.transform.position;
        // Read current vy once so every halt-and-bail branch can preserve
        // gravity. Previously the dead/frozen early-return left velocity
        // untouched, so the dynamic body kept sliding forever after death.
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = (rb && rb.getLinearVelocity) ? (rb.getLinearVelocity().y || 0) : 0;

        if (this.scene._riftFrozen || !alive) {
            this._targetX = null;
            this._targetZ = null;
            this._prevQ = this._prevE = this._prevR = false;
            this._prevShop = false;
            this.scene.setVelocity(this.entity.id, { x: 0, y: vy, z: 0 });
            return;
        }

        // Shop open — pause champion. Right-click move orders, basic
        // attacks, and ability casts all wait for the shop to close so
        // clicks land on shop buttons, not the world. Movement halts so
        // the dynamic body doesn't drift while shopping. The shop hotkey
        // (KeyB) still fires below to toggle off.
        if (this.scene._riftShopOpen) {
            this._targetX = null;
            this._targetZ = null;
            this._prevQ = this._prevE = this._prevR = false;
            this.scene.setVelocity(this.entity.id, { x: 0, y: vy, z: 0 });
            // Still allow B to close the shop.
            var shopKeyClose = this.input && this.input.isKeyDown("KeyB");
            if (shopKeyClose && !this._prevShop) {
                this.scene.events.game.emit("rift_shop_toggle", {});
            }
            this._prevShop = shopKeyClose;
            return;
        }

        // Project the mouse onto the ground plane for targeting.
        var aim = this._resolveMouseWorld(pos);
        this.scene._riftMouseAim = aim;

        // Right-click issues a move order or an auto-attack if it lands
        // on an enemy entity. The destination comes from the cursor_right_click
        // event payload so it matches the actual click point on the
        // press frame.
        if (pendingRight) {
            var rAim = this._screenToWorld(pos, pendingRight.x, pendingRight.y);
            this._targetX = rAim.x;
            this._targetZ = rAim.z;
            this.scene.events.game.emit("rift_move_order", {
                x: rAim.x, z: rAim.z,
            });
        }

        // Drive toward target if one is set. Velocity-driven on a dynamic
        // body so Rapier auto-resolves against decor trees / arena walls.
        // (rb / vy already read at the top of onUpdate.)
        if (this._targetX !== null) {
            var dx = this._targetX - pos.x;
            var dz = this._targetZ - pos.z;
            var d = Math.sqrt(dx * dx + dz * dz);
            if (d < 0.25) {
                this._targetX = null;
                this._targetZ = null;
                this.scene.setVelocity(this.entity.id, { x: 0, y: vy, z: 0 });
            } else {
                var nx = dx / d, nz = dz / d;
                this.scene.setVelocity(this.entity.id, {
                    x: nx * this._moveSpeed,
                    y: vy,
                    z: nz * this._moveSpeed,
                });
                // Engine yaw is CCW-from-above (rpg_movement convention);
                // atan2(dx, -dz) was 180° off on the strafe axis, so the
                // champion faced sideways to the right-click destination.
                // freeze_rotation:true on the rigidbody keeps physics
                // from clobbering this write.
                var targetYaw = Math.atan2(-dx, -dz);
                var curYaw = this.entity.transform.getRotationEuler
                    ? this.entity.transform.getRotationEuler().y
                    : 0;
                var dy = targetYaw - curYaw;
                while (dy > Math.PI) dy -= 2 * Math.PI;
                while (dy < -Math.PI) dy += 2 * Math.PI;
                curYaw += dy * Math.min(1, this._turnSpeed * dt);
                this.entity.transform.setRotationEuler(0, curYaw, 0);
            }
        } else {
            // Idle: stop horizontal motion but keep vy so gravity holds
            // the champion on the ground.
            this.scene.setVelocity(this.entity.id, { x: 0, y: vy, z: 0 });
        }

        // Ability inputs — Q / E / R fire as skillshots at the cursor.
        this._abilityTap("KeyQ", "_prevQ", "Q", aim);
        this._abilityTap("KeyE", "_prevE", "E", aim);
        this._abilityTap("KeyR", "_prevR", "R", aim);

        // Auto-attack: a left-click fires a basic attack toward the
        // click point (the system validates range + damages). Coords
        // come from the cursor_click event so the attack points where
        // the player tapped, not where the cursor was a frame ago.
        if (pendingLeft && this._attackCd <= 0) {
            this._attackCd = this._attackCooldown;
            var lAim = this._screenToWorld(pos, pendingLeft.x, pendingLeft.y);
            this.scene.events.game.emit("rift_basic_attack", {
                aimX: lAim.x, aimZ: lAim.z,
            });
        }

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

    _screenToWorld(pos, sx, sy) {
        // Screen→ground projection at a specific click coord. Falls back
        // to the champion's own position when the projection misses.
        if (this.scene.screenPointToGround) {
            var g = this.scene.screenPointToGround(sx, sy, 0);
            if (g) return { x: g.x, z: g.z };
        }
        return { x: pos.x, z: pos.z };
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
