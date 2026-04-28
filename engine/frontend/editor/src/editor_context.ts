import { EventBus } from '../../runtime/core/event/event_bus.js';
import { ParallaxEngine } from '../../runtime/engine.js';
import { Scene } from '../../runtime/function/framework/scene.js';
import { Entity } from '../../runtime/function/framework/entity.js';
import { MeshRendererComponent } from '../../runtime/function/framework/components/mesh_renderer_component.js';
import { TerrainComponent } from '../../runtime/function/framework/components/terrain_component.js';
import { MeshData } from '../../runtime/resource/types/mesh_data.js';
import { EditorState } from './state/editor_state.js';
import { UndoRedoManager } from './history/undo_redo_manager.js';
import { BackendClient } from './backend/backend_client.js';
import { CloudSync } from './backend/cloud_sync.js';
import { loadGLB, ParsedMesh, applyFacingTransformToPositions } from './utils/glb_loader.js';
import { loadScriptClass } from '../../runtime/function/scripting/script_loader.js';
import { ScriptComponent } from '../../runtime/function/framework/components/script_component.js';
import { GameUISystem } from '../../runtime/function/ui/game_ui.js';
import { HTMLUIManager } from '../../runtime/function/ui/html_ui_manager.js';
import { buildScriptScene } from './play_mode_helpers.js';
import { MultiplayerManager } from './network/multiplayer_manager.js';

function resolvePropertyValue(value: any, scriptScene: any): any {
    if (value && typeof value === 'object') {
        if (value.__entityRef != null) {
            return scriptScene?.getEntityById?.(value.__entityRef)
                ?? scriptScene?.findEntityById?.(value.__entityRef)
                ?? null;
        }
        if (value.__componentRef != null && value.type) {
            const entity = scriptScene?.getEntityById?.(value.__componentRef)
                ?? scriptScene?.findEntityById?.(value.__componentRef);
            return entity?.getComponent?.(value.type) ?? null;
        }
    }
    return value;
}

export class EditorContext extends EventBus {
    readonly state: EditorState = new EditorState();
    readonly undoManager: UndoRedoManager = new UndoRedoManager();
    readonly backend: BackendClient = new BackendClient();
    readonly cloudSync: CloudSync = new CloudSync(this.backend);
    engine: ParallaxEngine | null = null;
    readonly multiplayer: MultiplayerManager = new MultiplayerManager();
    private preMultiplayerTickUpdate: ((dt?: number) => void) | null = null;
    private htmlUIManager: HTMLUIManager | null = null;
    private gameUISystem: GameUISystem | null = null;
    private _stopRestorePromise: Promise<void> | null = null;
    private _pointerLockStopping = false;
    private _pointerLockOverlay: HTMLDivElement | null = null;

    private autosaveTimer: number = 0;
    private static _instance: EditorContext | null = null;
    private gpuMeshCache: Map<string, any> = new Map();
    private parsedMeshCache: Map<string, any> = new Map();
    readonly assetMeta: Map<string, Record<string, any>> = new Map();
    cameraStateProvider: (() => any) | null = null;
    _isApplyingRemoteChange: boolean = false;
    private _collabSyncTimer: number = 0;
    collabClientId: string = '';
    collabDisplayName: string = '';
    collabColor: string = '';
    playModeReady: Promise<void> = Promise.resolve();
    _playModeReadyResolve: (() => void) | null = null;
    _lastCollabSceneJSON: string = '';
    private _assetLoadBatchTotal: number = 0;

    constructor() {
        super();
        this.on('sceneChanged', () => {
            const sceneKey = this.state.activeScenePath;
            if (sceneKey) {
                this.backend.sendWsMessage('set_active_scene', { sceneKey });
            }
        });
        // Surface cloud-sync conflicts regardless of which view is
        // active — subscribe once at context level so the modal pops
        // from the editor AND the project list the same way.
        this.cloudSync.on('conflict', async (e: any) => {
            const { showCloudConflictModal } = await import('./widgets/cloud_conflict_modal.js');
            showCloudConflictModal(e.payload, {
                keepMine: async () => {
                    try { await this.cloudSync.forcePush(e.projectId); } catch (err) { console.error(err); }
                },
                keepRemote: async () => {
                    try {
                        await this.cloudSync.pull(e.projectId);
                        if (this.state.projectId === e.projectId) window.location.reload();
                    } catch (err) { console.error(err); }
                },
                keepBoth: async () => {
                    // Fork local state into a new local-only project, then
                    // pull the remote into the current one. We can't undo
                    // is_cloud on the original without losing the mapping,
                    // so duplicate it via the existing /duplicate endpoint
                    // (which produces a draft copy) and then pull remote.
                    try {
                        const dup = await this.backend.duplicateProject(e.projectId);
                        // Mark the duplicate as local-only (already is by
                        // default — /duplicate doesn't carry is_cloud).
                        await this.cloudSync.pull(e.projectId);
                        if (this.state.projectId === e.projectId) window.location.reload();
                        console.info('[cloudSync] forked local → ' + dup.id);
                    } catch (err) { console.error(err); }
                },
            });
        });
        this.cloudSync.on('auth_required', () => {
            console.warn('[cloudSync] auth required; user needs to sign in again');
        });
    }

    static get instance(): EditorContext {
        if (!EditorContext._instance) {
            EditorContext._instance = new EditorContext();
            (window as any).__editorCtx = EditorContext._instance;
        }
        return EditorContext._instance;
    }

    // ── Selection ──

    setSelection(entityIds: number[]): void {
        this.state.selectedEntityIds = [...entityIds];
        this.state.selectedSceneId = null;
        this.emit('selectionChanged', this.state.selectedEntityIds);
    }

    addToSelection(entityId: number): void {
        if (!this.state.selectedEntityIds.includes(entityId)) {
            this.state.selectedEntityIds.push(entityId);
            this.state.selectedSceneId = null;
            this.emit('selectionChanged', this.state.selectedEntityIds);
        }
    }

    removeFromSelection(entityId: number): void {
        const idx = this.state.selectedEntityIds.indexOf(entityId);
        if (idx !== -1) {
            this.state.selectedEntityIds.splice(idx, 1);
            this.emit('selectionChanged', this.state.selectedEntityIds);
        }
    }

    toggleSelection(entityId: number): void {
        if (this.state.selectedEntityIds.includes(entityId)) {
            this.removeFromSelection(entityId);
        } else {
            this.addToSelection(entityId);
        }
    }

    clearSelection(): void {
        const hadSelection = this.state.selectedEntityIds.length > 0 || this.state.selectedSceneId !== null;
        this.state.selectedEntityIds = [];
        this.state.selectedSceneId = null;
        if (hadSelection) {
            this.emit('selectionChanged', this.state.selectedEntityIds);
        }
    }

    selectScene(sceneId: number): void {
        this.state.selectedSceneId = sceneId;
        this.state.selectedEntityIds = [];
        this.emit('selectionChanged', this.state.selectedEntityIds);
    }

    clearSceneSelection(): void {
        if (this.state.selectedSceneId !== null) {
            this.state.selectedSceneId = null;
            this.emit('selectionChanged', this.state.selectedEntityIds);
        }
    }

    getSelectedEntities(): Entity[] {
        const scene = this.getActiveScene();
        if (!scene) return [];
        return this.state.selectedEntityIds
            .map(id => scene.getEntity(id))
            .filter((e): e is Entity => e !== null);
    }

    // ── Scene ──

    getActiveScene(): Scene | null {
        if (!this.engine) return null;
        return this.engine.globalContext.worldManager.getActiveScene();
    }

    async loadSceneFromData(sceneData: any): Promise<Scene> {
        if (!this.engine) throw new Error('Engine not initialized');
        const wm = this.engine.globalContext.worldManager;

        const oldScene = wm.getActiveScene();
        if (oldScene) {
            await wm.unloadScene(oldScene.id);
        }

        const scene = await wm.loadSceneFromData(sceneData);
        wm.setActiveScene(scene.id);
        this.engine.setActiveScene(scene as any);
        this.emit('sceneChanged');
        return scene;
    }

    markDirty(): void {
        if (!this.state.projectDirty) {
            this.state.projectDirty = true;
            this.emit('dirtyChanged', true);
        }
        if (!this._isApplyingRemoteChange) {
            this.scheduleCollabSync();
        }
    }

    private scheduleCollabSync(): void {
        if (this.state.isPlaying) return;
        if (this._collabSyncTimer) clearTimeout(this._collabSyncTimer);
        this._collabSyncTimer = window.setTimeout(() => {
            this._collabSyncTimer = 0;
            if (this.state.isPlaying) return;

            const wm = this.engine?.globalContext.worldManager;
            if (!wm) return;
            const allScenes = wm.getLoadedScenes();
            const scenesMap: Record<string, any> = {};
            for (const scene of allScenes) {
                const key = this.getSceneKey(scene);
                scenesMap[key] = scene.toJSON();
            }

            const activeKey = this.state.activeScenePath || 'scenes/main.scene.json';
            if (scenesMap[activeKey]) {
                this._lastCollabSceneJSON = JSON.stringify(scenesMap[activeKey]);
            }

            this.backend.sendCollabSceneSync(scenesMap);
        }, 300);
    }

    markClean(): void {
        if (this.state.projectDirty) {
            this.state.projectDirty = false;
            this.emit('dirtyChanged', false);
        }
    }

    // ── Gizmo ──

