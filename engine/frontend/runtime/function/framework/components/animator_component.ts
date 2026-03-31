import { Component } from '../component.js';
import { AnimationStateMachine } from '../../animation/animation_state_machine.js';

export interface AnimationLayer {
    name: string;
    clip: string;
    time: number;
    speed: number;
    looping: boolean;
    isPlaying: boolean;
    weight: number;
    boneMask: Set<number>;
}

/**
 * AnimatorComponent handles skeletal animation playback.
 *
 * References a skeleton and animation clips by asset UUID.
 * Each tick, samples the current clip, applies bone transforms, and computes
 * joint matrices for GPU skinning. Supports cross-fading between clips
 * and layered animation with per-bone masks.
 */
export class AnimatorComponent extends Component {
    skeletonAssetUUID: string = '';
    clips: Map<string, string> = new Map();

    skeleton: any = null;
    loadedClips: Map<string, any> = new Map();
    currentClip: string = '';
    currentTime: number = 0;
    speed: number = 1.0;
    isPlaying: boolean = false;
    looping: boolean = true;
    jointMatrices: Float32Array = new Float32Array(0);
    gpuJointMatricesBuffer: GPUBuffer | null = null;
    availableClipNames: string[] = [];

    stateMachine: AnimationStateMachine | null = null;
    layers: AnimationLayer[] = [];

    // Cross-fade state
    private crossFadeFrom: string = '';
    private crossFadeFromTime: number = 0;
    private crossFadeDuration: number = 0;
    private crossFadeElapsed: number = 0;
    private isCrossFading: boolean = false;

    // Pre-allocated scratch buffers (resized when bone count changes)
    private scratchBoneCount: number = 0;
    private scratchLocalPos: Float32Array = new Float32Array(0);
    private scratchLocalRot: Float32Array = new Float32Array(0);
    private scratchLocalScale: Float32Array = new Float32Array(0);
    private scratchGlobals: Float32Array = new Float32Array(0);
    private scratchLocalMat: Float32Array = new Float32Array(16);
    private scratchSample: number[] = [0, 0, 0, 0];

    // -- State Machine API ----------------------------------------------------

    createStateMachine(): AnimationStateMachine {
        this.stateMachine = new AnimationStateMachine();
        return this.stateMachine;
    }

    setFloat(name: string, value: number): void {
        this.stateMachine?.setFloat(name, value);
    }

    setBool(name: string, value: boolean): void {
        this.stateMachine?.setBool(name, value);
    }

    setTrigger(name: string): void {
        this.stateMachine?.setTrigger(name);
    }

    getCurrentStateName(): string {
        return this.stateMachine?.getCurrentStateName() ?? this.currentClip;
    }

    /**
     * Resolve a clip name. Tries exact match, then case-insensitive substring.
     */
    resolveClipName(name: string): string | null {
        if (this.clips.has(name)) return name;
        const lower = name.toLowerCase();
        for (const n of this.availableClipNames) {
            if (n.toLowerCase().includes(lower)) return n;
        }
        return null;
    }

    // -- Layer API ------------------------------------------------------------

    playOnLayer(
        layerName: string,
        clipName: string,
        boneMask: Set<number>,
        options: { loop?: boolean; speed?: number; weight?: number } = {}
    ): void {
        const resolved = this.resolveClipName(clipName);
        if (!resolved) return;
        clipName = resolved;

        let layer = this.layers.find(l => l.name === layerName);
        if (!layer) {
            layer = { name: layerName, clip: '', time: 0, speed: 1, looping: true, isPlaying: false, weight: 1, boneMask };
            this.layers.push(layer);
        }
        layer.clip = clipName;
        layer.time = 0;
        layer.speed = options.speed ?? 1;
        layer.looping = options.loop ?? false;
        layer.weight = options.weight ?? 1;
        layer.isPlaying = true;
        layer.boneMask = boneMask;
    }

    stopLayer(layerName: string): void {
        const layer = this.layers.find(l => l.name === layerName);
        if (layer) {
            layer.isPlaying = false;
            layer.clip = '';
        }
    }

