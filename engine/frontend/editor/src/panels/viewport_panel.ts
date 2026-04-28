import { EditorContext } from '../editor_context.js';
import { EditorCamera } from '../input/editor_camera.js';
import { GizmoSystem } from '../gizmos/gizmo_system.js';
import { ViewportInputHandler } from '../input/viewport_input_handler.js';
import { TouchControls } from '../input/touch_controls.js';
import { CameraComponent } from '../../../runtime/function/framework/components/camera_component.js';
import { Vec3 } from '../../../runtime/core/math/vec3.js';
import { MeshData } from '../../../runtime/resource/types/mesh_data.js';
import { CreateEntityCommand } from '../history/commands.js';
import { buildComponentsForAsset, prettifyAssetName } from '../utils/asset_drop.js';
import { icon, Maximize2, Minimize2 } from '../widgets/icons.js';
import { StreamingManager } from '../streaming_manager.js';
import { isMobile } from '../utils/mobile.js';

/**
 * Viewport panel: contains the WebGPU canvas and overlay canvas for gizmos.
 */
export class ViewportPanel {
    readonly el: HTMLElement;
    readonly canvas: HTMLCanvasElement;
    readonly overlayCanvas: HTMLCanvasElement;
    readonly camera: EditorCamera;
    readonly gizmo: GizmoSystem;

    private ctx: EditorContext;
    private inputHandler: ViewportInputHandler;
    private touchControls: TouchControls | null = null;
    private fpsEl: HTMLElement;
    private assetLoadingIndicator: HTMLElement;

    private activeTab: 'game' | 'scene' = 'game';
    private tabBar: HTMLElement | null = null;
    private gameTabBtn: HTMLElement | null = null;
    private sceneTabBtn: HTMLElement | null = null;

    private lastFrameTime: number = 0;
    private collisionGpuMeshCache: Map<number, any> = new Map();
    private streaming: StreamingManager;

