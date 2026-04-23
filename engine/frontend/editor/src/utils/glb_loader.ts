/**
 * Minimal GLB (Binary glTF 2.0) parser.
 * Extracts positions, normals, uvs, and indices from all mesh primitives.
 * Returns data suitable for uploading to the GPU.
 *
 * Also applies the per-pack facing/scale transform from MODEL_FACING.json
 * so every loaded model conforms to the engine's canonical convention:
 *   forward = -Z, up = +Y, right = +X, units = meters, origin = bottom-center.
 */

// ── Facing registry (MODEL_FACING.json) ──────────────────────────────────
//
// Fetched once per session from /assets/MODEL_FACING.json and cached.
// Each pack entry can have {front, up} axes plus a {scale_to_meters: {axis,
// target_meters}}. Per-asset overrides under per_asset_overrides[fileName]
// take precedence over pack-level fields.

type AxisLabel = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
interface ScaleSpec { axis: 'length' | 'width' | 'height' | 'longest'; target_meters: number; }
interface FacingEntry {
    front?: AxisLabel;
    up?: AxisLabel;
    category?: string;
    scale_to_meters?: ScaleSpec;
    /** Direct multiplier from the raw GLB scale. Wins over scale_to_meters when both are present. */
    scale_multiplier?: number;
    per_asset_overrides?: Record<string, FacingEntry>;
    notes?: string;
}

let _facingRegistry: Record<string, FacingEntry> | null = null;
let _facingRegistryPromise: Promise<Record<string, FacingEntry>> | null = null;
let _assetsRoot: string = '/assets';   // override via setAssetsRoot()
let _useFacingRegistry: boolean = false; // off by default — backwards-compat for legacy projects

export function setAssetsRoot(rootUrl: string) {
    _assetsRoot = rootUrl.replace(/\/$/, '');
    _facingRegistry = null;
    _facingRegistryPromise = null;
}

/**
 * Per-game opt-in for the asset-normalization registry. Old projects (pre-registry)
 * leave this off (the default) so their hand-tuned `mesh.scale` and `modelRotationY`
 * values keep working unchanged. New projects opt in by setting
 * `useFacingRegistry: true` in their project config; the engine then applies the
 * registry's rotation + scale and the AI is taught to omit the per-entity overrides.
 */
export function setUseFacingRegistry(on: boolean) {
    _useFacingRegistry = !!on;
}

export function isFacingRegistryEnabled(): boolean {
    return _useFacingRegistry;
}

async function getFacingRegistry(): Promise<Record<string, FacingEntry>> {
    if (_facingRegistry) return _facingRegistry;
    if (_facingRegistryPromise) return _facingRegistryPromise;
    const url = `${_assetsRoot}/MODEL_FACING.json`;
    _facingRegistryPromise = (async () => {
        try {
            const r = await fetch(url);
            if (!r.ok) {
                console.warn(`[FacingRegistry] ${url} returned HTTP ${r.status} — registry disabled this session`);
                return {};
            }
            const j = await r.json();
            return (j && typeof j === 'object') ? j as Record<string, FacingEntry> : {};
        } catch (e) {
            console.warn(`[FacingRegistry] failed to load ${url}:`, e);
            return {};
        }
    })();
    _facingRegistry = await _facingRegistryPromise;
    return _facingRegistry;
}

const AXIS_VECS: Record<AxisLabel, [number, number, number]> = {
    '+x': [ 1,  0,  0],  '-x': [-1,  0,  0],
    '+y': [ 0,  1,  0],  '-y': [ 0, -1,  0],
    '+z': [ 0,  0,  1],  '-z': [ 0,  0, -1],
};

function buildFacingRotation(front: AxisLabel, up: AxisLabel): Float32Array | null {
    const f = AXIS_VECS[front], u = AXIS_VECS[up];
    if (!f || !u) return null;
    if (f[0] * u[0] + f[1] * u[1] + f[2] * u[2] !== 0) return null;
    // right = cross(up, -forward)
    const nf: [number, number, number] = [-f[0], -f[1], -f[2]];
    const r: [number, number, number] = [
        u[1] * nf[2] - u[2] * nf[1],
        u[2] * nf[0] - u[0] * nf[2],
        u[0] * nf[1] - u[1] * nf[0],
    ];
    // Row-major 3x3: rows are canonical basis expressed in asset coords.
    return new Float32Array([
        r[0],  r[1],  r[2],
        u[0],  u[1],  u[2],
        nf[0], nf[1], nf[2],
    ]);
}

function effectiveEntry(packEntry: FacingEntry | undefined, fileName: string): FacingEntry {
    if (!packEntry) return {};
    const out: FacingEntry = { ...packEntry };
    delete (out as any).per_asset_overrides;
    if (packEntry.per_asset_overrides && packEntry.per_asset_overrides[fileName]) {
        const ov = packEntry.per_asset_overrides[fileName];
        for (const k of Object.keys(ov) as (keyof FacingEntry)[]) {
            if (k === 'scale_to_meters' && out.scale_to_meters) {
                out.scale_to_meters = { ...out.scale_to_meters, ...ov.scale_to_meters! };
            } else {
                (out as any)[k] = (ov as any)[k];
            }
        }
    }
    return out;
}

