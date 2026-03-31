import { Vec3 } from './vec3';

/** Extract quaternion components from either a Quat (Float32Array-backed) or a plain {x,y,z,w} object. */
function qx(q: any): number { if (!q) return 0; return q.data ? q.data[0] : (q.x ?? 0); }
function qy(q: any): number { if (!q) return 0; return q.data ? q.data[1] : (q.y ?? 0); }
function qz(q: any): number { if (!q) return 0; return q.data ? q.data[2] : (q.z ?? 0); }
function qw(q: any): number { if (!q) return 1; return q.data ? q.data[3] : (q.w ?? 1); }

/** Extract vector components from either a Vec3 or a plain {x,y,z} object. */
function vx(v: any): number { if (!v) return 0; return v.data ? v.data[0] : (v.x ?? 0); }
function vy(v: any): number { if (!v) return 0; return v.data ? v.data[1] : (v.y ?? 0); }
function vz(v: any): number { if (!v) return 0; return v.data ? v.data[2] : (v.z ?? 0); }

export class Quat {
    data: Float32Array;

    constructor(x: number = 0, y: number = 0, z: number = 0, w: number = 1) {
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

    copy(q: any): this {
        this.data[0] = qx(q);
        this.data[1] = qy(q);
        this.data[2] = qz(q);
        this.data[3] = qw(q);
        return this;
    }

    clone(): Quat {
        return new Quat(this.data[0], this.data[1], this.data[2], this.data[3]);
    }

    identity(): this {
        this.data[0] = 0;
        this.data[1] = 0;
        this.data[2] = 0;
        this.data[3] = 1;
        return this;
    }

    multiply(q: any, out?: Quat): Quat {
        const r = out ?? new Quat();
        const ax = this.data[0], ay = this.data[1], az = this.data[2], aw = this.data[3];
        const bx = qx(q), by = qy(q), bz = qz(q), bw = qw(q);
        r.data[0] = aw * bx + ax * bw + ay * bz - az * by;
        r.data[1] = aw * by - ax * bz + ay * bw + az * bx;
        r.data[2] = aw * bz + ax * by - ay * bx + az * bw;
        r.data[3] = aw * bw - ax * bx - ay * by - az * bz;
        return r;
    }

    conjugate(out?: Quat): Quat {
        const r = out ?? new Quat();
        r.data[0] = -this.data[0];
        r.data[1] = -this.data[1];
        r.data[2] = -this.data[2];
        r.data[3] = this.data[3];
        return r;
    }

    inverse(out?: Quat): Quat {
        const r = out ?? new Quat();
        const d = this.data[0] * this.data[0] + this.data[1] * this.data[1] +
                  this.data[2] * this.data[2] + this.data[3] * this.data[3];
        if (d > 1e-10) {
            const invDot = 1 / d;
            r.data[0] = -this.data[0] * invDot;
            r.data[1] = -this.data[1] * invDot;
            r.data[2] = -this.data[2] * invDot;
            r.data[3] = this.data[3] * invDot;
        } else {
            r.data[0] = 0;
            r.data[1] = 0;
            r.data[2] = 0;
            r.data[3] = 1;
        }
        return r;
    }

    dot(q: any): number {
        return (
            this.data[0] * qx(q) +
            this.data[1] * qy(q) +
            this.data[2] * qz(q) +
            this.data[3] * qw(q)
        );
    }

    length(): number {
        return Math.sqrt(
            this.data[0] * this.data[0] + this.data[1] * this.data[1] +
            this.data[2] * this.data[2] + this.data[3] * this.data[3]
        );
    }

    lengthSquared(): number {
        return (
            this.data[0] * this.data[0] + this.data[1] * this.data[1] +
            this.data[2] * this.data[2] + this.data[3] * this.data[3]
        );
    }

    normalize(out?: Quat): Quat {
        const r = out ?? new Quat();
        const len = this.length();
        if (len > 1e-6) {
            const invLen = 1 / len;
            r.data[0] = this.data[0] * invLen;
            r.data[1] = this.data[1] * invLen;
            r.data[2] = this.data[2] * invLen;
            r.data[3] = this.data[3] * invLen;
        } else {
            r.identity();
        }
        return r;
    }

    /** Rotate a Vec3 by this quaternion: q * v * q^-1. Accepts both Vec3 and plain {x,y,z}. */
    mulVec3(v: any, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        const _qx = this.data[0], _qy = this.data[1], _qz = this.data[2], _qw = this.data[3];
        const _vx = vx(v), _vy = vy(v), _vz = vz(v);
        const tx = 2 * (_qy * _vz - _qz * _vy);
        const ty = 2 * (_qz * _vx - _qx * _vz);
        const tz = 2 * (_qx * _vy - _qy * _vx);
        r.data[0] = _vx + _qw * tx + (_qy * tz - _qz * ty);
        r.data[1] = _vy + _qw * ty + (_qz * tx - _qx * tz);
        r.data[2] = _vz + _qw * tz + (_qx * ty - _qy * tx);
        return r;
    }

    rotateVec3(v: any, out?: Vec3): Vec3 {
        return this.mulVec3(v, out);
    }

    multiplyVector(v: any, out?: Vec3): Vec3 {
        return this.mulVec3(v, out);
    }

    /** Set this quaternion from an axis and angle (radians). */
    setFromAxisAngle(axis: any, radians: number): this {
        Quat.fromAxisAngle(axis, radians, this as any);
        return this;
    }

    /** Return a new quaternion rotated by `degrees` around the Y axis. */
    rotateY(degrees: number): Quat {
        const rad = degrees * (Math.PI / 180);
        return this.multiply(Quat.fromAxisAngle(new Vec3(0, 1, 0), rad));
    }

    /** Return a new quaternion rotated by `degrees` around the X axis. */
    rotateX(degrees: number): Quat {
        const rad = degrees * (Math.PI / 180);
        return this.multiply(Quat.fromAxisAngle(new Vec3(1, 0, 0), rad));
    }

    /** Return a new quaternion rotated by `degrees` around the Z axis. */
    rotateZ(degrees: number): Quat {
        const rad = degrees * (Math.PI / 180);
        return this.multiply(Quat.fromAxisAngle(new Vec3(0, 0, 1), rad));
    }

    /** Set this quaternion from Euler angles in degrees. */
    setRotationEuler(xDeg: number, yDeg: number, zDeg: number): this {
        const deg2rad = Math.PI / 180;
        Quat.fromEuler(xDeg * deg2rad, yDeg * deg2rad, zDeg * deg2rad, this as any);
        return this;
    }

    /** Convert this quaternion to Euler angles in degrees. */
    toEulerDegrees(): { x: number; y: number; z: number } {
        const x = this.data[0], y = this.data[1], z = this.data[2], w = this.data[3];
        const t0 = 2 * (w * x + y * z);
        const t1 = 1 - 2 * (x * x + y * y);
        const pitch = Math.atan2(t0, t1) * 180 / Math.PI;
        let t2 = 2 * (w * y - z * x);
        t2 = Math.max(-1, Math.min(1, t2));
        const yaw = Math.asin(t2) * 180 / Math.PI;
        const t3 = 2 * (w * z + x * y);
        const t4 = 1 - 2 * (y * y + z * z);
        const roll = Math.atan2(t3, t4) * 180 / Math.PI;
        return { x: pitch, y: yaw, z: roll };
    }

    /** Spherical linear interpolation between quaternions a and b. */
    static slerp(a: any, b: any, t: number, out?: Quat): Quat {
        const r = out ?? new Quat();
        const ax = qx(a), ay = qy(a), az = qz(a), aw = qw(a);
        let bx_ = qx(b), by_ = qy(b), bz_ = qz(b), bw_ = qw(b);
        let dot = ax * bx_ + ay * by_ + az * bz_ + aw * bw_;

        if (dot < 0) {
            dot = -dot;
            bx_ = -bx_; by_ = -by_; bz_ = -bz_; bw_ = -bw_;
        }

        let s0: number, s1: number;
        if (dot < 0.9995) {
            const omega = Math.acos(dot);
            const sinOmega = Math.sin(omega);
            s0 = Math.sin((1 - t) * omega) / sinOmega;
            s1 = Math.sin(t * omega) / sinOmega;
        } else {
            s0 = 1 - t;
            s1 = t;
        }

        r.data[0] = s0 * ax + s1 * bx_;
        r.data[1] = s0 * ay + s1 * by_;
        r.data[2] = s0 * az + s1 * bz_;
        r.data[3] = s0 * aw + s1 * bw_;
        return r;
    }

    /** Normalized linear interpolation (faster but less smooth than slerp). */
    static nlerp(a: any, b: any, t: number, out?: Quat): Quat {
        const r = out ?? new Quat();
        const ax = qx(a), ay = qy(a), az = qz(a), aw = qw(a);
        const bx_ = qx(b), by_ = qy(b), bz_ = qz(b), bw_ = qw(b);

        const dot = ax * bx_ + ay * by_ + az * bz_ + aw * bw_;
        const sign = dot < 0 ? -1 : 1;
        const s0 = 1 - t;
        const s1 = t * sign;

        r.data[0] = s0 * ax + s1 * bx_;
        r.data[1] = s0 * ay + s1 * by_;
        r.data[2] = s0 * az + s1 * bz_;
        r.data[3] = s0 * aw + s1 * bw_;

        const len = Math.sqrt(
            r.data[0] * r.data[0] + r.data[1] * r.data[1] +
            r.data[2] * r.data[2] + r.data[3] * r.data[3]
        );
        if (len > 1e-6) {
            const invLen = 1 / len;
            r.data[0] *= invLen;
            r.data[1] *= invLen;
            r.data[2] *= invLen;
            r.data[3] *= invLen;
        }
        return r;
    }

    static fromAxisAngle(axis: any, radians: number, out?: Quat): Quat {
        const r = out ?? new Quat();
        const half = radians * 0.5;
        const s = Math.sin(half);
        const ax = vx(axis), ay = vy(axis), az = vz(axis);
        const len = Math.sqrt(ax * ax + ay * ay + az * az);
        if (len > 1e-6) {
            const invLen = 1 / len;
            r.data[0] = ax * invLen * s;
            r.data[1] = ay * invLen * s;
            r.data[2] = az * invLen * s;
        } else {
            r.data[0] = 0;
            r.data[1] = 0;
            r.data[2] = 0;
        }
        r.data[3] = Math.cos(half);
        return r;
    }

    /** Convert Euler angles (radians) to a quaternion. Rotation order: XYZ. */
    static fromEuler(x: number, y: number, z: number, out?: Quat): Quat {
        const r = out ?? new Quat();
        const hx = x * 0.5, hy = y * 0.5, hz = z * 0.5;
        const sx = Math.sin(hx), cx = Math.cos(hx);
        const sy = Math.sin(hy), cy = Math.cos(hy);
        const sz = Math.sin(hz), cz = Math.cos(hz);
        r.data[0] = sx * cy * cz - cx * sy * sz;
        r.data[1] = cx * sy * cz + sx * cy * sz;
        r.data[2] = cx * cy * sz - sx * sy * cz;
        r.data[3] = cx * cy * cz + sx * sy * sz;
        return r;
    }

    /** Convert this quaternion to Euler angles (radians). Returns Vec3(pitch, yaw, roll). */
    toEuler(out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        const x = this.data[0], y = this.data[1], z = this.data[2], w = this.data[3];

        const sinr_cosp = 2 * (w * x + y * z);
        const cosr_cosp = 1 - 2 * (x * x + y * y);
        r.data[0] = Math.atan2(sinr_cosp, cosr_cosp);

        const sinp = 2 * (w * y - z * x);
        if (Math.abs(sinp) >= 1) {
            r.data[1] = Math.sign(sinp) * Math.PI / 2;
        } else {
            r.data[1] = Math.asin(sinp);
        }

        const siny_cosp = 2 * (w * z + x * y);
        const cosy_cosp = 1 - 2 * (y * y + z * z);
        r.data[2] = Math.atan2(siny_cosp, cosy_cosp);

        return r;
    }

    /** Create a quaternion from a 3x3 rotation matrix (column-major values). */
    static fromRotationMatrix(
        m0: number, m1: number, m2: number,
        m3: number, m4: number, m5: number,
        m6: number, m7: number, m8: number,
        out?: Quat
    ): Quat {
        const r = out ?? new Quat();
        const trace = m0 + m4 + m8;

        if (trace > 0) {
            const s = 0.5 / Math.sqrt(trace + 1.0);
            r.data[3] = 0.25 / s;
            r.data[0] = (m5 - m7) * s;
            r.data[1] = (m6 - m2) * s;
            r.data[2] = (m1 - m3) * s;
        } else if (m0 > m4 && m0 > m8) {
            const s = 2.0 * Math.sqrt(1.0 + m0 - m4 - m8);
            r.data[3] = (m5 - m7) / s;
            r.data[0] = 0.25 * s;
            r.data[1] = (m3 + m1) / s;
            r.data[2] = (m6 + m2) / s;
        } else if (m4 > m8) {
            const s = 2.0 * Math.sqrt(1.0 + m4 - m0 - m8);
            r.data[3] = (m6 - m2) / s;
            r.data[0] = (m3 + m1) / s;
            r.data[1] = 0.25 * s;
            r.data[2] = (m7 + m5) / s;
        } else {
            const s = 2.0 * Math.sqrt(1.0 + m8 - m0 - m4);
            r.data[3] = (m1 - m3) / s;
            r.data[0] = (m6 + m2) / s;
            r.data[1] = (m7 + m5) / s;
            r.data[2] = 0.25 * s;
        }

        return r;
    }

    equals(q: any, epsilon: number = 1e-6): boolean {
        return (
            Math.abs(this.data[0] - qx(q)) < epsilon &&
            Math.abs(this.data[1] - qy(q)) < epsilon &&
            Math.abs(this.data[2] - qz(q)) < epsilon &&
            Math.abs(this.data[3] - qw(q)) < epsilon
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

    static fromJSON(json: { x: number; y: number; z: number; w: number }): Quat {
        return new Quat(json.x, json.y, json.z, json.w);
    }

    /** Create a Quat from any {x,y,z,w} object or Quat. */
    static from(q: any): Quat {
        if (q instanceof Quat) return q;
        return new Quat(q.x ?? 0, q.y ?? 0, q.z ?? 0, q.w ?? 1);
    }

    static readonly IDENTITY = Object.freeze(new Quat(0, 0, 0, 1));
}
