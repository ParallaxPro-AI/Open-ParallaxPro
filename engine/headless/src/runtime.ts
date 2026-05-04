/**
 * Headless runtime composed from the REAL browser-engine systems. No
 * parallel re-implementations of Scene / Entity / Components / PhysicsSystem
 * / ScriptSystem — this module imports each from `engine/frontend/runtime/`
 * and wires them together without the renderer / GPU / canvas / audio
 * context.
 *
 * What's swapped out:
 *   - CanvasManager, GPUDeviceManager, InputDevice, RenderSystem — never
 *     initialized. The framework code only calls into them through
 *     RenderSystem.tick() (we skip it) and through deps scripts pull from
 *     the scriptScene object (we stub those).
 *   - GameUISystem — replaced with a headless stub that tracks created
 *     buttons/texts/panels by bbox + id + text so playtests can click them
 *     without a DOM.
 *   - AudioSystem is kept but never `.resume()`-ed, which keeps it inert
 *     per its own `initialize()` contract.
 *
 * Load flow (mirrors editor's enter-play-mode path in
 * `frontend/editor/src/editor_context.ts` ~line 480-580):
 *   1. assembleGame(gameDir) → ConvertedScene { entities, scripts, prefabs,
 *      environment, multiplayerConfig }
 *   2. Scene.fromJSON(convertedScene)
 *   3. For each script URL: loadScriptClass(source) → scriptSystem.registerScript
 *   4. For each entity with a ScriptComponent: scriptSystem.attachScript(name, makeScriptEntity(entity))
 *   5. buildScriptScene(deps) → wire game/ui/audio/input/events surface
 *   6. tick loop: inputSystem.tick → scriptSystem.tickUpdate → physicsSystem.tick(dt, scene)
 *      → scriptSystem.tickLateUpdate → inputSystem.endFrame
 */

import { registerBuiltInComponents } from '../../frontend/runtime/function/framework/register_components.js';
import { Scene } from '../../frontend/runtime/function/framework/scene.js';
import { Entity } from '../../frontend/runtime/function/framework/entity.js';
import { PhysicsSystem } from '../../frontend/runtime/function/physics/physics_system.js';
import { ScriptSystem } from '../../frontend/runtime/function/scripting/script_system.js';
import { InputSystem } from '../../frontend/runtime/function/input/input_system.js';
import { WorldManager } from '../../frontend/runtime/function/framework/world_manager.js';
import { loadScriptClass } from '../../frontend/runtime/function/scripting/script_loader.js';
import { buildScriptScene } from '../../shared/scripting/script_scene_builder.js';
import { Vec3 } from '../../frontend/runtime/core/math/vec3.js';
import { assembleGame } from '../../backend/src/ws/services/pipeline/level_assembler.js';
import { createInlineHeightmapEntity } from '../../frontend/runtime/function/streaming/heightmap_terrain.js';

import { HeadlessUI } from './ui.js';
import { GameFiles } from './loader.js';

// Built-in components must be registered exactly once at module load. The
// registry is module-global; calling it twice is a no-op safeguarded by the
// registry itself.
registerBuiltInComponents();

// Silence Rapier WASM init's one-shot "deprecated parameters" console.warn
// so it doesn't pollute every playtest verdict. The warning is about a new
// init() signature we're not using by design.
{
  const origWarn = console.warn;
  console.warn = (...a: any[]) => {
    if (typeof a[0] === 'string' && /deprecated parameters for the initialization function/.test(a[0])) return;
    origWarn.apply(console, a);
  };
}

export interface RuntimeOptions {
  worldId?: string;
  fixedStep?: number;
  timeoutMs?: number;
}

/** Stub GameAudio — matches the shape `script_scene_builder.ts` expects.
 * All audio calls are no-ops; scripts can still call `this.audio.playSound`
 * without crashing but nothing actually plays. */
function makeAudioStub(): any {
  return {
    playSound: () => {},
    playMusic: () => {},
    stopMusic: () => {},
    setGroupVolume: () => {},
    getGroupVolume: () => 1,
    preload: () => {},
  };
}

/** Minimal ScriptScene deps compatible with the shared buildScriptScene. */
interface BuiltSceneResult { scriptScene: any; makeScriptEntity: (e: Entity) => any; }

