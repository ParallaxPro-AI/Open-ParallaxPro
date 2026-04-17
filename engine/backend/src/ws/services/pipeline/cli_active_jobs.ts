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
