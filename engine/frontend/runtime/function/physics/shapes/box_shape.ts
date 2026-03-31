import { Vec3 } from '../../../core/math/vec3.js';
import { Mat4 } from '../../../core/math/mat4.js';
import { Quat } from '../../../core/math/quat.js';

export interface AABB {
    min: Vec3;
    max: Vec3;
}

export interface CollisionShape {
    readonly type: string;
    computeAABB(position: Vec3, rotation: Quat): AABB;
    computeInertia(mass: number): Vec3;
    getSupport(direction: Vec3): Vec3;
}

export class BoxShape implements CollisionShape {
    readonly type = 'box';
    readonly halfExtents: Vec3;

    constructor(halfExtents: Vec3) {
        this.halfExtents = halfExtents.clone();
    }

    computeAABB(position: Vec3, rotation: Quat): AABB {
        const rotMat = Mat4.fromQuat(rotation);
        const d = rotMat.data;

        const ex = this.halfExtents.x;
        const ey = this.halfExtents.y;
        const ez = this.halfExtents.z;

        // Project box axes onto world axes to compute extent
        const extentX = Math.abs(d[0]) * ex + Math.abs(d[4]) * ey + Math.abs(d[8]) * ez;
        const extentY = Math.abs(d[1]) * ex + Math.abs(d[5]) * ey + Math.abs(d[9]) * ez;
        const extentZ = Math.abs(d[2]) * ex + Math.abs(d[6]) * ey + Math.abs(d[10]) * ez;

        return {
            min: new Vec3(position.x - extentX, position.y - extentY, position.z - extentZ),
            max: new Vec3(position.x + extentX, position.y + extentY, position.z + extentZ),
        };
    }

    computeInertia(mass: number): Vec3 {
        const ex = this.halfExtents.x * 2;
        const ey = this.halfExtents.y * 2;
        const ez = this.halfExtents.z * 2;
        const factor = mass / 12;
        return new Vec3(
            factor * (ey * ey + ez * ez),
            factor * (ex * ex + ez * ez),
            factor * (ex * ex + ey * ey)
        );
    }

    getSupport(direction: Vec3): Vec3 {
        return new Vec3(
            direction.x >= 0 ? this.halfExtents.x : -this.halfExtents.x,
            direction.y >= 0 ? this.halfExtents.y : -this.halfExtents.y,
            direction.z >= 0 ? this.halfExtents.z : -this.halfExtents.z
        );
    }
}
