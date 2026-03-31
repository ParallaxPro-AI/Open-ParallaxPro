import { EditorContext } from '../editor_context.js';
import { Entity } from '../../../runtime/function/framework/entity.js';
import { Vec3 } from '../../../runtime/core/math/vec3.js';

/**
 * Base interface for undo/redo commands.
 */
export interface Command {
    readonly label: string;
    execute(): void;
    undo(): void;
}

// ── ChangePropertyCommand ───────────────────────────────────────────────

/**
 * Changes a single property on a component.
 */
export class ChangePropertyCommand implements Command {
    readonly label: string;
    private savedSideEffects: { scale?: { x: number; y: number; z: number }; meshType?: string; shapeType?: number } | null = null;

    constructor(
        private entityId: number,
        private componentType: string,
        private fieldName: string,
        private oldValue: any,
        private newValue: any,
    ) {
        this.label = `Change ${fieldName}`;
    }

    execute(): void {
        this.captureSideEffects();
        this.applyValue(this.newValue);
    }

    undo(): void {
        this.applyValue(this.oldValue);
        this.restoreSideEffects();
    }

    /** Snapshot state that will be modified as a side-effect so undo can restore it. */
    private captureSideEffects(): void {
        if (this.componentType !== 'MeshRendererComponent') return;
        if (this.fieldName !== 'meshAsset' && this.fieldName !== 'meshType') return;

        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const entity = scene.getEntity(this.entityId);
        if (!entity) return;

        const tc = entity.getComponent('TransformComponent') as any;
        const mr = entity.getComponent('MeshRendererComponent') as any;
        const collider = entity.getComponent('ColliderComponent') as any;

        this.savedSideEffects = {
            scale: tc ? { x: tc.scale.x, y: tc.scale.y, z: tc.scale.z } : undefined,
            meshType: mr?.meshType,
            shapeType: collider?.shapeType,
        };
    }

    /** Restore side-effect state on undo. */
    private restoreSideEffects(): void {
        if (!this.savedSideEffects) return;

        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const entity = scene.getEntity(this.entityId);
        if (!entity) return;

        const s = this.savedSideEffects;

        if (s.scale) {
            const tc = entity.getComponent('TransformComponent') as any;
            if (tc) {
                tc.scale.set(s.scale.x, s.scale.y, s.scale.z);
                tc.setScale(tc.scale);
            }
        }
        if (s.meshType !== undefined) {
            const mr = entity.getComponent('MeshRendererComponent') as any;
            if (mr) {
                mr.meshType = s.meshType;
                mr.gpuMesh = null;
                mr.markDirty();
            }
        }
        if (s.shapeType !== undefined) {
            const collider = entity.getComponent('ColliderComponent') as any;
            if (collider) {
                collider.shapeType = s.shapeType;
                collider.markDirty();
            }
        }

        ctx.ensurePrimitiveMeshes();
        ctx.emit('propertyChanged', { entityId: this.entityId, componentType: this.componentType, field: this.fieldName });
    }

    private applyValue(value: any): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const entity = scene.getEntity(this.entityId);
        if (!entity) return;
        const component = entity.getComponent(this.componentType);
        if (!component) return;

        // TransformComponent uses setters to invalidate cached world matrices
        if (this.componentType === 'TransformComponent') {
            const t = component as any;
            if (this.fieldName === 'position' && value && typeof value === 'object') {
                t.position.set(value.x ?? 0, value.y ?? 0, value.z ?? 0);
                t.setPosition(t.position);
                ctx.markDirty();
                ctx.emit('propertyChanged', { entityId: this.entityId, componentType: this.componentType, field: this.fieldName });
                return;
            }
            if (this.fieldName === 'scale' && value && typeof value === 'object') {
                t.scale.set(value.x ?? 1, value.y ?? 1, value.z ?? 1);
                t.setScale(t.scale);
                ctx.markDirty();
                ctx.emit('propertyChanged', { entityId: this.entityId, componentType: this.componentType, field: this.fieldName });
                return;
            }
            if (this.fieldName === 'rotation' && value && typeof value === 'object') {
                if ('w' in value) {
                    t.rotation.set(value.x, value.y, value.z, value.w);
                    t.setRotation(t.rotation);
                } else {
                    t.setEulerAngles(new Vec3(value.x ?? 0, value.y ?? 0, value.z ?? 0));
                }
                ctx.markDirty();
                ctx.emit('propertyChanged', { entityId: this.entityId, componentType: this.componentType, field: this.fieldName });
                return;
            }
        }

