/**
 * sandbox_validate.ts — single source of truth for the validation scripts
 * that get dropped into every CLI sandbox (CREATE_GAME + FIX_GAME).
 *
 * Why this module exists: cli_creator and cli_fixer used to each hand-roll
 * their own near-identical `writeValidateScripts`, and the two copies
 * drifted — the fixer's validate.sh was silently missing the assembler
 * check (the strict one that catches unknown event names, active_behaviors
 * typos, etc). Centralising here guarantees parity.
 *
 * What the sandbox gets:
 *   - validate.sh            — bash orchestrator, run by the CLI at the
 *                              end of its turn budget.
 *   - validate_headless.js   — in-process script smoke test (loads every
 *                              behavior/system/scripts TS, runs onStart +
 *                              60 update ticks against stub runtimes).
 *   - validate_assembler.js  — POSTs to the backend's internal
 *                              /validate-sandbox endpoint so the real
 *                              assembleGame runs against the sandbox's
 *                              project/ dir. Soft-fails when the config
 *                              file (.validate_config.json) isn't present
 *                              OR the backend is unreachable, so offline
 *                              and self-hosted runs still clear the
 *                              earlier checks.
 *
 * The caller is responsible for writing `.validate_config.json` (with
 * `{ url, token }`) alongside these if they want the assembler step to
 * actually fire. The runCreator and runFixer code paths both do this.
 */

import * as fs from 'fs';
import * as path from 'path';

export function writeValidateScripts(sandboxDir: string): void {
    fs.writeFileSync(path.join(sandboxDir, 'validate.sh'), VALIDATE_SH, { mode: 0o755 });
    fs.writeFileSync(path.join(sandboxDir, 'validate_headless.js'), VALIDATE_HEADLESS_JS);
    fs.writeFileSync(path.join(sandboxDir, 'validate_assembler.js'), VALIDATE_ASSEMBLER_JS);
}

// ─── In-process checks ────────────────────────────────────────────────────
//
// These three exported functions are the authoritative spec for what
// validate.sh does (minus the strict assembler check, which callers run
// separately by invoking assembleGame directly). They're meant to be called
// from boot-time template_health.ts so the shipped-template sweep applies
// the exact same rules the CLI sees in its sandbox. The bash/node strings
// below (VALIDATE_SH + VALIDATE_HEADLESS_JS) are mirror copies — if you
// change a check here, update the inline script to match. They're kept in
// the same file so a reviewer can diff them at a glance.
//
// `projectDir` is the directory that holds `01_flow.json` etc. — for a CLI
// sandbox that's `${sandboxDir}/project`; for a shipped template it's the
// template folder itself.

const TEMPLATE_JSONS = ['01_flow.json', '02_entities.json', '03_worlds.json', '04_systems.json'];

export function checkTemplateJSON(projectDir: string): string[] {
    const errors: string[] = [];
    for (const f of TEMPLATE_JSONS) {
        const full = path.join(projectDir, f);
        if (!fs.existsSync(full)) {
            errors.push(`MISSING ${f}`);
            continue;
        }
        try {
            JSON.parse(fs.readFileSync(full, 'utf-8'));
        } catch (e: any) {
            errors.push(`JSON ERROR in ${f}: ${e?.message || e}`);
        }
    }
    return errors;
}

export function checkScriptSyntax(projectDir: string): string[] {
    const errors: string[] = [];
    for (const dir of ['behaviors', 'systems', 'scripts']) {
        walkTsFiles(path.join(projectDir, dir), (full, rel) => {
            const src = fs.readFileSync(full, 'utf-8');
            try {
                // eslint-disable-next-line no-new-func
                new Function('GameScript', 'Vec3', 'Quat', src + '\n;');
            } catch (e: any) {
                errors.push(`SYNTAX ERROR in ${dir}/${rel}: ${e?.message || e}`);
            }
        });
    }
    return errors;
}

const BROWSER_ONLY_RE = /document|window|canvas|AudioContext|WebSocket|fetch|pointerLock/i;

export function runHeadlessSmoke(projectDir: string): string[] {
    const scripts: Record<string, string> = {};
    for (const dir of ['behaviors', 'systems', 'scripts']) {
        walkTsFiles(path.join(projectDir, dir), (full, rel) => {
            scripts[`${dir}/${rel}`] = fs.readFileSync(full, 'utf-8');
        });
    }
    const errors: string[] = [];
    for (const [key, source] of Object.entries(scripts)) {
        try {
            const m = source.match(/class\s+(\w+)/);
            if (!m) {
                // No class → already covered by checkScriptSyntax; skip smoke.
                continue;
            }
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
    return errors;
}

function walkTsFiles(dir: string, visit: (fullPath: string, relPath: string) => void, prefix = ''): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkTsFiles(full, visit, prefix + entry.name + '/');
        } else if (entry.name.endsWith('.ts')) {
            try { visit(full, prefix + entry.name); } catch {}
        }
    }
}