export class Runtime {
  scene: Scene | null = null;
  inputSystem = new InputSystem();
  physicsSystem = new PhysicsSystem();
  scriptSystem = new ScriptSystem();
  worldManager = new WorldManager();
  ui = new HeadlessUI();
  audio: any = makeAudioStub();
  scriptErrors: Array<{ source: string; message: string }> = [];
  /** Every event the scriptScene's EventRegistry has emitted, tagged with
   * the frame it fired on. Populated via an onEmit hook wired in boot().
   * Playtest invariants (e.g. "hud_update stops after game_over") use this
   * to reason about event timing. */
  emittedEvents: Array<{ channel: string; name: string; data: any; frame: number }> = [];
  classMap = new Map<string, new () => any>();
  projectScripts: Record<string, string> = {};
  scriptScene: any = null;
  makeScriptEntity: ((e: Entity) => any) | null = null;
  currentFsmState: string | null = null;
  time = { time: 0, deltaTime: 1 / 60, frameCount: 0 };
  // Fake engine shim for the script_scene_builder's `engine.globalContext.inputSystem`
  // / `engine.globalContext.physicsSystem` access patterns scripts rely on.
  engineShim: any;
  private fixedStep: number;
  private multiplayerConfig: any = undefined;
  private environment: any = undefined;

  constructor(public files: GameFiles, public opts: RuntimeOptions = {}) {
    this.fixedStep = opts.fixedStep ?? 1 / 60;
    this.engineShim = {
      globalContext: {
        inputSystem: this.inputSystem,
        physicsSystem: this.physicsSystem,
        scriptSystem: this.scriptSystem,
        worldManager: this.worldManager,
        renderSystem: { getCanvas: () => null, uploadMesh: () => null, releaseMesh: () => {} },
        multiplayerSession: null,
      },
    };
  }

  /**
   * Install all the one-time hooks that turn the script-crash-on-console-error
   * pattern into a structured error the playtest can report. Replaces
   * console.error for the duration of this runtime's lifecycle. Idempotent.
   */
  private installErrorCapture(): void {
    const origErr = console.error;
    const self = this;
    console.error = (...args: any[]) => {
      // ScriptSystem logs with the form: "Error in onStart for entity N:" plus Error
      // We recognise that and route to scriptErrors; everything else still goes to
      // the real stderr so genuine engine errors aren't swallowed.
      const first = args[0];
      if (typeof first === 'string' && /^Error in (onStart|onUpdate|onFixedUpdate|onLateUpdate|onDestroy|onCollision|onTrigger)/.test(first)) {
        const err = args[1];
        const msg = err?.message ?? String(err ?? '');
        // Try to extract a source file from the Error's stack (format:
        //   `...at ClassName.onStart (eval at loadClass (.../script_loader.ts:NN:NN), <anonymous>:NN:NN)`)
        // Fall back to the method header if the stack is unavailable.
        let source = first;
        const stack = err?.stack ?? '';
        const fileMatch = String(stack).match(/<anonymous>:(\d+):(\d+)/);
        if (fileMatch) source = `${first.replace(/:$/, '')} (line ${fileMatch[1]})`;
        self.scriptErrors.push({ source, message: msg });
        return;
      }
      origErr.apply(console, args);
    };
  }

  /** Turn the assembled `ConvertedScene` into the shape `Scene.fromJSON`
   * expects. The two are nearly identical — entities + environment + prefabs
   * — but the assembler emits some fields Scene doesn't consume. We pass
   * only what Scene knows about so nothing weird slips in. */
  private toSceneJSON(assembled: any): any {
    return {
      name: 'headless_scene',
      entities: assembled.entities ?? [],
      environment: assembled.environment ?? {},
      prefabs: assembled.prefabs ?? {},
    };
  }

