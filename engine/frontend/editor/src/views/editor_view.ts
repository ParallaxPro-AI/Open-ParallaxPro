import { EditorContext } from '../editor_context.js';
import { ParallaxEditor } from '../editor.js';
import { EditorLayout } from './editor_layout.js';
import { Toolbar } from '../toolbar/toolbar.js';
import { SceneHierarchyPanel } from '../panels/scene_hierarchy_panel.js';
import { ObjectPropertiesPanel } from '../panels/object_properties_panel.js';
import { ViewportPanel } from '../panels/viewport_panel.js';
import { AssetsPanel } from '../panels/assets_panel.js';
import { AiChatPanel } from '../panels/ai_chat_panel.js';
import { ShortcutManager } from '../input/shortcut_manager.js';

export class EditorView {
    readonly el: HTMLElement;
    private ctx: EditorContext;
    private editor: ParallaxEditor;
    private toolbar: Toolbar;
    private layout: EditorLayout;
    private hierarchy: SceneHierarchyPanel;
    private properties: ObjectPropertiesPanel;
    private viewport: ViewportPanel;
    private assets: AssetsPanel;
    private chat: AiChatPanel;
    private shortcuts: ShortcutManager;
    private beforeUnloadHandler: (e: BeforeUnloadEvent) => void;

    private connectionBanner: HTMLElement;
    private disconnectOverlay: HTMLElement;
    private disconnectOverlayTimer: number = 0;

    constructor() {
        this.ctx = EditorContext.instance;
        this.editor = new ParallaxEditor();

        this.el = document.createElement('div');
        this.el.className = 'editor-root';

        this.toolbar = new Toolbar();
        this.el.appendChild(this.toolbar.el);

        this.connectionBanner = document.createElement('div');
        this.connectionBanner.className = 'connection-banner';
        this.connectionBanner.style.display = 'none';
        this.el.appendChild(this.connectionBanner);

        this.layout = new EditorLayout();

        this.hierarchy = new SceneHierarchyPanel();
        this.properties = new ObjectPropertiesPanel();
        this.viewport = new ViewportPanel();
        this.assets = new AssetsPanel();
        this.chat = new AiChatPanel();

        this.layout.leftTop.appendChild(this.hierarchy.el);
        this.layout.leftBottom.appendChild(this.properties.el);
        this.layout.centerTop.appendChild(this.viewport.el);
        this.layout.centerBottom.appendChild(this.assets.el);
        this.layout.rightColumn.appendChild(this.chat.el);

        this.el.appendChild(this.layout.el);

        this.disconnectOverlay = document.createElement('div');
        this.disconnectOverlay.className = 'disconnect-overlay';
        this.disconnectOverlay.style.display = 'none';
        this.disconnectOverlay.innerHTML = '<div class="disconnect-overlay-msg">Editing disabled while reconnecting...</div>';
        this.layout.el.style.position = 'relative';
        this.layout.el.appendChild(this.disconnectOverlay);

        this.shortcuts = new ShortcutManager();

        this.ctx.undoManager.onChange(() => {
            this.ctx.emit('historyChanged');
        });

        this.beforeUnloadHandler = (e: BeforeUnloadEvent) => {
            if (this.ctx.state.projectDirty) {
                e.preventDefault();
            }
        };
        window.addEventListener('beforeunload', this.beforeUnloadHandler);
    }

