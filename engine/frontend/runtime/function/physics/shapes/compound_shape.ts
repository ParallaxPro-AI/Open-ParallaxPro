import { Vec3 } from '../../../core/math/vec3.js';
import { Quat } from '../../../core/math/quat.js';
import type { CollisionShape, AABB } from './box_shape.js';

export interface CompoundChild {
    shape: CollisionShape;
    position: Vec3;
    rotation: Quat;
}

/**
 * A collision shape composed of multiple child shapes, each with a
 * local-space offset. Allows a single rigid body to have a complex
 * collision volume built from multiple primitives.
 */
export class CompoundShape implements CollisionShape {
    readonly type = 'compound';
    readonly children: CompoundChild[];

    constructor(children: CompoundChild[]) {
        this.children = children.map(c => ({
            shape: c.shape,
            position: c.position.clone(),
            rotation: c.rotation.clone(),
        }));
    }

    addChild(shape: CollisionShape, position: Vec3, rotation: Quat): void {
        this.children.push({
            shape,
            position: position.clone(),
            rotation: rotation.clone(),
        });
    }

    removeChild(index: number): void {
        if (index >= 0 && index < this.children.length) {
            this.children.splice(index, 1);
        }
    }

    computeAABB(position: Vec3, rotation: Quat): AABB {
        if (this.children.length === 0) {
            return { min: position.clone(), max: position.clone() };
        }

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (const child of this.children) {
            const childWorldPos = rotation.mulVec3(child.position).add(position);
            const childWorldRot = rotation.multiply(child.rotation);
            const childAABB = child.shape.computeAABB(childWorldPos, childWorldRot);

            if (childAABB.min.x < minX) minX = childAABB.min.x;
            if (childAABB.min.y < minY) minY = childAABB.min.y;
            if (childAABB.min.z < minZ) minZ = childAABB.min.z;
            if (childAABB.max.x > maxX) maxX = childAABB.max.x;
            if (childAABB.max.y > maxY) maxY = childAABB.max.y;
            if (childAABB.max.z > maxZ) maxZ = childAABB.max.z;
        }

        return {
            min: new Vec3(minX, minY, minZ),
            max: new Vec3(maxX, maxY, maxZ),
        };
    }

    /**
     * Approximate compound inertia using the parallel axis theorem.
     * Mass is distributed equally among children.
     */
    computeInertia(mass: number): Vec3 {
        if (this.children.length === 0) {
            return new Vec3(0, 0, 0);
        }

        const childMass = mass / this.children.length;
        let ix = 0, iy = 0, iz = 0;

        for (const child of this.children) {
            const localInertia = child.shape.computeInertia(childMass);
            const px2 = child.position.x * child.position.x;
            const py2 = child.position.y * child.position.y;
            const pz2 = child.position.z * child.position.z;

            ix += localInertia.x + childMass * (py2 + pz2);
            iy += localInertia.y + childMass * (px2 + pz2);
            iz += localInertia.z + childMass * (px2 + py2);
        }

        return new Vec3(ix, iy, iz);
    }

    /**
     * Support function for GJK/SAT: find the point on the compound shape
     * furthest along the given direction.
     */
    getSupport(direction: Vec3): Vec3 {
        let bestDot = -Infinity;
        let bestPoint = new Vec3(0, 0, 0);

        for (const child of this.children) {
            const invChildRot = child.rotation.inverse();
            const localDir = invChildRot.mulVec3(direction);
            const localSupport = child.shape.getSupport(localDir);
            const compoundSupport = child.rotation.mulVec3(localSupport).add(child.position);

            const d = compoundSupport.dot(direction);
            if (d > bestDot) {
                bestDot = d;
                bestPoint = compoundSupport;
            }
        }

        return bestPoint;
    }

    getChildCount(): number {
        return this.children.length;
    }

    getChild(index: number): CompoundChild | null {
        if (index < 0 || index >= this.children.length) return null;
        return this.children[index];
    }

    getChildWorldTransform(
        index: number,
        bodyPosition: Vec3,
        bodyRotation: Quat
    ): { position: Vec3; rotation: Quat } | null {
        const child = this.getChild(index);
        if (!child) return null;

        return {
            position: bodyRotation.mulVec3(child.position).add(bodyPosition),
            rotation: bodyRotation.multiply(child.rotation),
        };
    }
}
