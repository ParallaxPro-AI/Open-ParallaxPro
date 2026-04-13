/**
 * streamed_props.ts — Camera-driven streaming of street props from the same
 * chunk JSONs used by StreamedBuildings / StreamedRoads.
 *
 * Two sources feed the per-chunk prop set:
 *   1. Pre-baked OSM-driven furniture (`type: "furniture"`) — traffic signs,
 *      traffic lights, and street name signs at real intersections, written
 *      into the chunk JSONs by 002_world_gen/002_bake_traffic_controls.py.
 *   2. Runtime procedural scatter — lamp posts on sidewalk streets,
 *      guardrails on highways, construction cones on rare road segments,
 *      hydrants/trash cans/benches/mailboxes on building sidewalks, picket
 *      fences along short residential building edges.
 *
 * All props in a chunk are merged by material category (metal / wood / signs /
 * signs_green) into a single draw call per category.
 */

import { Scene } from '../../../engine/frontend/runtime/function/framework/scene.js';
import { MeshRendererComponent } from '../../../engine/frontend/runtime/function/framework/components/mesh_renderer_component.js';
import { RenderSystem } from '../../../engine/frontend/runtime/function/render/render_system.js';
import { GPUMeshHandle, MeshData } from '../../../engine/frontend/runtime/function/render/render_scene.js';
import {
    FURNITURE_CATEGORY, FURNITURE_MATERIALS, FURNITURE_GENERATORS,
    type FurnitureCategory,
} from './street_furniture.js';
import { SIDEWALK_WIDTHS } from './streamed_roads.js';

/** Road subtypes that get guardrails on both sides instead of sidewalk furniture. */
const HIGHWAY_SUBTYPES = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary']);

export interface StreamedPropsConfig {
    /** Base URL for the generator's output, must end in '/'. */
    assetBasePath: string;
    /** Chebyshev radius (in chunks) of chunks kept loaded around the camera. */
    loadRadius?: number;
    /** Chebyshev radius at which loaded chunks get freed. Must be ≥ loadRadius. */
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
    /** One entity per material category (metal / wood / signs / signs_green). */
    entities: { id: number; gpuMesh: GPUMeshHandle }[];
}

export class StreamedProps {
    private scene: Scene;
    private renderSystem: RenderSystem;
    private assetBasePath: string;
    private loadRadius: number;
    private unloadRadius: number;

    private parentId = -1;
    private worldIndex: Map<string, WorldIndexChunk> | null = null;
    private chunkSize = 250;
    private gridX = 0;
    private gridZ = 0;
    private loaded = new Map<string, LoadedChunk>();
    private pending = new Set<string>();
    private lastCamCX = Number.NaN;
    private lastCamCZ = Number.NaN;

