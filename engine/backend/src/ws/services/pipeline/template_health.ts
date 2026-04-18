/**
 * template_health.ts — boot-time quality check for every shipped template.
 *
 * Two stages per template:
 *
 *   1. Assemble — `assembleGame(folder)` runs the structural validator (UI
 *      button wiring, event-def names, active_behaviors/active_systems
 *      referential integrity, etc). Catches the silent-killer class.
 *
 *   2. Script smoke — every behavior/system/script file under the template
 *      is wrapped in `new Function(…)` against a stub GameScript and
 *      exercised for ~1 second of simulated frames (onStart + 60 onUpdate
 *      ticks). Catches runtime errors the static assembler can't see
 *      (missing fields, null-deref on first frame, typos that only bite
 *      when the code actually runs). Mirrors the headless smoke that
 *      CREATE_GAME's validate.sh runs inside its sandbox.
 *
 * Results are cached at module scope and exposed via
 * `getTemplateHealthResults()` so the admin dashboard can render a banner
 * when something's broken. A failure here NEVER crashes the backend — it
 * logs and marks the template as broken.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface TemplateHealthFailure {
    templateId: string;
    stage: 'assemble' | 'script';
    error: string;
}

export interface TemplateHealthResult {
    totalCount: number;
    passedCount: number;
    failedCount: number;
    failures: TemplateHealthFailure[];
    lastRunAt: string;
    lastRunAtEpochMs: number;
}

let _lastResult: TemplateHealthResult | null = null;

export function getTemplateHealthResults(): TemplateHealthResult | null {
    return _lastResult;
}

export function runTemplateHealthChecks(
    catalog: Array<{ id: string }>,
    loadTemplate: (id: string) => { _folderPath?: string } | null,
    assembleGame: (folderPath: string) => void,
): TemplateHealthResult {
    const failures: TemplateHealthFailure[] = [];
    for (const t of catalog) {
        const template = loadTemplate(t.id);
        if (!template?._folderPath) {
            failures.push({ templateId: t.id, stage: 'assemble', error: 'template folder path missing' });
            continue;
        }
        try {
            assembleGame(template._folderPath);
        } catch (e: any) {
            failures.push({ templateId: t.id, stage: 'assemble', error: e?.message || String(e) });
            continue;
        }
        const scriptErr = smokeScripts(template._folderPath);
        if (scriptErr) {
            failures.push({ templateId: t.id, stage: 'script', error: scriptErr });
        }
    }
    const now = Date.now();
    _lastResult = {
        totalCount: catalog.length,
        passedCount: catalog.length - failures.length,
        failedCount: failures.length,
        failures,
        lastRunAt: new Date(now).toISOString(),
        lastRunAtEpochMs: now,
    };
    return _lastResult;
}

// ─── Script smoke test ────────────────────────────────────────────────────
// Mirror the CLI sandbox's validate_headless.js (written in cli_creator.ts's
// writeValidateScripts). Browser-only APIs are filtered from the error set
// since the stubs here don't simulate the DOM / audio / network.

const BROWSER_ONLY_RE = /document|window|canvas|AudioContext|WebSocket|fetch|pointerLock/i;

function smokeScripts(folder: string): string | null {
    const scripts: Record<string, string> = {};
    loadScripts(path.join(folder, 'behaviors'), 'behaviors/', scripts);
    loadScripts(path.join(folder, 'systems'), 'systems/', scripts);
    loadScripts(path.join(folder, 'scripts'), 'scripts/', scripts);

    const errors: string[] = [];
    for (const [key, source] of Object.entries(scripts)) {
        try {
            const m = source.match(/class\s+(\w+)/);
            if (!m) continue;
            const fn = new Function('GameScript', 'Vec3', 'Quat', source + '\nreturn ' + m[1] + ';');
            const Cls = fn(StubGameScript, StubVec3, StubQuat);
            const inst = new Cls();
            seedScriptFields(inst);
            if (typeof inst.onStart === 'function') inst.onStart();
            for (let i = 0; i < 60; i++) {
                inst.time = { time: i / 60, deltaTime: 1 / 60, frameCount: i };
                if (typeof inst.onUpdate === 'function') inst.onUpdate(1 / 60);
            }
        } catch (e: any) {
            const msg = e?.message || String(e);
            if (!BROWSER_ONLY_RE.test(msg)) {
                errors.push(`${key}: ${msg}`);
            }
        }
    }
    return errors.length > 0 ? errors.join(' | ') : null;
}

function loadScripts(dir: string, prefix: string, out: Record<string, string>): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            loadScripts(full, prefix + entry.name + '/', out);
        } else if (entry.name.endsWith('.ts')) {
            try { out[prefix + entry.name] = fs.readFileSync(full, 'utf-8'); } catch {}
        }
    }
}

// Inject the same transient fields the real runtime sets on a GameScript
// instance (entity/scene/input/…) so user code doesn't null-deref on line 1
// of onStart.
function seedScriptFields(inst: any): void {
    inst.entity = {
        id: 0,
        name: '',
        active: true,
        tags: new Set<string>(),
        transform: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 },
            lookAt() {},
            setRotationEuler() {},
        },
        getComponent() { return null; },
        playAnimation() {},
        setActive() {},
        setMaterialColor() {},
        addTag() {}, removeTag() {},
        getScript() { return null; },
    };
    inst.scene = {
        events: {
            game: { on() {}, emit() {} },
            ui: { on() {}, emit() {} },
        },
        findEntityByName() { return null; },
        findEntitiesByName() { return []; },
        findEntitiesByTag() { return []; },
        setPosition() {}, setScale() {}, setRotationEuler() {}, setVelocity() {},
        destroyEntity() {}, createEntity() { return 0; }, spawnEntity() { return null; },
        raycast() { return null; }, screenRaycast() { return null; }, screenPointToGround() { return null; },
        getAllEntities() { return []; },
        setFog() {}, setTimeOfDay() {}, loadScene() {},
        saveData() {}, loadData() { return null; }, deleteData() {}, listSaveKeys() { return []; },
        getTerrainHeight() { return 0; }, getTerrainNormal() { return { x: 0, y: 1, z: 0 }; },
        _fpsYaw: 0, _tpYaw: 0,
        reloadScene() {},
    };
    inst.input = {
        isKeyDown() { return false; }, isKeyPressed() { return false; }, isKeyReleased() { return false; },
        getKey() { return false; }, getKeyDown() { return false; }, getKeyUp() { return false; },
        getMouseDelta() { return { x: 0, y: 0 }; },
        getMousePosition() { return { x: 0, y: 0 }; },
        getMouseButton() { return false; }, getMouseButtonDown() { return false; }, getMouseButtonUp() { return false; },
        getMouseScroll() { return 0; },
        requestPointerLock() {},
    };
    inst.ui = {
        createText() { return { text: '', remove() {}, x: 0, y: 0 }; },
        createButton() { return { label: '', remove() {} }; },
        sendState() {},
    };
    inst.audio = {
        playSound() {}, playMusic() {}, stopMusic() {},
        setGroupVolume() {}, getGroupVolume() { return 1; }, preload() {},
    };
    inst.time = { time: 0, deltaTime: 1 / 60, frameCount: 0 };
}

class StubGameScript {}
class StubVec3 {
    x: number; y: number; z: number;
    constructor(x?: number, y?: number, z?: number) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
}
class StubQuat {
    x: number; y: number; z: number; w: number;
    constructor(x?: number, y?: number, z?: number, w?: number) { this.x = x || 0; this.y = y || 0; this.z = z || 0; this.w = w !== undefined ? w : 1; }
}
