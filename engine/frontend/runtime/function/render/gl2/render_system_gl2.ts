import { Vec3 } from '../../../core/math/vec3.js';
import { Mat4 } from '../../../core/math/mat4.js';
import { GL2DeviceManager } from '../../../platform/gpu/gl2_device.js';
import { CanvasManager } from '../../../platform/canvas/canvas_manager.js';
import {
    MeshData, GPUMeshHandle, RenderCamera, RenderMeshInstance,
    RenderDirectionalLight, DecalInstance, RenderScene,
} from '../render_scene.js';
import { GraphicsQuality } from '../passes/geometry_pass.js';
import { DebugRenderer } from '../debug_renderer.js';
import { RenderStats } from '../render_stats.js';
import { IRenderer, GfxBackend } from '../i_renderer.js';
import { RenderSceneSource } from '../render_system.js';
import { GL2ResourceManager } from './gl2_resource_manager.js';
import {
    GL2Buffer, GL2Texture, asGL2Buffer, asGL2Texture, isGL2Texture, makeGL2Texture,
} from './gl2_handles.js';
import {
    buildLitVertexShader, buildLitInstancedVertexShader, LIT_FRAGMENT_SHADER,
    buildShadowVertexShader, buildShadowInstancedVertexShader, SHADOW_FRAGMENT_SHADER,
    SKYBOX_VERTEX_SHADER, SKYBOX_FRAGMENT_SHADER,
    DEBUG_LINES_VERTEX_SHADER, DEBUG_LINES_FRAGMENT_SHADER,
    buildProgram, MAX_JOINTS_GL2, MAX_INSTANCES_GL2,
    MAX_DIR_LIGHTS_GL2, MAX_POINT_LIGHTS_GL2, MAX_SPOT_LIGHTS_GL2,
} from './shader_library_gl2.js';

const VERTEX_STRIDE = 32;       // float[8]: position(12) + normal(12) + uv(8)
const SKIN_STRIDE = 32;         // u32[4] joints + f32[4] weights
// FrameUBO: 3 mat4 (view, proj, lightVP) + 5 vec4 fixed (cameraPos,
// ambient, fogParams, fogColor, misc) + 2 dir-light arrays of 4 vec4
// each + MAX_POINT_LIGHTS × 2 vec4 + MAX_SPOT_LIGHTS × 3 vec4.
const FRAME_UBO_BYTES = 16 * 4 * 3 + 4 * 4 * 5 + MAX_DIR_LIGHTS_GL2 * 32 + MAX_POINT_LIGHTS_GL2 * 32 + MAX_SPOT_LIGHTS_GL2 * 48;
const MATERIAL_UBO_BYTES = 5 * 4 * 4;   // 5 vec4
const JOINTS_UBO_BYTES = MAX_JOINTS_GL2 * 64;

const FRAME_UBO_BINDING = 0;
const MATERIAL_UBO_BINDING = 1;
const JOINTS_UBO_BINDING = 2;
const INSTANCE_MODELS_UBO_BINDING = 3;
const INSTANCE_MODELS_UBO_BYTES = MAX_INSTANCES_GL2 * 64;  // mat4[N], 64 bytes each

// Shadow tuning. Map size varies per quality (low: off, medium: 1024,
// high: 2048). Half-extent is the same across qualities — gameplay
// shouldn't hide behind quality-dependent shadow ranges.
const SHADOW_BOX_HALF = 60;
const SHADOW_NEAR = 1;
const SHADOW_FAR = 200;
const SHADOW_DIST_FROM_CAMERA = 80;
const SHADOW_MAP_SIZE_MEDIUM = 1024;
const SHADOW_MAP_SIZE_HIGH = 2048;

const TEXTURE_UNIT_BASE = 0;
const TEXTURE_UNIT_NORMAL = 1;
const TEXTURE_UNIT_SHADOW = 2;

/**
 * Per-mesh GPU state cached by GPUMeshHandle identity. Allocated on the
 * first frame the mesh is drawn, never freed (release happens via
 * releaseMesh which destroys the underlying GL2Buffers).
 */
interface MeshDrawState {
    vao: WebGLVertexArrayObject;
    skinVAO: WebGLVertexArrayObject | null;
    indexType: number;          // gl.UNSIGNED_SHORT / UNSIGNED_INT
    /**
     * Cached raw WebGLBuffer for the IBO. The VAO normally captures
     * the ELEMENT_ARRAY_BUFFER binding, but we re-bind explicitly
     * before each drawElements as a belt-and-braces fix — some
     * driver/browser combos appear to lose the VAO's IBO binding
     * after intervening UNIFORM_BUFFER ops, manifesting as
     * "must have element array buffer bound" at draw time.
     */
    iboGL: WebGLBuffer;
}

/**
 * WebGL2 fallback renderer. V1 feature set:
 *  - Forward-rendered lit geometry (directional light + ambient + fog)
 *  - Albedo texture sampling, base-color tint, emissive
 *  - GPU skinning via UBO of mat4[64]
 *  - Time-of-day procedural skybox (gradient, no sun disk)
 *  - Default-framebuffer rendering — no FXAA, no FBO juggling
 *
 * Out of V1 scope (graceful no-ops):
 *  - Shadows, HBAO, SSR, Bloom, decals, particles, debug-line drawing
 *  - Building-procedural materials (uploaded as plain meshes)
 *  - Normal maps (sampled but contribution disabled — kept simple)
 *
 * The class implements the same `IRenderer` surface as the WebGPU
 * `RenderSystem`, so the engine, scene, components, and editor never
 * branch on backend choice.
 */
export class RenderSystemWebGL2 implements IRenderer {
    readonly backend: GfxBackend = 'webgl2';

    private gl2Device!: GL2DeviceManager;
    private canvasManager!: CanvasManager;
    private resources = new GL2ResourceManager();
    private stats = new RenderStats();

    private gl: WebGL2RenderingContext | null = null;

    private litStaticProgram: WebGLProgram | null = null;
    private litSkinnedProgram: WebGLProgram | null = null;
    private litInstancedProgram: WebGLProgram | null = null;
    private shadowStaticProgram: WebGLProgram | null = null;
    private shadowSkinnedProgram: WebGLProgram | null = null;
    private shadowInstancedProgram: WebGLProgram | null = null;
    private skyboxProgram: WebGLProgram | null = null;

    private frameUBO: GL2Buffer | null = null;
    private materialUBO: GL2Buffer | null = null;
    /** UBO of mat4[MAX_INSTANCES_GL2] for instanced draws. The vertex
     *  shaders (lit + shadow instanced variants) read
     *  `u_models[gl_InstanceID]` from this. Each batch fills the UBO,
     *  binds, and issues drawElementsInstanced — runs of >MAX_INSTANCES_GL2
     *  are split across multiple submits. */
    private instanceModelsUBO: GL2Buffer | null = null;
    private instanceModelsScratch = new Float32Array(MAX_INSTANCES_GL2 * 16);
    /** Scan-pass schedule. 3 numbers per entry: [start, end, _unused].
     *  `end - start >= 2` means instanced batch; otherwise single mesh. */
    private _scheduleScratch: number[] = [];