function packKeyFromUrl(url: string): { packKey: string; fileName: string } | null {
    // Strip query/hash, then drop the assets root prefix to get the pack-relative path.
    const clean = url.split('?')[0].split('#')[0];
    const idx = clean.indexOf(_assetsRoot + '/');
    if (idx < 0) return null;
    const rel = clean.substring(idx + _assetsRoot.length + 1);
    const lastSlash = rel.lastIndexOf('/');
    if (lastSlash < 0) return null;
    return { packKey: rel.substring(0, lastSlash), fileName: rel.substring(lastSlash + 1) };
}

/**
 * Apply a 3x3 rotation (row-major 9 floats) to positions and normals in place.
 * Normals get re-normalized after rotation.
 */
function rotatePositionsNormals(positions: Float32Array, normals: Float32Array, R: Float32Array) {
    const r00 = R[0], r01 = R[1], r02 = R[2];
    const r10 = R[3], r11 = R[4], r12 = R[5];
    const r20 = R[6], r21 = R[7], r22 = R[8];
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        positions[i]     = r00 * x + r01 * y + r02 * z;
        positions[i + 1] = r10 * x + r11 * y + r12 * z;
        positions[i + 2] = r20 * x + r21 * y + r22 * z;
    }
    for (let i = 0; i < normals.length; i += 3) {
        const x = normals[i], y = normals[i + 1], z = normals[i + 2];
        let nx = r00 * x + r01 * y + r02 * z;
        let ny = r10 * x + r11 * y + r12 * z;
        let nz = r20 * x + r21 * y + r22 * z;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 1e-6) { nx /= len; ny /= len; nz /= len; }
        normals[i]     = nx;
        normals[i + 1] = ny;
        normals[i + 2] = nz;
    }
}

function pickScaleDimension(sx: number, sy: number, sz: number, axisLabel: ScaleSpec['axis']): number {
    switch (axisLabel) {
        case 'height':  return sy;
        case 'length':  return Math.max(sx, sz);
        case 'width':   return Math.min(sx, sz);
        case 'longest': return Math.max(sx, sy, sz);
    }
}

