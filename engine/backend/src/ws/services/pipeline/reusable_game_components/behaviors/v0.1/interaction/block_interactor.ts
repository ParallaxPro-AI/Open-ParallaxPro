// also: input handling, voxel game, intent events, hotbar system, authority
// Block interactor — translates mouse / number-key input into intent
// events the match system applies. Lives on the local player; reads
// `this.input` directly each frame, never touches the world grid (the
// match system owns authority for what's mineable / placeable / in-range).
//
// Intents: pk_intent_mine, pk_intent_place, pk_intent_attack, plus
// pk_hotbar_selected for the hotbar slot keys. The `pk_toggle_inventory`
// fan-out lets the movement behavior pause input while the inventory
// overlay is open.
//
// Reusable beyond Pickaxe Keep: any voxel-ish sandbox where the player
// clicks blocks in the world plane. Tune `_planeAxis` to "z" for XY
// action plane (this game) or "y" for top-down/3D voxel games.
class BlockInteractorBehavior extends GameScript {
    _behaviorName = "block_interactor";

    _interactRange = 5.0;
    _attackRange = 2.5;
    _planeAxis = "z";        // which world axis the action plane is normal to
    _planeValue = 0;         // value of that axis (e.g. z=0 for sidescroll)
    _mineHoldRate = 0.18;    // re-emit pk_intent_mine while holding LMB
    _placeHoldRate = 0.18;
    _holdMineTimer = 0;
    _holdPlaceTimer = 0;
    _matchOver = false;
    _inventoryOpen = false;
    // Track the virtual cursor (the visible aim reticle that ui_bridge
    // integrates from mouse delta). Pickaxe Keep enables show_cursor in
    // its FSM, so the player's perceived aim point is the virtual
    // cursor — not the raw OS mouse position. Using getMousePosition()
    // here would mine/place at the wrong spot whenever the OS cursor
    // and virtual cursor diverge (which happens whenever pointer-lock
    // is on, the mouse leaves the canvas, or the page is scaled).
    _cursorX = 0;
    _cursorY = 0;
    _gotCursor = false;
    // One-shot click intents queued by ui_bridge's cursor_click /
    // cursor_right_click events. The press-frame coords baked into the
    // event match what the user actually touched — polling MouseLeft /
    // MouseRight against the cached cursor would land the first tap at
    // the previous cursor location on touch devices. Held auto-repeat
    // still uses the cached cursor, which is correct because the user
    // is dragging continuously across many cursor_move emissions.
    _pendingMineClick = null;
    _pendingPlaceClick = null;

    onStart() {
        var self = this;
        this.scene.events.game.on("match_ended",   function() { self._matchOver = true; });
        this.scene.events.game.on("match_started", function() { self._matchOver = false; });
        this.scene.events.game.on("pk_toggle_inventory", function() {
            self._inventoryOpen = !self._inventoryOpen;
        });
        this.scene.events.ui.on("cursor_move", function(d) {
            if (!d) return;
            self._cursorX = d.x;
            self._cursorY = d.y;
            self._gotCursor = true;
        });
        this.scene.events.ui.on("cursor_click", function(d) {
            if (!d) return;
            self._pendingMineClick = d;
        });
        this.scene.events.ui.on("cursor_right_click", function(d) {
            if (!d) return;
            self._pendingPlaceClick = d;
        });
        // Hotbar slot click → emit pk_hotbar_selected, mirrors Digit1-9.
        // Only the local player's instance fires the intent; remote
        // players' block_interactor instances see the same event but bail
        // on the isLocalPlayer check.
        this.scene.events.ui.on("ui_event:hud/pickaxe_hotbar:select_slot", function(d) {
            var ni = self.entity.getComponent
                ? self.entity.getComponent("NetworkIdentityComponent")
                : null;
            if (ni && !ni.isLocalPlayer) return;
            var p = (d && d.payload) || {};
            if (typeof p.slot === "number" && p.slot >= 0 && p.slot < 9) {
                self.scene.events.game.emit("pk_hotbar_selected", { slot: p.slot });
            }
        });
    }

