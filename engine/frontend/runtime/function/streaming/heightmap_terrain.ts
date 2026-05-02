/**
 * heightmap_terrain.ts — Async-loaded world-scale heightmap terrain.
 *
 * Fetches a meta JSON + raw float32 binary from a configured URL,
 * resamples the heightmap to a size the LOD mesh can handle, and spawns
 * a TerrainComponent entity covering the full world. Call
 * `update(camPos)` each frame to drive ring-based LOD simplification.
 *
 * Games bake a heightmap into
 * `{ width, height, worldWidth, worldDepth, heightmapFile, origin }`
 * and point this class at the meta URL. After ground textures load, call
 * `applyTerrainTextures()` to switch from generic PBR to the dedicated
 * terrain shader pipeline.
 */

import { Scene } from '../framework/scene.js';
import { TerrainComponent, TerrainGpuTextures } from '../framework/components/terrain_component.js';

export interface HeightmapTerrainConfig {
    /** URL of the heightmap meta JSON. The binary is resolved relative
     * to this URL via `meta.heightmapFile`. */
    metaUrl?: string;

    /** Optional terrain base color (RGBA 0..1). Used before textures load. */
    baseColor?: [number, number, number, number];

    /** Optional: world-space Y threshold. Terrain pixels at or below
     * this elevation render as water (waves, Fresnel, sun glints) via
     * the terrain shader's built-in per-pixel water path. Also used as
     * the LOD contour-lock level to keep the shoreline crisp. */
    waterLevel?: number;

    /** Inline terrain: flat mesh, no external heightmap file needed.
     *  When set, metaUrl is ignored and a flat terrain of the given
     *  world-space dimensions is generated directly. */
    inline?: {
        worldWidth: number;
        worldDepth: number;
        resolution?: number;
    };
}

/**
 * Shape of the heightmap meta JSON emitted by the preprocess script.
 * Nothing in this file or the TerrainComponent cares where the
 * numbers came from; the meta is purely a description of geometry.
 */
interface HeightmapMeta {
    /** Heightmap grid dimensions (samples). */
    width: number;
    height: number;
    /** World-space extent in meters (full heightmap including any padding). */
    worldWidth: number;
    worldDepth: number;
    /** Path to the raw float32 heightmap, relative to the meta URL. */
    heightmapFile: string;
    /** World-space position of the heightmap's NW corner. Defaults to (0, 0). */
    origin?: { x: number; z: number };
    /** Optional: when the heightmap has real content only within a sub-region
     * (e.g. an OSM bounding box surrounded by extrapolated padding), these
     * give that sub-region's extent. Used for weight-map / decal UVs that
     * only cover the real content. Defaults to worldWidth/worldDepth. */
    contentWidth?: number;
    contentDepth?: number;
}

/** Cap the LOD grid at this many samples per axis. Keeps the working
 * vertex budget bounded even for large source heightmaps. */
const MAX_LOD_RESOLUTION = 1024;

export class HeightmapTerrain {
    private scene: Scene;
    private config: HeightmapTerrainConfig;
    private parentId = -1;
    private _ready = false;
    private terrainEntityId = -1;

    // Cached geometry so getWorldHeight / update don't need to look at the
    // entity each call.
    private heightData: Float32Array | null = null;
    private res = 0;
    private centerX = 0;
    private centerZ = 0;

    /** Full heightmap extent in meters (= world size including any padding). */
    worldWidth = 0;
    worldDepth = 0;
    /** World-space NW corner of the heightmap. The OSM content is pinned at
     * (0, 0) by convention, so this is typically negative. */
    originX = 0;
    originZ = 0;
    /** Width of the "real content" sub-region in meters (OSM bounds etc.).
     * Callers can use this to size masks / decals that only cover the
     * non-padded region. Defaults to the full heightmap width. */
    contentWidth = 0;
    /** Depth of the "real content" sub-region in meters. See `contentWidth`. */
    contentDepth = 0;

    onReady: (() => void) | null = null;

    get ready(): boolean { return this._ready; }

