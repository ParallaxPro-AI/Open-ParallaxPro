/**
 * streamed_buildings.ts — Camera-driven streaming of plain-color
 * extruded OSM buildings from pre-generated chunk JSON.
 *
 * Fetches `<assetBasePath>/world_index.json` once, then fetches
 * per-chunk JSON (`chunk_<cx>_<cz>.json`) lazily as the active camera
 * enters each chunk's load radius. Each building placement in the
 * chunk is extruded into a simple walls-plus-flat-roof mesh; all
 * buildings in a chunk are merged into one draw call and rendered
 * through the standard PBR path via a MeshRendererComponent whose
 * `gpuMesh` is assigned directly — no new shader is required.
 *
 * Scope: plain-color only. No facade/window shader, no roof shape
 * variation, no LOD. Chunk JSON is the format emitted by
 * `everything_game/002_world_gen/002_generate_chunks.ts`; placements
 * with `type === 'building'` are consumed, everything else is ignored.
 */
import { Scene } from '../framework/scene.js';
import { MeshRendererComponent } from '../framework/components/mesh_renderer_component.js';
import { RenderSystem } from '../render/render_system.js';
import { GPUMeshHandle } from '../render/render_scene.js';

export interface StreamedBuildingsConfig {
    /** Base URL for the generator's output, must end in '/'. */
    assetBasePath: string;
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

    constructor(scene: Scene, renderSystem: RenderSystem, config: StreamedBuildingsConfig) {
        this.scene = scene;
        this.renderSystem = renderSystem;
        this.assetBasePath = config.assetBasePath.endsWith('/') ? config.assetBasePath : config.assetBasePath + '/';
        this.loadRadius = config.loadRadius ?? 3;
        this.unloadRadius = config.unloadRadius ?? this.loadRadius + 1;
        this.baseColor = config.baseColor ?? [0.74, 0.71, 0.66, 1.0];

        const parent = scene.createEntity('StreamedBuildings');
        parent.addTag('streamed_buildings_root');
        this.parentId = parent.id;

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

        for (const p of placements) {
            if (p.type !== 'building') continue;
            const b = p as BuildingPlacement;
            if (b.polygon && b.polygon.length >= 3 && typeof b.height === 'number') {
                const baseY = b.position[1];
                // Sink slightly so the wall base vanishes into the terrain
                // rather than floating above small elevation variation.
                extrudePolygon(b.polygon, baseY - 0.5, b.height + 0.5,
                    positions, normals, uvs, indices);
            } else if (b.size) {
                // Point building fallback: axis-aligned box centered on position.
                const [px, py, pz] = b.position;
                const [sw, sh, sd] = b.size;
                const hx = sw * 0.5, hz = sd * 0.5;
                extrudeAxisAlignedBox(
                    px - hx, pz - hz, sw, sd,
                    py - 0.5, py - 0.5 + sh,
                    positions, normals, uvs, indices,
                );
            }
        }

        if (indices.length === 0) {
            // Remember the chunk as loaded so we don't refetch each frame.
            this.loaded.set(key, { cx, cz, entityId: -1, gpuMesh: null as any });
            return;
        }

        const gpuMesh = this.renderSystem.uploadMesh({
            positions: new Float32Array(positions),
            normals: new Float32Array(normals),
            uvs: new Float32Array(uvs),
            indices: new Uint32Array(indices),
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
    pos: number[], norm: number[], uv: number[], idx: number[],
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
        // v0: bottom-left, v1: bottom-right, v2: top-right, v3: top-left
        pos.push(x0, baseY, z0,  x1, baseY, z1,  x1, topY, z1,  x0, topY, z0);
        for (let k = 0; k < 4; k++) norm.push(nx, 0, nz);
        uv.push(0, 0, len, 0, len, height, 0, height);
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
    for (let i = 0; i < n; i++) {
        const [x, z] = polygon[i];
        pos.push(x, topY, z);
        norm.push(0, 1, 0);
        uv.push(x - cx, z - cz);
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
    pos: number[], norm: number[], uv: number[], idx: number[],
): void {
    const x1 = x + sx;
    const z1 = z + sz;

    // +X
    addQuad(pos, norm, uv, idx,
        x1, y0, z1,  x1, y0, z,   x1, y1, z,   x1, y1, z1,
        1, 0, 0);
    // -X
    addQuad(pos, norm, uv, idx,
        x,  y0, z,   x,  y0, z1,  x,  y1, z1,  x,  y1, z,
        -1, 0, 0);
    // +Z
    addQuad(pos, norm, uv, idx,
        x,  y0, z1,  x1, y0, z1,  x1, y1, z1,  x,  y1, z1,
        0, 0, 1);
    // -Z
    addQuad(pos, norm, uv, idx,
        x1, y0, z,   x,  y0, z,   x,  y1, z,   x1, y1, z,
        0, 0, -1);
    // +Y (roof)
    addQuad(pos, norm, uv, idx,
        x,  y1, z1,  x1, y1, z1,  x1, y1, z,   x,  y1, z,
        0, 1, 0);
}

function addQuad(
    pos: number[], norm: number[], uv: number[], idx: number[],
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
): void {
    const base = pos.length / 3;
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let k = 0; k < 4; k++) norm.push(nx, ny, nz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
