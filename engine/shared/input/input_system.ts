export interface InputModifiers {
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
}

export interface InputPlatformAdapter {
    requestPointerLock?(): void;
    exitPointerLock?(): void;
    isPointerLocked?(): boolean;
    pollGamepads?(): { axes: readonly number[]; buttons: readonly { pressed: boolean }[] } | null;
}

/**
 * Platform-agnostic input state manager.
 *
 * Used by both the browser frontend (fed from DOM events via InputDevice)
 * and the headless backend (fed from simulation methods).
 */
export class InputSystem {
    private adapter: InputPlatformAdapter | null = null;

    // Key state
    private keysDown = new Set<string>();
    private keysJustPressed = new Set<string>();
    private keysJustReleased = new Set<string>();
    private keysDownPrev = new Set<string>();

    // Mouse button state
    private mouseButtonsDown = new Set<number>();
    private mouseButtonsJustPressed = new Set<number>();
    private mouseButtonsJustReleased = new Set<number>();
    private mouseButtonsPrev = new Set<number>();

    // Mouse position and delta
    private mouseX = 0;
    private mouseY = 0;
    private mouseDeltaX = 0;
    private mouseDeltaY = 0;
    private scrollDeltaX = 0;
    private scrollDeltaY = 0;

    // Accumulated deltas within the current frame
    private frameDeltaX = 0;
    private frameDeltaY = 0;
    private frameScrollX = 0;
    private frameScrollY = 0;

    // Gamepad state
    private gamepadAxes: number[] = [];
    private gamepadButtonsDown = new Map<number, boolean>();
    private gamepadButtonsPrev = new Map<number, boolean>();

    // Modifier keys
    private modifiers: InputModifiers = { ctrl: false, shift: false, alt: false, meta: false };

    setPlatformAdapter(adapter: InputPlatformAdapter): void {
        this.adapter = adapter;
    }

    // ── Event injection (called by platform layer / InputDevice callbacks) ──

    injectKeyDown(code: string): void {
        this.keysDown.add(code);
    }

    injectKeyUp(code: string): void {
        this.keysDown.delete(code);
    }

    injectMouseButtonDown(button: number, x: number, y: number): void {
        this.mouseButtonsDown.add(button);
        this.mouseX = x;
        this.mouseY = y;
    }

    injectMouseButtonUp(button: number, x: number, y: number): void {
        this.mouseButtonsDown.delete(button);
        this.mouseX = x;
        this.mouseY = y;
    }

    injectMouseMove(x: number, y: number, deltaX: number, deltaY: number): void {
        this.mouseX = x;
        this.mouseY = y;
        this.frameDeltaX += deltaX;
        this.frameDeltaY += deltaY;
    }

    injectWheel(deltaX: number, deltaY: number): void {
        this.frameScrollX += deltaX;
        this.frameScrollY += deltaY;
    }

    injectModifiers(mods: InputModifiers): void {
        this.modifiers = mods;
    }

    // ── Simulation (for headless / testing) ──

    simulateKeyDown(key: string): void {
        const mb = this.mouseStringToButton(key);
        if (mb !== null) { this.mouseButtonsDown.add(mb); return; }
        this.keysDown.add(key);
    }

    simulateKeyUp(key: string): void {
        const mb = this.mouseStringToButton(key);
        if (mb !== null) { this.mouseButtonsDown.delete(mb); return; }
        this.keysDown.delete(key);
    }

    simulateMouseMove(dx: number, dy: number): void {
        this.frameDeltaX += dx;
        this.frameDeltaY += dy;
    }

    simulateMousePosition(x: number, y: number): void {
        this.mouseX = x;
        this.mouseY = y;
    }

    simulateScroll(delta: number): void {
        this.frameScrollY += delta;
    }

    // ── Frame management ──

    /** Called at the beginning of each frame to compute just-pressed/released state. */
    tick(): void {
        this.keysJustPressed.clear();
        this.keysJustReleased.clear();
        for (const key of this.keysDown) {
            if (!this.keysDownPrev.has(key)) this.keysJustPressed.add(key);
        }
        for (const key of this.keysDownPrev) {
            if (!this.keysDown.has(key)) this.keysJustReleased.add(key);
        }

        this.mouseButtonsJustPressed.clear();
        this.mouseButtonsJustReleased.clear();
        for (const btn of this.mouseButtonsDown) {
            if (!this.mouseButtonsPrev.has(btn)) this.mouseButtonsJustPressed.add(btn);
        }
        for (const btn of this.mouseButtonsPrev) {
            if (!this.mouseButtonsDown.has(btn)) this.mouseButtonsJustReleased.add(btn);
        }

        this.mouseDeltaX = this.frameDeltaX;
        this.mouseDeltaY = this.frameDeltaY;
        this.scrollDeltaX = this.frameScrollX;
        this.scrollDeltaY = this.frameScrollY;

        this.pollGamepads();
    }