    constructor() {
        this.ctx = EditorContext.instance;
        this.camera = new EditorCamera();
        this.gizmo = new GizmoSystem(this.camera);
        this.streaming = new StreamingManager(this.ctx);

        this.el = document.createElement('div');
        this.el.className = 'viewport-panel';

        // Canvas container
        const container = document.createElement('div');
        container.className = 'viewport-canvas-container';

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'viewport-canvas';
        this.canvas.tabIndex = 0;
        container.appendChild(this.canvas);

        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.className = 'viewport-canvas';
        this.overlayCanvas.style.position = 'absolute';
        this.overlayCanvas.style.top = '0';
        this.overlayCanvas.style.left = '0';
        this.overlayCanvas.style.pointerEvents = isMobile() ? 'none' : 'auto';
        container.appendChild(this.overlayCanvas);

        // Overlay info
        const overlay = document.createElement('div');
        overlay.className = 'viewport-overlay';

        const infoDiv = document.createElement('div');
        infoDiv.className = 'viewport-info';
        this.fpsEl = document.createElement('div');
        this.fpsEl.className = 'viewport-fps';
        this.fpsEl.textContent = '0 FPS';
        infoDiv.appendChild(this.fpsEl);
        overlay.appendChild(infoDiv);

        this.assetLoadingIndicator = document.createElement('div');
        this.assetLoadingIndicator.className = 'viewport-asset-loading';
        this.assetLoadingIndicator.style.display = 'none';
        this.assetLoadingIndicator.innerHTML = '<div class="viewport-asset-loading-spinner"></div><span class="viewport-asset-loading-text">Loading assets...</span>';
        overlay.appendChild(this.assetLoadingIndicator);

        container.appendChild(overlay);

        // Tab bar (Game / Scene) for play mode
        this.tabBar = document.createElement('div');
        this.tabBar.className = 'tab-bar';
        this.tabBar.style.display = 'none';

        this.gameTabBtn = document.createElement('div');
        this.gameTabBtn.className = 'tab-item active';
        this.gameTabBtn.textContent = 'Game';
        this.gameTabBtn.addEventListener('click', () => this.setActiveTab('game'));

        this.sceneTabBtn = document.createElement('div');
        this.sceneTabBtn.className = 'tab-item';
        this.sceneTabBtn.textContent = 'Scene';
        this.sceneTabBtn.addEventListener('click', () => this.setActiveTab('scene'));

        this.tabBar.appendChild(this.gameTabBtn);
        this.tabBar.appendChild(this.sceneTabBtn);

        // Fullscreen button.
        //
        // Safari (iOS especially) doesn't expose the standard Fullscreen API
        // on non-<video> elements — `Element.requestFullscreen` either
        // doesn't exist, or rejects on call. Earlier Safari uses webkit-
        // prefixed names. Probe up-front and:
        //   - hide the button entirely when neither API is reachable
        //     (most iPhone Safari sessions), so we don't ship a dead control;
        //   - catch promise rejection in case `fullscreenEnabled` lies;
        //   - listen on both `fullscreenchange` and `webkitfullscreenchange`
        //     so the icon flips correctly on prefixed Safari builds.
        const d = document as any;
        const elProto = container as any;
        const requestFn: ((opts?: any) => Promise<void>) | null =
            (typeof container.requestFullscreen === 'function' ? container.requestFullscreen.bind(container) : null) ||
            (typeof elProto.webkitRequestFullscreen === 'function' ? elProto.webkitRequestFullscreen.bind(container) : null) ||
            (typeof elProto.webkitRequestFullScreen === 'function' ? elProto.webkitRequestFullScreen.bind(container) : null);
        const exitFn: (() => Promise<void>) | null =
            (typeof document.exitFullscreen === 'function' ? document.exitFullscreen.bind(document) : null) ||
            (typeof d.webkitExitFullscreen === 'function' ? d.webkitExitFullscreen.bind(document) : null) ||
            (typeof d.webkitCancelFullScreen === 'function' ? d.webkitCancelFullScreen.bind(document) : null);
        const fsEnabled = d.fullscreenEnabled === true || d.webkitFullscreenEnabled === true;
        const getFsElement = () => document.fullscreenElement || d.webkitFullscreenElement || null;

        if (requestFn && exitFn && fsEnabled) {
            const fullscreenBtn = document.createElement('div');
            fullscreenBtn.className = 'tab-item';
            fullscreenBtn.style.marginLeft = 'auto';
            fullscreenBtn.title = 'Toggle fullscreen';
            fullscreenBtn.appendChild(icon(Maximize2, 14));
            fullscreenBtn.addEventListener('click', () => {
                if (getFsElement()) {
                    Promise.resolve(exitFn()).catch(() => { /* swallow */ });
                } else {
                    Promise.resolve(requestFn()).catch(() => { /* swallow */ });
                }
            });
            const updateIcon = () => {
                fullscreenBtn.innerHTML = '';
                fullscreenBtn.appendChild(icon(getFsElement() ? Minimize2 : Maximize2, 14));
            };
            document.addEventListener('fullscreenchange', updateIcon);
            document.addEventListener('webkitfullscreenchange', updateIcon);
            this.tabBar.appendChild(fullscreenBtn);
        }
        // else: platform doesn't support entering fullscreen on a custom
        // element (iOS Safari pre-16.4 for non-video, locked-down PWAs,
        // some embedded browsers). Skip the button so the tab bar doesn't
        // show a control that does nothing.

        this.el.appendChild(this.tabBar);
        this.el.appendChild(container);

        const inputCanvas = isMobile() ? this.canvas : this.overlayCanvas;
        this.camera.attach(inputCanvas);
        this.gizmo.attachOverlay(this.overlayCanvas);
        this.inputHandler = new ViewportInputHandler(inputCanvas, this.camera, this.gizmo);

        if (isMobile()) {
            this.gizmo.attachTouchTarget(this.canvas);
            this.touchControls = new TouchControls(container, this.camera);
        }

        // Asset drag-and-drop
        this.overlayCanvas.addEventListener('dragover', (e) => {
            if (e.dataTransfer?.types.includes('application/x-parallax-asset')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
            }
        });

        this.overlayCanvas.addEventListener('drop', (e) => {
            e.preventDefault();
            const json = e.dataTransfer?.getData('application/x-parallax-asset');
            if (!json) return;
            try {
                const asset = JSON.parse(json);
                const worldPos = this.screenToGroundPlane(e.clientX, e.clientY);
                this.createEntityFromAsset(asset, worldPos);
            } catch { /* ignore */ }
        });

        // Play mode
        this.ctx.on('playModeChanged', (isPlaying: boolean) => {
            if (isPlaying) {
                this.tabBar!.style.display = '';
                this.setActiveTab('game');
            } else {
                this.tabBar!.style.display = 'none';
                // On mobile the overlay canvas sits above the WebGL canvas
                // that owns the touch handlers (see line ~63 and the
                // isMobile branch for `inputCanvas`). Setting pointerEvents
                // to 'auto' on stop swallows every touch and breaks
                // look-around / object selection until the page reloads.
                this.overlayCanvas.style.pointerEvents = isMobile() ? 'none' : 'auto';
                this.camera.disabled = false;
            }
        });

        // Asset loading progress
        this.ctx.on('assetLoadProgress', (progress: { loaded: number; total: number }) => {
            if (progress.total === 0 || progress.loaded >= progress.total) {
                this.assetLoadingIndicator.style.display = 'none';
            } else {
                this.assetLoadingIndicator.style.display = 'flex';
                const textEl = this.assetLoadingIndicator.querySelector('.viewport-asset-loading-text') as HTMLElement;
                if (textEl) textEl.textContent = `Loading assets (${progress.loaded}/${progress.total})`;
            }
        });

        // Focus on entity
        this.ctx.on('focusEntity', (entityId: number) => {
            const scene = this.ctx.getActiveScene();
            if (scene) {
                const entity = scene.getEntity(entityId);
                if (entity) {
                    this.camera.focusOn(entity.getWorldPosition());
                    this.ctx.setCameraMode('orbit');
                }
            }
        });

        // Set editor camera from external source
        this.ctx.on('setEditorCamera', (data: any) => {
            if (data.position && data.target) {
                this.camera.setPositionAndTarget(
                    { x: data.position.x ?? 0, y: data.position.y ?? 5, z: data.position.z ?? 15 },
                    { x: data.target.x ?? 0, y: data.target.y ?? 0, z: data.target.z ?? 0 },
                );
                this.ctx.setCameraMode('orbit');
            } else if (data.target) {
                this.camera.focusOn(data.target);
                this.ctx.setCameraMode('orbit');
            }
        });

        // Camera state persistence
        this.ctx.cameraStateProvider = () => this.camera.toJSON();

        this.ctx.on('projectLoaded', () => {
            const pd = this.ctx.state.projectData;
            const camData = pd?.editor?.['editor/camera.json'];
            if (camData) {
                this.camera.fromJSON(camData);
                if (camData.flyMode) {
                    this.ctx.setCameraMode('fly');
                }
            } else {
                // First-time open of the project: orbit around a "Player"
                // entity if present. Keeps brand-new projects viewable
                // without the user having to hunt down where the content
                // lives — especially important for world-scale scenes.
                const scene = this.ctx.getActiveScene();
                if (scene) {
                    for (const entity of scene.entities.values()) {
                        if (entity.name !== 'Player' && entity.name !== 'player') continue;
                        const pos = entity.getWorldPosition();
                        this.camera.fromJSON({
                            target: { x: pos.x, y: pos.y, z: pos.z },
                            distance: 50,
                            yaw: 0.4,
                            pitch: 0.5,
                            flyMode: false,
                        });
                        break;
                    }
                }
            }
            this.streaming.init();
        });

        // Re-init streamed content (heightmap terrain, OSM buildings, etc.)
        // after any scene swap — including the play→stop snapshot restore,
        // which otherwise leaves a stale Terrain entity with no heightData.
        this.ctx.on('sceneChanged', () => {
            this.streaming.init();
        });

        // Resize handling
        const resizeObserver = new ResizeObserver(() => {
            const rect = container.getBoundingClientRect();
            this.canvas.width = rect.width * window.devicePixelRatio;
            this.canvas.height = rect.height * window.devicePixelRatio;
            this.overlayCanvas.width = rect.width;
            this.overlayCanvas.height = rect.height;
        });
        resizeObserver.observe(container);

        this.startRenderLoop();
    }