    /**
     * Build a bone mask from bone names using the skeleton.
     * Includes the named bones and all their descendants.
     */
    buildBoneMask(boneNames: string[]): Set<number> {
        const mask = new Set<number>();
        if (!this.skeleton?.bones) return mask;
        const bones = this.skeleton.bones;

        const roots: number[] = [];
        for (let i = 0; i < bones.length; i++) {
            if (boneNames.includes(bones[i].name)) roots.push(i);
        }

        const queue = [...roots];
        while (queue.length > 0) {
            const idx = queue.shift()!;
            mask.add(idx);
            for (let i = 0; i < bones.length; i++) {
                if (bones[i].parentIndex === idx && !mask.has(i)) queue.push(i);
            }
        }
        return mask;
    }

    // -- Playback API ---------------------------------------------------------

    play(clipName: string, options: { loop?: boolean; speed?: number; blendTime?: number } = {}): void {
        const resolved = this.resolveClipName(clipName);
        if (!resolved) return;
        clipName = resolved;

        if (options.blendTime && options.blendTime > 0 && this.isPlaying && this.currentClip !== clipName) {
            this.crossFadeFrom = this.currentClip;
            this.crossFadeFromTime = this.currentTime;
            this.crossFadeDuration = options.blendTime;
            this.crossFadeElapsed = 0;
            this.isCrossFading = true;
        }

        this.currentClip = clipName;
        this.currentTime = 0;
        this.speed = options.speed ?? this.speed;
        this.looping = options.loop ?? true;
        this.isPlaying = true;
    }

    stop(): void {
        this.isPlaying = false;
        this.currentTime = 0;
        this.isCrossFading = false;
    }

    crossFade(clipName: string, duration: number): void {
        this.play(clipName, { blendTime: duration });
    }

    // -- Lifecycle ------------------------------------------------------------

    initialize(data: Record<string, any>): void {
        this.skeletonAssetUUID = data.skeletonAssetUUID ?? '';

        if (data.clips && typeof data.clips === 'object') {
            if (data.clips instanceof Map) {
                this.clips = new Map(data.clips);
            } else {
                this.clips = new Map(Object.entries(data.clips));
            }
        }

        this.speed = data.speed ?? 1.0;
        this.looping = data.looping ?? true;

        if (data.currentClip) {
            this.currentClip = data.currentClip;
        }

        this.markDirty();
    }

    tick(deltaTime: number): void {
        if (this.stateMachine) {
            const info = this.stateMachine.update(deltaTime);
            if (info.clip && info.clip !== this.currentClip) {
                if (info.blendFactor > 0 && info.blendFactor < 1) {
                    this.crossFadeFrom = this.currentClip;
                    this.crossFadeFromTime = this.currentTime;
                    this.crossFadeDuration = 0.2;
                    this.crossFadeElapsed = info.blendFactor * 0.2;
                    this.isCrossFading = true;
                }
                this.currentClip = info.clip;
                this.isPlaying = true;
            }
            this.currentTime = info.time;
        }

        if (!this.isPlaying || !this.currentClip) return;

        if (!this.stateMachine) {
            this.currentTime += deltaTime * this.speed;
        }

        if (this.isCrossFading) {
            this.crossFadeElapsed += deltaTime;
            this.crossFadeFromTime += deltaTime * this.speed;
            if (this.crossFadeElapsed >= this.crossFadeDuration) {
                this.isCrossFading = false;
                this.crossFadeFrom = '';
            }
        }

        // Handle looping / clip end
        const clipData = this.loadedClips.get(this.currentClip);
        if (clipData && clipData.duration !== undefined) {
            if (this.currentTime >= clipData.duration) {
                if (this.looping) {
                    this.currentTime = this.currentTime % clipData.duration;
                } else {
                    this.currentTime = clipData.duration;
                    this.isPlaying = false;
                }
            }
        }

        // Advance layer timers
        for (const layer of this.layers) {
            if (!layer.isPlaying || !layer.clip) continue;
            layer.time += deltaTime * layer.speed;
            const lClip = this.loadedClips.get(layer.clip);
            if (lClip && lClip.duration !== undefined) {
                if (layer.time >= lClip.duration) {
                    if (layer.looping) {
                        layer.time = layer.time % lClip.duration;
                    } else {
                        layer.time = lClip.duration;
                        layer.isPlaying = false;
                    }
                }
            }
        }

        // Sample animation and compute joint matrices
        if (this.skeleton && clipData && this.jointMatrices.length > 0) {
            this.sampleAndComputeJointMatrices(clipData);
        }

        this.markDirty();
    }

