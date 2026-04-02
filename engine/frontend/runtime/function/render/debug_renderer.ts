import { Vec3 } from '../../core/math/vec3.js';
import { GPUResourceManager } from './gpu_resource_manager.js';
import { ShaderLibrary } from './shader_library.js';

interface DebugVertex {
    x: number;
    y: number;
    z: number;
    r: number;
    g: number;
    b: number;
    a: number;
}

const VERTEX_STRIDE = 7 * 4; // 28 bytes: position(3) + color(4)

/**
 * Immediate-mode debug line and shape rendering.
 * Lines and triangles are collected during the frame and flushed in a single draw call each.
 */
export class DebugRenderer {
    private device: GPUDevice | null = null;
    private linePipeline: GPURenderPipeline | null = null;
    private triPipeline: GPURenderPipeline | null = null;
    private lineVertexBuffer: GPUBuffer | null = null;
    private triVertexBuffer: GPUBuffer | null = null;
    private lineVertices: DebugVertex[] = [];
    private triVertices: DebugVertex[] = [];
    private maxLineVertices = 65536;
    private maxTriVertices = 200000;

    initialize(
        device: GPUDevice,
        resources: GPUResourceManager,
        shaderLib: ShaderLibrary,
        canvasFormat: GPUTextureFormat,
        cameraBindGroupLayout: GPUBindGroupLayout
    ): void {
        this.device = device;

        this.lineVertexBuffer = resources.createBuffer(
            this.maxLineVertices * VERTEX_STRIDE,
            GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            'debug_line_vertex_buffer'
        );

        this.triVertexBuffer = resources.createBuffer(
            this.maxTriVertices * VERTEX_STRIDE,
            GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            'debug_tri_vertex_buffer'
        );

        const pipelineLayout = resources.createPipelineLayout(
            [cameraBindGroupLayout],
            'debug_pipeline_layout'
        );

        const vertexModule = shaderLib.getModule('debug_vertex');
        const fragmentModule = shaderLib.getModule('debug_fragment');

        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: VERTEX_STRIDE,
            stepMode: 'vertex',
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x4' },
            ],
        };

        const blendState: GPUBlendState = {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        };

        const depthStencil: GPUDepthStencilState = {
            format: 'depth24plus',
            depthWriteEnabled: false,
            depthCompare: 'less-equal',
        };

        this.linePipeline = device.createRenderPipeline({
            label: 'debug_line_pipeline',
            layout: pipelineLayout,
            vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
            fragment: {
                module: fragmentModule,
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat, blend: blendState }],
            },
            primitive: { topology: 'line-list' },
            depthStencil,
            multisample: { count: 1 },
        });

        this.triPipeline = device.createRenderPipeline({
            label: 'debug_tri_pipeline',
            layout: pipelineLayout,
            vertex: { module: vertexModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
            fragment: {
                module: fragmentModule,
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat, blend: blendState }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil,
            multisample: { count: 1 },
        });
    }

    drawLine(p0: Vec3, p1: Vec3, r = 1, g = 1, b = 0, a = 1): void {
        if (this.lineVertices.length >= this.maxLineVertices - 1) return;
        this.lineVertices.push({ x: p0.x, y: p0.y, z: p0.z, r, g, b, a });
        this.lineVertices.push({ x: p1.x, y: p1.y, z: p1.z, r, g, b, a });
    }

    drawBox(center: Vec3, halfExtents: Vec3, r = 0, g = 1, b = 0, a = 1): void {
        const hx = halfExtents.x, hy = halfExtents.y, hz = halfExtents.z;
        const cx = center.x, cy = center.y, cz = center.z;
        const corners = [
            new Vec3(cx - hx, cy - hy, cz - hz),
            new Vec3(cx + hx, cy - hy, cz - hz),
            new Vec3(cx + hx, cy + hy, cz - hz),
            new Vec3(cx - hx, cy + hy, cz - hz),
            new Vec3(cx - hx, cy - hy, cz + hz),
            new Vec3(cx + hx, cy - hy, cz + hz),
            new Vec3(cx + hx, cy + hy, cz + hz),
            new Vec3(cx - hx, cy + hy, cz + hz),
        ];
        // Bottom face
        this.drawLine(corners[0], corners[1], r, g, b, a);
        this.drawLine(corners[1], corners[2], r, g, b, a);
        this.drawLine(corners[2], corners[3], r, g, b, a);
        this.drawLine(corners[3], corners[0], r, g, b, a);
        // Top face
        this.drawLine(corners[4], corners[5], r, g, b, a);
        this.drawLine(corners[5], corners[6], r, g, b, a);
        this.drawLine(corners[6], corners[7], r, g, b, a);
        this.drawLine(corners[7], corners[4], r, g, b, a);
        // Vertical edges
        this.drawLine(corners[0], corners[4], r, g, b, a);
        this.drawLine(corners[1], corners[5], r, g, b, a);
        this.drawLine(corners[2], corners[6], r, g, b, a);
        this.drawLine(corners[3], corners[7], r, g, b, a);
    }

    drawSphere(center: Vec3, radius: number, r = 0, g = 1, b = 1, a = 1): void {
        const segments = 24;
        const step = (Math.PI * 2) / segments;

        for (let i = 0; i < segments; i++) {
            const a0 = i * step;
            const a1 = (i + 1) * step;
            // XY circle
            this.drawLine(
                new Vec3(center.x + Math.cos(a0) * radius, center.y + Math.sin(a0) * radius, center.z),
                new Vec3(center.x + Math.cos(a1) * radius, center.y + Math.sin(a1) * radius, center.z),
                r, g, b, a
            );
            // XZ circle
            this.drawLine(
                new Vec3(center.x + Math.cos(a0) * radius, center.y, center.z + Math.sin(a0) * radius),
                new Vec3(center.x + Math.cos(a1) * radius, center.y, center.z + Math.sin(a1) * radius),
                r, g, b, a
            );
            // YZ circle
            this.drawLine(
                new Vec3(center.x, center.y + Math.cos(a0) * radius, center.z + Math.sin(a0) * radius),
                new Vec3(center.x, center.y + Math.cos(a1) * radius, center.z + Math.sin(a1) * radius),
                r, g, b, a
            );
        }
    }

    drawTriangle(p0: Vec3, p1: Vec3, p2: Vec3, r = 0.5, g = 0.5, b = 0.5, a = 0.6): void {
        if (this.triVertices.length >= this.maxTriVertices - 2) return;
        this.triVertices.push({ x: p0.x, y: p0.y, z: p0.z, r, g, b, a });
        this.triVertices.push({ x: p1.x, y: p1.y, z: p1.z, r, g, b, a });
        this.triVertices.push({ x: p2.x, y: p2.y, z: p2.z, r, g, b, a });
    }

    drawRay(origin: Vec3, direction: Vec3, length = 1, r = 1, g = 0, b = 0, a = 1): void {
        const end = origin.add(direction.normalize().scale(length));
        this.drawLine(origin, end, r, g, b, a);
    }

    flush(
        commandEncoder: GPUCommandEncoder,
        colorView: GPUTextureView,
        depthView: GPUTextureView,
        cameraBindGroup: GPUBindGroup
    ): void {
        if (this.lineVertices.length === 0 && this.triVertices.length === 0) return;
        if (!this.device || !this.linePipeline || !this.lineVertexBuffer) return;

        const depthStencilAttachment: GPURenderPassDepthStencilAttachment = {
            view: depthView,
            depthLoadOp: 'load',
            depthStoreOp: 'store',
        };

        // Flush solid triangles first (behind lines)
        if (this.triVertices.length > 0 && this.triPipeline && this.triVertexBuffer) {
            const triData = this.packVertices(this.triVertices);
            this.device.queue.writeBuffer(this.triVertexBuffer, 0, triData as unknown as ArrayBuffer);

            const triPass = commandEncoder.beginRenderPass({
                label: 'debug_tri_pass',
                colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
                depthStencilAttachment,
            });
            triPass.setPipeline(this.triPipeline);
            triPass.setBindGroup(0, cameraBindGroup);
            triPass.setVertexBuffer(0, this.triVertexBuffer);
            triPass.draw(this.triVertices.length);
            triPass.end();
        }

        // Then flush lines on top
        if (this.lineVertices.length > 0) {
            const lineData = this.packVertices(this.lineVertices);
            this.device.queue.writeBuffer(this.lineVertexBuffer, 0, lineData as unknown as ArrayBuffer);

            const linePass = commandEncoder.beginRenderPass({
                label: 'debug_line_pass',
                colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
                depthStencilAttachment,
            });
            linePass.setPipeline(this.linePipeline);
            linePass.setBindGroup(0, cameraBindGroup);
            linePass.setVertexBuffer(0, this.lineVertexBuffer);
            linePass.draw(this.lineVertices.length);
            linePass.end();
        }

        this.lineVertices.length = 0;
        this.triVertices.length = 0;
    }

    clear(): void {
        this.lineVertices.length = 0;
        this.triVertices.length = 0;
    }

    shutdown(): void {
        this.lineVertexBuffer?.destroy();
        this.triVertexBuffer?.destroy();
        this.lineVertexBuffer = null;
        this.triVertexBuffer = null;
        this.lineVertices.length = 0;
        this.triVertices.length = 0;
        this.linePipeline = null;
        this.triPipeline = null;
        this.device = null;
    }

    private packVertices(vertices: DebugVertex[]): Float32Array {
        const data = new Float32Array(vertices.length * 7);
        for (let i = 0; i < vertices.length; i++) {
            const v = vertices[i];
            const offset = i * 7;
            data[offset] = v.x;
            data[offset + 1] = v.y;
            data[offset + 2] = v.z;
            data[offset + 3] = v.r;
            data[offset + 4] = v.g;
            data[offset + 5] = v.b;
            data[offset + 6] = v.a;
        }
        return data;
    }
}
