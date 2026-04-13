/**
 * streamed_roads.ts — Camera-driven road + sidewalk rasterization into the
 * terrain's road atlas, sourced from the pre-generated chunk JSONs under
 * `everything_game/002_world_gen/chunks/`.
 *
 * Uses the same chunk index / JSON files as `StreamedBuildings`, but
 * instead of spawning building entities it feeds each chunk's road +
 * railway placements into a `RoadAtlas`. The atlas textures are then
 * sampled by the terrain shader to overlay asphalt, lane markings, and
 * sidewalk concrete directly on the terrain surface — no separate road
 * meshes required.
 */
import { RoadAtlas } from '../../../engine/frontend/runtime/function/streaming/road_atlas.js';

/** SF-calibrated sidewalk widths per road subtype, in meters. */
export const SIDEWALK_WIDTHS: Record<string, number> = {
    motorway: 0,
    motorway_link: 0,
    trunk: 0,
    trunk_link: 0,
    primary: 3.0,
    primary_link: 2.0,
    secondary: 2.5,
    secondary_link: 1.5,
    tertiary: 2.0,
    tertiary_link: 1.5,
    residential: 1.5,
    service: 1.0,
    unclassified: 1.5,
    living_street: 2.0,
    pedestrian: 0,
    cycleway: 0,
    footway: 0,
    path: 0,
    track: 0,
};

export interface StreamedRoadsConfig {
    /** Base URL for chunk JSONs, must end in '/'. */
    assetBasePath: string;
    /** Chebyshev radius in chunks that feed the near (high-res) atlas. */
    nearRadius?: number;
    /** Chebyshev radius in chunks that feed the far atlas (must be >= nearRadius). */
    farRadius?: number;
    /** Chebyshev radius at which loaded chunks get freed. Must be >= farRadius. */
    unloadRadius?: number;
}

interface WorldIndexChunk { cx: number; cz: number; file: string }
interface WorldIndex {
    chunkSize: number;
    chunksX: number;
    chunksZ: number;
    chunks: WorldIndexChunk[];
}

interface LoadedChunk {
    cx: number;
    cz: number;
    isNear: boolean;
}

export class StreamedRoads {
    private assetBasePath: string;
    private nearRadius: number;
    private farRadius: number;
    private unloadRadius: number;

    readonly atlas: RoadAtlas;
    private worldIndex: Map<string, WorldIndexChunk> | null = null;
    private chunkSize = 250;
    private gridX = 0;
    private gridZ = 0;
    private loaded = new Map<string, LoadedChunk>();
    /** Cached raw placements so near↔far transitions don't re-fetch. */
    private placementsCache = new Map<string, any[]>();
    private pending = new Set<string>();
    private lastCamCX = Number.NaN;
    private lastCamCZ = Number.NaN;

    constructor(device: GPUDevice, config: StreamedRoadsConfig) {
        this.assetBasePath = config.assetBasePath.endsWith('/') ? config.assetBasePath : config.assetBasePath + '/';
        // Default radii chosen to keep initial fetches bounded:
        //   near 2 → 25 chunks (~500 m, high-res tiles)
        //   far  6 → 169 chunks (~1.5 km, low-res tiles)
        // The atlas grid itself can hold 16× (near) / 64× (far) tiles, so
        // callers can safely raise these.
        this.nearRadius = config.nearRadius ?? 2;
        this.farRadius = config.farRadius ?? 6;
        this.unloadRadius = config.unloadRadius ?? this.farRadius + 2;
        this.atlas = new RoadAtlas(device, SIDEWALK_WIDTHS);
        this.fetchWorldIndex();
    }

