/**
 * Semantic retrieval of reference/ library files for the fixer/creator sandbox.
 *
 * At boot we embed each behavior/system/UI file's relPath + top-comment
 * description with all-MiniLM-L6-v2, cache vectors to disk. Per request,
 * embed the task description and return top-K relPaths per category. Only
 * those files get copied into the sandbox's reference/ — the agent's
 * exploration surface drops from ~276 files to ~50.
 *
 * Fallback to shipping everything if embeddings aren't ready yet.
 *
 * Mirrors template_index.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
    initEmbedder,
    embedText,
    embedTexts,
    cosineSimilarity,
    computeFingerprint,
} from '../../../embedding_service.js';
import { getLibraryCatalog, getEnrichedLibrary, type EnrichedLibraryItem, type LibraryKind } from './library_catalog.js';

const __dirname_li = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname_li, 'reusable_game_components');
const LIBRARY_EMBEDDINGS_CACHE = path.resolve(__dirname_li, '../../../../.library_embeddings_cache.json');

type Kind = 'behaviors' | 'systems' | 'ui';

// UI panels that are engine infrastructure (lobby, pause, HUD shell). They
// must be available whenever the game wants them, and the agent won't always
// find them via semantic similarity to the task description (e.g. "top-down
// shooter" shouldn't need the lobby UI, but if it's multiplayer it will).
// Small list — keep as an always-include to avoid missing on recall.
const ALWAYS_INCLUDE_UI: ReadonlySet<string> = new Set([
    'main_menu.html',
    'pause_menu.html',
    'lobby_browser.html',
    'lobby_host_config.html',
    'lobby_room.html',
    'connecting_overlay.html',
    'disconnected_banner.html',
    'hud/ping.html',
    'hud/text_chat.html',
    'hud/voice_chat.html',
    'hud/scoreboard.html',
]);

interface IndexEntry {
    kind: Kind;
    relPath: string; // within the kind's v0.1/ root
    vector: number[];
}

let entries: IndexEntry[] | null = null;
let initPromise: Promise<void> | null = null;

function buildCorpus(): Array<{ key: string; text: string; kind: Kind; relPath: string }> {
    const cat = getLibraryCatalog();
    const out: Array<{ key: string; text: string; kind: Kind; relPath: string }> = [];
    const push = (kind: Kind, relPath: string, description: string) => {
        // Prepend kind + filename-derived label so queries like "movement" or
        // "health hud" get non-zero signal even when the file's top comment
        // is sparse. relPath carries category + stem (e.g. "movement/jump.ts").
        const stem = relPath.replace(/\.[^.]+$/, '').replace(/[\/_]/g, ' ');
        out.push({
            key: `${kind}:${relPath}`,
            kind,
            relPath,
            text: `${kind} ${stem} ${description}`.trim(),
        });
    };
    for (const b of cat.behaviors) push('behaviors', b.relPath, b.description);
    for (const s of cat.systems)   push('systems',   s.relPath, s.description);
    for (const u of cat.ui)        push('ui',        u.relPath, u.description);
    return out;
}

export function libraryIndexReady(): boolean {
    return entries !== null;
}

export function initLibraryIndex(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        const corpus = buildCorpus();
        const fingerprint = computeFingerprint(corpus.map(c => ({ key: c.key, text: c.text })));

        let vectors: number[][] | null = null;
        if (fs.existsSync(LIBRARY_EMBEDDINGS_CACHE)) {
            try {
                const data = JSON.parse(fs.readFileSync(LIBRARY_EMBEDDINGS_CACHE, 'utf-8'));
                if (data?.fingerprint === fingerprint
                    && Array.isArray(data.vectors)
                    && data.vectors.length === corpus.length) {
                    vectors = data.vectors;
                }
            } catch { /* corrupt cache — recompute */ }
        }

        if (!vectors) {
            await initEmbedder();
            vectors = await embedTexts(corpus.map(c => c.text));
            try {
                fs.writeFileSync(
                    LIBRARY_EMBEDDINGS_CACHE,
                    JSON.stringify({ fingerprint, vectors }),
                );
            } catch (e: any) {
                console.warn(`[LibraryIndex] Failed to write embeddings cache: ${e.message}`);
            }
        }

        entries = corpus.map((c, i) => ({ kind: c.kind, relPath: c.relPath, vector: vectors![i] }));
        console.log(`[LibraryIndex] Indexed ${entries.length} library files`);
    })();
    return initPromise;
}

