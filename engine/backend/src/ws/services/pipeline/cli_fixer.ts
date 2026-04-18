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
import { randomUUID } from 'crypto';
import { ProjectFiles, writeFilesToDir, readFilesFromDir } from './project_files.js';
import { assembleGame } from './level_assembler.js';
import { spawnCLIAgent, CLIActivity, acquireCLISlot, releaseCLISlot, resolveCLI } from './cli_runner.js';
import { registerActiveJob, unregisterActiveJob } from './cli_active_jobs.js';
import { pickRelevantLibrary, copyPickedLibraryFiles } from './library_index.js';
import { registerSandboxToken, unregisterSandboxToken } from './sandbox_validator.js';
import { isDockerSandboxEnabled } from './docker_sandbox.js';
import { config } from '../../../config.js';
import { writeValidateScripts } from './sandbox_validate.js';

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

export async function runFixer(
    projectId: string,
    description: string,
    projectFiles: ProjectFiles,
    activeSceneKey: string,
    sendStatus?: (msg: string) => void,
    abortSignal?: AbortSignal,
    cliOverride?: string,
): Promise<FixerResult> {
    const jobId = randomUUID();
    await acquireCLISlot({ cliOverride, sendStatus, jobId });
    // Random suffix per run so concurrent fixes on the same projectId don't
    // trample each other's sandbox. mkdtempSync guarantees a fresh empty dir.
    const sandboxDir = fs.mkdtempSync(path.join('/tmp', 'parallaxpro-fix-'));

    // Sandbox token + backend URL for the strict assembler check in
    // validate.sh (same pattern as runCreator). validate_assembler.js POSTs
    // to `/validate-sandbox/:token` so the real assembleGame runs against
    // the fixer sandbox's project/ dir. Without this pair the check soft-
    // fails silently and the fixer CLI never sees structural regressions
    // (unknown events, active_behaviors typos, etc).
    const validateToken = registerSandboxToken(sandboxDir);
    const validateBackendUrl = isDockerSandboxEnabled()
        ? `http://host.docker.internal:${config.port}`
        : `http://localhost:${config.port}`;

    // Register in the shared active-jobs view so the admin dashboard can
    // see which CLIs are currently fixing what (mirrors what generation
    // jobs do from the other side). Unregistered in finally, paired with
    // the slot release — a throw before register is fine since the
    // finally only runs code that was set up.
    let registered = false;
    try {
        registerActiveJob({
            jobId,
            cli: resolveCLI(cliOverride),
            kind: 'fix',
            projectId,
            description,
            startedAt: Date.now(),
        });
        registered = true;
    } catch { /* best-effort — don't let observability break the run */ }

    try {
        sendStatus?.('Setting up sandbox...');
        await createSandbox(sandboxDir, projectFiles, description);

        // Drop the config where validate_assembler.js can find it. Done
        // after createSandbox so the sandbox dir is guaranteed to exist.
        fs.writeFileSync(
            path.join(sandboxDir, '.validate_config.json'),
            JSON.stringify({ url: validateBackendUrl, token: validateToken }),
        );

        const projectSummary = buildProjectSummary(sandboxDir, projectFiles, activeSceneKey);
        fs.writeFileSync(
            path.join(sandboxDir, 'TASK.md'),
            `# Bug Report\n\n${description}\n\n# Current Project State\n\n${projectSummary}`,
        );

        sendStatus?.('Editing Agent is analyzing and coding...');
        const cliResult = await spawnCLI(sandboxDir, sendStatus, abortSignal, cliOverride, { jobId, projectId });

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
        try { unregisterSandboxToken(validateToken); } catch {}
        if (registered) {
            try { unregisterActiveJob(jobId); } catch {}
        }
        releaseCLISlot(cliOverride);
        try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
    }
}

// ─── Sandbox creation ──────────────────────────────────────────────────────

async function createSandbox(
    sandboxDir: string,
    projectFiles: ProjectFiles,
    description: string,
): Promise<void> {
    // sandboxDir is freshly created by mkdtempSync in the caller — already
    // exists and is empty, so no nuke-and-recreate needed here.

    // Project: the user's actual file tree (template format).
    const projectDir = path.join(sandboxDir, 'project');
    writeFilesToDir(projectFiles, projectDir);

    // Reference: filtered by semantic similarity to the bug report. Instead
    // of dumping 276 library files for every fix, we ship only the top
    // candidates — the agent still has escape hatches to pull more in, but
    // its default exploration surface is tiny.
    const refDir = path.join(sandboxDir, 'reference');
    fs.mkdirSync(refDir, { recursive: true });

    const picks = await pickRelevantLibrary(description);
    copyPickedLibraryFiles(picks, refDir);

    // Convenience: top-level event_definitions.ts pointer.
    const evtDefs = path.join(RGC_DIR, 'systems', 'v0.1', 'event_definitions.ts');
    if (fs.existsSync(evtDefs)) fs.copyFileSync(evtDefs, path.join(refDir, 'event_definitions.ts'));

    // Auto-loaded agent instructions. Each CLI picks up its own convention
    // (claude → CLAUDE.md, codex/opencode/copilot → AGENTS.md) without a
    // tool-call Read, which saves a turn per run and lets Claude's prompt
    // cache hit across sessions since the system prefix becomes stable.
    if (fs.existsSync(FIXER_CONTEXT_PATH)) {
        const ctx = fs.readFileSync(FIXER_CONTEXT_PATH, 'utf-8');
        fs.writeFileSync(path.join(sandboxDir, 'CLAUDE.md'), ctx);
        fs.writeFileSync(path.join(sandboxDir, 'AGENTS.md'), ctx);
    }

    writeValidateScripts(sandboxDir);
}

// ─── CLI spawning ──────────────────────────────────────────────────────────

// Engine docs + rules live in CLAUDE.md / AGENTS.md, which each CLI auto-loads
// into its system prompt — no Read call needed. Keep this prompt to the
// per-run instructions only.
const FIXER_PROMPT = `Read TASK.md for the bug report and project state. Edit template files in project/ to fix the bug (the 4 JSONs + pinned behaviors/, systems/, ui/, scripts/ — never assembled output). To use a behavior/system not yet in project/, copy it from reference/ into project/ and reference its path from the template JSON. Run "bash validate.sh" when done. Be concise — fix the bug, don't refactor.`;

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

function spawnCLI(sandboxDir: string, sendStatus?: (msg: string) => void, abortSignal?: AbortSignal, cliOverride?: string, capture?: { jobId: string; projectId: string }): Promise<{ text: string; costUsd: number }> {
    return spawnCLIAgent({
        sandboxDir,
        prompt: FIXER_PROMPT,
        maxTurns: 30,
        statusMapper: fixerStatus,
        sendStatus,
        abortSignal,
        cliOverride,
        capture: capture ? { ...capture, kind: 'fix' } : undefined,
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