        // Generic property assignment with .set() support for vector/color types
        const currentVal = (component as any)[this.fieldName];
        if (currentVal && typeof currentVal.set === 'function' && value && typeof value === 'object') {
            if ('r' in value && 'g' in value && 'b' in value) {
                currentVal.set(value.r, value.g, value.b, value.a ?? 1);
            } else if ('w' in value) {
                currentVal.set(value.x, value.y, value.z, value.w);
            } else if ('z' in value) {
                currentVal.set(value.x, value.y, value.z);
            }
        } else if (this.componentType === 'MeshRendererComponent' && this.fieldName === 'textureBundle') {
            const mr = component as any;
            if (!mr.materialOverrides) mr.materialOverrides = {};
            if (value && typeof value === 'string') {
                const parts = value.split('/');
                const dirIdx = parts.length - 2;
                const fileIdx = parts.length - 1;
                const texName = parts[dirIdx] || parts[fileIdx].split('_diff')[0].split('_diffuse')[0];
                mr.materialOverrides.textureBundle = texName;
                mr.gpuBaseColorTexture = null;
                mr.gpuNormalMapTexture = null;
                mr.gpuMesh = null;
                ctx.ensurePrimitiveMeshes();
            } else {
                delete mr.materialOverrides.textureBundle;
                mr.gpuBaseColorTexture = null;
                mr.gpuNormalMapTexture = null;
                mr.gpuMesh = null;
                ctx.ensurePrimitiveMeshes();
            }
        } else {
            (component as any)[this.fieldName] = value;
        }
        component.markDirty();

        // Auto-configure entity when meshAsset changes
        if (this.componentType === 'MeshRendererComponent' && this.fieldName === 'meshAsset') {
            const mr = component as any;
            if (value) {
                mr.meshType = 'custom';
                mr.gpuMesh = null;
                mr.markDirty();

                const tc = entity.getComponent('TransformComponent') as any;
                if (tc) {
                    tc.scale.set(1, 1, 1);
                    tc.setScale(tc.scale);
                }

                const collider = entity.getComponent('ColliderComponent') as any;
                if (collider) {
                    collider.shapeType = 3; // MESH
                    collider.markDirty();
                }

                ctx.ensurePrimitiveMeshes();
            } else {
                mr.meshType = 'cube';
                mr.gpuMesh = null;
                mr.gpuBaseColorTexture = null;
                mr.gpuNormalMapTexture = null;
                mr.gpuSubMeshes = null;
                mr.markDirty();

                const collider = entity.getComponent('ColliderComponent') as any;
                if (collider && collider.shapeType === 3) {
                    collider.shapeType = 0; // BOX
                    collider.markDirty();
                }

                ctx.ensurePrimitiveMeshes();
            }
        }

        // When meshType changes to a primitive, clear custom mesh state
        if (this.componentType === 'MeshRendererComponent' && this.fieldName === 'meshType') {
            const mr = component as any;
            if (value && value !== 'custom') {
                mr.meshAsset = '';
                mr.gpuMesh = null;
                mr.gpuBaseColorTexture = null;
                mr.gpuNormalMapTexture = null;
                mr.gpuSubMeshes = null;
                mr.markDirty();

                const collider = entity.getComponent('ColliderComponent') as any;
                if (collider && collider.shapeType === 3) {
                    collider.shapeType = 0; // BOX
                    collider.markDirty();
                }

                ctx.ensurePrimitiveMeshes();
            }
        }

        // AnimatorComponent clip selection
        if (this.componentType === 'AnimatorComponent' && this.fieldName === 'currentClip') {
            const animator = component as any;
            if (value) {
                animator.play(value, { loop: animator.looping ?? true });
            } else {
                animator.stop();
            }
        }

