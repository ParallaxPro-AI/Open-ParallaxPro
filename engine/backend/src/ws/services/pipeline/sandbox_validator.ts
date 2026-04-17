/**
 * sandbox_validator.ts — token registry for the /validate-sandbox route.
 *
 * The CLI creator (and potentially the fixer, later) runs assembleGame
 * as its strictest validation step — but assembleGame lives in the
 * engine backend process, and the sandbox can only reach the engine
 * over HTTP. This module gives the sandbox a one-shot credential
 * (random UUID) mapped to its /tmp dir; the validate endpoint
 * resolves the token → dir and runs assembleGame against it.
 *
 * Tokens are created at sandbox setup and revoked on cleanup, so the
 * window in which a leaked token is usable is bounded by the run's
 * wall-clock. The endpoint never writes anything — only reads files
 * and returns a pass/fail — so exposure is minimal even if a token
 * escapes.
 */

import { randomUUID } from 'crypto';

const tokens = new Map<string, string>();

/** Mint a new token for a sandbox dir. Caller must pair with unregister. */
export function registerSandboxToken(sandboxDir: string): string {
    const token = randomUUID();
    tokens.set(token, sandboxDir);
    return token;
}

/** Release a token (call in the same `finally` that releases the CLI slot). */
export function unregisterSandboxToken(token: string): void {
    tokens.delete(token);
}

/** Resolve a token to its sandbox dir, or null if unknown/revoked. */
export function lookupSandboxToken(token: string): string | null {
    return tokens.get(token) || null;
}