    private defaultWhiteTexture: GL2Texture | null = null;
    private defaultFlatNormalTexture: GL2Texture | null = null;

    private shadowFBO: WebGLFramebuffer | null = null;
    private shadowDepthTex: WebGLTexture | null = null;
    private shadowMapSize = 2048;
    private shadowMatrix = Mat4.identity();
    private shadowEnabled = true;
    private quality: GraphicsQuality = 'high';

    private meshState: WeakMap<GPUMeshHandle, MeshDrawState> = new WeakMap();
    private uboBlockBindingsBound = new WeakSet<WebGLProgram>();

    private activeCamera: RenderCamera | null = null;
    private cameraOverrideView: Mat4 | null = null;
    private cameraOverrideProj: Mat4 | null = null;

    private renderScene = new RenderScene();
    private debugRendererStub: DebugRenderer;

    // Reusable scratch buffers to avoid per-frame allocations.
    private frameUBOScratch = new Float32Array(FRAME_UBO_BYTES / 4);
    private materialUBOScratch = new Float32Array(MATERIAL_UBO_BYTES / 4);

    constructor() {
        this.debugRendererStub = makeStubDebugRenderer();
    }

    getCanvas(): HTMLCanvasElement | null {
        return this.canvasManager?.getCanvas() ?? null;
    }

    /** WebGL2 has no GPUDevice — null is the truthful answer. Callers
     *  that need to differentiate (e.g. terrain streaming uploading
     *  GPUTextures directly) bail when this returns null. */
    getDevice(): GPUDevice | null {
        return null;
    }

    getRenderStats() { return this.stats.snapshot(); }

    getGpuTimings() {
        return { supported: false as const, mode: 'cpu-submit' as const, passes: [] };
    }

    async initialize(gl2Device: GL2DeviceManager, canvasManager: CanvasManager): Promise<void> {
        this.gl2Device = gl2Device;
        this.canvasManager = canvasManager;
        const gl = gl2Device.getContext();
        this.gl = gl;
        this.resources.initialize(gl);

        this.litStaticProgram = buildProgram(gl, buildLitVertexShader(false), LIT_FRAGMENT_SHADER, 'lit_static');
        this.litSkinnedProgram = buildProgram(gl, buildLitVertexShader(true), LIT_FRAGMENT_SHADER, 'lit_skinned');
        this.litInstancedProgram = buildProgram(gl, buildLitInstancedVertexShader(), LIT_FRAGMENT_SHADER, 'lit_instanced');
        this.shadowStaticProgram = buildProgram(gl, buildShadowVertexShader(false), SHADOW_FRAGMENT_SHADER, 'shadow_static');
        this.shadowSkinnedProgram = buildProgram(gl, buildShadowVertexShader(true), SHADOW_FRAGMENT_SHADER, 'shadow_skinned');
        this.shadowInstancedProgram = buildProgram(gl, buildShadowInstancedVertexShader(), SHADOW_FRAGMENT_SHADER, 'shadow_instanced');
        this.skyboxProgram = buildProgram(gl, SKYBOX_VERTEX_SHADER, SKYBOX_FRAGMENT_SHADER, 'skybox');

        this.bindUBOBlockBindings(this.litStaticProgram, true);
        this.bindUBOBlockBindings(this.litSkinnedProgram, true);
        this.bindUBOBlockBindings(this.litInstancedProgram, true);
        this.bindInstancedProgramBindings(this.litInstancedProgram);
        this.bindShadowProgramBindings(this.shadowSkinnedProgram);
        this.bindInstancedProgramBindings(this.shadowInstancedProgram);
        this.bindUBOBlockBindings(this.skyboxProgram, false);

        this.frameUBO = this.resources.createUniformBuffer(FRAME_UBO_BYTES, 'frame_ubo');
        this.materialUBO = this.resources.createUniformBuffer(MATERIAL_UBO_BYTES, 'material_ubo');
        this.instanceModelsUBO = this.resources.createUniformBuffer(INSTANCE_MODELS_UBO_BYTES, 'instance_models_ubo');
        this.defaultWhiteTexture = this.resources.createDefaultWhiteTexture();
        this.defaultFlatNormalTexture = this.createFlatNormalTexture();
        this.createShadowFramebuffer();

        canvasManager.onResize((w, h) => this.onCanvasResize(w, h));
    }

    private bindShadowProgramBindings(prog: WebGLProgram): void {
        const gl = this.gl!;
        const jointsIdx = gl.getUniformBlockIndex(prog, 'JointsUBO');
        if (jointsIdx !== gl.INVALID_INDEX) gl.uniformBlockBinding(prog, jointsIdx, JOINTS_UBO_BINDING);
    }

    /** Bind the InstanceModelsUBO block on a program that uses it. Both
     *  the lit and shadow instanced variants declare the same block at
     *  the same binding so a single UBO buffer feeds both passes. */
    private bindInstancedProgramBindings(prog: WebGLProgram): void {
        const gl = this.gl!;
        const idx = gl.getUniformBlockIndex(prog, 'InstanceModelsUBO');
        if (idx !== gl.INVALID_INDEX) gl.uniformBlockBinding(prog, idx, INSTANCE_MODELS_UBO_BINDING);
    }

