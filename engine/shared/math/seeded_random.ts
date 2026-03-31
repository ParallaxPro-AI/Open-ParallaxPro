/**
 * Seeded pseudo-random number generator using xoshiro128**.
 * Deterministic: the same seed always produces the same sequence.
 */
export class SeededRandom {
    private s0: number;
    private s1: number;
    private s2: number;
    private s3: number;

    constructor(seed: number = 12345) {
        this.s0 = this.splitmix(seed);
        this.s1 = this.splitmix(this.s0);
        this.s2 = this.splitmix(this.s1);
        this.s3 = this.splitmix(this.s2);
    }

    private splitmix(state: number): number {
        state = (state + 0x9e3779b9) | 0;
        state = Math.imul(state ^ (state >>> 16), 0x85ebca6b);
        state = Math.imul(state ^ (state >>> 13), 0xc2b2ae35);
        return (state ^ (state >>> 16)) >>> 0;
    }

    private rotl(x: number, k: number): number {
        return (x << k) | (x >>> (32 - k));
    }

    /** Returns a float in [0, 1). */
    next(): number {
        const result = Math.imul(this.rotl(Math.imul(this.s1, 5), 7), 9);
        const t = this.s1 << 9;
        this.s2 ^= this.s0;
        this.s3 ^= this.s1;
        this.s1 ^= this.s2;
        this.s0 ^= this.s3;
        this.s2 ^= t;
        this.s3 = this.rotl(this.s3, 11);
        return (result >>> 0) / 4294967296;
    }

    /** Returns a float in [min, max). */
    range(min: number, max: number): number {
        return min + this.next() * (max - min);
    }

    /** Returns an integer in [min, max] inclusive. */
    int(min: number, max: number): number {
        return Math.floor(this.range(min, max + 1));
    }

    /** Reset the generator with a new seed. */
    setSeed(seed: number): void {
        this.s0 = this.splitmix(seed);
        this.s1 = this.splitmix(this.s0);
        this.s2 = this.splitmix(this.s1);
        this.s3 = this.splitmix(this.s2);
    }
}