    private setActiveTab(tab: 'game' | 'scene'): void {
        this.activeTab = tab;
        if (this.gameTabBtn && this.sceneTabBtn) {
            this.gameTabBtn.classList.toggle('active', tab === 'game');
            this.sceneTabBtn.classList.toggle('active', tab === 'scene');
        }
        if (tab === 'game') {
            this.overlayCanvas.style.pointerEvents = 'none';
            this.camera.disabled = true;
            this.canvas.focus();
            this.ctx.emit('viewportTabChanged', 'game');
        } else {
            // See playModeChanged — mobile routes touch input to the
            // underlying canvas, so the overlay must stay pointer-transparent.
            this.overlayCanvas.style.pointerEvents = isMobile() ? 'none' : 'auto';
            this.camera.disabled = false;
            this.ctx.emit('viewportTabChanged', 'scene');
        }
    }

    getCanvas(): HTMLCanvasElement {
        return this.canvas;
    }

    private findSceneCamera(): CameraComponent | null {
        const scene = this.ctx.getActiveScene();
        if (!scene) return null;

        let best: CameraComponent | null = null;
        let bestPriority = -Infinity;

        for (const entity of scene.entities.values()) {
            const cam = entity.getComponent('CameraComponent') as CameraComponent | null;
            if (cam && cam.priority >= bestPriority) {
                best = cam;
                bestPriority = cam.priority;
            }
        }
        return best;
    }

