/**
 * terrain_texture_cache.ts — Loads Poly Haven ground textures for terrain.
 *
 * Packs 4 tiling PBR ground layers (diffuse + normal) into texture_2d_arrays,
 * blended by elevation (and optionally by a ground-type weight map) in the
 * terrain shader. Also loads sidewalk concrete and an optional NAIP weight map.
 */

import type { TerrainGpuTextures } from '../../../engine/frontend/runtime/function/framework/components/terrain_component.js';

interface GroundEntry {
    dir: string;
    /** Texture repeat: 1 / uvMetersPerTile = UV scale passed to shader. */
    uvMetersPerTile: number;
}

const GROUND_LAYERS: GroundEntry[] = [
    { dir: 'coast_sand_01',     uvMetersPerTile: 8  },  // layer 0: beach sand
    { dir: 'leafy_grass',       uvMetersPerTile: 6  },  // layer 1: lowland grass
    { dir: 'aerial_grass_rock', uvMetersPerTile: 10 },  // layer 2: hillside grass/rock
    { dir: 'rocky_terrain',     uvMetersPerTile: 12 },  // layer 3: mountain rock
];

async function fetchBitmap(url: string): Promise<ImageBitmap | null> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return createImageBitmap(await resp.blob());
    } catch {
        return null;
    }
}

// Box-downsample pipeline, cached per GPUDevice. Hoisted so we don't rebuild
// shader module / bind-group layout / pipeline on every texture upload.
interface MipmapPipeline {
    pipeline: GPURenderPipeline;
    bgl: GPUBindGroupLayout;
    sampler: GPUSampler;
}
const mipmapPipelineCache = new WeakMap<GPUDevice, MipmapPipeline>();

function getMipmapPipeline(device: GPUDevice): MipmapPipeline {
    let cached = mipmapPipelineCache.get(device);
    if (cached) return cached;

    const module = device.createShaderModule({
        code: /* wgsl */ `
            @group(0) @binding(0) var src: texture_2d<f32>;
            @group(0) @binding(1) var smp: sampler;
            struct V { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
            @vertex fn vs(@builtin(vertex_index) i: u32) -> V {
                let x = f32((i << 1u) & 2u); let y = f32(i & 2u);
                return V(vec4(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0), vec2(x, 1.0 - y));
            }
            @fragment fn fs(v: V) -> @location(0) vec4<f32> {
                return textureSample(src, smp, v.uv);
            }
        `,
    });
    const bgl = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ]});
    const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
    });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    cached = { pipeline, bgl, sampler };
    mipmapPipelineCache.set(device, cached);
    return cached;
}

function generateMipmaps(
    device: GPUDevice,
    texture: GPUTexture,
    layerCount: number,
    mipCount: number,
): void {
    const { pipeline, bgl, sampler } = getMipmapPipeline(device);
    const enc = device.createCommandEncoder();
    for (let layer = 0; layer < layerCount; layer++) {
        for (let mip = 1; mip < mipCount; mip++) {
            const src = texture.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: mip - 1, mipLevelCount: 1 });
            const dst = texture.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1, baseMipLevel: mip, mipLevelCount: 1 });
            const bg = device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: src }, { binding: 1, resource: sampler }] });
            const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst, loadOp: 'clear', storeOp: 'store' }] });
            pass.setPipeline(pipeline); pass.setBindGroup(0, bg); pass.draw(3); pass.end();
        }
    }
    device.queue.submit([enc.finish()]);
}

const ASSET_BASE = '/assets/';

/**
 * Geometry describing where the splatmap and the road atlas live in world
 * space. The splatmap covers the full extended terrain; the road atlas only
 * covers the OSM content sub-region (so we mask its sampling outside that).
 */
export interface TerrainGeometry {
    /** Full heightmap extent in meters (extended bbox). */
    worldWidth: number;
    worldDepth: number;
    /** World-space NW corner of the heightmap (typically negative when the
     *  OSM content sits at world origin). */
    originX: number;
    originZ: number;
    /** Extent of the OSM content sub-region in meters. The road atlas / OSM
     *  decals are masked to this region in the shader. */
    contentWidth: number;
    contentDepth: number;
}

/**
 * Load all terrain ground textures and pack them into GPU texture arrays.
 *
 * `geometry` is written into layerProps so the terrain shader can map a
 * world XZ position to splatmap UV (full extended bbox) and detect when a
 * fragment is outside the OSM content (mask the road atlas there).
 */
