import { HeightmapTerrain } from '../../runtime/function/streaming/heightmap_terrain.js';
import { StreamedBuildings } from '../../../../everything_game/003_runtime/streaming/streamed_buildings.js';
import { StreamedRoads } from '../../../../everything_game/003_runtime/streaming/streamed_roads.js';
import { StreamedProps } from '../../../../everything_game/003_runtime/streaming/streamed_props.js';
import { loadTerrainTextureArrays } from '../../../../everything_game/003_runtime/streaming/terrain_texture_cache.js';
import type { EditorContext } from './editor_context.js';

interface HeightmapTerrainSceneCfg {
    metaUrl: string;
    baseColor?: [number, number, number, number];
    waterLevel?: number;
}

/**
 * Instantiates scene-declared streaming modules (heightmap terrain,
 * OSM buildings, roads, props) and drives their per-frame LOD/stream
 * updates from the active camera's position.
 *
 * Lives in the editor package because the streamed buildings/roads/props
 * modules are everything_game-specific, not part of the generic engine
 * runtime. Both ViewportPanel (editor) and play.ts (published games)
 * construct one so play-mode behavior matches in both contexts.
 */
export class StreamingManager {
    heightmapTerrain: HeightmapTerrain | null = null;
    streamedBuildings: StreamedBuildings | null = null;
    streamedRoads: StreamedRoads | null = null;
    streamedProps: StreamedProps | null = null;

    constructor(private ctx: EditorContext) {}

    /** Rebuild all streamers from the currently loaded project data. */
    init(): void {
        this.destroy();
        this.initHeightmapTerrain();
        this.initStreamedBuildings();
        this.initStreamedRoads();
        this.initStreamedProps();
    }

    /** Drive per-frame camera-based updates. Caller supplies the active
     *  camera position (editor camera in edit mode, scene camera in play). */
    update(camPos: { x: number; y: number; z: number }): void {
        if (!this.ctx.engine) return;
        if (this.heightmapTerrain) this.heightmapTerrain.update(camPos);
        if (this.streamedBuildings) this.streamedBuildings.update(camPos);
        if (this.streamedRoads) {
            this.streamedRoads.update(camPos);
            const renderSystem = this.ctx.engine.globalContext.renderSystem;
            renderSystem.setDecals(this.streamedRoads.collectDecals());
        }
        if (this.streamedProps) this.streamedProps.update(camPos);
    }

    destroy(): void {
        if (this.heightmapTerrain) { this.heightmapTerrain.destroy(); this.heightmapTerrain = null; }
        if (this.streamedBuildings) { this.streamedBuildings.destroy(); this.streamedBuildings = null; }
        if (this.streamedRoads) { this.streamedRoads.destroy(); this.streamedRoads = null; }
        if (this.streamedProps) { this.streamedProps.destroy(); this.streamedProps = null; }
    }

    private initHeightmapTerrain(): void {
        const scene = this.ctx.getActiveScene();
        if (!scene) return;

        // Clean up any stale heightmap-terrain entities restored from a
        // previous scene snapshot (the runtime re-spawns its own on init).
        for (const entity of [...scene.entities.values()]) {
            if (entity.hasTag('heightmap_terrain_root')) {
                scene.destroyEntity(entity.id);
            }
        }

        const pd = this.ctx.state.projectData;
        const scenes = pd?.scenes || {};
        for (const sceneData of Object.values(scenes) as any[]) {
            const cfg = sceneData?.heightmapTerrain as HeightmapTerrainSceneCfg | undefined;
            if (!cfg?.metaUrl) continue;
            const terrain = new HeightmapTerrain(scene, {
                metaUrl: cfg.metaUrl,
                baseColor: cfg.baseColor,
                waterLevel: cfg.waterLevel,
            });
            // After the heightmap geometry lands, upload it to GPU and then
            // asynchronously load the PBR ground textures to activate the
            // dedicated terrain shader pipeline. Content dims come from the
            // heightmap meta, not the scene config, so the two don't drift.
            terrain.onReady = () => {
                this.ctx.ensurePrimitiveMeshes();
                const device = this.ctx.engine?.globalContext.renderSystem.getDevice();
                if (!device) return;
                loadTerrainTextureArrays(device, {
                    worldWidth:   terrain.worldWidth,
                    worldDepth:   terrain.worldDepth,
                    originX:      terrain.originX,
                    originZ:      terrain.originZ,
                    contentWidth: terrain.contentWidth,
                    contentDepth: terrain.contentDepth,
                })
                    .then(arrays => terrain.applyTerrainTextures(
                        arrays,
                        this.streamedRoads?.atlas.nearTexture,
                        this.streamedRoads?.atlas.farTexture,
                    ))
                    .catch(err => console.warn('[Terrain] Failed to load ground textures:', err));
            };
            this.heightmapTerrain = terrain;
            break;
        }
    }

