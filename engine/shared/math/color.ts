import { MathUtils } from './math_utils';

/**
 * RGBA color with conversions between hex, HSL, linear/sRGB, and packed formats.
 * Components are stored as floats in the [0, 1] range.
 */
export class Color {
    data: Float32Array;

    constructor(r: number = 1, g: number = 1, b: number = 1, a: number = 1) {
        this.data = new Float32Array([r, g, b, a]);
    }

    get r(): number { return this.data[0]; }
    set r(v: number) { this.data[0] = v; }
    get g(): number { return this.data[1]; }
    set g(v: number) { this.data[1] = v; }
    get b(): number { return this.data[2]; }
    set b(v: number) { this.data[2] = v; }
    get a(): number { return this.data[3]; }
    set a(v: number) { this.data[3] = v; }

    set(r: number, g: number, b: number, a: number = 1): this {
        this.data[0] = r;
        this.data[1] = g;
        this.data[2] = b;
        this.data[3] = a;
        return this;
    }

    copy(c: Color): this {
        this.data[0] = c.data[0];
        this.data[1] = c.data[1];
        this.data[2] = c.data[2];
        this.data[3] = c.data[3];
        return this;
    }

    clone(): Color {
        return new Color(this.data[0], this.data[1], this.data[2], this.data[3]);
    }

    add(c: Color, out?: Color): Color {
        const r = out ?? new Color();
        r.data[0] = this.data[0] + c.data[0];
        r.data[1] = this.data[1] + c.data[1];
        r.data[2] = this.data[2] + c.data[2];
        r.data[3] = this.data[3] + c.data[3];
        return r;
    }

    multiply(c: Color, out?: Color): Color {
        const r = out ?? new Color();
        r.data[0] = this.data[0] * c.data[0];
        r.data[1] = this.data[1] * c.data[1];
        r.data[2] = this.data[2] * c.data[2];
        r.data[3] = this.data[3] * c.data[3];
        return r;
    }

    scale(s: number, out?: Color): Color {
        const r = out ?? new Color();
        r.data[0] = this.data[0] * s;
        r.data[1] = this.data[1] * s;
        r.data[2] = this.data[2] * s;
        r.data[3] = this.data[3] * s;
        return r;
    }

    lerp(c: Color, t: number, out?: Color): Color {
        const r = out ?? new Color();
        r.data[0] = this.data[0] + (c.data[0] - this.data[0]) * t;
        r.data[1] = this.data[1] + (c.data[1] - this.data[1]) * t;
        r.data[2] = this.data[2] + (c.data[2] - this.data[2]) * t;
        r.data[3] = this.data[3] + (c.data[3] - this.data[3]) * t;
        return r;
    }

    clamp(out?: Color): Color {
        const r = out ?? new Color();
        r.data[0] = MathUtils.clamp(this.data[0], 0, 1);
        r.data[1] = MathUtils.clamp(this.data[1], 0, 1);
        r.data[2] = MathUtils.clamp(this.data[2], 0, 1);
        r.data[3] = MathUtils.clamp(this.data[3], 0, 1);
        return r;
    }

    equals(c: Color, epsilon: number = MathUtils.EPSILON): boolean {
        return (
            Math.abs(this.data[0] - c.data[0]) < epsilon &&
            Math.abs(this.data[1] - c.data[1]) < epsilon &&
            Math.abs(this.data[2] - c.data[2]) < epsilon &&
            Math.abs(this.data[3] - c.data[3]) < epsilon
        );
    }

    /** Convert sRGB to linear space. */
    toLinear(out?: Color): Color {
        const r = out ?? new Color();
        r.data[0] = Color.srgbToLinearChannel(this.data[0]);
        r.data[1] = Color.srgbToLinearChannel(this.data[1]);
        r.data[2] = Color.srgbToLinearChannel(this.data[2]);
        r.data[3] = this.data[3];
        return r;
    }

    /** Convert linear to sRGB space. */
    toSRGB(out?: Color): Color {
        const r = out ?? new Color();
        r.data[0] = Color.linearToSrgbChannel(this.data[0]);
        r.data[1] = Color.linearToSrgbChannel(this.data[1]);
        r.data[2] = Color.linearToSrgbChannel(this.data[2]);
        r.data[3] = this.data[3];
        return r;
    }

    /** Convert to hex string "#rrggbb" or "#rrggbbaa". */
    toHex(includeAlpha: boolean = false): string {
        const r = Math.round(MathUtils.clamp(this.data[0], 0, 1) * 255);
        const g = Math.round(MathUtils.clamp(this.data[1], 0, 1) * 255);
        const b = Math.round(MathUtils.clamp(this.data[2], 0, 1) * 255);
        let hex = '#' + Color.toHex2(r) + Color.toHex2(g) + Color.toHex2(b);
        if (includeAlpha) {
            const a = Math.round(MathUtils.clamp(this.data[3], 0, 1) * 255);
            hex += Color.toHex2(a);
        }
        return hex;
    }