    onUpdate(dt) {
        // Capture and clear pending click events at the top so any
        // early-return path (match over, inventory open, remote player,
        // no cursor yet) drops them rather than letting them queue.
        var pendingMine = this._pendingMineClick;
        var pendingPlace = this._pendingPlaceClick;
        this._pendingMineClick = null;
        this._pendingPlaceClick = null;

        if (this._matchOver) return;
        var ni = this.entity.getComponent
            ? this.entity.getComponent("NetworkIdentityComponent")
            : null;
        if (ni && !ni.isLocalPlayer) return;

        // Hotbar select keys 1..9 → emit pk_hotbar_selected. The match
        // system tracks the active slot; the HUD listens for highlight.
        for (var d = 1; d <= 9; d++) {
            if (this.input.isKeyPressed && this.input.isKeyPressed("Digit" + d)) {
                this.scene.events.game.emit("pk_hotbar_selected", { slot: d - 1 });
            }
        }

        // Inventory toggle (E key). The toggle event flips both this
        // behavior's lock and the movement behavior's lock so neither
        // misbehaves while the player browses recipes.
        if (this.input.isKeyPressed && this.input.isKeyPressed("KeyE")) {
            this.scene.events.game.emit("pk_toggle_inventory", {});
        }

        // Stop processing world clicks while the inventory is open —
        // clicks during inventory should land on UI buttons, not blocks
        // hidden behind them.
        if (this._inventoryOpen) return;

        // Mining / placing — both are click-and-hold: the cursor_click /
        // cursor_right_click event fires one intent at the press-frame
        // coords, hold-down repeats at _mineHoldRate / _placeHoldRate
        // using the cached cursor (which is fresh because the user is
        // dragging across many frames). The match system handles
        // cooldowns on its own for mining time. Aim with the virtual
        // cursor (visible reticle), not the raw OS mouse — they diverge
        // under pointer lock and CSS-scaled canvases, and the player
        // aims at what they SEE.
        if (!this._gotCursor) return;
        var mouse = { x: this._cursorX, y: this._cursorY };

        // Left-click = mine / attack
        var lDown = this.input.isKeyDown ? this.input.isKeyDown("MouseLeft") : false;
        if (pendingMine) {
            this._holdMineTimer = 0;
            this._fireMineOrAttack({ x: pendingMine.x, y: pendingMine.y });
        } else if (lDown) {
            this._holdMineTimer += dt;
            if (this._holdMineTimer >= this._mineHoldRate) {
                this._holdMineTimer = 0;
                this._fireMineOrAttack(mouse);
            }
        } else {
            this._holdMineTimer = 0;
        }

        // Right-click = place
        var rDown = this.input.isKeyDown ? this.input.isKeyDown("MouseRight") : false;
        if (pendingPlace) {
            this._holdPlaceTimer = 0;
            this._firePlace({ x: pendingPlace.x, y: pendingPlace.y });
        } else if (rDown) {
            this._holdPlaceTimer += dt;
            if (this._holdPlaceTimer >= this._placeHoldRate) {
                this._holdPlaceTimer = 0;
                this._firePlace(mouse);
            }
        } else {
            this._holdPlaceTimer = 0;
        }
    }

    _fireMineOrAttack(mouse) {
        // Pre-resolve to an entity under the cursor — gives the match
        // system both a cell index and (when present) the entity ID so
        // it can match against the block grid OR an enemy in one shot.
        var hit = this.scene.screenRaycast ? this.scene.screenRaycast(mouse.x, mouse.y, 60) : null;
        var planePoint = this._mouseOnPlane(mouse);
        if (!planePoint) return;

        var pp = this.entity.transform.position;
        var dx = planePoint.x - pp.x;
        var dy = planePoint.y - pp.y;
        var dist = Math.sqrt(dx * dx + dy * dy);

        // Prefer entity hits within attack range (zombies, props) for
        // the attack pulse so the match system can damage them. Fall
        // through to the mine intent if the click landed on a block.
        if (hit && hit.entityId && dist <= this._attackRange) {
            this.scene.events.game.emit("pk_intent_attack", {
                entityId: hit.entityId,
                x: planePoint.x,
                y: planePoint.y,
            });
        }

        if (dist <= this._interactRange) {
            this.scene.events.game.emit("pk_intent_mine", {
                x: Math.round(planePoint.x),
                y: Math.round(planePoint.y),
                entityId: hit && hit.entityId ? hit.entityId : 0,
            });
        }
    }

    _firePlace(mouse) {
        var planePoint = this._mouseOnPlane(mouse);
        if (!planePoint) return;
        var pp = this.entity.transform.position;
        var dx = planePoint.x - pp.x;
        var dy = planePoint.y - pp.y;
        if (dx * dx + dy * dy > this._interactRange * this._interactRange) return;
        this.scene.events.game.emit("pk_intent_place", {
            x: Math.round(planePoint.x),
            y: Math.round(planePoint.y),
        });
    }

    // Project the cursor onto the action plane. For a sidescroll game
    // the plane is z = _planeValue; we get a ray from the camera and
    // intersect it analytically. screenPointToGround only handles a
    // horizontal plane (y=const), so we roll the math here.
    _mouseOnPlane(mouse) {
        if (!this.scene.screenToWorldRay) return null;
        var ray = this.scene.screenToWorldRay(mouse.x, mouse.y);
        if (!ray || !ray.origin || !ray.direction) return null;
        var o = ray.origin, d = ray.direction;
        if (this._planeAxis === "z") {
            if (Math.abs(d.z) < 1e-6) return null;
            var t = (this._planeValue - o.z) / d.z;
            if (t < 0) return null;
            return { x: o.x + d.x * t, y: o.y + d.y * t, z: this._planeValue };
        }
        if (this._planeAxis === "y") {
            if (Math.abs(d.y) < 1e-6) return null;
            var t2 = (this._planeValue - o.y) / d.y;
            if (t2 < 0) return null;
            return { x: o.x + d.x * t2, y: this._planeValue, z: o.z + d.z * t2 };
        }
        // x-axis plane
        if (Math.abs(d.x) < 1e-6) return null;
        var t3 = (this._planeValue - o.x) / d.x;
        if (t3 < 0) return null;
        return { x: this._planeValue, y: o.y + d.y * t3, z: o.z + d.z * t3 };
    }
}
