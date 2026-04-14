/**
 * template_mutator.ts — translate scene-script verbs into edits to the 4
 * template JSON files.
 *
 * The editor's EDIT block contains JS code that calls `scene.addEntity()`,
 * `scene.setPosition()`, etc. The legacy executor mutated an in-memory
 * assembled scene; this mutator re-implements the same API surface but
 * mutates `02_entities.json` and `03_worlds.json` (and `worlds[0].environment`
 * for scene-level edits). After the script runs, the updated JSON strings
 * are pulled out via `getUpdatedFiles()` and committed to the project.
 *
 * Behaviour notes:
 * - Editor-created entities go into `02_entities.json.definitions` under a
 *   generated name (`_${safeName}`) and into `worlds[0].placements` with
 *   `name` matching what the editor uses.
 * - Component edits land on the placement's `extra_components` (passthrough),
 *   except for the few derived ones (Mesh/Collider/Rigidbody/Camera/Script)
 *   which the assembler builds from `mesh`/`physics`/etc. Editing those is a
 *   no-op with a warning — use FIX_GAME for changes to the auto-derived ones.
 * - Verbs that can't be cleanly mapped (multi-scene management, parent
 *   reparenting across placements) record a warning and skip.
 */

import vm from 'node:vm';
import fs from 'fs';
import path from 'path';
import { config } from '../../../config.js';
import { ProjectFiles } from './project_files.js';
import { buildProject } from './project_builder.js';

const TIMEOUT_MS = 2000;
const MAX_ENTITIES = 10000;
const PRIMITIVES = new Set(['cube', 'sphere', 'cylinder', 'cone', 'capsule', 'plane']);

export interface MutatorResult {
    success: boolean;
    error?: string;
    /** Updated template JSON file contents (only files actually touched). */
    updatedFiles: Record<string, string>;
    /** Warnings for verbs that couldn't be cleanly translated. */
    warnings: string[];
    /** Names of mutations performed (for fileChanges reporting). */
    changes: { action: string; entity: string; detail?: string }[];
}

/**
 * Run an EDIT-block scene script against the project's template files. Returns
 * the updated JSON strings to commit, or an error if the script threw.
 */
