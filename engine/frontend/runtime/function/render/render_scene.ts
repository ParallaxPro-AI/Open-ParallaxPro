import { Vec3 } from '../../core/math/vec3.js';
import { Mat4 } from '../../core/math/mat4.js';

export interface MeshData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint16Array | Uint32Array;
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
    uvScaleX?: number;
    uvScaleY?: number;
    firstIndex?: number;
    drawIndexCount?: number;
    alphaMode?: string;
    jointMatricesBuffer?: GPUBuffer;
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

        const vp = this.camera.projectionMatrix.multiply(this.camera.viewMatrix);
        const planes = vp.extractFrustumPlanes();

        const visible = this.meshes.filter(mesh => {
            for (const plane of planes) {
                const dist = plane.normal.dot(mesh.boundCenter) + plane.d;
                if (dist < -mesh.boundRadius) return false;
            }
            return true;
        });

        // Sort by vertex buffer identity to minimize GPU state changes.
        // Meshes sharing the same GLB skip setVertexBuffer/setIndexBuffer rebinding.
        const bufferIds = new Map<GPUBuffer, number>();
        let nextId = 0;
        for (const m of visible) {
            if (!bufferIds.has(m.meshHandle.vertexBuffer)) {
                bufferIds.set(m.meshHandle.vertexBuffer, nextId++);
            }
        }
        visible.sort((a, b) => bufferIds.get(a.meshHandle.vertexBuffer)! - bufferIds.get(b.meshHandle.vertexBuffer)!);

        return visible;
    }
}
