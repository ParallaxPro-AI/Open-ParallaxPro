/**
 * level_assembler.ts
 *
 * Reads the 4-file game template format and assembles a ConvertedScene:
 *   01_flow.json      — HFSM game states + ui_params
 *   02_entities.json   — entity definitions (prefabs) with behaviors
 *   03_worlds.json     — scene layouts with placements referencing entity defs
 *   04_systems.json    — standalone manager systems
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateControlManifest } from '../../../../../shared/input/control_manifest.js';
import { checkRetryFlowWiring, normalizeRetryFlow } from './sandbox_validate.js';

export interface MultiplayerConfig {
  enabled?: boolean;
  maxPlayers?: number;
  minPlayers?: number;
  tickRate?: number;
  authority?: 'host';
  predictLocalPlayer?: boolean;
  hostPlaysGame?: boolean;
  /**
   * Prefab name used when the network adapter needs to instantiate a
   * visible proxy for a peer it's never seen before (only auto-spawn
   * path; games can still spawn proxies themselves via the adapter's
   * manual-bind hook).
   *
   *   string  → instantiate `prefabs[name]` per new peer.
   *   null    → disable auto-spawn entirely; the game owns spawning.
   *   undef   → legacy fallback (a plain blue capsule), kept for older
   *             templates that predate this field.
   */
  remotePlayerPrefab?: string | null;
  /**
   * Whether players can join a lobby that's already in-progress.
   * Defaults to false (competitive templates — you can't drop into a
   * coin-grab match halfway through). Social / open-world games
   * (walk-around, MMOs) set this to true so players come and go
   * without the host having to restart the match.
   */
  allowJoinInProgress?: boolean;
}

/**
 * Mobile-controls manifest. Pulled verbatim from `01_flow.json:controls`
 * and forwarded to the runtime; the engine's mobile overlay parses + renders
 * from this. Schema lives in `engine/shared/input/control_manifest.ts`.
 *
 * Opaque passthrough — the assembler doesn't validate the shape; the
 * shared `resolveManifest()` does at runtime so headless and browser agree.
 */
export type ControlsManifest = Record<string, any>;

export interface ConvertedScene {
  entities: any[];
  scripts: Record<string, string>;
  uiFiles: Record<string, string>;
  controlsManifest?: ControlsManifest;
  /**
   * Named prefab blueprints, keyed by the entity-def name from
   * 02_entities.json. Each value is an already-assembled entity JSON
   * blob (same shape as entries in `entities`) minus a world position
   * and id — the runtime calls Scene.instantiatePrefab(name, pos) to
   * stamp one into the scene with a fresh id.
   *
   * Used mainly by the multiplayer adapter to spawn remote-player
   * proxies that look like the same prefab as the local player, but
   * any script can call it for per-game entity spawning.
   */
  prefabs?: Record<string, any>;
  multiplayerConfig?: MultiplayerConfig;
  /** Scene-level environment (gravity, lighting, fog, time of day) sourced from
   *  worlds[0].environment. The editor's environment edits go here. */
  environment?: Record<string, any>;
  /**
   * Opaque passthrough of `worlds[0].heightmapTerrain` from the template.
   * The editor reads it off the scene and hands it to its HeightmapTerrain
   * runtime to build the world-scale terrain. `undefined` when the
   * template doesn't opt in; the assembler never inspects its shape.
   */
  heightmapTerrain?: Record<string, any>;
  /**
   * Opaque passthrough of `worlds[0].streamedBuildings` from the template.
   * The editor reads it off the scene and hands it to its StreamedBuildings
   * runtime to populate the world with plain-color extruded footprints
   * around the active camera. `undefined` when the template doesn't opt in.
   */
  streamedBuildings?: Record<string, any>;
}

interface SystemDef {
  description?: string;
  script: string;
  params?: Record<string, any>;
}

// ─── Directory constants ────────────────────────────────────────────────────

const __dirname_la = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname_la, 'reusable_game_components');
const SYSTEMS_DIR = path.join(RGC_DIR, 'systems', 'v0.1');
const BEHAVIORS_DIR = path.join(RGC_DIR, 'behaviors', 'v0.1');
const UI_DIR = path.join(RGC_DIR, 'ui', 'v0.1');

const NO_LABEL_TAGS = new Set(['camera']);

// ─── Helpers ────────────────────────────────────────────────────────────────

function eulerDegreesToQuat(x: number, y: number, z: number): { x: number; y: number; z: number; w: number } {
  const deg2rad = Math.PI / 180;
  const hx = x * deg2rad * 0.5, hy = y * deg2rad * 0.5, hz = z * deg2rad * 0.5;
  const cx = Math.cos(hx), sx = Math.sin(hx);
  const cy = Math.cos(hy), sy = Math.sin(hy);
  const cz = Math.cos(hz), sz = Math.sin(hz);
  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');
}

/** Flatten a collider spec into the shape ColliderComponent.initialize
 * consumes: `{ shapeType }`, plus an optional `isTrigger`. Accepts the legacy
 * vocabulary (`cuboid` → `box`, `ball` → `sphere`).
 *
 * **Dimensions are not honoured.** Authored `halfExtents` / `size` / `radius`
 * / `height` / `center` and the legacy `disableAutoFit` opt-out are dropped
 * here on purpose — the runtime auto-fits the collider to the visible mesh
 * AABB on mesh load (editor_context.autoFitCollider), so any author-supplied
 * dimensions create a window where the collision shape doesn't match what
 * the player sees. A warning is logged so the source of the mismatch is
 * traceable without breaking assembly. */
function buildColliderData(shape: string, src: any): any {
  const normShape = shape === 'cuboid' ? 'box' : (shape === 'ball' ? 'sphere' : shape);
  if (src && (src.halfExtents !== undefined || src.size !== undefined ||
              src.radius !== undefined || src.height !== undefined ||
              src.center !== undefined || src.disableAutoFit !== undefined)) {
    const dropped: string[] = [];
    if (src.halfExtents !== undefined) dropped.push('halfExtents');
    if (src.size !== undefined) dropped.push('size');
    if (src.radius !== undefined) dropped.push('radius');
    if (src.height !== undefined) dropped.push('height');
    if (src.center !== undefined) dropped.push('center');
    if (src.disableAutoFit !== undefined) dropped.push('disableAutoFit');
    console.warn(
      `[level_assembler] Ignoring authored collider field(s) [${dropped.join(', ')}] — ` +
      `colliders auto-fit to the visible mesh AABB. Author shape + isTrigger only.`,
    );
  }
  return { shapeType: normShape };
}

function tryLoadScript(scriptPath: string, behaviorsDir?: string, systemsDir?: string): string | null {
  const relative = scriptPath.replace(/^\/+/, '');
  const behaviorsFull = path.join(behaviorsDir || BEHAVIORS_DIR, relative);
  try { return fs.readFileSync(behaviorsFull, 'utf-8'); } catch {}
  const systemsFull = path.join(systemsDir || SYSTEMS_DIR, relative);
  try { return fs.readFileSync(systemsFull, 'utf-8'); } catch { return null; }
}

function injectParams(code: string, params: Record<string, any>): string {
  let result = code;
  for (const [key, value] of Object.entries(params)) {
    const pattern = new RegExp(`(\\s+_${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*)([^;]*)(;)`, 'g');
    const safeValue = JSON.stringify(value).replace(/\$/g, '$$$$');
    result = result.replace(pattern, `$1${safeValue}$3`);
  }
  return result;
}

