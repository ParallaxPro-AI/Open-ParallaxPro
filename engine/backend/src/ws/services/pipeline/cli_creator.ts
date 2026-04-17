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
import { registerSandboxToken, unregisterSandboxToken } from './sandbox_validator.js';
import { isDockerSandboxEnabled } from './docker_sandbox.js';
import { pickRelevantLibrary, copyPickedLibraryFiles } from './library_index.js';

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
    /**
     * Absolute path to the admin-side CLI session capture dir for this run,
     * when capture is enabled. Propagated up so generation_jobs can pass it
     * to the onGenerationComplete hook (admin plugin archives it in
     * creator_snapshots). Never exposed to user-visible routes.
     */
    sessionCapturePath?: string | null;
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

    // Token that maps to this sandbox for the /validate-sandbox
    // endpoint. validate.sh inside the sandbox POSTs with this token
    // so the backend can run the real assembleGame against the
    // sandbox's project/ dir. Revoked in the finally so a leftover
    // token can't be used after the sandbox is cleaned up.
    const validateToken = registerSandboxToken(sandboxDir);
    // Inside docker we reach the host via the bridge's host-gateway
    // mapping (see docker_sandbox wrapSpawn --add-host). Outside docker
    // (local dev) the sandbox is on the host's own filesystem, so
    // localhost works.
    const validateBackendUrl = isDockerSandboxEnabled()
        ? `http://host.docker.internal:${config.port}`
        : `http://localhost:${config.port}`;

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
        await createSandbox(sandboxDir, description);

        // Drop the config where validate_assembler.js can find it. Done
        // after createSandbox (which rewrites assets) so we don't race
        // with any sandbox seeding step that could clobber the file.
        fs.writeFileSync(
            path.join(sandboxDir, '.validate_config.json'),
            JSON.stringify({ url: validateBackendUrl, token: validateToken }),
        );

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
        const cliResult = await spawnCLI(sandboxDir, sendStatus, cliOverride, abortSignal, { jobId: registryJobId, projectId });

        sendStatus?.('Reading created files...');
        const projectDir = path.join(sandboxDir, 'project');
        let files = readFilesFromDir(projectDir);

        if (!files['01_flow.json'] || !files['02_entities.json']) {
            return { success: false, summary: 'Creator did not produce required template files.', templateId, files: null, costUsd: cliResult.costUsd, sessionCapturePath: cliResult.sessionCapturePath };
        }

        // The CLI may exit "successfully" (exit code 0, valid cost event)
        // without ever modifying the seeded scaffold — opencode in particular
        // has been observed to terminate early with no file writes. Without
        // this guard we'd commit the empty scaffold back to the user's
        // project and cheerfully report "game created" — exactly what they
        // got for projectId de549996 on 2026-04-16.
        const seed = emptyTemplateFiles();
        if (files['01_flow.json'] === seed['01_flow.json']) {
            return { success: false, summary: 'Creator finished but did not modify 01_flow.json — the agent exited without writing any game content.', templateId, files: null, costUsd: cliResult.costUsd, sessionCapturePath: cliResult.sessionCapturePath };
        }

        sendStatus?.('Running final validation...');
        let assembleErr: any = null;
        try {
            assembleGame(projectDir, {
                behaviors: path.join(projectDir, 'behaviors'),
                systems: path.join(projectDir, 'systems'),
                ui: path.join(projectDir, 'ui'),
            });
        } catch (e: any) {
            assembleErr = e;
        }

        if (assembleErr) {
            // One retry: the CLI's own validate.sh can miss things the
            // real assembler catches (unknown event refs, asset paths
            // that don't resolve, FSM transition parse errors). Append
            // the error to TASK.md and give the agent one more run to
            // fix it before we give up. Aborts are honored — if the
            // user hit Stop while we were waiting, don't re-spawn.
            if (abortSignal?.aborted) {
                return { success: false, summary: 'Aborted before retry.', templateId, files: null, costUsd: cliResult.costUsd, sessionCapturePath: cliResult.sessionCapturePath };
            }
            sendStatus?.('Validation failed — feeding error back to the agent for one retry...');
            try {
                const taskPath = path.join(sandboxDir, 'TASK.md');
                const existing = fs.readFileSync(taskPath, 'utf-8');
                fs.writeFileSync(
                    taskPath,
                    existing +
                        `\n\n# Previous attempt failed validation\n\nThe engine's assembler rejected your output with this error:\n\n\`\`\`\n${assembleErr.message || String(assembleErr)}\n\`\`\`\n\nRead the error, find which file caused it, fix just that, and run "bash validate.sh" again. Do NOT rewrite unrelated files — small targeted edits only. This is your FINAL attempt.`,
                );
            } catch (e: any) {
                console.warn(`[CLICreator] Failed to append retry guidance to TASK.md: ${e?.message}`);
            }

            let retryResult: { text: string; costUsd: number; sessionCapturePath?: string | null };
            try {
                // Retry is a fresh CLI spawn, so session_capture opens a
                // second capture dir (the first is still on disk under its
                // own timestamped name). We swap cliResult's path to point
                // at the retry's capture so admins land on the last run.
                retryResult = await spawnCLI(sandboxDir, sendStatus, cliOverride, abortSignal, { jobId: registryJobId, projectId });
            } catch (e: any) {
                return {
                    success: false,
                    summary: `Template validation failed and retry spawn errored: ${e?.message || e}\n\nOriginal error: ${assembleErr.message}`,
                    templateId,
                    files: null,
                    costUsd: cliResult.costUsd, sessionCapturePath: cliResult.sessionCapturePath,
                };
            }
            // Accumulate cost so the retry isn't invisible to usage.
            cliResult.costUsd += retryResult.costUsd;
            if (retryResult.text) cliResult.text = retryResult.text;
            if (retryResult.sessionCapturePath) cliResult.sessionCapturePath = retryResult.sessionCapturePath;

            if (abortSignal?.aborted) {
                return { success: false, summary: 'Aborted during retry.', templateId, files: null, costUsd: cliResult.costUsd, sessionCapturePath: cliResult.sessionCapturePath };
            }

            sendStatus?.('Reading retried files...');
            files = readFilesFromDir(projectDir);
            if (!files['01_flow.json'] || !files['02_entities.json']) {
                return { success: false, summary: `Retry removed required template files. Original error: ${assembleErr.message}`, templateId, files: null, costUsd: cliResult.costUsd, sessionCapturePath: cliResult.sessionCapturePath };
            }

            sendStatus?.('Re-running final validation...');
            try {
                assembleGame(projectDir, {
                    behaviors: path.join(projectDir, 'behaviors'),
                    systems: path.join(projectDir, 'systems'),
                    ui: path.join(projectDir, 'ui'),
                });
            } catch (e2: any) {
                return {
                    success: false,
                    summary: `Template validation failed after retry.\n\nFirst: ${assembleErr.message}\nRetry: ${e2.message || e2}`,
                    templateId,
                    files: null,
                    costUsd: cliResult.costUsd, sessionCapturePath: cliResult.sessionCapturePath,
                };
            }
        }

        return {
            success: true,
            summary: cliResult.text || `Created "${templateId}".`,
            templateId,
            files,
            costUsd: cliResult.costUsd, sessionCapturePath: cliResult.sessionCapturePath,
        };
    } finally {
        try { unregisterSandboxToken(validateToken); } catch {}
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

async function createSandbox(sandboxDir: string, description: string): Promise<void> {
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

    // Reference: game_templates kept whole (40 templates × 4 small JSONs —
    // cheap and the agent picks one by name). behaviors/systems/ui are
    // filtered by semantic similarity to the game description so the agent
    // isn't swimming through hundreds of irrelevant files.
    const refDir = path.join(sandboxDir, 'reference');
    copyDirRecursive(path.join(RGC_DIR, 'game_templates', 'v0.1'), path.join(refDir, 'game_templates'));

    const picks = await pickRelevantLibrary(description);
    copyPickedLibraryFiles(picks, refDir);

    // Auto-loaded agent instructions. Each CLI picks up its own convention
    // (claude → CLAUDE.md, codex/opencode/copilot → AGENTS.md) without a
    // tool-call Read, saving a turn per run and letting Claude's prompt
    // cache hit across sessions.
    if (fs.existsSync(CREATOR_CONTEXT_PATH)) {
        const ctx = fs.readFileSync(CREATOR_CONTEXT_PATH, 'utf-8');
        fs.writeFileSync(path.join(sandboxDir, 'CLAUDE.md'), ctx);
        fs.writeFileSync(path.join(sandboxDir, 'AGENTS.md'), ctx);
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

echo "=== Assembler Check (strict) ==="
# Calls the engine's internal /validate-sandbox endpoint which runs the
# real assembleGame against this project's files. Catches everything
# the local checks miss: unknown event names, missing behavior/system/UI
# refs, asset paths that don't resolve, bad FSM transitions, component
# schema errors. Soft-fails on network unreachable so offline / self-
# hosted dev with the backend down still runs the earlier checks.
node validate_assembler.js 2>&1
if [ $? -ne 0 ]; then ERRORS=$((ERRORS+1)); fi

if [ $ERRORS -eq 0 ]; then
    echo "All checks passed."
else
    echo "$ERRORS check(s) failed."
    exit 1
fi
`;
    fs.writeFileSync(path.join(sandboxDir, 'validate.sh'), validateSh, { mode: 0o755 });

    // Small Node helper that reads .validate_config.json (written by
    // runCreator with {url, token}) and POSTs to the backend's internal
    // assembler endpoint. Separated from validate.sh to avoid escaping
    // a multi-line `node -e "..."` script through bash.
    const assemblerJs = `
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
        // backend may not be reachable. runCreator's post-exit
        // assembleGame is still the authoritative gate either way.
        console.warn('WARN: could not reach assembler endpoint: ' + e.message);
        process.exit(0);
    });
`;
    fs.writeFileSync(path.join(sandboxDir, 'validate_assembler.js'), assemblerJs);

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

// Template-format docs + rules live in CLAUDE.md / AGENTS.md, which each CLI
// auto-loads into its system prompt — no Read call needed.
const CREATOR_PROMPT = `Read TASK.md for the game description and baseline event list — use those events unless you add a new one to project/systems/event_definitions.ts. Browse assets/ for 3D models, audio, textures. reference/game_templates/ has working examples; reference/behaviors|systems|ui/ has library files to copy into project/. Fill in the 4 JSON template files plus pinned behaviors/, systems/, ui/, and any custom scripts/ under project/. Run "bash validate.sh" when done and fix any errors.`;

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

async function spawnCLI(sandboxDir: string, sendStatus?: (msg: string) => void, cliOverride?: string, abortSignal?: AbortSignal, capture?: { jobId: string; projectId: string; userId?: number; username?: string }): Promise<{ text: string; costUsd: number; sessionCapturePath?: string | null }> {
    const { text, costUsd, sessionCapturePath } = await spawnCLIAgent({
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
        capture: capture ? { ...capture, kind: 'create' } : undefined,
    });
    return { text: text || 'Template created.', costUsd, sessionCapturePath };
}
