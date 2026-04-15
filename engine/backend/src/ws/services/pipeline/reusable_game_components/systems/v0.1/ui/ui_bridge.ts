// UIBridge — generic bridge between game events and HTML UI overlays.
// Forwards all game events as state to HTML panels via sendState().
// Does NOT contain game-specific logic — scripts set state via hud_update events.

class UIBridge extends GameScript {
    _state = {};
    _dirty = true;
    _cursorVisible = false;
    _cursorX = 400;
    _cursorY = 300;
    _resendTimer = 0;
    _resendCount = 0;

    onStart() {
        var self = this;

        // Center cursor on viewport
        var canvas = (typeof document !== "undefined") ? document.querySelector(".viewport-canvas-container") || document.querySelector("canvas") : null;
        if (canvas) {
            var rect = canvas.getBoundingClientRect();
            self._cursorX = rect.left + rect.width / 2;
            self._cursorY = rect.top + rect.height / 2;
        }

        // ── FSM state (phase, vars) ──
        this.scene.events.game.on("state_changed", function(data) {
            for (var k in data) self._state[k] = data[k];
            self._dirty = true;
        });

        // ── HUD updates (generic key-value merge from any script) ──
        this.scene.events.ui.on("hud_update", function(data) {
            for (var k in data) self._state[k] = data[k];
            self._dirty = true;
        });

        // ── UI panel visibility (driven by FSM) ──
        this.scene.events.ui.on("show_ui", function(data) {
            var flag = (data.panel || "").replace(/[^a-zA-Z0-9_]/g, "") + "Visible";
            self._state[flag] = true;
            self._dirty = true;
            self._resendTimer = 0;
            self._resendCount = 5;
        });
        this.scene.events.ui.on("hide_ui", function(data) {
            var flag = (data.panel || "").replace(/[^a-zA-Z0-9_]/g, "") + "Visible";
            self._state[flag] = false;
            self._dirty = true;
        });

        // ── Cursor ──
        this.scene.events.ui.on("show_cursor", function() { self._cursorVisible = true; self._dirty = true; });
        this.scene.events.ui.on("hide_cursor", function() { self._cursorVisible = false; self._dirty = true; });

        // ── Notifications ──
        this.scene.events.ui.on("show_notification", function(data) {
            self._state._notification = data.text || "";
            self._dirty = true;
            setTimeout(function() { self._state._notification = ""; self._dirty = true; }, data.duration || 3000);
        });

        // ── UI commands from HTML buttons ──
        this.scene.events.ui.on("ui_command", function(data) {
            var action = data.action || "";
            var panel = data.panel || "";

            // Emit panel-qualified event for FSM transitions
            if (panel && action) {
                self.scene.events.ui.emit("ui_event:" + panel + ":" + action, data);
            }

            self._dirty = true;
        });
    }

    onUpdate(dt) {
        // Pause toggle. KeyP is the reserved pause key — don't bind
        // Escape, it's owned by the browser's pointer-lock release.
        // Emits both pause and resume — each FSM state scopes its own
        // transition, so only the relevant one fires.
        if (this.input.isKeyPressed("KeyP")) {
            this.scene.events.ui.emit("keyboard:pause", {});
            this.scene.events.ui.emit("keyboard:resume", {});
        }

        // Virtual cursor
        if (this._cursorVisible) {
            var delta = this.input.getMouseDelta();
            this._cursorX += delta.x;
            this._cursorY += delta.y;
            var vc = (typeof document !== "undefined") ? document.querySelector(".viewport-canvas-container") : null;
            if (vc) {
                var vr = vc.getBoundingClientRect();
                this._cursorX = Math.max(vr.left, Math.min(vr.right, this._cursorX));
                this._cursorY = Math.max(vr.top, Math.min(vr.bottom, this._cursorY));
            }
            var offX = 0, offY = 0;
            if (vc) { var vcR = vc.getBoundingClientRect(); offX = vcR.left; offY = vcR.top; }
            this._state._cursor = { visible: true, x: this._cursorX - offX, y: this._cursorY - offY };

            var canvasEl = (typeof document !== "undefined") ? document.querySelector(".viewport-canvas-container canvas") || vc : null;
            var cx = this._cursorX, cy = this._cursorY;
            if (canvasEl) { var cr = canvasEl.getBoundingClientRect(); cx -= cr.left; cy -= cr.top; }
            this.scene.events.ui.emit("cursor_move", { x: cx, y: cy });

            if (this.input.isKeyPressed("MouseLeft")) {
                this._state._cursorClick = { x: this._cursorX - offX, y: this._cursorY - offY };
                this.scene.events.ui.emit("cursor_click", { x: cx, y: cy });
            }
            if (this.input.isKeyPressed("MouseRight")) {
                this.scene.events.ui.emit("cursor_right_click", { x: cx, y: cy });
            }
            this._dirty = true;
        } else {
            if (this._state._cursor && this._state._cursor.visible) {
                this._state._cursor = { visible: false, x: 0, y: 0 };
                this._dirty = true;
            }
        }

        // Re-send state after new panels load
        if (this._resendCount > 0) {
            this._resendTimer += dt;
            if (this._resendTimer >= 0.1) {
                this._resendTimer = 0;
                this._resendCount--;
                this._dirty = true;
            }
        }

        // Send state to HTML UI
        if (!this._dirty) return;
        this._dirty = false;
        if (this.ui && this.ui.sendState) {
            this.ui.sendState(this._state);
        }
        if (this._state._cursorClick) {
            delete this._state._cursorClick;
        }
    }
}
