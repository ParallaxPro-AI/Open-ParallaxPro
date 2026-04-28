import type { InputModifiers } from '../../../../shared/input/input_system.js';

function isEditorTextInput(el: HTMLElement | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
        return !el.closest('iframe');
    }
    if (el.isContentEditable) return true;
    return false;
}

type KeyDownCallback = (key: string, code: string, repeat: boolean, modifiers: InputModifiers) => void;
type KeyUpCallback = (key: string, code: string, modifiers: InputModifiers) => void;
type MouseButtonCallback = (button: number, x: number, y: number, modifiers: InputModifiers) => void;
type MouseMoveCallback = (x: number, y: number, deltaX: number, deltaY: number) => void;
type WheelCallback = (deltaX: number, deltaY: number) => void;
type TouchCallback = (touches: Touch[]) => void;
type GamepadCallback = (gamepad: Gamepad) => void;

function extractModifiers(event: KeyboardEvent | MouseEvent | TouchEvent): InputModifiers {
    return {
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        meta: event.metaKey,
    };
}

export class InputDevice {
    private canvas: HTMLCanvasElement | null = null;
    public forcePointerLocked: boolean = false;
    public suppressGameInput: boolean = false;
    /**
     * When true, the legacy "primary-touch-as-mouse" path inside
     * `connectInputDevice` is bypassed. The MobileInputOverlay sets this on
     * touch devices because it owns viewport tap handling itself and
     * already calls injectMouseButtonDown / injectMouseMove with
     * canvas-relative coordinates. Without this flag, every viewport tap
     * would inject TWO mouse-down events (overlay + legacy shim) and
     * scripts that count `isMouseButtonJustPressed(0)` would double-fire.
     */
    public suppressLegacyTouchAsMouse: boolean = false;

    private keyDownCallbacks: Set<KeyDownCallback> = new Set();
    private keyUpCallbacks: Set<KeyUpCallback> = new Set();
    private mouseDownCallbacks: Set<MouseButtonCallback> = new Set();
    private mouseUpCallbacks: Set<MouseButtonCallback> = new Set();
    private mouseMoveCallbacks: Set<MouseMoveCallback> = new Set();
    private wheelCallbacks: Set<WheelCallback> = new Set();
    private touchStartCallbacks: Set<TouchCallback> = new Set();
    private touchMoveCallbacks: Set<TouchCallback> = new Set();
    private touchEndCallbacks: Set<TouchCallback> = new Set();
    private gamepadConnectedCallbacks: Set<GamepadCallback> = new Set();
    private gamepadDisconnectedCallbacks: Set<GamepadCallback> = new Set();

    private boundKeyDown: ((e: KeyboardEvent) => void) | null = null;
    private boundKeyUp: ((e: KeyboardEvent) => void) | null = null;
    private boundMouseDown: ((e: MouseEvent) => void) | null = null;
    private boundMouseUp: ((e: MouseEvent) => void) | null = null;
    private boundMouseMove: ((e: MouseEvent) => void) | null = null;
    private boundWheel: ((e: WheelEvent) => void) | null = null;
    private boundTouchStart: ((e: TouchEvent) => void) | null = null;
    private boundTouchMove: ((e: TouchEvent) => void) | null = null;
    private boundTouchEnd: ((e: TouchEvent) => void) | null = null;
    private boundGamepadConnected: ((e: GamepadEvent) => void) | null = null;
    private boundGamepadDisconnected: ((e: GamepadEvent) => void) | null = null;
    private boundContextMenu: ((e: Event) => void) | null = null;

