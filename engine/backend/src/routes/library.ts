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
        // Accept multiple queries via repeated ?q=... params. Lets the
        // tool caller fold N related searches into one bash call, which
        // matters for token cost in the agent's transcript more than
        // local HTTP latency.
        const rawQ = req.query.q;
        let queries: string[];
        if (Array.isArray(rawQ))    queries = rawQ.map(x => String(x).trim()).filter(Boolean);
        else if (typeof rawQ === 'string') queries = [rawQ.trim()].filter(Boolean);
        else                        queries = [];
        if (queries.length === 0) return res.status(400).json({ error: 'q is required' });

        const kindParam = req.query.kind;
        const category = req.query.category ? String(req.query.category) : undefined;
        const limit = Math.min(Math.max(parseInt(String(req.query.limit || '10'), 10) || 10, 1), 50);
        const kind = isKind(kindParam) ? kindParam : undefined;

        try {
            const results = await Promise.all(queries.map(async q => ({
                query: q,
                hits: await searchLibrary(q, { kind, category, limit }),
            })));
            if (results.length === 1) {
                // Single-query shape stays flat for back-compat.
                const r = results[0];
                return res.json({ query: r.query, hits: r.hits });
            }
            res.json({ batch: true, results });
        } catch (e: any) {
            console.error('[library-search]', e?.message);
            res.status(500).json({ error: 'search_failed', detail: e?.message });
        }
    });

    router.get('/file', (req: Request, res: Response) => {
        // Accept one or more ?path=... params. Multi-path responses come
        // back as a concatenated text blob with `=== <resolved> ===`
        // separators — same shape as reading a template dir, so the
        // agent has one parsing pattern to learn.
        const rawP = req.query.path;
        let paths: string[];
        if (Array.isArray(rawP))               paths = rawP.map(x => String(x).trim()).filter(Boolean);
        else if (typeof rawP === 'string')     paths = [rawP.trim()].filter(Boolean);
        else                                   paths = [];
        if (paths.length === 0) return res.status(400).json({ error: 'path is required' });

        const resolveOne = (raw: string): { resolvedPath: string; content: string } | { notFound: string[] } => {
            // 1. Explicit template path.
            if (raw.startsWith('templates/')) {
                const id = raw.slice('templates/'.length).replace(/\/+$/, '');
                const tpl = readLibraryTemplate(id);
                if (!tpl) return { notFound: [`templates/${id}`] };
                const content = Object.entries(tpl)
                    .map(([name, c]) => `=== ${name} ===\n${c}`)
                    .join('\n\n');
                return { resolvedPath: `templates/${id}`, content };
            }
            // 2. Explicit kind prefix.
            if (raw.startsWith('behaviors/') || raw.startsWith('systems/') || raw.startsWith('ui/')) {
                const hit = readLibraryFile(raw);
                if (!hit) return { notFound: [raw] };
                return { resolvedPath: raw, content: hit.content };
            }
            // 3. Kind-inferring. References in library files drop the kind
            //    prefix. `*.ts` is behaviors or systems; `*.html` is ui;
            //    bare names are a ui panel id or template id.
            if (raw.endsWith('.ts')) {
                const tried: string[] = [];
                for (const kind of ['behaviors', 'systems'] as const) {
                    const p = `${kind}/${raw}`;
                    tried.push(p);
                    const hit = readLibraryFile(p);
                    if (hit) return { resolvedPath: p, content: hit.content };
                }
                return { notFound: tried };
            }
            if (raw.endsWith('.html')) {
                const p = `ui/${raw}`;
                const hit = readLibraryFile(p);
                if (hit) return { resolvedPath: p, content: hit.content };
                return { notFound: [p] };
            }
            // No extension.
            const tried: string[] = [];
            {
                const p = `ui/${raw}.html`;
                tried.push(p);
                const hit = readLibraryFile(p);
                if (hit) return { resolvedPath: p, content: hit.content };
            }
            if (/^[a-zA-Z0-9_-]+$/.test(raw)) {
                const tpl = readLibraryTemplate(raw);
                if (tpl) {
                    const content = Object.entries(tpl)
                        .map(([name, c]) => `=== ${name} ===\n${c}`)
                        .join('\n\n');
                    return { resolvedPath: `templates/${raw}`, content };
                }
                tried.push(`templates/${raw}`);
            }
            return { notFound: tried };
        };

        // Single-path: keep the clean "content or 404" response.
        if (paths.length === 1) {
            const r = resolveOne(paths[0]);
            if ('notFound' in r) {
                return res.status(404).json({ error: 'not_found', tried: r.notFound });
            }
            res.setHeader('X-Library-Resolved-Path', r.resolvedPath);
            return res.type('text/plain').send(r.content);
        }

        // Multi-path: concatenate. Anything that couldn't be resolved
        // becomes a "=== NOT_FOUND: <what was tried> ===" block so the
        // agent can tell what worked vs didn't without a second call.
        const parts: string[] = [];
        for (const p of paths) {
            const r = resolveOne(p);
            if ('notFound' in r) {
                parts.push(`=== NOT_FOUND: ${p} (tried: ${r.notFound.join(', ')}) ===`);
            } else {
                parts.push(`=== ${r.resolvedPath} ===\n${r.content}`);
            }
        }
        res.type('text/plain').send(parts.join('\n\n'));
    });

    return router;
}