    /** Convert to HSL. Returns [h (0-360), s (0-1), l (0-1)]. */
    toHSL(): [number, number, number] {
        const r = this.data[0], g = this.data[1], b = this.data[2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const l = (max + min) / 2;

        if (max === min) {
            return [0, 0, l];
        }

        const d = max - min;
        const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

        let h: number;
        if (max === r) {
            h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        } else if (max === g) {
            h = ((b - r) / d + 2) / 6;
        } else {
            h = ((r - g) / d + 4) / 6;
        }

        return [h * 360, s, l];
    }

    /** Convert to a 32-bit packed RGBA integer (0xRRGGBBAA). */
    toRGBA32(): number {
        const r = Math.round(MathUtils.clamp(this.data[0], 0, 1) * 255);
        const g = Math.round(MathUtils.clamp(this.data[1], 0, 1) * 255);
        const b = Math.round(MathUtils.clamp(this.data[2], 0, 1) * 255);
        const a = Math.round(MathUtils.clamp(this.data[3], 0, 1) * 255);
        return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
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

    toJSON(): { r: number; g: number; b: number; a: number } {
        return { r: this.data[0], g: this.data[1], b: this.data[2], a: this.data[3] };
    }

    static fromJSON(json: { r: number; g: number; b: number; a: number }): Color {
        return new Color(json.r, json.g, json.b, json.a ?? 1);
    }

    /** Create from hex string. Supports "#RGB", "#RGBA", "#RRGGBB", "#RRGGBBAA". */
    static fromHex(hex: string): Color {
        let str = hex.replace('#', '');

        if (str.length === 3) {
            str = str[0] + str[0] + str[1] + str[1] + str[2] + str[2];
        } else if (str.length === 4) {
            str = str[0] + str[0] + str[1] + str[1] + str[2] + str[2] + str[3] + str[3];
        }

        const r = parseInt(str.substring(0, 2), 16) / 255;
        const g = parseInt(str.substring(2, 4), 16) / 255;
        const b = parseInt(str.substring(4, 6), 16) / 255;
        const a = str.length >= 8 ? parseInt(str.substring(6, 8), 16) / 255 : 1;
        return new Color(r, g, b, a);
    }

    /** Create from HSL. h in [0, 360], s and l in [0, 1]. */
    static fromHSL(h: number, s: number, l: number, a: number = 1): Color {
        if (s === 0) {
            return new Color(l, l, l, a);
        }

        const hue2rgb = (p: number, q: number, t: number): number => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };

        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const hNorm = h / 360;

        return new Color(
            hue2rgb(p, q, hNorm + 1 / 3),
            hue2rgb(p, q, hNorm),
            hue2rgb(p, q, hNorm - 1 / 3),
            a
        );
    }

    /** Create from 0-255 integer components. */
    static fromBytes(r: number, g: number, b: number, a: number = 255): Color {
        return new Color(r / 255, g / 255, b / 255, a / 255);
    }

    /** Create from a 32-bit packed RGBA integer (0xRRGGBBAA). */
    static fromRGBA32(rgba: number): Color {
        return new Color(
            ((rgba >>> 24) & 0xFF) / 255,
            ((rgba >>> 16) & 0xFF) / 255,
            ((rgba >>> 8) & 0xFF) / 255,
            (rgba & 0xFF) / 255
        );
    }

    private static srgbToLinearChannel(c: number): number {
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    private static linearToSrgbChannel(c: number): number {
        return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    }

    private static toHex2(v: number): string {
        const s = v.toString(16);
        return s.length < 2 ? '0' + s : s;
    }

    static readonly WHITE = Object.freeze(new Color(1, 1, 1, 1));
    static readonly BLACK = Object.freeze(new Color(0, 0, 0, 1));
    static readonly RED = Object.freeze(new Color(1, 0, 0, 1));
    static readonly GREEN = Object.freeze(new Color(0, 1, 0, 1));
    static readonly BLUE = Object.freeze(new Color(0, 0, 1, 1));
    static readonly YELLOW = Object.freeze(new Color(1, 1, 0, 1));
    static readonly CYAN = Object.freeze(new Color(0, 1, 1, 1));
    static readonly MAGENTA = Object.freeze(new Color(1, 0, 1, 1));
    static readonly TRANSPARENT = Object.freeze(new Color(0, 0, 0, 0));
    static readonly GRAY = Object.freeze(new Color(0.5, 0.5, 0.5, 1));
}
