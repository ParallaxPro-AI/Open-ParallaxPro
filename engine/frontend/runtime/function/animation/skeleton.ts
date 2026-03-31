import { Vec3 } from '../../core/math/vec3.js';
import { Quat } from '../../core/math/quat.js';
import { Mat4 } from '../../core/math/mat4.js';

/**
 * A local-space pose for a single joint/bone.
 */
export interface JointPose {
    position: Vec3;
    rotation: Quat;
    scale: Vec3;
}

/**
 * A bone in the skeleton hierarchy.
 */
export interface Bone {
    name: string;
    parentIndex: number; // -1 for root
    localBindPose: JointPose;
}

/**
 * Defines a bone hierarchy and computes joint matrices for skinned mesh rendering.
 */
export class Skeleton {
    readonly bones: Bone[];
    readonly inverseBindMatrices: Mat4[];

    constructor(bones: Bone[], inverseBindMatrices: Mat4[]) {
        this.bones = bones;
        this.inverseBindMatrices = inverseBindMatrices;
    }

    get boneCount(): number {
        return this.bones.length;
    }

    /**
     * Create a Skeleton from serialized data.
     */
    static fromData(data: {
        bones: { name: string; parentIndex: number; bindPose: { position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] } }[];
        inverseBindMatrices: Float32Array;
    }): Skeleton {
        const bones: Bone[] = data.bones.map(b => ({
            name: b.name,
            parentIndex: b.parentIndex,
            localBindPose: {
                position: new Vec3(b.bindPose.position[0], b.bindPose.position[1], b.bindPose.position[2]),
                rotation: new Quat(b.bindPose.rotation[0], b.bindPose.rotation[1], b.bindPose.rotation[2], b.bindPose.rotation[3]),
                scale: new Vec3(b.bindPose.scale[0], b.bindPose.scale[1], b.bindPose.scale[2]),
            },
        }));

        const inverseBindMatrices: Mat4[] = [];
        const boneCount = bones.length;
        for (let i = 0; i < boneCount; i++) {
            const mat = new Mat4();
            if (data.inverseBindMatrices.length >= (i + 1) * 16) {
                mat.data.set(data.inverseBindMatrices.subarray(i * 16, (i + 1) * 16));
            }
            inverseBindMatrices.push(mat);
        }

        return new Skeleton(bones, inverseBindMatrices);
    }

    /**
     * Get the bind pose as an array of cloned JointPose values.
     */
    getBindPose(): JointPose[] {
        return this.bones.map(b => ({
            position: b.localBindPose.position.clone(),
            rotation: b.localBindPose.rotation.clone(),
            scale: b.localBindPose.scale.clone(),
        }));
    }

    /**
     * Compute the final joint matrices (skin matrices) from a set of local poses.
     * Result: jointMatrices[i] = globalTransform[i] * inverseBindMatrix[i]
     */
    computeJointMatrices(localPoses: JointPose[]): Mat4[] {
        const count = this.bones.length;
        const globalTransforms: Mat4[] = new Array(count);
        const jointMatrices: Mat4[] = new Array(count);

        for (let i = 0; i < count; i++) {
            const pose = localPoses[i] ?? this.bones[i].localBindPose;
            const localMat = Mat4.compose(pose.position, pose.rotation, pose.scale);

            const parentIdx = this.bones[i].parentIndex;
            if (parentIdx >= 0 && parentIdx < i) {
                globalTransforms[i] = globalTransforms[parentIdx].multiply(localMat);
            } else {
                globalTransforms[i] = localMat;
            }

            jointMatrices[i] = globalTransforms[i].multiply(this.inverseBindMatrices[i]);
        }

        return jointMatrices;
    }

    /**
     * Find bone index by name. Returns -1 if not found.
     */
    findBoneIndex(name: string): number {
        for (let i = 0; i < this.bones.length; i++) {
            if (this.bones[i].name === name) return i;
        }
        return -1;
    }
}
