import { Vec3 } from '../../../core/math/vec3.js';
import { Mat4 } from '../../../core/math/mat4.js';
import { GPUResourceManager } from '../gpu_resource_manager.js';
import { ShaderLibrary } from '../shader_library.js';
import { RenderScene, RenderMeshInstance, RenderCamera } from '../render_scene.js';
import { RenderStats } from '../render_stats.js';

const SHADOW_MAP_SIZE = 2048;
const NUM_CASCADES = 4;
const SHADOW_ARRAY_LAYERS = 4;
const LIGHT_CAMERA_SIZE = 128; // 2 x mat4x4(64)
// Hard cap so the farthest cascade doesn't re-rasterize the entire world
// each frame. Beyond this, shadows simply fade out. 150 keeps texel
// density high for typical game scenes (arenas, corridors, interiors)
// — was 1000, which meant ~0.5 world units per texel on cascade 3 and
// visibly fuzzy shadows everywhere.
const MAX_SHADOW_DISTANCE = 150;
const CASCADE_SPLIT_LAMBDA = 0.75;

/**
 * Cascaded shadow map pass.
 * Renders the scene from the directional light's perspective into a depth texture
 * array with one layer per cascade. Each cascade covers a different depth slice of
 * the camera frustum — high resolution for near shadows, broad coverage for distant
 * ones.
 */
export class ShadowPass {
    private stats: RenderStats | null = null;
    setStats(stats: RenderStats): void { this.stats = stats; }

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

    // Skinned pipeline + bind groups. Shares the model buffer pool above
    // so skinned meshes get the same matrix-cache benefits, wrapped with
    // the per-mesh joint storage buffer in a (model, joints) bind group.
    private skinnedPipeline: GPURenderPipeline | null = null;
    private skinnedModelBGL: GPUBindGroupLayout | null = null;
    private skinnedModelBindGroupCache = new Map<string, GPUBindGroup>();

    // ── Instanced shadow path ─────────────────────────────────────────
    // Mirrors the geometry-pass instancing approach: one shadow pipeline
    // variant that reads modelMatrix from a storage buffer keyed by
    // @builtin(instance_index). Standard-stride (non-skinned, non-
    // building) meshes whose model matrices share a vertex buffer get
    // packed into a per-frame instance buffer and drawn in a single
    // drawIndexed(instanceCount > 1).
    //
    // The shadow pass owns its OWN instance buffer (separate from the
    // geometry pass) because both passes share one queue: a single
    // queue.writeBuffer would have only one winning copy by the time
    // draws execute. Two buffers keeps each pass's data live for its
    // own draws.
    private instancedModelBGL: GPUBindGroupLayout | null = null;
    private pipelineInstanced: GPURenderPipeline | null = null;
    private instanceBuffer: GPUBuffer | null = null;
    private instanceBufferCapacity: number = 0;
    private instanceBindGroup: GPUBindGroup | null = null;
    private _instanceScratch: Float32Array = new Float32Array(0);
    private _scheduleScratch: number[] = [];

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

        // Skinned pipeline — reads position from the standard vertex buffer,
        // joint indices + weights from the mesh's skinBuffer, and applies
        // linear blend skinning before projecting into light space.
        // Without this, shadows of animated characters are frozen in the
        // GLB bind pose (T-pose) while the visible mesh plays its clip.
        this.skinnedModelBGL = resources.createBindGroupLayout([
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
            { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        ], 'shadow_skinned_model_bgl');

        const skinnedPipelineLayout = resources.createPipelineLayout(
            [this.lightCameraBGL, this.skinnedModelBGL],
            'shadow_skinned_pipeline_layout'
        );
        const skinnedShadowModule = shaderLib.getModule('shadow_vertex_skinned');

        this.skinnedPipeline = device.createRenderPipeline({
            label: 'shadow_skinned_pipeline',
            layout: skinnedPipelineLayout,
            vertex: {
                module: skinnedShadowModule,
                entryPoint: 'vs_main',
                buffers: [
                    {
                        arrayStride: 32,  // pos(12) + normal(12) + uv(8)
                        stepMode: 'vertex',
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' as GPUVertexFormat },
                        ],
                    },
                    {
                        arrayStride: 32,  // joints(u32x4=16) + weights(f32x4=16)
                        stepMode: 'vertex',
                        attributes: [
                            { shaderLocation: 3, offset: 0, format: 'uint32x4' as GPUVertexFormat },
                            { shaderLocation: 4, offset: 16, format: 'float32x4' as GPUVertexFormat },
                        ],
                    },
                ],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less',
                depthBias: 4, depthBiasSlopeScale: 3.0, depthBiasClamp: 0.002,
            },
        });

