import { HeightmapTerrain } from '../../runtime/function/streaming/heightmap_terrain.js';
import { StreamedBuildings } from '../../../../everything_game/003_runtime/streaming/streamed_buildings.js';
import { StreamedRoads } from '../../../../everything_game/003_runtime/streaming/streamed_roads.js';
import { StreamedProps } from '../../../../everything_game/003_runtime/streaming/streamed_props.js';
import { loadTerrainTextureArrays } from '../../../../everything_game/003_runtime/streaming/terrain_texture_cache.js';
import { loadInlineTerrainTextures } from '../../runtime/function/streaming/terrain_inline_loader.js';
import { bakeSplatmap } from '../../runtime/function/streaming/terrain_baker.js';
import type { InlineTerrainSpec } from '../../runtime/function/streaming/terrain_baker.js';
import type { TerrainGpuTextures } from '../../runtime/function/framework/components/terrain_component.js';
import { RenderSystemWebGL2 } from '../../runtime/function/render/gl2/render_system_gl2.js';
import type { EditorContext } from './editor_context.js';

interface HeightmapTerrainSceneCfg {
    metaUrl?: string;
    baseColor?: [number, number, number, number];
    waterLevel?: number;
    // Inline terrain fields (AI-authored)
    size?: [number, number];
    layers?: InlineTerrainSpec['layers'];
    default_layer?: string;
    paints?: InlineTerrainSpec['paints'];
    paths?: InlineTerrainSpec['paths'];
    splatmap_resolution?: number;
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
        if (!scene) { console.warn('[Terrain] no active scene'); return; }

        // Clean up any stale heightmap-terrain entities restored from a
        // previous scene snapshot (the runtime re-spawns its own on init).
        for (const entity of [...scene.entities.values()]) {
            if (entity.hasTag('heightmap_terrain_root')) {
                scene.destroyEntity(entity.id);
            }
        }

