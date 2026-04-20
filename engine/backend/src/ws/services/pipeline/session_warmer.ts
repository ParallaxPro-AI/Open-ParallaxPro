/**
 * session_warmer.ts — pre-warm Claude Code sessions with static reference files.
 *
 * CREATE_GAME and FIX_GAME both spend their first 5-10 turns reading static
 * files (game templates, library behaviors, asset catalogs, etc.). This module
 * pre-reads those files into a Claude session using haiku, then forks that
 * session for real runs so the agent starts with everything already in context.
 *
 * Prompt caching makes the forked prefix ~90% cheaper on every subsequent turn.
 *
 * Only supports Claude — other CLIs (codex, opencode, copilot) skip warming.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { config } from '../../../config.js';
import { pickRelevantLibrary, copyPickedLibraryFiles } from './library_index.js';
import { writeValidateScripts } from './sandbox_validate.js';
import {
    writeFilesToDir,
    ENGINE_MACHINERY,
} from './project_files.js';

const __dirname_warmer = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname_warmer, 'reusable_game_components');
const CREATOR_CONTEXT_PATH = path.join(__dirname_warmer, 'CREATOR_CONTEXT.md');
const FIXER_CONTEXT_PATH = path.join(__dirname_warmer, 'FIXER_CONTEXT.md');
const ASSETS_DIR = config.assetsDir;

// Persistent warm sandbox dirs (survive across warm cycles for session reuse)
const WARM_DIR_BASE = '/tmp/parallaxpro-warm';
const WARM_CREATOR_DIR = path.join(WARM_DIR_BASE, 'creator');
const WARM_FIXER_DIR = path.join(WARM_DIR_BASE, 'fixer');

export type WarmKind = 'creator' | 'fixer';
export type WarmStatus = 'not_warm' | 'warming' | 'warm' | 'error';

interface WarmState {
    status: WarmStatus;
    contentHash: string | null;
    sessionId: string | null;
    warmSandboxDir: string;
    lastWarmedAt: number | null;
    error: string | null;
}

const states: Record<WarmKind, WarmState> = {
    creator: { status: 'not_warm', contentHash: null, sessionId: null, warmSandboxDir: WARM_CREATOR_DIR, lastWarmedAt: null, error: null },
    fixer:   { status: 'not_warm', contentHash: null, sessionId: null, warmSandboxDir: WARM_FIXER_DIR,   lastWarmedAt: null, error: null },
};

const inflightWarm: Record<WarmKind, Promise<void> | null> = { creator: null, fixer: null };

// ─── Public API ──────────────────────────────────────────────────────────────

export function getWarmStatus(): Record<WarmKind, { status: WarmStatus; lastWarmedAt: number | null; contentHash: string | null; error: string | null }> {
    return {
        creator: { status: states.creator.status, lastWarmedAt: states.creator.lastWarmedAt, contentHash: states.creator.contentHash, error: states.creator.error },
        fixer:   { status: states.fixer.status,   lastWarmedAt: states.fixer.lastWarmedAt,   contentHash: states.fixer.contentHash,   error: states.fixer.error },
    };
}

export function warmIfNeeded(kind: WarmKind): Promise<void> {
    const state = states[kind];

    const hash = computeContentHash(kind);
    if (state.status === 'warm' && state.contentHash === hash && state.sessionId) {
        const claudeProjectDir = getClaudeProjectDir(state.warmSandboxDir);
        if (claudeProjectDir && fs.existsSync(path.join(claudeProjectDir, state.sessionId + '.jsonl'))) {
            return Promise.resolve();
        }
    }

    if (inflightWarm[kind]) return inflightWarm[kind]!;

    state.status = 'warming';
    state.error = null;
    console.log(`[SessionWarmer] Warming ${kind} session...`);

    const p = (async () => {
        try {
            await buildWarmSandbox(kind);
            const sessionId = await runWarmAgent(kind);
            state.sessionId = sessionId;
            state.contentHash = hash;
            state.lastWarmedAt = Date.now();
            state.status = 'warm';
            try {
                fs.writeFileSync(
                    path.join(WARM_DIR_BASE, `${kind}_meta.json`),
                    JSON.stringify({ contentHash: hash, sessionId, lastWarmedAt: state.lastWarmedAt }),
                );
            } catch {}
            console.log(`[SessionWarmer] ${kind} session warm (session=${sessionId}, hash=${hash.slice(0, 12)})`);
        } catch (e: any) {
            state.status = 'error';
            state.error = e?.message || String(e);
            console.error(`[SessionWarmer] Failed to warm ${kind}:`, state.error);
        } finally {
            inflightWarm[kind] = null;
        }
    })();

    inflightWarm[kind] = p;
    return p;
}

/**
 * Fork a warm session into a new sandbox directory. Copies the session JSONL
 * so `claude --continue --fork-session` picks it up.
 *
 * Returns true if forking succeeded, false if not warm or copy failed.
 */
