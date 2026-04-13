/**
 * streamed_buildings.ts — Camera-driven streaming of extruded OSM
 * buildings from the pre-generated chunk JSON under
 * `everything_game/002_world_gen/chunks/`.
 *
 * Fetches `<assetBasePath>/world_index.json` once, then fetches
 * per-chunk JSON (`chunk_<cx>_<cz>.json`) lazily as the active camera
 * enters each chunk's load radius. Each building placement with
 * `type === 'building'` is extruded into a walls-plus-flat-roof mesh;
 * all buildings in a chunk are merged into one draw call. Meshes are
 * rendered through the engine's building pipeline with per-vertex
 * metadata that includes texture layer index (from Poly Haven texture
 * arrays) and window grid configuration.
 *
 * This file is game-specific: it knows the OSM placement schema and
 * the subtype whitelist. The mesh upload path (`uploadBuildingMesh`),
 * render pipeline, and shaders are generic and live under engine/.
 */
import { Scene } from '../../../engine/frontend/runtime/function/framework/scene.js';
import { MeshRendererComponent } from '../../../engine/frontend/runtime/function/framework/components/mesh_renderer_component.js';
import { RenderSystem } from '../../../engine/frontend/runtime/function/render/render_system.js';
import { GPUMeshHandle } from '../../../engine/frontend/runtime/function/render/render_scene.js';
import {
	loadBuildingTextureArrays,
	BUILDING_LAYER_RANGES,
	BUILDING_TEXTURES,
} from './osm_texture_cache.js';

export interface StreamedBuildingsConfig {
    /** Base URL for the generator's output, must end in '/'. */
    assetBasePath: string;
    /**
     * Base URL for Poly Haven textures, must end in '/'.
     * Textures are expected at `<polyHavenBasePath>poly_haven/textures/<name>/`.
     * Defaults to two directories above assetBasePath (i.e. strips the
     * `everything_game/chunks/` suffix that chunk data lives under).
     */
    polyHavenBasePath?: string;
    /** Chebyshev radius (in chunks) of chunks kept loaded around the camera. */
    loadRadius?: number;
    /** Chebyshev radius at which loaded chunks get freed. Must be ≥ loadRadius. */
    unloadRadius?: number;
    /** RGBA color applied uniformly to every wall + roof. */
    baseColor?: [number, number, number, number];
}

interface WorldIndexChunk { cx: number; cz: number; file: string }
interface WorldIndex {
    chunkSize: number;
    chunksX: number;
    chunksZ: number;
    chunks: WorldIndexChunk[];
}

interface BuildingPlacement {
    type: 'building';
    subtype?: string;
    position: [number, number, number];
    /** Outer-ring footprint polygon in game coords. Missing for point buildings. */
    polygon?: [number, number][];
    /** Height in meters — present for polygon buildings. */
    height?: number;
    /** [w, h, d] box size — present for point buildings (polygon absent). */
    size?: [number, number, number];
    rotation?: number;
}

interface LoadedChunk {
    cx: number;
    cz: number;
    entityId: number;
    gpuMesh: GPUMeshHandle;
}

export class StreamedBuildings {
    private scene: Scene;
    private renderSystem: RenderSystem;
    private assetBasePath: string;
    private loadRadius: number;
    private unloadRadius: number;
    private baseColor: [number, number, number, number];

    private parentId = -1;
    private worldIndex: Map<string, WorldIndexChunk> | null = null;
    private chunkSize = 250;
    private gridX = 0;
    private gridZ = 0;
    private loaded = new Map<string, LoadedChunk>();
    /** Keys currently being fetched — avoids duplicate in-flight requests. */
    private pending = new Set<string>();
    private lastCamCX = Number.NaN;
    private lastCamCZ = Number.NaN;

    // Texture arrays from Poly Haven
    private textureArrays: Awaited<ReturnType<typeof loadBuildingTextureArrays>> | null = null;
    private polyHavenBasePath: string;

