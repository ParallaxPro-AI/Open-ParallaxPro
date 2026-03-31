export class Vec4 {
    data: Float32Array;

    constructor(x: number = 0, y: number = 0, z: number = 0, w: number = 0) {
        this.data = new Float32Array([x, y, z, w]);
    }

    get x(): number { return this.data[0]; }
    set x(v: number) { this.data[0] = v; }
    get y(): number { return this.data[1]; }
    set y(v: number) { this.data[1] = v; }
    get z(): number { return this.data[2]; }
    set z(v: number) { this.data[2] = v; }
    get w(): number { return this.data[3]; }
    set w(v: number) { this.data[3] = v; }

    set(x: number, y: number, z: number, w: number): this {
        this.data[0] = x;
        this.data[1] = y;
        this.data[2] = z;
        this.data[3] = w;
        return this;
    }

    copy(v: Vec4): this {
        this.data[0] = v.data[0];
        this.data[1] = v.data[1];
        this.data[2] = v.data[2];
        this.data[3] = v.data[3];
        return this;
    }

    clone(): Vec4 {
        return new Vec4(this.data[0], this.data[1], this.data[2], this.data[3]);
    }

    add(v: Vec4, out?: Vec4): Vec4 {
        const r = out ?? new Vec4();
        r.data[0] = this.data[0] + v.data[0];
        r.data[1] = this.data[1] + v.data[1];
        r.data[2] = this.data[2] + v.data[2];
        r.data[3] = this.data[3] + v.data[3];
        return r;
    }

    sub(v: Vec4, out?: Vec4): Vec4 {
        const r = out ?? new Vec4();
        r.data[0] = this.data[0] - v.data[0];
        r.data[1] = this.data[1] - v.data[1];
        r.data[2] = this.data[2] - v.data[2];
        r.data[3] = this.data[3] - v.data[3];
        return r;
    }

    multiply(v: Vec4, out?: Vec4): Vec4 {
        const r = out ?? new Vec4();
        r.data[0] = this.data[0] * v.data[0];
        r.data[1] = this.data[1] * v.data[1];
        r.data[2] = this.data[2] * v.data[2];
        r.data[3] = this.data[3] * v.data[3];
        return r;
    }

    scale(s: number, out?: Vec4): Vec4 {
        const r = out ?? new Vec4();
        r.data[0] = this.data[0] * s;
        r.data[1] = this.data[1] * s;
        r.data[2] = this.data[2] * s;
        r.data[3] = this.data[3] * s;
        return r;
    }

    negate(out?: Vec4): Vec4 {
        const r = out ?? new Vec4();
        r.data[0] = -this.data[0];
        r.data[1] = -this.data[1];
        r.data[2] = -this.data[2];
        r.data[3] = -this.data[3];
        return r;
    }

    dot(v: Vec4): number {
        return (
            this.data[0] * v.data[0] +
            this.data[1] * v.data[1] +
            this.data[2] * v.data[2] +
            this.data[3] * v.data[3]
        );
    }

    length(): number {
        const x = this.data[0], y = this.data[1], z = this.data[2], w = this.data[3];
        return Math.sqrt(x * x + y * y + z * z + w * w);
    }

    lengthSquared(): number {
        const x = this.data[0], y = this.data[1], z = this.data[2], w = this.data[3];
        return x * x + y * y + z * z + w * w;
    }

    normalize(out?: Vec4): Vec4 {
        const r = out ?? new Vec4();
        const len = this.length();
        if (len > 1e-6) {
            const invLen = 1 / len;
            r.data[0] = this.data[0] * invLen;
            r.data[1] = this.data[1] * invLen;
            r.data[2] = this.data[2] * invLen;
            r.data[3] = this.data[3] * invLen;
        } else {
            r.data[0] = 0;
            r.data[1] = 0;
            r.data[2] = 0;
            r.data[3] = 0;
        }
        return r;
    }

    lerp(v: Vec4, t: number, out?: Vec4): Vec4 {
        const r = out ?? new Vec4();
        r.data[0] = this.data[0] + (v.data[0] - this.data[0]) * t;
        r.data[1] = this.data[1] + (v.data[1] - this.data[1]) * t;
        r.data[2] = this.data[2] + (v.data[2] - this.data[2]) * t;
        r.data[3] = this.data[3] + (v.data[3] - this.data[3]) * t;
        return r;
    }

    min(v: Vec4, out?: Vec4): Vec4 {
        const r = out ?? new Vec4();
        r.data[0] = Math.min(this.data[0], v.data[0]);
        r.data[1] = Math.min(this.data[1], v.data[1]);
        r.data[2] = Math.min(this.data[2], v.data[2]);
        r.data[3] = Math.min(this.data[3], v.data[3]);
        return r;
    }

    max(v: Vec4, out?: Vec4): Vec4 {
        const r = out ?? new Vec4();
        r.data[0] = Math.max(this.data[0], v.data[0]);
        r.data[1] = Math.max(this.data[1], v.data[1]);
        r.data[2] = Math.max(this.data[2], v.data[2]);
        r.data[3] = Math.max(this.data[3], v.data[3]);
        return r;
    }

    equals(v: Vec4, epsilon: number = 1e-6): boolean {
        return (
            Math.abs(this.data[0] - v.data[0]) < epsilon &&
            Math.abs(this.data[1] - v.data[1]) < epsilon &&
            Math.abs(this.data[2] - v.data[2]) < epsilon &&
            Math.abs(this.data[3] - v.data[3]) < epsilon
        );
    }

    toArray(): [number, number, number, number] {
        return [this.data[0], this.data[1], this.data[2], this.data[3]];
    }

    fromArray(arr: ArrayLike<number>, offset: number = 0): this {
        this.data[0] = arr[offset];
        this.data[1] = arr[offset + 1];
        this.data[2] = arr[offset + 2];
        this.data[3] = arr[offset + 3];
        return this;
    }

    toJSON(): { x: number; y: number; z: number; w: number } {
        return { x: this.data[0], y: this.data[1], z: this.data[2], w: this.data[3] };
    }

    static fromJSON(json: { x: number; y: number; z: number; w: number }): Vec4 {
        return new Vec4(json.x, json.y, json.z, json.w);
    }

    static readonly ZERO = Object.freeze(new Vec4(0, 0, 0, 0));
    static readonly ONE = Object.freeze(new Vec4(1, 1, 1, 1));
}
