/**
 * CLI Fixer — spawns a CLI agent (claude, codex, opencode, etc.) to fix game bugs.
 *
 * Sandbox is the project's file tree in template format. Edits go to template
 * sources (01-04 JSON, behaviors/, systems/, ui/, scripts/) — never to assembled
 * output. After the fixer finishes, the modified file tree is read back and
 * the project is rebuilt.
 *
 * Flow:
 * 1. Hydrate project file tree to sandbox/project/
 * 2. Copy shared library to sandbox/reference/ (read-only)
 * 3. Write TASK.md with bug report + project summary
 * 4. Spawn CLI with FIXER_CONTEXT.md as system prompt
 * 5. Read changed/added/deleted files
 * 6. Validate scripts (syntax)
 * 7. Return changes for the editor to commit + rebuild
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProjectFiles, writeFilesToDir, readFilesFromDir } from './project_files.js';
import { assembleGame } from './level_assembler.js';
import { spawnCLIAgent, CLIActivity } from './cli_runner.js';

const __dirname_fixer = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname_fixer, 'reusable_game_components');
const FIXER_CONTEXT_PATH = path.join(__dirname_fixer, 'FIXER_CONTEXT.md');

export interface FixerResult {
    success: boolean;
    summary: string;
    /** Relative file paths in the project tree that changed (added/modified/deleted). */
    filesChanged: string[];
    /** New/updated file contents to merge into the project tree. */
    changedFiles: Record<string, string>;
    /** Files removed from the project tree. */
    deletedFiles: string[];
    costUsd?: number;
}

const MAX_CONCURRENT_FIXERS = 10;
let activeFixerCount = 0;
const waitQueue: (() => void)[] = [];

function acquireSlot(sendStatus?: (msg: string) => void): Promise<void> {
    if (activeFixerCount < MAX_CONCURRENT_FIXERS) {
        activeFixerCount++;
        return Promise.resolve();
    }
    sendStatus?.(`Queued — ${waitQueue.length + 1} in line, waiting for a slot...`);
    return new Promise<void>((resolve) => {
        waitQueue.push(() => { activeFixerCount++; resolve(); });
    });
}

function releaseSlot(): void {
    activeFixerCount--;
    const next = waitQueue.shift();
    if (next) next();
}

export async function runFixer(
    projectId: string,
    description: string,
    projectFiles: ProjectFiles,
    activeSceneKey: string,
    sendStatus?: (msg: string) => void,
    abortSignal?: AbortSignal,
    cliOverride?: string,
): Promise<FixerResult> {
    await acquireSlot(sendStatus);
    const sandboxDir = path.join('/tmp', `parallaxpro-fix-${projectId}`);

    try {
        sendStatus?.('Setting up sandbox...');
        createSandbox(sandboxDir, projectFiles);

        const projectSummary = buildProjectSummary(sandboxDir, projectFiles, activeSceneKey);
        fs.writeFileSync(
            path.join(sandboxDir, 'TASK.md'),
            `# Bug Report\n\n${description}\n\n# Current Project State\n\n${projectSummary}`,
        );

        sendStatus?.('Editing Agent is analyzing and coding...');
        const cliResult = await spawnCLI(sandboxDir, sendStatus, abortSignal, cliOverride);

        sendStatus?.('Reading changes...');
        const changes = readChanges(sandboxDir, projectFiles);

        if (changes.filesChanged.length === 0) {
            return {
                success: true,
                summary: cliResult.text || 'No changes were needed.',
                filesChanged: [],
                changedFiles: {},
                deletedFiles: [],
                costUsd: cliResult.costUsd,
            };
        }

        const validationErrors = validateChanges(changes.changedFiles);
        if (validationErrors.length > 0) {
            return {
                success: false,
                summary: `Fix had syntax errors:\n${validationErrors.join('\n')}`,
                filesChanged: [],
                changedFiles: {},
                deletedFiles: [],
                costUsd: cliResult.costUsd,
            };
        }

        return {
            success: true,
            summary: cliResult.text || `Fixed ${changes.filesChanged.length} file(s).`,
            filesChanged: changes.filesChanged,
            changedFiles: changes.changedFiles,
            deletedFiles: changes.deletedFiles,
            costUsd: cliResult.costUsd,
        };
    } finally {
        releaseSlot();
        try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
    }
}