    constructor(scene: Scene, renderSystem: RenderSystem, config: StreamedBuildingsConfig) {
        this.scene = scene;
        this.renderSystem = renderSystem;
        this.assetBasePath = config.assetBasePath.endsWith('/') ? config.assetBasePath : config.assetBasePath + '/';
        this.loadRadius = config.loadRadius ?? 3;
        this.unloadRadius = config.unloadRadius ?? this.loadRadius + 1;
        this.baseColor = config.baseColor ?? [0.74, 0.71, 0.66, 1.0];

        if (config.polyHavenBasePath) {
            this.polyHavenBasePath = config.polyHavenBasePath.endsWith('/')
                ? config.polyHavenBasePath : config.polyHavenBasePath + '/';
        } else {
            // Poly Haven textures are served from reusable_assets/ at /assets/
            this.polyHavenBasePath = '/assets/';
        }

        const parent = scene.createEntity('StreamedBuildings');
        parent.addTag('streamed_buildings_root');
        this.parentId = parent.id;

        this.fetchWorldIndex();
        this.loadTextures();
    }

    /** Call each frame with the active camera's world position. */
    update(camPos: { x: number; y: number; z: number }): void {
        if (!this.worldIndex) return;
        const cx = Math.floor(camPos.x / this.chunkSize);
        const cz = Math.floor(camPos.z / this.chunkSize);
        if (cx === this.lastCamCX && cz === this.lastCamCZ) return;
        this.lastCamCX = cx;
        this.lastCamCZ = cz;

        // Unload far chunks.
        const UR = this.unloadRadius;
        for (const [key, ch] of this.loaded) {
            const d = Math.max(Math.abs(ch.cx - cx), Math.abs(ch.cz - cz));
            if (d > UR) this.unloadChunk(key);
        }

        // Load missing chunks within loadRadius.
        const R = this.loadRadius;
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
        for (const key of [...this.loaded.keys()]) this.unloadChunk(key);
        this.pending.clear();
        this.worldIndex = null;
        if (this.parentId >= 0) {
            this.scene.destroyEntity(this.parentId);
            this.parentId = -1;
        }
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
            for (const c of data.chunks || []) {
                map.set(`${c.cx}_${c.cz}`, c);
            }
            this.worldIndex = map;
        } catch (e) {
            console.warn('[StreamedBuildings] Failed to load world_index:', e);
        }
    }

    private async loadTextures(): Promise<void> {
        try {
            const device = this.renderSystem.getDevice();
            if (!device) {
                console.warn('[StreamedBuildings] GPU device not yet available; textures will load on next check');
                // Try again in a moment when device is ready
                setTimeout(() => this.loadTextures(), 100);
                return;
            }
            this.textureArrays = await loadBuildingTextureArrays(device, this.polyHavenBasePath);
            if (this.textureArrays) {
                console.log('[StreamedBuildings] Loaded Poly Haven building textures');
                // Pass textures to render system for building pipeline
                this.renderSystem.setBuildingTextures(
                    this.textureArrays.diffuseArray,
                    this.textureArrays.normalArray,
                    this.textureArrays.layerProps,
                );
            }
        } catch (e) {
            console.warn('[StreamedBuildings] Failed to load building textures:', e);
        }
    }

    private async fetchChunk(cx: number, cz: number, key: string): Promise<void> {
        this.pending.add(key);
        try {
            const info = this.worldIndex!.get(key)!;
            const resp = await fetch(this.assetBasePath + info.file);
            const data = await resp.json();
            this.pending.delete(key);
            // Camera may have moved away while fetching.
            const d = Math.max(Math.abs(cx - this.lastCamCX), Math.abs(cz - this.lastCamCZ));
            if (d > this.unloadRadius) return;
            if (this.loaded.has(key)) return;
            this.buildChunk(cx, cz, key, data.placements || []);
        } catch (e) {
            this.pending.delete(key);
        }
    }

    private buildChunk(cx: number, cz: number, key: string, placements: any[]): void {
        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];
        const meta: number[] = [];

        for (const p of placements) {
            if (p.type !== 'building') continue;
            const b = p as BuildingPlacement;

            // Classify building and pick texture layer
            const category = classifyBuilding(b.subtype ?? 'yes');
            const seed = hashPos(Math.floor(b.position[0]), Math.floor(b.position[2]));
            const layerIndex = pickLayer(category, seed);
            const seed6 = seed & 0x3F;

            if (b.polygon && b.polygon.length >= 3 && typeof b.height === 'number') {
                const baseY = b.position[1];
                const buildingHeight = b.height + 0.5;
                // floorCount=0 disables the window grid for non-window building types
                const floorCount = hasWindows(b.subtype)
                    ? Math.max(1, Math.min(63, Math.round(buildingHeight / 3.5)))
                    : 0;
                extrudePolygon(b.polygon, baseY - 0.5, buildingHeight, seed6, floorCount, layerIndex,
                    positions, normals, uvs, indices, meta);
            } else if (b.size) {
                const [px, py, pz] = b.position;
                const [sw, sh, sd] = b.size;
                const hx = sw * 0.5, hz = sd * 0.5;
                const floorCount = hasWindows(b.subtype)
                    ? Math.max(1, Math.min(63, Math.round(sh / 3.5)))
                    : 0;
                extrudeAxisAlignedBox(
                    px - hx, pz - hz, sw, sd,
                    py - 0.5, py - 0.5 + sh,
                    sh, seed6, floorCount, layerIndex,
                    positions, normals, uvs, indices, meta,
                );
            }
        }

        if (indices.length === 0) {
            // Remember the chunk as loaded so we don't refetch each frame.
            this.loaded.set(key, { cx, cz, entityId: -1, gpuMesh: null as any });
            return;
        }

        const gpuMesh = this.renderSystem.uploadBuildingMesh({
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint32Array(indices),
            meta: new Uint32Array(meta),
        });

        const entity = this.scene.createEntity(`BuildingsChunk_${cx}_${cz}`, this.parentId);
        entity.addTag('streamed_buildings_chunk');
        entity.addComponent('TransformComponent', { position: { x: 0, y: 0, z: 0 } });
        entity.addComponent('MeshRendererComponent', {
            meshType: '',
            materialOverrides: {
                baseColor: this.baseColor,
                metallic: 0.0,
                roughness: 0.9,
            },
            castShadows: true,
            receiveShadows: true,
            visible: true,
        });
        const mr = entity.getComponent('MeshRendererComponent') as MeshRendererComponent;
        mr.gpuMesh = gpuMesh;

        this.loaded.set(key, { cx, cz, entityId: entity.id, gpuMesh });
    }

    private unloadChunk(key: string): void {
        const ch = this.loaded.get(key);
        if (!ch) return;
        if (ch.entityId >= 0) this.scene.destroyEntity(ch.entityId);
        if (ch.gpuMesh) this.renderSystem.releaseMesh(ch.gpuMesh);
        this.loaded.delete(key);
    }
}

