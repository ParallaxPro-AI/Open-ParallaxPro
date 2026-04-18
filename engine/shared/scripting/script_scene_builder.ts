/**
 * Shared Script Scene Builder
 *
 * Both the frontend (browser) and headless (Node.js) engines import this module.
 * Each platform provides a ScriptSceneDeps adapter with platform-specific implementations,
 * and this module builds the unified ScriptScene + ScriptEntity interfaces on top.
 *
 * This file must not import anything from frontend/ or backend/.
 */

import { Vec3 } from '../math/vec3.js';
import { Quat } from '../math/quat.js';
import { EventRegistry } from '../events/event_registry.js';

// ── Helpers ──

/** Convert Euler angles (degrees) to a quaternion {x,y,z,w}. */
export function eulerDegreesToQuat(xDeg: number, yDeg: number, zDeg: number): { x: number; y: number; z: number; w: number } {
  const deg2rad = Math.PI / 180;
  const rx = xDeg * deg2rad, ry = yDeg * deg2rad, rz = zDeg * deg2rad;
  const cx = Math.cos(rx * 0.5), sx = Math.sin(rx * 0.5);
  const cy = Math.cos(ry * 0.5), sy = Math.sin(ry * 0.5);
  const cz = Math.cos(rz * 0.5), sz = Math.sin(rz * 0.5);
  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
}

/** Compute a lookAt rotation quaternion from position to target. */
function computeLookAtRotation(
  px: number, py: number, pz: number,
  tx: number, ty: number, tz: number
): { x: number; y: number; z: number; w: number } | null {
  const dx = tx - px, dy = ty - py, dz = tz - pz;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 0.0001) return null;
  const fdx = dx / dist, fdy = dy / dist, fdz = dz / dist;
  const yaw = (fdx * fdx + fdz * fdz < 1e-8) ? 0 : Math.atan2(-fdx, -fdz);
  const pitch = Math.asin(Math.max(-1, Math.min(1, fdy)));
  const sp = Math.sin(pitch * 0.5), cp = Math.cos(pitch * 0.5);
  const sy = Math.sin(yaw * 0.5), cy = Math.cos(yaw * 0.5);
  return { x: sp * cy, y: cp * sy, z: -sp * sy, w: cp * cy };
}

// ── ScriptSceneDeps Interface ──

/** Platform adapter -- each engine (frontend/headless) provides this. */
export interface ScriptSceneDeps {
  scene: any;
  engine: any;
  scriptSystem: any;
  classMap: Map<string, new () => any>;
  projectScripts: Record<string, string>;
  gameUI: any;
  gameAudio: any;
  ensurePrimitiveMeshes: () => void;
  loadScriptClass: (source: string) => (new () => any) | null;
  state: { projectData: any; projectId?: string };
  raycast?: (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number) => any;
  screenToWorldRay?: (sx: number, sy: number) => any;
  screenRaycast?: (sx: number, sy: number, maxDist?: number) => any;
  screenPointToGround?: (sx: number, sy: number, groundY?: number) => any;
  setMeshData?: (entityId: number, positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array) => void;
  getTerrainHeight?: (x: number, z: number) => number;
  getTerrainNormal?: (x: number, z: number) => { x: number; y: number; z: number };
  loadScene?: (sceneName: string, fadeMs?: number) => void;
  getSceneNames?: () => string[];
  saveData?: (key: string, data: any) => void;
  loadData?: (key: string) => any;
  deleteData?: (key: string) => void;
  listSaveKeys?: () => string[];
  setTimeOfDay?: (hour: number) => void;
  getTimeOfDay?: () => number;
  setFog?: (enabled: boolean, color?: number[], near?: number, far?: number) => void;
  getCamera?: () => any;
  setCameraTarget?: (target: any) => void;
  setCameraPosition?: (pos: any) => void;
  worldToScreen?: (wx: number, wy: number, wz: number) => { x: number; y: number } | null;
  uiSendState?: (state: any) => void;
  reloadScene?: () => void;
}

// ── buildScriptScene ──

/**
 * Builds the ScriptScene adapter and makeScriptEntity function.
 * This is the canonical implementation used by both frontend and headless engines.
 */