    setGizmoMode(mode: 'translate' | 'rotate' | 'scale'): void {
        if (this.state.gizmoMode !== mode) {
            this.state.gizmoMode = mode;
            this.emit('gizmoModeChanged', mode);
        }
    }

    setGizmoSpace(space: 'global' | 'local'): void {
        if (this.state.gizmoSpace !== space) {
            this.state.gizmoSpace = space;
            this.emit('gizmoSpaceChanged', space);
        }
    }

    toggleGizmoSpace(): void {
        this.setGizmoSpace(this.state.gizmoSpace === 'global' ? 'local' : 'global');
    }

    // ── Graphics Quality ──

    setGraphicsQuality(quality: 'low' | 'medium' | 'high'): void {
        if (this.engine) {
            this.engine.globalContext.renderSystem.setGraphicsQuality(quality);
        }
    }

    // ── Camera Mode ──

    setCameraMode(mode: 'orbit' | 'fly'): void {
        if (this.state.cameraMode !== mode) {
            this.state.cameraMode = mode;
            this.emit('cameraModeChanged', mode);
        }
    }

    toggleCameraMode(): void {
        this.setCameraMode(this.state.cameraMode === 'orbit' ? 'fly' : 'orbit');
    }

    // ── Play Mode ──

    play(): void {
        if (this.state.isPlaying) return;
        if (this.loadingAssets.size > 0) {
            console.warn(`[Play] Blocked: ${this.loadingAssets.size} assets still loading`);
            return;
        }
        if (this.engine) {
            this.engine.globalContext.inputDevice.suppressGameInput = false;
        }
        this.restoreCollisionMeshVisibility();
        this.state.showCollisionMesh = false;
        const scene = this.getActiveScene();
        if (scene) {
            this.state.prePlaySceneSnapshot = scene.toJSON();
        }
        this.state.isPlaying = true;
        const viewportCanvas = document.querySelector('.viewport-canvas') as HTMLCanvasElement;
        if (viewportCanvas) viewportCanvas.focus();
        const isMobileDevice = ('ontouchstart' in window) && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        if (isMobileDevice && this.engine) {
            this.engine.globalContext.inputDevice.forcePointerLocked = true;
        }
        // Pointer-lock relock overlay is desktop-only (mobile has no
        // pointer lock). Track the desktop-specific helpers in this
        // closure so the tab-change listener below can call them when
        // applicable, and the play-mode cleanup can detach them.
        let removeOverlay: () => void = () => {};
        let onPointerLockChange: ((e: Event) => void) | null = null;
        if (viewportCanvas && !isMobileDevice) {
            try { viewportCanvas.requestPointerLock(); } catch (_) {}

            const container = viewportCanvas.parentElement || document.body;
            this._pointerLockStopping = false;
            this._pointerLockOverlay = null;

            removeOverlay = () => {
                if (this._pointerLockOverlay) {
                    this._pointerLockOverlay.remove();
                    this._pointerLockOverlay = null;
                }
            };

            onPointerLockChange = () => {
                if (this._pointerLockStopping || !this.state.isPlaying) return;
                if (!document.pointerLockElement) {
                    if (this._pointerLockOverlay) return;
                    this._pointerLockOverlay = document.createElement('div');
                    this._pointerLockOverlay.style.cssText = 'position:absolute;inset:0;z-index:10000;cursor:pointer;';
                    this._pointerLockOverlay.addEventListener('mousedown', () => {
                        try { viewportCanvas.requestPointerLock(); } catch (_) {}
                    });
                    container.appendChild(this._pointerLockOverlay);
                } else {
                    removeOverlay();
                }
            };
            document.addEventListener('pointerlockchange', onPointerLockChange);
        }

        // Tab-changed listener — runs on BOTH desktop and mobile so the
        // HUD HTML / game-ui-overlay / entity labels hide when the user
        // toggles to the Scene tab during play. Previously this was
        // nested inside the desktop-only pointer-lock block, which left
        // mobile players staring at the in-game HUD on top of the scene
        // tab's gizmos. Pointer-lock specifics are still gated on
        // desktop via the captured helpers above.
        const onTabChanged = (tab: string) => {
            if (!this.state.isPlaying) return;
            const hide = tab === 'scene';
            if (this.engine) {
                this.engine.globalContext.inputDevice.suppressGameInput = hide;
                if (hide) this.engine.globalContext.inputSystem.clearAllInputState();
            }
            if (!isMobileDevice && viewportCanvas) {
                if (hide) {
                    this._pointerLockStopping = true;
                    removeOverlay();
                    try { document.exitPointerLock(); } catch (_) {}
                } else {
                    this._pointerLockStopping = false;
                    try { viewportCanvas.requestPointerLock(); } catch (_) {}
                }
            }
            if (this.htmlUIManager) this.htmlUIManager.setVisible(!hide);
            const guiOverlay = document.getElementById('game-ui-overlay');
            if (guiOverlay) guiOverlay.style.visibility = hide ? 'hidden' : '';
            const labels = document.querySelectorAll('.viewport-canvas-container .entity-label, .viewport-canvas-container [data-entity-label]');
            labels.forEach(el => (el as HTMLElement).style.visibility = hide ? 'hidden' : '');
            // Mobile-only: also hide the touch-controls overlay on the
            // Scene tab (it's a play-mode-only surface, and its joystick
            // / look pad would block the orbit camera's drag input).
            try {
                this.engine?.globalContext.mobileOverlay?.setSuspended(hide, 'scene-tab');
            } catch { /* swallow */ }
        };
        this.on('viewportTabChanged', onTabChanged);

        // Cleanup on Stop. Detach pointer-lock listener + tab listener
        // so a Play→Stop→Play cycle doesn't pile up duplicates that
        // each fire on the next tab toggle.
        const onPlayModeChanged = (playing: boolean) => {
            if (!playing) {
                this._pointerLockStopping = true;
                if (onPointerLockChange) document.removeEventListener('pointerlockchange', onPointerLockChange);
                removeOverlay();
                this.off('viewportTabChanged', onTabChanged);
                this.off('playModeChanged', onPlayModeChanged);
                try { document.exitPointerLock(); } catch (_) {}
                // Clear the scene-tab suspension key so the overlay is
                // ready for the next Play.
                try { this.engine?.globalContext.mobileOverlay?.setSuspended(false, 'scene-tab'); } catch { /* swallow */ }
            }
        };
        this.on('playModeChanged', onPlayModeChanged);
        if (this.engine) {
            const wm = this.engine.globalContext.worldManager;
            const pd = this.state.projectData;
            if (wm && pd && pd.scenes) {
                wm.clearSceneDataRegistry();
                for (const [key, data] of Object.entries(pd.scenes)) {
                    const name = key.replace('scenes/', '').replace('.scene.json', '');
                    wm.registerSceneData(name, data as Record<string, any>);
                    wm.registerSceneData(key, data as Record<string, any>);
                }
            }
            this._playModeReadyResolve = null;
            this.playModeReady = new Promise<void>((resolve) => {
                this._playModeReadyResolve = resolve;
            });
            this.loadAndAttachScripts().then(async () => {
                this.ensurePrimitiveMeshes();
                await this.waitForAllAssetsLoaded(10000);
                await this.loadCachedMeshColliders();
                const currentScene = this.getActiveScene();
                if (currentScene) {
                    this.engine!.setActiveScene(currentScene as any);
                }
                // Defense-in-depth: rebind skinned animators that came back
                // from snapshot reload with empty loadedClips / null skeleton.
                // The primary fix is RenderSystem.clearSkinningCaches in
                // engine.setEditorMode(true), but if a future change to the
                // snapshot/reload path empties the AnimatorComponent state,
                // this catches it. setupAnimatorFromGLB is idempotent
                // (reuses existing GPU buffer when bone count matches).
                if (currentScene && this.engine) {
                    const renderSystem = this.engine.globalContext.renderSystem;
                    for (const entity of currentScene.entities.values()) {
                        const mr: any = entity.getComponent('MeshRendererComponent');
                        const url: string | undefined = mr?.meshAsset;
                        if (!url) continue;
                        const animator: any = entity.getComponent('AnimatorComponent');
                        if (animator && animator.loadedClips?.size > 0 && animator.skeleton) continue;
                        const cachedParsed = this.parsedMeshCache.get(url);
                        if (cachedParsed?.hasSkin && cachedParsed?.skeleton && cachedParsed?.animationClips?.length) {
                            this.setupAnimatorFromGLB(entity, cachedParsed, renderSystem);
                        }
                    }
                }
                this.engine!.setEditorMode(false);
                this.emit('playModeChanged', true);
                if (this._playModeReadyResolve) {
                    this._playModeReadyResolve();
                    this._playModeReadyResolve = null;
                }
                this.startMultiplayer(scene!);
            }).catch((err) => {
                console.error('[Play] Failed to start play mode:', err);
                if (this.engine) {
                    const errScene = this.getActiveScene();
                    if (errScene) this.engine.setActiveScene(errScene as any);
                    this.engine.setEditorMode(false);
                }
                if (this._playModeReadyResolve) {
                    this._playModeReadyResolve();
                    this._playModeReadyResolve = null;
                }
            });
        } else {
            this.emit('playModeChanged', true);
        }
    }

