import { Vec3 } from '../../core/math/vec3.js';
import { Mat4 } from '../../core/math/mat4.js';
import { GPUDeviceManager } from '../../platform/gpu/gpu_device.js';
import { CanvasManager } from '../../platform/canvas/canvas_manager.js';
import { ShaderLibrary } from './shader_library.js';
import { GPUResourceManager } from './gpu_resource_manager.js';
import { RenderPipeline } from './render_pipeline.js';
import { RenderScene, MeshData, GPUMeshHandle, RenderCamera, RenderMeshInstance, RenderDirectionalLight, RenderPointLight, RenderSpotLight, RenderFogData, DecalInstance } from './render_scene.js';
import { DebugRenderer } from './debug_renderer.js';
import { GraphicsQuality } from './passes/geometry_pass.js';
import { ParticleRenderer, ParticleRenderData } from './particle_renderer.js';
import { IRenderer, GfxBackend } from './i_renderer.js';

/**
 * Lightweight interface for extracting renderable data from the active scene.
 * The framework Scene class implements this interface.
 */
export interface RenderSceneSource {
    getMeshInstances(): RenderMeshInstance[];
    getDirectionalLights(): RenderDirectionalLight[];
    getPointLights(): RenderPointLight[];
    getSpotLights(): RenderSpotLight[];
    getActiveCamera(): RenderCamera | null;
    getAmbientColor(): Vec3;
    getAmbientIntensity(): number;
    getFogData(): RenderFogData;
    getTimeOfDay(): number;
    getParticleRenderData?(): { instanceData: Float32Array; activeCount: number }[];
}

/**
 * Top-level rendering facade.
 * Manages GPU resources, builds the RenderScene each frame,
 * and drives the RenderPipeline.
 */
export class RenderSystem implements IRenderer {
    readonly backend: GfxBackend = 'webgpu';
    private gpuDevice!: GPUDeviceManager;
    private canvasManager!: CanvasManager;
    private shaderLibrary = new ShaderLibrary();
    private gpuResources = new GPUResourceManager();
    private renderPipeline = new RenderPipeline();
    private renderScene = new RenderScene();
    private debugRenderer!: DebugRenderer;
    private particleRenderer = new ParticleRenderer();
    private activeCamera: RenderCamera | null = null;
    private cameraOverrideView: Mat4 | null = null;
    private cameraOverrideProj: Mat4 | null = null;
    private nextJointBufferId = 0;

    getCanvas(): HTMLCanvasElement | null {
        return this.canvasManager?.getCanvas() ?? null;
    }

    getDevice(): GPUDevice | null {
        return this.gpuDevice?.getDevice() ?? null;
    }

    async initialize(gpuDevice: GPUDeviceManager, canvasManager: CanvasManager): Promise<void> {
        this.gpuDevice = gpuDevice;
        this.canvasManager = canvasManager;

        const device = gpuDevice.getDevice();
        const context = gpuDevice.getContext();
        const format = gpuDevice.getCanvasFormat();
        const width = canvasManager.getWidth();
        const height = canvasManager.getHeight();

        this.gpuResources.initialize(device);
        this.shaderLibrary.initialize(device);
        this.renderPipeline.initialize(device, context, this.gpuResources, this.shaderLibrary, format, width, height);
        this.debugRenderer = this.renderPipeline.getDebugRenderer();

        const cameraBGL = this.renderPipeline.getCameraBGL();
        if (cameraBGL) {
            this.particleRenderer.initialize(device, this.gpuResources, this.shaderLibrary, format, cameraBGL);
        }
        this.particleRenderer.setStats(this.renderPipeline.getStats());

        canvasManager.onResize((w, h) => this.onCanvasResize(w, h));
    }

    /** Per-frame renderer counters (draw calls, triangles, meshes) consumed
     *  by the editor's Performance Profiler panel. */
    getRenderStats(): { drawCalls: number; triangles: number; meshesRendered: number; meshesTotal: number } {
        return this.renderPipeline.getStats().snapshot();
    }

