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
 * 2. Drop library.sh + search_assets.sh + validate.sh. The library
 *    (behaviors / systems / UI panels) is NOT pre-copied — the agent
 *    fetches pieces on demand via library.sh.
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
import { spawnCLIAgent, CLIActivity, acquireCLISlot, releaseCLISlot, resolveCLI, CLIRunResult } from './cli_runner.js';
import { forkSession, warmIfNeeded, forkPreviousFixSession, registerFixSession } from './session_warmer.js';
import { registerActiveJob, unregisterActiveJob, preemptProjectJob, updateJobSessionType } from './cli_active_jobs.js';
import type { SessionType } from './cli_active_jobs.js';
import { preemptGenerationJob } from './generation_jobs.js';
// Previously used pickRelevantLibrary/copyPickedLibraryFiles to seed
// reference/behaviors|systems|ui. After L2 of the library-tool plan
// those files no longer live in the sandbox — library.sh serves them
// on demand.
import { registerSandboxToken, unregisterSandboxToken } from './sandbox_validator.js';
import { isDockerSandboxEnabled } from './docker_sandbox.js';
import { config } from '../../../config.js';
import { writeValidateScripts, writeSearchAssetsTool, writeLibraryTool } from './sandbox_validate.js';
import { generateAssetCatalog } from './cli_creator.js';

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
    usedWarmSession?: boolean;
    resumedPrevious?: boolean;
}

