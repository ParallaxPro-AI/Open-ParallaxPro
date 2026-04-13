/**
 * road_atlas.ts — Dual-resolution chunked road atlas.
 *
 * Rasterizes road + sidewalk polylines per chunk into two RGBA8 atlases
 * that the terrain shader samples to overlay asphalt and sidewalk bands:
 *
 *   R = road coverage         (0 outside, 1 on road)
 *   G = distance from center  (normalized by halfW, used for lane markings)
 *   B = sidewalk coverage     (0 outside, 1 on sidewalk)
 *   A = sidewalk edge distance (for curb / gutter detail)
 *
 *   - Near: 8192² atlas, 512² tiles, 16×16 grid (~0.5 m / pixel).
 *           Populated only for chunks within the "near" ring.
 *   - Far:  8192² atlas, 128² tiles, 64×64 grid (~2 m / pixel).
 *           Populated for every loaded chunk.
 *
 * Generic: takes placements `{ type, points, width, subtype }` and a
 * `sidewalkWidths` map keyed by subtype. Games drive chunk (un)load
 * and the camera→chunk "is near?" decision.
 */

const NEAR_ATLAS_SIZE = 8192;
const NEAR_TILE_SIZE = 512;
const NEAR_GRID = NEAR_ATLAS_SIZE / NEAR_TILE_SIZE; // 16

const FAR_ATLAS_SIZE = 8192;
const FAR_TILE_SIZE = 128;
const FAR_GRID = FAR_ATLAS_SIZE / FAR_TILE_SIZE; // 64

export const NEAR_GRID_DIM = NEAR_GRID;
export const FAR_GRID_DIM = FAR_GRID;

export interface RoadAtlasPlacement {
    type: string; // 'road' | 'railway' | ...
    points?: number[][]; // [[x, y, z], ...]
    width?: number;
    subtype?: string;
}

export class RoadAtlas {
    private device: GPUDevice;
    private sidewalkWidths: Record<string, number>;
    readonly nearTexture: GPUTexture;
    readonly farTexture: GPUTexture;
    private nearBuffer = new Uint8Array(NEAR_TILE_SIZE * NEAR_TILE_SIZE * 4);
    private farBuffer = new Uint8Array(FAR_TILE_SIZE * FAR_TILE_SIZE * 4);

