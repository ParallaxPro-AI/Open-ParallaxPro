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
                // Auto-register active_behaviors listener for behavior scripts
                const behaviorName = (inst.script as any)._behaviorName;
                if (behaviorName && inst.script.scene?.events?.game) {
                    const script = inst.script as any;
                    if (script._behaviorActive === undefined) {
                        script._behaviorActive = false;
                        inst.script.scene.events.game.on('active_behaviors', (d: any) => {
                            script._behaviorActive = d.behaviors && d.behaviors.indexOf(behaviorName) >= 0;
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
            if (typeof inst.script.onUpdate === 'function') {
                try { inst.script.onUpdate(this.timeInfo.deltaTime); } catch (e) {
                    console.error(`Error in onUpdate for entity ${inst.entityId}:`, e);
                }
            }
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
            if (typeof inst.script.onFixedUpdate === 'function') {
                try { inst.script.onFixedUpdate(fixedDt); } catch (e) {
                    console.error(`Error in onFixedUpdate for entity ${inst.entityId}:`, e);
                }
            }
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
            if (typeof inst.script.onLateUpdate === 'function') {
                try { inst.script.onLateUpdate(this.timeInfo.deltaTime); } catch (e) {
                    console.error(`Error in onLateUpdate for entity ${inst.entityId}:`, e);
                }
            }
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