export function runEditScript(
    projectId: string,
    files: ProjectFiles,
): { execute: (code: string) => MutatorResult } {
    // Build once for read-only queries (findEntity, getEntities). The build
    // result is the source of truth for "what entities exist right now".
    const built = buildProject(projectId, files);

    const flow = parseJSON(files['01_flow.json'])      || {};
    const entitiesDef = parseJSON(files['02_entities.json']) || { definitions: {} };
    const worlds = parseJSON(files['03_worlds.json']) || { worlds: [] };
    const systems = parseJSON(files['04_systems.json']) || { systems: {} };

    if (!entitiesDef.definitions) entitiesDef.definitions = {};
    if (!worlds.worlds || worlds.worlds.length === 0) {
        worlds.worlds = [{ id: 'main', name: 'Main', placements: [] }];
    }
    if (!worlds.worlds[0].placements) worlds.worlds[0].placements = [];

    const world = worlds.worlds[0];
    const warnings: string[] = [];
    const changes: { action: string; entity: string; detail?: string }[] = [];
    const dirty: Set<string> = new Set();

    const markDirty = (file: string) => dirty.add(file);

    // ─── Helpers ─────────────────────────────────────────────────────────
    const findPlacementByName = (name: string) => {
        for (const p of world.placements) {
            const placedName = p.name || derivedNameForRef(world.placements, p);
            if (placedName === name) return p;
        }
        return null;
    };

    const findAssembledEntity = (name: string) => {
        const sceneKey = built.activeSceneKey;
        const ents = built.scenes[sceneKey]?.entities || [];
        return ents.find((e: any) => e.name === name) || null;
    };

    const ensureMaterialOverrides = (placement: any) => {
        if (!placement.material_overrides) placement.material_overrides = {};
        return placement.material_overrides;
    };

    const ensureExtraComponents = (placement: any): any[] => {
        if (!placement.extra_components) placement.extra_components = [];
        return placement.extra_components;
    };

    const ensureExtraTags = (placement: any): string[] => {
        if (!placement.tags) placement.tags = [];
        return placement.tags;
    };

    const ensureEnv = () => {
        if (!world.environment) world.environment = {};
        return world.environment;
    };

    const newDefName = (entityName: string): string => {
        const safe = '_' + entityName.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');
        if (!entitiesDef.definitions[safe]) return safe;
        let i = 2;
        while (entitiesDef.definitions[`${safe}_${i}`]) i++;
        return `${safe}_${i}`;
    };

    const toVec = (v: any, def: any) => {
        if (v === undefined || v === null) return def;
        if (Array.isArray(v)) return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
        if (typeof v === 'object') return [v.x ?? 0, v.y ?? 0, v.z ?? 0];
        throw new Error(`Expected {x,y,z} or [x,y,z], got ${typeof v}`);
    };

    // ─── Scene API ───────────────────────────────────────────────────────
    const sceneAPI = {
        addEntity(name: string, type: string, options?: any) {
            options = options || {};
            if (world.placements.length >= MAX_ENTITIES) {
                throw new Error(`Entity limit reached (${MAX_ENTITIES}).`);
            }
            const pos = toVec(options.position, [0, 0, 0]);
            const scale = options.scale !== undefined ? toVec(options.scale, [1, 1, 1]) : undefined;
            const rotation = options.rotation !== undefined ? toVec(options.rotation, [0, 0, 0]) : undefined;

            const def: any = {};
            if (PRIMITIVES.has(type)) {
                def.mesh = { type };
                if (scale) def.mesh.scale = scale;
                if (options.materialOverrides?.baseColor) def.mesh.color = options.materialOverrides.baseColor;
            } else if (type === 'custom' && options.meshAsset) {
                const assetPath = options.meshAsset.replace(/^\/assets\//, '');
                if (!fs.existsSync(path.join(config.assetsDir, assetPath))) {
                    throw new Error(`addEntity("${name}"): meshAsset "${options.meshAsset}" not found.`);
                }
                def.mesh = { type: 'custom', asset: options.meshAsset };
                if (scale) def.mesh.scale = scale;
            } else if (type === 'camera') {
                def.camera = { fov: options.cameraData?.fov ?? 60 };
                def.tags = ['camera'];
                def.label = false;
            } else if (type === 'directional_light' || type === 'point_light') {
                warnings.push(`addEntity("${name}", "${type}"): light entities are managed by the assembler — use 03_worlds.json lighting instead.`);
                return;
            } else if (type === 'empty') {
                // No mesh, no camera — placeholder.
            } else {
                warnings.push(`addEntity("${name}", "${type}"): unsupported type — skipping.`);
                return;
            }

            const tagsFromOpts: string[] = Array.isArray(options.tags)
                ? options.tags
                : (options.tags ? [options.tags] : []);
            if (tagsFromOpts.length > 0) {
                def.tags = [...new Set([...(def.tags || []), ...tagsFromOpts])];
            }

            const defName = newDefName(name);
            entitiesDef.definitions[defName] = def;

            const placement: any = { ref: defName, name, position: pos };
            if (rotation) placement.rotation = rotation;
            if (scale && type !== 'custom') placement.scale = scale; // primitives can override per-instance
            if (options.materialOverrides && type !== 'custom') {
                placement.material_overrides = options.materialOverrides;
            }
            if (Array.isArray(options.components) && options.components.length > 0) {
                placement.extra_components = options.components.filter((c: any) => c?.type && c.type !== 'TransformComponent');
            }
            world.placements.push(placement);

            markDirty('02_entities.json');
            markDirty('03_worlds.json');
            changes.push({ action: 'add_entity', entity: name, detail: type });
        },

        deleteEntity(name: string) {
            const idx = world.placements.findIndex((p: any) => (p.name || derivedNameForRef(world.placements, p)) === name);
            if (idx < 0) return;
            const removed = world.placements.splice(idx, 1)[0];
            markDirty('03_worlds.json');
            // GC entity def if no other placements reference it AND it was an editor-generated def.
            if (removed?.ref && removed.ref.startsWith('_')) {
                const stillUsed = world.placements.some((p: any) => p.ref === removed.ref);
                if (!stillUsed && entitiesDef.definitions[removed.ref]) {
                    delete entitiesDef.definitions[removed.ref];
                    markDirty('02_entities.json');
                }
            }
            changes.push({ action: 'delete_entity', entity: name });
        },

        setPosition(name: string, x: number, y: number, z: number) {
            assertNumbers('setPosition', name, [x, y, z]);
            const p = findPlacementByName(name);
            if (!p) { warnings.push(`setPosition: no placement named "${name}"`); return; }
            p.position = [x, y, z];
            markDirty('03_worlds.json');
            changes.push({ action: 'set_position', entity: name });
        },

        translate(name: string, dx: number, dy: number, dz: number) {
            assertNumbers('translate', name, [dx, dy, dz]);
            const p = findPlacementByName(name);
            if (!p) { warnings.push(`translate: no placement named "${name}"`); return; }
            const pos = p.position || [0, 0, 0];
            p.position = [pos[0] + dx, pos[1] + dy, pos[2] + dz];
            markDirty('03_worlds.json');
            changes.push({ action: 'translate', entity: name });
        },

        setScale(name: string, x: number, y: number, z: number) {
            assertNumbers('setScale', name, [x, y, z]);
            const p = findPlacementByName(name);
            if (!p) { warnings.push(`setScale: no placement named "${name}"`); return; }
            p.scale = [x, y, z];
            markDirty('03_worlds.json');
            changes.push({ action: 'set_scale', entity: name });
        },

        scaleBy(name: string, sx: number, sy: number, sz: number) {
            assertNumbers('scaleBy', name, [sx, sy, sz]);
            const p = findPlacementByName(name);
            if (!p) { warnings.push(`scaleBy: no placement named "${name}"`); return; }
            const def = entitiesDef.definitions[p.ref];
            const baseScale = p.scale || def?.mesh?.scale || [1, 1, 1];
            p.scale = [baseScale[0] * sx, baseScale[1] * sy, baseScale[2] * sz];
            markDirty('03_worlds.json');
            changes.push({ action: 'scale_by', entity: name });
        },

        setRotation(name: string, rx: number, ry: number, rz: number) {
            const p = findPlacementByName(name);
            if (!p) { warnings.push(`setRotation: no placement named "${name}"`); return; }
            p.rotation = [rx, ry, rz];
            markDirty('03_worlds.json');
            changes.push({ action: 'set_rotation', entity: name });
        },

        rotate(name: string, dx: number, dy: number, dz: number) {
            const p = findPlacementByName(name);
            if (!p) { warnings.push(`rotate: no placement named "${name}"`); return; }
            const r = p.rotation || [0, 0, 0];
            p.rotation = [r[0] + dx, r[1] + dy, r[2] + dz];
            markDirty('03_worlds.json');
            changes.push({ action: 'rotate', entity: name });
        },

        addComponent(name: string, componentType: string, data?: any) {
            const p = findPlacementByName(name);
            if (!p) { warnings.push(`addComponent: no placement named "${name}"`); return; }
            const compData = data || {};
            // Validate ColliderComponent.shapeType.
            if (componentType === 'ColliderComponent' && compData.shapeType) {
                const SHAPE_ALIASES: Record<string, string> = { circle: 'sphere', cube: 'box' };
                const VALID_SHAPES = new Set(['box', 'sphere', 'capsule', 'mesh', 'terrain']);
                if (SHAPE_ALIASES[compData.shapeType]) compData.shapeType = SHAPE_ALIASES[compData.shapeType];
                if (!VALID_SHAPES.has(compData.shapeType)) {
                    throw new Error(`addComponent("${name}"): invalid shapeType "${compData.shapeType}".`);
                }
            }
            const list = ensureExtraComponents(p);
            const existing = list.find((c: any) => c.type === componentType);
            if (existing) {
                existing.data = { ...(existing.data || {}), ...compData };
            } else {
                list.push({ type: componentType, data: compData });
            }
            markDirty('03_worlds.json');
            changes.push({ action: 'add_component', entity: name, detail: componentType });
        },

        removeComponent(name: string, componentType: string) {
            const p = findPlacementByName(name);
            if (!p) { warnings.push(`removeComponent: no placement named "${name}"`); return; }
            if (Array.isArray(p.extra_components)) {
                p.extra_components = p.extra_components.filter((c: any) => c.type !== componentType);
                if (p.extra_components.length === 0) delete p.extra_components;
            }
            // Note: derived components (auto-built from def.mesh/physics/etc.) cannot be
            // removed via placement override. The agent should edit the def or use FIX_GAME.
            markDirty('03_worlds.json');
            changes.push({ action: 'remove_component', entity: name, detail: componentType });
        },

        setMaterial(name: string, materialOverrides: any) {
            const p = findPlacementByName(name);
            if (!p) { warnings.push(`setMaterial: no placement named "${name}"`); return; }
            p.material_overrides = { ...(p.material_overrides || {}), ...(materialOverrides || {}) };
            markDirty('03_worlds.json');
            changes.push({ action: 'set_material', entity: name });
        },

        findEntity(name: string): any {
            const e = findAssembledEntity(name);
            if (!e) return null;
            const clone = JSON.parse(JSON.stringify(e));
            const tc = (clone.components || []).find((c: any) => c.type === 'TransformComponent');
            if (tc?.data) {
                clone.position = tc.data.position;
                clone.scale = tc.data.scale;
                clone.rotation = tc.data.rotation;
            }
            const mr = (clone.components || []).find((c: any) => c.type === 'MeshRendererComponent');
            if (mr?.data) {
                clone.meshType = mr.data.meshType;
                clone.materialOverrides = mr.data.materialOverrides;
            }
            return clone;
        },

        getEntities(): string[] {
            const sceneKey = built.activeSceneKey;
            return (built.scenes[sceneKey]?.entities || []).map((e: any) => e.name);
        },

        getEntityCount(): number {
            const sceneKey = built.activeSceneKey;
            return (built.scenes[sceneKey]?.entities || []).length;
        },

        addTag(name: string, tag: string) {
            const p = findPlacementByName(name);
            if (!p) { warnings.push(`addTag: no placement named "${name}"`); return; }
            const tags = ensureExtraTags(p);
            if (!tags.includes(tag)) tags.push(tag);
            markDirty('03_worlds.json');
            changes.push({ action: 'add_tag', entity: name, detail: tag });
        },

        removeTag(name: string, tag: string) {
            const p = findPlacementByName(name);
            if (!p?.tags) return;
            p.tags = p.tags.filter((t: string) => t !== tag);
            if (p.tags.length === 0) delete p.tags;
            markDirty('03_worlds.json');
            changes.push({ action: 'remove_tag', entity: name, detail: tag });
        },

        setGravity(x: number, y: number, z: number) {
            ensureEnv().gravity = [x, y, z];
            markDirty('03_worlds.json');
            changes.push({ action: 'set_gravity', entity: 'scene', detail: `(${x}, ${y}, ${z})` });
        },

        setAmbientLight(color: [number, number, number], intensity: number) {
            const env = ensureEnv();
            env.ambientColor = color;
            env.ambientIntensity = intensity;
            markDirty('03_worlds.json');
            changes.push({ action: 'set_ambient_light', entity: 'scene' });
        },

        setFog(enabled: boolean, color?: [number, number, number], near?: number, far?: number) {
            const env = ensureEnv();
            if (!env.fog) env.fog = { enabled: false, color: [0.8, 0.8, 0.8], near: 10, far: 100 };
            env.fog.enabled = enabled;
            if (color) env.fog.color = color;
            if (near !== undefined) env.fog.near = near;
            if (far !== undefined) env.fog.far = far;
            markDirty('03_worlds.json');
            changes.push({ action: 'set_fog', entity: 'scene' });
        },

        setTimeOfDay(hour: number) {
            ensureEnv().timeOfDay = Math.max(0, Math.min(24, hour));
            markDirty('03_worlds.json');
            changes.push({ action: 'set_time_of_day', entity: 'scene', detail: String(hour) });
        },

        setEnvironment(props: Record<string, any>) {
            const env = ensureEnv();
            for (const [dotted, value] of Object.entries(props)) {
                const parts = dotted.split('.');
                let target: any = env;
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!target[parts[i]]) target[parts[i]] = {};
                    target = target[parts[i]];
                }
                target[parts[parts.length - 1]] = value;
            }
            markDirty('03_worlds.json');
            changes.push({ action: 'set_environment', entity: 'scene' });
        },

        renameEntity(oldName: string, newName: string) {
            const p = findPlacementByName(oldName);
            if (!p) { warnings.push(`renameEntity: no placement named "${oldName}"`); return; }
            p.name = newName;
            markDirty('03_worlds.json');
            changes.push({ action: 'rename_entity', entity: oldName, detail: newName });
        },

        duplicateEntity(name: string, newName?: string) {
            const p = findPlacementByName(name);
            if (!p) { warnings.push(`duplicateEntity: no placement named "${name}"`); return; }
            if (world.placements.length >= MAX_ENTITIES) {
                throw new Error(`Entity limit reached (${MAX_ENTITIES}).`);
            }
            const clone = JSON.parse(JSON.stringify(p));
            clone.name = newName || `${name} (copy)`;
            world.placements.push(clone);
            markDirty('03_worlds.json');
            changes.push({ action: 'duplicate_entity', entity: name, detail: clone.name });
        },

        setActive(name: string, active: boolean) {
            const p = findPlacementByName(name);
            if (!p) { warnings.push(`setActive: no placement named "${name}"`); return; }
            if (active) delete p.active;
            else p.active = false;
            markDirty('03_worlds.json');
            changes.push({ action: 'set_active', entity: name, detail: String(active) });
        },

        setParent(_childName: string, _parentName: string | null) {
            warnings.push(`setParent: parenting placements is not yet supported in template format. Use FIX_GAME for hierarchy changes.`);
        },

        // Multi-scene management — current model has one world per project.
        switchScene(_sceneKey: string) {
            warnings.push('switchScene: multi-world projects are not yet supported. Edits target worlds[0].');
        },
        createScene(_sceneKey: string, _name?: string) {
            warnings.push('createScene: multi-world projects are not yet supported.');
        },
        deleteScene(_sceneKey: string) {
            warnings.push('deleteScene: multi-world projects are not yet supported.');
        },
        listScenes(): string[] { return [built.activeSceneKey]; },
        getActiveScene(): string { return built.activeSceneKey; },
    };

    return {
        execute(code: string): MutatorResult {
            const sandbox = {
                scene: sceneAPI,
                console: { log: () => {}, warn: () => {}, error: () => {} },
                Math, parseInt, parseFloat, isNaN, isFinite,
                Number, String, Boolean, Array, Object,
                JSON: { parse: JSON.parse, stringify: JSON.stringify },
                Map, Set,
            };
            try {
                const script = new vm.Script(code, { filename: 'edit_block.js' });
                const context = vm.createContext(sandbox);
                script.runInContext(context, { timeout: TIMEOUT_MS });
            } catch (err: any) {
                const msg = err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
                    ? `Script execution timed out after ${TIMEOUT_MS / 1000}s (possible infinite loop)`
                    : err.message;
                return { success: false, error: msg, updatedFiles: {}, warnings, changes };
            }

            const updatedFiles: Record<string, string> = {};
            for (const f of dirty) {
                if (f === '01_flow.json') updatedFiles[f] = JSON.stringify(flow, null, 2);
                else if (f === '02_entities.json') updatedFiles[f] = JSON.stringify(entitiesDef, null, 2);
                else if (f === '03_worlds.json') updatedFiles[f] = JSON.stringify(worlds, null, 2);
                else if (f === '04_systems.json') updatedFiles[f] = JSON.stringify(systems, null, 2);
            }
            return { success: true, updatedFiles, warnings, changes };
        },
    };
}

function parseJSON(s: string | undefined): any | null {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
}

function assertNumbers(verb: string, name: string, vals: number[]): void {
    for (const v of vals) {
        if (typeof v !== 'number' || isNaN(v)) {
            throw new Error(`${verb}("${name}"): arguments must be numbers.`);
        }
    }
}

/**
 * Replicates level_assembler's nameFromRef behaviour (`player` → `Player`,
 * second `player` → `Player 2`) so we can find placements by their assembled
 * names when the editor calls into a placement that has no explicit `name`.
 */
function derivedNameForRef(allPlacements: any[], placement: any): string {
    if (placement.name) return placement.name;
    const ref = placement.ref;
    if (!ref) return '';
    const base = ref.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    let count = 0;
    for (const p of allPlacements) {
        if (p === placement) { count++; break; }
        if (p.ref === ref && !p.name) count++;
    }
    return count <= 1 ? base : `${base} ${count}`;
}