    onDestroy(): void {
        this.skeleton = null;
        this.loadedClips.clear();
        this.jointMatrices = new Float32Array(0);
        this.scratchBoneCount = 0;
        this.scratchLocalPos = new Float32Array(0);
        this.scratchLocalRot = new Float32Array(0);
        this.scratchLocalScale = new Float32Array(0);
        this.scratchGlobals = new Float32Array(0);
    }

    getCrossFadeState(): {
        isCrossFading: boolean;
        fromClip: string;
        fromTime: number;
        blendFactor: number;
    } {
        return {
            isCrossFading: this.isCrossFading,
            fromClip: this.crossFadeFrom,
            fromTime: this.crossFadeFromTime,
            blendFactor: this.crossFadeDuration > 0
                ? Math.min(this.crossFadeElapsed / this.crossFadeDuration, 1)
                : 1,
        };
    }

    toJSON(): Record<string, any> {
        const clipsObj: Record<string, string> = {};
        for (const [name, uuid] of this.clips) {
            clipsObj[name] = uuid;
        }
        return {
            skeletonAssetUUID: this.skeletonAssetUUID,
            clips: clipsObj,
            speed: this.speed,
            looping: this.looping,
        };
    }

    // -- Animation sampling ---------------------------------------------------

    private ensureScratchBuffers(boneCount: number): void {
        if (this.scratchBoneCount >= boneCount) return;
        this.scratchBoneCount = boneCount;
        this.scratchLocalPos = new Float32Array(boneCount * 3);
        this.scratchLocalRot = new Float32Array(boneCount * 4);
        this.scratchLocalScale = new Float32Array(boneCount * 3);
        this.scratchGlobals = new Float32Array(boneCount * 16);
    }

    private sampleAndComputeJointMatrices(clip: any): void {
        const bones = this.skeleton?.bones;
        if (!bones) return;
        const boneCount = bones.length;
        const time = this.currentTime;

        this.ensureScratchBuffers(boneCount);
        const localPos = this.scratchLocalPos;
        const localRot = this.scratchLocalRot;
        const localScale = this.scratchLocalScale;
        const globals = this.scratchGlobals;

        // Initialize with bind pose
        for (let i = 0; i < boneCount; i++) {
            const bp = bones[i].localBindPose;
            localPos[i * 3] = bp.position[0]; localPos[i * 3 + 1] = bp.position[1]; localPos[i * 3 + 2] = bp.position[2];
            localRot[i * 4] = bp.rotation[0]; localRot[i * 4 + 1] = bp.rotation[1]; localRot[i * 4 + 2] = bp.rotation[2]; localRot[i * 4 + 3] = bp.rotation[3];
            localScale[i * 3] = bp.scale[0]; localScale[i * 3 + 1] = bp.scale[1]; localScale[i * 3 + 2] = bp.scale[2];
        }

        // Cross-fade: sample "from" clip first, then blend "to" clip on top
        if (this.isCrossFading && this.crossFadeFrom) {
            const fromClip = this.loadedClips.get(this.crossFadeFrom);
            if (fromClip) {
                const blendFactor = Math.min(this.crossFadeElapsed / this.crossFadeDuration, 1);
                // Apply the "from" clip at full weight
                this.applyClipChannels(fromClip, this.crossFadeFromTime, boneCount, localPos, localRot, localScale, 1.0, new Set());
                // Blend the "to" clip on top using the blend factor
                this.applyClipChannels(clip, time, boneCount, localPos, localRot, localScale, blendFactor, new Set());
            } else {
                this.applyClipChannels(clip, time, boneCount, localPos, localRot, localScale, 1.0, new Set());
            }
        } else {
            this.applyClipChannels(clip, time, boneCount, localPos, localRot, localScale, 1.0, new Set());
        }

        // Apply animation layers (override masked bones)
        for (const layer of this.layers) {
            if (!layer.isPlaying || !layer.clip || layer.weight <= 0) continue;
            const lClip = this.loadedClips.get(layer.clip);
            if (!lClip) continue;
            this.applyClipChannels(lClip, layer.time, boneCount, localPos, localRot, localScale, layer.weight, layer.boneMask);
        }

        // Compute global transforms and joint matrices
        const localMat = this.scratchLocalMat;

        for (let i = 0; i < boneCount; i++) {
            this.composeTRS(
                localPos[i * 3], localPos[i * 3 + 1], localPos[i * 3 + 2],
                localRot[i * 4], localRot[i * 4 + 1], localRot[i * 4 + 2], localRot[i * 4 + 3],
                localScale[i * 3], localScale[i * 3 + 1], localScale[i * 3 + 2],
                localMat
            );

            const parentIdx = bones[i].parentIndex;
            const gOff = i * 16;

            if (parentIdx >= 0 && parentIdx < i) {
                this.multiplyMat4(globals, parentIdx * 16, localMat, 0, globals, gOff);
            } else {
                globals.set(localMat, gOff);
            }

            // Joint matrix = global * inverseBindMatrix
            const ibm = bones[i].inverseBindMatrix;
            this.multiplyMat4(globals, gOff, ibm, 0, this.jointMatrices, i * 16);
        }
    }