    private createFlatNormalTexture(): GL2Texture {
        // 1×1 flat-up tangent-space normal (0.5, 0.5, 1.0 → +Z) so meshes
        // without a normal map sample a no-op perturbation. Bound to
        // texture unit 1 alongside the per-mesh normal map slot.
        const gl = this.gl!;
        const tex = makeGL2Texture(gl, gl.TEXTURE_2D, 1, 1, 'flat_normal');
        gl.bindTexture(gl.TEXTURE_2D, tex.glTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 255, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return tex;
    }

    private createShadowFramebuffer(): void {
        const gl = this.gl!;
        this.shadowDepthTex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, this.shadowDepthTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, this.shadowMapSize, this.shadowMapSize, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // sampler2DShadow comparison mode — depth values < r returns 1.0.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
        gl.bindTexture(gl.TEXTURE_2D, null);

        this.shadowFBO = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowDepthTex, 0);
        // No color attachment — depth-only target. WebGL2 needs an
        // explicit drawBuffers([NONE]) for FBO completeness.
        gl.drawBuffers([gl.NONE]);
        gl.readBuffer(gl.NONE);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            console.warn('[gl2] shadow FBO incomplete:', status, '— shadows will be disabled');
            this.shadowEnabled = false;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    /**
     * Uniform block bindings have to be assigned per-program because each
     * link gets fresh block indices. Material/Joints share a bindpoint
     * across programs so a single buffer write per frame feeds them all.
     */
    private bindUBOBlockBindings(prog: WebGLProgram, hasMatJoints: boolean): void {
        if (this.uboBlockBindingsBound.has(prog)) return;
        const gl = this.gl!;
        const frameIdx = gl.getUniformBlockIndex(prog, 'FrameUBO');
        if (frameIdx !== gl.INVALID_INDEX) gl.uniformBlockBinding(prog, frameIdx, FRAME_UBO_BINDING);
        if (hasMatJoints) {
            const matIdx = gl.getUniformBlockIndex(prog, 'MaterialUBO');
            if (matIdx !== gl.INVALID_INDEX) gl.uniformBlockBinding(prog, matIdx, MATERIAL_UBO_BINDING);
            const jointsIdx = gl.getUniformBlockIndex(prog, 'JointsUBO');
            if (jointsIdx !== gl.INVALID_INDEX) gl.uniformBlockBinding(prog, jointsIdx, JOINTS_UBO_BINDING);
        }
        this.uboBlockBindingsBound.add(prog);
    }

    tick(_deltaTime: number, scene: RenderSceneSource | null): void {
        if (!this.gl) return;
        const gl = this.gl;

        // Scene assembly mirrors the WebGPU RenderSystem so existing
        // game scenes feed in unchanged.
        this.renderScene.clear();
        if (scene) {
            for (const mesh of scene.getMeshInstances()) this.renderScene.addMesh(mesh);
            for (const dl of scene.getDirectionalLights()) this.renderScene.addDirectionalLight(dl);
            for (const pl of scene.getPointLights()) this.renderScene.addPointLight(pl);
            for (const sl of scene.getSpotLights()) this.renderScene.addSpotLight(sl);
            if (this.renderScene.directionalLights.length === 0) {
                this.renderScene.addDirectionalLight({
                    direction: new Vec3(0.3, -1, 0.5).normalize(),
                    color: new Vec3(1, 1, 1),
                    intensity: 1.0,
                });
            }
            this.renderScene.setAmbient(scene.getAmbientColor(), scene.getAmbientIntensity());
            this.renderScene.setFog(scene.getFogData());
            this.renderScene.setTimeOfDay(scene.getTimeOfDay());

            let camera = this.activeCamera ?? scene.getActiveCamera();
            if (camera) {
                if (this.cameraOverrideView && this.cameraOverrideProj) {
                    camera = {
                        ...camera,
                        viewMatrix: this.cameraOverrideView,
                        projectionMatrix: this.cameraOverrideProj,
                    };
                }
                this.renderScene.setCamera(camera);
            }
        } else if (this.activeCamera) {
            const cam = (this.cameraOverrideView && this.cameraOverrideProj)
                ? { ...this.activeCamera, viewMatrix: this.cameraOverrideView, projectionMatrix: this.cameraOverrideProj }
                : this.activeCamera;
            this.renderScene.setCamera(cam);
            if (this.renderScene.directionalLights.length === 0) {
                this.renderScene.addDirectionalLight({
                    direction: new Vec3(0.3, -1, 0.5).normalize(),
                    color: new Vec3(1, 1, 1),
                    intensity: 1.0,
                });
            }
        }

        this.stats.reset();
        this.stats.meshesTotal = this.renderScene.meshes.length;

        // Compute the directional-light shadow matrix from the camera's
        // current position so the cascade follows the player. Updated
        // every frame because the camera moves; cheap (a lookAt + ortho).
        if (this.renderScene.camera && this.shadowEnabled) {
            this.updateShadowMatrix();
        }

        this.writeFrameUBO();

        // Shadow pass — depth-only render of all visible meshes from the
        // light's POV. Skipped if no camera, no FBO, or shadows disabled.
        if (this.shadowEnabled && this.shadowFBO && this.renderScene.camera) {
            this.renderShadowPass();
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const w = this.canvasManager.getWidth();
        const h = this.canvasManager.getHeight();
        if (w > 0 && h > 0) gl.viewport(0, 0, w, h);

        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // Skybox runs first with depth-test/write off so the geometry
        // pass can naturally overwrite covered pixels.
        this.drawSkybox();

        if (!this.renderScene.camera) return;

        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.enable(gl.CULL_FACE);
        gl.disable(gl.BLEND);

        // Bind the shadow map at unit 2 once for the entire main pass —
        // every lit draw samples the same map.
        if (this.shadowDepthTex) {
            gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT_SHADOW);
            gl.bindTexture(gl.TEXTURE_2D, this.shadowDepthTex);
        }

        const visible = this.renderScene.getVisibleMeshes();

        // Batched main pass: walk the sorted visible list, identifying
        // runs of consecutive non-skinned meshes that share VB / IBO /
        // draw range / material inputs. Runs of size ≥ 2 dispatch via
        // drawMeshBatchGL2 with one drawElementsInstanced; runs of 1
        // fall through to the per-mesh drawMesh path. Runs longer than
        // MAX_INSTANCES_GL2 are split into chunks because the
        // InstanceModelsUBO can't hold more than that.
        for (let i = 0; i < visible.length; ) {
            const m = visible[i];
            const skinned = !!m.jointMatricesBuffer && !!m.meshHandle.skinBuffer;
            if (!skinned) {
                let runEnd = i + 1;
                while (runEnd < visible.length && this.canBatchGL2(m, visible[runEnd])) runEnd++;
                if (runEnd - i >= 2) {
                    this.dispatchInstancedMainBatchGL2(visible, i, runEnd);
                    i = runEnd;
                    continue;
                }
            }
            this.drawMesh(m);
            i++;
        }
    }

    /** Set up the instanced lit program with the same per-batch state
     *  the per-mesh drawMesh would set, then split the run into
     *  ≤MAX_INSTANCES_GL2 chunks and dispatch drawMeshBatchGL2 for each. */
    private dispatchInstancedMainBatchGL2(visible: RenderMeshInstance[], start: number, end: number): void {
        const gl = this.gl!;
        const inst = visible[start];
        const handle = inst.meshHandle;
        const program = this.litInstancedProgram!;
        gl.useProgram(program);

        const state = this.getOrCreateMeshState(handle);
        gl.bindVertexArray(state.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.iboGL);

        // Material UBO is constant across the batch — write once.
        this.writeMaterialUBO(inst);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, MATERIAL_UBO_BINDING, this.materialUBO!.glBuffer);

        // Albedo + normal textures + shadow unit assignments — same for
        // every instance, so set once.
        gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT_BASE);
        if (inst.baseColorTexture && isGL2Texture(inst.baseColorTexture)) {
            gl.bindTexture(gl.TEXTURE_2D, asGL2Texture(inst.baseColorTexture).glTexture);
        } else {
            gl.bindTexture(gl.TEXTURE_2D, this.defaultWhiteTexture!.glTexture);
        }
        gl.uniform1i(gl.getUniformLocation(program, 'u_baseColorTex'), TEXTURE_UNIT_BASE);

        gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT_NORMAL);
        if (inst.normalMapTexture && isGL2Texture(inst.normalMapTexture)) {
            gl.bindTexture(gl.TEXTURE_2D, asGL2Texture(inst.normalMapTexture).glTexture);
        } else {
            gl.bindTexture(gl.TEXTURE_2D, this.defaultFlatNormalTexture!.glTexture);
        }
        gl.uniform1i(gl.getUniformLocation(program, 'u_normalMap'), TEXTURE_UNIT_NORMAL);

        gl.uniform1i(gl.getUniformLocation(program, 'u_shadowMap'), TEXTURE_UNIT_SHADOW);

        const firstIndex = inst.firstIndex ?? 0;
        const drawCount = inst.drawIndexCount ?? handle.indexCount;
        const indexByteSize = state.indexType === gl.UNSIGNED_SHORT ? 2 : 4;
        const firstIndexBytes = firstIndex * indexByteSize;

        // Split runs >MAX_INSTANCES_GL2 into chunks.
        for (let chunkStart = start; chunkStart < end; chunkStart += MAX_INSTANCES_GL2) {
            const chunkEnd = Math.min(chunkStart + MAX_INSTANCES_GL2, end);
            this.drawMeshBatchGL2(visible, chunkStart, chunkEnd, state.indexType, firstIndexBytes, drawCount);
            const cnt = chunkEnd - chunkStart;
            this.stats.drawCalls++;
            this.stats.triangles += Math.floor(drawCount / 3) * cnt;
            this.stats.meshesRendered += cnt;
        }
    }

    private updateShadowMatrix(): void {
        const cam = this.renderScene.camera!;
        const dl = this.renderScene.directionalLights[0];
        const dir = dl?.direction ?? new Vec3(0.3, -1, 0.5).normalize();
        const target = cam.position;
        const eye = new Vec3(
            target.x - dir.x * SHADOW_DIST_FROM_CAMERA,
            target.y - dir.y * SHADOW_DIST_FROM_CAMERA,
            target.z - dir.z * SHADOW_DIST_FROM_CAMERA,
        );
        // Pick up vector that isn't parallel to dir.
        const up = Math.abs(dir.y) > 0.99 ? new Vec3(0, 0, 1) : new Vec3(0, 1, 0);
        const view = Mat4.lookAt(eye, target, up);
        const proj = Mat4.ortho(-SHADOW_BOX_HALF, SHADOW_BOX_HALF, -SHADOW_BOX_HALF, SHADOW_BOX_HALF, SHADOW_NEAR, SHADOW_FAR);
        this.shadowMatrix = proj.multiply(view);
    }

    private renderShadowPass(): void {
        const gl = this.gl!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO!);
        gl.viewport(0, 0, this.shadowMapSize, this.shadowMapSize);
        gl.clearDepth(1.0);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        // Slope-scaled depth bias — kills shadow acne without the
        // detached-shadow ("Peter Panning") artifact a constant
        // fragment-side bias produces. Tuned empirically; raise the
        // factor (first arg) if any acne reappears on flat surfaces
        // facing the light at a shallow angle.
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(2.5, 4.0);

        const visible = this.renderScene.getVisibleMeshes();

        // Walk visible meshes detecting batchable runs (same VB/IBO/
        // draw range, non-skinned). Skinned meshes never batch — joint
        // UBO is per-mesh — so they pass through to the per-mesh path.
        for (let i = 0; i < visible.length; ) {
            const m = visible[i];
            const skinned = !!m.jointMatricesBuffer && !!m.meshHandle.skinBuffer;
            if (!skinned) {
                let runEnd = i + 1;
                while (runEnd < visible.length && this.canBatchGL2(m, visible[runEnd])) runEnd++;
                if (runEnd - i >= 2) {
                    this.dispatchInstancedShadowBatchGL2(visible, i, runEnd);
                    i = runEnd;
                    continue;
                }
            }
            this.drawShadowMesh(m);
            i++;
        }

        gl.disable(gl.POLYGON_OFFSET_FILL);
    }

    /** Per-mesh shadow draw — extracted from the renderShadowPass loop
     *  so the new batching logic can fall through here for singletons
     *  / skinned meshes without duplicating state setup. */
    private drawShadowMesh(inst: RenderMeshInstance): void {
        const gl = this.gl!;
        const handle = inst.meshHandle;
        const skinned = !!inst.jointMatricesBuffer && !!handle.skinBuffer;
        const program = skinned ? this.shadowSkinnedProgram! : this.shadowStaticProgram!;
        gl.useProgram(program);

        const state = this.getOrCreateMeshState(handle);
        gl.bindVertexArray(skinned ? state.skinVAO! : state.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.iboGL);

        if (skinned) {
            const jointBuf = asGL2Buffer(inst.jointMatricesBuffer);
            gl.bindBufferBase(gl.UNIFORM_BUFFER, JOINTS_UBO_BINDING, jointBuf.glBuffer);
        }

        const lightVPLoc = gl.getUniformLocation(program, 'u_lightViewProj');
        gl.uniformMatrix4fv(lightVPLoc, false, this.shadowMatrix.data);
        const modelLoc = gl.getUniformLocation(program, 'u_modelMatrix');
        gl.uniformMatrix4fv(modelLoc, false, inst.modelMatrix.data);

        const firstIndex = inst.firstIndex ?? 0;
        const drawCount = inst.drawIndexCount ?? handle.indexCount;
        const indexByteSize = state.indexType === gl.UNSIGNED_SHORT ? 2 : 4;
        gl.drawElements(gl.TRIANGLES, drawCount, state.indexType, firstIndex * indexByteSize);
    }

    /** Instanced shadow batch dispatch. Sets up program + VAO + IBO +
     *  the lightViewProj uniform once, then runs through chunks of
     *  ≤MAX_INSTANCES_GL2 instances each as drawElementsInstanced. */
    private dispatchInstancedShadowBatchGL2(visible: RenderMeshInstance[], start: number, end: number): void {
        const gl = this.gl!;
        const inst = visible[start];
        const handle = inst.meshHandle;
        const program = this.shadowInstancedProgram!;
        gl.useProgram(program);

        const state = this.getOrCreateMeshState(handle);
        gl.bindVertexArray(state.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.iboGL);

        const lightVPLoc = gl.getUniformLocation(program, 'u_lightViewProj');
        gl.uniformMatrix4fv(lightVPLoc, false, this.shadowMatrix.data);

        const firstIndex = inst.firstIndex ?? 0;
        const drawCount = inst.drawIndexCount ?? handle.indexCount;
        const indexByteSize = state.indexType === gl.UNSIGNED_SHORT ? 2 : 4;
        const firstIndexBytes = firstIndex * indexByteSize;

        for (let chunkStart = start; chunkStart < end; chunkStart += MAX_INSTANCES_GL2) {
            const chunkEnd = Math.min(chunkStart + MAX_INSTANCES_GL2, end);
            this.drawMeshBatchGL2(visible, chunkStart, chunkEnd, state.indexType, firstIndexBytes, drawCount);
        }
    }

    private writeFrameUBO(): void {
        const gl = this.gl!;
        const cam = this.renderScene.camera;
        const buf = this.frameUBOScratch;
        const viewMat = cam?.viewMatrix ?? Mat4.identity();
        const projMat = cam?.projectionMatrix ?? Mat4.identity();
        const camPos = cam?.position ?? new Vec3(0, 0, 0);

        // Layout (float-units; each = 4 bytes):
        // [0..15]    u_viewMatrix
        // [16..31]   u_projMatrix
        // [32..47]   u_lightViewProj
        // [48..51]   u_cameraPos       .xyz used
        // [52..55]   u_ambient         .rgb=ambient×intensity, .a=numDirLights
        // [56..71]   u_dirLightDir[4]  16 floats (4 × vec4)
        // [72..87]   u_dirLightColor[4]
        // [88..91]   u_fogParams       x=enabled, y=near, z=far
        // [92..95]   u_fogColor
        // [96..99]   u_misc            x=timeOfDay, y=numPoint, z=numSpot, w=shadowEnabled
        // [100..163] point lights      (8 × 8 floats)
        // [164..211] spot lights       (4 × 12 floats)
        buf.set(viewMat.data, 0);
        buf.set(projMat.data, 16);
        buf.set(this.shadowMatrix.data, 32);

        buf[48] = camPos.x; buf[49] = camPos.y; buf[50] = camPos.z; buf[51] = 0;

        const ambient = this.renderScene.ambientColor;
        const ambIntensity = this.renderScene.ambientIntensity;
        // Quality-tiered dir-light cap. Low → key light only (cheapest);
        // medium / high → up to MAX_DIR_LIGHTS_GL2 (key + fills + rim).
        const dirCap = this.quality === 'low' ? 1 : MAX_DIR_LIGHTS_GL2;
        const numDir = Math.min(
            Math.max(this.renderScene.directionalLights.length, 1),
            dirCap,
        );
        buf[52] = ambient.x * ambIntensity;
        buf[53] = ambient.y * ambIntensity;
        buf[54] = ambient.z * ambIntensity;
        buf[55] = numDir;

        // Directional lights — up to MAX_DIR_LIGHTS_GL2. Pad unused
        // slots with zero color so they contribute nothing if the
        // shader iterates past `numDir` for any reason.
        const dirDirBase = 56;
        const dirColorBase = 72;
        for (let i = 0; i < MAX_DIR_LIGHTS_GL2; i++) {
            const dl = this.renderScene.directionalLights[i];
            const o = dirDirBase + i * 4;
            const co = dirColorBase + i * 4;
            if (dl) {
                buf[o]     = dl.direction.x;
                buf[o + 1] = dl.direction.y;
                buf[o + 2] = dl.direction.z;
                buf[o + 3] = 0;
                buf[co]     = dl.color.x * dl.intensity;
                buf[co + 1] = dl.color.y * dl.intensity;
                buf[co + 2] = dl.color.z * dl.intensity;
                buf[co + 3] = 0;
            } else {
                buf[o] = 0; buf[o + 1] = -1; buf[o + 2] = 0; buf[o + 3] = 0;
                buf[co] = 0; buf[co + 1] = 0; buf[co + 2] = 0; buf[co + 3] = 0;
            }
        }

        const fog = this.renderScene.fog;
        // u_fogParams.w doubles as the hemispherical-ambient strength
        // multiplier (0 disables the effect on 'low' so flat-shading
        // stays predictable).
        const hemiStrength = this.quality === 'low' ? 0 : 0.35;
        buf[88] = fog.enabled ? 1.0 : 0.0;
        buf[89] = fog.near;
        buf[90] = fog.far;
        buf[91] = hemiStrength;
        buf[92] = fog.color.x;
        buf[93] = fog.color.y;
        buf[94] = fog.color.z;
        buf[95] = performance.now() / 1000.0;

        const numPoint = Math.min(this.renderScene.pointLights.length, MAX_POINT_LIGHTS_GL2);
        const numSpot = Math.min(this.renderScene.spotLights.length, MAX_SPOT_LIGHTS_GL2);
        buf[96] = this.renderScene.timeOfDay;
        buf[97] = numPoint;
        buf[98] = numSpot;
        buf[99] = this.shadowEnabled ? 1.0 : 0.0;

        const pointBase = 100;
        for (let i = 0; i < numPoint; i++) {
            const pl = this.renderScene.pointLights[i];
            const o = pointBase + i * 8;
            buf[o]     = pl.position.x;
            buf[o + 1] = pl.position.y;
            buf[o + 2] = pl.position.z;
            buf[o + 3] = pl.range;
            buf[o + 4] = pl.color.x * pl.intensity;
            buf[o + 5] = pl.color.y * pl.intensity;
            buf[o + 6] = pl.color.z * pl.intensity;
            buf[o + 7] = 0;
        }
        // Zero unused point-light slots so stale data from previous
        // frames doesn't show up if numPoint dropped this frame.
        for (let i = numPoint; i < MAX_POINT_LIGHTS_GL2; i++) {
            const o = pointBase + i * 8;
            for (let k = 0; k < 8; k++) buf[o + k] = 0;
        }

        // Spot lights after point-light array.
        const spotBase = pointBase + MAX_POINT_LIGHTS_GL2 * 8;
        for (let i = 0; i < numSpot; i++) {
            const sl = this.renderScene.spotLights[i];
            const o = spotBase + i * 12;
            buf[o]     = sl.position.x;
            buf[o + 1] = sl.position.y;
            buf[o + 2] = sl.position.z;
            buf[o + 3] = sl.range;
            buf[o + 4] = sl.direction.x;
            buf[o + 5] = sl.direction.y;
            buf[o + 6] = sl.direction.z;
            buf[o + 7] = Math.cos(sl.innerConeAngle);
            buf[o + 8]  = sl.color.x * sl.intensity;
            buf[o + 9]  = sl.color.y * sl.intensity;
            buf[o + 10] = sl.color.z * sl.intensity;
            buf[o + 11] = Math.cos(sl.outerConeAngle);
        }
        for (let i = numSpot; i < MAX_SPOT_LIGHTS_GL2; i++) {
            const o = spotBase + i * 12;
            for (let k = 0; k < 12; k++) buf[o + k] = 0;
        }

        gl.bindBuffer(gl.UNIFORM_BUFFER, this.frameUBO!.glBuffer);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, buf);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, FRAME_UBO_BINDING, this.frameUBO!.glBuffer);
    }

    private drawSkybox(): void {
        const gl = this.gl!;
        gl.useProgram(this.skyboxProgram!);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, FRAME_UBO_BINDING, this.frameUBO!.glBuffer);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /** Two consecutive RenderMeshInstance can share an instanced draw
     *  iff they hit the same shader path (non-skinned), the same VB +
     *  IBO + draw range (so one drawElementsInstanced rasterizes the
     *  same triangles N times), AND have identical material inputs
     *  (textures, material UBO contents). The batch reads each
     *  instance's modelMatrix from u_models[gl_InstanceID]; everything
     *  else is uniform across the batch. */
    private canBatchGL2(a: RenderMeshInstance, b: RenderMeshInstance): boolean {
        if (a.meshHandle.vertexBuffer !== b.meshHandle.vertexBuffer) return false;
        if (a.meshHandle.indexBuffer !== b.meshHandle.indexBuffer) return false;
        if ((a.firstIndex ?? 0) !== (b.firstIndex ?? 0)) return false;
        const aIdx = a.drawIndexCount ?? a.meshHandle.indexCount;
        const bIdx = b.drawIndexCount ?? b.meshHandle.indexCount;
        if (aIdx !== bIdx) return false;
        // Skinned meshes can't batch: each carries its own joint UBO.
        const aSkinned = !!a.jointMatricesBuffer && !!a.meshHandle.skinBuffer;
        const bSkinned = !!b.jointMatricesBuffer && !!b.meshHandle.skinBuffer;
        if (aSkinned || bSkinned) return false;
        if (a.baseColorTexture !== b.baseColorTexture) return false;
        if (a.normalMapTexture !== b.normalMapTexture) return false;
        if (a.baseColor[0] !== b.baseColor[0]) return false;
        if (a.baseColor[1] !== b.baseColor[1]) return false;
        if (a.baseColor[2] !== b.baseColor[2]) return false;
        if (a.baseColor[3] !== b.baseColor[3]) return false;
        if (a.metallic !== b.metallic) return false;
        if (a.roughness !== b.roughness) return false;
        if (a.emissive[0] !== b.emissive[0]) return false;
        if (a.emissive[1] !== b.emissive[1]) return false;
        if (a.emissive[2] !== b.emissive[2]) return false;
        if ((a.normalScale ?? 1) !== (b.normalScale ?? 1)) return false;
        if ((a.uvScaleX ?? 1) !== (b.uvScaleX ?? 1)) return false;
        if ((a.uvScaleY ?? 1) !== (b.uvScaleY ?? 1)) return false;
        return true;
    }

    /** Pack [start..end) instances' model matrices into the
     *  InstanceModelsUBO scratch + upload, then issue a single
     *  drawElementsInstanced. Caller has already set up the program /
     *  VAO / IBO / material UBO / textures since those are uniform
     *  across the batch. */
    private drawMeshBatchGL2(visible: RenderMeshInstance[], start: number, end: number, indexType: number, firstIndexBytes: number, drawCount: number): void {
        const gl = this.gl!;
        const scratch = this.instanceModelsScratch;
        const count = end - start;
        for (let k = 0; k < count; k++) {
            scratch.set(visible[start + k].modelMatrix.data, k * 16);
        }
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.instanceModelsUBO!.glBuffer);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, scratch, 0, count * 16);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, INSTANCE_MODELS_UBO_BINDING, this.instanceModelsUBO!.glBuffer);
        gl.drawElementsInstanced(gl.TRIANGLES, drawCount, indexType, firstIndexBytes, count);
    }

    private drawMesh(inst: RenderMeshInstance): void {
        const gl = this.gl!;
        const handle = inst.meshHandle;
        const skinned = !!inst.jointMatricesBuffer && !!handle.skinBuffer;
        const program = skinned ? this.litSkinnedProgram! : this.litStaticProgram!;
        gl.useProgram(program);

        const state = this.getOrCreateMeshState(handle);
        gl.bindVertexArray(skinned ? state.skinVAO! : state.vao);
        // Explicit IBO rebind — see MeshDrawState.iboGL comment.
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, state.iboGL);

        // Material UBO update — per-mesh because base color, metallic,
        // roughness, emissive, and uvScale all vary per draw.
        this.writeMaterialUBO(inst);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, MATERIAL_UBO_BINDING, this.materialUBO!.glBuffer);

        if (skinned) {
            const jointBuf = asGL2Buffer(inst.jointMatricesBuffer);
            gl.bindBufferBase(gl.UNIFORM_BUFFER, JOINTS_UBO_BINDING, jointBuf.glBuffer);
        }

        // u_modelMatrix is a regular uniform (not in a UBO) so the value
        // can vary cheaply per draw without a UBO write.
        const modelLoc = gl.getUniformLocation(program, 'u_modelMatrix');
        gl.uniformMatrix4fv(modelLoc, false, inst.modelMatrix.data);

        // Albedo (unit 0). Falls back to 1×1 white so an un-textured mesh
        // still shows its base-color tint.
        gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT_BASE);
        if (inst.baseColorTexture && isGL2Texture(inst.baseColorTexture)) {
            gl.bindTexture(gl.TEXTURE_2D, asGL2Texture(inst.baseColorTexture).glTexture);
        } else {
            gl.bindTexture(gl.TEXTURE_2D, this.defaultWhiteTexture!.glTexture);
        }
        gl.uniform1i(gl.getUniformLocation(program, 'u_baseColorTex'), TEXTURE_UNIT_BASE);

        // Normal map (unit 1). Always bound so the sampler always has a
        // valid texture; the shader only consumes it when u_pbr.w > 0.5.
        gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT_NORMAL);
        if (inst.normalMapTexture && isGL2Texture(inst.normalMapTexture)) {
            gl.bindTexture(gl.TEXTURE_2D, asGL2Texture(inst.normalMapTexture).glTexture);
        } else {
            gl.bindTexture(gl.TEXTURE_2D, this.defaultFlatNormalTexture!.glTexture);
        }
        gl.uniform1i(gl.getUniformLocation(program, 'u_normalMap'), TEXTURE_UNIT_NORMAL);

        // Shadow map (unit 2) — bound globally for the main pass; just
        // tell the program which unit it lives at.
        gl.uniform1i(gl.getUniformLocation(program, 'u_shadowMap'), TEXTURE_UNIT_SHADOW);

        const firstIndex = inst.firstIndex ?? 0;
        const drawCount = inst.drawIndexCount ?? handle.indexCount;
        const indexByteSize = state.indexType === gl.UNSIGNED_SHORT ? 2 : 4;
        gl.drawElements(gl.TRIANGLES, drawCount, state.indexType, firstIndex * indexByteSize);

        this.stats.drawCalls++;
        this.stats.triangles += Math.floor(drawCount / 3);
        this.stats.meshesRendered++;
    }

    private writeMaterialUBO(inst: RenderMeshInstance): void {
        const gl = this.gl!;
        const buf = this.materialUBOScratch;
        const c = inst.baseColor;
        buf[0] = c[0]; buf[1] = c[1]; buf[2] = c[2]; buf[3] = c[3];
        buf[4] = inst.metallic;
        buf[5] = inst.roughness;
        buf[6] = inst.normalScale ?? 1.0;
        buf[7] = inst.normalMapTexture ? 1.0 : 0.0;
        buf[8] = inst.emissive[0]; buf[9] = inst.emissive[1]; buf[10] = inst.emissive[2]; buf[11] = 0;
        buf[12] = inst.uvScaleX ?? 1.0;
        buf[13] = inst.uvScaleY ?? 1.0;
        buf[14] = 0; buf[15] = 0;
        buf[16] = inst.waterEffect ? 1.0 : 0.0;
        buf[17] = inst.waterLevel ?? -1e20;
        buf[18] = inst.waterScale ?? 1.0;
        buf[19] = 0;
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.materialUBO!.glBuffer);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, buf);
    }

    private getOrCreateMeshState(handle: GPUMeshHandle): MeshDrawState {
        let state = this.meshState.get(handle);
        if (state) return state;

        const gl = this.gl!;
        const vbo = asGL2Buffer(handle.vertexBuffer);
        const ibo = asGL2Buffer(handle.indexBuffer);
        const indexType = handle.indexFormat === 'uint16' ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;

        const vao = gl.createVertexArray();
        if (!vao) throw new Error('gl.createVertexArray returned null');
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo.glBuffer);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo.glBuffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_STRIDE, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, VERTEX_STRIDE, 12);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, VERTEX_STRIDE, 24);

        let skinVAO: WebGLVertexArrayObject | null = null;
        if (handle.skinBuffer) {
            skinVAO = gl.createVertexArray();
            if (!skinVAO) throw new Error('gl.createVertexArray returned null');
            gl.bindVertexArray(skinVAO);
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo.glBuffer);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo.glBuffer);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_STRIDE, 0);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 3, gl.FLOAT, false, VERTEX_STRIDE, 12);
            gl.enableVertexAttribArray(2);
            gl.vertexAttribPointer(2, 2, gl.FLOAT, false, VERTEX_STRIDE, 24);

            const skinVBO = asGL2Buffer(handle.skinBuffer);
            gl.bindBuffer(gl.ARRAY_BUFFER, skinVBO.glBuffer);
            gl.enableVertexAttribArray(3);
            gl.vertexAttribIPointer(3, 4, gl.UNSIGNED_INT, SKIN_STRIDE, 0);
            gl.enableVertexAttribArray(4);
            gl.vertexAttribPointer(4, 4, gl.FLOAT, false, SKIN_STRIDE, 16);
        }

        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

        state = { vao, skinVAO, indexType, iboGL: ibo.glBuffer };
        this.meshState.set(handle, state);
        return state;
    }

    setDecals(_decals: DecalInstance[]): void { /* no-op: decals not in V1 */ }

    uploadMesh(meshData: MeshData): GPUMeshHandle {
        const vertexCount = meshData.positions.length / 3;
        const interleaved = new Float32Array(vertexCount * 8);
        for (let i = 0; i < vertexCount; i++) {
            const si = i * 3, ui = i * 2, di = i * 8;
            interleaved[di]     = meshData.positions[si];
            interleaved[di + 1] = meshData.positions[si + 1];
            interleaved[di + 2] = meshData.positions[si + 2];
            interleaved[di + 3] = meshData.normals[si];
            interleaved[di + 4] = meshData.normals[si + 1];
            interleaved[di + 5] = meshData.normals[si + 2];
            interleaved[di + 6] = meshData.uvs[ui];
            interleaved[di + 7] = meshData.uvs[ui + 1];
        }

        const bounds = computeBounds(meshData.positions);
        const fs = meshData.facingScale;
        if (fs && Math.abs(fs - 1) > 1e-4) {
            bounds.boundRadius *= fs;
            bounds.boundMin = new Vec3(bounds.boundMin.x * fs, bounds.boundMin.y * fs, bounds.boundMin.z * fs);
            bounds.boundMax = new Vec3(bounds.boundMax.x * fs, bounds.boundMax.y * fs, bounds.boundMax.z * fs);
        }

        const indexFormat: GPUIndexFormat = meshData.indices instanceof Uint16Array ? 'uint16' : 'uint32';
        const vb = this.resources.createVertexBuffer(interleaved, 'mesh_vb');
        const ib = this.resources.createIndexBuffer(meshData.indices, 'mesh_ib');
        return {
            vertexBuffer: vb as unknown as GPUBuffer,
            indexBuffer: ib as unknown as GPUBuffer,
            indexCount: meshData.indices.length,
            indexFormat,
            ...bounds,
        };
    }

    /**
     * Building meshes carry an extra per-vertex u32 meta attribute used
     * by the WebGPU procedural-window shader. WebGL2 V1 doesn't have a
     * matching pipeline; we drop the meta attribute and treat the mesh
     * as a regular static one. Visual diff: walls are flat-shaded
     * instead of windowed — acceptable fallback.
     */
    uploadBuildingMesh(meshData: MeshData & { meta: Uint32Array }): GPUMeshHandle {
        const handle = this.uploadMesh(meshData);
        handle.hasBuildingMeta = true;
        return handle;
    }

    uploadSkinnedMesh(meshData: MeshData, joints: Uint16Array, weights: Float32Array): GPUMeshHandle {
        const handle = this.uploadMesh(meshData);
        const vertexCount = meshData.positions.length / 3;
        const skinData = new ArrayBuffer(vertexCount * SKIN_STRIDE);
        const skinU32 = new Uint32Array(skinData);
        const skinF32 = new Float32Array(skinData);
        for (let i = 0; i < vertexCount; i++) {
            skinU32[i * 8 + 0] = joints[i * 4 + 0];
            skinU32[i * 8 + 1] = joints[i * 4 + 1];
            skinU32[i * 8 + 2] = joints[i * 4 + 2];
            skinU32[i * 8 + 3] = joints[i * 4 + 3];
            skinF32[i * 8 + 4] = weights[i * 4 + 0];
            skinF32[i * 8 + 5] = weights[i * 4 + 1];
            skinF32[i * 8 + 6] = weights[i * 4 + 2];
            skinF32[i * 8 + 7] = weights[i * 4 + 3];
        }
        handle.skinBuffer = this.resources.createVertexBuffer(new Float32Array(skinData), 'skin_vb') as unknown as GPUBuffer;
        return handle;
    }

    createJointMatricesBuffer(_jointCount: number): GPUBuffer {
        // Always allocate the full MAX_JOINTS_GL2 capacity — the GLSL
        // UBO is declared `mat4 u_jointMatrices[MAX_JOINTS_GL2]` and
        // GL refuses to bind a smaller buffer to it ("uniform buffer
        // too small" at every drawElements). Skeletons with <64 joints
        // simply leave the tail of the UBO uninitialized; they only
        // index up to their own count.
        const buf = this.resources.createJointBuffer(MAX_JOINTS_GL2, 'joint_matrices_gl2');
        return buf as unknown as GPUBuffer;
    }

    updateJointMatrices(buffer: GPUBuffer, matrices: Float32Array): void {
        const gl = this.gl!;
        const buf = asGL2Buffer(buffer);
        const max = Math.min(matrices.byteLength, JOINTS_UBO_BYTES, buf.byteLength);
        const slice = matrices.byteLength <= max ? matrices : new Float32Array(matrices.buffer, matrices.byteOffset, max / 4);
        gl.bindBuffer(gl.UNIFORM_BUFFER, buf.glBuffer);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, slice);
    }

    uploadTexture(imageBitmap: ImageBitmap, params: any): GPUTexture {
        const tex = this.resources.uploadTexture2DFromBitmap(imageBitmap, {
            generateMipmaps: params?.generateMipmaps !== false,
            label: params?.label,
            sRGB: params?.sRGB ?? params?.format === 'rgba8unorm-srgb',
        });
        return tex as unknown as GPUTexture;
    }

    reuploadVertexBuffer(handle: GPUMeshHandle, interleavedData: Float32Array): void {
        const buf = asGL2Buffer(handle.vertexBuffer);
        this.resources.writeBuffer(buf, 0, interleavedData);
        // Drop cached VAO so next draw re-binds against the (potentially
        // resized) vertex buffer. Cheap; rebuilds in microseconds.
        this.meshState.delete(handle);
    }

    releaseMesh(handle: GPUMeshHandle): void {
        try { asGL2Buffer(handle.vertexBuffer).destroy(); } catch {}
        try { asGL2Buffer(handle.indexBuffer).destroy(); } catch {}
        if (handle.skinBuffer) {
            try { asGL2Buffer(handle.skinBuffer).destroy(); } catch {}
        }
        this.meshState.delete(handle);
    }

    releaseTexture(handle: GPUTexture): void {
        try { asGL2Texture(handle).destroy(); } catch {}
    }

    setActiveCamera(camera: RenderCamera): void {
        this.activeCamera = camera;
    }

    overrideCamera(viewMatrix: Mat4, projectionMatrix: Mat4): void {
        this.cameraOverrideView = viewMatrix.clone();
        this.cameraOverrideProj = projectionMatrix.clone();
    }

    clearCameraOverride(): void {
        this.cameraOverrideView = null;
        this.cameraOverrideProj = null;
    }

    setGraphicsQuality(q: GraphicsQuality): void {
        if (q === this.quality) return;
        this.quality = q;
        if (!this.gl) return;

        const wantSize = q === 'medium' ? SHADOW_MAP_SIZE_MEDIUM
            : q === 'high' ? SHADOW_MAP_SIZE_HIGH
            : 0;

        // Free the existing shadow FBO whenever the size changes (or
        // shadows were turned off entirely). Creating WebGL textures
        // and FBOs is cheap; reuploading on every quality flip is not
        // a hot path and the alternative — keeping a 2048² depth tex
        // resident on a low-tier GPU — costs ~16 MB for nothing.
        if (this.shadowFBO) this.gl.deleteFramebuffer(this.shadowFBO);
        if (this.shadowDepthTex) this.gl.deleteTexture(this.shadowDepthTex);
        this.shadowFBO = null;
        this.shadowDepthTex = null;

        if (wantSize === 0) {
            this.shadowMapSize = 0;
            this.shadowEnabled = false;
        } else {
            this.shadowMapSize = wantSize;
            this.shadowEnabled = true;
            this.createShadowFramebuffer();
        }
    }

    onCanvasResize(width: number, height: number): void {
        if (this.gl && width > 0 && height > 0) this.gl.viewport(0, 0, width, height);
    }

    getDebugRenderer(): DebugRenderer {
        return this.debugRendererStub;
    }

    setBuildingTextures(_d: GPUTexture | null, _n: GPUTexture | null, _props: Float32Array | null): void {
        // V1: building procedural textures are only used by the WebGPU
        // building pipeline. Plain meshes render fine without them.
    }

    clearSkinningCaches(): void {
        // No bind-group cache to clear in WebGL2 (joint UBOs are bound
        // freshly each draw via bindBufferBase). VAOs are mesh-scoped,
        // not skin-scoped, so they don't need clearing on Play→Stop→Play.
    }

    shutdown(): void {
        const gl = this.gl;
        if (gl) {
            if (this.litStaticProgram) gl.deleteProgram(this.litStaticProgram);
            if (this.litSkinnedProgram) gl.deleteProgram(this.litSkinnedProgram);
            if (this.shadowStaticProgram) gl.deleteProgram(this.shadowStaticProgram);
            if (this.shadowSkinnedProgram) gl.deleteProgram(this.shadowSkinnedProgram);
            if (this.skyboxProgram) gl.deleteProgram(this.skyboxProgram);
            if (this.shadowFBO) gl.deleteFramebuffer(this.shadowFBO);
            if (this.shadowDepthTex) gl.deleteTexture(this.shadowDepthTex);
        }
        this.litStaticProgram = null;
        this.litSkinnedProgram = null;
        this.shadowStaticProgram = null;
        this.shadowSkinnedProgram = null;
        this.skyboxProgram = null;
        this.shadowFBO = null;
        this.shadowDepthTex = null;
        this.frameUBO?.destroy(); this.frameUBO = null;
        this.materialUBO?.destroy(); this.materialUBO = null;
        this.defaultWhiteTexture?.destroy(); this.defaultWhiteTexture = null;
        this.defaultFlatNormalTexture?.destroy(); this.defaultFlatNormalTexture = null;
        this.resources.shutdown();
        this.gl = null;
        this.activeCamera = null;
        this.cameraOverrideView = null;
        this.cameraOverrideProj = null;
    }
}