        // Terrain properties require mesh regeneration
        if (this.componentType === 'TerrainComponent') {
            const tc = component as any;
            if ((this.fieldName === 'width' || this.fieldName === 'depth') && typeof this.oldValue === 'number' && typeof value === 'number' && this.oldValue > 0) {
                const ratio = value / this.oldValue;
                if (Math.abs(ratio - 1) > 0.01) {
                    const newRes = Math.round(tc.resolution * ratio);
                    tc.resolution = Math.max(2, Math.min(256, newRes));
                }
            }
            tc.meshDirty = true;
            tc.generateMesh();
            tc.markDirty();
            ctx.ensurePrimitiveMeshes();
        }

        // Auto-adjust terrain resolution when entity scale changes
        if (this.componentType === 'TransformComponent' && this.fieldName === 'scale') {
            const terrain = entity.getComponent('TerrainComponent') as any;
            if (terrain && value && typeof value === 'object' && this.oldValue && typeof this.oldValue === 'object') {
                const oldMaxXZ = Math.max(Math.abs(this.oldValue.x ?? 1), Math.abs(this.oldValue.z ?? 1));
                const newMaxXZ = Math.max(Math.abs(value.x ?? 1), Math.abs(value.z ?? 1));
                if (oldMaxXZ > 0.01) {
                    const ratio = newMaxXZ / oldMaxXZ;
                    if (Math.abs(ratio - 1) > 0.01) {
                        const newRes = Math.round(terrain.resolution * ratio);
                        terrain.resolution = Math.max(2, Math.min(256, newRes));
                        terrain.meshDirty = true;
                        terrain.generateMesh();
                        terrain.markDirty();
                        ctx.ensurePrimitiveMeshes();
                    }
                }
            }
        }

        ctx.markDirty();
        ctx.emit('propertyChanged', { entityId: this.entityId, componentType: this.componentType, field: this.fieldName });
    }
}

// ── CreateEntityCommand ─────────────────────────────────────────────────

export class CreateEntityCommand implements Command {
    readonly label: string;
    private createdEntityId: number = -1;

    constructor(
        private name: string,
        private parentId: number | null,
        private componentData?: { type: string; data?: Record<string, any> }[],
    ) {
        this.label = `Create ${name}`;
    }

    execute(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;

        const entity = scene.createEntity(this.name, this.parentId);
        this.createdEntityId = entity.id;

        if (this.componentData) {
            for (const cd of this.componentData) {
                if (!entity.hasComponent(cd.type)) {
                    entity.addComponent(cd.type, cd.data ?? {});
                }
            }
        }

        if (!entity.hasComponent('TransformComponent')) {
            entity.addComponent('TransformComponent', {
                position: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0, w: 1 },
                scale: { x: 1, y: 1, z: 1 },
            });
        }

        ctx.markDirty();
        ctx.emit('entityCreated', entity.id);
        ctx.emit('sceneChanged');
    }

    undo(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene || this.createdEntityId < 0) return;

        ctx.removeFromSelection(this.createdEntityId);
        scene.destroyEntity(this.createdEntityId);
        ctx.markDirty();
        ctx.emit('entityDeleted', this.createdEntityId);
        ctx.emit('sceneChanged');
    }

    getCreatedEntityId(): number {
        return this.createdEntityId;
    }
}

// ── DeleteEntityCommand ─────────────────────────────────────────────────

export class DeleteEntityCommand implements Command {
    readonly label: string;
    private entitySnapshot: any = null;
    private parentId: number | null = null;

    constructor(private entityId: number) {
        this.label = 'Delete Entity';
    }

    static readonly PROTECTED_NAMES = new Set([
        'Main Camera', 'Directional Light',
    ]);

    execute(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;

        const entity = scene.getEntity(this.entityId);
        if (!entity) return;

        if (DeleteEntityCommand.PROTECTED_NAMES.has(entity.name)) {
            console.warn(`Cannot delete core entity "${entity.name}"`);
            return;
        }

        this.entitySnapshot = entity.toJSON();
        this.parentId = entity.parent ? entity.parent.id : null;

        ctx.removeFromSelection(this.entityId);
        scene.destroyEntity(this.entityId);
        ctx.markDirty();
        ctx.emit('entityDeleted', this.entityId);
        ctx.emit('sceneChanged');
    }

    undo(): void {
        if (!this.entitySnapshot) return;
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;

        const entity = Entity.fromJSON(this.entitySnapshot, scene);
        scene.entities.set(entity.id, entity);

        if (this.parentId !== null) {
            const parent = scene.getEntity(this.parentId);
            if (parent) {
                entity.setParent(parent);
            }
        }

        ctx.markDirty();
        ctx.emit('entityCreated', entity.id);
        ctx.emit('sceneChanged');
    }
}