// ─── Sandbox creation ──────────────────────────────────────────────────────

function createSandbox(sandboxDir: string, projectFiles: ProjectFiles): void {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.mkdirSync(sandboxDir, { recursive: true });

    // Project: the user's actual file tree (template format).
    const projectDir = path.join(sandboxDir, 'project');
    writeFilesToDir(projectFiles, projectDir);

    // Reference: read-only copies of the shared library so the fixer can
    // discover behaviors/systems/UI panels not yet pinned to the project.
    const refDir = path.join(sandboxDir, 'reference');
    fs.mkdirSync(refDir, { recursive: true });

    const behaviorsDir = path.join(RGC_DIR, 'behaviors', 'v0.1');
    if (fs.existsSync(behaviorsDir)) copyDirRecursive(behaviorsDir, path.join(refDir, 'behaviors'));

    const systemsDir = path.join(RGC_DIR, 'systems', 'v0.1');
    if (fs.existsSync(systemsDir)) copyDirRecursive(systemsDir, path.join(refDir, 'systems'));

    const uiDir = path.join(RGC_DIR, 'ui', 'v0.1');
    if (fs.existsSync(uiDir)) copyDirRecursive(uiDir, path.join(refDir, 'ui'));

    // Convenience: top-level event_definitions.ts pointer.
    const evtDefs = path.join(systemsDir, 'event_definitions.ts');
    if (fs.existsSync(evtDefs)) fs.copyFileSync(evtDefs, path.join(refDir, 'event_definitions.ts'));

    if (fs.existsSync(FIXER_CONTEXT_PATH)) {
        fs.copyFileSync(FIXER_CONTEXT_PATH, path.join(sandboxDir, 'CONTEXT.md'));
    }

    writeValidateScripts(sandboxDir);
}

function copyDirRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
        else fs.copyFileSync(srcPath, destPath);
    }
}