    /** Per-pass timings for the Performance Profiler panel. Note: these are
     *  CPU-side submit times, not true GPU durations — WebGPU timestamp-query
     *  would give real GPU numbers but requires wiring timestampWrites into
     *  every pass's render pass descriptor. */
    getGpuTimings(): { supported: boolean; mode: 'cpu-submit' | 'gpu'; passes: Array<{ name: string; avgMs: number; maxMs: number }> } {
        return {
            supported: true,
            mode: 'cpu-submit',
            passes: this.renderPipeline.getPassTimings(),
        };
    }

    tick(deltaTime: number, scene: RenderSceneSource | null): void {
        this.renderScene.clear();

        if (scene) {
            for (const mesh of scene.getMeshInstances()) {
                this.renderScene.addMesh(mesh);
            }

            for (const light of scene.getDirectionalLights()) {
                this.renderScene.addDirectionalLight(light);
            }
            // Shaders always expect at least one directional light
            if (this.renderScene.directionalLights.length === 0) {
                this.renderScene.addDirectionalLight({
                    direction: new Vec3(0.3, -1, 0.5).normalize(),
                    color: new Vec3(1, 1, 1),
                    intensity: 1.0,
                });
            }

            for (const pl of scene.getPointLights()) {
                this.renderScene.addPointLight(pl);
            }
            for (const sl of scene.getSpotLights()) {
                this.renderScene.addSpotLight(sl);
            }

            this.renderScene.setAmbient(scene.getAmbientColor(), scene.getAmbientIntensity());
            this.renderScene.setFog(scene.getFogData());
            this.renderScene.setTimeOfDay(scene.getTimeOfDay());

            let camera = this.activeCamera ?? scene.getActiveCamera();
            if (camera) {
                if (this.cameraOverrideView && this.cameraOverrideProj) {
                    camera = {
                        ...camera,
                        viewMatrix: this.cameraOverrideView,
                        projectionMatrix: this.cameraOverrideProj,
                    };
                }
                this.renderScene.setCamera(camera);
            }
        } else {
            if (this.cameraOverrideView && this.cameraOverrideProj && this.activeCamera) {
                this.renderScene.setCamera({
                    ...this.activeCamera,
                    viewMatrix: this.cameraOverrideView,
                    projectionMatrix: this.cameraOverrideProj,
                });
            } else if (this.activeCamera) {
                this.renderScene.setCamera(this.activeCamera);
            }

            if (this.renderScene.directionalLights.length === 0) {
                this.renderScene.addDirectionalLight({
                    direction: new Vec3(0.3, -1, 0.5).normalize(),
                    color: new Vec3(1, 1, 1),
                    intensity: 1.0,
                });
            }
        }

        let particleData: ParticleRenderData[] = [];
        if (scene?.getParticleRenderData) {
            particleData = scene.getParticleRenderData();
        }

        this.renderPipeline.render(this.renderScene, this.particleRenderer, particleData);
    }

    /** Replace the decal list rendered this frame. Call before tick() returns. */
    setDecals(decals: DecalInstance[]): void {
        this.renderScene.setDecals(decals);
    }

    uploadMesh(meshData: MeshData): GPUMeshHandle {
        const vertexCount = meshData.positions.length / 3;
        const interleaved = new Float32Array(vertexCount * 8);

        for (let i = 0; i < vertexCount; i++) {
            const si = i * 3;
            const ui = i * 2;
            const di = i * 8;
            interleaved[di]     = meshData.positions[si];
            interleaved[di + 1] = meshData.positions[si + 1];
            interleaved[di + 2] = meshData.positions[si + 2];
            interleaved[di + 3] = meshData.normals[si];
            interleaved[di + 4] = meshData.normals[si + 1];
            interleaved[di + 5] = meshData.normals[si + 2];
            interleaved[di + 6] = meshData.uvs[ui];
            interleaved[di + 7] = meshData.uvs[ui + 1];
        }

        // Bounds. computeBounds works on raw vertex positions; for skinned
        // meshes, glb_loader.applyFacingTransformInPlace stashes the
        // registry scale on `meshData.facingScale` instead of baking it
        // into positions (baking breaks the skeleton). Physics auto-fit,
        // frustum cull, picking, etc. all read these bounds and assume
        // they reflect the rendered size — so we apply facingScale here
        // before stashing on the GPU mesh handle. Without this, every
        // skinned character has bounds in pre-scale GLB space (typically
        // 2-10× the visible mesh, depending on the pack's scale_multiplier),
        // and the auto-fit capsule ends up that many times too tall.
        const bounds = computeBounds(meshData.positions);
        const fs = meshData.facingScale;
        if (fs && Math.abs(fs - 1) > 1e-4) {
            bounds.boundRadius = bounds.boundRadius * fs;
            bounds.boundMin = new Vec3(bounds.boundMin.x * fs, bounds.boundMin.y * fs, bounds.boundMin.z * fs);
            bounds.boundMax = new Vec3(bounds.boundMax.x * fs, bounds.boundMax.y * fs, bounds.boundMax.z * fs);
        }

        const indexFormat: GPUIndexFormat = meshData.indices instanceof Uint16Array ? 'uint16' : 'uint32';
        return {
            vertexBuffer: this.gpuResources.createVertexBuffer(interleaved, 'mesh_vb'),
            indexBuffer: this.gpuResources.createIndexBuffer(meshData.indices, 'mesh_ib'),
            indexCount: meshData.indices.length,
            indexFormat,
            ...bounds,
        };
    }

