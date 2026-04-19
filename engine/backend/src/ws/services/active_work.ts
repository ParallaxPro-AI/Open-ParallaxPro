/**
 * active_work.ts — unified "is the backend busy?" view.
 *
 * Pulls together every class of in-flight LLM/CLI work so deploy.sh can
 * poll a single endpoint and only trigger a pm2 restart once the box is
 * truly quiet. Two inputs:
 *   - cli_active_jobs registry (CREATE_GAME, FIX_GAME, admin regens — any
 *     spawnCLIAgent child process).
 *   - A counter bumped around every callLLMStream call, covering chat
 *     turns that go through the direct LLM API (and the CLI-fallback
 *     chat path, which also routes through callLLMStream).
 *
 * Both counters live in memory only; they reset to zero on process
 * restart, which is fine because the work they track dies with the
 * process too.
 */

import { listActiveJobs } from './pipeline/cli_active_jobs.js';

let activeLLMStreams = 0;

export function beginLLMStream(): void {
    activeLLMStreams++;
}

export function endLLMStream(): void {
    activeLLMStreams = Math.max(0, activeLLMStreams - 1);
}

export interface ActiveWorkSummary {
    total: number;
    llmStreams: number;
    cliJobs: Array<{
        jobId: string;
        kind: string;
        projectId: string;
        description: string;
        startedAt: number;
    }>;
}

export function getActiveWorkSummary(): ActiveWorkSummary {
    const jobs = listActiveJobs();
    return {
        total: jobs.length + activeLLMStreams,
        llmStreams: activeLLMStreams,
        cliJobs: jobs.map(j => ({
            jobId: j.jobId,
            kind: j.kind,
            projectId: j.projectId,
            description: j.description,
            startedAt: j.startedAt,
        })),
    };
}