export function forkSession(kind: WarmKind, targetSandboxDir: string): boolean {
    const state = states[kind];
    if (state.status !== 'warm' || !state.sessionId) return false;

    const sourceProjectDir = getClaudeProjectDir(state.warmSandboxDir);
    if (!sourceProjectDir) return false;

    const sourceJsonl = path.join(sourceProjectDir, state.sessionId + '.jsonl');
    if (!fs.existsSync(sourceJsonl)) {
        console.warn(`[SessionWarmer] Warm session JSONL missing: ${sourceJsonl}`);
        state.status = 'not_warm';
        return false;
    }

    const targetProjectDir = getClaudeProjectDir(targetSandboxDir);
    if (!targetProjectDir) return false;

    try {
        fs.mkdirSync(targetProjectDir, { recursive: true });
        fs.copyFileSync(sourceJsonl, path.join(targetProjectDir, state.sessionId + '.jsonl'));
        return true;
    } catch (e: any) {
        console.warn(`[SessionWarmer] Failed to fork session:`, e?.message);
        return false;
    }
}

export function invalidate(kind: WarmKind): void {
    const state = states[kind];
    state.status = 'not_warm';
    state.sessionId = null;
    state.contentHash = null;
    state.lastWarmedAt = null;
    state.error = null;
}

// ─── Per-project fix session reuse ──────────────────────────────────────────
//
// When a user repeatedly fixes the same project, we reuse the previous fix
// session so the agent already has context about the project's codebase.

const projectFixSessions = new Map<string, { sessionId: string; claudeProjectDir: string }>();

/**
 * After a FIX_GAME completes, register the session so the next fix on the
 * same project can resume from it.
 */
export function registerFixSession(projectId: string, sandboxDir: string): void {
    const claudeProjectDir = getClaudeProjectDir(sandboxDir);
    if (!claudeProjectDir) return;
    const sessionId = findLatestSessionId(sandboxDir);
    if (!sessionId) return;
    projectFixSessions.set(projectId, { sessionId, claudeProjectDir });
}

/**
 * Fork a previous fix session for the same project into a new sandbox.
 * Returns true if a previous session existed and was copied successfully.
 */
export function forkPreviousFixSession(projectId: string, targetSandboxDir: string): boolean {
    const prev = projectFixSessions.get(projectId);
    if (!prev) return false;

    const sourceJsonl = path.join(prev.claudeProjectDir, prev.sessionId + '.jsonl');
    if (!fs.existsSync(sourceJsonl)) {
        projectFixSessions.delete(projectId);
        return false;
    }

    const targetProjectDir = getClaudeProjectDir(targetSandboxDir);
    if (!targetProjectDir) return false;

    try {
        fs.mkdirSync(targetProjectDir, { recursive: true });
        fs.copyFileSync(sourceJsonl, path.join(targetProjectDir, prev.sessionId + '.jsonl'));
        return true;
    } catch (e: any) {
        console.warn(`[SessionWarmer] Failed to fork previous fix session:`, e?.message);
        return false;
    }
}

/**
 * Initialize on server boot. Checks if existing warm sessions are still
 * valid (hash matches, JSONL on disk). Only re-warms if static content
 * changed. Non-blocking — failures never prevent the server from starting.
 */
export function initWarmer(): void {
    fs.mkdirSync(WARM_DIR_BASE, { recursive: true });
    for (const kind of ['creator', 'fixer'] as WarmKind[]) {
        try {
            recoverExistingSession(kind);
        } catch (e: any) {
            console.warn(`[SessionWarmer] Recovery failed for ${kind}, warming in background:`, e?.message);
            warmIfNeeded(kind).catch(() => {});
        }
    }
}

