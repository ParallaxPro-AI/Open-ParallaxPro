/**
 * generation_jobs.ts — background CREATE_GAME job registry.
 *
 * A generation job runs the full CLI creator (cli_creator.ts) against a
 * project and replaces the project's file tree on success. Unlike the
 * fixer / chat flow, the job intentionally outlives the WebSocket client
 * that kicked it off: closing the browser tab does NOT kill the build.
 *
 * Lifecycle (in-memory `jobs` map keyed by projectId — one active job
 * per project is the invariant):
 *
 *   startGenerationJob → writes DB lock row, spawns runCreator in the
 *   background, returns jobId immediately.
 *
 *   runCreator → acquires a CLI slot (may queue), spawns the agent,
 *   emits status updates via `sendStatus`. Each status tick bumps the
 *   per-job heartbeat so the UI can tell a silent job from a live one.
 *
 *   completion → commits files on success / stashes error on failure,
 *   clears the DB lock, notifies subscribers, and fires plugins'
 *   onGenerationComplete hook (the hosted email plugin uses this).
 *
 * Orphan recovery: on process start we treat any row with a non-null
 * `generation_job_id` as aborted (the previous process died mid-build)
 * and surface a restart error in the project list. See
 * `cleanupOrphanedJobsOnBoot`.
 *
 * The DB columns are the source of truth for "is this project locked?"
 * — the in-memory map drops on restart, but the lock row does not. Code
 * that needs a live view (queue position, current status string) reads
 * the map via `getActiveJob`; code that only needs "is it locked" reads
 * the DB directly.
 */

import { randomUUID } from 'crypto';
import db from '../../../db/connection.js';
import { config } from '../../../config.js';
import { parseProjectData, serializeProjectData, isLegacyProjectData, ProjectFiles } from './project_files.js';
import { runCreator } from './cli_creator.js';
import { recordPendingFeedback } from '../feedback.js';
import { getQueuePosition, resolveCLI } from './cli_runner.js';
import type { EnginePlugin } from '../../../plugin.js';

export interface QueuePosition {
    position: number;
    total: number;
    cli: string;
}

/** Event stream emitted to subscribers while a job is live. */
export type JobEvent =
    | { type: 'status'; text: string }
    | { type: 'queue_position'; queuePosition: QueuePosition }
    | { type: 'complete'; status: 'success' | 'failed' | 'aborted'; summary: string; costUsd: number };

type Subscriber = (event: JobEvent) => void;

interface GenerationJob {
    jobId: string;
    projectId: string;
    userId: number;
    /** Captured at start so plugins firing at completion (email, usage
     *  reporting, admin events) can attribute the run without an
     *  active WS client. Username is a nicety; authToken is load-
     *  bearing for the usage plugin's HTTP token report. */
    username?: string;
    authToken?: string;
    description: string;
    /** Epoch ms. */
    startedAt: number;
    currentStatus: string;
    /** Epoch ms, bumped on every status tick. */
    lastHeartbeatAt: number;
    abortController: AbortController;
    subscribers: Set<Subscriber>;
    cliOverride?: string;
    /** Set while we're polling cli_runner's queue for a position update. */
    queuePoll?: NodeJS.Timeout;
}

// One active job per project. A second startGenerationJob for the same
// projectId throws — this is the "project is locked" invariant the rest
// of the editor WS / routes assume.
const jobs = new Map<string, GenerationJob>();

let _plugins: EnginePlugin[] = [];
export function setGenerationJobsPlugins(plugins: EnginePlugin[]): void {
    _plugins = plugins;
}

// ─── Public API ───────────────────────────────────────────────────────────

export interface StartJobArgs {
    projectId: string;
    userId: number;
    description: string;
    /** claude / codex / opencode / copilot — falls back to whichever the
     *  fixer CLI probe found first at startup. */
    cliOverride?: string;
    /** Captured once at start and stashed on the job so plugins firing
     *  at completion (usage token report, admin event, email) can
     *  attribute the run even after the WS client has disconnected.
     *  Both are best-effort; hooks that need them should no-op when
     *  missing. */
    username?: string;
    authToken?: string;
}

/**
 * Start a background generation job. Writes the DB lock synchronously so
 * any concurrent request sees the lock before our promise unwinds. Returns
 * the new jobId. Throws when the project is already locked, or (hosted
 * only) when the user already has a job running anywhere.
 */
