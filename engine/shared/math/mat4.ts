import { Vec3 } from './vec3';
import { Vec4 } from './vec4';
import { Quat } from './quat';

/**
 * 4x4 matrix stored in column-major order (WebGPU/OpenGL convention).
 *
 * Layout indices:
 *   col0: [0,1,2,3]   col1: [4,5,6,7]   col2: [8,9,10,11]  col3: [12,13,14,15]
 *
 * Conceptual row-column view:
 *   m00(0)  m01(4)  m02(8)   m03(12)
 *   m10(1)  m11(5)  m12(9)   m13(13)
 *   m20(2)  m21(6)  m22(10)  m23(14)
 *   m30(3)  m31(7)  m32(11)  m33(15)
 */
export class Mat4 {
    data: Float32Array;

    constructor() {
        this.data = new Float32Array(16);
        this.data[0] = 1;
        this.data[5] = 1;
        this.data[10] = 1;
        this.data[15] = 1;
    }

    static identity(out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        const d = r.data;
        d[0] = 1;  d[1] = 0;  d[2] = 0;  d[3] = 0;
        d[4] = 0;  d[5] = 1;  d[6] = 0;  d[7] = 0;
        d[8] = 0;  d[9] = 0;  d[10] = 1; d[11] = 0;
        d[12] = 0; d[13] = 0; d[14] = 0; d[15] = 1;
        return r;
    }

    setIdentity(): this {
        this.data.fill(0);
        this.data[0] = 1;
        this.data[5] = 1;
        this.data[10] = 1;
        this.data[15] = 1;
        return this;
    }

    /** Set from row-major values (stored internally as column-major). */
    set(
        m00: number, m01: number, m02: number, m03: number,
        m10: number, m11: number, m12: number, m13: number,
        m20: number, m21: number, m22: number, m23: number,
        m30: number, m31: number, m32: number, m33: number
    ): this {
        const d = this.data;
        d[0] = m00; d[1] = m10; d[2] = m20; d[3] = m30;
        d[4] = m01; d[5] = m11; d[6] = m21; d[7] = m31;
        d[8] = m02; d[9] = m12; d[10] = m22; d[11] = m32;
        d[12] = m03; d[13] = m13; d[14] = m23; d[15] = m33;
        return this;
    }

    copy(m: Mat4): this {
        this.data.set(m.data);
        return this;
    }

    clone(): Mat4 {
        const r = new Mat4();
        r.data.set(this.data);
        return r;
    }