    private applyClipChannels(
        clip: any, time: number, boneCount: number,
        localPos: Float32Array, localRot: Float32Array, localScale: Float32Array,
        weight: number, boneMask: Set<number>
    ): void {
        const sample = this.scratchSample;
        for (const ch of clip.channels ?? []) {
            const bi = ch.boneIndex;
            if (bi < 0 || bi >= boneCount) continue;
            if (boneMask.size > 0 && !boneMask.has(bi)) continue;

            if (ch.positionKeys?.length) {
                this.sampleKeys(ch.positionKeys, time, 3, sample);
                if (weight >= 1) {
                    localPos[bi * 3] = sample[0]; localPos[bi * 3 + 1] = sample[1]; localPos[bi * 3 + 2] = sample[2];
                } else {
                    localPos[bi * 3] += (sample[0] - localPos[bi * 3]) * weight;
                    localPos[bi * 3 + 1] += (sample[1] - localPos[bi * 3 + 1]) * weight;
                    localPos[bi * 3 + 2] += (sample[2] - localPos[bi * 3 + 2]) * weight;
                }
            }
            if (ch.rotationKeys?.length) {
                this.sampleKeys(ch.rotationKeys, time, 4, sample);
                if (weight >= 1) {
                    localRot[bi * 4] = sample[0]; localRot[bi * 4 + 1] = sample[1]; localRot[bi * 4 + 2] = sample[2]; localRot[bi * 4 + 3] = sample[3];
                } else {
                    this.slerpInPlace(localRot, bi * 4, sample, weight);
                }
            }
            if (ch.scaleKeys?.length) {
                this.sampleKeys(ch.scaleKeys, time, 3, sample);
                if (weight >= 1) {
                    localScale[bi * 3] = sample[0]; localScale[bi * 3 + 1] = sample[1]; localScale[bi * 3 + 2] = sample[2];
                } else {
                    localScale[bi * 3] += (sample[0] - localScale[bi * 3]) * weight;
                    localScale[bi * 3 + 1] += (sample[1] - localScale[bi * 3 + 1]) * weight;
                    localScale[bi * 3 + 2] += (sample[2] - localScale[bi * 3 + 2]) * weight;
                }
            }
        }
    }

