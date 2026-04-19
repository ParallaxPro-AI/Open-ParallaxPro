/**
 * cli_active_jobs.ts — shared in-memory registry of in-flight CLI runs.
 *
 * Both cli_fixer (short FIX_GAME / direct-agent edits) and cli_creator
 * (long CREATE_GAME builds) call into acquireCLISlot in cli_runner. That
 * gives us counts per CLI, but admins watching production want to know
 * *what* each active run is doing: which project, which user, which
 * prompt. This module is that view.
 *
 * Registration is caller-owned: each wrapper (runFixer, runCreator) adds
 * itself when it acquires a slot and removes itself in its `finally`.
 * The registry is an in-memory Map — it drops on restart, which is fine
 * since the CLI children also die with the parent process.
 */

export type CLIJobKind = 'fix' | 'create';

export interface ActiveCLIJob {
    jobId: string;
    cli: string;
    kind: CLIJobKind;
    projectId: string;
    description: string;
    startedAt: number; // epoch ms
    /** Kills the CLI run. Set by runFixer / runCreator at registration.
     *  Called by preemptProjectJob when a new CLI run wants to work on
     *  the same project — the newer request wins, the older one dies. */
    abort?: () => void;
}

const jobs = new Map<string, ActiveCLIJob>();

export function registerActiveJob(job: ActiveCLIJob): void {
    jobs.set(job.jobId, job);
}

export function unregisterActiveJob(jobId: string): void {
    jobs.delete(jobId);
}

export function listActiveJobs(): ActiveCLIJob[] {
    return Array.from(jobs.values()).sort((a, b) => a.startedAt - b.startedAt);
}

/** Returns the active fix/create job for a project, if any. */
export function findActiveJobForProject(projectId: string): ActiveCLIJob | undefined {
    for (const j of jobs.values()) {
        if (j.projectId === projectId) return j;
    }
    return undefined;
}

/**
 * If a CLI run is already working on this project, kill it and wait for
 * its finally block to unregister. Enforces "one CLI per project" by
 * superseding old runs — the newer request wins. We don't know how
 * users end up launching two CLIs on the same project (double-click?
 * two tabs? retry-on-slow-response?) but it's been observed in prod and
 * the races it creates (split project_data writes, orphan fix commits
 * over a completing build) are worse than silently dropping the older
 * run. Bounded wait so a stuck job can't block the new one indefinitely.
 */
export async function preemptProjectJob(projectId: string, waitMs = 20_000): Promise<boolean> {
    const existing = findActiveJobForProject(projectId);
    if (!existing) return false;
    console.log(`[CLIActiveJobs] Preempting ${existing.kind} job ${existing.jobId} on project ${projectId} to make way for a new run`);
    try {
        existing.abort?.();
    } catch (e: any) {
        console.warn(`[CLIActiveJobs] Abort callback threw for job ${existing.jobId}: ${e?.message}`);
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && jobs.has(existing.jobId)) {
        await new Promise(r => setTimeout(r, 50));
    }
    if (jobs.has(existing.jobId)) {
        console.warn(`[CLIActiveJobs] Preempted job ${existing.jobId} did not unregister within ${waitMs}ms — proceeding anyway`);
    }
    return true;
}
