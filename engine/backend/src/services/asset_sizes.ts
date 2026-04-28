/**
 * Canonical 3D-model size lookup.
 *
 * Returns the size (W × H × D in meters) a GLB will render at after the
 * asset-normalization registry's rotation + scale is applied. Used by
 * `searchAssets` so AI tool calls (`bash search_assets.sh "..."`) report
 * dimensions next to each path — letting the AI plan placements with a
 * sense of scale instead of guessing.
 *
 * Lazy: each GLB is inspected on first lookup and cached. The MODEL_FACING.json
 * registry is also cached and re-read when its mtime changes.
 */

import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

const assetsDir = config.assetsDir;
const REGISTRY_PATH = path.join(assetsDir, 'MODEL_FACING.json');

// ── Registry cache ───────────────────────────────────────────────────────

interface FacingEntry {
    front?: string;
    up?: string;
    scale_to_meters?: { axis: 'length' | 'width' | 'height' | 'longest'; target_meters: number };
    scale_multiplier?: number;
    per_asset_overrides?: Record<string, FacingEntry>;
}
let _facingRegistry: Record<string, FacingEntry> = {};
let _facingMtime = -1;

function loadFacingRegistry(): Record<string, FacingEntry> {
    try {
        const stat = fs.statSync(REGISTRY_PATH);
        if (stat.mtimeMs === _facingMtime) return _facingRegistry;
        const j = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
        _facingRegistry = (j && typeof j === 'object') ? j : {};
        _facingMtime = stat.mtimeMs;
        // Invalidate the size cache when the registry changes — sizes depend on it.
        _sizeCache.clear();
    } catch {
        _facingRegistry = {};
    }
    return _facingRegistry;
}

// ── Rotation helper ──────────────────────────────────────────────────────
//
// Build a 3x3 rotation matrix (row-major, Float32Array[9]) that maps from
// the asset's current axes (front, up) to the engine's canonical axes
// (-Z forward, +Y up, +X right). Mirrors buildFacingRotation in
// engine/frontend/editor/src/utils/glb_loader.ts — keep in sync.

const AXIS_VECS: Record<string, [number, number, number]> = {
    '+x': [ 1,  0,  0], '-x': [-1,  0,  0],
    '+y': [ 0,  1,  0], '-y': [ 0, -1,  0],
    '+z': [ 0,  0,  1], '-z': [ 0,  0, -1],
};

function buildRotationMatrix(front?: string, up?: string): Float32Array | null {
    if (!front || !up) return null;
    const f = AXIS_VECS[front], u = AXIS_VECS[up];
    if (!f || !u) return null;
    if (f[0] * u[0] + f[1] * u[1] + f[2] * u[2] !== 0) return null;
    const nf: [number, number, number] = [-f[0], -f[1], -f[2]];
    const r: [number, number, number] = [
        u[1] * nf[2] - u[2] * nf[1],
        u[2] * nf[0] - u[0] * nf[2],
        u[0] * nf[1] - u[1] * nf[0],
    ];
    return new Float32Array([r[0], r[1], r[2], u[0], u[1], u[2], nf[0], nf[1], nf[2]]);
}

// Apply a rotation matrix to an axis-aligned bounding-box size. The rotated
// box's new AABB extent along world axis i is the absolute dot product of
// row i of R with the original size vector.
function rotateAabbSize(size: [number, number, number], R: Float32Array): [number, number, number] {
    const [sx, sy, sz] = size;
    return [
        Math.abs(R[0]) * sx + Math.abs(R[1]) * sy + Math.abs(R[2]) * sz,
        Math.abs(R[3]) * sx + Math.abs(R[4]) * sy + Math.abs(R[5]) * sz,
        Math.abs(R[6]) * sx + Math.abs(R[7]) * sy + Math.abs(R[8]) * sz,
    ];
}

function effectiveEntry(packEntry: FacingEntry | undefined, fileName: string): FacingEntry {
    if (!packEntry) return {};
    const out: FacingEntry = { ...packEntry };
    delete out.per_asset_overrides;
    const ov = packEntry.per_asset_overrides?.[fileName];
    if (ov) {
        for (const k of Object.keys(ov) as (keyof FacingEntry)[]) {
            if (k === 'scale_to_meters' && out.scale_to_meters) {
                out.scale_to_meters = { ...out.scale_to_meters, ...ov.scale_to_meters! };
            } else (out as any)[k] = (ov as any)[k];
        }
    }
    return out;
}

// ── GLB inspector — reads JSON chunk + walks node hierarchy ──────────────

interface RawAabb { min: [number, number, number]; max: [number, number, number]; size: [number, number, number]; }

