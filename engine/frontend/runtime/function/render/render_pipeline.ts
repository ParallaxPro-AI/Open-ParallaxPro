import { Mat4 } from '../../core/math/mat4.js';
import { GPUResourceManager } from './gpu_resource_manager.js';
import { ShaderLibrary } from './shader_library.js';
import { RenderScene } from './render_scene.js';
import { GeometryPass, GraphicsQuality } from './passes/geometry_pass.js';
import { ShadowPass } from './passes/shadow_pass.js';
import { FXAAPass } from './passes/fxaa_pass.js';
import { HBAOPass } from './passes/hbao_pass.js';
import { SSRPass } from './passes/ssr_pass.js';
import { SkyboxPass } from './passes/skybox_pass.js';
import { BloomPass } from './passes/bloom_pass.js';
import { DebugRenderer } from './debug_renderer.js';
import { ParticleRenderer, ParticleRenderData } from './particle_renderer.js';

/**
 * Orchestrates render passes based on graphics quality.
 *
 * Low:    GeometryPass -> Skybox -> FXAA (blit) -> swapchain
 * Medium: ShadowPass -> GeometryPass(MRT) -> HBAO -> Skybox -> FXAA -> swapchain
 * High:   ShadowPass -> GeometryPass(MSAA+MRT) -> HBAO -> Skybox -> SSR -> Bloom -> FXAA -> swapchain
 */
export class RenderPipeline {
    private device: GPUDevice | null = null;
    private context: GPUCanvasContext | null = null;
    private geometryPass = new GeometryPass();
    private shadowPass = new ShadowPass();
    private fxaaPass = new FXAAPass();
    private hbaoPass = new HBAOPass();
    private ssrPass = new SSRPass();
    private skyboxPass = new SkyboxPass();
    private bloomPass = new BloomPass();
    private debugRenderer = new DebugRenderer();
    private canvasFormat: GPUTextureFormat = 'bgra8unorm';
    private quality: GraphicsQuality = 'low';

    private ssrOutputTexture: GPUTexture | null = null;
    private ssrOutputTextureView: GPUTextureView | null = null;

    initialize(
        device: GPUDevice,
        context: GPUCanvasContext,
        resources: GPUResourceManager,
        shaderLib: ShaderLibrary,
        canvasFormat: GPUTextureFormat,
        width: number,
        height: number
    ): void {
        this.device = device;
        this.context = context;
        this.canvasFormat = canvasFormat;

        this.geometryPass.initialize(device, resources, shaderLib, canvasFormat, width, height);

        const modelBGL = this.geometryPass.getModelBindGroupLayout();
        if (modelBGL) {
            this.shadowPass.initialize(device, resources, shaderLib, modelBGL);
        }

        this.fxaaPass.initialize(device, resources, shaderLib, canvasFormat, width, height);
        this.hbaoPass.initialize(device, resources, shaderLib, canvasFormat, width, height);
        this.ssrPass.initialize(device, resources, shaderLib, canvasFormat, width, height);
        this.skyboxPass.initialize(device, resources, shaderLib, canvasFormat, width, height);
        this.bloomPass.initialize(device, resources, shaderLib, canvasFormat, width, height);

        const cameraBGL = this.geometryPass.getCameraBindGroupLayout();
        if (cameraBGL) {
            this.debugRenderer.initialize(device, resources, shaderLib, canvasFormat, cameraBGL);
        }

        this.recreateSSROutputTexture(width, height);
    }

    setGraphicsQuality(quality: GraphicsQuality): void {
        this.quality = quality;
        this.geometryPass.setGraphicsQuality(quality);
    }

    render(scene: RenderScene, particleRenderer?: ParticleRenderer, particleData?: ParticleRenderData[]): void {
        if (!this.device || !this.context) return;

        const textureView = this.context.getCurrentTexture().createView();
        const commandEncoder = this.device.createCommandEncoder({ label: 'frame_command_encoder' });

        if (this.quality === 'low') {
            this.renderLow(commandEncoder, textureView, scene);
        } else if (this.quality === 'medium') {
            this.renderMedium(commandEncoder, textureView, scene);
        } else {
            this.renderHigh(commandEncoder, textureView, scene);
        }

        // Particle rendering (after geometry, before debug overlay)
        const depthView = this.geometryPass.getDepthTextureView();
        if (particleRenderer && particleData && particleData.length > 0 && scene.camera && depthView) {
            particleRenderer.render(commandEncoder, textureView, depthView, scene.camera, particleData);
        }

        // Debug overlay
        const cameraBindGroup = this.geometryPass.getCameraBindGroup();
        if (depthView && cameraBindGroup) {
            this.debugRenderer.flush(commandEncoder, textureView, depthView, cameraBindGroup);
        }

        this.device.queue.submit([commandEncoder.finish()]);
    }

    onResize(width: number, height: number): void {
        this.geometryPass.onResize(width, height);
        this.fxaaPass.onResize(width, height);
        this.hbaoPass.onResize(width, height);
        this.ssrPass.onResize(width, height);
        this.skyboxPass.onResize(width, height);
        this.bloomPass.onResize(width, height);
        this.recreateSSROutputTexture(width, height);
    }

    getDebugRenderer(): DebugRenderer {
        return this.debugRenderer;
    }

    getCameraBGL(): GPUBindGroupLayout | null {
        return this.geometryPass.getCameraBindGroupLayout();
    }

