/**
 * Library co-occurrence graph — "which library files are used together in
 * which templates." Built by walking every shipped game template once at
 * boot, cached to disk, served as optional annotations on library.sh show
 * responses.
 *
 * Pure additive: if the graph is missing or stale, file responses just
 * don't carry annotations. No fallback path needed.
 *
 * Fingerprint includes all template JSON content — when any template
 * changes, the graph rebuilds. Takes <100ms for the current corpus.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname_lg = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_ROOT = path.join(__dirname_lg, 'reusable_game_components', 'game_templates', 'v0.1');
const GRAPH_CACHE_PATH = path.resolve(__dirname_lg, '../../../../.library_graph_cache.json');

interface GraphCache {
    version: 1;
    fingerprint: string;
    // For each library file path (e.g. "behaviors/movement/jump.ts"),
    // which templates reference it. Co-occurrence weights are derived
    // on query: count of shared templates between two files.
    templatesByFile: Record<string, string[]>;
}

let cached: GraphCache | null = null;

// ─── Template scanner ────────────────────────────────────────────────────

/**
 * Walk one template dir, extract every library file it references.
 * Returns normalized library paths (with kind prefix), which are the
 * same identifiers used by library.sh / the /file endpoint.
 */
function scanTemplate(templateDir: string): string[] {
    const refs = new Set<string>();
    const read = (name: string): any | null => {
        try { return JSON.parse(fs.readFileSync(path.join(templateDir, name), 'utf-8')); }
        catch { return null; }
    };

    // 02_entities.json — every `script: "movement/jump.ts"` lives under
    // behaviors/, regardless of nesting depth.
    const entities = read('02_entities.json');
    walk(entities, (key, val) => {
        if (key === 'script' && typeof val === 'string') refs.add(`behaviors/${val}`);
    });

    // 04_systems.json — every system has `script: "gameplay/foo.ts"`,
    // which lives under systems/.
    const systems = read('04_systems.json');
    walk(systems, (key, val) => {
        if (key === 'script' && typeof val === 'string') refs.add(`systems/${val}`);
    });

    // 01_flow.json — action strings like "show_ui:hud/health" and
    // "show_ui:main_menu" each reference one UI panel.
    const flow = read('01_flow.json');
    walk(flow, (key, val) => {
        if (key === 'show_ui' && typeof val === 'string') refs.add(normalizeUi(val));
        if (key === 'on_enter' || key === 'on_exit') {
            if (Array.isArray(val)) {
                for (const a of val) {
                    if (typeof a === 'string' && a.startsWith('show_ui:')) {
                        refs.add(normalizeUi(a.slice('show_ui:'.length)));
                    }
                }
            }
        }
    });

    return [...refs];
}

function walk(obj: any, cb: (key: string, val: any) => void): void {
    if (obj == null) return;
    if (Array.isArray(obj)) { for (const v of obj) walk(v, cb); return; }
    if (typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
        cb(k, v);
        walk(v, cb);
    }
}

function normalizeUi(ref: string): string {
    // Templates reference UI as "main_menu" or "hud/health"; the library
    // layout is ui/<subpath>.html.
    const cleaned = ref.replace(/^\/+/, '');
    return cleaned.endsWith('.html') ? `ui/${cleaned}` : `ui/${cleaned}.html`;
}

// ─── Graph build ─────────────────────────────────────────────────────────

function fingerprintTemplates(): string {
    const hash = crypto.createHash('sha256');
    if (!fs.existsSync(TEMPLATES_ROOT)) return 'no-templates';
    const templateIds = fs.readdirSync(TEMPLATES_ROOT).sort();
    for (const id of templateIds) {
        const dir = path.join(TEMPLATES_ROOT, id);
        if (!fs.statSync(dir).isDirectory()) continue;
        hash.update(id + '\n');
        for (const f of ['01_flow.json', '02_entities.json', '03_worlds.json', '04_systems.json']) {
            try { hash.update(fs.readFileSync(path.join(dir, f))); }
            catch { /* missing file is fine, still contributes to fingerprint */ }
        }
    }
    return hash.digest('hex');
}

