import { Vec3 } from '../../../core/math/vec3.js';
import { Mat4 } from '../../../core/math/mat4.js';
import { GPUResourceManager } from '../gpu_resource_manager.js';
import { ShaderLibrary } from '../shader_library.js';
import { RenderScene, RenderMeshInstance, RenderCamera } from '../render_scene.js';

const SHADOW_MAP_SIZE = 1024;
const NUM_CASCADES = 4;
const SHADOW_ARRAY_LAYERS = 4;
const LIGHT_CAMERA_SIZE = 128; // 2 x mat4x4(64)
// Hard cap so the farthest cascade doesn't re-rasterize the entire world
// each frame. Beyond this, shadows simply fade out — barely noticeable
// in motion and saves a lot of draw cost.
const MAX_SHADOW_DISTANCE = 1000;
const CASCADE_SPLIT_LAMBDA = 0.75;

/**
 * Cascaded shadow map pass.
 * Renders the scene from the directional light's perspective into a depth texture
 * array with one layer per cascade. Each cascade covers a different depth slice of
 * the camera frustum — high resolution for near shadows, broad coverage for distant
 * ones.
 */
export class ShadowPass {
    private device: GPUDevice | null = null;
    private resources: GPUResourceManager | null = null;
    private pipeline: GPURenderPipeline | null = null;
    /** Second pipeline variant for building meshes (36-byte vertex stride). */
    private pipeline36: GPURenderPipeline | null = null;
    private modelBGL: GPUBindGroupLayout | null = null;

    private depthArrayTexture: GPUTexture | null = null;
    private depthArrayTextureView: GPUTextureView | null = null;
    private cascadeViews: GPUTextureView[] = [];
    private lightSpaceMatrices: Mat4[] = [];
    private cascadeSplits: number[] = [];

    private lightCameraBGL: GPUBindGroupLayout | null = null;
    private lightCameraBuffers: GPUBuffer[] = [];
    private lightCameraBindGroups: GPUBindGroup[] = [];

    /**
     * Stable per-Mat4 buffer slots with a cached copy of the last-written
     * matrix data, so static meshes skip both the inverse-transpose compute
     * AND the writeBuffer upload across 4 cascades. For a mostly-static
     * scene this kills thousands of redundant per-frame uploads.
     */
    private modelBufferPool: GPUBuffer[] = [];
    private modelBindGroupPool: GPUBindGroup[] = [];
    private modelDataScratch = new Float32Array(32);
    private matrixSlotMap = new Map<Mat4, number>();
    private slotCachedMatrix: Float32Array[] = [];

    private viewMatrix: Mat4 = new Mat4();
    private projMatrix: Mat4 = new Mat4();

    initialize(
        device: GPUDevice,
        resources: GPUResourceManager,
        shaderLib: ShaderLibrary,
        modelBGL: GPUBindGroupLayout
    ): void {
        this.device = device;
        this.resources = resources;
        this.modelBGL = modelBGL;

        // Pre-populate SHADOW_ARRAY_LAYERS slots so the lit fragment shader's
        // `cascadeMatrices[i]` / `cascadeSplits[i]` reads are always valid
        // even if we render fewer cascades than the array length.
        for (let i = 0; i < SHADOW_ARRAY_LAYERS; i++) {
            this.lightSpaceMatrices.push(new Mat4());
            this.cascadeSplits.push(0);
        }

        this.lightCameraBGL = resources.createBindGroupLayout([{
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: 'uniform' },
        }], 'shadow_light_camera_bgl');

        for (let i = 0; i < NUM_CASCADES; i++) {
            const buf = resources.createUniformBuffer(LIGHT_CAMERA_SIZE, `shadow_light_camera_${i}`);
            this.lightCameraBuffers.push(buf);
            this.lightCameraBindGroups.push(resources.createBindGroup(this.lightCameraBGL, [{
                binding: 0,
                resource: { buffer: buf },
            }], `shadow_light_camera_bg_${i}`));
        }

