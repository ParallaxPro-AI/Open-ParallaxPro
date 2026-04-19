/**
 * feedback.ts — agent feedback collection (CREATE_GAME + FIX_GAME).
 *
 * Every completed CREATE_GAME build and every committed FIX_GAME change
 * writes a pending row to `agent_feedback`. On the next WS connect the
 * editor renders a feedback form in the chat panel and the user rates
 * the result (👍 / 👎 + free-form text). Submission unlocks the chat,
 * triggers an AI follow-up turn, and leaves the row behind as training
 * data for prompt / pipeline improvements.
 *
 * CREATE_GAME is strict — no dismiss. Matches the user's expectation
 * that a 20-minute build deserves a sentence of feedback. FIX_GAME is
 * soft — dismissable, but the pending row stays until actually
 * submitted, so the next WS connect re-prompts.
 */

import db from '../../db/connection.js';

export type FeedbackKind = 'create_game' | 'fix_game';
export type FeedbackRating = 'up' | 'down';
export type FeedbackResolution = 'submitted' | 'dismissed';

export interface PendingFeedback {
    id: number;
    kind: FeedbackKind;
    prompt: string;
    createdAt: string;
    /** For FIX_GAME — so the editor can link the feedback prompt back
     *  to the specific assistant bubble that applied the change. */
    chatMessageId: number | null;
}

const stmtInsert = db.prepare(`
    INSERT INTO agent_feedback (
        user_id, project_id, kind, job_id, chat_message_id,
        cli_session_path, prompt, project_before, project_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtGetPending = db.prepare(`
    SELECT id, kind, prompt, chat_message_id, created_at
    FROM agent_feedback
    WHERE project_id = ? AND resolved_at IS NULL
    ORDER BY id DESC
    LIMIT 1
`);

const stmtGetById = db.prepare('SELECT * FROM agent_feedback WHERE id = ?');

const stmtResolve = db.prepare(`
    UPDATE agent_feedback
    SET rating = ?, feedback_text = ?, resolution = ?,
        resolved_at = strftime('%Y-%m-%d %H:%M:%f','now')
    WHERE id = ? AND resolved_at IS NULL
`);

/**
 * Record a pending feedback row after a CLI run commits. Caller supplies
 * the snapshots inline (CREATE_GAME) or leaves them null and passes a
 * chat_message_id (FIX_GAME — snapshots already on chat_messages).
 */
export function recordPendingFeedback(row: {
    userId: number;
    projectId: string;
    kind: FeedbackKind;
    jobId?: string | null;
    chatMessageId?: number | null;
    cliSessionPath?: string | null;
    prompt: string;
    projectBefore?: string | null;
    projectAfter?: string | null;
}): number {
    const info = stmtInsert.run(
        row.userId,
        row.projectId,
        row.kind,
        row.jobId ?? null,
        row.chatMessageId ?? null,
        row.cliSessionPath ?? null,
        row.prompt.slice(0, 10_000),
        row.projectBefore ?? null,
        row.projectAfter ?? null,
    );
    return info.lastInsertRowid as number;
}

/** Most recent unresolved feedback for a project, if any. */
export function getPendingFeedback(projectId: string): PendingFeedback | null {
    const row = stmtGetPending.get(projectId) as any;
    if (!row) return null;
    return {
        id: row.id as number,
        kind: row.kind as FeedbackKind,
        prompt: row.prompt ?? '',
        createdAt: row.created_at,
        chatMessageId: row.chat_message_id as number | null,
    };
}

export function getFeedbackById(id: number): any | null {
    return stmtGetById.get(id) ?? null;
}

/** Mark a row submitted or dismissed. No-op if already resolved. */
export function resolveFeedback(
    id: number,
    resolution: FeedbackResolution,
    rating: FeedbackRating | null,
    text: string | null,
): boolean {
    const info = stmtResolve.run(rating, text ? text.slice(0, 10_000) : null, resolution, id);
    return info.changes > 0;
}
