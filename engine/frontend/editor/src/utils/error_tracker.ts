/**
 * Captures uncaught JS errors and unhandled promise rejections,
 * deduplicates by fingerprint, and periodically flushes batches to the backend.
 */

interface PendingError {
    fingerprint: string;
    message: string;
    stack: string | null;
    source: string;
    userAgent: string;
}

const pending = new Map<string, PendingError>();
let flushTimer = 0;
const FLUSH_INTERVAL = 10_000;
const MAX_PENDING = 50;

function computeFingerprint(message: string, stack: string | null): string {
    const firstFrame = stack?.split('\n').find(l => l.includes('at ')) || '';
    const key = message + '|' + firstFrame;
    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function enqueue(message: string, stack: string | null): void {
    const fp = computeFingerprint(message, stack);
    if (pending.has(fp) || pending.size >= MAX_PENDING) return;
    pending.set(fp, {
        fingerprint: fp,
        message: message.slice(0, 1000),
        stack: stack?.slice(0, 4000) || null,
        source: window.location.href,
        userAgent: navigator.userAgent,
    });
    scheduleFlush();
}

function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = window.setTimeout(flush, FLUSH_INTERVAL);
}

async function flush(): Promise<void> {
    flushTimer = 0;
    if (pending.size === 0) return;
    const batch = Array.from(pending.values()).slice(0, 10);
    for (const e of batch) pending.delete(e.fingerprint);

    try {
        await fetch('/api/engine/admin/errors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ errors: batch }),
        });
    } catch {
        // Error tracking should never disrupt the editor
    }

    if (pending.size > 0) scheduleFlush();
}

window.addEventListener('error', (event) => {
    if (event.message === 'Script error.' && !event.filename) return;
    enqueue(
        event.message || 'Unknown error',
        event.error?.stack || `${event.filename}:${event.lineno}:${event.colno}`
    );
});

window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack || null : null;
    enqueue(message, stack);
});

// Flush pending errors on page hide so they aren't lost
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pending.size > 0) {
        const batch = Array.from(pending.values()).slice(0, 10);
        navigator.sendBeacon(
            '/api/engine/admin/errors',
            new Blob([JSON.stringify({ errors: batch })], { type: 'application/json' })
        );
        for (const e of batch) pending.delete(e.fingerprint);
    }
});