    constructor(scene: Scene, config: HeightmapTerrainConfig) {
        this.scene = scene;
        this.config = config;
        const parent = scene.createEntity('HeightmapTerrain');
        parent.addTag('heightmap_terrain_root');
        this.parentId = parent.id;
        this.init();
    }

    /** Drive terrain LOD each frame from the active camera's world position. */
    update(camPos: { x: number; y: number; z: number }): void {
        if (this.terrainEntityId < 0) return;
        const entity = this.scene.entities.get(this.terrainEntityId);
        if (!entity) return;
        const terrain = entity.getComponent('TerrainComponent') as TerrainComponent | null;
        if (!terrain || !terrain.lodEnabled) return;
        terrain.updateLOD(camPos.x - this.centerX, camPos.z - this.centerZ);
    }

    /**
     * Attach GPU terrain textures to activate the dedicated terrain shader pipeline.
     * Call this once ground texture arrays, road atlases, and the weight map are loaded.
     */
    applyTerrainTextures(
        textures: TerrainGpuTextures,
        roadAtlasNear?: GPUTexture,
        roadAtlasFar?: GPUTexture,
    ): void {
        if (this.terrainEntityId < 0) return;
        const entity = this.scene.entities.get(this.terrainEntityId);
        if (!entity) return;
        const terrain = entity.getComponent('TerrainComponent') as TerrainComponent | null;
        if (!terrain) return;
        terrain.gpuTerrainTextures = textures;
        terrain.gpuRoadAtlasNear = roadAtlasNear;
        terrain.gpuRoadAtlasFar = roadAtlasFar;
    }

    /** Bilinear height lookup in world coords. Returns 0 outside the heightmap. */
    getWorldHeight(wx: number, wz: number): number {
        const data = this.heightData;
        if (!data) return 0;
        const localX = wx - this.centerX + this.worldWidth / 2;
        const localZ = wz - this.centerZ + this.worldDepth / 2;
        const fx = localX / this.worldWidth;
        const fz = localZ / this.worldDepth;
        if (fx < 0 || fx > 1 || fz < 0 || fz > 1) return 0;
        const res = this.res;
        const gx = fx * (res - 1);
        const gz = fz * (res - 1);
        const ix = Math.floor(gx), iz = Math.floor(gz);
        const tx = gx - ix, tz = gz - iz;
        const ix1 = Math.min(ix + 1, res - 1);
        const iz1 = Math.min(iz + 1, res - 1);
        const h00 = data[iz * res + ix];
        const h10 = data[iz * res + ix1];
        const h01 = data[iz1 * res + ix];
        const h11 = data[iz1 * res + ix1];

        // Match the TerrainComponent LOD mesh triangle split exactly so
        // gameplay height lookups agree with the rendered surface:
        //   tl → bl → tr  (tx + tz <= 1)
        //   tr → bl → br  (tx + tz > 1)
        if (tx + tz <= 1) {
            return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
        }
        return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
    }

    destroy(): void {
        if (this.parentId >= 0) this.scene.destroyEntity(this.parentId);
        this._ready = false;
    }

    private async init(): Promise<void> {
        try {
            if (this.config.inline) {
                this.createInlineTerrain(this.config.inline);
                this._ready = true;
                // Defer so the caller can set onReady after construction
                queueMicrotask(() => this.onReady?.());
            } else if (this.config.metaUrl) {
                const metaResp = await fetch(this.config.metaUrl);
                const meta = await metaResp.json() as HeightmapMeta;
                await this.createTerrain(meta);
                this._ready = true;
                this.onReady?.();
            }
        } catch (e) {
            console.warn('[HeightmapTerrain] Init failed:', e);
        }
    }

