/**
 * fetch_with_retry.ts — small shared helper for fetches that fail under
 * flaky-wifi conditions (transient TCP RSTs, partial bodies, slow DNS).
 *
 * The plain `fetch(url)` calls scattered through the loaders have no retry
 * and no per-request timeout, so a bad-wifi user gets a permanently broken
 * game from a single packet loss. This wraps fetch + body-read so a failure
 * in either retries up to N times, with exponential backoff and a per-attempt
 * AbortSignal so a stuck connection actually gives up instead of hanging.
 *
 * Happy-path users (first attempt succeeds) see no behavior change — same
 * single fetch, same body read, no extra latency.
 */

export interface RetryOpts {
    /** Max attempts including the first. Default 3. */
    retries?: number;
    /** First-retry delay; doubles each subsequent retry. Default 500ms. */
    baseDelayMs?: number;
    /** Per-attempt wall-clock cap before AbortSignal fires. Default 60s. */
    timeoutMs?: number;
    /** Tag prefix for console.warn logs so loaders are distinguishable. */
    label?: string;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY = 500;
const DEFAULT_TIMEOUT = 60_000;

/**
 * Fetch + consume body inside one retry envelope. The `consume` callback
 * runs against the Response and is responsible for body reads (json /
 * arrayBuffer / text / blob); a body-read failure mid-stream counts as a
 * retryable error, which is the whole point — partial bodies are common
 * on bad wifi.
 *
 * Retries: any thrown error (including AbortError from our timeout), plus
 * 5xx / 408 / 429 responses. Permanent 4xx (404, 403, 401, ...) are
 * surfaced immediately so we don't spam the server with retries on a
 * deleted game.
 */
export async function fetchWithRetry<T>(
    url: string,
    consume: (res: Response) => Promise<T>,
    init?: RequestInit,
    opts: RetryOpts = {},
): Promise<T> {
    const retries = opts.retries ?? DEFAULT_RETRIES;
    const baseDelay = opts.baseDelayMs ?? DEFAULT_BASE_DELAY;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    const label = opts.label ?? '[fetch]';

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        // Compose with a caller-supplied signal if any: abort either when
        // our timeout fires OR the caller cancels.
        if (init?.signal) {
            const callerSignal = init.signal;
            if (callerSignal.aborted) controller.abort();
            else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        try {
            const res = await fetch(url, { ...init, signal: controller.signal });
            if (!res.ok) {
                // Permanent client errors — don't retry. 408/429 ARE
                // retryable (slow client, rate limit recovery).
                const isPermanent = res.status >= 400 && res.status < 500
                    && res.status !== 408 && res.status !== 429;
                if (isPermanent) {
                    throw new Error(`${label} ${url} → HTTP ${res.status}`);
                }
                throw new Error(`${label} ${url} → HTTP ${res.status} (transient)`);
            }
            return await consume(res);
        } catch (e: any) {
            lastErr = e;
            // If the error is a permanent 4xx we already logged the URL —
            // bail without further retries.
            if (typeof e?.message === 'string' && /HTTP 4(?!08|29)\d\d/.test(e.message)) {
                throw e;
            }
            if (attempt < retries) {
                const delay = baseDelay * Math.pow(2, attempt - 1);
                console.warn(`${label} ${url} attempt ${attempt}/${retries} failed (${e?.message || e}); retrying in ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error(`${label} ${url} failed after ${retries} attempts:`, e?.message || e);
            }
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr ?? new Error(`${label} ${url} failed`);
}
