import { Component } from '../component.js';
import { Vec3 } from '../../../core/math/vec3.js';

export interface TerrainLayer {
    name: string;
    color: number[];
    roughness: number;
    tilingScale: number;
}

/**
 * TerrainComponent generates a heightmap-based terrain mesh.
 *
 * Supports procedural generation, brush-based sculpting, terrain layers
 * for splatmap texturing, and bilinear height/normal queries.
 */
/** LOD ring configuration: distance ranges (in world units) and grid step sizes. */
const LOD_RINGS = [
    { innerSq: 0,           outerSq: 400 * 400,   step: 1 },
    { innerSq: 400 * 400,   outerSq: 700 * 700,   step: 2 },
    { innerSq: 700 * 700,   outerSq: 1500 * 1500, step: 4 },
    { innerSq: 1500 * 1500, outerSq: Infinity,     step: 8 },
];

export class TerrainComponent extends Component {
    width: number = 100;
    depth: number = 100;
    resolution: number = 64;
    heightScale: number = 10;
    heightData: Float32Array = new Float32Array(0);
    layers: TerrainLayer[] = [];
    splatmapData: Float32Array[] = [];

    // Runtime mesh data
    positions: Float32Array = new Float32Array(0);
    normals: Float32Array = new Float32Array(0);
    uvs: Float32Array = new Float32Array(0);
    indices: Uint32Array = new Uint32Array(0);
    meshDirty: boolean = true;

    gpuMesh: any = null;
    baseColor: number[] = [0.3, 0.55, 0.2, 1.0];
    metallic: number = 0.0;
    roughness: number = 0.85;

    // LOD state
    lodEnabled: boolean = false;
    lodCamLocalX: number = NaN;
    lodCamLocalZ: number = NaN;
    lodRebuildThreshold: number = 100;
    lodActiveVertexCount: number = 0;
    lodActiveIndexCount: number = 0;

    /**
     * Optional: world-space height value at which LOD simplification is
     * suppressed in a padded band. When set, any cell whose corners
     * straddle this height is forced to the finest (step=1) LOD ring, and
     * so are all cells within `preserveContourPadding` cells around it.
     * Useful for keeping coastlines (or any sharp iso-contour) crisp as
     * the mesh coarsens with distance. Leave unset to LOD-simplify
     * uniformly.
     */
    preserveContourLevel: number | undefined = undefined;
    preserveContourPadding: number = 3;

    initialize(data: Record<string, any>): void {
        this.width = data.width ?? 100;
        this.depth = data.depth ?? 100;
        this.resolution = Math.max(2, Math.min(data.resolution ?? 64, 1024));
        this.heightScale = data.heightScale ?? 10;
        this.baseColor = data.baseColor ?? [0.3, 0.55, 0.2, 1.0];
        this.metallic = data.metallic ?? 0.0;
        this.roughness = data.roughness ?? 0.85;
        this.preserveContourLevel = typeof data.preserveContourLevel === 'number'
            ? data.preserveContourLevel
            : undefined;
        this.preserveContourPadding = typeof data.preserveContourPadding === 'number'
            ? data.preserveContourPadding
            : 3;

        if (data.heightData instanceof Float32Array) {
            this.heightData = data.heightData;
        } else if (data.heightData && Array.isArray(data.heightData)) {
            this.heightData = new Float32Array(data.heightData);
        } else if (data.heightData && ArrayBuffer.isView(data.heightData)) {
            this.heightData = new Float32Array((data.heightData as Float32Array).buffer.slice(0));
        } else {
            this.heightData = new Float32Array(this.resolution * this.resolution);
        }

        if (Array.isArray(data.layers)) {
            this.layers = data.layers.map((l: any) => ({
                name: l.name ?? 'Layer',
                color: l.color ?? [0.3, 0.55, 0.2, 1.0],
                roughness: l.roughness ?? 0.85,
                tilingScale: l.tilingScale ?? 1.0,
            }));
        }

        if (Array.isArray(data.splatmapData)) {
            this.splatmapData = data.splatmapData.map((arr: any) =>
                new Float32Array(Array.isArray(arr) ? arr : [])
            );
        }

        this.meshDirty = true;
        this.generateMesh();
        this.markDirty();
    }