function writeValidateScripts(sandboxDir: string): void {
    const validateSh = `#!/bin/bash
# Validate template JSON, scripts, and run a headless smoke test.
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

if [ $ERRORS -eq 0 ]; then
    echo "All checks passed."
else
    echo "$ERRORS check(s) failed."
    exit 1
fi
`;
    fs.writeFileSync(path.join(sandboxDir, 'validate.sh'), validateSh, { mode: 0o755 });

    const headlessJs = `
const fs = require('fs');
const path = require('path');

const errors = [];
const scripts = {};

function loadScriptsFrom(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) loadScriptsFrom(full, prefix + entry.name + '/');
        else if (entry.name.endsWith('.ts')) scripts[prefix + entry.name] = fs.readFileSync(full, 'utf-8');
    }
}
loadScriptsFrom('project/behaviors', 'behaviors/');
loadScriptsFrom('project/systems', 'systems/');
loadScriptsFrom('project/scripts', 'scripts/');

class GameScript {
    constructor() {
        this.entity = { id: 0, name: '', active: true, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, lookAt() {}, setRotationEuler() {} }, getComponent() { return null; }, playAnimation() {}, tags: new Set() };
        this.scene = { events: { game: { on() {}, emit() {} }, ui: { on() {}, emit() {} } }, findEntityByName() { return null; }, findEntitiesByTag() { return []; }, setPosition() {}, setVelocity() {}, destroyEntity() {}, createEntity() { return 0; }, raycast() { return null; }, screenRaycast() { return null; }, screenPointToGround() { return null; }, getAllEntities() { return []; }, _fpsYaw: 0, reloadScene() {} };
        this.input = { isKeyDown() { return false; }, isKeyPressed() { return false; }, isKeyReleased() { return false; }, getMouseDelta() { return { x: 0, y: 0 }; }, requestPointerLock() {} };
        this.ui = { createText() { return { text: '', remove() {}, x: 0, y: 0 }; }, createPanel() { return { remove() {} }; }, createButton() { return { remove() {} }; }, createImage() { return { remove() {} }; }, sendState() {} };
        this.audio = { playSound() {}, playMusic() {}, stopMusic() {} };
        this.time = { time: 0, deltaTime: 1/60, frameCount: 0 };
    }
    onStart() {} onUpdate() {} onLateUpdate() {} onFixedUpdate() {} onDestroy() {}
}
class Vec3 { constructor(x,y,z) { this.x=x||0; this.y=y||0; this.z=z||0; } }
class Quat { constructor(x,y,z,w) { this.x=x||0; this.y=y||0; this.z=z||0; this.w=w||1; } }

const compiled = {};
for (const [key, source] of Object.entries(scripts)) {
    try {
        const m = source.match(/class\\s+(\\w+)/);
        if (!m) continue;
        const fn = new Function('GameScript', 'Vec3', 'Quat', source + '\\nreturn ' + m[1] + ';');
        compiled[key] = fn(GameScript, Vec3, Quat);
    } catch (e) {
        errors.push('COMPILE ERROR in ' + key + ': ' + e.message);
    }
}

const instances = [];
for (const [key, Cls] of Object.entries(compiled)) {
    try {
        const inst = new Cls();
        inst.onStart();
        instances.push({ key, inst });
    } catch (e) {
        const msg = e.message || '';
        if (!/document|window|canvas|AudioContext|WebSocket|fetch|pointerLock|requestAnimationFrame/i.test(msg)) {
            errors.push('RUNTIME ERROR in ' + key + ' onStart: ' + msg);
        }
    }
}

for (let frame = 0; frame < 180; frame++) {
    for (const { key, inst } of instances) {
        try {
            inst.time = { time: frame / 60, deltaTime: 1/60, frameCount: frame };
            if (typeof inst.onUpdate === 'function') inst.onUpdate(1/60);
        } catch (e) {
            const msg = e.message || '';
            if (!/document|window|canvas|AudioContext|WebSocket|fetch|pointerLock|requestAnimationFrame/i.test(msg)) {
                if (!errors.some(err => err.includes(key))) {
                    errors.push('RUNTIME ERROR in ' + key + ' onUpdate (frame ' + frame + '): ' + msg);
                }
            }
        }
    }
}

if (errors.length === 0) {
    console.log('Headless smoke test passed (' + Object.keys(scripts).length + ' scripts, 180 frames).');
} else {
    for (const e of errors) console.error(e);
    process.exit(1);
}
`;
    fs.writeFileSync(path.join(sandboxDir, 'validate_headless.js'), headlessJs);
}

// ─── CLI spawning ──────────────────────────────────────────────────────────

const FIXER_PROMPT = `Read TASK.md for the bug report and project state. Read CONTEXT.md for engine docs and rules. The project lives in project/ — its 4 template files (01_flow.json, 02_entities.json, 03_worlds.json, 04_systems.json) plus pinned behaviors/, systems/, ui/, and any user scripts/. Edit template files (NOT generated artifacts) to fix the bug. If you need a behavior or system from reference/ that isn't in project/, copy it into project/ first and reference it from the template JSON. After fixing, run "bash validate.sh". Be concise — fix the bug, don't refactor.`;

function fixerStatus(activity: CLIActivity): string | undefined {
    switch (activity.kind) {
        case 'read': return 'Reading project files...';
        case 'edit': return 'Editing files...';
        case 'write': return 'Creating new files...';
        case 'bash': return 'Running validation...';
        case 'search': return 'Searching project...';
        case 'other': return 'Thinking...';
    }
}

function spawnCLI(sandboxDir: string, sendStatus?: (msg: string) => void, abortSignal?: AbortSignal, cliOverride?: string): Promise<{ text: string; costUsd: number }> {
    return spawnCLIAgent({
        sandboxDir,
        prompt: FIXER_PROMPT,
        maxTurns: 30,
        statusMapper: fixerStatus,
        sendStatus,
        abortSignal,
        cliOverride,
    });
}

// ─── Read changes ──────────────────────────────────────────────────────────

interface Changes {
    changedFiles: Record<string, string>;
    deletedFiles: string[];
    filesChanged: string[];
}

