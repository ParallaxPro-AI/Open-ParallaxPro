/**
 * CLI Fixer — spawns a CLI agent (claude, codex, opencode, etc.) to fix game bugs.
 *
 * Flow:
 * 1. Create sandbox with project files + reference docs
 * 2. Write TASK.md with user's bug report + project summary
 * 3. Spawn CLI process with FIXER_CONTEXT.md as system prompt
 * 4. Wait for completion
 * 5. Read changed files from sandbox
 * 6. Validate changes (syntax check)
 * 7. Apply to project data + reload frontend
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { config } from '../../../config.js';

const __dirname_fixer = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname_fixer, 'reusable_game_components');
const FIXER_CONTEXT_PATH = path.join(__dirname_fixer, 'FIXER_CONTEXT.md');

export interface FixerResult {
    success: boolean;
    summary: string;
    filesChanged: string[];
}

export async function runFixer(
    projectId: string,
    description: string,
    projectData: any,
    activeSceneKey: string,
    sendStatus?: (msg: string) => void,
): Promise<FixerResult> {
    const sandboxDir = path.join('/tmp', `parallaxpro-fix-${projectId}`);

    try {
        // 1. Create sandbox
        sendStatus?.('Setting up sandbox...');
        createSandbox(sandboxDir, projectData);

        // 2. Write task file
        const projectSummary = buildProjectSummary(projectData, activeSceneKey);
        fs.writeFileSync(path.join(sandboxDir, 'TASK.md'), `# Bug Report\n\n${description}\n\n# Current Project State\n\n${projectSummary}`);

        // 3. Spawn CLI
        sendStatus?.('Fixer agent is analyzing and fixing...');
        const cliOutput = await spawnCLI(sandboxDir, description, sendStatus);

        // 4. Read changes
        sendStatus?.('Reading changes...');
        const changes = readChanges(sandboxDir, projectData);

        if (changes.filesChanged.length === 0) {
            return { success: true, summary: cliOutput || 'No changes were needed.', filesChanged: [] };
        }

        // 5. Validate
        const validationErrors = validateChanges(changes.newScripts);
        if (validationErrors.length > 0) {
            return { success: false, summary: `Fix had syntax errors:\n${validationErrors.join('\n')}`, filesChanged: [] };
        }

        // 6. Apply changes to project data
        applyChanges(projectData, changes);

        return {
            success: true,
            summary: cliOutput || `Fixed ${changes.filesChanged.length} file(s).`,
            filesChanged: changes.filesChanged,
        };
    } finally {
        // Cleanup sandbox
        try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
    }
}

// ─── Sandbox creation ──────────────────────────────────────────────────────

function createSandbox(sandboxDir: string, projectData: any): void {
    fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.mkdirSync(sandboxDir, { recursive: true });

    // Project files
    const projectDir = path.join(sandboxDir, 'project');
    fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'scenes'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'ui'), { recursive: true });

    // Write scripts
    if (projectData.scripts) {
        for (const [key, content] of Object.entries(projectData.scripts)) {
            const filePath = path.join(projectDir, key);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content as string);
        }
    }

    // Write scenes
    if (projectData.scenes) {
        for (const [key, data] of Object.entries(projectData.scenes)) {
            fs.writeFileSync(path.join(projectDir, 'scenes', key), JSON.stringify(data, null, 2));
        }
    }

    // Write UI files
    if (projectData.uiFiles) {
        for (const [key, content] of Object.entries(projectData.uiFiles)) {
            const filePath = path.join(projectDir, key);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content as string);
        }
    }

    // Reference files (read-only copies)
    const refDir = path.join(sandboxDir, 'reference');
    fs.mkdirSync(refDir, { recursive: true });

    // Copy behaviors
    const behaviorsDir = path.join(RGC_DIR, 'behaviors', 'v0.1');
    if (fs.existsSync(behaviorsDir)) {
        copyDirRecursive(behaviorsDir, path.join(refDir, 'behaviors'));
    }

    // Copy systems
    const systemsDir = path.join(RGC_DIR, 'systems', 'v0.1');
    if (fs.existsSync(systemsDir)) {
        copyDirRecursive(systemsDir, path.join(refDir, 'systems'));
    }

    // Copy event definitions
    const evtDefs = path.join(systemsDir, 'event_definitions.ts');
    if (fs.existsSync(evtDefs)) {
        fs.copyFileSync(evtDefs, path.join(refDir, 'event_definitions.ts'));
    }

    // Copy fixer context
    if (fs.existsSync(FIXER_CONTEXT_PATH)) {
        fs.copyFileSync(FIXER_CONTEXT_PATH, path.join(sandboxDir, 'CONTEXT.md'));
    }

    // Validation script — CLI can run this to check syntax
    const validateScript = `#!/bin/bash
# Validates all project scripts for syntax errors.
# Run: bash validate.sh

ERRORS=0
for f in project/scripts/*.ts project/scripts/**/*.ts; do
    [ -f "$f" ] || continue
    # Use node to syntax-check: wrap in function to catch parse errors
    node -e "
        const fs = require('fs');
        const src = fs.readFileSync('$f', 'utf-8');
        try { new Function('GameScript', 'Vec3', 'Quat', src + '\\n;'); }
        catch(e) { console.error('SYNTAX ERROR in $f: ' + e.message); process.exit(1); }
    " 2>&1
    if [ $? -ne 0 ]; then ERRORS=$((ERRORS+1)); fi
