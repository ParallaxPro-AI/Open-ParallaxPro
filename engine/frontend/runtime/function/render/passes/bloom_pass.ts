import { GPUResourceManager } from '../gpu_resource_manager.js';
import { ShaderLibrary } from '../shader_library.js';
import { RenderStats } from '../render_stats.js';

/**
 * Multi-step bloom post-processing.
 * 1. Extract bright pixels to quarter-res texture
 * 2. Two-pass separable Gaussian blur at quarter-res
 * 3. Additive composite bloom onto scene
 */
export class BloomPass {
    private stats: RenderStats | null = null;
    setStats(stats: RenderStats): void { this.stats = stats; }

    private device: GPUDevice | null = null;
    private canvasFormat: GPUTextureFormat = 'bgra8unorm';
    private canvasWidth = 0;
    private canvasHeight = 0;

    private extractPipeline: GPURenderPipeline | null = null;
    private blurPipeline: GPURenderPipeline | null = null;
    private compositePipeline: GPURenderPipeline | null = null;

    private extractBGL: GPUBindGroupLayout | null = null;
    private blurBGL: GPUBindGroupLayout | null = null;
    private compositeBGL: GPUBindGroupLayout | null = null;

    private extractParamsBuffer: GPUBuffer | null = null;
    private blurParamsBufferH: GPUBuffer | null = null;
    private blurParamsBufferV: GPUBuffer | null = null;
    private compositeParamsBuffer: GPUBuffer | null = null;

    private bloomTexA: GPUTexture | null = null;
    private bloomTexAView: GPUTextureView | null = null;
    private bloomTexB: GPUTexture | null = null;
    private bloomTexBView: GPUTextureView | null = null;

    private outputTexture: GPUTexture | null = null;
    private outputTextureView: GPUTextureView | null = null;

    private sampler: GPUSampler | null = null;

    // Bind group caching: the extract step's input changes (inputColorView from scene),
    // while internal steps use stable textures (bloomTexAView, bloomTexBView).
    private cachedExtractBG: GPUBindGroup | null = null;
    private cachedExtractInputView: GPUTextureView | null = null;
    private cachedBlurHBG: GPUBindGroup | null = null;
    private cachedBlurVBG: GPUBindGroup | null = null;
    private cachedCompositeBG: GPUBindGroup | null = null;
    private cachedCompositeInputView: GPUTextureView | null = null;

