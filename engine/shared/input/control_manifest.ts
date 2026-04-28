/**
 * control_manifest.ts — declarative input bindings for mobile control overlay.
 *
 * Lives in `01_flow.json` under `controls`. The mobile overlay (rendered in
 * the browser) builds its on-screen joystick + buttons from this manifest;
 * scripts on both desktop and mobile keep polling raw key codes, because
 * the overlay injects the *same* key codes into the InputSystem that a
 * physical keyboard would. The result: every script written against
 * `isKeyDown("KeyW")` works unchanged on touch.
 *
 * The manifest is engine-agnostic; it's parsed in shared so both the
 * browser runtime and the headless playtest can interpret the same data.
 */
export type KeyCode = string;
export type MouseToken = 'MouseLeft' | 'MouseMiddle' | 'MouseRight';

/** Codes the engine reserves; never bind these to gameplay actions. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
    'KeyP',     // pause
    'KeyV',     // voice mute
    'Enter',    // chat open / send
    'Escape',   // browser pointer-lock release
]);

/** Top-level archetype hint. The overlay seeds defaults from this when fields are absent. */
export type ControlPreset =
    | 'fps'
    | 'tps'
    | 'topdown'
    | 'platformer'
    | 'sidescroller'
    | 'racer'
    | 'flight'
    | 'rts'
    | 'click'
    | 'custom';

/** Movement scheme: which keys move the player and what hold-modifiers exist. */
export interface MovementBlock {
    /** Discrete key set the joystick is wired to. */
    type: 'wasd' | 'arrows' | 'wasd+arrows' | 'horizontal' | 'none';
    /** Optional auxiliary keys — exposed as on-screen action buttons. */
    sprint?: KeyCode;
    crouch?: KeyCode;
    jump?: KeyCode;
}

/** Mouse-look / camera-rotation pad configuration. */
export interface LookBlock {
    /**
     *   mouseDelta — drag injects mouseDeltaX/Y (FPS / TPS / mouse-look games)
     *   tapToFace  — single tap on viewport faces the tap location (RTS-ish)
     *   none       — game has no camera-look input
     */
    type: 'mouseDelta' | 'tapToFace' | 'none';
    sensitivity?: number;
    /** Reserved for future opt-in DeviceMotion gyro support; default false. */
    gyro?: boolean;
}

/** Primary fire / aim mouse buttons. The overlay builds a Fire button for primary. */
export interface FireBlock {
    primary?: MouseToken | KeyCode;
    secondary?: MouseToken | KeyCode;
    label?: string;
    secondaryLabel?: string;
    /** True = button stays "down" while held; false = momentary tap. */
    holdPrimary?: boolean;
    holdSecondary?: boolean;
}

/** A single on-screen action button. */
export interface ActionBinding {
    key: KeyCode | MouseToken;
    label: string;
    /** Optional 1-2 char glyph for the button face when the label is long. */
    icon?: string;
    /** True = key stays down while finger is on the button. False = tap-to-fire. */
    hold?: boolean;
    /** True = a tap toggles the key state on/off (sticks down). Rare. */
    toggle?: boolean;
}

/** Number-row hotbar (inventory slots / abilities). Renders as a top strip. */
export interface HotbarBlock {
    /** Inclusive range, e.g. Digit1..Digit9. */
    from: KeyCode;
    to: KeyCode;
    /** Optional per-slot labels in order. Pad with empty strings. */
    labels?: string[];
}

/** Pinch-to-scroll, etc. */
export interface ScrollBlock {
    type: 'pinch' | 'twoFinger' | 'none';
    /** Multiplier on raw delta. */
    sensitivity?: number;
}

/** How raw viewport touches (outside any overlay control) translate to mouse. */
export interface ViewportBlock {
    /**
     *   click — touchstart→mousedown(0), touchend→mouseup(0) at canvas-relative coords
     *   drag  — same as click but ongoing touchmove also injects mousemove (for drag-aim)
     *   none  — viewport touches do nothing on their own
     */
    tap: 'click' | 'drag' | 'none';
}

