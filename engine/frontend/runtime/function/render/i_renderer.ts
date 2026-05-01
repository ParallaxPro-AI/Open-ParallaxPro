import type { Mat4 } from '../../core/math/mat4.js';
import type { MeshData, GPUMeshHandle, RenderCamera, DecalInstance } from './render_scene.js';
import type { GraphicsQuality } from './passes/geometry_pass.js';
import type { DebugRenderer } from './debug_renderer.js';
import type { RenderSceneSource } from './render_system.js';

export type GfxBackend = 'webgpu' | 'webgl2';

/**
 * Common renderer surface implemented by RenderSystem (WebGPU) and
 * RenderSystemWebGL2. Lets the engine swap backends without touching
 * call sites. Handle types stay typed as GPU* — the WebGL2 backend
 * wraps its WebGL objects in shape-compatible stubs so existing
 * components storing `GPUBuffer` / `GPUTexture` references continue
 * to compile and round-trip without ever touching real WebGPU APIs.
 */
export interface IRenderer {
    readonly backend: GfxBackend;

    getCanvas(): HTMLCanvasElement | null;
    getDevice(): GPUDevice | null;

    getRenderStats(): { drawCalls: number; triangles: number; meshesRendered: number; meshesTotal: number };
    getGpuTimings(): { supported: boolean; mode: 'cpu-submit' | 'gpu'; passes: Array<{ name: string; avgMs: number; maxMs: number }> };

    tick(deltaTime: number, scene: RenderSceneSource | null): void;

    setDecals(decals: DecalInstance[]): void;

    uploadMesh(meshData: MeshData): GPUMeshHandle;
    uploadBuildingMesh(meshData: MeshData & { meta: Uint32Array }): GPUMeshHandle;
    uploadSkinnedMesh(meshData: MeshData, joints: Uint16Array, weights: Float32Array): GPUMeshHandle;

    createJointMatricesBuffer(jointCount: number): GPUBuffer;
    updateJointMatrices(buffer: GPUBuffer, matrices: Float32Array): void;

    uploadTexture(imageBitmap: ImageBitmap, params: any): GPUTexture;

    reuploadVertexBuffer(handle: GPUMeshHandle, interleavedData: Float32Array): void;
    releaseMesh(handle: GPUMeshHandle): void;
    releaseTexture(handle: GPUTexture): void;

    setActiveCamera(camera: RenderCamera): void;
    overrideCamera(viewMatrix: Mat4, projectionMatrix: Mat4): void;
    clearCameraOverride(): void;

    setGraphicsQuality(quality: GraphicsQuality): void;
    onCanvasResize(width: number, height: number): void;

    getDebugRenderer(): DebugRenderer;

    setBuildingTextures(
        diffuseArray: GPUTexture | null,
        normalArray: GPUTexture | null,
        layerProps: Float32Array | null,
    ): void;

    clearSkinningCaches(): void;

    shutdown(): void;
}