    initialize(
        device: GPUDevice,
        resources: GPUResourceManager,
        shaderLib: ShaderLibrary,
        canvasFormat: GPUTextureFormat,
        width: number,
        height: number
    ): void {
        this.device = device;
        this.canvasFormat = canvasFormat;
        this.canvasWidth = width;
        this.canvasHeight = height;

        this.sampler = device.createSampler({
            label: 'bloom_sampler',
            magFilter: 'linear',
            minFilter: 'linear',
        });

        this.extractBGL = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ], 'bloom_extract_bgl');

        this.blurBGL = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ], 'bloom_blur_bgl');

        this.compositeBGL = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ], 'bloom_composite_bgl');

        this.extractParamsBuffer = resources.createUniformBuffer(16, 'bloom_extract_params');
        this.blurParamsBufferH = resources.createUniformBuffer(16, 'bloom_blur_params_h');
        this.blurParamsBufferV = resources.createUniformBuffer(16, 'bloom_blur_params_v');
        this.compositeParamsBuffer = resources.createUniformBuffer(16, 'bloom_composite_params');

        device.queue.writeBuffer(this.extractParamsBuffer, 0, new Float32Array([0.8, 0.3, 0, 0]));
        device.queue.writeBuffer(this.compositeParamsBuffer, 0, new Float32Array([0.3, 0, 0, 0]));

        const fsVertex = shaderLib.getModule('fullscreen_vertex');

        this.extractPipeline = device.createRenderPipeline({
            label: 'bloom_extract_pipeline',
            layout: resources.createPipelineLayout([this.extractBGL], 'bloom_extract_pl'),
            vertex: { module: fsVertex, entryPoint: 'vs_main' },
            fragment: {
                module: shaderLib.getModule('bloom_extract_fragment'),
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat }],
            },
            primitive: { topology: 'triangle-list' },
        });

        this.blurPipeline = device.createRenderPipeline({
            label: 'bloom_blur_pipeline',
            layout: resources.createPipelineLayout([this.blurBGL], 'bloom_blur_pl'),
            vertex: { module: fsVertex, entryPoint: 'vs_main' },
            fragment: {
                module: shaderLib.getModule('bloom_blur_fragment'),
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat }],
            },
            primitive: { topology: 'triangle-list' },
        });

        this.compositePipeline = device.createRenderPipeline({
            label: 'bloom_composite_pipeline',
            layout: resources.createPipelineLayout([this.compositeBGL], 'bloom_composite_pl'),
            vertex: { module: fsVertex, entryPoint: 'vs_main' },
            fragment: {
                module: shaderLib.getModule('bloom_composite_fragment'),
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat }],
            },
            primitive: { topology: 'triangle-list' },
        });

        this.recreateTextures(width, height);
    }

    execute(commandEncoder: GPUCommandEncoder, inputColorView: GPUTextureView): void {
        if (!this.device || !this.extractPipeline || !this.blurPipeline || !this.compositePipeline) return;
        if (!this.bloomTexAView || !this.bloomTexBView || !this.outputTextureView) return;

        const clearValue = { r: 0, g: 0, b: 0, a: 1 };

        // Step 1: Extract bright pixels -> bloomTexA (quarter-res)
        if (inputColorView !== this.cachedExtractInputView) {
            this.cachedExtractBG = this.device.createBindGroup({
                label: 'bloom_extract_bg', layout: this.extractBGL!,
                entries: [
                    { binding: 0, resource: { buffer: this.extractParamsBuffer! } },
                    { binding: 1, resource: inputColorView },
                    { binding: 2, resource: this.sampler! },
                ],
            });
            this.cachedExtractInputView = inputColorView;
        }
        this.runFullscreenPass(commandEncoder, 'bloom_extract_pass', this.extractPipeline,
            this.bloomTexAView, clearValue, this.cachedExtractBG!);

        // Step 2: Horizontal blur bloomTexA -> bloomTexB (internal textures are stable)
        if (!this.cachedBlurHBG) {
            this.cachedBlurHBG = this.device.createBindGroup({
                label: 'bloom_blur_h_bg', layout: this.blurBGL!,
                entries: [
                    { binding: 0, resource: { buffer: this.blurParamsBufferH! } },
                    { binding: 1, resource: this.bloomTexAView },
                    { binding: 2, resource: this.sampler! },
                ],
            });
        }
        this.runFullscreenPass(commandEncoder, 'bloom_blur_h_pass', this.blurPipeline,
            this.bloomTexBView, clearValue, this.cachedBlurHBG);

        // Step 3: Vertical blur bloomTexB -> bloomTexA (internal textures are stable)
        if (!this.cachedBlurVBG) {
            this.cachedBlurVBG = this.device.createBindGroup({
                label: 'bloom_blur_v_bg', layout: this.blurBGL!,
                entries: [
                    { binding: 0, resource: { buffer: this.blurParamsBufferV! } },
                    { binding: 1, resource: this.bloomTexBView },
                    { binding: 2, resource: this.sampler! },
                ],
            });
        }
        this.runFullscreenPass(commandEncoder, 'bloom_blur_v_pass', this.blurPipeline,
            this.bloomTexAView, clearValue, this.cachedBlurVBG);

        // Step 4: Composite scene + bloom -> outputTexture
        if (inputColorView !== this.cachedCompositeInputView) {
            this.cachedCompositeBG = this.device.createBindGroup({
                label: 'bloom_composite_bg', layout: this.compositeBGL!,
                entries: [
                    { binding: 0, resource: { buffer: this.compositeParamsBuffer! } },
                    { binding: 1, resource: inputColorView },
                    { binding: 2, resource: this.bloomTexAView },
                    { binding: 3, resource: this.sampler! },
                ],
            });
            this.cachedCompositeInputView = inputColorView;
        }
        this.runFullscreenPass(commandEncoder, 'bloom_composite_pass', this.compositePipeline,
            this.outputTextureView, clearValue, this.cachedCompositeBG!);
    }

    getOutputTextureView(): GPUTextureView | null {
        return this.outputTextureView;
    }

    onResize(width: number, height: number): void {
        this.canvasWidth = width;
        this.canvasHeight = height;
        this.recreateTextures(width, height);
    }

    shutdown(): void {
        this.extractParamsBuffer?.destroy();
        this.blurParamsBufferH?.destroy();
        this.blurParamsBufferV?.destroy();
        this.compositeParamsBuffer?.destroy();
        this.bloomTexA?.destroy();
        this.bloomTexB?.destroy();
        this.outputTexture?.destroy();
        this.extractParamsBuffer = null;
        this.blurParamsBufferH = null;
        this.blurParamsBufferV = null;
        this.compositeParamsBuffer = null;
        this.bloomTexA = null;
        this.bloomTexB = null;
        this.outputTexture = null;
        this.outputTextureView = null;
        this.invalidateBindGroupCache();
        this.extractPipeline = null;
        this.blurPipeline = null;
        this.compositePipeline = null;
        this.device = null;
    }

    private recreateTextures(width: number, height: number): void {
        if (!this.device) return;

        this.bloomTexA?.destroy();
        this.bloomTexB?.destroy();
        this.outputTexture?.destroy();

        const qw = Math.max(Math.floor(width / 4), 1);
        const qh = Math.max(Math.floor(height / 4), 1);
        const texUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;

        this.bloomTexA = this.device.createTexture({ label: 'bloom_tex_a', size: [qw, qh], format: this.canvasFormat, usage: texUsage });
        this.bloomTexAView = this.bloomTexA.createView();

        this.bloomTexB = this.device.createTexture({ label: 'bloom_tex_b', size: [qw, qh], format: this.canvasFormat, usage: texUsage });
        this.bloomTexBView = this.bloomTexB.createView();

        this.outputTexture = this.device.createTexture({ label: 'bloom_output', size: [width, height], format: this.canvasFormat, usage: texUsage });
        this.outputTextureView = this.outputTexture.createView();

        if (this.blurParamsBufferH && this.blurParamsBufferV) {
            this.device.queue.writeBuffer(this.blurParamsBufferH, 0, new Float32Array([1, 0, 1.0 / qw, 1.0 / qh]));
            this.device.queue.writeBuffer(this.blurParamsBufferV, 0, new Float32Array([0, 1, 1.0 / qw, 1.0 / qh]));
        }

        // Internal textures changed, invalidate all cached bind groups
        this.invalidateBindGroupCache();
    }

    private invalidateBindGroupCache(): void {
        this.cachedExtractBG = null;
        this.cachedExtractInputView = null;
        this.cachedBlurHBG = null;
        this.cachedBlurVBG = null;
        this.cachedCompositeBG = null;
        this.cachedCompositeInputView = null;
    }

    private runFullscreenPass(
        commandEncoder: GPUCommandEncoder,
        label: string,
        pipeline: GPURenderPipeline,
        targetView: GPUTextureView,
        clearValue: GPUColor,
        bindGroup: GPUBindGroup
    ): void {
        const pass = commandEncoder.beginRenderPass({
            label,
            colorAttachments: [{ view: targetView, loadOp: 'clear', storeOp: 'store', clearValue }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
        this.stats?.addDraw(1);
    }
}
