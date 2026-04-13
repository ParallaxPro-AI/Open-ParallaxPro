import { Mat4 } from '../../../core/math/mat4.js';
import { GPUResourceManager } from '../gpu_resource_manager.js';
import { ShaderLibrary, CAMERA_UNIFORM_SIZE, MODEL_UNIFORM_SIZE, MATERIAL_UNIFORM_SIZE, LIGHT_UNIFORM_SIZE } from '../shader_library.js';
import { RenderScene, RenderMeshInstance, RenderCamera } from '../render_scene.js';

export type GraphicsQuality = 'low' | 'medium' | 'high';

/**
 * Main forward rendering pass with PBR lighting.
 * Supports a single shadow map, MSAA, offscreen MRT, skinned meshes,
 * and alpha-blended transparency.
 */
export class GeometryPass {
    private device: GPUDevice | null = null;
    private resources: GPUResourceManager | null = null;
    private canvasFormat: GPUTextureFormat = 'bgra8unorm';

    // Opaque pipelines (one per quality mode)
    private pipelineStandard: GPURenderPipeline | null = null;
    private pipelineMRT: GPURenderPipeline | null = null;
    private pipelineMSAA: GPURenderPipeline | null = null;

    // Transparent pipelines (alpha blend, no depth write)
    private pipelineStandardBlend: GPURenderPipeline | null = null;
    private pipelineMRTBlend: GPURenderPipeline | null = null;
    private pipelineMSAABlend: GPURenderPipeline | null = null;

    // Skinned pipelines
    private skinnedPipelineStandard: GPURenderPipeline | null = null;
    private skinnedPipelineMRT: GPURenderPipeline | null = null;
    private skinnedPipelineMSAA: GPURenderPipeline | null = null;

    // Building pipelines (36-byte vertex stride with extra u32 buildingMeta)
    private buildingPipelineStandard: GPURenderPipeline | null = null;
    private buildingPipelineMRT: GPURenderPipeline | null = null;
    private buildingPipelineMSAA: GPURenderPipeline | null = null;

    // Terrain pipelines (standard vertex + dedicated terrain fragment)
    private terrainPipelineStandard: GPURenderPipeline | null = null;
    private terrainPipelineMRT: GPURenderPipeline | null = null;
    private terrainPipelineMSAA: GPURenderPipeline | null = null;

    // Bind group layouts
    private cameraBindGroupLayout: GPUBindGroupLayout | null = null;
    private modelBindGroupLayout: GPUBindGroupLayout | null = null;
    private skinnedModelBindGroupLayout: GPUBindGroupLayout | null = null;
    private materialBindGroupLayout: GPUBindGroupLayout | null = null;
    private buildingMaterialBindGroupLayout: GPUBindGroupLayout | null = null;
    private terrainMaterialBindGroupLayout: GPUBindGroupLayout | null = null;
    private lightBindGroupLayout: GPUBindGroupLayout | null = null;

    // Uniform buffers and bind groups
    private cameraUniformBuffer: GPUBuffer | null = null;
    private lightUniformBuffer: GPUBuffer | null = null;
    private cameraBindGroup: GPUBindGroup | null = null;
    private lightBindGroup: GPUBindGroup | null = null;

    // Depth textures
    private depthTexture: GPUTexture | null = null;
    private depthTextureView: GPUTextureView | null = null;
    private msaaDepthTexture: GPUTexture | null = null;
    private msaaDepthTextureView: GPUTextureView | null = null;

    // Offscreen color target
    private offscreenColorTexture: GPUTexture | null = null;
    private offscreenColorTextureView: GPUTextureView | null = null;
    private msaaColorTexture: GPUTexture | null = null;
    private msaaColorTextureView: GPUTextureView | null = null;

    // Normal+depth MRT target
    private normalDepthTexture: GPUTexture | null = null;
    private normalDepthTextureView: GPUTextureView | null = null;
    private msaaNormalDepthTexture: GPUTexture | null = null;
    private msaaNormalDepthTextureView: GPUTextureView | null = null;

    // Default textures
    private defaultWhiteTexture: GPUTexture | null = null;
    private defaultWhiteTextureView: GPUTextureView | null = null;
    private defaultNormalTexture: GPUTexture | null = null;
    private defaultNormalTextureView: GPUTextureView | null = null;
    private defaultSampler: GPUSampler | null = null;
    // 1-layer 2d-array fallbacks for building bind group before real textures load
    private defaultWhiteArrayTexture: GPUTexture | null = null;
    private defaultWhiteArrayTextureView: GPUTextureView | null = null;
    private defaultNormalArrayTexture: GPUTexture | null = null;
    private defaultNormalArrayTextureView: GPUTextureView | null = null;

    // Building texture arrays (from Poly Haven)
    private buildingDiffuseArray: GPUTexture | null = null;
    private buildingDiffuseArrayView: GPUTextureView | null = null;
    private buildingNormalArray: GPUTexture | null = null;
    private buildingNormalArrayView: GPUTextureView | null = null;
    private buildingLayerPropsBuffer: GPUBuffer | null = null;
    private buildingMaterialBindGroup: GPUBindGroup | null = null;

    // Terrain material bind group cache (keyed by texture IDs)
    private terrainMaterialBindGroupCache = new Map<string, GPUBindGroup>();
    private terrainLayerPropsBuffer: GPUBuffer | null = null;
    private defaultBlackTexture: GPUTexture | null = null;
    private defaultBlackTextureView: GPUTextureView | null = null;

    // Shadow map bindings
    private dummyShadowTexture: GPUTexture | null = null;
    private dummyShadowTextureView: GPUTextureView | null = null;
    private shadowComparisonSampler: GPUSampler | null = null;
    private shadowMapView: GPUTextureView | null = null;
    private cascadeMatrices: Mat4[] = [new Mat4(), new Mat4(), new Mat4(), new Mat4()];
    private cascadeSplits: number[] = [0, 0, 0, 0];

    // State
    private canvasWidth = 0;
    private canvasHeight = 0;
    private quality: GraphicsQuality = 'low';
    private shadowEnabled = false;
    private shadowMapSize = 2048;

    // Pre-allocated GPU resource pools
    private modelBufferPool: GPUBuffer[] = [];
    private modelBindGroupPool: GPUBindGroup[] = [];
    private modelPoolIndex = 0;
    private modelDataScratch = new Float32Array(32);
    private materialBindGroupCache = new Map<string, GPUBindGroup>();
    private nextTextureId = 1;
    private textureIdMap = new WeakMap<GPUTexture, number>();

    // Texture view cache: avoids creating duplicate views for the same GPUTexture
    private textureViewCache = new WeakMap<GPUTexture, GPUTextureView>();

    // Skinned model bind group pool: cache by (modelBufferIndex, jointBuffer)
    private skinnedModelBindGroupCache = new Map<string, GPUBindGroup>();

