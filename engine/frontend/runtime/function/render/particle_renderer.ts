import { GPUResourceManager } from './gpu_resource_manager.js';
import { ShaderLibrary } from './shader_library.js';
import { RenderCamera } from './render_scene.js';
import { RenderStats } from './render_stats.js';

const FLOATS_PER_INSTANCE = 12;
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;

export interface ParticleRenderData {
    /** Flat array: [posX, posY, posZ, size, r, g, b, a, rotation, pad, pad, pad] per particle */
    instanceData: Float32Array;
    activeCount: number;
}

/**
 * GPU instanced particle renderer.
 * Uses a single billboarded quad mesh and per-particle instance data
 * (position, size, color, rotation) rendered in one draw call per system.
 */
export class ParticleRenderer {
    private stats: RenderStats | null = null;
    setStats(stats: RenderStats): void { this.stats = stats; }

    private device: GPUDevice | null = null;
    private resources: GPUResourceManager | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private quadVertexBuffer: GPUBuffer | null = null;
    private quadIndexBuffer: GPUBuffer | null = null;
    private instanceBuffer: GPUBuffer | null = null;
    private instanceBufferCapacity = 0;
    private cameraUniformBuffer: GPUBuffer | null = null;
    private cameraBindGroup: GPUBindGroup | null = null;

    initialize(
        device: GPUDevice,
        resources: GPUResourceManager,
        shaderLib: ShaderLibrary,
        canvasFormat: GPUTextureFormat,
        cameraBGL: GPUBindGroupLayout,
    ): void {
        this.device = device;
        this.resources = resources;

        if (!shaderLib.hasModule('particle_vertex')) {
            shaderLib.compileModule('particle_vertex', PARTICLE_VERTEX_SHADER);
        }
        if (!shaderLib.hasModule('particle_fragment')) {
            shaderLib.compileModule('particle_fragment', PARTICLE_FRAGMENT_SHADER);
        }

        // Unit quad: position(2) + uv(2) = 4 floats per vertex
        const quadVerts = new Float32Array([
            -0.5, -0.5, 0.0, 1.0,
             0.5, -0.5, 1.0, 1.0,
             0.5,  0.5, 1.0, 0.0,
            -0.5,  0.5, 0.0, 0.0,
        ]);
        this.quadVertexBuffer = resources.createVertexBuffer(quadVerts, 'particle_quad_vb');
        this.quadIndexBuffer = resources.createIndexBuffer(new Uint16Array([0, 1, 2, 0, 2, 3]), 'particle_quad_ib');

        this.cameraUniformBuffer = resources.createUniformBuffer(256, 'particle_camera_uniform');
        this.cameraBindGroup = resources.createBindGroup(cameraBGL, [{
            binding: 0,
            resource: { buffer: this.cameraUniformBuffer },
        }], 'particle_camera_bg');

        const pipelineLayout = resources.createPipelineLayout([cameraBGL], 'particle_pipeline_layout');

        this.pipeline = device.createRenderPipeline({
            label: 'particle_pipeline',
            layout: pipelineLayout,
            vertex: {
                module: shaderLib.getModule('particle_vertex'),
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 16,
                        stepMode: 'vertex',
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x2' },
                            { shaderLocation: 1, offset: 8, format: 'float32x2' },
                        ],
                    },
                    {
                        arrayStride: BYTES_PER_INSTANCE,
                        stepMode: 'instance',
                        attributes: [
                            { shaderLocation: 2, offset: 0, format: 'float32x3' },
                            { shaderLocation: 3, offset: 12, format: 'float32' },
                            { shaderLocation: 4, offset: 16, format: 'float32x4' },
                            { shaderLocation: 5, offset: 32, format: 'float32' },
                        ],
                    },
                ],
            },
            fragment: {
                module: shaderLib.getModule('particle_fragment'),
                entryPoint: 'fs_main',
                targets: [{
                    format: canvasFormat,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                    },
                }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: false,
                depthCompare: 'less',
            },
        });
    }

    render(
        commandEncoder: GPUCommandEncoder,
        colorView: GPUTextureView,
        depthView: GPUTextureView,
        camera: RenderCamera,
        particleSystems: ParticleRenderData[],
    ): void {
        if (!this.device || !this.pipeline || !this.quadVertexBuffer || !this.quadIndexBuffer) return;

        const systems = particleSystems.filter(s => s.activeCount > 0);
        if (systems.length === 0) return;

        this.uploadCameraUniform(camera);

        const renderPass = commandEncoder.beginRenderPass({
            label: 'particle_pass',
            colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
            depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
        });

        renderPass.setPipeline(this.pipeline);
        renderPass.setBindGroup(0, this.cameraBindGroup!);
        renderPass.setVertexBuffer(0, this.quadVertexBuffer);
        renderPass.setIndexBuffer(this.quadIndexBuffer, 'uint16');

        for (const system of systems) {
            this.ensureInstanceBuffer(system.activeCount);
            this.device.queue.writeBuffer(
                this.instanceBuffer!,
                0,
                system.instanceData.buffer,
                system.instanceData.byteOffset,
                system.activeCount * BYTES_PER_INSTANCE,
            );
            renderPass.setVertexBuffer(1, this.instanceBuffer!);
            renderPass.drawIndexed(6, system.activeCount);
            this.stats?.addDraw(system.activeCount * 2);
        }

        renderPass.end();
    }

    shutdown(): void {
        this.quadVertexBuffer?.destroy();
        this.quadIndexBuffer?.destroy();
        this.instanceBuffer?.destroy();
        this.cameraUniformBuffer?.destroy();
        this.quadVertexBuffer = null;
        this.quadIndexBuffer = null;
        this.instanceBuffer = null;
        this.cameraUniformBuffer = null;
        this.cameraBindGroup = null;
        this.pipeline = null;
        this.device = null;
        this.resources = null;
    }

    private uploadCameraUniform(camera: RenderCamera): void {
        if (!this.device || !this.cameraUniformBuffer) return;
        const data = new Float32Array(36);
        data.set(camera.viewMatrix.data, 0);
        data.set(camera.projectionMatrix.data, 16);
        data[32] = camera.position.x;
        data[33] = camera.position.y;
        data[34] = camera.position.z;
        this.device.queue.writeBuffer(this.cameraUniformBuffer, 0, data);
    }

    private ensureInstanceBuffer(count: number): void {
        if (!this.device || !this.resources) return;
        const needed = count * BYTES_PER_INSTANCE;
        if (this.instanceBuffer && this.instanceBufferCapacity >= needed) return;

        this.instanceBuffer?.destroy();
        const capacity = Math.max(needed, 4096) * 2;
        this.instanceBuffer = this.resources.createBuffer(
            capacity,
            GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            'particle_instance_buffer',
        );
        this.instanceBufferCapacity = capacity;
    }
}

