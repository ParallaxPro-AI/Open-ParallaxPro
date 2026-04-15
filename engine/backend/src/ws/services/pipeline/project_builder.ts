/**
 * project_builder.ts — assemble a project's runtime view from its file tree.
 *
 * Hydrates the project's files to a per-project /tmp directory, then invokes
 * assembleGame() against it. Behaviors/systems/ui are resolved against the
 * project's pinned copies (not the shared library) so library updates can't
 * break old projects.
 *
 * Result: assembled scenes/scripts/uiFiles ready for the frontend, plus a
 * sourceMap that lets editor file_save calls map an assembled script key
 * back to the underlying template file (e.g. scripts/movement_jump.ts →
 * behaviors/movement/jump.ts).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ProjectFiles } from './project_files.js';
import { assembleGame, ConvertedScene, MultiplayerConfig } from './level_assembler.js';

export interface BuildResult {
    success: boolean;
    error?: string;
    /** Assembled scenes (one entry — `main.json`). */
    scenes: Record<string, any>;
    scripts: Record<string, string>;
    uiFiles: Record<string, string>;
    multiplayerConfig?: MultiplayerConfig;
    /** Default scene environment (the frontend expects this on each scene). */
    activeSceneKey: string;
    /** Mapping: assembled script/UI key → underlying template file path in the project tree. */
    sourceMap: Record<string, string>;
    warnings: string[];
}

const BUILD_ROOT = path.join(os.tmpdir(), 'parallaxpro-builds');

/** Build directory unique to a project — cached across builds within a session. */
function buildDirFor(projectId: string): string {
    return path.join(BUILD_ROOT, projectId);
}

/**
 * Hydrate the project's file tree to disk. Reuses the per-project build dir
 * but wipes it first so deleted files don't linger.
 */
function hydrate(files: ProjectFiles, dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
        if (rel === '__legacy__') continue;
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
}

/**
 * Build a project from its file tree. The frontend wire format is the same as
 * before (scenes/scripts/uiFiles), produced by assembleGame() under the hood.
 */
export function buildProject(
    projectId: string,
    files: ProjectFiles,
    opts?: { activeSceneKey?: string; environment?: any },
): BuildResult {
    const warnings: string[] = [];
    const dir = buildDirFor(projectId);

    try {
        hydrate(files, dir);
    } catch (e: any) {
        return errorResult(`Failed to hydrate project files: ${e.message}`, opts?.activeSceneKey);
    }

    let assembled: ConvertedScene;
    try {
        assembled = assembleGame(dir, {
            behaviors: path.join(dir, 'behaviors'),
            systems: path.join(dir, 'systems'),
            ui: path.join(dir, 'ui'),
        });
    } catch (e: any) {
        return errorResult(e.message || String(e), opts?.activeSceneKey);
    }

    const sceneKey = opts?.activeSceneKey || 'main.json';
    const sceneName = parseTemplateName(files['01_flow.json']) || 'Main';
    const scene: any = {
        name: sceneName,
        entities: assembled.entities,
        // Editor environment edits land in worlds[0].environment, so prefer that
        // over the caller's hint and fall back to a sane default.
        environment: { ...defaultEnvironment(), ...(opts?.environment || {}), ...(assembled.environment || {}) },
    };
    if (assembled.heightmapTerrain) scene.heightmapTerrain = assembled.heightmapTerrain;
    if (assembled.streamedBuildings) scene.streamedBuildings = assembled.streamedBuildings;

    return {
        success: true,
        scenes: { [sceneKey]: scene },
        scripts: assembled.scripts,
        uiFiles: assembled.uiFiles,
        multiplayerConfig: assembled.multiplayerConfig,
        activeSceneKey: sceneKey,
        sourceMap: buildSourceMap(files, assembled),
        warnings,
    };
}

/** Look up a project's build dir without rebuilding (used by fixer/creator). */
export function getBuildDir(projectId: string): string {
    return buildDirFor(projectId);
}

/** Wipe a project's build dir (e.g. on deletion). */
export function cleanupBuildDir(projectId: string): void {
    try { fs.rmSync(buildDirFor(projectId), { recursive: true, force: true }); } catch {}
}

function defaultEnvironment(): any {
    return {
        ambientColor: [1, 1, 1],
        ambientIntensity: 0.3,
        fog: { enabled: false, color: [0.8, 0.8, 0.8], near: 10, far: 100 },
        gravity: [0, -9.81, 0],
        timeOfDay: 12,
        dayNightCycleSpeed: 0,
    };
}

function parseTemplateName(flowJson: string | undefined): string | null {
    if (!flowJson) return null;
    try {
        const parsed = JSON.parse(flowJson);
        return typeof parsed?.name === 'string' ? parsed.name : null;
    } catch { return null; }
}

function errorResult(message: string, activeSceneKey?: string): BuildResult {
    return {
        success: false,
        error: message,
        scenes: {},
        scripts: {},
        uiFiles: {},
        activeSceneKey: activeSceneKey || 'main.json',
        sourceMap: {},
        warnings: [],
    };
}

/**
 * Map each assembled script/UI key back to the project file it came from.
 * Behaviors and systems are flattened by the assembler (`movement/jump.ts` →
 * `scripts/movement_jump.ts`); we invert by walking the project tree and
 * matching flat names. UI files map 1:1.
 */
function buildSourceMap(files: ProjectFiles, assembled: ConvertedScene): Record<string, string> {
    const map: Record<string, string> = {};

    // Behaviors / systems: build a lookup of flat-key → template path.
    const flatLookup = new Map<string, string>();
    for (const projPath of Object.keys(files)) {
        if (!projPath.endsWith('.ts')) continue;
        if (!projPath.startsWith('behaviors/') && !projPath.startsWith('systems/')) continue;
        // Strip top-level dir, flatten subpath, build assembled key.
        const sub = projPath.replace(/^(behaviors|systems)\//, '');
        const flat = sub.replace(/\//g, '_');
        const flatKey = `scripts/${flat}`;
        flatLookup.set(flatKey, projPath);
    }

    for (const assembledKey of Object.keys(assembled.scripts)) {
        // Skip purely generated artifacts — editing these would corrupt engine
        // machinery (the FSM driver is regenerated per-flow; the event validator
        // is built from event_definitions.ts at assembly time).
        if (assembledKey.startsWith('scripts/fsm_driver_')) continue;
        if (assembledKey === 'scripts/_event_validator.ts') continue;

        const direct = flatLookup.get(assembledKey);
        if (direct) { map[assembledKey] = direct; continue; }
        // Disambiguated keys append `_${entityName}` — try stripping that suffix.
        const base = assembledKey.replace(/_[^_]+\.ts$/, '.ts');
        const baseHit = flatLookup.get(base);
        if (baseHit) map[assembledKey] = baseHit;
    }

    // UI files map straight through — same key on both sides.
    for (const uiKey of Object.keys(assembled.uiFiles)) {
        if (files[uiKey]) map[uiKey] = uiKey;
    }

    return map;
}