    multiply(b: Mat4, out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        const a = this.data;
        const bd = b.data;
        const rd = r.data;
        for (let col = 0; col < 4; col++) {
            const bCol = col * 4;
            const b0 = bd[bCol], b1 = bd[bCol + 1], b2 = bd[bCol + 2], b3 = bd[bCol + 3];
            rd[bCol]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
            rd[bCol + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
            rd[bCol + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
            rd[bCol + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
        }
        return r;
    }

    transformVec4(v: Vec4, out?: Vec4): Vec4 {
        const r = out ?? new Vec4();
        const d = this.data;
        const x = v.data[0], y = v.data[1], z = v.data[2], w = v.data[3];
        r.data[0] = d[0] * x + d[4] * y + d[8]  * z + d[12] * w;
        r.data[1] = d[1] * x + d[5] * y + d[9]  * z + d[13] * w;
        r.data[2] = d[2] * x + d[6] * y + d[10] * z + d[14] * w;
        r.data[3] = d[3] * x + d[7] * y + d[11] * z + d[15] * w;
        return r;
    }

    /** Transform a point (applies translation). Divides by w for perspective. */
    transformPoint(v: Vec3, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        const d = this.data;
        const x = v.data[0], y = v.data[1], z = v.data[2];
        const w = d[3] * x + d[7] * y + d[11] * z + d[15];
        const invW = Math.abs(w) > 1e-12 ? 1 / w : 1;
        r.data[0] = (d[0] * x + d[4] * y + d[8]  * z + d[12]) * invW;
        r.data[1] = (d[1] * x + d[5] * y + d[9]  * z + d[13]) * invW;
        r.data[2] = (d[2] * x + d[6] * y + d[10] * z + d[14]) * invW;
        return r;
    }

    /** Transform a direction (ignores translation). */
    transformDirection(v: Vec3, out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        const d = this.data;
        const x = v.data[0], y = v.data[1], z = v.data[2];
        r.data[0] = d[0] * x + d[4] * y + d[8]  * z;
        r.data[1] = d[1] * x + d[5] * y + d[9]  * z;
        r.data[2] = d[2] * x + d[6] * y + d[10] * z;
        return r;
    }

    transpose(out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        const d = this.data;
        const rd = r.data;
        if (r === this) {
            let tmp: number;
            tmp = d[1];  d[1]  = d[4];  d[4]  = tmp;
            tmp = d[2];  d[2]  = d[8];  d[8]  = tmp;
            tmp = d[3];  d[3]  = d[12]; d[12] = tmp;
            tmp = d[6];  d[6]  = d[9];  d[9]  = tmp;
            tmp = d[7];  d[7]  = d[13]; d[13] = tmp;
            tmp = d[11]; d[11] = d[14]; d[14] = tmp;
        } else {
            rd[0]  = d[0];  rd[1]  = d[4];  rd[2]  = d[8];  rd[3]  = d[12];
            rd[4]  = d[1];  rd[5]  = d[5];  rd[6]  = d[9];  rd[7]  = d[13];
            rd[8]  = d[2];  rd[9]  = d[6];  rd[10] = d[10]; rd[11] = d[14];
            rd[12] = d[3];  rd[13] = d[7];  rd[14] = d[11]; rd[15] = d[15];
        }
        return r;
    }

    determinant(): number {
        const d = this.data;
        const a00 = d[0], a01 = d[1], a02 = d[2], a03 = d[3];
        const a10 = d[4], a11 = d[5], a12 = d[6], a13 = d[7];
        const a20 = d[8], a21 = d[9], a22 = d[10], a23 = d[11];
        const a30 = d[12], a31 = d[13], a32 = d[14], a33 = d[15];

        const b00 = a00 * a11 - a01 * a10;
        const b01 = a00 * a12 - a02 * a10;
        const b02 = a00 * a13 - a03 * a10;
        const b03 = a01 * a12 - a02 * a11;
        const b04 = a01 * a13 - a03 * a11;
        const b05 = a02 * a13 - a03 * a12;
        const b06 = a20 * a31 - a21 * a30;
        const b07 = a20 * a32 - a22 * a30;
        const b08 = a20 * a33 - a23 * a30;
        const b09 = a21 * a32 - a22 * a31;
        const b10 = a21 * a33 - a23 * a31;
        const b11 = a22 * a33 - a23 * a32;

        return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    }

    /** Returns null if the matrix is singular. */
    inverse(out?: Mat4): Mat4 | null {
        const r = out ?? new Mat4();
        const d = this.data;
        const a00 = d[0], a01 = d[1], a02 = d[2], a03 = d[3];
        const a10 = d[4], a11 = d[5], a12 = d[6], a13 = d[7];
        const a20 = d[8], a21 = d[9], a22 = d[10], a23 = d[11];
        const a30 = d[12], a31 = d[13], a32 = d[14], a33 = d[15];

        const b00 = a00 * a11 - a01 * a10;
        const b01 = a00 * a12 - a02 * a10;
        const b02 = a00 * a13 - a03 * a10;
        const b03 = a01 * a12 - a02 * a11;
        const b04 = a01 * a13 - a03 * a11;
        const b05 = a02 * a13 - a03 * a12;
        const b06 = a20 * a31 - a21 * a30;
        const b07 = a20 * a32 - a22 * a30;
        const b08 = a20 * a33 - a23 * a30;
        const b09 = a21 * a32 - a22 * a31;
        const b10 = a21 * a33 - a23 * a31;
        const b11 = a22 * a33 - a23 * a32;

        let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        if (Math.abs(det) < 1e-10) return null;
        det = 1 / det;

        const rd = r.data;
        rd[0]  = (a11 * b11 - a12 * b10 + a13 * b09) * det;
        rd[1]  = (a02 * b10 - a01 * b11 - a03 * b09) * det;
        rd[2]  = (a31 * b05 - a32 * b04 + a33 * b03) * det;
        rd[3]  = (a22 * b04 - a21 * b05 - a23 * b03) * det;
        rd[4]  = (a12 * b08 - a10 * b11 - a13 * b07) * det;
        rd[5]  = (a00 * b11 - a02 * b08 + a03 * b07) * det;
        rd[6]  = (a32 * b02 - a30 * b05 - a33 * b01) * det;
        rd[7]  = (a20 * b05 - a22 * b02 + a23 * b01) * det;
        rd[8]  = (a10 * b10 - a11 * b08 + a13 * b06) * det;
        rd[9]  = (a01 * b08 - a00 * b10 - a03 * b06) * det;
        rd[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
        rd[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
        rd[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
        rd[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
        rd[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
        rd[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
        return r;
    }

    getTranslation(out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        r.data[0] = this.data[12];
        r.data[1] = this.data[13];
        r.data[2] = this.data[14];
        return r;
    }

    setTranslation(x: number, y: number, z: number): this {
        this.data[12] = x;
        this.data[13] = y;
        this.data[14] = z;
        return this;
    }

    getScaling(out?: Vec3): Vec3 {
        const r = out ?? new Vec3();
        const d = this.data;
        r.data[0] = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        r.data[1] = Math.sqrt(d[4] * d[4] + d[5] * d[5] + d[6] * d[6]);
        r.data[2] = Math.sqrt(d[8] * d[8] + d[9] * d[9] + d[10] * d[10]);
        return r;
    }

    /** Decompose into translation, rotation (Quat), and scale. Returns null if a scale axis is zero-length. */
    decompose(): { translation: Vec3; rotation: Quat; scale: Vec3 } | null {
        const d = this.data;
        const translation = new Vec3(d[12], d[13], d[14]);

        let sx = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
        const sy = Math.sqrt(d[4] * d[4] + d[5] * d[5] + d[6] * d[6]);
        const sz = Math.sqrt(d[8] * d[8] + d[9] * d[9] + d[10] * d[10]);
        if (sx < 1e-12 || sy < 1e-12 || sz < 1e-12) return null;

        // Detect reflection via 3x3 determinant sign
        const det3 =
            d[0] * (d[5] * d[10] - d[6] * d[9]) -
            d[4] * (d[1] * d[10] - d[2] * d[9]) +
            d[8] * (d[1] * d[6] - d[2] * d[5]);
        if (det3 < 0) sx = -sx;

        const scale = new Vec3(sx, sy, sz);

        const invSx = 1 / sx, invSy = 1 / sy, invSz = 1 / sz;
        const rotation = Quat.fromRotationMatrix(
            d[0] * invSx, d[1] * invSx, d[2] * invSx,
            d[4] * invSy, d[5] * invSy, d[6] * invSy,
            d[8] * invSz, d[9] * invSz, d[10] * invSz
        );

        return { translation, rotation, scale };
    }

    static fromTranslation(x: number, y: number, z: number, out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        r.setIdentity();
        r.data[12] = x;
        r.data[13] = y;
        r.data[14] = z;
        return r;
    }

    static fromScaling(x: number, y: number, z: number, out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        r.data.fill(0);
        r.data[0] = x;
        r.data[5] = y;
        r.data[10] = z;
        r.data[15] = 1;
        return r;
    }

    static fromRotationX(radians: number, out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        const c = Math.cos(radians), s = Math.sin(radians);
        r.setIdentity();
        r.data[5] = c;  r.data[6] = s;
        r.data[9] = -s;  r.data[10] = c;
        return r;
    }

    static fromRotationY(radians: number, out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        const c = Math.cos(radians), s = Math.sin(radians);
        r.setIdentity();
        r.data[0] = c;  r.data[2] = -s;
        r.data[8] = s;  r.data[10] = c;
        return r;
    }

    static fromRotationZ(radians: number, out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        const c = Math.cos(radians), s = Math.sin(radians);
        r.setIdentity();
        r.data[0] = c;  r.data[1] = s;
        r.data[4] = -s;  r.data[5] = c;
        return r;
    }

    static fromAxisAngle(axis: Vec3, radians: number, out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        const x = axis.data[0], y = axis.data[1], z = axis.data[2];
        const len = Math.sqrt(x * x + y * y + z * z);
        if (len < 1e-12) return Mat4.identity(r);

        const invLen = 1 / len;
        const nx = x * invLen, ny = y * invLen, nz = z * invLen;
        const c = Math.cos(radians), s = Math.sin(radians), t = 1 - c;
        const d = r.data;

        d[0]  = nx * nx * t + c;      d[1]  = ny * nx * t + nz * s;  d[2]  = nz * nx * t - ny * s;  d[3]  = 0;
        d[4]  = nx * ny * t - nz * s; d[5]  = ny * ny * t + c;       d[6]  = nz * ny * t + nx * s;  d[7]  = 0;
        d[8]  = nx * nz * t + ny * s; d[9]  = ny * nz * t - nx * s;  d[10] = nz * nz * t + c;       d[11] = 0;
        d[12] = 0;                     d[13] = 0;                      d[14] = 0;                      d[15] = 1;
        return r;
    }

    static fromQuat(q: Quat, out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        const x = q.data[0], y = q.data[1], z = q.data[2], w = q.data[3];
        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, xy = x * y2, xz = x * z2;
        const yy = y * y2, yz = y * z2, zz = z * z2;
        const wx = w * x2, wy = w * y2, wz = w * z2;
        const rd = r.data;
        rd[0] = 1 - (yy + zz); rd[1] = xy + wz;       rd[2] = xz - wy;       rd[3] = 0;
        rd[4] = xy - wz;       rd[5] = 1 - (xx + zz); rd[6] = yz + wx;       rd[7] = 0;
        rd[8] = xz + wy;       rd[9] = yz - wx;       rd[10] = 1 - (xx + yy); rd[11] = 0;
        rd[12] = 0;             rd[13] = 0;             rd[14] = 0;             rd[15] = 1;
        return r;
    }

    /** Compose a TRS matrix from position, rotation, and scale. Accepts both typed and plain objects. */
    static compose(position: Vec3, rotation: Quat, scale: Vec3, out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        const pd = (position as any).data;
        const rotd = (rotation as any).data;
        const sd = (scale as any).data;

        const qx = rotd ? rotd[0] : (rotation as any).x ?? 0;
        const qy = rotd ? rotd[1] : (rotation as any).y ?? 0;
        const qz = rotd ? rotd[2] : (rotation as any).z ?? 0;
        const qw = rotd ? rotd[3] : (rotation as any).w ?? 1;
        const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
        const xx = qx * x2, xy = qx * y2, xz = qx * z2;
        const yy = qy * y2, yz = qy * z2, zz = qz * z2;
        const wx = qw * x2, wy = qw * y2, wz = qw * z2;

        const sx = sd ? sd[0] : (scale as any).x ?? 1;
        const sy = sd ? sd[1] : (scale as any).y ?? 1;
        const sz = sd ? sd[2] : (scale as any).z ?? 1;

        const rd = r.data;
        rd[0] = (1 - (yy + zz)) * sx; rd[1] = (xy + wz) * sx;       rd[2] = (xz - wy) * sx;       rd[3] = 0;
        rd[4] = (xy - wz) * sy;       rd[5] = (1 - (xx + zz)) * sy; rd[6] = (yz + wx) * sy;       rd[7] = 0;
        rd[8] = (xz + wy) * sz;       rd[9] = (yz - wx) * sz;       rd[10] = (1 - (xx + yy)) * sz; rd[11] = 0;
        rd[12] = pd ? pd[0] : (position as any).x ?? 0;
        rd[13] = pd ? pd[1] : (position as any).y ?? 0;
        rd[14] = pd ? pd[2] : (position as any).z ?? 0;
        rd[15] = 1;
        return r;
    }

    /** Right-handed lookAt view matrix. Camera at `eye`, looking toward `target`, with `up` hint. */
    static lookAt(eye: Vec3, target: Vec3, up: Vec3, out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        const ed = (eye as any).data, td = (target as any).data, ud = (up as any).data;
        const ex = ed ? ed[0] : (eye as any).x ?? 0;
        const ey = ed ? ed[1] : (eye as any).y ?? 0;
        const ez = ed ? ed[2] : (eye as any).z ?? 0;
        const tx = td ? td[0] : (target as any).x ?? 0;
        const ty = td ? td[1] : (target as any).y ?? 0;
        const tz = td ? td[2] : (target as any).z ?? 0;
        const upx = ud ? ud[0] : (up as any).x ?? 0;
        const upy = ud ? ud[1] : (up as any).y ?? 1;
        const upz = ud ? ud[2] : (up as any).z ?? 0;

        let fx = tx - ex, fy = ty - ey, fz = tz - ez;
        let len = Math.sqrt(fx * fx + fy * fy + fz * fz);
        if (len > 1e-6) { len = 1 / len; fx *= len; fy *= len; fz *= len; }

        let sx = fy * upz - fz * upy;
        let sy = fz * upx - fx * upz;
        let sz = fx * upy - fy * upx;
        len = Math.sqrt(sx * sx + sy * sy + sz * sz);
        if (len > 1e-6) { len = 1 / len; sx *= len; sy *= len; sz *= len; } else { sx = 0; sy = 0; sz = 0; }

        const ux = sy * fz - sz * fy;
        const uy = sz * fx - sx * fz;
        const uz = sx * fy - sy * fx;

        const rd = r.data;
        rd[0] = sx;  rd[1] = ux;  rd[2] = -fx;  rd[3] = 0;
        rd[4] = sy;  rd[5] = uy;  rd[6] = -fy;  rd[7] = 0;
        rd[8] = sz;  rd[9] = uz;  rd[10] = -fz; rd[11] = 0;
        rd[12] = -(sx * ex + sy * ey + sz * ez);
        rd[13] = -(ux * ex + uy * ey + uz * ez);
        rd[14] = (fx * ex + fy * ey + fz * ez);
        rd[15] = 1;
        return r;
    }

    /** Right-handed perspective projection. Clip-space z in [0, 1] (WebGPU convention). */
    static perspective(fovY: number, aspect: number, near: number, far: number, out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        const f = 1 / Math.tan(fovY * 0.5);
        const rd = r.data;
        rd.fill(0);
        rd[0] = f / aspect;
        rd[5] = f;
        if (far === Infinity) {
            rd[10] = -1;
            rd[14] = -near;
        } else {
            const rangeInv = 1 / (near - far);
            rd[10] = far * rangeInv;
            rd[14] = near * far * rangeInv;
        }
        rd[11] = -1;
        return r;
    }

    /** Right-handed orthographic projection. Clip-space z in [0, 1] (WebGPU convention). */
    static ortho(left: number, right: number, bottom: number, top: number, near: number, far: number, out?: Mat4): Mat4 {
        const r = out ?? new Mat4();
        const rd = r.data;
        rd.fill(0);
        const lr = 1 / (left - right);
        const bt = 1 / (bottom - top);
        const nf = 1 / (near - far);
        rd[0] = -2 * lr;
        rd[5] = -2 * bt;
        rd[10] = nf;
        rd[12] = (left + right) * lr;
        rd[13] = (top + bottom) * bt;
        rd[14] = near * nf;
        rd[15] = 1;
        return r;
    }

    /** Extract 6 frustum planes from a view-projection matrix. Order: left, right, bottom, top, near, far. */
    extractFrustumPlanes(): { normal: Vec3; d: number }[] {
        const d = this.data;
        return [
            Mat4.normalizePlane(d[3] + d[0], d[7] + d[4], d[11] + d[8], d[15] + d[12]),   // left
            Mat4.normalizePlane(d[3] - d[0], d[7] - d[4], d[11] - d[8], d[15] - d[12]),   // right
            Mat4.normalizePlane(d[3] + d[1], d[7] + d[5], d[11] + d[9], d[15] + d[13]),   // bottom
            Mat4.normalizePlane(d[3] - d[1], d[7] - d[5], d[11] - d[9], d[15] - d[13]),   // top
            Mat4.normalizePlane(d[2], d[6], d[10], d[14]),                                  // near
            Mat4.normalizePlane(d[3] - d[2], d[7] - d[6], d[11] - d[10], d[15] - d[14]),  // far
        ];
    }

    private static normalizePlane(a: number, b: number, c: number, d: number): { normal: Vec3; d: number } {
        const len = Math.sqrt(a * a + b * b + c * c);
        if (len > 1e-10) {
            const invLen = 1 / len;
            return { normal: new Vec3(a * invLen, b * invLen, c * invLen), d: d * invLen };
        }
        return { normal: new Vec3(a, b, c), d };
    }

    equals(m: Mat4, epsilon: number = 1e-6): boolean {
        for (let i = 0; i < 16; i++) {
            if (Math.abs(this.data[i] - m.data[i]) >= epsilon) return false;
        }
        return true;
    }

    toArray(): number[] {
        return Array.from(this.data);
    }

    toJSON(): { data: number[] } {
        return { data: Array.from(this.data) };
    }

    static fromJSON(json: { data: number[] }): Mat4 {
        const r = new Mat4();
        r.data.set(json.data);
        return r;
    }

    static readonly IDENTITY = Object.freeze(new Mat4());

    // ── Array-based utilities (for working with raw number[] matrices) ──

    /** Multiply two column-major 4x4 matrices given as ArrayLike<number>. */
    static multiplyArrays(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
        const r = new Array(16).fill(0);
        for (let col = 0; col < 4; col++) {
            for (let row = 0; row < 4; row++) {
                r[col * 4 + row] =
                    a[0 * 4 + row] * b[col * 4 + 0] +
                    a[1 * 4 + row] * b[col * 4 + 1] +
                    a[2 * 4 + row] * b[col * 4 + 2] +
                    a[3 * 4 + row] * b[col * 4 + 3];
            }
        }
        return r;
    }

    /** Invert a column-major 4x4 matrix given as ArrayLike<number>. Returns identity if singular. */
    static invertArray(m: ArrayLike<number>): number[] {
        const m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3];
        const m10 = m[4], m11 = m[5], m12 = m[6], m13 = m[7];
        const m20 = m[8], m21 = m[9], m22 = m[10], m23 = m[11];
        const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];

        const b00 = m00 * m11 - m01 * m10;
        const b01 = m00 * m12 - m02 * m10;
        const b02 = m00 * m13 - m03 * m10;
        const b03 = m01 * m12 - m02 * m11;
        const b04 = m01 * m13 - m03 * m11;
        const b05 = m02 * m13 - m03 * m12;
        const b06 = m20 * m31 - m21 * m30;
        const b07 = m20 * m32 - m22 * m30;
        const b08 = m20 * m33 - m23 * m30;
        const b09 = m21 * m32 - m22 * m31;
        const b10 = m21 * m33 - m23 * m31;
        const b11 = m22 * m33 - m23 * m32;

        let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        if (Math.abs(det) < 1e-10) {
            return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        }
        det = 1.0 / det;

        return [
            (m11 * b11 - m12 * b10 + m13 * b09) * det,
            (m02 * b10 - m01 * b11 - m03 * b09) * det,
            (m31 * b05 - m32 * b04 + m33 * b03) * det,
            (m22 * b04 - m21 * b05 - m23 * b03) * det,
            (m12 * b08 - m10 * b11 - m13 * b07) * det,
            (m00 * b11 - m02 * b08 + m03 * b07) * det,
            (m32 * b02 - m30 * b05 - m33 * b01) * det,
            (m20 * b05 - m22 * b02 + m23 * b01) * det,
            (m10 * b10 - m11 * b08 + m13 * b06) * det,
            (m01 * b08 - m00 * b10 - m03 * b06) * det,
            (m30 * b04 - m31 * b02 + m33 * b00) * det,
            (m21 * b02 - m20 * b04 - m23 * b00) * det,
            (m11 * b07 - m10 * b09 - m12 * b06) * det,
            (m00 * b09 - m01 * b07 + m02 * b06) * det,
            (m31 * b01 - m30 * b03 - m32 * b00) * det,
            (m20 * b03 - m21 * b01 + m22 * b00) * det,
        ];
    }
}
