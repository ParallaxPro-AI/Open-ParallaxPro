/**
 * project_seeder.ts — build a project's initial file tree from a template.
 *
 * Walks the template's references in 02_entities.json, 04_systems.json, and
 * 01_flow.json (UI shows / transitions) to determine which shared behaviors,
 * systems, and UI panels must be copied into the project. Engine machinery
 * files (fsm_driver, _entity_label, event_definitions, ui_bridge) are
 * always copied so the project owns its frozen snapshot.
 *
 * Does NOT pin every file in the shared library — only what the template
 * actually references. This keeps projects small.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProjectFiles, ENGINE_MACHINERY, ENGINE_MACHINERY_USER_EXTENSIBLE, ENGINE_UI, emptyTemplateFiles } from './project_files.js';
import { loadTemplate } from './template_loader.js';

const __dirname_seeder = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname_seeder, 'reusable_game_components');
const BEHAVIORS_DIR = path.join(RGC_DIR, 'behaviors', 'v0.1');
const SYSTEMS_DIR = path.join(RGC_DIR, 'systems', 'v0.1');
const UI_DIR = path.join(RGC_DIR, 'ui', 'v0.1');

export interface SeedResult {
    files: ProjectFiles;
    templateId: string | null;
    warnings: string[];
}

/** Seed an empty project — just the default 4-file template plus engine machinery. */
export function seedEmpty(): SeedResult {
    const files: ProjectFiles = { ...emptyTemplateFiles() };
    copyEngineMachinery(files);
    return { files, templateId: null, warnings: [] };
}

/** Seed a project from a named template. */
export function seedFromTemplate(templateId: string): SeedResult {
    const template = loadTemplate(templateId);
    const warnings: string[] = [];
    if (!template?._folderPath) {
        warnings.push(`Template "${templateId}" not found — seeding empty project.`);
        return { ...seedEmpty(), templateId: null, warnings };
    }

    const files: ProjectFiles = {};

    // 1) Copy all files from the template folder verbatim — includes the 4 JSONs
    // plus any optional sidecar files (heightmapTerrain configs, etc.).
    copyDirInto(template._folderPath, files, '');

    // 2) Walk references and pin used behaviors/systems/UI.
    pinReferencedBehaviors(files, warnings);
    pinReferencedSystems(files, warnings);
    pinReferencedUI(files, warnings);

    // 3) Always include engine machinery.
    copyEngineMachinery(files);

    return { files, templateId, warnings };
}

