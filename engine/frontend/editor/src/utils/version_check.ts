/**
 * Checks for editor updates on startup.
 * Connects to parallaxpro.ai to see if a newer version is available.
 */

const EDITOR_VERSION = '0.1.0';
const UPDATE_URL = 'https://parallaxpro.ai/api/editor/updates';

export function checkForUpdates(): void {
    const hostname = window.location.hostname;
    const isHosted = hostname === 'parallaxpro.ai' || hostname === 'www.parallaxpro.ai';
    const base = isHosted ? '' : UPDATE_URL.replace('/api/editor/updates', '');
    const source = isHosted ? 'hosted' : 'self-hosted';

    const headers: Record<string, string> = {};
    if (isHosted) {
        const token = localStorage.getItem('auth_token') ?? localStorage.getItem('token');
        if (token) headers['Authorization'] = `Bearer ${token}`;
    }

    fetch(`${base}/api/editor/updates?v=${EDITOR_VERSION}&source=${source}`, { headers })
        .then(r => r.json())
        .then(data => {
            if (data.latest && data.latest !== EDITOR_VERSION) {
                console.info(`[ParallaxPro] New version available: ${data.latest} (current: ${EDITOR_VERSION})`);
            }
        })
        .catch(() => {});
}
