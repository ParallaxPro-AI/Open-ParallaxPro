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
    type LibraryKind,
} from '../ws/services/pipeline/library_catalog.js';
import { searchLibrary } from '../ws/services/pipeline/library_index.js';

function isKind(v: unknown): v is LibraryKind {
    return v === 'behaviors' || v === 'systems' || v === 'ui' || v === 'templates';
}

export function createLibraryRouter(): Router {
    const router = Router();

    router.get('/index', (req: Request, res: Response) => {
        const kindParam = req.query.kind;
        const enriched = getEnrichedLibrary();

        if (kindParam && isKind(kindParam)) {
            return res.json({ kind: kindParam, items: enriched[kindParam] });
        }

        // No kind filter — return every kind's enriched catalog. Templates
        // are now first-class items in the enriched map (their summary
        // comes from each template's 01_flow.json), so we serve them
        // uniformly alongside behaviors/systems/ui.
        res.json({
            behaviors: enriched.behaviors,
            systems:   enriched.systems,
            ui:        enriched.ui,
            templates: enriched.templates,
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

        const sendTemplate = (id: string): boolean => {
            const tpl = readLibraryTemplate(id);
            if (!tpl) return false;
            res.setHeader('X-Library-Resolved-Path', `templates/${id}`);
            res.type('text/plain').send(
                Object.entries(tpl)
                    .map(([name, content]) => `=== ${name} ===\n${content}`)
                    .join('\n\n'),
            );
            return true;
        };
        const sendFile = (p: string): boolean => {
            const hit = readLibraryFile(p);
            if (!hit) return false;
            res.setHeader('X-Library-Resolved-Path', p);
            res.type('text/plain').send(hit.content);
            return true;
        };

        // 1. Explicit template path — fetch all 4 JSONs.
        if (raw.startsWith('templates/')) {
            const id = raw.slice('templates/'.length).replace(/\/+$/, '');
            if (sendTemplate(id)) return;
            return res.status(404).json({ error: 'not_found' });
        }

        // 2. Explicit kind prefix — trust the caller, one shot.
        if (
            raw.startsWith('behaviors/') ||
            raw.startsWith('systems/') ||
            raw.startsWith('ui/')
        ) {
            if (sendFile(raw)) return;
            return res.status(404).json({ error: 'not_found' });
        }

        // 3. Kind-inferring resolution — literal references inside library
        //    files don't carry a kind prefix (a template's 02_entities.json
        //    says "script": "movement/jump.ts", not "behaviors/movement/...").
        //    Try the sensible kinds in order.
        //
        //    - `*.ts` files are either behaviors or systems (never ui).
        //    - `*.html` files are ui only.
        //    - bare names with no extension are either a ui panel id
        //      (flow references like "hud/health") or a template id
        //      (like "platformer").
        if (raw.endsWith('.ts')) {
            if (sendFile(`behaviors/${raw}`)) return;
            if (sendFile(`systems/${raw}`)) return;
            return res.status(404).json({ error: 'not_found', tried: [`behaviors/${raw}`, `systems/${raw}`] });
        }
        if (raw.endsWith('.html')) {
            if (sendFile(`ui/${raw}`)) return;
            return res.status(404).json({ error: 'not_found', tried: [`ui/${raw}`] });
        }
        // No extension → prefer ui panel (flow action shape), then template.
        if (sendFile(`ui/${raw}.html`)) return;
        if (/^[a-zA-Z0-9_-]+$/.test(raw) && sendTemplate(raw)) return;
        return res.status(404).json({
            error: 'not_found',
            tried: [`ui/${raw}.html`, `templates/${raw}`],
        });
    });

    return router;
}
