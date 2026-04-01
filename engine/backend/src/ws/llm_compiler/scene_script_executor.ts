/**
 * Scene Script Executor — runs JavaScript code in a sandboxed vm context
 * with a scene API for programmatic scene editing.
 *
 * Timeout: 2 seconds. Max entities: 10000.
 */

import vm from 'node:vm';
import fs from 'fs';
import path from 'path';
import { config } from '../../config.js';

const MAX_ENTITIES = 10000;
const TIMEOUT_MS = 2000;

export interface SceneScriptResult {
  success: boolean;
  scenes: Record<string, any>;
  modifiedScenes: string[];
  changes: { action: string; entity: string; detail?: string }[];
  error?: string;
}

export function executeSceneScript(code: string, allScenes: Record<string, any>, activeSceneKey: string): SceneScriptResult {
  const changes: { action: string; entity: string; detail?: string }[] = [];

  // Deep clone all scenes
  const scenes: Record<string, any> = JSON.parse(JSON.stringify(allScenes));
  const modifiedScenes = new Set<string>();

  // Current scene pointer — starts at the active scene
  let currentKey = activeSceneKey;
  const getCurrentScene = () => {
    if (!scenes[currentKey]) {
      scenes[currentKey] = { name: currentKey.replace('.json', ''), entities: [], environment: {} };
    }
    const s = scenes[currentKey];
    if (!Array.isArray(s.entities)) s.entities = [];
    return s;
  };
  const markModified = () => modifiedScenes.add(currentKey);

  // Helper to find entity in current scene
  const findEntity = (name: string) => getCurrentScene().entities.find((e: any) => e.name === name);

  const getOrCreateTransform = (entity: any) => {
    if (!entity.components) entity.components = [];
    let tc = entity.components.find((c: any) => c.type === 'TransformComponent');
    if (!tc) {
      tc = { type: 'TransformComponent', data: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } };
      entity.components.push(tc);
    }
    if (!tc.data) tc.data = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } };
    return tc;
  };

  let sd = getCurrentScene();
  markModified();

  const primitives = new Set(['cube', 'sphere', 'cylinder', 'cone', 'capsule', 'plane']);

  const sceneAPI = {
    addEntity(name: string, type: string, options?: any) {
      if (sd.entities.length >= MAX_ENTITIES) {
        throw new Error(`Entity limit reached (${MAX_ENTITIES}). Cannot add more entities.`);
      }
      options = options || {};
      // Accept arrays [x,y,z] or objects {x,y,z} for position/scale
      const toVec3 = (v: any, def: any) => {
        if (!v) return def;
        if (Array.isArray(v)) return { x: v[0] ?? 0, y: v[1] ?? 0, z: v[2] ?? 0 };
        if (typeof v === 'object') return { x: v.x ?? 0, y: v.y ?? 0, z: v.z ?? 0 };
        throw new Error(`Expected {x,y,z} or [x,y,z], got ${typeof v}`);
      };
      const pos = toVec3(options.position, { x: 0, y: 0, z: 0 });
      const scale = toVec3(options.scale, { x: 1, y: 1, z: 1 });
      const rot = options.rotation ? toVec3(options.rotation, { x: 0, y: 0, z: 0 }) : { x: 0, y: 0, z: 0, w: 1 };
      if (rot.w === undefined) rot.w = 1; // euler-style {x,y,z} → add w=1

      const comps: any[] = [
        { type: 'TransformComponent', data: { position: pos, rotation: rot, scale } },
      ];

      if (primitives.has(type)) {
        const meshData: any = { meshType: type };
        if (options.materialOverrides) meshData.materialOverrides = options.materialOverrides;
        comps.push({ type: 'MeshRendererComponent', data: meshData });
      } else if (type === 'custom' && options.meshAsset) {
        // Validate asset path exists
        const assetPath = options.meshAsset.replace(/^\/assets\//, '');
        const fullPath = path.join(config.assetsDir, assetPath);
        if (!fs.existsSync(fullPath)) {
          throw new Error(`addEntity("${name}"): meshAsset "${options.meshAsset}" not found. Use LIST_ASSETS to find valid asset paths.`);
        }
        const meshData: any = { meshType: 'custom', meshAsset: options.meshAsset };
        if (options.materialOverrides) meshData.materialOverrides = options.materialOverrides;
        comps.push({ type: 'MeshRendererComponent', data: meshData });
      } else if (type === 'camera') {
        comps.push({ type: 'CameraComponent', data: options.cameraData || {} });
      } else if (type === 'directional_light' || type === 'point_light') {
        comps.push({ type: 'LightComponent', data: { lightType: type === 'directional_light' ? 0 : 1, ...options.lightData } });
      }

      if (Array.isArray(options.components)) {
        for (const c of options.components) {
          if (c.type !== 'TransformComponent') {
            comps.push({ type: c.type, data: c.data || {} });
          }
        }
      }

      const entity: any = { name, components: comps };
      if (options.tags) entity.tags = Array.isArray(options.tags) ? options.tags : [options.tags];
      if (options.parent) entity.parent = options.parent;

      sd.entities.push(entity);
      changes.push({ action: 'add_entity', entity: name, detail: type });
    },

    deleteEntity(name: string) {
      const idx = sd.entities.findIndex((e: any) => e.name === name);
      if (idx >= 0) {
        sd.entities.splice(idx, 1);
        changes.push({ action: 'delete_entity', entity: name });
      }
    },

    setPosition(name: string, x: number, y: number, z: number) {
      if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' || isNaN(x) || isNaN(y) || isNaN(z)) {
        throw new Error(`setPosition("${name}"): arguments must be numbers. Use setPosition("name", x, y, z)`);
      }
      const entity = findEntity(name);
      if (!entity) return;
      getOrCreateTransform(entity).data.position = { x, y, z };
      changes.push({ action: 'set_position', entity: name });
    },

    setScale(name: string, x: number, y: number, z: number) {
      if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' || isNaN(x) || isNaN(y) || isNaN(z)) {
        throw new Error(`setScale("${name}"): arguments must be numbers. Use setScale("name", x, y, z)`);
      }
      const entity = findEntity(name);
      if (!entity) return;
      getOrCreateTransform(entity).data.scale = { x, y, z };
      changes.push({ action: 'set_scale', entity: name });
    },

    setRotation(name: string, rx: number, ry: number, rz: number) {
      const entity = findEntity(name);
      if (!entity) return;
      const tc = getOrCreateTransform(entity);
      const toRad = Math.PI / 180;
      const cx = Math.cos(rx * toRad / 2), sx = Math.sin(rx * toRad / 2);
      const cy = Math.cos(ry * toRad / 2), sy = Math.sin(ry * toRad / 2);
      const cz = Math.cos(rz * toRad / 2), sz = Math.sin(rz * toRad / 2);
      tc.data.rotation = {
        x: sx * cy * cz - cx * sy * sz,
        y: cx * sy * cz + sx * cy * sz,
        z: cx * cy * sz - sx * sy * cz,
        w: cx * cy * cz + sx * sy * sz,
      };
      changes.push({ action: 'set_rotation', entity: name });
    },

    addComponent(name: string, componentType: string, data?: any) {
      const entity = findEntity(name);
      if (!entity) return;
      if (!entity.components) entity.components = [];
      const compData = data || {};
      // Validate shapeType for ColliderComponent — fail loud on invalid
      if (componentType === 'ColliderComponent' && compData.shapeType) {
        const SHAPE_ALIASES: Record<string, string> = { 'circle': 'sphere', 'cube': 'box' };
        const VALID_SHAPES = new Set(['box', 'sphere', 'capsule', 'mesh', 'terrain']);
        if (SHAPE_ALIASES[compData.shapeType]) {
          compData.shapeType = SHAPE_ALIASES[compData.shapeType];
        }
        if (!VALID_SHAPES.has(compData.shapeType)) {
          throw new Error(`addComponent("${name}"): invalid shapeType "${compData.shapeType}". Valid: box, sphere, capsule, mesh, terrain (aliases: circle→sphere, cube→box)`);
        }
      }
      const existing = entity.components.find((c: any) => c.type === componentType);
      if (existing) {
        if (!existing.data) existing.data = {};
        Object.assign(existing.data, compData);
      } else {
        entity.components.push({ type: componentType, data: compData });
      }
      changes.push({ action: 'add_component', entity: name, detail: componentType });
    },

    removeComponent(name: string, componentType: string) {
      const entity = findEntity(name);
      if (!entity?.components) return;
      entity.components = entity.components.filter((c: any) => c.type !== componentType);
      changes.push({ action: 'remove_component', entity: name, detail: componentType });
    },

    setMaterial(name: string, materialOverrides: any) {
      const entity = findEntity(name);
      if (!entity?.components) return;
      const mr = entity.components.find((c: any) => c.type === 'MeshRendererComponent');
      if (mr) {
        if (!mr.data) mr.data = {};
        mr.data.materialOverrides = materialOverrides;
      }
      changes.push({ action: 'set_material', entity: name });
    },

    findEntity(name: string): any {
      const entity = findEntity(name);
      if (!entity) return null;
      const clone = JSON.parse(JSON.stringify(entity));
      // Add convenience fields so AI can write entity.position instead of digging into components
      const tc = (clone.components || []).find((c: any) => c.type === 'TransformComponent');
      if (tc?.data) {
        clone.position = tc.data.position || { x: 0, y: 0, z: 0 };
        clone.scale = tc.data.scale || { x: 1, y: 1, z: 1 };
        clone.rotation = tc.data.rotation || { x: 0, y: 0, z: 0, w: 1 };
      }
      const mr = (clone.components || []).find((c: any) => c.type === 'MeshRendererComponent');
      if (mr?.data) {
        clone.meshType = mr.data.meshType;
        clone.materialOverrides = mr.data.materialOverrides;
      }
      return clone;
    },

    getEntities(): string[] {
      return sd.entities.map((e: any) => e.name);
    },

    getEntityCount(): number {
      return sd.entities.length;
    },

    addTag(name: string, tag: string) {
      const entity = findEntity(name);
      if (!entity) return;
      if (!entity.tags) entity.tags = [];
      if (!entity.tags.includes(tag)) entity.tags.push(tag);
    },

    removeTag(name: string, tag: string) {
      const entity = findEntity(name);
      if (!entity?.tags) return;
      entity.tags = entity.tags.filter((t: string) => t !== tag);
    },

    setGravity(x: number, y: number, z: number) {
      if (!sd.environment) sd.environment = {};
      sd.environment.gravity = [x, y, z];
      changes.push({ action: 'set_gravity', entity: 'scene', detail: `(${x}, ${y}, ${z})` });
    },

    setAmbientLight(color: [number, number, number], intensity: number) {
      if (!sd.environment) sd.environment = {};
      sd.environment.ambientLight = { color, intensity };
      changes.push({ action: 'set_ambient_light', entity: 'scene' });
    },

    renameEntity(oldName: string, newName: string) {
      const entity = findEntity(oldName);
      if (!entity) return;
      entity.name = newName;
      changes.push({ action: 'rename_entity', entity: oldName, detail: newName });
    },

    duplicateEntity(name: string, newName?: string) {
      const entity = findEntity(name);
      if (!entity) return;
      if (sd.entities.length >= MAX_ENTITIES) {
        throw new Error(`Entity limit reached (${MAX_ENTITIES}). Cannot duplicate.`);
      }
      const clone = JSON.parse(JSON.stringify(entity));
      clone.name = newName || `${name} (copy)`;
      sd.entities.push(clone);
      changes.push({ action: 'duplicate_entity', entity: name, detail: clone.name });
    },

    setActive(name: string, active: boolean) {
      const entity = findEntity(name);
      if (!entity) return;
      entity.active = active;
      changes.push({ action: 'set_active', entity: name, detail: String(active) });
    },

    setParent(childName: string, parentName: string | null) {
      const child = findEntity(childName);
      if (!child) return;
      if (parentName === null) {
        delete child.parent;
      } else {
        const parent = findEntity(parentName);
        if (!parent) return;
        child.parent = parentName;
      }
      changes.push({ action: 'set_parent', entity: childName, detail: parentName || 'none' });
    },

    setEnvironment(props: Record<string, any>) {
      if (!sd.environment) sd.environment = {};
      for (const [path, value] of Object.entries(props)) {
        const parts = path.split('.');
        let target: any = sd.environment;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!target[parts[i]]) target[parts[i]] = {};
          target = target[parts[i]];
        }
        target[parts[parts.length - 1]] = value;
      }
      changes.push({ action: 'set_environment', entity: 'scene' });
    },

    setFog(enabled: boolean, color?: [number, number, number], near?: number, far?: number) {
      if (!sd.environment) sd.environment = {};
      if (!sd.environment.fog) sd.environment.fog = { enabled: false, color: [0.8, 0.8, 0.8], near: 10, far: 100 };
      sd.environment.fog.enabled = enabled;
      if (color) sd.environment.fog.color = color;
      if (near !== undefined) sd.environment.fog.near = near;
      if (far !== undefined) sd.environment.fog.far = far;
      changes.push({ action: 'set_fog', entity: 'scene' });
    },

    setTimeOfDay(hour: number) {
      if (!sd.environment) sd.environment = {};
      sd.environment.timeOfDay = Math.max(0, Math.min(24, hour));
      changes.push({ action: 'set_time_of_day', entity: 'scene', detail: String(hour) });
    },

    // -- Scene management --

    switchScene(sceneKey: string) {
      if (!scenes[sceneKey]) throw new Error(`Scene "${sceneKey}" does not exist. Use scene.listScenes() to see available scenes.`);
      currentKey = sceneKey;
      sd = getCurrentScene();
      markModified();
      changes.push({ action: 'switch_scene', entity: 'scene', detail: sceneKey });
    },

    createScene(sceneKey: string, name?: string) {
      if (scenes[sceneKey]) throw new Error(`Scene "${sceneKey}" already exists.`);
      scenes[sceneKey] = { name: name || sceneKey.replace('.json', ''), entities: [], environment: {} };
      currentKey = sceneKey;
      sd = getCurrentScene();
      markModified();
      changes.push({ action: 'create_scene', entity: 'scene', detail: sceneKey });
    },

    deleteScene(sceneKey: string) {
      if (!scenes[sceneKey]) return;
      if (Object.keys(scenes).length <= 1) throw new Error('Cannot delete the last scene.');
      delete scenes[sceneKey];
      modifiedScenes.delete(sceneKey);
      if (currentKey === sceneKey) {
        currentKey = Object.keys(scenes)[0];
        sd = getCurrentScene();
      }
      changes.push({ action: 'delete_scene', entity: 'scene', detail: sceneKey });
    },

    listScenes(): string[] {
      return Object.keys(scenes);
    },

    getActiveScene(): string {
      return currentKey;
    },
  };

  // Create isolated sandbox
  const sandbox = {
    scene: sceneAPI,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Math,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    Map,
    Set,
  };

  try {
    const script = new vm.Script(code, { filename: 'scene_script.js' });
    const context = vm.createContext(sandbox);
    script.runInContext(context, { timeout: TIMEOUT_MS });
  } catch (err: any) {
    const msg = err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
      ? `Script execution timed out after ${TIMEOUT_MS / 1000} seconds (possible infinite loop)`
      : err.message;
    return {
      success: false,
      scenes,
      modifiedScenes: [...modifiedScenes],
      changes,
      error: msg,
    };
  }

  // Assign entity IDs in all modified scenes
  for (const key of modifiedScenes) {
    const s = scenes[key];
    if (!s?.entities) continue;
    for (let i = 0; i < s.entities.length; i++) {
      if (typeof s.entities[i].id !== 'number') s.entities[i].id = i + 1;
    }
  }

  return {
    success: true,
    scenes,
    modifiedScenes: [...modifiedScenes],
    changes,
  };
}