    private screenToGroundPlane(clientX: number, clientY: number): { x: number; y: number; z: number } {
        const rect = this.overlayCanvas.getBoundingClientRect();
        const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);

        const invViewProj = this.camera.getViewProjectionMatrix().inverse();
        if (!invViewProj) return { x: 0, y: 0, z: 0 };

        const nearPoint = invViewProj.transformPoint(new Vec3(ndcX, ndcY, 0));
        const farPoint = invViewProj.transformPoint(new Vec3(ndcX, ndcY, 1));
        const rayDir = farPoint.sub(nearPoint);

        if (Math.abs(rayDir.y) < 1e-6) return { x: 0, y: 0, z: 0 };
        const t = -nearPoint.y / rayDir.y;
        if (t < 0) return { x: 0, y: 0, z: 0 };

        const x = Math.round((nearPoint.x + rayDir.x * t) * 2) / 2;
        const z = Math.round((nearPoint.z + rayDir.z * t) * 2) / 2;
        return { x, y: 0, z };
    }

    private createEntityFromAsset(asset: any, pos: { x: number; y: number; z: number }): void {
        if (asset.fileUrl) this.ctx.assetMeta.set(asset.fileUrl, asset);
        const components = buildComponentsForAsset(asset, pos);
        const name = prettifyAssetName(asset.name);
        const cmd = new CreateEntityCommand(name, null, components);
        this.ctx.undoManager.execute(cmd);
        this.ctx.emit('historyChanged');
        this.ctx.ensurePrimitiveMeshes();
    }

    private updateCollisionMeshVis(): void {
        const show = this.ctx.state.showCollisionMesh;
        const selected = this.ctx.getSelectedEntities();
        const activeIds = new Set<number>();

        if (show) {
            for (const entity of selected) {
                const collider = entity.getComponent('ColliderComponent') as any;
                if (!collider || collider.shapeType !== 3) continue;
                const positions = collider.collisionPositions as Float32Array | null;
                const indices = collider.collisionIndices as Uint32Array | null;
                if (!positions || !indices) continue;

                activeIds.add(entity.id);

                const mr = entity.getComponent('MeshRendererComponent') as any;
                if (!mr) continue;

                if (this.ctx.state.collisionMeshHiddenEntities.has(entity.id)) continue;

                if (!this.collisionGpuMeshCache.has(entity.id)) {
                    const renderSystem = this.ctx.engine!.globalContext.renderSystem;
                    const meshData = this.buildCollisionMeshData(positions, indices);
                    const gpuHandle = renderSystem.uploadMesh(meshData);
                    this.collisionGpuMeshCache.set(entity.id, gpuHandle);
                }

                this.ctx.state.collisionMeshOriginals.set(entity.id, {
                    gpuMesh: mr.gpuMesh,
                    baseColorTexture: mr.gpuBaseColorTexture,
                    normalMapTexture: mr.gpuNormalMapTexture,
                    gpuSubMeshes: mr.gpuSubMeshes,
                    materialOverrides: JSON.parse(JSON.stringify(mr.materialOverrides)),
                });
                mr.gpuMesh = this.collisionGpuMeshCache.get(entity.id);
                mr.gpuBaseColorTexture = null;
                mr.gpuNormalMapTexture = null;
                mr.gpuSubMeshes = null;
                mr.materialOverrides = { baseColor: [0.85, 0.85, 0.85, 1], roughness: 0.9, metallic: 0 };
                this.ctx.state.collisionMeshHiddenEntities.add(entity.id);
            }
        }

        // Restore originals for entities no longer being previewed
        for (const id of this.ctx.state.collisionMeshHiddenEntities) {
            if (activeIds.has(id)) continue;
            const scene = this.ctx.getActiveScene();
            if (!scene) continue;
            const entity = scene.entities.get(id);
            if (!entity) continue;
            const mr = entity.getComponent('MeshRendererComponent') as any;
            const orig = this.ctx.state.collisionMeshOriginals.get(id);
            if (mr && orig) {
                mr.gpuMesh = orig.gpuMesh;
                mr.gpuBaseColorTexture = orig.baseColorTexture;
                mr.gpuNormalMapTexture = orig.normalMapTexture;
                mr.gpuSubMeshes = orig.gpuSubMeshes;
                mr.materialOverrides = orig.materialOverrides;
            }
            this.ctx.state.collisionMeshOriginals.delete(id);
            this.collisionGpuMeshCache.delete(id);
            this.ctx.state.collisionMeshHiddenEntities.delete(id);
        }
    }

    private buildCollisionMeshData(positions: Float32Array, indices: Uint32Array): MeshData {
        const vertCount = positions.length / 3;
        const normals = new Float32Array(positions.length);

        for (let i = 0; i < indices.length; i += 3) {
            const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
            const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
            const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
            const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];
            const ex = bx - ax, ey = by - ay, ez = bz - az;
            const fx = cx - ax, fy = cy - ay, fz = cz - az;
            const nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
            for (const vi of [i0, i1, i2]) {
                normals[vi * 3] += nx;
                normals[vi * 3 + 1] += ny;
                normals[vi * 3 + 2] += nz;
            }
        }

        for (let i = 0; i < vertCount; i++) {
            const o = i * 3;
            const len = Math.sqrt(normals[o] * normals[o] + normals[o + 1] * normals[o + 1] + normals[o + 2] * normals[o + 2]);
            if (len > 1e-8) { normals[o] /= len; normals[o + 1] /= len; normals[o + 2] /= len; }
            else { normals[o + 1] = 1; }
        }

        const md = new MeshData();
        md.positions = new Float32Array(positions);
        md.normals = normals;
        md.uvs = new Float32Array(vertCount * 2);
        md.indices = new Uint32Array(indices);
        return md;
    }

    private startRenderLoop(): void {
        const loop = () => {
            const now = performance.now() / 1000;
            const dt = now - this.lastFrameTime;
            this.lastFrameTime = now;

            this.camera.update(dt);
            this.gizmo.draw();

            if (!this.ctx.state.isPlaying && this.ctx.engine) {
                this.updateCollisionMeshVis();
            }

            if (this.ctx.engine) {
                const renderSystem = this.ctx.engine.globalContext.renderSystem;

                const useGameCam = this.ctx.state.isPlaying && this.activeTab === 'game';
                const sceneCam = useGameCam ? this.findSceneCamera() : null;
                let camPos: Vec3;
                if (sceneCam) {
                    const aspect = this.canvas.clientWidth / Math.max(this.canvas.clientHeight, 1);
                    camPos = sceneCam.entity.getWorldPosition();
                    renderSystem.setActiveCamera({
                        viewMatrix: sceneCam.getViewMatrix(),
                        projectionMatrix: sceneCam.getProjectionMatrix(aspect),
                        position: camPos,
                        near: sceneCam.nearClip,
                        far: sceneCam.farClip,
                        fovY: sceneCam.fov * (Math.PI / 180),
                    });
                } else {
                    camPos = this.camera.getPosition();
                    renderSystem.setActiveCamera({
                        viewMatrix: this.camera.getViewMatrix(),
                        projectionMatrix: this.camera.getProjectionMatrix(),
                        position: camPos,
                        near: this.camera.near,
                        far: this.camera.far,
                        fovY: this.camera.fov,
                    });
                }

                this.streaming.update(camPos);

                this.fpsEl.textContent = `${this.ctx.engine.getFPS()} FPS`;
            }

            requestAnimationFrame(loop);
        };
        this.lastFrameTime = performance.now() / 1000;
        requestAnimationFrame(loop);
    }
}
