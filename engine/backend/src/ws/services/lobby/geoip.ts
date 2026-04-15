/**
 * GeoIP lookup + cross-peer ping estimation.
 *
 * Wraps geoip-lite (a redistributable, ~30MB MaxMind GeoLite2 City snapshot
 * bundled with the npm package — no signup, no external API). Used by the
 * lobby service to compute an estimated P2P RTT between a browsing peer
 * and each lobby's host without actually opening a WebRTC connection.
 *
 * Estimation model:
 *   ping_ms ≈ BASELINE_MS + distance_km * MS_PER_KM
 * BASELINE_MS covers handshake + last-mile + protocol overhead. MS_PER_KM
 * is empirical — fiber theoretical is ~5 µs/km but real-world routes
 * detour, so we use ~13 µs/km / round-trip ⇒ 26 µs/km RTT.
 *
 * Loopback / private IPs: the npm DB has no entry, so we treat both
 * endpoints as colocated (5 ms) — matches the localhost preview-client
 * dev workflow without lying to real users.
 */

// geoip-lite is CommonJS and ships no types. Backend is ESM, so use
// createRequire to load it without dragging in @types/geoip-lite.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const geoip: { lookup: (ip: string) => { ll?: [number, number]; country?: string; city?: string } | null } = require('geoip-lite');

const BASELINE_MS = 25;
const MS_PER_KM = 0.026;
const LOCAL_PEER_PING_MS = 5;

export interface GeoLoc {
    lat: number;
    lon: number;
    country?: string;
    city?: string;
}

export function lookupGeo(ip: string | undefined | null): GeoLoc | null {
    if (!ip) return null;
    const cleaned = stripIpv6Prefix(ip);
    if (isLocalIp(cleaned)) return null;
    const r = geoip.lookup(cleaned);
    if (!r || !r.ll) return null;
    return { lat: r.ll[0], lon: r.ll[1], country: r.country, city: r.city };
}

/**
 * RTT estimate between two peers identified by IP. Returns -1 when one
 * side is unknown and the other isn't (no signal to display). Two
 * loopback / LAN peers are treated as colocated.
 */
export function estimatePingMs(
    aIp: string | undefined | null,
    bIp: string | undefined | null,
): number {
    const a = stripIpv6Prefix(aIp || '');
    const b = stripIpv6Prefix(bIp || '');
    if (!a || !b) return -1;

    const aLocal = isLocalIp(a);
    const bLocal = isLocalIp(b);
    if (aLocal && bLocal) return LOCAL_PEER_PING_MS;
    // Same public IP (NAT'd colocated devices) — assume LAN.
    if (a === b) return LOCAL_PEER_PING_MS;

    const aGeo = aLocal ? null : lookupGeo(a);
    const bGeo = bLocal ? null : lookupGeo(b);
    if (!aGeo || !bGeo) return -1;

    const km = haversineKm(aGeo.lat, aGeo.lon, bGeo.lat, bGeo.lon);
    return Math.round(BASELINE_MS + km * MS_PER_KM);
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // earth radius, km
    const toRad = (x: number) => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function stripIpv6Prefix(ip: string): string {
    // ::ffff:1.2.3.4 → 1.2.3.4 (IPv4-mapped IPv6, common when Node listens dual-stack)
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    return ip;
}

function isLocalIp(ip: string): boolean {
    if (!ip) return true;
    if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
    if (ip.startsWith('10.')) return true;
    if (ip.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
    if (ip.startsWith('169.254.')) return true; // link-local
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique-local IPv6
    return false;
}