        this.depthArrayTexture = device.createTexture({
            label: 'shadow_depth_array',
            size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, SHADOW_ARRAY_LAYERS],
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.depthArrayTextureView = this.depthArrayTexture.createView({ dimension: '2d-array' });
        for (let i = 0; i < SHADOW_ARRAY_LAYERS; i++) {
            this.cascadeViews.push(this.depthArrayTexture.createView({
                dimension: '2d',
                baseArrayLayer: i,
                arrayLayerCount: 1,
            }));
        }

        const pipelineLayout = resources.createPipelineLayout([this.lightCameraBGL, modelBGL], 'shadow_pipeline_layout');
        const shadowModule = shaderLib.getModule('shadow_vertex');

        this.pipeline = device.createRenderPipeline({
            label: 'shadow_pipeline',
            layout: pipelineLayout,
            vertex: {
                module: shadowModule,
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 32,
                    stepMode: 'vertex',
                    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }],
                }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less',
                depthBias: 4, depthBiasSlopeScale: 3.0, depthBiasClamp: 0.002,
            },
        });

        // Building meshes use a 36-byte stride (extra u32 meta at offset 32).
        // The shadow vertex shader only reads position, so the same shader
        // module is reused — only the arrayStride changes.
        this.pipeline36 = device.createRenderPipeline({
            label: 'shadow_pipeline_36',
            layout: pipelineLayout,
            vertex: {
                module: shadowModule,
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 36,
                    stepMode: 'vertex',
                    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }],
                }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less',
                depthBias: 4, depthBiasSlopeScale: 3.0, depthBiasClamp: 0.002,
            },
        });
    }

    execute(commandEncoder: GPUCommandEncoder, scene: RenderScene): void {
        if (!this.device || !this.pipeline || !this.depthArrayTexture) return;
        if (scene.directionalLights.length === 0 || !scene.camera) return;

        const lightDir = scene.directionalLights[0].direction;
        const camera = scene.camera;

        this.computeCascadeSplits(camera.near, camera.far);

        for (let cascade = 0; cascade < NUM_CASCADES; cascade++) {
            const nearDist = cascade === 0 ? camera.near : this.cascadeSplits[cascade - 1];
            const farDist = this.cascadeSplits[cascade];

            this.computeLightMatrixForCascade(lightDir, camera, nearDist, farDist);
            this.lightSpaceMatrices[cascade] = this.projMatrix.multiply(this.viewMatrix);

            const data = new Float32Array(32);
            data.set(this.viewMatrix.data, 0);
            data.set(this.projMatrix.data, 16);
            this.device.queue.writeBuffer(this.lightCameraBuffers[cascade], 0, data);

            const lightVP = this.lightSpaceMatrices[cascade];
            const lightPlanes = lightVP.extractFrustumPlanes();
            const visibleMeshes = scene.meshes.filter(mesh => {
                for (const plane of lightPlanes) {
                    const dist = plane.normal.dot(mesh.boundCenter) + plane.d;
                    if (dist < -mesh.boundRadius) return false;
                }
                return true;
            });

            const meshBindGroups: (GPUBindGroup | null)[] = [];
            let lastVertexBuffer: GPUBuffer | null = null;
            let lastModelMatrix: Mat4 | null = null;
            let lastBindGroup: GPUBindGroup | null = null;

            for (const mesh of visibleMeshes) {
                if (mesh.alphaMode === 'BLEND') {
                    meshBindGroups.push(null);
                    continue;
                }
                if (mesh.meshHandle.vertexBuffer === lastVertexBuffer && mesh.modelMatrix === lastModelMatrix && lastBindGroup) {
                    meshBindGroups.push(lastBindGroup);
                } else {
                    const bg = this.getModelBindGroup(mesh);
                    meshBindGroups.push(bg);
                    lastVertexBuffer = mesh.meshHandle.vertexBuffer;
                    lastModelMatrix = mesh.modelMatrix;
                    lastBindGroup = bg;
                }
            }

            const renderPass = commandEncoder.beginRenderPass({
                label: `shadow_pass_cascade_${cascade}`,
                colorAttachments: [],
                depthStencilAttachment: {
                    view: this.cascadeViews[cascade],
                    depthClearValue: 1.0,
                    depthLoadOp: 'clear',
                    depthStoreOp: 'store',
                },
            });

            renderPass.setPipeline(this.pipeline);
            renderPass.setBindGroup(0, this.lightCameraBindGroups[cascade]);

            let lastVB: GPUBuffer | null = null;
            let currentStride36 = false;

            for (let i = 0; i < visibleMeshes.length; i++) {
                const mesh = visibleMeshes[i];
                if (mesh.alphaMode === 'BLEND' || !meshBindGroups[i]) continue;

                const needsStride36 = !!mesh.meshHandle.hasBuildingMeta;
                if (needsStride36 !== currentStride36) {
                    renderPass.setPipeline(needsStride36 ? this.pipeline36! : this.pipeline);
                    currentStride36 = needsStride36;
                    lastVB = null;
                }

                if (mesh.meshHandle.vertexBuffer !== lastVB) {
                    renderPass.setVertexBuffer(0, mesh.meshHandle.vertexBuffer);
                    renderPass.setIndexBuffer(mesh.meshHandle.indexBuffer, mesh.meshHandle.indexFormat);
                    lastVB = mesh.meshHandle.vertexBuffer;
                }

                renderPass.setBindGroup(1, meshBindGroups[i]!);
                renderPass.drawIndexed(
                    mesh.drawIndexCount ?? mesh.meshHandle.indexCount,
                    1,
                    mesh.firstIndex ?? 0,
                    0, 0
                );
            }

            renderPass.end();
        }
    }

    getLightSpaceMatrices(): Mat4[] { return this.lightSpaceMatrices; }
    getCascadeSplits(): number[] { return this.cascadeSplits; }
    getDepthArrayTextureView(): GPUTextureView | null { return this.depthArrayTextureView; }
    getShadowMapSize(): number { return SHADOW_MAP_SIZE; }

    shutdown(): void {
        this.depthArrayTexture?.destroy();
        this.depthArrayTexture = null;
        this.depthArrayTextureView = null;
        this.cascadeViews = [];
        for (const buf of this.lightCameraBuffers) buf.destroy();
        this.lightCameraBuffers = [];
        this.lightCameraBindGroups = [];
        for (const buf of this.modelBufferPool) buf.destroy();
        this.modelBufferPool = [];
        this.modelBindGroupPool = [];
        this.matrixSlotMap.clear();
        this.slotCachedMatrix.length = 0;
        this.pipeline = null;
        this.pipeline36 = null;
        this.device = null;
        this.resources = null;
    }

    private getModelBindGroup(mesh: RenderMeshInstance): GPUBindGroup {
        let idx = this.matrixSlotMap.get(mesh.modelMatrix);
        if (idx === undefined) {
            idx = this.matrixSlotMap.size;
            const buf = this.resources!.createUniformBuffer(128, `shadow_model_pool_${idx}`);
            this.modelBufferPool.push(buf);
            this.modelBindGroupPool.push(
                this.resources!.createBindGroup(this.modelBGL!, [{
                    binding: 0,
                    resource: { buffer: buf },
                }], `shadow_model_bg_pool_${idx}`)
            );
            this.matrixSlotMap.set(mesh.modelMatrix, idx);
            const sentinel = new Float32Array(16);
            sentinel[0] = NaN; // force first-write mismatch
            this.slotCachedMatrix[idx] = sentinel;
        }

        const cached = this.slotCachedMatrix[idx];
        const src = mesh.modelMatrix.data;
        let changed = false;
        for (let i = 0; i < 16; i++) {
            if (cached[i] !== src[i]) { changed = true; break; }
        }
        if (changed) {
            const d = this.modelDataScratch;
            d.set(src, 0);
            const inv = mesh.modelMatrix.inverse();
            if (inv) d.set(inv.transpose().data, 16);
            else { d.fill(0, 16, 32); d[16] = d[21] = d[26] = d[31] = 1; }
            this.device!.queue.writeBuffer(this.modelBufferPool[idx], 0, d.buffer, d.byteOffset, d.byteLength);
            cached.set(src);
        }

        return this.modelBindGroupPool[idx];
    }

    private computeCascadeSplits(near: number, far: number): void {
        const shadowFar = Math.min(far, MAX_SHADOW_DISTANCE);
        for (let i = 0; i < NUM_CASCADES; i++) {
            const p = (i + 1) / NUM_CASCADES;
            const log = near * Math.pow(shadowFar / near, p);
            const uniform = near + (shadowFar - near) * p;
            this.cascadeSplits[i] = CASCADE_SPLIT_LAMBDA * log + (1 - CASCADE_SPLIT_LAMBDA) * uniform;
        }
        // Pad unused layers with the last split so the shader's cascade
        // selection chain never picks a cascade we didn't render.
        const lastSplit = this.cascadeSplits[NUM_CASCADES - 1];
        for (let i = NUM_CASCADES; i < SHADOW_ARRAY_LAYERS; i++) {
            this.cascadeSplits[i] = lastSplit;
        }
    }

    private computeLightMatrixForCascade(lightDir: Vec3, camera: RenderCamera, nearDist: number, farDist: number): void {
        const dir = lightDir.normalize();
        const up = Math.abs(dir.y) > 0.99 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);

        const corners = this.getFrustumCorners(camera, nearDist, farDist);

        let cx = 0, cy = 0, cz = 0;
        for (const corner of corners) {
            cx += corner.x; cy += corner.y; cz += corner.z;
        }
        cx /= 8; cy /= 8; cz /= 8;
        const center = new Vec3(cx, cy, cz);

        let radius = 0;
        for (const corner of corners) {
            const dx = corner.x - cx, dy = corner.y - cy, dz = corner.z - cz;
            radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }

        const worldUnitsPerTexel = (radius * 2) / SHADOW_MAP_SIZE;
        if (worldUnitsPerTexel > 0) {
            radius = Math.ceil(radius / worldUnitsPerTexel) * worldUnitsPerTexel;
        }

        const padding = 100;
        const lightPos = center.add(dir.scale(-(radius + padding)));
        const lightView = Mat4.lookAt(lightPos, center, up);

        let minX = -radius, maxX = radius;
        let minY = -radius, maxY = radius;

        if (worldUnitsPerTexel > 0) {
            const vd = lightView.data;
            const lcx = vd[0] * center.x + vd[4] * center.y + vd[8] * center.z + vd[12];
            const lcy = vd[1] * center.x + vd[5] * center.y + vd[9] * center.z + vd[13];
            const snapX = Math.round(lcx / worldUnitsPerTexel) * worldUnitsPerTexel - lcx;
            const snapY = Math.round(lcy / worldUnitsPerTexel) * worldUnitsPerTexel - lcy;
            minX += snapX; maxX += snapX;
            minY += snapY; maxY += snapY;
        }

        const lightProj = Mat4.ortho(minX, maxX, minY, maxY, padding, radius * 2 + padding);

        this.viewMatrix.copy(lightView);
        this.projMatrix.copy(lightProj);
    }

    private getFrustumCorners(camera: RenderCamera, nearDist: number, farDist: number): Vec3[] {
        const tanHalfFov = 1.0 / camera.projectionMatrix.data[5];
        const aspect = camera.projectionMatrix.data[5] / camera.projectionMatrix.data[0];

        const viewInv = camera.viewMatrix.inverse();
        if (!viewInv) {
            const p = camera.position;
            return [
                new Vec3(p.x - 10, p.y - 10, p.z - 10), new Vec3(p.x + 10, p.y - 10, p.z - 10),
                new Vec3(p.x - 10, p.y + 10, p.z - 10), new Vec3(p.x + 10, p.y + 10, p.z - 10),
                new Vec3(p.x - 10, p.y - 10, p.z + 10), new Vec3(p.x + 10, p.y - 10, p.z + 10),
                new Vec3(p.x - 10, p.y + 10, p.z + 10), new Vec3(p.x + 10, p.y + 10, p.z + 10),
            ];
        }

        const vd = viewInv.data;
        const right = new Vec3(vd[0], vd[1], vd[2]);
        const camUp = new Vec3(vd[4], vd[5], vd[6]);
        const forward = new Vec3(-vd[8], -vd[9], -vd[10]);
        const pos = camera.position;

        const corners: Vec3[] = [];
        for (const dist of [nearDist, farDist]) {
            const halfH = tanHalfFov * dist;
            const halfW = halfH * aspect;
            const center = pos.add(forward.scale(dist));
            corners.push(center.add(right.scale(-halfW)).add(camUp.scale(-halfH)));
            corners.push(center.add(right.scale(halfW)).add(camUp.scale(-halfH)));
            corners.push(center.add(right.scale(-halfW)).add(camUp.scale(halfH)));
            corners.push(center.add(right.scale(halfW)).add(camUp.scale(halfH)));
        }

        return corners;
    }
}
