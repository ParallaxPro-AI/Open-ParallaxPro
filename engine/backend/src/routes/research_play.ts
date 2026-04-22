/**
 * research_play.ts — ephemeral, in-memory "play this game right now"
 * and "open this game in the editor" endpoints for the local research
 * workbench.
 *
 * What it is:
 *   A localhost-only escape hatch that accepts ProjectFiles over HTTP,
 *   runs buildProject on them once, caches the result (plus project
 *   files) under a UUID, and serves them at URLs the runtime + editor
 *   expect.
 *
 * Why it exists:
 *   The research workbench (research/create_game/) wants to iframe a
 *   freshly-generated game in two modes:
 *     1. play.html (fast, just runs the scene)
 *     2. the full editor (hierarchy / FSM / performance / play+client)
 *   without publishing to `published_games` or writing to the `projects`
 *   table.
 *
 * Safety:
 *   Mounted ONLY when `config.isHosted === false`. In hosted prod the
 *   router is never registered, so the endpoints don't exist. Tokens
 *   are UUIDs with a 1h TTL and a 50-entry cap; oldest evicts when
 *   full. All caching is in-memory — a server restart clears
 *   everything.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { buildProject, type BuildResult } from '../ws/services/pipeline/project_builder.js';

interface CacheEntry {
    token: string;
    projectId: string;            // "research-<token>"
    files: Record<string, string>;
    built: BuildResult;
    projectName: string;
    createdAt: number;
    tempDir: string;
}

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 50;
const _cache = new Map<string, CacheEntry>();

function evictExpired(): void {
    const now = Date.now();
    for (const [token, entry] of _cache) {
        if (now - entry.createdAt > TTL_MS) dropEntry(token);
    }
    while (_cache.size >= MAX_ENTRIES) {
        const oldest = _cache.keys().next().value;
        if (!oldest) break;
        dropEntry(oldest);
    }
}
function dropEntry(token: string): void {
    const entry = _cache.get(token);
    _cache.delete(token);
    if (entry) { try { fs.rmSync(entry.tempDir, { recursive: true, force: true }); } catch {} }
}

function writeFiles(tempDir: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(tempDir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
}

function idToToken(id: string): string | null {
    const m = id.match(/^research-([a-zA-Z0-9-]+)$/);
    return m ? m[1] : null;
}

/**
 * Create a research project from files. Returns a token + both URLs
 * the frontend can iframe. The buildProject call runs only here; the
 * result is cached so subsequent reads (and the editor's repeated
 * project loads) are instant.
 */
export function createResearchPlayRouter(): Router {
    const router = Router();

    router.post('/projects', (req: Request, res: Response) => {
        evictExpired();

        const files = req.body?.files;
        const name = typeof req.body?.name === 'string' ? req.body.name : 'research';
        if (!files || typeof files !== 'object') {
            return res.status(400).json({ error: 'files is required' });
        }
        if (!files['01_flow.json'] || !files['02_entities.json']) {
            return res.status(400).json({ error: 'files must include at least 01_flow.json and 02_entities.json' });
        }

        const token = randomUUID();
        const projectId = `research-${token}`;
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pp-research-`));
        try {
            writeFiles(tempDir, files);
            // Mutates files in-place to refresh engine machinery, then
            // assembles. Match what publish + real project-load do so the
            // scene data shape is the one the runtime + editor expect.
            const built = buildProject(projectId, { ...files });
            if (!built.success) {
                throw new Error(built.error || 'buildProject failed');
            }
            _cache.set(token, {
                token,
                projectId,
                files,
                built,
                projectName: name,
                createdAt: Date.now(),
                tempDir,
            });
            res.json({
                token,
                projectId,
                // Play URL (runtime only)
                playPath: `/play/research/${token}`,
                // Editor URL (full workbench: hierarchy, FSM, Play + Client, perf)
                editorPath: `/?project=${projectId}`,
                expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
            });
        } catch (e: any) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
            _cache.delete(token);
            console.error('[research_play] build failed:', e?.message);
            res.status(422).json({ error: `build_failed: ${e?.message || e}` });
        }
    });

    /**
     * Minimal game-data shape that play.ts accepts — matches what
     * /api/engine/games/:owner/:slug returns for published games.
     */
    router.get('/projects/:token/data', (req: Request, res: Response) => {
        const token = String(req.params.token || '');
        const entry = _cache.get(token);
        if (!entry || Date.now() - entry.createdAt > TTL_MS) {
            if (entry) dropEntry(token);
            return res.status(404).json({ error: 'not_found_or_expired' });
        }
        const built = entry.built;
        res.json({
            id: token,
            name: entry.projectName,
            slug: `research-${token.slice(0, 8)}`,
            owner: 'research',
            engineGitHash: null,
            scenes: built.scenes,
            scripts: built.scripts,
            uiFiles: built.uiFiles,
            multiplayerConfig: built.multiplayerConfig,
        });
    });

    router.delete('/projects/:token', (req: Request, res: Response) => {
        dropEntry(String(req.params.token || ''));
        res.status(204).end();
    });

    return router;
}

/**
 * Middleware that catches requests to /api/engine/projects/research-<token>.
 *
 * Mounted BEFORE the normal projects auth middleware so research IDs
 * bypass the user-scoped DB lookup entirely.
 *
 *   GET      → serve the ephemeral project shaped like the normal
 *              project-load response the editor consumes.
 *   PATCH/PUT/POST → 204 (no-op — research projects are read-only).
 *   DELETE   → drop the cache entry.
 */
export function researchProjectMiddleware(req: Request, res: Response, next: NextFunction): void {
    // req.url is relative to the mount (/api/engine/projects) — we get
    // things like "/research-xyz" or "/research-xyz/thumbnail".
    const m = req.url.match(/^\/(research-[a-zA-Z0-9-]+)(\/.*)?$/);
    if (!m) return next();

    const projectId = m[1];
    const subpath = m[2] || '';
    const token = idToToken(projectId);
    if (!token) return next();
    const entry = _cache.get(token);
    if (!entry) {
        res.status(404).json({ error: 'not_found_or_expired' });
        return;
    }

    // Top-level project load: GET /:id
    if (req.method === 'GET' && subpath === '') {
        const built = entry.built;
        res.json({
            id: projectId,
            name: entry.projectName,
            thumbnail: null,
            status: 'active',
            createdAt: entry.createdAt,
            updatedAt: entry.createdAt,
            projectConfig: { name: entry.projectName },
            files: entry.files,
            scenes: built.scenes,
            scripts: built.scripts,
            uiFiles: built.uiFiles,
            sourceMap: built.sourceMap,
            multiplayerConfig: built.multiplayerConfig,
            editor: {},
            isCloud: false,
            cloudUserId: null,
            cloudPulledUpdatedAt: null,
            editedEngineHash: null,
            generation: null,
            isResearchProject: true, // marker the editor can sniff later if it wants
        });
        return;
    }

    // Generation / WS ticket / chat / save / everything else: swallow
    // so the editor doesn't 404-loop. No real state changes either way.
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        res.status(204).end();
        return;
    }
    if (req.method === 'DELETE') {
        dropEntry(token);
        res.status(204).end();
        return;
    }

    next();
}
