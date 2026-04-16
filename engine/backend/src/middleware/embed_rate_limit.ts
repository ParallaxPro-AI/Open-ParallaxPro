/**
 * Per-user budget for embedding-powered search on the HOSTED version
 * (parallaxpro.ai). Self-hosted instances run with no limit — local
 * users own the GPU/CPU so there's no reason to gate them.
 *
 * Callers check the budget before running an expensive vector-similarity
 * search; when exceeded, the handler falls back to plain substring
 * matching instead of 429ing the user. Shared by /api/engine/assets
 * and /api/engine/projects/templates.
 */

import { config } from '../config.js';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30; // 30 embedding searches per minute per user

const userBuckets = new Map<number, { count: number; resetAt: number }>();

/**
 * Returns true if the user has budget for another embedding search and
 * increments their count. Returns false when exceeded — caller should
 * fall back to a cheaper search path. Always returns true on self-hosted.
 */
export function tryConsumeEmbedBudget(userId: number | undefined): boolean {
    if (!config.isHosted) return true; // no limit on self-hosted
    if (!userId) return true; // unauthenticated is gated elsewhere
    const now = Date.now();
    const entry = userBuckets.get(userId);
    if (!entry || now > entry.resetAt) {
        userBuckets.set(userId, { count: 1, resetAt: now + WINDOW_MS });
        return true;
    }
    if (entry.count >= MAX_PER_WINDOW) return false;
    entry.count++;
    return true;
}