export async function startGenerationJob(args: StartJobArgs): Promise<string> {
    const { projectId, userId, description, cliOverride, username, authToken } = args;

    if (jobs.has(projectId)) {
        throw new Error('This project already has a build running.');
    }

    // Hosted per-user cap: one job at a time since a 20–30 minute CLI run
    // monopolises the agent pool. Self-hosted users manage their own
    // machine, so parallel projects are fine.
    if (config.isHosted) {
        for (const j of jobs.values()) {
            if (j.userId === userId) {
                throw new Error('You already have a game being built. Wait for it to finish (or stop it) before starting another.');
            }
        }
    }

    const row = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(projectId) as any;
    if (!row) throw new Error('Project not found.');
    if (row.user_id !== userId) throw new Error('Access denied.');

    const jobId = randomUUID();
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();

    db.prepare(`
        UPDATE projects SET
            generation_job_id = ?,
            generation_started_at = ?,
            generation_description = ?,
            generation_last_status = ?,
            generation_last_heartbeat_at = ?,
            generation_last_error = NULL,
            generation_last_success_at = NULL
        WHERE id = ?
    `).run(jobId, startedAtIso, description, 'Queued...', startedAtIso, projectId);

    const abortController = new AbortController();
    const job: GenerationJob = {
        jobId,
        projectId,
        userId,
        username,
        authToken,
        description,
        startedAt,
        currentStatus: 'Queued...',
        lastHeartbeatAt: startedAt,
        abortController,
        subscribers: new Set(),
        cliOverride,
    };
    jobs.set(projectId, job);

    // Deliberately not awaited — startGenerationJob returns to the caller
    // (the chat-turn handler) immediately. The background promise owns
    // its own completion path via runJob's finally block.
    runJob(job).catch(e => {
        console.error(`[GenerationJobs] Unhandled error for job ${jobId}:`, e?.message || e);
    });

    return jobId;
}

/** Abort an active job. Returns true if one was aborted. */
export function abortJob(projectId: string): boolean {
    const job = jobs.get(projectId);
    if (!job) return false;
    job.abortController.abort();
    return true;
}

/** Returns the live job, or undefined when the project isn't locked in
 *  this process. Callers that only need "is it locked" should read the
 *  DB via `readGenerationState` instead (survives process restarts). */
export function getActiveJob(projectId: string): GenerationJob | undefined {
    return jobs.get(projectId);
}

/** Subscribe to a job's status stream. Returns null if no job exists, or
 *  an unsubscribe function. Subscribers also receive a synthetic
 *  initial `status` event with the current state so late joiners don't
 *  miss the last tick. */
export function subscribeToJob(projectId: string, cb: Subscriber): (() => void) | null {
    const job = jobs.get(projectId);
    if (!job) return null;
    job.subscribers.add(cb);
    try { cb({ type: 'status', text: job.currentStatus }); } catch {}
    return () => { job.subscribers.delete(cb); };
}

export interface GenerationState {
    active: boolean;
    jobId?: string;
    /** ISO */
    startedAt?: string;
    description?: string;
    lastStatus?: string;
    /** ISO */
    lastHeartbeatAt?: string;
    lastError?: string;
    /** ISO — stamped on the last successful completion, cleared when
     *  the user opens the project or dismisses the "✓ Just built" strip.
     *  When set, the card renders a green notice; a subsequent run
     *  start nulls this out first. */
    lastSuccessAt?: string;
    queuePosition?: QueuePosition;
}

/**
 * Fresh view of the project's generation state. Used by `/projects` list
 * and `/projects/:id`. When the DB says the project is locked but there's
 * no matching job in the in-memory registry the backend must have been
 * restarted during the run — lazily flip the row to failed so clients
 * don't see a perpetually-spinning timer.
 */
export function readGenerationState(projectId: string): GenerationState {
    const row = db.prepare(`
        SELECT generation_job_id, generation_started_at, generation_description,
               generation_last_status, generation_last_heartbeat_at, generation_last_error,
               generation_last_success_at
        FROM projects WHERE id = ?
    `).get(projectId) as any;
    if (!row) return { active: false };

    if (row.generation_job_id) {
        const job = jobs.get(projectId);
        if (!job) {
            db.prepare(`
                UPDATE projects SET
                    generation_job_id = NULL,
                    generation_started_at = NULL,
                    generation_last_status = NULL,
                    generation_last_heartbeat_at = NULL,
                    generation_last_error = ?
                WHERE id = ?
            `).run('Generation interrupted — process exited before completion.', projectId);
            return { active: false, lastError: 'Generation interrupted — process exited before completion.' };
        }
        const qp = getQueuePosition(job.cliOverride, job.jobId) || undefined;
        return {
            active: true,
            jobId: row.generation_job_id,
            startedAt: row.generation_started_at,
            description: row.generation_description,
            lastStatus: row.generation_last_status,
            lastHeartbeatAt: row.generation_last_heartbeat_at,
            queuePosition: qp,
        };
    }
    if (row.generation_last_error) {
        return { active: false, lastError: row.generation_last_error };
    }
    if (row.generation_last_success_at) {
        return { active: false, lastSuccessAt: row.generation_last_success_at };
    }
    return { active: false };
}

