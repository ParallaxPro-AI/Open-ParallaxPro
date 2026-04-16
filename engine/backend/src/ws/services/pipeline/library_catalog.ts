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

export interface LibraryCatalog {
    behaviors: LibraryItem[];   // reference/behaviors/v0.1/<relPath>
    systems:   LibraryItem[];   // reference/systems/v0.1/<relPath>
    ui:        LibraryItem[];   // reference/ui/v0.1/<relPath>
    events:    string[];        // all event names from event_definitions.ts
    templates: string[];        // every directory under game_templates/v0.1/
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
