/**
 * session_capture.ts — per-run capture of CLI session artifacts for later
 * admin-side analysis.
 *
 * For every spawned editing-agent run (fixer or creator, any of the four
 * CLIs), we archive:
 *
 *   - metadata.json  — who/what/when, sandbox dir, prompt, docker on/off,
 *                      hostname, pid — everything needed to tell one run
 *                      apart from another.
 *   - stdout.jsonl   — raw stdout tee. For claude/codex/opencode/copilot
 *                      this is their JSONL event stream — the canonical
 *                      source of truth. Captured even if the CLI crashes
 *                      before writing its native session file.
 *   - stderr.log     — raw stderr tee.
 *   - result.json    — exit code, cost, duration, final summary text,
 *                      aborted flag. Written on finalize.
 *   - native_claude/ — copy of `~/.claude/projects/<encoded-cwd>/*.jsonl`
 *                      (Claude Code's own session file).
 *   - native_opencode/ — best-effort copy of opencode's session_diff and
 *                      tool-output files if we spotted a sessionID in the
 *                      stream.
 *
 * Design goals:
 *
 *   - NEVER break the run. Every filesystem op is wrapped in try/catch. A
 *     bad mkdir, a full disk, or a missing native session dir must NOT
 *     propagate out. Missing capture is fine; crashing the fixer/creator
 *     because of capture is not.
 *   - Host-side capture only. Writes land in
 *     engine/backend/cli_session_logs/ on the host. In docker-sandbox mode
 *     the native auth dirs are already bind-mounted RW into the container,
 *     so post-run copies on the host work unchanged.
 *   - Admin-only. Nothing in the capture surfaces to user-visible routes.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import db from '../../../db/connection.js';

const __dirname_cap = path.dirname(fileURLToPath(import.meta.url));

// Persistent root for captures. Sibling of `parallaxpro_engine.db` so the
// same volume mount that persists the DB also persists captures — nothing
// lives inside the docker-sandbox container. Gitignored at the repo root.
const CAPTURE_ROOT = path.resolve(__dirname_cap, '../../../../cli_session_logs');

// Matches anything plausibly an opencode session id (`ses_<hex+alnum>`).
// The stream emits it under a few field names depending on opencode version,
// so we scan permissively rather than pinning one key.
const OPENCODE_SESSION_RE = /\bses_[a-zA-Z0-9]{20,}\b/;

export interface CaptureContext {
    /** Which CLI is about to run — determines which native session we hunt for. */
    cli: 'claude' | 'codex' | 'opencode' | 'copilot';
    /** 'fix' for cli_fixer, 'create' for cli_creator. Shows up in the dir name. */
    kind: 'fix' | 'create';
    sandboxDir: string;
    /** Optional — present for create (from generation_jobs) and fix (random uuid). */
    jobId?: string;
    projectId?: string;
    userId?: number;
    username?: string;
    /** User-supplied prompt/description. Stored in metadata.json, never sent to a user-visible route. */
    prompt?: string;
    dockerSandbox?: boolean;
    hostname?: string;
    /** Server-side cap on LLM round-trips (`--max-turns`). Stored in metadata so the admin UI can show "steps used / allowed" without parsing the spawn arguments. */
    maxTurns?: number;
}

export interface CaptureHandle {
    /** Absolute path to the capture dir. Null when capture init failed — all methods are still safe no-ops. */
    readonly dir: string | null;
    tapStdout(chunk: Buffer | string): void;
    tapStderr(chunk: Buffer | string): void;
    /**
     * Remember an opencode sessionID seen in the stdout stream so finalize()
     * can copy the matching native files. Safe to call multiple times — only
     * the first non-empty value is kept.
     */
    noteOpencodeSessionID(id: string): void;
    /** Close streams + copy native session files + write result.json. */
    finalize(result: { exitCode: number | null; costUsd?: number; text?: string; aborted?: boolean; sessionType?: string; remoteRetry?: boolean; numTurns?: number }): void;
}

/**
 * Start a capture for this run. Returns a handle whose methods are safe to
 * call even if init failed (the dir field will be null in that case — the
 * taps silently drop). Call finalize() exactly once at the end of the run.
 */