    constructor(scene: Scene, renderSystem: RenderSystem, config: StreamedPropsConfig) {
        this.scene         = scene;
        this.renderSystem  = renderSystem;
        this.assetBasePath = config.assetBasePath.endsWith('/') ? config.assetBasePath : config.assetBasePath + '/';
        this.loadRadius    = config.loadRadius   ?? 3;
        this.unloadRadius  = config.unloadRadius ?? this.loadRadius + 1;

        const parent = scene.createEntity('StreamedProps');
        parent.addTag('streamed_props_root');
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

        for (const [key, ch] of this.loaded) {
            const d = Math.max(Math.abs(ch.cx - cx), Math.abs(ch.cz - cz));
            if (d > this.unloadRadius) this.unloadChunk(key);
        }

        const R = this.loadRadius;
        for (let dz = -R; dz <= R; dz++) {
            for (let dx = -R; dx <= R; dx++) {
                const tcx = cx + dx, tcz = cz + dz;
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

    // ── Internals ────────────────────────────────────────────────────

    private async fetchWorldIndex(): Promise<void> {
        try {
            const resp = await fetch(this.assetBasePath + 'world_index.json');
            const data = await resp.json() as WorldIndex;
            this.chunkSize = data.chunkSize ?? 250;
            this.gridX     = data.chunksX   ?? 0;
            this.gridZ     = data.chunksZ   ?? 0;
            const map = new Map<string, WorldIndexChunk>();
            for (const c of data.chunks || []) map.set(`${c.cx}_${c.cz}`, c);
            this.worldIndex = map;
        } catch (e) {
            console.warn('[StreamedProps] Failed to load world_index:', e);
        }
    }

    private async fetchChunk(cx: number, cz: number, key: string): Promise<void> {
        this.pending.add(key);
        try {
            const info = this.worldIndex!.get(key)!;
            const resp = await fetch(this.assetBasePath + info.file);
            const data = await resp.json();
            this.pending.delete(key);
            const d = Math.max(Math.abs(cx - this.lastCamCX), Math.abs(cz - this.lastCamCZ));
            if (d > this.unloadRadius) return;
            if (this.loaded.has(key)) return;
            this.buildChunk(cx, cz, key, data.placements || []);
        } catch {
            this.pending.delete(key);
        }
    }

    private buildChunk(cx: number, cz: number, key: string, placements: any[]): void {
        const minX = cx * this.chunkSize, minZ = cz * this.chunkSize;
        const maxX = minX + this.chunkSize, maxZ = minZ + this.chunkSize;
        const inChunk = (x: number, z: number) => x >= minX && x < maxX && z >= minZ && z < maxZ;

        const byCategory: Record<FurnitureCategory, MeshData[]> = {
            metal: [], wood: [], signs: [], signs_green: [],
        };
        const emit = (subtype: string, x: number, y: number, z: number, rot: number): void => {
            const cat = FURNITURE_CATEGORY[subtype];
            const gen = FURNITURE_GENERATORS[subtype];
            if (!cat || !gen) return;
            byCategory[cat].push(gen(x, y, z, rot) as MeshData);
        };

        // Pass 1: emit pre-baked furniture (OSM-driven traffic signs/lights).
        const roads = placements.filter(p => p.type === 'road' && p.points && p.points.length >= 2);
        for (const p of placements) {
            if (p.type !== 'furniture') continue;
            const pos = p.position;
            if (!pos || !inChunk(pos[0], pos[2])) continue;
            emit(p.subtype, pos[0], pos[1], pos[2], p.rotation ?? 0);
        }

        // Pass 2: scatter road-driven props (lamps, guardrails, construction).
        for (const road of roads) this.scatterRoadProps(road, inChunk, emit);
        this.scatterConstructionZones(roads, inChunk, emit);

        // Pass 3: scatter building-driven props (sidewalk furniture, fences).
        for (const p of placements) {
            if (p.type === 'building') this.scatterBuildingProps(p, inChunk, emit);
        }

        const entities: { id: number; gpuMesh: GPUMeshHandle }[] = [];
        for (const cat of Object.keys(byCategory) as FurnitureCategory[]) {
            const merged = mergeMeshes(byCategory[cat]);
            if (!merged) continue;

            const gpuMesh = this.renderSystem.uploadMesh(merged);
            const entity  = this.scene.createEntity(`PropsChunk_${cx}_${cz}_${cat}`, this.parentId);
            entity.addTag('streamed_props_chunk');

            const mat = FURNITURE_MATERIALS[cat];
            entity.addComponent('TransformComponent', { position: { x: 0, y: 0, z: 0 } });
            entity.addComponent('MeshRendererComponent', {
                meshType: '',
                materialOverrides: { baseColor: mat.baseColor, metallic: mat.metallic, roughness: mat.roughness },
                castShadows: true,
                receiveShadows: true,
                visible: true,
            });
            const mr = entity.getComponent('MeshRendererComponent') as MeshRendererComponent;
            mr.gpuMesh = gpuMesh;

            entities.push({ id: entity.id, gpuMesh });
        }

        this.loaded.set(key, { cx, cz, entities });
    }

    private unloadChunk(key: string): void {
        const ch = this.loaded.get(key);
        if (!ch) return;
        for (const e of ch.entities) {
            this.scene.destroyEntity(e.id);
            this.renderSystem.releaseMesh(e.gpuMesh);
        }
        this.loaded.delete(key);
    }

    // ── Placement heuristics ─────────────────────────────────────────

    private scatterRoadProps(
        p: any,
        inChunk: (x: number, z: number) => boolean,
        emit: (subtype: string, x: number, y: number, z: number, rot: number) => void,
    ): void {
        const pts: [number, number, number][] = p.points;
        const sub = p.subtype || '';
        const isHighway = HIGHWAY_SUBTYPES.has(sub);
        const sidewalkW = SIDEWALK_WIDTHS[sub] ?? 0;
        if (!isHighway && sidewalkW <= 0) return;

        const roadHalfW = (p.width || 6) / 2;
        const propOff   = isHighway
            ? roadHalfW + 0.5
            : roadHalfW + Math.max(0.5, sidewalkW * 0.5);

        const LAMP_SPACING      = 30.0;
        const GUARDRAIL_SPACING = 4.0;
        let lampAccum = 0, railAccum = 0;
        let sideFlip = 1;

        for (let i = 0; i < pts.length - 1; i++) {
            const [ax, ay, az] = pts[i];
            const [bx, , bz]   = pts[i + 1];
            const dx = bx - ax, dz = bz - az;
            const segLen = Math.sqrt(dx * dx + dz * dz);
            if (segLen < 0.1) continue;
            const ux = dx / segLen, uz = dz / segLen;
            const nx = -uz, nz = ux;
            const heading = Math.atan2(ux, uz);

            if (!isHighway) {
                let t = LAMP_SPACING - lampAccum;
                while (t < segLen) {
                    const wx = ax + ux * t + nx * propOff * sideFlip;
                    const wz = az + uz * t + nz * propOff * sideFlip;
                    if (inChunk(wx, wz)) emit('lamp_post', wx, ay, wz, heading);
                    t += LAMP_SPACING;
                    sideFlip = -sideFlip;
                }
                lampAccum = (lampAccum + segLen) % LAMP_SPACING;
            } else {
                // Guardrail's long axis (local +X) must run along the edge,
                // not perpendicular to it — see the rotation-convention notes
                // for fences below.
                const railRot = Math.atan2(uz, ux);
                let t = GUARDRAIL_SPACING - railAccum;
                while (t < segLen) {
                    for (const side of [1, -1]) {
                        const wx = ax + ux * t + nx * propOff * side;
                        const wz = az + uz * t + nz * propOff * side;
                        if (inChunk(wx, wz)) emit('guardrail', wx, ay, wz, railRot);
                    }
                    t += GUARDRAIL_SPACING;
                }
                railAccum = (railAccum + segLen) % GUARDRAIL_SPACING;
            }
        }
    }

    /**
     * Rare construction zones along drivable road segments — 5 cones lined
     * along the curb at the segment midpoint. Deterministic per segment.
     */
    private scatterConstructionZones(
        roads: any[],
        inChunk: (x: number, z: number) => boolean,
        emit: (subtype: string, x: number, y: number, z: number, rot: number) => void,
    ): void {
        const ODDS = 0.015;
        for (const road of roads) {
            const sub = road.subtype || '';
            if (sub === 'footway' || sub === 'cycleway' || sub === 'path') continue;
            const pts = road.points as [number, number, number][];
            const roadHalfW = (road.width || 6) / 2;

            for (let i = 0; i < pts.length - 1; i++) {
                const [ax, ay, az] = pts[i];
                const [bx, , bz]   = pts[i + 1];
                const dx = bx - ax, dz = bz - az;
                const segLen = Math.sqrt(dx * dx + dz * dz);
                if (segLen < 8) continue;
                const seed = Math.abs(Math.floor(ax * 91 + az * 47 + i * 13)) >>> 0;
                if ((seed % 1000) / 1000 > ODDS) continue;

                const ux = dx / segLen, uz = dz / segLen;
                const nx = -uz, nz = ux;
                const curbOff = roadHalfW - 0.3;
                const heading = Math.atan2(ux, uz);

                const midT = segLen * 0.5 - 4;
                for (let c = 0; c < 5; c++) {
                    const t = midT + c * 2;
                    if (t < 0 || t > segLen) continue;
                    const cx = ax + ux * t + nx * curbOff;
                    const cz = az + uz * t + nz * curbOff;
                    if (inChunk(cx, cz)) emit('construction_cone', cx, ay, cz, heading);
                }
            }
        }
    }

    private scatterBuildingProps(
        p: any,
        inChunk: (x: number, z: number) => boolean,
        emit: (subtype: string, x: number, y: number, z: number, rot: number) => void,
    ): void {
        const pos  = p.position;
        const poly = p.polygon as [number, number][] | undefined;
        if (!pos || !poly || poly.length < 3) return;

        const seed   = (Math.abs(Math.floor(pos[0] * 17 + pos[2] * 31))) >>> 0;
        const height = p.height ?? 8;

        let ccx = 0, ccz = 0;
        for (const [px, pz] of poly) { ccx += px; ccz += pz; }
        ccx /= poly.length; ccz /= poly.length;

        // 1) Sidewalk prop (hydrant / trash can / bench / mailbox) for ~30%
        //    of buildings, placed just outside a deterministic polygon edge.
        if ((seed % 1000) / 1000 <= 0.30) {
            const edgeIdx = (seed >>> 4) % poly.length;
            const [ax, az] = poly[edgeIdx];
            const [bx, bz] = poly[(edgeIdx + 1) % poly.length];
            const dx = bx - ax, dz = bz - az;
            const edgeLen = Math.sqrt(dx * dx + dz * dz);
            if (edgeLen >= 1) {
                const ux = dx / edgeLen, uz = dz / edgeLen;
                const midX = (ax + bx) / 2, midZ = (az + bz) / 2;
                const nx0 = -uz, nz0 = ux;
                const outSign = ((midX - ccx) * nx0 + (midZ - ccz) * nz0) >= 0 ? 1 : -1;
                const wx = midX + nx0 * outSign * 1.0;
                const wz = midZ + nz0 * outSign * 1.0;
                if (inChunk(wx, wz)) {
                    const palette = ['fire_hydrant', 'trash_can', 'bench', 'mailbox'];
                    const subtype = palette[(seed >>> 8) % palette.length];
                    emit(subtype, wx, pos[1], wz, Math.atan2(ux, uz));
                }
            }
        }

        // 2) Picket fence along one polygon edge for ~35% of short
        //    residential buildings.
        if (height < 10 && (((seed >>> 11) % 1000) / 1000) <= 0.35) {
            const edgeIdx = (seed >>> 16) % poly.length;
            const [ax, az] = poly[edgeIdx];
            const [bx, bz] = poly[(edgeIdx + 1) % poly.length];
            const dx = bx - ax, dz = bz - az;
            const edgeLen = Math.sqrt(dx * dx + dz * dz);
            if (edgeLen >= 2 && edgeLen <= 40) {
                const ux = dx / edgeLen, uz = dz / edgeLen;
                // Fence rail's long axis (local +X) must run along the edge.
                // atan2(uz, ux) rotates local +X to (ux, uz) = edge direction.
                const heading = Math.atan2(uz, ux);
                const FENCE_SEG = 2.0;
                const inset = 0.3;
                const nx0 = -uz, nz0 = ux;
                const midX = (ax + bx) / 2, midZ = (az + bz) / 2;
                const outSign = ((midX - ccx) * nx0 + (midZ - ccz) * nz0) >= 0 ? 1 : -1;
                const nx = nx0 * outSign, nz = nz0 * outSign;

                for (let t = FENCE_SEG / 2; t < edgeLen; t += FENCE_SEG) {
                    const fx = ax + ux * t + nx * inset;
                    const fz = az + uz * t + nz * inset;
                    if (!inChunk(fx, fz)) continue;
                    emit('fence', fx, pos[1], fz, heading);
                }
            }
        }
    }
}

// ── Mesh merging ─────────────────────────────────────────────────────

function mergeMeshes(meshes: MeshData[]): MeshData | null {
    if (meshes.length === 0) return null;
    if (meshes.length === 1) return meshes[0];

    let totalVerts = 0, totalIdx = 0;
    for (const m of meshes) { totalVerts += m.positions.length / 3; totalIdx += m.indices.length; }

    const positions = new Float32Array(totalVerts * 3);
    const normals   = new Float32Array(totalVerts * 3);
    const uvs       = new Float32Array(totalVerts * 2);
    const indices   = new Uint32Array(totalIdx);

    let vOff = 0, iOff = 0, vBase = 0;
    for (const m of meshes) {
        const nv = m.positions.length / 3;
        positions.set(m.positions, vOff * 3);
        normals.set(m.normals,     vOff * 3);
        uvs.set(m.uvs,             vOff * 2);
        for (let i = 0; i < m.indices.length; i++) indices[iOff + i] = m.indices[i] + vBase;
        vOff += nv; iOff += m.indices.length; vBase += nv;
    }

    return { positions, normals, uvs, indices };
}
