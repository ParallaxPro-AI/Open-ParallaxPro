/**
 * project_files.ts — types + helpers for the per-project file tree.
 *
 * A project on disk/in DB is a flat map of `path → content`. The four
 * template JSONs (01_flow / 02_entities / 03_worlds / 04_systems) sit at the
 * root; the project's pinned copies of behaviors/systems/ui sit in their
 * respective subdirectories. User-written custom code lives under `scripts/`.
 *
 * Build artifacts (assembled scenes, generated FSM driver, etc.) are NOT
 * stored here — they are produced by project_builder.assembleProject().
 */

import fs from 'fs';
import path from 'path';

/** A flat map of relative path → file contents. */
export type ProjectFiles = Record<string, string>;

/** What gets stored in the `projects.project_data` column. */
export interface ProjectData {
    projectConfig: {
        name: string;
        /**
         * Which CLI fixer agent runs when the AI decides to escalate a request
         * (via the LLM's FIX_GAME tool call). 'claude' | 'codex' | 'opencode' | 'copilot'. Optional —
         * missing means "use the first installed CLI" (claude preferred). The
         * picker in the editor surfaces only the installed CLIs.
         */
        editingAgent?: string;
        /**
         * Which provider handles chat-path LLM calls (the conversational back-
         * and-forth that decides whether to call EDIT / FIX_GAME / etc.).
         * 'llm_api' uses the direct AI_BASE_URL; otherwise the same CLI ids
         * as editingAgent drive a local CLI for chat. Missing/empty means
         * auto (direct API when configured, else first installed CLI).
         */
        chatAgent?: string;
        /**
         * Author-chosen render quality for this project. Applied when the
         * editor loads and as the default when a player opens play mode.
         * Players can still override per-session in the play-mode settings
         * panel (stored in localStorage).
         */
        graphicsQuality?: 'low' | 'medium' | 'high';
    };
    files: ProjectFiles;
}

export const TEMPLATE_FILES = [
    '01_flow.json',
    '02_entities.json',
    '03_worlds.json',
    '04_systems.json',
] as const;

/** Engine machinery files that every project ships with a frozen copy of. */
export const ENGINE_MACHINERY = [
    'systems/fsm_driver.ts',
    'systems/_entity_label.ts',
    'systems/event_definitions.ts',
    'systems/ui/ui_bridge.ts',
    'systems/mp/mp_bridge.ts',
] as const;

/**
 * Engine-owned reusable UI panels. Like ENGINE_MACHINERY these are refreshed
 * from the shared library on every build so fixes to the lobby / HUD UIs land
 * in existing projects. User custom UI (e.g. `ui/my_hud.html`) is untouched.
 */
export const ENGINE_UI = [
    'ui/lobby_browser.html',
    'ui/lobby_host_config.html',
    'ui/lobby_room.html',
    'ui/connecting_overlay.html',
    'ui/disconnected_banner.html',
    'ui/hud/ping.html',
    'ui/hud/text_chat.html',
    'ui/hud/voice_chat.html',
    'ui/hud/scoreboard.html',
] as const;

/** Empty 4-file template — the seed for a project created with no template. */
export function emptyTemplateFiles(): ProjectFiles {
    return {
        '01_flow.json': JSON.stringify({
            id: 'empty',
            name: 'Untitled Game',
            start: 'boot',
            ui_params: {},
            states: {
                boot: {
                    description: 'Initialize systems',
                    duration: -1,
                    on_enter: ['set:boot_frames=0'],
                    on_update: ['increment:boot_frames'],
                    transitions: [{ when: 'boot_frames>=2', goto: 'gameplay' }],
                },
                gameplay: {
                    description: 'Empty world',
                    on_enter: ['emit:game.game_ready'],
                    transitions: [],
                },
            },
        }, null, 2),
        '02_entities.json': JSON.stringify({
            definitions: {
                ground: {
                    mesh: { type: 'plane', color: [0.3, 0.35, 0.3, 1], scale: [40, 1, 40] },
                    tags: ['ground'],
                    label: false,
                },
                camera: {
                    camera: { fov: 60 },
                    tags: ['camera'],
                    label: false,
                },
            },
        }, null, 2),
        '03_worlds.json': JSON.stringify({
            worlds: [{
                id: 'main',
                name: 'Main',
                lighting: { sun_color: [1, 0.95, 0.9] },
                placements: [
                    { ref: 'ground', position: [0, 0, 0] },
                    { ref: 'camera', position: [0, 5, 8] },
                ],
            }],
        }, null, 2),
        '04_systems.json': JSON.stringify({ systems: {} }, null, 2),
    };
}

/** Default project data with a name and empty 4-file template. */
export function defaultProjectData(name: string): ProjectData {
    return {
        projectConfig: { name },
        files: emptyTemplateFiles(),
    };
}

/**
 * Parse the JSON stored in `projects.project_data`. Tolerates the legacy
 * `{scenes, scripts, uiFiles}` shape (returns it as `files` of one entry
 * for migration purposes) — callers should rebuild legacy projects if needed.
 */
export function parseProjectData(raw: string | null | undefined): ProjectData {
    if (!raw) return defaultProjectData('Untitled Project');
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { return defaultProjectData('Untitled Project'); }
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
        return {
            projectConfig: parsed.projectConfig || { name: 'Untitled Project' },
            files: parsed.files,
        };
    }
    // Legacy shape — wrap so callers can detect and migrate.
    return {
        projectConfig: parsed?.projectConfig || { name: 'Untitled Project' },
        files: { __legacy__: JSON.stringify(parsed) },
    };
}

/** True if a parsed project came from the legacy `{scenes, scripts, uiFiles}` shape. */
export function isLegacyProjectData(data: ProjectData): boolean {
    return data.files.__legacy__ !== undefined && Object.keys(data.files).length === 1;
}

/** Serialize a project for the DB. */
export function serializeProjectData(data: ProjectData): string {
    return JSON.stringify({
        projectConfig: data.projectConfig,
        files: data.files,
    });
}

/** Write all files in the tree to a directory on disk (for assembleGame to read). */
export function writeFilesToDir(files: ProjectFiles, dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
        if (rel === '__legacy__') continue;
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
}

/** Read a directory back into a file tree. */
export function readFilesFromDir(dir: string): ProjectFiles {
    const out: ProjectFiles = {};
    if (!fs.existsSync(dir)) return out;
    const walk = (sub: string, prefix: string) => {
        for (const entry of fs.readdirSync(sub, { withFileTypes: true })) {
            const full = path.join(sub, entry.name);
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(full, rel);
            else out[rel] = fs.readFileSync(full, 'utf-8');
        }
    };
    walk(dir, '');
    return out;
}

/** Set or replace a file in the tree. */
export function setFile(data: ProjectData, filePath: string, content: string): void {
    data.files[filePath] = content;
}

/** Remove a file from the tree if present. */
export function removeFile(data: ProjectData, filePath: string): void {
    delete data.files[filePath];
}

/** Get a file's content if present. */
export function getFile(data: ProjectData, filePath: string): string | undefined {
    return data.files[filePath];
}