function applyFacingTransformInPlace(parsed: ParsedMesh, entry: FacingEntry) {
    const positions = parsed.positions;
    const normals = parsed.normals;

    // For SKINNED meshes, baking the transform into vertex positions breaks the
    // skeleton: bones still drive vertices to their unscaled/unrotated positions,
    // so animations explode (the soldier's arms float in the air). Instead we
    // stash the facing transform on the parsed mesh and the renderer composes it
    // into the model matrix at draw time, applying it uniformly to vertices and
    // bone-driven positions alike.
    if (parsed.hasSkin) {
        if (entry.front && entry.up) {
            const R = buildFacingRotation(entry.front, entry.up);
            if (R) parsed.facingRotMatrix = R;
        }
        let scale: number | null = null;
        if (typeof entry.scale_multiplier === 'number' && entry.scale_multiplier > 0) {
            scale = entry.scale_multiplier;
        } else if (entry.scale_to_meters && entry.scale_to_meters.target_meters > 0) {
            // For scale_to_meters on skinned, derive multiplier from the
            // (un-rotated, un-scaled) bind-pose AABB. Rotation here is OK
            // because uniform scale * rotation preserves dimensions.
            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            let minZ = Infinity, maxZ = -Infinity;
            for (let i = 0; i < positions.length; i += 3) {
                const x = positions[i], y = positions[i + 1], z = positions[i + 2];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
            if (isFinite(minX)) {
                const dim = pickScaleDimension(maxX - minX, maxY - minY, maxZ - minZ, entry.scale_to_meters.axis);
                if (dim > 1e-6) scale = entry.scale_to_meters.target_meters / dim;
            }
        }
        if (scale !== null && Math.abs(scale - 1) > 1e-4) parsed.facingScale = scale;
        return;
    }

    // STATIC meshes: safe to bake into vertices (no skeleton to fight).
    // 1) Rotation
    if (entry.front && entry.up) {
        const R = buildFacingRotation(entry.front, entry.up);
        if (R) rotatePositionsNormals(positions, normals, R);
    }

    // 2) Scale — scale_multiplier (direct from raw) wins over scale_to_meters
    let scale: number | null = null;
    if (typeof entry.scale_multiplier === 'number' && entry.scale_multiplier > 0) {
        scale = entry.scale_multiplier;
    } else if (entry.scale_to_meters && entry.scale_to_meters.target_meters > 0) {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        if (isFinite(minX)) {
            const dim = pickScaleDimension(maxX - minX, maxY - minY, maxZ - minZ, entry.scale_to_meters.axis);
            if (dim > 1e-6) scale = entry.scale_to_meters.target_meters / dim;
        }
    }
    if (scale !== null && Math.abs(scale - 1) > 1e-4) {
        for (let i = 0; i < positions.length; i++) positions[i] *= scale;
    }

    // 3) Re-center bottom to (0, y=0, 0). The original parseGLB does this once
    //    pre-rotation; if we rotated, rerun so the resulting AABB is aligned.
    {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        if (isFinite(minX)) {
            const offX = (minX + maxX) / 2;
            const offY = minY;
            const offZ = (minZ + maxZ) / 2;
            if (Math.abs(offX) > 0.001 || Math.abs(offY) > 0.001 || Math.abs(offZ) > 0.001) {
                for (let i = 0; i < positions.length; i += 3) {
                    positions[i] -= offX;
                    positions[i + 1] -= offY;
                    positions[i + 2] -= offZ;
                }
            }
        }
    }
}

// ── Parsed-mesh interface ────────────────────────────────────────────────

export interface ParsedMesh {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    /** URL to the base color texture image, if any */
    baseColorTextureUrl?: string;
    /** Embedded base color texture as a Blob, if stored in the GLB binary chunk */
    baseColorTextureBlob?: Blob;
    /** Embedded normal map texture as a Blob (single-material GLBs) */
    normalMapTextureBlob?: Blob;
    /** Multiple texture blobs for atlas building (multi-material GLBs) */
    atlasTextureBlobs?: (Blob | null)[];
    /** Base color factors for materials without textures [r,g,b,a] 0-255 */
    atlasBaseColors?: ([number, number, number, number] | null)[];
    /** Atlas grid dimensions (cols x rows) */
    atlasGrid?: { cols: number; rows: number };
    /** Per-slot max UV tiling extents [maxU, maxV] for pre-tiling textures in atlas */
    atlasMaxUVs?: [number, number][];
    /** Normal map texture blobs for atlas building (parallel to atlasTextureBlobs) */
    atlasNormalMapBlobs?: (Blob | null)[];
    /** Per-material sub-mesh index ranges for multi-material rendering */
    subMeshRanges?: { firstIndex: number; indexCount: number; slot: number }[];
    /** Per-slot alpha mode from glTF material ('OPAQUE' | 'MASK' | 'BLEND') */
    atlasAlphaModes?: string[];
    /** Per-vertex bone indices (4 per vertex), if the GLB has skin data */
    joints?: Uint16Array;
    /** Per-vertex bone weights (4 per vertex), if the GLB has skin data */
    weights?: Float32Array;
    /** Whether this mesh has embedded skin data */
    hasSkin?: boolean;
    /**
     * Asset-normalization registry rotation, as a 3x3 row-major matrix.
     * Only set for skinned meshes (where baking into vertex positions would
     * desynchronise the skeleton). The renderer composes it into the model
     * matrix so it applies uniformly to vertex+bone positions.
     */
    facingRotMatrix?: Float32Array;
    /**
     * Asset-normalization registry uniform scale. Only set for skinned meshes —
     * for static meshes we bake the scale into vertex positions in the loader.
     */
    facingScale?: number;
    /** Extracted skeleton from glTF skin */
    skeleton?: ParsedSkeleton;
    /** Extracted animation clips from glTF animations */
    animationClips?: ParsedAnimationClip[];
}

export interface ParsedBone {
    name: string;
    parentIndex: number;
    /** Column-major 4x4 inverse bind matrix */
    inverseBindMatrix: Float32Array;
    /** Local bind pose */
    localBindPose: {
        position: [number, number, number];
        rotation: [number, number, number, number];
        scale: [number, number, number];
    };
}

export interface ParsedSkeleton {
    bones: ParsedBone[];
}

export interface ParsedAnimKeyframe {
    time: number;
    value: number[];
}

export interface ParsedAnimChannel {
    boneIndex: number;
    positionKeys?: ParsedAnimKeyframe[];
    rotationKeys?: ParsedAnimKeyframe[];
    scaleKeys?: ParsedAnimKeyframe[];
}

export interface ParsedAnimationClip {
    name: string;
    duration: number;
    channels: ParsedAnimChannel[];
}

export async function loadGLB(url: string): Promise<ParsedMesh> {
    if (!_useFacingRegistry) {
        // Legacy path — no registry fetch, no transforms applied. Identical to
        // pre-registry behavior so existing projects continue to render exactly
        // as their hand-tuned mesh.scale / modelRotationY expect.
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Failed to fetch GLB: ${resp.status}`);
        const buffer = await resp.arrayBuffer();
        return parseGLB(buffer, url);
    }
    const [resp, registry] = await Promise.all([
        fetch(url),
        getFacingRegistry(),
    ]);
    if (!resp.ok) throw new Error(`Failed to fetch GLB: ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    const parsed = parseGLB(buffer, url);

    const keyInfo = packKeyFromUrl(url);
    if (!keyInfo) return parsed;
    const packEntry = registry[keyInfo.packKey];
    if (!packEntry) return parsed;
    const entry = effectiveEntry(packEntry, keyInfo.fileName);
    if (entry.front || entry.scale_to_meters || entry.scale_multiplier) {
        applyFacingTransformInPlace(parsed, entry);
    }
    return parsed;
}

/**
 * Apply the same facing transform the visible mesh receives, but to a flat
 * Float32Array of positions (e.g. .collision.bin contents). Used by the
 * collider loader so the collision shape stays aligned with the visible mesh
 * when the registry is on.
 *
 * Returns true if a transform was applied (caller may want to invalidate any
 * cached AABBs derived from the positions).
 */
export async function applyFacingTransformToPositions(positions: Float32Array, glbUrl: string): Promise<boolean> {
    if (!_useFacingRegistry) return false;
    const registry = await getFacingRegistry();
    const keyInfo = packKeyFromUrl(glbUrl);
    if (!keyInfo) return false;
    const entry = effectiveEntry(registry[keyInfo.packKey], keyInfo.fileName);
    if (!entry.front && !entry.scale_to_meters && !entry.scale_multiplier) return false;
    // Reuse the same in-place pipeline by wrapping positions in a tiny ParsedMesh-like shim.
    // Normals don't exist on collision data; pass an empty Float32Array to skip the normal pass.
    applyFacingTransformInPlace(
        { positions, normals: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0) } as any,
        entry,
    );
    return true;
}

function parseGLB(buffer: ArrayBuffer, glbUrl?: string): ParsedMesh {
    const view = new DataView(buffer);

    // GLB header: magic(4) version(4) length(4)
    const magic = view.getUint32(0, true);
    if (magic !== 0x46546C67) throw new Error('Not a valid GLB file');

    // Chunk 0: JSON
    const jsonChunkLength = view.getUint32(12, true);
    const jsonChunkType = view.getUint32(16, true);
    if (jsonChunkType !== 0x4E4F534A) throw new Error('Expected JSON chunk');
    const jsonBytes = new Uint8Array(buffer, 20, jsonChunkLength);
    const gltf = JSON.parse(new TextDecoder().decode(jsonBytes));

    // Chunk 1: BIN
    const binOffset = 20 + jsonChunkLength;
    let binData: ArrayBuffer;
    if (binOffset < buffer.byteLength) {
        const binChunkLength = view.getUint32(binOffset, true);
        binData = buffer.slice(binOffset + 8, binOffset + 8 + binChunkLength);
    } else {
        binData = new ArrayBuffer(0);
    }

    if (!gltf.meshes?.length) throw new Error('No mesh found in GLB');

    const nodeWorldMatrices = computeNodeWorldMatrices(gltf);

    const allPositions: Float32Array[] = [];
    const allNormals: Float32Array[] = [];
    const allUvs: Float32Array[] = [];
    const allIndices: number[] = [];
    const allJoints: Uint16Array[] = [];
    const allWeights: Float32Array[] = [];
    let hasSkin = false;
    let vertexOffset = 0;

    // Collect all nodes from the scene hierarchy
    const processedNodes = new Set<number>();
    const nodesToProcess: number[] = [];
    if (gltf.scenes?.length) {
        const sceneIdx = gltf.scene ?? 0;
        const scene = gltf.scenes[sceneIdx];
        if (scene?.nodes) {
            const collectNodes = (idx: number) => {
                if (processedNodes.has(idx)) return;
                processedNodes.add(idx);
                nodesToProcess.push(idx);
                const node = gltf.nodes[idx];
                if (node.children) {
                    for (const childIdx of node.children) collectNodes(childIdx);
                }
            };
            for (const rootIdx of scene.nodes) collectNodes(rootIdx);
        }
    } else if (gltf.nodes) {
        for (let i = 0; i < gltf.nodes.length; i++) {
            nodesToProcess.push(i);
        }
    }

    // Build material-to-atlas-slot mapping (deduplicated by image)
    const materials: any[] = gltf.materials ?? [];
    const atlasSlots: { blob: Blob | null; baseColor: [number, number, number, number] }[] = [];
    const normalMapBlobs: (Blob | null)[] = [];
    const alphaModes: string[] = [];
    const materialToSlot = new Map<number, number>();
    const imageToSlot = new Map<number, number>();
    const colorToSlot = new Map<string, number>();

    function extractImageBlob(gltfImgIdx: number): Blob | null {
        const img = gltf.images?.[gltfImgIdx];
        if (!img || img.bufferView === undefined) return null;
        const bv = gltf.bufferViews[img.bufferView];
        const bvOffset = bv.byteOffset ?? 0;
        const bvLength = bv.byteLength;
        const mimeType = img.mimeType ?? 'image/png';
        return new Blob([new Uint8Array(binData, bvOffset, bvLength)], { type: mimeType });
    }

    for (let matIdx = 0; matIdx < materials.length; matIdx++) {
        const mat = materials[matIdx];
        const pbr = mat?.pbrMetallicRoughness;
        const texIdxVal = pbr?.baseColorTexture?.index;
        const bcf = pbr?.baseColorFactor ?? [1, 1, 1, 1];
        const matAlphaMode: string = mat?.alphaMode ?? 'OPAQUE';
        // For OPAQUE/MASK modes, force alpha to 1 -- some GLBs set baseColorFactor alpha
        // to 0 because textures handle visibility, but the shader discards alpha < 0.01
        const effectiveAlpha = (matAlphaMode !== 'BLEND') ? 1 : (bcf[3] ?? 1);
        const baseColor: [number, number, number, number] = [
            Math.round(bcf[0] * 255),
            Math.round(bcf[1] * 255),
            Math.round(bcf[2] * 255),
            Math.round(effectiveAlpha * 255),
        ];

        let normalBlob: Blob | null = null;
        const normalTexIdx = mat?.normalTexture?.index;
        if (normalTexIdx !== undefined && gltf.textures?.[normalTexIdx]) {
            const normalImgIdx = gltf.textures[normalTexIdx].source;
            if (normalImgIdx !== undefined) normalBlob = extractImageBlob(normalImgIdx);
        }

        let imgIdx: number | undefined;
        if (texIdxVal !== undefined && gltf.textures?.[texIdxVal]) {
            imgIdx = gltf.textures[texIdxVal].source;
        }

        if (imgIdx !== undefined) {
            if (imageToSlot.has(imgIdx)) {
                const existingSlot = imageToSlot.get(imgIdx)!;
                materialToSlot.set(matIdx, existingSlot);
                if (matAlphaMode === 'BLEND') alphaModes[existingSlot] = 'BLEND';
            } else {
                const blob = extractImageBlob(imgIdx);
                const slotIdx = atlasSlots.length;
                atlasSlots.push({ blob, baseColor });
                normalMapBlobs.push(normalBlob);
                alphaModes.push(matAlphaMode);
                imageToSlot.set(imgIdx, slotIdx);
                materialToSlot.set(matIdx, slotIdx);
            }
        } else {
            const colorKey = baseColor.join(',');
            if (colorToSlot.has(colorKey)) {
                const existingSlot = colorToSlot.get(colorKey)!;
                materialToSlot.set(matIdx, existingSlot);
                if (matAlphaMode === 'BLEND') alphaModes[existingSlot] = 'BLEND';
            } else {
                const slotIdx = atlasSlots.length;
                atlasSlots.push({ blob: null, baseColor });
                normalMapBlobs.push(normalBlob);
                alphaModes.push(matAlphaMode);
                colorToSlot.set(colorKey, slotIdx);
                materialToSlot.set(matIdx, slotIdx);
            }
        }
    }

    if (atlasSlots.length === 0) {
        atlasSlots.push({ blob: null, baseColor: [255, 255, 255, 255] });
        normalMapBlobs.push(null);
        alphaModes.push('OPAQUE');
    }

    const numSlots = atlasSlots.length;
    const useAtlas = numSlots > 1;

    // Collect per-primitive index arrays with slot info, then sort by slot
    // so same-material primitives are contiguous for batched draw calls.
    const primIndexBuffers: { indices: number[]; slot: number }[] = [];

    for (const nodeIdx of nodesToProcess) {
        const node = gltf.nodes[nodeIdx];
        if (node.mesh === undefined) continue;

        const meshDef = gltf.meshes[node.mesh];
        if (!meshDef?.primitives) continue;

        const worldMatrix = nodeWorldMatrices[nodeIdx];

        for (const primitive of meshDef.primitives) {
            const posAccessorIdx = primitive.attributes?.POSITION;
            if (posAccessorIdx === undefined) continue;

            const rawPositions = getAccessorData(gltf, binData, posAccessorIdx) as Float32Array;
            const vertCount = rawPositions.length / 3;

            let rawNormals: Float32Array;
            if (primitive.attributes.NORMAL !== undefined) {
                rawNormals = getAccessorData(gltf, binData, primitive.attributes.NORMAL) as Float32Array;
            } else {
                rawNormals = new Float32Array(vertCount * 3);
                for (let i = 0; i < vertCount; i++) rawNormals[i * 3 + 1] = 1;
            }

            // Transform positions and normals by the node's world matrix
            const positions = new Float32Array(vertCount * 3);
            const normals = new Float32Array(vertCount * 3);
            const m = worldMatrix;

            for (let i = 0; i < vertCount; i++) {
                const px = rawPositions[i * 3];
                const py = rawPositions[i * 3 + 1];
                const pz = rawPositions[i * 3 + 2];

                positions[i * 3]     = m[0] * px + m[4] * py + m[8]  * pz + m[12];
                positions[i * 3 + 1] = m[1] * px + m[5] * py + m[9]  * pz + m[13];
                positions[i * 3 + 2] = m[2] * px + m[6] * py + m[10] * pz + m[14];

                const nx = rawNormals[i * 3];
                const ny = rawNormals[i * 3 + 1];
                const nz = rawNormals[i * 3 + 2];

                let tnx = m[0] * nx + m[4] * ny + m[8]  * nz;
                let tny = m[1] * nx + m[5] * ny + m[9]  * nz;
                let tnz = m[2] * nx + m[6] * ny + m[10] * nz;

                const len = Math.sqrt(tnx * tnx + tny * tny + tnz * tnz);
                if (len > 1e-6) { tnx /= len; tny /= len; tnz /= len; }

                normals[i * 3]     = tnx;
                normals[i * 3 + 1] = tny;
                normals[i * 3 + 2] = tnz;
            }

            let uvs: Float32Array;
            if (primitive.attributes.TEXCOORD_0 !== undefined) {
                uvs = getAccessorData(gltf, binData, primitive.attributes.TEXCOORD_0) as Float32Array;
            } else {
                uvs = new Float32Array(vertCount * 2);
            }

            // Extract skin data if present
            if (primitive.attributes.JOINTS_0 !== undefined && primitive.attributes.WEIGHTS_0 !== undefined) {
                hasSkin = true;
                const rawJoints = getAccessorData(gltf, binData, primitive.attributes.JOINTS_0);
                const rawWeights = getAccessorData(gltf, binData, primitive.attributes.WEIGHTS_0) as Float32Array;
                const jointsU16 = new Uint16Array(vertCount * 4);
                for (let i = 0; i < vertCount * 4; i++) jointsU16[i] = rawJoints[i];
                allJoints.push(jointsU16);
                allWeights.push(rawWeights);
            } else {
                allJoints.push(new Uint16Array(vertCount * 4));
                allWeights.push(new Float32Array(vertCount * 4));
            }

            allPositions.push(positions);
            allNormals.push(normals);
            allUvs.push(uvs);

            const primIndices: number[] = [];
            if (primitive.indices !== undefined) {
                const indices = getAccessorData(gltf, binData, primitive.indices);
                for (let i = 0; i < indices.length; i++) {
                    primIndices.push(indices[i] + vertexOffset);
                }
            } else {
                for (let i = 0; i < vertCount; i++) {
                    primIndices.push(i + vertexOffset);
                }
            }

            const matIdx = primitive.material ?? 0;
            const slot = useAtlas ? (materialToSlot.get(matIdx) ?? 0) : 0;
            primIndexBuffers.push({ indices: primIndices, slot });

            vertexOffset += vertCount;
        }
    }

    // Sort primitives by material slot so same-material indices are contiguous,
    // then build merged index buffer and one sub-mesh range per unique slot.
    const subMeshRanges: { firstIndex: number; indexCount: number; slot: number }[] = [];
    if (useAtlas) {
        primIndexBuffers.sort((a, b) => a.slot - b.slot);
    }
    let currentSlot = -1;
    let rangeStart = 0;
    for (const prim of primIndexBuffers) {
        if (useAtlas && prim.slot !== currentSlot) {
            if (currentSlot >= 0 && allIndices.length > rangeStart) {
                subMeshRanges.push({ firstIndex: rangeStart, indexCount: allIndices.length - rangeStart, slot: currentSlot });
            }
            currentSlot = prim.slot;
            rangeStart = allIndices.length;
        }
        for (let i = 0; i < prim.indices.length; i++) {
            allIndices.push(prim.indices[i]);
        }
    }
    if (useAtlas && currentSlot >= 0 && allIndices.length > rangeStart) {
        subMeshRanges.push({ firstIndex: rangeStart, indexCount: allIndices.length - rangeStart, slot: currentSlot });
    }

    // Single-texture extraction for single-material GLBs
    let baseColorTextureUrl: string | undefined;
    let baseColorTextureBlob: Blob | undefined;
    let normalMapTextureBlob: Blob | undefined;

    if (!useAtlas && atlasSlots.length === 1 && atlasSlots[0].blob) {
        baseColorTextureBlob = atlasSlots[0].blob;
        if (normalMapBlobs[0]) normalMapTextureBlob = normalMapBlobs[0];
    } else if (!useAtlas) {
        const firstMat = gltf.materials?.[0];
        const texIdxFb = firstMat?.pbrMetallicRoughness?.baseColorTexture?.index;
        if (texIdxFb !== undefined && gltf.textures?.[texIdxFb]) {
            const imgIdx = gltf.textures[texIdxFb].source;
            const img = gltf.images?.[imgIdx];
            if (img?.uri && glbUrl) {
                const base = glbUrl.substring(0, glbUrl.lastIndexOf('/') + 1);
                baseColorTextureUrl = base + img.uri;
            }
        }
    }

    const positions = concatFloat32Arrays(allPositions);

    // Auto-center mesh to bottom-center (feet at Y=0, centered on X/Z).
    // Many GLB files have geometry far from origin; centering ensures the
    // entity transform alone controls world placement.
    {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < positions.length; i += 3) {
            const x = positions[i], y = positions[i + 1], z = positions[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        if (isFinite(minX)) {
            const offX = (minX + maxX) / 2;
            const offY = minY;
            const offZ = (minZ + maxZ) / 2;
            if (Math.abs(offX) > 0.001 || Math.abs(offY) > 0.001 || Math.abs(offZ) > 0.001) {
                for (let i = 0; i < positions.length; i += 3) {
                    positions[i] -= offX;
                    positions[i + 1] -= offY;
                    positions[i + 2] -= offZ;
                }
            }
        }
    }

    const result: ParsedMesh = {
        positions,
        normals: concatFloat32Arrays(allNormals),
        uvs: concatFloat32Arrays(allUvs),
        indices: new Uint32Array(allIndices),
        baseColorTextureUrl,
        baseColorTextureBlob,
        normalMapTextureBlob,
    };

    if (useAtlas) {
        result.atlasTextureBlobs = atlasSlots.map(s => s.blob);
        result.atlasBaseColors = atlasSlots.map(s => s.baseColor);
        if (normalMapBlobs.some(b => b !== null)) {
            result.atlasNormalMapBlobs = normalMapBlobs;
        }
        if (subMeshRanges.length > 0) {
            result.subMeshRanges = subMeshRanges;
        }
        if (alphaModes.some(m => m !== 'OPAQUE')) {
            result.atlasAlphaModes = alphaModes;
        }
    }

    if (hasSkin) {
        result.joints = concatUint16Arrays(allJoints);
        result.weights = concatFloat32Arrays(allWeights);
        result.hasSkin = true;
    }

    // Extract skeleton and animations from glTF skin data
    const skin = gltf.skins?.[0];
    if (skin && gltf.nodes) {
        const jointNodeIndices: number[] = skin.joints ?? [];
        const jointCount = jointNodeIndices.length;

        const nodeToJoint = new Map<number, number>();
        for (let j = 0; j < jointCount; j++) nodeToJoint.set(jointNodeIndices[j], j);

        let ibms: Float32Array | null = null;
        if (skin.inverseBindMatrices !== undefined) {
            ibms = getAccessorData(gltf, binData, skin.inverseBindMatrices) as Float32Array;
        }

        const bones: ParsedBone[] = [];
        for (let j = 0; j < jointCount; j++) {
            const nodeIdx = jointNodeIndices[j];
            const node = gltf.nodes[nodeIdx];

            // Find parent joint index by checking which joint node lists this one as a child
            let parentJointIndex = -1;
            for (let pi = 0; pi < jointCount; pi++) {
                const pNodeIdx = jointNodeIndices[pi];
                const pNode = gltf.nodes[pNodeIdx];
                if (pNode.children && pNode.children.includes(nodeIdx)) {
                    parentJointIndex = pi;
                    break;
                }
            }

            const t = node.translation ?? [0, 0, 0];
            const r = node.rotation ?? [0, 0, 0, 1];
            const s = node.scale ?? [1, 1, 1];

            const ibm = new Float32Array(16);
            if (ibms) {
                for (let k = 0; k < 16; k++) ibm[k] = ibms[j * 16 + k];
            } else {
                ibm[0] = ibm[5] = ibm[10] = ibm[15] = 1;
            }

            bones.push({
                name: node.name || `joint_${j}`,
                parentIndex: parentJointIndex,
                inverseBindMatrix: ibm,
                localBindPose: {
                    position: [t[0], t[1], t[2]],
                    rotation: [r[0], r[1], r[2], r[3]],
                    scale: [s[0], s[1], s[2]],
                },
            });
        }

        result.skeleton = { bones };

        // Extract animation clips
        if (gltf.animations?.length) {
            const clips: ParsedAnimationClip[] = [];
            for (const anim of gltf.animations) {
                const boneChannels = new Map<number, ParsedAnimChannel>();
                let duration = 0;

                for (const ch of anim.channels ?? []) {
                    const targetNode = ch.target?.node;
                    const path = ch.target?.path;
                    if (targetNode === undefined || !path) continue;

                    const jointIdx = nodeToJoint.get(targetNode);
                    if (jointIdx === undefined) continue;

                    const sampler = anim.samplers?.[ch.sampler];
                    if (!sampler) continue;

                    const inputData = getAccessorData(gltf, binData, sampler.input) as Float32Array;
                    const outputData = getAccessorData(gltf, binData, sampler.output) as Float32Array;

                    const keyframes: ParsedAnimKeyframe[] = [];
                    const compCount = path === 'rotation' ? 4 : 3;
                    for (let k = 0; k < inputData.length; k++) {
                        const time = inputData[k];
                        if (time > duration) duration = time;
                        const value: number[] = [];
                        for (let c = 0; c < compCount; c++) value.push(outputData[k * compCount + c]);
                        keyframes.push({ time, value });
                    }

                    let channel = boneChannels.get(jointIdx);
                    if (!channel) {
                        channel = { boneIndex: jointIdx };
                        boneChannels.set(jointIdx, channel);
                    }

                    if (path === 'translation') channel.positionKeys = keyframes;
                    else if (path === 'rotation') channel.rotationKeys = keyframes;
                    else if (path === 'scale') channel.scaleKeys = keyframes;
                }

                const channels: ParsedAnimChannel[] = [];
                for (const ch of boneChannels.values()) channels.push(ch);

                // Clean animation name: strip "Armature|Armature|" prefixes
                let name = anim.name || `clip_${clips.length}`;
                const pipeIdx = name.lastIndexOf('|');
                if (pipeIdx >= 0) name = name.substring(pipeIdx + 1);

                clips.push({ name, duration, channels });
            }
            result.animationClips = clips;
        }
    }

    return result;
}

/**
 * Compute a 4x4 world matrix (column-major Float64Array[16]) for every node,
 * applying the full parent chain of TRS / matrix transforms.
 */
function computeNodeWorldMatrices(gltf: any): Float64Array[] {
    const nodes: any[] = gltf.nodes ?? [];
    const matrices: Float64Array[] = new Array(nodes.length);

    const parentOf = new Int32Array(nodes.length).fill(-1);
    for (let i = 0; i < nodes.length; i++) {
        const children: number[] | undefined = nodes[i].children;
        if (children) {
            for (const c of children) parentOf[c] = i;
        }
    }

    function localMatrix(node: any): Float64Array {
        const m = new Float64Array(16);
        if (node.matrix) {
            for (let i = 0; i < 16; i++) m[i] = node.matrix[i];
            return m;
        }
        const t = node.translation ?? [0, 0, 0];
        const r = node.rotation ?? [0, 0, 0, 1];
        const s = node.scale ?? [1, 1, 1];

        const x = r[0], y = r[1], z = r[2], w = r[3];
        const x2 = x + x, y2 = y + y, z2 = z + z;
        const xx = x * x2, xy = x * y2, xz = x * z2;
        const yy = y * y2, yz = y * z2, zz = z * z2;
        const wx = w * x2, wy = w * y2, wz = w * z2;

        m[0]  = (1 - (yy + zz)) * s[0];
        m[1]  = (xy + wz)       * s[0];
        m[2]  = (xz - wy)       * s[0];
        m[3]  = 0;
        m[4]  = (xy - wz)       * s[1];
        m[5]  = (1 - (xx + zz)) * s[1];
        m[6]  = (yz + wx)       * s[1];
        m[7]  = 0;
        m[8]  = (xz + wy)       * s[2];
        m[9]  = (yz - wx)       * s[2];
        m[10] = (1 - (xx + yy)) * s[2];
        m[11] = 0;
        m[12] = t[0];
        m[13] = t[1];
        m[14] = t[2];
        m[15] = 1;
        return m;
    }

    function mul(a: Float64Array, b: Float64Array): Float64Array {
        const r = new Float64Array(16);
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

    function getWorldMatrix(idx: number): Float64Array {
        if (matrices[idx]) return matrices[idx];
        const local = localMatrix(nodes[idx]);
        if (parentOf[idx] < 0) {
            matrices[idx] = local;
        } else {
            matrices[idx] = mul(getWorldMatrix(parentOf[idx]), local);
        }
        return matrices[idx];
    }

    for (let i = 0; i < nodes.length; i++) getWorldMatrix(i);
    return matrices;
}

function getAccessorData(gltf: any, binData: ArrayBuffer, accessorIdx: number): Float32Array | Uint16Array | Uint32Array | Uint8Array {
    const accessor = gltf.accessors[accessorIdx];
    const bufferView = gltf.bufferViews[accessor.bufferView];
    const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const count = accessor.count;

    const typeCounts: Record<string, number> = {
        'SCALAR': 1,
        'VEC2': 2,
        'VEC3': 3,
        'VEC4': 4,
        'MAT2': 4,
        'MAT3': 9,
        'MAT4': 16,
    };

    const numComponents = typeCounts[accessor.type] ?? 1;
    const totalElements = count * numComponents;

    switch (accessor.componentType) {
        case 5126: { // FLOAT
            const byteLen = totalElements * 4;
            return new Float32Array(binData.slice(byteOffset, byteOffset + byteLen));
        }
        case 5123: { // UNSIGNED_SHORT
            const byteLen = totalElements * 2;
            return new Uint16Array(binData.slice(byteOffset, byteOffset + byteLen));
        }
        case 5125: { // UNSIGNED_INT
            const byteLen = totalElements * 4;
            return new Uint32Array(binData.slice(byteOffset, byteOffset + byteLen));
        }
        case 5121: { // UNSIGNED_BYTE
            return new Uint8Array(binData, byteOffset, totalElements);
        }
        case 5120: { // BYTE
            const bytes = new Int8Array(binData, byteOffset, totalElements);
            const result = new Uint8Array(totalElements);
            for (let i = 0; i < totalElements; i++) result[i] = bytes[i] < 0 ? 0 : bytes[i];
            return result;
        }
        default: {
            const byteLen = totalElements * 4;
            return new Float32Array(binData.slice(byteOffset, byteOffset + byteLen));
        }
    }
}

function concatUint16Arrays(arrays: Uint16Array[]): Uint16Array {
    let totalLen = 0;
    for (const a of arrays) totalLen += a.length;
    const result = new Uint16Array(totalLen);
    let offset = 0;
    for (const a of arrays) {
        result.set(a, offset);
        offset += a.length;
    }
    return result;
}

function concatFloat32Arrays(arrays: Float32Array[]): Float32Array {
    let totalLen = 0;
    for (const a of arrays) totalLen += a.length;
    const result = new Float32Array(totalLen);
    let offset = 0;
    for (const a of arrays) {
        result.set(a, offset);
        offset += a.length;
    }
    return result;
}
