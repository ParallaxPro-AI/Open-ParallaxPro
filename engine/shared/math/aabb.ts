import { Vec3 } from './vec3';
import { Mat4 } from './mat4';

/**
 * Axis-Aligned Bounding Box defined by min and max corners.
 */
export class AABB {
    min: Vec3;
    max: Vec3;

    constructor(min?: Vec3, max?: Vec3) {
        this.min = min ? min.clone() : new Vec3(Infinity, Infinity, Infinity);
        this.max = max ? max.clone() : new Vec3(-Infinity, -Infinity, -Infinity);
    }

    static fromCenterExtents(center: Vec3, halfExtents: Vec3): AABB {
        return new AABB(
            center.sub(halfExtents),
            center.add(halfExtents)
        );
    }

    static fromPoints(points: Vec3[]): AABB {
        const aabb = new AABB();
        for (const p of points) {
            aabb.expandByPoint(p);
        }
        return aabb;
    }

    /** Reset to an empty (inverted) state. */
    reset(): this {
        this.min.set(Infinity, Infinity, Infinity);
        this.max.set(-Infinity, -Infinity, -Infinity);
        return this;
    }

    isEmpty(): boolean {
        return (
            this.min.data[0] > this.max.data[0] ||
            this.min.data[1] > this.max.data[1] ||
            this.min.data[2] > this.max.data[2]
        );
    }

    getCenter(out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        r.data[0] = (this.min.data[0] + this.max.data[0]) * 0.5;
        r.data[1] = (this.min.data[1] + this.max.data[1]) * 0.5;
        r.data[2] = (this.min.data[2] + this.max.data[2]) * 0.5;
        return r;
    }

    getSize(out?: Vec3): Vec3 {
        return this.max.sub(this.min, out);
    }

    getHalfExtents(out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        r.data[0] = (this.max.data[0] - this.min.data[0]) * 0.5;
        r.data[1] = (this.max.data[1] - this.min.data[1]) * 0.5;
        r.data[2] = (this.max.data[2] - this.min.data[2]) * 0.5;
        return r;
    }

    expandByPoint(point: Vec3): this {
        this.min.data[0] = Math.min(this.min.data[0], point.data[0]);
        this.min.data[1] = Math.min(this.min.data[1], point.data[1]);
        this.min.data[2] = Math.min(this.min.data[2], point.data[2]);
        this.max.data[0] = Math.max(this.max.data[0], point.data[0]);
        this.max.data[1] = Math.max(this.max.data[1], point.data[1]);
        this.max.data[2] = Math.max(this.max.data[2], point.data[2]);
        return this;
    }

    expandByAABB(other: AABB): this {
        this.min.data[0] = Math.min(this.min.data[0], other.min.data[0]);
        this.min.data[1] = Math.min(this.min.data[1], other.min.data[1]);
        this.min.data[2] = Math.min(this.min.data[2], other.min.data[2]);
        this.max.data[0] = Math.max(this.max.data[0], other.max.data[0]);
        this.max.data[1] = Math.max(this.max.data[1], other.max.data[1]);
        this.max.data[2] = Math.max(this.max.data[2], other.max.data[2]);
        return this;
    }

    expandByScalar(scalar: number): this {
        this.min.data[0] -= scalar;
        this.min.data[1] -= scalar;
        this.min.data[2] -= scalar;
        this.max.data[0] += scalar;
        this.max.data[1] += scalar;
        this.max.data[2] += scalar;
        return this;
    }

    containsPoint(point: Vec3): boolean {
        return (
            point.data[0] >= this.min.data[0] && point.data[0] <= this.max.data[0] &&
            point.data[1] >= this.min.data[1] && point.data[1] <= this.max.data[1] &&
            point.data[2] >= this.min.data[2] && point.data[2] <= this.max.data[2]
        );
    }

    containsAABB(other: AABB): boolean {
        return (
            this.min.data[0] <= other.min.data[0] && other.max.data[0] <= this.max.data[0] &&
            this.min.data[1] <= other.min.data[1] && other.max.data[1] <= this.max.data[1] &&
            this.min.data[2] <= other.min.data[2] && other.max.data[2] <= this.max.data[2]
        );
    }

    intersectsAABB(other: AABB): boolean {
        return (
            this.min.data[0] <= other.max.data[0] && this.max.data[0] >= other.min.data[0] &&
            this.min.data[1] <= other.max.data[1] && this.max.data[1] >= other.min.data[1] &&
            this.min.data[2] <= other.max.data[2] && this.max.data[2] >= other.min.data[2]
        );
    }

    intersectsSphere(center: Vec3, radius: number): boolean {
        let distSq = 0;
        for (let i = 0; i < 3; i++) {
            const v = center.data[i];
            if (v < this.min.data[i]) {
                const d = this.min.data[i] - v;
                distSq += d * d;
            } else if (v > this.max.data[i]) {
                const d = v - this.max.data[i];
                distSq += d * d;
            }
        }
        return distSq <= radius * radius;
    }

    /** Closest point on or inside the AABB to the given point. */
    closestPoint(point: Vec3, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        r.data[0] = Math.max(this.min.data[0], Math.min(point.data[0], this.max.data[0]));
        r.data[1] = Math.max(this.min.data[1], Math.min(point.data[1], this.max.data[1]));
        r.data[2] = Math.max(this.min.data[2], Math.min(point.data[2], this.max.data[2]));
        return r;
    }

    /**
     * Transform this AABB by a 4x4 matrix, returning a new AABB that encloses
     * all 8 transformed corners.
     */
    transform(matrix: Mat4, out?: AABB): AABB {
        const r = out ?? new AABB();
        r.reset();

        const minX = this.min.data[0], minY = this.min.data[1], minZ = this.min.data[2];
        const maxX = this.max.data[0], maxY = this.max.data[1], maxZ = this.max.data[2];
        const corner = new Vec3();

        for (let i = 0; i < 8; i++) {
            corner.data[0] = (i & 1) ? maxX : minX;
            corner.data[1] = (i & 2) ? maxY : minY;
            corner.data[2] = (i & 4) ? maxZ : minZ;
            const transformed = matrix.transformPoint(corner);
            r.expandByPoint(transformed);
        }

        return r;
    }

    copy(other: AABB): this {
        this.min.copy(other.min);
        this.max.copy(other.max);
        return this;
    }

    clone(): AABB {
        return new AABB(this.min, this.max);
    }

    equals(other: AABB, epsilon: number = 1e-6): boolean {
        return this.min.equals(other.min, epsilon) && this.max.equals(other.max, epsilon);
    }

    toJSON(): {
        min: { x: number; y: number; z: number };
        max: { x: number; y: number; z: number };
    } {
        return {
            min: this.min.toJSON(),
            max: this.max.toJSON(),
        };
    }

    static fromJSON(json: {
        min: { x: number; y: number; z: number };
        max: { x: number; y: number; z: number };
    }): AABB {
        return new AABB(Vec3.fromJSON(json.min), Vec3.fromJSON(json.max));
    }
}
