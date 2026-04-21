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
    parseProjectData,
    isLegacyProjectData,
    ENGINE_MACHINERY,
} from './project_files.js';
import db from '../../../db/connection.js';
import { spawnCLIAgent, CLIActivity, acquireCLISlot, releaseCLISlot, resolveCLI, CLIRunResult } from './cli_runner.js';
import { forkSession, warmIfNeeded } from './session_warmer.js';
import { registerActiveJob, unregisterActiveJob, preemptProjectJob } from './cli_active_jobs.js';
import { registerSandboxToken, unregisterSandboxToken } from './sandbox_validator.js';
import { isDockerSandboxEnabled } from './docker_sandbox.js';
import { pickRelevantLibrary, copyPickedLibraryFiles } from './library_index.js';
import { archiveCreatorSandbox } from './sandbox_archive.js';
import { writeValidateScripts, writeSearchAssetsTool } from './sandbox_validate.js';

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
    usedWarmSession?: boolean;
}

export async function runCreator(
    projectId: string,
    description: string,
    sendStatus?: (msg: string) => void,
    cliOverride?: string,
    abortSignal?: AbortSignal,
    jobId?: string,
    chatHistory?: string,
): Promise<CreatorResult> {
    // Local AbortController so the cli_active_jobs entry can kill this
    // run from outside — when a newer FIX_GAME or CREATE_GAME on the
    // same project calls preemptProjectJob, it fires our abort()
    // callback and we unwind. The external signal (from the WS client's
    // Stop button) is forwarded into this controller, so either path
    // aborts the run.
    const abortController = new AbortController();
    if (abortSignal) {
        if (abortSignal.aborted) abortController.abort();
        else abortSignal.addEventListener('abort', () => abortController.abort());
    }
    const localSignal = abortController.signal;

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
            abort: () => abortController.abort(),
        });
        registered = true;
    } catch { /* observability only — don't let it break the run */ }

    // Collected so the finally block can archive the sandbox with the right
    // status (success vs. failed) + summary + cost regardless of which exit
    // path we took. Stays null if the body throws — archive treats that as
    // failed, which matches the caller's view.
    let finalResult: CreatorResult | null = null;
    const runStartedAt = Date.now();

    // Snapshot the project's current file tree before we build the
    // sandbox so we can drop it in reference/previous_project/ for
    // the agent's optional use. Read once here, outside the try so a
    // failed DB read doesn't obscure a creation failure. NULL is
    // expected for brand-new projects.
    let previousProjectFiles: ProjectFiles | null = null;
    try {
        const row = db.prepare('SELECT project_data FROM projects WHERE id = ?').get(projectId) as { project_data?: string } | undefined;
        if (row?.project_data) {
            const pd = parseProjectData(row.project_data);
            if (!isLegacyProjectData(pd) && pd.files && Object.keys(pd.files).length > 0) {
                previousProjectFiles = pd.files;
            }
        }
    } catch (e: any) {
        console.warn('[CLICreator] failed to read previous project files:', e?.message);
    }

    try {
      finalResult = await (async (): Promise<CreatorResult> => {
        sendStatus?.('Setting up creation sandbox...');
        await createSandbox(sandboxDir, description, previousProjectFiles);

        // Drop the config where validate_assembler.js can find it. Done
        // after createSandbox (which rewrites assets) so we don't race
        // with any sandbox seeding step that could clobber the file.
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

        let taskContent = `# Game to Create\n\n${description}\n\n# Template ID\n\n${templateId}\n\nFill in the project files in project/ — the 4 template JSONs (01_flow.json / 02_entities.json / 03_worlds.json / 04_systems.json), pinned behaviors in project/behaviors/, systems in project/systems/, UI panels in project/ui/, and any custom scripts in project/scripts/. The reference/ directory has the latest shared library to copy from. Run "bash validate.sh" before finishing.${validEventsList}`;
        if (chatHistory) {
            taskContent += `\n\n# Chat History\n\nThis is the recent conversation between the user and the AI assistant before this build was requested. Use it to understand the user's intent and any specific requirements they mentioned.\n\n${chatHistory}`;
        }
        fs.writeFileSync(path.join(sandboxDir, 'TASK.md'), taskContent);

        sendStatus?.('Creator agent is building the game...');
        const cliResult = await spawnCLI(sandboxDir, sendStatus, cliOverride, localSignal, { jobId: registryJobId, projectId });

        sendStatus?.('Reading created files...');
        const projectDir = path.join(sandboxDir, 'project');
        let files = readFilesFromDir(projectDir);

        if (!files['01_flow.json'] || !files['02_entities.json']) {
            return { success: false, summary: 'Creator did not produce required template files.', templateId, files, costUsd: cliResult.costUsd, sessionCapturePath: cliResult.sessionCapturePath };
        }

        // The CLI may exit "successfully" (exit code 0, valid cost event)
        // without ever modifying the seeded scaffold — opencode in particular
        // has been observed to terminate early with no file writes. Without
        // this guard we'd commit the empty scaffold back to the user's
        // project and cheerfully report "game created" — exactly what they
        // got for projectId de549996 on 2026-04-16.
        const seed = emptyTemplateFiles();
        if (files['01_flow.json'] === seed['01_flow.json']) {
            return { success: false, summary: 'Creator finished but did not modify 01_flow.json — the agent exited without writing any game content.', templateId, files, costUsd: cliResult.costUsd, sessionCapturePath: cliResult.sessionCapturePath };
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
            if (localSignal.aborted) {
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
                retryResult = await spawnCLI(sandboxDir, sendStatus, cliOverride, localSignal, { jobId: registryJobId, projectId });
            } catch (e: any) {
                return {
                    success: false,
                    summary: `Template validation failed and retry spawn errored: ${e?.message || e}\n\nOriginal error: ${assembleErr.message}`,
                    templateId,
                    files,
                    costUsd: cliResult.costUsd, sessionCapturePath: cliResult.sessionCapturePath,
                };
            }
            // Accumulate cost so the retry isn't invisible to usage.
            cliResult.costUsd += retryResult.costUsd;
            if (retryResult.text) cliResult.text = retryResult.text;
            if (retryResult.sessionCapturePath) cliResult.sessionCapturePath = retryResult.sessionCapturePath;

            if (localSignal.aborted) {
                return { success: false, summary: 'Aborted during retry.', templateId, files: null, costUsd: cliResult.costUsd, sessionCapturePath: cliResult.sessionCapturePath };
            }

            sendStatus?.('Reading retried files...');
            files = readFilesFromDir(projectDir);
            if (!files['01_flow.json'] || !files['02_entities.json']) {
                return { success: false, summary: `Retry removed required template files. Original error: ${assembleErr.message}`, templateId, files, costUsd: cliResult.costUsd, sessionCapturePath: cliResult.sessionCapturePath };
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
                    files,
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
            usedWarmSession: cliResult.usedWarmSession,
        };
      })();
      return finalResult;
    } finally {
        // Admin-only snapshot of the sandbox's project/ tree + TASK.md.
        // Runs for both success AND failure so we can diff broken outputs
        // against working ones later. Best-effort — a failed archive must
        // never break the run, so errors are swallowed inside the helper.
        try {
            archiveCreatorSandbox(sandboxDir, {
                jobId: registryJobId,
                projectId,
                description,
                templateId,
                status: finalResult?.success ? 'success' : 'failed',
                summary: finalResult?.summary,
                costUsd: finalResult?.costUsd,
                durationMs: Date.now() - runStartedAt,
                sessionCapturePath: finalResult?.sessionCapturePath,
            });
        } catch {}
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

async function createSandbox(
    sandboxDir: string,
    description: string,
    previousProjectFiles: ProjectFiles | null,
): Promise<void> {
    // sandboxDir is freshly created by mkdtempSync in the caller — already
    // exists and is empty, so no nuke-and-recreate needed here.

    // Project: only engine machinery (pre-installed systems). The 4 template
    // JSONs are NOT seeded — the agent writes them fresh from the patterns
    // it learned in the warm session / reference templates. Skipping the
    // empty scaffold saves 4 Read turns (Claude's Write tool requires
    // reading existing files before overwriting).
    const projectDir = path.join(sandboxDir, 'project');
    const seed: ProjectFiles = {};
    for (const rel of ENGINE_MACHINERY) {
        const sub = rel.replace(/^systems\//, '');
        const src = path.join(RGC_DIR, 'systems', 'v0.1', sub);
        if (fs.existsSync(src)) seed[rel] = fs.readFileSync(src, 'utf-8');
    }
    fs.mkdirSync(path.join(projectDir, 'behaviors'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'ui'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
    writeFilesToDir(seed, projectDir);

    // Reference: game_templates kept whole (40 templates × 4 small JSONs —
    // cheap and the agent picks one by name). behaviors/systems/ui are
    // filtered by semantic similarity to the game description so the agent
    // isn't swimming through hundreds of irrelevant files.
    const refDir = path.join(sandboxDir, 'reference');
    copyDirRecursive(path.join(RGC_DIR, 'game_templates', 'v0.1'), path.join(refDir, 'game_templates'));

    const picks = await pickRelevantLibrary(description);
    copyPickedLibraryFiles(picks, refDir);

    // If the user had existing project files (e.g. a template they'd
    // been tweaking), drop the whole tree into reference/previous_project/
    // plus a short README that tells the agent how to use it. CREATE_GAME
    // is a from-scratch rebuild so we don't seed this into project/; but
    // often the new brief is a variant of what's already there (same
    // theme, same mechanics, different twist) and the old file tree is
    // the richest possible worked example. CREATOR_CONTEXT.md tells the
    // agent to use it for continuity if the brief is a variant, ignore
    // if the brief is a completely different game.
    if (previousProjectFiles && Object.keys(previousProjectFiles).length > 0) {
        const prevDir = path.join(refDir, 'previous_project');
        writeFilesToDir(previousProjectFiles, prevDir);
        fs.writeFileSync(path.join(prevDir, 'README.md'),
            '# Previous project — use with caution\n\n' +
            '⚠️ This directory contains the files that were in the project ' +
            'BEFORE the user asked to create from scratch. These files are ' +
            'often an UNRELATED template that was auto-loaded by the system ' +
            '(e.g. a chess template loaded before the user asked for a tower ' +
            'defense game).\n\n' +
            '## How to decide:\n' +
            '1. Read the user\'s description in TASK.md first.\n' +
            '2. If the previous project is clearly the same genre/theme as ' +
            'what the user wants, feel free to borrow ideas, entity layouts, ' +
            'or UI patterns from it.\n' +
            '3. If the previous project is a DIFFERENT genre or theme, ignore ' +
            'this directory. Build from reference/game_templates/ instead.\n' +
            '4. NEVER copy the previous project\'s structure wholesale — the ' +
            'user asked to create from scratch for a reason.\n',
        );
    }

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
    await generateSuggestedAssets(assetsDir, description);

    writeValidateScripts(sandboxDir);
    writeSearchAssetsTool(sandboxDir);
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

export function generateAssetCatalog(assetsDir: string): void {
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

/**
 * Semantic asset suggestion. Embeds asset pack directory names with the
 * same MiniLM model used by library_index, caches vectors to disk, and
 * returns the top-K most relevant packs for a game description. Each
 * pack's files are extracted from the full asset catalogs.
 */

import {
    initEmbedder,
    embedText,
    embedTexts,
    cosineSimilarity,
} from '../../../embedding_service.js';

const ASSET_EMBEDDINGS_CACHE = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '.asset_embeddings_cache.json',
);

interface AssetPackEntry {
    dirName: string;
    humanName: string;
}

let _assetPackCache: { fingerprint: string; packs: AssetPackEntry[]; vectors: number[][] } | null = null;

function scanAssetPacks(): AssetPackEntry[] {
    const packs: AssetPackEntry[] = [];
    if (!fs.existsSync(ASSETS_DIR)) return packs;

    for (const vendor of fs.readdirSync(ASSETS_DIR, { withFileTypes: true })) {
        if (!vendor.isDirectory() || vendor.name === 'thumbnails') continue;
        const vendorPath = path.join(ASSETS_DIR, vendor.name);
        for (const category of fs.readdirSync(vendorPath, { withFileTypes: true })) {
            if (!category.isDirectory()) continue;
            const catPath = path.join(vendorPath, category.name);
            if (category.name === 'textures') {
                packs.push({
                    dirName: `${vendor.name}/${category.name}`,
                    humanName: `${vendor.name} ${category.name}`.replace(/_/g, ' '),
                });
                continue;
            }
            for (const pack of fs.readdirSync(catPath, { withFileTypes: true })) {
                if (!pack.isDirectory()) continue;
                packs.push({
                    dirName: `${vendor.name}/${category.name}/${pack.name}`,
                    humanName: pack.name.replace(/_/g, ' '),
                });
            }
        }
    }
    return packs;
}

async function getAssetPackVectors(): Promise<{ packs: AssetPackEntry[]; vectors: number[][] }> {
    const packs = scanAssetPacks();
    const { createHash } = await import('crypto');
    const fp = createHash('md5').update(packs.map(p => p.dirName).join('\n')).digest('hex');

    if (_assetPackCache && _assetPackCache.fingerprint === fp) {
        return { packs: _assetPackCache.packs, vectors: _assetPackCache.vectors };
    }

    try {
        if (fs.existsSync(ASSET_EMBEDDINGS_CACHE)) {
            const cached = JSON.parse(fs.readFileSync(ASSET_EMBEDDINGS_CACHE, 'utf-8'));
            if (cached.fingerprint === fp && cached.vectors?.length === packs.length) {
                _assetPackCache = { fingerprint: fp, packs, vectors: cached.vectors };
                return { packs, vectors: cached.vectors };
            }
        }
    } catch {}

    await initEmbedder();
    const vectors = await embedTexts(packs.map(p => p.humanName));
    _assetPackCache = { fingerprint: fp, packs, vectors };
    try {
        fs.writeFileSync(ASSET_EMBEDDINGS_CACHE, JSON.stringify({ fingerprint: fp, vectors }));
    } catch {}
    return { packs, vectors };
}

async function generateSuggestedAssets(assetsDir: string, description: string): Promise<void> {
    const TOP_K = 10;
    let queryVec: number[];
    let packData: { packs: AssetPackEntry[]; vectors: number[][] };

    try {
        await initEmbedder();
        queryVec = await embedText(description);
        packData = await getAssetPackVectors();
    } catch (e: any) {
        console.warn('[CLICreator] Asset suggestion embedding failed (non-fatal):', e?.message);
        return;
    }

    const scored = packData.packs.map((p, i) => ({
        ...p,
        score: cosineSimilarity(queryVec, packData.vectors[i]),
    }));
    scored.sort((a, b) => b.score - a.score);
    if (scored[0]?.score < 0.3) return;
    const topPacks = scored.filter(s => s.score >= 0.15).slice(0, TOP_K);

    const lines: string[] = [
        '# Suggested Assets',
        '',
        'Asset packs matching your game description, ranked by relevance.',
        'Use these paths directly in entity definitions and scripts.',
        '',
    ];

    for (const catalog of ['3D_MODELS.md', 'AUDIO.md', 'TEXTURES.md']) {
        const catalogPath = path.join(assetsDir, catalog);
        if (!fs.existsSync(catalogPath)) continue;
        const content = fs.readFileSync(catalogPath, 'utf-8');
        const matches: string[] = [];
        for (const line of content.split('\n')) {
            if (!line.startsWith('- ')) continue;
            const assetPath = line.slice(2).trim();
            if (topPacks.some(p => assetPath.toLowerCase().includes(p.dirName.split('/').pop()!.toLowerCase()))) {
                matches.push(line);
            }
        }
        if (matches.length > 0) {
            lines.push(`## ${catalog.replace('.md', '')}`, '');
            for (const m of matches) lines.push(m);
            lines.push('');
        }
    }

    if (lines.length > 6) {
        fs.writeFileSync(path.join(assetsDir, 'SUGGESTED_ASSETS.md'), lines.join('\n'));
    }
}

// Validation scripts (validate.sh, validate_headless.js, validate_assembler.js)
// live in ./sandbox_validate.ts — shared between creator + fixer to avoid
// drift. The previous hand-rolled copies had silently diverged; the fixer
// was missing the strict assembler check entirely.

// ─── CLI spawning ──────────────────────────────────────────────────────────

// Template-format docs + rules live in CLAUDE.md / AGENTS.md, which each CLI
// auto-loads into its system prompt — no Read call needed.
const CREATOR_PROMPT = `Read TASK.md for the game description and baseline event list — use those events unless you add a new one to project/systems/event_definitions.ts. Use "bash search_assets.sh \\"query\\"" to find 3D models, audio, and textures (do NOT read the full catalog files). reference/game_templates/ has working examples; reference/behaviors|systems|ui/ has library files to copy into project/. Fill in the 4 JSON template files plus pinned behaviors/, systems/, ui/, and any custom scripts/ under project/. Run "bash validate.sh" when done and fix any errors. If the user's game description in TASK.md is in a non-English language, write all in-game UI text (HUD, menus, buttons, instructions, messages) in that same language.`;

const CREATOR_PROMPT_WARM = `You have already read the game templates and engine machinery in your previous turns. Now read TASK.md for the game description and baseline event list. Use "bash search_assets.sh \\"query\\"" to find 3D models, audio, and textures (do NOT read the full catalog files). Create the game template in project/ following the patterns you've already seen. Copy any needed library files from reference/ into project/. Run "bash validate.sh" when done and fix any errors. If the user's game description in TASK.md is in a non-English language, write all in-game UI text (HUD, menus, buttons, instructions, messages) in that same language.`;

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

async function spawnCLI(sandboxDir: string, sendStatus?: (msg: string) => void, cliOverride?: string, abortSignal?: AbortSignal, capture?: { jobId: string; projectId: string; userId?: number; username?: string }): Promise<{ text: string; costUsd: number; sessionCapturePath?: string | null; usedWarmSession?: boolean }> {
    const cli = resolveCLI(cliOverride);
    let usedWarmSession = false;

    if (cli === 'claude') {
        sendStatus?.('Waiting for warm session...');
        await Promise.race([warmIfNeeded('creator'), new Promise(r => setTimeout(r, 60_000))]);
        const forked = forkSession('creator', sandboxDir);
        if (forked) {
            try {
                sendStatus?.('Using pre-warmed session...');
                const result = await spawnCLIAgent({
                    sandboxDir,
                    prompt: CREATOR_PROMPT_WARM,
                    maxTurns: 120,
                    timeout: 45 * 60 * 1000,
                    claudeModel: 'claude-opus-4-6',
                    continueForked: true,
                    sessionType: 'warm_fork',
                    statusMapper: creatorStatus,
                    sendStatus,
                    cliOverride,
                    abortSignal,
                    capture: capture ? { ...capture, kind: 'create' } : undefined,
                });
                usedWarmSession = true;
                return { text: result.text || 'Template created.', costUsd: result.costUsd, sessionCapturePath: result.sessionCapturePath, usedWarmSession };
            } catch (e: any) {
                console.warn(`[CLICreator] Warm fork failed, falling back to cold start:`, e?.message);
                sendStatus?.('Warm session failed — starting fresh...');
            }
        }
    }

    const { text, costUsd, sessionCapturePath } = await spawnCLIAgent({
        sandboxDir,
        prompt: CREATOR_PROMPT,
        maxTurns: 120,
        timeout: 45 * 60 * 1000,
        claudeModel: 'claude-opus-4-6',
        statusMapper: creatorStatus,
        sendStatus,
        cliOverride,
        abortSignal,
        capture: capture ? { ...capture, kind: 'create' } : undefined,
    });
    return { text: text || 'Template created.', costUsd, sessionCapturePath, usedWarmSession };
}