    private initStreamedBuildings(): void {
        const scene = this.ctx.getActiveScene();
        if (!scene || !this.ctx.engine) return;

        // Clean up any stale streamed-buildings entities restored from a
        // previous scene snapshot — the runtime re-spawns its own on init.
        for (const entity of [...scene.entities.values()]) {
            if (entity.hasTag('streamed_buildings_root') || entity.hasTag('streamed_buildings_chunk')) {
                scene.destroyEntity(entity.id);
            }
        }

        const pd = this.ctx.state.projectData;
        const scenes = pd?.scenes || {};
        for (const sceneData of Object.values(scenes) as any[]) {
            const cfg = sceneData?.streamedBuildings;
            if (!cfg?.assetBasePath) continue;
            const renderSystem = this.ctx.engine.globalContext.renderSystem;
            this.streamedBuildings = new StreamedBuildings(scene, renderSystem, {
                assetBasePath: cfg.assetBasePath,
                loadRadius: cfg.loadRadius,
                unloadRadius: cfg.unloadRadius,
                baseColor: cfg.baseColor,
            });
            break;
        }
    }

    // Roads share the streamedBuildings asset base — both read the same chunk
    // JSONs. We create the road atlas synchronously alongside buildings so
    // that by the time the heightmap terrain's onReady callback fires,
    // `this.streamedRoads.atlas.nearTexture/farTexture` already exist and can
    // be passed into applyTerrainTextures().
    private initStreamedRoads(): void {
        if (!this.ctx.engine) return;
        const device = this.ctx.engine.globalContext.renderSystem.getDevice();
        if (!device) return;

        const pd = this.ctx.state.projectData;
        const scenes = pd?.scenes || {};
        for (const sceneData of Object.values(scenes) as any[]) {
            const cfg = sceneData?.streamedBuildings;
            if (!cfg?.assetBasePath) continue;
            this.streamedRoads = new StreamedRoads(device, { assetBasePath: cfg.assetBasePath });
            break;
        }
    }

    private initStreamedProps(): void {
        const scene = this.ctx.getActiveScene();
        if (!scene || !this.ctx.engine) return;

        for (const entity of [...scene.entities.values()]) {
            if (entity.hasTag('streamed_props_root') || entity.hasTag('streamed_props_chunk')) {
                scene.destroyEntity(entity.id);
            }
        }

        const pd = this.ctx.state.projectData;
        const scenes = pd?.scenes || {};
        for (const sceneData of Object.values(scenes) as any[]) {
            const cfg = sceneData?.streamedBuildings;
            if (!cfg?.assetBasePath) continue;
            const renderSystem = this.ctx.engine.globalContext.renderSystem;
            this.streamedProps = new StreamedProps(scene, renderSystem, {
                assetBasePath: cfg.assetBasePath,
                loadRadius: cfg.loadRadius,
                unloadRadius: cfg.unloadRadius,
            });
            break;
        }
    }
}
