/**
 * Centralized GPU resource creation and management.
 * Handles buffer/texture allocation, mipmap generation, and bind group creation.
 */
export class GPUResourceManager {
    device: GPUDevice | null = null;
    private nextId = 0;
    private mipmapPipeline: GPURenderPipeline | null = null;
    private mipmapSampler: GPUSampler | null = null;

    initialize(device: GPUDevice): void {
        this.device = device;
    }

    getDevice(): GPUDevice {
        if (!this.device) throw new Error('GPUResourceManager not initialized');
        return this.device;
    }

    createBuffer(
        size: number,
        usage: GPUBufferUsageFlags,
        label?: string,
        mappedAtCreation?: boolean
    ): GPUBuffer {
        const device = this.getDevice();
        const alignedSize = Math.max(Math.ceil(size / 4) * 4, 4);
        return device.createBuffer({
            label: label ?? `buffer_${this.nextId++}`,
            size: alignedSize,
            usage,
            mappedAtCreation: mappedAtCreation ?? false,
        });
    }

    createUniformBuffer(size: number, label?: string): GPUBuffer {
        const alignedSize = Math.ceil(size / 256) * 256;
        return this.createBuffer(
            alignedSize,
            GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label ?? `uniform_${this.nextId++}`
        );
    }

    createVertexBuffer(data: Float32Array | Uint16Array | Uint32Array, label?: string): GPUBuffer {
        const buffer = this.createBuffer(
            data.byteLength,
            GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            label ?? `vertex_${this.nextId++}`
        );
        this.getDevice().queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
        return buffer;
    }

    createIndexBuffer(data: Uint16Array | Uint32Array, label?: string): GPUBuffer {
        const buffer = this.createBuffer(
            data.byteLength,
            GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            label ?? `index_${this.nextId++}`
        );
        this.getDevice().queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
        return buffer;
    }

    writeBuffer(buffer: GPUBuffer, offset: number, data: ArrayBufferView): void {
        this.getDevice().queue.writeBuffer(buffer, offset, data.buffer, data.byteOffset, data.byteLength);
    }

    createTexture2D(
        width: number,
        height: number,
        format: GPUTextureFormat = 'rgba8unorm',
        usage?: GPUTextureUsageFlags,
        label?: string
    ): GPUTexture {
        return this.getDevice().createTexture({
            label: label ?? `texture_${this.nextId++}`,
            size: { width, height, depthOrArrayLayers: 1 },
            format,
            usage: usage ?? (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT),
        });
    }

    createDepthTexture(width: number, height: number, label?: string): GPUTexture {
        return this.createTexture2D(
            width, height,
            'depth24plus',
            GPUTextureUsage.RENDER_ATTACHMENT,
            label ?? 'depth_texture'
        );
    }

    uploadTextureFromBitmap(imageBitmap: ImageBitmap, params?: {
        format?: GPUTextureFormat;
        generateMipmaps?: boolean;
        label?: string;
    }): GPUTexture {
        const device = this.getDevice();
        const format = params?.format ?? 'rgba8unorm';
        const w = imageBitmap.width;
        const h = imageBitmap.height;
        const mipCount = params?.generateMipmaps
            ? Math.floor(Math.log2(Math.max(w, h))) + 1
            : 1;

        const texture = device.createTexture({
            label: params?.label ?? `tex_bitmap_${this.nextId++}`,
            size: { width: w, height: h },
            format,
            mipLevelCount: mipCount,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        device.queue.copyExternalImageToTexture(
            { source: imageBitmap },
            { texture },
            { width: w, height: h }
        );

        if (mipCount > 1) {
            this.generateMipmaps(device, texture, mipCount, format);
        }

        return texture;
    }

    createSampler(descriptor?: GPUSamplerDescriptor, label?: string): GPUSampler {
        return this.getDevice().createSampler({
            label: label ?? `sampler_${this.nextId++}`,
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat',
            ...descriptor,
        });
    }

    createBindGroupLayout(entries: GPUBindGroupLayoutEntry[], label?: string): GPUBindGroupLayout {
        return this.getDevice().createBindGroupLayout({
            label: label ?? `bgl_${this.nextId++}`,
            entries,
        });
    }

    createBindGroup(
        layout: GPUBindGroupLayout,
        entries: GPUBindGroupEntry[],
        label?: string
    ): GPUBindGroup {
        return this.getDevice().createBindGroup({
            label: label ?? `bg_${this.nextId++}`,
            layout,
            entries,
        });
    }

    createPipelineLayout(
        bindGroupLayouts: GPUBindGroupLayout[],
        label?: string
    ): GPUPipelineLayout {
        return this.getDevice().createPipelineLayout({
            label: label ?? `pl_${this.nextId++}`,
            bindGroupLayouts,
        });
    }

    shutdown(): void {
        this.device = null;
    }

    private generateMipmaps(
        device: GPUDevice,
        texture: GPUTexture,
        mipCount: number,
        format: GPUTextureFormat
    ): void {
        if (!this.mipmapPipeline) {
            const module = device.createShaderModule({ code: `
                @group(0) @binding(0) var srcTex: texture_2d<f32>;
                @group(0) @binding(1) var srcSampler: sampler;
                struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
                @vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
                    var p = array<vec2<f32>, 3>(vec2(-1.0,-1.0), vec2(3.0,-1.0), vec2(-1.0,3.0));
                    var out: VSOut;
                    out.pos = vec4(p[i], 0.0, 1.0);
                    out.uv = vec2(p[i].x * 0.5 + 0.5, 1.0 - (p[i].y * 0.5 + 0.5));
                    return out;
                }
                @fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
                    return textureSample(srcTex, srcSampler, in.uv);
                }
            ` });
            this.mipmapSampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
            this.mipmapPipeline = device.createRenderPipeline({
                layout: 'auto',
                vertex: { module, entryPoint: 'vs' },
                fragment: { module, entryPoint: 'fs', targets: [{ format }] },
            });
        }

        const pipeline = this.mipmapPipeline;
        const sampler = this.mipmapSampler!;
        const encoder = device.createCommandEncoder({ label: 'mipgen' });

        for (let level = 1; level < mipCount; level++) {
            const srcView = texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 });
            const dstView = texture.createView({ baseMipLevel: level, mipLevelCount: 1 });
            const bg = device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: srcView },
                    { binding: 1, resource: sampler },
                ],
            });
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: dstView,
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
            });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bg);
            pass.draw(3);
            pass.end();
        }

        device.queue.submit([encoder.finish()]);
    }
}