    /**
     * Generate terrain mesh from heightmap data.
     */
    generateMesh(): void {
        const res = this.resolution;
        const w = this.width;
        const d = this.depth;
        const vertCount = res * res;
        const triCount = (res - 1) * (res - 1) * 2;

        this.positions = new Float32Array(vertCount * 3);
        this.normals = new Float32Array(vertCount * 3);
        this.uvs = new Float32Array(vertCount * 2);
        this.indices = new Uint32Array(triCount * 3);

        if (this.heightData.length !== vertCount) {
            const newData = new Float32Array(vertCount);
            const copyLen = Math.min(this.heightData.length, vertCount);
            for (let i = 0; i < copyLen; i++) newData[i] = this.heightData[i];
            this.heightData = newData;
        }

        const halfW = w / 2;
        const halfD = d / 2;
        for (let z = 0; z < res; z++) {
            for (let x = 0; x < res; x++) {
                const idx = z * res + x;
                const fx = x / (res - 1);
                const fz = z / (res - 1);

                this.positions[idx * 3] = fx * w - halfW;
                this.positions[idx * 3 + 1] = this.heightData[idx] * this.heightScale;
                this.positions[idx * 3 + 2] = fz * d - halfD;

                this.uvs[idx * 2] = fx;
                this.uvs[idx * 2 + 1] = fz;
            }
        }

        let ii = 0;
        for (let z = 0; z < res - 1; z++) {
            for (let x = 0; x < res - 1; x++) {
                const topLeft = z * res + x;
                const topRight = topLeft + 1;
                const bottomLeft = (z + 1) * res + x;
                const bottomRight = bottomLeft + 1;

                this.indices[ii++] = topLeft;
                this.indices[ii++] = bottomLeft;
                this.indices[ii++] = topRight;

                this.indices[ii++] = topRight;
                this.indices[ii++] = bottomLeft;
                this.indices[ii++] = bottomRight;
            }
        }

        this.computeNormals();
        this.meshDirty = false;
    }

    /**
     * Check if an LOD rebuild is needed based on camera movement.
     * Returns true if the mesh was rebuilt.
     */
    updateLOD(camLocalX: number, camLocalZ: number): boolean {
        if (!this.lodEnabled) return false;
        const dx = camLocalX - this.lodCamLocalX;
        const dz = camLocalZ - this.lodCamLocalZ;
        if (!isNaN(this.lodCamLocalX) && dx * dx + dz * dz < this.lodRebuildThreshold * this.lodRebuildThreshold) {
            return false;
        }
        this.generateLODMesh(camLocalX, camLocalZ);
        return true;
    }