export async function loadTerrainTextureArrays(
    device: GPUDevice,
    geometry?: TerrainGeometry,
): Promise<TerrainGpuTextures> {
    const count = GROUND_LAYERS.length;
    const TEX_SIZE = 1024;
    const mipCount = Math.floor(Math.log2(TEX_SIZE)) + 1;

    // Fetch all bitmaps in parallel
    const diffBitmaps = await Promise.all(
        GROUND_LAYERS.map(e => fetchBitmap(`${ASSET_BASE}poly_haven/textures/${e.dir}/${e.dir}_diff_1k.jpg`)
            .then(b => { if (!b) console.warn(`[TerrainTextures] missing diffuse: ${e.dir}`); return b; }))
    );
    const normBitmaps = await Promise.all(
        GROUND_LAYERS.map(e => fetchBitmap(`${ASSET_BASE}poly_haven/textures/${e.dir}/${e.dir}_nor_gl_1k.jpg`)
            .then(b => { if (!b) console.warn(`[TerrainTextures] missing normal: ${e.dir}`); return b; }))
    );

    const arrayDesc = {
        size: [TEX_SIZE, TEX_SIZE, count] as [number, number, number],
        mipLevelCount: mipCount,
        format: 'rgba8unorm' as GPUTextureFormat,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    };
    const diffuseArray = device.createTexture({ label: 'terrain_ground_diffuse', ...arrayDesc });
    const normalArray  = device.createTexture({ label: 'terrain_ground_normal',  ...arrayDesc });

    for (let i = 0; i < count; i++) {
        const bmpD = diffBitmaps[i];
        const bmpN = normBitmaps[i];
        if (bmpD) {
            device.queue.copyExternalImageToTexture({ source: bmpD }, { texture: diffuseArray, origin: [0, 0, i] }, [TEX_SIZE, TEX_SIZE]);
            bmpD.close();
        }
        if (bmpN) {
            device.queue.copyExternalImageToTexture({ source: bmpN }, { texture: normalArray,  origin: [0, 0, i] }, [TEX_SIZE, TEX_SIZE]);
            bmpN.close();
        }
    }

    generateMipmaps(device, diffuseArray, count, mipCount);
    generateMipmaps(device, normalArray,  count, mipCount);

    // layerProps layout (vec4 per entry, 8 entries = 128 bytes, padded to 256):
    //   [0..3].x = UV scale (= 1 / uvMetersPerTile) for ground layers 0-3
    //   [5].xy   = full heightmap extent in metres (splatmap UV denominator)
    //   [5].zw   = heightmap NW-corner origin in world coords (UV offset)
    //   [6].xy   = OSM content extent in metres (road-atlas mask denominator)
    //              .zw is reserved (OSM content is pinned at world origin).
    const layerProps = new Float32Array(8 * 4);
    for (let i = 0; i < count; i++) {
        layerProps[i * 4] = 1.0 / GROUND_LAYERS[i].uvMetersPerTile;
    }
    if (geometry) {
        layerProps[5 * 4]     = geometry.worldWidth;
        layerProps[5 * 4 + 1] = geometry.worldDepth;
        layerProps[5 * 4 + 2] = geometry.originX;
        layerProps[5 * 4 + 3] = geometry.originZ;
        layerProps[6 * 4]     = geometry.contentWidth;
        layerProps[6 * 4 + 1] = geometry.contentDepth;
    }

    // Sidewalk concrete (optional, falls back to white/flat in shader)
    const [swDiffBmp, swNormBmp] = await Promise.all([
        fetchBitmap(`${ASSET_BASE}poly_haven/textures/brushed_concrete/brushed_concrete_diff_1k.jpg`),
        fetchBitmap(`${ASSET_BASE}poly_haven/textures/brushed_concrete/brushed_concrete_nor_gl_1k.jpg`),
    ]);

    const sw2dDesc = {
        size: [TEX_SIZE, TEX_SIZE] as [number, number],
        mipLevelCount: mipCount,
        format: 'rgba8unorm' as GPUTextureFormat,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    };
    const sidewalkDiffuse = device.createTexture({ label: 'sidewalk_diffuse', ...sw2dDesc });
    const sidewalkNormal  = device.createTexture({ label: 'sidewalk_normal',  ...sw2dDesc });

    if (swDiffBmp) { device.queue.copyExternalImageToTexture({ source: swDiffBmp }, { texture: sidewalkDiffuse }, [TEX_SIZE, TEX_SIZE]); swDiffBmp.close(); }
    if (swNormBmp) { device.queue.copyExternalImageToTexture({ source: swNormBmp }, { texture: sidewalkNormal  }, [TEX_SIZE, TEX_SIZE]); swNormBmp.close(); }
    generateMipmaps(device, sidewalkDiffuse, 1, mipCount);
    generateMipmaps(device, sidewalkNormal,  1, mipCount);

    // Ground-type weight map — optional NAIP-derived RGBA texture.
    // R=sand, G=grass, B=grass/rock, A=rock weight per pixel.
    // Falls back to height-based weights in shader when absent.
    let groundTypeMap: GPUTexture | undefined;
    try {
        const metaResp = await fetch(`${ASSET_BASE}official/everything_game/terrain/ground_type_map_meta.json`);
        if (metaResp.ok) {
            const meta = await metaResp.json() as { width: number; height: number };
            const binResp = await fetch(`${ASSET_BASE}official/everything_game/terrain/ground_type_map.bin`);
            if (binResp.ok) {
                const raw = new Uint8Array(await binResp.arrayBuffer());
                const canvas = new OffscreenCanvas(meta.width, meta.height);
                const ctx2d = canvas.getContext('2d')!;
                const imgData = ctx2d.createImageData(meta.width, meta.height);
                imgData.data.set(raw);
                ctx2d.putImageData(imgData, 0, 0);
                const bmp = await createImageBitmap(canvas);
                groundTypeMap = device.createTexture({
                    label: 'ground_type_map',
                    size: [meta.width, meta.height],
                    format: 'rgba8unorm',
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
                });
                device.queue.copyExternalImageToTexture({ source: bmp }, { texture: groundTypeMap }, [meta.width, meta.height]);
                bmp.close();
            }
        }
    } catch {
        // Not available — shader falls back to height+slope weights
    }

    return { diffuseArray, normalArray, layerProps, sidewalkDiffuse, sidewalkNormal, groundTypeMap };
}
