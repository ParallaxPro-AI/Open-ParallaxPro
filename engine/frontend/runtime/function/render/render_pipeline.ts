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
import { DecalPass } from './passes/decal_pass.js';
import { DebugRenderer } from './debug_renderer.js';
import { ParticleRenderer, ParticleRenderData } from './particle_renderer.js';
import { RenderStats } from './render_stats.js';

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
    private decalPass = new DecalPass();
    private debugRenderer = new DebugRenderer();
    private canvasFormat: GPUTextureFormat = 'bgra8unorm';
    private quality: GraphicsQuality = 'low';
    private canvasWidth = 0;
    private canvasHeight = 0;

    private ssrOutputTexture: GPUTexture | null = null;
    private ssrOutputTextureView: GPUTextureView | null = null;
    private stats = new RenderStats();

    // ── Per-pass rolling CPU submit timings (proxy for GPU cost) ────────
    // WebGPU's `timestamp-query` feature would give true GPU durations, but
    // wiring it requires editing every pass's beginRenderPass descriptor.
    // For V1 we record the CPU time spent assembling + submitting each pass
    // as a rough proxy, labeled accordingly in the profiler panel.
    private readonly GPU_RING = 60;
    private passHistory: Map<string, { samples: Float32Array; index: number; fill: number }> = new Map();

    getStats(): RenderStats { return this.stats; }

    getPassTimings(): Array<{ name: string; avgMs: number; maxMs: number }> {
        const out: Array<{ name: string; avgMs: number; maxMs: number }> = [];
        for (const [name, h] of this.passHistory) {
            if (h.fill === 0) continue;
            let sum = 0, max = 0;
            for (let i = 0; i < h.fill; i++) {
                const v = h.samples[i];
                sum += v;
                if (v > max) max = v;
            }
            out.push({ name, avgMs: sum / h.fill, maxMs: max });
        }
        return out;
    }

    private timedPass(name: string, fn: () => void): void {
        const t0 = performance.now();
        fn();
        const elapsed = performance.now() - t0;
        let h = this.passHistory.get(name);
        if (!h) {
            h = { samples: new Float32Array(this.GPU_RING), index: 0, fill: 0 };
            this.passHistory.set(name, h);
        }
        h.samples[h.index] = elapsed;
        h.index = (h.index + 1) % this.GPU_RING;
        h.fill = Math.min(h.fill + 1, this.GPU_RING);
    }

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
        this.canvasWidth = width;
        this.canvasHeight = height;

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
        const cameraBuffer = this.geometryPass.getCameraUniformBuffer();
        if (cameraBGL) {
            this.debugRenderer.initialize(device, resources, shaderLib, canvasFormat, cameraBGL);
        }
        if (cameraBGL && cameraBuffer) {
            this.decalPass.initialize(device, resources, shaderLib, canvasFormat, cameraBGL, cameraBuffer);
            this.decalPass.setViewportSize(width, height);
        }

        this.recreateSSROutputTexture(width, height);

        // Give every pass a shared counter bag to bump during execute().
        this.geometryPass.setStats(this.stats);
        this.shadowPass.setStats(this.stats);
        this.fxaaPass.setStats(this.stats);
        this.hbaoPass.setStats(this.stats);
        this.ssrPass.setStats(this.stats);
        this.skyboxPass.setStats(this.stats);
        this.bloomPass.setStats(this.stats);
        this.decalPass.setStats(this.stats);
        this.debugRenderer.setStats(this.stats);
        // Particle renderer is owned by RenderSystem — it's wired separately.
    }

    setGraphicsQuality(quality: GraphicsQuality): void {
        this.quality = quality;
        this.geometryPass.setGraphicsQuality(quality);
    }

    render(scene: RenderScene, particleRenderer?: ParticleRenderer, particleData?: ParticleRenderData[]): void {
        if (!this.device || !this.context) return;

        this.stats.reset();
        this.stats.meshesTotal = scene.meshes.length;

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
        this.canvasWidth = width;
        this.canvasHeight = height;
        this.geometryPass.onResize(width, height);
        this.fxaaPass.onResize(width, height);
        this.hbaoPass.onResize(width, height);
        this.ssrPass.onResize(width, height);
        this.skyboxPass.onResize(width, height);
        this.bloomPass.onResize(width, height);
        this.decalPass.onResize();
        this.decalPass.setViewportSize(width, height);
        this.recreateSSROutputTexture(width, height);
    }

    getDebugRenderer(): DebugRenderer {
        return this.debugRenderer;
    }

    getCameraBGL(): GPUBindGroupLayout | null {
        return this.geometryPass.getCameraBindGroupLayout();
    }

    setBuildingTextures(
        diffuseArray: GPUTexture | null,
        normalArray: GPUTexture | null,
        layerProps: Float32Array | null,
    ): void {
        this.geometryPass.setBuildingTextures(diffuseArray, normalArray, layerProps);
    }

    shutdown(): void {
        this.geometryPass.shutdown();
        this.shadowPass.shutdown();
        this.fxaaPass.shutdown();
        this.hbaoPass.shutdown();
        this.ssrPass.shutdown();
        this.skyboxPass.shutdown();
        this.bloomPass.shutdown();
        this.decalPass.shutdown();
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
        this.geometryPass.setShadowMap(null, [], [], 1);
        this.timedPass('geometry', () => this.geometryPass.execute(commandEncoder, textureView, scene));

        const offscreenView = this.geometryPass.getOffscreenColorTextureView();
        const normalDepthView = this.geometryPass.getNormalDepthTextureView();

        if (offscreenView && normalDepthView && scene.camera && scene.decals.length > 0) {
            this.timedPass('decal', () => this.decalPass.execute(commandEncoder, offscreenView!, normalDepthView!, scene.camera!, scene.decals));
        }

        if (offscreenView && normalDepthView && scene.camera) {
            this.timedPass('skybox', () => this.skyboxPass.execute(commandEncoder, offscreenView!, normalDepthView!, scene.camera!, scene.timeOfDay));
        }

        const skyboxOutput = this.skyboxPass.getOutputTextureView();
        const blitInput = skyboxOutput ?? offscreenView;
        if (blitInput) {
            this.timedPass('fxaa', () => this.fxaaPass.execute(commandEncoder, textureView, blitInput));
        }
    }

    private renderMedium(commandEncoder: GPUCommandEncoder, textureView: GPUTextureView, scene: RenderScene): void {
        this.timedPass('shadow', () => this.shadowPass.execute(commandEncoder, scene));
        const shadowView = this.shadowPass.getDepthArrayTextureView();
        const cascadeMatrices = this.shadowPass.getLightSpaceMatrices();
        const cascadeSplits = this.shadowPass.getCascadeSplits();
        const shadowMapSize = this.shadowPass.getShadowMapSize();
        this.geometryPass.setShadowMap(shadowView, cascadeMatrices, cascadeSplits, shadowMapSize);

        this.timedPass('geometry', () => this.geometryPass.execute(commandEncoder, textureView, scene));

        const offscreenView = this.geometryPass.getOffscreenColorTextureView();
        const normalDepthView = this.geometryPass.getNormalDepthTextureView();

        if (offscreenView && normalDepthView && scene.camera && scene.decals.length > 0) {
            this.timedPass('decal', () => this.decalPass.execute(commandEncoder, offscreenView!, normalDepthView!, scene.camera!, scene.decals));
        }

        if (offscreenView && normalDepthView && scene.camera) {
            this.timedPass('hbao', () => this.hbaoPass.execute(commandEncoder, offscreenView!, normalDepthView!, scene.camera!));
        }

        const hbaoOutput = this.hbaoPass.getOutputTextureView();
        const skyboxInput = hbaoOutput ?? offscreenView;
        if (skyboxInput && normalDepthView && scene.camera) {
            this.timedPass('skybox', () => this.skyboxPass.execute(commandEncoder, skyboxInput!, normalDepthView!, scene.camera!, scene.timeOfDay));
        }

        const skyboxOutput = this.skyboxPass.getOutputTextureView();
        const fxaaInput = skyboxOutput ?? hbaoOutput ?? offscreenView;
        if (fxaaInput) {
            this.timedPass('fxaa', () => this.fxaaPass.execute(commandEncoder, textureView, fxaaInput));
        }
    }

    private renderHigh(commandEncoder: GPUCommandEncoder, textureView: GPUTextureView, scene: RenderScene): void {
        this.timedPass('shadow', () => this.shadowPass.execute(commandEncoder, scene));
        const shadowView = this.shadowPass.getDepthArrayTextureView();
        const cascadeMatrices = this.shadowPass.getLightSpaceMatrices();
        const cascadeSplits = this.shadowPass.getCascadeSplits();
        const shadowMapSize = this.shadowPass.getShadowMapSize();
        this.geometryPass.setShadowMap(shadowView, cascadeMatrices, cascadeSplits, shadowMapSize);

        this.timedPass('geometry', () => this.geometryPass.execute(commandEncoder, textureView, scene));

        const offscreenView = this.geometryPass.getOffscreenColorTextureView();
        const normalDepthView = this.geometryPass.getNormalDepthTextureView();

        if (offscreenView && normalDepthView && scene.camera && scene.decals.length > 0) {
            this.timedPass('decal', () => this.decalPass.execute(commandEncoder, offscreenView!, normalDepthView!, scene.camera!, scene.decals));
        }

        if (offscreenView && normalDepthView && scene.camera) {
            this.timedPass('hbao', () => this.hbaoPass.execute(commandEncoder, offscreenView!, normalDepthView!, scene.camera!));
        }

        const hbaoOutput = this.hbaoPass.getOutputTextureView();
        const skyboxInput = hbaoOutput ?? offscreenView;
        if (skyboxInput && normalDepthView && scene.camera) {
            this.timedPass('skybox', () => this.skyboxPass.execute(commandEncoder, skyboxInput!, normalDepthView!, scene.camera!, scene.timeOfDay));
        }

        const skyboxOutput = this.skyboxPass.getOutputTextureView();
        const ssrInput = skyboxOutput ?? hbaoOutput ?? offscreenView;
        if (ssrInput && normalDepthView && scene.camera && this.ssrOutputTextureView) {
            this.timedPass('ssr', () => this.ssrPass.execute(commandEncoder, this.ssrOutputTextureView!, ssrInput!, normalDepthView!, scene.camera!));
        }

        const bloomInput = this.ssrOutputTextureView ?? ssrInput;
        if (bloomInput) {
            this.timedPass('bloom', () => this.bloomPass.execute(commandEncoder, bloomInput!));
        }

        const bloomOutput = this.bloomPass.getOutputTextureView();
        const fxaaInput = bloomOutput ?? this.ssrOutputTextureView ?? ssrInput;
        if (fxaaInput) {
            this.timedPass('fxaa', () => this.fxaaPass.execute(commandEncoder, textureView, fxaaInput));
        }
    }
}