    private async loadAndAttachScripts(): Promise<void> {
        const scene = this.getActiveScene();
        if (!scene || !this.engine) return;

        const scriptSystem = this.engine.globalContext.scriptSystem;
        scriptSystem.initialize(this.engine.globalContext.inputSystem);

        const gameUI = new GameUISystem('.viewport-canvas-container');
        this.gameUISystem = gameUI;

        this.htmlUIManager = new HTMLUIManager();

        const htmlUIManager = this.htmlUIManager;
        (gameUI as any).sendState = (state: any) => htmlUIManager.sendState(state);

        scriptSystem.setGameUI(gameUI);

        const gameAudio = this.engine.globalContext.audioSystem;
        if (gameAudio && (gameAudio as any).audioContext?.state === 'suspended') {
            (gameAudio as any).audioContext.resume();
        }
        scriptSystem.setGameAudio(gameAudio);

        const projectScripts = (this.state.projectData?.scripts ?? {}) as Record<string, string>;
        const compiledScripts = ((this.state.projectData as any)?.compiledScripts ?? {}) as Record<string, string>;
        const classMap = new Map<string, new () => any>();

        const { scriptScene, makeScriptEntity } = buildScriptScene({
            scene,
            engine: this.engine,
            scriptSystem,
            classMap,
            projectScripts,
            gameUI,
            gameAudio,
            ensurePrimitiveMeshes: () => this.ensurePrimitiveMeshes(),
            state: this.state,
            uiSendState: (state: any) => htmlUIManager.sendState(state),
            reloadScene: () => {
                this.stop();
                const doPlay = () => this.play();
                if (this._stopRestorePromise) {
                    this._stopRestorePromise.then(doPlay);
                } else {
                    setTimeout(doPlay, 50);
                }
            },
        });

        scriptSystem.setScene(scriptScene);

        const uiFiles = this.state.projectData?.uiFiles as Record<string, string> | undefined;
        if (uiFiles && htmlUIManager) {
            for (const [uiPath, uiContent] of Object.entries(uiFiles)) {
                htmlUIManager.loadUI(uiPath, uiContent);
            }
        }

        if (htmlUIManager) {
            htmlUIManager.onUICommand = (data: any) => {
                scriptScene.events?.ui?.emit('ui_command', data);
                const mpHandler = (htmlUIManager as any)._mpCommandHandler;
                if (mpHandler && data?.action?.startsWith('mp')) {
                    mpHandler(data);
                }
            };
        }

        const scriptEntities: { entity: Entity; scriptURL: string; isAdditional: boolean; additionalIndex: number }[] = [];
        for (const entity of scene.entities.values()) {
            const sc = entity.getComponent('ScriptComponent') as ScriptComponent | null;
            if (sc) {
                const url = sc.scriptURL || sc.scriptAssetUUID;
                if (url) {
                    scriptEntities.push({ entity, scriptURL: url, isAdditional: false, additionalIndex: -1 });
                }
                for (let i = 0; i < sc.additionalScripts.length; i++) {
                    const addUrl = sc.additionalScripts[i].scriptURL;
                    if (addUrl) {
                        scriptEntities.push({ entity, scriptURL: addUrl, isAdditional: true, additionalIndex: i });
                    }
                }
            }
        }

        if (scriptEntities.length === 0) return;

        const uniqueURLs = [...new Set(scriptEntities.map(s => s.scriptURL))];
        const scriptSources = new Map<string, string>();

        await Promise.all(uniqueURLs.map(async (url) => {
            if (projectScripts[url]) {
                scriptSources.set(url, projectScripts[url]);
                return;
            }
            try {
                const res = await fetch(url, { cache: 'no-store' });
                if (res.ok) {
                    scriptSources.set(url, await res.text());
                } else {
                    console.warn(`Failed to fetch script: ${url} (${res.status})`);
                }
            } catch (e) {
                console.warn(`Failed to fetch script: ${url}`, e);
            }
        }));

        for (const [url, source] of scriptSources) {
            const ScriptClass = loadScriptClass(source);
            if (!ScriptClass) {
                console.error('[Play] Failed to compile script:', url);
            }
            if (ScriptClass) {
                const name = ScriptClass.name || url;
                classMap.set(url, ScriptClass);
                scriptSystem.registerScript(name, ScriptClass);
            }
        }

        const scriptEntityCache = new Map<number, any>();
        for (const { entity, scriptURL, isAdditional, additionalIndex } of scriptEntities) {
            const ScriptClass = classMap.get(scriptURL);
            if (!ScriptClass) continue;
            const name = ScriptClass.name || scriptURL;
            let scriptEntity = scriptEntityCache.get(entity.id);
            if (!scriptEntity) {
                scriptEntity = makeScriptEntity(entity);
                if (scriptEntity) scriptEntityCache.set(entity.id, scriptEntity);
            }
            if (scriptEntity) {
                const inst = scriptSystem.attachScript(name, scriptEntity);
                if (inst) {
                    const sc = entity.getComponent('ScriptComponent') as ScriptComponent | null;
                    if (sc) {
                        const props = isAdditional
                            ? (sc.additionalScripts[additionalIndex]?.properties ?? {})
                            : sc.properties;
                        for (const [key, value] of Object.entries(props)) {
                            (inst as any)[key] = resolvePropertyValue(value, scriptScene);
                        }
                    }
                    if (isAdditional) {
                        if (sc) {
                            sc.addScriptInstance(inst);
                        }
                    }
                }
            }
        }

        const origTickUpdate = scriptSystem.tickUpdate.bind(scriptSystem);
        const origTickLateUpdate = scriptSystem.tickLateUpdate.bind(scriptSystem);
        const invalidateAll = () => {
            for (const e of scene.entities.values()) {
                const tc = e.getComponent('TransformComponent') as any;
                if (tc?.invalidate) tc.invalidate();
            }
        };
        scriptSystem.tickUpdate = () => { origTickUpdate(); invalidateAll(); };
        scriptSystem.tickLateUpdate = () => { origTickLateUpdate(); invalidateAll(); };
    }

