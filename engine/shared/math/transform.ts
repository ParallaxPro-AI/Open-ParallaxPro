import { Vec3 } from './vec3';
import { Quat } from './quat';
import { Mat4 } from './mat4';

/**
 * Combines position (Vec3), rotation (Quat), and scale (Vec3) into a transform.
 * Caches the model matrix and its inverse, recomputing only when marked dirty.
 */
export class Transform {
    position: Vec3;
    rotation: Quat;
    scale: Vec3;

    private _matrixDirty: boolean = true;
    private _inverseMatrixDirty: boolean = true;
    private _cachedMatrix: Mat4 = new Mat4();
    private _cachedInverseMatrix: Mat4 = new Mat4();

    constructor(position?: Vec3, rotation?: Quat, scale?: Vec3) {
        this.position = position ? position.clone() : new Vec3(0, 0, 0);
        this.rotation = rotation ? rotation.clone() : new Quat(0, 0, 0, 1);
        this.scale = scale ? scale.clone() : new Vec3(1, 1, 1);
    }

    /** Mark cached matrices as dirty. Call after modifying position, rotation, or scale directly. */
    setDirty(): void {
        this._matrixDirty = true;
        this._inverseMatrixDirty = true;
    }

    setPosition(x: number, y: number, z: number): this {
        this.position.set(x, y, z);
        this.setDirty();
        return this;
    }

    setRotation(q: Quat): this {
        this.rotation.copy(q);
        this.setDirty();
        return this;
    }

    setScale(x: number, y: number, z: number): this {
        this.scale.set(x, y, z);
        this.setDirty();
        return this;
    }

    setRotationEuler(x: number, y: number, z: number): this {
        Quat.fromEuler(x, y, z, this.rotation);
        this.setDirty();
        return this;
    }

    /** Returns the 4x4 model matrix (TRS). Cached until setDirty() is called. */
    getMatrix(): Mat4 {
        if (this._matrixDirty) {
            Mat4.compose(this.position, this.rotation, this.scale, this._cachedMatrix);
            this._matrixDirty = false;
        }
        return this._cachedMatrix;
    }

    /** Returns the inverse of the model matrix. Cached until setDirty() is called. */
    getInverseMatrix(): Mat4 {
        if (this._inverseMatrixDirty) {
            const mat = this.getMatrix();
            const inv = mat.inverse(this._cachedInverseMatrix);
            if (!inv) {
                Mat4.identity(this._cachedInverseMatrix);
            }
            this._inverseMatrixDirty = false;
        }
        return this._cachedInverseMatrix;
    }

    /** Local forward direction (-Z in right-handed coordinates). */
    getForward(out?: Vec3): Vec3 {
        return this.rotation.mulVec3(Vec3.FORWARD as Vec3, out);
    }

    /** Local right direction (+X). */
    getRight(out?: Vec3): Vec3 {
        return this.rotation.mulVec3(Vec3.RIGHT as Vec3, out);
    }

    /** Local up direction (+Y). */
    getUp(out?: Vec3): Vec3 {
        return this.rotation.mulVec3(Vec3.UP as Vec3, out);
    }

    copy(t: Transform): this {
        this.position.copy(t.position);
        this.rotation.copy(t.rotation);
        this.scale.copy(t.scale);
        this.setDirty();
        return this;
    }

    clone(): Transform {
        return new Transform(this.position, this.rotation, this.scale);
    }

    /** Interpolate between this transform and another. Uses slerp for rotation. */
    lerp(other: Transform, t: number, out?: Transform): Transform {
        const r = out ?? new Transform();
        this.position.lerp(other.position, t, r.position);
        Quat.slerp(this.rotation, other.rotation, t, r.rotation);
        this.scale.lerp(other.scale, t, r.scale);
        r.setDirty();
        return r;
    }

    toJSON(): {
        position: { x: number; y: number; z: number };
        rotation: { x: number; y: number; z: number; w: number };
        scale: { x: number; y: number; z: number };
    } {
        return {
            position: this.position.toJSON(),
            rotation: this.rotation.toJSON(),
            scale: this.scale.toJSON(),
        };
    }

    static fromJSON(json: {
        position: { x: number; y: number; z: number };
        rotation: { x: number; y: number; z: number; w: number };
        scale: { x: number; y: number; z: number };
    }): Transform {
        return new Transform(
            Vec3.fromJSON(json.position),
            Quat.fromJSON(json.rotation),
            Vec3.fromJSON(json.scale)
        );
    }
}