done

# Validate scene JSON
for f in project/scenes/*.json; do
    [ -f "$f" ] || continue
    node -e "JSON.parse(require('fs').readFileSync('$f','utf-8'))" 2>&1
    if [ $? -ne 0 ]; then echo "JSON ERROR in $f"; ERRORS=$((ERRORS+1)); fi
done

if [ $ERRORS -eq 0 ]; then
    echo "All files valid."
else
    echo "$ERRORS file(s) have errors."
    exit 1
fi
`;
    fs.writeFileSync(path.join(sandboxDir, 'validate.sh'), validateScript, { mode: 0o755 });
}

function copyDirRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// ─── CLI spawning ──────────────────────────────────────────────────────────

function spawnCLI(sandboxDir: string, description: string, sendStatus?: (msg: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
        const cli = config.fixer.cli;
        const timeout = config.fixer.timeout;

        const prompt = `Read TASK.md for the bug report and project state. Read CONTEXT.md for engine docs and rules. Fix the bug by editing files in the project/ directory. After fixing, run "bash validate.sh" to check for syntax errors. Be concise — just fix the bug, don't refactor unrelated code.`;

        let args: string[];
        if (cli === 'claude') {
            args = [
                '-p', prompt,
                '--output-format', 'stream-json',
                '--model', 'sonnet',
                '--dangerously-skip-permissions',
                '--max-turns', '30',
            ];
        } else {
            throw new Error(`Fixer CLI "${cli}" is not supported yet. Currently only "claude" is supported. Set FIXER_CLI=claude in .env`);
        }

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
                                    if (name === 'Read') sendStatus?.('Analyzing game code...');
                                    else if (name === 'Edit') sendStatus?.('Applying fix...');
                                    else if (name === 'Write') sendStatus?.('Creating new file...');
                                    else if (name === 'Bash') sendStatus?.('Running validation...');
                                    else if (name === 'Grep' || name === 'Glob') sendStatus?.('Searching for relevant code...');
                                    else sendStatus?.('Working...');
                                }
                            }
                        }
                    }
                    if (event.type === 'result') {
                        resultText = event.result || '';
                    }
                } catch {}
            }
        });

        proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        proc.on('close', (code) => {
            // Parse any remaining buffer
            if (buffer.trim()) {
                try {
                    const event = JSON.parse(buffer);
                    if (event.type === 'result') resultText = event.result || '';
                } catch {}
            }
            if (code === 0 || code === null) {
                resolve(resultText || 'Changes applied.');
            } else {
                console.error(`[CLIFixer] ${cli} exited with code ${code}. stderr: ${stderr.slice(0, 500)}`);
                reject(new Error(`Fixer CLI exited with code ${code}`));
            }
        });

        proc.on('error', (err) => {
            console.error(`[CLIFixer] Failed to spawn ${cli}:`, err.message);
            reject(new Error(`Failed to spawn fixer CLI "${cli}": ${err.message}`));
        });
    });
}

// ─── Read changes ──────────────────────────────────────────────────────────

interface Changes {
    newScripts: Record<string, string>;
    newScenes: Record<string, any>;
    newUiFiles: Record<string, string>;
    filesChanged: string[];
}

function readChanges(sandboxDir: string, originalData: any): Changes {
    const projectDir = path.join(sandboxDir, 'project');
    const filesChanged: string[] = [];
    const newScripts: Record<string, string> = {};
    const newScenes: Record<string, any> = {};
    const newUiFiles: Record<string, string> = {};

    // Read scripts
    const scriptsDir = path.join(projectDir, 'scripts');
    if (fs.existsSync(scriptsDir)) {
        walkFiles(scriptsDir, '', (relPath, content) => {
            const key = `scripts/${relPath}`;
            newScripts[key] = content;
            if (!originalData.scripts?.[key] || originalData.scripts[key] !== content) {
                filesChanged.push(key);
            }
        });
    }

    // Read scenes
    const scenesDir = path.join(projectDir, 'scenes');
    if (fs.existsSync(scenesDir)) {
        walkFiles(scenesDir, '', (relPath, content) => {
            try {
                const data = JSON.parse(content);
                newScenes[relPath] = data;
                const original = originalData.scenes?.[relPath];
                if (!original || JSON.stringify(original) !== JSON.stringify(data)) {
                    filesChanged.push(`scenes/${relPath}`);
                }
            } catch {}
        });
    }

    // Read UI files
    const uiDir = path.join(projectDir, 'ui');
    if (fs.existsSync(uiDir)) {
        walkFiles(uiDir, '', (relPath, content) => {
            const key = `ui/${relPath}`;
            newUiFiles[key] = content;
            if (!originalData.uiFiles?.[key] || originalData.uiFiles[key] !== content) {
                filesChanged.push(key);
            }
        });
    }

    return { newScripts, newScenes, newUiFiles, filesChanged };
}

function walkFiles(dir: string, prefix: string, callback: (relPath: string, content: string) => void): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkFiles(fullPath, relPath, callback);
        } else {
            callback(relPath, fs.readFileSync(fullPath, 'utf-8'));
        }
    }
}

// ─── Validation ────────────────────────────────────────────────────────────

function validateChanges(scripts: Record<string, string>): string[] {
    const errors: string[] = [];
    for (const [key, source] of Object.entries(scripts)) {
        try {
            new Function('GameScript', 'Vec3', 'Quat', source + '\n;');
        } catch (e: any) {
            errors.push(`${key}: ${e.message}`);
        }
    }
    return errors;
}

// ─── Apply changes ─────────────────────────────────────────────────────────

function applyChanges(projectData: any, changes: Changes): void {
    // Merge scripts
    if (Object.keys(changes.newScripts).length > 0) {
        projectData.scripts = { ...(projectData.scripts || {}), ...changes.newScripts };
    }

    // Merge scenes
    if (Object.keys(changes.newScenes).length > 0) {
        projectData.scenes = { ...(projectData.scenes || {}), ...changes.newScenes };
    }

    // Merge UI files
    if (Object.keys(changes.newUiFiles).length > 0) {
        projectData.uiFiles = { ...(projectData.uiFiles || {}), ...changes.newUiFiles };
    }
}

// ─── Project summary ──────────────────────────────────────────────────────

function buildProjectSummary(projectData: any, activeSceneKey: string): string {
    const lines: string[] = [];

    // Scripts
    const scripts = projectData.scripts || {};
    const scriptKeys = Object.keys(scripts);
    if (scriptKeys.length > 0) {
        lines.push(`## Scripts (${scriptKeys.length})`);
        for (const key of scriptKeys) {
            const source = scripts[key];
            const classMatch = source.match(/class\s+(\w+)/);
            lines.push(`- ${key} (${classMatch?.[1] || 'unknown class'})`);
        }
        lines.push('');
    }

    // Scenes
    const scenes = projectData.scenes || {};
    for (const [key, data] of Object.entries(scenes) as [string, any][]) {
        const isActive = key === activeSceneKey;
        const entities = data.entities || [];
        lines.push(`## Scene "${key}"${isActive ? ' (ACTIVE)' : ''} — ${entities.length} entities`);
        for (const e of entities.slice(0, 30)) {
            const pos = e.components?.find((c: any) => c.type === 'TransformComponent')?.data?.position;
            const posStr = pos ? `at (${pos.x?.toFixed?.(1) ?? pos.x}, ${pos.y?.toFixed?.(1) ?? pos.y}, ${pos.z?.toFixed?.(1) ?? pos.z})` : '';
            lines.push(`- ${e.name} ${posStr}`);
        }
        if (entities.length > 30) lines.push(`  ... and ${entities.length - 30} more`);
        lines.push('');
    }

    // UI files
    const uiFiles = projectData.uiFiles || {};
    const uiKeys = Object.keys(uiFiles);
    if (uiKeys.length > 0) {
        lines.push(`## UI Files (${uiKeys.length})`);
        for (const key of uiKeys) lines.push(`- ${key}`);
        lines.push('');
    }

    return lines.join('\n');
}