    private async startMultiplayer(_scene: Scene): Promise<void> {
        if (!this.engine) return;

        const existingRoom = new URLSearchParams(window.location.search).get('room');
        const scripts = this.state.projectData?.scripts as Record<string, string> | undefined;
        const isMultiplayerGame = scripts && Object.keys(scripts).some(k => k.includes('network_sync'));
        if (!existingRoom && !isMultiplayerGame) return;
        const token = localStorage.getItem('auth_token') || localStorage.getItem('token');
        if (!token) return;

        const mp = this.multiplayer;
        const getScene = () => this.getActiveScene();

        const findPlayerEntity = () => {
            const s = getScene();
            if (!s) return null;
            for (const entity of s.entities.values()) {
                if (/^player$/i.test(entity.name || '')) return entity;
            }
            return null;
        };

        const getPlayerMeshAsset = () => {
            const player = findPlayerEntity();
            if (!player) return null;
            const mr = player.getComponent('MeshRendererComponent') as any;
            return mr?.meshAsset || mr?.meshType || null;
        };

        mp.getLocalPlayerState = () => {
            const player = findPlayerEntity();
            if (!player) return null;
            const tc = player.getComponent('TransformComponent') as any;
            if (!tc) return null;
            return {
                position: { x: tc.position.x, y: tc.position.y, z: tc.position.z },
                rotation: { x: tc.rotation.x, y: tc.rotation.y, z: tc.rotation.z, w: tc.rotation.w },
            };
        };

        mp.onSpawnRemotePlayer = (networkId: number, username: string) => {
            const s = getScene();
            if (!s) return null;
            const meshAsset = getPlayerMeshAsset();
            const e = s.createEntity(`Player_${username}`);
            const angle = Math.random() * Math.PI * 2;
            const dist = 2 + Math.random() * 3;
            e.addComponent('TransformComponent', {
                position: { x: Math.cos(angle) * dist, y: 0, z: Math.sin(angle) * dist },
                rotation: { x: 0, y: 0, z: 0, w: 1 },
                scale: { x: 1, y: 1, z: 1 },
            });
            const primitiveTypes = ['cube', 'sphere', 'capsule', 'cylinder', 'plane', 'cone'];
            if (meshAsset && !primitiveTypes.includes(meshAsset)) {
                e.addComponent('MeshRendererComponent', { meshType: 'custom', meshAsset, castShadows: true, receiveShadows: true, visible: true });
            } else {
                e.addComponent('MeshRendererComponent', { meshType: meshAsset || 'capsule', castShadows: true, receiveShadows: true, visible: true });
            }
            this.ensurePrimitiveMeshes();

            const mr = e.getComponent('MeshRendererComponent') as any;
            if (mr) this.loadMeshAsset(mr);

            return e.id;
        };

        mp.onDespawnRemotePlayer = (entityId: number) => {
            const s = getScene();
            if (s) s.destroyEntity(entityId);
        };

        mp.onUpdateRemotePlayer = (entityId: number, pos, rot) => {
            const s = getScene();
            if (!s) return;
            const entity = s.getEntity(entityId);
            if (!entity) return;
            const tc = entity.getComponent('TransformComponent') as any;
            if (!tc) return;
            tc.position.x = pos.x; tc.position.y = pos.y; tc.position.z = pos.z;
            tc.rotation.x = rot.x; tc.rotation.y = rot.y; tc.rotation.z = rot.z; tc.rotation.w = rot.w;
            tc.markDirty();
            (tc as any).worldMatrix = null;
            (tc as any).localMatrix = null;
        };

        const engineLoop = this.engine.globalContext;
        const scriptScene = (engineLoop.scriptSystem as any).scene;
        if (scriptScene) {
            scriptScene._multiplayer = mp;
        }

        this.preMultiplayerTickUpdate = engineLoop.scriptSystem.tickUpdate.bind(engineLoop.scriptSystem);
        const origTick = this.preMultiplayerTickUpdate;
        let lastMpTime = performance.now();
        const patchedTick = () => {
            origTick();
            const now = performance.now();
            const dt = (now - lastMpTime) / 1000;
            lastMpTime = now;
            mp.tick(dt);

            if (this.htmlUIManager && mp.isConnected) {
                const remotePlayers = mp.getRemotePlayers();
                const hostId = mp.hostNetworkId;
                const players = remotePlayers.map(p => ({
                    name: p.username, username: p.username, networkId: p.networkId,
                    isHost: p.networkId === hostId, isYou: false, isReady: p.isReady, latency: p.latency,
                }));
                players.unshift({
                    name: 'You', username: 'You', networkId: mp.localNetworkId,
                    isHost: mp.isRoomHost, isYou: true, isReady: mp.isReady, latency: 0,
                });
                this.htmlUIManager.sendStatePartial({
                    mpScreen: mp.lobbyState === 'lobby' ? 'lobby' : mp.lobbyState === 'playing' ? 'playing' : null,
                    mpRoomCode: mp.currentRoomId,
                    mpPlayers: players,
                    mpIsHost: mp.isRoomHost,
                    mpLatency: mp.getLatency(),
                    mpGameName: mp.gameName,
                    mpMaxPlayers: mp.maxPlayers,
                    mpMinPlayers: mp.minPlayers,
                });
            }
        };
        engineLoop.scriptSystem.tickUpdate = patchedTick;

        if (this.htmlUIManager) {
            (this.htmlUIManager as any)._mpCommandHandler = (msg: any) => {
                if (!msg || msg.type !== 'game_command') return;
                switch (msg.action) {
                    case 'mpHostGame':
                        if (!mp.isConnected || !mp.currentRoomId) {
                            if (mp.isConnected) mp.disconnect();
                            mp.connect(undefined, this.state.projectId || undefined, undefined, this.state.projectData)
                                .then((newRoomId: string) => {
                                    this.emit('multiplayerRoomCreated', { roomId: newRoomId, joinLink: mp.getJoinLink() });
                                }).catch(() => {});
                        }
                        break;
                    case 'mpJoinGame':
                        if (msg.roomId) { mp.disconnect(); mp.connect(msg.roomId, this.state.projectId || undefined); }
                        break;
                    case 'mpBrowseGames': {
                        const doBrowse = () => {
                            mp.requestRoomList(this.state.projectId || undefined);
                            mp.on('roomList', (data: any) => {
                                if (this.htmlUIManager) this.htmlUIManager.sendStatePartial({ mpScreen: 'browse', mpRoomList: data.rooms });
                            });
                            if (this.htmlUIManager) this.htmlUIManager.sendStatePartial({ mpScreen: 'browse' });
                        };
                        if (!mp.connected) { mp.connectForBrowse().then(() => doBrowse()).catch(() => {}); }
                        else { doBrowse(); }
                        break;
                    }
                    case 'mpBackToMenu':
                        if (this.htmlUIManager) this.htmlUIManager.sendStatePartial({ mpScreen: 'menu' });
                        break;
                    case 'mpReady': mp.setReady(!!msg.ready); break;
                    case 'mpSetPublic': if (mp.isConnected) mp.send('set_public', { isPublic: !!msg.isPublic }); break;
                    case 'mpRenameLobby': if (msg.name && mp.isConnected) mp.send('rename_room', { name: msg.name }); break;
                    case 'mpStartGame': try { mp.startGame(); } catch (e) { console.error('[MP] startGame error:', e); } break;
                    case 'mpCopyCode': if (msg.code && navigator.clipboard) navigator.clipboard.writeText(msg.code).catch(() => {}); break;
                    case 'mpLeaveLobby': mp.disconnect(); if (this.htmlUIManager) this.htmlUIManager.sendStatePartial({ mpScreen: 'menu' }); break;
                    case 'mpKickPlayer': if (msg.networkId) mp.kickPlayer(msg.networkId); break;
                    case 'mpTransferHost': if (msg.networkId) mp.transferHost(msg.networkId); break;
                }
            };
        }

        mp.on('kicked', () => {
            if (this.htmlUIManager) this.htmlUIManager.sendStatePartial({ mpScreen: 'menu' });
        });

        mp.on('roomClosed', (data: any) => {
            this.emit('multiplayerRoomClosed', data.message);
            this.stop();
        });

        mp.on('disconnected', () => {
            if (this.state.isPlaying) this.emit('multiplayerDisconnected');
        });

        (mp as any)._onGameStarted = () => {
            const ss = (this.engine?.globalContext.scriptSystem as any)?.scene;
            if (ss?.events?.ui) ss.events.ui.emit('mpGameStarted', {});
        };

        const isJoining = !!existingRoom;
        const projectSnapshot = !isJoining ? this.state.projectData : undefined;
        try {
            const roomId = await mp.connect(existingRoom || undefined, this.state.projectId || undefined, undefined, projectSnapshot);
            this.emit('multiplayerRoomCreated', { roomId, joinLink: mp.getJoinLink() });

            if (this.backend.isConnected) {
                this.backend.sendWsMessage('multiplayer_room', { roomId, joinLink: mp.getJoinLink(), hostName: this.collabDisplayName || 'A collaborator' });
            }
        } catch (err) {
            console.warn('[Multiplayer] Could not start multiplayer session:', err);
        }

        (mp as any)._onKicked = (data: any) => {
            const ss = (this.engine?.globalContext.scriptSystem as any)?.scene;
            if (ss?.events?.ui) {
                ss.events.ui.emit('showNotification', { text: data?.message || 'You have been kicked from the room.' });
                ss.events.ui.emit('btnMainMenu', {});
            }
        };
    }

    stop(): void {
        if (!this.state.isPlaying) return;
        this._pointerLockStopping = true;
        if (this._pointerLockOverlay) {
            this._pointerLockOverlay.remove();
            this._pointerLockOverlay = null;
        }
        try { document.exitPointerLock(); } catch (_) {}
        this.state.isPlaying = false;
        this.loadingAssets.clear();
        this._assetLoadBatchTotal = 0;
        this.clearSelection();
        if (this.htmlUIManager) { this.htmlUIManager.destroyAll(); this.htmlUIManager = null; }
        if (this.gameUISystem) { this.gameUISystem.destroyAll(); this.gameUISystem = null; }
        // Editor collaboration multiplayer (distinct from the runtime
        // P2P session below).
        this.multiplayer.disconnect();
        // Runtime P2P multiplayer: close lobby WS, every peer connection,
        // release the mic, tear down voice elements and reconcile timer.
        // Without this, Stop leaves the user still in a lobby, still
        // holding the mic, and still connected to every other peer.
        try { this.engine?.globalContext.multiplayerSession.disconnect(); } catch { /* ignored */ }
        if (this.engine && this.preMultiplayerTickUpdate) {
            this.engine.globalContext.scriptSystem.tickUpdate = this.preMultiplayerTickUpdate;
            this.preMultiplayerTickUpdate = null;
        }
        if (this.engine) {
            const audio = this.engine.globalContext.audioSystem;
            if (audio) {
                audio.stopAll();
                audio.stopMusic();
                if ((audio as any).audioContext?.state === 'running') {
                    (audio as any).audioContext.suspend();
                }
            }
            this.engine.globalContext.scriptSystem.shutdown();
            const scriptScene = this.engine.globalContext.scriptSystem?.scene;
            if (scriptScene?.events?.clear) scriptScene.events.clear();
            this.engine.setEditorMode(true);
            if (this.state.prePlaySceneSnapshot) {
                const wm = this.engine.globalContext.worldManager;
                const oldScene = wm.getActiveScene();
                if (oldScene) wm.unloadScene(oldScene.id);
                this._stopRestorePromise = this.loadSceneFromData(this.state.prePlaySceneSnapshot).then(() => {
                    this.state.prePlaySceneSnapshot = null;
                    this._stopRestorePromise = null;
                    this.ensurePrimitiveMeshes();
                    this.emit('sceneChanged');
                });
            }
        }
        this.emit('playModeChanged', false);
    }

    togglePlayMode(): void {
        if (this.state.isPlaying) { this.stop(); } else { this.play(); }
    }

    // ── Save ──

    async saveProject(): Promise<void> {
        if (!this.state.projectId) return;
        const wm = this.engine?.globalContext.worldManager;
        if (!wm) return;

        this.restoreCollisionMeshVisibility();

        const files: Record<string, any> = {};

        if (!this.state.projectData) this.state.projectData = {};
        if (!this.state.projectData.scenes) this.state.projectData.scenes = {};
        const allScenes = wm.getLoadedScenes();
        const newScenesMap: Record<string, any> = {};
        for (const scene of allScenes) {
            const sceneData = scene.toJSON();
            const sceneKey = this.getSceneKey(scene);
            const saveKey = sceneKey.startsWith('scenes/') ? sceneKey : `scenes/${sceneKey}`;
            files[saveKey] = sceneData;
            newScenesMap[sceneKey] = sceneData;
        }
        this.state.projectData.scenes = newScenesMap;
        if (this.cameraStateProvider) {
            files['editor/camera.json'] = this.cameraStateProvider();
        }
        if (this.state.projectData?.projectConfig || this.state.projectData?.config) {
            files['project.json'] = this.state.projectData.projectConfig ?? this.state.projectData.config;
        }
        try {
            await this.backend.saveProject(this.state.projectId, files);
            this.markClean();
            this.emit('projectSaved');
            // Cloud projects also push to parallaxpro.ai. Debounced, so
            // autosave bursts coalesce into one HTTP call.
            const pd: any = this.state.projectData;
            if (pd?.isCloud) {
                this.cloudSync.schedulePush(this.state.projectId);
            }
        } catch (e) {
            console.error('Failed to save project:', e);
        }
    }

