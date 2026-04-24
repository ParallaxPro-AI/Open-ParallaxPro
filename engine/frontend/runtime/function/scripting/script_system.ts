import { GameScript, GameUI, ScriptEntity, ScriptScene, TimeInfo } from './script_api.js';
import type { GameAudio } from './script_api.js';
import { InputSystem } from '../input/input_system.js';

interface ScriptInstance {
    entityId: number;
    script: GameScript;
    started: boolean;
}

/**
 * Manages user script lifecycle: registration, instantiation, and per-frame ticking.
 */
export class ScriptSystem {
    private scriptRegistry: Map<string, new () => GameScript> = new Map();
    private instances: ScriptInstance[] = [];
    scene: ScriptScene | null = null;
    private timeInfo: TimeInfo = { time: 0, deltaTime: 0, frameCount: 0 };
    private inputSystem: InputSystem | null = null;
    private gameUI: GameUI | null = null;
    private gameAudio: GameAudio | null = null;

    /** Currently executing entity ID, used by scene.on() to track listener ownership. */
    currentExecutingEntityId: number = -1;

    // ── Per-script timings (consumed by the Performance Profiler panel) ──
    // Keyed by behavior/class name; values accumulate totalMs + call count
    // across all entities that share the name. Reset at the start of each
    // tickUpdate so the Profiler sees one frame's worth of work.
    private timings: Map<string, { totalMs: number; calls: number }> = new Map();

    // Latest `active_behaviors` set as emitted by fsm_driver on FSM state
    // enter. Cached here so that behaviors attached AFTER a state transition
    // (e.g. prefabs spawned at runtime via scene.spawnEntity from inside a
    // gameplay system's restart handler) can initialize their
    // `_behaviorActive` flag from the current set rather than defaulting to
    // `false` and staying dormant until the next transition — which is how
    // the driving "coins respawn but don't collect after Play Again"
    // regression slipped in: coin prefabs spawned by _resetRound arrived
    // AFTER the FSM had already broadcast `active_behaviors` for the
    // gameplay state, so their coin_pickup scripts had `_behaviorActive`
    // stuck at `false` for the rest of the match.
    private activeBehaviorNames: Set<string> = new Set();
    private activeBehaviorsSubscribed = false;

    private scriptName(script: GameScript): string {
        return (script as any)._behaviorName || script.constructor?.name || 'UnnamedScript';
    }

    private timedInvoke(script: GameScript, entityId: number, method: 'onUpdate' | 'onFixedUpdate' | 'onLateUpdate', arg: number): void {
        const fn = (script as any)[method];
        if (typeof fn !== 'function') return;
        const name = this.scriptName(script);
        const t0 = performance.now();
        try {
            fn.call(script, arg);
        } catch (e) {
            console.error(`Error in ${method} for entity ${entityId}:`, e);
        }
        const elapsed = performance.now() - t0;
        const entry = this.timings.get(name);
        if (entry) { entry.totalMs += elapsed; entry.calls++; }
        else this.timings.set(name, { totalMs: elapsed, calls: 1 });
    }

    /** Read-only snapshot of per-script timings for this frame, sorted by totalMs desc. */
    getScriptTimings(): Array<{ name: string; totalMs: number; calls: number }> {
        const out: Array<{ name: string; totalMs: number; calls: number }> = [];
        for (const [name, v] of this.timings) {
            out.push({ name, totalMs: v.totalMs, calls: v.calls });
        }
        out.sort((a, b) => b.totalMs - a.totalMs);
        return out;
    }

    initialize(inputSystem: InputSystem): void {
        this.inputSystem = inputSystem;
    }

    setScene(scene: ScriptScene): void {
        this.scene = scene;
    }

    setGameUI(ui: GameUI): void {
        this.gameUI = ui;
    }

    setGameAudio(audio: GameAudio): void {
        this.gameAudio = audio;
    }

    setTimeInfo(time: number, deltaTime: number, frameCount: number): void {
        this.timeInfo.time = time;
        this.timeInfo.deltaTime = deltaTime;
        this.timeInfo.frameCount = frameCount;
    }

