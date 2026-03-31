import { Vec3 } from '../../../core/math/vec3.js';
import { Component } from '../component.js';

import { ShapeType } from '../../../../../shared/types/physics_enums.js';
export { ShapeType };

/**
 * ColliderComponent defines a collision shape for an entity.
 *
 * An entity with ColliderComponent but no RigidbodyComponent is a static collider.
 * Trigger colliders fire callbacks but don't cause physical collision response.
 */
export class ColliderComponent extends Component {
    shapeType: ShapeType = ShapeType.BOX;
    center: Vec3;
    halfExtents: Vec3;
    radius: number = 0.5;
    height: number = 1.0;
    meshAssetUUID: string = '';
    isTrigger: boolean = false;

    /** Cached collision mesh data (runtime only, loaded from IndexedDB) */
    collisionPositions: Float32Array | null = null;
    collisionIndices: Uint32Array | null = null;

    get size(): Vec3 {
        return new Vec3(this.halfExtents.x * 2, this.halfExtents.y * 2, this.halfExtents.z * 2);
    }
    set size(value: Vec3) {
        this.halfExtents.set(value.x * 0.5, value.y * 0.5, value.z * 0.5);
    }

    // -- Collision Callbacks (set by user scripts) ----------------------------

    constructor() {
        super();
        this.center = new Vec3(0, 0, 0);
        this.halfExtents = new Vec3(0.5, 0.5, 0.5);
    }

    initialize(data: Record<string, any>): void {
        const st = data.shapeType ?? data.shape ?? ShapeType.BOX;
        if (typeof st === 'string') {
            const map: Record<string, ShapeType> = {
                box: ShapeType.BOX,
                sphere: ShapeType.SPHERE,
                capsule: ShapeType.CAPSULE,
                mesh: ShapeType.MESH,
                terrain: ShapeType.TERRAIN,
                compound: ShapeType.COMPOUND,
            };
            this.shapeType = map[st.toLowerCase()] ?? ShapeType.BOX;
        } else {
            this.shapeType = st;
        }

        if (data.center) {
            this.center.set(data.center.x ?? 0, data.center.y ?? 0, data.center.z ?? 0);
        }
        if (data.size) {
            this.halfExtents.set(
                (data.size.x ?? 1) * 0.5,
                (data.size.y ?? 1) * 0.5,
                (data.size.z ?? 1) * 0.5,
            );
        } else if (data.halfExtents) {
            this.halfExtents.set(
                data.halfExtents.x ?? 0.5,
                data.halfExtents.y ?? 0.5,
                data.halfExtents.z ?? 0.5
            );
        }

        this.radius = data.radius ?? 0.5;
        this.height = data.height ?? 1.0;
        this.meshAssetUUID = data.meshAssetUUID ?? '';
        this.isTrigger = data.isTrigger ?? false;

        this.markDirty();
    }

    onDestroy(): void {}

    toJSON(): Record<string, any> {
        return {
            shapeType: this.shapeType,
            center: { x: this.center.x, y: this.center.y, z: this.center.z },
            size: { x: this.halfExtents.x * 2, y: this.halfExtents.y * 2, z: this.halfExtents.z * 2 },
            radius: this.radius,
            height: this.height,
            meshAssetUUID: this.meshAssetUUID,
            isTrigger: this.isTrigger,
        };
    }
}
