/**
 * CLI Creator — spawns a CLI agent to create a brand-new game template inside a
 * project's file tree. Unlike the legacy creator, this one does NOT save the
 * result to the shared `reusable_game_components/` directory — the new template
 * lives entirely inside the user's project, pinned alongside its dependencies.
 *
 * Flow:
 * 1. Sandbox with `project/` (empty 4-file scaffold + engine machinery) and
 *    `reference/` (read-only copy of the shared library).
 * 2. Spawn CLI → fills in 01-04 JSON, behaviors/, systems/, ui/, scripts/.
 * 3. CLI runs validate.sh.
 * 4. Read the project file tree back.
 * 5. Assemble for final validation.
 * 6. Return the file tree to the caller (which writes it into the project).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../../../config.js';
import { assembleGame } from './level_assembler.js';
import {
    ProjectFiles,
    writeFilesToDir,
    readFilesFromDir,
    emptyTemplateFiles,
    ENGINE_MACHINERY,
} from './project_files.js';
import { spawnCLIAgent, CLIActivity, acquireCLISlot, releaseCLISlot, resolveCLI } from './cli_runner.js';
import { registerActiveJob, unregisterActiveJob } from './cli_active_jobs.js';

const __dirname_creator = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname_creator, 'reusable_game_components');
const ASSETS_DIR = config.assetsDir;
const CREATOR_CONTEXT_PATH = path.join(__dirname_creator, 'CREATOR_CONTEXT.md');

export interface CreatorResult {
    success: boolean;
    summary: string;
    templateId: string;
    files: ProjectFiles | null;
    costUsd: number;
}

export async function runCreator(
    projectId: string,
    description: string,
    sendStatus?: (msg: string) => void,
    cliOverride?: string,
    abortSignal?: AbortSignal,
    jobId?: string,
): Promise<CreatorResult> {
    await acquireCLISlot({ cliOverride, sendStatus, jobId });
    const templateId = deriveTemplateId(description);
    // Random suffix per run so concurrent creates on the same projectId don't
    // trample each other's sandbox. mkdtempSync guarantees a fresh empty dir.
    const sandboxDir = fs.mkdtempSync(path.join('/tmp', 'parallaxpro-create-'));

    // Mirror the fixer's registration into the shared active-jobs view
    // so the admin dashboard sees both kinds of runs in one table.
    // jobId is always passed by generation_jobs in the normal flow; fall
    // back to a synthetic one for any direct runCreator callers.
    const registryJobId = jobId || `create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let registered = false;
    try {
        registerActiveJob({
            jobId: registryJobId,
            cli: resolveCLI(cliOverride),
            kind: 'create',
            projectId,
            description,
            startedAt: Date.now(),
        });
        registered = true;
    } catch { /* observability only — don't let it break the run */ }

    try {
        sendStatus?.('Setting up creation sandbox...');
        createSandbox(sandboxDir);

        // Seed TASK.md with the baseline event list so the agent knows
        // what's already defined. Agents may extend project/systems/
        // event_definitions.ts with game-specific events (see
        // CONTEXT.md → "Event Definitions") — so this is a starting
        // reference, not a hard allowlist.
        let validEventsList = '';
        try {
            const evtSrc = fs.readFileSync(path.join(RGC_DIR, 'systems', 'v0.1', 'event_definitions.ts'), 'utf-8');
            const nameMatches = evtSrc.matchAll(/^\s+(\w+)\s*:/gm);
            const names: string[] = [];
            for (const m of nameMatches) if (!['fields', 'type', 'optional'].includes(m[1])) names.push(m[1]);
            validEventsList = `\n\n# Baseline Game Events\n\nThese events already exist in project/systems/event_definitions.ts — prefer them when a reasonable match is available:\n\n${names.map(n => `- ${n}`).join('\n')}\n\nIf your game's mechanic genuinely needs a new event (e.g. a game-specific phase like \`tornado_spawned\`), you MAY append it to project/systems/event_definitions.ts using the same format as the existing entries. Do NOT rename or remove any existing event.`;
        } catch {}

        fs.writeFileSync(
            path.join(sandboxDir, 'TASK.md'),
            `# Game to Create\n\n${description}\n\n# Template ID\n\n${templateId}\n\nFill in the project files in project/ — the 4 template JSONs (01_flow.json / 02_entities.json / 03_worlds.json / 04_systems.json), pinned behaviors in project/behaviors/, systems in project/systems/, UI panels in project/ui/, and any custom scripts in project/scripts/. The reference/ directory has the latest shared library to copy from. Run "bash validate.sh" before finishing.${validEventsList}`,
        );

        sendStatus?.('Creator agent is building the game...');
        const cliResult = await spawnCLI(sandboxDir, sendStatus, cliOverride, abortSignal);

        sendStatus?.('Reading created files...');
        const projectDir = path.join(sandboxDir, 'project');
        const files = readFilesFromDir(projectDir);

        if (!files['01_flow.json'] || !files['02_entities.json']) {
            return { success: false, summary: 'Creator did not produce required template files.', templateId, files: null, costUsd: cliResult.costUsd };
        }

        // The CLI may exit "successfully" (exit code 0, valid cost event)
        // without ever modifying the seeded scaffold — opencode in particular
        // has been observed to terminate early with no file writes. Without
        // this guard we'd commit the empty scaffold back to the user's
        // project and cheerfully report "game created" — exactly what they
        // got for projectId de549996 on 2026-04-16.
        const seed = emptyTemplateFiles();
        if (files['01_flow.json'] === seed['01_flow.json']) {
            return { success: false, summary: 'Creator finished but did not modify 01_flow.json — the agent exited without writing any game content.', templateId, files: null, costUsd: cliResult.costUsd };
        }

        sendStatus?.('Running final validation...');
        try {
            assembleGame(projectDir, {
                behaviors: path.join(projectDir, 'behaviors'),
                systems: path.join(projectDir, 'systems'),
                ui: path.join(projectDir, 'ui'),
            });
        } catch (e: any) {
            return { success: false, summary: `Template validation failed: ${e.message}`, templateId, files: null, costUsd: cliResult.costUsd };
        }

        return {
            success: true,
            summary: cliResult.text || `Created "${templateId}".`,
            templateId,
            files,
            costUsd: cliResult.costUsd,
        };
    } finally {
        if (registered) {
            try { unregisterActiveJob(registryJobId); } catch {}
        }
        releaseCLISlot(cliOverride);
        try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
    }
}

