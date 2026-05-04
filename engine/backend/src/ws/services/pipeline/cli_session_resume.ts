/**
 * cli_session_resume.ts — per-(cli, projectId) session-ID registry for fix runs.
 *
 * Claude has its own warmer- and JSONL-based resume in session_warmer.ts.
 * For codex and opencode the resume mechanism is "remember the session ID
 * the CLI emitted on the prior run, then pass it back via the CLI's resume
 * flag on the next run":
 *
 *   codex:    `codex exec resume <uuid>` — appends to the same JSONL on
 *             ~/.codex/sessions, but per-project locking in cli_fixer
 *             prevents concurrent appends for the same project.
 *   opencode: `opencode run --session <id> --fork` — fork creates a fresh
 *             session ID each time, so the original is preserved and the
 *             resumed run gets a clean state to grow from.
 *   copilot:  `copilot --resume <uuid>` — appends to the same session-state
 *             dir under ~/.copilot/session-state/. Honors the new cwd over
 *             the recorded one. No fork primitive — per-project locking
 *             prevents concurrent appends.
 *
 * Claude has its own JSONL-copy mechanism in session_warmer.ts (the
 * forkPreviousFixSession path) and is excluded from this registry.
 */

import type { CLIName } from './cli_runner.js';

interface ProjectSession {
    cli: CLIName;
    sessionId: string;
    /** Host that owns the session. opencode/codex/copilot store sessions in
     *  per-host SQLite/JSONL files — a session ID emitted on host A is
     *  meaningless on host B. We record this so the resume lookup can
     *  refuse cross-host resumes (which would 4s-fail with "Session not
     *  found" then retry locally). 'local' or a worker name. */
    host: string;
    recordedAt: number;
}

const sessions = new Map<string, ProjectSession>();
const key = (cli: CLIName, projectId: string): string => `${cli}:${projectId}`;

/**
 * Record the session ID emitted by a finished fix run, keyed by (cli,
 * projectId). The next fix on the same project + same cli can resume from
 * this. Pass `null`/`undefined` sessionId to silently no-op (e.g. when the
 * runner couldn't extract one).
 */
export function recordFixSession(cli: CLIName, projectId: string, sessionId: string | null | undefined, host?: string): void {
    if (!sessionId || !projectId) return;
    if (cli === 'claude') return;  // see file header — claude uses its own JSONL-copy path
    sessions.set(key(cli, projectId), { cli, sessionId, host: host ?? 'local', recordedAt: Date.now() });
}

/** Look up the previously recorded session ID for (cli, projectId, host).
 *  When `host` is provided, returns null if the recorded session lives on a
 *  different host — opencode/codex/copilot sessions are per-host SQLite/
 *  JSONL state and resuming cross-host triggers a 4s "Session not found"
 *  failure then a wasteful retry. Callers that don't pass a host get the
 *  legacy "any-host" lookup (preserves behavior for self-hosters with no
 *  routing matrix). */
export function getRecordedFixSession(cli: CLIName, projectId: string, host?: string): string | null {
    if (cli === 'claude') return null;
    const rec = sessions.get(key(cli, projectId));
    if (!rec) return null;
    if (host !== undefined && rec.host !== host) return null;
    return rec.sessionId;
}

/** Drop a recorded session — call when a resume attempt fails so the next
 *  call falls back to a cold start instead of looping. */
export function forgetFixSession(cli: CLIName, projectId: string): void {
    sessions.delete(key(cli, projectId));
}

/** Snapshot for admin/debug. */
export function listRecordedSessions(): Array<{ cli: CLIName; projectId: string; sessionId: string; host: string; ageMs: number }> {
    const now = Date.now();
    const out: Array<{ cli: CLIName; projectId: string; sessionId: string; host: string; ageMs: number }> = [];
    for (const [k, v] of sessions.entries()) {
        const projectId = k.slice(v.cli.length + 1);
        out.push({ cli: v.cli, projectId, sessionId: v.sessionId, host: v.host, ageMs: now - v.recordedAt });
    }
    return out;
}