    shutdown(): void {
        this.geometryPass.shutdown();
        this.shadowPass.shutdown();
        this.fxaaPass.shutdown();
        this.hbaoPass.shutdown();
        this.ssrPass.shutdown();
        this.skyboxPass.shutdown();
        this.bloomPass.shutdown();
        this.debugRenderer.shutdown();
        this.ssrOutputTexture?.destroy();
        this.ssrOutputTexture = null;
        this.ssrOutputTextureView = null;
        this.device = null;
        this.context = null;
    }

    private recreateSSROutputTexture(width: number, height: number): void {
        if (!this.device) return;
        this.ssrOutputTexture?.destroy();
        this.ssrOutputTexture = this.device.createTexture({
            label: 'ssr_offscreen_output',
            size: [width, height],
            format: this.canvasFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.ssrOutputTextureView = this.ssrOutputTexture.createView();
    }

    private renderLow(commandEncoder: GPUCommandEncoder, textureView: GPUTextureView, scene: RenderScene): void {
        // No shadows on low quality
        this.geometryPass.setShadowMap(null, new Mat4(), 1);
        this.geometryPass.execute(commandEncoder, textureView, scene);

        const offscreenView = this.geometryPass.getOffscreenColorTextureView();
        const normalDepthView = this.geometryPass.getNormalDepthTextureView();
        if (offscreenView && normalDepthView && scene.camera) {
            this.skyboxPass.execute(commandEncoder, offscreenView, normalDepthView, scene.camera, scene.timeOfDay);
        }

        const skyboxOutput = this.skyboxPass.getOutputTextureView();
        const blitInput = skyboxOutput ?? offscreenView;
        if (blitInput) {
            this.fxaaPass.execute(commandEncoder, textureView, blitInput);
        }
    }

    private renderMedium(commandEncoder: GPUCommandEncoder, textureView: GPUTextureView, scene: RenderScene): void {
        // 1. Shadow pass
        this.shadowPass.execute(commandEncoder, scene);
        const shadowView = this.shadowPass.getDepthTextureView();
        const shadowMatrix = this.shadowPass.getLightSpaceMatrix();
        const shadowMapSize = this.shadowPass.getShadowMapSize();
        this.geometryPass.setShadowMap(shadowView, shadowMatrix, shadowMapSize);

        // 2. Geometry (MRT: color + normal/depth)
        this.geometryPass.execute(commandEncoder, textureView, scene);

        // 3. HBAO
        const offscreenView = this.geometryPass.getOffscreenColorTextureView();
        const normalDepthView = this.geometryPass.getNormalDepthTextureView();
        if (offscreenView && normalDepthView && scene.camera) {
            this.hbaoPass.execute(commandEncoder, offscreenView, normalDepthView, scene.camera);
        }

        // 4. Skybox
        const hbaoOutput = this.hbaoPass.getOutputTextureView();
        const skyboxInput = hbaoOutput ?? offscreenView;
        if (skyboxInput && normalDepthView && scene.camera) {
            this.skyboxPass.execute(commandEncoder, skyboxInput, normalDepthView, scene.camera, scene.timeOfDay);
        }

        // 5. FXAA to swapchain
        const skyboxOutput = this.skyboxPass.getOutputTextureView();
        const fxaaInput = skyboxOutput ?? hbaoOutput ?? offscreenView;
        if (fxaaInput) {
            this.fxaaPass.execute(commandEncoder, textureView, fxaaInput);
        }
    }

    private renderHigh(commandEncoder: GPUCommandEncoder, textureView: GPUTextureView, scene: RenderScene): void {
        // 1. Shadow pass
        this.shadowPass.execute(commandEncoder, scene);
        const shadowView = this.shadowPass.getDepthTextureView();
        const shadowMatrix = this.shadowPass.getLightSpaceMatrix();
        const shadowMapSize = this.shadowPass.getShadowMapSize();
        this.geometryPass.setShadowMap(shadowView, shadowMatrix, shadowMapSize);

        // 2. Geometry pass (MSAA + MRT)
        this.geometryPass.execute(commandEncoder, textureView, scene);

        // 3. HBAO
        const offscreenView = this.geometryPass.getOffscreenColorTextureView();
        const normalDepthView = this.geometryPass.getNormalDepthTextureView();
        if (offscreenView && normalDepthView && scene.camera) {
            this.hbaoPass.execute(commandEncoder, offscreenView, normalDepthView, scene.camera);
        }

        // 4. Skybox
        const hbaoOutput = this.hbaoPass.getOutputTextureView();
        const skyboxInput = hbaoOutput ?? offscreenView;
        if (skyboxInput && normalDepthView && scene.camera) {
            this.skyboxPass.execute(commandEncoder, skyboxInput, normalDepthView, scene.camera, scene.timeOfDay);
        }

        // 5. SSR
        const skyboxOutput = this.skyboxPass.getOutputTextureView();
        const ssrInput = skyboxOutput ?? hbaoOutput ?? offscreenView;
        if (ssrInput && normalDepthView && scene.camera && this.ssrOutputTextureView) {
            this.ssrPass.execute(commandEncoder, this.ssrOutputTextureView, ssrInput, normalDepthView, scene.camera);
        }

        // 6. Bloom
        const bloomInput = this.ssrOutputTextureView ?? ssrInput;
        if (bloomInput) {
            this.bloomPass.execute(commandEncoder, bloomInput);
        }

        // 7. FXAA to swapchain
        const bloomOutput = this.bloomPass.getOutputTextureView();
        const fxaaInput = bloomOutput ?? this.ssrOutputTextureView ?? ssrInput;
        if (fxaaInput) {
            this.fxaaPass.execute(commandEncoder, textureView, fxaaInput);
        }
    }
}
