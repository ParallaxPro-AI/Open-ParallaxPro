import { Vec3 } from '../../core/math/vec3.js';
import { Quat } from '../../core/math/quat.js';
import { JointPose } from './skeleton.js';

/**
 * Blends two pose arrays together and provides cross-fade helpers.
 */
export class AnimationBlender {
    /**
     * Blend two full pose arrays by weight t (0 = all poseA, 1 = all poseB).
     */
    static blend(poseA: JointPose[], poseB: JointPose[], t: number): JointPose[] {
        const result: JointPose[] = [];
        const count = Math.max(poseA.length, poseB.length);
        const clamped = Math.max(0, Math.min(1, t));

        for (let i = 0; i < count; i++) {
            const a = poseA[i];
            const b = poseB[i];

            if (a && b) {
                result.push({
                    position: a.position.lerp(b.position, clamped),
                    rotation: Quat.slerp(a.rotation, b.rotation, clamped),
                    scale: a.scale.lerp(b.scale, clamped),
                });
            } else if (a) {
                result.push({
                    position: a.position.clone(),
                    rotation: a.rotation.clone(),
                    scale: a.scale.clone(),
                });
            } else if (b) {
                result.push({
                    position: b.position.clone(),
                    rotation: b.rotation.clone(),
                    scale: b.scale.clone(),
                });
            } else {
                result.push({
                    position: new Vec3(0, 0, 0),
                    rotation: new Quat(0, 0, 0, 1),
                    scale: new Vec3(1, 1, 1),
                });
            }
        }

        return result;
    }

    /**
     * Apply a partial pose (from AnimationClip.sample()) on top of a base pose.
     * Only bones present in the partial map are overridden.
     */
    static applyPartial(basePose: JointPose[], partial: Map<number, JointPose>, weight: number = 1.0): JointPose[] {
        const result: JointPose[] = basePose.map(p => ({
            position: p.position.clone(),
            rotation: p.rotation.clone(),
            scale: p.scale.clone(),
        }));

        const clamped = Math.max(0, Math.min(1, weight));

        for (const [index, pose] of partial) {
            if (index < result.length) {
                const base = result[index];
                base.position = base.position.lerp(pose.position, clamped);
                base.rotation = Quat.slerp(base.rotation, pose.rotation, clamped);
                base.scale = base.scale.lerp(pose.scale, clamped);
            }
        }

        return result;
    }
}

/**
 * Manages a timed cross-fade between two animations with smoothstep easing.
 */
export class CrossFade {
    private duration: number;
    private elapsed: number = 0;
    private active: boolean = false;

    constructor(duration: number = 0.3) {
        this.duration = Math.max(0.01, duration);
    }

    start(duration?: number): void {
        if (duration !== undefined) this.duration = Math.max(0.01, duration);
        this.elapsed = 0;
        this.active = true;
    }

    update(deltaTime: number): void {
        if (!this.active) return;
        this.elapsed += deltaTime;
        if (this.elapsed >= this.duration) {
            this.active = false;
            this.elapsed = this.duration;
        }
    }

    /** Returns blend weight (0 at start, 1 when complete) with smoothstep easing. */
    getWeight(): number {
        if (!this.active) return 1;
        const t = Math.min(this.elapsed / this.duration, 1);
        return t * t * (3 - 2 * t);
    }

    isActive(): boolean {
        return this.active;
    }

    isComplete(): boolean {
        return !this.active && this.elapsed >= this.duration;
    }

    reset(): void {
        this.elapsed = 0;
        this.active = false;
    }
}
