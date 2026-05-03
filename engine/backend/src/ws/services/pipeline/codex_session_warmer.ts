/**
 * codex_session_warmer.ts — pre-warm codex sessions with engine docs +
 * exemplar templates, then fork-per-run by copying the warm JSONL with a
 * fresh UUID before each real spawn.
 *
 * Codex's `exec resume <id>` APPENDS to the original session's JSONL, so
 * concurrent jobs against the same warm UUID would corrupt each other. To
 * fork safely we copy the warm session file with a new UUID and rewrite
 * the embedded session_id field — verified empirically that codex resumes
 * cleanly from the forked file (a "thread not found" warning is logged to
 * stderr but is cosmetic; the conversation context loads correctly).
 *
 * The fork happens inline at real-run time (not at warm time), so each
 * real run gets its own UUID and the warm JSONL is never appended to.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname_cw = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname_cw, 'reusable_game_components');
const CREATOR_CONTEXT_PATH = path.join(__dirname_cw, 'CREATOR_CONTEXT.md');
const FIXER_CONTEXT_PATH = path.join(__dirname_cw, 'FIXER_CONTEXT.md');
const CODEX_PREAMBLE_PATH = path.join(__dirname_cw, 'CODEX_PREAMBLE.md');

const WARM_DIR_BASE = path.join(os.tmpdir(), 'parallaxpro-warm-codex');
const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

export type WarmKind = 'creator' | 'fixer';
export type WarmStatus = 'not_warm' | 'warming' | 'warm' | 'error';

interface WarmState {
    status: WarmStatus;
    contentHash: string | null;
    sessionId: string | null;
    sessionFilePath: string | null;
    sandboxDir: string;
    lastWarmedAt: number | null;
    error: string | null;
}

const states: Record<WarmKind, WarmState> = {
    creator: { status: 'not_warm', contentHash: null, sessionId: null, sessionFilePath: null, sandboxDir: path.join(WARM_DIR_BASE, 'creator'), lastWarmedAt: null, error: null },
    fixer:   { status: 'not_warm', contentHash: null, sessionId: null, sessionFilePath: null, sandboxDir: path.join(WARM_DIR_BASE, 'fixer'),   lastWarmedAt: null, error: null },
};
const inflightWarm: Record<WarmKind, Promise<void> | null> = { creator: null, fixer: null };

// ─── Public API ──────────────────────────────────────────────────────────────

export function getCodexWarmStatus(): Record<WarmKind, { status: WarmStatus; lastWarmedAt: number | null; sessionId: string | null }> {
    return {
        creator: { status: states.creator.status, lastWarmedAt: states.creator.lastWarmedAt, sessionId: states.creator.sessionId },
        fixer:   { status: states.fixer.status,   lastWarmedAt: states.fixer.lastWarmedAt,   sessionId: states.fixer.sessionId   },
    };
}

/**
 * Fork the warm session for `kind` into a fresh UUID and return that UUID.
 * The caller passes it as `resumeSessionId` into spawnCodex. Returns null
 * if the kind isn't warm yet or the warm JSONL has gone missing.
 */
export function forkCodexWarmSession(kind: WarmKind): string | null {
    const state = states[kind];
    if (state.status !== 'warm' || !state.sessionId || !state.sessionFilePath) return null;
    if (!fs.existsSync(state.sessionFilePath)) {
        console.warn(`[CodexWarmer] Warm JSONL for ${kind} missing: ${state.sessionFilePath}`);
        state.status = 'not_warm';
        return null;
    }
    try {
        const newUuid = randomUUID();
        const ts = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '').slice(0, -4);
        const sessionDir = path.dirname(state.sessionFilePath);
        const newFile = path.join(sessionDir, `rollout-${ts}-${newUuid}.jsonl`);
        const content = fs.readFileSync(state.sessionFilePath, 'utf-8').replaceAll(state.sessionId, newUuid);
        fs.writeFileSync(newFile, content);
        return newUuid;
    } catch (e: any) {
        console.warn(`[CodexWarmer] Failed to fork warm session for ${kind}:`, e?.message);
        return null;
    }
}