/** Convenience: true if the project is currently locked by a running job. */
export function isProjectLocked(projectId: string): boolean {
    return jobs.has(projectId);
}

/**
 * Sweep on server boot: every row with `generation_job_id` set is an
 * orphan (its CLI child died with the previous process). Mark them
 * failed with a "server restarted" error so project cards stop showing
 * a live timer for jobs that aren't actually running anywhere.
 *
 * Also fires `onGenerationComplete` for each orphan so the same plugin
 * chain that notifies users on normal completion runs here too —
 * without this, a user whose build was interrupted by a deploy or crash
 * never hears anything back. `authToken` is unavailable for orphans
 * (it lived in-memory on the dead GenerationJob), so token-usage
 * reporting no-ops; email still works since generation_notify looks up
 * the address via the landing DB by userId.
 */
export function cleanupOrphanedJobsOnBoot(plugins: EnginePlugin[] = []): void {
    try {
        const rows = db.prepare(`
            SELECT id, user_id, name, generation_description, generation_started_at
            FROM projects
            WHERE generation_job_id IS NOT NULL
        `).all() as any[];
        if (rows.length === 0) return;

        const summary = 'Our servers restarted while this build was running, so it didn\'t finish. Your project is unlocked — try again or pick a template.';
        const endedAt = Date.now();

        for (const r of rows) {
            const startedAt = r.generation_started_at ? Date.parse(r.generation_started_at) : endedAt;
            for (const p of plugins) {
                if (!p.onGenerationComplete) continue;
                try {
                    p.onGenerationComplete({
                        projectId: r.id,
                        projectName: r.name || r.id,
                        userId: r.user_id,
                        // username + authToken unknown for orphans — plugins
                        // that need them (usage reporting) should no-op.
                        status: 'failed',
                        summary,
                        description: r.generation_description || '',
                        startedAt: isNaN(startedAt) ? endedAt : startedAt,
                        endedAt,
                        cli: 'unknown',
                        costUsd: 0,
                    });
                } catch (e: any) {
                    console.error(`[GenerationJobs] Orphan hook ${p.name} failed for project ${r.id}:`, e?.message);
                }
            }
        }

        const result = db.prepare(`
            UPDATE projects SET
                generation_job_id = NULL,
                generation_started_at = NULL,
                generation_last_status = NULL,
                generation_last_heartbeat_at = NULL,
                generation_last_error = 'Generation interrupted by server restart — please retry.'
            WHERE generation_job_id IS NOT NULL
        `).run();
        if (result.changes > 0) {
            console.log(`[GenerationJobs] Cleared ${result.changes} orphaned generation job(s) from previous process (email sent).`);
        }
    } catch (e: any) {
        console.error('[GenerationJobs] Failed to clear orphaned jobs on boot:', e?.message);
    }
}

// ─── Internal ─────────────────────────────────────────────────────────────

