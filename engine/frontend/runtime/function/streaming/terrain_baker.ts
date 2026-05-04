/**
 * terrain_baker.ts — CPU splatmap rasterizer for inline terrain specs.
 *
 * Takes declarative paint regions and spline paths from the AI-authored
 * heightmapTerrain config and bakes them into an RGBA8 weight map that
 * maps 1:1 to the terrain shader's groundTypeMap texture.
 *
 * Channel mapping:  R = layer 0,  G = layer 1,  B = layer 2,  A = layer 3.
 *
 * Bake order:  default_layer → paints[] (in array order) → paths[] (last,
 * so roads always sit on top of biome regions).
 */

// ── Public types ────────────────────────────────────────────────

export interface TerrainLayerSpec {
    name: string;
    dir: string;
    uvMetersPerTile: number;
}

export interface PaintSpec {
    shape: 'circle' | 'rect' | 'polygon';
    layer: string;
    center?: [number, number];
    radius?: number;
    size?: [number, number];
    points?: [number, number][];
    feather?: number;
    noise?: number;
}

export interface PathSpec {
    layer: string;
    points: [number, number][];
    width: number;
    feather?: number;
}

/** Elevation building blocks. Stack noise + hills + flat_zones to shape
 *  the ground. All heights are in meters; coordinates are world-space XZ
 *  matching the splatmap (positive Y = up). See bakeHeightmap for order. */
export interface NoiseElevation {
    /** Integer seed; same seed = same terrain across reloads. */
    seed?: number;
    /** Octaves of fBm. 3–5 is plenty for natural-looking rolls. */
    octaves?: number;
    /** Higher = more bumps per meter. ~0.005–0.05 is typical. */
    frequency?: number;
    /** Peak-to-peak height in meters of the noise contribution. */
    amplitude?: number;
}

export interface HillSpec {
    shape: 'circle' | 'rect';
    /** World-space XZ. */
    center: [number, number];
    /** circle */
    radius?: number;
    /** rect */
    size?: [number, number];
    /** Height in meters at the center. Negative = depression / pit. */
    height: number;
    /** Soft-edge falloff width in meters from the shape edge outward.
     *  Default 8. Inside the shape: full height; in the feather band:
     *  raised cosine fade to 0; beyond: 0. */
    feather?: number;
}

export interface FlatZoneSpec {
    shape: 'circle' | 'rect';
    center: [number, number];
    radius?: number;
    size?: [number, number];
    /** Forced height in meters. Default 0. */
    height?: number;
    /** Feather band where the surface blends from forced height back to
     *  whatever's underneath. Default 6. */
    feather?: number;
}

export interface ElevationSpec {
    /** Heightmap grid resolution. Higher = sharper hills, more memory.
     *  Default 128. Capped to 512. */
    resolution?: number;
    /** Optional symmetric clamp on the final height in meters. */
    max_height?: number;
    noise?: NoiseElevation;
    hills?: HillSpec[];
    /** Force regions to a specific height after noise + hills (e.g. for
     *  starting areas, building footprints, courts). Applied last. */
    flat_zones?: FlatZoneSpec[];
}

export interface InlineTerrainSpec {
    size: [number, number];
    layers: TerrainLayerSpec[];
    default_layer: string;
    paints?: PaintSpec[];
    paths?: PathSpec[];
    splatmap_resolution?: number;
    elevation?: ElevationSpec;
}

// ── Bake ────────────────────────────────────────────────────────

/**
 * Bake an RGBA8 splatmap from a declarative terrain spec.
 * Returns a Uint8Array of length `res * res * 4` (row-major, top-to-bottom).
 */