// ── Mesh generation ───────────────────────────────────────────────────

/**
 * Extrude a polygon footprint into walls + flat roof, appending geometry
 * to the provided arrays. The polygon is expected to be CW when viewed
 * from +Y looking down (OSM conversion in
 * `everything_game/002_world_gen/002_generate_chunks.ts` produces this
 * winding: `x = lng, z = -lat`, which flips OSM's CCW-from-above into
 * CW-from-above in game coords). With that winding, outward wall
 * normals are `(dz, 0, -dx)` and the CCW quad winding on each wall puts
 * the front face on the exterior.
 *
 * Roof is fan-triangulated from the centroid — produces correct results
 * for convex polygons and small artifacts on concave ones (acceptable
 * for plain-color rendering).
 */
function extrudePolygon(
    polygon: [number, number][],
    baseY: number,
    height: number,
    seed6: number,
    floorCount: number,
    layerIndex: number,
    pos: number[], norm: number[], uv: number[], idx: number[], meta: number[],
): void {
    const n = polygon.length;
    const topY = baseY + height;

    // ── Walls ──
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const [x0, z0] = polygon[i];
        const [x1, z1] = polygon[j];
        const dx = x1 - x0;
        const dz = z1 - z0;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.001) continue;
        const nx = dz / len;
        const nz = -dx / len;

        const base = pos.length / 3;
        const segMeta = packBuildingMeta(layerIndex, seed6, floorCount, len, height);
        // v0: bottom-left, v1: bottom-right, v2: top-right, v3: top-left
        pos.push(x0, baseY, z0,  x1, baseY, z1,  x1, topY, z1,  x0, topY, z0);
        for (let k = 0; k < 4; k++) norm.push(nx, 0, nz);
        uv.push(0, 0, len, 0, len, height, 0, height);
        for (let k = 0; k < 4; k++) meta.push(segMeta);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    // ── Flat roof (fan from centroid) ──
    let cx = 0, cz = 0;
    for (const [x, z] of polygon) { cx += x; cz += z; }
    cx /= n; cz /= n;

    const roofBase = pos.length / 3;
    pos.push(cx, topY, cz);
    norm.push(0, 1, 0);
    uv.push(0, 0);
    meta.push(0);
    for (let i = 0; i < n; i++) {
        const [x, z] = polygon[i];
        pos.push(x, topY, z);
        norm.push(0, 1, 0);
        uv.push(x - cx, z - cz);
        meta.push(0);
    }
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        idx.push(roofBase, roofBase + 1 + i, roofBase + 1 + j);
    }
}