/** Copy all files from a directory tree into the project file map under a prefix. */
function copyDirInto(srcDir: string, files: ProjectFiles, prefix: string): void {
    if (!fs.existsSync(srcDir)) return;
    const walk = (sub: string, rel: string) => {
        for (const entry of fs.readdirSync(sub, { withFileTypes: true })) {
            const full = path.join(sub, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(full, relPath);
            else files[prefix ? `${prefix}/${relPath}` : relPath] = fs.readFileSync(full, 'utf-8');
        }
    };
    walk(srcDir, '');
}

/**
 * Always-pinned engine files — copied fresh from the shared library.
 *
 * We overwrite any existing copy so engine-owned pieces (fsm_driver,
 * ui_bridge, mp_bridge, _entity_label) track library updates. Files in
 * ENGINE_MACHINERY_USER_EXTENSIBLE (currently just event_definitions.ts)
 * are treated as seed-only: we copy them in on first seed, then leave
 * them alone on subsequent refreshes so the CREATE_GAME agent's
 * game-specific event additions survive.
 */
function copyEngineMachinery(files: ProjectFiles): void {
    for (const rel of ENGINE_MACHINERY) {
        if (ENGINE_MACHINERY_USER_EXTENSIBLE.has(rel) && files[rel] !== undefined) {
            continue;
        }
        const sub = rel.replace(/^systems\//, '');
        const src = path.join(SYSTEMS_DIR, sub);
        if (fs.existsSync(src)) files[rel] = fs.readFileSync(src, 'utf-8');
    }
}

/**
 * Public entry point used by the builder to refresh engine machinery on
 * every build. Existing projects pinned at an older engine version pick
 * up fsm_driver / mp_bridge / ui_bridge patches without needing a reseed.
 */
export function refreshEngineMachinery(files: ProjectFiles): void {
    copyEngineMachinery(files);
    // Reusable lobby + HUD UIs are engine-owned too; refresh each build.
    for (const rel of ENGINE_UI) {
        const sub = rel.replace(/^ui\//, '');
        const src = path.join(UI_DIR, sub);
        if (fs.existsSync(src)) files[rel] = fs.readFileSync(src, 'utf-8');
    }
}

/** Walk 02_entities.json behavior refs and pin each script into behaviors/. */
function pinReferencedBehaviors(files: ProjectFiles, warnings: string[]): void {
    const entities = parseJSON(files['02_entities.json']);
    if (!entities?.definitions) return;
    const visit = (def: any) => {
        if (!def) return;
        for (const beh of def.behaviors || []) {
            if (typeof beh?.script === 'string') pinBehavior(beh.script, files, warnings);
        }
        for (const child of def.children || []) visit(child);
    };
    for (const def of Object.values(entities.definitions)) visit(def);
}

/** Walk 04_systems.json system refs and pin each script into systems/. */
function pinReferencedSystems(files: ProjectFiles, warnings: string[]): void {
    const sys = parseJSON(files['04_systems.json']);
    if (!sys?.systems) return;
    for (const s of Object.values(sys.systems) as any[]) {
        if (typeof s?.script === 'string') pinSystem(s.script, files, warnings);
    }
}

/** Walk 01_flow.json show_ui actions + ui_event transitions and pin each panel. */
function pinReferencedUI(files: ProjectFiles, warnings: string[]): void {
    const flow = parseJSON(files['01_flow.json']);
    if (!flow?.states) return;
    const panels = new Set<string>();
    const visit = (states: Record<string, any>) => {
        for (const state of Object.values(states) as any[]) {
            for (const list of [state.on_enter, state.on_exit, state.on_update, state.on_timeout]) {
                if (!Array.isArray(list)) continue;
                for (const action of list) {
                    if (typeof action !== 'string') continue;
                    if (action.startsWith('show_ui:')) panels.add(action.slice('show_ui:'.length));
                    else if (action.startsWith('hide_ui:')) panels.add(action.slice('hide_ui:'.length));
                }
            }
            for (const t of state.transitions || []) {
                const when = t?.when || '';
                if (when.startsWith('ui_event:')) {
                    const parts = when.slice('ui_event:'.length).split(':');
                    if (parts[0]) panels.add(parts[0]);
                }
            }
            if (state.substates) visit(state.substates);
        }
    };
    visit(flow.states);
    for (const panel of panels) pinUI(panel, files, warnings);
}

function pinBehavior(scriptPath: string, files: ProjectFiles, warnings: string[]): void {
    const rel = scriptPath.replace(/^\/+/, '');
    const projKey = `behaviors/${rel}`;
    if (files[projKey]) return;
    const src = path.join(BEHAVIORS_DIR, rel);
    if (fs.existsSync(src)) {
        files[projKey] = fs.readFileSync(src, 'utf-8');
    } else {
        warnings.push(`Behavior not found in shared library: ${scriptPath}`);
    }
}

function pinSystem(scriptPath: string, files: ProjectFiles, warnings: string[]): void {
    const rel = scriptPath.replace(/^\/+/, '');
    const projKey = `systems/${rel}`;
    if (files[projKey]) return;
    const src = path.join(SYSTEMS_DIR, rel);
    if (fs.existsSync(src)) {
        files[projKey] = fs.readFileSync(src, 'utf-8');
    } else {
        warnings.push(`System not found in shared library: ${scriptPath}`);
    }
}

function pinUI(panelName: string, files: ProjectFiles, warnings: string[]): void {
    const rel = `${panelName.replace(/^\/+/, '')}.html`;
    const projKey = `ui/${rel}`;
    if (files[projKey]) return;
    const src = path.join(UI_DIR, rel);
    if (fs.existsSync(src)) {
        files[projKey] = fs.readFileSync(src, 'utf-8');
    } else {
        warnings.push(`UI panel not found in shared library: ${panelName}`);
    }
}

function parseJSON(content: string | undefined): any | null {
    if (!content) return null;
    try { return JSON.parse(content); } catch { return null; }
}