    getSceneKey(scene: Scene): string {
        const pd = this.state.projectData;
        if (pd?.scenes) {
            for (const [key, data] of Object.entries(pd.scenes)) {
                if ((data as any)?.name === scene.name) return key;
            }
        }
        const safeName = (scene.name || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '_');
        return `scenes/${safeName}.scene.json`;
    }

    startAutosave(intervalMs: number = 30000): void {
        this.stopAutosave();
        this.autosaveTimer = window.setInterval(() => {
            if (this.state.projectDirty && !this.state.isPlaying) {
                this.saveProject();
            }
        }, intervalMs);
    }

    stopAutosave(): void {
        if (this.autosaveTimer) {
            clearInterval(this.autosaveTimer);
            this.autosaveTimer = 0;
        }
    }

    /**
     * Turn a local-only project into a cloud project: cloud-upserts the
     * source to parallaxpro.ai with the shared UUID, then marks the
     * local row is_cloud=1 so subsequent saves auto-push. Shared by the
     * editor's promote banner and the Settings modal's "Promote to
     * Cloud" button. No-ops cleanly when requirements aren't met.
     */
    async promoteCurrentProjectToCloud(): Promise<{ ok: true } | { ok: false; reason: string }> {
        const projectId = this.state.projectId;
        if (!projectId) return { ok: false, reason: 'No project open.' };
        if (!this.backend.isSelfHosted) return { ok: false, reason: 'Already on parallaxpro.ai.' };
        const userId = this.cloudSync.currentUserId();
        if (!userId) return { ok: false, reason: 'Sign in to parallaxpro.ai first.' };
        const engineGitHash = typeof __ENGINE_GIT_HASH__ !== 'undefined' ? __ENGINE_GIT_HASH__ : 'unknown';
        try {
            const fresh = await this.backend.loadProject(projectId);
            const res = await this.backend.cloudUpsertProd({
                id: projectId,
                name: fresh.name,
                projectData: { projectConfig: fresh.projectConfig ?? { name: fresh.name }, files: fresh.files ?? {} },
                expectedUpdatedAt: null,
                engineGitHash,
                force: true, // first cloud push — no prior state to conflict with
            });
            const abs = res.thumbnail
                ? (res.thumbnail.startsWith('http') ? res.thumbnail : `https://parallaxpro.ai${res.thumbnail}`)
                : null;
            await this.backend.markCloudLocal(projectId, {
                cloudUserId: userId,
                cloudUpdatedAt: res.updatedAt,
                editedEngineHash: res.editedEngineHash,
                thumbnail: abs,
            });
            if (this.state.projectData) (this.state.projectData as any).isCloud = true;
            this.emit('cloudPromoted');
            return { ok: true };
        } catch (e: any) {
            return { ok: false, reason: e?.message ?? 'Failed to promote to cloud.' };
        }
    }

    // ── Primitive Mesh Upload ──

    ensurePrimitiveMeshes(): void {
        const scene = this.getActiveScene();
        if (!scene || !this.engine) return;

        const renderSystem = this.engine.globalContext.renderSystem;

        for (const entity of scene.entities.values()) {
            const mr = entity.getComponent('MeshRendererComponent') as MeshRendererComponent | null;
            if (!mr || mr.gpuMesh) continue;

            if (mr.meshAsset && mr.meshType === 'custom') {
                this.loadMeshAsset(mr);
                continue;
            }

            if (!mr.meshType) continue;

            let gpuHandle = this.gpuMeshCache.get(mr.meshType);
            if (!gpuHandle) {
                const meshData = this.createPrimitiveMeshData(mr.meshType);
                if (!meshData) continue;
                gpuHandle = renderSystem.uploadMesh(meshData);
                this.gpuMeshCache.set(mr.meshType, gpuHandle);
            }
            mr.gpuMesh = gpuHandle;
            // Primitives (cube/sphere/plane/cylinder/capsule) used to skip
            // auto-fit because this path doesn't go through loadMeshAsset.
            // That left every primitive-meshed entity with the
            // ColliderComponent's default halfExtents (0.5, 0.5, 0.5) instead
            // of the actual primitive's AABB — so a plane mesh (mesh-local Y
            // extent = 0) ended up with a 1m-tall box collider, and any
            // template that authored `physics.collider: "box"` on a primitive
            // and trusted auto-fit to do the right thing got the wrong shape.
            // Calling autoFitCollider here closes that gap so primitives are
            // covered by the same invariant as custom GLBs.
            this.autoFitCollider(entity, gpuHandle);

            if (mr.materialOverrides) {
                const bundle = mr.materialOverrides.textureBundle || mr.materialOverrides.albedoMap;
                if (bundle && typeof bundle === 'string' && !mr.gpuBaseColorTexture) {
                    this.loadTextureBundle(mr, bundle, renderSystem);
                }
            }
        }

        for (const entity of scene.entities.values()) {
            const terrain = entity.getComponent('TerrainComponent') as TerrainComponent | null;
            if (!terrain) continue;
            if (terrain.meshDirty) terrain.generateMesh();
            if (!terrain.gpuMesh || terrain.dirty) {
                if (terrain.gpuMesh) renderSystem.releaseMesh(terrain.gpuMesh);
                if (terrain.positions.length > 0 && terrain.indices.length > 0) {
                    terrain.gpuMesh = renderSystem.uploadMesh({
                        positions: terrain.positions, normals: terrain.normals, uvs: terrain.uvs, indices: terrain.indices,
                    });
                    terrain.clearDirty();
                }
            }
        }
    }

    private loadingAssets: Set<string> = new Set();

    getAssetLoadProgress(): { loaded: number; total: number } {
        if (this._assetLoadBatchTotal === 0) return { loaded: 0, total: 0 };
        return { loaded: this._assetLoadBatchTotal - this.loadingAssets.size, total: this._assetLoadBatchTotal };
    }

    get assetsLoadingCount(): number { return this.loadingAssets.size; }

    private _emitAssetLoadProgress(): void {
        this.emit('assetLoadProgress', this.getAssetLoadProgress());
    }

    waitForAllAssetsLoaded(timeoutMs: number = 15000): Promise<void> {
        return new Promise((resolve) => {
            const start = Date.now();
            const check = () => {
                if (this.loadingAssets.size === 0) { resolve(); }
                else if (Date.now() - start > timeoutMs) {
                    console.warn(`[Play] Asset loading timed out after ${timeoutMs}ms. Still loading: ${[...this.loadingAssets].join(', ')}`);
                    resolve();
                } else { setTimeout(check, 100); }
            };
            check();
        });
    }

    private gpuTextureCache: Map<string, GPUTexture> = new Map();
    private gpuNormalMapCache: Map<string, GPUTexture> = new Map();
    private gpuSubMeshesCache: Map<string, MeshRendererComponent['gpuSubMeshes']> = new Map();