export function warmCodexIfNeeded(kind: WarmKind): Promise<void> {
    const state = states[kind];
    const hash = computeContentHash(kind);
    if (state.status === 'warm' && state.contentHash === hash && state.sessionId
        && state.sessionFilePath && fs.existsSync(state.sessionFilePath)) {
        return Promise.resolve();
    }
    if (inflightWarm[kind]) return inflightWarm[kind]!;

    state.status = 'warming';
    state.error = null;
    console.log(`[CodexWarmer] Warming ${kind} session...`);

    const p = (async () => {
        try {
            await buildWarmSandbox(kind);
            const sessionId = await runWarmAgent(kind);
            const sessionFilePath = findCodexSessionFile(sessionId);
            if (!sessionFilePath) throw new Error(`Codex session JSONL for ${sessionId} not found on disk`);
            state.sessionId = sessionId;
            state.sessionFilePath = sessionFilePath;
            state.contentHash = hash;
            state.lastWarmedAt = Date.now();
            state.status = 'warm';
            try {
                fs.mkdirSync(WARM_DIR_BASE, { recursive: true });
                fs.writeFileSync(
                    path.join(WARM_DIR_BASE, `${kind}_meta.json`),
                    JSON.stringify({ contentHash: hash, sessionId, sessionFilePath, lastWarmedAt: state.lastWarmedAt }),
                );
            } catch {}
            console.log(`[CodexWarmer] ${kind} session warm (uuid=${sessionId.slice(0, 16)}, hash=${hash.slice(0, 12)})`);
        } catch (e: any) {
            state.status = 'error';
            state.error = e?.message || String(e);
            console.error(`[CodexWarmer] Failed to warm ${kind}:`, state.error);
        } finally {
            inflightWarm[kind] = null;
        }
    })();
    inflightWarm[kind] = p;
    return p;
}

export function invalidateCodex(kind: WarmKind): void {
    const state = states[kind];
    state.status = 'not_warm';
    state.sessionId = null;
    state.sessionFilePath = null;
    state.contentHash = null;
    state.lastWarmedAt = null;
    state.error = null;
}

