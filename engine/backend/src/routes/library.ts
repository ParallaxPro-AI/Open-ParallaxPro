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
import { getCoOccurrenceAnnotation } from '../ws/services/pipeline/library_graph.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname_lib = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR_FOR_EXAMPLES = path.resolve(__dirname_lib, '..', 'ws', 'services', 'pipeline', 'reusable_game_components');

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

    router.get('/examples', (req: Request, res: Response) => {
        // Grep-style examples finder. Given a query string (typically a
        // method name like "setTimeOfDay" or a type name like
        // "LightComponent"), walk every library + template file looking
        // for literal substring hits. Return file:line + a few lines
        // of context so the agent sees how the API is actually called.
        // Soft-caps total response to keep transcript cost predictable.
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (!q) return res.status(400).json({ error: 'q is required' });
        const limit = Math.min(Math.max(parseInt(String(req.query.limit || '12'), 10) || 12, 1), 40);
        const ctx = Math.min(Math.max(parseInt(String(req.query.context || '2'), 10) || 2, 0), 6);
        const MAX_BYTES = 3500;

        const hits: Array<{ path: string; line: number; snippet: string }> = [];
        let totalBytes = 0;
        const scanned = { behaviors: 0, systems: 0, ui: 0, templates: 0 };

        const walk = (dir: string, kind: keyof typeof scanned, extFilter: (p: string) => boolean, relBase: string) => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, entry.name);
                const rel = path.posix.join(relBase, entry.name);
                if (entry.isDirectory()) { walk(p, kind, extFilter, rel); continue; }
                if (!extFilter(entry.name)) continue;
                scanned[kind]++;
                let text: string;
                try { text = fs.readFileSync(p, 'utf-8'); } catch { continue; }
                const lines = text.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (!lines[i].includes(q)) continue;
                    if (hits.length >= limit) return;
                    const start = Math.max(0, i - ctx);
                    const end = Math.min(lines.length, i + ctx + 1);
                    const snippet = lines.slice(start, end).map((l, k) => {
                        const n = start + k + 1;
                        const mark = n === i + 1 ? '→' : ' ';
                        return `${mark}${String(n).padStart(4)}: ${l}`;
                    }).join('\n');
                    const b = Buffer.byteLength(snippet, 'utf-8');
                    if (totalBytes + b > MAX_BYTES) return;
                    totalBytes += b;
                    hits.push({ path: rel, line: i + 1, snippet });
                }
            }
        };

        walk(path.join(RGC_DIR_FOR_EXAMPLES, 'behaviors', 'v0.1'), 'behaviors', n => n.endsWith('.ts'), 'behaviors');
        walk(path.join(RGC_DIR_FOR_EXAMPLES, 'systems',   'v0.1'), 'systems',   n => n.endsWith('.ts'), 'systems');
        walk(path.join(RGC_DIR_FOR_EXAMPLES, 'ui',        'v0.1'), 'ui',        n => n.endsWith('.html'), 'ui');
        walk(path.join(RGC_DIR_FOR_EXAMPLES, 'game_templates', 'v0.1'), 'templates', n => n.endsWith('.json'), 'templates');

        res.json({ query: q, scanned, hits });
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

        // Tack co-occurrence hints ("often paired with", "used in
        // templates") onto each library file, so the agent sees
        // related files without a second round-trip. Template shows
        // skip this — they already show everything they contain.
        //
        // Critical: wrap the hint in format-native comment syntax for
        // the file's kind. If the agent copies the raw response into
        // project/ verbatim (e.g. `library.sh show ui/foo.html > file`
        // then cp), we don't want the annotation to end up as visible
        // text in a rendered HTML page or as a syntax error in TS.
        const wrapAnnotation = (resolvedPath: string, hint: string): string => {
            if (resolvedPath.endsWith('.html')) return `<!--\n${hint}\n-->`;
            if (resolvedPath.endsWith('.ts') || resolvedPath.endsWith('.js')) return `/*\n${hint}\n*/`;
            return hint;
        };
        const annotationFor = (resolvedPath: string): string => {
            const hint = getCoOccurrenceAnnotation(resolvedPath);
            return hint ? `\n\n${wrapAnnotation(resolvedPath, hint)}\n` : '';
        };

        // resolveOne returns raw body without annotation so the caller
        // can apply --head/--tail/--range to just the content, then
        // re-append the annotation untouched after slicing.
        const resolveOne = (raw: string): { resolvedPath: string; content: string; annotate: boolean } | { notFound: string[] } => {
            // 1. Explicit template path.
            if (raw.startsWith('templates/')) {
                const id = raw.slice('templates/'.length).replace(/\/+$/, '');
                const tpl = readLibraryTemplate(id);
                if (!tpl) return { notFound: [`templates/${id}`] };
                const content = Object.entries(tpl)
                    .map(([name, c]) => `=== ${name} ===\n${c}`)
                    .join('\n\n');
                return { resolvedPath: `templates/${id}`, content, annotate: false };
            }
            // 2. Explicit kind prefix.
            if (raw.startsWith('behaviors/') || raw.startsWith('systems/') || raw.startsWith('ui/')) {
                const hit = readLibraryFile(raw);
                if (!hit) return { notFound: [raw] };
                return { resolvedPath: raw, content: hit.content, annotate: true };
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
                    if (hit) return { resolvedPath: p, content: hit.content, annotate: true };
                }
                return { notFound: tried };
            }
            if (raw.endsWith('.html')) {
                const p = `ui/${raw}`;
                const hit = readLibraryFile(p);
                if (hit) return { resolvedPath: p, content: hit.content, annotate: true };
                return { notFound: [p] };
            }
            // No extension.
            const tried: string[] = [];
            {
                const p = `ui/${raw}.html`;
                tried.push(p);
                const hit = readLibraryFile(p);
                if (hit) return { resolvedPath: p, content: hit.content, annotate: true };
            }
            if (/^[a-zA-Z0-9_-]+$/.test(raw)) {
                const tpl = readLibraryTemplate(raw);
                if (tpl) {
                    const content = Object.entries(tpl)
                        .map(([name, c]) => `=== ${name} ===\n${c}`)
                        .join('\n\n');
                    return { resolvedPath: `templates/${raw}`, content, annotate: false };
                }
                tried.push(`templates/${raw}`);
            }
            return { notFound: tried };
        };

        // Parse optional ?head=N / ?tail=N / ?range=L1-L2 (1-based,
        // inclusive). Only applied on single-path responses. Multi-
        // path would make slice semantics ambiguous across files.
        const parseSlice = (): { kind: 'head'|'tail'|'range'; a: number; b?: number } | null => {
            const head = parseInt((req.query.head as string) ?? '', 10);
            if (Number.isFinite(head) && head > 0) return { kind: 'head', a: head };
            const tail = parseInt((req.query.tail as string) ?? '', 10);
            if (Number.isFinite(tail) && tail > 0) return { kind: 'tail', a: tail };
            const range = typeof req.query.range === 'string' ? req.query.range : '';
            const rm = range.match(/^(\d+)-(\d+)$/);
            if (rm) {
                const a = parseInt(rm[1], 10), b = parseInt(rm[2], 10);
                if (a > 0 && b >= a) return { kind: 'range', a, b };
            }
            return null;
        };
        const applySlice = (content: string, slice: ReturnType<typeof parseSlice>): string => {
            if (!slice) return content;
            const lines = content.split('\n');
            const total = lines.length;
            let out: string[];
            let note: string;
            if (slice.kind === 'head') {
                out = lines.slice(0, slice.a);
                note = `[head ${out.length} of ${total} lines]`;
            } else if (slice.kind === 'tail') {
                const start = Math.max(0, total - slice.a);
                out = lines.slice(start);
                note = `[tail ${out.length} of ${total} lines; starts at line ${start + 1}]`;
            } else {
                const start = Math.max(0, slice.a - 1);
                const end = Math.min(total, slice.b!);
                out = lines.slice(start, end);
                note = `[lines ${start + 1}-${end} of ${total}]`;
            }
            return out.join('\n') + `\n\n${note}`;
        };

        // Single-path: keep the clean "content or 404" response.
        if (paths.length === 1) {
            const r = resolveOne(paths[0]);
            if ('notFound' in r) {
                return res.status(404).json({ error: 'not_found', tried: r.notFound });
            }
            const slice = parseSlice();
            const sliced = applySlice(r.content, slice);
            const body = r.annotate ? sliced + annotationFor(r.resolvedPath) : sliced;
            res.setHeader('X-Library-Resolved-Path', r.resolvedPath);
            return res.type('text/plain').send(body);
        }

        // Multi-path: concatenate. Anything that couldn't be resolved
        // becomes a "=== NOT_FOUND: <what was tried> ===" block so the
        // agent can tell what worked vs didn't without a second call.
        // Slice flags are ignored for multi-path — they'd be ambiguous
        // across files.
        const parts: string[] = [];
        for (const p of paths) {
            const r = resolveOne(p);
            if ('notFound' in r) {
                parts.push(`=== NOT_FOUND: ${p} (tried: ${r.notFound.join(', ')}) ===`);
            } else {
                const body = r.annotate ? r.content + annotationFor(r.resolvedPath) : r.content;
                parts.push(`=== ${r.resolvedPath} ===\n${body}`);
            }
        }
        res.type('text/plain').send(parts.join('\n\n'));
    });

    /**
     * GET /animations?path=<asset_path> [&path=...]
     *
     * Look up the animation clip names baked into a GLB. Reads the
     * pre-built manifest at engine/backend/data/glb_clip_manifest.json.
     * Returns a plain-text list — one clip per line, prefixed with the
     * asset path so multi-asset queries are unambiguous. Used by the
     * CLI's `library.sh animations <path>` subcommand so the agent can
     * verify clip names before authoring `entity.playAnimation("X")`
     * calls — and the `animation_clip_resolves` invariant uses the
     * same manifest as the static-analysis source of truth.
     *
     * Asset paths take the same form 02_entities.json uses, e.g.
     *   /assets/quaternius/characters/platformer_game_kit/Character.glb
     *
     * Soft-fail: paths not in the manifest emit `=== NOT_FOUND: ... ===`
     * markers (same shape as /file) so library.sh degrades gracefully.
     * If the manifest itself is missing, returns a 503 with a hint to
     * regenerate it via `npx tsx engine/backend/src/scripts/build_glb_clip_manifest.ts`.
     */
    router.get('/animations', (req: Request, res: Response) => {
        const manifestPath = path.resolve(__dirname_lib, '..', '..', 'data', 'glb_clip_manifest.json');
        if (!fs.existsSync(manifestPath)) {
            return res.status(503).type('text/plain').send(
                'glb_clip_manifest.json missing. Regenerate with:\n' +
                '  npx tsx engine/backend/src/scripts/build_glb_clip_manifest.ts'
            );
        }
        let manifest: Record<string, { clips: string[] }>;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch (e: any) {
            return res.status(500).type('text/plain').send(`manifest parse failed: ${e?.message ?? e}`);
        }
        const rawP = req.query.path;
        let paths: string[];
        if (Array.isArray(rawP))               paths = rawP.map(x => String(x).trim()).filter(Boolean);
        else if (typeof rawP === 'string')     paths = [rawP.trim()].filter(Boolean);
        else                                   paths = [];
        if (paths.length === 0) return res.status(400).json({ error: 'path is required' });

        const parts: string[] = [];
        for (const p of paths) {
            const entry = manifest[p];
            if (!entry) {
                parts.push(`=== NOT_FOUND: ${p} (not in manifest — check the path matches /assets/<vendor>/<...>/<name>.glb exactly) ===`);
                continue;
            }
            if (entry.clips.length === 0) {
                parts.push(`=== ${p} ===\n(no animation clips — this GLB is static or uses skeletal data only)`);
                continue;
            }
            parts.push(`=== ${p} ===\n${entry.clips.join('\n')}`);
        }
        res.type('text/plain').send(parts.join('\n\n'));
    });

    return router;
}