/** Engine-reserved keys are routed through here — the overlay shows them in a system tray. */
export interface SystemBlock {
    pause?: KeyCode;
    chat?: KeyCode;
    voice?: KeyCode;
    scoreboard?: KeyCode;
}

/** Full controls manifest. All sub-blocks are optional; preset fills defaults. */
export interface ControlManifest {
    preset?: ControlPreset;
    movement?: MovementBlock;
    look?: LookBlock;
    fire?: FireBlock;
    actions?: ActionBinding[];
    hotbar?: HotbarBlock;
    scroll?: ScrollBlock;
    viewport?: ViewportBlock;
    system?: SystemBlock;
}

/** Default `system` block — every game reserves the same keys, so seed unconditionally. */
export const DEFAULT_SYSTEM: Required<SystemBlock> = {
    pause: 'KeyP',
    chat: 'Enter',
    voice: 'KeyV',
    scoreboard: 'Tab',
};

/** Per-preset baseline. Specific manifest fields override these. */
const PRESET_DEFAULTS: Record<ControlPreset, ControlManifest> = {
    fps: {
        movement: { type: 'wasd', sprint: 'ShiftLeft', jump: 'Space', crouch: 'ControlLeft' },
        look: { type: 'mouseDelta', sensitivity: 1.0, gyro: false },
        fire: { primary: 'MouseLeft', secondary: 'MouseRight', label: 'Fire', secondaryLabel: 'Aim', holdPrimary: true, holdSecondary: true },
        viewport: { tap: 'none' },
        scroll: { type: 'none' },
    },
    tps: {
        movement: { type: 'wasd', sprint: 'ShiftLeft', jump: 'Space' },
        look: { type: 'mouseDelta', sensitivity: 1.0 },
        fire: { primary: 'MouseLeft', label: 'Fire', holdPrimary: true },
        viewport: { tap: 'none' },
        scroll: { type: 'none' },
    },
    topdown: {
        movement: { type: 'wasd+arrows' },
        look: { type: 'none' },
        fire: { primary: 'MouseLeft', label: 'Fire', holdPrimary: true },
        viewport: { tap: 'click' },
        scroll: { type: 'none' },
    },
    platformer: {
        movement: { type: 'wasd+arrows', jump: 'Space' },
        look: { type: 'none' },
        viewport: { tap: 'click' },
        scroll: { type: 'none' },
    },
    sidescroller: {
        movement: { type: 'horizontal', jump: 'Space' },
        look: { type: 'none' },
        viewport: { tap: 'click' },
        scroll: { type: 'none' },
    },
    racer: {
        movement: { type: 'wasd+arrows' },
        look: { type: 'none' },
        viewport: { tap: 'none' },
        scroll: { type: 'none' },
    },
    flight: {
        movement: { type: 'wasd' },
        look: { type: 'mouseDelta', sensitivity: 0.8 },
        fire: { primary: 'MouseLeft', label: 'Fire', holdPrimary: true },
        viewport: { tap: 'none' },
        scroll: { type: 'none' },
    },
    rts: {
        movement: { type: 'wasd+arrows' },
        look: { type: 'none' },
        fire: { primary: 'MouseLeft', secondary: 'MouseRight', label: 'Select', secondaryLabel: 'Order' },
        viewport: { tap: 'click' },
        scroll: { type: 'pinch', sensitivity: 1.0 },
    },
    click: {
        movement: { type: 'none' },
        look: { type: 'none' },
        fire: { primary: 'MouseLeft', secondary: 'MouseRight', label: 'Click' },
        viewport: { tap: 'click' },
        scroll: { type: 'none' },
    },
    custom: {
        movement: { type: 'none' },
        look: { type: 'none' },
        viewport: { tap: 'click' },
        scroll: { type: 'none' },
    },
};

