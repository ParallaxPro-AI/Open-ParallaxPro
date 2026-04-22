/**
 * Library catalog — the source of truth for which behaviors / systems / UI
 * panels exist and what they do. Two consumers:
 *   1. The qa_creator LLM prompt (so the model picks from real names).
 *   2. The assembler validator (so we never write a project file referencing
 *      a name the engine doesn't know about).
 *
 * Built lazily by scanning reusable_game_components/v0.1/. Cached for the
 * life of the process. Re-scan on backend restart.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname_lc = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname_lc, 'reusable_game_components');

export interface LibraryItem {
    /** Path relative to its kind (e.g. "movement/platformer_movement.ts"). */
    relPath: string;
    /** Top-of-file `// description` comment, or empty. */
    description: string;
}

export type LibraryKind = 'behaviors' | 'systems' | 'ui' | 'templates';

export interface LibraryCatalog {
    behaviors: LibraryItem[];   // reference/behaviors/v0.1/<relPath>
    systems:   LibraryItem[];   // reference/systems/v0.1/<relPath>
    ui:        LibraryItem[];   // reference/ui/v0.1/<relPath>
    events:    string[];        // all event names from event_definitions.ts
    templates: string[];        // every directory under game_templates/v0.1/
}

/**
 * The same items but enriched with kind/category/name — what the
 * library tool returns from its index + search endpoints.
 *
 *   kind:     'behaviors' | 'systems' | 'ui'
 *   category: first path segment (e.g. "movement", "ai", "hud")
 *   name:     basename without extension (e.g. "jump", "main_menu")
 *   summary:  alias for description (renamed for tool output clarity)
 */
export interface EnrichedLibraryItem {
    kind: LibraryKind;
    relPath: string;
    category: string;
    name: string;
    summary: string;
}

let cachedEnriched: { kind: LibraryKind; items: EnrichedLibraryItem[] }[] | null = null;

export function getEnrichedLibrary(): Record<LibraryKind, EnrichedLibraryItem[]> {
    if (!cachedEnriched) {
        const cat = getLibraryCatalog();
        cachedEnriched = [
            { kind: 'behaviors' as const, items: enrich(cat.behaviors, 'behaviors') },
            { kind: 'systems'   as const, items: enrich(cat.systems,   'systems') },
            { kind: 'ui'        as const, items: enrich(cat.ui,        'ui') },
            { kind: 'templates' as const, items: enrichTemplates(cat.templates) },
        ];
    }
    const out: Record<LibraryKind, EnrichedLibraryItem[]> = {
        behaviors: [], systems: [], ui: [], templates: [],
    };
    for (const e of cachedEnriched) out[e.kind] = e.items;
    return out;
}

function enrich(items: LibraryItem[], kind: LibraryKind): EnrichedLibraryItem[] {
    return items.map(i => {
        const [category, ...rest] = i.relPath.split('/');
        // Single-file-at-root case: no subcategory — use kind as the grouping.
        const hasSubdir = rest.length > 0;
        const name = (hasSubdir ? rest.join('/') : i.relPath).replace(/\.[^.]+$/, '');
        return {
            kind,
            relPath: i.relPath,
            category: hasSubdir ? category : '_root',
            name,
            summary: i.description,
        };
    });
}

/**
 * Templates are directories (4 JSONs each), so we synthesize an enriched
 * entry by reading 01_flow.json's name + description. Falls back to the
 * template id if the JSON isn't parseable or lacks fields.
 *
 * relPath is intentionally the id itself (no trailing slash) so the tool
 * surface can use "templates/<id>" uniformly alongside other kinds.
 */
function enrichTemplates(ids: string[]): EnrichedLibraryItem[] {
    return ids.map(id => {
        let summary = '';
        try {
            const flowPath = path.join(RGC_DIR, 'game_templates', 'v0.1', id, '01_flow.json');
            if (fs.existsSync(flowPath)) {
                const parsed = JSON.parse(fs.readFileSync(flowPath, 'utf-8'));
                // Prefer description; fall back to name.
                summary = String(parsed?.description || parsed?.name || '').trim();
            }
        } catch { /* leave summary empty */ }
        return {
            kind: 'templates' as const,
            relPath: id,
            category: '_root',
            name: id,
            summary,
        };
    });
}

/**
 * Safe read of a library file. `relPath` is of the form
 * "<kind>/<path-within-kind>" e.g. "behaviors/movement/jump.ts".
 * Returns null if the file is outside the library tree or missing.
 * The relPath is normalized and validated to stay under RGC_DIR/<kind>/v0.1/.
 */
export function readLibraryFile(relPath: string): { kind: LibraryKind; relPath: string; content: string } | null {
    // Split the first segment as kind; the rest is path within the kind root.
    const firstSlash = relPath.indexOf('/');
    if (firstSlash < 0) return null;
    const kind = relPath.slice(0, firstSlash) as LibraryKind;
    const within = relPath.slice(firstSlash + 1);
    // Templates are dirs with 4 JSONs — reached via readLibraryTemplate.
    // This fetch only handles single-file kinds.
    if (kind !== 'behaviors' && kind !== 'systems' && kind !== 'ui') return null;

    const root = path.join(RGC_DIR, kind, 'v0.1');
    const full = path.resolve(root, within);
    if (!full.startsWith(root + path.sep) && full !== root) return null;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    try {
        return { kind, relPath: within, content: fs.readFileSync(full, 'utf-8') };
    } catch { return null; }
}

/**
 * Read every JSON file in a game_templates/v0.1/<id>/ dir. Returns a
 * map of filename → content (4 files expected: 01_flow.json,
 * 02_entities.json, 03_worlds.json, 04_systems.json) or null if the
 * template doesn't exist.
 */