// ─── Template ID generation ────────────────────────────────────────────────

function deriveTemplateId(description: string): string {
    const base = description
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => !['a', 'an', 'the', 'game', 'with', 'and', 'of', 'for', 'that', 'where', 'make', 'create', 'build'].includes(w))
        .slice(0, 3)
        .join('_') || 'custom_game';
    return base;
}

// ─── Sandbox creation ──────────────────────────────────────────────────────

function createSandbox(sandboxDir: string): void {
    // sandboxDir is freshly created by mkdtempSync in the caller — already
    // exists and is empty, so no nuke-and-recreate needed here.

    // Project: starts as the empty 4-file scaffold + engine machinery so the
    // agent has working baseline files to edit.
    const projectDir = path.join(sandboxDir, 'project');
    const seed: ProjectFiles = { ...emptyTemplateFiles() };
    for (const rel of ENGINE_MACHINERY) {
        const sub = rel.replace(/^systems\//, '');
        const src = path.join(RGC_DIR, 'systems', 'v0.1', sub);
        if (fs.existsSync(src)) seed[rel] = fs.readFileSync(src, 'utf-8');
    }
    writeFilesToDir(seed, projectDir);

    // Reference: read-only library for the agent to inspect/copy from.
    const refDir = path.join(sandboxDir, 'reference');
    copyDirRecursive(path.join(RGC_DIR, 'game_templates', 'v0.1'), path.join(refDir, 'game_templates'));
    copyDirRecursive(path.join(RGC_DIR, 'behaviors', 'v0.1'), path.join(refDir, 'behaviors'));
    copyDirRecursive(path.join(RGC_DIR, 'systems', 'v0.1'), path.join(refDir, 'systems'));
    copyDirRecursive(path.join(RGC_DIR, 'ui', 'v0.1'), path.join(refDir, 'ui'));

    if (fs.existsSync(CREATOR_CONTEXT_PATH)) {
        fs.copyFileSync(CREATOR_CONTEXT_PATH, path.join(sandboxDir, 'CONTEXT.md'));
    }

    // Asset catalogs.
    const assetsDir = path.join(sandboxDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    generateAssetCatalog(assetsDir);

    writeValidateScripts(sandboxDir);
}

function copyDirRecursive(src: string, dest: string): void {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
        else fs.copyFileSync(srcPath, destPath);
    }
}

// ─── Asset catalog generation ──────────────────────────────────────────────

function generateAssetCatalog(assetsDir: string): void {
    const models: string[] = ['# Available 3D Models\n\nUse these paths in entity definitions: `"asset": "/assets/..."`\n'];
    const audio: string[] = ['# Available Audio\n\nUse these paths in scripts: `this.audio.playSound("/assets/...")`\n'];
    const textures: string[] = ['# Available Textures\n\nUse these paths in mesh_override: `"textureBundle": "/assets/..."`\n'];

    function scanDir(dir: string, urlPrefix: string): void {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                scanDir(path.join(dir, entry.name), `${urlPrefix}/${entry.name}`);
            } else {
                const name = entry.name;
                const url = `${urlPrefix}/${name}`;
                if (name.endsWith('.glb') && !name.includes('lod') && !name.includes('collision')) models.push(`- ${url}`);
                else if (name.endsWith('.ogg') || name.endsWith('.mp3') || name.endsWith('.wav')) audio.push(`- ${url}`);
                else if (name.endsWith('.png') || name.endsWith('.jpg')) textures.push(`- ${url}`);
            }
        }
    }

    scanDir(ASSETS_DIR, '/assets');

    fs.writeFileSync(path.join(assetsDir, '3D_MODELS.md'), models.join('\n'));
    fs.writeFileSync(path.join(assetsDir, 'AUDIO.md'), audio.join('\n'));
    fs.writeFileSync(path.join(assetsDir, 'TEXTURES.md'), textures.join('\n'));
}