    initialize(canvasElement: HTMLCanvasElement): void {
        this.canvas = canvasElement;

        if (!canvasElement.hasAttribute('tabindex')) {
            canvasElement.setAttribute('tabindex', '0');
        }

        this.boundKeyDown = (e: KeyboardEvent) => {
            if (isEditorTextInput(e.target as HTMLElement)) return;
            if (this.suppressGameInput) return;
            for (const cb of this.keyDownCallbacks) {
                cb(e.key, e.code, e.repeat, extractModifiers(e));
            }
        };

        this.boundKeyUp = (e: KeyboardEvent) => {
            // Intentionally NOT filtering on isEditorTextInput here (unlike
            // keydown). If the user presses W on the canvas, then focuses
            // the chat input and releases W, the keyup target is the chat
            // input — filtering would swallow it and the engine's
            // keysDown set would think W is still held forever, leaving
            // the character stuck walking forward until a fresh W
            // keydown+keyup pair fires on the canvas.
            //
            // Forwarding every keyup unconditionally is safe: injectKeyUp
            // for a key that was never injectKeyDown'd is a no-op
            // (Set.delete on a missing member), and no game scripts in the
            // codebase subscribe to onKeyUp directly — they all poll
            // isKeyDown/isKeyPressed, which only reads the keysDown set.
            if (this.suppressGameInput) return;
            for (const cb of this.keyUpCallbacks) {
                cb(e.key, e.code, extractModifiers(e));
            }
        };

        this.boundMouseDown = (e: MouseEvent) => {
            if (this.suppressGameInput) return;
            const rect = canvasElement.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            for (const cb of this.mouseDownCallbacks) {
                cb(e.button, x, y, extractModifiers(e));
            }
        };

        this.boundMouseUp = (e: MouseEvent) => {
            if (this.suppressGameInput) return;
            const rect = canvasElement.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            for (const cb of this.mouseUpCallbacks) {
                cb(e.button, x, y, extractModifiers(e));
            }
        };

        this.boundMouseMove = (e: MouseEvent) => {
            const rect = canvasElement.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            for (const cb of this.mouseMoveCallbacks) {
                cb(x, y, e.movementX, e.movementY);
            }
        };

        this.boundWheel = (e: WheelEvent) => {
            e.preventDefault();
            for (const cb of this.wheelCallbacks) {
                cb(e.deltaX, e.deltaY);
            }
        };

        this.boundTouchStart = (e: TouchEvent) => {
            e.preventDefault();
            const touches = Array.from(e.changedTouches);
            for (const cb of this.touchStartCallbacks) {
                cb(touches);
            }
        };

        this.boundTouchMove = (e: TouchEvent) => {
            e.preventDefault();
            const touches = Array.from(e.touches);
            for (const cb of this.touchMoveCallbacks) {
                cb(touches);
            }
        };

        this.boundTouchEnd = (e: TouchEvent) => {
            const touches = Array.from(e.touches);
            for (const cb of this.touchEndCallbacks) {
                cb(touches);
            }
        };

        this.boundGamepadConnected = (e: GamepadEvent) => {
            for (const cb of this.gamepadConnectedCallbacks) {
                cb(e.gamepad);
            }
        };

        this.boundGamepadDisconnected = (e: GamepadEvent) => {
            for (const cb of this.gamepadDisconnectedCallbacks) {
                cb(e.gamepad);
            }
        };

        this.boundContextMenu = (e: Event) => {
            e.preventDefault();
        };

        window.addEventListener('keydown', this.boundKeyDown);
        window.addEventListener('keyup', this.boundKeyUp);

        canvasElement.addEventListener('mousedown', this.boundMouseDown);
        canvasElement.addEventListener('mouseup', this.boundMouseUp);
        canvasElement.addEventListener('mousemove', this.boundMouseMove);
        canvasElement.addEventListener('wheel', this.boundWheel, { passive: false });
        canvasElement.addEventListener('contextmenu', this.boundContextMenu);

        canvasElement.addEventListener('touchstart', this.boundTouchStart, { passive: false });
        canvasElement.addEventListener('touchmove', this.boundTouchMove, { passive: false });
        canvasElement.addEventListener('touchend', this.boundTouchEnd);

        window.addEventListener('gamepadconnected', this.boundGamepadConnected);
        window.addEventListener('gamepaddisconnected', this.boundGamepadDisconnected);
    }

    onKeyDown(callback: KeyDownCallback): void { this.keyDownCallbacks.add(callback); }
    onKeyUp(callback: KeyUpCallback): void { this.keyUpCallbacks.add(callback); }
    onMouseDown(callback: MouseButtonCallback): void { this.mouseDownCallbacks.add(callback); }
    onMouseUp(callback: MouseButtonCallback): void { this.mouseUpCallbacks.add(callback); }
    onMouseMove(callback: MouseMoveCallback): void { this.mouseMoveCallbacks.add(callback); }
    onWheel(callback: WheelCallback): void { this.wheelCallbacks.add(callback); }
    onTouchStart(callback: TouchCallback): void { this.touchStartCallbacks.add(callback); }
    onTouchMove(callback: TouchCallback): void { this.touchMoveCallbacks.add(callback); }
    onTouchEnd(callback: TouchCallback): void { this.touchEndCallbacks.add(callback); }
    onGamepadConnected(callback: GamepadCallback): void { this.gamepadConnectedCallbacks.add(callback); }
    onGamepadDisconnected(callback: GamepadCallback): void { this.gamepadDisconnectedCallbacks.add(callback); }

    requestPointerLock(): void {
        if (this.canvas) {
            try { this.canvas.requestPointerLock(); } catch { /* requires user gesture */ }
        }
    }

    exitPointerLock(): void {
        document.exitPointerLock();
    }

    isPointerLocked(): boolean {
        return this.forcePointerLocked || document.pointerLockElement === this.canvas;
    }

    getGamepads(): (Gamepad | null)[] {
        return Array.from(navigator.getGamepads());
    }

    destroy(): void {
        if (this.boundKeyDown) window.removeEventListener('keydown', this.boundKeyDown);
        if (this.boundKeyUp) window.removeEventListener('keyup', this.boundKeyUp);
        if (this.boundGamepadConnected) window.removeEventListener('gamepadconnected', this.boundGamepadConnected);
        if (this.boundGamepadDisconnected) window.removeEventListener('gamepaddisconnected', this.boundGamepadDisconnected);

        if (this.canvas) {
            if (this.boundMouseDown) this.canvas.removeEventListener('mousedown', this.boundMouseDown);
            if (this.boundMouseUp) this.canvas.removeEventListener('mouseup', this.boundMouseUp);
            if (this.boundMouseMove) this.canvas.removeEventListener('mousemove', this.boundMouseMove);
            if (this.boundWheel) this.canvas.removeEventListener('wheel', this.boundWheel);
            if (this.boundContextMenu) this.canvas.removeEventListener('contextmenu', this.boundContextMenu);
            if (this.boundTouchStart) this.canvas.removeEventListener('touchstart', this.boundTouchStart);
            if (this.boundTouchMove) this.canvas.removeEventListener('touchmove', this.boundTouchMove);
            if (this.boundTouchEnd) this.canvas.removeEventListener('touchend', this.boundTouchEnd);
        }

        this.keyDownCallbacks.clear();
        this.keyUpCallbacks.clear();
        this.mouseDownCallbacks.clear();
        this.mouseUpCallbacks.clear();
        this.mouseMoveCallbacks.clear();
        this.wheelCallbacks.clear();
        this.touchStartCallbacks.clear();
        this.touchMoveCallbacks.clear();
        this.touchEndCallbacks.clear();
        this.gamepadConnectedCallbacks.clear();
        this.gamepadDisconnectedCallbacks.clear();

        this.canvas = null;
    }
}