function computeBounds(positions: Float32Array): { boundRadius: number; boundMin: Vec3; boundMax: Vec3 } {
    let maxDistSq = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const px = positions[i], py = positions[i + 1], pz = positions[i + 2];
        const d2 = px * px + py * py + pz * pz;
        if (d2 > maxDistSq) maxDistSq = d2;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
    }
    return {
        boundRadius: Math.sqrt(maxDistSq),
        boundMin: new Vec3(minX, minY, minZ),
        boundMax: new Vec3(maxX, maxY, maxZ),
    };
}

/**
 * Lightweight DebugRenderer-shaped stub. The WebGPU path's DebugRenderer
 * collects vertex data into transient buffers and flushes them in a
 * single line/triangle draw at the end of each frame. WebGL2 V1 doesn't
 * implement that pipeline — every method is a silent no-op so the
 * editor's debug-line and gizmo paths keep calling without crashing.
 *
 * Cast `as unknown as DebugRenderer` because the real class has private
 * fields that prevent structural assignment — the editor never touches
 * those, only the public method surface.
 */
function makeStubDebugRenderer(): DebugRenderer {
    const noop = () => {};
    return {
        setStats: noop,
        addLine: noop,
        addBox: noop,
        addSphere: noop,
        addCircle: noop,
        addCapsule: noop,
        addTriangle: noop,
        addMesh: noop,
        clear: noop,
        flush: noop,
        initialize: noop,
        shutdown: noop,
    } as unknown as DebugRenderer;
}
