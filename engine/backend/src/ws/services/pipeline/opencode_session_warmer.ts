/**
 * opencode_session_warmer.ts — pre-warm opencode sessions analogous to
 * session_warmer.ts (which is claude-only).
 *
 * Why opencode warming is simpler than Claude:
 *   - Claude needs to copy a JSONL file (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`)
 *     into each real-run sandbox so `--continue --fork-session` finds it.
 *   - OpenCode keeps sessions in SQLite, but `--session <warm_id> --fork`
 *     creates a fresh derived session that inherits the warm prefix —
 *     regardless of the current working directory. No file copy needed.
 *
 * What we cache:
 *   The same content the Claude warmer caches: CREATOR_CONTEXT.md / FIXER_CONTEXT.md,
 *   plus the game_templates/ tree (for creator) — read once into a long-lived
 *   session, then forked per real run.
 *
 * Codex and copilot are NOT covered here. Codex's `exec resume <id>` appends
 * (no fork primitive — would need JSONL copy + UUID rewrite, fragile).
 * Copilot's `--resume <id>` likewise appends. Both are tracked as future
 * work in tools/cli_probe_findings.md.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname_ow = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname_ow, 'reusable_game_components');
const CREATOR_CONTEXT_PATH = path.join(__dirname_ow, 'CREATOR_CONTEXT.md');
const FIXER_CONTEXT_PATH = path.join(__dirname_ow, 'FIXER_CONTEXT.md');
const OPENCODE_PREAMBLE_PATH = path.join(__dirname_ow, 'OPENCODE_PREAMBLE.md');

const WARM_DIR_BASE = path.join(os.tmpdir(), 'parallaxpro-warm-opencode');

export type WarmKind = 'creator' | 'fixer';
export type WarmStatus = 'not_warm' | 'warming' | 'warm' | 'error';

interface WarmState {
    status: WarmStatus;
    contentHash: string | null;
    sessionId: string | null;
    sandboxDir: string;
    lastWarmedAt: number | null;
    error: string | null;
}

const states: Record<WarmKind, WarmState> = {
    creator: { status: 'not_warm', contentHash: null, sessionId: null, sandboxDir: path.join(WARM_DIR_BASE, 'creator'), lastWarmedAt: null, error: null },
    fixer:   { status: 'not_warm', contentHash: null, sessionId: null, sandboxDir: path.join(WARM_DIR_BASE, 'fixer'),   lastWarmedAt: null, error: null },
};
const inflightWarm: Record<WarmKind, Promise<void> | null> = { creator: null, fixer: null };

// ─── Public API ──────────────────────────────────────────────────────────────

export function getOpencodeWarmStatus(): Record<WarmKind, { status: WarmStatus; lastWarmedAt: number | null; sessionId: string | null }> {
    return {
        creator: { status: states.creator.status, lastWarmedAt: states.creator.lastWarmedAt, sessionId: states.creator.sessionId },
        fixer:   { status: states.fixer.status,   lastWarmedAt: states.fixer.lastWarmedAt,   sessionId: states.fixer.sessionId   },
    };
}

/** Returns the warm session ID if ready, else null. Used by the cli_runner
 *  cold path to decide whether to pass `--session <id> --fork`. */
export function getOpencodeWarmSessionId(kind: WarmKind): string | null {
    const s = states[kind];
    return s.status === 'warm' ? s.sessionId : null;
}

export function warmOpencodeIfNeeded(kind: WarmKind): Promise<void> {
    const state = states[kind];
    const hash = computeContentHash(kind);
    if (state.status === 'warm' && state.contentHash === hash && state.sessionId) {
        return Promise.resolve();
    }
    if (inflightWarm[kind]) return inflightWarm[kind]!;

    state.status = 'warming';
    state.error = null;
    console.log(`[OpencodeWarmer] Warming ${kind} session...`);

    const p = (async () => {
        try {
            await buildWarmSandbox(kind);
            const sessionId = await runWarmAgent(kind);
            state.sessionId = sessionId;
            state.contentHash = hash;
            state.lastWarmedAt = Date.now();
            state.status = 'warm';
            try {
                fs.mkdirSync(WARM_DIR_BASE, { recursive: true });
                fs.writeFileSync(
                    path.join(WARM_DIR_BASE, `${kind}_meta.json`),
                    JSON.stringify({ contentHash: hash, sessionId, lastWarmedAt: state.lastWarmedAt }),
                );
            } catch {}
            console.log(`[OpencodeWarmer] ${kind} session warm (session=${sessionId.slice(0, 16)}, hash=${hash.slice(0, 12)})`);
        } catch (e: any) {
            state.status = 'error';
            state.error = e?.message || String(e);
            console.error(`[OpencodeWarmer] Failed to warm ${kind}:`, state.error);
        } finally {
            inflightWarm[kind] = null;
        }
    })();
    inflightWarm[kind] = p;
    return p;
}

export function invalidateOpencode(kind: WarmKind): void {
    const state = states[kind];
    state.status = 'not_warm';
    state.sessionId = null;
    state.contentHash = null;
    state.lastWarmedAt = null;
    state.error = null;
}

/** Initialize on server boot. Recovers from disk if a prior warm session
 *  is still valid; otherwise warms in the background. Non-blocking. */
export function initOpencodeWarmer(): void {
    fs.mkdirSync(WARM_DIR_BASE, { recursive: true });
    for (const kind of ['creator', 'fixer'] as WarmKind[]) {
        try {
            if (recoverExistingSession(kind)) continue;
            warmOpencodeIfNeeded(kind).catch(() => {});
        } catch (e: any) {
            console.warn(`[OpencodeWarmer] Recovery failed for ${kind}:`, e?.message);
            warmOpencodeIfNeeded(kind).catch(() => {});
        }
    }
}

