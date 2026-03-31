import { Vec3 } from '../../core/math/vec3.js';
import { Quat } from '../../core/math/quat.js';
import { Mat4 } from '../../core/math/mat4.js';
import { Component } from './component.js';
import { createComponent } from './component_registry.js';
import type { Scene } from './scene.js';

/**
 * An entity is a container of components with a name, tags, hierarchy, and active state.
 */
export class Entity {
    readonly id: number;
    name: string;
    scene: Scene;
    parent: Entity | null = null;
    children: Entity[] = [];
    tags: Set<string> = new Set();
    active: boolean = true;

    private components: Map<string, Component> = new Map();
    private started: boolean = false;

    constructor(id: number, name: string, scene: Scene) {
        this.id = id;
        this.name = name;
        this.scene = scene;
    }

    // -- Tick ------------------------------------------------------------------

    tick(deltaTime: number): void {
        if (!this.active) return;

        if (!this.started) {
            this.started = true;
            for (const component of this.components.values()) {
                if (component.enabled) {
                    component.start();
                }
            }
        }

        for (const component of this.components.values()) {
            if (component.enabled) {
                component.tick(deltaTime);
            }
        }

        for (const component of this.components.values()) {
            if (component.enabled) {
                component.lateUpdate(deltaTime);
            }
        }
    }

    // -- Component Management -------------------------------------------------

    addComponent(componentType: string, data?: Record<string, any>): Component {
        if (this.components.has(componentType)) {
            if (data && Object.keys(data).length > 0) {
                const existing = this.components.get(componentType)!;
                existing.initialize(data);
                existing.markDirty();
                return existing;
            }
            return this.components.get(componentType)!;
        }

        const component = createComponent(componentType);
        if (!component) {
            throw new Error(`Unknown component type: ${componentType}`);
        }

        component.entity = this;
        this.components.set(componentType, component);
        component.initialize(data ?? {});
        component.markDirty();

        return component;
    }

    removeComponent(componentType: string): void {
        const component = this.components.get(componentType);
        if (component) {
            component.onDestroy();
            this.components.delete(componentType);
        }
    }

    private static readonly componentAliases: Record<string, string> = {
        'Rigidbody': 'RigidbodyComponent',
        'rigidbody': 'RigidbodyComponent',
        'Collider': 'ColliderComponent',
        'collider': 'ColliderComponent',
        'Transform': 'TransformComponent',
        'transform': 'TransformComponent',
        'MeshRenderer': 'MeshRendererComponent',
        'meshRenderer': 'MeshRendererComponent',
        'Camera': 'CameraComponent',
        'camera': 'CameraComponent',
        'Light': 'LightComponent',
        'light': 'LightComponent',
        'Script': 'ScriptComponent',
        'script': 'ScriptComponent',
        'Animator': 'AnimatorComponent',
        'animator': 'AnimatorComponent',
        'AudioSource': 'AudioSourceComponent',
        'audioSource': 'AudioSourceComponent',
        'AudioListener': 'AudioListenerComponent',
        'Terrain': 'TerrainComponent',
        'Vehicle': 'VehicleComponent',
        'NetworkIdentity': 'NetworkIdentityComponent',
    };

    getComponent(componentType: string): Component | null {
        return this.components.get(componentType)
            ?? this.components.get(Entity.componentAliases[componentType] ?? '')
            ?? null;
    }

    hasComponent(componentType: string): boolean {
        return this.components.has(componentType)
            || this.components.has(Entity.componentAliases[componentType] ?? '');
    }

    getComponents(): Component[] {
        return Array.from(this.components.values());
    }

    getComponentEntries(): [string, Component][] {
        return Array.from(this.components.entries());
    }

    // -- Hierarchy ------------------------------------------------------------

    setParent(parentEntity: Entity | null): void {
        if (this.parent) {
            this.parent.removeChild(this);
        }

        this.parent = parentEntity;

        if (parentEntity) {
            parentEntity.children.push(this);
        }
    }