async function runJob(job: GenerationJob): Promise<void> {
    const { projectId, description, abortController, cliOverride, jobId } = job;

    const sendStatus = (msg: string) => {
        job.currentStatus = msg;
        job.lastHeartbeatAt = Date.now();
        try {
            db.prepare(`UPDATE projects SET generation_last_status = ?, generation_last_heartbeat_at = ? WHERE id = ?`)
                .run(msg, new Date(job.lastHeartbeatAt).toISOString(), projectId);
        } catch {}
        broadcast(job, { type: 'status', text: msg });
    };

    // Poll the CLI queue while our runCreator call is waiting on a slot.
    // Once the slot is acquired (or the whole job aborts) the `finally`
    // block clears this. Polling is cheap (in-memory array scan) so 5s
    // is fine — users get a visibly moving position without flooding.
    job.queuePoll = setInterval(() => {
        const qp = getQueuePosition(cliOverride, jobId);
        if (!qp) return;
        sendStatus(`Queued — position ${qp.position} of ${qp.total} for ${qp.cli}`);
        broadcast(job, { type: 'queue_position', queuePosition: qp });
    }, 5000);

    let outcome: 'success' | 'failed' | 'aborted' = 'aborted';
    let summary = 'Build stopped.';
    let costUsd = 0;
    let files: ProjectFiles | null = null;
    // Captured from runCreator and handed to the onGenerationComplete hook
    // so the admin plugin can record it alongside the creator_snapshots row.
    let sessionCapturePath: string | null = null;

    try {
        const result = await runCreator(
            projectId,
            description,
            sendStatus,
            cliOverride,
            abortController.signal,
            jobId,
        );
        costUsd = result.costUsd;
        sessionCapturePath = result.sessionCapturePath ?? null;
        if (abortController.signal.aborted) {
            outcome = 'aborted';
            summary = 'Build stopped.';
        } else if (result.success && result.files) {
            outcome = 'success';
            summary = result.summary;
            files = result.files;
        } else {
            outcome = 'failed';
            summary = result.summary || 'Build failed.';
        }
    } catch (e: any) {
        if (abortController.signal.aborted) {
            outcome = 'aborted';
            summary = 'Build stopped.';
        } else {
            outcome = 'failed';
            summary = e?.message || 'Build failed.';
        }
    } finally {
        if (job.queuePoll) { clearInterval(job.queuePoll); job.queuePoll = undefined; }
    }

    // Look up the project name for the completion hook (used in email).
    // Read before we clear the lock so the hook sees the DB as it was
    // during the build.
    let projectName = projectId;
    try {
        const nameRow = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as any;
        if (nameRow?.name) projectName = nameRow.name;
    } catch {}

    // Commit files on success. If the commit itself fails, we demote to
    // 'failed' and stash the error so the user sees *why* — vs. leaving
    // a half-written project behind.
    let projectBeforeSnapshot: string | null = null;
    let projectAfterSnapshot: string | null = null;
    if (outcome === 'success' && files) {
        try {
            const row = db.prepare('SELECT project_data FROM projects WHERE id = ?').get(projectId) as any;
            projectBeforeSnapshot = row?.project_data ?? null;
            const pd = parseProjectData(row?.project_data);
            if (isLegacyProjectData(pd)) {
                throw new Error('Project is in the legacy file shape; cannot commit generated files.');
            }
            pd.files = { ...files };
            projectAfterSnapshot = serializeProjectData(pd);
            db.prepare(`UPDATE projects SET project_data = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`)
                .run(projectAfterSnapshot, projectId);
        } catch (e: any) {
            outcome = 'failed';
            summary = `Build produced files but commit failed: ${e?.message || e}`;
        }
    }

    // Record a pending feedback row so the editor puts up the
    // feedback form on the user's next connect. Strict UX for
    // CREATE_GAME — no dismiss. Only runs on successful commit;
    // failed builds don't warrant asking "how did it go?".
    if (outcome === 'success' && projectAfterSnapshot) {
        try {
            recordPendingFeedback({
                userId: job.userId,
                projectId,
                kind: 'create_game',
                jobId,
                cliSessionPath: sessionCapturePath,
                prompt: job.description,
                projectBefore: projectBeforeSnapshot,
                projectAfter: projectAfterSnapshot,
            });
        } catch (e: any) {
            console.error(`[GenerationJobs] Failed to record CREATE_GAME feedback row: ${e?.message}`);
        }
    }

    try {
        if (outcome === 'success') {
            db.prepare(`
                UPDATE projects SET
                    generation_job_id = NULL,
                    generation_started_at = NULL,
                    generation_description = NULL,
                    generation_last_status = NULL,
                    generation_last_heartbeat_at = NULL,
                    generation_last_error = NULL,
                    generation_last_success_at = ?
                WHERE id = ?
            `).run(new Date().toISOString(), projectId);
        } else {
            db.prepare(`
                UPDATE projects SET
                    generation_job_id = NULL,
                    generation_started_at = NULL,
                    generation_last_status = NULL,
                    generation_last_heartbeat_at = NULL,
                    generation_last_error = ?
                WHERE id = ?
            `).run(summary, projectId);
        }
    } catch (e: any) {
        console.error(`[GenerationJobs] Failed to clear DB lock for ${projectId}:`, e?.message);
    }

    jobs.delete(projectId);

    broadcast(job, { type: 'complete', status: outcome, summary, costUsd });

    // Resolve the CLI once — if the process unknowns what's installed it
    // throws, but we're past acquireCLISlot which would've failed first,
    // so wrap defensively and fall back to the override value verbatim.
    let cliName: string;
    try { cliName = resolveCLI(job.cliOverride); }
    catch { cliName = job.cliOverride || 'unknown'; }
    const endedAt = Date.now();

    for (const p of _plugins) {
        if (p.onGenerationComplete) {
            try {
                p.onGenerationComplete({
                    projectId,
                    projectName,
                    userId: job.userId,
                    username: job.username,
                    authToken: job.authToken,
                    status: outcome,
                    summary,
                    description: job.description,
                    startedAt: job.startedAt,
                    endedAt,
                    cli: cliName,
                    costUsd,
                    sessionCapturePath,
                });
            } catch (e: any) {
                console.error(`[GenerationJobs] Plugin ${p.name} onGenerationComplete failed:`, e?.message);
            }
        }
    }
}

function broadcast(job: GenerationJob, event: JobEvent): void {
    for (const cb of job.subscribers) {
        try { cb(event); } catch (e: any) {
            console.error(`[GenerationJobs] Subscriber threw:`, e?.message);
        }
    }
}
