import { Vec3 } from '../../../core/math/vec3.js';
import { Mat4 } from '../../../core/math/mat4.js';
import { GPUResourceManager } from '../gpu_resource_manager.js';
import { ShaderLibrary } from '../shader_library.js';
import { RenderScene, RenderMeshInstance, RenderCamera } from '../render_scene.js';

const SHADOW_MAP_SIZE = 2048;
const LIGHT_CAMERA_SIZE = 128; // 2 x mat4x4(64)
const MAX_SHADOW_DISTANCE = 200;

/**
 * Single shadow map pass.
 * Renders the scene from the directional light's perspective into a 2D depth texture.
 * The shadow volume follows the camera frustum each frame using a bounding-sphere fit.
 */
export class ShadowPass {
    private device: GPUDevice | null = null;
    private resources: GPUResourceManager | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private modelBGL: GPUBindGroupLayout | null = null;
    private depthTexture: GPUTexture | null = null;
    private depthTextureView: GPUTextureView | null = null;
    private lightSpaceMatrix: Mat4 = new Mat4();

    private lightCameraBGL: GPUBindGroupLayout | null = null;
    private lightCameraBuffer: GPUBuffer | null = null;
    private lightCameraBindGroup: GPUBindGroup | null = null;

    private modelBufferPool: GPUBuffer[] = [];
    private modelBindGroupPool: GPUBindGroup[] = [];
    private modelPoolIndex = 0;
    private modelDataScratch = new Float32Array(32);

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

        this.lightCameraBGL = resources.createBindGroupLayout([{
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: 'uniform' },
        }], 'shadow_light_camera_bgl');

        this.lightCameraBuffer = resources.createUniformBuffer(LIGHT_CAMERA_SIZE, 'shadow_light_camera');
        this.lightCameraBindGroup = resources.createBindGroup(this.lightCameraBGL, [{
            binding: 0,
            resource: { buffer: this.lightCameraBuffer },
        }], 'shadow_light_camera_bg');

        this.depthTexture = device.createTexture({
            label: 'shadow_depth_map',
            size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE],
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.depthTextureView = this.depthTexture.createView();

        this.pipeline = device.createRenderPipeline({
            label: 'shadow_pipeline',
            layout: resources.createPipelineLayout([this.lightCameraBGL, modelBGL], 'shadow_pipeline_layout'),
            vertex: {
                module: shaderLib.getModule('shadow_vertex'),
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 32,
                    stepMode: 'vertex',
                    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }],
                }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'front' },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
        });
    }

    execute(commandEncoder: GPUCommandEncoder, scene: RenderScene): void {
        if (!this.device || !this.pipeline || !this.depthTextureView) return;
        if (scene.directionalLights.length === 0 || !scene.camera) return;

        this.computeLightMatrix(scene.directionalLights[0].direction, scene.camera);

        // Upload light camera matrices
        const data = new Float32Array(32);
        data.set(this.viewMatrix.data, 0);
        data.set(this.projMatrix.data, 16);
        this.device.queue.writeBuffer(this.lightCameraBuffer!, 0, data);

        this.modelPoolIndex = 0;

        // Pre-compute model bind groups
        const visibleMeshes = scene.getVisibleMeshes();
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

        // Single render pass
        const renderPass = commandEncoder.beginRenderPass({
            label: 'shadow_pass',
            colorAttachments: [],
            depthStencilAttachment: {
                view: this.depthTextureView,
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.lightCameraBindGroup!);

        let lastVB: GPUBuffer | null = null;

        for (let i = 0; i < visibleMeshes.length; i++) {
            const mesh = visibleMeshes[i];
            if (mesh.alphaMode === 'BLEND' || !meshBindGroups[i]) continue;

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

    getLightSpaceMatrix(): Mat4 { return this.lightSpaceMatrix; }
    getDepthTextureView(): GPUTextureView | null { return this.depthTextureView; }
    getShadowMapSize(): number { return SHADOW_MAP_SIZE; }

    shutdown(): void {
        this.depthTexture?.destroy();
        this.depthTexture = null;
        this.depthTextureView = null;
        if (this.lightCameraBuffer) this.lightCameraBuffer.destroy();
        this.lightCameraBuffer = null;
        this.lightCameraBindGroup = null;
        for (const buf of this.modelBufferPool) buf.destroy();
        this.modelBufferPool = [];
        this.modelBindGroupPool = [];
        this.pipeline = null;
        this.device = null;
        this.resources = null;
    }

    private getModelBindGroup(mesh: RenderMeshInstance): GPUBindGroup {
        const idx = this.modelPoolIndex++;

        if (idx >= this.modelBufferPool.length) {
            const buf = this.resources!.createUniformBuffer(128, `shadow_model_pool_${idx}`);
            this.modelBufferPool.push(buf);
            this.modelBindGroupPool.push(
                this.resources!.createBindGroup(this.modelBGL!, [{
                    binding: 0,
                    resource: { buffer: buf },
                }], `shadow_model_bg_pool_${idx}`)
            );
        }

        const d = this.modelDataScratch;
        d.set(mesh.modelMatrix.data, 0);
        const inv = mesh.modelMatrix.inverse();
        if (inv) d.set(inv.transpose().data, 16);
        else { d.fill(0, 16, 32); d[16] = d[21] = d[26] = d[31] = 1; }
        this.device!.queue.writeBuffer(this.modelBufferPool[idx], 0, d.buffer, d.byteOffset, d.byteLength);

        return this.modelBindGroupPool[idx];
    }

    private computeLightMatrix(lightDir: Vec3, camera: RenderCamera): void {
        const dir = lightDir.normalize();
        const up = Math.abs(dir.y) > 0.99 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);

        // Clamp far plane to keep reasonable shadow quality
        const shadowFar = Math.min(camera.far, MAX_SHADOW_DISTANCE);

        // Get frustum corners for the visible range
        const corners = this.getFrustumCorners(camera, camera.near, shadowFar);

        // Bounding sphere: compute center and radius
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

        // Round radius to texel grid for frame-to-frame stability
        const worldUnitsPerTexel = (radius * 2) / SHADOW_MAP_SIZE;
        if (worldUnitsPerTexel > 0) {
            radius = Math.ceil(radius / worldUnitsPerTexel) * worldUnitsPerTexel;
        }

        // Position the light camera behind the scene center along the light direction
        const padding = 100;
        const lightPos = center.add(dir.scale(-(radius + padding)));
        const lightView = Mat4.lookAt(lightPos, center, up);

        let minX = -radius, maxX = radius;
        let minY = -radius, maxY = radius;

        // Texel snapping: snap the ortho bounds to the texel grid in light space
        // to prevent sub-texel shimmering when the camera moves
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
        this.lightSpaceMatrix = lightProj.multiply(lightView);
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
