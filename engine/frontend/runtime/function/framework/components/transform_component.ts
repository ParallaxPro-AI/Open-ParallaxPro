import { Vec3 } from '../../../core/math/vec3.js';
import { Quat } from '../../../core/math/quat.js';
import { Mat4 } from '../../../core/math/mat4.js';
import { MathUtils } from '../../../core/math/math_utils.js';
import { Component } from '../component.js';

/**
 * TransformComponent stores position, rotation, and scale in local space
 * (relative to parent). World transforms are computed lazily from the
 * parent chain using matrix multiplication.
 *
 * Every entity should have a TransformComponent.
 */
export class TransformComponent extends Component {
    position: Vec3;
    rotation: Quat;
    scale: Vec3;

    private worldMatrix: Mat4 | null = null;
    private localMatrix: Mat4 | null = null;

    constructor() {
        super();
        this.position = new Vec3(0, 0, 0);
        this.rotation = new Quat(0, 0, 0, 1);
        this.scale = new Vec3(1, 1, 1);
    }

    // -- Setters (invalidate cached matrices) ---------------------------------

    setPosition(pos: Vec3): void {
        this.position.copy(pos);
        this.invalidate();
    }

    setRotation(rot: Quat): void {
        this.rotation.copy(rot);
        this.invalidate();
    }

    setScale(scl: Vec3): void {
        this.scale.copy(scl);
        this.invalidate();
    }

    // -- World-space getters --------------------------------------------------

    getWorldPosition(): Vec3 {
        return this.getWorldMatrix().getTranslation();
    }

    getWorldRotation(): Quat {
        if (!this.entity.parent) {
            return this.rotation.clone();
        }
        const parentTransform = this.entity.parent.getComponent('TransformComponent') as TransformComponent | null;
        if (!parentTransform) {
            return this.rotation.clone();
        }
        return parentTransform.getWorldRotation().multiply(this.rotation);
    }

    getWorldScale(): Vec3 {
        if (!this.entity.parent) {
            return this.scale.clone();
        }
        const parentTransform = this.entity.parent.getComponent('TransformComponent') as TransformComponent | null;
        if (!parentTransform) {
            return this.scale.clone();
        }
        return parentTransform.getWorldScale().multiply(this.scale);
    }

    getLocalMatrix(): Mat4 {
        if (!this.localMatrix || this.dirty) {
            this.localMatrix = Mat4.compose(this.position, this.rotation, this.scale, this.localMatrix ?? undefined);
        }
        return this.localMatrix;
    }

    getWorldMatrix(): Mat4 {
        if (!this.worldMatrix || this.dirty) {
            const local = this.getLocalMatrix();

            if (this.entity.parent) {
                const parentTransform = this.entity.parent.getComponent('TransformComponent') as TransformComponent | null;
                if (parentTransform) {
                    const parentWorld = parentTransform.getWorldMatrix();
                    this.worldMatrix = parentWorld.multiply(local, this.worldMatrix ?? undefined);
                } else {
                    if (!this.worldMatrix) this.worldMatrix = new Mat4();
                    this.worldMatrix.copy(local);
                }
            } else {
                if (!this.worldMatrix) this.worldMatrix = new Mat4();
                this.worldMatrix.copy(local);
            }
        }
        return this.worldMatrix;
    }

    // -- Convenience transforms -----------------------------------------------

    translate(delta: Vec3): void {
        this.position = this.position.add(delta, this.position);
        this.invalidate();
    }

    rotate(axis: Vec3, angleDeg: number): void {
        const angleRad = angleDeg * MathUtils.DEG2RAD;
        const deltaRot = Quat.fromAxisAngle(axis, angleRad);
        this.rotation = this.rotation.multiply(deltaRot, this.rotation);
        this.invalidate();
    }