// ── ReparentEntityCommand ───────────────────────────────────────────────

export class ReparentEntityCommand implements Command {
    readonly label = 'Reparent Entity';
    private oldParentId: number | null = null;

    constructor(
        private entityId: number,
        private newParentId: number | null,
    ) {}

    execute(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;

        const entity = scene.getEntity(this.entityId);
        if (!entity) return;

        this.oldParentId = entity.parent ? entity.parent.id : null;
        scene.reparentEntity(this.entityId, this.newParentId);
        ctx.markDirty();
        ctx.emit('entityReparented', this.entityId);
        ctx.emit('sceneChanged');
    }

    undo(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;

        scene.reparentEntity(this.entityId, this.oldParentId);
        ctx.markDirty();
        ctx.emit('entityReparented', this.entityId);
        ctx.emit('sceneChanged');
    }
}

// ── ReorderEntityCommand ────────────────────────────────────────────────

export class ReorderEntityCommand implements Command {
    readonly label = 'Reorder Entity';
    private oldParentId: number | null = null;
    private oldSiblingIndex: number = 0;

    constructor(
        private entityId: number,
        private newParentId: number | null,
        private newSiblingIndex: number,
    ) {}

    execute(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;

        const entity = scene.getEntity(this.entityId);
        if (!entity) return;

        this.oldParentId = entity.parent ? entity.parent.id : null;
        if (entity.parent) {
            this.oldSiblingIndex = entity.parent.children.indexOf(entity);
        } else {
            const roots = scene.getRootEntities();
            this.oldSiblingIndex = roots.findIndex(r => r.id === entity.id);
        }

        scene.reorderEntity(this.entityId, this.newParentId, this.newSiblingIndex);
        ctx.markDirty();
        ctx.emit('entityReparented', this.entityId);
        ctx.emit('sceneChanged');
    }

    undo(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;

        scene.reorderEntity(this.entityId, this.oldParentId, this.oldSiblingIndex);
        ctx.markDirty();
        ctx.emit('entityReparented', this.entityId);
        ctx.emit('sceneChanged');
    }
}

// ── AddComponentCommand ─────────────────────────────────────────────────

export class AddComponentCommand implements Command {
    readonly label: string;

    constructor(
        private entityId: number,
        private componentType: string,
        private data?: Record<string, any>,
    ) {
        this.label = `Add ${componentType}`;
    }

    execute(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;

        const entity = scene.getEntity(this.entityId);
        if (!entity) return;

        // Auto-fit ColliderComponent to mesh bounds when no explicit size is provided
        let data = this.data ?? {};
        if (this.componentType === 'ColliderComponent' && !data.size && !data.halfExtents) {
            const mr = entity.getComponent('MeshRendererComponent') as any;
            if (mr?.gpuMesh?.boundMin && mr?.gpuMesh?.boundMax) {
                const bMin = mr.gpuMesh.boundMin;
                const bMax = mr.gpuMesh.boundMax;
                data = {
                    ...data,
                    size: {
                        x: bMax.x - bMin.x,
                        y: bMax.y - bMin.y,
                        z: bMax.z - bMin.z,
                    },
                    center: {
                        x: (bMin.x + bMax.x) / 2,
                        y: (bMin.y + bMax.y) / 2,
                        z: (bMin.z + bMax.z) / 2,
                    },
                };
            }
        }

        entity.addComponent(this.componentType, data);
        ctx.markDirty();
        ctx.emit('componentAdded', { entityId: this.entityId, componentType: this.componentType });
    }

    undo(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;

        const entity = scene.getEntity(this.entityId);
        if (!entity) return;

        entity.removeComponent(this.componentType);
        ctx.markDirty();
        ctx.emit('componentRemoved', { entityId: this.entityId, componentType: this.componentType });
    }
}

// ── RemoveComponentCommand ──────────────────────────────────────────────

export class RemoveComponentCommand implements Command {
    readonly label: string;
    private componentSnapshot: any = null;

    constructor(
        private entityId: number,
        private componentType: string,
    ) {
        this.label = `Remove ${componentType}`;
    }

