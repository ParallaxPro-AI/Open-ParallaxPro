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
/**
 * Mobile-touch look multiplier applied on top of the manifest's
 * `look.sensitivity` (which is calibrated to desktop mouse). A 100px
 * touch sweep on a phone is a significant finger gesture but produces
 * only the same raw mouseDelta a 100px mouse flick would; cameras then
 * scale that by their own ~0.15 sensitivity, giving ~15° per finger
 * sweep — far too little to look around comfortably. Multiplying touch
 * deltas by ~3 lifts that to ~45° per 100px sweep, which feels right.
 * Per-game manifests can still tune up or down via look.sensitivity.
 */
const MOBILE_TOUCH_LOOK_MULTIPLIER = 3.0;

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
 * Two changes from the previous implementation, both prompted by user
 * reports of "controls don't pop up until I refresh":
 *
 *   1. Multi-source touch detection. `'ontouchstart' in window` alone is
 *      unreliable in some hybrid browser contexts (in-app webviews,
 *      certain Android browsers on cold boot). Including
 *      `navigator.maxTouchPoints > 0` covers the gap.
 *
 *   2. No more `window.innerWidth < 1024` gate. That width is captured
 *      ONCE at attach time. On a slow iframe layout (CSS still settling,
 *      iOS Safari address-bar collapse animations, parent React
 *      hydration races) it can momentarily report a stale wider value,
 *      the overlay never attaches, and the only fix is a refresh — which
 *      is exactly the bug reported. Use a CSS pointer-coarse query
 *      instead — it identifies devices whose PRIMARY input is a finger,
 *      which is robust across screen sizes (phones + tablets without
 *      keyboard) and excludes desktops-with-touchscreens (primary is
 *      mouse, coarse is false).
 *
 * iPad-Pro-with-keyboard still shows the overlay; the auto-fade on
 * first physical KeyboardEvent (already in this file) hides it once
 * the user starts typing.
 */