interface GlbInspection {
    aabb: RawAabb;
    /**
     * Total vertex count across all primitives in the active scene. Sums
     * `accessors[POSITION].count` per primitive — i.e. the number of unique
     * vertices uploaded to the GPU (not 3 × triangles for indexed meshes).
     * Drives the cost annotation in `searchAssets` so AI can budget
     * mesh-heavy scenes.
     */
    vertices: number;
}

function inspectGlb(fullPath: string): GlbInspection | null {
    let buf: Buffer;
    try { buf = fs.readFileSync(fullPath); } catch { return null; }
    const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
    if (view.getUint32(0, true) !== 0x46546C67) return null;       // "glTF"

    const jsonLen = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4E4F534A) return null;      // "JSON"
    let gltf: any;
    try { gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf-8')); } catch { return null; }

    const matrices = computeWorldMatrices(gltf);
    const nodes = gltf.nodes ?? [];
    const sceneIdx = gltf.scene ?? 0;
    const inScene = new Set<number>();
    if (gltf.scenes?.[sceneIdx]?.nodes) {
        const collect = (i: number) => { if (inScene.has(i)) return; inScene.add(i); for (const c of (nodes[i]?.children ?? [])) collect(c); };
        for (const r of gltf.scenes[sceneIdx].nodes) collect(r);
    }

    let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
    let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
    let totalVerts = 0;
    for (let i = 0; i < nodes.length; i++) {
        if (inScene.size && !inScene.has(i)) continue;
        const n = nodes[i];
        if (n.mesh === undefined) continue;
        const mesh = gltf.meshes?.[n.mesh];
        if (!mesh?.primitives) continue;
        const m = matrices[i];
        for (const prim of mesh.primitives) {
            const accIdx = prim.attributes?.POSITION;
            if (accIdx === undefined) continue;
            const acc = gltf.accessors[accIdx];
            if (!acc) continue;
            if (typeof acc.count === 'number') totalVerts += acc.count;
            if (!acc.min || !acc.max) continue;
            for (const c of [
                [acc.min[0], acc.min[1], acc.min[2]], [acc.min[0], acc.min[1], acc.max[2]],
                [acc.min[0], acc.max[1], acc.min[2]], [acc.min[0], acc.max[1], acc.max[2]],
                [acc.max[0], acc.min[1], acc.min[2]], [acc.max[0], acc.min[1], acc.max[2]],
                [acc.max[0], acc.max[1], acc.min[2]], [acc.max[0], acc.max[1], acc.max[2]],
            ]) {
                const wx = m[0] * c[0] + m[4] * c[1] + m[8]  * c[2] + m[12];
                const wy = m[1] * c[0] + m[5] * c[1] + m[9]  * c[2] + m[13];
                const wz = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14];
                if (wx < mnX) mnX = wx; if (wx > mxX) mxX = wx;
                if (wy < mnY) mnY = wy; if (wy > mxY) mxY = wy;
                if (wz < mnZ) mnZ = wz; if (wz > mxZ) mxZ = wz;
            }
        }
    }
    if (!isFinite(mnX)) return null;
    return {
        aabb: { min: [mnX, mnY, mnZ], max: [mxX, mxY, mxZ], size: [mxX - mnX, mxY - mnY, mxZ - mnZ] },
        vertices: totalVerts,
    };
}

// Cache of raw GLB inspection results — keyed by relative file path.
// Independent of the registry (registry only affects size scaling, not raw
// AABB or vertex count), so this cache is permanent for the process lifetime
// and never invalidated by registry mtime changes.
const _glbInfoCache = new Map<string, GlbInspection | null>();

function getGlbInfo(filePath: string): GlbInspection | null {
    if (_glbInfoCache.has(filePath)) return _glbInfoCache.get(filePath)!;
    if (!filePath.toLowerCase().endsWith('.glb')) {
        _glbInfoCache.set(filePath, null);
        return null;
    }
    const info = inspectGlb(path.join(assetsDir, filePath));
    _glbInfoCache.set(filePath, info);
    return info;
}

