/**
 * terrain_inline_loader.ts — Loads terrain textures + bakes splatmap
 * for AI-authored inline terrain specs (no external heightmap file).
 *
 * Reuses the same GPU texture format as terrain_texture_cache.ts
 * (everything_game) so the terrain shader works identically.
 */

import type { TerrainGpuTextures } from '../framework/components/terrain_component.js';
import { bakeSplatmap, type InlineTerrainSpec, type TerrainLayerSpec } from './terrain_baker.js';

const ASSET_BASE = '/assets/';
const TEX_SIZE = 1024;

async function fetchBitmap(url: string): Promise<ImageBitmap | null> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return createImageBitmap(await resp.blob());
    } catch {
        return null;
    }
}

// ── Mipmap pipeline (same as terrain_texture_cache.ts) ──────────

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

function generateMipmaps(device: GPUDevice, texture: GPUTexture, layerCount: number, mipCount: number): void {
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

// ── Main loader ─────────────────────────────────────────────────

export async function loadInlineTerrainTextures(
    device: GPUDevice,
    spec: InlineTerrainSpec,
    worldWidth: number,
    worldDepth: number,
): Promise<TerrainGpuTextures> {
    const layers = spec.layers.slice(0, 4);
    const count = layers.length;
    const mipCount = Math.floor(Math.log2(TEX_SIZE)) + 1;

    // Pad to 4 layers — unused layers get the first layer's texture
    const paddedLayers: TerrainLayerSpec[] = [];
    for (let i = 0; i < 4; i++) {
        paddedLayers.push(layers[i] ?? layers[0]);
    }

    // Fetch diffuse + normal bitmaps in parallel
    const diffBitmaps = await Promise.all(
        paddedLayers.map(l =>
            fetchBitmap(`${ASSET_BASE}poly_haven/textures/${l.dir}/${l.dir}_diff_1k.jpg`)
                .then(b => { if (!b) console.warn(`[InlineTerrain] missing diffuse: ${l.dir}`); return b; }))
    );
    const normBitmaps = await Promise.all(
        paddedLayers.map(l =>
            fetchBitmap(`${ASSET_BASE}poly_haven/textures/${l.dir}/${l.dir}_nor_gl_1k.jpg`)
                .then(b => { if (!b) console.warn(`[InlineTerrain] missing normal: ${l.dir}`); return b; }))
    );

    // Create 2D-array textures (4 layers)
    const arrayDesc = {
        size: [TEX_SIZE, TEX_SIZE, 4] as [number, number, number],
        mipLevelCount: mipCount,
        format: 'rgba8unorm' as GPUTextureFormat,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    };
    const diffuseArray = device.createTexture({ label: 'inline_terrain_diffuse', ...arrayDesc });
    const normalArray  = device.createTexture({ label: 'inline_terrain_normal',  ...arrayDesc });

    for (let i = 0; i < 4; i++) {
        if (diffBitmaps[i]) {
            device.queue.copyExternalImageToTexture({ source: diffBitmaps[i]! }, { texture: diffuseArray, origin: [0, 0, i] }, [TEX_SIZE, TEX_SIZE]);
            diffBitmaps[i]!.close();
        }
        if (normBitmaps[i]) {
            device.queue.copyExternalImageToTexture({ source: normBitmaps[i]! }, { texture: normalArray, origin: [0, 0, i] }, [TEX_SIZE, TEX_SIZE]);
            normBitmaps[i]!.close();
        }
    }

    generateMipmaps(device, diffuseArray, 4, mipCount);
    generateMipmaps(device, normalArray,  4, mipCount);

    // Layer props: vec4 per entry (8 entries = 128 bytes padded to 256)
    const layerProps = new Float32Array(8 * 4);
    for (let i = 0; i < 4; i++) {
        layerProps[i * 4] = 1.0 / paddedLayers[i].uvMetersPerTile;
    }
    // [5].xy = world extent, [5].zw = origin (centered at 0,0 for inline terrain)
    layerProps[5 * 4]     = worldWidth;
    layerProps[5 * 4 + 1] = worldDepth;
    layerProps[5 * 4 + 2] = -worldWidth / 2;
    layerProps[5 * 4 + 3] = -worldDepth / 2;
    // [6].xy = content extent (same as world extent for inline terrain)
    layerProps[6 * 4]     = worldWidth;
    layerProps[6 * 4 + 1] = worldDepth;

    // Bake splatmap from paints + paths
    const { data: splatData, resolution: splatRes } = bakeSplatmap(spec);

    // Upload splatmap directly — writeTexture avoids alpha premultiplication
    // that createImageBitmap applies (A=0 zeros out all channels for 3-layer maps)
    const groundTypeMap = device.createTexture({
        label: 'inline_terrain_splatmap',
        size: [splatRes, splatRes],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
        { texture: groundTypeMap },
        splatData.buffer,
        { offset: splatData.byteOffset, bytesPerRow: splatRes * 4, rowsPerImage: splatRes },
        [splatRes, splatRes],
    );

    return { diffuseArray, normalArray, layerProps, groundTypeMap };
}