export function shouldShowMobileOverlay(): boolean {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    const hasTouch = ('ontouchstart' in window) || ((navigator as any)?.maxTouchPoints ?? 0) > 0;
    if (!hasTouch) return false;
    // matchMedia is always present in modern browsers; defensive default
    // is `true` so we don't accidentally exclude touch devices on
    // browsers that lack the API.
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? true;
    return coarse;
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

    /**
     * Two-tier visibility:
     *   - controlsVisible: joystick / look pad / action rail / hotbar.
     *     Hidden by ANY suspension reason (edit-mode pause, AI chat
     *     sheet open over the viewport).
     *   - trayVisible: the system tray (☰ pause / voice / chat / score).
     *     Hidden ONLY by edit-mode. Stays visible while the AI chat
     *     sheet is open so players can still pause / mute / open the
     *     in-game text chat without dismissing the assistant.
     *
     * The user's localStorage `enabled` toggle disables the entire
     * overlay regardless of either tier.
     */
    const TRAY_HIDING_REASONS: ReadonlySet<string> = new Set(['editor-mode']);
    const isControlsVisible = () => enabled && suspendedReasons.size === 0;
    const isTrayVisible = () => {
        if (!enabled) return false;
        for (const r of suspendedReasons) if (TRAY_HIDING_REASONS.has(r)) return false;
        return true;
    };
    const isVisible = () => isControlsVisible() || isTrayVisible();

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
        const sens = (look.sensitivity ?? LOOK_PAD_BASE_SENS) * MOBILE_TOUCH_LOOK_MULTIPLIER;
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

    // ── Action rail (bottom-right thumb cluster) ─────────────────────────
    //
    // Each button is absolute-positioned for a non-linear "controller"
    // layout instead of a column-reverse stack that just turns into a
    // tall vertical strip.
    //
    //                                      [Crouch]
    //                                [Aim]           [Jump]
    //   [a3]  [a4]                                 [Fire]
    //   [a1]  [a2]
    //
    // Primary buttons (Fire/Jump/Aim/Crouch) are placed at fixed offsets
    // relative to the bottom-right corner so the largest button (Fire)
    // sits where the right thumb rests, and the others fan up-and-left.
    //
    // Secondary buttons (manifest.actions[]) form a 2-column grid to the
    // left of the primary cluster, growing upward — so 6 actions become
    // a 2×3 block, not a 6-tall column.
    const railContainer = document.createElement('div');
    railContainer.style.cssText = [
        'position:absolute',
        'right:env(safe-area-inset-right, 12px)',
        'bottom:env(safe-area-inset-bottom, 12px)',
        'pointer-events:none',
    ].join(';');
    root.appendChild(railContainer);

    const railButtons: ReturnType<typeof buildButton>[] = [];
    const fire = manifest.fire;

    // Primary cluster offsets, hand-tuned for thumb reach. Coordinates
    // are (right, bottom) px from the cluster's bottom-right corner.
    //   Fire    bottom-right anchor (84×84)
    //   Jump    above Fire, slightly indented left (12 px)
    //   Aim     left of Fire, raised 8 px (visual offset from Fire's bottom)
    //   Crouch  above Aim, between Jump and Aim diagonally
    const placeAt = (b: ReturnType<typeof buildButton>, right: number, bottom: number) => {
        b.el.style.position = 'absolute';
        b.el.style.right = right + 'px';
        b.el.style.bottom = bottom + 'px';
        railContainer.appendChild(b.el);
        railButtons.push(b);
    };
    if (fire?.primary) {
        const b = buildButton({
            key: fire.primary, label: fire.label || 'Fire', size: 84, accent: true,
            hold: fire.holdPrimary !== false,
        });
        placeAt(b, 0, 0);
    }
    if (movement.jump) {
        const b = buildButton({ key: movement.jump, label: 'Jump', size: 72 });
        placeAt(b, 12, 96);
    }
    if (fire?.secondary) {
        const b = buildButton({
            key: fire.secondary, label: fire.secondaryLabel || 'Aim', size: 64,
            hold: fire.holdSecondary !== false,
        });
        placeAt(b, 94, 14);
    }
    if (movement.crouch) {
        const b = buildButton({ key: movement.crouch, label: 'Crouch', size: 56, hold: true });
        placeAt(b, 102, 90);
    }

    // Secondary grid (2 columns × N rows, growing up). Anchored to the
    // left of the primary cluster.
    const SECONDARY_SIZE = 56;
    const SECONDARY_GAP = 8;
    const PRIMARY_CLUSTER_WIDTH = ((fire?.secondary || movement.crouch) ? 158 : 84);
    const SECONDARY_OFFSET = PRIMARY_CLUSTER_WIDTH + 12;
    const actions = manifest.actions || [];
    actions.forEach((action, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const right = SECONDARY_OFFSET + col * (SECONDARY_SIZE + SECONDARY_GAP);
        const bottom = row * (SECONDARY_SIZE + SECONDARY_GAP);
        const b = buildButton({
            key: action.key, label: action.label, size: SECONDARY_SIZE,
            hold: !!action.hold, toggle: !!action.toggle,
        });
        placeAt(b, right, bottom);
    });

    function buildButton(cfg: {
        key: string; label: string; size: number; accent?: boolean; hold?: boolean; toggle?: boolean;
    }) {
        const el = document.createElement('div');
        const iconKey = pickIconForBinding(cfg.key, cfg.label);
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
        if (iconKey) {
            // Icon-only button. Inner SVG is sized as a fraction of the
            // button so it scales with cfg.size automatically.
            const inner = Math.floor(cfg.size * 0.5);
            el.innerHTML = renderIconSvg(iconKey, inner);
        } else {
            el.textContent = cfg.label;
        }
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
    let hotbarContainer: HTMLElement | null = null;
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
        hotbarContainer = hotbar;
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
    //
    // The toggle and the menu items are positioned independently against
    // the overlay root: toggle anchored top-right, items anchored
    // top-right with an extra rightward inset of (toggle-width + gap).
    // This keeps the hamburger from moving when the menu opens, and lets
    // the menu grow leftward without ever wrapping to a new line. (The
    // earlier flex-row-reverse parent caused the toggle to reflow as
    // soon as siblings appeared, and on narrower viewports the row
    // could wrap.)
    const sys = manifest.system!;
    const TRAY_TOGGLE_SIZE = 42;
    const TRAY_GAP = 8;
    const trayContainer = document.createElement('div');
    // Sized to wrap both the absolutely-positioned toggle and items, so
    // hit-tests against `trayContainer` continue to fire correctly via
    // its bounding rect (which expands when items are visible).
    trayContainer.style.cssText = [
        'position:absolute',
        'right:env(safe-area-inset-right, 6px)',
        'top:env(safe-area-inset-top, 6px)',
        'width:0',
        'height:0',
        'pointer-events:none', // children opt back in
        'z-index:1',
    ].join(';');
    const trayToggle = document.createElement('div');
    trayToggle.textContent = '☰';
    trayToggle.style.cssText = [
        'position:absolute',
        'top:0',
        'right:0',
        `width:${TRAY_TOGGLE_SIZE}px`,
        `height:${TRAY_TOGGLE_SIZE}px`,
        'border-radius:50%',
        'background:rgba(0,0,0,0.40)',
        'border:1px solid rgba(255,255,255,0.20)',
        'color:white', 'font-size:18px',
        'display:flex', 'align-items:center', 'justify-content:center',
        'pointer-events:auto',
        'touch-action:none', 'user-select:none',
    ].join(';');
    const trayItems = document.createElement('div');
    // Anchored to the LEFT of the toggle: right edge = toggle.right + toggle.width + gap.
    // flex-direction:row-reverse so appendChild order matches visual right-to-left order.
    trayItems.style.cssText = [
        'position:absolute',
        'top:0',
        `right:${TRAY_TOGGLE_SIZE + TRAY_GAP}px`,
        'display:none',
        'flex-direction:row-reverse',
        'gap:8px',
        'pointer-events:auto',
        'white-space:nowrap',
    ].join(';');
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
        // System tray. Toggle has its own touchstart listener that opens
        // the menu; widgetAt returns null for it so the document handler
        // doesn't preventDefault. Menu-item hit-tests run against
        // `trayItems`'s rect — when the tray is closed, trayItems is
        // display:none → getBoundingClientRect returns zeros → hit()
        // is false → the loop is skipped automatically.
        if (hit(trayToggle, x, y)) return null;
        if (hit(trayItems, x, y)) {
            const items = trayItems.children;
            for (let i = 0; i < items.length; i++) {
                const el = items[i] as HTMLElement;
                if (hit(el, x, y)) {
                    const handlers = (el as any).__pp_handlers;
                    if (handlers) return { kind: 'system', onStart: handlers.onStart, onMove: handlers.onMove, onEnd: handlers.onEnd };
                }
            }
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
    // tray flex-direction is row-reverse, so the FIRST appendChild is the
    // rightmost visual position. The user wants the "Hide Controls" toggle
    // at the rightmost end of the menu (closest to the hamburger).
    const hideBtn = buildHideControlsBtnTagged();
    trayItems.appendChild(hideBtn);
    if (sys.pause) trayItems.appendChild(buildSystemBtnTagged('Pause', sys.pause, true));
    if (sys.voice) trayItems.appendChild(buildSystemBtnTagged('Voice', sys.voice, false, true));
    if (sys.chat)  trayItems.appendChild(buildSystemBtnTagged('Chat', sys.chat, true));

    /**
     * "Hide Controls" toggle button. Suspends the gameplay-controls
     * tier (joystick / look pad / action rail / hotbar) using the
     * 'manual-hide' reason key, which isn't in TRAY_HIDING_REASONS so
     * the system tray itself stays visible — meaning the user can
     * always reach this button to toggle them back on. Useful when the
     * controls are visually covering an in-game UI element.
     */
    function buildHideControlsBtnTagged(): HTMLElement {
        const el = document.createElement('div');
        const baseBg = 'rgba(0,0,0,0.40)';
        const activeBg = 'rgba(140,80,230,0.55)';
        el.style.cssText = [
            'min-width:64px', 'height:42px', 'padding:0 14px',
            'border-radius:21px',
            `background:${baseBg}`, 'border:1px solid rgba(255,255,255,0.20)',
            'color:white', 'font-size:13px', 'font-weight:600',
            'display:flex', 'align-items:center', 'justify-content:center',
            'touch-action:none', 'white-space:nowrap',
        ].join(';');
        let hidden = false;
        const updateLabel = () => { el.textContent = hidden ? 'Show Controls' : 'Hide Controls'; };
        updateLabel();
        const onStart = (touch: Touch) => {
            const state: FingerState = {
                widget: 'system', keys: new Set(),
                lastX: touch.clientX, lastY: touch.clientY,
                startX: touch.clientX, startY: touch.clientY,
                target: el,
            };
            fingers.set(touch.identifier, state);
            el.style.background = activeBg;
            hidden = !hidden;
            if (hidden) suspendedReasons.add('manual-hide');
            else suspendedReasons.delete('manual-hide');
            applyVisibility();
            updateLabel();
        };
        const onMove = (_t: Touch, _s: FingerState) => { /* no-op */ };
        const onEnd = (_state: FingerState) => {
            el.style.background = baseBg;
            // No keys to release — this button doesn't synthesize input.
        };
        (el as any).__pp_handlers = { onStart, onMove, onEnd };
        return el;
    }

    function hit(el: HTMLElement, x: number, y: number): boolean {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    /**
     * Find an interactive element inside any visible HUD iframe at the
     * touch point. Used to synthesize clicks on HUD buttons that are
     * stuck `pointer-events:none` on mobile — the desktop code path that
     * flips them to `auto` runs from `mousemove`, which never fires on
     * touch devices, leaving HUD buttons unreachable. We manually
     * dispatch the click instead. Cross-origin iframes are skipped
     * because their contentDocument is inaccessible.
     */
    const findInteractiveHudElement = (x: number, y: number): HTMLElement | null => {
        const iframes = document.getElementsByTagName('iframe');
        const INTERACTIVE = 'button, input, select, a, [data-interactive], [onclick]';
        for (let i = 0; i < iframes.length; i++) {
            const frame = iframes[i] as HTMLIFrameElement;
            if (frame.style.display === 'none') continue;
            const rect = frame.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
            try {
                const iDoc = frame.contentDocument;
                if (!iDoc) continue;
                const inner = iDoc.elementFromPoint(x - rect.left, y - rect.top);
                if (!inner) continue;
                const interactive = (inner as Element).closest?.(INTERACTIVE) as HTMLElement | null;
                if (interactive) return interactive;
            } catch { /* cross-origin or sandboxed — skip */ }
        }
        return null;
    };

    // ── Touch listeners (capture so HUD iframes don't swallow first) ─────
    const onTouchStart = (e: TouchEvent) => {
        if (!isVisible()) return;
        let consumed = false;
        for (let i = 0; i < e.changedTouches.length; i++) {
            const t = e.changedTouches[i];
            // HUD iframe button takes precedence over any overlay widget
            // or viewport-tap claim. Synthesize the click ourselves
            // because the iframe can't receive the touch directly under
            // its default pointer-events:none.
            const hudEl = findInteractiveHudElement(t.clientX, t.clientY);
            if (hudEl) {
                try { hudEl.click(); } catch { /* swallow */ }
                consumed = true;
                continue;
            }
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
        applyVisibility();
        // Don't write to localStorage — this is a soft, session-only fade.
    }

    function releaseAllFingers() {
        for (const state of fingers.values()) releaseAll(state);
        fingers.clear();
    }

    // ── Settings panel toggle (existing #settings-panel hook) ─────────────
    //
    // Only added for legacy / non-mobile-ready games (no gameplay
    // widgets to suspend). Mobile-ready games already expose the same
    // toggle via the hamburger system tray's "Hide Controls" button —
    // duplicating it in the graphics-quality dropdown clutters the UX.
    let settingsRow: HTMLElement | null = null;
    const settingsPanel = document.getElementById('settings-panel');
    const hasGameplayWidgets =
        (manifest.movement?.type && manifest.movement.type !== 'none') ||
        manifest.look?.type === 'mouseDelta' ||
        !!manifest.fire?.primary ||
        (manifest.actions?.length ?? 0) > 0 ||
        !!manifest.hotbar;
    if (settingsPanel && !hasGameplayWidgets) {
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
            applyVisibility();
        };
        toggle.addEventListener('click', () => {
            enabled = !enabled;
            try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch { /* private mode */ }
            updateToggleUI();
            if (!isControlsVisible()) releaseAllFingers();
        });
        updateToggleUI();
        settingsRow.appendChild(label);
        settingsRow.appendChild(toggle);
        settingsPanel.appendChild(settingsRow);
    }

    // ── Visibility application ────────────────────────────────────────────
    // Apply controls vs tray visibility independently. Root stays mounted
    // and pointer-events:none, just toggling per-child display so the
    // tray can stay visible while the gameplay controls hide.
    function applyVisibility(): void {
        const showControls = isControlsVisible();
        const showTray = isTrayVisible();
        // Root: present iff anything inside should show. Hidden entirely
        // when the user has toggled the overlay off and we're in editor-mode.
        root.style.display = (showControls || showTray) ? '' : 'none';
        if (joystick) joystick.el.style.display = showControls ? '' : 'none';
        if (lookPad) lookPad.el.style.display = showControls ? '' : 'none';
        railContainer.style.display = showControls ? '' : 'none';
        if (hotbarContainer) hotbarContainer.style.display = showControls ? '' : 'none';
        trayContainer.style.display = showTray ? '' : 'none';
        // If gameplay controls just hid, drop any held keys they had
        // synthesized. Tray buttons handle their own teardown on touchend.
        if (!showControls) releaseAllFingers();
    }
    applyVisibility();

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
            try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch { /* swallow */ }
            applyVisibility();
        },
        isEnabled: () => enabled,
        setSuspended: (s, reason) => {
            const key = reason || 'default';
            if (s) suspendedReasons.add(key);
            else suspendedReasons.delete(key);
            applyVisibility();
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

// ─── Icon system ───────────────────────────────────────────────────────
//
// Inline Lucide-style SVGs for the most universal action-rail bindings.
// The shared module can't import editor icons, so the paths are embedded
// here as small strings. Stroke-based monochrome glyphs scale cleanly
// from the ~28px (small action) to ~50px (large fire) range.

/** Path-only inner SVG body — wrapped by renderIconSvg() with the outer <svg>. */
const ICON_PATHS: Record<string, string> = {
    target:       '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
    eye:          '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    chevronsUp:   '<polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>',
    chevronsDown: '<polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/>',
    zap:          '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    rotateCw:     '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    refresh:      '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    plus:         '<line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/>',
    minus:        '<line x1="5" x2="19" y1="12" y2="12"/>',
    sparkles:     '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
    map:          '<polygon points="3 6 9 4 15 6 21 4 21 18 15 20 9 18 3 20 3 6"/><line x1="9" x2="9" y1="4" y2="18"/><line x1="15" x2="15" y1="6" y2="20"/>',
    box:          '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" x2="12" y1="22.08" y2="12"/>',
    arrowDown:    '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
    arrowUp:      '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
    hand:         '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    pause:        '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
    square:       '<rect x="4" y="4" width="16" height="16" rx="2"/>',
    shield:       '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    crosshair:    '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>',
};

function renderIconSvg(name: string, size: number): string {
    const body = ICON_PATHS[name];
    if (!body) return '';
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}" style="pointer-events:none">${body}</svg>`;
}

/**
 * Pick an icon for a key + label combo. Returns the icon name to look
 * up in ICON_PATHS, or null when no good match is found (in which case
 * the button falls back to its text label).
 *
 * Strategy: key-code matches first (universal mappings — Space=jump
 * regardless of label), then label keyword matches (game-specific
 * labels like "Reload" / "Boost"), then null.
 */
function pickIconForBinding(key: string, label: string): string | null {
    if (key === 'MouseLeft') return 'target';
    if (key === 'MouseRight') return 'eye';
    if (key === 'Space') return 'chevronsUp';
    if (key === 'ControlLeft' || key === 'ControlRight') return 'chevronsDown';
    if (key === 'ShiftLeft' || key === 'ShiftRight') return 'zap';
    if (key === 'Tab') return 'box';

    const l = (label || '').toLowerCase().trim();
    if (!l) return null;
    if (/^(fire|shoot|attack|hit|cannon|tap)/.test(l)) return 'target';
    if (/^(aim|look|scope)/.test(l)) return 'eye';
    if (/^(jump|hop|leap|bounce)/.test(l)) return 'chevronsUp';
    if (/^(crouch|duck|down)/.test(l)) return 'chevronsDown';
    if (/^(sprint|run|dash|drift|boost|brake)/.test(l)) return 'zap';
    if (/^(reload)/.test(l)) return 'rotateCw';
    if (/^(switch|cycle|next|change|swap|rotate)/.test(l)) return 'refresh';
    if (/^(use|grab|interact|enter|pick|kick|action|press)/.test(l)) return 'hand';
    if (/^(drop|throw|toss)/.test(l)) return 'arrowDown';
    if (/^(heal|repair|add|cancel)/.test(l)) return 'plus';
    if (/^(map)/.test(l)) return 'map';
    if (/^(item|powerup|skill|ability|special|magic|spell|q|e|skill 1|skill 2)/.test(l)) return 'sparkles';
    if (/^(inventory|menu|wave|item)/.test(l)) return 'box';
    if (/^(reduce|remove|−|-)/.test(l)) return 'minus';
    if (/^(pause)/.test(l)) return 'pause';
    if (/^(select|target)/.test(l)) return 'crosshair';
    if (/^(block|defend|guard|shield)/.test(l)) return 'shield';
    if (/^(plant|place|build|put)/.test(l)) return 'plus';
    if (/^(mine|dig)/.test(l)) return 'target';

    return null;
}
