/**
 * Cloudflare Realtime TURN credentials.
 *
 * Mints short-lived WebRTC TURN credentials via Cloudflare's REST API
 * (https://developers.cloudflare.com/realtime/turn). Returns an
 * iceServers array suitable for passing through to RTCPeerConnection
 * config alongside the public STUN servers we always use.
 *
 * The API token never leaves the backend; clients only ever see the
 * generated username/credential pair. We cache one credential set for
 * roughly half its TTL — every connecting peer in that window gets the
 * same creds, which keeps API calls minimal.
 *
 * Returns null when env vars aren't set or the API call fails. Callers
 * should treat that as "TURN unavailable" — direct WebRTC and STUN
 * still work for ~80% of NATs, so the worst case is degraded coverage,
 * not a broken multiplayer.
 */

const TOKEN_ID = process.env.CLOUDFLARE_TURN_TOKEN_ID;
const API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN;

const TTL_SECONDS = 8 * 3600;                  // each cred set good for 8 hours
const REFRESH_BEFORE_MS = 4 * 60 * 60 * 1000;  // refresh when <4h validity left

export interface IceServer {
    urls: string | string[];
    username?: string;
    credential?: string;
}

interface CachedCreds {
    iceServers: IceServer[];
    expiresAt: number;
}

let cached: CachedCreds | null = null;
let inflight: Promise<CachedCreds | null> | null = null;

export function isTurnConfigured(): boolean {
    return !!(TOKEN_ID && API_TOKEN);
}

export async function getTurnIceServers(): Promise<IceServer[] | null> {
    const creds = await getCredsCached();
    return creds?.iceServers ?? null;
}

async function getCredsCached(): Promise<CachedCreds | null> {
    if (!isTurnConfigured()) return null;
    const now = Date.now();
    if (cached && cached.expiresAt - now > REFRESH_BEFORE_MS) return cached;
    if (inflight) return inflight;

    inflight = fetchFreshCreds()
        .then((next) => { cached = next; return next; })
        .catch((e) => { console.warn('[cloudflare-turn]', e); return cached; })
        .finally(() => { inflight = null; });
    return inflight;
}

async function fetchFreshCreds(): Promise<CachedCreds | null> {
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${TOKEN_ID}/credentials/generate`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`credentials request failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    // Cloudflare returns { iceServers: { urls, username, credential } }.
    // Normalize to an array so it can be merged into RTCConfiguration.
    const raw = data?.iceServers;
    if (!raw) throw new Error('response missing iceServers field');
    const arr = Array.isArray(raw) ? raw : [raw];
    return { iceServers: arr, expiresAt: Date.now() + TTL_SECONDS * 1000 };
}