  /** Load game dir → assemble → fromJSON → register scripts → attach →
   * buildScriptScene → call onStart. Must be awaited before tick(). */
  async boot(): Promise<void> {
    this.installErrorCapture();

    const assembled = assembleGame(this.files.root, {
      behaviors: this.files.root + '/behaviors',
      systems: this.files.root + '/systems',
      ui: this.files.root + '/ui',
    });
    this.multiplayerConfig = assembled.multiplayerConfig;
    this.environment = assembled.environment;
    this.projectScripts = assembled.scripts ?? {};

    // Physics init — use gravity from assembled environment (worlds[0]).
    const g = Array.isArray(assembled.environment?.gravity) ? assembled.environment.gravity : [0, -9.81, 0];
    await this.physicsSystem.initialize(new Vec3(g[0], g[1], g[2]), this.fixedStep);
    this.scriptSystem.initialize(this.inputSystem);
    this.scriptSystem.setGameUI(this.ui as any);
    this.scriptSystem.setGameAudio(this.audio);
    await this.worldManager.initialize(null as any, null as any);

    // Build the Scene from assembled entities.
    this.scene = Scene.fromJSON(this.toSceneJSON(assembled));
    this.worldManager.setActiveScene(this.scene.id);

    // If the assembled scene declares a heightmapTerrain block, create
    // the terrain entity (TerrainComponent + static rigidbody + terrain
    // collider) so playtest physics has actual ground to stand on. The
    // editor / play frontends do this through StreamingManager which we
    // don't load here; createInlineHeightmapEntity is the bare-minimum
    // shared path.
    const ht = assembled.heightmapTerrain;
    if (ht && Array.isArray(ht.size) && Array.isArray(ht.layers) && ht.layers.length > 0) {
      try {
        createInlineHeightmapEntity(this.scene, {
          worldWidth: ht.size[0],
          worldDepth: ht.size[1],
          resolution: ht.elevation?.resolution,
          elevation: ht.elevation,
          baseColor: ht.baseColor,
          waterLevel: ht.waterLevel,
        });
      } catch (e: any) {
        console.warn('[headless] heightmap terrain create failed:', e?.message);
      }
    }

    // Register FSM start state from 01_flow.json if present (the game's
    // fsm_driver.ts system will actually drive the FSM, but tests want to
    // assert the initial state is a valid key).
    if (typeof this.files.flow?.start === 'string') {
      this.currentFsmState = this.files.flow.start;
    }

    // Pre-load + register every script referenced by a ScriptComponent.
    const scriptEntities: Array<{ entity: Entity; scriptURL: string; isAdditional: boolean; additionalIndex: number }> = [];
    for (const entity of this.scene.entities.values()) {
      const sc: any = entity.getComponent('ScriptComponent');
      if (!sc) continue;
      const url = sc.scriptURL || sc.scriptAssetUUID;
      if (url) scriptEntities.push({ entity, scriptURL: url, isAdditional: false, additionalIndex: -1 });
      if (Array.isArray(sc.additionalScripts)) {
        for (let i = 0; i < sc.additionalScripts.length; i++) {
          const addUrl = sc.additionalScripts[i]?.scriptURL;
          if (addUrl) scriptEntities.push({ entity, scriptURL: addUrl, isAdditional: true, additionalIndex: i });
        }
      }
    }

    const uniqueURLs = [...new Set(scriptEntities.map(s => s.scriptURL))];
    for (const url of uniqueURLs) {
      const src = this.projectScripts[url];
      if (!src) {
        this.scriptErrors.push({ source: url, message: `script source missing in assembled output` });
        continue;
      }
      try {
        const ScriptClass = loadScriptClass(src);
        if (!ScriptClass) {
          this.scriptErrors.push({ source: url, message: 'loadScriptClass returned null (no class found in source)' });
          continue;
        }
        const name = ScriptClass.name || url;
        this.classMap.set(url, ScriptClass);
        this.scriptSystem.registerScript(name, ScriptClass);
      } catch (e: any) {
        this.scriptErrors.push({ source: url, message: `load error: ${e?.message ?? e}` });
      }
    }

    // Build scriptScene with headless deps. Most deps use defaults; raycast
    // is wired to PhysicsSystem so scripts that do `scene.raycast(...)` hit
    // real Rapier geometry.
    const scene = this.scene;
    const physics = this.physicsSystem;
    const raycastDep = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number) => {
      const anyPhys: any = physics;
      if (typeof anyPhys.raycastWorld === 'function') {
        const hit = anyPhys.raycastWorld(new Vec3(ox, oy, oz), new Vec3(dx, dy, dz), maxDist, undefined);
        if (hit) {
          const ent = scene.entities.get(hit.entityId);
          return { entityId: hit.entityId, entityName: ent?.name ?? '', distance: hit.distance, point: hit.point, normal: hit.normal };
        }
      }
      return null;
    };

    const built: BuiltSceneResult = buildScriptScene({
      scene: this.scene as any,
      engine: this.engineShim,
      scriptSystem: this.scriptSystem,
      classMap: this.classMap,
      projectScripts: this.projectScripts,
      gameUI: this.ui as any,
      gameAudio: this.audio,
      ensurePrimitiveMeshes: () => {},
      loadScriptClass,
      state: { projectData: { projectConfig: {}, multiplayerConfig: this.multiplayerConfig } },
      raycast: raycastDep,
      screenToWorldRay: () => null,
      screenRaycast: () => null,
      screenPointToGround: (_sx: number, _sy: number, groundY: number = 0) => new Vec3(0, groundY, 0),
      worldToScreen: () => null,
      getCamera: () => (this.scene as any).getActiveCamera?.() ?? null,
      setCameraTarget: () => {},
      setCameraPosition: () => {},
      uiSendState: (s: any) => this.ui.sendState(s),
      reloadScene: () => {},
    } as any);
    this.scriptScene = built.scriptScene;
    this.makeScriptEntity = built.makeScriptEntity;
    this.scriptSystem.setScene(this.scriptScene);

