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

    // Sweep orphaned generation jobs. Any project row marked as mid-build
    // when this process starts came from a previous process that died
    // (restart, crash, kill -9). The CLI child is dead too; mark the row
    // failed so the UI stops showing a perpetually-spinning timer.
    // Plugins are passed so onGenerationComplete fires for each orphan —
    // the user gets the same "build failed" email they would've gotten
    // had the CLI crashed normally, just with a "server restarted"
    // summary so they know to retry.
    const { cleanupOrphanedJobsOnBoot } = await import('./ws/services/pipeline/generation_jobs.js');
    cleanupOrphanedJobsOnBoot(plugins);

    // Dynamic imports (after schema is ready, since routes prepare statements)
    const { default: projectRoutes, setProjectPlugins } = await import('./routes/projects.js');
    const { default: assetRoutes } = await import('./routes/assets.js');
    const { setupEditorWebSocket, setPlugins } = await import('./ws/editor_ws.js');

    // Pass plugins to WebSocket handler and project routes
    setPlugins(plugins);
    setProjectPlugins(plugins);

    // Express app
    const app = express();

    // CORS has to run before the auth middleware below, otherwise a
    // preflight OPTIONS to /api/engine/projects/* hits requireAuth first,
    // gets a 401 without any Access-Control-Allow-Origin header, and the
    // browser blocks the real request (self-hosted editors calling
    // publish-from-local are the common victim).
    // Skip /assets — those are public files served either directly by
    // express.static, by 302 to the CDN, or in prod by nginx/Cloudflare
    // which add their own `Access-Control-Allow-Origin: *`. Letting cors()
    // also echo the request Origin produces two ACAO header values in one
    // response, which the browser rejects.
    const corsMiddleware = cors({ origin: config.corsOrigins, credentials: true });
    app.use((req, res, next) => {
        if (req.path.startsWith('/assets')) return next();
        return corsMiddleware(req, res, next);
    });
    app.use(express.json({ limit: '10mb' }));

    // Auth middleware for project routes — applies to both core router and plugin routes
    const pluginAuth = plugins.find(p => p.authMiddleware)?.authMiddleware;
    const { requireAuth } = await import('./middleware/auth.js');
    app.use('/api/engine/projects', pluginAuth || requireAuth);
    if (config.isHosted) app.use('/api/engine', httpRateLimit);

    // Project thumbnails. Same on-disk location as the hosted publish
    // plugin — so a locally-uploaded thumbnail and a hosted one both
    // resolve at /uploads/thumbnails/<id>.<ext>. Import lazily so the
    // routes module has already initialised the directory.
    const { THUMBNAIL_DIR } = await import('./routes/projects.js');
    app.use('/uploads/thumbnails', express.static(THUMBNAIL_DIR, {
        maxAge: '1d',
        // Defense-in-depth: even if a non-image somehow lands in the
        // thumbnail dir, browsers won't sniff it into HTML/JS.
        setHeaders: (res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); },
    }));

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

    // Internal assembler gate for sandboxed CLI runs. validate.sh inside
    // the sandbox POSTs here with its per-run token; we look up the
    // token → /tmp sandbox dir and run assembleGame against it, which
    // is the same strict check used everywhere else in the engine.
    // Without this, the sandbox's validate.sh only catches JSON parse
    // errors and JS syntax — unknown event names, missing panel files,
    // mesh paths that don't resolve, etc. silently pass and then blow
    // up in runCreator's post-exit assembleGame, wasting a whole run.
    //
    // Token auth (random UUID per run, revoked at cleanup) is the only
    // gate — the endpoint never writes and never leaks file contents,
    // so unauthenticated exposure is low-risk, but the token ensures
    // only the current sandbox's validate.sh can target its own dir.
    // Deploy-time poll target. Returns a unified count of in-flight work so
    // `server_deploy.sh` can wait until the box is quiet before pm2-restarting.
    // Gated by INTERNAL_API_TOKEN header — prevents random external callers
    // from probing job state; server_deploy.sh on the same box knows the token.
    // In dev mode (no token set) we allow unauthenticated calls so running
    // the backend locally doesn't require env setup.
    // Freeze CLI slots — called by server_deploy.sh right before pm2 restart.
    // Jobs that arrive during freeze queue instead of starting, so they
    // survive the restart gap (client retries after WS reconnect).
    app.post('/api/engine/internal/freeze-cli', async (req, res) => {
        const expected = process.env.INTERNAL_API_TOKEN;
        if (expected) {
            const provided = req.headers['x-internal-token'];
            if (provided !== expected) { res.status(401).json({ error: 'Unauthorized' }); return; }
        }
        const { freezeCLISlots } = await import('./ws/services/pipeline/cli_runner.js');
        freezeCLISlots();
        res.json({ ok: true, frozen: true });
    });

    // Session warmer status — used by admin dashboard to show warm/warming/not-warm.
    app.get('/api/engine/internal/warm-status', async (req, res) => {
        const expected = process.env.INTERNAL_API_TOKEN;
        if (expected) {
            const provided = req.headers['x-internal-token'];
            if (provided !== expected) { res.status(401).json({ error: 'Unauthorized' }); return; }
        }
        const { getWarmStatus } = await import('./ws/services/pipeline/session_warmer.js');
        res.json(getWarmStatus());
    });

    // Trigger warming manually from admin dashboard.
    app.post('/api/engine/internal/warm-sessions/:kind', async (req, res) => {
        const expected = process.env.INTERNAL_API_TOKEN;
        if (expected) {
            const provided = req.headers['x-internal-token'];
            if (provided !== expected) { res.status(401).json({ error: 'Unauthorized' }); return; }
        }
        const kind = req.params.kind;
        if (kind !== 'creator' && kind !== 'fixer') { res.status(400).json({ error: 'kind must be creator or fixer' }); return; }
        const { warmIfNeeded } = await import('./ws/services/pipeline/session_warmer.js');
        warmIfNeeded(kind).catch(() => {});
        res.json({ ok: true, message: `Warming ${kind} session...` });
    });

    app.get('/api/engine/internal/active-jobs', async (req, res) => {
        const expected = process.env.INTERNAL_API_TOKEN;
        if (expected) {
            const provided = req.headers['x-internal-token'];
            if (provided !== expected) {
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }
        }
        const { getActiveWorkSummary } = await import('./ws/services/active_work.js');
        res.json(getActiveWorkSummary());
    });

    // Move every project owned by `fromUserId` onto `toUserId`. Called
    // by the landing backend on signup/login when the caller had an
    // anon JWT, so their in-progress work follows them onto the real
    // account. Same INTERNAL_API_TOKEN gate as /active-jobs.
    app.post('/api/engine/internal/transfer-projects', async (req, res) => {
        const expected = process.env.INTERNAL_API_TOKEN;
        if (expected) {
            const provided = req.headers['x-internal-token'];
            if (provided !== expected) {
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }
        }
        const fromUserId = req.body?.fromUserId;
        const toUserId = req.body?.toUserId;
        if (typeof fromUserId !== 'number' || typeof toUserId !== 'number') {
            res.status(400).json({ error: 'fromUserId and toUserId must be numbers' });
            return;
        }
        if (fromUserId === toUserId) {
            res.json({ ok: true, moved: 0 });
            return;
        }
        try {
            const info = db.prepare('UPDATE projects SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
            res.json({ ok: true, moved: info.changes });
        } catch (e: any) {
            console.error('[Engine] transfer-projects failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Hard-delete every engine-side row owned by `userId`. Called by the
    // landing backend's account-deletion endpoint (App Store guideline
    // 5.1.1(v)). Same INTERNAL_API_TOKEN gate as the other internal
    // endpoints. Removes projects + their build dirs, chat_messages,
    // agent_feedback, and any plugin-owned rows that the publish plugin
    // needs to clean up via its own onUserDelete hook.
    app.post('/api/engine/internal/delete-user', async (req, res) => {
        const expected = process.env.INTERNAL_API_TOKEN;
        if (expected) {
            const provided = req.headers['x-internal-token'];
            if (provided !== expected) { res.status(401).json({ error: 'Unauthorized' }); return; }
        }
        const userId = req.body?.userId;
        if (typeof userId !== 'number') {
            res.status(400).json({ error: 'userId must be a number' }); return;
        }
        try {
            const projects = db.prepare('SELECT id FROM projects WHERE user_id = ?').all(userId) as { id: string }[];
            const projectIds = projects.map(p => p.id);

            // Plugin hooks: each plugin that owns user-keyed rows can declare
            // an `onUserDelete(userId, projectIds)` cleanup. Implemented for
            // the publish plugin so published_games / published_versions /
            // game_likes / game_comments / game_reports go too.
            for (const p of plugins) {
                const hook = (p as any).onUserDelete;
                if (typeof hook === 'function') {
                    try { await hook(userId, projectIds); }
                    catch (e: any) { console.error(`[delete-user] plugin ${p.name} onUserDelete failed:`, e.message); }
                }
            }

            const tx = db.transaction(() => {
                if (projectIds.length > 0) {
                    const placeholders = projectIds.map(() => '?').join(',');
                    db.prepare(`DELETE FROM chat_messages WHERE project_id IN (${placeholders})`).run(...projectIds);
                    try { db.prepare(`DELETE FROM agent_feedback WHERE project_id IN (${placeholders})`).run(...projectIds); } catch {}
                }
                db.prepare('DELETE FROM projects WHERE user_id = ?').run(userId);
            });
            tx();

            // Build dirs aren't transactional with the DB; clean them on a
            // best-effort basis after the row removal succeeds.
            try {
                const { cleanupBuildDir } = await import('./ws/services/pipeline/project_builder.js');
                for (const id of projectIds) cleanupBuildDir(id);
            } catch { /* ignore — dirs are reclaimable on next boot */ }

            res.json({ ok: true, projects: projectIds.length });
        } catch (e: any) {
            console.error('[delete-user] failed:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Library tool endpoints — used by the sandbox's library.sh. Same
    // INTERNAL_API_TOKEN gate as search-assets; mounted as a full
    // router so the three sub-routes (/index, /search, /file) live
    // together. Localhost-only in dev (no token set).
    {
        const { createLibraryRouter } = await import('./routes/library.js');
        const libraryRouter = createLibraryRouter();
        app.use('/api/engine/internal/library', (req, res, next) => {
            const expected = process.env.INTERNAL_API_TOKEN;
            if (expected) {
                const provided = req.headers['x-internal-token'];
                if (provided !== expected) {
                    res.status(401).json({ error: 'Unauthorized' });
                    return;
                }
            }
            libraryRouter(req, res, next);
        });
    }

    app.get('/api/engine/internal/search-assets', async (req, res) => {
        const expected = process.env.INTERNAL_API_TOKEN;
        if (expected) {
            const provided = req.headers['x-internal-token'];
            if (provided !== expected) {
                res.status(401).json({ error: 'Unauthorized' });
                return;
            }
        }
        const { searchAssets } = await import('./routes/assets.js');
        const q = (req.query.q as string) || '';
        const category = (req.query.category as string) || '';
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
        if (!q) { res.json({ results: [] }); return; }
        const results = await searchAssets({ search: q, category: category || undefined, limit });
        res.json({ results });
    });

    app.post('/api/engine/internal/validate-sandbox/:token', async (req, res) => {
        const { lookupSandboxToken } = await import('./ws/services/pipeline/sandbox_validator.js');
        const { assembleGame } = await import('./ws/services/pipeline/level_assembler.js');
        const path = await import('path');

        const sandboxDir = lookupSandboxToken(req.params.token);
        if (!sandboxDir) {
            res.status(404).json({ ok: false, error: 'Unknown or expired sandbox token' });
            return;
        }

        const projectDir = path.join(sandboxDir, 'project');
        try {
            assembleGame(projectDir, {
                behaviors: path.join(projectDir, 'behaviors'),
                systems:   path.join(projectDir, 'systems'),
                ui:        path.join(projectDir, 'ui'),
            });
            res.json({ ok: true });
        } catch (e: any) {
            res.json({ ok: false, error: e?.message || String(e) });
        }
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

    const { setupLobbyWebSocket } = await import('./ws/services/lobby/lobby_ws.js');
    const lobbyWSS = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 128 * 1024 });
    setupLobbyWebSocket(lobbyWSS);

    // Additional WS paths from plugins
    const wsHandlers = new Map<string, WebSocketServer>();
    wsHandlers.set('/ws/engine', editorWSS);
    // Lobby WS is mounted under a versioned path so we can ship breaking
    // protocol changes as /v2 / /v3 without yanking /v1 out from under
    // already-published games. Unversioned alias remains as legacy so
    // pre-versioning clients still connect.
    wsHandlers.set('/ws/multiplayer/v1', lobbyWSS);
    wsHandlers.set('/ws/multiplayer', lobbyWSS);
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
        // Graceful EADDRINUSE: print a helpful hint instead of dumping a
        // stack trace. Common when a previous dev server is still alive.
        server.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                console.error(
                    `[Server] ✗ Port ${config.port} is already in use.\n` +
                    `         Stop whatever is using it (e.g. \`lsof -ti:${config.port} | xargs kill -9\`),\n` +
                    `         or set PORT=<other> in your .env. If you change the port, also\n` +
                    `         set BACKEND_URL=http://localhost:<port> for the editor frontend\n` +
                    `         so its vite proxy reaches the new port.`,
                );
                process.exit(1);
            }
            throw err;
        });

        server.listen(config.port, async () => {
            console.log(`[Server] Running on port ${config.port} (${config.nodeEnv})`);

            // Detect which CLI fixer agents (claude, codex, opencode, copilot)
            // are installed. Runs once, cached for the life of the process.
            // Hard-fail if zero are installed — without an editing agent the
            // fixer silently can't run, which is a confusing failure mode to
            // discover at first-message time.
            import('./ws/services/pipeline/cli_availability.js').then(({ detectAgents }) => {
                const agents = detectAgents();
                if (!agents.some(a => a.installed)) {
                    console.error(
                        '[Agents] ✗ No editing-agent CLIs detected on PATH.\n' +
                        '         Install at least one of: claude, codex, opencode, copilot\n' +
                        '         (see README.md → "Fixer CLIs"). Refusing to start.',
                    );
                    process.exit(1);
                }
            });

            // Pre-warm Claude sessions in the background so the first
            // CREATE_GAME / FIX_GAME run can fork from a warm context.
            import('./ws/services/pipeline/session_warmer.js').then(({ initWarmer }) => {
                initWarmer();
            }).catch(e => console.warn('[SessionWarmer] Init failed (non-fatal):', e?.message));

            // Same for opencode — uses --session <warm_id> --fork instead
            // of Claude's JSONL-copy mechanism. Warming is best-effort;
            // failures fall back to cold start at run time.
            import('./ws/services/pipeline/opencode_session_warmer.js').then(({ initOpencodeWarmer }) => {
                initOpencodeWarmer();
            }).catch(e => console.warn('[OpencodeWarmer] Init failed (non-fatal):', e?.message));

            // And codex — forks per-run by copying the warm JSONL with a
            // fresh UUID (codex has no native fork primitive).
            import('./ws/services/pipeline/codex_session_warmer.js').then(({ initCodexWarmer }) => {
                initCodexWarmer();
            }).catch(e => console.warn('[CodexWarmer] Init failed (non-fatal):', e?.message));

            // If DOCKER_SANDBOX=1, confirm docker + the sandbox image are
            // available and log the outcome so misconfigurations don't go
            // unnoticed (the fixer still runs unsandboxed if probe fails).
            import('./ws/services/pipeline/docker_sandbox.js').then(({ isDockerSandboxEnabled, probeDockerSandbox }) => {
                if (!isDockerSandboxEnabled()) return;
                const r = probeDockerSandbox();
                if (r.ok) console.log(`[Sandbox] ${r.reason}`);
                else console.warn(`[Sandbox] DOCKER_SANDBOX=1 but sandbox unavailable: ${r.reason}. Falling back to unsandboxed spawns.`);
            });

            // Validate all shipped game templates at startup. Two stages per
            // template: assembler + headless script smoke (see
            // template_health.ts for details). Failures are logged + cached
            // so the admin dashboard can surface them; they never crash boot.
            Promise.all([
                import('./ws/services/pipeline/template_loader.js'),
                import('./ws/services/pipeline/level_assembler.js'),
                import('./ws/services/pipeline/template_health.js'),
            ]).then(([{ loadTemplateCatalog, loadTemplate }, { assembleGame }, { runTemplateHealthChecks }]) => {
                const catalog = loadTemplateCatalog();
                const result = runTemplateHealthChecks(catalog, loadTemplate, assembleGame);
                for (const f of result.failures) {
                    console.error(`[Templates] ${f.stage.toUpperCase()} FAILED: ${f.templateId} — ${f.error}`);
                }
                console.log(`[Templates] ${result.passedCount}/${result.totalCount} templates healthy${result.failedCount > 0 ? `, ${result.failedCount} failed` : ''}`);
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