// ─── Validation scripts ────────────────────────────────────────────────────

function writeValidateScripts(sandboxDir: string): void {
    const validateSh = `#!/bin/bash
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

class GameScript {
    constructor() {
        this.entity = { id: 0, name: '', active: true, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 }, lookAt() {}, setRotationEuler() {} }, getComponent() { return null; }, playAnimation() {}, tags: new Set() };
        this.scene = { events: { game: { on() {}, emit() {} }, ui: { on() {}, emit() {} } }, findEntityByName() { return null; }, findEntitiesByTag() { return []; }, setPosition() {}, setVelocity() {}, destroyEntity() {}, createEntity() { return 0; }, raycast() { return null; }, screenRaycast() { return null; }, screenPointToGround() { return null; }, getAllEntities() { return []; }, _fpsYaw: 0, reloadScene() {} };
        this.input = { isKeyDown() { return false; }, isKeyPressed() { return false; }, isKeyReleased() { return false; }, getMouseDelta() { return { x: 0, y: 0 }; }, requestPointerLock() {} };
        this.ui = { createText() { return { text: '', remove() {}, x: 0, y: 0 }; }, sendState() {} };
        this.audio = { playSound() {}, playMusic() {}, stopMusic() {} };
        this.time = { time: 0, deltaTime: 1/60, frameCount: 0 };
    }
    onStart() {} onUpdate() {} onLateUpdate() {} onDestroy() {}
}
class Vec3 { constructor(x,y,z) { this.x=x||0; this.y=y||0; this.z=z||0; } }
class Quat { constructor(x,y,z,w) { this.x=x||0; this.y=y||0; this.z=z||0; this.w=w||1; } }

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
    fs.writeFileSync(path.join(sandboxDir, 'validate_headless.js'), headlessJs);
}

// ─── CLI spawning ──────────────────────────────────────────────────────────

const CREATOR_PROMPT = `Read TASK.md for the game description AND the list of valid game events — you MUST only use events from that list. Read CONTEXT.md for template format docs. Browse assets/ for available 3D models, audio, textures. Look at reference/game_templates/ for examples. The project lives in project/ — fill in 01-04 JSON template files plus pinned behaviors/, systems/, ui/, and any custom scripts/ directly there. After creating, run "bash validate.sh" and fix any errors.`;

function creatorStatus(activity: CLIActivity): string | undefined {
    switch (activity.kind) {
        case 'read': return 'Reading reference files...';
        case 'write': return 'Creating game files...';
        case 'edit': return 'Editing files...';
        case 'bash': return 'Running validation...';
        case 'search': return 'Searching assets...';
        case 'other': return 'Working...';
    }
}

async function spawnCLI(sandboxDir: string, sendStatus?: (msg: string) => void, cliOverride?: string, abortSignal?: AbortSignal): Promise<{ text: string; costUsd: number }> {
    const { text, costUsd } = await spawnCLIAgent({
        sandboxDir,
        prompt: CREATOR_PROMPT,
        // 120 because CREATE_GAME writes 4 JSONs + N behaviors + M systems
        // + K UI panels + validates + fixes. 50 turns (the fixer default)
        // was starving ambitious games — agents ran out mid-build with
        // scripts still unwritten. 120 gives the creator room to
        // breathe without being infinite.
        maxTurns: 120,
        // 45 min — comfortably above the "20–30 min" we promise in chat,
        // so ambitious builds that take longer than expected still get
        // to finish instead of being SIGKILL'd with partial files.
        timeout: 45 * 60 * 1000,
        statusMapper: creatorStatus,
        sendStatus,
        cliOverride,
        abortSignal,
    });
    return { text: text || 'Template created.', costUsd };
}
