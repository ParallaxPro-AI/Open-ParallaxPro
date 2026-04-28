/**
 * mobile_input_overlay.ts — touch overlay that renders a manifest-driven
 * control surface and injects key/mouse events into a shared InputSystem.
 *
 * Design contract: scripts on desktop and mobile both poll the same
 * `InputSystem` for `isKeyDown("KeyW")`, `getMouseDelta()`, etc. The
 * overlay does not dispatch synthetic DOM KeyboardEvents (that path is
 * brittle — it goes through focus filters and key-repeat). Instead it
 * calls the InputSystem injection methods directly, exactly the way the
 * desktop `InputDevice` does for real hardware events. As a result every
 * existing behavior keeps working unchanged on touch.
 *
 * Multi-touch is partitioned by `Touch.identifier`: each finger is owned
 * by exactly one widget (joystick, look pad, action button, hotbar slot,
 * system tray, or viewport). On `touchend`/`touchcancel` we always
 * release every key the owning widget had pressed, so a lifted finger
 * never leaves a stuck key.
 */

import {
    ControlManifest,
    MouseToken,
    resolveManifest,
} from './control_manifest.js';

interface InjectionTarget {
    injectKeyDown(code: string): void;
    injectKeyUp(code: string): void;
    injectMouseButtonDown(button: number, x: number, y: number): void;
    injectMouseButtonUp(button: number, x: number, y: number): void;
    injectMouseMove(x: number, y: number, deltaX: number, deltaY: number): void;
    injectWheel(deltaX: number, deltaY: number): void;
    clearAllInputState(): void;
}

const STORAGE_KEY = 'pp_mobile_controls_enabled';

/** Threshold below which joystick deflection is treated as zero. */
const STICK_THRESHOLD = 0.3;

/** Auto-sprint engages when joystick deflection exceeds this. */
const SPRINT_THRESHOLD = 0.85;

/** Mouse-look pad sensitivity baseline in pixels-per-pixel; manifest can scale. */
const LOOK_PAD_BASE_SENS = 1.0;

/** Z-index — above the canvas, below HUD iframes. */
const OVERLAY_Z = 9000;

/** Map a `MouseLeft|Middle|Right` token to its mouse button index. */
function mouseButtonOf(code: string): number | null {
    if (code === 'MouseLeft') return 0;
    if (code === 'MouseMiddle') return 1;
    if (code === 'MouseRight') return 2;
    return null;
}

function isMouseToken(code: string): code is MouseToken {
    return code === 'MouseLeft' || code === 'MouseMiddle' || code === 'MouseRight';
}

export interface MobileInputOverlayOptions {
    canvas: HTMLCanvasElement;
    inputSystem: InjectionTarget;
    manifest: ControlManifest | null | undefined;
    /** Optional container the overlay attaches to. Defaults to canvas.parentElement or body. */
    container?: HTMLElement;
}

export interface MobileInputOverlay {
    /** Tear down DOM, remove listeners, release any stuck keys. */
    destroy(): void;
    /** Toggle visibility programmatically. State is persisted in localStorage. */
    setEnabled(enabled: boolean): void;
    /** Whether the overlay is currently rendering. */
    isEnabled(): boolean;
    /**
     * Suspend the overlay temporarily without overwriting the user's
     * `enabled` toggle. Multiple independent reasons can suspend the
     * overlay (edit-mode pauses scripts; AI chat sheet opens over the
     * viewport); the overlay is hidden iff any reason is active.
     *
     *   setSuspended(true)            → suspends with the default key
     *   setSuspended(true, 'chat')    → suspends with the 'chat' key
     *
     * localStorage state is untouched.
     */
    setSuspended(suspended: boolean, reason?: string): void;
}

/**
 * Detect a touch-capable device that should get the overlay.
 *
 * Matches the existing `html_ui_manager.ts:234` rule so mobile-disabled
 * cursor logic and overlay attach decisions agree. iPad-Pro-with-keyboard
 * (>1024px) stays on the desktop path.
 */
export function shouldShowMobileOverlay(): boolean {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    if (!('ontouchstart' in window)) return false;
    return window.innerWidth < 1024;
}

/**
 * Attach the overlay. Returns a handle with `destroy()`. If the device is
 * not touch-capable, returns a no-op handle without rendering.
 */