    private loadMeshAsset(mr: MeshRendererComponent): void {
        let url = mr.meshAsset;
        if (!url || !this.engine) return;

        const cached = this.gpuMeshCache.get(url);
        if (cached) {
            mr.gpuMesh = cached;
            mr.gpuBaseColorTexture = this.gpuTextureCache.get(url) ?? null;
            mr.gpuNormalMapTexture = this.gpuNormalMapCache.get(url) ?? null;
            mr.gpuSubMeshes = this.gpuSubMeshesCache.get(url) ?? null;

            if (cached.boundMin && cached.boundMax) {
                const scene = this.getActiveScene();
                if (scene) {
                    for (const e of scene.entities.values()) {
                        const comp = e.getComponent('MeshRendererComponent') as any;
                        if (comp && comp.meshAsset === url) this.autoFitCollider(e, cached);
                    }
                }
            }

            const cachedParsed = this.parsedMeshCache.get(url);
            if (cachedParsed?.hasSkin && cachedParsed?.skeleton && cachedParsed?.animationClips?.length) {
                const scene = this.getActiveScene();
                if (scene) {
                    for (const e of scene.entities.values()) {
                        const comp = e.getComponent('MeshRendererComponent') as any;
                        if (comp && comp.meshAsset === url) this.setupAnimatorFromGLB(e, cachedParsed, this.engine!.globalContext.renderSystem);
                    }
                }
            }
            // Surface the facing-registry transform (only set on skinned meshes by
            // the loader) so scene.ts can compose it into the per-entity mesh
            // transform at render time. Static meshes have it baked into vertices
            // already, so meshData stays null for them and there's nothing to do.
            if (cachedParsed) {
                const scene = this.getActiveScene();
                if (scene) {
                    for (const e of scene.entities.values()) {
                        const comp = e.getComponent('MeshRendererComponent') as any;
                        if (comp && comp.meshAsset === url) comp.meshData = cachedParsed;
                    }
                }
            }
            return;
        }

        if (this.loadingAssets.has(url)) return;
        this.loadingAssets.add(url);
        this._assetLoadBatchTotal++;
        this._emitAssetLoadProgress();

        loadGLB(url).then(async (meshData) => {
            if (!this.engine) return;
            const renderSystem = this.engine.globalContext.renderSystem;
            const gpuHandle = (meshData.hasSkin && meshData.joints && meshData.weights)
                ? renderSystem.uploadSkinnedMesh(meshData, meshData.joints, meshData.weights)
                : renderSystem.uploadMesh(meshData);
            let gpuTexture: GPUTexture | null = null;
            let gpuNormalMap: GPUTexture | null = null;
            let gpuSubMeshes: MeshRendererComponent['gpuSubMeshes'] = null;

            try {
                if (meshData.subMeshRanges && meshData.atlasTextureBlobs) {
                    gpuSubMeshes = await this.buildSubMeshTextures(meshData, renderSystem);
                    if (gpuSubMeshes) this.gpuSubMeshesCache.set(url, gpuSubMeshes);
                } else {
                    gpuTexture = await this.loadGLBTexture(meshData, renderSystem);
                    if (gpuTexture) this.gpuTextureCache.set(url, gpuTexture);
                    gpuNormalMap = await this.loadGLBNormalMap(meshData, renderSystem);
                    if (gpuNormalMap) this.gpuNormalMapCache.set(url, gpuNormalMap);
                }
            } catch (e) {
                console.warn(`[EditorContext] Failed to load texture for: ${url}`, e);
            }

            this.gpuMeshCache.set(url, gpuHandle);
            if (meshData.hasSkin) this.parsedMeshCache.set(url, meshData);

            this.loadLODSidecars(url, renderSystem);

            this.loadingAssets.delete(url);
            if (this.loadingAssets.size === 0) this._assetLoadBatchTotal = 0;
            this._emitAssetLoadProgress();

            const scene = this.getActiveScene();
            if (scene) {
                for (const entity of scene.entities.values()) {
                    const comp = entity.getComponent('MeshRendererComponent') as MeshRendererComponent | null;
                    if (comp && comp.meshAsset === url) {
                        comp.gpuMesh = gpuHandle;
                        // Stash the parsed mesh so scene.ts can read facingRotMatrix
                        // / facingScale (skinned-mesh registry transform) from it.
                        // Static meshes have those baked into vertices; setting
                        // meshData for them is harmless (the fields are absent).
                        comp.meshData = meshData;
                        this.autoFitCollider(entity, gpuHandle);
                        comp.gpuBaseColorTexture = gpuTexture;
                        comp.gpuNormalMapTexture = gpuNormalMap;
                        comp.gpuSubMeshes = gpuSubMeshes;
                        if (meshData.hasSkin && meshData.skeleton && meshData.animationClips?.length) {
                            this.setupAnimatorFromGLB(entity, meshData, renderSystem);
                        }
                    }
                }
            }
        }).catch((err) => {
            console.error(`[EditorContext] Failed to load mesh asset: ${url}`, err);
            this.loadingAssets.delete(url);
            if (this.loadingAssets.size === 0) this._assetLoadBatchTotal = 0;
            this._emitAssetLoadProgress();
        });
    }

    private lodCache: Map<string, { lod1: any; lod2: any }> = new Map();
    // Server-side manifest of asset paths (relative) that have generated
    // .lod1.bin/.lod2.bin sidecars. Lazily fetched once; gates LOD fetches
    // so the browser console isn't spammed with 404s for small meshes.
    private lodManifest: Set<string> | null = null;
    private lodManifestPromise: Promise<Set<string>> | null = null;

    private async getLODManifest(): Promise<Set<string>> {
        if (this.lodManifest) return this.lodManifest;
        if (!this.lodManifestPromise) {
            this.lodManifestPromise = fetch('/api/engine/assets/lod-manifest')
                .then(r => r.ok ? r.json() : { paths: [] })
                .then((data: any) => new Set<string>(data?.paths ?? []))
                .catch(() => new Set<string>());
        }
        this.lodManifest = await this.lodManifestPromise;
        return this.lodManifest;
    }