function build(): GraphCache {
    const fingerprint = fingerprintTemplates();

    if (fs.existsSync(GRAPH_CACHE_PATH)) {
        try {
            const loaded: GraphCache = JSON.parse(fs.readFileSync(GRAPH_CACHE_PATH, 'utf-8'));
            if (loaded.version === 1 && loaded.fingerprint === fingerprint) {
                console.log(`[LibraryGraph] Loaded cached graph (${Object.keys(loaded.templatesByFile).length} files)`);
                return loaded;
            }
        } catch { /* corrupt cache — rebuild below */ }
    }

    const templatesByFile: Record<string, string[]> = {};
    if (fs.existsSync(TEMPLATES_ROOT)) {
        for (const id of fs.readdirSync(TEMPLATES_ROOT).sort()) {
            const dir = path.join(TEMPLATES_ROOT, id);
            if (!fs.statSync(dir).isDirectory()) continue;
            for (const ref of scanTemplate(dir)) {
                (templatesByFile[ref] ??= []).push(id);
            }
        }
    }

    const out: GraphCache = { version: 1, fingerprint, templatesByFile };
    try {
        fs.writeFileSync(GRAPH_CACHE_PATH, JSON.stringify(out));
        console.log(`[LibraryGraph] Built graph for ${Object.keys(templatesByFile).length} files across ${fs.readdirSync(TEMPLATES_ROOT).length} templates`);
    } catch (e: any) {
        console.warn(`[LibraryGraph] Cache write failed: ${e.message}`);
    }
    return out;
}

function getCache(): GraphCache {
    if (cached) return cached;
    cached = build();
    return cached;
}

// ─── Annotation serving ──────────────────────────────────────────────────

const MAX_PAIRS = 5;        // top-N co-used files
const MIN_WEIGHT = 1;       // skip coincidental pairings
const MAX_TEMPLATE_NAMES = 5;
// Files used in >= this many templates are considered "universal" — their
// template list doesn't help the agent pick, so we collapse it.
const UNIVERSAL_THRESHOLD = 20;

/**
 * Annotation block appended to a library.sh `show` response. Returns a
 * short text block (no leading/trailing newlines) or an empty string
 * if the file isn't in the graph (e.g. newly added, not yet in any
 * template).
 */
export function getCoOccurrenceAnnotation(relPath: string): string {
    const g = getCache();
    const myTemplates = g.templatesByFile[relPath];
    if (!myTemplates || myTemplates.length === 0) return '';

    const mySet = new Set(myTemplates);

    // Count co-occurrences with every other file.
    const pairs: Array<{ path: string; weight: number }> = [];
    for (const [otherPath, otherTemplates] of Object.entries(g.templatesByFile)) {
        if (otherPath === relPath) continue;
        let weight = 0;
        for (const t of otherTemplates) if (mySet.has(t)) weight++;
        if (weight >= MIN_WEIGHT) pairs.push({ path: otherPath, weight });
    }
    pairs.sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
    const topPairs = pairs.slice(0, MAX_PAIRS);

    const lines: string[] = [];
    if (topPairs.length > 0) {
        lines.push('=== Often paired with (co-used in templates) ===');
        const widest = Math.max(...topPairs.map(p => p.path.length));
        for (const p of topPairs) {
            lines.push(`  ${p.path.padEnd(widest)}  (${p.weight} template${p.weight === 1 ? '' : 's'})`);
        }
    }

    if (myTemplates.length >= UNIVERSAL_THRESHOLD) {
        if (lines.length > 0) lines.push('');
        lines.push(`=== Used in ${myTemplates.length} templates (universal — most shipped games include this) ===`);
    } else {
        if (lines.length > 0) lines.push('');
        lines.push(`=== Used in templates ===`);
        const shown = myTemplates.slice(0, MAX_TEMPLATE_NAMES);
        let line = `  ${shown.join(', ')}`;
        if (myTemplates.length > shown.length) line += `, …and ${myTemplates.length - shown.length} more`;
        lines.push(line);
    }

    return lines.join('\n');
}

// Kick off build at module load so the first /file request doesn't pay
// the walk cost. Non-blocking: any caller that arrives before it finishes
// just triggers build() on demand (idempotent + fast).
try { getCache(); } catch (e: any) {
    console.warn(`[LibraryGraph] Initial build failed: ${e?.message}`);
}
