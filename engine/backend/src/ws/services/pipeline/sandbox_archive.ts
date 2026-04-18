/**
 * sandbox_archive.ts — admin-only snapshot of a CREATE_GAME sandbox for
 * later analysis.
 *
 * Runs once per CREATE_GAME run (both success and failure), right before
 * the sandbox's tmp dir is nuked. Copies:
 *
 *   - metadata.json — jobId/projectId/user/status/summary/cost/duration,
 *                     plus a backlink to the session capture dir so one
 *                     archive entry ties together "what the CLI did" (logs)
 *                     with "what the CLI wrote to disk" (files).
 *   - TASK.md       — the prompt the agent was given, including any retry
 *                     guidance appended after the first assembler failure.
 *   - project/      — the full file tree the CLI produced (the 4 template
 *                     JSONs + behaviors/ + systems/ + ui/ + scripts/).
 *                     Failed runs are preserved here too — that's the whole
 *                     point: creator_snapshots.project_data is null on
 *                     failure, so without this archive the broken output
 *                     would be lost forever.
 *
 * Admin-only. Nothing here surfaces to user-visible routes — it lives on
 * the host filesystem alongside cli_session_logs/ and is not served by any
 * endpoint. Never throw out of here: archive failure must never break a run.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname_sa = path.dirname(fileURLToPath(import.meta.url));

// Sibling of cli_session_logs. Gitignored at the repo root. Same volume
// mount as the DB + session captures so a single persistence strategy
// covers all three.
const ARCHIVE_ROOT = path.resolve(__dirname_sa, '../../../../cli_sandbox_archives');

export interface SandboxArchiveCtx {
    jobId?: string;
    projectId?: string;
    userId?: number;
    username?: string;
    description?: string;
    status: 'success' | 'failed';
    templateId?: string;
    summary?: string;
    costUsd?: number;
    durationMs?: number;
    /** Path into cli_session_logs/ for the matching stdout/stderr + native capture. */
    sessionCapturePath?: string | null;
}

export function archiveCreatorSandbox(sandboxDir: string, ctx: SandboxArchiveCtx): string | null {
    try {
        const archivedAt = Date.now();
        const shortId = (ctx.jobId || 'anon').slice(0, 8);
        const ts = new Date(archivedAt).toISOString().replace(/[:.]/g, '-');
        const dirname = `${ts}_${ctx.status}_${shortId}`;

        fs.mkdirSync(ARCHIVE_ROOT, { recursive: true });
        const destDir = path.join(ARCHIVE_ROOT, dirname);
        fs.mkdirSync(destDir, { recursive: true });

        const meta = {
            jobId: ctx.jobId || null,
            projectId: ctx.projectId || null,
            userId: ctx.userId ?? null,
            username: ctx.username || null,
            templateId: ctx.templateId || null,
            description: ctx.description || null,
            status: ctx.status,
            summary: ctx.summary || null,
            costUsd: ctx.costUsd ?? null,
            durationMs: ctx.durationMs ?? null,
            sessionCapturePath: ctx.sessionCapturePath || null,
            hostname: os.hostname(),
            archivedAt: new Date(archivedAt).toISOString(),
            archivedAtEpochMs: archivedAt,
        };
        fs.writeFileSync(path.join(destDir, 'metadata.json'), JSON.stringify(meta, null, 2));

        const taskPath = path.join(sandboxDir, 'TASK.md');
        if (fs.existsSync(taskPath)) {
            try { fs.copyFileSync(taskPath, path.join(destDir, 'TASK.md')); } catch (e: any) {
                console.warn(`[SandboxArchive] TASK.md copy failed: ${e?.message}`);
            }
        }

        const projectSrc = path.join(sandboxDir, 'project');
        if (fs.existsSync(projectSrc)) {
            copyDirRecursive(projectSrc, path.join(destDir, 'project'));
        }

        return destDir;
    } catch (e: any) {
        console.warn(`[SandboxArchive] Failed to archive sandbox (non-fatal): ${e?.message}`);
        return null;
    }
}

function copyDirRecursive(src: string, dest: string): void {
    try { fs.mkdirSync(dest, { recursive: true }); } catch {}
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(s, d);
        } else if (entry.isFile()) {
            try { fs.copyFileSync(s, d); } catch (e: any) {
                console.warn(`[SandboxArchive] Copy failed for ${entry.name}: ${e?.message}`);
            }
        }
    }
}

export function sandboxArchiveRoot(): string { return ARCHIVE_ROOT; }
