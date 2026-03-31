/**
 * Minimal GLB (Binary glTF 2.0) parser.
 * Extracts positions, normals, uvs, and indices from all mesh primitives.
 * Returns data suitable for uploading to the GPU.
 */

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
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch GLB: ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    return parseGLB(buffer, url);
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
