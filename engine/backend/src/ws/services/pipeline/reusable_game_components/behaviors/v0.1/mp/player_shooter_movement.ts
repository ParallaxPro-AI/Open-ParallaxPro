// also: WASD strafing, mouse aim, sprint, reload intent, pickup system
// Top-down shooter player movement — client-authoritative.
//
// WASD locomotion on the xz-plane with the player yaw driven by the
// mouse cursor (top-down aim). Sprint is held on Shift. Input intents
// for fire/reload/swap/pickup/heal are emitted on the game bus so the
// match system + weapon behavior can react without this script knowing
// anything about weapon internals.
//
// Reusable for any top-down shooter variant — tune speed/sprint/turn
// via behavior params, and swap the intent event names if a game wants
// a different input vocabulary.
//
// Conventions:
//   scene._shooterFrozen  — true while a non-input modal owns input
//                           (match-over screen, pause). Movement + intent
//                           emission both yield while this is set.
//   scene._shooterMouseAim = { x, z, dx, dz, yaw }  — world-space aim
//                           point updated every tick from the mouse. Other
//                           behaviors (weapon, camera) read this so we
//                           don't recompute cursor→ground rays twice.
class PlayerShooterMovementBehavior extends GameScript {
    _behaviorName = "player_shooter_movement";

    _speed = 6.0;
    _sprintMult = 1.45;
    _deadSpeedMult = 1.25;
    _turnSpeed = 18;
    _boundsHalf = 58;
    _cameraHeight = 26;

    _prevFire = false;
    _firing = false;
    _prevReload = false;
    _prevSlot1 = false;
    _prevSlot2 = false;
    _prevSlot3 = false;
    _prevSlot4 = false;
    _prevHeal = false;
    _prevPickup = false;
    // Virtual cursor screen-pixel position (relative to canvas) emitted
    // by ui_bridge when show_cursor is active. We subscribe in onStart
    // and use it in _resolveMouseAim — raw input.mouseX/mouseY don't
    // reflect the virtual cursor when ui_bridge owns the pointer.
    _vcursorX = 0;
    _vcursorY = 0;
    _vcursorReady = false;

    onStart() {
        var self = this;
        this.scene.events.ui.on("cursor_move", function(d) {
            if (!d) return;
            self._vcursorX = d.x;
            self._vcursorY = d.y;
            self._vcursorReady = true;
        });
    }

