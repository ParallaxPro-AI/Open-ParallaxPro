/** Extract x/y/z from either a Vec3 (Float32Array-backed) or a plain {x,y,z} object. */
function rx(v: any): number { if (!v) return 0; return v.data ? v.data[0] : (v.x ?? 0); }
function ry(v: any): number { if (!v) return 0; return v.data ? v.data[1] : (v.y ?? 0); }
function rz(v: any): number { if (!v) return 0; return v.data ? v.data[2] : (v.z ?? 0); }

export class Vec3 {
    data: Float32Array;

    constructor(x: number = 0, y: number = 0, z: number = 0) {
        this.data = new Float32Array([x, y, z]);
    }

    get x(): number { return this.data[0]; }
    set x(v: number) { this.data[0] = v; }
    get y(): number { return this.data[1]; }
    set y(v: number) { this.data[1] = v; }
    get z(): number { return this.data[2]; }
    set z(v: number) { this.data[2] = v; }

    set(x: number, y: number, z: number): this {
        this.data[0] = x;
        this.data[1] = y;
        this.data[2] = z;
        return this;
    }

    copy(v: any): this {
        this.data[0] = rx(v);
        this.data[1] = ry(v);
        this.data[2] = rz(v);
        return this;
    }

    clone(): Vec3 {
        return new Vec3(this.data[0], this.data[1], this.data[2]);
    }

    add(v: any, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        r.data[0] = this.data[0] + rx(v);
        r.data[1] = this.data[1] + ry(v);
        r.data[2] = this.data[2] + rz(v);
        return r;
    }

    addInPlace(v: any): this {
        this.data[0] += rx(v);
        this.data[1] += ry(v);
        this.data[2] += rz(v);
        return this;
    }

    sub(v: any, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        r.data[0] = this.data[0] - rx(v);
        r.data[1] = this.data[1] - ry(v);
        r.data[2] = this.data[2] - rz(v);
        return r;
    }

    subtract(v: any, out?: Vec3): Vec3 {
        return this.sub(v, out);
    }

    multiply(v: any, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        if (typeof v === 'number') {
            r.data[0] = this.data[0] * v;
            r.data[1] = this.data[1] * v;
            r.data[2] = this.data[2] * v;
        } else {
            r.data[0] = this.data[0] * rx(v);
            r.data[1] = this.data[1] * ry(v);
            r.data[2] = this.data[2] * rz(v);
        }
        return r;
    }

    scale(s: number, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        r.data[0] = this.data[0] * s;
        r.data[1] = this.data[1] * s;
        r.data[2] = this.data[2] * s;
        return r;
    }

    multiplyScalar(s: number, out?: Vec3): Vec3 {
        return this.scale(s, out);
    }

    negate(out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        r.data[0] = -this.data[0];
        r.data[1] = -this.data[1];
        r.data[2] = -this.data[2];
        return r;
    }

    dot(v: any): number {
        return this.data[0] * rx(v) + this.data[1] * ry(v) + this.data[2] * rz(v);
    }

    cross(v: any, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        const ax = this.data[0], ay = this.data[1], az = this.data[2];
        const bx = rx(v), by = ry(v), bz = rz(v);
        r.data[0] = ay * bz - az * by;
        r.data[1] = az * bx - ax * bz;
        r.data[2] = ax * by - ay * bx;
        return r;
    }

    length(): number {
        const x = this.data[0], y = this.data[1], z = this.data[2];
        return Math.sqrt(x * x + y * y + z * z);
    }

    lengthSquared(): number {
        const x = this.data[0], y = this.data[1], z = this.data[2];
        return x * x + y * y + z * z;
    }

    normalize(out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        const len = this.length();
        if (len > 1e-6) {
            const invLen = 1 / len;
            r.data[0] = this.data[0] * invLen;
            r.data[1] = this.data[1] * invLen;
            r.data[2] = this.data[2] * invLen;
        } else {
            r.data[0] = 0;
            r.data[1] = 0;
            r.data[2] = 0;
        }
        return r;
    }