    /**
     * Generate a variable-density terrain mesh based on distance from camera.
     * Near the camera: full resolution. Far away: coarser grid.
     * Vertices at LOD boundaries are snapped to prevent T-junction cracks.
     */
    generateLODMesh(camLocalX: number, camLocalZ: number): void {
        const res = this.resolution;
        const w = this.width;
        const d = this.depth;
        const halfW = w / 2;
        const halfD = d / 2;
        const cellW = w / (res - 1);
        const cellD = d / (res - 1);

        // Convert camera local-space position to grid coordinates
        const camGX = (camLocalX + halfW) / w * (res - 1);
        const camGZ = (camLocalZ + halfD) / d * (res - 1);

        // Step 1: Assign a step size to each grid cell based on distance to camera.
        // cellStep[cz * (res-1) + cx] = step for cell (cx, cz).
        const cells = res - 1;
        const cellStep = new Uint8Array(cells * cells);

        for (let cz = 0; cz < cells; cz++) {
            const centerGZ = cz + 0.5;
            const dzG = centerGZ - camGZ;
            const dzW = dzG * cellD;
            const dzSq = dzW * dzW;
            for (let cx = 0; cx < cells; cx++) {
                const centerGX = cx + 0.5;
                const dxG = centerGX - camGX;
                const dxW = dxG * cellW;
                const distSq = dxW * dxW + dzSq;

                let step = LOD_RINGS[LOD_RINGS.length - 1].step;
                for (let r = 0; r < LOD_RINGS.length; r++) {
                    if (distSq < LOD_RINGS[r].outerSq) {
                        step = LOD_RINGS[r].step;
                        break;
                    }
                }
                cellStep[cz * cells + cx] = step;
            }
        }

        // Optional iso-contour protection: if preserveContourLevel is set,
        // force step=1 in a padded band around every cell whose corners
        // straddle that height. Keeps sharp visual features (typically a
        // water shoreline) crisp as the mesh coarsens with distance.
        if (this.preserveContourLevel !== undefined) {
            const contourLevel = this.preserveContourLevel;
            const pad = this.preserveContourPadding;
            const hd = this.heightData;
            const hs = this.heightScale;
            // Pass 1: find cells that straddle the contour
            const isAtContour = new Uint8Array(cells * cells);
            for (let cz = 0; cz < cells; cz++) {
                for (let cx = 0; cx < cells; cx++) {
                    const h00 = hd[cz * res + cx] * hs;
                    const h10 = hd[cz * res + cx + 1] * hs;
                    const h01 = hd[(cz + 1) * res + cx] * hs;
                    const h11 = hd[(cz + 1) * res + cx + 1] * hs;
                    const anyAbove = h00 > contourLevel || h10 > contourLevel || h01 > contourLevel || h11 > contourLevel;
                    const anyBelow = h00 <= contourLevel || h10 <= contourLevel || h01 <= contourLevel || h11 <= contourLevel;
                    if (anyAbove && anyBelow) isAtContour[cz * cells + cx] = 1;
                }
            }
            // Pass 2: dilate — force step 1 within `pad` cells of any contour cell
            for (let cz = 0; cz < cells; cz++) {
                for (let cx = 0; cx < cells; cx++) {
                    if (!isAtContour[cz * cells + cx]) continue;
                    const z0 = Math.max(0, cz - pad);
                    const z1 = Math.min(cells - 1, cz + pad);
                    const x0 = Math.max(0, cx - pad);
                    const x1 = Math.min(cells - 1, cx + pad);
                    for (let nz = z0; nz <= z1; nz++) {
                        for (let nx = x0; nx <= x1; nx++) {
                            cellStep[nz * cells + nx] = 1;
                        }
                    }
                }
            }
        }

        // Step 2: Emit quads. Process from coarsest to finest.
        // A coarse quad at (cx, cz) with step s covers cells [cx..cx+s-1, cz..cz+s-1].
        // It is emitted only if all those cells have step >= s (i.e., the coarse quad "owns" them).
        // Finer quads are emitted afterwards and naturally overwrite.
        //
        // Simpler approach: mark which cells are "covered" by an emitted quad.
        const covered = new Uint8Array(cells * cells);

        // Sort ring steps from coarsest to finest
        const steps = [...new Set(LOD_RINGS.map(r => r.step))].sort((a, b) => b - a);

        const vertexMap = new Map<number, number>(); // gridKey -> vertex index
        let vertCount = 0;
        let idxCount = 0;

        // Pre-allocate working arrays at max possible size (full res)
        const maxVerts = res * res;
        const maxIndices = (res - 1) * (res - 1) * 6;
        if (this.positions.length < maxVerts * 3) {
            this.positions = new Float32Array(maxVerts * 3);
            this.normals = new Float32Array(maxVerts * 3);
            this.uvs = new Float32Array(maxVerts * 2);
            this.indices = new Uint32Array(maxIndices);
        }

        const positions = this.positions;
        const uvs = this.uvs;
        const indices = this.indices;
        const heightData = this.heightData;
        const heightScale = this.heightScale;

        // Helper: get or create a vertex at grid position (gx, gz), with boundary snapping
        const getVertex = (gx: number, gz: number): number => {
            const key = gz * res + gx;
            const existing = vertexMap.get(key);
            if (existing !== undefined) return existing;

            // Determine if this vertex needs snapping (lies on boundary with coarser ring)
            let posX = gx / (res - 1) * w - halfW;
            let posZ = gz / (res - 1) * d - halfD;
            let posY = heightData[gz * res + gx] * heightScale;

            // Check neighboring cells for coarser step — snap if needed
            const myStep = getVertexStep(gx, gz);
            let snapStepX = 0;
            let snapStepZ = 0;

            // Check X neighbors
            if (gx > 0 && gx < cells) {
                const leftStep = cellStep[(Math.min(gz, cells - 1)) * cells + (gx - 1)];
                const rightStep = cellStep[(Math.min(gz, cells - 1)) * cells + gx];
                const neighborStep = Math.max(leftStep, rightStep);
                if (neighborStep > myStep && gx % neighborStep !== 0) {
                    snapStepX = neighborStep;
                }
            }
            if (gz > 0 && gz < cells) {
                const topStep = cellStep[(gz - 1) * cells + Math.min(gx, cells - 1)];
                const botStep = cellStep[gz * cells + Math.min(gx, cells - 1)];
                const neighborStep = Math.max(topStep, botStep);
                if (neighborStep > myStep && gz % neighborStep !== 0) {
                    snapStepZ = neighborStep;
                }
            }

            if (snapStepX > 0) {
                const gxLo = Math.floor(gx / snapStepX) * snapStepX;
                const gxHi = Math.min(gxLo + snapStepX, res - 1);
                const t = gxHi > gxLo ? (gx - gxLo) / (gxHi - gxLo) : 0;
                const hLo = heightData[gz * res + gxLo] * heightScale;
                const hHi = heightData[gz * res + gxHi] * heightScale;
                posY = hLo + (hHi - hLo) * t;
                posX = (gxLo / (res - 1) * w - halfW) + ((gxHi / (res - 1) * w - halfW) - (gxLo / (res - 1) * w - halfW)) * t;
            }
            if (snapStepZ > 0) {
                const gzLo = Math.floor(gz / snapStepZ) * snapStepZ;
                const gzHi = Math.min(gzLo + snapStepZ, res - 1);
                const t = gzHi > gzLo ? (gz - gzLo) / (gzHi - gzLo) : 0;
                const hLo = heightData[gzLo * res + gx] * heightScale;
                const hHi = heightData[gzHi * res + gx] * heightScale;
                if (snapStepX > 0) {
                    // Both X and Z snapped — bilinear interpolation from 4 coarse corners
                    const gxLo = Math.floor(gx / snapStepX) * snapStepX;
                    const gxHi = Math.min(gxLo + snapStepX, res - 1);
                    const tx = gxHi > gxLo ? (gx - gxLo) / (gxHi - gxLo) : 0;
                    const h00 = heightData[gzLo * res + gxLo] * heightScale;
                    const h10 = heightData[gzLo * res + gxHi] * heightScale;
                    const h01 = heightData[gzHi * res + gxLo] * heightScale;
                    const h11 = heightData[gzHi * res + gxHi] * heightScale;
                    posY = h00 * (1 - tx) * (1 - t) + h10 * tx * (1 - t) + h01 * (1 - tx) * t + h11 * tx * t;
                } else {
                    posY = hLo + (hHi - hLo) * t;
                }
                posZ = (gzLo / (res - 1) * d - halfD) + ((gzHi / (res - 1) * d - halfD) - (gzLo / (res - 1) * d - halfD)) * t;
            }

            const vi = vertCount++;
            positions[vi * 3] = posX;
            positions[vi * 3 + 1] = posY;
            positions[vi * 3 + 2] = posZ;
            uvs[vi * 2] = gx / (res - 1);
            uvs[vi * 2 + 1] = gz / (res - 1);
            vertexMap.set(key, vi);
            return vi;
        };

        // Helper: determine the finest step that uses this vertex
        const getVertexStep = (gx: number, gz: number): number => {
            let minStep = 255;
            // Check the up-to-4 cells that share this vertex
            if (gx > 0 && gz > 0) minStep = Math.min(minStep, cellStep[(gz - 1) * cells + (gx - 1)]);
            if (gx < cells && gz > 0) minStep = Math.min(minStep, cellStep[(gz - 1) * cells + gx]);
            if (gx > 0 && gz < cells) minStep = Math.min(minStep, cellStep[gz * cells + (gx - 1)]);
            if (gx < cells && gz < cells) minStep = Math.min(minStep, cellStep[gz * cells + gx]);
            return minStep;
        };

        // Step 3: Emit quads for each step level (coarsest first, finest last).
        for (const step of steps) {
            for (let cz = 0; cz <= cells - step; cz += step) {
                for (let cx = 0; cx <= cells - step; cx += step) {
                    // Check if any cell in this quad block has this step assigned
                    let owns = true;
                    for (let dz = 0; dz < step && owns; dz++) {
                        for (let dx = 0; dx < step && owns; dx++) {
                            if (covered[(cz + dz) * cells + (cx + dx)]) { owns = false; }
                        }
                    }
                    if (!owns) continue;

                    // Check if the minimum step among cells in this block matches
                    let minCellStep = 255;
                    for (let dz = 0; dz < step; dz++) {
                        for (let dx = 0; dx < step; dx++) {
                            minCellStep = Math.min(minCellStep, cellStep[(cz + dz) * cells + (cx + dx)]);
                        }
                    }
                    if (minCellStep !== step) continue;

                    // Mark cells as covered
                    for (let dz = 0; dz < step; dz++) {
                        for (let dx = 0; dx < step; dx++) {
                            covered[(cz + dz) * cells + (cx + dx)] = 1;
                        }
                    }

                    // Emit quad: 2 triangles
                    const tl = getVertex(cx, cz);
                    const tr = getVertex(cx + step, cz);
                    const bl = getVertex(cx, cz + step);
                    const br = getVertex(cx + step, cz + step);

                    indices[idxCount++] = tl;
                    indices[idxCount++] = bl;
                    indices[idxCount++] = tr;
                    indices[idxCount++] = tr;
                    indices[idxCount++] = bl;
                    indices[idxCount++] = br;
                }
            }
        }

        // Step 4: Fill any remaining uncovered cells with fallback quads (step=1 each)
        for (let cz = 0; cz < cells; cz++) {
            for (let cx = 0; cx < cells; cx++) {
                if (covered[cz * cells + cx]) continue;
                const tl = getVertex(cx, cz);
                const tr = getVertex(cx + 1, cz);
                const bl = getVertex(cx, cz + 1);
                const br = getVertex(cx + 1, cz + 1);
                indices[idxCount++] = tl;
                indices[idxCount++] = bl;
                indices[idxCount++] = tr;
                indices[idxCount++] = tr;
                indices[idxCount++] = bl;
                indices[idxCount++] = br;
            }
        }

        // Step 5: Compute normals
        this.normals.fill(0, 0, vertCount * 3);
        for (let i = 0; i < idxCount; i += 3) {
            const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
            const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
            const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
            const cx2 = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz2 = positions[i2 * 3 + 2];
            const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
            const e2x = cx2 - ax, e2y = cy - ay, e2z = cz2 - az;
            const nx = e1y * e2z - e1z * e2y;
            const ny = e1z * e2x - e1x * e2z;
            const nz = e1x * e2y - e1y * e2x;
            this.normals[i0 * 3] += nx; this.normals[i0 * 3 + 1] += ny; this.normals[i0 * 3 + 2] += nz;
            this.normals[i1 * 3] += nx; this.normals[i1 * 3 + 1] += ny; this.normals[i1 * 3 + 2] += nz;
            this.normals[i2 * 3] += nx; this.normals[i2 * 3 + 1] += ny; this.normals[i2 * 3 + 2] += nz;
        }
        for (let i = 0; i < vertCount; i++) {
            const x = this.normals[i * 3], y = this.normals[i * 3 + 1], z = this.normals[i * 3 + 2];
            const len = Math.sqrt(x * x + y * y + z * z);
            if (len > 0.0001) {
                this.normals[i * 3] /= len; this.normals[i * 3 + 1] /= len; this.normals[i * 3 + 2] /= len;
            } else {
                this.normals[i * 3] = 0; this.normals[i * 3 + 1] = 1; this.normals[i * 3 + 2] = 0;
            }
        }

        this.lodCamLocalX = camLocalX;
        this.lodCamLocalZ = camLocalZ;
        this.lodActiveVertexCount = vertCount;
        this.lodActiveIndexCount = idxCount;
        this.meshDirty = false;
        this.markDirty();
    }