    async initialize(projectId: string): Promise<void> {
        let projectData: any = null;
        try {
            projectData = await this.ctx.backend.loadProject(projectId);
        } catch (e) {
            console.warn('Failed to load project:', e);
            const base = window.location.pathname.replace(/\?.*/, '');
            window.location.href = base;
            return;
        }
        this.ctx.state.projectId = projectId;
        this.ctx.state.projectData = projectData;

        this.toolbar.setProjectName(projectData?.name ?? 'Untitled Project');

        await this.editor.initialize(this.viewport.getCanvas(), projectData);

        this.ctx.backend.onWsMessage('connected', (data: any) => {
            this.ctx.collabClientId = data.clientId ?? '';
            this.ctx.collabDisplayName = data.displayName ?? '';
            this.ctx.collabColor = data.color ?? '';

            if (data.projectUpdatedAt && this.ctx.state.projectData) {
                const serverTime = new Date(data.projectUpdatedAt + 'Z').getTime();
                const localTime = this.ctx.state.projectData._lastLoadedAt || 0;
                if (serverTime > localTime) {
                    this.recoverStateAfterReconnect(projectId);
                }
            }
            if (this.ctx.state.projectData) {
                this.ctx.state.projectData._lastLoadedAt = Date.now();
            }
        });

        this.ctx.backend.onWsMessage('project_renamed', (data: any) => {
            if (!data?.name || !this.ctx.state.projectData) return;
            if (data.projectId && data.projectId !== this.ctx.state.projectId) return;
            this.ctx.state.projectData.name = data.name;
            this.toolbar.setProjectName(data.name);
        });

        this.ctx.backend.onWsMessage('project_freshness', (data: any) => {
            if (!data.updatedAt || !this.ctx.state.projectData) return;
            const serverTime = new Date(data.updatedAt.includes('T') ? data.updatedAt : data.updatedAt + 'Z').getTime();
            const localTime = this.ctx.state.projectData._lastLoadedAt || 0;
            if (serverTime > localTime && localTime > 0) {
                this.ctx.state.projectData._lastLoadedAt = Date.now();
                this.recoverStateAfterReconnect(projectId);
            }
        });

        this.ctx.backend.onWsMessage('__ws_disconnected', () => {
            this.connectionBanner.textContent = 'Connection lost. Reconnecting...';
            this.connectionBanner.className = 'connection-banner warning';
            this.connectionBanner.style.display = '';

            this.disconnectOverlayTimer = window.setTimeout(() => {
                this.disconnectOverlay.style.display = 'flex';
                this.connectionBanner.textContent = 'Connection lost — editing disabled until reconnection';
                this.connectionBanner.className = 'connection-banner error';
            }, 5000);
        });

        this.ctx.backend.onWsMessage('__ws_reconnecting', (data: any) => {
            const { attempt, maxAttempts } = data;
            if (this.connectionBanner.style.display !== 'none') {
                const isDisabled = this.disconnectOverlay.style.display !== 'none';
                if (isDisabled) {
                    this.connectionBanner.textContent = `Reconnecting... (attempt ${attempt}/${maxAttempts})`;
                } else {
                    this.connectionBanner.textContent = `Connection lost. Reconnecting... (attempt ${attempt}/${maxAttempts})`;
                }
            }
        });

        this.ctx.backend.onWsMessage('__ws_reconnected', () => {
            clearTimeout(this.disconnectOverlayTimer);
            this.disconnectOverlayTimer = 0;
            this.disconnectOverlay.style.display = 'none';

            this.connectionBanner.textContent = 'Reconnected';
            this.connectionBanner.className = 'connection-banner success';
            this.connectionBanner.style.display = '';
            setTimeout(() => {
                if (this.connectionBanner.textContent === 'Reconnected') {
                    this.connectionBanner.style.display = 'none';
                }
            }, 3000);

            this.recoverStateAfterReconnect(projectId);
        });

        this.ctx.backend.onWsMessage('__ws_reconnect_failed', () => {
            console.error('[EditorView] All reconnect attempts failed');
            this.connectionBanner.textContent = 'Unable to reconnect. Please check your connection and refresh the page.';
            this.connectionBanner.className = 'connection-banner error';
            this.disconnectOverlay.style.display = 'flex';
            const msg = this.disconnectOverlay.querySelector('.disconnect-overlay-msg');
            if (msg) msg.textContent = 'Connection lost. Please refresh the page to continue editing.';
        });

        this.ctx.backend.onWsMessage('collab_presence', (data: any) => {
            this.ctx.emit('collabPresenceChanged', data.users ?? []);
        });
        this.ctx.backend.onWsMessage('collab_user_joined', (data: any) => {
            this.ctx.emit('collabUserJoined', data);
        });
        this.ctx.backend.onWsMessage('collab_user_left', (data: any) => {
            this.ctx.emit('collabUserLeft', data);
        });

        this.ctx.backend.onWsMessage('collab_scene_sync', async (data: any) => {
            const scenes = data.scenes as Record<string, any> | undefined;
            if (!scenes || typeof scenes !== 'object') return;

            if (!this.ctx.state.projectData) this.ctx.state.projectData = {};
            this.ctx.state.projectData.scenes = { ...scenes };

            if (this.ctx.state.isPlaying) {
                const activeKey = this.ctx.state.activeScenePath || 'scenes/main.scene.json';
                if (scenes[activeKey]) {
                    this.ctx.state.prePlaySceneSnapshot = scenes[activeKey];
                }
                return;
            }

            const activeKey = this.ctx.state.activeScenePath || 'scenes/main.scene.json';
            let activeSceneData = scenes[activeKey];

            if (!activeSceneData) {
                const keys = Object.keys(scenes);
                if (keys.length > 0) {
                    this.ctx.state.activeScenePath = keys[0];
                    activeSceneData = scenes[keys[0]];
                } else {
                    return;
                }
            }

            const incomingJSON = JSON.stringify(activeSceneData);
            if (incomingJSON === this.ctx._lastCollabSceneJSON) {
                this.ctx.emit('sceneChanged');
                return;
            }
            this.ctx._lastCollabSceneJSON = incomingJSON;

            this.ctx._isApplyingRemoteChange = true;
            try {
                const selectedNames: string[] = [];
                const currentScene = this.ctx.getActiveScene();
                if (currentScene) {
                    for (const id of this.ctx.state.selectedEntityIds) {
                        const e = currentScene.getEntity(id);
                        if (e) selectedNames.push(e.name);
                    }
                }

                await this.ctx.loadSceneFromData(activeSceneData);
                this.ctx.ensurePrimitiveMeshes();
                this.ctx.undoManager.clear();

                if (selectedNames.length > 0) {
                    const newScene = this.ctx.getActiveScene();
                    if (newScene) {
                        const newIds: number[] = [];
                        for (const entity of newScene.entities.values()) {
                            if (selectedNames.includes(entity.name)) {
                                newIds.push(entity.id);
                            }
                        }
                        if (newIds.length > 0) {
                            this.ctx.setSelection(newIds);
                        }
                    }
                }

                this.ctx.emit('sceneChanged');
            } finally {
                this.ctx._isApplyingRemoteChange = false;
            }
        });

        this.ctx.backend.onWsMessage('collab_chat_message', (data: any) => {
            this.ctx.emit('collabChatMessage', data);
        });

        this.ctx.backend.onWsMessage('project_reload', async (data: any) => {
            if (data.sceneData) {
                this.ctx._isApplyingRemoteChange = true;
                try {
                    if (!this.ctx.state.projectData) this.ctx.state.projectData = {};
                    if (!this.ctx.state.projectData.scenes) this.ctx.state.projectData.scenes = {};
                    const sceneKey = data.sceneKey || Object.keys(this.ctx.state.projectData.scenes)[0] || 'main.json';
                    this.ctx.state.projectData.scenes[sceneKey] = data.sceneData;
                    if (data.scripts) this.ctx.state.projectData.scripts = data.scripts;
                    if (data.uiFiles) this.ctx.state.projectData.uiFiles = data.uiFiles;

                    await this.ctx.loadSceneFromData(data.sceneData);
                    this.ctx.ensurePrimitiveMeshes();
                    this.ctx.emit('sceneChanged');
                    if (this.ctx.state.projectData) this.ctx.state.projectData._lastLoadedAt = Date.now();
                } finally {
                    this.ctx._isApplyingRemoteChange = false;
                }
            }
        });

        this.ctx.backend.onWsMessage('scene_reload', async (data: any) => {
            if (data.sceneData) {
                this.ctx._isApplyingRemoteChange = true;
                try {
                    if (!this.ctx.state.projectData) this.ctx.state.projectData = {};
                    if (!this.ctx.state.projectData.scenes) this.ctx.state.projectData.scenes = {};
                    const sceneKey = data.sceneKey || Object.keys(this.ctx.state.projectData.scenes)[0] || 'main.json';
                    this.ctx.state.projectData.scenes[sceneKey] = data.sceneData;

                    await this.ctx.loadSceneFromData(data.sceneData);
                    this.ctx.ensurePrimitiveMeshes();
                    this.ctx.emit('sceneChanged');
                    if (this.ctx.state.projectData) this.ctx.state.projectData._lastLoadedAt = Date.now();
                    this.ctx.backend.sendWsMessage('scene_reload_complete', {});
                } finally {
                    this.ctx._isApplyingRemoteChange = false;
                }
            }
        });

        this.ctx.backend.onWsMessage('scene_added', (data: any) => {
            if (data.sceneName && data.sceneKey && data.sceneData) {
                if (!this.ctx.state.projectData) this.ctx.state.projectData = {};
                if (!this.ctx.state.projectData.scenes) this.ctx.state.projectData.scenes = {};
                this.ctx.state.projectData.scenes[data.sceneKey] = data.sceneData;
                this.ctx.emit('sceneChanged');
            }
        });

        this.ctx.backend.onWsMessage('script_written', (data: any) => {
            if (data.path && data.content) {
                if (!this.ctx.state.projectData) this.ctx.state.projectData = {};
                if (!this.ctx.state.projectData.scripts) this.ctx.state.projectData.scripts = {};
                this.ctx.state.projectData.scripts[data.path] = data.content;
            }
        });

        this.ctx.backend.onWsMessage('ui_written', (data: any) => {
            if (data.path && data.content) {
                if (!this.ctx.state.projectData) this.ctx.state.projectData = {};
                if (!this.ctx.state.projectData.uiFiles) this.ctx.state.projectData.uiFiles = {};
                this.ctx.state.projectData.uiFiles[data.path] = data.content;
            }
        });

        this.ctx.backend.onWsMessage('script_attached', (data: any) => {
            if (!data.entity || !data.scriptPath) return;
            const scene = this.ctx.getActiveScene();
            if (!scene) return;
            for (const entity of scene.entities.values()) {
                if (entity.name === data.entity) {
                    const sc = entity.getComponent('ScriptComponent') as any;
                    if (sc) {
                        if (sc.scriptURL !== data.scriptPath) {
                            const existing = sc.additionalScripts?.find?.(
                                (a: any) => a.scriptURL === data.scriptPath
                            );
                            if (!existing) {
                                if (!sc.additionalScripts) sc.additionalScripts = [];
                                sc.additionalScripts.push({ scriptURL: data.scriptPath });
                            }
                        }
                    } else {
                        entity.addComponent('ScriptComponent', { scriptURL: data.scriptPath });
                    }
                    break;
                }
            }
        });

        this.ctx.backend.connectWebSocket(projectId);

        this.ctx.startAutosave(30000);

        const savedQuality = (localStorage.getItem('graphics_quality') as 'low' | 'medium' | 'high') ?? 'medium';
        this.ctx.setGraphicsQuality(savedQuality);

        this.ctx.emit('projectLoaded');
        this.ctx.emit('sceneChanged');

        this.maybeShowPromoteToCloudPrompt();
        this.maybeShowCloudSignedOutBanner();
        this.maybeFlushPendingCloudPush();
    }

