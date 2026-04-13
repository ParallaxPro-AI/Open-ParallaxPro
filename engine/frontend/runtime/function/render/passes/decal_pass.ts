import { GPUResourceManager } from '../gpu_resource_manager.js';
import { ShaderLibrary, CAMERA_UNIFORM_SIZE } from '../shader_library.js';
import { RenderCamera, DecalInstance } from '../render_scene.js';

/** Bytes per decal in the storage buffer: 2 mat4x4 + vec4 = 144 bytes */
const DECAL_STRIDE = 144;
const DECAL_PARAMS_SIZE = 96; // mat4(64) + 4 floats(16) padded to 96
const MAX_DECALS = 16384;

/**
 * Screen-space projected decal pass.
 *
 * Renders instanced unit cubes for each decal. The fragment shader
 * reconstructs world position from the normalDepth MRT, projects it into
 * the decal's local space, and blends the decal color onto the color buffer.
 */
export class DecalPass {
    private device: GPUDevice | null = null;
    private pipeline: GPURenderPipeline | null = null;

    // Bind group layouts
    private cameraBGL: GPUBindGroupLayout | null = null;
    private decalBGL: GPUBindGroupLayout | null = null;
    private depthBGL: GPUBindGroupLayout | null = null;

    // GPU resources
    private cubeVB: GPUBuffer | null = null;
    private cubeIB: GPUBuffer | null = null;
    private decalStorageBuffer: GPUBuffer | null = null;
    private decalParamsBuffer: GPUBuffer | null = null;

    // Bind groups
    private cameraBindGroup: GPUBindGroup | null = null;
    private decalBindGroup: GPUBindGroup | null = null;
    private depthBindGroup: GPUBindGroup | null = null;

    // Cache invalidation
    private cachedNormalDepthView: GPUTextureView | null = null;

    // Scratch buffers for uploads
    private uploadBuffer: Float32Array | null = null;
    private paramsData = new Float32Array(24); // 96 bytes

    initialize(
        device: GPUDevice,
        resources: GPUResourceManager,
        shaderLib: ShaderLibrary,
        canvasFormat: GPUTextureFormat,
        cameraBindGroupLayout: GPUBindGroupLayout,
        cameraUniformBuffer: GPUBuffer,
    ): void {
        this.device = device;

        // Reuse the camera bind group layout from the geometry pass
        this.cameraBGL = cameraBindGroupLayout;

        this.cameraBindGroup = resources.createBindGroup(this.cameraBGL, [{
            binding: 0,
            resource: { buffer: cameraUniformBuffer },
        }], 'decal_camera_bg');

        // Decal storage buffer (group 1)
        this.decalBGL = resources.createBindGroupLayout([{
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'read-only-storage' },
        }], 'decal_storage_bgl');

        this.decalStorageBuffer = device.createBuffer({
            label: 'decal_storage',
            size: MAX_DECALS * DECAL_STRIDE,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this.decalBindGroup = resources.createBindGroup(this.decalBGL, [{
            binding: 0,
            resource: { buffer: this.decalStorageBuffer },
        }], 'decal_storage_bg');

        // Depth texture + params (group 2)
        this.depthBGL = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ], 'decal_depth_bgl');

        this.decalParamsBuffer = resources.createUniformBuffer(DECAL_PARAMS_SIZE, 'decal_params');

        // Unit cube mesh
        this.createCubeMesh(device);

        // Pipeline
        const pipelineLayout = resources.createPipelineLayout([
            this.cameraBGL,
            this.decalBGL,
            this.depthBGL,
        ], 'decal_pipeline_layout');