    private slerpInPlace(arr: Float32Array, offset: number, target: number[], t: number): void {
        const a0 = arr[offset], a1 = arr[offset + 1], a2 = arr[offset + 2], a3 = arr[offset + 3];
        let dot = a0 * target[0] + a1 * target[1] + a2 * target[2] + a3 * target[3];
        const flip = dot < 0 ? -1 : 1;
        dot = Math.abs(dot);
        let s0: number, s1: number;
        if (dot > 0.9999) {
            s0 = 1 - t; s1 = t * flip;
        } else {
            const om = Math.acos(dot);
            const si = Math.sin(om);
            s0 = Math.sin((1 - t) * om) / si;
            s1 = Math.sin(t * om) / si * flip;
        }
        const r0 = s0 * a0 + s1 * target[0];
        const r1 = s0 * a1 + s1 * target[1];
        const r2 = s0 * a2 + s1 * target[2];
        const r3 = s0 * a3 + s1 * target[3];
        const len = Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2 + r3 * r3) || 1;
        arr[offset] = r0 / len; arr[offset + 1] = r1 / len; arr[offset + 2] = r2 / len; arr[offset + 3] = r3 / len;
    }

    /** Write a TRS composition into an existing column-major 4x4 matrix buffer. */
    private composeTRS(
        px: number, py: number, pz: number,
        qx: number, qy: number, qz: number, qw: number,
        sx: number, sy: number, sz: number,
        out: Float32Array
    ): void {
        const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
        const xx = qx * x2, xy = qx * y2, xz = qx * z2;
        const yy = qy * y2, yz = qy * z2, zz = qz * z2;
        const wx = qw * x2, wy = qw * y2, wz = qw * z2;

        out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx;       out[2] = (xz - wy) * sx;       out[3] = 0;
        out[4] = (xy - wz) * sy;       out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy;       out[7] = 0;
        out[8] = (xz + wy) * sz;       out[9] = (yz - wx) * sz;       out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
        out[12] = px;                   out[13] = py;                   out[14] = pz;                   out[15] = 1;
    }

    /** Multiply two column-major 4x4 matrices: out = a * b. */
    private multiplyMat4(
        a: Float32Array, aOff: number,
        b: Float32Array | number[], bOff: number,
        out: Float32Array, outOff: number
    ): void {
        for (let col = 0; col < 4; col++) {
            for (let row = 0; row < 4; row++) {
                out[outOff + col * 4 + row] =
                    a[aOff + 0 * 4 + row] * b[bOff + col * 4 + 0] +
                    a[aOff + 1 * 4 + row] * b[bOff + col * 4 + 1] +
                    a[aOff + 2 * 4 + row] * b[bOff + col * 4 + 2] +
                    a[aOff + 3 * 4 + row] * b[bOff + col * 4 + 3];
            }
        }
    }

    /** Sample keyframes at a given time into the output array. Uses binary search + slerp for quaternions. */
    private sampleKeys(keys: { time: number; value: number[] }[], time: number, compCount: number, out: number[]): void {
        if (keys.length === 0) {
            out[0] = 0; out[1] = 0; out[2] = 0;
            if (compCount === 4) out[3] = 1;
            return;
        }
        if (time <= keys[0].time) {
            const v = keys[0].value;
            for (let i = 0; i < compCount; i++) out[i] = v[i];
            return;
        }
        if (time >= keys[keys.length - 1].time) {
            const v = keys[keys.length - 1].value;
            for (let i = 0; i < compCount; i++) out[i] = v[i];
            return;
        }

        // Binary search for the keyframe pair
        let lo = 0, hi = keys.length - 2;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (keys[mid + 1].time < time) lo = mid + 1;
            else hi = mid;
        }

        const k0 = keys[lo], k1 = keys[lo + 1];
        const t = (time - k0.time) / (k1.time - k0.time);
        const a = k0.value, b = k1.value;

        if (compCount === 4) {
            // Quaternion slerp
            let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
            const flip = dot < 0 ? -1 : 1;
            dot = Math.abs(dot);
            let s0: number, s1: number;
            if (dot > 0.9999) {
                s0 = 1 - t; s1 = t * flip;
            } else {
                const omega = Math.acos(dot);
                const sinO = Math.sin(omega);
                s0 = Math.sin((1 - t) * omega) / sinO;
                s1 = Math.sin(t * omega) / sinO * flip;
            }
            out[0] = s0 * a[0] + s1 * b[0];
            out[1] = s0 * a[1] + s1 * b[1];
            out[2] = s0 * a[2] + s1 * b[2];
            out[3] = s0 * a[3] + s1 * b[3];
            const len = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3]) || 1;
            out[0] /= len; out[1] /= len; out[2] /= len; out[3] /= len;
        } else {
            for (let i = 0; i < compCount; i++) {
                out[i] = a[i] + (b[i] - a[i]) * t;
            }
        }
    }
}
