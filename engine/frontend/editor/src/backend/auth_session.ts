/**
 * Bridges the self-hosted editor to parallaxpro.ai's auth so the
 * publish-from-local flow has a valid JWT. On parallaxpro.ai itself the
 * token is already in localStorage and `ensureLoggedIn()` short-circuits.
 *
 * Popup flow:
 *   editor → window.open('parallaxpro.ai/cli-login?callback=http://localhost:5174/auth/callback&state=…')
 *   landing → (login if needed) → 302 to callback URL with ?token=…&state=…
 *   callback page → postMessage to opener → closes itself
 *   editor → validates state, persists token, resolves promise
 */

const LOGIN_ORIGIN = 'https://parallaxpro.ai';
const CLI_LOGIN_PATH = '/cli-login';
const CALLBACK_PATH = '/auth/callback';
const MESSAGE_TYPE = 'parallaxpro-auth';

// Dedicated storage key for the prod JWT acquired via the cli-login
// popup. Kept separate from 'auth_token'/'token' (which the local
// backend_client sends to its own backend) so we don't accidentally
// hand a parallaxpro.ai JWT to the self-hosted local backend — its
// dev-secret can't verify it, so it would 401 every request even
// though its dev-mode bypass would have admitted an anonymous one.
export const CLI_TOKEN_KEY = 'pp_cli_token';

export function getStoredToken(): string | null {
    // Fall back to legacy auth_token/token on parallaxpro.ai itself so
    // the hosted editor keeps working without a second login round-trip.
    const dedicated = localStorage.getItem(CLI_TOKEN_KEY);
    if (dedicated) return dedicated;
    const h = window.location.hostname;
    if (h === 'parallaxpro.ai' || h === 'www.parallaxpro.ai') {
        return localStorage.getItem('auth_token') ?? localStorage.getItem('token');
    }
    return null;
}

export function clearStoredToken(): void {
    localStorage.removeItem(CLI_TOKEN_KEY);
}

/**
 * Best-effort JWT expiry check. Tokens without an `exp` claim are treated
 * as valid (server decides on the actual request); malformed tokens are
 * treated as invalid so we force a re-login. The 60s leeway avoids a race
 * where the token looks fresh locally but is rejected by the server.
 */
function isTokenValid(token: string): boolean {
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (!payload.exp) return true;
        return payload.exp * 1000 > Date.now() + 60_000;
    } catch {
        return false;
    }
}

export function decodeToken(token: string): { id?: number; email?: string; username?: string } | null {
    try {
        return JSON.parse(atob(token.split('.')[1]));
    } catch {
        return null;
    }
}

export async function ensureLoggedIn(): Promise<string> {
    const existing = getStoredToken();
    if (existing && isTokenValid(existing)) return existing;
    return loginViaPopup();
}

function loginViaPopup(): Promise<string> {
    return new Promise((resolve, reject) => {
        const state = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        const callbackUrl = `${window.location.origin}${CALLBACK_PATH}`;
        const loginUrl = `${LOGIN_ORIGIN}${CLI_LOGIN_PATH}?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;

        const popup = window.open(loginUrl, 'parallaxpro-cli-login', 'width=520,height=680,noopener=no');
        if (!popup) {
            reject(new Error('Popup blocked. Allow popups for this site, then click Publish again.'));
            return;
        }

        let settled = false;
        const cleanup = () => {
            settled = true;
            window.removeEventListener('message', onMessage);
            clearInterval(pollClose);
        };

        const onMessage = (e: MessageEvent) => {
            if (settled) return;
            if (e.origin !== window.location.origin) return;
            const data = e.data as { type?: string; token?: string | null; state?: string | null; error?: string | null } | null;
            if (!data || data.type !== MESSAGE_TYPE) return;
            if (data.state !== state) return;
            cleanup();
            if (data.error) { reject(new Error(data.error)); return; }
            if (!data.token) { reject(new Error('Login returned no token.')); return; }
            try { localStorage.setItem(CLI_TOKEN_KEY, data.token); } catch {}
            resolve(data.token);
        };
        window.addEventListener('message', onMessage);

        const pollClose = setInterval(() => {
            if (settled) return;
            let closed = false;
            try { closed = popup.closed; } catch { closed = true; }
            if (closed) {
                cleanup();
                reject(new Error('Sign-in window closed before completing.'));
            }
        }, 500);
    });
}
