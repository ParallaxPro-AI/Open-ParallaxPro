import type { Entity } from './entity.js';

/**
 * Base class for all components in the Entity-Component architecture.
 *
 * Components store data and behavior attached to entities.
 * Subclasses override lifecycle hooks and must implement toJSON().
 *
 * Lifecycle order:
 *   1. constructor()
 *   2. initialize(data) -- called after construction with deserialized data
 *   3. start()          -- called once before the first tick
 *   4. tick(dt)         -- called every frame
 *   5. lateUpdate(dt)   -- called after all tick()s complete
 *   6. onDestroy()      -- called before removal
 */
export abstract class Component {
    /** The entity this component belongs to. Set by Entity.addComponent(). */
    entity!: Entity;

    /** Whether this component is ticked each frame. */
    enabled: boolean = true;

    /** Change-tracking flag for systems that need to detect modifications. */
    dirty: boolean = false;

    initialize(data: Record<string, any>): void {}
    start(): void {}
    tick(deltaTime: number): void {}
    lateUpdate(deltaTime: number): void {}
    onDestroy(): void {}

    getTransform(): Component | null {
        return this.entity.getComponent('TransformComponent');
    }

    getScene() {
        return this.entity.scene;
    }

    abstract toJSON(): Record<string, any>;

    markDirty(): void {
        this.dirty = true;
    }

    clearDirty(): void {
        this.dirty = false;
    }
}
