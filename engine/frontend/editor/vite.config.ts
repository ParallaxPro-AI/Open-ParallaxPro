import { defineConfig } from 'vite';
import path from 'path';
import { execSync } from 'child_process';

// Prevent Vite from crashing when the backend restarts
process.on('uncaughtException', (err) => {
    if (err.message?.includes('socket hang up') || err.message?.includes('ECONNRESET') || err.message?.includes('ECONNREFUSED')) {
        return;
    }
    console.error(err);
    process.exit(1);
});

// Override where vite proxies backend requests. Default matches the
// backend's default PORT. If you change the backend PORT, set BACKEND_URL
// here too so the proxy still lands.
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3003';

// Resolve the commit hash of the engine the editor was built against. Used
// by the publish-from-local flow so the server can pair each published
// game with the exact engine bundle it needs to replay. Resolves at dev-
// server start *and* at build time. Falls back to 'unknown' outside a git
// checkout (tarball installs, CI without .git, etc).
function resolveEngineGitHash(): string {
    if (process.env.ENGINE_GIT_HASH) return process.env.ENGINE_GIT_HASH;
    try {
        const hash = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
        // Uncommitted engine changes mean two laptops on the same HEAD
        // could still disagree on behaviour. Flag that so cloud-sync
        // warns about mismatches instead of trusting the bare hash.
        let dirty = false;
        try { execSync('git diff --quiet HEAD --', { stdio: 'ignore' }); } catch { dirty = true; }
        return dirty ? `${hash}+dirty` : hash;
    } catch {
        return 'unknown';
    }
}
const ENGINE_GIT_HASH = resolveEngineGitHash();

export default defineConfig(({ command }) => ({
    root: '.',
    define: {
        __ENGINE_GIT_HASH__: JSON.stringify(ENGINE_GIT_HASH),
    },
    server: {
        port: 5174,
        host: true,
        watch: {
            // Watch runtime and shared directories outside the editor root
            // so that changes to them trigger HMR
            ignored: ['!**/engine/frontend/runtime/**', '!**/engine/shared/**'],
        },
        proxy: {
            '/api/engine': { target: BACKEND_URL, configure: (p: any) => p.on('error', () => {}) },
            '/assets': { target: BACKEND_URL, configure: (p: any) => p.on('error', () => {}) },
            '/uploads': { target: BACKEND_URL, configure: (p: any) => p.on('error', () => {}) },
            '/ws/engine': { target: BACKEND_URL, ws: true, changeOrigin: true, configure: (p: any) => p.on('error', () => {}) },
            '/ws/multiplayer': { target: BACKEND_URL, ws: true, changeOrigin: true, configure: (p: any) => p.on('error', () => {}) },
        },
    },
    base: command === 'build' ? '/editor/' : '/',
    resolve: {
        alias: {
            '@dimforge/rapier3d-compat': path.resolve(__dirname, 'node_modules/@dimforge/rapier3d-compat/rapier.mjs'),
        },
    },
    optimizeDeps: {
        include: ['@dimforge/rapier3d-compat', 'lucide'],
    },
    build: {
        outDir: 'dist',
        rollupOptions: {
            input: {
                main: path.resolve(__dirname, 'index.html'),
                play: path.resolve(__dirname, 'play.html'),
                preview: path.resolve(__dirname, 'preview.html'),
                authCallback: path.resolve(__dirname, 'auth-callback.html'),
            },
        },
    },
    plugins: [
        {
            name: 'page-rewrites',
            configureServer(server) {
                server.middlewares.use((req, _res, next) => {
                    if (req.url) {
                        if (/^\/play\//.test(req.url)) {
                            req.url = '/play.html';
                        } else if (/^\/auth\/callback(?:\?|$)/.test(req.url)) {
                            // Preserve query string when serving the static HTML.
                            const q = req.url.indexOf('?');
                            req.url = q >= 0 ? `/auth-callback.html${req.url.slice(q)}` : '/auth-callback.html';
                        }
                    }
                    next();
                });
            },
        },
    ],
}));