    /**
     * Upload a building mesh with an extra per-vertex u32 meta attribute.
     * Stride is 36 bytes: position(12) + normal(12) + uv(8) + meta(4). The
     * returned handle is flagged with `hasBuildingMeta` so the geometry
     * and shadow passes route it through the building pipeline.
     */
    uploadBuildingMesh(meshData: MeshData & { meta: Uint32Array }): GPUMeshHandle {
        const vertexCount = meshData.positions.length / 3;
        // Interleave as 36 bytes per vertex: 8 floats + 1 u32 (9 words).
        const buf = new ArrayBuffer(vertexCount * 36);
        const f32 = new Float32Array(buf);
        const u32 = new Uint32Array(buf);

        for (let i = 0; i < vertexCount; i++) {
            const si = i * 3;
            const ui = i * 2;
            const di = i * 9;
            f32[di]     = meshData.positions[si];
            f32[di + 1] = meshData.positions[si + 1];
            f32[di + 2] = meshData.positions[si + 2];
            f32[di + 3] = meshData.normals[si];
            f32[di + 4] = meshData.normals[si + 1];
            f32[di + 5] = meshData.normals[si + 2];
            f32[di + 6] = meshData.uvs[ui];
            f32[di + 7] = meshData.uvs[ui + 1];
            u32[di + 8] = meshData.meta[i];
        }

        const indexFormat: GPUIndexFormat = meshData.indices instanceof Uint16Array ? 'uint16' : 'uint32';
        return {
            vertexBuffer: this.gpuResources.createVertexBuffer(new Float32Array(buf), 'building_mesh_vb'),
            indexBuffer: this.gpuResources.createIndexBuffer(meshData.indices, 'building_mesh_ib'),
            indexCount: meshData.indices.length,
            indexFormat,
            ...computeBounds(meshData.positions),
            hasBuildingMeta: true,
        };
    }

    uploadSkinnedMesh(meshData: MeshData, joints: Uint16Array, weights: Float32Array): GPUMeshHandle {
        const handle = this.uploadMesh(meshData);

        // joints (4 x u32) + weights (4 x f32) = 32 bytes per vertex
        const vertexCount = meshData.positions.length / 3;
        const skinData = new ArrayBuffer(vertexCount * 32);
        const skinU32 = new Uint32Array(skinData);
        const skinF32 = new Float32Array(skinData);

        for (let i = 0; i < vertexCount; i++) {
            skinU32[i * 8 + 0] = joints[i * 4 + 0];
            skinU32[i * 8 + 1] = joints[i * 4 + 1];
            skinU32[i * 8 + 2] = joints[i * 4 + 2];
            skinU32[i * 8 + 3] = joints[i * 4 + 3];
            skinF32[i * 8 + 4] = weights[i * 4 + 0];
            skinF32[i * 8 + 5] = weights[i * 4 + 1];
            skinF32[i * 8 + 6] = weights[i * 4 + 2];
            skinF32[i * 8 + 7] = weights[i * 4 + 3];
        }

        handle.skinBuffer = this.gpuResources.createVertexBuffer(new Float32Array(skinData), 'skin_vb');
        return handle;
    }