// -- WGSL Shaders --------------------------------------------------------

const PARTICLE_VERTEX_SHADER = /* wgsl */`
struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projMatrix: mat4x4<f32>,
    cameraPos: vec3<f32>,
    _pad: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
    // Per-vertex quad data
    @location(0) quadPos: vec2<f32>,
    @location(1) quadUV: vec2<f32>,
    // Per-instance particle data
    @location(2) worldPos: vec3<f32>,
    @location(3) size: f32,
    @location(4) color: vec4<f32>,
    @location(5) rotation: f32,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    // Billboard: extract camera right and up vectors from the view matrix
    let right = vec3<f32>(camera.viewMatrix[0][0], camera.viewMatrix[1][0], camera.viewMatrix[2][0]);
    let up = vec3<f32>(camera.viewMatrix[0][1], camera.viewMatrix[1][1], camera.viewMatrix[2][1]);

    // Apply 2D rotation to the quad position
    let cosR = cos(input.rotation);
    let sinR = sin(input.rotation);
    let rotatedPos = vec2<f32>(
        input.quadPos.x * cosR - input.quadPos.y * sinR,
        input.quadPos.x * sinR + input.quadPos.y * cosR,
    );

    // Offset from particle center in world space (billboarded)
    let worldOffset = right * rotatedPos.x * input.size + up * rotatedPos.y * input.size;
    let finalWorldPos = input.worldPos + worldOffset;

    output.position = camera.projMatrix * camera.viewMatrix * vec4<f32>(finalWorldPos, 1.0);
    output.uv = input.quadUV;
    output.color = input.color;

    return output;
}
`;

const PARTICLE_FRAGMENT_SHADER = /* wgsl */`
struct FragmentInput {
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
    // Soft circular particle: compute distance from center, fade near edges
    let dist = length(input.uv - vec2<f32>(0.5, 0.5)) * 2.0;

    // Smooth circle falloff
    let alpha = 1.0 - smoothstep(0.0, 1.0, dist);

    return vec4<f32>(input.color.rgb, input.color.a * alpha);
}
`;
