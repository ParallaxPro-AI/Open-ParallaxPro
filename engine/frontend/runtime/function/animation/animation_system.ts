import { Skeleton, JointPose } from './skeleton.js';
import { AnimationClip } from './animation_clip.js';
import { AnimationBlender, CrossFade } from './animation_blender.js';

/**
 * A runtime animator instance attached to an entity.
 */
export interface AnimatorComponent {
    entityId: number;
    skeleton: Skeleton;
    currentClip: AnimationClip | null;
    previousClip: AnimationClip | null;
    currentTime: number;
    speed: number;
    loop: boolean;
    playing: boolean;
    crossFade: CrossFade;
    previousTime: number;
    currentPose: JointPose[];
    /** Bind pose from the animation source skeleton, used for retargeting. */
    sourceBindPose?: JointPose[];
}

/**
 * Manages skeletons, animation clips, and animator components.
 * Ticks all active animators each frame to produce skinning poses.
 */
export class AnimationSystem {
    private skeletons: Map<string, Skeleton> = new Map();
    private clips: Map<string, AnimationClip> = new Map();
    private animators: Map<number, AnimatorComponent> = new Map();

    initialize(): void {}

    registerSkeleton(name: string, skeleton: Skeleton): void {
        this.skeletons.set(name, skeleton);
    }

    getSkeleton(name: string): Skeleton | undefined {
        return this.skeletons.get(name);
    }

    registerClip(name: string, clip: AnimationClip): void {
        this.clips.set(name, clip);
    }

    getClip(name: string): AnimationClip | undefined {
        return this.clips.get(name);
    }

    createAnimator(entityId: number, skeleton: Skeleton): AnimatorComponent {
        const animator: AnimatorComponent = {
            entityId,
            skeleton,
            currentClip: null,
            previousClip: null,
            currentTime: 0,
            speed: 1,
            loop: true,
            playing: false,
            crossFade: new CrossFade(),
            previousTime: 0,
            currentPose: skeleton.getBindPose(),
        };
        this.animators.set(entityId, animator);
        return animator;
    }

    getAnimator(entityId: number): AnimatorComponent | undefined {
        return this.animators.get(entityId);
    }

    removeAnimator(entityId: number): void {
        this.animators.delete(entityId);
    }

    /**
     * Play a clip on an animator, optionally cross-fading from the current clip.
     */
    play(entityId: number, clipName: string, crossFadeDuration: number = 0.3): void {
        const animator = this.animators.get(entityId);
        if (!animator) return;

        const clip = this.clips.get(clipName);
        if (!clip) return;

        if (animator.currentClip && crossFadeDuration > 0) {
            animator.previousClip = animator.currentClip;
            animator.previousTime = animator.currentTime;
            animator.crossFade.start(crossFadeDuration);
        }

        animator.currentClip = clip;
        animator.currentTime = 0;
        animator.playing = true;
    }

    stop(entityId: number): void {
        const animator = this.animators.get(entityId);
        if (animator) {
            animator.playing = false;
        }
    }

    /**
     * Advance all active animators by deltaTime, sampling clips and blending poses.
     */
    tick(deltaTime: number): void {
        for (const animator of this.animators.values()) {
            if (!animator.playing || !animator.currentClip) continue;

            animator.currentTime += deltaTime * animator.speed;
            if (animator.loop && animator.currentClip.duration > 0) {
                animator.currentTime = animator.currentTime % animator.currentClip.duration;
            } else if (animator.currentTime >= animator.currentClip.duration) {
                animator.currentTime = animator.currentClip.duration;
                animator.playing = false;
            }

            animator.crossFade.update(deltaTime);

            const boneCount = animator.skeleton.boneCount;
            const currentPoseMap = animator.currentClip.sample(animator.currentTime, boneCount);
            const basePose = animator.skeleton.getBindPose();
            let currentPose = AnimationBlender.applyPartial(basePose, currentPoseMap);

            // Blend with previous clip during cross-fade
            if (animator.crossFade.isActive() && animator.previousClip) {
                animator.previousTime += deltaTime * animator.speed;
                if (animator.loop && animator.previousClip.duration > 0) {
                    animator.previousTime = animator.previousTime % animator.previousClip.duration;
                }

                const prevPoseMap = animator.previousClip.sample(animator.previousTime, boneCount);
                const prevPose = AnimationBlender.applyPartial(basePose, prevPoseMap);
                const weight = animator.crossFade.getWeight();
                currentPose = AnimationBlender.blend(prevPose, currentPose, weight);
            }

            animator.currentPose = currentPose;
        }
    }

    shutdown(): void {
        this.skeletons.clear();
        this.clips.clear();
        this.animators.clear();
    }
}