function seedScriptFields(inst: any): void {
    inst.entity = {
        id: 0, name: '', active: true, tags: new Set<string>(),
        transform: {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 },
            lookAt() {}, setRotationEuler() {},
        },
        getComponent() { return null; },
        playAnimation() {}, setActive() {}, setMaterialColor() {},
        addTag() {}, removeTag() {}, getScript() { return null; },
    };
    inst.scene = {
        events: { game: { on() {}, emit() {} }, ui: { on() {}, emit() {} } },
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
        createPanel() { return { remove() {} }; },
        createButton() { return { remove() {} }; },
        createImage() { return { remove() {} }; },
        sendState() {},
    };
    inst.audio = { playSound() {}, playMusic() {}, stopMusic() {}, setGroupVolume() {}, getGroupVolume() { return 1; }, preload() {} };
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

const VALIDATE_SH = `#!/bin/bash
# Validate template JSON, scripts, run a headless smoke, then hit the
# backend's strict assembler. A single authoritative pipeline used by
# both CREATE_GAME and FIX_GAME sandboxes.
ERRORS=0

echo "=== Template JSON Check ==="
for f in project/01_flow.json project/02_entities.json project/03_worlds.json project/04_systems.json; do
    [ -f "$f" ] || { echo "MISSING $f"; ERRORS=$((ERRORS+1)); continue; }
    node -e "JSON.parse(require('fs').readFileSync('$f','utf-8'))" 2>&1
    if [ $? -ne 0 ]; then echo "JSON ERROR in $f"; ERRORS=$((ERRORS+1)); fi
done

echo "=== Script Syntax Check ==="
for f in $(find project/behaviors project/systems project/scripts -name '*.ts' 2>/dev/null); do
    node -e "
        const fs = require('fs');
        const src = fs.readFileSync('$f', 'utf-8');
        try { new Function('GameScript', 'Vec3', 'Quat', src + '\\n;'); }
        catch(e) { console.error('SYNTAX ERROR in $f: ' + e.message); process.exit(1); }
    " 2>&1
    if [ $? -ne 0 ]; then ERRORS=$((ERRORS+1)); fi
done

echo "=== Headless Smoke Test ==="
node validate_headless.js 2>&1
if [ $? -ne 0 ]; then ERRORS=$((ERRORS+1)); fi

echo "=== Assembler Check (strict) ==="
# Calls the engine's internal /validate-sandbox endpoint which runs the
# real assembleGame against this project's files. Catches everything
# the local checks miss: unknown event names, missing behavior/system/UI
# refs, active_behaviors / active_systems name typos, bad FSM transitions,
# component schema errors, asset paths that don't resolve. Soft-fails on
# network unreachable so offline / self-hosted dev with the backend down
# still runs the earlier checks.
node validate_assembler.js 2>&1
if [ $? -ne 0 ]; then ERRORS=$((ERRORS+1)); fi

if [ $ERRORS -eq 0 ]; then
    echo "All checks passed."
else
    echo "$ERRORS check(s) failed."
    exit 1
fi
`;

const VALIDATE_ASSEMBLER_JS = `
const fs = require('fs');
let cfg;
try {
    cfg = JSON.parse(fs.readFileSync('.validate_config.json', 'utf-8'));
} catch (e) {
    // No config = we can't run the strict check; don't block validate.sh.
    console.warn('WARN: .validate_config.json missing or unreadable — skipping assembler check.');
    process.exit(0);
}
fetch(cfg.url + '/api/engine/internal/validate-sandbox/' + cfg.token, { method: 'POST' })
    .then(function(r) { return r.json(); })
    .then(function(r) {
        if (r && r.ok) {
            console.log('Assembler check passed.');
            process.exit(0);
        } else {
            console.error('ASSEMBLE ERROR: ' + (r && r.error ? r.error : 'unknown'));
            process.exit(1);
        }
    })
    .catch(function(e) {
        // Soft-fail on network error — the sandbox may be offline / the
        // backend may not be reachable. The backend's post-exit assembler
        // gate (for CREATE_GAME) catches anything this layer misses.
        console.warn('WARN: could not reach assembler endpoint: ' + e.message);
        process.exit(0);
    });
`;

