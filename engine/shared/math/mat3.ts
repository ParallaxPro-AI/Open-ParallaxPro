import { Vec2 } from './vec2';

/**
 * 3x3 matrix stored in column-major order.
 *
 * Layout: [m00, m10, m20, m01, m11, m21, m02, m12, m22]
 *
 *   m00  m01  m02
 *   m10  m11  m12
 *   m20  m21  m22
 */
export class Mat3 {
    data: Float32Array;

    constructor() {
        this.data = new Float32Array([
            1, 0, 0,
            0, 1, 0,
            0, 0, 1,
        ]);
    }

    static identity(out?: Mat3): Mat3 {
        const r = out ?? new Mat3();
        const d = r.data;
        d[0] = 1; d[1] = 0; d[2] = 0;
        d[3] = 0; d[4] = 1; d[5] = 0;
        d[6] = 0; d[7] = 0; d[8] = 1;
        return r;
    }

    set(
        m00: number, m01: number, m02: number,
        m10: number, m11: number, m12: number,
        m20: number, m21: number, m22: number
    ): this {
        const d = this.data;
        d[0] = m00; d[1] = m10; d[2] = m20;
        d[3] = m01; d[4] = m11; d[5] = m21;
        d[6] = m02; d[7] = m12; d[8] = m22;
        return this;
    }

    copy(m: Mat3): this {
        this.data.set(m.data);
        return this;
    }

    clone(): Mat3 {
        const r = new Mat3();
        r.data.set(this.data);
        return r;
    }

    multiply(m: Mat3, out?: Mat3): Mat3 {
        const r = out ?? new Mat3();
        const a = this.data;
        const b = m.data;
        const d = r.data;

        const a00 = a[0], a01 = a[3], a02 = a[6];
        const a10 = a[1], a11 = a[4], a12 = a[7];
        const a20 = a[2], a21 = a[5], a22 = a[8];

        const b00 = b[0], b01 = b[3], b02 = b[6];
        const b10 = b[1], b11 = b[4], b12 = b[7];
        const b20 = b[2], b21 = b[5], b22 = b[8];

        d[0] = a00 * b00 + a01 * b10 + a02 * b20;
        d[1] = a10 * b00 + a11 * b10 + a12 * b20;
        d[2] = a20 * b00 + a21 * b10 + a22 * b20;

        d[3] = a00 * b01 + a01 * b11 + a02 * b21;
        d[4] = a10 * b01 + a11 * b11 + a12 * b21;
        d[5] = a20 * b01 + a21 * b11 + a22 * b21;

        d[6] = a00 * b02 + a01 * b12 + a02 * b22;
        d[7] = a10 * b02 + a11 * b12 + a12 * b22;
        d[8] = a20 * b02 + a21 * b12 + a22 * b22;

        return r;
    }

    determinant(): number {
        const d = this.data;
        const a00 = d[0], a01 = d[3], a02 = d[6];
        const a10 = d[1], a11 = d[4], a12 = d[7];
        const a20 = d[2], a21 = d[5], a22 = d[8];

        return (
            a00 * (a11 * a22 - a12 * a21) -
            a01 * (a10 * a22 - a12 * a20) +
            a02 * (a10 * a21 - a11 * a20)
        );
    }

    inverse(out?: Mat3): Mat3 | null {
        const r = out ?? new Mat3();
        const d = this.data;

        const a00 = d[0], a01 = d[3], a02 = d[6];
        const a10 = d[1], a11 = d[4], a12 = d[7];
        const a20 = d[2], a21 = d[5], a22 = d[8];

        const c00 = a11 * a22 - a12 * a21;
        const c01 = a12 * a20 - a10 * a22;
        const c02 = a10 * a21 - a11 * a20;

        const det = a00 * c00 + a01 * c01 + a02 * c02;
        if (Math.abs(det) < 1e-12) {
            return null;
        }

        const invDet = 1 / det;
        const rd = r.data;

        rd[0] = c00 * invDet;
        rd[1] = c01 * invDet;
        rd[2] = c02 * invDet;

        rd[3] = (a02 * a21 - a01 * a22) * invDet;
        rd[4] = (a00 * a22 - a02 * a20) * invDet;
        rd[5] = (a01 * a20 - a00 * a21) * invDet;

        rd[6] = (a01 * a12 - a02 * a11) * invDet;
        rd[7] = (a02 * a10 - a00 * a12) * invDet;
        rd[8] = (a00 * a11 - a01 * a10) * invDet;

        return r;
    }