/**
 * Point-building fallback. Winding matches MeshData.createBox so the
 * standard PBR front-face culling keeps the exterior visible.
 */
function extrudeAxisAlignedBox(
    x: number, z: number, sx: number, sz: number,
    y0: number, y1: number,
    buildingHeight: number,
    seed6: number,
    floorCount: number,
    layerIndex: number,
    pos: number[], norm: number[], uv: number[], idx: number[], meta: number[],
): void {
    const x1 = x + sx;
    const z1 = z + sz;
    const height = y1 - y0;
    // Walls use UV in meters so the shader's window grid matches real size.
    const metaX = packBuildingMeta(layerIndex, seed6, floorCount, sz, buildingHeight); // +X / -X walls are sz wide
    const metaZ = packBuildingMeta(layerIndex, seed6, floorCount, sx, buildingHeight); // +Z / -Z walls are sx wide

    // +X — spans Z (0..sz) × Y (0..height)
    addQuadMeta(pos, norm, uv, idx, meta,
        x1, y0, z1,  x1, y0, z,   x1, y1, z,   x1, y1, z1,
        1, 0, 0, sz, height, metaX);
    // -X
    addQuadMeta(pos, norm, uv, idx, meta,
        x,  y0, z,   x,  y0, z1,  x,  y1, z1,  x,  y1, z,
        -1, 0, 0, sz, height, metaX);
    // +Z — spans X (0..sx) × Y
    addQuadMeta(pos, norm, uv, idx, meta,
        x,  y0, z1,  x1, y0, z1,  x1, y1, z1,  x,  y1, z1,
        0, 0, 1, sx, height, metaZ);
    // -Z
    addQuadMeta(pos, norm, uv, idx, meta,
        x1, y0, z,   x,  y0, z,   x,  y1, z,   x1, y1, z,
        0, 0, -1, sx, height, metaZ);
    // +Y roof — meta = 0 disables the window grid on the roof
    addQuadMeta(pos, norm, uv, idx, meta,
        x,  y1, z1,  x1, y1, z1,  x1, y1, z,   x,  y1, z,
        0, 1, 0, 1, 1, 0);
}

function addQuadMeta(
    pos: number[], norm: number[], uv: number[], idx: number[], meta: number[],
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    uMax: number, vMax: number, metaValue: number,
): void {
    const base = pos.length / 3;
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let k = 0; k < 4; k++) norm.push(nx, ny, nz);
    // UVs in meters so fragment shader can lay out a window grid at real scale.
    uv.push(0, 0,  uMax, 0,  uMax, vMax,  0, vMax);
    for (let k = 0; k < 4; k++) meta.push(metaValue);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * OSM `building=*` subtypes that should render with the procedural
 * window facade. Anything outside this set renders as a plain tinted
 * wall — this is an *inclusion* list, not an exclusion list, so new/weird
 * subtypes default to "no windows" and we never accidentally paint
 * windows on sheds, silos, bridge towers, stadium bowls, etc.
 *
 * `yes` is included deliberately: it's OSM's generic fallback (~79 % of
 * buildings with no explicit subtype) and in practice is overwhelmingly
 * real houses/offices that should have windows.
 */
