/**
 * CLI Creator — spawns a CLI agent to create a new game template from scratch.
 *
 * Flow:
 * 1. Create sandbox with reference templates, assets catalogs, context docs
 * 2. Spawn CLI → creates 4 template JSONs + behavior/system/UI scripts
 * 3. CLI runs validate.sh (syntax + assembler + headless)
 * 4. Server reads new template + scripts from sandbox
 * 5. Server runs assembleGame() for final validation
 * 6. Saves template + scripts to reusable_game_components/ (with conflict handling)
 * 7. Assembles game and sends to frontend
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { config } from '../../../config.js';
import { assembleGame, ConvertedScene } from './level_assembler.js';

const __dirname_creator = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname_creator, 'reusable_game_components');
const ASSETS_DIR = config.assetsDir;
const CREATOR_CONTEXT_PATH = path.join(__dirname_creator, 'CREATOR_CONTEXT.md');

export interface CreatorResult {
    success: boolean;
    summary: string;
    templateId: string;
    assembled: ConvertedScene | null;
}

export async function runCreator(
    projectId: string,
    description: string,
    sendStatus?: (msg: string) => void,
): Promise<CreatorResult> {
    const templateId = deriveTemplateId(description);
    const sandboxDir = path.join('/tmp', `parallaxpro-create-${projectId}`);

    try {
        sendStatus?.('Setting up creation sandbox...');
        createSandbox(sandboxDir, templateId);

        // Build valid events list for the task file
        let validEventsList = '';
        try {
            const evtSrc = fs.readFileSync(path.join(RGC_DIR, 'systems', 'v0.1', 'event_definitions.ts'), 'utf-8');
            const nameMatches = evtSrc.matchAll(/^\s+(\w+)\s*:/gm);
            const names: string[] = [];
            for (const m of nameMatches) {
                if (!['fields', 'type', 'optional'].includes(m[1])) names.push(m[1]);
            }
            validEventsList = `\n\n# CRITICAL: Valid Game Events\n\nYou MUST only use these event names with events.game.on/emit. Using any other name will cause validation to fail.\n\n${names.map(n => `- ${n}`).join('\n')}\n\nDo NOT invent new event names. If you need an event that's not listed, use the closest match (e.g., use "entity_killed" instead of "enemy_killed", use "wave_started" instead of "wave_cleared").`;
        } catch {}

        fs.writeFileSync(path.join(sandboxDir, 'TASK.md'),
            `# Game to Create\n\n${description}\n\n# Template ID\n\n${templateId}\n\nCreate all 4 template JSON files in template/ and any custom scripts in new_scripts/. Read reference/ for examples and assets/ for available 3D models, audio, and textures.${validEventsList}`
        );

        sendStatus?.('Creator agent is building the game...');
        const cliOutput = await spawnCLI(sandboxDir, description, sendStatus);

        sendStatus?.('Reading created files...');
        const created = readCreatedFiles(sandboxDir);

        if (!created.hasTemplate) {
            return { success: false, summary: 'Creator did not produce template files.', templateId, assembled: null };
        }

        // Validate BEFORE saving — write temp copies of new scripts so assembler can find them
        sendStatus?.('Running final validation...');
        const tempScriptsDir = path.join(sandboxDir, '_validate');
        writeTempScripts(tempScriptsDir, created);

        // Write template JSONs to a temp location for assembleGame
        const tempTemplateDir = path.join(sandboxDir, '_validate_template');
        fs.mkdirSync(tempTemplateDir, { recursive: true });
        for (const [filename, content] of Object.entries(created.templateFiles)) {
            fs.writeFileSync(path.join(tempTemplateDir, filename), content);
        }

        let assembled: ConvertedScene;
        try {
            assembled = assembleGame(tempTemplateDir, {
                behaviors: path.join(tempScriptsDir, 'behaviors'),
                systems: path.join(tempScriptsDir, 'systems'),
                ui: path.join(tempScriptsDir, 'ui'),
            });
        } catch (e: any) {
            return { success: false, summary: `Template validation failed: ${e.message}`, templateId, assembled: null };
        }

        // Validation passed — now save to reusable_game_components
        sendStatus?.('Saving template...');
        saveTemplate(templateId, created);

        return {
            success: true,
            summary: cliOutput || `Created "${templateId}" template with ${assembled.entities.length} entities.`,
            templateId,
            assembled,
        };
    } finally {
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

    // Check for conflicts with existing templates
    const templatesDir = path.join(RGC_DIR, 'game_templates', 'v0.1');
    let id = base;
    let counter = 1;
    while (fs.existsSync(path.join(templatesDir, id))) {
        id = `${base}_${counter++}`;
    }
    return id;
}

// ─── Sandbox creation ──────────────────────────────────────────────────────

function createSandbox(sandboxDir: string, templateId: string): void {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.mkdirSync(sandboxDir, { recursive: true });

    // Directories the CLI creates into
    fs.mkdirSync(path.join(sandboxDir, 'template'), { recursive: true });
    fs.mkdirSync(path.join(sandboxDir, 'new_scripts', 'behaviors'), { recursive: true });
    fs.mkdirSync(path.join(sandboxDir, 'new_scripts', 'systems'), { recursive: true });
    fs.mkdirSync(path.join(sandboxDir, 'new_scripts', 'ui'), { recursive: true });

    // Reference: existing templates, behaviors, systems, UI, event defs
    const refDir = path.join(sandboxDir, 'reference');
    copyDirRecursive(path.join(RGC_DIR, 'game_templates', 'v0.1'), path.join(refDir, 'game_templates'));
    copyDirRecursive(path.join(RGC_DIR, 'behaviors', 'v0.1'), path.join(refDir, 'behaviors'));
    copyDirRecursive(path.join(RGC_DIR, 'systems', 'v0.1'), path.join(refDir, 'systems'));
    copyDirRecursive(path.join(RGC_DIR, 'ui', 'v0.1'), path.join(refDir, 'ui'));

    // Context doc
    if (fs.existsSync(CREATOR_CONTEXT_PATH)) {
        fs.copyFileSync(CREATOR_CONTEXT_PATH, path.join(sandboxDir, 'CONTEXT.md'));
    }

    // Asset catalogs
    const assetsDir = path.join(sandboxDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    generateAssetCatalog(assetsDir);

    // Validation scripts
    writeValidateScripts(sandboxDir, templateId);
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

// ─── Temp scripts for validation ───────────────────────────────────────────

function writeTempScripts(tempDir: string, created: CreatedFiles): void {
    // Copy existing shared scripts as base
    copyDirRecursive(path.join(RGC_DIR, 'behaviors', 'v0.1'), path.join(tempDir, 'behaviors'));
    copyDirRecursive(path.join(RGC_DIR, 'systems', 'v0.1'), path.join(tempDir, 'systems'));
    copyDirRecursive(path.join(RGC_DIR, 'ui', 'v0.1'), path.join(tempDir, 'ui'));

    // Overlay new scripts on top
    for (const [rel, content] of Object.entries(created.behaviors)) {
        const p = path.join(tempDir, 'behaviors', rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
    }
    for (const [rel, content] of Object.entries(created.systems)) {
        const p = path.join(tempDir, 'systems', rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
    }
    for (const [rel, content] of Object.entries(created.uiFiles)) {
        const p = path.join(tempDir, 'ui', rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
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
                if (name.endsWith('.glb') && !name.includes('lod') && !name.includes('collision')) {
                    models.push(`- ${url}`);
                } else if (name.endsWith('.ogg') || name.endsWith('.mp3') || name.endsWith('.wav')) {
                    audio.push(`- ${url}`);
                } else if (name.endsWith('.png') || name.endsWith('.jpg')) {
                    textures.push(`- ${url}`);
                }
            }
        }
    }

    scanDir(ASSETS_DIR, '/assets');

    fs.writeFileSync(path.join(assetsDir, '3D_MODELS.md'), models.join('\n'));
    fs.writeFileSync(path.join(assetsDir, 'AUDIO.md'), audio.join('\n'));
    fs.writeFileSync(path.join(assetsDir, 'TEXTURES.md'), textures.join('\n'));
}

// ─── Validation scripts ────────────────────────────────────────────────────

function writeValidateScripts(sandboxDir: string, templateId: string): void {
    const validateSh = `#!/bin/bash
ERRORS=0

echo "=== Syntax Check ==="
for f in new_scripts/behaviors/**/*.ts new_scripts/systems/**/*.ts; do
    [ -f "$f" ] || continue
    node -e "
        const fs = require('fs');
        const src = fs.readFileSync('$f', 'utf-8');
        try { new Function('GameScript', 'Vec3', 'Quat', src + '\\n;'); }
        catch(e) { console.error('SYNTAX ERROR in $f: ' + e.message); process.exit(1); }
    " 2>&1
    if [ $? -ne 0 ]; then ERRORS=$((ERRORS+1)); fi
