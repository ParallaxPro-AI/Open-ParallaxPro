import { Vec3 } from './vec3';
import { Mat4 } from './mat4';
import { AABB } from './aabb';

export interface FrustumPlane {
    normal: Vec3;
    d: number;
}

/**
 * 6-plane view frustum extracted from a View-Projection matrix.
 * Used for frustum culling of AABBs, spheres, and points.
 */
export class Frustum {
    /** Planes in order: left, right, bottom, top, near, far. */
    planes: FrustumPlane[] = [];

    constructor() {
        for (let i = 0; i < 6; i++) {
            this.planes.push({ normal: new Vec3(), d: 0 });
        }
    }

    /**
     * Extract frustum planes from a View-Projection matrix (VP = projection * view).
     * Uses the Gribb-Hartmann method on a column-major matrix.
     * Near plane uses row2 only (WebGPU [0,1] depth range).
     */
    setFromViewProjectionMatrix(vp: Mat4): this {
        const d = vp.data;

        // Left:   row3 + row0
        this.setPlane(0, d[3] + d[0], d[7] + d[4], d[11] + d[8], d[15] + d[12]);
        // Right:  row3 - row0
        this.setPlane(1, d[3] - d[0], d[7] - d[4], d[11] - d[8], d[15] - d[12]);
        // Bottom: row3 + row1
        this.setPlane(2, d[3] + d[1], d[7] + d[5], d[11] + d[9], d[15] + d[13]);
        // Top:    row3 - row1
        this.setPlane(3, d[3] - d[1], d[7] - d[5], d[11] - d[9], d[15] - d[13]);
        // Near:   row2 (WebGPU [0,1] depth)
        this.setPlane(4, d[2], d[6], d[10], d[14]);
        // Far:    row3 - row2
        this.setPlane(5, d[3] - d[2], d[7] - d[6], d[11] - d[10], d[15] - d[14]);

        return this;
    }

    private setPlane(index: number, a: number, b: number, c: number, d: number): void {
        const len = Math.sqrt(a * a + b * b + c * c);
        if (len > 1e-10) {
            const invLen = 1 / len;
            this.planes[index].normal.set(a * invLen, b * invLen, c * invLen);
            this.planes[index].d = d * invLen;
        } else {
            this.planes[index].normal.set(a, b, c);
            this.planes[index].d = d;
        }
    }

    private distanceToPlane(plane: FrustumPlane, point: Vec3): number {
        return plane.normal.dot(point) + plane.d;
    }

    /** Test if a point is inside the frustum. */
    containsPoint(point: Vec3): boolean {
        for (let i = 0; i < 6; i++) {
            if (this.distanceToPlane(this.planes[i], point) < 0) {
                return false;
            }
        }
        return true;
    }

    /** Test if a sphere intersects or is inside the frustum. */
    containsSphere(center: Vec3, radius: number): boolean {
        for (let i = 0; i < 6; i++) {
            if (this.distanceToPlane(this.planes[i], center) < -radius) {
                return false;
            }
        }
        return true;
    }

    /** Test if an AABB intersects or is inside the frustum. */
    containsAABB(aabbOrMin: AABB | Vec3, max?: Vec3): boolean {
        let minV: Vec3;
        let maxV: Vec3;
        if (aabbOrMin instanceof AABB) {
            minV = aabbOrMin.min;
            maxV = aabbOrMin.max;
        } else {
            minV = aabbOrMin;
            maxV = max!;
        }

        for (let i = 0; i < 6; i++) {
            const plane = this.planes[i];
            const nx = plane.normal.data[0];
            const ny = plane.normal.data[1];
            const nz = plane.normal.data[2];

            // P-vertex: the corner furthest along the plane normal
            const px = nx >= 0 ? maxV.data[0] : minV.data[0];
            const py = ny >= 0 ? maxV.data[1] : minV.data[1];
            const pz = nz >= 0 ? maxV.data[2] : minV.data[2];

            if (nx * px + ny * py + nz * pz + plane.d < 0) {
                return false;
            }
        }
        return true;
    }

    /**
     * Precise AABB frustum test that distinguishes:
     * - 0: fully outside
     * - 1: intersecting (partially inside)
     * - 2: fully inside
     */
    testAABB(aabb: AABB): 0 | 1 | 2 {
        let allInside = true;

        for (let i = 0; i < 6; i++) {
            const plane = this.planes[i];
            const nx = plane.normal.data[0];
            const ny = plane.normal.data[1];
            const nz = plane.normal.data[2];

            // P-vertex (furthest along normal)
            const px = nx >= 0 ? aabb.max.data[0] : aabb.min.data[0];
            const py = ny >= 0 ? aabb.max.data[1] : aabb.min.data[1];
            const pz = nz >= 0 ? aabb.max.data[2] : aabb.min.data[2];

            // N-vertex (furthest against normal)
            const nxv = nx >= 0 ? aabb.min.data[0] : aabb.max.data[0];
            const nyv = ny >= 0 ? aabb.min.data[1] : aabb.max.data[1];
            const nzv = nz >= 0 ? aabb.min.data[2] : aabb.max.data[2];

            if (nx * px + ny * py + nz * pz + plane.d < 0) {
                return 0;
            }

            if (nx * nxv + ny * nyv + nz * nzv + plane.d < 0) {
                allInside = false;
            }
        }

        return allInside ? 2 : 1;
    }

    static fromVPMatrix(vp: Mat4): Frustum {
        const f = new Frustum();
        f.setFromViewProjectionMatrix(vp);
        return f;
    }
}
