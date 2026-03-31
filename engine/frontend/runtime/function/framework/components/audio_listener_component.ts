import { Component } from '../component.js';

/**
 * AudioListenerComponent represents the "ears" in 3D audio.
 *
 * Only one should be active at a time (usually on the camera entity).
 * Each tick it updates the Web Audio API listener position and orientation
 * from the entity's world transform.
 */
export class AudioListenerComponent extends Component {
    private static sharedContext: AudioContext | null = null;

    tick(deltaTime: number): void {
        if (typeof AudioContext === 'undefined') return;

        const ctx = AudioListenerComponent.getAudioContext();
        if (!ctx) return;

        const listener = ctx.listener;
        const worldPos = this.entity.getWorldPosition();
        const worldRot = this.entity.getWorldRotation();

        if (listener.positionX) {
            listener.positionX.value = worldPos.x;
            listener.positionY.value = worldPos.y;
            listener.positionZ.value = worldPos.z;
        }

        // Compute forward and up vectors from world rotation quaternion.
        // Forward = rotation * (0, 0, -1), Up = rotation * (0, 1, 0)
        const qx = worldRot.x, qy = worldRot.y, qz = worldRot.z, qw = worldRot.w;

        const fwdX = 2 * (qx * qz + qw * qy);
        const fwdY = 2 * (qy * qz - qw * qx);
        const fwdZ = -(1 - 2 * (qx * qx + qy * qy));

        const upX = 2 * (qx * qy - qw * qz);
        const upY = 1 - 2 * (qx * qx + qz * qz);
        const upZ = 2 * (qy * qz + qw * qx);

        if (listener.forwardX) {
            listener.forwardX.value = fwdX;
            listener.forwardY.value = fwdY;
            listener.forwardZ.value = fwdZ;
            listener.upX.value = upX;
            listener.upY.value = upY;
            listener.upZ.value = upZ;
        }
    }

    initialize(data: Record<string, any>): void {}

    toJSON(): Record<string, any> {
        return {};
    }

    static getAudioContext(): AudioContext | null {
        if (!AudioListenerComponent.sharedContext && typeof AudioContext !== 'undefined') {
            AudioListenerComponent.sharedContext = new AudioContext();
        }
        return AudioListenerComponent.sharedContext;
    }

    static setAudioContext(ctx: AudioContext): void {
        AudioListenerComponent.sharedContext = ctx;
    }
}