    private createInlineTerrain(cfg: NonNullable<HeightmapTerrainConfig['inline']>): void {
        const worldW = cfg.worldWidth;
        const worldD = cfg.worldDepth;
        const res = Math.min(cfg.resolution ?? 128, MAX_LOD_RESOLUTION);
        const heightData = new Float32Array(res * res);

        const entity = this.scene.createEntity('Terrain', this.parentId);
        entity.addTag('heightmap_terrain');
        this.terrainEntityId = entity.id;
        entity.addComponent('TransformComponent', {
            position: { x: 0, y: 0, z: 0 },
        });
        entity.addComponent('TerrainComponent', {
            width: worldW,
            depth: worldD,
            resolution: res,
            heightScale: 1.0,
            heightData,
            baseColor: this.config.baseColor ?? [0.45, 0.55, 0.35, 1],
            roughness: 0.9,
            metallic: 0.0,
            waterLevel: this.config.waterLevel,
        });

        const terrain = entity.getComponent('TerrainComponent') as TerrainComponent | null;
        if (terrain) terrain.lodEnabled = true;

        this.heightData = heightData;
        this.res = res;
        this.worldWidth = worldW;
        this.worldDepth = worldD;
        this.centerX = 0;
        this.centerZ = 0;
        this.originX = -worldW / 2;
        this.originZ = -worldD / 2;
        this.contentWidth = worldW;
        this.contentDepth = worldD;
    }

    private async createTerrain(meta: HeightmapMeta): Promise<void> {
        // Resolve the binary URL relative to the meta URL so the meta can
        // use a bare filename (`heightmap.bin`) and still work regardless
        // of where the meta itself is served from.
        const binUrl = new URL(meta.heightmapFile, new URL(this.config.metaUrl!, window.location.href)).href;
        const resp = await fetch(binUrl);
        const rawData = new Float32Array(await resp.arrayBuffer());

        const hmW = meta.width;
        const hmH = meta.height;
        const worldW = meta.worldWidth;
        const worldD = meta.worldDepth;
        const originX = meta.origin?.x ?? 0;
        const originZ = meta.origin?.z ?? 0;

        // Resample to a square grid within the LOD vertex budget.
        const res = Math.min(hmW, hmH, MAX_LOD_RESOLUTION);
        const heightData = new Float32Array(res * res);

        for (let oz = 0; oz < res; oz++) {
            const srcZ = oz / (res - 1) * (hmH - 1);
            const iz = Math.floor(srcZ);
            const fz = srcZ - iz;
            const iz1 = Math.min(iz + 1, hmH - 1);

            for (let ox = 0; ox < res; ox++) {
                const srcX = ox / (res - 1) * (hmW - 1);
                const ix = Math.floor(srcX);
                const fx = srcX - ix;
                const ix1 = Math.min(ix + 1, hmW - 1);

                const h00 = rawData[iz * hmW + ix];
                const h10 = rawData[iz * hmW + ix1];
                const h01 = rawData[iz1 * hmW + ix];
                const h11 = rawData[iz1 * hmW + ix1];
                heightData[oz * res + ox] = h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz)
                    + h01 * (1 - fx) * fz + h11 * fx * fz;
            }
        }

        // TerrainComponent builds its mesh centered on its TransformComponent
        // position, so the transform lives at heightmap NW corner + half extent.
        const centerX = originX + worldW / 2;
        const centerZ = originZ + worldD / 2;

        const entity = this.scene.createEntity('Terrain', this.parentId);
        entity.addTag('heightmap_terrain');
        this.terrainEntityId = entity.id;
        entity.addComponent('TransformComponent', {
            position: { x: centerX, y: 0, z: centerZ },
        });
        entity.addComponent('TerrainComponent', {
            width: worldW,
            depth: worldD,
            resolution: res,
            heightScale: 1.0,
            heightData,
            baseColor: this.config.baseColor ?? [0.55, 0.55, 0.55, 1],
            roughness: 0.9,
            metallic: 0.0,
            waterLevel: this.config.waterLevel,
            // preserveContourLevel defaults to waterLevel in TerrainComponent.initialize()
        });

        const terrain = entity.getComponent('TerrainComponent') as TerrainComponent | null;
        if (terrain) terrain.lodEnabled = true;

        this.heightData = heightData;
        this.res = res;
        this.worldWidth = worldW;
        this.worldDepth = worldD;
        this.centerX = centerX;
        this.centerZ = centerZ;
        this.originX = originX;
        this.originZ = originZ;
        this.contentWidth = meta.contentWidth ?? worldW;
        this.contentDepth = meta.contentDepth ?? worldD;
    }
}
