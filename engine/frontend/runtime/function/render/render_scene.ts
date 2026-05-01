import { Vec3 } from '../../core/math/vec3.js';
import { Mat4 } from '../../core/math/mat4.js';
import { TerrainGpuTextures } from '../framework/components/terrain_component.js';

export interface MeshData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint16Array | Uint32Array;
    /**
     * Registry-driven uniform scale that the renderer composes into the
     * per-mesh model matrix at draw time. Set by glb_loader for SKINNED
     * meshes only — those can't bake the scale into vertex positions
     * (would break the skeleton's bind pose), so the scale rides on the
     * model matrix instead. STATIC meshes have it baked into positions
     * directly and leave this undefined.
     *
     * uploadMesh consumes it to scale boundMin/boundMax/boundRadius up
     * to the rendered size — without this, gpuMesh bounds would be the
     * raw GLB bounds (Quaternius character pack: pre-scale ~3.7m head-
     * to-toe), and physics auto-fit would build a capsule for the un-
     * scaled character (visible Knight ~1.85m, capsule 3.7m → 2× too
     * tall). Same fix applies to anything else reading these bounds
     * (frustum cull, picking, AABB-fit box / sphere colliders).
     */
    facingScale?: number;
}

export interface GPUMeshHandle {
    vertexBuffer: GPUBuffer;
    indexBuffer: GPUBuffer;
    indexCount: number;
    indexFormat: GPUIndexFormat;
    boundRadius?: number;
    boundMin?: Vec3;
    boundMax?: Vec3;
    /** Second vertex buffer with joints (vec4<u32>) + weights (vec4<f32>) for skinned meshes */
    skinBuffer?: GPUBuffer;
    /**
     * True when this mesh was uploaded with an extra per-vertex u32 meta
     * (via `uploadBuildingMesh`). Vertex stride is 36 bytes and the
     * geometry/shadow passes route it through the building pipeline that
     * procedurally paints window grids on the walls.
     */
    hasBuildingMeta?: boolean;
}

export interface RenderMeshInstance {
    meshHandle: GPUMeshHandle;
    modelMatrix: Mat4;
    baseColor: [number, number, number, number];
    metallic: number;
    roughness: number;
    emissive: [number, number, number];
    boundCenter: Vec3;
    boundRadius: number;
    baseColorTexture?: GPUTexture;
    normalMapTexture?: GPUTexture;
    normalScale?: number;
    waterEffect?: boolean;
    /** Optional world-space Y threshold for per-pixel water rendering. See
     * MaterialUniforms.waterLevel in the PBR shader. Omit or set below all
     * terrain to disable. */
    waterLevel?: number;
    uvScaleX?: number;
    uvScaleY?: number;
    firstIndex?: number;
    drawIndexCount?: number;
    alphaMode?: string;
    jointMatricesBuffer?: GPUBuffer;

    // ── Terrain-pipeline routing ──────────────────────────────
    /** When set, routes this mesh through the terrain shader pipeline. */
    gpuTerrainTextures?: TerrainGpuTextures;
    /** Road atlas near-tile texture (terrain pipeline only). */
    roadAtlasNear?: GPUTexture;
    /** Road atlas far-tile texture (terrain pipeline only). */
    roadAtlasFar?: GPUTexture;
}

export interface DecalInstance {
    modelMatrix: Mat4;
    invModelMatrix: Mat4;
    color: [number, number, number, number];
}

export interface RenderCamera {
    viewMatrix: Mat4;
    projectionMatrix: Mat4;
    position: Vec3;
    near: number;
    far: number;
    fovY: number;
}

export interface RenderDirectionalLight {
    direction: Vec3;
    color: Vec3;
    intensity: number;
    /**
     * Maximum world-space distance the shadow cascades span. Undefined =
     * the engine default (tuned for typical arena-scale scenes); open-
     * world templates that need distant shadows can raise this.
     */
    shadowDistance?: number;
}

export interface RenderPointLight {
    position: Vec3;
    color: Vec3;
    intensity: number;
    range: number;
}

export interface RenderSpotLight {
    position: Vec3;
    direction: Vec3;
    color: Vec3;
    intensity: number;
    range: number;
    innerConeAngle: number;
    outerConeAngle: number;
}

export interface RenderFogData {
    enabled: boolean;
    color: Vec3;
    near: number;
    far: number;
}