export function buildScriptScene(deps: ScriptSceneDeps): { scriptScene: any; makeScriptEntity: (entity: any) => any } {
  const {
    scene, engine, scriptSystem, classMap, projectScripts,
    gameUI, gameAudio, ensurePrimitiveMeshes,
    loadScriptClass: loadScriptClassFn,
  } = deps;

  const events = new EventRegistry();
  events.configure({
    getCurrentEntityId: () => scriptSystem?.currentExecutingEntityId ?? -1,
  });

  function resolveId(v: any): number {
    return typeof v === 'object' && v !== null ? v.id : v;
  }

  // ── makeScriptEntity ──

  function makeScriptEntity(entity: any): any {
    if (!entity) return null;

    let tc = entity.getComponent('TransformComponent');
    if (!tc) {
      tc = entity.addComponent('TransformComponent', {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
      });
      if (!tc) return null;
    }

    // ── Script Transform ──
    const scriptTransform: any = {};

    Object.defineProperty(scriptTransform, 'position', {
      get: () => tc.position,
      set: (v: any) => {
        tc.position.x = v.x ?? 0;
        tc.position.y = v.y ?? 0;
        tc.position.z = v.z ?? 0;
        tc.invalidate?.();
      },
      enumerable: true,
    });

    Object.defineProperty(scriptTransform, 'rotation', {
      get: () => tc.rotation,
      set: (v: any) => {
        tc.rotation.x = v.x ?? (v.data ? v.data[0] : 0);
        tc.rotation.y = v.y ?? (v.data ? v.data[1] : 0);
        tc.rotation.z = v.z ?? (v.data ? v.data[2] : 0);
        tc.rotation.w = v.w ?? (v.data ? v.data[3] : 1);
        tc.invalidate?.();
      },
      enumerable: true,
    });

    Object.defineProperty(scriptTransform, 'scale', {
      get: () => tc.scale,
      set: (v: any) => {
        tc.scale.x = v.x ?? 1;
        tc.scale.y = v.y ?? 1;
        tc.scale.z = v.z ?? 1;
        tc.invalidate?.();
      },
      enumerable: true,
    });

    scriptTransform.lookAt = (target: any, upOrY?: any, z?: number) => {
      let tx: number, ty: number, tz: number;
      if (typeof target === 'number') {
        tx = target; ty = upOrY ?? 0; tz = z ?? 0;
      } else {
        tx = target.x ?? 0; ty = target.y ?? 0; tz = target.z ?? 0;
      }
      const q = computeLookAtRotation(tc.position.x, tc.position.y, tc.position.z, tx, ty, tz);
      if (q) {
        tc.rotation.x = q.x; tc.rotation.y = q.y;
        tc.rotation.z = q.z; tc.rotation.w = q.w;
        tc.invalidate?.();
      }
    };

    scriptTransform.setPosition = (xOrVec: any, y?: number, z?: number) => {
      let px: number, py: number, pz: number;
      if (typeof xOrVec === 'object' && xOrVec !== null) {
        px = xOrVec.x ?? 0; py = xOrVec.y ?? 0; pz = xOrVec.z ?? 0;
      } else {
        px = xOrVec ?? 0; py = y ?? 0; pz = z ?? 0;
      }
      tc.position.x = px; tc.position.y = py; tc.position.z = pz;
      tc.invalidate?.();
    };

    scriptTransform.setRotationEuler = (xDeg: number, yDeg: number, zDeg: number) => {
      const q = eulerDegreesToQuat(xDeg, yDeg, zDeg);
      tc.rotation.x = q.x; tc.rotation.y = q.y; tc.rotation.z = q.z; tc.rotation.w = q.w;
      tc.invalidate?.();
    };

    // Direction vectors (engine forward is -Z)
    Object.defineProperty(scriptTransform, 'forward', {
      get: () => {
        const { x: qx, y: qy, z: qz, w: qw } = tc.rotation;
        return new Vec3(
          -(2 * (qx * qz + qw * qy)),
          -(2 * (qy * qz - qw * qx)),
          -(1 - 2 * (qx * qx + qy * qy)),
        );
      },
      enumerable: true,
    });

    Object.defineProperty(scriptTransform, 'right', {
      get: () => {
        const { x: qx, y: qy, z: qz, w: qw } = tc.rotation;
        return new Vec3(
          1 - 2 * (qy * qy + qz * qz),
          2 * (qx * qy + qw * qz),
          2 * (qx * qz - qw * qy),
        );
      },
      enumerable: true,
    });

    Object.defineProperty(scriptTransform, 'up', {
      get: () => {
        const { x: qx, y: qy, z: qz, w: qw } = tc.rotation;
        return new Vec3(
          2 * (qx * qy - qw * qz),
          1 - 2 * (qx * qx + qz * qz),
          2 * (qy * qz + qw * qx),
        );
      },
      enumerable: true,
    });

    scriptTransform.getParent = () => null;

    // ── ScriptEntity ──
    const se: any = {
      id: entity.id,
      name: entity.name,

      get active() { return entity.active; },
      set active(v: boolean) { entity.setActive(v); },
      transform: scriptTransform,

      get tags() {
        return Array.isArray(entity.tags) ? entity.tags : Array.from(entity.tags);
      },

      hasTag: (tag: string) => {
        const t = entity.tags;
        return t instanceof Set ? t.has(tag) : (t?.includes?.(tag) ?? false);
      },

      addTag: (tag: string) => { entity.addTag?.(tag); },
      removeTag: (tag: string) => { entity.removeTag?.(tag); },

      getParent: () => entity.parent ? makeScriptEntity(entity.parent) : null,
      getWorldPosition: () => entity.getWorldPosition?.() ?? tc.position,

      getComponent: <T>(type: string): T | null => {
        let fullType = type;
        if (!type.endsWith('Component')) fullType = type + 'Component';
        if (fullType === 'TransformComponent') return scriptTransform as any;
        return (entity.getComponent(fullType) ?? entity.getComponent(type)) as T | null;
      },

      addComponent: (type: string, data?: Record<string, any>) => {
        const comp = entity.addComponent(type, data ?? {});
        if (type === 'MeshRendererComponent') ensurePrimitiveMeshes();
        if (type === 'ScriptComponent' && data?.scriptURL) {
          attachScriptByURL(entity, data.scriptURL);
        }
        return comp;
      },

      removeComponent: (type: string) => { entity.removeComponent?.(type); },
      setActive: (active: boolean) => entity.setActive(active),
      setParent: (parentOrNull: any) => { entity.setParent?.(parentOrNull); },
      getScript: (className: string) => scriptSystem.findScript(entity.id, className),

      setMaterialColor: (r: number, g: number, b: number, a?: number) => {
        const mr = entity.getComponent('MeshRendererComponent');
        if (!mr) return;
        if (!mr.materialOverrides) mr.materialOverrides = {};
        mr.materialOverrides.baseColor = [r, g, b, a ?? 1];
      },

      setMaterialProperty: (name: string, value: any) => {
        const mr = entity.getComponent('MeshRendererComponent');
        if (!mr) return;
        if (!mr.materialOverrides) mr.materialOverrides = {};
        mr.materialOverrides[name] = value;
      },

      playAnimation: (clipName: string, options?: any) => {
        const animator = entity.getComponent('AnimatorComponent') as any;
        if (animator) animator.play(clipName, options || {});
      },

      playAnimationOnLayer: (layerName: string, clipName: string, boneNames: string[], options?: any) => {
        const animator = entity.getComponent('AnimatorComponent') as any;
        if (!animator?.playOnLayer) return;
        const mask = animator.buildBoneMask(boneNames);
        animator.playOnLayer(layerName, clipName, mask, options || {});
      },

      stopAnimationLayer: (layerName: string) => {
        const animator = entity.getComponent('AnimatorComponent') as any;
        if (animator?.stopLayer) animator.stopLayer(layerName);
      },

      stopAnimation: () => {
        const animator = entity.getComponent('AnimatorComponent') as any;
        if (animator) animator.stop();
      },

      getAnimationNames: (): string[] => {
        const animator = entity.getComponent('AnimatorComponent') as any;
        return animator?.availableClipNames ?? [];
      },
    };

    return se;
  }

  // ── Helper: attach a script by URL ──

  function attachScriptByURL(entity: any, url: string): void {
    let SC = classMap.get(url);
    if (!SC) {
      const src = projectScripts[url];
      if (src) {
        const loaded = loadScriptClassFn(src);
        if (loaded) {
          SC = loaded;
          classMap.set(url, loaded);
          scriptSystem.registerScript(loaded.name || url, loaded);
        }
      }
    }
    if (SC) {
      const wrappedEntity = makeScriptEntity(entity);
      if (wrappedEntity) scriptSystem.attachScript(SC.name || url, wrappedEntity);
    }
  }

  // ── ScriptScene ──

  const scriptScene = {
    // Entity lookup
    findEntityByName: (name: string) => {
      for (const e of scene.entities.values()) {
        if (e.name === name) return makeScriptEntity(e);
      }
      const lower = name.toLowerCase();
      for (const e of scene.entities.values()) {
        if (e.name.toLowerCase() === lower) return makeScriptEntity(e);
      }
      return null;
    },

    findEntitiesByName: (name: string) => {
      const result: any[] = [];
      for (const e of scene.entities.values()) {
        if (e.name === name) {
          const se = makeScriptEntity(e);
          if (se) result.push(se);
        }
      }
      return result;
    },

    findEntitiesByTag: (tag: string) => {
      const result: any[] = [];
      for (const e of scene.entities.values()) {
        const t = e.tags;
        const has = t instanceof Set ? t.has(tag) : (t?.includes?.(tag) ?? false);
        if (has) {
          const se = makeScriptEntity(e);
          if (se) result.push(se);
        }
      }
      return result;
    },

    findEntityByTag: (tag: string) => {
      for (const e of scene.entities.values()) {
        const t = e.tags;
        const has = t instanceof Set ? t.has(tag) : (t?.includes?.(tag) ?? false);
        if (has) return makeScriptEntity(e);
      }
      return null;
    },

    getEntity: (id: number) => {
      const e = scene.getEntity(id);
      return e ? makeScriptEntity(e) : null;
    },

    // Entity creation — instantiates a prefab from `02_entities.json` by its
    // definition key (the same key used in world placements via `ref:`).
    // Returns a fully-built entity with mesh, physics, behaviors, components.
    //
    // Throws on unknown name. The previous behavior — silently creating a
    // bare entity with only a TransformComponent — was the root cause of
    // the lawn-mower-survival "0 score, 0 kills, 0:00, nothing to do" class
    // of bugs: spawnEntity("enemy_slime") would succeed but the spawned
    // enemy had no mesh, no AI behavior, no collider. The throw is loud
    // and tells the script author exactly what went wrong.
    //
    // For genuinely blank entities (rare — usually you want a prefab),
    // use createEntity(name) which is intentionally bare-create.
    spawnEntity: (name: string) => {
      if (typeof scene.hasPrefab === 'function' && scene.hasPrefab(name)) {
        const e = scene.instantiatePrefab(name);
        if (!e) {
          throw new Error(
            `spawnEntity("${name}") failed: prefab registered but instantiation returned null. This is an engine bug — please report.`,
          );
        }
        return makeScriptEntity(e)!;
      }
      throw new Error(
        `spawnEntity("${name}") references unknown entity definition. ` +
          `Names must match a key in 02_entities.json "definitions" exactly. ` +
          `Use scene.createEntity(name) instead if you intentionally want a bare entity.`,
      );
    },

    createEntity: (nameOrSpec: string | any): any => {
      if (typeof nameOrSpec === 'object' && nameOrSpec !== null) {
        const spec = nameOrSpec;
        const e = scene.createEntity(spec.name || 'Entity');
        const tcSpec = spec.components?.find?.((c: any) => c.type === 'TransformComponent');
        e.addComponent('TransformComponent', tcSpec?.data || {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
        });

        if (Array.isArray(spec.components)) {
          for (const comp of spec.components) {
            if (comp.type === 'TransformComponent') continue;
            const compType = comp.type === 'MeshComponent' ? 'MeshRendererComponent' : comp.type;
            e.addComponent(compType, comp.data || {});
          }
        }

        if (Array.isArray(spec.tags)) {
          for (const tag of spec.tags) e.addTag(tag);
        }
        ensurePrimitiveMeshes();
        return makeScriptEntity(e)?.id ?? e.id;
      }

      // Simple string name
      const e = scene.createEntity(nameOrSpec);
      if (!e.getComponent('TransformComponent')) {
        e.addComponent('TransformComponent', {
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          scale: { x: 1, y: 1, z: 1 },
        });
      }
      return makeScriptEntity(e)!.id;
    },

    destroyEntity: (idOrObj: number | any) => {
      const id = resolveId(idOrObj);
      scriptSystem.detachScripts(id);
      scene.destroyEntity(id);
    },

    getAllEntities: () => {
      const result: any[] = [];
      for (const e of scene.entities.values()) {
        const se = makeScriptEntity(e);
        if (se) result.push(se);
      }
      return result;
    },

    // Transform (ID-based)
    getTransform: (entityIdOrObj: number | any) => {
      const e = scene.getEntity(resolveId(entityIdOrObj));
      if (!e) return null;
      return makeScriptEntity(e)?.transform ?? null;
    },

    getPosition: (entityId: number | any) => {
      const e = scene.getEntity(resolveId(entityId));
      if (!e) return new Vec3(0, 0, 0);
      const tc = e.getComponent('TransformComponent');
      if (!tc) return new Vec3(0, 0, 0);
      return new Vec3(tc.position.x, tc.position.y, tc.position.z);
    },

    setPosition: (entityId: number | any, xOrVec: any, y?: number, z?: number) => {
      const e = scene.getEntity(resolveId(entityId));
      if (!e) return;
      const tc = e.getComponent('TransformComponent');
      if (!tc) return;
      let px: number, py: number, pz: number;
      if (typeof xOrVec === 'object' && xOrVec !== null) {
        px = xOrVec.x ?? 0; py = xOrVec.y ?? 0; pz = xOrVec.z ?? 0;
      } else {
        px = xOrVec ?? 0; py = y ?? 0; pz = z ?? 0;
      }
      if (tc.position.set) tc.position.set(px, py, pz);
      else { tc.position.x = px; tc.position.y = py; tc.position.z = pz; }
      tc.invalidate?.();
      const rb = e.getComponent('RigidbodyComponent');
      if (rb?.teleport) rb.teleport(px, py, pz);
    },

    setScale: (entityId: number | any, x: number, y: number, z: number) => {
      const e = scene.getEntity(resolveId(entityId));
      if (!e) return;
      const tc = e.getComponent('TransformComponent');
      if (!tc) return;
      if (tc.scale.set) tc.scale.set(x, y, z);
      else { tc.scale.x = x; tc.scale.y = y; tc.scale.z = z; }
      tc.invalidate?.();
    },

    setRotationEuler: (entityId: number | any, xDeg: number, yDeg: number, zDeg: number) => {
      const e = scene.getEntity(resolveId(entityId));
      if (!e) return;
      const tc = e.getComponent('TransformComponent');
      if (!tc) return;
      const q = eulerDegreesToQuat(xDeg, yDeg, zDeg);
      tc.rotation.x = q.x; tc.rotation.y = q.y; tc.rotation.z = q.z; tc.rotation.w = q.w;
      tc.invalidate?.();
    },

    // Components (ID-based)
    getComponent: <T>(entityId: number | any, type: string): T | null => {
      const e = scene.getEntity(resolveId(entityId));
      if (!e) return null;
      const fullType = type.endsWith('Component') ? type : type + 'Component';
      return (e.getComponent(fullType) ?? e.getComponent(type)) as T | null;
    },

    getScript: (entityId: number | any, className: string): any => {
      return scriptSystem.findScript(resolveId(entityId), className);
    },

    addComponent: (entityIdOrObj: number | any, type: string, data?: Record<string, any>) => {
      const e = scene.getEntity(resolveId(entityIdOrObj));
      if (!e) return;
      e.addComponent(type, data ?? {});
      if (type === 'MeshRendererComponent') ensurePrimitiveMeshes();
      if (type === 'ScriptComponent' && data?.scriptURL) {
        attachScriptByURL(e, data.scriptURL);
      }
    },

    // Physics (ID-based)
    setVelocity: (entityId: number | any, v: any) => {
      const e = scene.getEntity(resolveId(entityId));
      const rb = e?.getComponent('RigidbodyComponent');
      if (!rb) return;
      if (rb.setLinearVelocity) rb.setLinearVelocity({ x: v.x ?? 0, y: v.y ?? 0, z: v.z ?? 0 });
      else if (rb.velocity) { rb.velocity.x = v.x ?? 0; rb.velocity.y = v.y ?? 0; rb.velocity.z = v.z ?? 0; }
    },

    getVelocity: (entityId: number | any) => {
      const e = scene.getEntity(resolveId(entityId));
      const rb = e?.getComponent('RigidbodyComponent');
      if (rb?.getLinearVelocity) {
        const v = rb.getLinearVelocity();
        return new Vec3(v.x ?? 0, v.y ?? 0, v.z ?? 0);
      }
      if (rb?.velocity) return new Vec3(rb.velocity.x, rb.velocity.y, rb.velocity.z);
      return new Vec3(0, 0, 0);
    },

    applyForce: (entityId: number | any, f: any) => {
      const e = scene.getEntity(resolveId(entityId));
      const rb = e?.getComponent('RigidbodyComponent');
      if (rb?.addForce) rb.addForce(f);
    },

    // Tags
    addTag: (entityId: number | any, tag: string) => {
      const e = scene.getEntity(resolveId(entityId));
      if (e) e.addTag(tag);
    },
    removeTag: (entityId: number | any, tag: string) => {
      const e = scene.getEntity(resolveId(entityId));
      if (e) e.removeTag(tag);
    },

    // Hierarchy
    setParent: (entityId: number | any, parentEntityId: number | any | null) => {
      const e = scene.getEntity(resolveId(entityId));
      if (!e) return;
      if (parentEntityId === null) {
        e.setParent(null);
      } else {
        const parent = scene.getEntity(resolveId(parentEntityId));
        if (parent) e.setParent(parent);
      }
    },

    // LookAt (scene-level)
    lookAt: (entityId: number | any, targetX: number, targetY: number, targetZ: number) => {
      const e = scene.getEntity(resolveId(entityId));
      if (!e) return;
      const tc = e.getComponent('TransformComponent');
      if (!tc) return;
      const q = computeLookAtRotation(tc.position.x, tc.position.y, tc.position.z, targetX, targetY, targetZ);
      if (q) {
        tc.rotation.x = q.x; tc.rotation.y = q.y;
        tc.rotation.z = q.z; tc.rotation.w = q.w;
        tc.invalidate?.();
      }
    },

    // Raycast
    raycast: deps.raycast ?? (() => null),
    screenToWorldRay: deps.screenToWorldRay ?? (() => null),
    screenRaycast: deps.screenRaycast ?? ((sx: number, sy: number, maxDist?: number) => {
      const ray = deps.screenToWorldRay?.(sx, sy);
      if (!ray) return null;
      return deps.raycast?.(ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z, maxDist ?? 200) ?? null;
    }),
    screenPointToGround: deps.screenPointToGround ?? ((_sx: number, _sy: number, groundY: number = 0) => new Vec3(0, groundY, 0)),
    worldToScreen: deps.worldToScreen ?? (() => null),

    // Terrain
    getTerrainHeight: deps.getTerrainHeight ?? (() => 0),
    getTerrainNormal: deps.getTerrainNormal ?? (() => ({ x: 0, y: 1, z: 0 })),

    // Mesh data
    setMeshData: deps.setMeshData ?? (() => {}),

    // Event system
    events,
    _cleanupEntityListeners(entityId: number) {
      events.cleanupEntity(entityId);
    },

    // Scene management
    loadScene: deps.loadScene ?? (() => {}),
    getSceneNames: deps.getSceneNames ?? (() => []),
    reloadScene: () => {
      events.game.emit('sceneReloading', {});
      setTimeout(() => { deps.reloadScene?.(); }, 0);
    },

    // Camera
    getCamera: deps.getCamera ?? (() => null),
    setCameraTarget: deps.setCameraTarget ?? (() => {}),
    setCameraPosition: deps.setCameraPosition ?? (() => {}),

    // Save/Load
    saveData: deps.saveData ?? (() => {}),
    loadData: deps.loadData ?? (() => null),
    deleteData: deps.deleteData ?? (() => {}),
    listSaveKeys: deps.listSaveKeys ?? (() => []),

    // Environment
    setTimeOfDay: deps.setTimeOfDay ?? ((hour: number) => {
      if (scene.environment) scene.environment.timeOfDay = Math.max(0, Math.min(24, hour));
    }),
    getTimeOfDay: deps.getTimeOfDay ?? (() => scene.environment?.timeOfDay ?? 12),
    setFog: deps.setFog ?? ((enabled: boolean, color?: number[], near?: number, far?: number) => {
      if (scene.environment?.fog) {
        scene.environment.fog.enabled = enabled;
        if (color) scene.environment.fog.color = [color[0], color[1], color[2]];
        if (near !== undefined) scene.environment.fog.near = near;
        if (far !== undefined) scene.environment.fog.far = far;
      }
    }),

    // UI creation
    createText: (opts?: any) => gameUI.createText(opts),
    createImage: (opts?: any) => gameUI.createImage?.(opts) ?? gameUI.createText(opts),
    createButton: (opts?: any) => gameUI.createButton(opts),
    createPanel: (opts?: any) => gameUI.createPanel(opts),
    createProgressBar: (opts?: any) => gameUI.createProgressBar(opts),

    // System accessors
    get input() { return engine.globalContext?.inputSystem ?? deps.engine; },
    get ui() {
      if (!gameUI.sendState) gameUI.sendState = deps.uiSendState ?? (() => {});
      return gameUI;
    },
    get audio() { return gameAudio; },
    get time() {
      const ti = scriptSystem.timeInfo || { time: 0, deltaTime: 0, frameCount: 0 };
      return { time: ti.time, deltaTime: ti.deltaTime, frameCount: ti.frameCount };
    },

    // Particles
    spawnParticles: (preset: string, x: number, y: number, z: number, opts?: any): number => {
      return (scene as any).spawnParticles?.(preset, x, y, z, opts) ?? -1;
    },
    stopParticles: (emitterId: number) => { (scene as any).stopParticles?.(emitterId); },
    removeParticles: (emitterId: number) => { (scene as any).removeParticles?.(emitterId); },

    // Animation (ID-based)
    playAnimation: (entityIdOrObj: number | any, clipName: string, options?: { loop?: boolean; speed?: number; blendTime?: number }) => {
      const e = scene.getEntity(resolveId(entityIdOrObj));
      if (!e) return;
      const animator = e.getComponent('AnimatorComponent') as any;
      if (animator) animator.play(clipName, options || {});
    },
    stopAnimation: (entityIdOrObj: number | any) => {
      const e = scene.getEntity(resolveId(entityIdOrObj));
      if (!e) return;
      const animator = e.getComponent('AnimatorComponent') as any;
      if (animator) animator.stop();
    },
    getAnimationNames: (entityIdOrObj: number | any): string[] => {
      const e = scene.getEntity(resolveId(entityIdOrObj));
      if (!e) return [];
      const animator = e.getComponent('AnimatorComponent') as any;
      return animator?.availableClipNames ?? [];
    },
  } as any;

  // Audio event listeners
  if (gameAudio && typeof gameAudio.playSound === 'function') {
    events.audio.on('playSound', (data: any) => {
      gameAudio.playSound(data.path, data.volume ?? 0.7);
    });
    events.audio.on('playMusic', (data: any) => {
      if (gameAudio.playMusic) gameAudio.playMusic(data.path ?? data.track, data.volume ?? 0.4);
    });
    events.audio.on('stopMusic', () => {
      if (gameAudio.stopMusic) gameAudio.stopMusic();
    });
  }

  return { scriptScene, makeScriptEntity };
}