export function beginCapture(ctx: CaptureContext): CaptureHandle {
    const startedAt = Date.now();
    const shortId = (ctx.jobId || randomUUID()).slice(0, 8);
    const ts = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
    const dirname = `${ts}_${ctx.kind}_${ctx.cli}_${shortId}`;

    let dir: string | null = null;
    let stdoutStream: fs.WriteStream | null = null;
    let stderrStream: fs.WriteStream | null = null;
    let opencodeSessionId: string | null = null;
    let opencodeIdScanned = 0;
    let finalized = false;

    try {
        fs.mkdirSync(CAPTURE_ROOT, { recursive: true });
        const full = path.join(CAPTURE_ROOT, dirname);
        fs.mkdirSync(full, { recursive: true });
        dir = full;
        // metadata.json up front so even crashed runs leave identifying
        // breadcrumbs before finalize() gets a chance to write anything else.
        const meta = {
            jobId: ctx.jobId || null,
            projectId: ctx.projectId || null,
            userId: ctx.userId ?? null,
            username: ctx.username || null,
            cli: ctx.cli,
            kind: ctx.kind,
            sandboxDir: ctx.sandboxDir,
            prompt: ctx.prompt || null,
            dockerSandbox: !!ctx.dockerSandbox,
            hostname: ctx.hostname || os.hostname(),
            pid: process.pid,
            startedAt: new Date(startedAt).toISOString(),
            startedAtEpochMs: startedAt,
            maxTurns: ctx.maxTurns ?? null,
        };
        fs.writeFileSync(path.join(full, 'metadata.json'), JSON.stringify(meta, null, 2));
        stdoutStream = fs.createWriteStream(path.join(full, 'stdout.jsonl'), { flags: 'a' });
        stderrStream = fs.createWriteStream(path.join(full, 'stderr.log'), { flags: 'a' });
        // Swallow stream errors so a disk-full mid-run doesn't propagate.
        stdoutStream.on('error', e => console.warn(`[SessionCapture] stdout stream error: ${e.message}`));
        stderrStream.on('error', e => console.warn(`[SessionCapture] stderr stream error: ${e.message}`));

        // Best-effort: update projects.session_capture_path so the admin UI can
        // jump straight to this capture for the latest run on this project.
        if (ctx.projectId) {
            try {
                db.prepare(`UPDATE projects SET session_capture_path = ? WHERE id = ?`).run(full, ctx.projectId);
            } catch (e: any) {
                // Missing column on an old DB, DB locked, projectId doesn't
                // exist — none of these should break the run.
                console.warn(`[SessionCapture] Failed to stamp project row: ${e?.message}`);
            }
        }
    } catch (e: any) {
        console.warn(`[SessionCapture] Failed to initialize capture dir: ${e?.message}`);
        dir = null;
    }

    const handle: CaptureHandle = {
        get dir() { return dir; },

        tapStdout(chunk) {
            if (!stdoutStream) return;
            try { stdoutStream.write(chunk); } catch {}
            // Sniff opencode sessionID from the stream until we find one.
            // Cap scan at ~64KB of stdout to keep it bounded even on long runs.
            if (ctx.cli === 'opencode' && !opencodeSessionId && opencodeIdScanned < 65536) {
                try {
                    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
                    opencodeIdScanned += s.length;
                    const m = s.match(OPENCODE_SESSION_RE);
                    if (m) opencodeSessionId = m[0];
                } catch {}
            }
        },

        tapStderr(chunk) {
            if (!stderrStream) return;
            try { stderrStream.write(chunk); } catch {}
        },

        noteOpencodeSessionID(id) {
            if (!opencodeSessionId && typeof id === 'string' && id.trim()) {
                opencodeSessionId = id.trim();
            }
        },

        finalize({ exitCode, costUsd, text, aborted, sessionType, remoteRetry, numTurns }) {
            if (finalized) return;
            finalized = true;
            try { stdoutStream?.end(); } catch {}
            try { stderrStream?.end(); } catch {}
            if (!dir) return;

            const endedAt = Date.now();
            try {
                fs.writeFileSync(
                    path.join(dir, 'result.json'),
                    JSON.stringify({
                        exitCode,
                        costUsd: costUsd ?? null,
                        aborted: !!aborted,
                        summaryText: text || null,
                        sessionType: sessionType || null,
                        remoteRetry: !!remoteRetry,
                        numTurns: numTurns ?? null,
                        endedAt: new Date(endedAt).toISOString(),
                        endedAtEpochMs: endedAt,
                        durationMs: endedAt - startedAt,
                    }, null, 2),
                );
            } catch (e: any) {
                console.warn(`[SessionCapture] Failed to write result.json: ${e?.message}`);
            }

            try {
                if (ctx.cli === 'claude') {
                    copyClaudeNativeSession(ctx.sandboxDir, dir);
                } else if (ctx.cli === 'opencode') {
                    copyOpencodeNativeSession(opencodeSessionId, dir);
                }
            } catch (e: any) {
                console.warn(`[SessionCapture] Native session copy failed: ${e?.message}`);
            }
        },
    };

    return handle;
}