function computeWorldMatrices(gltf: any): Float64Array[] {
    const nodes: any[] = gltf.nodes ?? [];
    const matrices: Float64Array[] = new Array(nodes.length);
    const parentOf = new Int32Array(nodes.length).fill(-1);
    for (let i = 0; i < nodes.length; i++) {
        for (const c of (nodes[i].children ?? [])) parentOf[c] = i;
    }

    function localMat(node: any): Float64Array {
        const m = new Float64Array(16);
        if (node.matrix) { for (let i = 0; i < 16; i++) m[i] = node.matrix[i]; return m; }
        const t = node.translation ?? [0, 0, 0];
        const r = node.rotation ?? [0, 0, 0, 1];
        const s = node.scale ?? [1, 1, 1];
        const x = r[0], y = r[1], z = r[2], w = r[3];
        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, xy = x * y2, xz = x * z2;
        const yy = y * y2, yz = y * z2, zz = z * z2;
        const wx = w * x2, wy = w * y2, wz = w * z2;
        m[0]  = (1 - (yy + zz)) * s[0]; m[1]  = (xy + wz)       * s[0]; m[2]  = (xz - wy)       * s[0];
        m[4]  = (xy - wz)       * s[1]; m[5]  = (1 - (xx + zz)) * s[1]; m[6]  = (yz + wx)       * s[1];
        m[8]  = (xz + wy)       * s[2]; m[9]  = (yz - wx)       * s[2]; m[10] = (1 - (xx + yy)) * s[2];
        m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
        return m;
    }

    function mul(a: Float64Array, b: Float64Array): Float64Array {
        const r = new Float64Array(16);
        for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
            r[col * 4 + row] =
                a[0 * 4 + row] * b[col * 4 + 0] + a[1 * 4 + row] * b[col * 4 + 1] +
                a[2 * 4 + row] * b[col * 4 + 2] + a[3 * 4 + row] * b[col * 4 + 3];
        }
        return r;
    }

    function get(idx: number): Float64Array {
        if (matrices[idx]) return matrices[idx];
        const local = localMat(nodes[idx]);
        matrices[idx] = parentOf[idx] < 0 ? local : mul(get(parentOf[idx]), local);
        return matrices[idx];
    }
    for (let i = 0; i < nodes.length; i++) get(i);
    return matrices;
}

// ── Public API ───────────────────────────────────────────────────────────

const _sizeCache = new Map<string, [number, number, number] | null>();

/**
 * Canonical size in meters for a GLB asset (raw AABB × registry scale).
 * Returns null for non-GLBs, missing files, or assets the inspector can't read.
 *
 * @param filePath  path RELATIVE to assets root (e.g. "kenney/3d_models/car_kit/sedan.glb")
 */
export function getCanonicalSize(filePath: string): [number, number, number] | null {
    const cached = _sizeCache.get(filePath);
    if (cached !== undefined) return cached;
    const info = getGlbInfo(filePath);
    if (!info) { _sizeCache.set(filePath, null); return null; }
    const raw = info.aabb;

    // Apply registry scale_multiplier (or scale_to_meters fallback)
    const reg = loadFacingRegistry();
    const segs = filePath.split(path.sep);
    const fileName = segs[segs.length - 1];
    const packKey = segs.slice(0, -1).join('/');
    const eff = effectiveEntry(reg[packKey], fileName);

    let scale = 1;
    if (typeof eff.scale_multiplier === 'number' && eff.scale_multiplier > 0) {
        scale = eff.scale_multiplier;
    } else if (eff.scale_to_meters && eff.scale_to_meters.target_meters > 0) {
        const [sx, sy, sz] = raw.size;
        const dim = eff.scale_to_meters.axis === 'height'  ? sy
                  : eff.scale_to_meters.axis === 'length'  ? Math.max(sx, sz)
                  : eff.scale_to_meters.axis === 'width'   ? Math.min(sx, sz)
                  : Math.max(sx, sy, sz);
        if (dim > 1e-6) scale = eff.scale_to_meters.target_meters / dim;
    }

    // Apply the registry rotation so the reported W x H x D is always in
    // canonical axes (X = left-right, Y = up-down, Z = forward-back). Without
    // this, packs with front=+x/-x would report W and D swapped — the AI
    // would reason about the wrong axis when planning placements.
    const R = buildRotationMatrix(eff.front, eff.up);
    const rotatedSize: [number, number, number] = R ? rotateAabbSize(raw.size, R) : raw.size;

    const size: [number, number, number] = [rotatedSize[0] * scale, rotatedSize[1] * scale, rotatedSize[2] * scale];
    _sizeCache.set(filePath, size);
    return size;
}

/**
 * Total vertex count for a GLB asset (sum of `accessors[POSITION].count`
 * across every primitive in the active scene). Returns null for non-GLBs,
 * missing files, or assets the inspector can't read. Independent of the
 * MODEL_FACING.json registry — vertices don't scale with size.
 *
 * Used by `searchAssets` so AI tool calls (`bash search_assets.sh`)
 * can report each match's render cost. Roughly proportional to GPU
 * vertex-shader work and per-mesh VRAM (each vertex carries position +
 * normal + uv = 32 bytes interleaved).
 *
 * @param filePath  path RELATIVE to assets root (e.g. "kenney/3d_models/car_kit/sedan.glb")
 */
export function getCanonicalVertexCount(filePath: string): number | null {
    const info = getGlbInfo(filePath);
    return info ? info.vertices : null;
}
