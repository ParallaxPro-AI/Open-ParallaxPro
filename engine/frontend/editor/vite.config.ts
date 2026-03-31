import { defineConfig } from 'vite';
import path from 'path';

// Prevent Vite from crashing when the backend restarts
process.on('uncaughtException', (err) => {
    if (err.message?.includes('socket hang up') || err.message?.includes('ECONNRESET') || err.message?.includes('ECONNREFUSED')) {
        return;
    }
    console.error(err);
    process.exit(1);
});

export default defineConfig(({ command }) => ({
    root: '.',
    server: {
        port: 5174,
        host: true,
        watch: {
            // Watch runtime and shared directories outside the editor root
            // so that changes to them trigger HMR
            ignored: ['!**/engine/frontend/runtime/**', '!**/engine/shared/**'],
        },
        proxy: {
            '/api/engine': { target: 'http://localhost:3002', configure: (p: any) => p.on('error', () => {}) },
            '/assets': { target: 'http://localhost:3002', configure: (p: any) => p.on('error', () => {}) },
            '/uploads': { target: 'http://localhost:3002', configure: (p: any) => p.on('error', () => {}) },
            '/ws/engine': { target: 'http://localhost:3002', ws: true, changeOrigin: true, configure: (p: any) => p.on('error', () => {}) },
            '/ws/multiplayer': { target: 'http://localhost:3002', ws: true, changeOrigin: true, configure: (p: any) => p.on('error', () => {}) },
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
            },
        },
    },
    plugins: [
        {
            name: 'play-page-rewrite',
            configureServer(server) {
                server.middlewares.use((req, _res, next) => {
                    if (req.url && /^\/play\//.test(req.url)) {
                        req.url = '/play.html';
                    }
                    next();
                });
            },
        },
    ],
}));