done

echo "=== JSON Check ==="
for f in template/*.json; do
    [ -f "$f" ] || continue
    node -e "JSON.parse(require('fs').readFileSync('$f','utf-8'))" 2>&1
    if [ $? -ne 0 ]; then echo "JSON ERROR in $f"; ERRORS=$((ERRORS+1)); fi
done

echo "=== Template Completeness ==="
[ -f "template/01_flow.json" ] || { echo "MISSING: 01_flow.json"; ERRORS=$((ERRORS+1)); }
[ -f "template/02_entities.json" ] || { echo "MISSING: 02_entities.json"; ERRORS=$((ERRORS+1)); }
[ -f "template/03_worlds.json" ] || { echo "MISSING: 03_worlds.json"; ERRORS=$((ERRORS+1)); }

echo "=== Event Validation ==="
node validate_events.js 2>&1
if [ $? -ne 0 ]; then ERRORS=$((ERRORS+1)); fi

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

    // Headless smoke test for new template scripts
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

// Load from new_scripts/ AND reference scripts
function loadScriptsFrom(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) loadScriptsFrom(full, prefix + entry.name + '/');
        else if (entry.name.endsWith('.ts')) scripts[prefix + entry.name] = fs.readFileSync(full, 'utf-8');
    }
}
loadScriptsFrom('new_scripts/behaviors', '');
loadScriptsFrom('new_scripts/systems', '');

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

    // Event validation script — checks scripts use only valid event names
    const eventsJs = `
const fs = require('fs');
const path = require('path');

// Read valid events from reference
const evtSrc = fs.readFileSync('reference/systems/event_definitions.ts', 'utf-8');
const validEvents = new Set();
const matches = evtSrc.matchAll(/^\\s+(\\w+)\\s*:/gm);
for (const m of matches) {
    if (!['fields', 'type', 'optional'].includes(m[1])) validEvents.add(m[1]);
}

const errors = [];

// Check all new scripts
function checkDir(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { checkDir(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const src = fs.readFileSync(full, 'utf-8');
        const gameRefs = src.matchAll(/events\\.game\\.(?:on|emit)\\s*\\(\\s*"([^"]+)"/g);
        for (const m of gameRefs) {
            if (!validEvents.has(m[1])) {
                errors.push(full + ': unknown game event "' + m[1] + '"');
            }
        }
        // Check for game events on ui bus
        const uiRefs = src.matchAll(/events\\.ui\\.emit\\s*\\(\\s*"([^"]+)"/g);
        for (const m of uiRefs) {
            if (validEvents.has(m[1])) {
                errors.push(full + ': game event "' + m[1] + '" emitted on ui bus — use events.game.emit');
            }
        }
    }
}

checkDir('new_scripts/behaviors');
checkDir('new_scripts/systems');

// Also check flow JSON for invalid events
try {
    const flow = JSON.parse(fs.readFileSync('template/01_flow.json', 'utf-8'));
    function checkStates(states, prefix) {
        for (const [name, s] of Object.entries(states)) {
            for (const t of (s.transitions || [])) {
                const w = t.when || '';
                if (w.startsWith('game_event:')) {
                    const evt = w.substring(11);
                    if (!validEvents.has(evt)) {
                        errors.push('01_flow.json ' + prefix + name + ': unknown game event "' + evt + '" in "' + w + '"');
                    }
                }
            }
            for (const actionList of [s.on_enter, s.on_exit, s.on_update]) {
                if (!Array.isArray(actionList)) continue;
                for (const action of actionList) {
                    if (typeof action === 'string' && action.startsWith('emit:game.')) {
                        const evt = action.substring(10);
                        if (!validEvents.has(evt)) {
                            errors.push('01_flow.json ' + prefix + name + ': unknown game event "' + evt + '"');
                        }
                    }
                }
            }
            if (s.substates) checkStates(s.substates, prefix + name + '/');
        }
    }
    if (flow.states) checkStates(flow.states, '');

    // UI button validation — check ui_event: transitions reference panels with matching buttons
    const panelButtons = {};
    // Scan new UI files
    function scanUI(dir) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanUI(full); continue; }
            if (!entry.name.endsWith('.html')) continue;
            const panelName = entry.name.replace('.html', '');
            const html = fs.readFileSync(full, 'utf-8');
            const buttons = new Set();
            const emitMatches = html.matchAll(/emit\\s*\\(\\s*['"]([^'"]+)['"]/g);
            for (const m of emitMatches) buttons.add(m[1]);
            if (buttons.size > 0) panelButtons[panelName] = buttons;
        }
    }
    scanUI('new_scripts/ui');
    scanUI('reference/ui');

    function checkUITransitions(states, prefix) {
        for (const [name, s] of Object.entries(states)) {
            for (const t of (s.transitions || [])) {
                const w = t.when || '';
                if (!w.startsWith('ui_event:')) continue;
                const parts = w.substring(9).split(':');
                if (parts.length !== 2) { errors.push(prefix + name + ': malformed ui_event "' + w + '"'); continue; }
                const panel = parts[0], action = parts[1];
                const buttons = panelButtons[panel];
                if (!buttons) {
                    errors.push(prefix + name + ': ui_event references panel "' + panel + '" but no buttons found in ' + panel + '.html');
                } else if (!buttons.has(action)) {
                    errors.push(prefix + name + ': ui_event references button "' + action + '" but ' + panel + '.html only has: ' + [...buttons].join(', '));
                }
            }
            if (s.substates) checkUITransitions(s.substates, prefix + name + '/');
        }
    }
    if (flow.states) checkUITransitions(flow.states, '');
} catch (e) {
    errors.push('Failed to parse 01_flow.json: ' + e.message);
}

if (errors.length === 0) {
    console.log('Event + UI validation passed (' + validEvents.size + ' valid events).');
} else {
    for (const e of errors) console.error('VALIDATION ERROR: ' + e);
    console.error(errors.length + ' validation error(s) found.');
    process.exit(1);
}
`;
    fs.writeFileSync(path.join(sandboxDir, 'validate_events.js'), eventsJs);
}

// ─── CLI spawning ──────────────────────────────────────────────────────────

function spawnCLI(sandboxDir: string, description: string, sendStatus?: (msg: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
        const cli = config.fixer.cli;
        const timeout = config.fixer.timeout;

        if (cli !== 'claude') {
            throw new Error(`Creator CLI "${cli}" is not supported yet. Currently only "claude" is supported.`);
        }

        const prompt = `Read TASK.md for the game description AND the list of valid game events — you MUST only use events from that list. Read CONTEXT.md for template format docs and rules. Browse assets/ for available 3D models, audio, textures. Look at reference/game_templates/ for examples of complete templates. Create the game template in template/ and any custom scripts in new_scripts/. After creating, run "bash validate.sh" to verify. Fix any errors.`;

        const args = [
            '-p', prompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--model', 'sonnet',
            '--dangerously-skip-permissions',
            '--max-turns', '50',
        ];

        const proc = spawn(cli, args, {
            cwd: sandboxDir,
            timeout,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, HOME: process.env.HOME || '/tmp' },
        });

        let resultText = '';
        let stderr = '';
        let buffer = '';

        proc.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);
                    if (event.type === 'assistant') {
                        const content = event.message?.content;
                        if (Array.isArray(content)) {
                            for (const block of content) {
                                if (block.type === 'tool_use') {
                                    const name = block.name || '';
                                    if (name === 'Read') sendStatus?.('Reading reference files...');
                                    else if (name === 'Write') sendStatus?.('Creating game files...');
                                    else if (name === 'Edit') sendStatus?.('Editing files...');
                                    else if (name === 'Bash') sendStatus?.('Running validation...');
                                    else if (name === 'Grep' || name === 'Glob') sendStatus?.('Searching assets...');
                                    else sendStatus?.('Working...');
                                }
                            }
                        }
                    }
                    if (event.type === 'result') resultText = event.result || '';
                } catch {}
            }
        });

        proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        proc.on('close', (code) => {
            if (buffer.trim()) {
                try { const e = JSON.parse(buffer); if (e.type === 'result') resultText = e.result || ''; } catch {}
            }
            if (code === 0 || code === null) {
                resolve(resultText || 'Template created.');
            } else {
                console.error(`[CLICreator] exited with code ${code}. stderr: ${stderr.slice(0, 500)}`);
                reject(new Error(`Creator CLI exited with code ${code}`));
            }
        });

        proc.on('error', (err) => {
            reject(new Error(`Failed to spawn creator CLI: ${err.message}`));
        });
    });
}

// ─── Read created files ────────────────────────────────────────────────────

interface CreatedFiles {
    hasTemplate: boolean;
    templateFiles: Record<string, string>;  // filename → content
    behaviors: Record<string, string>;      // relative path → content
    systems: Record<string, string>;
    uiFiles: Record<string, string>;
}

function readCreatedFiles(sandboxDir: string): CreatedFiles {
    const result: CreatedFiles = { hasTemplate: false, templateFiles: {}, behaviors: {}, systems: {}, uiFiles: {} };

    // Template JSONs
    const templateDir = path.join(sandboxDir, 'template');
    if (fs.existsSync(templateDir)) {
        for (const f of fs.readdirSync(templateDir)) {
            if (f.endsWith('.json')) {
                result.templateFiles[f] = fs.readFileSync(path.join(templateDir, f), 'utf-8');
            }
        }
        result.hasTemplate = '01_flow.json' in result.templateFiles && '02_entities.json' in result.templateFiles;
    }

    // New scripts
    walkFiles(path.join(sandboxDir, 'new_scripts', 'behaviors'), '', (rel, content) => { result.behaviors[rel] = content; });
    walkFiles(path.join(sandboxDir, 'new_scripts', 'systems'), '', (rel, content) => { result.systems[rel] = content; });
    walkFiles(path.join(sandboxDir, 'new_scripts', 'ui'), '', (rel, content) => { result.uiFiles[rel] = content; });

    return result;
}

function walkFiles(dir: string, prefix: string, cb: (rel: string, content: string) => void): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walkFiles(path.join(dir, entry.name), rel, cb);
        else cb(rel, fs.readFileSync(path.join(dir, entry.name), 'utf-8'));
    }
}

// ─── Save template to reusable_game_components ────────────────────────────

function saveTemplate(templateId: string, created: CreatedFiles): string {
    // Save template JSONs
    const templateDir = path.join(RGC_DIR, 'game_templates', 'v0.1', templateId);
    fs.mkdirSync(templateDir, { recursive: true });
    for (const [filename, content] of Object.entries(created.templateFiles)) {
        fs.writeFileSync(path.join(templateDir, filename), content);
    }

    // Save behaviors with conflict handling
    const behaviorsDir = path.join(RGC_DIR, 'behaviors', 'v0.1');
    saveScriptsWithConflictHandling(created.behaviors, behaviorsDir, templateId, created.templateFiles);

    // Save systems with conflict handling
    const systemsDir = path.join(RGC_DIR, 'systems', 'v0.1');
    saveScriptsWithConflictHandling(created.systems, systemsDir, templateId, created.templateFiles);

    // Save UI files with conflict handling
    const uiDir = path.join(RGC_DIR, 'ui', 'v0.1');
    saveScriptsWithConflictHandling(created.uiFiles, uiDir, templateId, created.templateFiles);

    return templateDir;
}

function saveScriptsWithConflictHandling(
    scripts: Record<string, string>,
    targetDir: string,
    templateId: string,
    templateFiles: Record<string, string>,
): void {
    for (const [relPath, content] of Object.entries(scripts)) {
        const targetPath = path.join(targetDir, relPath);
        const targetDirForFile = path.dirname(targetPath);
        fs.mkdirSync(targetDirForFile, { recursive: true });

        if (fs.existsSync(targetPath)) {
            const existing = fs.readFileSync(targetPath, 'utf-8');
            if (existing === content) continue; // Identical — skip

            // Conflict — rename with template prefix
            const ext = path.extname(relPath);
            const base = relPath.slice(0, -ext.length);
            const newRelPath = `${base}_${templateId}${ext}`;
            const newTargetPath = path.join(targetDir, newRelPath);
            fs.writeFileSync(newTargetPath, content);

            // Update references in template JSONs
            for (const [jsonFile, jsonContent] of Object.entries(templateFiles)) {
                const updated = jsonContent.replace(new RegExp(escapeRegex(relPath), 'g'), newRelPath);
                if (updated !== jsonContent) {
                    templateFiles[jsonFile] = updated;
                    // Re-save the updated JSON
                    const templateDir = path.join(RGC_DIR, 'game_templates', 'v0.1', templateId);
                    fs.writeFileSync(path.join(templateDir, jsonFile), updated);
                }
            }
        } else {
            fs.writeFileSync(targetPath, content);
        }
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
