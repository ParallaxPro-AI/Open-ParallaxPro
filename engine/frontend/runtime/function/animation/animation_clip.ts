import { Vec3 } from '../../core/math/vec3.js';
import { Quat } from '../../core/math/quat.js';
import { JointPose } from './skeleton.js';

/**
 * A single keyframe in an animation track.
 */
export interface Keyframe<T> {
    time: number;
    value: T;
}

/**
 * An animation channel targeting a specific bone.
 */
export interface AnimChannel {
    boneIndex: number;
    positionKeys: Keyframe<Vec3>[];
    rotationKeys: Keyframe<Quat>[];
    scaleKeys: Keyframe<Vec3>[];
}

/**
 * A set of keyframed animation channels.
 * Supports sampling at any time with interpolation.
 */
export class AnimationClip {
    readonly name: string;
    readonly duration: number;
    readonly channels: AnimChannel[];

    constructor(name: string, duration: number, channels: AnimChannel[]) {
        this.name = name;
        this.duration = duration;
        this.channels = channels;
    }

    /**
     * Create an AnimationClip from serialized data.
     */
    static fromData(data: {
        name: string;
        duration: number;
        channels: {
            boneIndex: number;
            positionKeys: { time: number; value: [number, number, number] }[];
            rotationKeys: { time: number; value: [number, number, number, number] }[];
            scaleKeys: { time: number; value: [number, number, number] }[];
        }[];
    }): AnimationClip {
        const channels: AnimChannel[] = data.channels.map(ch => ({
            boneIndex: ch.boneIndex,
            positionKeys: ch.positionKeys.map(k => ({
                time: k.time,
                value: new Vec3(k.value[0], k.value[1], k.value[2]),
            })),
            rotationKeys: ch.rotationKeys.map(k => ({
                time: k.time,
                value: new Quat(k.value[0], k.value[1], k.value[2], k.value[3]),
            })),
            scaleKeys: ch.scaleKeys.map(k => ({
                time: k.time,
                value: new Vec3(k.value[0], k.value[1], k.value[2]),
            })),
        }));

        return new AnimationClip(data.name, data.duration, channels);
    }

    /**
     * Sample the clip at the given time, producing a partial pose map.
     * Only bones with channels are included in the result.
     */
    sample(time: number, boneCount: number): Map<number, JointPose> {
        const result = new Map<number, JointPose>();

        for (const channel of this.channels) {
            if (channel.boneIndex < 0 || channel.boneIndex >= boneCount) continue;

            const position = this.sampleVec3Track(channel.positionKeys, time) ?? new Vec3(0, 0, 0);
            const rotation = this.sampleQuatTrack(channel.rotationKeys, time) ?? new Quat(0, 0, 0, 1);
            const scale = this.sampleVec3Track(channel.scaleKeys, time) ?? new Vec3(1, 1, 1);

            result.set(channel.boneIndex, { position, rotation, scale });
        }

        return result;
    }

    private sampleVec3Track(keys: Keyframe<Vec3>[], time: number): Vec3 | null {
        if (keys.length === 0) return null;
        if (keys.length === 1) return keys[0].value.clone();

        if (time <= keys[0].time) return keys[0].value.clone();
        if (time >= keys[keys.length - 1].time) return keys[keys.length - 1].value.clone();

        let i = 0;
        for (; i < keys.length - 1; i++) {
            if (time < keys[i + 1].time) break;
        }

        const k0 = keys[i];
        const k1 = keys[i + 1];
        const dt = k1.time - k0.time;
        const t = dt > 1e-8 ? (time - k0.time) / dt : 0;

        return k0.value.lerp(k1.value, t);
    }

    private sampleQuatTrack(keys: Keyframe<Quat>[], time: number): Quat | null {
        if (keys.length === 0) return null;
        if (keys.length === 1) return keys[0].value.clone();

        if (time <= keys[0].time) return keys[0].value.clone();
        if (time >= keys[keys.length - 1].time) return keys[keys.length - 1].value.clone();

        let i = 0;
        for (; i < keys.length - 1; i++) {
            if (time < keys[i + 1].time) break;
        }

        const k0 = keys[i];
        const k1 = keys[i + 1];
        const dt = k1.time - k0.time;
        const t = dt > 1e-8 ? (time - k0.time) / dt : 0;

        return Quat.slerp(k0.value, k1.value, t);
    }
}