function recoverExistingSession(kind: WarmKind): boolean {
    const state = states[kind];
    const metaPath = path.join(WARM_DIR_BASE, `${kind}_meta.json`);
    if (!fs.existsSync(metaPath)) return false;
    try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        const currentHash = computeContentHash(kind);
        if (meta.contentHash !== currentHash) {
            console.log(`[OpencodeWarmer] ${kind} hash changed — re-warming`);
            return false;
        }
        // Note: we DON'T verify the session still exists in opencode's
        // SQLite db (no easy CLI for that). If the session was pruned we'll
        // find out at fork-time and fall back to cold. Cheap to be optimistic.
        state.sessionId = meta.sessionId;
        state.contentHash = currentHash;
        state.lastWarmedAt = meta.lastWarmedAt || null;
        state.status = 'warm';
        console.log(`[OpencodeWarmer] Recovered existing ${kind} session (hash=${currentHash.slice(0, 12)})`);
        return true;
    } catch { return false; }
}

// ─── Internals ───────────────────────────────────────────────────────────────

function computeContentHash(kind: WarmKind): string {
    const hash = createHash('md5');
    const contextPath = kind === 'creator' ? CREATOR_CONTEXT_PATH : FIXER_CONTEXT_PATH;
    if (fs.existsSync(contextPath)) hash.update(fs.readFileSync(contextPath));
    if (fs.existsSync(OPENCODE_PREAMBLE_PATH)) hash.update(fs.readFileSync(OPENCODE_PREAMBLE_PATH));
    if (kind === 'creator') {
        const tplDir = path.join(RGC_DIR, 'game_templates', 'v0.1');
        if (fs.existsSync(tplDir)) hashDirRecursive(tplDir, hash);
    }
    // Note: behaviors/systems/ui dirs not in hash because we don't pre-read
    // them in the warm session (they're served by library.sh on demand).
    // Hash captures only what gets pre-loaded.
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
    const sandboxDir = states[kind].sandboxDir;
    if (fs.existsSync(sandboxDir)) fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.mkdirSync(sandboxDir, { recursive: true });

    // AGENTS.md = preamble + engine context (mirrors writeAgentInstructions).
    const contextPath = kind === 'creator' ? CREATOR_CONTEXT_PATH : FIXER_CONTEXT_PATH;
    let combined = '';
    if (fs.existsSync(OPENCODE_PREAMBLE_PATH)) combined += fs.readFileSync(OPENCODE_PREAMBLE_PATH, 'utf-8');
    if (fs.existsSync(contextPath)) combined += fs.readFileSync(contextPath, 'utf-8');
    if (combined) fs.writeFileSync(path.join(sandboxDir, 'AGENTS.md'), combined);

    // For creator: seed game_templates/ in reference/ so the warm read can
    // pull them into context.
    const refDir = path.join(sandboxDir, 'reference');
    fs.mkdirSync(refDir, { recursive: true });
    if (kind === 'creator') {
        const src = path.join(RGC_DIR, 'game_templates', 'v0.1');
        if (fs.existsSync(src)) {
            copyDirRecursive(src, path.join(refDir, 'game_templates'));
        }
    }
}

function copyDirRecursive(src: string, dest: string): void {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDirRecursive(s, d);
        else fs.copyFileSync(s, d);
    }
}

const CREATOR_WARM_PROMPT = `You are being pre-warmed for a game creation task. READ AND INTERNALIZE these reference files so they sit in your context for the real run that forks from you:

1. AGENTS.md — engine docs and tool conventions.
2. reference/game_templates/INDEX.md — one-line summary of every shipped template.
3. reference/game_templates/open_world_crime/{01_flow,02_entities,03_worlds,04_systems}.json — single-player exemplar (read all four).
4. reference/game_templates/buccaneer_bay/{01_flow,02_entities,03_worlds,04_systems}.json — multiplayer exemplar (read all four).

Do NOT read any other files. Do NOT create, edit, or delete anything. Just read and respond with the single token: WARM_COMPLETE`;

const FIXER_WARM_PROMPT = `You are being pre-warmed for a game editing task. READ AND INTERNALIZE these reference files so they sit in your context for the real run that forks from you:

1. AGENTS.md — engine docs and tool conventions.

Do NOT create, edit, or delete anything. Respond with the single token: WARM_COMPLETE`;

function runWarmAgent(kind: WarmKind): Promise<string> {
    return new Promise((resolve, reject) => {
        const state = states[kind];
        const prompt = kind === 'creator' ? CREATOR_WARM_PROMPT : FIXER_WARM_PROMPT;

        const args = [
            'run',
            '--format', 'json',
            '--dir', state.sandboxDir,
            '--dangerously-skip-permissions',
            prompt,
        ];

        const proc = spawn('opencode', args, {
            cwd: state.sandboxDir,
            timeout: 5 * 60 * 1000,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, HOME: process.env.HOME || '/tmp' },
        });

        let stderr = '';
        let sessionId: string | null = null;
        let buf = '';

        proc.stdout.on('data', (chunk: Buffer) => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);
                    const id = event.sessionID || event.part?.sessionID;
                    if (typeof id === 'string' && !sessionId) sessionId = id;
                } catch {}
            }
        });

        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

        proc.on('close', (code) => {
            if (code === 0 && sessionId) {
                resolve(sessionId);
            } else {
                reject(new Error(`opencode warm agent exited with code ${code}. ${sessionId ? '' : 'No session ID found. '}stderr: ${stderr.slice(0, 300)}`));
            }
        });
        proc.on('error', (err) => reject(new Error(`Failed to spawn opencode warm agent: ${err.message}`)));
    });
}