export function readLibraryTemplate(id: string): Record<string, string> | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null; // reject traversal
    const root = path.join(RGC_DIR, 'game_templates', 'v0.1', id);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;
    const out: Record<string, string> = {};
    for (const entry of fs.readdirSync(root)) {
        if (!entry.endsWith('.json')) continue;
        try { out[entry] = fs.readFileSync(path.join(root, entry), 'utf-8'); } catch {}
    }
    return Object.keys(out).length > 0 ? out : null;
}

let cached: LibraryCatalog | null = null;

export function getLibraryCatalog(): LibraryCatalog {
    if (cached) return cached;
    cached = build();
    return cached;
}

function build(): LibraryCatalog {
    return {
        behaviors: scanFiles(path.join(RGC_DIR, 'behaviors', 'v0.1'), '.ts'),
        systems:   scanFiles(path.join(RGC_DIR, 'systems', 'v0.1'),   '.ts'),
        ui:        scanFiles(path.join(RGC_DIR, 'ui', 'v0.1'),        '.html'),
        events:    extractEventNames(path.join(RGC_DIR, 'systems', 'v0.1', 'event_definitions.ts')),
        templates: scanDirNames(path.join(RGC_DIR, 'game_templates', 'v0.1')),
    };
}

function scanFiles(rootDir: string, ext: string): LibraryItem[] {
    if (!fs.existsSync(rootDir)) return [];
    const out: LibraryItem[] = [];
    walk(rootDir, '', file => {
        if (!file.endsWith(ext)) return;
        const full = path.join(rootDir, file);
        out.push({ relPath: file, description: extractTopComment(full) });
    });
    return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function walk(root: string, rel: string, cb: (file: string) => void): void {
    const dir = path.join(root, rel);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const next = rel ? path.join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) walk(root, next, cb);
        else cb(next);
    }
}

function scanDirNames(root: string): string[] {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
}

function extractTopComment(file: string): string {
    try {
        const lines = fs.readFileSync(file, 'utf-8').split('\n');
        // Grab the first contiguous run of `// ...` or HTML <!-- ... --> comments.
        const out: string[] = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('//')) {
                out.push(trimmed.replace(/^\/\/\s?/, ''));
            } else if (trimmed.startsWith('<!--')) {
                out.push(trimmed.replace(/^<!--\s?/, '').replace(/-->\s*$/, ''));
            } else if (out.length > 0) {
                break;  // ran past the leading comment block
            } else if (trimmed === '') {
                continue;  // skip leading blank lines
            } else {
                break;
            }
        }
        return out.join(' ').trim();
    } catch { return ''; }
}

function extractEventNames(file: string): string[] {
    if (!fs.existsSync(file)) return [];
    try {
        const src = fs.readFileSync(file, 'utf-8');
        const out: string[] = [];
        // Each event is a top-level key in EVENTS; pattern `^    name: { ... }`.
        for (const m of src.matchAll(/^\s+(\w+)\s*:/gm)) {
            const name = m[1];
            if (['fields', 'type', 'optional'].includes(name)) continue;
            out.push(name);
        }
        // Dedupe
        return Array.from(new Set(out)).sort();
    } catch { return []; }
}

// ─── Format for LLM prompt ────────────────────────────────────────────────

/**
 * Compact catalog string for injection into the qa_creator system prompt.
 * Every behavior/system/UI panel as `<relPath> — <description>`.
 * Roughly 5-8k tokens — worth it for the quality bump, fits in any modern
 * context window with room to spare.
 */
export function formatCatalogForPrompt(c: LibraryCatalog): string {
    const fmt = (items: LibraryItem[]) =>
        items.map(i => `  - ${i.relPath}${i.description ? ' — ' + truncate(i.description, 140) : ''}`).join('\n');
    return [
        `## Behaviors (per-entity scripts; reference path in 02_entities.json's behaviors[].script)`,
        fmt(c.behaviors),
        ``,
        `## Systems (global scripts; reference path in 04_systems.json's systems.<key>.script)`,
        fmt(c.systems),
        ``,
        `## UI panels (HTML overlays; named in 01_flow.json show_ui:<name>)`,
        fmt(c.ui),
        ``,
        `## Templates (game_templates/v0.1/<name>/ — your starting point)`,
        c.templates.map(t => `  - ${t}`).join('\n'),
        ``,
        `## Events (only these names parse; emit/listen via game/net/ui buses)`,
        wrap(c.events.join(', '), 100, '  '),
    ].join('\n');
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function wrap(s: string, width: number, indent: string): string {
    const words = s.split(' ');
    const lines: string[] = [indent];
    for (const w of words) {
        const last = lines[lines.length - 1];
        if (last.length + w.length + 1 > width) lines.push(indent + w);
        else lines[lines.length - 1] = last + (last === indent ? '' : ' ') + w;
    }
    return lines.join('\n');
}

// ─── Validators (used by the assembler) ───────────────────────────────────

export function isKnownBehavior(c: LibraryCatalog, relPath: string): boolean {
    return c.behaviors.some(b => b.relPath === relPath);
}
export function isKnownSystem(c: LibraryCatalog, relPath: string): boolean {
    return c.systems.some(s => s.relPath === relPath);
}
export function isKnownUI(c: LibraryCatalog, relPath: string): boolean {
    // UI references in flow are like "hud/health" — we add .html when matching.
    const withExt = relPath.endsWith('.html') ? relPath : relPath + '.html';
    return c.ui.some(u => u.relPath === withExt);
}
export function isKnownEvent(c: LibraryCatalog, name: string): boolean {
    return c.events.includes(name);
}
