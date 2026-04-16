/**
 * Format a server-produced SQLite timestamp for display in the user's
 * local timezone. The backend stamps `datetime('now')` which returns
 * `YYYY-MM-DD HH:MM:SS` without a trailing `Z`, so the naive string
 * is ambiguous — we know it's UTC by convention and reparse it here.
 *
 * Returns the caller's default fallback when the input is empty or
 * unparseable, rather than a broken "Invalid Date".
 */
export function formatServerTime(raw: string | null | undefined, fallback = 'unknown'): string {
    if (!raw) return fallback;
    const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const d = new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z');
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleString();
}