/**
 * Per-frame render scene built from the active game scene.
 * Collects visible meshes, lights, and the active camera.
 */
export class RenderScene {
    meshes: RenderMeshInstance[] = [];
    camera: RenderCamera | null = null;
    directionalLights: RenderDirectionalLight[] = [];
    pointLights: RenderPointLight[] = [];
    spotLights: RenderSpotLight[] = [];
    ambientColor: Vec3 = new Vec3(1, 1, 1);
    ambientIntensity = 0.3;
    fog: RenderFogData = { enabled: false, color: new Vec3(0.8, 0.8, 0.8), near: 10, far: 100 };
    timeOfDay = 12.0;
    decals: DecalInstance[] = [];

    // ── Scratch storage for getVisibleMeshes() ────────────────────────
    // Reused every frame to avoid allocating a fresh Mat4 + 6 plane
    // objects + visible array + bufferIds Map on the render hot path.
    // All contents are overwritten before use; nothing carries over.
    private _vpScratch = new Mat4();
    private _planesScratch: { normal: Vec3; d: number }[] = [
        { normal: new Vec3(0, 0, 0), d: 0 },
        { normal: new Vec3(0, 0, 0), d: 0 },
        { normal: new Vec3(0, 0, 0), d: 0 },
        { normal: new Vec3(0, 0, 0), d: 0 },
        { normal: new Vec3(0, 0, 0), d: 0 },
        { normal: new Vec3(0, 0, 0), d: 0 },
    ];
    private _visibleScratch: RenderMeshInstance[] = [];
    private _bufferIdsScratch: Map<GPUBuffer, number> = new Map();

    clear(): void {
        this.meshes.length = 0;
        this.directionalLights.length = 0;
        this.pointLights.length = 0;
        this.spotLights.length = 0;
        this.camera = null;
    }

    addMesh(instance: RenderMeshInstance): void {
        this.meshes.push(instance);
    }

    setCamera(camera: RenderCamera): void {
        this.camera = camera;
    }

    addDirectionalLight(light: RenderDirectionalLight): void {
        this.directionalLights.push(light);
    }

    addPointLight(light: RenderPointLight): void {
        this.pointLights.push(light);
    }

    addSpotLight(light: RenderSpotLight): void {
        this.spotLights.push(light);
    }

    setDecals(decals: DecalInstance[]): void {
        this.decals = decals;
    }

    setAmbient(color: Vec3, intensity: number): void {
        this.ambientColor.copy(color);
        this.ambientIntensity = intensity;
    }

    setFog(fog: RenderFogData): void {
        this.fog = fog;
    }

    setTimeOfDay(time: number): void {
        this.timeOfDay = time;
    }

    /**
     * Return meshes visible to the camera via frustum culling,
     * sorted by vertex buffer identity to minimize GPU state changes.
     */
    getVisibleMeshes(): RenderMeshInstance[] {
        if (!this.camera) return this.meshes;

        // Reuse member scratch — see _vpScratch / _planesScratch / etc.
        // Same logic as the prior allocating version; just no fresh
        // objects per frame. The Map is cleared and refilled in-place.
        const vp = this.camera.projectionMatrix.multiply(this.camera.viewMatrix, this._vpScratch);
        const planes = vp.extractFrustumPlanes(this._planesScratch);

        const visible = this._visibleScratch;
        visible.length = 0;
        const meshes = this.meshes;
        outer: for (let i = 0; i < meshes.length; i++) {
            const mesh = meshes[i];
            for (let p = 0; p < planes.length; p++) {
                const plane = planes[p];
                if (plane.normal.dot(mesh.boundCenter) + plane.d < -mesh.boundRadius) continue outer;
            }
            visible.push(mesh);
        }

        // Sort by vertex buffer identity to minimize GPU state changes.
        // Meshes sharing the same GLB skip setVertexBuffer/setIndexBuffer rebinding.
        const bufferIds = this._bufferIdsScratch;
        bufferIds.clear();
        let nextId = 0;
        for (let i = 0; i < visible.length; i++) {
            const vb = visible[i].meshHandle.vertexBuffer;
            if (!bufferIds.has(vb)) bufferIds.set(vb, nextId++);
        }
        visible.sort((a, b) => bufferIds.get(a.meshHandle.vertexBuffer)! - bufferIds.get(b.meshHandle.vertexBuffer)!);

        return visible;
    }
}