    /**
     * Register a script class by name so it can be instantiated later.
     */
    registerScript(name: string, scriptClass: new () => GameScript): void {
        this.scriptRegistry.set(name, scriptClass);
    }

    /**
     * Instantiate and attach a script to an entity.
     */
    attachScript(scriptName: string, entity: ScriptEntity): GameScript | null {
        const ScriptClass = this.scriptRegistry.get(scriptName);
        if (!ScriptClass) {
            console.warn(`Script "${scriptName}" not found in registry`);
            return null;
        }

        const script = new ScriptClass();
        script.entity = entity;
        script.transform = entity.transform;
        if (this.scene) script.scene = this.scene;
        script.time = this.timeInfo;
        if (this.inputSystem) script.input = this.inputSystem;
        if (this.gameUI) script.ui = this.gameUI;
        if (this.gameAudio) script.audio = this.gameAudio;

        this.instances.push({
            entityId: entity.id,
            script,
            started: false,
        });

        return script;
    }

    /**
     * Remove all scripts attached to an entity.
     */
    detachScripts(entityId: number): void {
        const toRemove: ScriptInstance[] = [];
        for (const inst of this.instances) {
            if (inst.entityId === entityId) {
                toRemove.push(inst);
            }
        }
        for (const inst of toRemove) {
            if (inst.started && typeof inst.script.onDestroy === 'function') {
                try { inst.script.onDestroy(); } catch (e) {
                    console.error(`Error in onDestroy for entity ${inst.entityId}:`, e);
                }
            }
            const idx = this.instances.indexOf(inst);
            if (idx !== -1) this.instances.splice(idx, 1);
        }
        // Clean up event listeners registered by this entity
        if (this.scene && (this.scene as any)._cleanupEntityListeners) {
            (this.scene as any)._cleanupEntityListeners(entityId);
        }
    }

    /**
     * Tick all scripts with two-phase execution:
     *   Phase 1: call onStart() on all unstarted scripts
     *   Phase 2: call onUpdate() on all started scripts
     *
     * This guarantees every script registers its event listeners (in onStart)
     * before any script emits events (in onUpdate).
     */
    tickUpdate(): void {
        // Reset per-frame timings at the top of the first script phase.
        this.timings.clear();

        // Refresh references for all instances
        for (const inst of this.instances) {
            inst.script.time = this.timeInfo;
            if (this.scene) inst.script.scene = this.scene;
            if (this.gameUI) inst.script.ui = this.gameUI;
            if (this.gameAudio) inst.script.audio = this.gameAudio;
            if (this.inputSystem) inst.script.input = this.inputSystem;
        }

        // Phase 1: start unstarted scripts (only if entity is active)
        for (const inst of this.instances) {
            if (!inst.started && inst.script.entity?.active !== false) {
                inst.started = true;
                this.currentExecutingEntityId = inst.entityId;
                if (typeof inst.script.onStart === 'function') {
                    try { inst.script.onStart(); } catch (e) {
                        console.error(`Error in onStart for entity ${inst.entityId}:`, e);
                    }
                }
                // Auto-register active_behaviors listener for behavior scripts.
                // The SystemSystem emits `active_behaviors` on every FSM state
                // enter; we cache the latest set at the ScriptSystem level so
                // newly-attached behaviors (i.e. prefabs spawned at runtime
                // AFTER the emit already happened) can initialize their
                // _behaviorActive from the current set. Without this, a coin
                // prefab spawned during Play Again would sit with
                // _behaviorActive=false until the NEXT state transition —
                // which in most games never comes — and its pickup/AI logic
                // would silently never run.
                const behaviorName = (inst.script as any)._behaviorName;
                if (behaviorName && inst.script.scene?.events?.game) {
                    const script = inst.script as any;
                    if (!this.activeBehaviorsSubscribed) {
                        this.activeBehaviorsSubscribed = true;
                        inst.script.scene.events.game.on('active_behaviors', (d: any) => {
                            this.activeBehaviorNames = new Set(Array.isArray(d?.behaviors) ? d.behaviors : []);
                        });
                    }
                    if (script._behaviorActive === undefined) {
                        script._behaviorActive = this.activeBehaviorNames.has(behaviorName);
                        inst.script.scene.events.game.on('active_behaviors', (d: any) => {
                            script._behaviorActive = Array.isArray(d?.behaviors) && d.behaviors.indexOf(behaviorName) >= 0;
                        });
                    }
                }
                this.currentExecutingEntityId = -1;
            }
        }

        // Phase 2: update all started scripts (skip inactive entities and inactive behaviors)
        for (const inst of this.instances) {
            if (!inst.started) continue;
            if (inst.script.entity?.active === false) continue;
            if ((inst.script as any)._behaviorActive === false) continue;
            this.currentExecutingEntityId = inst.entityId;
            this.timedInvoke(inst.script, inst.entityId, 'onUpdate', this.timeInfo.deltaTime);
            this.currentExecutingEntityId = -1;
        }
    }