    execute(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;

        const entity = scene.getEntity(this.entityId);
        if (!entity) return;

        const comp = entity.getComponent(this.componentType);
        if (comp) {
            this.componentSnapshot = comp.toJSON();
        }

        entity.removeComponent(this.componentType);
        ctx.markDirty();
        ctx.emit('componentRemoved', { entityId: this.entityId, componentType: this.componentType });
    }

    undo(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;

        const entity = scene.getEntity(this.entityId);
        if (!entity) return;

        entity.addComponent(this.componentType, this.componentSnapshot ?? {});
        ctx.markDirty();
        ctx.emit('componentAdded', { entityId: this.entityId, componentType: this.componentType });
    }
}

// ── RenameEntityCommand ─────────────────────────────────────────────────

export class RenameEntityCommand implements Command {
    readonly label = 'Rename Entity';

    constructor(
        private entityId: number,
        private oldName: string,
        private newName: string,
    ) {}

    execute(): void {
        this.applyName(this.newName);
    }

    undo(): void {
        this.applyName(this.oldName);
    }

    private applyName(name: string): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;

        const entity = scene.getEntity(this.entityId);
        if (entity) {
            entity.name = name;
            ctx.markDirty();
            ctx.emit('entityRenamed', { entityId: this.entityId, name });
            ctx.emit('sceneChanged');
        }
    }
}

// ── SetEntityActiveCommand ──────────────────────────────────────────────

export class SetEntityActiveCommand implements Command {
    readonly label: string;

    constructor(
        private entityId: number,
        private oldActive: boolean,
        private newActive: boolean,
    ) {
        this.label = newActive ? 'Activate Entity' : 'Deactivate Entity';
    }

    execute(): void {
        this.applyActive(this.newActive);
    }

    undo(): void {
        this.applyActive(this.oldActive);
    }

    private applyActive(active: boolean): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const entity = scene.getEntity(this.entityId);
        if (entity) {
            entity.setActive(active);
            ctx.markDirty();
            ctx.emit('sceneChanged');
        }
    }
}

// ── SetComponentEnabledCommand ─────────────────────────────────────────

export class SetComponentEnabledCommand implements Command {
    readonly label: string;

    constructor(
        private entityId: number,
        private componentType: string,
        private oldEnabled: boolean,
        private newEnabled: boolean,
    ) {
        this.label = newEnabled ? 'Enable Component' : 'Disable Component';
    }

    execute(): void {
        this.applyEnabled(this.newEnabled);
    }

    undo(): void {
        this.applyEnabled(this.oldEnabled);
    }

    private applyEnabled(enabled: boolean): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const entity = scene.getEntity(this.entityId);
        if (!entity) return;
        const comp = entity.getComponent(this.componentType);
        if (comp) {
            comp.enabled = enabled;
            ctx.markDirty();
            ctx.emit('propertyChanged', { entityId: this.entityId, componentType: this.componentType, field: 'enabled' });
        }
    }
}

// ── AddTagCommand ──────────────────────────────────────────────────────

export class AddTagCommand implements Command {
    readonly label = 'Add Tag';

    constructor(
        private entityId: number,
        private tag: string,
    ) {}

    execute(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const entity = scene.getEntity(this.entityId);
        if (entity) {
            entity.addTag(this.tag);
            ctx.markDirty();
            ctx.emit('sceneChanged');
        }
    }

    undo(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const entity = scene.getEntity(this.entityId);
        if (entity) {
            entity.removeTag(this.tag);
            ctx.markDirty();
            ctx.emit('sceneChanged');
        }
    }
}

// ── RemoveTagCommand ───────────────────────────────────────────────────

export class RemoveTagCommand implements Command {
    readonly label = 'Remove Tag';

    constructor(
        private entityId: number,
        private tag: string,
    ) {}

    execute(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const entity = scene.getEntity(this.entityId);
        if (entity) {
            entity.removeTag(this.tag);
            ctx.markDirty();
            ctx.emit('sceneChanged');
        }
    }

    undo(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const entity = scene.getEntity(this.entityId);
        if (entity) {
            entity.addTag(this.tag);
            ctx.markDirty();
            ctx.emit('sceneChanged');
        }
    }
}

// ── ResetComponentCommand ──────────────────────────────────────────────