export function initCodexWarmer(): void {
    fs.mkdirSync(WARM_DIR_BASE, { recursive: true });
    for (const kind of ['creator', 'fixer'] as WarmKind[]) {
        try {
            if (recoverExistingSession(kind)) continue;
            warmCodexIfNeeded(kind).catch(() => {});
        } catch (e: any) {
            console.warn(`[CodexWarmer] Recovery failed for ${kind}:`, e?.message);
            warmCodexIfNeeded(kind).catch(() => {});
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
        if (meta.contentHash !== currentHash) return false;
        if (!meta.sessionFilePath || !fs.existsSync(meta.sessionFilePath)) return false;
        state.sessionId = meta.sessionId;
        state.sessionFilePath = meta.sessionFilePath;
        state.contentHash = currentHash;
        state.lastWarmedAt = meta.lastWarmedAt || null;
        state.status = 'warm';
        console.log(`[CodexWarmer] Recovered existing ${kind} session (hash=${currentHash.slice(0, 12)})`);
        return true;
    } catch { return false; }
}

// ─── Internals ───────────────────────────────────────────────────────────────

function computeContentHash(kind: WarmKind): string {
    const hash = createHash('md5');
    const contextPath = kind === 'creator' ? CREATOR_CONTEXT_PATH : FIXER_CONTEXT_PATH;
    if (fs.existsSync(contextPath)) hash.update(fs.readFileSync(contextPath));
    if (fs.existsSync(CODEX_PREAMBLE_PATH)) hash.update(fs.readFileSync(CODEX_PREAMBLE_PATH));
    if (kind === 'creator') {
        const tplDir = path.join(RGC_DIR, 'game_templates', 'v0.1');
        if (fs.existsSync(tplDir)) hashDirRecursive(tplDir, hash);
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
    const sandboxDir = states[kind].sandboxDir;
    if (fs.existsSync(sandboxDir)) fs.rmSync(sandboxDir, { recursive: true, force: true });
    fs.mkdirSync(sandboxDir, { recursive: true });

    // AGENTS.md = preamble + engine context.
    const contextPath = kind === 'creator' ? CREATOR_CONTEXT_PATH : FIXER_CONTEXT_PATH;
    let combined = '';
    if (fs.existsSync(CODEX_PREAMBLE_PATH)) combined += fs.readFileSync(CODEX_PREAMBLE_PATH, 'utf-8');
    if (fs.existsSync(contextPath)) combined += fs.readFileSync(contextPath, 'utf-8');
    if (combined) fs.writeFileSync(path.join(sandboxDir, 'AGENTS.md'), combined);

    const refDir = path.join(sandboxDir, 'reference');
    fs.mkdirSync(refDir, { recursive: true });
    if (kind === 'creator') {
        const src = path.join(RGC_DIR, 'game_templates', 'v0.1');
        if (fs.existsSync(src)) copyDirRecursive(src, path.join(refDir, 'game_templates'));
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

const CREATOR_WARM_PROMPT = `You are being pre-warmed for a game creation task. Read these files and internalize them so they sit in your context for the real run that forks from you:

1. AGENTS.md (engine docs and Codex tool conventions)
2. reference/game_templates/INDEX.md (one-line summary of every shipped template)
3. reference/game_templates/open_world_crime/{01_flow,02_entities,03_worlds,04_systems}.json — single-player exemplar (read all four)
4. reference/game_templates/buccaneer_bay/{01_flow,02_entities,03_worlds,04_systems}.json — multiplayer exemplar (read all four)

Use cat to read the files. Do NOT create, edit, or delete anything. Do NOT use apply_patch. Respond with the single line: WARM_COMPLETE`;

const FIXER_WARM_PROMPT = `You are being pre-warmed for a game editing task. Read AGENTS.md (engine docs + Codex tool conventions). Use cat. Do NOT create, edit, or delete anything. Respond with the single line: WARM_COMPLETE`;

function runWarmAgent(kind: WarmKind): Promise<string> {
    return new Promise((resolve, reject) => {
        const state = states[kind];
        const prompt = kind === 'creator' ? CREATOR_WARM_PROMPT : FIXER_WARM_PROMPT;

        const args = [
            'exec',
            '--json',
            '--skip-git-repo-check',
            '--dangerously-bypass-approvals-and-sandbox',
            // Use cheaper model for warming — context loads the same.
            '-c', 'model="gpt-5.4-mini"',
            '-c', 'model_reasoning_effort="low"',
            '-C', state.sandboxDir,
            prompt,
        ];

        const proc = spawn('codex', args, {
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
                    if (event.type === 'thread.started' && typeof event.thread_id === 'string' && !sessionId) {
                        sessionId = event.thread_id;
                    }
                } catch {}
            }
        });
        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

        proc.on('close', (code) => {
            if (code === 0 && sessionId) resolve(sessionId);
            else reject(new Error(`codex warm agent exited with code ${code}. ${sessionId ? '' : 'No session ID found. '}stderr: ${stderr.slice(0, 300)}`));
        });
        proc.on('error', (err) => reject(new Error(`Failed to spawn codex warm agent: ${err.message}`)));
    });
}

/** Locate `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` for a uuid.
 *  Searches the most-recent date dirs first since warm sessions are fresh. */
function findCodexSessionFile(uuid: string): string | null {
    if (!fs.existsSync(CODEX_SESSIONS_ROOT)) return null;
    const years = fs.readdirSync(CODEX_SESSIONS_ROOT).sort().reverse();
    for (const y of years) {
        const yd = path.join(CODEX_SESSIONS_ROOT, y);
        if (!fs.statSync(yd).isDirectory()) continue;
        const months = fs.readdirSync(yd).sort().reverse();
        for (const m of months) {
            const md = path.join(yd, m);
            if (!fs.statSync(md).isDirectory()) continue;
            const days = fs.readdirSync(md).sort().reverse();
            for (const d of days) {
                const dd = path.join(md, d);
                if (!fs.statSync(dd).isDirectory()) continue;
                for (const f of fs.readdirSync(dd)) {
                    if (f.endsWith('.jsonl') && f.includes(uuid)) {
                        return path.join(dd, f);
                    }
                }
            }
        }
    }
    return null;
}