/**
 * Resolve a partially-specified manifest to a fully-populated one by layering
 * preset defaults under user-supplied fields, then layering DEFAULT_SYSTEM
 * under any user-supplied system block.
 *
 * Reserved keys are stripped from `actions[]` (they belong in `system`); a
 * console warning fires for each one removed.
 */
export function resolveManifest(raw: ControlManifest | null | undefined): ControlManifest {
    const m: ControlManifest = raw ? deepClone(raw) : {};
    const preset: ControlPreset = m.preset && PRESET_DEFAULTS[m.preset] ? m.preset : 'custom';
    const base = PRESET_DEFAULTS[preset];

    const out: ControlManifest = {
        preset,
        movement: { ...(base.movement || {}), ...(m.movement || {}) } as MovementBlock,
        look: { ...(base.look || {}), ...(m.look || {}) } as LookBlock,
        fire: m.fire || base.fire,
        actions: filterReservedActions(m.actions || []),
        hotbar: m.hotbar,
        scroll: { ...(base.scroll || { type: 'none' }), ...(m.scroll || {}) } as ScrollBlock,
        viewport: { ...(base.viewport || { tap: 'click' }), ...(m.viewport || {}) } as ViewportBlock,
        system: { ...DEFAULT_SYSTEM, ...(m.system || {}) } as SystemBlock,
    };
    return out;
}

function filterReservedActions(actions: ActionBinding[]): ActionBinding[] {
    const out: ActionBinding[] = [];
    for (const a of actions) {
        if (RESERVED_KEYS.has(a.key)) {
            try { console.warn(`[controls] dropping reserved key "${a.key}" from actions[] — route through controls.system instead`); } catch { /* swallow */ }
            continue;
        }
        out.push(a);
    }
    return out;
}

function deepClone<T>(o: T): T { return JSON.parse(JSON.stringify(o)); }

/**
 * Walk every binding and return the set of distinct key codes the manifest
 * binds. Used by the headless `mobile_controls_complete` invariant.
 */
export function manifestBoundKeys(m: ControlManifest): Set<string> {
    const keys = new Set<string>();
    const mv = m.movement;
    if (mv && mv.type !== 'none') {
        if (mv.type === 'wasd' || mv.type === 'wasd+arrows') ['KeyW', 'KeyA', 'KeyS', 'KeyD'].forEach(k => keys.add(k));
        if (mv.type === 'arrows' || mv.type === 'wasd+arrows') ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].forEach(k => keys.add(k));
        if (mv.type === 'horizontal') ['KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight'].forEach(k => keys.add(k));
        if (mv.sprint) keys.add(mv.sprint);
        if (mv.crouch) keys.add(mv.crouch);
        if (mv.jump) keys.add(mv.jump);
    }
    if (m.fire?.primary) keys.add(m.fire.primary);
    if (m.fire?.secondary) keys.add(m.fire.secondary);
    for (const a of m.actions || []) keys.add(a.key);
    const hb = m.hotbar;
    if (hb) {
        // Expand inclusive Digit/F1 range
        const expand = (from: string, to: string): string[] => {
            const m1 = /^(Digit|F)(\d+)$/.exec(from);
            const m2 = /^(Digit|F)(\d+)$/.exec(to);
            if (m1 && m2 && m1[1] === m2[1]) {
                const out: string[] = [];
                const s = parseInt(m1[2], 10);
                const e = parseInt(m2[2], 10);
                for (let i = s; i <= e; i++) out.push(`${m1[1]}${i}`);
                return out;
            }
            return [from, to];
        };
        for (const k of expand(hb.from, hb.to)) keys.add(k);
    }
    const s = m.system;
    if (s) {
        for (const k of [s.pause, s.chat, s.voice, s.scoreboard]) {
            if (k) keys.add(k);
        }
    }
    return keys;
}