    /**
     * If this cloud project has local saves newer than our last known
     * server state, push them immediately on open rather than waiting
     * for the next explicit save. Covers the "edited offline last
     * session, now online" case so users see ✓ Synced instead of
     * ↑ Unsynced without having to touch the file.
     */
    private maybeFlushPendingCloudPush(): void {
        const pd: any = this.ctx.state.projectData;
        if (!pd?.isCloud) return;
        if (!this.ctx.backend.isSelfHosted) return;
        if (!this.ctx.cloudSync.currentUserId()) return;
        const localT = Date.parse(pd.updatedAt || 0);
        const lastSync = Date.parse(pd.cloudPulledUpdatedAt || 0);
        if (localT > lastSync && this.ctx.state.projectId) {
            this.ctx.cloudSync.schedulePush(this.ctx.state.projectId);
        }
    }

    /**
     * When a user opens a cloud project on self-hosted while logged out,
     * saves keep working locally but don't push to parallaxpro.ai. Surface
     * it as a bottom-right toast (same form factor as the promote toast)
     * — dismissable per-project-per-session, with a Sign in button that
     * resumes sync and flushes anything edited offline.
     */
    private maybeShowCloudSignedOutBanner(): void {
        const projectId = this.ctx.state.projectId;
        const pd: any = this.ctx.state.projectData;
        if (!projectId || !pd?.isCloud) return;
        if (!this.ctx.backend.isSelfHosted) return;
        if (this.ctx.cloudSync.currentUserId()) return;
        const dismissKey = `pp_signedout_dismissed:${projectId}`;
        try { if (sessionStorage.getItem(dismissKey)) return; } catch {}

        const toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;right:18px;bottom:18px;max-width:340px;background:linear-gradient(135deg,rgba(154,99,0,0.96),rgba(234,170,70,0.96));color:#fff;padding:14px 16px;border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,0.35);z-index:200;display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.45;animation:ppCloudPromoteSlideIn 0.25s ease-out;';

        if (!document.getElementById('pp-cloud-promote-style')) {
            const style = document.createElement('style');
            style.id = 'pp-cloud-promote-style';
            style.textContent = '@keyframes ppCloudPromoteSlideIn { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }';
            document.head.appendChild(style);
        }

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:flex-start;gap:10px;';
        const text = document.createElement('div');
        text.style.flex = '1';
        text.innerHTML = 'Editing a cloud project while signed out — changes save locally but <strong>won\'t sync to parallaxpro.ai</strong> until you sign in.';
        header.appendChild(text);

        const dismissBtn = document.createElement('button');
        dismissBtn.textContent = '×';
        dismissBtn.title = 'Dismiss for this session';
        dismissBtn.style.cssText = 'padding:0 6px;background:transparent;border:0;color:rgba(255,255,255,0.85);font-size:20px;cursor:pointer;line-height:1;';
        dismissBtn.addEventListener('click', () => {
            try { sessionStorage.setItem(dismissKey, '1'); } catch {}
            toast.remove();
        });
        header.appendChild(dismissBtn);
        toast.appendChild(header);

        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:11.5px;color:rgba(255,255,255,0.9);';
        hint.textContent = 'You can sign in any time from the Settings panel in the toolbar.';
        toast.appendChild(hint);

        const signInBtn = document.createElement('button');
        signInBtn.textContent = 'Sign in';
        signInBtn.style.cssText = 'align-self:flex-start;padding:6px 16px;background:#fff;color:#6b4300;border:0;border-radius:6px;font-size:12.5px;font-weight:700;cursor:pointer;';
        signInBtn.addEventListener('click', async () => {
            signInBtn.disabled = true;
            signInBtn.textContent = 'Signing in…';
            try {
                const { ensureLoggedIn } = await import('../backend/auth_session.js');
                await ensureLoggedIn();
                toast.remove();
                // Push whatever the user has edited since opening so their
                // offline work reaches prod immediately.
                if (this.ctx.state.projectId) this.ctx.cloudSync.schedulePush(this.ctx.state.projectId);
            } catch (e: any) {
                signInBtn.disabled = false;
                signInBtn.textContent = 'Sign in';
                console.warn('[auth] sign-in cancelled:', e?.message ?? e);
            }
        });
        toast.appendChild(signInBtn);

        document.body.appendChild(toast);
    }