export function bakeSplatmap(spec: InlineTerrainSpec): { data: Uint8Array; resolution: number } {
    const res = spec.splatmap_resolution ?? 512;
    const [worldW, worldD] = spec.size;
    const halfW = worldW / 2;
    const halfD = worldD / 2;

    const layerIndex = new Map<string, number>();
    for (let i = 0; i < spec.layers.length; i++) {
        layerIndex.set(spec.layers[i].name, i);
    }

    const defaultIdx = layerIndex.get(spec.default_layer) ?? 0;
    const channelCount = Math.min(spec.layers.length, 4);

    // Floating-point weight buffer: res × res × 4 channels
    const weights = new Float32Array(res * res * 4);

    // Fill default layer
    for (let i = 0; i < res * res; i++) {
        weights[i * 4 + defaultIdx] = 1.0;
    }

    // Apply paints (in order)
    if (spec.paints) {
        for (const paint of spec.paints) {
            const idx = layerIndex.get(paint.layer);
            if (idx === undefined || idx >= 4) continue;
            applyPaint(weights, res, worldW, worldD, halfW, halfD, paint, idx);
        }
    }

    // Apply paths (last — roads on top)
    if (spec.paths) {
        for (const pathSpec of spec.paths) {
            const idx = layerIndex.get(pathSpec.layer);
            if (idx === undefined || idx >= 4) continue;
            applyPath(weights, res, worldW, worldD, halfW, halfD, pathSpec, idx);
        }
    }

    // Normalize and pack to RGBA8
    const data = new Uint8Array(res * res * 4);
    for (let i = 0; i < res * res; i++) {
        const off = i * 4;
        let total = 0;
        for (let c = 0; c < channelCount; c++) total += weights[off + c];
        if (total < 0.001) {
            data[off + defaultIdx] = 255;
            continue;
        }
        const inv = 1.0 / total;
        for (let c = 0; c < 4; c++) {
            data[off + c] = Math.round(Math.min(1, Math.max(0, weights[off + c] * inv)) * 255);
        }
    }

    return { data, resolution: res };
}

// ── Paint rasterizer ────────────────────────────────────────────

function applyPaint(
    weights: Float32Array, res: number,
    worldW: number, worldD: number, halfW: number, halfD: number,
    paint: PaintSpec, layerIdx: number,
): void {
    const feather = paint.feather ?? 3;
    const noiseAmp = paint.noise ?? 0;

    for (let pz = 0; pz < res; pz++) {
        const wz = (pz / (res - 1)) * worldD - halfD;
        for (let px = 0; px < res; px++) {
            const wx = (px / (res - 1)) * worldW - halfW;
            let dist: number;

            switch (paint.shape) {
                case 'circle': {
                    const cx = paint.center?.[0] ?? 0;
                    const cz = paint.center?.[1] ?? 0;
                    const r = paint.radius ?? 10;
                    const dx = wx - cx, dz = wz - cz;
                    dist = Math.sqrt(dx * dx + dz * dz) - r;
                    break;
                }
                case 'rect': {
                    const cx = paint.center?.[0] ?? 0;
                    const cz = paint.center?.[1] ?? 0;
                    const hw = (paint.size?.[0] ?? 20) / 2;
                    const hd = (paint.size?.[1] ?? 20) / 2;
                    const dx = Math.abs(wx - cx) - hw;
                    const dz = Math.abs(wz - cz) - hd;
                    dist = Math.max(dx, dz);
                    break;
                }
                case 'polygon': {
                    if (!paint.points || paint.points.length < 3) continue;
                    dist = sdfPolygon(wx, wz, paint.points);
                    break;
                }
                default:
                    continue;
            }

            if (noiseAmp > 0) {
                dist += hashNoise(wx * 0.37, wz * 0.37) * feather * noiseAmp;
            }

            if (dist < feather) {
                const w = 1 - smoothstep(-feather * 0.2, feather, dist);
                blendWeight(weights, res, px, pz, layerIdx, w);
            }
        }
    }
}

// ── Path (Catmull-Rom spline) rasterizer ────────────────────────

function applyPath(
    weights: Float32Array, res: number,
    worldW: number, worldD: number, halfW: number, halfD: number,
    path: PathSpec, layerIdx: number,
): void {
    if (path.points.length < 2) return;
    const feather = path.feather ?? 1.5;
    const halfWidth = path.width / 2;

    // Build dense polyline from Catmull-Rom spline
    const polyline = catmullRomPolyline(path.points, 20);

    for (let pz = 0; pz < res; pz++) {
        const wz = (pz / (res - 1)) * worldD - halfD;
        for (let px = 0; px < res; px++) {
            const wx = (px / (res - 1)) * worldW - halfW;

            const dist = distanceToPolyline(wx, wz, polyline) - halfWidth;

            if (dist < feather) {
                const w = 1 - smoothstep(-feather * 0.1, feather, dist);
                blendWeight(weights, res, px, pz, layerIdx, w);
            }
        }
    }
}

/**
 * Evaluate Catmull-Rom spline through control points and return a dense
 * polyline with `segmentsPerSpan` linear segments per span.
 */
function catmullRomPolyline(
    pts: [number, number][],
    segmentsPerSpan: number,
): [number, number][] {
    const out: [number, number][] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[Math.min(pts.length - 1, i + 1)];
        const p3 = pts[Math.min(pts.length - 1, i + 2)];
        for (let s = 1; s <= segmentsPerSpan; s++) {
            const t = s / segmentsPerSpan;
            out.push(catmullRomPoint(p0, p1, p2, p3, t));
        }
    }
    return out;
}