        // Instanced shadow pipeline (32-byte stride only; building stride36
        // and skinned variants stay non-instanced for now). Uses the
        // shadow_vertex_instanced shader which reads
        // models[@builtin(instance_index)] from a storage buffer.
        this.instancedModelBGL = resources.createBindGroupLayout([{
            binding: 0,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: 'read-only-storage' },
        }], 'shadow_instanced_model_bgl');

        const instancedPipelineLayout = resources.createPipelineLayout(
            [this.lightCameraBGL, this.instancedModelBGL],
            'shadow_instanced_pipeline_layout'
        );
        const instancedShadowModule = shaderLib.getModule('shadow_vertex_instanced');

        this.pipelineInstanced = device.createRenderPipeline({
            label: 'shadow_pipeline_instanced',
            layout: instancedPipelineLayout,
            vertex: {
                module: instancedShadowModule,
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
    }

    /** Grow the instance buffer + recreate its bind group + resize the
     *  CPU scratch when more instances are needed. Mirrors the geometry
     *  pass helper but owns its own buffer (separate queue.writeBuffer
     *  destinations are needed because shadow + geometry encode in the
     *  same command buffer). */
    private ensureInstanceCapacity(needed: number): void {
        if (needed <= this.instanceBufferCapacity) return;
        const newCap = Math.max(needed, Math.max(64, this.instanceBufferCapacity * 2));
        this.instanceBuffer?.destroy();
        const sizeBytes = newCap * 32 * 4;
        this.instanceBuffer = this.device!.createBuffer({
            label: 'shadow_instanced_models',
            size: sizeBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.instanceBufferCapacity = newCap;
        this._instanceScratch = new Float32Array(newCap * 32);
        this.instanceBindGroup = this.resources!.createBindGroup(
            this.instancedModelBGL!,
            [{ binding: 0, resource: { buffer: this.instanceBuffer } }],
            'shadow_instanced_models_bg',
        );
    }

    /** Pack one instance's modelMatrix (slots 0..15) + identity normal
     *  matrix (slots 16..31) into the CPU scratch. The shadow vertex
     *  shader only reads modelMatrix; normal matrix slots are written
     *  to keep the per-instance stride identical to the geometry pass
     *  format (32 floats/instance) — that way packInstance and the
     *  storage layout match the same ModelUniforms struct. */
    private packShadowInstance(mesh: RenderMeshInstance, target: Float32Array, floatOffset: number): void {
        target.set(mesh.modelMatrix.data, floatOffset);
        target.fill(0, floatOffset + 16, floatOffset + 32);
        target[floatOffset + 16] = 1;
        target[floatOffset + 21] = 1;
        target[floatOffset + 26] = 1;
        target[floatOffset + 31] = 1;
    }

    execute(commandEncoder: GPUCommandEncoder, scene: RenderScene): void {
        if (!this.device || !this.pipeline || !this.depthArrayTexture) return;
        if (scene.directionalLights.length === 0 || !scene.camera) return;

        const lightDir = scene.directionalLights[0].direction;
        const camera = scene.camera;

        // Reset the per-frame slot assignment. The pool itself (buffers +
        // bindgroups) persists — we just let getModelBindGroup re-assign
        // indices from 0 as meshes come in. Without this, keying by Mat4
        // identity would leak any time an upstream path allocated a fresh
        // Mat4 per frame (easy to do, and the leak is unbounded).
        this.matrixSlotMap.clear();

        // The default MAX_SHADOW_DISTANCE is tuned for typical arena-scale
        // scenes (sharp shadows everywhere); open-world templates that need
        // distant shadows can raise it via LightComponent.shadowDistance,
        // trading texel density for coverage.
        const maxShadowDist = scene.directionalLights[0].shadowDistance ?? MAX_SHADOW_DISTANCE;
        this.computeCascadeSplits(camera.near, camera.far, maxShadowDist);

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

            // ── Build draw schedule for this cascade ──────────────
            // Mirrors the geometry-pass two-pass approach. Standard-
            // stride non-skinned non-building meshes that share a
            // vertex buffer (and have the same draw range) are batched
            // into instanced draws. Building-stride and skinned meshes
            // pass through as singletons. Transparent meshes are
            // skipped entirely (shadow doesn't render BLEND).
            const schedule = this._scheduleScratch;
            schedule.length = 0;
            let totalShadowInstances = 0;
            const meshBindGroups: (GPUBindGroup | null)[] = [];

            // Per-mesh bind group prebuild for the per-mesh path. For
            // skinned + non-batched standard meshes we still use the
            // pooled per-mesh model BG (preserves the matrix-cache
            // behavior of the previous code path). Batched standard
            // meshes use the shared instance bind group instead.
            let lastVertexBuffer: GPUBuffer | null = null;
            let lastModelMatrix: Mat4 | null = null;
            let lastBindGroup: GPUBindGroup | null = null;

            for (let i = 0; i < visibleMeshes.length; i++) {
                const mesh = visibleMeshes[i];
                if (mesh.alphaMode === 'BLEND') { meshBindGroups.push(null); continue; }
                const isSkinned = !!(mesh.meshHandle.skinBuffer && mesh.jointMatricesBuffer);
                if (isSkinned) {
                    meshBindGroups.push(this.getSkinnedModelBindGroup(mesh));
                    lastVertexBuffer = null;
                    lastModelMatrix = null;
                    lastBindGroup = null;
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

            // Schedule build (separate from per-mesh BG prebuild above).
            for (let i = 0; i < visibleMeshes.length; ) {
                const m = visibleMeshes[i];
                if (m.alphaMode === 'BLEND' || !meshBindGroups[i]) { i++; continue; }
                const mSkinned = !!(m.meshHandle.skinBuffer && m.jointMatricesBuffer);
                const mStride36 = !mSkinned && !!m.meshHandle.hasBuildingMeta;
                const mStandard = !mSkinned && !mStride36;
                if (mStandard) {
                    let runEnd = i + 1;
                    while (runEnd < visibleMeshes.length) {
                        const n = visibleMeshes[runEnd];
                        if (n.alphaMode === 'BLEND' || !meshBindGroups[runEnd]) break;
                        const nSkinned = !!(n.meshHandle.skinBuffer && n.jointMatricesBuffer);
                        if (nSkinned) break;
                        if (n.meshHandle.hasBuildingMeta) break;
                        if (n.meshHandle.vertexBuffer !== m.meshHandle.vertexBuffer) break;
                        if ((n.firstIndex ?? 0) !== (m.firstIndex ?? 0)) break;
                        const nIdx = n.drawIndexCount ?? n.meshHandle.indexCount;
                        const mIdx = m.drawIndexCount ?? m.meshHandle.indexCount;
                        if (nIdx !== mIdx) break;
                        runEnd++;
                    }
                    if (runEnd - i >= 2) {
                        schedule.push(i, runEnd, totalShadowInstances);
                        totalShadowInstances += runEnd - i;
                        i = runEnd;
                        continue;
                    }
                }
                schedule.push(i, i + 1, 0);
                i++;
            }

            // Pack + upload instance data for this cascade
            if (totalShadowInstances > 0) {
                this.ensureInstanceCapacity(totalShadowInstances);
                const scratch = this._instanceScratch;
                for (let s = 0; s < schedule.length; s += 3) {
                    const start = schedule[s];
                    const end = schedule[s + 1];
                    const fInstance = schedule[s + 2];
                    if (end - start < 2) continue;
                    for (let k = start; k < end; k++) {
                        this.packShadowInstance(visibleMeshes[k], scratch, (fInstance + (k - start)) * 32);
                    }
                }
                this.device.queue.writeBuffer(
                    this.instanceBuffer!,
                    0,
                    scratch.buffer,
                    scratch.byteOffset,
                    totalShadowInstances * 32 * 4,
                );
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

            renderPass.setBindGroup(0, this.lightCameraBindGroups[cascade]);

            let lastVB: GPUBuffer | null = null;
            type ActivePipeline = 'standard' | 'stride36' | 'skinned' | 'instanced';
            let activePipeline: ActivePipeline | null = null;

            for (let s = 0; s < schedule.length; s += 3) {
                const start = schedule[s];
                const end = schedule[s + 1];
                const fInstance = schedule[s + 2];
                const instanceCount = end - start;
                const isBatch = instanceCount >= 2;
                const sample = visibleMeshes[start];

                const isSkinned = !!(sample.meshHandle.skinBuffer && sample.jointMatricesBuffer);
                const needsStride36 = !isSkinned && !!sample.meshHandle.hasBuildingMeta;
                const wanted: ActivePipeline = isBatch ? 'instanced'
                    : (isSkinned ? 'skinned' : (needsStride36 ? 'stride36' : 'standard'));
                if (wanted !== activePipeline) {
                    const pipe = wanted === 'instanced' ? this.pipelineInstanced!
                        : (wanted === 'skinned' ? this.skinnedPipeline!
                            : (wanted === 'stride36' ? this.pipeline36! : this.pipeline));
                    renderPass.setPipeline(pipe);
                    activePipeline = wanted;
                    lastVB = null;
                }

                if (sample.meshHandle.vertexBuffer !== lastVB) {
                    renderPass.setVertexBuffer(0, sample.meshHandle.vertexBuffer);
                    renderPass.setIndexBuffer(sample.meshHandle.indexBuffer, sample.meshHandle.indexFormat);
                    lastVB = sample.meshHandle.vertexBuffer;
                }
                if (isSkinned) renderPass.setVertexBuffer(1, sample.meshHandle.skinBuffer!);

                const modelBG = isBatch ? this.instanceBindGroup! : meshBindGroups[start]!;
                renderPass.setBindGroup(1, modelBG);

                const idxCount = sample.drawIndexCount ?? sample.meshHandle.indexCount;
                renderPass.drawIndexed(idxCount, instanceCount, sample.firstIndex ?? 0, 0, fInstance);
                this.stats?.addDraw((idxCount / 3) * instanceCount);
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
        this.skinnedModelBindGroupCache.clear();
        this.pipeline = null;
        this.pipeline36 = null;
        this.skinnedPipeline = null;
        this.skinnedModelBGL = null;
        this.device = null;
        this.resources = null;
    }

    /**
     * Skinned equivalent of getModelBindGroup. Pulls the shared model
     * buffer slot (so the matrix upload and GPU-side caching work the
     * same way), then wraps it with the mesh's joint-matrices storage
     * buffer into a dedicated (model, joints) bind group. Cached by
     * `${slotIdx}_${jointBufferLabel}` so a peer's proxy keeps its
     * bind group across frames.
     */
    private getSkinnedModelBindGroup(mesh: RenderMeshInstance): GPUBindGroup | null {
        if (!mesh.jointMatricesBuffer) return null;
        // Reuse getModelBindGroup's slot allocation + matrix upload — the
        // returned standard BG is discarded, we just need the slot index
        // and the backing buffer to be populated.
        this.getModelBindGroup(mesh);
        const idx = this.matrixSlotMap.get(mesh.modelMatrix);
        if (idx === undefined) return null;

        const jointBuf = mesh.jointMatricesBuffer;
        const cacheKey = `${idx}_${jointBuf.label ?? ''}`;
        let bg = this.skinnedModelBindGroupCache.get(cacheKey);
        if (!bg) {
            bg = this.resources!.createBindGroup(this.skinnedModelBGL!, [
                { binding: 0, resource: { buffer: this.modelBufferPool[idx] } },
                { binding: 1, resource: { buffer: jointBuf } },
            ], `shadow_skinned_model_bg_${cacheKey}`);
            this.skinnedModelBindGroupCache.set(cacheKey, bg);
        }
        return bg;
    }

    private getModelBindGroup(mesh: RenderMeshInstance): GPUBindGroup {
        let idx = this.matrixSlotMap.get(mesh.modelMatrix);
        if (idx === undefined) {
            idx = this.matrixSlotMap.size;
            // Only grow the pool when we've exhausted existing slots.
            // Reused slots keep their GPUBuffer + GPUBindGroup — we just
            // force the sentinel mismatch so the first writeBuffer of the
            // frame actually uploads (the old cached data doesn't describe
            // the new mesh assigned to this slot).
            if (idx >= this.modelBufferPool.length) {
                const buf = this.resources!.createUniformBuffer(128, `shadow_model_pool_${idx}`);
                this.modelBufferPool.push(buf);
                this.modelBindGroupPool.push(
                    this.resources!.createBindGroup(this.modelBGL!, [{
                        binding: 0,
                        resource: { buffer: buf },
                    }], `shadow_model_bg_pool_${idx}`)
                );
                this.slotCachedMatrix[idx] = new Float32Array(16);
            }
            this.slotCachedMatrix[idx][0] = NaN; // force first-write mismatch
            this.matrixSlotMap.set(mesh.modelMatrix, idx);
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

    private computeCascadeSplits(near: number, far: number, maxShadowDist: number): void {
        const shadowFar = Math.min(far, maxShadowDist);
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