    /**
     * On self-hosted editors, when the user is signed in to parallaxpro.ai
     * and the current project isn't cloud-synced, float a non-intrusive
     * toast in the bottom-right corner offering to promote it. Dismissing
     * ('×') is sticky per-project — we never ask again for that project.
     * The Settings modal exposes the same action for users who dismissed
     * and changed their mind.
     */
    private maybeShowPromoteToCloudPrompt(): void {
        const projectId = this.ctx.state.projectId;
        const pd: any = this.ctx.state.projectData;
        if (!projectId || !pd) return;
        if (pd.isCloud) return;
        if (!this.ctx.backend.isSelfHosted) return;
        if (!this.ctx.cloudSync.currentUserId()) return;
        const dismissKey = `pp_promote_dismissed:${projectId}`;
        if (localStorage.getItem(dismissKey)) return;

        const toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;right:18px;bottom:18px;max-width:340px;background:linear-gradient(135deg,rgba(134,72,230,0.96),rgba(105,187,243,0.96));color:#fff;padding:14px 16px;border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,0.35);z-index:200;display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.45;animation:ppCloudPromoteSlideIn 0.25s ease-out;';

        // Inject the entrance keyframe once so multiple toasts don't
        // duplicate the style node.
        if (!document.getElementById('pp-cloud-promote-style')) {
            const style = document.createElement('style');
            style.id = 'pp-cloud-promote-style';
            style.textContent = '@keyframes ppCloudPromoteSlideIn { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }';
            document.head.appendChild(style);
        }

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:flex-start;gap:10px;';
        const text = document.createElement('div');
        text.style.flex = '1';
        text.innerHTML = 'Sync this project to <strong>parallaxpro.ai</strong> so you can pick up where you left off from any computer.';
        header.appendChild(text);

        const dismissBtn = document.createElement('button');
        dismissBtn.textContent = '×';
        dismissBtn.title = "Don't ask again for this project";
        dismissBtn.style.cssText = 'padding:0 6px;background:transparent;border:0;color:rgba(255,255,255,0.8);font-size:20px;cursor:pointer;line-height:1;';
        dismissBtn.addEventListener('click', () => {
            try { localStorage.setItem(dismissKey, '1'); } catch {}
            toast.remove();
        });
        header.appendChild(dismissBtn);
        toast.appendChild(header);

        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:11.5px;color:rgba(255,255,255,0.85);';
        hint.textContent = 'You can do this any time from the Settings panel in the toolbar.';
        toast.appendChild(hint);

        const promoteBtn = document.createElement('button');
        promoteBtn.textContent = 'Promote to Cloud';
        promoteBtn.style.cssText = 'align-self:flex-start;padding:6px 16px;background:#fff;color:#5a2cba;border:0;border-radius:6px;font-size:12.5px;font-weight:700;cursor:pointer;';
        promoteBtn.addEventListener('click', async () => {
            promoteBtn.disabled = true;
            promoteBtn.textContent = 'Syncing…';
            const result = await this.ctx.promoteCurrentProjectToCloud();
            if (result.ok) {
                toast.remove();
            } else {
                promoteBtn.disabled = false;
                promoteBtn.textContent = 'Promote to Cloud';
                alert(result.reason);
            }
        });
        toast.appendChild(promoteBtn);

        document.body.appendChild(toast);
    }

