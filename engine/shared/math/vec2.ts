export class Vec2 {
    data: Float32Array;

    constructor(x: number = 0, y: number = 0) {
        this.data = new Float32Array([x, y]);
    }

    get x(): number { return this.data[0]; }
    set x(v: number) { this.data[0] = v; }
    get y(): number { return this.data[1]; }
    set y(v: number) { this.data[1] = v; }

    set(x: number, y: number): this {
        this.data[0] = x;
        this.data[1] = y;
        return this;
    }

    copy(v: Vec2): this {
        this.data[0] = v.data[0];
        this.data[1] = v.data[1];
        return this;
    }

    clone(): Vec2 {
        return new Vec2(this.data[0], this.data[1]);
    }

    add(v: Vec2, out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        r.data[0] = this.data[0] + v.data[0];
        r.data[1] = this.data[1] + v.data[1];
        return r;
    }

    sub(v: Vec2, out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        r.data[0] = this.data[0] - v.data[0];
        r.data[1] = this.data[1] - v.data[1];
        return r;
    }

    multiply(v: Vec2, out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        r.data[0] = this.data[0] * v.data[0];
        r.data[1] = this.data[1] * v.data[1];
        return r;
    }

    scale(s: number, out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        r.data[0] = this.data[0] * s;
        r.data[1] = this.data[1] * s;
        return r;
    }

    negate(out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        r.data[0] = -this.data[0];
        r.data[1] = -this.data[1];
        return r;
    }

    dot(v: Vec2): number {
        return this.data[0] * v.data[0] + this.data[1] * v.data[1];
    }

    cross(v: Vec2): number {
        return this.data[0] * v.data[1] - this.data[1] * v.data[0];
    }

    length(): number {
        return Math.sqrt(this.data[0] * this.data[0] + this.data[1] * this.data[1]);
    }

    lengthSquared(): number {
        return this.data[0] * this.data[0] + this.data[1] * this.data[1];
    }

    normalize(out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        const len = this.length();
        if (len > 1e-6) {
            const invLen = 1 / len;
            r.data[0] = this.data[0] * invLen;
            r.data[1] = this.data[1] * invLen;
        } else {
            r.data[0] = 0;
            r.data[1] = 0;
        }
        return r;
    }

    distanceTo(v: Vec2): number {
        const dx = this.data[0] - v.data[0];
        const dy = this.data[1] - v.data[1];
        return Math.sqrt(dx * dx + dy * dy);
    }

    distanceToSquared(v: Vec2): number {
        const dx = this.data[0] - v.data[0];
        const dy = this.data[1] - v.data[1];
        return dx * dx + dy * dy;
    }

    lerp(v: Vec2, t: number, out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        r.data[0] = this.data[0] + (v.data[0] - this.data[0]) * t;
        r.data[1] = this.data[1] + (v.data[1] - this.data[1]) * t;
        return r;
    }

    min(v: Vec2, out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        r.data[0] = Math.min(this.data[0], v.data[0]);
        r.data[1] = Math.min(this.data[1], v.data[1]);
        return r;
    }

    max(v: Vec2, out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        r.data[0] = Math.max(this.data[0], v.data[0]);
        r.data[1] = Math.max(this.data[1], v.data[1]);
        return r;
    }

    angle(): number {
        return Math.atan2(this.data[1], this.data[0]);
    }

    rotate(radians: number, out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        const x = this.data[0];
        const y = this.data[1];
        r.data[0] = x * cos - y * sin;
        r.data[1] = x * sin + y * cos;
        return r;
    }

    equals(v: Vec2, epsilon: number = 1e-6): boolean {
        return (
            Math.abs(this.data[0] - v.data[0]) < epsilon &&
            Math.abs(this.data[1] - v.data[1]) < epsilon
        );
    }

    toArray(): [number, number] {
        return [this.data[0], this.data[1]];
    }

    fromArray(arr: ArrayLike<number>, offset: number = 0): this {
        this.data[0] = arr[offset];
        this.data[1] = arr[offset + 1];
        return this;
    }

    toJSON(): { x: number; y: number } {
        return { x: this.data[0], y: this.data[1] };
    }

    static fromJSON(json: { x: number; y: number }): Vec2 {
        return new Vec2(json.x, json.y);
    }

    static readonly ZERO = Object.freeze(new Vec2(0, 0));
    static readonly ONE = Object.freeze(new Vec2(1, 1));
    static readonly UP = Object.freeze(new Vec2(0, 1));
    static readonly DOWN = Object.freeze(new Vec2(0, -1));
    static readonly LEFT = Object.freeze(new Vec2(-1, 0));
    static readonly RIGHT = Object.freeze(new Vec2(1, 0));
}