    onUpdate(dt) {
        var ni = this.entity.getComponent
            ? this.entity.getComponent("NetworkIdentityComponent")
            : null;
        if (ni && !ni.isLocalPlayer) return;

        var isAlive = this.entity._shooterAlive !== false;

        var forward = (this.input.isKeyDown("KeyW") ? 1 : 0) - (this.input.isKeyDown("KeyS") ? 1 : 0);
        var strafe  = (this.input.isKeyDown("KeyD") ? 1 : 0) - (this.input.isKeyDown("KeyA") ? 1 : 0);
        var sprint  = this.input.isKeyDown("ShiftLeft") || this.input.isKeyDown("ShiftRight");

        if (this.scene._shooterFrozen) { forward = 0; strafe = 0; }

        var speed = this._speed;
        if (sprint) speed *= this._sprintMult;
        if (!isAlive) speed *= this._deadSpeedMult;

        var pos = this.entity.transform.position;
        // Normalize diagonal so diagonal isn't 1.41× faster than cardinal.
        var mag = Math.sqrt(forward * forward + strafe * strafe);
        if (mag > 0) {
            pos.x += (strafe / mag) * speed * dt;
            pos.z += (-forward / mag) * speed * dt;
        }

        // Mouse aim — project the cursor onto the ground plane at
        // player.y to get a world aim point. We read from input.mouseX/Y
        // if available (Normalized Device Coords in [-1,1]); otherwise
        // fall back to the current facing so single-player test harness
        // without mouse still works.
        var aim = this._resolveMouseAim(pos);
        this.scene._shooterMouseAim = aim;

        // Yaw chases the aim direction smoothly so the character model
        // doesn't snap. Uses the same dYaw-wrap logic as other behaviors.
        if (aim) {
            var targetYaw = Math.atan2(aim.dx, -aim.dz);
            var curYaw = this.entity.transform.getRotationEuler
                ? this.entity.transform.getRotationEuler().y
                : 0;
            var dYaw = targetYaw - curYaw;
            while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
            while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
            curYaw += dYaw * Math.min(1, this._turnSpeed * dt);
            this.entity.transform.setRotationEuler(0, curYaw, 0);
        }

        // Map bounds — honors a soft buffer so players can't walk into
        // the storm-visualization cylinder's geometry.
        var h = this._boundsHalf;
        if (pos.x < -h) pos.x = -h;
        if (pos.x >  h) pos.x =  h;
        if (pos.z < -h) pos.z = -h;
        if (pos.z >  h) pos.z =  h;

        this.entity.transform.markDirty && this.entity.transform.markDirty();

        if (this.scene._shooterFrozen || !isAlive) {
            this._prevFire = false;
            this._prevReload = false;
            this._prevSlot1 = this._prevSlot2 = this._prevSlot3 = this._prevSlot4 = false;
            this._prevHeal = false;
            this._prevPickup = false;
            this._firing = false;
            return;
        }

        // ── Fire intent: press & hold. Weapon behavior owns rate-of-fire
        // so we just forward the button state each frame.
        var leftDown = this.input.isKeyDown("MouseLeft");
        if (leftDown && !this._firing) {
            this.scene.events.game.emit("royale_fire_start", {
                aimX: aim && aim.x, aimZ: aim && aim.z,
            });
        } else if (!leftDown && this._firing) {
            this.scene.events.game.emit("royale_fire_stop", {});
        }
        this._firing = leftDown;
        this._prevFire = leftDown;

        // ── Reload (R) ──
        var nowR = this.input.isKeyDown("KeyR");
        if (nowR && !this._prevReload) {
            this.scene.events.game.emit("royale_reload_pressed", {});
        }
        this._prevReload = nowR;

        // ── Weapon slot hotkeys (1/2/3/4) ──
        this._slot("Digit1", "_prevSlot1", 0);
        this._slot("Digit2", "_prevSlot2", 1);
        this._slot("Digit3", "_prevSlot3", 2);
        this._slot("Digit4", "_prevSlot4", 3);

        // ── Heal (H) ── — consumes a medkit/bandage in inventory
        var nowH = this.input.isKeyDown("KeyH");
        if (nowH && !this._prevHeal) {
            this.scene.events.game.emit("royale_heal_pressed", {});
        }
        this._prevHeal = nowH;

        // ── Pickup (E / F) ── — loot_crate behavior also auto-pickups
        // on overlap, but E gives the player an explicit "grab nearest"
        // action in case overlap didn't trigger (e.g. Shift slow-walk).
        var nowPickup = this.input.isKeyDown("KeyE") || this.input.isKeyDown("KeyF");
        if (nowPickup && !this._prevPickup) {
            this.scene.events.game.emit("royale_pickup_pressed", {
                x: pos.x, y: pos.y, z: pos.z,
            });
        }
        this._prevPickup = nowPickup;
    }

    _slot(key, prevProp, idx) {
        var now = this.input.isKeyDown(key);
        if (now && !this[prevProp]) {
            this.scene.events.game.emit("royale_switch_slot", { slot: idx });
        }
        this[prevProp] = now;
    }

    _resolveMouseAim(playerPos) {
        // Project the virtual cursor (the sprite ui_bridge renders when
        // show_cursor is active) onto the world ground plane at the
        // player's height. screenPointToGround handles the camera
        // matrix internally so this works for any camera pose — fixes
        // the previous "red cross stuck in middle" issue where raw
        // input.mouseX/mouseY were 0 because pointer-lock was off.
        var ground = null;
        if (this._vcursorReady && this.scene.screenPointToGround) {
            ground = this.scene.screenPointToGround(this._vcursorX, this._vcursorY, playerPos.y);
        }
        if (!ground) {
            // Fallback: aim straight ahead (north) if the cursor hasn't
            // moved yet this frame. Keeps yaw stable instead of NaN.
            return {
                x: playerPos.x, z: playerPos.z - 1,
                dx: 0, dz: -1,
                yaw: 0,
            };
        }
        var dx = ground.x - playerPos.x;
        var dz = ground.z - playerPos.z;
        var len = Math.sqrt(dx * dx + dz * dz) || 1;
        return {
            x: ground.x, z: ground.z,
            dx: dx / len, dz: dz / len,
            yaw: Math.atan2(dx, -dz),
        };
    }
}
