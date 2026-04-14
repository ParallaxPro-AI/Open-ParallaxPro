import { Mat4 } from '../../../core/math/mat4.js';
import { GPUResourceManager } from '../gpu_resource_manager.js';
import { ShaderLibrary } from '../shader_library.js';
import { RenderCamera } from '../render_scene.js';
import { RenderStats } from '../render_stats.js';

const HBAO_UNIFORM_SIZE = 224;

/**
 * Horizon-Based Ambient Occlusion post-processing pass.
 * Reads color + normal/depth textures, outputs AO-modulated color.
 */
export class HBAOPass {
    private stats: RenderStats | null = null;
    setStats(stats: RenderStats): void { this.stats = stats; }

    private device: GPUDevice | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private bindGroupLayout: GPUBindGroupLayout | null = null;
    private sampler: GPUSampler | null = null;
    private paramsBuffer: GPUBuffer | null = null;
    private outputTexture: GPUTexture | null = null;
    private outputTextureView: GPUTextureView | null = null;
    private canvasWidth = 0;
    private canvasHeight = 0;
    private canvasFormat: GPUTextureFormat = 'bgra8unorm';

    private cachedBindGroup: GPUBindGroup | null = null;
    private cachedColorView: GPUTextureView | null = null;
    private cachedDepthView: GPUTextureView | null = null;

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
        this.canvasFormat = canvasFormat;

        this.bindGroupLayout = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ], 'hbao_bgl');

        this.sampler = device.createSampler({
            label: 'hbao_sampler',
            magFilter: 'linear',
            minFilter: 'linear',
        });

        this.paramsBuffer = resources.createUniformBuffer(HBAO_UNIFORM_SIZE, 'hbao_params');

        this.pipeline = device.createRenderPipeline({
            label: 'hbao_pipeline',
            layout: resources.createPipelineLayout([this.bindGroupLayout], 'hbao_pl'),
            vertex: { module: shaderLib.getModule('fullscreen_vertex'), entryPoint: 'vs_main' },
            fragment: {
                module: shaderLib.getModule('hbao_fragment'),
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
        depthTextureView: GPUTextureView,
        camera: RenderCamera
    ): void {
        if (!this.device || !this.pipeline || !this.bindGroupLayout || !this.outputTextureView) return;

        this.uploadParams(camera);

        if (colorTextureView !== this.cachedColorView || depthTextureView !== this.cachedDepthView) {
            this.cachedBindGroup = this.device.createBindGroup({
                label: 'hbao_bg',
                layout: this.bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.paramsBuffer! } },
                    { binding: 1, resource: colorTextureView },
                    { binding: 2, resource: depthTextureView },
                    { binding: 3, resource: this.sampler! },
                ],
            });
            this.cachedColorView = colorTextureView;
            this.cachedDepthView = depthTextureView;
        }

        const renderPass = commandEncoder.beginRenderPass({
            label: 'hbao_pass',
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
        this.stats?.addDraw(1);
        renderPass.end();
    }

    getOutputTextureView(): GPUTextureView | null {
        return this.outputTextureView;
    }

    onResize(width: number, height: number): void {
        this.canvasWidth = width;
        this.canvasHeight = height;
        this.recreateOutputTexture(width, height);
        this.cachedBindGroup = null;
        this.cachedColorView = null;
        this.cachedDepthView = null;
    }

    shutdown(): void {
        this.paramsBuffer?.destroy();
        this.paramsBuffer = null;
        this.outputTexture?.destroy();
        this.outputTexture = null;
        this.outputTextureView = null;
        this.cachedBindGroup = null;
        this.cachedColorView = null;
        this.cachedDepthView = null;
        this.pipeline = null;
        this.device = null;
    }

    private recreateOutputTexture(width: number, height: number): void {
        if (!this.device) return;
        this.outputTexture?.destroy();
        this.outputTexture = this.device.createTexture({
            label: 'hbao_output',
            size: [width, height],
            format: this.canvasFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.outputTextureView = this.outputTexture.createView();
    }

    private uploadParams(camera: RenderCamera): void {
        if (!this.device || !this.paramsBuffer) return;
        const data = new Float32Array(56);
        data.set(camera.viewMatrix.data, 0);
        data.set(camera.projectionMatrix.data, 16);
        const invProj = camera.projectionMatrix.inverse();
        if (invProj) {
            data.set(invProj.data, 32);
        } else {
            // Fallback to identity matrix when inverse fails
            const identity = new Mat4();
            data.set(identity.data, 32);
        }
        data[48] = this.canvasWidth;
        data[49] = this.canvasHeight;
        data[50] = camera.near;
        data[51] = camera.far;
        data[52] = 0.8;  // aoRadius
        data[53] = 1.2;  // aoStrength
        this.device.queue.writeBuffer(this.paramsBuffer, 0, data);
    }
}
