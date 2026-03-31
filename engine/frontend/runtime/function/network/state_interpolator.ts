import { Vec3 } from '../../core/math/vec3.js';
import { Quat } from '../../core/math/quat.js';

export interface StateSnapshot {
    entityId: number;
    position: Vec3;
    rotation: Quat;
    velocity: Vec3;
    timestamp: number;
}

export interface InterpolatedState {
    position: Vec3;
    rotation: Quat;
}

/**
 * Buffers server snapshots and interpolates between them for smooth
 * remote entity rendering. Uses a fixed interpolation delay to ensure
 * two snapshots are always available.
 */
export class StateInterpolator {
    private buffers: Map<number, StateSnapshot[]> = new Map();
    private interpolationDelay: number = 0.1;
    private maxBufferSize: number = 30;

    constructor(interpolationDelay: number = 0.1) {
        this.interpolationDelay = interpolationDelay;
    }

    setInterpolationDelay(delay: number): void {
        this.interpolationDelay = Math.max(0, delay);
    }

    addSnapshot(snapshot: StateSnapshot): void {
        let buffer = this.buffers.get(snapshot.entityId);
        if (!buffer) {
            buffer = [];
            this.buffers.set(snapshot.entityId, buffer);
        }

        buffer.push(snapshot);
        buffer.sort((a, b) => a.timestamp - b.timestamp);

        while (buffer.length > this.maxBufferSize) {
            buffer.shift();
        }
    }

    interpolate(entityId: number, renderTime: number): InterpolatedState | null {
        const buffer = this.buffers.get(entityId);
        if (!buffer || buffer.length === 0) return null;

        const targetTime = renderTime - this.interpolationDelay;

        if (targetTime <= buffer[0].timestamp) {
            return {
                position: buffer[0].position.clone(),
                rotation: buffer[0].rotation.clone(),
            };
        }

        if (targetTime >= buffer[buffer.length - 1].timestamp) {
            const last = buffer[buffer.length - 1];
            if (buffer.length >= 2) {
                const prev = buffer[buffer.length - 2];
                const dt = last.timestamp - prev.timestamp;
                if (dt > 0) {
                    const extrapolateTime = targetTime - last.timestamp;
                    const clampedExtra = Math.min(extrapolateTime, dt * 2);
                    return {
                        position: last.position.add(last.velocity.scale(clampedExtra)),
                        rotation: last.rotation.clone(),
                    };
                }
            }
            return {
                position: last.position.clone(),
                rotation: last.rotation.clone(),
            };
        }

        for (let i = 0; i < buffer.length - 1; i++) {
            const s0 = buffer[i];
            const s1 = buffer[i + 1];
            if (targetTime >= s0.timestamp && targetTime <= s1.timestamp) {
                const dt = s1.timestamp - s0.timestamp;
                const t = dt > 0 ? (targetTime - s0.timestamp) / dt : 0;
                return {
                    position: s0.position.lerp(s1.position, t),
                    rotation: Quat.slerp(s0.rotation, s1.rotation, t),
                };
            }
        }

        return null;
    }

    removeEntity(entityId: number): void {
        this.buffers.delete(entityId);
    }

    clear(): void {
        this.buffers.clear();
    }

    prune(cutoffTime: number): void {
        for (const [entityId, buffer] of this.buffers) {
            while (buffer.length > 2 && buffer[0].timestamp < cutoffTime) {
                buffer.shift();
            }
            if (buffer.length === 0) {
                this.buffers.delete(entityId);
            }
        }
    }
}