    /**
     * Get height at a world-space (x, z) position using bilinear interpolation.
     */
    getHeightAt(worldX: number, worldZ: number): number {
        const halfW = this.width / 2;
        const halfD = this.depth / 2;

        const fx = (worldX + halfW) / this.width;
        const fz = (worldZ + halfD) / this.depth;

        if (fx < 0 || fx > 1 || fz < 0 || fz > 1) return 0;

        const res = this.resolution;
        const gx = fx * (res - 1);
        const gz = fz * (res - 1);

        const ix = Math.floor(gx);
        const iz = Math.floor(gz);
        const tx = gx - ix;
        const tz = gz - iz;

        const ix1 = Math.min(ix + 1, res - 1);
        const iz1 = Math.min(iz + 1, res - 1);

        const h00 = this.heightData[iz * res + ix];
        const h10 = this.heightData[iz * res + ix1];
        const h01 = this.heightData[iz1 * res + ix];
        const h11 = this.heightData[iz1 * res + ix1];

        const h = h00 * (1 - tx) * (1 - tz) +
            h10 * tx * (1 - tz) +
            h01 * (1 - tx) * tz +
            h11 * tx * tz;

        return h * this.heightScale;
    }

    /**
     * Get normal at a world-space (x, z) position via central differences.
     */
    getNormalAt(worldX: number, worldZ: number): Vec3 {
        const eps = this.width / (this.resolution - 1) * 0.5;
        const hL = this.getHeightAt(worldX - eps, worldZ);
        const hR = this.getHeightAt(worldX + eps, worldZ);
        const hD = this.getHeightAt(worldX, worldZ - eps);
        const hU = this.getHeightAt(worldX, worldZ + eps);

        const nx = hL - hR;
        const nz = hD - hU;
        const ny = 2 * eps;

        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        return new Vec3(nx / len, ny / len, nz / len);
    }