function readChanges(sandboxDir: string, original: ProjectFiles): Changes {
    const projectDir = path.join(sandboxDir, 'project');
    const newFiles = readFilesFromDir(projectDir);

    const changedFiles: Record<string, string> = {};
    const deletedFiles: string[] = [];
    const filesChanged: string[] = [];

    for (const [key, content] of Object.entries(newFiles)) {
        if (original[key] === undefined || original[key] !== content) {
            changedFiles[key] = content;
            filesChanged.push(key);
        }
    }
    for (const key of Object.keys(original)) {
        if (key === '__legacy__') continue;
        if (newFiles[key] === undefined) {
            deletedFiles.push(key);
            filesChanged.push(key);
        }
    }

    return { changedFiles, deletedFiles, filesChanged };
}

// ─── Validation ────────────────────────────────────────────────────────────

function validateChanges(changedFiles: Record<string, string>): string[] {
    const errors: string[] = [];
    for (const [key, source] of Object.entries(changedFiles)) {
        if (key.endsWith('.json')) {
            try { JSON.parse(source); }
            catch (e: any) { errors.push(`${key}: ${e.message}`); }
            continue;
        }
        if (key.endsWith('.ts') || key.endsWith('.js')) {
            try { new Function('GameScript', 'Vec3', 'Quat', source + '\n;'); }
            catch (e: any) { errors.push(`${key}: ${e.message}`); }
        }
    }
    return errors;
}

// ─── Project summary ──────────────────────────────────────────────────────

/**
 * Build a human-readable summary of the project for the fixer. Lists template
 * files, pinned behaviors/systems, UI panels, and a snapshot of the assembled
 * scene so the agent knows what's actually rendered.
 */
function buildProjectSummary(sandboxDir: string, files: ProjectFiles, activeSceneKey: string): string {
    const lines: string[] = [];

    lines.push('## Template Files');
    for (const k of ['01_flow.json', '02_entities.json', '03_worlds.json', '04_systems.json']) {
        lines.push(`- ${k}${files[k] ? '' : ' (MISSING)'}`);
    }
    lines.push('');

    const groupBy = (prefix: string) => Object.keys(files)
        .filter(k => k.startsWith(prefix))
        .sort();

    const behaviors = groupBy('behaviors/');
    if (behaviors.length > 0) {
        lines.push(`## Pinned Behaviors (${behaviors.length})`);
        for (const k of behaviors) lines.push(`- ${k}`);
        lines.push('');
    }

    const systems = groupBy('systems/');
    if (systems.length > 0) {
        lines.push(`## Pinned Systems (${systems.length})`);
        for (const k of systems) lines.push(`- ${k}`);
        lines.push('');
    }

    const ui = groupBy('ui/');
    if (ui.length > 0) {
        lines.push(`## UI Panels (${ui.length})`);
        for (const k of ui) lines.push(`- ${k}`);
        lines.push('');
    }

    const userScripts = groupBy('scripts/');
    if (userScripts.length > 0) {
        lines.push(`## User Scripts (${userScripts.length})`);
        for (const k of userScripts) lines.push(`- ${k}`);
        lines.push('');
    }

    // Try to assemble for an entity snapshot — best effort, ignore errors.
    try {
        const projectDir = path.join(sandboxDir, 'project');
        const assembled = assembleGame(projectDir, {
            behaviors: path.join(projectDir, 'behaviors'),
            systems: path.join(projectDir, 'systems'),
            ui: path.join(projectDir, 'ui'),
        });
        lines.push(`## Assembled Scene "${activeSceneKey}" — ${assembled.entities.length} entities`);
        for (const e of assembled.entities.slice(0, 30)) {
            const tc = e.components?.find((c: any) => c.type === 'TransformComponent');
            const pos = tc?.data?.position;
            const posStr = pos ? `at (${fmt(pos.x)}, ${fmt(pos.y)}, ${fmt(pos.z)})` : '';
            lines.push(`- ${e.name} ${posStr}`);
        }
        if (assembled.entities.length > 30) lines.push(`  ... and ${assembled.entities.length - 30} more`);
    } catch (e: any) {
        lines.push(`## Assembled Scene`);
        lines.push(`(Build failed: ${e.message})`);
    }

    return lines.join('\n');
}

function fmt(n: any): string {
    return typeof n === 'number' ? n.toFixed(1) : String(n);
}