    // Install event-history capture. configure() with only onEmit preserves
    // the existing getCurrentEntityId hook set inside buildScriptScene. Every
    // emit across every bus (game/ui/audio/etc.) gets appended to
    // emittedEvents with the current frame number — lets invariants reason
    // about timing (e.g. "nothing emits hud_update after game_over fires").
    if (this.scriptScene.events && typeof this.scriptScene.events.configure === 'function') {
      const self = this;
      this.scriptScene.events.configure({
        onEmit: (channel: string, name: string, data: any) => {
          self.emittedEvents.push({ channel, name, data, frame: self.time.frameCount });
        },
      });
    }

    // Expose projectConfig etc. on the scriptScene the way play_mode_helpers does —
    // some systems read `_projectConfig` / `_mp` / `_engine`.
    this.scriptScene._projectConfig = { multiplayerConfig: this.multiplayerConfig };
    this.scriptScene._mp = null;
    this.scriptScene._engine = this.engineShim;

    // Attach script instances to entities (mirror editor play-mode flow).
    const scriptEntityCache = new Map<number, any>();
    for (const { entity, scriptURL, isAdditional, additionalIndex } of scriptEntities) {
      const ScriptClass = this.classMap.get(scriptURL);
      if (!ScriptClass) continue;
      const name = ScriptClass.name || scriptURL;
      let scriptEntity = scriptEntityCache.get(entity.id);
      if (!scriptEntity) {
        scriptEntity = this.makeScriptEntity!(entity);
        if (scriptEntity) scriptEntityCache.set(entity.id, scriptEntity);
      }
      if (!scriptEntity) continue;
      const inst = this.scriptSystem.attachScript(name, scriptEntity);
      if (!inst) continue;
      // Apply properties — behavior scripts declare `_behaviorName`,
      // `_speed`, etc. as class fields and expect them set from properties.
      const sc: any = entity.getComponent('ScriptComponent');
      const props = isAdditional
        ? (sc?.additionalScripts?.[additionalIndex]?.properties ?? {})
        : (sc?.properties ?? {});
      for (const [k, v] of Object.entries(props)) (inst as any)[k] = v;
    }
  }

  /** Advance one fixed step. Frame-order subset from engine.ts::tickOneFrame:
   * input → scripts.update → physics → scripts.lateUpdate → input.endFrame.
   * Animation / audio / render phases skipped; network only enabled if the
   * game opts in via multiplayerConfig. */
  tick(dt?: number): void {
    const step = dt ?? this.fixedStep;
    this.time.deltaTime = step;
    this.time.time += step;
    this.time.frameCount += 1;
    this.inputSystem.tick();
    this.scriptSystem.setTimeInfo(this.time.time, step, this.time.frameCount);
    this.scriptSystem.tickUpdate();
    try {
      const steps = this.physicsSystem.tick(step, this.scene);
      const fixedDt = this.physicsSystem.getFixedTimestep();
      for (let i = 0; i < steps; i++) this.scriptSystem.tickFixedUpdate(fixedDt);
      for (const evt of this.physicsSystem.getContactEvents()) this.scriptSystem.notifyContactEvent(evt.type, evt.a, evt.b);
      for (const evt of this.physicsSystem.getTriggerEvents()) this.scriptSystem.notifyTriggerEvent(evt.type, evt.a, evt.b);
    } catch (e: any) {
      this.scriptErrors.push({ source: 'physics', message: `tick error: ${e?.message ?? e}` });
    }
    this.scriptSystem.tickLateUpdate();
    this.worldManager.tick(step);
    this.inputSystem.endFrame();
  }

  tickN(n: number): void { for (let i = 0; i < n; i++) this.tick(); }
  tickSeconds(s: number): void {
    const n = Math.max(1, Math.round(s / this.fixedStep));
    this.tickN(n);
  }

  shutdown(): void {
    try { this.scriptSystem.shutdown(); } catch {}
    try { this.physicsSystem.shutdown(); } catch {}
    try { this.inputSystem.shutdown(); } catch {}
  }
}