    /** Call each frame with the active camera's world position. */
    update(camPos: { x: number; y: number; z: number }): void {
        if (!this.worldIndex) return;
        const cx = Math.floor(camPos.x / this.chunkSize);
        const cz = Math.floor(camPos.z / this.chunkSize);
        if (cx === this.lastCamCX && cz === this.lastCamCZ) return;
        this.lastCamCX = cx;
        this.lastCamCZ = cz;

        // Unload chunks beyond unloadRadius
        for (const [key, ch] of this.loaded) {
            const d = Math.max(Math.abs(ch.cx - cx), Math.abs(ch.cz - cz));
            if (d > this.unloadRadius) {
                this.atlas.clearTile(ch.cx, ch.cz, ch.isNear);
                this.loaded.delete(key);
                this.placementsCache.delete(key);
            }
        }

        // Near/far transitions for chunks still loaded: re-rasterize if
        // a chunk crossed the near boundary.
        for (const ch of this.loaded.values()) {
            const d = Math.max(Math.abs(ch.cx - cx), Math.abs(ch.cz - cz));
            const shouldBeNear = d <= this.nearRadius;
            if (shouldBeNear !== ch.isNear) {
                if (!shouldBeNear) {
                    // Was near, no longer — clear just the near atlas tile
                    this.atlas.clearTile(ch.cx, ch.cz, true);
                }
                ch.isNear = shouldBeNear;
                const placements = this.placementsCache.get(`${ch.cx}_${ch.cz}`);
                if (placements) this.atlas.updateTile(ch.cx, ch.cz, placements, this.chunkSize, shouldBeNear);
            }
        }

        // Load missing chunks within farRadius
        const R = this.farRadius;
        for (let dz = -R; dz <= R; dz++) {
            for (let dx = -R; dx <= R; dx++) {
                const tcx = cx + dx;
                const tcz = cz + dz;
                if (tcx < 0 || tcz < 0 || tcx >= this.gridX || tcz >= this.gridZ) continue;
                const key = `${tcx}_${tcz}`;
                if (this.loaded.has(key) || this.pending.has(key)) continue;
                if (!this.worldIndex.has(key)) continue;
                this.fetchChunk(tcx, tcz, key);
            }
        }
    }

    destroy(): void {
        this.loaded.clear();
        this.placementsCache.clear();
        this.pending.clear();
        this.worldIndex = null;
        this.atlas.destroy();
    }

    // ── Internals ─────────────────────────────────────────────────────

    private async fetchWorldIndex(): Promise<void> {
        try {
            const resp = await fetch(this.assetBasePath + 'world_index.json');
            const data = await resp.json() as WorldIndex;
            this.chunkSize = data.chunkSize ?? 250;
            this.gridX = data.chunksX ?? 0;
            this.gridZ = data.chunksZ ?? 0;
            const map = new Map<string, WorldIndexChunk>();
            for (const c of data.chunks || []) map.set(`${c.cx}_${c.cz}`, c);
            this.worldIndex = map;
        } catch (e) {
            console.warn('[StreamedRoads] Failed to load world_index:', e);
        }
    }

    private async fetchChunk(cx: number, cz: number, key: string): Promise<void> {
        this.pending.add(key);
        try {
            const info = this.worldIndex!.get(key)!;
            const resp = await fetch(this.assetBasePath + info.file);
            const data = await resp.json();
            this.pending.delete(key);
            // Camera may have moved away while fetching
            const d = Math.max(Math.abs(cx - this.lastCamCX), Math.abs(cz - this.lastCamCZ));
            if (d > this.unloadRadius) return;
            if (this.loaded.has(key)) return;

            // Keep only road + railway placements to bound cache memory
            const all = data.placements || [];
            const roadsOnly = all.filter((p: any) => p.type === 'road' || p.type === 'railway');
            this.placementsCache.set(key, roadsOnly);

            const isNear = d <= this.nearRadius;
            this.atlas.updateTile(cx, cz, roadsOnly, this.chunkSize, isNear);
            this.loaded.set(key, { cx, cz, isNear });
        } catch (e) {
            this.pending.delete(key);
        }
    }
}