    setHeightAtGrid(gridX: number, gridZ: number, height: number): void {
        if (gridX < 0 || gridX >= this.resolution || gridZ < 0 || gridZ >= this.resolution) return;
        this.heightData[gridZ * this.resolution + gridX] = height;
        this.meshDirty = true;
    }

    applyBrush(worldX: number, worldZ: number, radius: number, strength: number, mode: 'raise' | 'lower' | 'smooth' | 'flatten'): void {
        const halfW = this.width / 2;
        const res = this.resolution;
        const cellW = this.width / (res - 1);

        const centerGX = ((worldX + halfW) / this.width) * (res - 1);
        const centerGZ = ((worldZ + this.depth / 2) / this.depth) * (res - 1);
        const gridRadius = radius / cellW;

        const minX = Math.max(0, Math.floor(centerGX - gridRadius));
        const maxX = Math.min(res - 1, Math.ceil(centerGX + gridRadius));
        const minZ = Math.max(0, Math.floor(centerGZ - gridRadius));
        const maxZ = Math.min(res - 1, Math.ceil(centerGZ + gridRadius));

        let flattenHeight = 0;
        if (mode === 'flatten') {
            flattenHeight = this.getHeightAt(worldX, worldZ) / this.heightScale;
        }

        for (let gz = minZ; gz <= maxZ; gz++) {
            for (let gx = minX; gx <= maxX; gx++) {
                const dx = gx - centerGX;
                const dz = gz - centerGZ;
                const dist = Math.sqrt(dx * dx + dz * dz);
                if (dist > gridRadius) continue;

                const falloff = 1.0 - (dist / gridRadius);
                const idx = gz * res + gx;

                switch (mode) {
                    case 'raise':
                        this.heightData[idx] += strength * falloff;
                        break;
                    case 'lower':
                        this.heightData[idx] -= strength * falloff;
                        break;
                    case 'smooth': {
                        let sum = 0;
                        let count = 0;
                        for (let nz = -1; nz <= 1; nz++) {
                            for (let nx = -1; nx <= 1; nx++) {
                                const ngx = gx + nx;
                                const ngz = gz + nz;
                                if (ngx >= 0 && ngx < res && ngz >= 0 && ngz < res) {
                                    sum += this.heightData[ngz * res + ngx];
                                    count++;
                                }
                            }
                        }
                        this.heightData[idx] += (sum / count - this.heightData[idx]) * strength * falloff;
                        break;
                    }
                    case 'flatten':
                        this.heightData[idx] += (flattenHeight - this.heightData[idx]) * strength * falloff;
                        break;
                }
            }
        }

        this.meshDirty = true;
    }