    transpose(out?: Mat3): Mat3 {
        const r = out ?? new Mat3();
        const s = this.data;
        const d = r.data;

        if (r === this) {
            const tmp01 = s[1];
            const tmp02 = s[2];
            const tmp12 = s[5];
            d[1] = s[3];
            d[2] = s[6];
            d[3] = tmp01;
            d[5] = s[7];
            d[6] = tmp02;
            d[7] = tmp12;
        } else {
            d[0] = s[0]; d[1] = s[3]; d[2] = s[6];
            d[3] = s[1]; d[4] = s[4]; d[5] = s[7];
            d[6] = s[2]; d[7] = s[5]; d[8] = s[8];
        }

        return r;
    }

    scale(sx: number, sy: number, out?: Mat3): Mat3 {
        const r = out ?? new Mat3();
        const d = r.data;
        const s = this.data;
        d[0] = s[0] * sx; d[1] = s[1] * sx; d[2] = s[2] * sx;
        d[3] = s[3] * sy; d[4] = s[4] * sy; d[5] = s[5] * sy;
        d[6] = s[6];      d[7] = s[7];      d[8] = s[8];
        return r;
    }

    rotate(radians: number, out?: Mat3): Mat3 {
        const r = out ?? new Mat3();
        const s = this.data;
        const c = Math.cos(radians);
        const sn = Math.sin(radians);
        const d = r.data;

        const a00 = s[0], a01 = s[3];
        const a10 = s[1], a11 = s[4];
        const a20 = s[2], a21 = s[5];

        d[0] = a00 * c + a01 * sn;
        d[1] = a10 * c + a11 * sn;
        d[2] = a20 * c + a21 * sn;

        d[3] = a01 * c - a00 * sn;
        d[4] = a11 * c - a10 * sn;
        d[5] = a21 * c - a20 * sn;

        d[6] = s[6]; d[7] = s[7]; d[8] = s[8];
        return r;
    }

    translate(tx: number, ty: number, out?: Mat3): Mat3 {
        const r = out ?? new Mat3();
        const s = this.data;
        const d = r.data;

        d[0] = s[0]; d[1] = s[1]; d[2] = s[2];
        d[3] = s[3]; d[4] = s[4]; d[5] = s[5];
        d[6] = s[0] * tx + s[3] * ty + s[6];
        d[7] = s[1] * tx + s[4] * ty + s[7];
        d[8] = s[2] * tx + s[5] * ty + s[8];

        return r;
    }

    transformVec2(v: Vec2, out?: Vec2): Vec2 {
        const r = out ?? new Vec2();
        const d = this.data;
        const x = v.data[0], y = v.data[1];
        r.data[0] = d[0] * x + d[3] * y + d[6];
        r.data[1] = d[1] * x + d[4] * y + d[7];
        return r;
    }

    static fromTranslation(tx: number, ty: number, out?: Mat3): Mat3 {
        const r = out ?? new Mat3();
        const d = r.data;
        d[0] = 1; d[1] = 0; d[2] = 0;
        d[3] = 0; d[4] = 1; d[5] = 0;
        d[6] = tx; d[7] = ty; d[8] = 1;
        return r;
    }

    static fromRotation(radians: number, out?: Mat3): Mat3 {
        const r = out ?? new Mat3();
        const c = Math.cos(radians);
        const s = Math.sin(radians);
        const d = r.data;
        d[0] = c;  d[1] = s;  d[2] = 0;
        d[3] = -s; d[4] = c;  d[5] = 0;
        d[6] = 0;  d[7] = 0;  d[8] = 1;
        return r;
    }

    static fromScaling(sx: number, sy: number, out?: Mat3): Mat3 {
        const r = out ?? new Mat3();
        const d = r.data;
        d[0] = sx; d[1] = 0;  d[2] = 0;
        d[3] = 0;  d[4] = sy; d[5] = 0;
        d[6] = 0;  d[7] = 0;  d[8] = 1;
        return r;
    }

    equals(m: Mat3, epsilon: number = 1e-6): boolean {
        for (let i = 0; i < 9; i++) {
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

    static fromJSON(json: { data: number[] }): Mat3 {
        const r = new Mat3();
        r.data.set(json.data);
        return r;
    }
}