    /**
     * Call onFixedUpdate on all scripts. Runs once per physics sub-step.
     */
    tickFixedUpdate(fixedDt: number): void {
        for (const inst of this.instances) {
            if (!inst.started) continue;
            if (inst.script.entity?.active === false) continue;
            if ((inst.script as any)._behaviorActive === false) continue;
            this.timedInvoke(inst.script, inst.entityId, 'onFixedUpdate', fixedDt);
        }
    }

    /**
     * Call onLateUpdate on all scripts.
     */
    tickLateUpdate(): void {
        for (const inst of this.instances) {
            if (!inst.started) continue;
            if (inst.script.entity?.active === false) continue;
            if ((inst.script as any)._behaviorActive === false) continue;
            this.timedInvoke(inst.script, inst.entityId, 'onLateUpdate', this.timeInfo.deltaTime);
        }
    }

    /**
     * Notify scripts of a collision between two entities.
     */
    notifyContactEvent(type: 'enter' | 'stay' | 'exit', entityIdA: number, entityIdB: number): void {
        const method = type === 'enter' ? 'onCollisionEnter' : type === 'stay' ? 'onCollisionStay' : 'onCollisionExit';
        this.dispatchPairCallback(entityIdA, entityIdB, method);
    }

    notifyTriggerEvent(type: 'enter' | 'stay' | 'exit', entityIdA: number, entityIdB: number): void {
        const method = type === 'enter' ? 'onTriggerEnter' : type === 'stay' ? 'onTriggerStay' : 'onTriggerExit';
        this.dispatchPairCallback(entityIdA, entityIdB, method);
    }

    private dispatchPairCallback(entityIdA: number, entityIdB: number, method: string): void {
        for (const inst of this.instances) {
            if (!inst.started) continue;
            const fn = (inst.script as any)[method];
            if (typeof fn !== 'function') continue;
            if (inst.entityId === entityIdA) {
                try { fn.call(inst.script, entityIdB); } catch (e) {
                    console.error(`Error in ${method} for entity ${entityIdA}:`, e);
                }
            } else if (inst.entityId === entityIdB) {
                try { fn.call(inst.script, entityIdA); } catch (e) {
                    console.error(`Error in ${method} for entity ${entityIdB}:`, e);
                }
            }
        }
    }

    /**
     * Get all script instances attached to an entity.
     */
    getScriptsForEntity(entityId: number): GameScript[] {
        return this.instances
            .filter(inst => inst.entityId === entityId)
            .map(inst => inst.script);
    }

    /**
     * Find a script instance on an entity by class name.
     */
    findScript(entityId: number, className: string): GameScript | null {
        for (const inst of this.instances) {
            if (inst.entityId === entityId) {
                const name = inst.script.constructor?.name;
                if (name === className) return inst.script;
            }
        }
        return null;
    }

    getInstanceCount(): number {
        return this.instances.length;
    }

    shutdown(): void {
        for (const inst of this.instances) {
            if (inst.started && typeof inst.script.onDestroy === 'function') {
                try { inst.script.onDestroy(); } catch (e) {
                    console.error(`Error in onDestroy for entity ${inst.entityId}:`, e);
                }
            }
        }
        this.instances.length = 0;
        this.scriptRegistry.clear();
        this.scene = null;
        this.inputSystem = null;
        if (this.gameUI) {
            this.gameUI.destroyAll();
            this.gameUI = null;
        }
        this.gameAudio = null;
    }
}