    createJointMatricesBuffer(jointCount: number): GPUBuffer {
        const size = Math.max(64, jointCount * 64);
        // Each buffer gets a unique label. The skinning bind-group cache
        // in geometry_pass.getSkinnedModelBindGroup keys by
        // `${idx}_${jointBuf.label}` — if every buffer shares the same
        // label, the key collapses to just the frame-local model-pool
        // index, and two different characters that happen to take the
        // same draw-order slot share a stale bind group → one renders
        // with the other's joint matrices, producing T-pose / "arms in
        // the air" on whichever skeleton drew first that frame. Reported
        // for deadly_games (15 contestants spawned, several visibly
        // stuck in bind pose). Unique labels make the cache key
        // genuinely identify the (slot, joint buffer) pair.
        const id = this.nextJointBufferId++;
        return this.gpuResources.device!.createBuffer({
            label: `joint_matrices_${id}`,
            size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
    }

    updateJointMatrices(buffer: GPUBuffer, matrices: Float32Array): void {
        this.gpuResources.writeBuffer(buffer, 0, matrices);
    }

    uploadTexture(imageBitmap: ImageBitmap, params: any): GPUTexture {
        return this.gpuResources.uploadTextureFromBitmap(imageBitmap, params);
    }

    reuploadVertexBuffer(handle: GPUMeshHandle, interleavedData: Float32Array): void {
        this.gpuResources.writeBuffer(handle.vertexBuffer, 0, interleavedData);
    }

    releaseMesh(handle: GPUMeshHandle): void {
        handle.vertexBuffer.destroy();
        handle.indexBuffer.destroy();
    }

    releaseTexture(handle: GPUTexture): void {
        handle.destroy();
    }

    setActiveCamera(camera: RenderCamera): void {
        this.activeCamera = camera;
    }

    overrideCamera(viewMatrix: Mat4, projectionMatrix: Mat4): void {
        this.cameraOverrideView = viewMatrix.clone();
        this.cameraOverrideProj = projectionMatrix.clone();
    }

    clearCameraOverride(): void {
        this.cameraOverrideView = null;
        this.cameraOverrideProj = null;
    }

    setGraphicsQuality(quality: GraphicsQuality): void {
        this.renderPipeline.setGraphicsQuality(quality);
    }

    onCanvasResize(width: number, height: number): void {
        if (width > 0 && height > 0) {
            this.renderPipeline.onResize(width, height);
        }
    }

    getDebugRenderer(): DebugRenderer {
        return this.debugRenderer;
    }

    setBuildingTextures(
        diffuseArray: GPUTexture | null,
        normalArray: GPUTexture | null,
        layerProps: Float32Array | null,
    ): void {
        this.renderPipeline.setBuildingTextures(diffuseArray, normalArray, layerProps);
    }

    /** Forwarded to RenderPipeline; called by Engine.setEditorMode(true)
     *  on Stop so Play→Stop→Play rebuilds skinning bind groups against
     *  the current joint-matrices buffers. */
    clearSkinningCaches(): void {
        this.renderPipeline.clearSkinningCaches();
    }

    shutdown(): void {
        this.particleRenderer.shutdown();
        this.renderPipeline.shutdown();
        this.shaderLibrary.shutdown();
        this.gpuResources.shutdown();
        this.cameraOverrideView = null;
        this.cameraOverrideProj = null;
        this.activeCamera = null;
    }
}

/** Compute bounding radius (from origin) + axis-aligned bounds in one pass. */
function computeBounds(positions: Float32Array): { boundRadius: number; boundMin: Vec3; boundMax: Vec3 } {
    let maxDistSq = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const px = positions[i], py = positions[i + 1], pz = positions[i + 2];
        const d2 = px * px + py * py + pz * pz;
        if (d2 > maxDistSq) maxDistSq = d2;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    }
    return {
        boundRadius: Math.sqrt(maxDistSq),
        boundMin: new Vec3(minX, minY, minZ),
        boundMax: new Vec3(maxX, maxY, maxZ),
    };
}