function makeScriptKey(scriptPath: string, entityName: string, usedKeys: Set<string>): string {
  const relative = scriptPath.replace(/^\/+/, '');
  let flat = relative.replace(/\//g, '_');
  if (!flat.endsWith('.ts')) flat += '.ts';
  let key = `scripts/${flat}`;
  if (usedKeys.has(key)) {
    key = `scripts/${flat.replace('.ts', '')}_${safeName(entityName)}.ts`;
  }
  return key;
}

function buildScriptData(urls: string[], properties?: Record<string, any>): any {
  const data: any = { scriptURL: urls[0] };
  if (properties) data.properties = properties;
  if (urls.length > 1) {
    data.additionalScripts = urls.slice(1).map(url => ({ scriptURL: url }));
  }
  return data;
}

function appendScript(entity: any, url: string): void {
  const sc = entity.components?.find((c: any) => c.type === 'ScriptComponent');
  if (sc) {
    if (!sc.data.additionalScripts) sc.data.additionalScripts = [];
    sc.data.additionalScripts.push({ scriptURL: url });
  } else {
    entity.components.push({ type: 'ScriptComponent', data: { scriptURL: url } });
  }
}

function loadSystemScript(
  sys: SystemDef,
  entityName: string,
  scripts: Record<string, string>,
  usedKeys: Set<string>,
  behaviorsDir?: string,
  systemsDir?: string,
  missingScripts?: Set<string>,
): string | null {
  let code = tryLoadScript(sys.script, behaviorsDir, systemsDir);
  if (!code) {
    missingScripts?.add(sys.script);
    const className = safeName(path.basename(sys.script, '.ts'))
      .replace(/(^|_)([a-z])/g, (_m: string, _p: string, c: string) => c.toUpperCase());
    code = `class ${className || 'GeneratedScript'} extends GameScript {\n    onStart() {}\n    onUpdate(dt) {}\n}\n`;
  }
  if (sys.params && Object.keys(sys.params).length > 0) {
    code = injectParams(code, sys.params);
    // Rename the class in this per-entity copy so multiple entities
    // sharing the same script source don't collide on the
    // scriptRegistry's name-keyed lookup (last-registered wins, which
    // means every placed instance ends up running with the LAST-loaded
    // entity's params). Bullet-hell run cf41b9d1 had every grunt sharing
    // the boss's maxHealth=400 because all eight enemy types loaded
    // class BHEnemyBehavior with different params, each overwriting the
    // previous registration. Suffix with the entity name so each gets a
    // unique class. Only fires when this entity has its own params —
    // entities reusing the default class stay sharing the original.
    const safeSuffix = safeName(entityName).replace(/[^A-Za-z0-9_]/g, '_');
    if (safeSuffix) {
      code = code.replace(
        /(class\s+)([A-Z][A-Za-z0-9_]*)(\s+extends\s+GameScript)/,
        `$1$2_${safeSuffix}$3`,
      );
    }
  }
  const key = makeScriptKey(sys.script, entityName, usedKeys);
  usedKeys.add(key);
  scripts[key] = code;
  return key;
}

// ─── FSM driver generation ─────────────────────────────────────────────────

const _fsmDriverCache = new Map<string, string>();
function getFSMDriverCode(systemsDir?: string): string {
  const dir = systemsDir || SYSTEMS_DIR;
  const cached = _fsmDriverCache.get(dir);
  if (cached) return cached;
  let code: string;
  try {
    code = fs.readFileSync(path.join(dir, 'fsm_driver.ts'), 'utf-8');
  } catch {
    code = 'class FSMDriver extends GameScript {}';
  }
  _fsmDriverCache.set(dir, code);
  return code;
}

function generateFSMDriver(entityName: string, configs: any[], systemsDir?: string): string {
  let code = getFSMDriverCode(systemsDir);
  const uniqueClass = `FSMDriver_${safeName(entityName)}`;
  code = code.replace(/class FSMDriver extends/, `class ${uniqueClass} extends`);
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  code = code.replace(/_fsmConfigs = ".*?";|_fsmConfigs = '\[\]';/, `_fsmConfigs = '${esc(JSON.stringify(configs))}';`);
  return code;
}

// ─── Entity label script ────────────────────────────────────────────────────

const ENTITY_LABEL_KEY = 'scripts/_entity_label.ts';
const _entityLabelCache = new Map<string, string>();
function getEntityLabelCode(systemsDir?: string): string {
  const dir = systemsDir || SYSTEMS_DIR;
  const cached = _entityLabelCache.get(dir);
  if (cached) return cached;
  let code: string;
  try {
    code = fs.readFileSync(path.join(dir, '_entity_label.ts'), 'utf-8');
  } catch {
    code = `class EntityLabel extends GameScript { onStart() {} onUpdate(dt) {} }`;
  }
  _entityLabelCache.set(dir, code);
  return code;
}

// ─── Shared entity building ─────────────────────────────────────────────────

interface EntityBuildConfig {
  def: any;
  entityName: string;
  position: number[];
  rotation?: number[];
  scale?: number[];
  parentId?: number;
  parentTags?: Set<string>;
  scripts: Record<string, string>;
  usedKeys: Set<string>;
  baseDirs?: { behaviors?: string; systems?: string };
  missingScripts?: Set<string>;
  placementMeta?: Record<string, any>;
  /** Per-instance overrides emitted by the editor mutator (placement-level). */
  placementOverrides?: {
    materialOverrides?: any;
    extraComponents?: any[];
    extraTags?: string[];
    active?: boolean;
  };
}

function buildEntity(config: EntityBuildConfig, nextId: { value: number }): any[] {
  const { def, entityName, position, parentId, parentTags, scripts, usedKeys, baseDirs, missingScripts, placementMeta, placementOverrides } = config;
  const rotation = config.rotation || [0, 0, 0];
  const entities: any[] = [];

  const isCustomMesh = def.mesh?.type === 'custom' && def.mesh?.asset;
  const meshScale = config.scale || def.mesh?.scale || [1, 1, 1];

  const entityId = nextId.value++;
  const tags: string[] = [...(def.tags || []), ...(placementOverrides?.extraTags || [])];
  const tagSet = new Set(tags);

  // Components
  const components: any[] = [
    { type: 'TransformComponent', data: {
      position: { x: position[0], y: position[1], z: position[2] },
      rotation: eulerDegreesToQuat(rotation[0], rotation[1], rotation[2]),
      scale: { x: meshScale[0], y: meshScale[1], z: meshScale[2] },
    }},
  ];

  // Mesh
  if (def.mesh) {
    const meshData: any = {
      meshType: def.mesh.type || 'cube',
      baseColor: def.mesh.color || [0.8, 0.2, 0.2, 1],
    };
    if (isCustomMesh) meshData.meshAsset = def.mesh.asset;
    if (def.mesh.modelRotationX) meshData.modelRotationX = def.mesh.modelRotationX;
    if (def.mesh.modelRotationY) meshData.modelRotationY = def.mesh.modelRotationY;
    if (def.mesh.modelRotationZ) meshData.modelRotationZ = def.mesh.modelRotationZ;
    // hideFromOwner — controls whether the mesh is rendered when the
    // active camera is "inside" this entity (e.g. FPS camera at the
    // player's head). Needs to be forwarded to MeshRendererComponent
    // data or the runtime sees `hideFromOwner = false` regardless of
    // what the JSON declared. This was the "I still see my own mesh"
    // bug in FPS run 43744221 — JSON said true, renderer saw false.
    if (def.mesh.hideFromOwner) meshData.hideFromOwner = true;
    // Texture overrides — def-level first, then placement-level (editor edits win).
    if (def.mesh_override || placementOverrides?.materialOverrides) {
      meshData.materialOverrides = { ...(def.mesh_override || {}), ...(placementOverrides?.materialOverrides || {}) };
    }
    components.push({ type: 'MeshRendererComponent', data: meshData });
  }

  // Camera
  if (def.camera) {
    components.push({ type: 'CameraComponent', data: {
      fov: def.camera.fov ?? 60,
      nearClip: def.camera.near ?? 0.1,
      farClip: def.camera.far ?? 1000,
    } });
  }

  // Physics — auto-assigned for all mesh entities (skip cameras).
  //
  // Opt-out gates, in order:
  //   1. `physics: false` or `physics: null` — explicit author opt-out.
  //   2. `tags: ["decoration_only"]` with no `physics` field — semantic
  //      opt-out. The `_only` suffix means "purely visual, no collision";
  //      this is how all 274 decoration_only entities in shipped templates
  //      already pair with `physics: false`. Authors who write the tag but
  //      forget the explicit `false` (e.g. AI-generated skybox mountains
  //      and distant ridges) used to get a default static box collider
  //      anyway, and a tight AABB box around a tall thin cone reads as a
  //      "way too big" collider that the user can't walk into but the
  //      gizmo still draws over the silhouette.
  //   `tags: ["decoration"]` (without `_only`) is intentionally NOT opted
  //   out — rocks, crates, stadium stands, etc. legitimately want
  //   collision and rely on the auto-fit default.
  const physicsOptOut = def.physics === false
    || def.physics === null
    || (def.physics === undefined && tagSet.has('decoration_only'));
  if (def.mesh && !tagSet.has('camera') && !physicsOptOut) {
    const p = def.physics || {};
    components.push({ type: 'RigidbodyComponent', data: {
      bodyType: p.type || 'static',
      mass: p.mass || 1,
      freezeRotation: p.freeze_rotation || false,
    }});
    // Collider shape: explicit override > mesh-based default.
    //
    // The `physics.collider` field in 02_entities.json can be:
    //   - a string shortcut — "box" | "cuboid" | "sphere" | "ball" | "capsule" | "mesh"
    //   - an object — { shape: "cuboid", halfExtents: [hx,hy,hz] } | { shape: "sphere", radius: r }
    //     | { shape: "capsule", radius: r, height: h } | { shape: "mesh" }
    //
    // Previously this code read only the string form: for the object form it
    // wrote `shapeType: <whole object>` and then fell through to `size: {1,1,1}`,
    // which ColliderComponent.initialize interpreted as a 1-unit cube regardless
    // of the authored size. That silently scaled every hand-tuned collider
    // (the marine-drive sedan authored as 1.8×1×4 became a 1×1×1 cube). Fix:
    // normalise both forms into the flat fields ColliderComponent expects.
    let colData: any;
    const rawCol = p.collider;
    const meshFallbackShape = isCustomMesh ? 'mesh' : (def.mesh?.type === 'sphere' ? 'sphere' : 'box');
    if (typeof rawCol === 'string') {
      colData = buildColliderData(rawCol, null);
    } else if (rawCol && typeof rawCol === 'object') {
      const shape = (rawCol as any).shape ?? (rawCol as any).shapeType ?? meshFallbackShape;
      colData = buildColliderData(shape, rawCol);
    } else {
      colData = buildColliderData(meshFallbackShape, null);
    }
    if (p.is_trigger) colData.isTrigger = true;
    components.push({ type: 'ColliderComponent', data: colData });
  }

  // Scripts from behaviors
  const scriptURLs: string[] = [];
  const properties: Record<string, any> = {};

  if (def.behaviors) {
    for (const beh of def.behaviors) {
      const behWithName = { ...beh, params: { ...beh.params, behaviorName: (beh as any).name || '' } };
      const key = loadSystemScript(behWithName as SystemDef, entityName, scripts, usedKeys, baseDirs?.behaviors, baseDirs?.systems, missingScripts);
      if (key) scriptURLs.push(key);
    }
  }

  // Player flag
  if (tagSet.has('player') || parentTags?.has('player')) {
    properties._isPlayerControlled = true;
  }

  // Network identity — populated from the `network` block on the entity def.
  // Only added when the block is present; single-player games are unaffected.
  if (def.network && typeof def.network === 'object') {
    const n = def.network as any;
    const initialVars: Record<string, any> = {};
    if (Array.isArray(n.networkedVars)) {
      for (const name of n.networkedVars) {
        if (typeof name === 'string') initialVars[name] = 0;
      }
    } else if (n.networkedVars && typeof n.networkedVars === 'object') {
      for (const [k, v] of Object.entries(n.networkedVars)) initialVars[k] = v;
    }
    components.push({ type: 'NetworkIdentityComponent', data: {
      // networkId/ownerId/isLocalPlayer are populated at spawn time by the
      // MultiplayerSession; these are placeholders for the template-defined
      // instances placed in the world.
      networkId: -1,
      ownerId: n.ownership === 'local_player' ? -2 : -1,
      isLocalPlayer: n.ownership === 'local_player',
      syncTransform: n.syncTransform !== false,
      syncInterval: Math.max(16, Math.min(1000, Number(n.syncInterval) || 33)),
      networkedVars: initialVars,
    } });
  }

  // Meta properties (pickups, mission markers, etc.)
  if (placementMeta) {
    for (const [k, v] of Object.entries(placementMeta)) properties[`_${k}`] = v;
  }
  if (def.meta) {
    for (const [k, v] of Object.entries(def.meta)) {
      if (properties[`_${k}`] === undefined) properties[`_${k}`] = v;
    }
  }

  // Attach ScriptComponent
  if (scriptURLs.length > 0) {
    const scriptData = buildScriptData(scriptURLs, Object.keys(properties).length > 0 ? properties : undefined);
    if (properties._isPlayerControlled && scriptData.additionalScripts) {
      for (const as of scriptData.additionalScripts) {
        if (!as.properties) as.properties = {};
        as.properties._isPlayerControlled = true;
      }
    }
    components.push({ type: 'ScriptComponent', data: scriptData });
  }

  // Placement-level extra components — passed through verbatim, after auto-derived ones.
  if (placementOverrides?.extraComponents) {
    for (const c of placementOverrides.extraComponents) {
      if (!c?.type) continue;
      const existing = components.find((x: any) => x.type === c.type);
      if (existing) {
        existing.data = { ...(existing.data || {}), ...(c.data || {}) };
      } else {
        components.push({ type: c.type, data: c.data || {} });
      }
    }
  }

  const entity: any = { id: entityId, name: entityName, components, tags: [...tags] };
  if (parentId !== undefined) entity.parentId = parentId;
  if (placementOverrides?.active === false) entity.active = false;

  // Entity label — only for interactive entities with meaningful tags
  const hasLabelTag = tags.length > 0 && !tags.every(t => NO_LABEL_TAGS.has(t));
  if (def.mesh && !isCustomMesh && hasLabelTag && def.label !== false && !tagSet.has('manager')) {
    appendScript(entity, ENTITY_LABEL_KEY);
  }

  entities.push(entity);

  // Process children
  if (def.children) {
    for (const childDef of def.children) {
      const childPos = childDef.transform?.position || [0, 0, 0];
      const childScale = childDef.mesh?.scale || childDef.transform?.scale || [1, 1, 1];
      const childEntities = buildEntity({
        def: childDef,
        entityName: childDef.name || `${entityName}_child`,
        position: childPos,
        scale: childScale,
        parentId: entityId,
        parentTags: tagSet,
        scripts,
        usedKeys,
        baseDirs,
      }, nextId);
      entities.push(...childEntities);
    }
  }

  return entities;
}

// ─── Event definitions (read once, shared between validator + validation) ───

interface EventFieldDef { type: string; optional?: boolean; }
interface EventDef { fields: Record<string, EventFieldDef>; }

const _eventDefsCache = new Map<string, { defs: Record<string, EventDef>; names: Set<string> }>();

/**
 * Drop the cached event-definition parse for a given systems dir. Called
 * by project_builder right after hydrating the project files — now that
 * event_definitions.ts is user-editable (CREATE_GAME agent can append
 * game-specific events), we can't assume the on-disk content matches
 * the parse from the previous build.
 */
export function invalidateEventDefsCache(systemsDir?: string): void {
    if (systemsDir) _eventDefsCache.delete(systemsDir);
    else _eventDefsCache.clear();
}

function loadGameEventDefs(systemsDir?: string): { defs: Record<string, EventDef>; names: Set<string> } | null {
  const dir = systemsDir || SYSTEMS_DIR;
  const cached = _eventDefsCache.get(dir);
  if (cached) return cached;
  try {
    const evtSrc = fs.readFileSync(path.join(dir, 'event_definitions.ts'), 'utf-8');
    // Extract event names from GAME_EVENTS keys
    const nameMatches = evtSrc.matchAll(/^\s+(\w+)\s*:\s*\{/gm);
    const names = new Set<string>();
    for (const m of nameMatches) names.add(m[1]);
    // Remove non-event keys like 'fields', 'type', 'optional'
    for (const nonEvent of ['fields', 'type', 'optional']) names.delete(nonEvent);
    if (names.size === 0) return null;

    // Parse field schemas from source
    const defs: Record<string, EventDef> = {};
    for (const name of names) {
      // Match: event_name: { fields: { fieldName: { type: 'xxx', optional: true }, ... } }
      const fieldRegex = new RegExp(`${name}\\s*:\\s*\\{\\s*fields\\s*:\\s*\\{([^}]*)\\}`, 's');
      const fieldMatch = evtSrc.match(fieldRegex);
      const fields: Record<string, EventFieldDef> = {};
      if (fieldMatch && fieldMatch[1].trim()) {
        const fieldEntries = fieldMatch[1].matchAll(/(\w+)\s*:\s*\{([^}]*)\}/g);
        for (const fe of fieldEntries) {
          const fieldName = fe[1];
          const typeMatch = fe[2].match(/type\s*:\s*'(\w+)'/);
          const optMatch = fe[2].match(/optional\s*:\s*true/);
          fields[fieldName] = { type: typeMatch?.[1] || 'any', optional: !!optMatch };
        }
      }
      defs[name] = { fields };
    }

    const result = { defs, names };
    _eventDefsCache.set(dir, result);
    return result;
  } catch {}
  return null;
}

// ─── Main assembler ────────────────────────────────────────────────────────

function normalizeFlowUIActions(states: Record<string, any>): void {
  for (const state of Object.values(states) as any[]) {
    for (const key of ['on_enter', 'on_exit', 'on_update', 'on_timeout'] as const) {
      const list = state[key];
      if (!Array.isArray(list)) continue;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (typeof a !== 'string') continue;
        for (const verb of ['show_ui:', 'hide_ui:'] as const) {
          if (a.startsWith(verb) && a.endsWith('.html')) {
            list[i] = a.slice(0, -'.html'.length);
            break;
          }
        }
      }
    }
    if (state.substates) normalizeFlowUIActions(state.substates);
  }
}