function recoverExistingSession(kind: WarmKind): void {
    const state = states[kind];
    const hash = computeContentHash(kind);
    const claudeProjectDir = getClaudeProjectDir(state.warmSandboxDir);
    if (!claudeProjectDir || !fs.existsSync(claudeProjectDir)) {
        console.log(`[SessionWarmer] No existing ${kind} session dir — warming in background`);
        warmIfNeeded(kind).catch(() => {});
        return;
    }

    const sessionId = findLatestSessionId(state.warmSandboxDir);
    if (!sessionId) {
        console.log(`[SessionWarmer] No ${kind} session JSONL found — warming in background`);
        warmIfNeeded(kind).catch(() => {});
        return;
    }

    const metaPath = path.join(WARM_DIR_BASE, `${kind}_meta.json`);
    let metaHash: string | null = null;
    try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        metaHash = meta.contentHash;
        if (meta.contentHash === hash && meta.sessionId === sessionId) {
            state.status = 'warm';
            state.contentHash = hash;
            state.sessionId = sessionId;
            state.lastWarmedAt = meta.lastWarmedAt || null;
            console.log(`[SessionWarmer] Recovered existing ${kind} session (hash=${hash.slice(0, 12)})`);
            return;
        }
    } catch {}

    if (!metaHash) {
        console.log(`[SessionWarmer] No ${kind} meta file — warming in background`);
        warmIfNeeded(kind).catch(() => {});
        return;
    }

    console.log(`[SessionWarmer] ${kind} hash changed (${(metaHash || '?').slice(0, 12)} → ${hash.slice(0, 12)}) — re-warming in background`);
    warmIfNeeded(kind).catch(() => {});
}

// ─── Internals ───────────────────────────────────────────────────────────────

function getClaudeProjectDir(sandboxDir: string): string | null {
    const home = process.env.HOME || '/tmp';
    try {
        const resolved = fs.realpathSync(sandboxDir);
        const encoded = resolved.replace(/[/\\]/g, '-');
        return path.join(home, '.claude', 'projects', encoded);
    } catch {
        const encoded = sandboxDir.replace(/[/\\]/g, '-');
        return path.join(home, '.claude', 'projects', encoded);
    }
}

function computeContentHash(kind: WarmKind): string {
    const hash = createHash('md5');

    const contextPath = kind === 'creator' ? CREATOR_CONTEXT_PATH : FIXER_CONTEXT_PATH;
    if (fs.existsSync(contextPath)) hash.update(fs.readFileSync(contextPath));

    if (kind === 'creator') {
        const templatesDir = path.join(RGC_DIR, 'game_templates', 'v0.1');
        if (fs.existsSync(templatesDir)) hashDirRecursive(templatesDir, hash);
    }

    for (const sub of ['behaviors', 'systems', 'ui']) {
        const dir = path.join(RGC_DIR, sub, 'v0.1');
        if (fs.existsSync(dir)) hashDirRecursive(dir, hash);
    }

    return hash.digest('hex');
}

function hashDirRecursive(dir: string, hash: ReturnType<typeof createHash>): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) hashDirRecursive(full, hash);
        else hash.update(fs.readFileSync(full));
    }
}