    /**
     * Generate procedural terrain using multi-octave noise.
     */
    generateProcedural(roughness: number = 0.5, seed: number = 42): void {
        const size = this.resolution;
        const data = this.heightData;
        data.fill(0);

        const rng = this.seededRandom(seed);
        const octaves = 6;

        for (let o = 0; o < octaves; o++) {
            const freq = Math.pow(2, o) * 2;
            const amp = Math.pow(roughness, o);
            const phaseX = rng() * 1000;
            const phaseZ = rng() * 1000;

            for (let z = 0; z < size; z++) {
                for (let x = 0; x < size; x++) {
                    const fx = x / (size - 1);
                    const fz = z / (size - 1);
                    const val = Math.sin(fx * freq * Math.PI + phaseX) *
                        Math.cos(fz * freq * Math.PI + phaseZ) * amp;
                    data[z * size + x] += val * 0.5 + 0.25 * amp;
                }
            }
        }

        // Normalize to 0..1
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < data.length; i++) {
            if (data[i] < min) min = data[i];
            if (data[i] > max) max = data[i];
        }
        const range = max - min || 1;
        for (let i = 0; i < data.length; i++) {
            data[i] = (data[i] - min) / range;
        }

        this.meshDirty = true;
        this.generateMesh();
        this.markDirty();
    }

    onDestroy(): void {
        this.gpuMesh = null;
        this.heightData = new Float32Array(0);
        this.positions = new Float32Array(0);
        this.normals = new Float32Array(0);
        this.uvs = new Float32Array(0);
        this.indices = new Uint32Array(0);
    }

    toJSON(): Record<string, any> {
        return {
            width: this.width,
            depth: this.depth,
            resolution: this.resolution,
            heightScale: this.heightScale,
            heightData: Array.from(this.heightData),
            baseColor: this.baseColor,
            metallic: this.metallic,
            roughness: this.roughness,
            layers: this.layers,
        };
    }

    // -- Private helpers ------------------------------------------------------

    private computeNormals(): void {
        const normals = this.normals;
        normals.fill(0);

        const positions = this.positions;
        const indices = this.indices;

        for (let i = 0; i < indices.length; i += 3) {
            const i0 = indices[i];
            const i1 = indices[i + 1];
            const i2 = indices[i + 2];

            const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
            const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
            const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];

            const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
            const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

            const nx = e1y * e2z - e1z * e2y;
            const ny = e1z * e2x - e1x * e2z;
            const nz = e1x * e2y - e1y * e2x;

            normals[i0 * 3] += nx; normals[i0 * 3 + 1] += ny; normals[i0 * 3 + 2] += nz;
            normals[i1 * 3] += nx; normals[i1 * 3 + 1] += ny; normals[i1 * 3 + 2] += nz;
            normals[i2 * 3] += nx; normals[i2 * 3 + 1] += ny; normals[i2 * 3 + 2] += nz;
        }

        for (let i = 0; i < normals.length; i += 3) {
            const x = normals[i], y = normals[i + 1], z = normals[i + 2];
            const len = Math.sqrt(x * x + y * y + z * z);
            if (len > 0.0001) {
                normals[i] /= len;
                normals[i + 1] /= len;
                normals[i + 2] /= len;
            } else {
                normals[i] = 0;
                normals[i + 1] = 1;
                normals[i + 2] = 0;
            }
        }
    }

    private seededRandom(seed: number): () => number {
        let s = seed;
        return () => {
            s = (s * 16807) % 2147483647;
            return s / 2147483647;
        };
    }
}
