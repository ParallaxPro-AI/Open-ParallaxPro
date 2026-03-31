import { Vec3 } from '../../../core/math/vec3.js';
import { Quat } from '../../../core/math/quat.js';
import type { CollisionShape, AABB } from './box_shape.js';

export interface MeshTriangle {
    v0: Vec3;
    v1: Vec3;
    v2: Vec3;
}

interface MeshBVHNode {
    aabb: AABB;
    left: MeshBVHNode | null;
    right: MeshBVHNode | null;
    triangleIndices: number[];
}

const MAX_LEAF_TRIANGLES = 4;

/**
 * Collision shape for arbitrary triangle meshes. Builds an internal BVH
 * over the triangles for fast spatial queries against static geometry.
 * Triangles are stored in local (mesh) space.
 */
export class MeshShape implements CollisionShape {
    readonly type = 'mesh';
    readonly triangles: MeshTriangle[];
    readonly bvh: MeshBVHNode;
    private localAABB: AABB;

    constructor(positions: Float32Array, indices: Uint32Array) {
        this.triangles = [];
        for (let i = 0; i < indices.length; i += 3) {
            const i0 = indices[i] * 3;
            const i1 = indices[i + 1] * 3;
            const i2 = indices[i + 2] * 3;
            this.triangles.push({
                v0: new Vec3(positions[i0], positions[i0 + 1], positions[i0 + 2]),
                v1: new Vec3(positions[i1], positions[i1 + 1], positions[i1 + 2]),
                v2: new Vec3(positions[i2], positions[i2 + 1], positions[i2 + 2]),
            });
        }

        const allIndices = Array.from({ length: this.triangles.length }, (_, i) => i);
        this.localAABB = MeshShape.computeTrianglesAABB(this.triangles, allIndices);
        this.bvh = this.buildBVH(allIndices);
    }

    computeAABB(position: Vec3, rotation: Quat): AABB {
        const la = this.localAABB;
        const corners = [
            new Vec3(la.min.x, la.min.y, la.min.z),
            new Vec3(la.max.x, la.min.y, la.min.z),
            new Vec3(la.min.x, la.max.y, la.min.z),
            new Vec3(la.max.x, la.max.y, la.min.z),
            new Vec3(la.min.x, la.min.y, la.max.z),
            new Vec3(la.max.x, la.min.y, la.max.z),
            new Vec3(la.min.x, la.max.y, la.max.z),
            new Vec3(la.max.x, la.max.y, la.max.z),
        ];

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const c of corners) {
            const w = rotation.mulVec3(c).add(position);
            if (w.x < minX) minX = w.x;
            if (w.y < minY) minY = w.y;
            if (w.z < minZ) minZ = w.z;
            if (w.x > maxX) maxX = w.x;
            if (w.y > maxY) maxY = w.y;
            if (w.z > maxZ) maxZ = w.z;
        }

        return {
            min: new Vec3(minX, minY, minZ),
            max: new Vec3(maxX, maxY, maxZ),
        };
    }

    /** Approximate inertia using the local AABB dimensions. */
    computeInertia(mass: number): Vec3 {
        const la = this.localAABB;
        const dx = la.max.x - la.min.x;
        const dy = la.max.y - la.min.y;
        const dz = la.max.z - la.min.z;
        const factor = mass / 12;
        return new Vec3(
            factor * (dy * dy + dz * dz),
            factor * (dx * dx + dz * dz),
            factor * (dx * dx + dy * dy)
        );
    }

    getSupport(direction: Vec3): Vec3 {
        let bestDot = -Infinity;
        let bestVert = new Vec3(0, 0, 0);

        for (const tri of this.triangles) {
            for (const v of [tri.v0, tri.v1, tri.v2]) {
                const d = v.dot(direction);
                if (d > bestDot) {
                    bestDot = d;
                    bestVert = v;
                }
            }
        }

        return bestVert.clone();
    }

    /**
     * Query all triangles whose AABB overlaps the given local-space AABB.
     * Used by narrowphase to select candidate triangles for collision testing.
     */
    queryTriangles(localAABB: AABB): MeshTriangle[] {
        const result: MeshTriangle[] = [];
        this.queryBVH(this.bvh, localAABB, result);
        return result;
    }

    // -- BVH construction (median-split) --

    private buildBVH(triIndices: number[]): MeshBVHNode {
        const aabb = MeshShape.computeTrianglesAABB(this.triangles, triIndices);

        if (triIndices.length <= MAX_LEAF_TRIANGLES) {
            return { aabb, left: null, right: null, triangleIndices: triIndices };
        }

        const dx = aabb.max.x - aabb.min.x;
        const dy = aabb.max.y - aabb.min.y;
        const dz = aabb.max.z - aabb.min.z;

        let axis: 'x' | 'y' | 'z' = 'x';
        if (dy > dx && dy > dz) axis = 'y';
        else if (dz > dx && dz > dy) axis = 'z';

        const centroids = triIndices.map(i => {
            const tri = this.triangles[i];
            const cx = (tri.v0.x + tri.v1.x + tri.v2.x) / 3;
            const cy = (tri.v0.y + tri.v1.y + tri.v2.y) / 3;
            const cz = (tri.v0.z + tri.v1.z + tri.v2.z) / 3;
            return { idx: i, val: axis === 'x' ? cx : axis === 'y' ? cy : cz };
        });
        centroids.sort((a, b) => a.val - b.val);

        const mid = Math.floor(centroids.length / 2);
        const leftIndices = centroids.slice(0, mid).map(c => c.idx);
        const rightIndices = centroids.slice(mid).map(c => c.idx);

        // Degenerate split guard
        if (leftIndices.length === 0 || rightIndices.length === 0) {
            return { aabb, left: null, right: null, triangleIndices: triIndices };
        }

        return {
            aabb,
            left: this.buildBVH(leftIndices),
            right: this.buildBVH(rightIndices),
            triangleIndices: [],
        };
    }

    // -- BVH query --

    private queryBVH(node: MeshBVHNode, queryAABB: AABB, result: MeshTriangle[]): void {
        if (!MeshShape.aabbOverlap(node.aabb, queryAABB)) return;

        if (node.triangleIndices.length > 0) {
            for (const idx of node.triangleIndices) {
                result.push(this.triangles[idx]);
            }
            return;
        }

        if (node.left) this.queryBVH(node.left, queryAABB, result);
        if (node.right) this.queryBVH(node.right, queryAABB, result);
    }

    // -- Static helpers --

    private static computeTrianglesAABB(triangles: MeshTriangle[], indices: number[]): AABB {
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const idx of indices) {
            const tri = triangles[idx];
            for (const v of [tri.v0, tri.v1, tri.v2]) {
                if (v.x < minX) minX = v.x;
                if (v.y < minY) minY = v.y;
                if (v.z < minZ) minZ = v.z;
                if (v.x > maxX) maxX = v.x;
                if (v.y > maxY) maxY = v.y;
                if (v.z > maxZ) maxZ = v.z;
            }
        }

        if (minX === Infinity) {
            return { min: new Vec3(0, 0, 0), max: new Vec3(0, 0, 0) };
        }

        return {
            min: new Vec3(minX, minY, minZ),
            max: new Vec3(maxX, maxY, maxZ),
        };
    }

    private static aabbOverlap(a: AABB, b: AABB): boolean {
        return (
            a.min.x <= b.max.x && a.max.x >= b.min.x &&
            a.min.y <= b.max.y && a.max.y >= b.min.y &&
            a.min.z <= b.max.z && a.max.z >= b.min.z
        );
    }
}
