import { Vec3 } from '../../../core/math/vec3.js';
import { Component } from '../component.js';

import { ShapeType } from '../../../../../shared/types/physics_enums.js';
export { ShapeType };

/**
 * ColliderComponent defines a collision shape for an entity.
 *
 * An entity with ColliderComponent but no RigidbodyComponent is a static collider.
 * Trigger colliders fire callbacks but don't cause physical collision response.
 *
 * **Dimensions are runtime state, not authored input.** `halfExtents`,
 * `radius`, `height`, and `center` are rewritten by
 * editor_context.autoFitCollider as soon as the visible mesh's AABB is
 * available — that runs in both the editor and at play time (play.ts boots
 * the runtime through EditorContext, so the same fit path executes in
 * published games). Any value passed in via `initialize` is therefore a
 * transient placeholder; the snapshot-restore / editor-primitive callers
 * legitimately seed these fields so the collider has *something* to render
 * before the mesh GLB finishes loading, and that's fine because autoFit
 * will overwrite as soon as the mesh handle materialises.
 *
 * The hard invariant — "collider tracks the visible mesh" — is enforced at
 * the **assembler boundary** (level_assembler.buildColliderData strips and
 * warns on any authored dimension) plus the **mesh-load auto-fit**
 * (autoFitCollider has no opt-out and runs on every mesh handle that
 * becomes available). The component itself is intentionally permissive
 * because it's a runtime data container, not the authoring boundary.
 *
 * Author-controlled fields: `shapeType` (gameplay semantics — box vs
 * capsule vs sphere vs mesh) and `isTrigger`.
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

        // Dimensions are seeded here as a transient placeholder — autoFitCollider
        // overwrites them as soon as the visible mesh's AABB is known. We accept
        // them silently (no warning) because legitimate callers pass them:
        //   * snapshot round-trip (toJSON → fromJSON), where the values came
        //     from a previous auto-fit and are correct;
        //   * editor "Add Cube/Sphere/Plane" primitives, which seed `size`
        //     so the collider renders correctly in the 1-frame window before
        //     loadMeshAsset → autoFitCollider fires;
        //   * AddComponentCommand (history/commands.ts), which pre-fits to
        //     the loaded mesh's AABB at component-add time.
        // The assembler boundary (level_assembler.buildColliderData) is where
        // AI-authored dims are stripped and warned about — by the time data
        // reaches this initialize, anything that came from a JSON template has
        // already been filtered.
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
                data.halfExtents.z ?? 0.5,
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
        // Persist the auto-fitted runtime dimensions so an editor save/reload
        // cycle keeps the collider visualisation stable until the mesh
        // re-loads and re-fits. They are derived state, not authored, but
        // serialising them costs nothing and avoids a 1-frame default-cube
        // flicker on scene reload.
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
