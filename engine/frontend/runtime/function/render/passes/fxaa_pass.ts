import { GPUResourceManager } from '../gpu_resource_manager.js';
import { ShaderLibrary } from '../shader_library.js';

/**
 * Full-screen FXAA anti-aliasing post-processing pass.
 * Reads from an offscreen color texture and writes to the target (swapchain).
 */
export class FXAAPass {
    private device: GPUDevice | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private bindGroupLayout: GPUBindGroupLayout | null = null;
    private sampler: GPUSampler | null = null;
    private paramsBuffer: GPUBuffer | null = null;
    private canvasWidth = 0;
    private canvasHeight = 0;

    private cachedBindGroup: GPUBindGroup | null = null;
    private cachedInputView: GPUTextureView | null = null;

    initialize(
        device: GPUDevice,
        resources: GPUResourceManager,
        shaderLib: ShaderLibrary,
        canvasFormat: GPUTextureFormat,
        width: number,
        height: number
    ): void {
        this.device = device;
        this.canvasWidth = width;
        this.canvasHeight = height;

        this.bindGroupLayout = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ], 'fxaa_bgl');

        this.sampler = device.createSampler({
            label: 'fxaa_sampler',
            magFilter: 'linear',
            minFilter: 'linear',
        });

        this.paramsBuffer = resources.createUniformBuffer(16, 'fxaa_params');
        this.uploadParams();

        this.pipeline = device.createRenderPipeline({
            label: 'fxaa_pipeline',
            layout: resources.createPipelineLayout([this.bindGroupLayout], 'fxaa_pl'),
            vertex: { module: shaderLib.getModule('fullscreen_vertex'), entryPoint: 'vs_main' },
            fragment: {
                module: shaderLib.getModule('fxaa_fragment'),
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat }],
            },
            primitive: { topology: 'triangle-list' },
        });
    }

    execute(
        commandEncoder: GPUCommandEncoder,
        targetView: GPUTextureView,
        inputTextureView: GPUTextureView
    ): void {
        if (!this.device || !this.pipeline || !this.bindGroupLayout) return;

        if (inputTextureView !== this.cachedInputView) {
            this.cachedBindGroup = this.device.createBindGroup({
                label: 'fxaa_bg',
                layout: this.bindGroupLayout,
                entries: [
                    { binding: 0, resource: inputTextureView },
                    { binding: 1, resource: this.sampler! },
                    { binding: 2, resource: { buffer: this.paramsBuffer! } },
                ],
            });
            this.cachedInputView = inputTextureView;
        }

        const renderPass = commandEncoder.beginRenderPass({
            label: 'fxaa_pass',
            colorAttachments: [{
                view: targetView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
            }],
        });

        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.cachedBindGroup!);
        renderPass.draw(3);
        renderPass.end();
    }

    onResize(width: number, height: number): void {
        this.canvasWidth = width;
        this.canvasHeight = height;
        this.uploadParams();
        this.cachedBindGroup = null;
        this.cachedInputView = null;
    }

    shutdown(): void {
        this.paramsBuffer?.destroy();
        this.paramsBuffer = null;
        this.cachedBindGroup = null;
        this.cachedInputView = null;
        this.pipeline = null;
        this.device = null;
    }

    private uploadParams(): void {
        if (!this.device || !this.paramsBuffer) return;
        this.device.queue.writeBuffer(this.paramsBuffer, 0, new Float32Array([this.canvasWidth, this.canvasHeight, 0, 0]));
    }
}