    initialize(
        device: GPUDevice,
        resources: GPUResourceManager,
        shaderLib: ShaderLibrary,
        canvasFormat: GPUTextureFormat,
        width: number,
        height: number
    ): void {
        this.device = device;
        this.resources = resources;
        this.canvasFormat = canvasFormat;
        this.canvasWidth = width;
        this.canvasHeight = height;

        this.createBindGroupLayouts(resources);
        this.createUniformBuffers(resources);
        this.createDefaultTextures(device);
        this.createDepthTexture(width, height);
        this.rebuildPipelines(device, resources, shaderLib, canvasFormat);
        this.rebuildLightBindGroup();
        this.rebuildBuildingMaterialBindGroup();
    }

    setGraphicsQuality(quality: GraphicsQuality): void {
        if (this.quality === quality) return;
        this.quality = quality;
        this.recreateRenderTargets();
    }

    setShadowMap(
        textureView: GPUTextureView | null,
        cascadeMatrices: Mat4[],
        cascadeSplits: number[],
        shadowMapSize: number,
    ): void {
        this.shadowMapView = textureView;
        for (let i = 0; i < 4; i++) {
            this.cascadeMatrices[i] = cascadeMatrices[i] ?? new Mat4();
            this.cascadeSplits[i] = cascadeSplits[i] ?? 0;
        }
        this.shadowEnabled = textureView !== null;
        this.shadowMapSize = shadowMapSize;
        this.rebuildLightBindGroup();
    }

    setBuildingTextures(
        diffuseArray: GPUTexture | null,
        normalArray: GPUTexture | null,
        layerProps: Float32Array | null,
    ): void {
        this.buildingDiffuseArray = diffuseArray;
        this.buildingNormalArray = normalArray;

        if (diffuseArray) {
            this.buildingDiffuseArrayView = diffuseArray.createView({
                dimension: '2d-array',
                format: 'rgba8unorm',
            });
        }
        if (normalArray) {
            this.buildingNormalArrayView = normalArray.createView({
                dimension: '2d-array',
                format: 'rgba8unorm',
            });
        }

        // Create layer properties buffer if we have properties
        if (layerProps && this.resources) {
            this.buildingLayerPropsBuffer = this.resources.createUniformBuffer(layerProps.byteLength, 'building_layer_props');
            this.device?.queue.writeBuffer(this.buildingLayerPropsBuffer, 0, layerProps);
        }

        this.rebuildBuildingMaterialBindGroup();
    }

    private rebuildBuildingMaterialBindGroup(): void {
        if (!this.device || !this.resources || !this.buildingMaterialBindGroupLayout) return;

        // layerProps uniform must be 256-byte aligned; 16 layers × 4 floats × 4 bytes = 256 bytes
        const LAYER_PROPS_SIZE = 256;

        const layerPropsBuffer = this.buildingLayerPropsBuffer
            ?? this.resources.createUniformBuffer(LAYER_PROPS_SIZE, 'building_layer_props_dummy');

        this.buildingMaterialBindGroup = this.resources.createBindGroup(
            this.buildingMaterialBindGroupLayout,
            [
                { binding: 0, resource: this.buildingDiffuseArrayView ?? this.defaultWhiteArrayTextureView! },
                { binding: 1, resource: this.defaultSampler! },
                { binding: 2, resource: this.buildingNormalArrayView ?? this.defaultNormalArrayTextureView! },
                { binding: 3, resource: { buffer: layerPropsBuffer } },
            ],
            'building_material_bg',
        );
    }

    execute(commandEncoder: GPUCommandEncoder, swapchainView: GPUTextureView, scene: RenderScene): void {
        if (!this.device || !this.depthTextureView || !scene.camera) return;

        this.uploadCameraUniforms(scene.camera);
        this.uploadLightUniforms(scene);

        const visibleMeshes = scene.getVisibleMeshes();

        if (this.quality === 'high' && this.pipelineMSAA && this.msaaColorTextureView && this.msaaDepthTextureView) {
            this.executeHighQuality(commandEncoder, visibleMeshes);
        } else if ((this.quality === 'low' || this.quality === 'medium') && this.offscreenColorTextureView && this.normalDepthTextureView && this.pipelineMRT) {
            this.executeMediumQuality(commandEncoder, visibleMeshes);
        } else {
            this.executeStandard(commandEncoder, swapchainView, this.depthTextureView, visibleMeshes);
        }
    }

    onResize(width: number, height: number): void {
        this.canvasWidth = width;
        this.canvasHeight = height;
        this.createDepthTexture(width, height);
        this.recreateRenderTargets();
    }

    getCameraBindGroupLayout(): GPUBindGroupLayout | null { return this.cameraBindGroupLayout; }
    getCameraUniformBuffer(): GPUBuffer | null { return this.cameraUniformBuffer; }
    getModelBindGroupLayout(): GPUBindGroupLayout | null { return this.modelBindGroupLayout; }
    getCameraBindGroup(): GPUBindGroup | null { return this.cameraBindGroup; }
    getDepthTextureView(): GPUTextureView | null { return this.depthTextureView; }
    getOffscreenColorTextureView(): GPUTextureView | null { return this.offscreenColorTextureView; }
    getNormalDepthTextureView(): GPUTextureView | null { return this.normalDepthTextureView; }

    shutdown(): void {
        for (const buf of this.modelBufferPool) buf.destroy();
        this.modelBufferPool.length = 0;
        this.modelBindGroupPool.length = 0;
        this.materialBindGroupCache.clear();
        this.skinnedModelBindGroupCache.clear();
        this.terrainMaterialBindGroupCache.clear();

        this.depthTexture?.destroy();
        this.defaultWhiteTexture?.destroy();
        this.defaultNormalTexture?.destroy();
        this.defaultWhiteArrayTexture?.destroy();
        this.defaultNormalArrayTexture?.destroy();
        this.buildingDiffuseArray?.destroy();
        this.buildingNormalArray?.destroy();
        this.buildingLayerPropsBuffer?.destroy();
        this.defaultBlackTexture?.destroy();
        this.terrainLayerPropsBuffer?.destroy();
        this.dummyShadowTexture?.destroy();
        this.offscreenColorTexture?.destroy();
        this.msaaColorTexture?.destroy();
        this.normalDepthTexture?.destroy();
        this.msaaNormalDepthTexture?.destroy();
        this.msaaDepthTexture?.destroy();
        this.cameraUniformBuffer?.destroy();
        this.lightUniformBuffer?.destroy();

        this.depthTexture = null;
        this.defaultWhiteTexture = null;
        this.defaultNormalTexture = null;
        this.defaultBlackTexture = null;
        this.terrainLayerPropsBuffer = null;
        this.dummyShadowTexture = null;
        this.offscreenColorTexture = null;
        this.msaaColorTexture = null;
        this.normalDepthTexture = null;
        this.msaaNormalDepthTexture = null;
        this.msaaDepthTexture = null;
        this.cameraUniformBuffer = null;
        this.lightUniformBuffer = null;
        this.pipelineStandard = null;
        this.pipelineMRT = null;
        this.pipelineMSAA = null;
        this.device = null;
        this.resources = null;
    }