/**
 * Claude Code stores sessions at `$HOME/.claude/projects/<encoded-cwd>/*.jsonl`
 * where the encoding replaces path separators with '-'. macOS resolves /tmp
 * to /private/tmp before Claude sees it, so realpath first to catch either.
 */
function copyClaudeNativeSession(sandboxDir: string, captureDir: string): void {
    const home = os.homedir();
    if (!home) return;
    const projectsRoot = path.join(home, '.claude', 'projects');
    if (!fs.existsSync(projectsRoot)) return;

    const candidates = new Set<string>();
    candidates.add(encodeClaudeProjectPath(sandboxDir));
    try {
        const real = fs.realpathSync(sandboxDir);
        if (real !== sandboxDir) candidates.add(encodeClaudeProjectPath(real));
    } catch {}

    for (const encoded of candidates) {
        const src = path.join(projectsRoot, encoded);
        if (!fs.existsSync(src)) continue;
        const dst = path.join(captureDir, 'native_claude');
        try {
            fs.mkdirSync(dst, { recursive: true });
            for (const f of fs.readdirSync(src)) {
                try {
                    fs.copyFileSync(path.join(src, f), path.join(dst, f));
                } catch (e: any) {
                    console.warn(`[SessionCapture] Claude file copy failed for ${f}: ${e?.message}`);
                }
            }
        } catch (e: any) {
            console.warn(`[SessionCapture] Claude native copy failed: ${e?.message}`);
        }
        return;
    }
}

function encodeClaudeProjectPath(p: string): string {
    return p.replace(/[\/\\]/g, '-');
}

/**
 * Opencode stores per-session artifacts across a few subdirs of
 * `$HOME/.local/share/opencode/storage/`. Walk the tree once and copy any
 * file whose name contains the session ID. If we don't know the session ID
 * (sniff failed) skip the copy — stdout.jsonl is already a full transcript.
 */
function copyOpencodeNativeSession(sessionId: string | null, captureDir: string): void {
    if (!sessionId) return;
    const home = os.homedir();
    if (!home) return;
    const storageRoot = path.join(home, '.local', 'share', 'opencode', 'storage');
    if (!fs.existsSync(storageRoot)) return;

    const dst = path.join(captureDir, 'native_opencode');
    try { fs.mkdirSync(dst, { recursive: true }); } catch {}

    const walk = (dir: string, depth: number) => {
        if (depth > 4) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) { walk(full, depth + 1); continue; }
            if (!ent.isFile()) continue;
            if (!ent.name.includes(sessionId)) continue;
            // Mirror the relative structure into the capture dir so multiple
            // buckets (session_diff/<id>.json, message/<id>/...) don't collide.
            const rel = path.relative(storageRoot, full);
            const out = path.join(dst, rel);
            try {
                fs.mkdirSync(path.dirname(out), { recursive: true });
                fs.copyFileSync(full, out);
            } catch (e: any) {
                console.warn(`[SessionCapture] Opencode file copy failed for ${rel}: ${e?.message}`);
            }
        }
    };
    walk(storageRoot, 0);
}

export function captureRoot(): string { return CAPTURE_ROOT; }
