/**
 * Template Loader — discovers and loads game templates.
 *
 * Scans game_templates/v0.1/ and v0.2/ for folders containing the
 * 4-file format (01_flow.json, 02_entities.json, 03_worlds.json,
 * 04_systems.json). v0.2 allows extra files (streaming, regions, etc.)
 * alongside the core four, but the loader only requires the core four.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname_tl = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIRS = [
    { dir: path.join(__dirname_tl, 'reusable_game_components', 'game_templates', 'v0.1'), version: '0.1' as const },
    { dir: path.join(__dirname_tl, 'reusable_game_components', 'game_templates', 'v0.2'), version: '0.2' as const },
];

export interface TemplateSummary {
    id: string;
    name: string;
    description: string;
    entityCount: number;
    multiplayer: boolean;
}

export interface FullTemplate {
    id: string;
    name: string;
    description: string;
    _folderPath: string;
}

function fileIdToName(id: string): string {
    return id.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Read metadata from a game template folder */
function readFolderMeta(folderPath: string, dirName: string): TemplateSummary | null {
    const files = fs.readdirSync(folderPath);
    if (!files.includes('01_flow.json') || !files.includes('02_entities.json')) return null;

    const name = fileIdToName(dirName);
    let description = `${name} game`;
    let entityCount = 0;

    try {
        const entData = JSON.parse(fs.readFileSync(path.join(folderPath, '02_entities.json'), 'utf-8'));
        entityCount = Object.keys(entData.definitions || {}).length;
    } catch {}
    try {
        const flowData = JSON.parse(fs.readFileSync(path.join(folderPath, '01_flow.json'), 'utf-8'));
        if (flowData.name) description = flowData.name;
    } catch {}

    // Detect multiplayer
    let multiplayer = dirName.endsWith('_mp');
    if (!multiplayer) {
        try {
            const sysData = JSON.parse(fs.readFileSync(path.join(folderPath, '04_systems.json'), 'utf-8'));
            if (sysData.systems?.network_sync) multiplayer = true;
        } catch {}
    }

    return { id: dirName, name, description, entityCount, multiplayer };
}

/** Load catalog of all available templates for LLM selection. */
export function loadTemplateCatalog(): TemplateSummary[] {
    const catalog: TemplateSummary[] = [];
    for (const { dir } of TEMPLATE_DIRS) {
        if (!fs.existsSync(dir)) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            try {
                const meta = readFolderMeta(path.join(dir, entry.name), entry.name);
                if (meta) catalog.push(meta);
            } catch (err) {
                console.warn(`[template_loader] Failed to parse ${entry.name}:`, err);
            }
        }
    }

    catalog.sort((a, b) => a.name.localeCompare(b.name));
    return catalog;
}

/** Load a single template by ID. Searches all version directories. */
export function loadTemplate(templateId: string): FullTemplate | null {
    let folderPath: string | null = null;
    for (const { dir } of TEMPLATE_DIRS) {
        const candidate = path.join(dir, templateId);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
            folderPath = candidate;
            break;
        }
    }
    if (!folderPath) return null;

    const meta = readFolderMeta(folderPath, templateId);
    if (!meta) return null;

    return {
        id: templateId,
        name: meta.name,
        description: meta.description,
        _folderPath: folderPath,
    };
}

/** Format the catalog as a concise string for the LLM prompt. */
export function formatCatalogForLLM(catalog: TemplateSummary[]): string {
    return catalog
        .map((t, i) => {
            const desc = t.description.length > 120 ? t.description.slice(0, 117) + '...' : t.description;
            const mpTag = t.multiplayer ? ' [MULTIPLAYER]' : '';
            return `${i + 1}. ${t.id}${mpTag} — ${desc} [${t.entityCount} entities]`;
        })
        .join('\n');
}