async function buildWarmSandbox(kind: WarmKind): Promise<void> {
    const sandboxDir = states[kind].warmSandboxDir;

    if (fs.existsSync(sandboxDir)) fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.mkdirSync(sandboxDir, { recursive: true });

    const contextPath = kind === 'creator' ? CREATOR_CONTEXT_PATH : FIXER_CONTEXT_PATH;
    if (fs.existsSync(contextPath)) {
        const ctx = fs.readFileSync(contextPath, 'utf-8');
        fs.writeFileSync(path.join(sandboxDir, 'CLAUDE.md'), ctx);
    }

    const refDir = path.join(sandboxDir, 'reference');
    fs.mkdirSync(refDir, { recursive: true });

    if (kind === 'creator') {
        const projectDir = path.join(sandboxDir, 'project');
        const seed: Record<string, string> = {};
        for (const rel of ENGINE_MACHINERY) {
            const sub = rel.replace(/^systems\//, '');
            const src = path.join(RGC_DIR, 'systems', 'v0.1', sub);
            if (fs.existsSync(src)) seed[rel] = fs.readFileSync(src, 'utf-8');
        }
        writeFilesToDir(seed, projectDir);

        copyDirRecursive(
            path.join(RGC_DIR, 'game_templates', 'v0.1'),
            path.join(refDir, 'game_templates'),
        );

        const assetsDir = path.join(sandboxDir, 'assets');
        fs.mkdirSync(assetsDir, { recursive: true });
        generateAssetCatalog(assetsDir);
    }

    const picks = await pickRelevantLibrary('');
    copyPickedLibraryFiles(picks, refDir);

    if (kind === 'fixer') {
        const evtDefs = path.join(RGC_DIR, 'systems', 'v0.1', 'event_definitions.ts');
        if (fs.existsSync(evtDefs)) fs.copyFileSync(evtDefs, path.join(refDir, 'event_definitions.ts'));
    }
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

function generateAssetCatalog(assetsDir: string): void {
    const models: string[] = ['# Available 3D Models\n'];
    const audio: string[] = ['# Available Audio\n'];
    const textures: string[] = ['# Available Textures\n'];

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

const CREATOR_WARM_PROMPT = `You are being pre-warmed for a game creation task. Your job right now is to READ and INTERNALIZE reference materials so they are in your context when the real task arrives.

1. Read all game templates in reference/game_templates/ — browse each subdirectory and read every file. These are the patterns you must follow.
2. Read the engine machinery in project/systems/ — these files are pre-installed in every game.
3. Do NOT read the asset catalog files (assets/3D_MODELS.md etc.) — use "bash search_assets.sh \\"query\\"" to find assets when you need them during the real task.

Do NOT create, edit, or delete any files. Just read everything and respond with: WARM_COMPLETE`;

const FIXER_WARM_PROMPT = `You are being pre-warmed for a game editing task. Your job right now is to READ and INTERNALIZE reference materials so they are in your context when the real task arrives.

1. Read reference/event_definitions.ts for the baseline event schema.
2. Browse reference/behaviors/, reference/systems/, and reference/ui/ to familiarize yourself with available library components.
3. Do NOT read the asset catalog files (assets/3D_MODELS.md etc.) — use "bash search_assets.sh \\"query\\"" to find assets when you need them during the real task.

Do NOT create, edit, or delete any files. Just read everything and respond with: WARM_COMPLETE`;

function runWarmAgent(kind: WarmKind): Promise<string> {
    return new Promise((resolve, reject) => {
        const state = states[kind];
        const prompt = kind === 'creator' ? CREATOR_WARM_PROMPT : FIXER_WARM_PROMPT;

        const args = [
            '-p', prompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--model', 'haiku',
            '--dangerously-skip-permissions',
            '--max-turns', kind === 'creator' ? '80' : '40',
        ];

        const proc = spawn('claude', args, {
            cwd: state.warmSandboxDir,
            timeout: 10 * 60 * 1000,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, HOME: process.env.HOME || '/tmp' },
        });

        let stderr = '';
        let sessionId: string | null = null;

        proc.stdout.on('data', (chunk: Buffer) => {
            const lines = chunk.toString().split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const event = JSON.parse(line);
                    if (event.session_id) sessionId = event.session_id;
                } catch {}
            }
        });

        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

        proc.on('close', (code) => {
            if (!sessionId) {
                sessionId = findLatestSessionId(state.warmSandboxDir);
            }
            if (code === 0 && sessionId) {
                resolve(sessionId);
            } else {
                reject(new Error(`Warm agent exited with code ${code}. ${sessionId ? '' : 'No session ID found. '}stderr: ${stderr.slice(0, 300)}`));
            }
        });

        proc.on('error', (err) => {
            reject(new Error(`Failed to spawn warm agent: ${err.message}`));
        });
    });
}

function findLatestSessionId(sandboxDir: string): string | null {
    const projectDir = getClaudeProjectDir(sandboxDir);
    if (!projectDir || !fs.existsSync(projectDir)) return null;

    let latest: { name: string; mtime: number } | null = null;
    for (const entry of fs.readdirSync(projectDir)) {
        if (!entry.endsWith('.jsonl')) continue;
        const stat = fs.statSync(path.join(projectDir, entry));
        if (!latest || stat.mtimeMs > latest.mtime) {
            latest = { name: entry.replace('.jsonl', ''), mtime: stat.mtimeMs };
        }
    }
    return latest?.name ?? null;
}