export interface LibraryPicks {
    behaviors: string[]; // relPaths within behaviors/v0.1/
    systems: string[];   // relPaths within systems/v0.1/
    ui: string[];        // relPaths within ui/v0.1/
    method: 'embedding' | 'all-fallback';
}

export interface LibraryPickOpts {
    topBehaviors?: number;
    topSystems?: number;
    topUi?: number;
}

/**
 * Select the library files most relevant to `description`. On any failure
 * (embedder not ready, embed error) returns the full catalog so the caller's
 * behavior is strictly no-worse than the current "ship everything" baseline.
 */
// Set to true to bypass semantic filtering and ship the full library to the
// creator/fixer sandbox. Kept as a flag so the embedding path can be
// re-enabled later without re-plumbing.
const DISABLE_SEMANTIC_FILTER = true;

export async function pickRelevantLibrary(
    description: string,
    opts: LibraryPickOpts = {},
): Promise<LibraryPicks> {
    const topBehaviors = opts.topBehaviors ?? 25;
    const topSystems  = opts.topSystems  ?? 15;
    const topUi       = opts.topUi       ?? 15;

    if (initPromise && !DISABLE_SEMANTIC_FILTER) {
        try { await initPromise; } catch { /* fall through to all */ }
    }

    const cat = getLibraryCatalog();
    const allBehaviors = cat.behaviors.map(b => b.relPath);
    const allSystems   = cat.systems.map(s => s.relPath);
    const allUi        = cat.ui.map(u => u.relPath);
    const alwaysUi     = allUi.filter(r => ALWAYS_INCLUDE_UI.has(r));

    if (DISABLE_SEMANTIC_FILTER || !entries) {
        return { behaviors: allBehaviors, systems: allSystems, ui: allUi, method: 'all-fallback' };
    }

    let queryVec: number[];
    try {
        queryVec = await embedText(description);
    } catch {
        return { behaviors: allBehaviors, systems: allSystems, ui: allUi, method: 'all-fallback' };
    }

    const byKind: Record<Kind, Array<{ relPath: string; score: number }>> = {
        behaviors: [], systems: [], ui: [],
    };
    for (const e of entries) {
        byKind[e.kind].push({ relPath: e.relPath, score: cosineSimilarity(queryVec, e.vector) });
    }
    const topK = (arr: Array<{ relPath: string; score: number }>, k: number) =>
        arr.sort((a, b) => b.score - a.score).slice(0, k).map(x => x.relPath);

    const uiSet = new Set<string>(topK(byKind.ui, topUi));
    for (const rel of alwaysUi) uiSet.add(rel);

    return {
        behaviors: topK(byKind.behaviors, topBehaviors),
        systems:   topK(byKind.systems,   topSystems),
        ui:        Array.from(uiSet),
        method: 'embedding',
    };
}

/**
 * Copy the picked files from reusable_game_components/{kind}/v0.1/ into
 * <refDir>/{kind}/. Creates directories as needed. Missing source files are
 * skipped silently — the index is built from the same catalog, so normally
 * every relPath exists, but we don't want stale index entries to break the
 * sandbox build.
 */