    private async recoverStateAfterReconnect(projectId: string): Promise<void> {
        try {
            const latestProject = await this.ctx.backend.loadProject(projectId);
            if (!latestProject) return;

            if (latestProject.scripts) {
                if (!this.ctx.state.projectData) this.ctx.state.projectData = {};
                this.ctx.state.projectData.scripts = latestProject.scripts;
            }

            if (latestProject.scenes) {
                if (!this.ctx.state.projectData) this.ctx.state.projectData = {};
                this.ctx.state.projectData.scenes = latestProject.scenes;

                const activeKey = this.ctx.state.activeScenePath || 'scenes/main.scene.json';
                const latestScene = latestProject.scenes[activeKey];
                if (latestScene) {
                    const latestJSON = JSON.stringify(latestScene);
                    if (latestJSON !== this.ctx._lastCollabSceneJSON) {
                        this.ctx._isApplyingRemoteChange = true;
                        try {
                            await this.ctx.loadSceneFromData(latestScene);
                            this.ctx.ensurePrimitiveMeshes();
                            this.ctx._lastCollabSceneJSON = latestJSON;
                            this.ctx.emit('sceneChanged');
                        } finally {
                            this.ctx._isApplyingRemoteChange = false;
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[Reconnect] Failed to recover state:', e);
        }
    }

    destroy(): void {
        clearTimeout(this.disconnectOverlayTimer);
        window.removeEventListener('beforeunload', this.beforeUnloadHandler);
        this.ctx.stopAutosave();
        this.ctx.backend.disconnectWebSocket();
        this.editor.shutdown();
        this.shortcuts.destroy();
    }

    sendInitialChatMessage(prompt: string): void {
        this.chat.sendInitialMessage(prompt);
    }
}