    addChild(childEntity: Entity): void {
        if (childEntity.parent === this) return;
        childEntity.setParent(this);
    }

    removeChild(childEntity: Entity): void {
        const index = this.children.indexOf(childEntity);
        if (index !== -1) {
            this.children.splice(index, 1);
        }
    }

    setParentAtIndex(parentEntity: Entity | null, index: number): void {
        if (this.parent) {
            this.parent.removeChild(this);
        }
        this.parent = parentEntity;
        if (parentEntity) {
            parentEntity.children.splice(index, 0, this);
        }
    }

    // -- Tags -----------------------------------------------------------------

    addTag(tag: string): void {
        this.tags.add(tag);
        if (this.scene) this.scene._indexAddTag(this.id, tag);
    }

    removeTag(tag: string): void {
        this.tags.delete(tag);
        if (this.scene) this.scene._indexRemoveTag(this.id, tag);
    }

    hasTag(tag: string): boolean {
        return this.tags.has(tag);
    }

    // -- Active State ---------------------------------------------------------

    setActive(active: boolean): void {
        this.active = active;
    }

    // -- World Transform ------------------------------------------------------

    getWorldPosition(): Vec3 {
        const transform = this.getComponent('TransformComponent');
        if (transform && 'getWorldPosition' in transform) {
            return (transform as any).getWorldPosition();
        }
        return new Vec3(0, 0, 0);
    }

    getWorldRotation(): Quat {
        const transform = this.getComponent('TransformComponent');
        if (transform && 'getWorldRotation' in transform) {
            return (transform as any).getWorldRotation();
        }
        return new Quat(0, 0, 0, 1);
    }

    getWorldScale(): Vec3 {
        const transform = this.getComponent('TransformComponent');
        if (transform && 'getWorldScale' in transform) {
            return (transform as any).getWorldScale();
        }
        return new Vec3(1, 1, 1);
    }

    getWorldMatrix(): Mat4 {
        const transform = this.getComponent('TransformComponent');
        if (transform && 'getWorldMatrix' in transform) {
            return (transform as any).getWorldMatrix();
        }
        return new Mat4();
    }

    // -- Serialization --------------------------------------------------------

    toJSON(): Record<string, any> {
        const componentsData: { type: string; data: Record<string, any> }[] = [];
        for (const [typeName, component] of this.components) {
            componentsData.push({
                type: typeName,
                data: component.toJSON(),
            });
        }

        return {
            id: this.id,
            name: this.name,
            parentId: this.parent ? this.parent.id : null,
            tags: Array.from(this.tags),
            active: this.active,
            components: componentsData,
        };
    }

    static fromJSON(entityData: Record<string, any>, scene: Scene): Entity {
        const id = entityData.id ?? 0;
        const name = entityData.name ?? '';
        const entity = new Entity(id, name, scene);
        entity.active = entityData.active ?? true;

        if (Array.isArray(entityData.tags)) {
            for (const tag of entityData.tags) {
                entity.tags.add(tag);
            }
        }

        if (Array.isArray(entityData.components)) {
            for (const compData of entityData.components) {
                const typeName = compData.type;
                const data = compData.data ?? {};
                try {
                    if (typeName === 'ScriptComponent' && entity.hasComponent('ScriptComponent')) {
                        const existing = entity.getComponent('ScriptComponent') as any;
                        if (existing && typeof existing.mergeScript === 'function') {
                            existing.mergeScript(data);
                        }
                    } else {
                        entity.addComponent(typeName, data);
                    }
                } catch (_e) {
                    // Skip unknown component types during deserialization
                }
            }
        }

        return entity;
    }

    destroy(): void {
        for (const child of [...this.children]) {
            child.destroy();
        }
        this.children.length = 0;

        for (const component of this.components.values()) {
            component.onDestroy();
        }
        this.components.clear();

        if (this.parent) {
            this.parent.removeChild(this);
            this.parent = null;
        }
    }
}