        this.pipeline = device.createRenderPipeline({
            label: 'decal_pipeline',
            layout: pipelineLayout,
            vertex: {
                module: shaderLib.getModule('decal_vertex'),
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: 12, // vec3<f32>
                    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat }],
                }],
            },
            fragment: {
                module: shaderLib.getModule('decal_fragment'),
                entryPoint: 'fs_main',
                targets: [{
                    format: canvasFormat,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                }],
            },
            primitive: {
                topology: 'triangle-list',
                cullMode: 'none', // fragment shader handles bounds checking
            },
            // No depth testing — we check depth via normalDepth MRT in the fragment shader
        });

        this.uploadBuffer = new Float32Array(MAX_DECALS * (DECAL_STRIDE / 4));
    }

    execute(
        commandEncoder: GPUCommandEncoder,
        colorTextureView: GPUTextureView,
        normalDepthTextureView: GPUTextureView,
        camera: RenderCamera,
        decals: DecalInstance[],
    ): void {
        if (!this.device || !this.pipeline || !this.cubeVB || !this.cubeIB) return;
        if (decals.length === 0) return;

        const count = Math.min(decals.length, MAX_DECALS);

        this.uploadDecals(decals, count);
        this.uploadParams(camera);

        // Rebuild depth bind group if normalDepth view changed
        if (normalDepthTextureView !== this.cachedNormalDepthView) {
            this.depthBindGroup = this.device.createBindGroup({
                label: 'decal_depth_bg',
                layout: this.depthBGL!,
                entries: [
                    { binding: 0, resource: normalDepthTextureView },
                    { binding: 1, resource: { buffer: this.decalParamsBuffer! } },
                ],
            });
            this.cachedNormalDepthView = normalDepthTextureView;
        }

        const renderPass = commandEncoder.beginRenderPass({
            label: 'decal_pass',
            colorAttachments: [{
                view: colorTextureView,
                loadOp: 'load',  // blend onto existing color
                storeOp: 'store',
            }],
        });

        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.cameraBindGroup!);
        renderPass.setBindGroup(1, this.decalBindGroup!);
        renderPass.setBindGroup(2, this.depthBindGroup!);
        renderPass.setVertexBuffer(0, this.cubeVB);
        renderPass.setIndexBuffer(this.cubeIB, 'uint16');
        renderPass.drawIndexed(36, count);
        renderPass.end();
    }

    onResize(): void {
        // Invalidate cached bind groups since normalDepth texture may be recreated
        this.cachedNormalDepthView = null;
        this.depthBindGroup = null;
    }

    setViewportSize(width: number, height: number): void {
        this.paramsData[18] = width;
        this.paramsData[19] = height;
    }

    shutdown(): void {
        this.cubeVB?.destroy();
        this.cubeIB?.destroy();
        this.decalStorageBuffer?.destroy();
        this.decalParamsBuffer?.destroy();
        this.cubeVB = null;
        this.cubeIB = null;
        this.decalStorageBuffer = null;
        this.decalParamsBuffer = null;
        this.cameraBindGroup = null;
        this.decalBindGroup = null;
        this.depthBindGroup = null;
        this.cachedNormalDepthView = null;
        this.uploadBuffer = null;
        this.pipeline = null;
        this.device = null;
    }

    // ── Private ──────────────────────────────────────────────────

    private createCubeMesh(device: GPUDevice): void {
        // Unit cube [-0.5, 0.5] — 8 shared vertices
        const positions = new Float32Array([
            -0.5, -0.5, -0.5,  // 0
             0.5, -0.5, -0.5,  // 1
             0.5,  0.5, -0.5,  // 2
            -0.5,  0.5, -0.5,  // 3
            -0.5, -0.5,  0.5,  // 4
             0.5, -0.5,  0.5,  // 5
             0.5,  0.5,  0.5,  // 6
            -0.5,  0.5,  0.5,  // 7
        ]);

        // CCW winding from outside (12 triangles)
        const indices = new Uint16Array([
            0, 1, 2,  0, 2, 3, // -Z
            4, 6, 5,  4, 7, 6, // +Z
            0, 3, 7,  0, 7, 4, // -X
            1, 5, 6,  1, 6, 2, // +X
            3, 2, 6,  3, 6, 7, // +Y
            0, 4, 5,  0, 5, 1, // -Y
        ]);

        this.cubeVB = device.createBuffer({
            label: 'decal_cube_vb',
            size: positions.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.cubeVB, 0, positions);

        this.cubeIB = device.createBuffer({
            label: 'decal_cube_ib',
            size: indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.cubeIB, 0, indices);
    }

    private uploadDecals(decals: DecalInstance[], count: number): void {
        if (!this.device || !this.decalStorageBuffer || !this.uploadBuffer) return;

        const buf = this.uploadBuffer;
        const floatsPerDecal = DECAL_STRIDE / 4; // 36 floats

        for (let i = 0; i < count; i++) {
            const d = decals[i];
            const off = i * floatsPerDecal;
            buf.set(d.modelMatrix.data, off);          // 16 floats
            buf.set(d.invModelMatrix.data, off + 16);   // 16 floats
            buf[off + 32] = d.color[0];
            buf[off + 33] = d.color[1];
            buf[off + 34] = d.color[2];
            buf[off + 35] = d.color[3];
        }

        this.device.queue.writeBuffer(
            this.decalStorageBuffer, 0,
            buf.buffer, buf.byteOffset,
            count * DECAL_STRIDE,
        );
    }

    private uploadParams(camera: RenderCamera): void {
        if (!this.device || !this.decalParamsBuffer) return;

        const d = this.paramsData;
        const invView = camera.viewMatrix.inverse();
        if (invView) d.set(invView.data, 0);

        d[16] = camera.projectionMatrix.data[0];  // proj[0][0]
        d[17] = camera.projectionMatrix.data[5];  // proj[1][1]
        // d[18] = viewportWidth  (set by setViewportSize)
        // d[19] = viewportHeight (set by setViewportSize)

        this.device.queue.writeBuffer(this.decalParamsBuffer, 0, d);
    }
}