export function attachMobileInputOverlay(opts: MobileInputOverlayOptions): MobileInputOverlay {
    if (!shouldShowMobileOverlay()) {
        return noopOverlay();
    }

    const manifest = resolveManifest(opts.manifest);
    const inputSystem = opts.inputSystem;
    const canvas = opts.canvas;
    const container = opts.container || canvas.parentElement || document.body;

    let enabled = readEnabled();
    const suspendedReasons = new Set<string>();
    let destroyed = false;
    const isVisible = () => enabled && suspendedReasons.size === 0;

    // ── Root overlay ────────────────────────────────────────────────────
    const root = document.createElement('div');
    root.id = 'pp-mobile-controls-overlay';
    root.style.cssText = [
        'position:absolute',
        'inset:0',
        'pointer-events:none', // children opt back in
        `z-index:${OVERLAY_Z}`,
        'touch-action:none',
        'user-select:none',
        '-webkit-user-select:none',
        '-webkit-touch-callout:none',
        'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
    ].join(';');
    if (!isVisible()) root.style.display = 'none';
    container.appendChild(root);

    // Track which Touch.identifier each widget owns + the keys it pressed.
    type FingerState = {
        widget: 'joystick' | 'look' | 'action' | 'hotbar' | 'system' | 'viewport';
        keys: Set<string>; // keyboard codes (incl. Mouse* tokens we routed)
        mouseButton?: number;
        lastX: number;
        lastY: number;
        startX: number;
        startY: number;
        target?: any;
    };
    const fingers: Map<number, FingerState> = new Map();

    const press = (state: FingerState, code: string): void => {
        if (state.keys.has(code)) return;
        const mb = mouseButtonOf(code);
        if (mb !== null) {
            inputSystem.injectMouseButtonDown(mb, state.lastX, state.lastY);
            state.mouseButton = mb;
        } else {
            inputSystem.injectKeyDown(code);
        }
        state.keys.add(code);
    };
    const release = (state: FingerState, code: string): void => {
        if (!state.keys.has(code)) return;
        const mb = mouseButtonOf(code);
        if (mb !== null) {
            inputSystem.injectMouseButtonUp(mb, state.lastX, state.lastY);
        } else {
            inputSystem.injectKeyUp(code);
        }
        state.keys.delete(code);
    };
    const releaseAll = (state: FingerState): void => {
        for (const k of [...state.keys]) release(state, k);
    };

    // ── Joystick (left thumb) ────────────────────────────────────────────
    const movement = manifest.movement!;
    const movementKeys = movementKeyMap(movement.type);
    const joystick = movement.type !== 'none' ? buildJoystick() : null;
    if (joystick) root.appendChild(joystick.el);

    function buildJoystick() {
        const el = document.createElement('div');
        el.style.cssText = [
            'position:absolute',
            'left:max(20px, env(safe-area-inset-left))',
            'bottom:max(20px, env(safe-area-inset-bottom))',
            'width:140px',
            'height:140px',
            'pointer-events:auto',
            'touch-action:none',
        ].join(';');

        const base = document.createElement('div');
        base.style.cssText = 'position:absolute;inset:0;border-radius:50%;background:rgba(255,255,255,0.10);border:2px solid rgba(255,255,255,0.22);backdrop-filter:blur(4px);';
        const thumb = document.createElement('div');
        thumb.style.cssText = 'position:absolute;width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,0.28);border:2px solid rgba(255,255,255,0.45);top:50%;left:50%;transform:translate(-50%,-50%);transition:background 0.08s;';
        el.appendChild(base);
        el.appendChild(thumb);

        let cx = 0, cy = 0, r = 0;
        const onStart = (touch: Touch) => {
            if ([...fingers.values()].some(f => f.widget === 'joystick')) return; // one finger only
            const rect = el.getBoundingClientRect();
            cx = rect.left + rect.width / 2;
            cy = rect.top + rect.height / 2;
            r = rect.width / 2 - 28;
            const state: FingerState = {
                widget: 'joystick', keys: new Set(),
                lastX: touch.clientX, lastY: touch.clientY,
                startX: touch.clientX, startY: touch.clientY,
            };
            fingers.set(touch.identifier, state);
            applyDeflection(touch.clientX, touch.clientY, state);
        };
        const onMove = (touch: Touch, state: FingerState) => {
            state.lastX = touch.clientX; state.lastY = touch.clientY;
            applyDeflection(touch.clientX, touch.clientY, state);
        };
        const onEnd = (state: FingerState) => {
            releaseAll(state);
            thumb.style.transform = 'translate(-50%, -50%)';
            thumb.style.background = 'rgba(255,255,255,0.28)';
        };
        const applyDeflection = (x: number, y: number, state: FingerState) => {
            let dx = x - cx, dy = y - cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > r && r > 0) { dx = (dx / dist) * r; dy = (dy / dist) * r; }
            thumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
            const nx = r > 0 ? dx / r : 0;
            const ny = r > 0 ? dy / r : 0;
            const mag = Math.sqrt(nx * nx + ny * ny);
            // Cardinal mapping
            if (movementKeys.up)    (ny < -STICK_THRESHOLD ? press : release)(state, movementKeys.up);
            if (movementKeys.down)  (ny >  STICK_THRESHOLD ? press : release)(state, movementKeys.down);
            if (movementKeys.left)  (nx < -STICK_THRESHOLD ? press : release)(state, movementKeys.left);
            if (movementKeys.right) (nx >  STICK_THRESHOLD ? press : release)(state, movementKeys.right);
            // Auto-sprint at strong deflection
            if (movement.sprint) {
                (mag > SPRINT_THRESHOLD ? press : release)(state, movement.sprint);
            }
            thumb.style.background = mag > 0.05 ? 'rgba(140,80,230,0.40)' : 'rgba(255,255,255,0.28)';
        };

        return { el, onStart, onMove, onEnd };
    }

    // ── Look pad (right thumb, full right half by default) ────────────────
    const look = manifest.look!;
    const lookPad = look.type === 'mouseDelta' ? buildLookPad() : null;
    if (lookPad) root.appendChild(lookPad.el);

    function buildLookPad() {
        const el = document.createElement('div');
        // Right half of screen, clear of bottom-right action stack which uses pointer-events:auto on its own subtree.
        el.style.cssText = [
            'position:absolute',
            'right:0',
            'top:0',
            'width:50%',
            'height:75%',
            // pointer-events: none, NOT auto. The browser must hit-test
            // *through* the look pad so taps that land on a HUD iframe in
            // this region (top-right score, top-center timer, etc.) reach
            // the iframe instead of being swallowed by an invisible
            // capture surface. Document-level capture still sees the
            // touch and we decide in widgetAt() whether this point is
            // bare canvas (treat as look gesture) or covered by a HUD
            // (yield, don't consume).
            'pointer-events:none',
            'touch-action:none',
            'background:transparent',
        ].join(';');
        const sens = (look.sensitivity ?? LOOK_PAD_BASE_SENS);
        const onStart = (touch: Touch) => {
            const state: FingerState = {
                widget: 'look', keys: new Set(),
                lastX: touch.clientX, lastY: touch.clientY,
                startX: touch.clientX, startY: touch.clientY,
            };
            fingers.set(touch.identifier, state);
        };
        const onMove = (touch: Touch, state: FingerState) => {
            const dx = (touch.clientX - state.lastX) * sens;
            const dy = (touch.clientY - state.lastY) * sens;
            state.lastX = touch.clientX; state.lastY = touch.clientY;
            inputSystem.injectMouseMove(touch.clientX, touch.clientY, dx, dy);
        };
        const onEnd = (_state: FingerState) => { /* nothing to release */ };
        return { el, onStart, onMove, onEnd };
    }

    // ── Action rail (right side, vertical stack of buttons) ──────────────
    const railContainer = document.createElement('div');
    railContainer.style.cssText = [
        'position:absolute',
        'right:max(20px, env(safe-area-inset-right))',
        'bottom:max(20px, env(safe-area-inset-bottom))',
        'display:flex',
        'flex-direction:column-reverse',
        'gap:10px',
        'pointer-events:none',
        'align-items:flex-end',
    ].join(';');
    root.appendChild(railContainer);

    // Build buttons: fire.primary (big, bottom), fire.secondary, jump, then actions[]
    const railButtons: ReturnType<typeof buildButton>[] = [];
    const fire = manifest.fire;
    if (fire?.primary) railButtons.push(buildButton({
        key: fire.primary, label: fire.label || 'Fire', size: 84, accent: true,
        hold: fire.holdPrimary !== false,
    }));
    if (fire?.secondary) railButtons.push(buildButton({
        key: fire.secondary, label: fire.secondaryLabel || 'Aim', size: 64,
        hold: fire.holdSecondary !== false,
    }));
    if (movement.jump) railButtons.push(buildButton({
        key: movement.jump, label: 'Jump', size: 72,
    }));
    if (movement.crouch) railButtons.push(buildButton({
        key: movement.crouch, label: 'Crouch', size: 56, hold: true,
    }));
    for (const action of manifest.actions || []) {
        railButtons.push(buildButton({
            key: action.key, label: action.label, size: 60, hold: !!action.hold, toggle: !!action.toggle,
        }));
    }
    for (const b of railButtons) railContainer.appendChild(b.el);

    function buildButton(cfg: {
        key: string; label: string; size: number; accent?: boolean; hold?: boolean; toggle?: boolean;
    }) {
        const el = document.createElement('div');
        el.style.cssText = [
            'pointer-events:auto',
            'touch-action:none',
            `width:${cfg.size}px`,
            `height:${cfg.size}px`,
            'border-radius:50%',
            `background:${cfg.accent ? 'rgba(220,80,80,0.30)' : 'rgba(255,255,255,0.14)'}`,
            `border:2px solid ${cfg.accent ? 'rgba(255,120,120,0.55)' : 'rgba(255,255,255,0.28)'}`,
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'color:rgba(255,255,255,0.92)',
            `font-size:${Math.max(11, Math.floor(cfg.size / 5.5))}px`,
            'font-weight:600',
            'backdrop-filter:blur(4px)',
        ].join(';');
        el.textContent = cfg.label;
        let toggled = false;
        const onStart = (touch: Touch) => {
            const state: FingerState = {
                widget: 'action', keys: new Set(),
                lastX: touch.clientX, lastY: touch.clientY,
                startX: touch.clientX, startY: touch.clientY,
                target: el,
            };
            fingers.set(touch.identifier, state);
            el.style.transform = 'scale(0.94)';
            el.style.background = cfg.accent ? 'rgba(220,80,80,0.55)' : 'rgba(140,80,230,0.40)';
            if (cfg.toggle) {
                toggled = !toggled;
                if (toggled) press(state, cfg.key);
                else release(state, cfg.key);
            } else {
                press(state, cfg.key);
            }
        };
        const onMove = (_touch: Touch, _state: FingerState) => { /* no-op */ };
        const onEnd = (state: FingerState) => {
            el.style.transform = '';
            el.style.background = cfg.accent ? 'rgba(220,80,80,0.30)' : 'rgba(255,255,255,0.14)';
            if (cfg.toggle) {
                // Toggle stays pressed across this touch end; key is released only on next tap.
                state.keys.delete(cfg.key);
                return;
            }
            if (cfg.hold === false) {
                // Momentary tap: release immediately on touchstart-end pair, but
                // for `hold: false` we still want a clean keydown then keyup.
                releaseAll(state);
                return;
            }
            releaseAll(state);
        };
        return { el, onStart, onMove, onEnd, key: cfg.key };
    }

    // ── Hotbar (top strip of digit / function-key slots) ──────────────────
    const hotbarBtns: ReturnType<typeof buildHotbarSlot>[] = [];
    if (manifest.hotbar) {
        const slots = expandHotbarRange(manifest.hotbar.from, manifest.hotbar.to);
        const labels = manifest.hotbar.labels || [];
        const hotbar = document.createElement('div');
        hotbar.style.cssText = [
            'position:absolute',
            'left:50%',
            'transform:translateX(-50%)',
            'top:max(12px, env(safe-area-inset-top))',
            'display:flex',
            'gap:6px',
            'pointer-events:none',
        ].join(';');
        slots.forEach((code, i) => {
            const b = buildHotbarSlot(code, labels[i] || labelFromHotbarCode(code));
            hotbar.appendChild(b.el);
            hotbarBtns.push(b);
        });
        root.appendChild(hotbar);
    }

    function buildHotbarSlot(code: string, label: string) {
        const el = document.createElement('div');
        el.style.cssText = [
            'pointer-events:auto',
            'touch-action:none',
            'min-width:38px',
            'height:38px',
            'padding:0 6px',
            'border-radius:8px',
            'background:rgba(0,0,0,0.40)',
            'border:1px solid rgba(255,255,255,0.20)',
            'display:flex',
            'flex-direction:column',
            'align-items:center',
            'justify-content:center',
            'color:rgba(255,255,255,0.92)',
            'font-size:10px',
            'font-weight:600',
            'gap:1px',
        ].join(';');
        const num = document.createElement('div');
        num.textContent = label;
        num.style.cssText = 'font-size:13px;line-height:1;';
        el.appendChild(num);
        const onStart = (touch: Touch) => {
            const state: FingerState = {
                widget: 'hotbar', keys: new Set(),
                lastX: touch.clientX, lastY: touch.clientY,
                startX: touch.clientX, startY: touch.clientY,
                target: el,
            };
            fingers.set(touch.identifier, state);
            el.style.background = 'rgba(140,80,230,0.55)';
            press(state, code);
        };
        const onMove = (_t: Touch, _s: FingerState) => { /* no-op */ };
        const onEnd = (state: FingerState) => {
            el.style.background = 'rgba(0,0,0,0.40)';
            releaseAll(state);
        };
        return { el, onStart, onMove, onEnd, key: code };
    }

    // ── System tray (top-right ☰ → pause / chat / voice / scoreboard) ────
    const sys = manifest.system!;
    const trayContainer = document.createElement('div');
    trayContainer.style.cssText = [
        'position:absolute',
        'right:max(20px, env(safe-area-inset-right))',
        'top:max(12px, env(safe-area-inset-top))',
        'pointer-events:auto',
        'display:flex',
        'gap:8px',
        'flex-direction:row-reverse',
        'align-items:flex-start',
    ].join(';');
    const trayToggle = document.createElement('div');
    trayToggle.textContent = '☰';
    trayToggle.style.cssText = [
        'width:42px', 'height:42px', 'border-radius:50%',
        'background:rgba(0,0,0,0.40)', 'border:1px solid rgba(255,255,255,0.20)',
        'color:white', 'font-size:18px', 'display:flex', 'align-items:center', 'justify-content:center',
        'touch-action:none', 'user-select:none',
    ].join(';');
    const trayItems = document.createElement('div');
    trayItems.style.cssText = 'display:none;flex-direction:row-reverse;gap:8px;';
    // System tray buttons are populated AFTER the helper functions are
    // declared (see "System tray buttons" below); we need handler tags
    // on the elements so widgetAt() can dispatch by hit-test.
    trayContainer.appendChild(trayToggle);
    trayContainer.appendChild(trayItems);
    root.appendChild(trayContainer);

    let trayOpen = false;
    trayToggle.addEventListener('touchstart', (e) => {
        e.preventDefault(); e.stopPropagation();
        trayOpen = !trayOpen;
        trayItems.style.display = trayOpen ? 'flex' : 'none';
    }, { passive: false });

    function buildSystemBtn(label: string, code: string, momentary?: boolean, hold?: boolean) {
        const el = document.createElement('div');
        el.style.cssText = [
            'min-width:64px', 'height:42px', 'padding:0 14px',
            'border-radius:21px',
            'background:rgba(0,0,0,0.40)', 'border:1px solid rgba(255,255,255,0.20)',
            'color:white', 'font-size:13px', 'font-weight:600',
            'display:flex', 'align-items:center', 'justify-content:center',
            'touch-action:none',
        ].join(';');
        el.textContent = label;
        const onStart = (touch: Touch) => {
            const state: FingerState = {
                widget: 'system', keys: new Set(),
                lastX: touch.clientX, lastY: touch.clientY,
                startX: touch.clientX, startY: touch.clientY,
                target: el,
            };
            fingers.set(touch.identifier, state);
            el.style.background = 'rgba(140,80,230,0.55)';
            press(state, code);
            if (momentary) {
                // Tap-and-release pause: release on next frame so the
                // FSM sees a press AND release (keyboard:pause emits on both).
                setTimeout(() => release(state, code), 50);
            }
        };
        const onMove = (_t: Touch, _s: FingerState) => { /* no-op */ };
        const onEnd = (state: FingerState) => {
            el.style.background = 'rgba(0,0,0,0.40)';
            if (hold) releaseAll(state);
            else if (!momentary) releaseAll(state);
            // momentary: already released on timer
        };
        return { el, onStart, onMove, onEnd, key: code };
    }

    // ── Viewport pass-through (taps that hit no overlay element) ──────────
    const viewport = manifest.viewport!;
    function viewportStart(touch: Touch) {
        if (viewport.tap === 'none') return;
        const rect = canvas.getBoundingClientRect();
        const cx = touch.clientX - rect.left;
        const cy = touch.clientY - rect.top;
        const state: FingerState = {
            widget: 'viewport', keys: new Set(),
            lastX: cx, lastY: cy,
            startX: cx, startY: cy,
        };
        fingers.set(touch.identifier, state);
        inputSystem.injectMouseMove(cx, cy, 0, 0);
        inputSystem.injectMouseButtonDown(0, cx, cy);
        state.keys.add('MouseLeft');
        state.mouseButton = 0;
    }
    function viewportMove(touch: Touch, state: FingerState) {
        if (viewport.tap !== 'drag') {
            // Track position even for click-mode so getMousePosition() stays current.
            const rect = canvas.getBoundingClientRect();
            const cx = touch.clientX - rect.left;
            const cy = touch.clientY - rect.top;
            inputSystem.injectMouseMove(cx, cy, 0, 0);
            state.lastX = cx; state.lastY = cy;
            return;
        }
        const rect = canvas.getBoundingClientRect();
        const cx = touch.clientX - rect.left;
        const cy = touch.clientY - rect.top;
        const dx = cx - state.lastX, dy = cy - state.lastY;
        state.lastX = cx; state.lastY = cy;
        inputSystem.injectMouseMove(cx, cy, dx, dy);
    }
    function viewportEnd(state: FingerState) {
        if (state.mouseButton !== undefined) {
            inputSystem.injectMouseButtonUp(state.mouseButton, state.lastX, state.lastY);
            state.keys.delete('MouseLeft');
        }
    }

    // ── Pinch zoom → wheel injection ─────────────────────────────────────
    let pinchActive = false;
    let pinchPrevDist = 0;
    function pinchStart(touches: TouchList) {
        if (manifest.scroll?.type !== 'pinch') return;
        if (touches.length < 2) return;
        if (pinchActive) return;
        const a = touches[0], b = touches[1];
        const dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
        pinchActive = true;
        pinchPrevDist = Math.sqrt(dx * dx + dy * dy);
    }
    function pinchMove(touches: TouchList) {
        if (!pinchActive || touches.length < 2) return;
        const a = touches[0], b = touches[1];
        const dx = a.clientX - b.clientX, dy = a.clientY - b.clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const delta = pinchPrevDist - dist;
        pinchPrevDist = dist;
        const sens = manifest.scroll?.sensitivity ?? 1.0;
        if (delta !== 0) inputSystem.injectWheel(0, delta * sens);
    }
    function pinchEnd(touches: TouchList) {
        if (touches.length < 2) {
            pinchActive = false;
            pinchPrevDist = 0;
        }
    }

    // ── Wire up DOM events ───────────────────────────────────────────────
    // We listen on `document` with capture: every touch in the window is
    // routed by hit-testing `document.elementFromPoint`. Why not per-element?
    // (a) The look pad and the action rail overlap geometrically — only one
    // element gets touchstart natively; we want the rail to win on its hit
    // box and the look pad to take everything else on the right. Manual
    // dispatch keeps that simple. (b) The viewport pass-through fallback
    // is naturally "anything not consumed".
    function widgetAt(x: number, y: number): {
        kind: FingerState['widget'];
        onStart: (t: Touch) => void;
        onMove: (t: Touch, s: FingerState) => void;
        onEnd: (s: FingerState) => void;
    } | null {
        // Order matters: action rail buttons sit on top of look pad on the right.
        for (const b of railButtons) {
            if (hit(b.el, x, y)) return { kind: 'action', onStart: b.onStart, onMove: b.onMove, onEnd: b.onEnd };
        }
        for (const b of hotbarBtns) {
            if (hit(b.el, x, y)) return { kind: 'hotbar', onStart: b.onStart, onMove: b.onMove, onEnd: b.onEnd };
        }
        // System tray
        if (hit(trayContainer, x, y)) {
            // Find which sub-button if any
            const items = trayItems.children;
            for (let i = 0; i < items.length; i++) {
                const el = items[i] as HTMLElement;
                if (hit(el, x, y)) {
                    const handlers = (el as any).__pp_handlers;
                    if (handlers) return { kind: 'system', onStart: handlers.onStart, onMove: handlers.onMove, onEnd: handlers.onEnd };
                }
            }
            // Tray toggle handles its own touchstart already; swallow.
            if (hit(trayToggle, x, y)) return null;
        }
        if (joystick && hit(joystick.el, x, y)) {
            return { kind: 'joystick', onStart: joystick.onStart, onMove: joystick.onMove, onEnd: joystick.onEnd };
        }
        // Look pad and the canvas-area viewport fallback are TRANSPARENT
        // pass-through zones. If a HUD iframe / HUD HTML element is
        // visually rendered at the touch point, it must receive the tap —
        // otherwise the user can see a HUD button but their touch goes
        // nowhere because the overlay claimed it. Use elementFromPoint
        // to identify what's actually under the finger; the look pad
        // itself has pointer-events:none so it's already see-through to
        // the browser's hit-test, and the viewport-fallback area is bare
        // canvas with the overlay root at pointer-events:none. We only
        // claim the touch as a look/viewport gesture when the topmost
        // element is the canvas itself.
        const topEl = document.elementFromPoint(x, y);
        const isCanvasTop = topEl === canvas;
        if (lookPad && hit(lookPad.el, x, y)) {
            if (!isCanvasTop) return null; // HUD iframe / element below — yield
            return { kind: 'look', onStart: lookPad.onStart, onMove: lookPad.onMove, onEnd: lookPad.onEnd };
        }
        if (hit(canvas, x, y)) {
            if (!isCanvasTop) return null; // HUD iframe / element on top of canvas — yield
            return {
                kind: 'viewport',
                onStart: viewportStart,
                onMove: viewportMove,
                onEnd: viewportEnd,
            };
        }
        return null;
    }

    // System tray buttons. Each gets `__pp_handlers` tagged on its element so
    // the touch dispatcher can route via hit-test.
    const buildSystemBtnTagged = (label: string, code: string, momentary?: boolean, hold?: boolean) => {
        const b = buildSystemBtn(label, code, momentary, hold);
        (b.el as any).__pp_handlers = { onStart: b.onStart, onMove: b.onMove, onEnd: b.onEnd };
        return b.el;
    };
    if (sys.pause)      trayItems.appendChild(buildSystemBtnTagged('Pause', sys.pause, true));
    if (sys.scoreboard) trayItems.appendChild(buildSystemBtnTagged('Score', sys.scoreboard, false, true));
    if (sys.voice)      trayItems.appendChild(buildSystemBtnTagged('Voice', sys.voice, false, true));
    if (sys.chat)       trayItems.appendChild(buildSystemBtnTagged('Chat', sys.chat, true));

    function hit(el: HTMLElement, x: number, y: number): boolean {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    // ── Touch listeners (capture so HUD iframes don't swallow first) ─────
    const onTouchStart = (e: TouchEvent) => {
        if (!isVisible()) return;
        let consumed = false;
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            const w = widgetAt(t.clientX, t.clientY);
            if (!w) continue;
            consumed = true;
            w.onStart(t);
        }
        // Pinch zoom check
        if (manifest.scroll?.type === 'pinch') pinchStart(e.touches);
        if (consumed) {
            try { e.preventDefault(); } catch { /* passive */ }
            e.stopPropagation();
        }
    };
    const onTouchMove = (e: TouchEvent) => {
        if (!isVisible()) return;
        let consumed = false;
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            const state = fingers.get(t.identifier);
            if (!state) continue;
            consumed = true;
            // Dispatch by widget
            switch (state.widget) {
                case 'joystick': if (joystick) joystick.onMove(t, state); break;
                case 'look': if (lookPad) lookPad.onMove(t, state); break;
                case 'action': /* no-op */ break;
                case 'hotbar': /* no-op */ break;
                case 'system': /* no-op */ break;
                case 'viewport': viewportMove(t, state); break;
            }
        }
        if (manifest.scroll?.type === 'pinch') pinchMove(e.touches);
        if (consumed) {
            try { e.preventDefault(); } catch { /* passive */ }
            e.stopPropagation();
        }
    };
    const onTouchEnd = (e: TouchEvent) => {
        if (!isVisible()) return;
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            const state = fingers.get(t.identifier);
            if (!state) continue;
            switch (state.widget) {
                case 'joystick': if (joystick) joystick.onEnd(state); break;
                case 'look': if (lookPad) lookPad.onEnd(state); break;
                case 'action': {
                    // Find which button by key
                    const btn = railButtons.find(b => b.key === [...state.keys][0]);
                    if (btn) btn.onEnd(state);
                    else releaseAll(state);
                    break;
                }
                case 'hotbar': {
                    const slot = hotbarBtns.find(b => b.key === [...state.keys][0]);
                    if (slot) slot.onEnd(state);
                    else releaseAll(state);
                    break;
                }
                case 'system': {
                    const handlers = state.target && (state.target as any).__pp_handlers;
                    if (handlers) handlers.onEnd(state);
                    else releaseAll(state);
                    break;
                }
                case 'viewport': viewportEnd(state); break;
            }
            fingers.delete(t.identifier);
        }
        if (manifest.scroll?.type === 'pinch') pinchEnd(e.touches);
    };
    const onTouchCancel = (e: TouchEvent) => {
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            const state = fingers.get(t.identifier);
            if (!state) continue;
            releaseAll(state);
            fingers.delete(t.identifier);
        }
    };

    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    document.addEventListener('touchcancel', onTouchCancel, { capture: true, passive: false });

    // Stuck-key safety: if focus leaves tab or page hides, release everything.
    const onVisibilityChange = () => {
        if (document.hidden) releaseAllFingers();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Auto-hide overlay when a real keyboard or gamepad is detected.
    const onPhysicalKey = (e: KeyboardEvent) => {
        // A real keydown that wasn't synthesized by us would mean the user
        // has a physical keyboard. Synthesized injections never go through
        // window 'keydown', so any event arriving here is genuinely real.
        // Fade out the overlay; user can re-enable from settings.
        if (!isVisible()) return;
        // Don't react to keys we know we never synthesized as DOM events
        // (we only inject into InputSystem). Belt-and-braces: ignore repeat.
        if (e.repeat) return;
        autoFadeOverlay();
    };
    window.addEventListener('keydown', onPhysicalKey, true);

    function autoFadeOverlay() {
        if (!isVisible()) return;
        enabled = false;
        root.style.display = 'none';
        releaseAllFingers();
        // Don't write to localStorage — this is a soft, session-only fade.
    }

    function releaseAllFingers() {
        for (const state of fingers.values()) releaseAll(state);
        fingers.clear();
    }

    // ── Settings panel toggle (existing #settings-panel hook) ─────────────
    let settingsRow: HTMLElement | null = null;
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsPanel) {
        settingsRow = document.createElement('div');
        settingsRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding-top:6px;';
        const label = document.createElement('div');
        label.textContent = 'Touch Controls';
        label.style.cssText = 'color:#ddd;font-size:12px;';
        const toggle = document.createElement('button');
        toggle.style.cssText = 'padding:4px 12px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:transparent;color:#aaa;font-size:12px;font-weight:500;cursor:pointer;';
        const updateToggleUI = () => {
            toggle.textContent = enabled ? 'On' : 'Off';
            toggle.style.background = enabled ? 'rgba(134,72,230,0.25)' : 'transparent';
            toggle.style.color = enabled ? '#c9a5f7' : '#aaa';
            root.style.display = isVisible() ? '' : 'none';
        };
        toggle.addEventListener('click', () => {
            enabled = !enabled;
            try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch { /* private mode */ }
            updateToggleUI();
            if (!isVisible()) releaseAllFingers();
        });
        updateToggleUI();
        settingsRow.appendChild(label);
        settingsRow.appendChild(toggle);
        settingsPanel.appendChild(settingsRow);
    }

    // ── Public handle ────────────────────────────────────────────────────
    return {
        destroy: () => {
            if (destroyed) return;
            destroyed = true;
            document.removeEventListener('touchstart', onTouchStart, { capture: true } as any);
            document.removeEventListener('touchmove', onTouchMove, { capture: true } as any);
            document.removeEventListener('touchend', onTouchEnd, { capture: true } as any);
            document.removeEventListener('touchcancel', onTouchCancel, { capture: true } as any);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('keydown', onPhysicalKey, true);
            releaseAllFingers();
            try { root.remove(); } catch { /* swallow */ }
            if (settingsRow) try { settingsRow.remove(); } catch { /* swallow */ }
        },
        setEnabled: (e) => {
            enabled = e;
            root.style.display = isVisible() ? '' : 'none';
            try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch { /* swallow */ }
            if (!isVisible()) releaseAllFingers();
        },
        isEnabled: () => enabled,
        setSuspended: (s, reason) => {
            const key = reason || 'default';
            if (s) suspendedReasons.add(key);
            else suspendedReasons.delete(key);
            root.style.display = isVisible() ? '' : 'none';
            if (!isVisible()) releaseAllFingers();
        },
    };
}