export function copyPickedLibraryFiles(picks: LibraryPicks, refDir: string): void {
    const kinds: Kind[] = ['behaviors', 'systems', 'ui'];
    for (const kind of kinds) {
        const srcRoot = path.join(RGC_DIR, kind, 'v0.1');
        const destRoot = path.join(refDir, kind);
        const relPaths =
            kind === 'behaviors' ? picks.behaviors :
            kind === 'systems'   ? picks.systems  :
                                   picks.ui;
        for (const rel of relPaths) {
            const src = path.join(srcRoot, rel);
            if (!fs.existsSync(src)) continue;
            const dest = path.join(destRoot, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
        }
    }
}

// ─── Public search API (for the library.sh tool) ─────────────────────────

export interface LibrarySearchHit extends EnrichedLibraryItem {
    score: number;
}

export interface LibrarySearchOpts {
    kind?: LibraryKind;
    category?: string;
    limit?: number;
}

/**
 * Semantic + lexical hybrid search over the library.
 *
 * 1. Embedding similarity (cosineSimilarity vs cached vectors) provides
 *    the primary ranking.
 * 2. A small lexical overlay bumps results whose name or category
 *    matches the query as a substring — catches literal queries like
 *    "mob_spawner" that embedding alone might miss.
 *
 * Filters are AND-ed — kind narrows to one of behaviors/systems/ui,
 * category narrows to a subdirectory within that kind.
 *
 * Returns an empty array if the embedder isn't ready; callers should
 * fall back to the full index (served by getEnrichedLibrary) in that
 * case.
 */
export async function searchLibrary(
    query: string,
    opts: LibrarySearchOpts = {},
): Promise<LibrarySearchHit[]> {
    const limit = opts.limit ?? 10;
    const enriched = getEnrichedLibrary();

    // Gather the candidate pool honoring the filters.
    let pool: EnrichedLibraryItem[] = [];
    const kinds: LibraryKind[] = opts.kind ? [opts.kind] : ['behaviors', 'systems', 'ui'];
    for (const k of kinds) {
        pool.push(...enriched[k]);
    }
    if (opts.category) pool = pool.filter(e => e.category === opts.category);
    if (pool.length === 0) return [];

    // Lexical score: 1 if query substring appears in name or category,
    // 0.5 if appears in summary. Small but deterministic bump over pure
    // cosine similarity for literal-name queries.
    const q = query.toLowerCase();
    const lex = (e: EnrichedLibraryItem): number => {
        const name = e.name.toLowerCase();
        const cat  = e.category.toLowerCase();
        const sum  = e.summary.toLowerCase();
        if (name.includes(q) || cat.includes(q)) return 1;
        if (sum.includes(q)) return 0.5;
        return 0;
    };

    // Embedding score: if embeddings aren't ready, skip — we still
    // return a lexically-ranked list (monotonically better than empty).
    let vectorByKey: Map<string, number[]> | null = null;
    if (entries !== null) {
        vectorByKey = new Map();
        for (const e of entries) vectorByKey.set(`${e.kind}:${e.relPath}`, e.vector);
    }

    let queryVec: number[] | null = null;
    if (vectorByKey) {
        try { queryVec = await embedText(query); }
        catch { queryVec = null; }
    }

    const hits: LibrarySearchHit[] = pool.map(e => {
        const lexScore = lex(e);
        let embScore = 0;
        if (vectorByKey && queryVec) {
            const v = vectorByKey.get(`${e.kind}:${e.relPath}`);
            if (v) embScore = cosineSimilarity(queryVec, v);
        }
        // Weighted blend: embedding drives ranking, lexical matches
        // add a small boost so "exact name" queries float to the top.
        const score = embScore + (lexScore * 0.15);
        return { ...e, score };
    });

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
}

// Kick off embeddings at module load, non-blocking. pickRelevantLibrary awaits
// on demand; if a request lands before init finishes it falls through to the
// all-files path (same as today's behavior).
initLibraryIndex().catch(err => {
    console.error('[LibraryIndex] Failed to initialize embeddings:', err.message);
});