export class ResetComponentCommand implements Command {
    readonly label: string;
    private oldSnapshot: any = null;

    constructor(
        private entityId: number,
        private componentType: string,
    ) {
        this.label = `Reset ${componentType}`;
    }

    execute(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const entity = scene.getEntity(this.entityId);
        if (!entity) return;
        const comp = entity.getComponent(this.componentType);
        if (comp) this.oldSnapshot = comp.toJSON();
        entity.removeComponent(this.componentType);
        entity.addComponent(this.componentType);
        ctx.markDirty();
        ctx.emit('componentRemoved', { entityId: this.entityId, componentType: this.componentType });
        ctx.emit('componentAdded', { entityId: this.entityId, componentType: this.componentType });
    }

    undo(): void {
        if (!this.oldSnapshot) return;
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const entity = scene.getEntity(this.entityId);
        if (!entity) return;
        entity.removeComponent(this.componentType);
        entity.addComponent(this.componentType, this.oldSnapshot);
        ctx.markDirty();
        ctx.emit('componentRemoved', { entityId: this.entityId, componentType: this.componentType });
        ctx.emit('componentAdded', { entityId: this.entityId, componentType: this.componentType });
    }
}

// ── PasteComponentCommand ──────────────────────────────────────────────

export class PasteComponentCommand implements Command {
    readonly label: string;
    private oldSnapshot: any = null;

    constructor(
        private entityId: number,
        private componentType: string,
        private pasteData: any,
    ) {
        this.label = `Paste ${componentType}`;
    }

    execute(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const entity = scene.getEntity(this.entityId);
        if (!entity) return;
        const comp = entity.getComponent(this.componentType);
        if (comp) this.oldSnapshot = comp.toJSON();
        entity.removeComponent(this.componentType);
        entity.addComponent(this.componentType, this.pasteData);
        ctx.markDirty();
        ctx.emit('componentRemoved', { entityId: this.entityId, componentType: this.componentType });
        ctx.emit('componentAdded', { entityId: this.entityId, componentType: this.componentType });
    }

    undo(): void {
        const ctx = EditorContext.instance;
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const entity = scene.getEntity(this.entityId);
        if (!entity) return;
        entity.removeComponent(this.componentType);
        entity.addComponent(this.componentType, this.oldSnapshot ?? {});
        ctx.markDirty();
        ctx.emit('componentRemoved', { entityId: this.entityId, componentType: this.componentType });
        ctx.emit('componentAdded', { entityId: this.entityId, componentType: this.componentType });
    }
}

// ── BatchCommand ────────────────────────────────────────────────────────

export class BatchCommand implements Command {
    readonly label: string;

    constructor(
        label: string,
        private commands: Command[],
    ) {
        this.label = label;
    }

    execute(): void {
        for (const cmd of this.commands) {
            cmd.execute();
        }
    }

    undo(): void {
        for (let i = this.commands.length - 1; i >= 0; i--) {
            this.commands[i].undo();
        }
    }
}

// ── ChangeEnvironmentPropertyCommand ────────────────────────────────

/**
 * Changes a property on the active scene's environment data.
 * Supports dot-separated paths like 'ambientLight.intensity' or 'fog.enabled'.
 */
export class ChangeEnvironmentPropertyCommand implements Command {
    readonly label: string;

    constructor(
        private sceneId: number,
        private fieldPath: string,
        private oldValue: any,
        private newValue: any,
    ) {
        this.label = `Change ${fieldPath}`;
    }

    execute(): void {
        this.applyValue(this.newValue);
    }

    undo(): void {
        this.applyValue(this.oldValue);
    }

    private applyValue(value: any): void {
        const ctx = EditorContext.instance;
        const wm = ctx.engine?.globalContext.worldManager;
        if (!wm) return;
        const scene = wm.getLoadedScenes().find((s: any) => s.id === this.sceneId);
        if (!scene) return;
        const env = (scene as any).environment;
        if (!env) return;

        const parts = this.fieldPath.split('.');
        let target: any = env;
        for (let i = 0; i < parts.length - 1; i++) {
            target = target[parts[i]];
            if (!target) return;
        }
        target[parts[parts.length - 1]] = value;

        ctx.markDirty();
        ctx.emit('propertyChanged', { entityId: -1, componentType: 'environment', field: this.fieldPath });
    }
}