let _nameCounters: Record<string, number> = {};

export function assembleGame(gamePath: string, baseDirs?: { behaviors: string; systems: string; ui: string }): ConvertedScene {
  _nameCounters = {};

  // Load template files
  const flow = loadJSON(gamePath, '01_flow.json');
  const entityDefs = loadJSON(gamePath, '02_entities.json');
  const worlds = loadJSON(gamePath, '03_worlds.json');
  const systemsDef = loadJSON(gamePath, '04_systems.json');

  // Normalize `show_ui:`/`hide_ui:` action panels: convention is the panel name
  // without `.html` (e.g. `show_ui:hud/health`). LLM-generated flows sometimes
  // emit the extension, which breaks the runtime ui_bridge (its visibility flag
  // is derived from the raw panel string) and defeats validation below. Must
  // run before generateFSMDriver bakes the flow into the runtime script.
  if (flow?.states) normalizeFlowUIActions(flow.states);

  // Auto-heal Play-Again-shaped transitions that don't reset state. Many
  // existing user games (and 17 shipped templates pre-fix) wired
  // `ui_event:game_over:play_again → playing` without `restart` in the
  // actions array, so score / lives / spawned entities leaked across
  // runs. We append `restart` in-memory so the assembled FSM driver
  // emits `game.restart_game` on Play Again, which triggers the
  // engine-level _vars reset + `runtime`-tagged-entity sweep. The
  // user's `01_flow.json` on disk is not modified.
  if (flow?.states) normalizeRetryFlow(flow);

  // Hard-error check for things we can't auto-heal: panel-button-name
  // mismatches (the flow listens for ui_event:<panel>:<action> but the
  // panel HTML doesn't emit that action). Pressing the button does
  // nothing — silent dead UI.
  const retryErrors = checkRetryFlowWiring(gamePath);
  if (retryErrors.length > 0) {
    throw new Error('Retry / UI-wiring errors:\n  - ' + retryErrors.join('\n  - '));
  }

  const entities: any[] = [];
  const scripts: Record<string, string> = {};
  const uiFiles: Record<string, string> = {};
  const usedKeys = new Set<string>();
  const missingScripts = new Set<string>();
  const nextId = { value: 1 };

  const defs: Record<string, any> = entityDefs?.definitions || {};
  const systems: Record<string, SystemDef> = systemsDef?.systems || {};

  // UI bridge is always injected
  if (!systems['ui']) {
    systems['ui'] = { description: 'HUD, menus, virtual cursor', script: 'ui/ui_bridge.ts' };
  }

  // Multiplayer bridge is auto-injected for multiplayer-enabled games so the
  // template doesn't have to remember to declare it. Kept always-active like
  // the ui bridge — the session survives flow state changes.
  const mpEnabled = !!(flow?.multiplayer && (flow.multiplayer.enabled !== false));
  if (mpEnabled && !systems['mp_bridge']) {
    systems['mp_bridge'] = { description: 'Multiplayer session bridge', script: 'mp/mp_bridge.ts' };
  }

  // Register shared scripts
  scripts[ENTITY_LABEL_KEY] = getEntityLabelCode(baseDirs?.systems);
  usedKeys.add(ENTITY_LABEL_KEY);

  // Event validator — enforces strict event names on the game bus at runtime
  const eventData = loadGameEventDefs(baseDirs?.systems);
  const validEvents = eventData?.names || null;
  if (validEvents) {
    const eventNames = [...validEvents];
    scripts['scripts/_event_validator.ts'] = `class EventValidator extends GameScript {
    onStart() {
        var validEvents = new Set(${JSON.stringify(eventNames)});
        if (this.scene.events && this.scene.events.game && this.scene.events.game.setValidEvents) {
            this.scene.events.game.setValidEvents(validEvents);
        }
    }
}`;
    usedKeys.add('scripts/_event_validator.ts');

    entities.push({
      id: nextId.value++,
      name: 'Event Validator',
      components: [
        { type: 'TransformComponent', data: { position: { x: 0, y: 0, z: 0 } } },
        { type: 'ScriptComponent', data: { scriptURL: 'scripts/_event_validator.ts' } },
      ],
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 1. Manager entities
  // ════════════════════════════════════════════════════════════════════════════

  const managersParentId = nextId.value++;
  entities.push({
    id: managersParentId,
    name: 'Systems',
    components: [{ type: 'TransformComponent', data: { position: { x: 0, y: 0, z: 0 } } }],
    tags: ['managers_root'],
  });

  // Game Manager — holds flow FSM
  if (flow?.states) {
    const flowConfig = flow.config || flow;
    (flowConfig as any)._entityKey = 'GameManager';
    if (flow.ui_params) (flowConfig as any)._uiParams = flow.ui_params;

    const driverKey = 'scripts/fsm_driver_GameManager.ts';
    scripts[driverKey] = generateFSMDriver('GameManager', [flowConfig], baseDirs?.systems);
    usedKeys.add(driverKey);

    entities.push({
      id: nextId.value++,
      name: 'Game Manager',
      components: [
        { type: 'TransformComponent', data: { position: { x: 0, y: 0, z: 0 } } },
        { type: 'ScriptComponent', data: { scriptURL: driverKey } },
      ],
      tags: ['manager'],
      parentId: managersParentId,
    });
  }

  // One entity per system from 04_systems.json
  for (const [sysName, sys] of Object.entries(systems)) {
    const entityName = sysName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') + ' Manager';
    const key = loadSystemScript(sys, entityName, scripts, usedKeys, baseDirs?.behaviors, baseDirs?.systems, missingScripts);

    const sysEntity: any = {
      id: nextId.value++,
      name: entityName,
      active: sysName === 'ui' || sysName === 'mp_bridge',
      components: [{ type: 'TransformComponent', data: { position: { x: 0, y: 0, z: 0 } } }],
      tags: ['manager', `system_${sysName}`],
      parentId: managersParentId,
    };
    if (key) {
      sysEntity.components.push({ type: 'ScriptComponent', data: buildScriptData([key], { _systemName: sysName }) });
    }
    entities.push(sysEntity);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 2. World entities from placements
  // ════════════════════════════════════════════════════════════════════════════

  const world = worlds?.worlds?.[0];

  // Directional light — pitched down, yawed for sun-like angle. Shadow
  // distance can be overridden per-world via world.lighting.shadowDistance
  // (open-world templates raise it to 800-1000 for long sight lines; the
  // default serves arena-scale scenes with sharp shadows).
  const lightData: any = {
    lightType: 'directional',
    intensity: 1.0,
    color: world?.lighting?.sun_color || [1, 1, 1],
  };
  if (typeof world?.lighting?.shadowDistance === 'number') {
    lightData.shadowDistance = world.lighting.shadowDistance;
  }
  entities.push({
    id: nextId.value++,
    name: 'Directional Light',
    components: [
      { type: 'TransformComponent', data: { position: { x: 0, y: 10, z: 0 }, rotation: eulerDegreesToQuat(-30, -30, 0) } },
      { type: 'LightComponent', data: lightData },
    ],
  });

  // Placed entities
  for (const placement of (world?.placements || [])) {
    const def = defs[placement.ref];
    if (!def) {
      console.warn(`[assembler] Unknown entity ref: "${placement.ref}"`);
      continue;
    }

    const pos = placement.position || [0, 0, 0];

    const builtEntities = buildEntity({
      def,
      entityName: placement.name || nameFromRef(placement.ref, nextId.value),
      position: pos,
      rotation: placement.rotation,
      scale: placement.scale || def.mesh?.scale,
      scripts,
      usedKeys,
      baseDirs: baseDirs ? { behaviors: baseDirs.behaviors, systems: baseDirs.systems } : undefined,
      missingScripts,
      placementMeta: placement.meta,
      placementOverrides: {
        materialOverrides: placement.material_overrides,
        extraComponents: placement.extra_components,
        extraTags: placement.tags,
        active: placement.active,
      },
    }, nextId);
    entities.push(...builtEntities);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 3. UI files
  // ════════════════════════════════════════════════════════════════════════════

  const walkUI = (dir: string, prefix: string = '') => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walkUI(path.join(dir, entry.name), prefix + entry.name + '/');
      } else if (entry.name.endsWith('.html')) {
        const key = `ui/${prefix}${entry.name}`;
        try { uiFiles[key] = fs.readFileSync(path.join(dir, entry.name), 'utf-8'); } catch {}
      }
    }
  };
  walkUI(baseDirs?.ui || UI_DIR);

  // ════════════════════════════════════════════════════════════════════════════
  // 4. Build-time validation
  // ════════════════════════════════════════════════════════════════════════════

  // Multiplayer config. Supports both the legacy flat shape
  // (flow.max_players / flow.min_players) and the richer nested block:
  //
  //   "multiplayer": {
  //     "enabled": true,
  //     "minPlayers": 2,
  //     "maxPlayers": 8,
  //     "tickRate": 30,
  //     "authority": "host",
  //     "predictLocalPlayer": true,
  //     "hostPlaysGame": true
  //   }
  //
  // Cap on maxPlayers is 16 (peer-to-peer star topology limit).
  let multiplayerConfig: MultiplayerConfig | undefined;
  const mpBlock: any = flow?.multiplayer;
  if (mpBlock && typeof mpBlock === 'object') {
    multiplayerConfig = {};
    multiplayerConfig.enabled = mpBlock.enabled !== false;
    multiplayerConfig.maxPlayers = Math.max(1, Math.min(16, Number(mpBlock.maxPlayers) || 2));
    multiplayerConfig.minPlayers = Math.max(1, Math.min(multiplayerConfig.maxPlayers, Number(mpBlock.minPlayers) || 1));
    multiplayerConfig.tickRate = Math.max(5, Math.min(120, Math.floor(Number(mpBlock.tickRate) || 30)));
    multiplayerConfig.authority = 'host';
    multiplayerConfig.predictLocalPlayer = mpBlock.predictLocalPlayer !== false;
    multiplayerConfig.hostPlaysGame = mpBlock.hostPlaysGame !== false;
    // remotePlayerPrefab: null opt-out OR a prefab name string.
    // undefined means "use the blue-capsule fallback" for back-compat.
    if (mpBlock.remotePlayerPrefab === null) {
      multiplayerConfig.remotePlayerPrefab = null;
    } else if (typeof mpBlock.remotePlayerPrefab === 'string' && mpBlock.remotePlayerPrefab.length > 0) {
      multiplayerConfig.remotePlayerPrefab = mpBlock.remotePlayerPrefab;
    }
    multiplayerConfig.allowJoinInProgress = mpBlock.allowJoinInProgress === true;
  } else if (flow?.max_players || flow?.min_players) {
    multiplayerConfig = {
      enabled: true,
      authority: 'host',
      predictLocalPlayer: true,
      hostPlaysGame: true,
      tickRate: 30,
    };
    if (flow.max_players) multiplayerConfig.maxPlayers = Math.max(1, Math.min(16, Number(flow.max_players)));
    if (flow.min_players) multiplayerConfig.minPlayers = Math.max(1, Math.min(multiplayerConfig.maxPlayers ?? 16, Number(flow.min_players)));
  }

  // Event validation
  if (validEvents) {
    const errors: string[] = [];
    const gameEventsEmitted = new Set<string>();

    const eventDefs = eventData?.defs || {};

    // Validate script event references + payload fields
    for (const [scriptKey, source] of Object.entries(scripts)) {
      if (scriptKey === 'scripts/_event_validator.ts') continue;

      // Check event names are valid
      for (const m of source.matchAll(/events\.game\.(?:on|emit)\s*\(\s*"([^"]+)"/g)) {
        if (!validEvents.has(m[1])) {
          errors.push(`${scriptKey}: unknown game event "${m[1]}"`);
        }
      }
      // Collect emitted events
      for (const m of source.matchAll(/events\.game\.emit\s*\(\s*"([^"]+)"/g)) {
        gameEventsEmitted.add(m[1]);
      }
      // Check game events wrongly on ui bus
      for (const m of source.matchAll(/events\.ui\.emit\s*\(\s*"([^"]+)"/g)) {
        if (validEvents.has(m[1])) {
          errors.push(`${scriptKey}: game event "${m[1]}" emitted on ui bus — should use events.game.emit`);
        }
      }
      // Validate emit payloads — check required fields are present
      for (const m of source.matchAll(/events\.game\.emit\s*\(\s*"([^"]+)"\s*,\s*(\{[^}]*\})/g)) {
        const evtName = m[1];
        const payloadStr = m[2];
        const def = eventDefs[evtName];
        if (!def) continue;
        for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
          if (!fieldDef.optional && payloadStr.indexOf(fieldName) < 0) {
            errors.push(`${scriptKey}: emit("${evtName}") missing required field "${fieldName}"`);
          }
        }
      }
    }

    // Validate flow emit actions + collect emitted events
    const validateFlowActions = (states: Record<string, any>, prefix: string = '') => {
      for (const [stateName, state] of Object.entries(states) as [string, any][]) {
        for (const actionList of [state.on_enter, state.on_exit, state.on_update, state.on_timeout]) {
          if (!Array.isArray(actionList)) continue;
          for (const action of actionList) {
            if (typeof action === 'string' && action.startsWith('emit:game.')) {
              const eventName = action.substring('emit:game.'.length);
              if (!validEvents.has(eventName)) {
                errors.push(`01_flow.json ${prefix}${stateName}: unknown game event "${eventName}"`);
              }
              gameEventsEmitted.add(eventName);
            }
          }
        }
        if (state.substates) validateFlowActions(state.substates, `${prefix}${stateName}/`);
      }
    };
    if (flow?.states) validateFlowActions(flow.states);

    // Add FSM driver built-in emits
    try {
      for (const m of getFSMDriverCode(baseDirs?.systems).matchAll(/_emitBus\s*\(\s*"game"\s*,\s*"([^"]+)"/g)) {
        gameEventsEmitted.add(m[1]);
      }
    } catch {}

    // Validate flow transition event references
    const validateTransitions = (states: Record<string, any>, prefix: string = '') => {
      for (const [stateName, state] of Object.entries(states) as [string, any][]) {
        for (const t of (state.transitions || [])) {
          const when = t.when || '';
          if (!when || /[>=<!]/.test(when)) continue;
          if (when === 'timer_expired' || when === 'random' || when.startsWith('random:')) continue;

          if (when.startsWith('game_event:')) {
            const eventName = when.substring('game_event:'.length);
            if (!validEvents.has(eventName)) {
              errors.push(`01_flow.json ${prefix}${stateName}: unknown game event "${eventName}" in "${when}"`);
            } else if (!gameEventsEmitted.has(eventName)) {
              console.warn(`[Assembler] Warning: 01_flow.json ${prefix}${stateName}: "${when}" — no script currently emits "${eventName}"`);
            }
          } else if (when.startsWith('ui_event:') || when.startsWith('keyboard:') || when.includes('.')) {
            // Validated separately or bus.event format
          } else if (!when.includes(':')) {
            errors.push(`01_flow.json ${prefix}${stateName}: bare event name "${when}" — use game_event:${when}, ui_event:panel:action, or keyboard:action`);
          }
        }
        if (state.substates) validateTransitions(state.substates, `${prefix}${stateName}/`);
      }
    };
    if (flow?.states) validateTransitions(flow.states);

    if (errors.length > 0) {
      console.error(`[Assembler] Event validation errors:\n  ${errors.join('\n  ')}`);
      throw new Error(`Event validation failed: ${errors.length} invalid event name(s). ${errors[0]}`);
    }
  }

  // Reference validation — missing behavior/system script files + missing UI panels
  {
    const refErrors: string[] = [];

    for (const scriptPath of missingScripts) {
      refErrors.push(`missing behavior/system file: ${scriptPath}`);
    }

    const uiPanelKeys = new Set(Object.keys(uiFiles));
    const validateUIRefs = (states: Record<string, any>, prefix: string = '') => {
      for (const [stateName, state] of Object.entries(states) as [string, any][]) {
        for (const actionList of [state.on_enter, state.on_exit, state.on_update, state.on_timeout]) {
          if (!Array.isArray(actionList)) continue;
          for (const action of actionList) {
            if (typeof action !== 'string') continue;
            let panel: string | null = null;
            if (action.startsWith('show_ui:')) panel = action.substring('show_ui:'.length);
            else if (action.startsWith('hide_ui:')) panel = action.substring('hide_ui:'.length);
            if (panel && !uiPanelKeys.has(`ui/${panel}.html`)) {
              refErrors.push(`01_flow.json ${prefix}${stateName}: missing UI panel "${panel}" (expected ui/${panel}.html)`);
            }
          }
        }
        if (state.substates) validateUIRefs(state.substates, `${prefix}${stateName}/`);
      }
    };
    if (flow?.states) validateUIRefs(flow.states);

    if (refErrors.length > 0) {
      console.error(`[Assembler] Reference validation errors:\n  ${refErrors.join('\n  ')}`);
      throw new Error(`Reference validation failed: ${refErrors.length} missing reference(s). ${refErrors[0]}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // FSM structural validation
  // ══════════════════════════════════════════════════════════════════════
  // Catches the silent-failure class where a CLI agent writes plausible-
  // looking `active_behaviors` / `active_systems` names that don't match
  // anything declared — the engine drops the reference and the game runs
  // with dead code (player can't move, enemies don't chase, etc.). Without
  // this check, validate.sh reports "all good" and the creator ships a
  // broken game. Surfaced by lawn-mower-survival 2026-04-18.
  {
    const validBehaviorNames = new Set<string>();
    for (const def of Object.values(defs)) {
      if (def?.behaviors) {
        for (const b of def.behaviors) {
          if (b?.name) validBehaviorNames.add(String(b.name));
        }
      }
    }
    // Valid system names = every key in `systems` (already includes auto-
    // injected `ui` and `mp_bridge` from earlier in this function).
    const validSystemNames = new Set<string>(Object.keys(systems));

    const structuralErrors: string[] = [];

    if (flow && flow.states) {
      if (!flow.start) {
        structuralErrors.push(
          `01_flow.json: missing required top-level "start" field — every flow needs an initial state name (e.g. "start": "boot"). See CREATOR_CONTEXT.md § "FSM structure — required fields".`,
        );
      }

      const walk = (states: Record<string, any>, prefix: string): void => {
        for (const [name, st] of Object.entries(states) as [string, any][]) {
          const path = prefix ? `${prefix}.${name}` : name;
          if (st?.substates && !st?.start) {
            structuralErrors.push(
              `01_flow.json state "${path}" is compound (has substates) but missing "start" — every compound state needs a starting substate name. See CREATOR_CONTEXT.md § "FSM structure — required fields".`,
            );
          }
          if (Array.isArray(st?.active_behaviors)) {
            for (const b of st.active_behaviors) {
              if (!validBehaviorNames.has(String(b))) {
                const valid = [...validBehaviorNames].sort().join(', ') || '(none declared — add behaviors with a `name` field in 02_entities.json)';
                structuralErrors.push(
                  `01_flow.json state "${path}" active_behaviors references unknown behavior "${b}". Every name here must match a behaviors[].name in 02_entities.json exactly. Valid names: ${valid}. See CREATOR_CONTEXT.md § "Silent-failure watch-list".`,
                );
              }
            }
          }
          if (Array.isArray(st?.active_systems)) {
            for (const s of st.active_systems) {
              if (!validSystemNames.has(String(s))) {
                const valid = [...validSystemNames].sort().join(', ');
                structuralErrors.push(
                  `01_flow.json state "${path}" active_systems references unknown system "${s}". Every name here must match a key in 04_systems.json (auto-injected "ui" and "mp_bridge" are always available). Valid names: ${valid}. See CREATOR_CONTEXT.md § "Silent-failure watch-list".`,
                );
              }
            }
          }
          if (st?.substates) walk(st.substates, path);
        }
      };
      walk(flow.states, '');
    }

    if (structuralErrors.length > 0) {
      console.error(`[Assembler] FSM structural validation errors:\n  ${structuralErrors.join('\n  ')}`);
      throw new Error(`FSM structural validation failed: ${structuralErrors.length} error(s). ${structuralErrors[0]}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // spawnEntity reference validation
  // ══════════════════════════════════════════════════════════════════════
  // Mirror of the events.game.emit("literal") check above: every literal
  // string passed to scene.spawnEntity(...) must match an entity key in
  // 02_entities.json, otherwise the runtime would throw at first call.
  // Catches the silent class where a CLI agent writes spawnEntity with a
  // typo or a name that was never declared (lawn-mower-survival 2026-04-18:
  // "spawnEntity('enemy_slime')" looked fine but no entities ever appeared).
  // Dynamic calls like spawnEntity(this._enemyTypes[i]) are invisible to
  // this regex — those need a __validatorManifest() stub that lists every
  // possible name as a literal call. See CREATOR_CONTEXT.md
  // § "Spawn entity — validator rule".
  {
    const validPrefabs = new Set(Object.keys(defs));
    const spawnErrors: string[] = [];
    for (const [scriptKey, source] of Object.entries(scripts)) {
      for (const m of source.matchAll(/\.spawnEntity\s*\(\s*['"]([^'"]+)['"]/g)) {
        const refName = m[1];
        if (!validPrefabs.has(refName)) {
          const valid = [...validPrefabs].sort().join(', ') || '(none — add entities to 02_entities.json definitions)';
          spawnErrors.push(
            `${scriptKey}: spawnEntity("${refName}") references unknown entity definition. ` +
              `Names must match a key in 02_entities.json "definitions" exactly. ` +
              `Valid names: ${valid}. ` +
              `For dynamic spawn pools, declare every possible name as a literal in a __validatorManifest() stub. ` +
              `See CREATOR_CONTEXT.md § "Spawn entity — validator rule".`,
          );
        }
      }
    }
    if (spawnErrors.length > 0) {
      console.error(`[Assembler] spawnEntity validation errors:\n  ${spawnErrors.join('\n  ')}`);
      throw new Error(`spawnEntity validation failed: ${spawnErrors.length} error(s). ${spawnErrors[0]}`);
    }
  }

  // UI button validation
  {
    const panelButtons = new Map<string, Set<string>>();
    for (const [uiPath, html] of Object.entries(uiFiles)) {
      const panelName = uiPath.replace('ui/', '').replace('.html', '');
      const buttons = new Set<string>();
      for (const m of html.matchAll(/emit\s*\(\s*['"]([^'"]+)['"]/g)) buttons.add(m[1]);
      if (buttons.size > 0) panelButtons.set(panelName, buttons);
    }

    const uiErrors: string[] = [];
    const validateUI = (states: Record<string, any>, prefix: string = '') => {
      for (const [stateName, state] of Object.entries(states) as [string, any][]) {
        for (const t of (state.transitions || [])) {
          const when = t.when || '';
          if (!when.startsWith('ui_event:')) continue;
          const parts = when.substring('ui_event:'.length).split(':');
          if (parts.length !== 2) {
            uiErrors.push(`${prefix}${stateName}: malformed ui_event "${when}" (expected ui_event:panel:action)`);
            continue;
          }
          const [panel, action] = parts;
          const buttons = panelButtons.get(panel);
          if (!buttons) {
            uiErrors.push(`${prefix}${stateName}: ui_event references panel "${panel}" but no buttons found in ${panel}.html`);
          } else if (!buttons.has(action)) {
            uiErrors.push(`${prefix}${stateName}: ui_event references button "${action}" but ${panel}.html only has: ${[...buttons].join(', ')}`);
          }
        }
        if (state.substates) validateUI(state.substates, `${prefix}${stateName}/`);
      }
    };
    if (flow?.states) validateUI(flow.states);

    if (uiErrors.length > 0) {
      console.error(`[Assembler] UI button validation errors:\n  ${uiErrors.join('\n  ')}`);
      throw new Error(`UI button validation failed: ${uiErrors.length} error(s). ${uiErrors[0]}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // hud_update key collision validation
  // ══════════════════════════════════════════════════════════════════════
  // The FSM driver merges `phase` (current FSM state name) and every
  // `set:<var>=` variable declared in 01_flow.json into HUD state every
  // frame via state_changed. If a system also emits those keys in
  // hud_update, the FSM overwrites them on the very next tick and the HUD
  // appears frozen or wrong. Discovered via a card-game post-mortem where
  // `phase` was used for both FSM state and battle phase (main/battle/ai).
  // See CREATOR_CONTEXT.md § "Reserved state keys — DO NOT reuse".
  {
    const reservedKeys = new Set<string>(['phase']);
    const collectSetVars = (states: Record<string, any>): void => {
      for (const state of Object.values(states) as any[]) {
        const actions: string[] = [
          ...(state?.on_enter || []),
          ...(state?.on_exit || []),
          ...(state?.on_update || []),
          ...((state?.transitions || []).flatMap((t: any) => t?.actions || [])),
        ];
        for (const a of actions) {
          const m = String(a).match(/^set:([A-Za-z_]\w*)\s*=/);
          if (m) reservedKeys.add(m[1]);
        }
        if (state?.substates) collectSetVars(state.substates);
      }
    };
    if (flow?.states) collectSetVars(flow.states);

    // Walk the top level of a JS object literal `{ ... }` and return the
    // key identifiers. Handles nested objects/arrays/parens, strings,
    // and comments, but not computed keys (`[expr]: v`) — those are rare
    // in hud_update payloads.
    const topLevelKeys = (literal: string): string[] => {
      const body = literal.slice(1, -1);
      const out: string[] = [];
      let depth = 0, i = 0;
      let inStr = false, strCh = '';
      let inLine = false, inBlock = false;
      while (i < body.length) {
        const c = body[i], n = body[i + 1];
        if (inLine) { if (c === '\n') inLine = false; i++; continue; }
        if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 2; continue; } i++; continue; }
        if (inStr) {
          if (c === '\\') { i += 2; continue; }
          if (c === strCh) inStr = false;
          i++; continue;
        }
        if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
        if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
        if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; i++; continue; }
        if (c === '{' || c === '[' || c === '(') { depth++; i++; continue; }
        if (c === '}' || c === ']' || c === ')') { depth--; i++; continue; }
        if (depth === 0) {
          const m = body.slice(i).match(/^(?:['"]([A-Za-z_$][\w$]*)['"]|([A-Za-z_$][\w$]*))\s*:/);
          if (m) { out.push(m[1] || m[2]); i += m[0].length; continue; }
        }
        i++;
      }
      return out;
    };

    const hudErrors: string[] = [];
    for (const [scriptKey, source] of Object.entries(scripts)) {
      const re = /events\.ui\.emit\s*\(\s*['"]hud_update['"]\s*,\s*\{/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        const openIdx = match.index + match[0].length - 1;
        let depth = 0, end = -1;
        for (let i = openIdx; i < source.length; i++) {
          if (source[i] === '{') depth++;
          else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end < 0) continue;
        const literal = source.slice(openIdx, end + 1);
        for (const k of topLevelKeys(literal)) {
          if (reservedKeys.has(k)) {
            const suggest = 'battle' + k[0].toUpperCase() + k.slice(1);
            hudErrors.push(
              `${scriptKey}: hud_update key "${k}" collides with an FSM-reserved state key. ` +
              `The FSM driver merges "${k}" into HUD state every frame from state_changed — your value will be overwritten on the next tick. ` +
              `Rename to a scoped key (e.g. "${suggest}", "match${k[0].toUpperCase() + k.slice(1)}"). ` +
              `Reserved names in this flow: ${[...reservedKeys].sort().join(', ')}. ` +
              `See CREATOR_CONTEXT.md § "Reserved state keys — DO NOT reuse".`,
            );
          }
        }
      }
    }
    if (hudErrors.length > 0) {
      console.error(`[Assembler] hud_update key validation errors:\n  ${hudErrors.join('\n  ')}`);
      throw new Error(`hud_update key validation failed: ${hudErrors.length} error(s). ${hudErrors[0]}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Inline onclick → IIFE-scope validation
  // ══════════════════════════════════════════════════════════════════════
  // Inline onclick="fn(...)" attrs look up `fn` on the global/window
  // scope. If the panel's <script> is wrapped in an IIFE, every function
  // defined inside (including `send`, `emit`, custom handlers) is trapped
  // in that closure and unreachable from inline onclicks — clicks fire
  // ReferenceError with no visible UI feedback. Seen in card-game
  // post-mortem: creator correctly did `window.onPlayerZone = ...` but
  // left `send` inside the IIFE while 3 buttons called `onclick="send(...)"`.
  // See CREATOR_CONTEXT.md § "Inline onclick and IIFE scoping".
  {
    const onclickErrors: string[] = [];
    for (const [uiPath, html] of Object.entries(uiFiles)) {
      const scriptBlocks: string[] = [];
      for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) scriptBlocks.push(m[1]);
      // IIFE heuristic: first non-whitespace/comment token opens with
      // `(function`, `(() =>`, or `!function`. Covers the common patterns
      // creators produce.
      const isIIFE = (s: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(?:\(\s*(?:function\b|\(\s*\)\s*=>)|!function\b)/.test(s);
      if (!scriptBlocks.some(isIIFE)) continue;
      // Names exposed to window across any script block in this panel.
      const exposed = new Set<string>();
      for (const s of scriptBlocks) {
        for (const m of s.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) exposed.add(m[1]);
      }
      // Names defined at top level in a NON-IIFE sibling script — those
      // are implicitly global in an HTML <script> and are fine.
      for (const s of scriptBlocks) {
        if (isIIFE(s)) continue;
        for (const m of s.matchAll(/(?:^|\n)\s*(?:function\s+|var\s+|let\s+|const\s+)([A-Za-z_$][\w$]*)\b/g)) exposed.add(m[1]);
      }
      // onclick handler names, ignoring method-call forms like obj.fn()
      const onclickNames = new Set<string>();
      for (const m of html.matchAll(/onclick\s*=\s*["']\s*([A-Za-z_$][\w$]*)\s*\(/gi)) onclickNames.add(m[1]);
      for (const name of onclickNames) {
        if (exposed.has(name)) continue;
        onclickErrors.push(
          `${uiPath}: onclick="${name}(...)" references a function that isn't exposed on window. ` +
          `The panel's <script> is wrapped in an IIFE, so "${name}" is captured in that closure and unreachable from inline onclick attrs. ` +
          `Fix: either add "window.${name} = ${name};" inside the IIFE, or replace the onclick with addEventListener('click', ...). ` +
          `See CREATOR_CONTEXT.md § "Inline onclick and IIFE scoping".`,
        );
      }
    }
    if (onclickErrors.length > 0) {
      console.error(`[Assembler] Inline-onclick IIFE validation errors:\n  ${onclickErrors.join('\n  ')}`);
      throw new Error(`Inline-onclick IIFE validation failed: ${onclickErrors.length} error(s). ${onclickErrors[0]}`);
    }
  }

  const heightmapTerrain = worlds?.worlds?.[0]?.heightmapTerrain;
  const streamedBuildings = worlds?.worlds?.[0]?.streamedBuildings;
  const environment = worlds?.worlds?.[0]?.environment;

  // ══════════════════════════════════════════════════════════════════════
  // Inline terrain validation
  // ══════════════════════════════════════════════════════════════════════
  if (heightmapTerrain && heightmapTerrain.layers && heightmapTerrain.size) {
    const terrainErrors: string[] = [];
    const ht = heightmapTerrain;
    if (!Array.isArray(ht.size) || ht.size.length !== 2 || ht.size[0] <= 0 || ht.size[1] <= 0) {
      terrainErrors.push('heightmapTerrain.size must be [width, depth] with positive values');
    }
    if (!Array.isArray(ht.layers) || ht.layers.length < 1 || ht.layers.length > 4) {
      terrainErrors.push('heightmapTerrain.layers must have 1-4 entries');
    }
    const layerNames = new Set<string>();
    if (Array.isArray(ht.layers)) {
      for (const layer of ht.layers) {
        if (!layer.name || !layer.dir) {
          terrainErrors.push(`heightmapTerrain layer missing "name" or "dir": ${JSON.stringify(layer)}`);
        } else {
          layerNames.add(layer.name);
        }
        if (typeof layer.uvMetersPerTile !== 'number' || layer.uvMetersPerTile <= 0) {
          terrainErrors.push(`heightmapTerrain layer "${layer.name}": uvMetersPerTile must be a positive number`);
        }
      }
    }
    if (ht.default_layer && !layerNames.has(ht.default_layer)) {
      terrainErrors.push(`heightmapTerrain.default_layer "${ht.default_layer}" not found in layers: [${[...layerNames].join(', ')}]`);
    }
    for (const paint of (ht.paints || [])) {
      if (!layerNames.has(paint.layer)) {
        terrainErrors.push(`heightmapTerrain paint references unknown layer "${paint.layer}". Valid: [${[...layerNames].join(', ')}]`);
      }
    }
    for (const pathSpec of (ht.paths || [])) {
      if (!layerNames.has(pathSpec.layer)) {
        terrainErrors.push(`heightmapTerrain path references unknown layer "${pathSpec.layer}". Valid: [${[...layerNames].join(', ')}]`);
      }
      if (!Array.isArray(pathSpec.points) || pathSpec.points.length < 2) {
        terrainErrors.push('heightmapTerrain path must have at least 2 points');
      }
    }
    // Elevation: optional. Validate the same shape the runtime baker
    // expects so stale/typo'd configs trip here instead of producing
    // silently-flat ground at runtime.
    if (ht.elevation) {
      const ev = ht.elevation;
      if (typeof ev !== 'object' || Array.isArray(ev)) {
        terrainErrors.push('heightmapTerrain.elevation must be an object');
      } else {
        if (ev.resolution !== undefined && (typeof ev.resolution !== 'number' || ev.resolution < 32 || ev.resolution > 512)) {
          terrainErrors.push('heightmapTerrain.elevation.resolution must be a number 32–512');
        }
        if (ev.max_height !== undefined && (typeof ev.max_height !== 'number' || ev.max_height <= 0)) {
          terrainErrors.push('heightmapTerrain.elevation.max_height must be a positive number');
        }
        if (ev.noise) {
          if (typeof ev.noise !== 'object') terrainErrors.push('heightmapTerrain.elevation.noise must be an object');
          else {
            if (typeof ev.noise.amplitude !== 'number' || ev.noise.amplitude < 0) {
              terrainErrors.push('heightmapTerrain.elevation.noise.amplitude must be a non-negative number');
            }
            if (ev.noise.seed !== undefined && (typeof ev.noise.seed !== 'number' || !isFinite(ev.noise.seed))) {
              terrainErrors.push('heightmapTerrain.elevation.noise.seed must be a finite number');
            }
            if (ev.noise.octaves !== undefined && (typeof ev.noise.octaves !== 'number' || ev.noise.octaves < 1 || ev.noise.octaves > 8)) {
              terrainErrors.push('heightmapTerrain.elevation.noise.octaves must be a number 1–8');
            }
            if (ev.noise.frequency !== undefined && (typeof ev.noise.frequency !== 'number' || ev.noise.frequency <= 0 || ev.noise.frequency > 0.5)) {
              terrainErrors.push('heightmapTerrain.elevation.noise.frequency must be a number > 0 and ≤ 0.5 (typical 0.005–0.05)');
            }
          }
        }
        for (const hill of (ev.hills || [])) {
          if (hill.shape !== 'circle' && hill.shape !== 'rect') {
            terrainErrors.push(`heightmapTerrain.elevation.hills[].shape must be "circle" or "rect" — "polygon" is not supported here (got "${hill.shape}")`);
          }
          if (hill.shape === 'circle' && (typeof hill.radius !== 'number' || hill.radius <= 0)) {
            terrainErrors.push('heightmapTerrain.elevation.hills[]: circle requires a positive "radius"');
          }
          if (hill.shape === 'rect' && (!Array.isArray(hill.size) || hill.size.length !== 2 || hill.size[0] <= 0 || hill.size[1] <= 0)) {
            terrainErrors.push('heightmapTerrain.elevation.hills[]: rect requires "size": [width, depth] with positive values');
          }
          if (typeof hill.height !== 'number' || !isFinite(hill.height)) {
            terrainErrors.push('heightmapTerrain.elevation.hills[].height must be a finite number (negative = depression)');
          }
          if (!Array.isArray(hill.center) || hill.center.length !== 2) {
            terrainErrors.push('heightmapTerrain.elevation.hills[].center must be [x, z]');
          }
        }
        for (const zone of (ev.flat_zones || [])) {
          if (zone.shape !== 'circle' && zone.shape !== 'rect') {
            terrainErrors.push(`heightmapTerrain.elevation.flat_zones[].shape must be "circle" or "rect" — "polygon" is not supported here (got "${zone.shape}")`);
          }
          if (zone.shape === 'circle' && (typeof zone.radius !== 'number' || zone.radius <= 0)) {
            terrainErrors.push('heightmapTerrain.elevation.flat_zones[]: circle requires a positive "radius"');
          }
          if (zone.shape === 'rect' && (!Array.isArray(zone.size) || zone.size.length !== 2 || zone.size[0] <= 0 || zone.size[1] <= 0)) {
            terrainErrors.push('heightmapTerrain.elevation.flat_zones[]: rect requires "size": [width, depth] with positive values');
          }
          if (zone.height !== undefined && (typeof zone.height !== 'number' || !isFinite(zone.height))) {
            terrainErrors.push('heightmapTerrain.elevation.flat_zones[].height must be a finite number');
          }
          if (!Array.isArray(zone.center) || zone.center.length !== 2) {
            terrainErrors.push('heightmapTerrain.elevation.flat_zones[].center must be [x, z]');
          }
        }
      }
    }
    if (terrainErrors.length > 0) {
      console.error(`[Assembler] Inline terrain validation errors:\n  ${terrainErrors.join('\n  ')}`);
      throw new Error(`Inline terrain validation failed: ${terrainErrors.length} error(s). ${terrainErrors[0]}`);
    }
  }

  // Emit every entity definition as a prefab blueprint so the runtime
  // can instantiate them on demand (e.g. the network adapter building a
  // remote-player avatar). Each blueprint is the same shape as an
  // entry in `entities` — a fully-assembled component bundle — but
  // with id/parentId stripped since those are assigned at spawn time.
  //
  // We run buildEntity with a zero position/rotation, separate `scripts`
  // and `usedKeys` collections so the blueprint doesn't churn the
  // deduped script bundle (all script keys referenced here are already
  // present from the regular placement pass above).
  const prefabs: Record<string, any> = {};
  const prefabIds = { value: 1_000_000_000 };  // isolated id space — prefab blueprints are templates, not scene entities.
  for (const [prefabName, def] of Object.entries(defs)) {
    try {
      const built = buildEntity({
        def,
        entityName: prefabName,
        position: [0, 0, 0],
        scripts,
        usedKeys,
        baseDirs: baseDirs ? { behaviors: baseDirs.behaviors, systems: baseDirs.systems } : undefined,
      }, prefabIds);
      if (built.length > 0) {
        const blueprint = built[0];
        // Strip id/parentId so the runtime assigns fresh ones per spawn.
        delete blueprint.id;
        delete blueprint.parentId;
        // Child blueprints (if any) are siblings in `built[1..]`; drop them for v1.
        // Most prefabs we care about (players, coins, walls) don't use children.
        prefabs[prefabName] = blueprint;
      }
    } catch (e: any) {
      console.warn(`[assembler] Failed to build prefab "${prefabName}":`, e?.message || e);
    }
  }

  // Mobile controls manifest. Static shape validation runs here so a
  // typo'd preset / invalid type / reserved-key-in-actions[] fails the
  // build with a precise error instead of silently degrading at
  // runtime. Runtime semantic checks ("does every script-read key
  // have a binding?") live in the headless playtest invariant
  // `mobile_controls_complete`.
  let controlsManifest: ControlsManifest | undefined;
  if (flow && Object.prototype.hasOwnProperty.call(flow, 'controls')) {
    const validationErrors = validateControlManifest(flow.controls);
    if (validationErrors.length > 0) {
      console.error(`[Assembler] controls manifest validation errors:\n  ${validationErrors.join('\n  ')}`);
      throw new Error(`01_flow.json:controls validation failed: ${validationErrors[0]}${validationErrors.length > 1 ? ` (+${validationErrors.length - 1} more)` : ''}`);
    }
    if (typeof flow.controls === 'object' && flow.controls) {
      controlsManifest = flow.controls as ControlsManifest;
    }
  }

  return { entities, scripts, uiFiles, prefabs, multiplayerConfig, environment, heightmapTerrain, streamedBuildings, controlsManifest };
}

// ─── File loading helpers ──────────────────────────────────────────────────

function loadJSON(gamePath: string, filename: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(gamePath, filename), 'utf-8'));
  } catch {
    return null;
  }
}

function nameFromRef(ref: string, id: number): string {
  const base = ref.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  if (!_nameCounters[ref]) _nameCounters[ref] = 0;
  _nameCounters[ref]++;
  return _nameCounters[ref] === 1 ? base : `${base} ${_nameCounters[ref]}`;
}

export function isGameTemplate(folderPath: string): boolean {
  try {
    const files = fs.readdirSync(folderPath);
    return files.includes('01_flow.json') && files.includes('02_entities.json');
  } catch {
    return false;
  }
}