    private async loadLODSidecars(url: string, renderSystem: any): Promise<void> {
        if (this.lodCache.has(url)) {
            const cached = this.lodCache.get(url)!;
            this.applyLODsToEntities(url, cached.lod1, cached.lod2);
            return;
        }
        // Only fetch LOD variants for assets the server reports as having them.
        // URL typically looks like "/assets/<relative path>"; extract the
        // relative path and check the manifest.
        const m = url.match(/\/assets\/(.+)$/);
        if (!m) return;
        const relPath = m[1];
        const manifest = await this.getLODManifest();
        if (!manifest.has(relPath)) return;
        try {
            const [lod1Resp, lod2Resp] = await Promise.all([
                fetch(url.replace(/\.glb$/i, '.lod1.bin')).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null),
                fetch(url.replace(/\.glb$/i, '.lod2.bin')).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null),
            ]);
            let lod1Handle: any = null, lod2Handle: any = null;
            if (lod1Resp && lod1Resp.byteLength > 24) { const m2 = this.parseLODBin(lod1Resp); if (m2) lod1Handle = renderSystem.uploadMesh(m2); }
            if (lod2Resp && lod2Resp.byteLength > 24) { const m2 = this.parseLODBin(lod2Resp); if (m2) lod2Handle = renderSystem.uploadMesh(m2); }
            if (lod1Handle || lod2Handle) {
                this.lodCache.set(url, { lod1: lod1Handle, lod2: lod2Handle });
                this.applyLODsToEntities(url, lod1Handle, lod2Handle);
            }
        } catch {}
    }

    private parseLODBin(buf: ArrayBuffer): { positions: Float32Array; indices: Uint32Array; normals: Float32Array; uvs: Float32Array } | null {
        if (buf.byteLength < 24) return null;
        const view = new DataView(buf);
        const magic = view.getUint32(0, true);
        if (magic !== 0x4C4F4431 && magic !== 0x4C4F4432) return null;
        const posCount = view.getUint32(8, true), idxCount = view.getUint32(12, true);
        const nrmCount = view.getUint32(16, true), uvCount = view.getUint32(20, true);
        let off = 24;
        const positions = new Float32Array(buf, off, posCount); off += posCount * 4;
        const indices = new Uint32Array(buf, off, idxCount); off += idxCount * 4;
        const normals = new Float32Array(buf, off, nrmCount); off += nrmCount * 4;
        const uvs = new Float32Array(buf, off, uvCount);
        return { positions, indices, normals, uvs };
    }

    private applyLODsToEntities(url: string, lod1: any, lod2: any): void {
        const scene = this.getActiveScene();
        if (!scene) return;
        for (const e of scene.entities.values()) {
            const mr = e.getComponent('MeshRendererComponent') as MeshRendererComponent | null;
            if (mr && mr.meshAsset === url) {
                if (lod1) mr.gpuMeshLOD1 = lod1;
                if (lod2) mr.gpuMeshLOD2 = lod2;
            }
        }
    }

    private autoFitCollider(entity: any, gpuMesh: any): void {
        if (!gpuMesh.boundMin || !gpuMesh.boundMax) return;
        const col = entity.getComponent('ColliderComponent') as any;
        if (!col) return;
        // Terrain has its own dimensions sourced from TerrainComponent (width,
        // depth, heightmap resolution); the visible mesh AABB doesn't apply.
        // Compound is a placeholder shape — no single mesh AABB either.
        if (col.shapeType === 4 /* TERRAIN */ || col.shapeType === 5 /* COMPOUND */) return;
        // No author opt-out anymore. The collider IS the visible mesh AABB —
        // hand-tuning a tighter or looser collider used to be allowed via
        // `disableAutoFit`, but that escape hatch was the root cause of the
        // class of bugs where the visible model and the physics shape didn't
        // line up (player bumping into nothing, sliding through walls, etc).
        // The shape-type choice (capsule vs box) stays author-controlled for
        // gameplay reasons; the dimensions track the mesh, full stop.
        const bMin = gpuMesh.boundMin, bMax = gpuMesh.boundMax;
        const minX = bMin.x ?? -0.5, minY = bMin.y ?? 0, minZ = bMin.z ?? -0.5;
        const maxX = bMax.x ?? 0.5, maxY = bMax.y ?? 1, maxZ = bMax.z ?? 0.5;
        const width = maxX - minX, height = maxY - minY, depth = maxZ - minZ;
        const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2, centerZ = (minZ + maxZ) / 2;

        if (col.shapeType === 1 /* SPHERE */) {
            // Bounding sphere of the AABB: half the longest extent. Centered
            // on the AABB midpoint so a non-origin-pivoted mesh still has its
            // collider where the model is.
            col.radius = Math.max(0.05, Math.max(width, height, depth) / 2);
            col.center = { x: centerX, y: centerY, z: centerZ };
            const rb = entity.getComponent('RigidbodyComponent') as any;
            if (rb) rb._forceRecreate = true;
        } else if (col.shapeType === 2) {
            col.radius = Math.max(0.1, Math.min(Math.min(width, depth) / 2, height * 0.15));
            col.height = height;
            col.center = { x: centerX, y: centerY, z: centerZ };
            const rb = entity.getComponent('RigidbodyComponent') as any;
            if (rb) rb._forceRecreate = true;
        } else if (col.shapeType === 3) {
            // Trimesh: vertices encode position, no center offset.
            //
            // BUT — if the .collision.bin sidecar didn't load (missing,
            // fetch failed, or out-of-order with body creation), the
            // collider's collisionPositions/Indices stay null and
            // physics_system.ts falls back to a fixed-size 1m³ cuboid
            // (cuboid(sx*0.5, sy*0.5, sz*0.5) at line 430) — completely
            // disconnected from the visible mesh, which has been scaled
            // by the asset-normalization registry (scale_multiplier on
            // packs like ultimate_fantasy_rts is 10×). Result: a 10m
            // building with a 1m collider, units walk through walls and
            // get stuck inside spawn-overlapping structures.
            //
            // Fix: if the sidecar didn't populate the trimesh, populate it
            // from the visible mesh's own geometry (which is already at
            // the correct scaled size by the time we get here, post-load),
            // then force a body recreate so Rapier picks up the new shape.
            if (!col.collisionPositions || !col.collisionIndices) {
                const mr = entity.getComponent('MeshRendererComponent') as any;
                const md = mr?.meshData;
                if (md?.positions && md?.indices) {
                    col.collisionPositions = md.positions instanceof Float32Array
                        ? md.positions
                        : new Float32Array(md.positions);
                    col.collisionIndices = md.indices instanceof Uint32Array
                        ? md.indices
                        : new Uint32Array(md.indices);
                }
            }
            const rb = entity.getComponent('RigidbodyComponent') as any;
            if (rb) rb._forceRecreate = true;
        } else {
            col.size = { x: width, y: height, z: depth };
            col.center = { x: centerX, y: centerY, z: centerZ };
            // Without _forceRecreate, the box collider's halfExtents update
            // here but Rapier still has the old shape — bodies created
            // before GLB load stay at the 1×1×1 fallback even after
            // autoFitCollider runs. Same fix as the trimesh branch above.
            const rb = entity.getComponent('RigidbodyComponent') as any;
            if (rb) rb._forceRecreate = true;
        }
        col.markDirty();
    }

    private setupAnimatorFromGLB(entity: any, meshData: ParsedMesh, renderSystem: any): void {
        const skeleton = meshData.skeleton!;
        const clips = meshData.animationClips!;
        const animSystem = this.engine?.globalContext.animationSystem;
        if (!animSystem) return;

        let animator = entity.getComponent('AnimatorComponent') as any;
        if (!animator) {
            entity.addComponent('AnimatorComponent', {});
            animator = entity.getComponent('AnimatorComponent') as any;
            if (!animator) return;
        }

        const boneCount = skeleton.bones.length;
        animator.skeleton = skeleton;

        // Reuse the existing jointMatrices array + GPU buffer if the
        // bone count hasn't changed. WebGPU bind groups created against
        // a specific GPUBuffer reference go stale when the buffer is
        // replaced — the renderer reads `animator.gpuJointMatricesBuffer`
        // each frame, so a swap silently breaks any cached bind groups
        // that were keyed by the old buffer. Iteration-6 Play→Stop→Play
        // anim-death class: the snapshot reload empties the runtime
        // fields, the cached path of loadMeshAsset re-fires
        // setupAnimatorFromGLB which previously REPLACED the buffer
        // unconditionally — characters rendered in T-pose because the
        // renderer's bind group still pointed at the old buffer.
        if (!animator.jointMatrices || animator.jointMatrices.length !== boneCount * 16) {
            animator.jointMatrices = new Float32Array(boneCount * 16);
        }
        if (!animator.gpuJointMatricesBuffer) {
            animator.gpuJointMatricesBuffer = renderSystem.createJointMatricesBuffer(boneCount);
        }

        const clipNames: string[] = [];
        for (const clip of clips) {
            animator.loadedClips.set(clip.name, clip);
            animator.clips.set(clip.name, clip.name);
            clipNames.push(clip.name);
        }
        animator.availableClipNames = clipNames;

        for (let i = 0; i < boneCount; i++) {
            const off = i * 16;
            animator.jointMatrices[off] = 1; animator.jointMatrices[off + 5] = 1;
            animator.jointMatrices[off + 10] = 1; animator.jointMatrices[off + 15] = 1;
        }
        renderSystem.updateJointMatrices(animator.gpuJointMatricesBuffer, animator.jointMatrices);

        const idleClip = clipNames.find(n => /idle/i.test(n)) ?? clipNames[0];
        if (idleClip) animator.play(idleClip, { loop: true });
    }

    private async loadTextureBundle(mr: MeshRendererComponent, bundleRef: string, renderSystem: any): Promise<void> {
        // Direct image URL (e.g. /assets/kenney/textures/prototype_textures/Dark/texture_02.png)
        if (bundleRef.match(/\.(png|jpg|jpeg|webp)$/i)) {
            const tex = await this.loadFirstAvailableTexture([bundleRef], `albedo_${bundleRef}`, renderSystem);
            if (tex) mr.gpuBaseColorTexture = tex;
            return;
        }

        let texName: string;
        if (bundleRef.startsWith('/assets/')) {
            const parts = bundleRef.split('/');
            texName = parts[parts.length - 2] || parts[parts.length - 1].split('_diff')[0].split('_diffuse')[0];
        } else {
            texName = bundleRef;
        }

        const basePath = `/assets/poly_haven/textures/${texName}`;
        const overrides = mr.materialOverrides;

        const diffFile = overrides.texDiff;
        const norFile = overrides.texNor;
        const roughFile = overrides.texRough;

        if (diffFile) {
            const tex = await this.loadFirstAvailableTexture([`${basePath}/${diffFile}`], `albedo_${texName}`, renderSystem);
            if (tex) mr.gpuBaseColorTexture = tex;
        } else {
            const tex = await this.loadFirstAvailableTexture(
                [`${basePath}/${texName}_diff_1k.jpg`, `${basePath}/${texName}_diffuse_1k.jpg`],
                `albedo_${texName}`, renderSystem);
            if (tex) mr.gpuBaseColorTexture = tex;
        }

        if (norFile) {
            const tex = await this.loadFirstAvailableTexture([`${basePath}/${norFile}`], `normal_${texName}`, renderSystem);
            if (tex) mr.gpuNormalMapTexture = tex;
        }

        if (roughFile) {
            try {
                const resp = await fetch(`${basePath}/${roughFile}`);
                if (resp.ok) {
                    const blob = await resp.blob();
                    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
                    const canvas = new OffscreenCanvas(4, 4);
                    const ctx = canvas.getContext('2d')!;
                    ctx.drawImage(bmp, 0, 0, 4, 4);
                    const pixels = ctx.getImageData(0, 0, 4, 4).data;
                    let sum = 0;
                    for (let i = 0; i < pixels.length; i += 4) sum += pixels[i];
                    overrides.roughness = sum / (16 * 255);
                }
            } catch {}
        }
        if (overrides.roughness === undefined) overrides.roughness = 0.7;
    }

    private async loadFirstAvailableTexture(urls: string[], label: string, renderSystem: any): Promise<any> {
        for (const url of urls) {
            const cached = this.gpuTextureCache.get(url);
            if (cached) return cached;
            try {
                const resp = await fetch(url);
                if (!resp.ok) continue;
                const blob = await resp.blob();
                const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
                const gpuTex = renderSystem.uploadTexture(bmp, { label, generateMipmaps: true });
                this.gpuTextureCache.set(url, gpuTex);
                return gpuTex;
            } catch { continue; }
        }
        return null;
    }

    private async loadGLBTexture(meshData: ParsedMesh, renderSystem: any): Promise<GPUTexture | null> {
        if (meshData.atlasTextureBlobs && meshData.atlasGrid) {
            return this.buildTextureAtlas(meshData, renderSystem);
        }
        let imageBitmap: ImageBitmap | null = null;
        if (meshData.baseColorTextureUrl) {
            const resp = await fetch(meshData.baseColorTextureUrl);
            if (!resp.ok) return null;
            imageBitmap = await createImageBitmap(await resp.blob(), { colorSpaceConversion: 'none' });
        } else if (meshData.baseColorTextureBlob) {
            imageBitmap = await createImageBitmap(meshData.baseColorTextureBlob, { colorSpaceConversion: 'none' });
        }
        if (!imageBitmap) return null;
        return renderSystem.uploadTexture(imageBitmap, { label: 'glb_base_color', generateMipmaps: true });
    }

    private async buildTextureAtlas(meshData: ParsedMesh, renderSystem: any): Promise<GPUTexture | null> {
        const blobs = meshData.atlasTextureBlobs!;
        const baseColors = meshData.atlasBaseColors!;
        const { cols, rows } = meshData.atlasGrid!;
        const maxUVs = meshData.atlasMaxUVs ?? blobs.map(() => [1, 1] as [number, number]);
        return this.buildBlobAtlas(blobs, cols, rows, maxUVs, baseColors, 'glb_atlas', renderSystem);
    }

    private async loadGLBNormalMap(meshData: ParsedMesh, renderSystem: any): Promise<GPUTexture | null> {
        if (meshData.atlasNormalMapBlobs && meshData.atlasGrid) {
            const blobs = meshData.atlasNormalMapBlobs;
            if (!blobs.some(b => b !== null)) return null;
            const { cols, rows } = meshData.atlasGrid;
            const maxUVs = meshData.atlasMaxUVs ?? blobs.map(() => [1, 1] as [number, number]);
            const defaultColors = blobs.map(() => [128, 128, 255, 255] as [number, number, number, number]);
            return this.buildBlobAtlas(blobs, cols, rows, maxUVs, defaultColors, 'glb_normal_atlas', renderSystem);
        }
        if (meshData.normalMapTextureBlob) {
            const bmp = await createImageBitmap(meshData.normalMapTextureBlob, { colorSpaceConversion: 'none' });
            return renderSystem.uploadTexture(bmp, { label: 'glb_normal_map', generateMipmaps: true });
        }
        return null;
    }

    private async buildSubMeshTextures(meshData: ParsedMesh, renderSystem: any): Promise<MeshRendererComponent['gpuSubMeshes']> {
        const ranges = meshData.subMeshRanges!;
        const blobs = meshData.atlasTextureBlobs!;
        const baseColors = meshData.atlasBaseColors!;
        const normalBlobs = meshData.atlasNormalMapBlobs;
        const alphaModesArr = meshData.atlasAlphaModes;

        const slotTextures = new Map<number, GPUTexture | null>();
        const slotNormalMaps = new Map<number, GPUTexture | null>();
        const uniqueSlots = new Set(ranges.map(r => r.slot));

        for (const slot of uniqueSlots) {
            const blob = blobs[slot];
            if (blob) {
                try {
                    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
                    slotTextures.set(slot, renderSystem.uploadTexture(bmp, { label: `glb_mat_${slot}`, generateMipmaps: true }));
                } catch { slotTextures.set(slot, null); }
            } else { slotTextures.set(slot, null); }

            if (normalBlobs && normalBlobs[slot]) {
                try {
                    const bmp = await createImageBitmap(normalBlobs[slot]!, { colorSpaceConversion: 'none' });
                    slotNormalMaps.set(slot, renderSystem.uploadTexture(bmp, { label: `glb_normal_${slot}`, generateMipmaps: true }));
                } catch { slotNormalMaps.set(slot, null); }
            } else { slotNormalMaps.set(slot, null); }
        }

        const result: NonNullable<MeshRendererComponent['gpuSubMeshes']> = [];
        for (const range of ranges) {
            const bc = baseColors[range.slot] ?? [255, 255, 255, 255];
            const am = alphaModesArr?.[range.slot];
            result.push({
                firstIndex: range.firstIndex, indexCount: range.indexCount,
                gpuTexture: slotTextures.get(range.slot) ?? null,
                gpuNormalMap: slotNormalMaps.get(range.slot) ?? null,
                baseColor: [bc[0] / 255, bc[1] / 255, bc[2] / 255, bc[3] / 255],
                alphaMode: am && am !== 'OPAQUE' ? am : undefined,
            });
        }
        return result;
    }

    private async buildBlobAtlas(
        blobs: (Blob | null)[], cols: number, rows: number, maxUVs: [number, number][],
        defaultColors: ([number, number, number, number] | null)[], label: string, renderSystem: any,
    ): Promise<GPUTexture | null> {
        const images: (ImageBitmap | null)[] = [];
        for (const blob of blobs) {
            if (blob) { try { images.push(await createImageBitmap(blob, { colorSpaceConversion: 'none' })); } catch { images.push(null); } }
            else { images.push(null); }
        }

        const maxAtlasSize = 8192;
        let cellSize = 256;
        for (const img of images) { if (img) cellSize = Math.max(cellSize, img.width, img.height); }
        cellSize = Math.min(cellSize, Math.floor(maxAtlasSize / Math.max(cols, rows)));

        const atlasWidth = cols * cellSize;
        const atlasHeight = rows * cellSize;
        const canvas = new OffscreenCanvas(atlasWidth, atlasHeight);
        const ctx2d = canvas.getContext('2d')!;

        for (let i = 0; i < blobs.length; i++) {
            const col = i % cols, row = Math.floor(i / cols);
            const x = col * cellSize, y = row * cellSize;
            if (images[i]) {
                const img = images[i]!;
                const [tilesU, tilesV] = maxUVs[i];
                if (tilesU <= 1 && tilesV <= 1) {
                    ctx2d.drawImage(img, x, y, cellSize, cellSize);
                } else {
                    ctx2d.save();
                    ctx2d.beginPath(); ctx2d.rect(x, y, cellSize, cellSize); ctx2d.clip();
                    const tileW = cellSize / tilesU, tileH = cellSize / tilesV;
                    for (let ty = 0; ty < tilesV; ty++) {
                        for (let tx = 0; tx < tilesU; tx++) { ctx2d.drawImage(img, x + tx * tileW, y + ty * tileH, tileW, tileH); }
                    }
                    ctx2d.restore();
                }
            } else {
                const [r, g, b, a] = defaultColors[i] ?? [255, 255, 255, 255];
                ctx2d.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
                ctx2d.fillRect(x, y, cellSize, cellSize);
            }
        }

        const atlasBitmap = await createImageBitmap(canvas, { colorSpaceConversion: 'none' });
        return renderSystem.uploadTexture(atlasBitmap, { label, generateMipmaps: true });
    }

    private createPrimitiveMeshData(meshType: string): { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array } | null {
        switch (meshType) {
            case 'cube': case 'box': { const m = MeshData.createBox(1, 1, 1); return { positions: m.positions, normals: m.normals, uvs: m.uvs, indices: m.indices }; }
            case 'sphere': { const m = MeshData.createSphere(0.5, 32); return { positions: m.positions, normals: m.normals, uvs: m.uvs, indices: m.indices }; }
            case 'plane': { const m = MeshData.createPlane(1, 1); return { positions: m.positions, normals: m.normals, uvs: m.uvs, indices: m.indices }; }
            case 'cylinder': { const m = MeshData.createCylinder(0.5, 0.5, 1, 32); return { positions: m.positions, normals: m.normals, uvs: m.uvs, indices: m.indices }; }
            case 'cone': { const m = MeshData.createCylinder(0, 0.5, 1, 32); return { positions: m.positions, normals: m.normals, uvs: m.uvs, indices: m.indices }; }
            case 'capsule': { const m = MeshData.createCapsule(0.5, 2, 32); return { positions: m.positions, normals: m.normals, uvs: m.uvs, indices: m.indices }; }
            default: return null;
        }
    }

    // ── Focus ──

    focusEntity(entityId: number): void { this.emit('focusEntity', entityId); }
    openScript(scriptPath: string): void { this.emit('openScript', scriptPath); }

    // ── Lock / Visibility ──

    toggleLock(entityId: number): void {
        if (this.state.lockedEntities.has(entityId)) { this.state.lockedEntities.delete(entityId); }
        else { this.state.lockedEntities.add(entityId); }
        this.emit('sceneChanged');
    }

    toggleVisibility(entityId: number): void {
        if (this.state.hiddenEntities.has(entityId)) { this.state.hiddenEntities.delete(entityId); }
        else { this.state.hiddenEntities.add(entityId); }
        this.emit('sceneChanged');
    }

    restoreCollisionMeshVisibility(): void {
        this.state.showCollisionMesh = false;
        const scene = this.getActiveScene();
        if (!scene) return;
        for (const id of this.state.collisionMeshHiddenEntities) {
            const entity = scene.entities.get(id);
            if (!entity) continue;
            const mr = entity.getComponent('MeshRendererComponent') as any;
            const orig = this.state.collisionMeshOriginals.get(id);
            if (mr && orig) {
                mr.gpuMesh = orig.gpuMesh;
                mr.gpuBaseColorTexture = orig.baseColorTexture;
                mr.gpuNormalMapTexture = orig.normalMapTexture;
                mr.gpuSubMeshes = orig.gpuSubMeshes;
                mr.materialOverrides = orig.materialOverrides;
            }
        }
        this.state.collisionMeshHiddenEntities.clear();
        this.state.collisionMeshOriginals.clear();
    }

    async loadCachedMeshColliders(): Promise<void> {
        const scene = this.getActiveScene();
        if (!scene) return;
        const fetches: Promise<void>[] = [];
        for (const entity of scene.entities.values()) {
            const collider = entity.getComponent('ColliderComponent') as any;
            if (!collider || collider.shapeType !== 3) continue;
            if (collider.collisionPositions) continue;
            const mr = entity.getComponent('MeshRendererComponent') as MeshRendererComponent | null;
            if (!mr || !mr.meshAsset) continue;
            const binUrl = mr.meshAsset.replace(/\.glb$/i, '.collision.bin');
            fetches.push(
                fetch(binUrl).then(resp => {
                    if (!resp.ok) throw new Error(`${resp.status}`);
                    return resp.arrayBuffer();
                }).then(async buf => {
                    if (buf.byteLength < 16) return;
                    const view = new DataView(buf);
                    if (view.getUint32(0, true) !== 0x434F4C4C) return;
                    const posCount = view.getUint32(8, true);
                    const idxCount = view.getUint32(12, true);
                    if (buf.byteLength < 16 + posCount * 4 + idxCount * 4) return;
                    // .collision.bin is baked from RAW geometry. When the project opts into
                    // the asset-normalization registry, transform the collision positions in
                    // place to match the visible mesh. (No-op for legacy projects.)
                    const positions = new Float32Array(buf.slice(16, 16 + posCount * 4));
                    await applyFacingTransformToPositions(positions, mr.meshAsset);
                    collider.collisionPositions = positions;
                    collider.collisionIndices = new Uint32Array(buf, 16 + posCount * 4, idxCount);
                }).catch(() => {
                    console.warn(`[MeshCollider] No collision sidecar for "${entity.name}" (${binUrl})`);
                })
            );
        }
        await Promise.all(fetches);
    }
}