    /** Called at the end of each frame to save current state as previous. */
    endFrame(): void {
        this.keysDownPrev = new Set(this.keysDown);
        this.mouseButtonsPrev = new Set(this.mouseButtonsDown);
        this.gamepadButtonsPrev = new Map(this.gamepadButtonsDown);
        this.frameDeltaX = 0;
        this.frameDeltaY = 0;
        this.frameScrollX = 0;
        this.frameScrollY = 0;
    }

    // ── Mouse button string mapping ──

    private mouseStringToButton(code: string): number | null {
        if (code === 'MouseLeft' || code === 'Mouse0') return 0;
        if (code === 'MouseMiddle' || code === 'Mouse1') return 1;
        if (code === 'MouseRight' || code === 'Mouse2') return 2;
        return null;
    }

    // ── Key queries ──

    isKeyDown(code: string): boolean {
        const mb = this.mouseStringToButton(code);
        if (mb !== null) return this.mouseButtonsDown.has(mb);
        return this.keysDown.has(code);
    }

    isKeyJustPressed(code: string): boolean {
        const mb = this.mouseStringToButton(code);
        if (mb !== null) return this.mouseButtonsJustPressed.has(mb);
        return this.keysJustPressed.has(code);
    }

    isKeyPressed(code: string): boolean {
        return this.isKeyJustPressed(code);
    }

    isKeyJustReleased(code: string): boolean {
        const mb = this.mouseStringToButton(code);
        if (mb !== null) return this.mouseButtonsJustReleased.has(mb);
        return this.keysJustReleased.has(code);
    }

    isKeyReleased(code: string): boolean {
        return this.isKeyJustReleased(code);
    }

    // ── Mouse queries ──

    isMouseButtonDown(button: number | string): boolean {
        const b = typeof button === 'string' ? (this.mouseStringToButton(button) ?? -1) : button;
        return this.mouseButtonsDown.has(b);
    }

    isMouseButtonJustPressed(button: number | string): boolean {
        const b = typeof button === 'string' ? (this.mouseStringToButton(button) ?? -1) : button;
        return this.mouseButtonsJustPressed.has(b);
    }

    isMouseButtonJustReleased(button: number | string): boolean {
        const b = typeof button === 'string' ? (this.mouseStringToButton(button) ?? -1) : button;
        return this.mouseButtonsJustReleased.has(b);
    }

    getMousePosition(): { x: number; y: number } {
        return { x: this.mouseX, y: this.mouseY };
    }

    getMouseX(): number { return this.mouseX; }
    getMouseY(): number { return this.mouseY; }

    getMouseDelta(): { x: number; y: number } {
        return { x: this.mouseDeltaX, y: this.mouseDeltaY };
    }

    getMouseDeltaX(): number { return this.mouseDeltaX; }
    getMouseDeltaY(): number { return this.mouseDeltaY; }

    getScrollDelta(): { x: number; y: number } {
        return { x: this.scrollDeltaX, y: this.scrollDeltaY };
    }

    getModifiers(): InputModifiers {
        return { ...this.modifiers };
    }

    // ── Gamepad ──

    getGamepadAxis(index: number): number {
        return this.gamepadAxes[index] ?? 0;
    }

    isGamepadButtonDown(index: number): boolean {
        return this.gamepadButtonsDown.get(index) ?? false;
    }

    private pollGamepads(): void {
        const gp = this.adapter?.pollGamepads?.();
        if (!gp) return;
        this.gamepadAxes = Array.from(gp.axes).map(v => Math.abs(v) < 0.1 ? 0 : v);
        for (let i = 0; i < gp.buttons.length; i++) {
            this.gamepadButtonsDown.set(i, gp.buttons[i].pressed);
        }
    }

    // ── Pointer lock ──

    requestPointerLock(): void {
        this.adapter?.requestPointerLock?.();
    }

    exitPointerLock(): void {
        this.adapter?.exitPointerLock?.();
    }

    isPointerLocked(): boolean {
        return this.adapter?.isPointerLocked?.() ?? true;
    }

    /** Clear all held key/button state. Call when focus leaves the game viewport. */
    clearAllInputState(): void {
        this.keysDown.clear();
        this.keysJustPressed.clear();
        this.keysJustReleased.clear();
        this.keysDownPrev.clear();
        this.mouseButtonsDown.clear();
        this.mouseButtonsJustPressed.clear();
        this.mouseButtonsJustReleased.clear();
        this.mouseButtonsPrev.clear();
        this.frameDeltaX = 0;
        this.frameDeltaY = 0;
        this.frameScrollX = 0;
        this.frameScrollY = 0;
    }

    shutdown(): void {
        this.keysDown.clear();
        this.keysJustPressed.clear();
        this.keysJustReleased.clear();
        this.keysDownPrev.clear();
        this.mouseButtonsDown.clear();
        this.mouseButtonsJustPressed.clear();
        this.mouseButtonsJustReleased.clear();
        this.mouseButtonsPrev.clear();
        this.gamepadAxes = [];
        this.gamepadButtonsDown.clear();
        this.gamepadButtonsPrev.clear();
    }
}