    // ── Private: Initialization ───────────────────────────────────────

    private createBindGroupLayouts(resources: GPUResourceManager): void {
        this.cameraBindGroupLayout = resources.createBindGroupLayout([{
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform' },
        }], 'camera_bgl');

        this.modelBindGroupLayout = resources.createBindGroupLayout([{
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: 'uniform' },
        }], 'model_bgl');

        this.skinnedModelBindGroupLayout = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        ], 'skinned_model_bgl');

        this.materialBindGroupLayout = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        ], 'material_bgl');

        this.buildingMaterialBindGroupLayout = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ], 'building_material_bgl');

        // Terrain material: material uniform + road atlas pair (2D) +
        // ground texture arrays (2D-array) + layer props + sidewalk pair + weight map
        this.terrainMaterialBindGroupLayout = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },                                  // material
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },        // road atlas near
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },        // road atlas far
            { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },  // ground diffuse
            { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },  // ground normal
            { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },                                  // layer props
            { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },        // sidewalk diffuse
            { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },        // sidewalk normal
            { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },        // ground type weight map
        ], 'terrain_material_bgl');

        this.lightBindGroupLayout = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth', viewDimension: '2d-array' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        ], 'light_bgl');
    }

    private createUniformBuffers(resources: GPUResourceManager): void {
        this.cameraUniformBuffer = resources.createUniformBuffer(CAMERA_UNIFORM_SIZE, 'camera_uniform');
        this.lightUniformBuffer = resources.createUniformBuffer(LIGHT_UNIFORM_SIZE, 'light_uniform');
        this.cameraBindGroup = resources.createBindGroup(this.cameraBindGroupLayout!, [{
            binding: 0,
            resource: { buffer: this.cameraUniformBuffer },
        }], 'camera_bg');
    }

    private createDefaultTextures(device: GPUDevice): void {
        // 1x1 white texture
        this.defaultWhiteTexture = device.createTexture({
            label: 'default_white_1x1',
            size: [1, 1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
            { texture: this.defaultWhiteTexture },
            new Uint8Array([255, 255, 255, 255]),
            { bytesPerRow: 4 },
            [1, 1, 1],
        );
        this.defaultWhiteTextureView = this.defaultWhiteTexture.createView();

        // 1x1 flat normal map (tangent-space up)
        this.defaultNormalTexture = device.createTexture({
            label: 'default_normal_1x1',
            size: [1, 1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
            { texture: this.defaultNormalTexture },
            new Uint8Array([128, 128, 255, 255]),
            { bytesPerRow: 4 },
            [1, 1, 1],
        );
        this.defaultNormalTextureView = this.defaultNormalTexture.createView();

        this.defaultSampler = device.createSampler({
            label: 'default_sampler',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat',
        });

        // 1×1×1 2d-array fallbacks used by building bind group before real textures load
        this.defaultWhiteArrayTexture = device.createTexture({
            label: 'default_white_array_1x1x1',
            size: [1, 1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
            { texture: this.defaultWhiteArrayTexture },
            new Uint8Array([255, 255, 255, 255]),
            { bytesPerRow: 4 },
            [1, 1, 1],
        );
        this.defaultWhiteArrayTextureView = this.defaultWhiteArrayTexture.createView({ dimension: '2d-array' });

        this.defaultNormalArrayTexture = device.createTexture({
            label: 'default_normal_array_1x1x1',
            size: [1, 1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
            { texture: this.defaultNormalArrayTexture },
            new Uint8Array([128, 128, 255, 255]),
            { bytesPerRow: 4 },
            [1, 1, 1],
        );
        this.defaultNormalArrayTextureView = this.defaultNormalArrayTexture.createView({ dimension: '2d-array' });

        // 1×1 black texture — fallback for the terrain weight map when no
        // ground-type map is provided (forces height-based layer weights).
        this.defaultBlackTexture = device.createTexture({
            label: 'default_black_1x1',
            size: [1, 1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
            { texture: this.defaultBlackTexture },
            new Uint8Array([0, 0, 0, 0]),
            { bytesPerRow: 4 },
            [1, 1, 1],
        );
        this.defaultBlackTextureView = this.defaultBlackTexture.createView();

        // Dummy shadow depth texture (1x1 × 4-layer array, for when shadows
        // are disabled or before the first shadow pass runs). Must be a 2d-array
        // because the lit shader's `shadowMap` binding is texture_depth_2d_array.
        this.dummyShadowTexture = device.createTexture({
            label: 'dummy_shadow_array_1x1x4',
            size: [1, 1, 4],
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.dummyShadowTextureView = this.dummyShadowTexture.createView({ dimension: '2d-array' });

        this.shadowComparisonSampler = device.createSampler({
            label: 'shadow_comparison_sampler',
            compare: 'less',
            magFilter: 'linear',
            minFilter: 'linear',
        });
    }

    private createDepthTexture(width: number, height: number): void {
        this.depthTexture?.destroy();
        if (!this.resources || width === 0 || height === 0) return;
        this.depthTexture = this.resources.createDepthTexture(width, height, 'geometry_depth');
        this.depthTextureView = this.depthTexture.createView();
    }

    private rebuildPipelines(
        device: GPUDevice,
        resources: GPUResourceManager,
        shaderLib: ShaderLibrary,
        canvasFormat: GPUTextureFormat
    ): void {
        const vertexModule = shaderLib.getModule('pbr_vertex');
        const fragmentModule = shaderLib.getModule('pbr_fragment');
        const fragmentMRTModule = shaderLib.getModule('pbr_fragment_mrt');

        const pipelineLayout = resources.createPipelineLayout([
            this.cameraBindGroupLayout!,
            this.modelBindGroupLayout!,
            this.materialBindGroupLayout!,
            this.lightBindGroupLayout!,
        ], 'pbr_pipeline_layout');

        // Building pipeline layout uses texture arrays for materials
        const buildingPipelineLayout = resources.createPipelineLayout([
            this.cameraBindGroupLayout!,
            this.modelBindGroupLayout!,
            this.buildingMaterialBindGroupLayout!,
            this.lightBindGroupLayout!,
        ], 'building_pipeline_layout');

        const vertexState: GPUVertexState = {
            module: vertexModule,
            entryPoint: 'vs_main',
            buffers: [{
                arrayStride: 32,
                stepMode: 'vertex',
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat },
                    { shaderLocation: 1, offset: 12, format: 'float32x3' as GPUVertexFormat },
                    { shaderLocation: 2, offset: 24, format: 'float32x2' as GPUVertexFormat },
                ],
            }],
        };

        const opaqueDepthStencil: GPUDepthStencilState = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };
        const opaquePrimitive: GPUPrimitiveState = { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' };

        // Standard pipeline (single color, sampleCount=1)
        this.pipelineStandard = device.createRenderPipeline({
            label: 'pbr_pipeline_standard',
            layout: pipelineLayout,
            vertex: vertexState,
            fragment: { module: fragmentModule, entryPoint: 'fs_main', targets: [{ format: canvasFormat }] },
            primitive: opaquePrimitive,
            depthStencil: opaqueDepthStencil,
            multisample: { count: 1 },
        });

        // MRT pipeline (sampleCount=1) for medium quality
        this.pipelineMRT = device.createRenderPipeline({
            label: 'pbr_pipeline_mrt',
            layout: pipelineLayout,
            vertex: vertexState,
            fragment: {
                module: fragmentMRTModule,
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat }, { format: 'rgba16float' }],
            },
            primitive: opaquePrimitive,
            depthStencil: opaqueDepthStencil,
            multisample: { count: 1 },
        });

        // MSAA pipeline (sampleCount=4, MRT) for high quality
        const mrtPipelineLayout = resources.createPipelineLayout([
            this.cameraBindGroupLayout!,
            this.modelBindGroupLayout!,
            this.materialBindGroupLayout!,
            this.lightBindGroupLayout!,
        ], 'pbr_mrt_pipeline_layout');

        this.pipelineMSAA = device.createRenderPipeline({
            label: 'pbr_pipeline_msaa_mrt',
            layout: mrtPipelineLayout,
            vertex: vertexState,
            fragment: {
                module: fragmentMRTModule,
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat }, { format: 'rgba16float' }],
            },
            primitive: opaquePrimitive,
            depthStencil: opaqueDepthStencil,
            multisample: { count: 4 },
        });

        // Skinned pipeline variants
        const skinnedVertexModule = shaderLib.getModule('pbr_vertex_skinned');
        const skinnedPipelineLayout = resources.createPipelineLayout([
            this.cameraBindGroupLayout!,
            this.skinnedModelBindGroupLayout!,
            this.materialBindGroupLayout!,
            this.lightBindGroupLayout!,
        ], 'skinned_pipeline_layout');

        const skinnedVertexState: GPUVertexState = {
            module: skinnedVertexModule,
            entryPoint: 'vs_main',
            buffers: [
                {
                    arrayStride: 32,
                    stepMode: 'vertex',
                    attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat },
                        { shaderLocation: 1, offset: 12, format: 'float32x3' as GPUVertexFormat },
                        { shaderLocation: 2, offset: 24, format: 'float32x2' as GPUVertexFormat },
                    ],
                },
                {
                    arrayStride: 32,
                    stepMode: 'vertex',
                    attributes: [
                        { shaderLocation: 3, offset: 0, format: 'uint32x4' as GPUVertexFormat },
                        { shaderLocation: 4, offset: 16, format: 'float32x4' as GPUVertexFormat },
                    ],
                },
            ],
        };

        this.skinnedPipelineStandard = device.createRenderPipeline({
            label: 'skinned_pipeline_standard',
            layout: skinnedPipelineLayout,
            vertex: skinnedVertexState,
            fragment: { module: fragmentModule, entryPoint: 'fs_main', targets: [{ format: canvasFormat }] },
            primitive: opaquePrimitive,
            depthStencil: opaqueDepthStencil,
            multisample: { count: 1 },
        });

        this.skinnedPipelineMRT = device.createRenderPipeline({
            label: 'skinned_pipeline_mrt',
            layout: skinnedPipelineLayout,
            vertex: skinnedVertexState,
            fragment: { module: fragmentMRTModule, entryPoint: 'fs_main', targets: [{ format: canvasFormat }, { format: 'rgba16float' }] },
            primitive: opaquePrimitive,
            depthStencil: opaqueDepthStencil,
            multisample: { count: 1 },
        });

        this.skinnedPipelineMSAA = device.createRenderPipeline({
            label: 'skinned_pipeline_msaa',
            layout: skinnedPipelineLayout,
            vertex: skinnedVertexState,
            fragment: { module: fragmentMRTModule, entryPoint: 'fs_main', targets: [{ format: canvasFormat }, { format: 'rgba16float' }] },
            primitive: opaquePrimitive,
            depthStencil: opaqueDepthStencil,
            multisample: { count: 4 },
        });

        // ── Building pipeline variants ──
        // Same bind group layouts as regular PBR — only the vertex layout
        // differs (36-byte stride with an extra u32 meta at offset 32) and
        // the fragment shader paints a procedural window grid on top of
        // the standard PBR result.
        const buildingVertexModule = shaderLib.getModule('building_vertex');
        const buildingFragmentModule = shaderLib.getModule('building_fragment');
        const buildingFragmentMRTModule = shaderLib.getModule('building_fragment_mrt');
        const buildingVertexState: GPUVertexState = {
            module: buildingVertexModule,
            entryPoint: 'vs_main',
            buffers: [{
                arrayStride: 36,
                stepMode: 'vertex',
                attributes: [
                    { shaderLocation: 0, offset: 0,  format: 'float32x3' as GPUVertexFormat },
                    { shaderLocation: 1, offset: 12, format: 'float32x3' as GPUVertexFormat },
                    { shaderLocation: 2, offset: 24, format: 'float32x2' as GPUVertexFormat },
                    { shaderLocation: 3, offset: 32, format: 'uint32'    as GPUVertexFormat },
                ],
            }],
        };

        this.buildingPipelineStandard = device.createRenderPipeline({
            label: 'building_pipeline_standard',
            layout: buildingPipelineLayout,
            vertex: buildingVertexState,
            fragment: { module: buildingFragmentModule, entryPoint: 'fs_main', targets: [{ format: canvasFormat }] },
            primitive: opaquePrimitive,
            depthStencil: opaqueDepthStencil,
            multisample: { count: 1 },
        });

        this.buildingPipelineMRT = device.createRenderPipeline({
            label: 'building_pipeline_mrt',
            layout: buildingPipelineLayout,
            vertex: buildingVertexState,
            fragment: {
                module: buildingFragmentMRTModule,
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat }, { format: 'rgba16float' }],
            },
            primitive: opaquePrimitive,
            depthStencil: opaqueDepthStencil,
            multisample: { count: 1 },
        });

        this.buildingPipelineMSAA = device.createRenderPipeline({
            label: 'building_pipeline_msaa',
            layout: buildingPipelineLayout,
            vertex: buildingVertexState,
            fragment: {
                module: buildingFragmentMRTModule,
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat }, { format: 'rgba16float' }],
            },
            primitive: opaquePrimitive,
            depthStencil: opaqueDepthStencil,
            multisample: { count: 4 },
        });

        // ── Terrain pipeline variants ──
        // Reuses the standard PBR vertex shader (same 32-byte vertex layout)
        // with the dedicated terrain fragment shader that handles ground layer
        // blending, road atlas overlay, and per-pixel water.
        const terrainFragmentModule = shaderLib.getModule('terrain_fragment');
        const terrainFragmentMRTModule = shaderLib.getModule('terrain_fragment_mrt');
        const terrainPipelineLayout = resources.createPipelineLayout([
            this.cameraBindGroupLayout!,
            this.modelBindGroupLayout!,
            this.terrainMaterialBindGroupLayout!,
            this.lightBindGroupLayout!,
        ], 'terrain_pipeline_layout');

        this.terrainPipelineStandard = device.createRenderPipeline({
            label: 'terrain_pipeline_standard',
            layout: terrainPipelineLayout,
            vertex: vertexState,
            fragment: { module: terrainFragmentModule, entryPoint: 'fs_main', targets: [{ format: canvasFormat }] },
            primitive: opaquePrimitive,
            depthStencil: opaqueDepthStencil,
            multisample: { count: 1 },
        });

        this.terrainPipelineMRT = device.createRenderPipeline({
            label: 'terrain_pipeline_mrt',
            layout: terrainPipelineLayout,
            vertex: vertexState,
            fragment: {
                module: terrainFragmentMRTModule,
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat }, { format: 'rgba16float' }],
            },
            primitive: opaquePrimitive,
            depthStencil: opaqueDepthStencil,
            multisample: { count: 1 },
        });

        this.terrainPipelineMSAA = device.createRenderPipeline({
            label: 'terrain_pipeline_msaa',
            layout: terrainPipelineLayout,
            vertex: vertexState,
            fragment: {
                module: terrainFragmentMRTModule,
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat }, { format: 'rgba16float' }],
            },
            primitive: opaquePrimitive,
            depthStencil: opaqueDepthStencil,
            multisample: { count: 4 },
        });

        // Transparent pipeline variants
        const blendState: GPUBlendState = {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        };
        const blendDepthStencil: GPUDepthStencilState = { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' };
        const blendPrimitive: GPUPrimitiveState = { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' };

        this.pipelineStandardBlend = device.createRenderPipeline({
            label: 'pbr_pipeline_standard_blend',
            layout: pipelineLayout,
            vertex: vertexState,
            fragment: { module: fragmentModule, entryPoint: 'fs_main', targets: [{ format: canvasFormat, blend: blendState }] },
            primitive: blendPrimitive,
            depthStencil: blendDepthStencil,
            multisample: { count: 1 },
        });

        this.pipelineMRTBlend = device.createRenderPipeline({
            label: 'pbr_pipeline_mrt_blend',
            layout: pipelineLayout,
            vertex: vertexState,
            fragment: {
                module: fragmentMRTModule,
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat, blend: blendState }, { format: 'rgba16float' }],
            },
            primitive: blendPrimitive,
            depthStencil: blendDepthStencil,
            multisample: { count: 1 },
        });

        this.pipelineMSAABlend = device.createRenderPipeline({
            label: 'pbr_pipeline_msaa_mrt_blend',
            layout: mrtPipelineLayout,
            vertex: vertexState,
            fragment: {
                module: fragmentMRTModule,
                entryPoint: 'fs_main',
                targets: [{ format: canvasFormat, blend: blendState }, { format: 'rgba16float' }],
            },
            primitive: blendPrimitive,
            depthStencil: blendDepthStencil,
            multisample: { count: 4 },
        });
    }

    private rebuildLightBindGroup(): void {
        if (!this.resources || !this.lightBindGroupLayout || !this.lightUniformBuffer) return;
        this.lightBindGroup = this.resources.createBindGroup(this.lightBindGroupLayout, [
            { binding: 0, resource: { buffer: this.lightUniformBuffer } },
            { binding: 1, resource: this.shadowMapView ?? this.dummyShadowTextureView! },
            { binding: 2, resource: this.shadowComparisonSampler! },
        ], 'light_bg');
    }

    private recreateRenderTargets(): void {
        if (!this.device) return;
        const w = this.canvasWidth;
        const h = this.canvasHeight;
        if (w === 0 || h === 0) return;

        this.offscreenColorTexture?.destroy();
        this.msaaColorTexture?.destroy();
        this.normalDepthTexture?.destroy();
        this.msaaNormalDepthTexture?.destroy();
        this.msaaDepthTexture?.destroy();
        this.offscreenColorTexture = null;
        this.msaaColorTexture = null;
        this.normalDepthTexture = null;
        this.msaaNormalDepthTexture = null;
        this.msaaDepthTexture = null;

        const rtUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;

        if (this.quality === 'low' || this.quality === 'medium') {
            this.offscreenColorTexture = this.device.createTexture({ label: 'offscreen_color', size: [w, h], format: this.canvasFormat, usage: rtUsage });
            this.offscreenColorTextureView = this.offscreenColorTexture.createView();

            this.normalDepthTexture = this.device.createTexture({ label: 'normal_depth', size: [w, h], format: 'rgba16float', usage: rtUsage });
            this.normalDepthTextureView = this.normalDepthTexture.createView();
        } else {
            // MSAA color (4x) + resolve target
            this.msaaColorTexture = this.device.createTexture({ label: 'msaa_color', size: [w, h], format: this.canvasFormat, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
            this.msaaColorTextureView = this.msaaColorTexture.createView();
            this.offscreenColorTexture = this.device.createTexture({ label: 'offscreen_color_resolve', size: [w, h], format: this.canvasFormat, usage: rtUsage });
            this.offscreenColorTextureView = this.offscreenColorTexture.createView();

            // MSAA normal+depth (4x) + resolve target
            this.msaaNormalDepthTexture = this.device.createTexture({ label: 'msaa_normal_depth', size: [w, h], format: 'rgba16float', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
            this.msaaNormalDepthTextureView = this.msaaNormalDepthTexture.createView();
            this.normalDepthTexture = this.device.createTexture({ label: 'normal_depth_resolve', size: [w, h], format: 'rgba16float', usage: rtUsage });
            this.normalDepthTextureView = this.normalDepthTexture.createView();

            // MSAA depth
            this.msaaDepthTexture = this.device.createTexture({ label: 'msaa_depth', size: [w, h], format: 'depth24plus', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
            this.msaaDepthTextureView = this.msaaDepthTexture.createView();
        }
    }

    // ── Private: Rendering ────────────────────────────────────────────

    private executeStandard(
        commandEncoder: GPUCommandEncoder,
        colorView: GPUTextureView,
        depthView: GPUTextureView,
        meshes: RenderMeshInstance[]
    ): void {
        const opaque = meshes.filter(m => m.alphaMode !== 'BLEND');
        const transparent = meshes.filter(m => m.alphaMode === 'BLEND');

        const renderPass = commandEncoder.beginRenderPass({
            label: 'geometry_pass_standard',
            colorAttachments: [{ view: colorView, clearValue: { r: 0.1, g: 0.1, b: 0.15, a: 1.0 }, loadOp: 'clear', storeOp: 'store' }],
            depthStencilAttachment: { view: depthView, depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' },
        });

        this.modelPoolIndex = 0;
        renderPass.setPipeline(this.pipelineStandard!);
        renderPass.setBindGroup(0, this.cameraBindGroup!);
        renderPass.setBindGroup(3, this.lightBindGroup!);
        this.drawMeshes(renderPass, opaque);

        if (transparent.length > 0) {
            renderPass.setPipeline(this.pipelineStandardBlend!);
            renderPass.setBindGroup(0, this.cameraBindGroup!);
            renderPass.setBindGroup(3, this.lightBindGroup!);
            this.drawMeshes(renderPass, transparent);
        }

        renderPass.end();
    }

    private executeMediumQuality(commandEncoder: GPUCommandEncoder, meshes: RenderMeshInstance[]): void {
        const opaque = meshes.filter(m => m.alphaMode !== 'BLEND');
        const transparent = meshes.filter(m => m.alphaMode === 'BLEND');
        const clearColor = { r: 0.1, g: 0.1, b: 0.15, a: 1.0 };

        const renderPass = commandEncoder.beginRenderPass({
            label: 'geometry_pass_medium_mrt',
            colorAttachments: [
                { view: this.offscreenColorTextureView!, clearValue: clearColor, loadOp: 'clear', storeOp: 'store' },
                { view: this.normalDepthTextureView!, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
            ],
            depthStencilAttachment: { view: this.depthTextureView!, depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' },
        });

        this.modelPoolIndex = 0;
        renderPass.setPipeline(this.pipelineMRT!);
        renderPass.setBindGroup(0, this.cameraBindGroup!);
        renderPass.setBindGroup(3, this.lightBindGroup!);
        this.drawMeshes(renderPass, opaque);

        if (transparent.length > 0) {
            renderPass.setPipeline(this.pipelineMRTBlend!);
            renderPass.setBindGroup(0, this.cameraBindGroup!);
            renderPass.setBindGroup(3, this.lightBindGroup!);
            this.drawMeshes(renderPass, transparent);
        }

        renderPass.end();
    }

    private executeHighQuality(commandEncoder: GPUCommandEncoder, meshes: RenderMeshInstance[]): void {
        const opaque = meshes.filter(m => m.alphaMode !== 'BLEND');
        const transparent = meshes.filter(m => m.alphaMode === 'BLEND');
        const clearColor = { r: 0.1, g: 0.1, b: 0.15, a: 1.0 };

        const renderPass = commandEncoder.beginRenderPass({
            label: 'geometry_pass_msaa_mrt',
            colorAttachments: [
                { view: this.msaaColorTextureView!, resolveTarget: this.offscreenColorTextureView!, clearValue: clearColor, loadOp: 'clear', storeOp: 'discard' },
                { view: this.msaaNormalDepthTextureView!, resolveTarget: this.normalDepthTextureView!, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'discard' },
            ],
            depthStencilAttachment: { view: this.msaaDepthTextureView!, depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        });

        this.modelPoolIndex = 0;
        renderPass.setPipeline(this.pipelineMSAA!);
        renderPass.setBindGroup(0, this.cameraBindGroup!);
        renderPass.setBindGroup(3, this.lightBindGroup!);
        this.drawMeshes(renderPass, opaque);

        if (transparent.length > 0) {
            renderPass.setPipeline(this.pipelineMSAABlend!);
            renderPass.setBindGroup(0, this.cameraBindGroup!);
            renderPass.setBindGroup(3, this.lightBindGroup!);
            this.drawMeshes(renderPass, transparent);
        }

        renderPass.end();
    }

    // ── Private: Mesh Drawing ─────────────────────────────────────────

    private drawMeshes(renderPass: GPURenderPassEncoder, meshes: RenderMeshInstance[]): void {
        let lastVertexBuffer: GPUBuffer | null = null;
        let lastModelMatrix: Mat4 | null = null;
        let lastModelBindGroup: GPUBindGroup | null = null;
        let currentKind: 'skinned' | 'building' | 'terrain' | 'standard' | null = null;

        for (const mesh of meshes) {
            const isSkinned = !!(mesh.meshHandle.skinBuffer && mesh.jointMatricesBuffer);
            const isBuilding = !!mesh.meshHandle.hasBuildingMeta && !isSkinned;
            const isTerrain = !!mesh.gpuTerrainTextures && !isSkinned && !isBuilding;
            const kind: 'skinned' | 'building' | 'terrain' | 'standard' =
                isSkinned ? 'skinned' : (isBuilding ? 'building' : (isTerrain ? 'terrain' : 'standard'));

            if (kind !== currentKind) {
                const pipeline = kind === 'skinned'
                    ? this.getSkinnedPipeline()
                    : (kind === 'building' ? this.getBuildingPipeline()
                    : (kind === 'terrain' ? this.getTerrainPipeline()
                    : this.getActivePipeline()));
                renderPass.setPipeline(pipeline);
                currentKind = kind;
                lastVertexBuffer = null;
            }

            // Reuse model bind group for sub-meshes of the same entity
            const sameEntity = mesh.meshHandle.vertexBuffer === lastVertexBuffer && mesh.modelMatrix === lastModelMatrix;
            let modelBindGroup: GPUBindGroup;
            if (sameEntity && lastModelBindGroup) {
                modelBindGroup = lastModelBindGroup;
            } else {
                modelBindGroup = isSkinned ? this.getSkinnedModelBindGroup(mesh) : this.getModelBindGroup(mesh);
                lastModelBindGroup = modelBindGroup;
            }

            if (mesh.meshHandle.vertexBuffer !== lastVertexBuffer) {
                renderPass.setVertexBuffer(0, mesh.meshHandle.vertexBuffer);
                if (isSkinned) renderPass.setVertexBuffer(1, mesh.meshHandle.skinBuffer!);
                renderPass.setIndexBuffer(mesh.meshHandle.indexBuffer, mesh.meshHandle.indexFormat);
                lastVertexBuffer = mesh.meshHandle.vertexBuffer;
            }
            lastModelMatrix = mesh.modelMatrix;

            renderPass.setBindGroup(1, modelBindGroup);
            const materialBindGroup = isTerrain
                ? this.getTerrainMaterialBindGroup(mesh)
                : (isBuilding
                    ? (this.buildingMaterialBindGroup || this.getMaterialBindGroup(mesh))
                    : this.getMaterialBindGroup(mesh));
            renderPass.setBindGroup(2, materialBindGroup);
            renderPass.drawIndexed(mesh.drawIndexCount ?? mesh.meshHandle.indexCount, 1, mesh.firstIndex ?? 0, 0, 0);
        }
    }

    private getSkinnedPipeline(): GPURenderPipeline {
        if (this.quality === 'high') return this.skinnedPipelineMSAA!;
        if (this.quality === 'medium') return this.skinnedPipelineMRT!;
        return this.skinnedPipelineStandard!;
    }

    private getActivePipeline(): GPURenderPipeline {
        if (this.quality === 'high') return this.pipelineMSAA!;
        if (this.quality === 'medium') return this.pipelineMRT!;
        return this.pipelineStandard!;
    }

    private getBuildingPipeline(): GPURenderPipeline {
        if (this.quality === 'high') return this.buildingPipelineMSAA!;
        if (this.quality === 'medium') return this.buildingPipelineMRT!;
        return this.buildingPipelineStandard!;
    }

    private getTerrainPipeline(): GPURenderPipeline {
        if (this.quality === 'high') return this.terrainPipelineMSAA!;
        if (this.quality === 'medium') return this.terrainPipelineMRT!;
        return this.terrainPipelineStandard!;
    }

    private getTerrainMaterialBindGroup(mesh: RenderMeshInstance): GPUBindGroup {
        const arrays = mesh.gpuTerrainTextures!;
        const texId = (t: GPUTexture | undefined) => t ? this.getTextureId(t) : 0;
        // Key must cover every texture in the bind group — textures load
        // asynchronously, and a stale cache entry would keep the bind group
        // pointing at earlier defaults (e.g. black weight map).
        const key = [
            'terrain',
            texId(arrays.diffuseArray),
            texId(arrays.normalArray),
            texId(mesh.roadAtlasNear),
            texId(mesh.roadAtlasFar),
            texId(arrays.sidewalkDiffuse),
            texId(arrays.sidewalkNormal),
            texId(arrays.groundTypeMap),
        ].join('|');

        let bg = this.terrainMaterialBindGroupCache.get(key);
        if (bg) return bg;

        // Terrain shader reads only `hasBaseColorTexture`/`hasNormalMap`
        // (as road-atlas presence flags) and `emissive` (left zero) from the
        // MaterialUniforms struct. The rest of the PBR layout stays zeroed
        // to keep the struct binary-compatible with the generic shader.
        const matData = new Float32Array(16);
        const matU32 = new Uint32Array(matData.buffer);
        matU32[6] = mesh.roadAtlasNear ? 1 : 0;
        matU32[7] = mesh.roadAtlasFar  ? 1 : 0;

        const matBuffer = this.resources!.createUniformBuffer(MATERIAL_UNIFORM_SIZE, 'terrain_material');
        this.device!.queue.writeBuffer(matBuffer, 0, matData);

        // Layer props buffer — min 256 bytes for uniform alignment
        const layerProps = arrays.layerProps;
        const alignedSize = Math.max(Math.ceil(layerProps.byteLength / 16) * 16, 256);
        if (!this.terrainLayerPropsBuffer || this.terrainLayerPropsBuffer.size < alignedSize) {
            this.terrainLayerPropsBuffer?.destroy();
            this.terrainLayerPropsBuffer = this.device!.createBuffer({
                label: 'terrain_layer_props',
                size: alignedSize,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
        }
        this.device!.queue.writeBuffer(this.terrainLayerPropsBuffer, 0, layerProps.buffer, layerProps.byteOffset, layerProps.byteLength);

        const roadNearView = mesh.roadAtlasNear ? this.getTextureView(mesh.roadAtlasNear) : this.defaultWhiteTextureView!;
        const roadFarView  = mesh.roadAtlasFar  ? this.getTextureView(mesh.roadAtlasFar)  : this.defaultWhiteTextureView!;
        const diffView     = arrays.diffuseArray.createView({ dimension: '2d-array' });
        const normView     = arrays.normalArray.createView({ dimension: '2d-array' });
        const swDiffView   = arrays.sidewalkDiffuse?.createView() ?? this.defaultWhiteTextureView!;
        const swNormView   = arrays.sidewalkNormal?.createView()  ?? this.defaultNormalTextureView!;
        const weightView   = arrays.groundTypeMap?.createView()   ?? this.defaultBlackTextureView!;

        bg = this.resources!.createBindGroup(this.terrainMaterialBindGroupLayout!, [
            { binding: 0, resource: { buffer: matBuffer } },
            { binding: 1, resource: roadNearView },
            { binding: 2, resource: this.defaultSampler! },
            { binding: 3, resource: roadFarView },
            { binding: 4, resource: diffView },
            { binding: 5, resource: normView },
            { binding: 6, resource: { buffer: this.terrainLayerPropsBuffer } },
            { binding: 7, resource: swDiffView },
            { binding: 8, resource: swNormView },
            { binding: 9, resource: weightView },
        ], 'terrain_material_bg');

        this.terrainMaterialBindGroupCache.set(key, bg);
        return bg;
    }

    private writeModelData(mesh: RenderMeshInstance, bufferIndex: number): void {
        const d = this.modelDataScratch;
        d.set(mesh.modelMatrix.data, 0);
        const inv = mesh.modelMatrix.inverse();
        if (inv) d.set(inv.transpose().data, 16);
        else { d.fill(0, 16, 32); d[16] = d[21] = d[26] = d[31] = 1; }
        this.device!.queue.writeBuffer(this.modelBufferPool[bufferIndex], 0, d.buffer, d.byteOffset, d.byteLength);
    }

    private ensureModelPoolEntry(idx: number): void {
        if (idx < this.modelBufferPool.length) return;
        const buf = this.resources!.createUniformBuffer(MODEL_UNIFORM_SIZE, `model_pool_${idx}`);
        this.modelBufferPool.push(buf);
        this.modelBindGroupPool.push(
            this.resources!.createBindGroup(this.modelBindGroupLayout!, [{
                binding: 0, resource: { buffer: buf },
            }], `model_bg_pool_${idx}`)
        );
    }

    private getModelBindGroup(mesh: RenderMeshInstance): GPUBindGroup {
        const idx = this.modelPoolIndex++;
        this.ensureModelPoolEntry(idx);
        this.writeModelData(mesh, idx);
        return this.modelBindGroupPool[idx];
    }

    private getSkinnedModelBindGroup(mesh: RenderMeshInstance): GPUBindGroup {
        const idx = this.modelPoolIndex++;
        this.ensureModelPoolEntry(idx);
        this.writeModelData(mesh, idx);

        // Pool skinned bind groups by (model buffer index, joint buffer) to avoid leaks.
        // The joint buffer label serves as a stable identity for the buffer.
        const jointBuf = mesh.jointMatricesBuffer!;
        const cacheKey = `${idx}_${jointBuf.label}`;

        let bg = this.skinnedModelBindGroupCache.get(cacheKey);
        if (!bg) {
            bg = this.resources!.createBindGroup(this.skinnedModelBindGroupLayout!, [
                { binding: 0, resource: { buffer: this.modelBufferPool[idx] } },
                { binding: 1, resource: { buffer: jointBuf } },
            ], `skinned_model_bg_${cacheKey}`);
            this.skinnedModelBindGroupCache.set(cacheKey, bg);
        }

        return bg;
    }

    private getTextureId(tex: GPUTexture): number {
        let id = this.textureIdMap.get(tex);
        if (id === undefined) {
            id = this.nextTextureId++;
            this.textureIdMap.set(tex, id);
        }
        return id;
    }

    private getTextureView(tex: GPUTexture): GPUTextureView {
        let view = this.textureViewCache.get(tex);
        if (!view) {
            view = tex.createView();
            this.textureViewCache.set(tex, view);
        }
        return view;
    }

    private getMaterialBindGroup(mesh: RenderMeshInstance): GPUBindGroup {
        const texId = mesh.baseColorTexture ? this.getTextureId(mesh.baseColorTexture) : 'none';
        const nrmId = mesh.normalMapTexture ? this.getTextureId(mesh.normalMapTexture) : 'none';
        const waterLevel = mesh.waterLevel ?? -1e20;
        const key = `${texId}|${nrmId}|${mesh.baseColor}|${mesh.metallic}|${mesh.roughness}|${mesh.emissive}|${mesh.waterEffect ? 1 : 0}|${waterLevel}`;

        let bg = this.materialBindGroupCache.get(key);
        if (bg) return bg;

        const matData = new Float32Array(16);
        matData[0] = mesh.baseColor[0];
        matData[1] = mesh.baseColor[1];
        matData[2] = mesh.baseColor[2];
        matData[3] = mesh.baseColor[3];
        matData[4] = mesh.metallic;
        matData[5] = mesh.roughness;
        const matU32 = new Uint32Array(matData.buffer);
        matU32[6] = mesh.baseColorTexture ? 1 : 0;
        matU32[7] = mesh.normalMapTexture ? 1 : 0;
        matData[8] = mesh.emissive[0];
        matData[9] = mesh.emissive[1];
        matData[10] = mesh.emissive[2];
        matData[11] = mesh.normalScale ?? 1.0;
        matU32[12] = mesh.waterEffect ? 1 : 0;
        matData[13] = mesh.uvScaleX ?? 1.0;
        matData[14] = mesh.uvScaleY ?? 1.0;
        matData[15] = waterLevel;

        const matBuffer = this.resources!.createUniformBuffer(MATERIAL_UNIFORM_SIZE, 'material_cached');
        this.device!.queue.writeBuffer(matBuffer, 0, matData);

        const baseColorView = mesh.baseColorTexture ? this.getTextureView(mesh.baseColorTexture) : this.defaultWhiteTextureView!;
        const normalMapView = mesh.normalMapTexture ? this.getTextureView(mesh.normalMapTexture) : this.defaultNormalTextureView!;

        bg = this.resources!.createBindGroup(this.materialBindGroupLayout!, [
            { binding: 0, resource: { buffer: matBuffer } },
            { binding: 1, resource: baseColorView },
            { binding: 2, resource: this.defaultSampler! },
            { binding: 3, resource: normalMapView },
        ], 'material_bg_cached');

        this.materialBindGroupCache.set(key, bg);
        return bg;
    }

    // ── Private: Uniform Uploads ──────────────────────────────────────

    private uploadCameraUniforms(camera: RenderCamera): void {
        if (!this.device || !this.cameraUniformBuffer) return;
        // Layout: viewMatrix[0..15], projMatrix[16..31], cameraPos+pad[32..35],
        //         cascadeMatrices[36..99] (4 x mat4), cascadeSplits[100..103]
        // Total: 104 floats = 416 bytes
        const data = new Float32Array(104);
        data.set(camera.viewMatrix.data, 0);
        data.set(camera.projectionMatrix.data, 16);
        data[32] = camera.position.x;
        data[33] = camera.position.y;
        data[34] = camera.position.z;
        // data[35] = padding (0)
        for (let i = 0; i < 4; i++) {
            data.set(this.cascadeMatrices[i].data, 36 + i * 16);
        }
        data[100] = this.cascadeSplits[0];
        data[101] = this.cascadeSplits[1];
        data[102] = this.cascadeSplits[2];
        data[103] = this.cascadeSplits[3];
        this.device.queue.writeBuffer(this.cameraUniformBuffer, 0, data);
    }

    private uploadLightUniforms(scene: RenderScene): void {
        if (!this.device || !this.lightUniformBuffer) return;

        const data = new Float32Array(180);
        const u32View = new Uint32Array(data.buffer);

        // Ambient
        data[0] = scene.ambientColor.x;
        data[1] = scene.ambientColor.y;
        data[2] = scene.ambientColor.z;
        data[3] = scene.ambientIntensity;

        // Light counts and shadow config
        const numDirLights = Math.min(scene.directionalLights.length, 4);
        const numPointLights = Math.min(scene.pointLights.length, 8);
        const numSpotLights = Math.min(scene.spotLights.length, 4);
        u32View[4] = numDirLights;
        u32View[5] = numPointLights;
        u32View[6] = numSpotLights;
        u32View[7] = this.shadowEnabled ? 1 : 0;

        data[8] = 0.001; // shadowBias
        data[9] = this.shadowMapSize;
        u32View[10] = scene.fog.enabled ? 1 : 0;
        data[11] = scene.fog.near;
        data[12] = scene.fog.far;
        data[13] = performance.now() / 1000.0;
        data[14] = scene.timeOfDay; // drives day/night lit-window threshold

        // Fog color
        data[16] = scene.fog.color.x;
        data[17] = scene.fog.color.y;
        data[18] = scene.fog.color.z;

        // Directional lights (8 floats each, offset 20)
        for (let i = 0; i < numDirLights; i++) {
            const light = scene.directionalLights[i];
            const o = 20 + i * 8;
            data[o] = light.direction.x; data[o + 1] = light.direction.y; data[o + 2] = light.direction.z;
            data[o + 4] = light.color.x; data[o + 5] = light.color.y; data[o + 6] = light.color.z;
            data[o + 7] = light.intensity;
        }

        // Point lights (8 floats each, offset 52)
        for (let i = 0; i < numPointLights; i++) {
            const light = scene.pointLights[i];
            const o = 52 + i * 8;
            data[o] = light.position.x; data[o + 1] = light.position.y; data[o + 2] = light.position.z;
            data[o + 3] = light.range;
            data[o + 4] = light.color.x; data[o + 5] = light.color.y; data[o + 6] = light.color.z;
            data[o + 7] = light.intensity;
        }

        // Spot lights (16 floats each, offset 116)
        for (let i = 0; i < numSpotLights; i++) {
            const light = scene.spotLights[i];
            const o = 116 + i * 16;
            data[o] = light.position.x; data[o + 1] = light.position.y; data[o + 2] = light.position.z;
            data[o + 3] = light.range;
            data[o + 4] = light.direction.x; data[o + 5] = light.direction.y; data[o + 6] = light.direction.z;
            data[o + 7] = light.intensity;
            data[o + 8] = light.color.x; data[o + 9] = light.color.y; data[o + 10] = light.color.z;
            data[o + 11] = Math.cos(light.outerConeAngle);
            data[o + 12] = Math.cos(light.innerConeAngle);
        }

        this.device.queue.writeBuffer(this.lightUniformBuffer, 0, data);
    }
}