        const pd = this.ctx.state.projectData;
        const scenes = pd?.scenes || {};
        console.log('[Terrain] scene count:', Object.keys(scenes).length);
        for (const sceneData of Object.values(scenes) as any[]) {
            const cfg = sceneData?.heightmapTerrain as HeightmapTerrainSceneCfg | undefined;
            console.log('[Terrain] heightmapTerrain cfg:', cfg ? Object.keys(cfg) : 'none');
            if (!cfg) continue;

            const isInline = !!(cfg.layers && cfg.size);
            console.log('[Terrain] isInline:', isInline, 'layers:', cfg.layers?.length, 'paths:', (cfg as any).paths?.length);

            if (!isInline && !cfg.metaUrl) continue;

            const terrain = isInline
                ? new HeightmapTerrain(scene, {
                    inline: {
                        worldWidth: cfg.size![0],
                        worldDepth: cfg.size![1],
                        resolution: 128,
                    },
                    baseColor: cfg.baseColor,
                    waterLevel: cfg.waterLevel,
                })
                : new HeightmapTerrain(scene, {
                    metaUrl: cfg.metaUrl!,
                    baseColor: cfg.baseColor,
                    waterLevel: cfg.waterLevel,
                });

            terrain.onReady = () => {
                console.log('[Terrain] onReady fired, isInline:', isInline);
                this.ctx.ensurePrimitiveMeshes();
                const device = this.ctx.engine?.globalContext.renderSystem.getDevice();
                if (!device) {
                    if (isInline) {
                        this.loadInlineTerrainTexturesGL2(terrain, cfg)
                            .catch(err => {
                                console.warn('[Terrain] GL2 full texture load failed, falling back:', err);
                                this.loadTerrainFallbackTexture(terrain, cfg);
                            });
                    } else {
                        this.loadTerrainFallbackTexture(terrain, cfg);
                    }
                    return;
                }

                if (isInline) {
                    const spec: InlineTerrainSpec = {
                        size: cfg.size!,
                        layers: cfg.layers!,
                        default_layer: cfg.default_layer ?? cfg.layers![0].name,
                        paints: cfg.paints,
                        paths: cfg.paths,
                        splatmap_resolution: cfg.splatmap_resolution,
                    };
                    loadInlineTerrainTextures(device, spec, terrain.worldWidth, terrain.worldDepth)
                        .then(arrays => terrain.applyTerrainTextures(arrays))
                        .catch(err => console.warn('[InlineTerrain] Failed to load textures:', err));
                } else {
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
                }
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

    private loadTerrainFallbackTexture(terrain: HeightmapTerrain, cfg: HeightmapTerrainSceneCfg): void {
        if (!this.ctx.engine) return;
        const renderSystem = this.ctx.engine.globalContext.renderSystem;
        const defaultLayer = cfg.layers?.[0];
        if (!defaultLayer) return;

        const url = `/assets/poly_haven/textures/${defaultLayer.dir}/${defaultLayer.dir}_diff_1k.jpg`;
        const uvScale = terrain.worldWidth / defaultLayer.uvMetersPerTile;

        fetch(url)
            .then(r => { if (!r.ok) throw new Error(r.statusText); return r.blob(); })
            .then(b => createImageBitmap(b))
            .then(bmp => {
                const tex = renderSystem.uploadTexture(bmp, {});
                bmp.close();
                terrain.setFallbackTexture(tex, uvScale);
            })
            .catch(err => console.warn('[Terrain] fallback texture failed:', err));
    }

    private async loadInlineTerrainTexturesGL2(terrain: HeightmapTerrain, cfg: HeightmapTerrainSceneCfg): Promise<void> {
        if (!this.ctx.engine || !cfg.layers || !cfg.size) return;
        const rs = this.ctx.engine.globalContext.renderSystem as RenderSystemWebGL2;
        const res = rs.getGL2ResourceManager();

        const ASSET_BASE = '/assets/';
        const layers = cfg.layers.slice(0, 4);
        const padded = [];
        for (let i = 0; i < 4; i++) padded.push(layers[i] ?? layers[0]);

        const fetchBmp = async (url: string): Promise<ImageBitmap | null> => {
            try {
                const r = await fetch(url);
                if (!r.ok) return null;
                return createImageBitmap(await r.blob());
            } catch { return null; }
        };

        const [diffBitmaps, normBitmaps] = await Promise.all([
            Promise.all(padded.map(l => fetchBmp(`${ASSET_BASE}poly_haven/textures/${l.dir}/${l.dir}_diff_1k.jpg`))),
            Promise.all(padded.map(l => fetchBmp(`${ASSET_BASE}poly_haven/textures/${l.dir}/${l.dir}_nor_gl_1k.jpg`))),
        ]);

        const diffuseArray = res.uploadTexture2DArray(diffBitmaps, { label: 'terrain_diffuse_gl2' });
        const normalArray = res.uploadTexture2DArray(normBitmaps, { label: 'terrain_normal_gl2' });

        for (const b of diffBitmaps) b?.close();
        for (const b of normBitmaps) b?.close();

        const layerProps = new Float32Array(8 * 4);
        for (let i = 0; i < 4; i++) layerProps[i * 4] = 1.0 / padded[i].uvMetersPerTile;
        layerProps[5 * 4]     = terrain.worldWidth;
        layerProps[5 * 4 + 1] = terrain.worldDepth;
        layerProps[5 * 4 + 2] = -terrain.worldWidth / 2;
        layerProps[5 * 4 + 3] = -terrain.worldDepth / 2;
        layerProps[6 * 4]     = terrain.worldWidth;
        layerProps[6 * 4 + 1] = terrain.worldDepth;

        const spec: InlineTerrainSpec = {
            size: cfg.size,
            layers: cfg.layers,
            default_layer: cfg.default_layer ?? cfg.layers[0].name,
            paints: cfg.paints,
            paths: cfg.paths,
            splatmap_resolution: cfg.splatmap_resolution,
        };
        const { data: splatData, resolution: splatRes } = bakeSplatmap(spec);
        const groundTypeMap = res.uploadTexture2DFromRawRGBA(splatData, splatRes, splatRes, { label: 'terrain_splatmap_gl2' });

        const textures: TerrainGpuTextures = {
            diffuseArray: diffuseArray as unknown as GPUTexture,
            normalArray: normalArray as unknown as GPUTexture,
            layerProps,
            groundTypeMap: groundTypeMap as unknown as GPUTexture,
        };
        terrain.applyTerrainTextures(textures);
    }
}