// Unified headless smoke. Stubs every major GameScript surface (entity,
// scene, input, ui, audio, time) so a script's onStart doesn't null-deref
// before we've had a chance to exercise onUpdate. Browser-only error
// fragments (document/window/canvas/WebSocket/etc.) are filtered so
// lighting / network scripts don't produce false positives node-side.
const VALIDATE_HEADLESS_JS = `
const fs = require('fs');
const path = require('path');

class GameScript {
    constructor() {
        this.entity = { id: 0, name: '', active: true, tags: new Set(), transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, lookAt() {}, setRotationEuler() {} }, getComponent() { return null; }, playAnimation() {}, setActive() {}, setMaterialColor() {}, addTag() {}, removeTag() {}, getScript() { return null; } };
        this.scene = { events: { game: { on() {}, emit() {} }, ui: { on() {}, emit() {} } }, findEntityByName() { return null; }, findEntitiesByName() { return []; }, findEntitiesByTag() { return []; }, setPosition() {}, setScale() {}, setRotationEuler() {}, setVelocity() {}, destroyEntity() {}, createEntity() { return 0; }, spawnEntity() { return null; }, raycast() { return null; }, screenRaycast() { return null; }, screenPointToGround() { return null; }, getAllEntities() { return []; }, setFog() {}, setTimeOfDay() {}, loadScene() {}, saveData() {}, loadData() { return null; }, deleteData() {}, listSaveKeys() { return []; }, getTerrainHeight() { return 0; }, getTerrainNormal() { return { x: 0, y: 1, z: 0 }; }, _fpsYaw: 0, _tpYaw: 0, reloadScene() {} };
        this.input = { isKeyDown() { return false; }, isKeyPressed() { return false; }, isKeyReleased() { return false; }, getKey() { return false; }, getKeyDown() { return false; }, getKeyUp() { return false; }, getMouseDelta() { return { x: 0, y: 0 }; }, getMousePosition() { return { x: 0, y: 0 }; }, getMouseButton() { return false; }, getMouseButtonDown() { return false; }, getMouseButtonUp() { return false; }, getMouseScroll() { return 0; }, requestPointerLock() {} };
        this.ui = { createText() { return { text: '', remove() {}, x: 0, y: 0 }; }, createPanel() { return { remove() {} }; }, createButton() { return { remove() {} }; }, createImage() { return { remove() {} }; }, sendState() {} };
        this.audio = { playSound() {}, playMusic() {}, stopMusic() {}, setGroupVolume() {}, getGroupVolume() { return 1; }, preload() {} };
        this.time = { time: 0, deltaTime: 1/60, frameCount: 0 };
    }
    onStart() {} onUpdate() {} onLateUpdate() {} onFixedUpdate() {} onDestroy() {}
}
class Vec3 { constructor(x,y,z) { this.x=x||0; this.y=y||0; this.z=z||0; } }
class Quat { constructor(x,y,z,w) { this.x=x||0; this.y=y||0; this.z=z||0; this.w=w!==undefined?w:1; } }

const errors = [];
const scripts = {};

function loadScripts(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) loadScripts(full, prefix + entry.name + '/');
        else if (entry.name.endsWith('.ts')) scripts[prefix + entry.name] = fs.readFileSync(full, 'utf-8');
    }
}
loadScripts('project/behaviors', 'behaviors/');
loadScripts('project/systems', 'systems/');
loadScripts('project/scripts', 'scripts/');

for (const [key, source] of Object.entries(scripts)) {
    try {
        const m = source.match(/class\\s+(\\w+)/);
        if (!m) continue;
        const fn = new Function('GameScript', 'Vec3', 'Quat', source + '\\nreturn ' + m[1] + ';');
        const Cls = fn(GameScript, Vec3, Quat);
        const inst = new Cls();
        inst.onStart();
        for (let i = 0; i < 60; i++) {
            inst.time = { time: i/60, deltaTime: 1/60, frameCount: i };
            if (typeof inst.onUpdate === 'function') inst.onUpdate(1/60);
        }
    } catch (e) {
        const msg = e.message || '';
        if (!/document|window|canvas|AudioContext|WebSocket|fetch|pointerLock/i.test(msg)) {
            errors.push(key + ': ' + msg);
        }
    }
}

if (errors.length === 0) {
    console.log('Headless smoke test passed (' + Object.keys(scripts).length + ' scripts).');
} else {
    for (const e of errors) console.error(e);
    process.exit(1);
}
`;