export async function runFixer(
    projectId: string,
    description: string,
    projectFiles: ProjectFiles,
    activeSceneKey: string,
    sendStatus?: (msg: string) => void,
    abortSignal?: AbortSignal,
    cliOverride?: string,
    chatHistory?: string,
): Promise<FixerResult> {
    // Per-project preemption: at most one CLI run per project. If someone
    // else is already working on this project (fix or create), kill it
    // and wait for its finally block to unwind before we start. Old runs
    // are cheap to lose; what's expensive is two CLIs racing each other's
    // project_data writes. preemptGenerationJob covers CREATE_GAMEs that
    // are still in generation_jobs' local map but haven't reached their
    // cli_active_jobs registration yet (queue wait window).
    await preemptGenerationJob(projectId);
    await preemptProjectJob(projectId);

    // Local AbortController so the registry entry can kill us from
    // outside (preemptProjectJob calls abort()). Mirrors the caller's
    // signal — a Stop from the chat UI still cancels the run.
    const abortController = new AbortController();
    if (abortSignal) {
        if (abortSignal.aborted) abortController.abort();
        else abortSignal.addEventListener('abort', () => abortController.abort());
    }
    const localSignal = abortController.signal;

    const jobId = randomUUID();

    // Register BEFORE acquireCLISlot so the per-project lock holds even
    // while we're queued. Without this, two fixes on the same project
    // could both enter the queue and only start racing once both got
    // their slots. Paired with unregisterActiveJob in the finally.
    let registered = false;
    try {
        registerActiveJob({
            jobId,
            cli: resolveCLI(cliOverride),
            kind: 'fix',
            projectId,
            description,
            startedAt: Date.now(),
            abort: () => abortController.abort(),
        });
        registered = true;
    } catch { /* best-effort — don't let observability break the run */ }

    // acquireCLISlot is the first thing that can throw after we've claimed
    // the per-project lock. If it does (queue abort, config error), we
    // must drop the lock before bubbling — the outer try/finally below
    // hasn't entered yet, so its cleanup won't run.
    try {
        await acquireCLISlot({ cliOverride, sendStatus, jobId });
    } catch (e) {
        if (registered) { try { unregisterActiveJob(jobId); } catch {} }
        throw e;
    }
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

    try {
        sendStatus?.('Setting up sandbox...');
        await createSandbox(sandboxDir, projectFiles, description);

        // Drop the config where validate_assembler.js can find it. Done
        // after createSandbox so the sandbox dir is guaranteed to exist.
        fs.writeFileSync(
            path.join(sandboxDir, '.validate_config.json'),
            JSON.stringify({ url: validateBackendUrl, token: validateToken }),
        );
        const searchPublicUrl = config.isHosted
            ? config.assetsCdn
            : `http://localhost:${config.port}`;
        fs.writeFileSync(
            path.join(sandboxDir, '.search_config.json'),
            JSON.stringify({ url: validateBackendUrl, fallbackUrl: searchPublicUrl, token: process.env.INTERNAL_API_TOKEN || '' }),
        );

        const projectSummary = buildProjectSummary(sandboxDir, projectFiles, activeSceneKey);
        let taskContent = `# Bug Report\n\n${description}\n\n# Current Project State\n\n${projectSummary}`;
        if (chatHistory) {
            taskContent += `\n\n# Chat History\n\nThis is the recent conversation between the user and the AI assistant before this fix was requested. Use it to understand context — what the user already tried, what they're expecting, etc.\n\n${chatHistory}`;
        }
        fs.writeFileSync(path.join(sandboxDir, 'TASK.md'), taskContent);

        sendStatus?.('Editing Agent is analyzing and coding...');
        const cliResult = await spawnCLI(sandboxDir, sendStatus, localSignal, cliOverride, { jobId, projectId });

        try { registerFixSession(projectId, sandboxDir); } catch {}

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
                usedWarmSession: cliResult.usedWarmSession,
                resumedPrevious: cliResult.resumedPrevious,
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
                usedWarmSession: cliResult.usedWarmSession,
                resumedPrevious: cliResult.resumedPrevious,
            };
        }

        return {
            success: true,
            summary: cliResult.text || `Fixed ${changes.filesChanged.length} file(s).`,
            filesChanged: changes.filesChanged,
            changedFiles: changes.changedFiles,
            deletedFiles: changes.deletedFiles,
            costUsd: cliResult.costUsd,
            usedWarmSession: cliResult.usedWarmSession,
            resumedPrevious: cliResult.resumedPrevious,
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

    // Reference: behaviors/systems/ui are NOT in the sandbox anymore — they're
    // served by library.sh on demand (see writeLibraryTool). This is the L2
    // step from docs/LIBRARY_TOOL_PLAN.md. The agent uses `bash library.sh
    // search / show` to reach any library file it needs.
    const refDir = path.join(sandboxDir, 'reference');
    fs.mkdirSync(refDir, { recursive: true });

    // Convenience: event_definitions.ts is referenced by every fix (the
    // agent checks valid event names before emit/listen). Keep a pointer
    // copy in reference/ so it's trivially reachable via Read without a
    // library.sh call.
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

    const assetsDir = path.join(sandboxDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    generateAssetCatalog(assetsDir);

    writeValidateScripts(sandboxDir);
    writeSearchAssetsTool(sandboxDir);
    writeLibraryTool(sandboxDir);
}

// ─── CLI spawning ──────────────────────────────────────────────────────────

// Engine docs + rules live in CLAUDE.md / AGENTS.md, which each CLI auto-loads
// into its system prompt — no Read call needed. Keep this prompt to the
// per-run instructions only.
const FIXER_PROMPT = `Read TASK.md for the bug report and project state. Edit template files in project/ to fix the bug (the 4 JSONs + pinned behaviors/, systems/, ui/, scripts/ — never assembled output). To use a behavior/system/UI panel not yet in project/, find it with "bash library.sh search \\"<intent>\\"", fetch it with "bash library.sh show <path>", and Write it into project/. The library is NOT in reference/ anymore — use the tool. Run "bash validate.sh" when done. Be concise — fix the bug, don't refactor. If the user's request in TASK.md is in a non-English language, write any new in-game UI text in that same language.`;

const FIXER_PROMPT_WARM = `You are already primed with the engine docs. Now read TASK.md for the bug report and project state. Read the project files in project/. Fix the bug — edit template files only (the 4 JSONs + pinned behaviors/, systems/, ui/, scripts/). If you need a library behavior/system/UI panel not in project/, use "bash library.sh {search|show}" to find and fetch it, then Write it into project/. Run "bash validate.sh" when done. Be concise — fix the bug, don't refactor. If the user's request in TASK.md is in a non-English language, write any new in-game UI text in that same language.`;

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

const FIXER_PROMPT_RESUME = `You previously worked on this project. The project files in project/ may have changed since your last session — re-read any files you need before editing. Read TASK.md for the new bug report. Fix the bug — edit template files only. Run "bash validate.sh" when done. Be concise — fix the bug, don't refactor. If the user's request in TASK.md is in a non-English language, write any new in-game UI text in that same language.`;

async function spawnCLI(sandboxDir: string, sendStatus?: (msg: string) => void, abortSignal?: AbortSignal, cliOverride?: string, capture?: { jobId: string; projectId: string }): Promise<{ text: string; costUsd: number; usedWarmSession?: boolean; resumedPrevious?: boolean }> {
    const cli = resolveCLI(cliOverride);
    const projectId = capture?.projectId;
    const jobId = capture?.jobId;

    if (cli === 'claude' && projectId) {
        const resumedFromPrev = forkPreviousFixSession(projectId, sandboxDir);
        if (resumedFromPrev) {
            try {
                sendStatus?.('Resuming from previous fix session...');
                if (jobId) updateJobSessionType(jobId, 'resume');
                const result = await spawnCLIAgent({
                    sandboxDir,
                    prompt: FIXER_PROMPT_RESUME,
                    maxTurns: 30,
                    claudeModel: 'sonnet',
                    continueForked: true,
                    sessionType: 'resume',
                    statusMapper: fixerStatus,
                    sendStatus,
                    abortSignal,
                    cliOverride,
                    capture: capture ? { ...capture, kind: 'fix' } : undefined,
                });
                return { text: result.text, costUsd: result.costUsd, usedWarmSession: false, resumedPrevious: true };
            } catch (e: any) {
                console.warn(`[CLIFixer] Resume from previous session failed, trying warm fork:`, e?.message);
            }
        }
    }

    if (cli === 'claude') {
        sendStatus?.('Waiting for warm session...');
        await Promise.race([warmIfNeeded('fixer'), new Promise(r => setTimeout(r, 60_000))]);
        const forked = forkSession('fixer', sandboxDir);
        if (forked) {
            try {
                sendStatus?.('Using pre-warmed session...');
                if (jobId) updateJobSessionType(jobId, 'warm_fork');
                const result = await spawnCLIAgent({
                    sandboxDir,
                    prompt: FIXER_PROMPT_WARM,
                    maxTurns: 30,
                    claudeModel: 'sonnet',
                    continueForked: true,
                    sessionType: 'warm_fork',
                    statusMapper: fixerStatus,
                    sendStatus,
                    abortSignal,
                    cliOverride,
                    capture: capture ? { ...capture, kind: 'fix' } : undefined,
                });
                return { text: result.text, costUsd: result.costUsd, usedWarmSession: true };
            } catch (e: any) {
                console.warn(`[CLIFixer] Warm fork failed, falling back to cold start:`, e?.message);
                sendStatus?.('Warm session failed — starting fresh...');
            }
        }
    }

    if (jobId) updateJobSessionType(jobId, 'cold');
    const result = await spawnCLIAgent({
        sandboxDir,
        prompt: FIXER_PROMPT,
        maxTurns: 30,
        claudeModel: 'sonnet',
        statusMapper: fixerStatus,
        sendStatus,
        abortSignal,
        cliOverride,
        capture: capture ? { ...capture, kind: 'fix' } : undefined,
    });
    return { text: result.text, costUsd: result.costUsd, usedWarmSession: false };
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
