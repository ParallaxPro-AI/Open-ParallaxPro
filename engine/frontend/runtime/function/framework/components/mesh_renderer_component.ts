import { Component } from '../component.js';

/**
 * MeshRendererComponent references mesh and material assets by UUID
 * and holds runtime GPU state (set by the RenderSystem).
 *
 * materialOverrides allow per-instance PBR tweaks without duplicating the base material.
 */
export class MeshRendererComponent extends Component {
    /** Built-in primitive type (cube, sphere, plane, cylinder, capsule) or empty for custom */
    meshType: string = '';

    meshAssetUUID: string = '';
    meshAsset: string = '';
    materialAssetUUID: string = '';

    /** Per-instance PBR overrides (baseColor, metallic, roughness, emissive, etc.) */
    materialOverrides: Record<string, any> = {};

    get waterEffect(): boolean {
        return this.materialOverrides.waterEffect ?? false;
    }
    set waterEffect(v: boolean) {
        this.materialOverrides.waterEffect = v;
    }

    castShadows: boolean = true;
    receiveShadows: boolean = true;
    visible: boolean = true;

    /** Model-space rotation (degrees) for aligning GLB models with engine's -Z forward */
    modelRotationX: number = 0;
    modelRotationY: number = 0;
    modelRotationZ: number = 0;

    /** Model-space vertical offset (pre-scale), aligns mesh center with entity position */
    modelOffsetY: number = 0;

    // -- Runtime State (set by engine systems) --------------------------------

    meshData: any = null;
    materialData: any = null;
    gpuMesh: any = null;
    gpuMeshLOD1: any = null;
    gpuMeshLOD2: any = null;
    gpuMaterial: any = null;
    gpuBaseColorTexture: any = null;
    gpuNormalMapTexture: any = null;
    gpuSubMeshes: {
        firstIndex: number;
        indexCount: number;
        gpuTexture: any;
        gpuNormalMap: any;
        baseColor: [number, number, number, number];
        alphaMode?: string;
    }[] | null = null;
    skinningData: any = null;
    skeletonName: string = '';

    /**
     * Output buffers for Scene.collectMeshInstances to write the final
     * model matrix into. Reusing the same Mat4 object across frames is
     * critical: shadow_pass keys its GPU-buffer pool by matrix reference,
     * so allocating a fresh Mat4 per frame would balloon the pool (and
     * allocated GPUBuffer + GPUBindGroup with it) indefinitely.
     */
    _meshTransformCache: any = null;   // Mat4 for the rotation/offset-only transform
    _meshTransformRotX: number = NaN;
    _meshTransformRotY: number = NaN;
    _meshTransformRotZ: number = NaN;
    _meshTransformOffY: number = NaN;
    _modelMatrixCache: any = null;     // Mat4 for world × mesh-transform

    // -- Lifecycle ------------------------------------------------------------

    initialize(data: Record<string, any>): void {
        this.meshType = data.meshType ?? '';
        this.meshAssetUUID = data.meshAssetUUID ?? '';
        this.meshAsset = data.meshAsset ?? '';
        this.materialAssetUUID = data.materialAssetUUID ?? '';

        // Build materialOverrides, normalizing protocol-style names to engine names.
        let rawOverrides = data.materialOverrides
            ? JSON.parse(JSON.stringify(data.materialOverrides))
            : {};
        if (!data.materialOverrides) {
            if (data.baseColor) rawOverrides.baseColor = data.baseColor;
            if (data.metallic !== undefined) rawOverrides.metallic = data.metallic;
            if (data.roughness !== undefined) rawOverrides.roughness = data.roughness;
            if (data.emissive) rawOverrides.emissive = data.emissive;
            if (data.waterEffect !== undefined) rawOverrides.waterEffect = data.waterEffect;
        }
        if (rawOverrides.baseColorFactor && !rawOverrides.baseColor) {
            rawOverrides.baseColor = rawOverrides.baseColorFactor;
            delete rawOverrides.baseColorFactor;
        }
        if (rawOverrides.metallicFactor !== undefined && rawOverrides.metallic === undefined) {
            rawOverrides.metallic = rawOverrides.metallicFactor;
            delete rawOverrides.metallicFactor;
        }
        if (rawOverrides.roughnessFactor !== undefined && rawOverrides.roughness === undefined) {
            rawOverrides.roughness = rawOverrides.roughnessFactor;
            delete rawOverrides.roughnessFactor;
        }
        if (rawOverrides.emissiveFactor && !rawOverrides.emissive) {
            rawOverrides.emissive = rawOverrides.emissiveFactor;
            delete rawOverrides.emissiveFactor;
        }
        this.materialOverrides = rawOverrides;

        this.castShadows = data.castShadows ?? true;
        this.receiveShadows = data.receiveShadows ?? true;
        this.visible = data.visible ?? true;
        this.modelRotationX = data.modelRotationX ?? 0;
        this.modelRotationY = data.modelRotationY ?? 0;
        this.modelRotationZ = data.modelRotationZ ?? 0;
        this.markDirty();
    }

    onDestroy(): void {
        this.gpuMesh = null;
        this.gpuMaterial = null;
        this.meshData = null;
        this.materialData = null;
    }

    toJSON(): Record<string, any> {
        return {
            meshType: this.meshType,
            meshAssetUUID: this.meshAssetUUID,
            meshAsset: this.meshAsset,
            materialAssetUUID: this.materialAssetUUID,
            materialOverrides: JSON.parse(JSON.stringify(this.materialOverrides)),
            castShadows: this.castShadows,
            receiveShadows: this.receiveShadows,
            visible: this.visible,
            modelRotationX: this.modelRotationX,
            modelRotationY: this.modelRotationY,
            modelRotationZ: this.modelRotationZ,
        };
    }
}
