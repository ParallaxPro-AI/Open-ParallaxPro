import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import db from './db/connection.js';
import { createSchema } from './db/schema.js';
import type { EnginePlugin } from './plugin.js';

// Per-IP rate limiter for HTTP API routes
const ipHits = new Map<string, { count: number; resetAt: number }>();
const HTTP_RATE_LIMIT = 480;  // requests per window
const HTTP_RATE_WINDOW = 60_000; // 1 minute
setInterval(() => { const now = Date.now(); for (const [k, v] of ipHits) { if (now > v.resetAt) ipHits.delete(k); } }, 60_000);

function httpRateLimit(req: Request, res: Response, next: NextFunction): void {
    const ip = (req.headers['x-real-ip'] as string) || req.ip || 'unknown';
    const now = Date.now();
    const entry = ipHits.get(ip);
    if (!entry || now > entry.resetAt) {
        ipHits.set(ip, { count: 1, resetAt: now + HTTP_RATE_WINDOW });
        next(); return;
    }
    if (entry.count >= HTTP_RATE_LIMIT) {
        res.status(429).json({ error: 'Too many requests. Try again later.' });
        return;
    }
    entry.count++;
    next();
}

export { type EnginePlugin } from './plugin.js';

/**
 * Create and configure the engine. Optionally accepts plugins for hosted extensions.
 * Returns the Express app and HTTP server (not yet listening).
 */
export async function createEngine(plugins: EnginePlugin[] = []): Promise<{
    app: express.Express;
    server: http.Server;
    shutdown: () => void;
}> {
    // Initialize database
    createSchema(db);

    // Let plugins extend the schema
    for (const p of plugins) {
        if (p.extendSchema) {
            p.extendSchema(db);
        }
    }

    // Dynamic imports (after schema is ready, since routes prepare statements)
    const { default: projectRoutes, setProjectPlugins } = await import('./routes/projects.js');
    const { default: assetRoutes } = await import('./routes/assets.js');
    const { setupEditorWebSocket, setPlugins } = await import('./ws/editor_ws.js');

    // Pass plugins to WebSocket handler and project routes
    setPlugins(plugins);
    setProjectPlugins(plugins);

    // Express app
    const app = express();

    // Auth middleware for project routes — applies to both core router and plugin routes
    const pluginAuth = plugins.find(p => p.authMiddleware)?.authMiddleware;
    const { requireAuth } = await import('./middleware/auth.js');
    app.use('/api/engine/projects', pluginAuth || requireAuth);

    app.use(cors({ origin: config.corsOrigins, credentials: true }));
    app.use(express.json({ limit: '10mb' }));
    if (config.isHosted) app.use('/api/engine', httpRateLimit);

    // Static asset serving — local files first, fallback to CDN redirect for self-hosted
    app.use('/assets', express.static(config.assetsDir, { maxAge: '1y', immutable: true }));
    if (config.assetsCdn && !config.isHosted) {
        // Redirect asset files to CDN (includes LOD and collision sidecar .bin files)
        // Remove CORS headers before redirect to avoid duplicate headers (CDN adds its own)
        const CDN_EXTENSIONS = /\.(glb|gltf|obj|fbx|png|jpg|jpeg|webp|ogg|mp3|wav|json|bin)$/i;
        app.use('/assets', (req, res, next) => {
            if (CDN_EXTENSIONS.test(req.url)) {
                res.removeHeader('Access-Control-Allow-Origin');
                res.removeHeader('Access-Control-Allow-Credentials');
                res.redirect(302, `${config.assetsCdn}/assets${req.url}`);
            } else {
                next();
            }
        });
    }

    // Plugin routes (before core routes so plugins can add /api/engine/projects/* endpoints)
    for (const p of plugins) {
        if (p.registerRoutes) {
            p.registerRoutes(app);
        }
    }

    // Core routes
    app.use('/api/engine/projects', projectRoutes);
    app.use('/api/engine/assets', assetRoutes);

    app.get('/api/engine/health', (_req, res) => {
        res.json({ status: 'ok' });
    });

    // WS ticket exchange — trade a JWT for a short-lived one-time ticket
    // so the actual token never appears in WebSocket URLs
    const { createWsTicket } = await import('./ws/ws_tickets.js');
    const authMiddleware = pluginAuth || requireAuth;
    app.post('/api/engine/ws-ticket', authMiddleware, (req, res) => {
        const ticket = createWsTicket(req.user!, req.headers.authorization?.split(' ')[1] ?? '');
        res.json({ ticket });
    });

    // HTTP server
    const server = http.createServer(app);

    // WebSocket servers
    const editorWSS = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 * 1024 * 1024 });
    setupEditorWebSocket(editorWSS);

    // Additional WS paths from plugins
    const wsHandlers = new Map<string, WebSocketServer>();
    wsHandlers.set('/ws/engine', editorWSS);
    for (const p of plugins) {
        if (p.registerWebSocket) {
            p.registerWebSocket(wsHandlers);
        }
    }

    server.on('upgrade', (req, socket, head) => {
        const pathname = req.url?.split('?')[0];
        const wss = wsHandlers.get(pathname || '');
        if (wss) {
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req);
            });
        } else {
            socket.destroy();
        }
    });

    const shutdown = () => {
        for (const p of plugins) {
            if (p.onShutdown) p.onShutdown();
        }
        server.close();
    };

    return { app, server, shutdown };
}

