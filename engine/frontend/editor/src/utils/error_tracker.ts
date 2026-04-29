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

// On-screen error banner. iOS Safari has no easily-accessible JS console,
// and a tab refresh ("A problem repeatedly occurred") happens before any
// remote log flush completes. The banner gives the user a chance to read
// the error mid-flight. Only shows when ?debug=1 is on the URL or the
// 'pp_debug' localStorage flag is set, so production users don't see it.
const debugVisible = (() => {
    try {
        if (typeof window === 'undefined') return false;
        const u = new URL(window.location.href);
        if (u.searchParams.get('debug') === '1') return true;
        return window.localStorage?.getItem('pp_debug') === '1';
    } catch { return false; }
})();

// Persist errors to localStorage SYNCHRONOUSLY so they survive an iOS
// "A problem repeatedly occurred" tab reload. After the reload, the boot
// path below pulls these out and shows them in the banner — that's the
// only way we get to read errors that crashed the tab on iPhone Safari.
const PERSIST_KEY = 'pp_recent_errors';
const PERSIST_MAX = 20;
function persistError(message: string, stack: string | null): void {
    try {
        if (typeof localStorage === 'undefined') return;
        const raw = localStorage.getItem(PERSIST_KEY);
        const list = raw ? JSON.parse(raw) : [];
        list.push({
            t: Date.now(),
            url: typeof location !== 'undefined' ? location.href : '',
            message: String(message || '').slice(0, 500),
            stack: (stack || '').slice(0, 1500),
        });
        while (list.length > PERSIST_MAX) list.shift();
        localStorage.setItem(PERSIST_KEY, JSON.stringify(list));
    } catch { /* swallow */ }
}
function loadPersistedErrors(): Array<{ t: number; url: string; message: string; stack: string }> {
    try {
        if (typeof localStorage === 'undefined') return [];
        const raw = localStorage.getItem(PERSIST_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}
// Expose a clear-button on the banner, plus a console hook for power-users.
if (typeof window !== 'undefined') {
    (window as any).ppClearErrors = () => {
        try { localStorage.removeItem(PERSIST_KEY); localStorage.removeItem(CHECKPOINT_KEY); } catch { /* swallow */ }
    };
}

// Checkpoint trail — scripts (mp_bridge.ts etc.) call ppCheckpoint("name")
// at critical points along risky flows (Start Game, host lobby, etc).
// Trail persists across iOS tab reloads so we can see which step ran
// last before the crash.
const CHECKPOINT_KEY = 'pp_checkpoints';
const CHECKPOINT_MAX = 30;
function pushCheckpoint(name: string): void {
    try {
        if (typeof localStorage === 'undefined') return;
        const raw = localStorage.getItem(CHECKPOINT_KEY);
        const list = raw ? JSON.parse(raw) : [];
        list.push({ t: Date.now(), name: String(name || '').slice(0, 200) });
        while (list.length > CHECKPOINT_MAX) list.shift();
        localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(list));
    } catch { /* swallow */ }
}
function loadCheckpoints(): Array<{ t: number; name: string }> {
    try {
        if (typeof localStorage === 'undefined') return [];
        const raw = localStorage.getItem(CHECKPOINT_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}
if (typeof window !== 'undefined') (window as any).ppCheckpoint = pushCheckpoint;

let errorBanner: HTMLElement | null = null;
function showErrorBanner(message: string, stack: string | null): void {
    if (!debugVisible || typeof document === 'undefined') return;
    if (!errorBanner) {
        errorBanner = document.createElement('div');
        errorBanner.style.cssText =
            'position:fixed;top:0;left:0;right:0;z-index:2147483647;' +
            'background:rgba(180,30,30,0.95);color:#fff;font:12px/1.4 monospace;' +
            'padding:10px 14px 10px 14px;max-height:40vh;overflow:auto;' +
            'pointer-events:auto;white-space:pre-wrap;word-break:break-word;' +
            '-webkit-user-select:text;user-select:text;';
        const close = document.createElement('span');
        close.textContent = '×';
        close.style.cssText = 'position:absolute;top:4px;right:10px;font-size:22px;cursor:pointer;line-height:1;';
        close.onclick = () => { if (errorBanner) errorBanner.style.display = 'none'; };
        errorBanner.appendChild(close);
        if (document.body) document.body.appendChild(errorBanner);
        else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(errorBanner!));
    }
    errorBanner.style.display = '';
    const stamp = new Date().toLocaleTimeString();
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:700;margin-bottom:2px;';
    head.textContent = '[' + stamp + '] ' + message;
    const body = document.createElement('div');
    body.style.cssText = 'opacity:0.85;font-size:11px;';
    body.textContent = (stack || '').slice(0, 800);
    errorBanner.appendChild(head);
    errorBanner.appendChild(body);
    // Cap entries; oldest fall off
    while (errorBanner.children.length > 8) errorBanner.removeChild(errorBanner.children[1]);
}

window.addEventListener('error', (event) => {
    if (event.message === 'Script error.' && !event.filename) return;
    const stack = event.error?.stack || `${event.filename}:${event.lineno}:${event.colno}`;
    persistError(event.message || 'Unknown error', stack);
    enqueue(event.message || 'Unknown error', stack);
    showErrorBanner(event.message || 'Unknown error', stack);
});

window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack || null : null;
    persistError('Promise rejected: ' + message, stack);
    enqueue(message, stack);
    showErrorBanner('Promise rejected: ' + message, stack);
});

// Errors forwarded from HUD / panel iframes (separate document scope —
// the parent's window.onerror doesn't see them otherwise).
window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'pp_iframe_error') return;
    const message = String(data.message || 'iframe error');
    const stack = String(data.stack || '');
    persistError('[iframe] ' + message, stack || null);
    enqueue('[iframe] ' + message, stack || null);
    showErrorBanner('[iframe ' + (data.kind || 'error') + '] ' + message, stack);
});

// Replay persisted errors + checkpoints from previous session on boot.
// iOS Safari often reloads the tab via "A problem repeatedly occurred"
// before any banner can render. Persisted state survives the reload so
// the user can see what crashed and where the last checkpoint was.
// Only shown when ?debug=1 is on the URL.
if (debugVisible) {
    const past = loadPersistedErrors();
    const checkpoints = loadCheckpoints();
    if (past.length > 0 || checkpoints.length > 0) {
        const showPast = () => {
            // Force banner creation with a placeholder so we can prepend.
            showErrorBanner('— prior session —', null);
            for (let i = past.length - 1; i >= 0; i--) {
                const e = past[i];
                showErrorBanner('[prior • ' + new Date(e.t).toLocaleTimeString() + '] ' + e.message, e.stack);
            }
            if (checkpoints.length > 0) {
                const cpStr = checkpoints
                    .slice(-15)
                    .map(c => new Date(c.t).toLocaleTimeString().slice(-8) + '  ' + c.name)
                    .join('\n');
                showErrorBanner('CHECKPOINT TRAIL (last ' + Math.min(checkpoints.length, 15) + '):', cpStr);
            }
        };
        if (document.body) showPast();
        else document.addEventListener('DOMContentLoaded', showPast);
    }
}

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
