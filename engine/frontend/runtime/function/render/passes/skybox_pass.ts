import { GPUResourceManager } from '../gpu_resource_manager.js';
import { ShaderLibrary } from '../shader_library.js';
import { RenderCamera } from '../render_scene.js';

const SKYBOX_UNIFORM_SIZE = 96;

/**
 * Procedural sky rendering post-processing pass.
 * Identifies sky pixels (linearDepth == 0) in the normalDepth texture
 * and replaces them with a procedural sky gradient with sun disc and stars.
 */
export class SkyboxPass {
    private device: GPUDevice | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private bindGroupLayout: GPUBindGroupLayout | null = null;
    private sampler: GPUSampler | null = null;
    private paramsBuffer: GPUBuffer | null = null;
    private outputTexture: GPUTexture | null = null;
    private outputTextureView: GPUTextureView | null = null;
    private canvasFormat: GPUTextureFormat = 'bgra8unorm';

    private cachedBindGroup: GPUBindGroup | null = null;
    private cachedColorView: GPUTextureView | null = null;
    private cachedNormalDepthView: GPUTextureView | null = null;

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

        this.bindGroupLayout = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ], 'skybox_bgl');

        this.sampler = device.createSampler({
            label: 'skybox_sampler',
            magFilter: 'linear',
            minFilter: 'linear',
        });

        this.paramsBuffer = resources.createUniformBuffer(SKYBOX_UNIFORM_SIZE, 'skybox_params');

        this.pipeline = device.createRenderPipeline({
            label: 'skybox_pipeline',
            layout: resources.createPipelineLayout([this.bindGroupLayout], 'skybox_pl'),
            vertex: { module: shaderLib.getModule('fullscreen_vertex'), entryPoint: 'vs_main' },
            fragment: {
                module: shaderLib.getModule('skybox_fragment'),
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat }],
            },
            primitive: { topology: 'triangle-list' },
        });

        this.recreateOutputTexture(width, height);
    }

    execute(
        commandEncoder: GPUCommandEncoder,
        colorTextureView: GPUTextureView,
        normalDepthTextureView: GPUTextureView,
        camera: RenderCamera,
        timeOfDay: number
    ): void {
        if (!this.device || !this.pipeline || !this.bindGroupLayout || !this.outputTextureView) return;

        this.uploadParams(camera, timeOfDay);

        if (colorTextureView !== this.cachedColorView || normalDepthTextureView !== this.cachedNormalDepthView) {
            this.cachedBindGroup = this.device.createBindGroup({
                label: 'skybox_bg',
                layout: this.bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.paramsBuffer! } },
                    { binding: 1, resource: colorTextureView },
                    { binding: 2, resource: normalDepthTextureView },
                    { binding: 3, resource: this.sampler! },
                ],
            });
            this.cachedColorView = colorTextureView;
            this.cachedNormalDepthView = normalDepthTextureView;
        }

        const renderPass = commandEncoder.beginRenderPass({
            label: 'skybox_pass',
            colorAttachments: [{
                view: this.outputTextureView,
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

    getOutputTextureView(): GPUTextureView | null {
        return this.outputTextureView;
    }

    onResize(width: number, height: number): void {
        this.recreateOutputTexture(width, height);
        this.cachedBindGroup = null;
        this.cachedColorView = null;
        this.cachedNormalDepthView = null;
    }

    shutdown(): void {
        this.paramsBuffer?.destroy();
        this.paramsBuffer = null;
        this.outputTexture?.destroy();
        this.outputTexture = null;
        this.outputTextureView = null;
        this.cachedBindGroup = null;
        this.cachedColorView = null;
        this.cachedNormalDepthView = null;
        this.pipeline = null;
        this.device = null;
    }

    private recreateOutputTexture(width: number, height: number): void {
        if (!this.device) return;
        this.outputTexture?.destroy();
        this.outputTexture = this.device.createTexture({
            label: 'skybox_output',
            size: [width, height],
            format: this.canvasFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.outputTextureView = this.outputTexture.createView();
    }

    private uploadParams(camera: RenderCamera, timeOfDay: number): void {
        if (!this.device || !this.paramsBuffer) return;
        const data = new Float32Array(24);

        // Inverse view-projection matrix
        const vp = camera.projectionMatrix.multiply(camera.viewMatrix);
        const invVP = vp.inverse();
        if (invVP) data.set(invVP.data, 0);

        // Sun direction from time of day (6=sunrise, 12=noon, 18=sunset, 0/24=midnight)
        const hourAngle = ((timeOfDay - 6) / 24) * Math.PI * 2;
        const sunY = Math.sin(hourAngle);
        const sunX = Math.cos(hourAngle);
        const sunZ = 0.2;
        const len = Math.sqrt(sunX * sunX + sunY * sunY + sunZ * sunZ);

        data[16] = sunX / len;
        data[17] = sunY / len;
        data[18] = sunZ / len;
        data[19] = sunY / len; // sunElevation

        this.device.queue.writeBuffer(this.paramsBuffer, 0, data);
    }
}