    distanceTo(v: any): number {
        const dx = this.data[0] - rx(v);
        const dy = this.data[1] - ry(v);
        const dz = this.data[2] - rz(v);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    distanceToSquared(v: any): number {
        const dx = this.data[0] - rx(v);
        const dy = this.data[1] - ry(v);
        const dz = this.data[2] - rz(v);
        return dx * dx + dy * dy + dz * dz;
    }

    lerp(v: any, t: number, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        const vx = rx(v), vy = ry(v), vz = rz(v);
        r.data[0] = this.data[0] + (vx - this.data[0]) * t;
        r.data[1] = this.data[1] + (vy - this.data[1]) * t;
        r.data[2] = this.data[2] + (vz - this.data[2]) * t;
        return r;
    }

    min(v: any, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        r.data[0] = Math.min(this.data[0], rx(v));
        r.data[1] = Math.min(this.data[1], ry(v));
        r.data[2] = Math.min(this.data[2], rz(v));
        return r;
    }

    max(v: any, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        r.data[0] = Math.max(this.data[0], rx(v));
        r.data[1] = Math.max(this.data[1], ry(v));
        r.data[2] = Math.max(this.data[2], rz(v));
        return r;
    }

    reflect(normal: any, out?: Vec3): Vec3 {
        const d = 2 * this.dot(normal);
        const r = out ?? new Vec3();
        r.data[0] = this.data[0] - d * rx(normal);
        r.data[1] = this.data[1] - d * ry(normal);
        r.data[2] = this.data[2] - d * rz(normal);
        return r;
    }

    project(v: any, out?: Vec3): Vec3 {
        const vx = rx(v), vy = ry(v), vz = rz(v);
        const denom = vx * vx + vy * vy + vz * vz;
        if (denom < 1e-12) {
            const r = out ?? new Vec3();
            r.set(0, 0, 0);
            return r;
        }
        const scalar = this.dot(v) / denom;
        const r = out ?? new Vec3();
        r.data[0] = vx * scalar;
        r.data[1] = vy * scalar;
        r.data[2] = vz * scalar;
        return r;
    }

    angle(v: any): number {
        const d = this.dot(v);
        const vLen = Math.sqrt(rx(v) ** 2 + ry(v) ** 2 + rz(v) ** 2);
        const lenProduct = this.length() * vLen;
        if (lenProduct < 1e-12) return 0;
        return Math.acos(Math.max(-1, Math.min(1, d / lenProduct)));
    }

    equals(v: any, epsilon: number = 1e-6): boolean {
        return (
            Math.abs(this.data[0] - rx(v)) < epsilon &&
            Math.abs(this.data[1] - ry(v)) < epsilon &&
            Math.abs(this.data[2] - rz(v)) < epsilon
        );
    }

    toArray(): [number, number, number] {
        return [this.data[0], this.data[1], this.data[2]];
    }

    fromArray(arr: ArrayLike<number>, offset: number = 0): this {
        this.data[0] = arr[offset];
        this.data[1] = arr[offset + 1];
        this.data[2] = arr[offset + 2];
        return this;
    }

    /** Rotate this vector by a quaternion. */
    applyQuaternion(q: { x: number; y: number; z: number; w: number }, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        const vx = this.data[0], vy = this.data[1], vz = this.data[2];
        const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
        const ix = qw * vx + qy * vz - qz * vy;
        const iy = qw * vy + qz * vx - qx * vz;
        const iz = qw * vz + qx * vy - qy * vx;
        const iw = -qx * vx - qy * vy - qz * vz;
        r.data[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
        r.data[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
        r.data[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
        return r;
    }

    toString(): string {
        const x = this.data[0], y = this.data[1], z = this.data[2];
        return `(${isNaN(x) ? '0.00' : x.toFixed(2)}, ${isNaN(y) ? '0.00' : y.toFixed(2)}, ${isNaN(z) ? '0.00' : z.toFixed(2)})`;
    }

    toJSON(): { x: number; y: number; z: number } {
        return { x: this.data[0], y: this.data[1], z: this.data[2] };
    }

    static fromJSON(json: { x: number; y: number; z: number }): Vec3 {
        return new Vec3(json.x, json.y, json.z);
    }

    /** Create a Vec3 from any {x,y,z} object or Vec3. */
    static from(v: any): Vec3 {
        if (v instanceof Vec3) return v;
        return new Vec3(v.x ?? 0, v.y ?? 0, v.z ?? 0);
    }

    // Right-handed coordinate system: +X right, +Y up, -Z forward
    static readonly ZERO = Object.freeze(new Vec3(0, 0, 0));
    static readonly ONE = Object.freeze(new Vec3(1, 1, 1));
    static readonly UP = Object.freeze(new Vec3(0, 1, 0));
    static readonly DOWN = Object.freeze(new Vec3(0, -1, 0));
    static readonly LEFT = Object.freeze(new Vec3(-1, 0, 0));
    static readonly RIGHT = Object.freeze(new Vec3(1, 0, 0));
    static readonly FORWARD = Object.freeze(new Vec3(0, 0, -1));
    static readonly BACK = Object.freeze(new Vec3(0, 0, 1));
}