function noopOverlay(): MobileInputOverlay {
    return {
        destroy: () => { /* no-op */ },
        setEnabled: () => { /* no-op */ },
        isEnabled: () => false,
        setSuspended: () => { /* no-op */ },
    };
}

function readEnabled(): boolean {
    try { return localStorage.getItem(STORAGE_KEY) !== 'false'; } catch { return true; }
}

function movementKeyMap(type: string): { up?: string; down?: string; left?: string; right?: string } {
    // The joystick presses ONE key per cardinal. For wasd+arrows we prefer
    // WASD because behaviors that read "WASD || Arrow*" still fire, while
    // behaviors that only read WASD don't break. Arrow-only games declare
    // type:"arrows" explicitly.
    switch (type) {
        case 'wasd':
        case 'wasd+arrows':
            return { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' };
        case 'arrows':
            return { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
        case 'horizontal':
            return { left: 'KeyA', right: 'KeyD' };
        default:
            return {};
    }
}

function expandHotbarRange(from: string, to: string): string[] {
    const m1 = /^(Digit|F)(\d+)$/.exec(from);
    const m2 = /^(Digit|F)(\d+)$/.exec(to);
    if (!m1 || !m2 || m1[1] !== m2[1]) return [from, to];
    const out: string[] = [];
    const s = parseInt(m1[2], 10);
    const e = parseInt(m2[2], 10);
    for (let i = s; i <= e; i++) out.push(`${m1[1]}${i}`);
    return out;
}

function labelFromHotbarCode(code: string): string {
    const m = /^Digit(\d+)$/.exec(code);
    if (m) return m[1];
    const f = /^F(\d+)$/.exec(code);
    if (f) return `F${f[1]}`;
    return '';
}
