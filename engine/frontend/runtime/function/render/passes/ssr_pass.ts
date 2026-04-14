import { Mat4 } from '../../../core/math/mat4.js';
import { GPUResourceManager } from '../gpu_resource_manager.js';
import { ShaderLibrary } from '../shader_library.js';
import { RenderCamera } from '../render_scene.js';
import { RenderStats } from '../render_stats.js';

const SSR_UNIFORM_SIZE = 224;

/**
 * Screen-space reflections post-processing pass.
 * Reads color + normal/depth textures and ray-marches to produce reflected color.
 */
export class SSRPass {
    private stats: RenderStats | null = null;
    setStats(stats: RenderStats): void { this.stats = stats; }

    private device: GPUDevice | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private bindGroupLayout: GPUBindGroupLayout | null = null;
    private sampler: GPUSampler | null = null;
    private paramsBuffer: GPUBuffer | null = null;
    private canvasWidth = 0;
    private canvasHeight = 0;

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
        this.canvasWidth = width;
        this.canvasHeight = height;

        this.bindGroupLayout = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ], 'ssr_bgl');

        this.sampler = device.createSampler({
            label: 'ssr_sampler',
            magFilter: 'linear',
            minFilter: 'linear',
        });

        this.paramsBuffer = resources.createUniformBuffer(SSR_UNIFORM_SIZE, 'ssr_params');

        this.pipeline = device.createRenderPipeline({
            label: 'ssr_pipeline',
            layout: resources.createPipelineLayout([this.bindGroupLayout], 'ssr_pl'),
            vertex: { module: shaderLib.getModule('fullscreen_vertex'), entryPoint: 'vs_main' },
            fragment: {
                module: shaderLib.getModule('ssr_fragment'),
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat }],
            },
            primitive: { topology: 'triangle-list' },
        });
    }

    execute(
        commandEncoder: GPUCommandEncoder,
        targetView: GPUTextureView,
        colorTextureView: GPUTextureView,
        normalDepthTextureView: GPUTextureView,
        camera: RenderCamera
    ): void {
        if (!this.device || !this.pipeline || !this.bindGroupLayout) return;

        this.uploadParams(camera);

        if (colorTextureView !== this.cachedColorView || normalDepthTextureView !== this.cachedNormalDepthView) {
            this.cachedBindGroup = this.device.createBindGroup({
                label: 'ssr_bg',
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
            label: 'ssr_pass',
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
        this.stats?.addDraw(1);
        renderPass.end();
    }

    onResize(width: number, height: number): void {
        this.canvasWidth = width;
        this.canvasHeight = height;
        this.cachedBindGroup = null;
        this.cachedColorView = null;
        this.cachedNormalDepthView = null;
    }

    shutdown(): void {
        this.paramsBuffer?.destroy();
        this.paramsBuffer = null;
        this.cachedBindGroup = null;
        this.cachedColorView = null;
        this.cachedNormalDepthView = null;
        this.pipeline = null;
        this.device = null;
    }

    private uploadParams(camera: RenderCamera): void {
        if (!this.device || !this.paramsBuffer) return;
        const data = new Float32Array(56);
        data.set(camera.projectionMatrix.data, 0);
        data.set(camera.viewMatrix.data, 16);
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
        this.device.queue.writeBuffer(this.paramsBuffer, 0, data);
    }
}
