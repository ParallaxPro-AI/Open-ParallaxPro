export class MathUtils {
    static readonly PI = Math.PI;
    static readonly TWO_PI = Math.PI * 2;
    static readonly DEG2RAD = Math.PI / 180;
    static readonly RAD2DEG = 180 / Math.PI;
    static readonly EPSILON = 1e-6;

    static clamp(value: number, min: number, max: number): number {
        return value < min ? min : value > max ? max : value;
    }

    static lerp(a: number, b: number, t: number): number {
        return a + (b - a) * t;
    }

    static inverseLerp(a: number, b: number, value: number): number {
        if (Math.abs(b - a) < MathUtils.EPSILON) return 0;
        return (value - a) / (b - a);
    }

    static smoothstep(edge0: number, edge1: number, x: number): number {
        const t = MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
        return t * t * (3 - 2 * t);
    }

    static degreesToRadians(degrees: number): number {
        return degrees * MathUtils.DEG2RAD;
    }

    static radiansToDegrees(radians: number): number {
        return radians * MathUtils.RAD2DEG;
    }

    static isPowerOfTwo(value: number): boolean {
        return (value & (value - 1)) === 0 && value > 0;
    }

    static nextPowerOfTwo(value: number): number {
        if (value <= 0) return 1;
        value--;
        value |= value >> 1;
        value |= value >> 2;
        value |= value >> 4;
        value |= value >> 8;
        value |= value >> 16;
        return value + 1;
    }

    static randomRange(min: number, max: number): number {
        return min + Math.random() * (max - min);
    }
}
