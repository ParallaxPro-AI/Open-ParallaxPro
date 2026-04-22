/**
 * library.ts — HTTP surface for the CLI sandbox's library.sh tool.
 *
 * Three endpoints, mounted under /api/engine/internal/library. Same
 * INTERNAL_API_TOKEN gate as /api/engine/internal/search-assets (dev
 * mode allows unauthenticated — see server.ts's guard).
 *
 *   GET /index?kind=behaviors|systems|ui  → full catalog for a kind
 *                                           (or all three + templates
 *                                           when kind is omitted)
 *   GET /search?q=X&kind=Y&category=Z&limit=N
 *                                         → ranked top-K with scores
 *   GET /file?path=<kind>/<rel>           → raw file content
 *
 * Never writes. Never touches project data. Soft-fail returns for
 * anything that's not found, so library.sh can degrade gracefully
 * instead of crashing runs.
 */

import { Router, type Request, type Response } from 'express';
import {
    getEnrichedLibrary, readLibraryFile, readLibraryTemplate,
    getLibraryCatalog, type LibraryKind,
} from '../ws/services/pipeline/library_catalog.js';
import { searchLibrary } from '../ws/services/pipeline/library_index.js';

function isKind(v: unknown): v is LibraryKind {
    return v === 'behaviors' || v === 'systems' || v === 'ui';
}

export function createLibraryRouter(): Router {
    const router = Router();

    router.get('/index', (req: Request, res: Response) => {
        const kindParam = req.query.kind;
        const enriched = getEnrichedLibrary();
        const cat = getLibraryCatalog();

        if (kindParam && isKind(kindParam)) {
            return res.json({ kind: kindParam, items: enriched[kindParam] });
        }

        // No kind filter — return all kinds plus the template list.
        // Templates aren't embedded (they live as 4-file dirs), so
        // surface just their ids with a summary parsed from 01_flow.json
        // if available.
        const templates = cat.templates.map(id => {
            const files = readLibraryTemplate(id);
            let summary = '';
            if (files?.['01_flow.json']) {
                try {
                    const parsed = JSON.parse(files['01_flow.json']);
                    summary = (parsed?.description || parsed?.name || '').toString();
                } catch {}
            }
            return { id, summary };
        });

        res.json({
            behaviors: enriched.behaviors,
            systems:   enriched.systems,
            ui:        enriched.ui,
            templates,
        });
    });

    router.get('/search', async (req: Request, res: Response) => {
        const q = String(req.query.q || '').trim();
        if (!q) return res.status(400).json({ error: 'q is required' });
        const kindParam = req.query.kind;
        const category = req.query.category ? String(req.query.category) : undefined;
        const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), 50);

        try {
            const hits = await searchLibrary(q, {
                kind: isKind(kindParam) ? kindParam : undefined,
                category,
                limit,
            });
            res.json({ query: q, hits });
        } catch (e: any) {
            console.error('[library-search]', e?.message);
            res.status(500).json({ error: 'search_failed', detail: e?.message });
        }
    });

    router.get('/file', (req: Request, res: Response) => {
        const raw = String(req.query.path || '').trim();
        if (!raw) return res.status(400).json({ error: 'path is required' });

        // Template dirs get a special shape — fetch all 4 JSONs.
        if (raw.startsWith('templates/')) {
            const id = raw.slice('templates/'.length).replace(/\/+$/, '');
            const tpl = readLibraryTemplate(id);
            if (!tpl) return res.status(404).json({ error: 'not_found' });
            return res.type('text/plain').send(
                Object.entries(tpl)
                    .map(([name, content]) => `=== ${name} ===\n${content}`)
                    .join('\n\n'),
            );
        }

        const hit = readLibraryFile(raw);
        if (!hit) return res.status(404).json({ error: 'not_found' });
        res.type('text/plain').send(hit.content);
    });

    return router;
}