    constructor(device: GPUDevice, sidewalkWidths: Record<string, number> = {}) {
        this.device = device;
        this.sidewalkWidths = sidewalkWidths;
        this.nearTexture = device.createTexture({
            label: 'road_atlas_near',
            size: { width: NEAR_ATLAS_SIZE, height: NEAR_ATLAS_SIZE },
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.farTexture = device.createTexture({
            label: 'road_atlas_far',
            size: { width: FAR_ATLAS_SIZE, height: FAR_ATLAS_SIZE },
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
    }

    /** Rasterize a chunk's placements into the atlas. Call when a chunk loads
     * or when its near/far status changes. */
    updateTile(cx: number, cz: number, placements: RoadAtlasPlacement[], chunkSize: number, isNear: boolean): void {
        const chunkMinX = cx * chunkSize;
        const chunkMinZ = cz * chunkSize;
        this.rasterizeAndUpload(placements, chunkMinX, chunkMinZ, chunkSize,
            this.farBuffer, FAR_TILE_SIZE, this.farTexture, FAR_GRID, cx, cz);
        if (isNear) {
            this.rasterizeAndUpload(placements, chunkMinX, chunkMinZ, chunkSize,
                this.nearBuffer, NEAR_TILE_SIZE, this.nearTexture, NEAR_GRID, cx, cz);
        }
    }

    /** Zero the tile for a chunk when it unloads. */
    clearTile(cx: number, cz: number, wasNear: boolean): void {
        this.clearAtlasTile(this.farTexture, FAR_TILE_SIZE, FAR_GRID, cx, cz);
        if (wasNear) this.clearAtlasTile(this.nearTexture, NEAR_TILE_SIZE, NEAR_GRID, cx, cz);
    }

    destroy(): void {
        this.nearTexture.destroy();
        this.farTexture.destroy();
    }

    private rasterizeAndUpload(
        placements: RoadAtlasPlacement[], chunkMinX: number, chunkMinZ: number, chunkSize: number,
        buf: Uint8Array, tileSize: number, texture: GPUTexture, gridDim: number,
        cx: number, cz: number,
    ): void {
        const pixelSize = chunkSize / tileSize;
        const numPixels = tileSize * tileSize;
        buf.fill(0);
        // Track how many distinct roads touch each pixel to detect intersections
        const hitCount = new Uint8Array(numPixels);

        // ── Pass 1: rasterize road pavement (R + G) for every segment.
        // Must happen for ALL roads before any sidewalk write, so pass 2 can
        // see full pavement coverage and avoid bleeding a sidewalk band from
        // road A across road B's pavement at an intersection.
        for (const p of placements) {
            if (p.type !== 'road' && p.type !== 'railway') continue;
            const pts = p.points;
            if (!pts || pts.length < 2) continue;
            const halfW = (p.width || 6) / 2;
            const sidewalkW = this.sidewalkWidths[p.subtype ?? ''] ?? 0;
            const expandPx = (halfW + sidewalkW) / pixelSize + 1;

            for (let i = 0; i < pts.length - 1; i++) {
                const x0 = pts[i][0], z0 = pts[i][2];
                const x1 = pts[i + 1][0], z1 = pts[i + 1][2];
                const ldx = x1 - x0, ldz = z1 - z0;
                const segLenSq = ldx * ldx + ldz * ldz;
                if (segLenSq < 0.01) continue;

                const { minPx, maxPx, minPy, maxPy } = this.segmentTileBounds(
                    x0, z0, x1, z1, chunkMinX, chunkMinZ, pixelSize, tileSize, expandPx);

                for (let py = minPy; py <= maxPy; py++) {
                    const wz = chunkMinZ + (py + 0.5) * pixelSize;
                    for (let px = minPx; px <= maxPx; px++) {
                        const wx = chunkMinX + (px + 0.5) * pixelSize;
                        const dx = wx - x0, dz = wz - z0;
                        const tRaw = (dx * ldx + dz * ldz) / segLenSq;
                        const t = tRaw < 0 ? 0 : (tRaw > 1 ? 1 : tRaw);
                        const closestX = x0 + t * ldx, closestZ = z0 + t * ldz;
                        const dist = Math.sqrt((wx - closestX) ** 2 + (wz - closestZ) ** 2);

                        const edgeDist = dist - halfW;
                        const cov = 1.0 - Math.max(0, Math.min(1, (edgeDist + pixelSize * 0.5) / pixelSize));
                        if (cov <= 0) continue;

                        const pIdx = py * tileSize + px;
                        const idx = pIdx * 4;
                        const covU8 = Math.min(255, Math.round(cov * 255));
                        if (covU8 > buf[idx]) {
                            buf[idx]     = covU8;
                            buf[idx + 1] = Math.min(255, Math.round((dist / halfW) * 255));
                        }
                        if (cov > 0.5) hitCount[pIdx] = Math.min(255, hitCount[pIdx] + 1);
                    }
                }
            }
        }

        // Intersection suppression: center-distance → mid-road at any pixel
        // touched by more than one road. Prevents lane-marking artifacts
        // through intersections.
        for (let i = 0; i < numPixels; i++) {
            if (hitCount[i] > 1) buf[i * 4 + 1] = 128;
        }

        // ── Pass 2: rasterize sidewalks (B + A). Writes are skipped where
        // pavement from any road already covers the pixel — this is what
        // eliminates the sidewalk-over-asphalt overlap at intersections.
        // PAVEMENT_MASK is chosen high enough to let anti-aliased asphalt
        // edges still show a thin sidewalk strip along the curb.
        const PAVEMENT_MASK = 128; // ~0.5 coverage
        for (const p of placements) {
            if (p.type !== 'road' && p.type !== 'railway') continue;
            const sidewalkW = this.sidewalkWidths[p.subtype ?? ''] ?? 0;
            if (sidewalkW <= 0) continue;
            const pts = p.points;
            if (!pts || pts.length < 2) continue;
            const halfW = (p.width || 6) / 2;
            const outerEdge = halfW + sidewalkW;
            const expandPx = outerEdge / pixelSize + 1;

            for (let i = 0; i < pts.length - 1; i++) {
                const x0 = pts[i][0], z0 = pts[i][2];
                const x1 = pts[i + 1][0], z1 = pts[i + 1][2];
                const ldx = x1 - x0, ldz = z1 - z0;
                const segLenSq = ldx * ldx + ldz * ldz;
                if (segLenSq < 0.01) continue;

                const { minPx, maxPx, minPy, maxPy } = this.segmentTileBounds(
                    x0, z0, x1, z1, chunkMinX, chunkMinZ, pixelSize, tileSize, expandPx);

                for (let py = minPy; py <= maxPy; py++) {
                    const wz = chunkMinZ + (py + 0.5) * pixelSize;
                    for (let px = minPx; px <= maxPx; px++) {
                        const wx = chunkMinX + (px + 0.5) * pixelSize;
                        const dx = wx - x0, dz = wz - z0;
                        const tRaw = (dx * ldx + dz * ldz) / segLenSq;
                        // Body-only: skip the rounded donut bands that would
                        // otherwise leave sidewalk circles at segment vertices.
                        if (tRaw < -0.01 || tRaw > 1.01) continue;

                        const t = tRaw < 0 ? 0 : (tRaw > 1 ? 1 : tRaw);
                        const closestX = x0 + t * ldx, closestZ = z0 + t * ldz;
                        const perpDist = Math.sqrt((wx - closestX) ** 2 + (wz - closestZ) ** 2);

                        const swOuterDist = perpDist - outerEdge;
                        const swCov = 1.0 - Math.max(0, Math.min(1, (swOuterDist + pixelSize * 0.5) / pixelSize));
                        const roadMask = Math.max(0, Math.min(1, (perpDist - halfW - pixelSize * 0.5) / pixelSize));
                        const finalSwCov = swCov * roadMask;
                        if (finalSwCov <= 0) continue;

                        const idx = (py * tileSize + px) * 4;
                        // Any road's pavement here → no sidewalk. This is the
                        // cross-road intersection fix.
                        if (buf[idx] >= PAVEMENT_MASK) continue;

                        const swCovU8 = Math.min(255, Math.round(finalSwCov * 255));
                        if (swCovU8 > buf[idx + 2]) {
                            buf[idx + 2] = swCovU8;
                            const innerDist = Math.max(0, Math.min(1, (outerEdge - perpDist) / sidewalkW));
                            buf[idx + 3] = Math.min(255, Math.round(innerDist * 255));
                        }
                    }
                }
            }
        }

        const tileX = ((cx % gridDim) + gridDim) % gridDim;
        const tileZ = ((cz % gridDim) + gridDim) % gridDim;
        this.device.queue.writeTexture(
            { texture, origin: { x: tileX * tileSize, y: tileZ * tileSize } },
            buf.buffer,
            { bytesPerRow: tileSize * 4 },
            { width: tileSize, height: tileSize },
        );
    }

    /** Pixel-space AABB of a segment expanded by `expandPx` (in pixels),
     * clamped to the tile. Used to bound the inner rasterization loop. */
    private segmentTileBounds(
        x0: number, z0: number, x1: number, z1: number,
        chunkMinX: number, chunkMinZ: number,
        pixelSize: number, tileSize: number, expandPx: number,
    ): { minPx: number; maxPx: number; minPy: number; maxPy: number } {
        const fpx0 = (x0 - chunkMinX) / pixelSize;
        const fpy0 = (z0 - chunkMinZ) / pixelSize;
        const fpx1 = (x1 - chunkMinX) / pixelSize;
        const fpy1 = (z1 - chunkMinZ) / pixelSize;
        return {
            minPx: Math.max(0, Math.floor(Math.min(fpx0, fpx1) - expandPx)),
            maxPx: Math.min(tileSize - 1, Math.ceil(Math.max(fpx0, fpx1) + expandPx)),
            minPy: Math.max(0, Math.floor(Math.min(fpy0, fpy1) - expandPx)),
            maxPy: Math.min(tileSize - 1, Math.ceil(Math.max(fpy0, fpy1) + expandPx)),
        };
    }

    private clearAtlasTile(texture: GPUTexture, tileSize: number, gridDim: number, cx: number, cz: number): void {
        const tileX = ((cx % gridDim) + gridDim) % gridDim;
        const tileZ = ((cz % gridDim) + gridDim) % gridDim;
        const zeros = new Uint8Array(tileSize * tileSize * 4);
        this.device.queue.writeTexture(
            { texture, origin: { x: tileX * tileSize, y: tileZ * tileSize } },
            zeros,
            { bytesPerRow: tileSize * 4 },
            { width: tileSize, height: tileSize },
        );
    }
}