const HAS_WINDOWS_SUBTYPES = new Set<string>([
    // Default generic
    'yes',
    // Residential
    'residential', 'house', 'detached', 'semidetached_house', 'terrace',
    'bungalow', 'apartments', 'dormitory', 'duplex', 'condominium',
    'cottage', 'cabin', 'allotment_house',
    // Commercial
    'commercial', 'office', 'retail', 'supermarket', 'mixed_use',
    'hotel', 'motel', 'hostel', 'restaurant', 'cafe', 'bar', 'pub',
    'fast_food', 'bank', 'kiosk', 'clinic',
    // Civic / public
    'school', 'university', 'college', 'kindergarten', 'library',
    'hospital', 'museum', 'theatre', 'theater', 'cinema',
    'arena', 'stadium', 'sports_centre', 'sports_hall', 'gymnasium', 'gym',
    'government', 'civic', 'public', 'townhall', 'courthouse',
    'community_centre', 'community_center', 'hall',
    'fire_station', 'police_station', 'train_station', 'terminal',
    // Religious
    'church', 'cathedral', 'chapel', 'temple', 'synagogue', 'mosque',
    'monastery', 'convent', 'shrine', 'religious', 'kingdom_hall',
    'place_of_worship',
]);

function hasWindows(subtype: string | undefined): boolean {
    return HAS_WINDOWS_SUBTYPES.has(subtype ?? 'yes');
}

/**
 * Pack per-vertex building meta as a u32:
 * - Bits  [0:3]:  texture layer index (0-13)
 * - Bits  [4:9]:  building seed (0-63, drives style + color variation)
 * - Bits [10:15]: floor count (0-63; 0 disables window grid)
 * - Bits [16:23]: wall segment width in 0.25 m units (0-255, max 63.75 m)
 * - Bits [24:31]: building height in 0.5 m units (0-255, max 127.5 m)
 */
function packBuildingMeta(
    layerIndex: number,
    seed6: number,
    floorCount: number,
    wallWidth: number,
    buildingHeight: number,
): number {
    const layerBits = (layerIndex & 0xF);
    const seedBits  = (seed6 & 0x3F) << 4;
    const floorBits = (Math.min(63, floorCount) & 0x3F) << 10;
    const wallBits  = (Math.min(255, Math.round(wallWidth / 0.25)) & 0xFF) << 16;
    const heightBits = (Math.min(255, Math.round(buildingHeight / 0.5)) & 0xFF) << 24;
    return (layerBits | seedBits | floorBits | wallBits | heightBits) >>> 0;
}

/**
 * Classify an OSM building subtype into a material category
 * for texture selection.
 */
function classifyBuilding(subtype: string): string {
    switch (subtype) {
        case 'residential':
        case 'house':
        case 'detached':
        case 'semidetached_house':
        case 'terrace':
        case 'bungalow':
        case 'apartments':
        case 'dormitory':
            return 'residential';
        case 'commercial':
        case 'office':
        case 'retail':
        case 'hotel':
        case 'supermarket':
            return 'commercial';
        case 'church':
        case 'cathedral':
        case 'chapel':
            return 'brick';
        case 'industrial':
        case 'factory':
            return 'industrial';
        case 'warehouse':
        case 'garage':
        case 'garages':
        case 'parking':
        case 'hangar':
            return 'industrial';
        default:
            return 'concrete';
    }
}

/**
 * Pick a texture layer index from the appropriate category range
 * using the building seed for deterministic variation.
 */
function pickLayer(category: string, seed: number): number {
    const range = BUILDING_LAYER_RANGES[category];
    if (!range) return 10; // fallback to beige_wall_001
    const [lo, hi] = range;
    return lo + (seed % (hi - lo + 1));
}

/**
 * Hash building position to a deterministic seed (0-63).
 */
function hashPos(x: number, z: number): number {
    let h = (x * 73856093) ^ (z * 19349669);
    h = ((h >>> 16) ^ h) * 0x45d9f3b | 0;
    h = ((h >>> 16) ^ h) * 0x45d9f3b | 0;
    return (h >>> 0) & 0x3F;
}