    /**
     * Orient this entity to face a target position (forward = -Z).
     */
    lookAt(target: Vec3, up: Vec3 = new Vec3(0, 1, 0)): void {
        const worldPos = this.getWorldPosition();
        const forward = target.sub(worldPos);
        if (forward.length() < MathUtils.EPSILON) return;

        const viewMatrix = Mat4.lookAt(worldPos, target, up);
        const invView = viewMatrix.inverse();
        if (!invView) return;

        const d = invView.data;
        const scaleX = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        const scaleY = Math.sqrt(d[4] * d[4] + d[5] * d[5] + d[6] * d[6]);
        const scaleZ = Math.sqrt(d[8] * d[8] + d[9] * d[9] + d[10] * d[10]);

        const isx = scaleX > MathUtils.EPSILON ? 1 / scaleX : 0;
        const isy = scaleY > MathUtils.EPSILON ? 1 / scaleY : 0;
        const isz = scaleZ > MathUtils.EPSILON ? 1 / scaleZ : 0;

        const q = Quat.fromRotationMatrix(
            d[0] * isx, d[1] * isx, d[2] * isx,
            d[4] * isy, d[5] * isy, d[6] * isy,
            d[8] * isz, d[9] * isz, d[10] * isz
        );
        this.rotation.copy(q);

        // Convert from world rotation to local rotation if parented
        if (this.entity.parent) {
            const parentTransform = this.entity.parent.getComponent('TransformComponent') as TransformComponent | null;
            if (parentTransform) {
                const parentInv = parentTransform.getWorldRotation().inverse();
                this.rotation = parentInv.multiply(this.rotation, this.rotation);
            }
        }

        this.invalidate();
    }

    // -- Euler angle convenience ----------------------------------------------

    getEulerAngles(): Vec3 {
        return this.rotation.toEuler();
    }

    setEulerAngles(euler: Vec3): void {
        this.rotation = Quat.fromEuler(
            euler.x * MathUtils.DEG2RAD,
            euler.y * MathUtils.DEG2RAD,
            euler.z * MathUtils.DEG2RAD,
            this.rotation
        );
        this.invalidate();
    }

    // -- Tick -----------------------------------------------------------------

    tick(deltaTime: number): void {
        if (this.dirty) {
            this.getWorldMatrix();
            this.clearDirty();
        }
    }

    // -- Serialization --------------------------------------------------------

    initialize(data: Record<string, any>): void {
        if (data.position) {
            const px = data.position.x ?? 0, py = data.position.y ?? 0, pz = data.position.z ?? 0;
            this.position.set(isNaN(px) ? 0 : px, isNaN(py) ? 0 : py, isNaN(pz) ? 0 : pz);
        }
        if (data.rotation) {
            const rx = data.rotation.x ?? 0, ry = data.rotation.y ?? 0, rz = data.rotation.z ?? 0, rw = data.rotation.w ?? 1;
            this.rotation.set(isNaN(rx) ? 0 : rx, isNaN(ry) ? 0 : ry, isNaN(rz) ? 0 : rz, isNaN(rw) ? 1 : rw);
        }
        if (data.scale) {
            const sx = data.scale.x ?? 1, sy = data.scale.y ?? 1, sz = data.scale.z ?? 1;
            this.scale.set(isNaN(sx) ? 1 : sx, isNaN(sy) ? 1 : sy, isNaN(sz) ? 1 : sz);
        }
        this.invalidate();
    }

    toJSON(): Record<string, any> {
        return {
            position: { x: this.position.x, y: this.position.y, z: this.position.z },
            rotation: { x: this.rotation.x, y: this.rotation.y, z: this.rotation.z, w: this.rotation.w },
            scale: { x: this.scale.x, y: this.scale.y, z: this.scale.z },
        };
    }

    // -- Cache invalidation ---------------------------------------------------

    invalidate(): void {
        this.markDirty();
        this.worldMatrix = null;
        this.localMatrix = null;

        if (this.entity) {
            for (const child of this.entity.children) {
                const childTransform = child.getComponent('TransformComponent') as TransformComponent | null;
                if (childTransform) {
                    childTransform.invalidate();
                }
            }
        }
    }
}
