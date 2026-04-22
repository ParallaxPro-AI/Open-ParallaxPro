/**
 * research_play.ts — ephemeral, in-memory "play this game right now"
 * endpoint for the local research workbench.
 *
 * What it is:
 *   A localhost-only escape hatch that accepts ProjectFiles over HTTP,
 *   runs `assembleGame` on them in a throw-away tempdir, caches the
 *   resulting ConvertedScene under a short-lived token, and serves it
 *   at a URL shaped like the public play flow expects.
 *
 * Why it exists:
 *   The research workbench (research/create_game/) wants to embed
 *   freshly-generated games in an iframe without publishing them to
 *   `published_games`. Nothing here writes to the engine DB.
 *
 * Safety:
 *   Mounted ONLY when `config.isHosted === false`. In hosted prod the
 *   router is never registered, so the endpoints don't exist.
 *   Tokens are UUIDs with a 1h TTL and a 50-entry cap; oldest evicts
 *   when full. All caching is in-memory — a server restart clears
 *   everything. No authentication: the parent server's routes are
 *   localhost-bound in non-hosted mode.
 */

import { Router, type Request, type Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { assembleGame } from '../ws/services/pipeline/level_assembler.js';

const __dirname_rp = path.dirname(fileURLToPath(import.meta.url));

interface CacheEntry {
    token: string;
    scene: unknown;
    projectName: string;
    createdAt: number;
    tempDir: string;
}

const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 50;
const _cache = new Map<string, CacheEntry>();

function evictExpired(): void {
    const now = Date.now();
    for (const [token, entry] of _cache) {
        if (now - entry.createdAt > TTL_MS) {
            _cache.delete(token);
            try { fs.rmSync(entry.tempDir, { recursive: true, force: true }); } catch {}
        }
    }
    while (_cache.size >= MAX_ENTRIES) {
        const oldestToken = _cache.keys().next().value;
        if (!oldestToken) break;
        const entry = _cache.get(oldestToken);
        _cache.delete(oldestToken);
        if (entry) { try { fs.rmSync(entry.tempDir, { recursive: true, force: true }); } catch {} }
    }
}

function writeFiles(tempDir: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(tempDir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
}

export function createResearchPlayRouter(): Router {
    const router = Router();

    // POST /api/engine/research/projects
    //   Body: { files: { [rel]: content }, name?: string }
    //   Returns: { token, playUrl, expiresAt }
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
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pp-research-play-`));
        try {
            writeFiles(tempDir, files);
            const scene = assembleGame(tempDir, {
                behaviors: path.join(tempDir, 'behaviors'),
                systems: path.join(tempDir, 'systems'),
                ui: path.join(tempDir, 'ui'),
            });
            const entry: CacheEntry = {
                token,
                scene,
                projectName: name,
                createdAt: Date.now(),
                tempDir,
            };
            _cache.set(token, entry);

            // Derive the playUrl. Using /play/research/:token keeps the
            // existing play.html mount — play.ts's research-token branch
            // does the rest.
            const playUrl = `/play/research/${token}`;
            res.json({
                token,
                playUrl,
                expiresAt: new Date(entry.createdAt + TTL_MS).toISOString(),
            });
        } catch (e: any) {
            // Clean up tmp on failure so we don't leak.
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
            _cache.delete(token);
            console.error('[research_play] assemble failed:', e?.message);
            res.status(422).json({ error: `assemble_failed: ${e?.message || e}` });
        }
    });

    // GET /api/engine/research/projects/:token/data
    //   Returns the ConvertedScene in the same shape as /api/engine/games/:owner/:slug.
    router.get('/projects/:token/data', (req: Request, res: Response) => {
        const token = String(req.params.token || '');
        const entry = _cache.get(token);
        if (!entry) return res.status(404).json({ error: 'not_found_or_expired' });
        if (Date.now() - entry.createdAt > TTL_MS) {
            _cache.delete(token);
            return res.status(404).json({ error: 'expired' });
        }
        // Wrap in a game_data-like envelope so play.ts's existing handling
        // ("scenes, scripts, uiFiles…") works. The ConvertedScene's keys are
        // already the right shape; we just add id/name/engineGitHash=null so
        // version-routing doesn't try to redirect into an archive.
        const scene = entry.scene as Record<string, unknown>;
        res.json({
            id: token,
            name: entry.projectName,
            slug: `research-${token.slice(0, 8)}`,
            owner: 'research',
            engineGitHash: null,
            ...scene,
        });
    });

    router.delete('/projects/:token', (req: Request, res: Response) => {
        const token = String(req.params.token || '');
        const entry = _cache.get(token);
        if (entry) {
            _cache.delete(token);
            try { fs.rmSync(entry.tempDir, { recursive: true, force: true }); } catch {}
        }
        res.status(204).end();
    });

    return router;
}
