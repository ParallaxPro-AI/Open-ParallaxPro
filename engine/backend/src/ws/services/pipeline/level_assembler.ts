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

export interface ConvertedScene {
  entities: any[];
  scripts: Record<string, string>;
  uiFiles: Record<string, string>;
  multiplayerConfig?: { maxPlayers?: number; minPlayers?: number };
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
): string | null {
  let code = tryLoadScript(sys.script, behaviorsDir, systemsDir);
  if (!code) {
    const className = safeName(path.basename(sys.script, '.ts'))
      .replace(/(^|_)([a-z])/g, (_m: string, _p: string, c: string) => c.toUpperCase());
    code = `class ${className || 'GeneratedScript'} extends GameScript {\n    onStart() {}\n    onUpdate(dt) {}\n}\n`;
  }
  if (sys.params && Object.keys(sys.params).length > 0) {
    code = injectParams(code, sys.params);
  }
  const key = makeScriptKey(sys.script, entityName, usedKeys);
  usedKeys.add(key);
  scripts[key] = code;
  return key;
}

// ─── FSM driver generation ─────────────────────────────────────────────────

let _fsmDriverCode: string | null = null;
function getFSMDriverCode(systemsDir?: string): string {
  if (!systemsDir && _fsmDriverCode) return _fsmDriverCode;
  const dir = systemsDir || SYSTEMS_DIR;
  let code: string;
  try {
    code = fs.readFileSync(path.join(dir, 'fsm_driver.ts'), 'utf-8');
  } catch {
    code = 'class FSMDriver extends GameScript {}';
  }
  if (!systemsDir) _fsmDriverCode = code;
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
let _entityLabelCode: string | null = null;
function getEntityLabelCode(): string {
  if (_entityLabelCode) return _entityLabelCode;
  try {
    _entityLabelCode = fs.readFileSync(path.join(SYSTEMS_DIR, '_entity_label.ts'), 'utf-8');
  } catch {
    _entityLabelCode = `class EntityLabel extends GameScript { onStart() {} onUpdate(dt) {} }`;
  }
  return _entityLabelCode;
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
  placementMeta?: Record<string, any>;
}

function buildEntity(config: EntityBuildConfig, nextId: { value: number }): any[] {
  const { def, entityName, position, parentId, parentTags, scripts, usedKeys, baseDirs, placementMeta } = config;
  const rotation = config.rotation || [0, 0, 0];
  const entities: any[] = [];

  const isCustomMesh = def.mesh?.type === 'custom' && def.mesh?.asset;
  const meshScale = config.scale || def.mesh?.scale || [1, 1, 1];

  const entityId = nextId.value++;
  const tags: string[] = def.tags || [];
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
    // Texture overrides
    if (def.mesh_override) {
      meshData.materialOverrides = { ...def.mesh_override };
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

  // Physics — auto-assigned for all mesh entities (skip cameras)
  if (def.mesh && !tagSet.has('camera') && def.physics !== false) {
    const p = def.physics || {};
    components.push({ type: 'RigidbodyComponent', data: {
      bodyType: p.type || 'static',
      mass: p.mass || 1,
      freezeRotation: p.freeze_rotation || false,
    }});
    // Collider shape: explicit override > mesh-based default
    const colShape = p.collider
      || (isCustomMesh ? 'mesh' : (def.mesh?.type === 'sphere' ? 'sphere' : 'box'));
    const colData: any = { shapeType: colShape };
    if (colShape === 'capsule') {
      colData.radius = 0.5;
      colData.height = 1.0;
    } else if (colShape === 'sphere') {
      colData.radius = 0.5;
    } else {
      colData.size = { x: 1, y: 1, z: 1 };
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
      const key = loadSystemScript(behWithName as SystemDef, entityName, scripts, usedKeys, baseDirs?.behaviors, baseDirs?.systems);
      if (key) scriptURLs.push(key);
    }
  }

  // Player flag
  if (tagSet.has('player') || parentTags?.has('player')) {
    properties._isPlayerControlled = true;
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

  const entity: any = { id: entityId, name: entityName, components, tags: [...tags] };
  if (parentId !== undefined) entity.parentId = parentId;

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

let _gameEventDefs: Record<string, EventDef> | null = null;
let _validGameEvents: Set<string> | null = null;

function loadGameEventDefs(): { defs: Record<string, EventDef>; names: Set<string> } | null {
  if (_gameEventDefs && _validGameEvents) return { defs: _gameEventDefs, names: _validGameEvents };
  try {
    const evtSrc = fs.readFileSync(path.join(SYSTEMS_DIR, 'event_definitions.ts'), 'utf-8');
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

    _gameEventDefs = defs;
    _validGameEvents = names;
    return { defs, names };
  } catch {}
  return null;
}

// ─── Main assembler ────────────────────────────────────────────────────────

let _nameCounters: Record<string, number> = {};

export function assembleGame(gamePath: string, baseDirs?: { behaviors: string; systems: string; ui: string }): ConvertedScene {
  _nameCounters = {};

  // Load template files
  const flow = loadJSON(gamePath, '01_flow.json');
  const entityDefs = loadJSON(gamePath, '02_entities.json');
  const worlds = loadJSON(gamePath, '03_worlds.json');
  const systemsDef = loadJSON(gamePath, '04_systems.json');

  const entities: any[] = [];
  const scripts: Record<string, string> = {};
  const uiFiles: Record<string, string> = {};
  const usedKeys = new Set<string>();
  const nextId = { value: 1 };

  const defs: Record<string, any> = entityDefs?.definitions || {};
  const systems: Record<string, SystemDef> = systemsDef?.systems || {};

  // UI bridge is always injected
  if (!systems['ui']) {
    systems['ui'] = { description: 'HUD, menus, virtual cursor', script: 'ui/ui_bridge.ts' };
  }

  // Register shared scripts
  scripts[ENTITY_LABEL_KEY] = getEntityLabelCode();
  usedKeys.add(ENTITY_LABEL_KEY);

  // Event validator — enforces strict event names on the game bus at runtime
  const eventData = loadGameEventDefs();
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
    const key = loadSystemScript(sys, entityName, scripts, usedKeys, baseDirs?.behaviors, baseDirs?.systems);

    const sysEntity: any = {
      id: nextId.value++,
      name: entityName,
      active: sysName === 'ui',
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

  // Directional light — pitched down, yawed for sun-like angle
  entities.push({
    id: nextId.value++,
    name: 'Directional Light',
    components: [
      { type: 'TransformComponent', data: { position: { x: 0, y: 10, z: 0 }, rotation: eulerDegreesToQuat(-30, -30, 0) } },
      { type: 'LightComponent', data: { lightType: 'directional', intensity: 1.0, color: world?.lighting?.sun_color || [1, 1, 1] } },
    ],
  });

  // Placed entities
  for (const placement of (world?.placements || [])) {
    const def = defs[placement.ref];
    if (!def) {
      console.warn(`[assembler] Unknown entity ref: "${placement.ref}"`);
      continue;
    }

    const isCustomMesh = def.mesh?.type === 'custom' && def.mesh?.asset;
    const rawPos = placement.position || [0, 0, 0];
    const pos = isCustomMesh ? [rawPos[0], 0, rawPos[2]] : rawPos;

    const builtEntities = buildEntity({
      def,
      entityName: placement.name || nameFromRef(placement.ref, nextId.value),
      position: pos,
      rotation: placement.rotation,
      scale: placement.scale || def.mesh?.scale,
      scripts,
      usedKeys,
      baseDirs: baseDirs ? { behaviors: baseDirs.behaviors, systems: baseDirs.systems } : undefined,
      placementMeta: placement.meta,
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

  // Multiplayer config
  let multiplayerConfig: { maxPlayers?: number; minPlayers?: number } | undefined;
  if (flow?.max_players || flow?.min_players) {
    multiplayerConfig = {};
    if (flow.max_players) multiplayerConfig.maxPlayers = Number(flow.max_players);
    if (flow.min_players) multiplayerConfig.minPlayers = Number(flow.min_players);
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
      for (const m of getFSMDriverCode().matchAll(/_emitBus\s*\(\s*"game"\s*,\s*"([^"]+)"/g)) {
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

  const heightmapTerrain = worlds?.worlds?.[0]?.heightmapTerrain;
  const streamedBuildings = worlds?.worlds?.[0]?.streamedBuildings;

  return { entities, scripts, uiFiles, multiplayerConfig, heightmapTerrain, streamedBuildings };
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