/**
 * Start the engine: listen on port, validate templates, generate assets.
 */
export async function startEngine(server: http.Server, plugins: EnginePlugin[] = []): Promise<void> {
    return new Promise((resolve) => {
        server.listen(config.port, async () => {
            console.log(`[Server] Running on port ${config.port} (${config.nodeEnv})`);

            // Detect which CLI fixer agents (claude, codex) are installed.
            // Runs once, cached for the life of the process.
            import('./ws/services/pipeline/cli_availability.js').then(({ detectAgents }) => {
                detectAgents();
            });

            // Validate all game templates at startup
            import('./ws/services/pipeline/template_loader.js').then(({ loadTemplateCatalog, loadTemplate }) => {
                import('./ws/services/pipeline/level_assembler.js').then(({ assembleGame }) => {
                    const catalog = loadTemplateCatalog();
                    let passed = 0, failed = 0;
                    for (const t of catalog) {
                        const template = loadTemplate(t.id);
                        if (!template?._folderPath) { failed++; continue; }
                        try {
                            assembleGame(template._folderPath);
                            passed++;
                        } catch (e: any) {
                            console.error(`[Templates] FAILED: ${t.id} — ${e.message}`);
                            failed++;
                        }
                    }
                    console.log(`[Templates] ${passed}/${catalog.length} templates validated${failed > 0 ? `, ${failed} failed` : ''}`);
                });
            });

            // Asset generators (non-blocking)
            import('./generators/thumbnail_generator.js').then(({ generateThumbnails }) => {
                generateThumbnails(config.assetsDir).catch(e => console.error('[Thumbnails] Failed:', e));
            });
            import('./generators/collision_mesh_generator.js').then(({ generateCollisionMeshes }) => {
                generateCollisionMeshes(config.assetsDir).catch(e => console.error('[CollisionMesh] Failed:', e));
            });
            import('./generators/lod_generator.js').then(({ generateLODs }) => {
                generateLODs(config.assetsDir).catch(e => console.error('[LOD] Failed:', e));
            });

            // Plugin startup hooks
            for (const p of plugins) {
                if (p.onStartup) p.onStartup();
            }

            resolve();
        });
    });
}

// ─── Standalone mode: run directly with `npx tsx src/server.ts` ────────────
const isMain = import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith('/server.ts') ||
    process.argv[1]?.endsWith('/server.js');

if (isMain) {
    const { server } = await createEngine();
    await startEngine(server);
}