function catmullRomPoint(
    p0: [number, number], p1: [number, number],
    p2: [number, number], p3: [number, number],
    t: number,
): [number, number] {
    const t2 = t * t, t3 = t2 * t;
    return [
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t +
            (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
            (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t +
            (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
            (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
    ];
}

function distanceToPolyline(px: number, pz: number, polyline: [number, number][]): number {
    let minDist = Infinity;
    for (let i = 0; i < polyline.length - 1; i++) {
        const d = distToSegment(px, pz, polyline[i], polyline[i + 1]);
        if (d < minDist) minDist = d;
    }
    return minDist;
}

function distToSegment(px: number, pz: number, a: [number, number], b: [number, number]): number {
    const abx = b[0] - a[0], abz = b[1] - a[1];
    const apx = px - a[0], apz = pz - a[1];
    const lenSq = abx * abx + abz * abz;
    if (lenSq < 0.0001) return Math.sqrt(apx * apx + apz * apz);
    const t = Math.max(0, Math.min(1, (apx * abx + apz * abz) / lenSq));
    const dx = px - (a[0] + t * abx);
    const dz = pz - (a[1] + t * abz);
    return Math.sqrt(dx * dx + dz * dz);
}

// ── SDF helpers ─────────────────────────────────────────────────

function sdfPolygon(px: number, pz: number, verts: [number, number][]): number {
    const n = verts.length;
    let dx = px - verts[0][0], dz = pz - verts[0][1];
    let minDistSq = dx * dx + dz * dz;
    let sign = 1.0;

    for (let i = 0, j = n - 1; i < n; j = i++) {
        const ex = verts[i][0] - verts[j][0];
        const ez = verts[i][1] - verts[j][1];
        const wx = px - verts[j][0];
        const wz = pz - verts[j][1];
        const lenSq = ex * ex + ez * ez;
        const t = Math.max(0, Math.min(1, (wx * ex + wz * ez) / (lenSq || 1)));
        const closestX = wx - ex * t;
        const closestZ = wz - ez * t;
        const dSq = closestX * closestX + closestZ * closestZ;
        if (dSq < minDistSq) minDistSq = dSq;

        // Winding number test for inside/outside
        if ((verts[j][1] <= pz) !== (verts[i][1] <= pz)) {
            const cross = wx * ez - wz * ex;
            if (verts[i][1] > verts[j][1] ? cross > 0 : cross < 0) {
                sign = -sign;
            }
        }
    }

    return sign * Math.sqrt(minDistSq);
}

// GLSL-standard smoothstep: returns 0 when x <= edge0, 1 when x >= edge1
function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

// Simple deterministic hash noise for organic edges
function hashNoise(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hash2d(ix, iy);
    const b = hash2d(ix + 1, iy);
    const c = hash2d(ix, iy + 1);
    const d = hash2d(ix + 1, iy + 1);
    return lerp(lerp(a, b, sx), lerp(c, d, sx), sy) * 2 - 1;
}

function hash2d(x: number, y: number): number {
    let n = x * 374761393 + y * 668265263;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) & 0x7fffffff) / 0x7fffffff;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function blendWeight(
    weights: Float32Array, res: number,
    px: number, pz: number, layerIdx: number, w: number,
): void {
    const off = (pz * res + px) * 4;
    // Additive blend: raise this layer's weight, reduce others proportionally
    const current = weights[off + layerIdx];
    const newW = current + (1 - current) * w;
    const scale = (1 - newW) / (1 - current || 1);
    for (let c = 0; c < 4; c++) {
        if (c === layerIdx) {
            weights[off + c] = newW;
        } else {
            weights[off + c] *= scale;
        }
    }
}

// ── Heightmap bake ──────────────────────────────────────────────
//
// Bakes a Float32Array(res*res) of vertex heights from a declarative
// `ElevationSpec`. Sample order matches the splatmap: row-major, top-to-
// bottom in world XZ. Cell (i, j) maps to world (x, z) where
//   x = -worldW/2 + (j + 0.5) * worldW/res
//   z = -worldD/2 + (i + 0.5) * worldD/res
// Same convention used by HeightmapTerrain's bilinear lookup so collision
// and rendering agree.

const MAX_HEIGHTMAP_RES = 512;

export function bakeHeightmap(
    spec: ElevationSpec,
    worldWidth: number,
    worldDepth: number,
): { data: Float32Array; resolution: number } {
    const res = Math.min(spec.resolution ?? 128, MAX_HEIGHTMAP_RES);
    const data = new Float32Array(res * res);
    const halfW = worldWidth / 2;
    const halfD = worldDepth / 2;

    const noise = spec.noise;
    const seed = noise?.seed ?? 1337;
    const octaves = Math.max(1, Math.min(8, noise?.octaves ?? 4));
    const freq = noise?.frequency ?? 0.02;
    const amp = noise?.amplitude ?? 0;

    for (let i = 0; i < res; i++) {
        const z = -halfD + (i + 0.5) * worldDepth / res;
        for (let j = 0; j < res; j++) {
            const x = -halfW + (j + 0.5) * worldWidth / res;
            let h = 0;
            if (amp > 0) h += fbm2(x * freq, z * freq, seed, octaves) * amp;
            if (spec.hills) {
                for (const hill of spec.hills) h += hillContribution(hill, x, z);
            }
            data[i * res + j] = h;
        }
    }

    // flat_zones blend the existing surface toward a forced height. Inside
    // the shape: snap to height; in the feather band: lerp; outside: pass
    // through untouched. Applied last so it always wins where requested.
    if (spec.flat_zones) {
        for (const zone of spec.flat_zones) {
            for (let i = 0; i < res; i++) {
                const z = -halfD + (i + 0.5) * worldDepth / res;
                for (let j = 0; j < res; j++) {
                    const x = -halfW + (j + 0.5) * worldWidth / res;
                    const t = flatZoneWeight(zone, x, z);
                    if (t <= 0) continue;
                    const target = zone.height ?? 0;
                    const idx = i * res + j;
                    data[idx] = data[idx] * (1 - t) + target * t;
                }
            }
        }
    }

    if (typeof spec.max_height === 'number' && spec.max_height > 0) {
        const cap = spec.max_height;
        for (let k = 0; k < data.length; k++) {
            if (data[k] > cap) data[k] = cap;
            else if (data[k] < -cap) data[k] = -cap;
        }
    }

    return { data, resolution: res };
}

// Cheap deterministic 2D hash → [-1, 1].
function hash2(ix: number, iy: number, seed: number): number {
    let h = (Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ (seed | 0)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return (h / 0x80000000) - 1;
}

function smoothFade(t: number): number { return t * t * (3 - 2 * t); }

function valueNoise(x: number, y: number, seed: number): number {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const a = hash2(xi, yi, seed);
    const b = hash2(xi + 1, yi, seed);
    const c = hash2(xi, yi + 1, seed);
    const d = hash2(xi + 1, yi + 1, seed);
    const u = smoothFade(xf);
    const v = smoothFade(yf);
    return a + (b - a) * u + (c - a + (a - b - c + d) * u) * v;
}

function fbm2(x: number, y: number, seed: number, octaves: number): number {
    let total = 0, amp = 1, fr = 1, max = 0;
    for (let i = 0; i < octaves; i++) {
        total += valueNoise(x * fr, y * fr, seed + i * 1013) * amp;
        max += amp;
        amp *= 0.5;
        fr *= 2;
    }
    return max > 0 ? total / max : 0;
}

function shapeSignedDistance(shape: 'circle' | 'rect', cx: number, cz: number, radius: number | undefined, size: [number, number] | undefined, x: number, z: number): number {
    if (shape === 'circle') {
        const r = radius ?? 0;
        return Math.hypot(x - cx, z - cz) - r;
    }
    const w = (size?.[0] ?? 0) / 2;
    const d = (size?.[1] ?? 0) / 2;
    const dx = Math.max(Math.abs(x - cx) - w, 0);
    const dz = Math.max(Math.abs(z - cz) - d, 0);
    const outside = Math.hypot(dx, dz);
    const inside = Math.min(Math.max(Math.abs(x - cx) - w, Math.abs(z - cz) - d), 0);
    return outside + inside;
}

function hillContribution(hill: HillSpec, x: number, z: number): number {
    const feather = Math.max(0.0001, hill.feather ?? 8);
    const sd = shapeSignedDistance(hill.shape, hill.center[0], hill.center[1], hill.radius, hill.size, x, z);
    if (sd >= feather) return 0;
    if (sd <= 0) return hill.height;
    const t = sd / feather;
    const fall = (1 + Math.cos(Math.PI * t)) / 2;
    return hill.height * fall;
}

function flatZoneWeight(zone: FlatZoneSpec, x: number, z: number): number {
    const feather = Math.max(0.0001, zone.feather ?? 6);
    const sd = shapeSignedDistance(zone.shape, zone.center[0], zone.center[1], zone.radius, zone.size, x, z);
    if (sd >= feather) return 0;
    if (sd <= 0) return 1;
    const t = sd / feather;
    return (1 + Math.cos(Math.PI * t)) / 2;
}
