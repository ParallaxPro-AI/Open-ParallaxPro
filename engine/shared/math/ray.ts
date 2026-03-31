import { Vec3 } from './vec3';
import { AABB } from './aabb';

/**
 * A ray defined by an origin point and a normalized direction vector.
 */
export class Ray {
    origin: Vec3;
    direction: Vec3;

    constructor(origin?: Vec3, direction?: Vec3) {
        this.origin = origin ? origin.clone() : new Vec3(0, 0, 0);
        this.direction = direction ? direction.normalize() : new Vec3(0, 0, -1);
    }

    /** Get the point at distance t along the ray. */
    at(t: number, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        r.data[0] = this.origin.data[0] + this.direction.data[0] * t;
        r.data[1] = this.origin.data[1] + this.direction.data[1] * t;
        r.data[2] = this.origin.data[2] + this.direction.data[2] * t;
        return r;
    }

    /**
     * Ray-AABB intersection using the slab method.
     * Returns the distance t to the nearest intersection, or null if no hit.
     */
    intersectAABB(aabb: AABB): number | null {
        const ox = this.origin.data[0], oy = this.origin.data[1], oz = this.origin.data[2];
        const dx = this.direction.data[0], dy = this.direction.data[1], dz = this.direction.data[2];

        let tmin = -Infinity;
        let tmax = Infinity;

        // X slab
        if (Math.abs(dx) > 1e-12) {
            const invD = 1 / dx;
            let t1 = (aabb.min.data[0] - ox) * invD;
            let t2 = (aabb.max.data[0] - ox) * invD;
            if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
            tmin = Math.max(tmin, t1);
            tmax = Math.min(tmax, t2);
            if (tmin > tmax) return null;
        } else {
            if (ox < aabb.min.data[0] || ox > aabb.max.data[0]) return null;
        }

        // Y slab
        if (Math.abs(dy) > 1e-12) {
            const invD = 1 / dy;
            let t1 = (aabb.min.data[1] - oy) * invD;
            let t2 = (aabb.max.data[1] - oy) * invD;
            if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
            tmin = Math.max(tmin, t1);
            tmax = Math.min(tmax, t2);
            if (tmin > tmax) return null;
        } else {
            if (oy < aabb.min.data[1] || oy > aabb.max.data[1]) return null;
        }

        // Z slab
        if (Math.abs(dz) > 1e-12) {
            const invD = 1 / dz;
            let t1 = (aabb.min.data[2] - oz) * invD;
            let t2 = (aabb.max.data[2] - oz) * invD;
            if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
            tmin = Math.max(tmin, t1);
            tmax = Math.min(tmax, t2);
            if (tmin > tmax) return null;
        } else {
            if (oz < aabb.min.data[2] || oz > aabb.max.data[2]) return null;
        }

        if (tmax < 0) return null;
        return tmin >= 0 ? tmin : tmax;
    }

    /**
     * Ray-plane intersection.
     * Plane defined by a normal and distance d (normal.dot(point) = d).
     * Returns the distance t along the ray, or null if parallel or behind.
     */
    intersectPlane(normal: Vec3, d: number): number | null {
        const denom = normal.dot(this.direction);
        if (Math.abs(denom) < 1e-12) return null;

        const t = (d - normal.dot(this.origin)) / denom;
        if (t < 0) return null;
        return t;
    }

    /**
     * Ray-sphere intersection.
     * Returns the nearest positive distance t to the sphere surface, or null.
     */
    intersectSphere(center: Vec3, radius: number): number | null {
        const ocx = this.origin.data[0] - center.data[0];
        const ocy = this.origin.data[1] - center.data[1];
        const ocz = this.origin.data[2] - center.data[2];

        const dx = this.direction.data[0], dy = this.direction.data[1], dz = this.direction.data[2];

        const a = dx * dx + dy * dy + dz * dz;
        const b = 2 * (ocx * dx + ocy * dy + ocz * dz);
        const c = ocx * ocx + ocy * ocy + ocz * ocz - radius * radius;

        const discriminant = b * b - 4 * a * c;
        if (discriminant < 0) return null;

        const sqrtD = Math.sqrt(discriminant);
        const inv2a = 1 / (2 * a);

        const t0 = (-b - sqrtD) * inv2a;
        const t1 = (-b + sqrtD) * inv2a;

        if (t0 >= 0) return t0;
        if (t1 >= 0) return t1;
        return null;
    }

    /**
     * Ray-triangle intersection using the Moller-Trumbore algorithm.
     * Returns { t, u, v } with distance and barycentric coordinates, or null.
     */
    intersectTriangle(
        v0: Vec3, v1: Vec3, v2: Vec3,
        cullBackFace: boolean = false
    ): { t: number; u: number; v: number } | null {
        const edge1x = v1.data[0] - v0.data[0];
        const edge1y = v1.data[1] - v0.data[1];
        const edge1z = v1.data[2] - v0.data[2];

        const edge2x = v2.data[0] - v0.data[0];
        const edge2y = v2.data[1] - v0.data[1];
        const edge2z = v2.data[2] - v0.data[2];

        const dx = this.direction.data[0];
        const dy = this.direction.data[1];
        const dz = this.direction.data[2];

        // P = cross(direction, edge2)
        const px = dy * edge2z - dz * edge2y;
        const py = dz * edge2x - dx * edge2z;
        const pz = dx * edge2y - dy * edge2x;

        const det = edge1x * px + edge1y * py + edge1z * pz;

        if (cullBackFace) {
            if (det < 1e-12) return null;
        } else {
            if (Math.abs(det) < 1e-12) return null;
        }

        const invDet = 1 / det;

        // T = origin - v0
        const tx = this.origin.data[0] - v0.data[0];
        const ty = this.origin.data[1] - v0.data[1];
        const tz = this.origin.data[2] - v0.data[2];

        const u = (tx * px + ty * py + tz * pz) * invDet;
        if (u < 0 || u > 1) return null;

        // Q = cross(T, edge1)
        const qx = ty * edge1z - tz * edge1y;
        const qy = tz * edge1x - tx * edge1z;
        const qz = tx * edge1y - ty * edge1x;

        const v = (dx * qx + dy * qy + dz * qz) * invDet;
        if (v < 0 || u + v > 1) return null;

        const t = (edge2x * qx + edge2y * qy + edge2z * qz) * invDet;
        if (t < 0) return null;

        return { t, u, v };
    }

    copy(ray: Ray): this {
        this.origin.copy(ray.origin);
        this.direction.copy(ray.direction);
        return this;
    }

    clone(): Ray {
        return new Ray(this.origin, this.direction);
    }

    toJSON(): {
        origin: { x: number; y: number; z: number };
        direction: { x: number; y: number; z: number };
    } {
        return {
            origin: this.origin.toJSON(),
            direction: this.direction.toJSON(),
        };
    }

    static fromJSON(json: {
        origin: { x: number; y: number; z: number };
        direction: { x: number; y: number; z: number };
    }): Ray {
        return new Ray(Vec3.fromJSON(json.origin), Vec3.fromJSON(json.direction));
    }
}
