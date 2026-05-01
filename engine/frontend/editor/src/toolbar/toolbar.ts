import { EditorContext } from '../editor_context.js';
import { showModal, showPromptModal, showConfirmModal } from '../widgets/modal.js';
import { icon, Save, Undo2, Redo2, Move, RotateCw, Maximize2, Play, Square, Settings, MousePointer2, Crosshair, Globe, Box, Sparkles } from '../widgets/icons.js';
import { PublishFlow } from '../widgets/publish_flow.js';
import { formatServerTime } from '../utils/format_time.js';
import { isMobile } from '../utils/mobile.js';
import { t } from '../i18n/index.js';

interface CollabUser {
    clientId: string;
    displayName: string;
    color: string;
}

interface CollabChatMsg {
    sender: string;
    color: string;
    text: string;
    timestamp: number;
    isLocal?: boolean;
}

export class Toolbar {
    readonly el: HTMLElement;
    private ctx: EditorContext;

    private projectNameEl!: HTMLElement;
    private syncStatusEl!: HTMLElement;
    private saveBtn!: HTMLElement;
    private undoBtn!: HTMLElement;
    private redoBtn!: HTMLElement;
    private translateBtn!: HTMLElement;
    private rotateBtn!: HTMLElement;
    private scaleBtn!: HTMLElement;
    private cameraModeBtn!: HTMLElement;
    private gizmoSpaceBtn!: HTMLElement;
    private playBtn!: HTMLElement;
    private stopBtn!: HTMLElement;
    private previewClientBtn!: HTMLButtonElement;
    /**
     * Mobile-landscape only. Replaces the floating chat-toggle FAB in the
     * bottom-right of the viewport. Wired up by editor_view via
     * bindMobileChat() once the MobileEditorLayout exists.
     */
    private aiChatBtn: HTMLElement | null = null;
    private mpBtn!: HTMLElement;
    private mpDropdown!: HTMLElement;
    private mpLinkText!: HTMLElement;
    private mpPlayerCount!: HTMLElement;

    private presenceContainer!: HTMLElement;
    private collabChatBtn!: HTMLElement;
    private collabChatPanel!: HTMLElement;
    private collabChatMessages!: HTMLElement;
    private collabChatInput!: HTMLInputElement;
    private collabUsers: CollabUser[] = [];
    private collabMessages: CollabChatMsg[] = [];
    private collabChatVisible: boolean = false;
    private unreadCount: number = 0;
    private unreadBadge!: HTMLElement;

    private overflowMenu: HTMLElement | null = null;
    private overflowBtn: HTMLElement | null = null;

    constructor() {
        this.ctx = EditorContext.instance;
        this.el = document.createElement('div');
        this.el.className = 'toolbar';

        if (isMobile()) {
            this.buildMobile();
        } else {
            this.build();
        }
        this.bindEvents();

        document.addEventListener('mousedown', (e) => {
            if (this.collabChatVisible &&
                !this.collabChatPanel.contains(e.target as Node) &&
                !this.collabChatBtn.contains(e.target as Node)) {
                this.collabChatVisible = false;
                this.collabChatPanel.style.display = 'none';
                this.collabChatBtn.classList.remove('active');
            }
            if (this.overflowMenu && !this.overflowMenu.contains(e.target as Node) &&
                this.overflowBtn && !this.overflowBtn.contains(e.target as Node)) {
                this.overflowMenu.classList.remove('open');
            }
        });

        document.addEventListener('touchstart', (e) => {
            if (this.overflowMenu && !this.overflowMenu.contains(e.target as Node) &&
                this.overflowBtn && !this.overflowBtn.contains(e.target as Node)) {
                this.overflowMenu.classList.remove('open');
            }
        });
    }

    private build(): void {
        const logo = document.createElement('img');
        logo.className = 'toolbar-logo';
        logo.src = `${import.meta.env.BASE_URL}logos/main_logo_horizontal.png`;
        logo.alt = 'ParallaxPro';
        logo.title = t('toolbar.backToProjects');
        logo.style.cursor = 'pointer';
        logo.addEventListener('click', () => {
            if (this.ctx.state.projectDirty) {
                if (!confirm(t('toolbar.unsavedConfirm'))) return;
            }
            const url = new URL(window.location.href);
            url.searchParams.delete('project');
            window.location.href = url.toString();
        });
        this.el.appendChild(logo);

        this.addSeparator();

        this.projectNameEl = document.createElement('span');
        this.projectNameEl.className = 'toolbar-project-name';
        this.projectNameEl.textContent = t('toolbar.untitled');
        this.projectNameEl.title = t('toolbar.renameTooltip');
        this.projectNameEl.style.cursor = 'pointer';
        this.projectNameEl.addEventListener('click', () => this.startRenameProject());
        this.el.appendChild(this.projectNameEl);

        // Cloud sync status pill — only visible when the open project
        // is a cloud project. Drives off cloudSync events.
        this.syncStatusEl = document.createElement('span');
        this.syncStatusEl.style.cssText = 'display:none;margin-left:8px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:3px;';
        this.el.appendChild(this.syncStatusEl);
        this.wireSyncStatus();

        this.addSeparator();

        const fileGroup = this.createGroup();
        this.saveBtn = this.createIconButton(Save, t('settings.save'), 'toolbar-btn disabled', () => this.ctx.saveProject());
        this.saveBtn.title = t('toolbar.save');
        fileGroup.appendChild(this.saveBtn);

        this.undoBtn = this.createIconButton(Undo2, '', 'toolbar-btn disabled', () => {
            this.ctx.undoManager.undo();
            this.ctx.emit('historyChanged');
            this.ctx.emit('sceneChanged');
            this.ctx.ensurePrimitiveMeshes();
        });
        this.undoBtn.title = t('toolbar.undo');
        fileGroup.appendChild(this.undoBtn);

        this.redoBtn = this.createIconButton(Redo2, '', 'toolbar-btn disabled', () => {
            this.ctx.undoManager.redo();
            this.ctx.emit('historyChanged');
            this.ctx.emit('sceneChanged');
            this.ctx.ensurePrimitiveMeshes();
        });
        this.redoBtn.title = t('toolbar.redo');
        fileGroup.appendChild(this.redoBtn);

        this.el.appendChild(fileGroup);
        this.addSeparator();

        const transformGroup = this.createGroup();
        this.translateBtn = this.createIconButton(Move, t('toolbar.moveLabel'), 'toolbar-btn active', () => this.ctx.setGizmoMode('translate'));
        this.translateBtn.title = t('toolbar.translate');
        transformGroup.appendChild(this.translateBtn);

        this.rotateBtn = this.createIconButton(RotateCw, t('toolbar.rotateLabel'), 'toolbar-btn', () => this.ctx.setGizmoMode('rotate'));
        this.rotateBtn.title = t('toolbar.rotate');
        transformGroup.appendChild(this.rotateBtn);

        this.scaleBtn = this.createIconButton(Maximize2, t('toolbar.scaleLabel'), 'toolbar-btn', () => this.ctx.setGizmoMode('scale'));
        this.scaleBtn.title = t('toolbar.scale');
        transformGroup.appendChild(this.scaleBtn);

        this.el.appendChild(transformGroup);
        this.addSeparator();

        const cameraGroup = this.createGroup();
        this.cameraModeBtn = this.createIconButton(MousePointer2, t('toolbar.orbitLabel'), 'toolbar-btn', () => this.ctx.toggleCameraMode());
        this.cameraModeBtn.title = t('toolbar.cameraMode');
        cameraGroup.appendChild(this.cameraModeBtn);

        this.gizmoSpaceBtn = this.createIconButton(Globe, t('toolbar.globalLabel'), 'toolbar-btn', () => this.ctx.toggleGizmoSpace());
        this.gizmoSpaceBtn.title = t('toolbar.gizmoSpace');
        cameraGroup.appendChild(this.gizmoSpaceBtn);

        this.el.appendChild(cameraGroup);

        const spacer = document.createElement('div');
        spacer.className = 'toolbar-spacer';
        this.el.appendChild(spacer);

        this.presenceContainer = document.createElement('div');
        this.presenceContainer.className = 'collab-presence';
        this.el.appendChild(this.presenceContainer);

        this.collabChatBtn = document.createElement('button');
        this.collabChatBtn.className = 'toolbar-btn collab-chat-btn';
        this.collabChatBtn.title = t('toolbar.teamChat');
        this.collabChatBtn.style.display = 'none';
        this.collabChatBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
        this.unreadBadge = document.createElement('span');
        this.unreadBadge.className = 'collab-unread-badge';
        this.unreadBadge.style.display = 'none';
        this.collabChatBtn.appendChild(this.unreadBadge);
        this.collabChatBtn.addEventListener('click', () => this.toggleCollabChat());
        this.el.appendChild(this.collabChatBtn);

        this.collabChatPanel = document.createElement('div');
        this.collabChatPanel.className = 'collab-chat-panel';
        this.collabChatPanel.style.display = 'none';
        this.collabChatPanel.innerHTML = `
            <div class="collab-chat-header">${t('toolbar.teamChat')}</div>
            <div class="collab-chat-messages"></div>
            <div class="collab-chat-input-row">
                <input type="text" class="collab-chat-input" placeholder="${t('toolbar.teamChatPlaceholder')}" />
            </div>
        `;
        document.body.appendChild(this.collabChatPanel);
        this.collabChatMessages = this.collabChatPanel.querySelector('.collab-chat-messages')!;
        this.collabChatInput = this.collabChatPanel.querySelector('.collab-chat-input')! as HTMLInputElement;
        this.collabChatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && this.collabChatInput.value.trim()) {
                const text = this.collabChatInput.value.trim();
                this.collabChatInput.value = '';
                this.ctx.backend.sendCollabChat(text);
                this.addCollabChatMessage({
                    sender: this.ctx.collabDisplayName || 'You',
                    color: this.ctx.collabColor || '#8648e6',
                    text,
                    timestamp: Date.now(),
                    isLocal: true,
                });
            }
        });

        this.addSeparator();

        const playGroup = this.createGroup();
        this.playBtn = this.createIconButton(Play, t('toolbar.play'), 'toolbar-btn play-btn disabled', () => {
            if (this.playBtn.classList.contains('disabled')) return;
            this.ctx.play();
        });
        this.playBtn.title = t('toolbar.loading');
        playGroup.appendChild(this.playBtn);

        this.stopBtn = this.createIconButton(Square, t('toolbar.stop'), 'toolbar-btn stop-btn', () => this.ctx.stop());
        this.stopBtn.title = t('toolbar.stop');
        this.stopBtn.style.display = 'none';
        playGroup.appendChild(this.stopBtn);

        // Multiplayer preview: opens the editor in a new tab with the same project
        // so the developer can exercise both ends of a peer-to-peer match locally.
        // Only visible for projects that declare multiplayer.enabled in 01_flow.json
        // (toggled by updatePreviewClientVisibility below).
        this.previewClientBtn = document.createElement('button');
        this.previewClientBtn.className = 'toolbar-btn';
        this.previewClientBtn.style.cssText = 'font-size:11px;padding:4px 10px;cursor:pointer;white-space:nowrap;margin-left:4px;display:none;';
        this.previewClientBtn.textContent = t('toolbar.previewClient');
        this.previewClientBtn.title = t('toolbar.previewClientTooltip');
        this.previewClientBtn.addEventListener('click', () => {
            const pid = this.ctx.state.projectId;
            if (!pid) return;
            // Preserve the current pathname so the editor opens at the same
            // base — root in dev (`/`) but `/editor/` on the hosted site.
            const url = new URL(window.location.href);
            url.searchParams.set('project', pid);
            url.searchParams.set('auto_play', '1');
            window.open(url.toString(), '_blank', 'noopener,noreferrer');
        });
        playGroup.appendChild(this.previewClientBtn);

        const mpWrapper = document.createElement('div');
        mpWrapper.style.cssText = 'position:relative;display:none;';
        this.mpBtn = document.createElement('button');
        this.mpBtn.className = 'toolbar-btn';
        this.mpBtn.style.cssText = 'font-size:11px;padding:4px 10px;cursor:pointer;white-space:nowrap;';
        this.mpBtn.textContent = t('toolbar.multiplayer');
        this.mpBtn.title = t('toolbar.multiplayerTooltip');
        mpWrapper.appendChild(this.mpBtn);

        this.mpDropdown = document.createElement('div');
        this.mpDropdown.style.cssText = 'display:none;position:absolute;top:100%;right:0;margin-top:4px;background:var(--bg-panel,#1e1e2e);border:1px solid var(--border-color,#333);border-radius:6px;padding:10px 14px;min-width:260px;z-index:10001;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
        const mpLabel = document.createElement('div');
        mpLabel.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.5);margin-bottom:4px;';
        mpLabel.textContent = t('toolbar.shareLink');
        this.mpDropdown.appendChild(mpLabel);

        this.mpLinkText = document.createElement('a');
        this.mpLinkText.style.cssText = 'font-size:11px;color:#4fc3f7;word-break:break-all;margin-bottom:6px;display:block;text-decoration:underline;cursor:pointer;';
        (this.mpLinkText as HTMLAnchorElement).target = '_blank';
        this.mpDropdown.appendChild(this.mpLinkText);

        const mpCopyBtn = document.createElement('button');
        mpCopyBtn.textContent = t('toolbar.copyLink');
        mpCopyBtn.style.cssText = 'font-size:11px;padding:4px 12px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:white;border-radius:4px;cursor:pointer;width:100%;';
        mpCopyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(this.mpLinkText.textContent || '').then(() => {
                mpCopyBtn.textContent = t('toolbar.copied');
                setTimeout(() => { mpCopyBtn.textContent = t('toolbar.copyLink'); }, 1500);
            });
        });
        this.mpDropdown.appendChild(mpCopyBtn);

        this.mpPlayerCount = document.createElement('div');
        this.mpPlayerCount.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.4);margin-top:6px;text-align:center;display:none;';
        this.mpDropdown.appendChild(this.mpPlayerCount);

        mpWrapper.appendChild(this.mpDropdown);

        this.mpBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = this.mpDropdown.style.display === 'block';
            this.mpDropdown.style.display = open ? 'none' : 'block';
        });
        document.addEventListener('click', () => { this.mpDropdown.style.display = 'none'; });
        this.mpDropdown.addEventListener('click', (e) => e.stopPropagation());

        playGroup.appendChild(mpWrapper);
        (this as any)._mpWrapper = mpWrapper;

        this.el.appendChild(playGroup);
        this.addSeparator();

        const publishBtn = this.createButton(t('toolbar.publish'), '', 'toolbar-btn publish-btn', () => {
            if (this.ctx.state.projectId) this.showPublishModal();
        });
        this.el.appendChild(publishBtn);

        const feedbackBtn = this.createButton(t('toolbar.feedback'), '', 'toolbar-btn', () => {
            this.showFeedbackModal();
        });
        this.el.appendChild(feedbackBtn);

        const settingsBtn = this.createIconButton(Settings, '', 'toolbar-btn', () => {
            this.showSettingsModal();
        });
        settingsBtn.title = t('toolbar.settings');
        this.el.appendChild(settingsBtn);
    }

    private buildMobile(): void {
        const logo = document.createElement('img');
        logo.className = 'toolbar-logo';
        logo.src = `${import.meta.env.BASE_URL}logos/main_logo_horizontal.png`;
        logo.alt = 'ParallaxPro';
        logo.title = t('toolbar.backToProjects');
        logo.style.cursor = 'pointer';
        logo.addEventListener('click', () => {
            if (this.ctx.state.projectDirty) {
                if (!confirm(t('toolbar.unsavedConfirm'))) return;
            }
            const url = new URL(window.location.href);
            url.searchParams.delete('project');
            window.location.href = url.toString();
        });
        this.el.appendChild(logo);

        this.projectNameEl = document.createElement('span');
        this.projectNameEl.style.display = 'none';
        this.syncStatusEl = document.createElement('span');
        this.syncStatusEl.style.display = 'none';
        this.wireSyncStatus();

        const transformGroup = this.createGroup();
        this.translateBtn = this.createIconButton(Move, '', 'toolbar-btn active', () => this.ctx.setGizmoMode('translate'));
        this.translateBtn.title = t('toolbar.translate');
        transformGroup.appendChild(this.translateBtn);

        this.rotateBtn = this.createIconButton(RotateCw, '', 'toolbar-btn', () => this.ctx.setGizmoMode('rotate'));
        this.rotateBtn.title = t('toolbar.rotate');
        transformGroup.appendChild(this.rotateBtn);

        this.scaleBtn = this.createIconButton(Maximize2, '', 'toolbar-btn', () => this.ctx.setGizmoMode('scale'));
        this.scaleBtn.title = t('toolbar.scale');
        transformGroup.appendChild(this.scaleBtn);
        this.el.appendChild(transformGroup);

        this.cameraModeBtn = this.createIconButton(Crosshair, t('toolbar.flyLabel'), 'toolbar-btn', () => this.ctx.toggleCameraMode());
        this.cameraModeBtn.title = t('toolbar.cameraMode');
        this.el.appendChild(this.cameraModeBtn);

        const spacer = document.createElement('div');
        spacer.className = 'toolbar-spacer';
        this.el.appendChild(spacer);

        const playGroup = this.createGroup();

        // AI Assistant button — only shown in mobile-landscape, replacing
        // the floating chat-toggle FAB that used to live bottom-right of
        // the viewport. The click handler is wired by editor_view via
        // bindMobileChat() once MobileEditorLayout exists. Visibility is
        // gated on (orientation: landscape) below.
        this.aiChatBtn = this.createIconButton(Sparkles, 'AI', 'toolbar-btn ai-chat-btn', () => { /* wired later */ });
        this.aiChatBtn.title = t('toolbar.aiAssistant');
        this.aiChatBtn.style.display = 'none';
        playGroup.appendChild(this.aiChatBtn);

        this.playBtn = this.createIconButton(Play, '', 'toolbar-btn play-btn disabled', () => {
            if (this.playBtn.classList.contains('disabled')) return;
            this.ctx.play();
        });
        this.playBtn.title = t('toolbar.play');
        playGroup.appendChild(this.playBtn);

        this.stopBtn = this.createIconButton(Square, '', 'toolbar-btn stop-btn', () => this.ctx.stop());
        this.stopBtn.title = t('toolbar.stop');
        this.stopBtn.style.display = 'none';
        playGroup.appendChild(this.stopBtn);

        this.previewClientBtn = document.createElement('button');
        this.previewClientBtn.style.display = 'none';
        playGroup.appendChild(this.previewClientBtn);
        this.el.appendChild(playGroup);

        // Show the AI Assistant button only in landscape; portrait uses
        // the bottom-half split-view chat panel instead.
        const landscapeQuery = window.matchMedia('(orientation: landscape)');
        const updateAiBtnVisibility = () => {
            if (!this.aiChatBtn) return;
            this.aiChatBtn.style.display = landscapeQuery.matches ? '' : 'none';
        };
        landscapeQuery.addEventListener('change', updateAiBtnVisibility);
        updateAiBtnVisibility();

        // Dummy elements that desktop bindEvents references (hidden on mobile)
        this.saveBtn = document.createElement('button');
        this.saveBtn.style.display = 'none';
        this.undoBtn = document.createElement('button');
        this.undoBtn.style.display = 'none';
        this.redoBtn = document.createElement('button');
        this.redoBtn.style.display = 'none';
        this.gizmoSpaceBtn = document.createElement('button');
        this.gizmoSpaceBtn.style.display = 'none';
        this.presenceContainer = document.createElement('div');
        this.collabChatBtn = document.createElement('button');
        this.collabChatBtn.style.display = 'none';
        this.collabChatPanel = document.createElement('div');
        this.collabChatPanel.style.display = 'none';
        this.collabChatMessages = document.createElement('div');
        this.collabChatInput = document.createElement('input') as HTMLInputElement;
        this.unreadBadge = document.createElement('span');
        this.mpBtn = document.createElement('button');
        this.mpBtn.style.display = 'none';
        this.mpDropdown = document.createElement('div');
        this.mpDropdown.style.display = 'none';
        this.mpLinkText = document.createElement('span');
        this.mpPlayerCount = document.createElement('div');
        const mpWrapper = document.createElement('div');
        mpWrapper.style.display = 'none';
        (this as any)._mpWrapper = mpWrapper;

        // Overflow menu button
        this.overflowBtn = document.createElement('button');
        this.overflowBtn.className = 'toolbar-overflow-btn';
        this.overflowBtn.textContent = '\u22EE';
        this.overflowBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.overflowMenu!.classList.toggle('open');
        });
        this.el.appendChild(this.overflowBtn);

        // Overflow menu dropdown
        this.overflowMenu = document.createElement('div');
        this.overflowMenu.className = 'toolbar-overflow-menu';
        this.el.style.position = 'relative';

        const addItem = (iconDef: any, label: string, onClick: () => void): HTMLElement => {
            const item = document.createElement('button');
            item.className = 'toolbar-overflow-item';
            item.appendChild(icon(iconDef, 16));
            const span = document.createElement('span');
            span.textContent = label;
            item.appendChild(span);
            item.addEventListener('click', () => {
                onClick();
                this.overflowMenu!.classList.remove('open');
            });
            this.overflowMenu!.appendChild(item);
            return item;
        };

        const addDivider = () => {
            const div = document.createElement('div');
            div.className = 'toolbar-overflow-divider';
            this.overflowMenu!.appendChild(div);
        };

        this.saveBtn = addItem(Save, t('settings.save'), () => this.ctx.saveProject());
        addItem(Undo2, t('toolbar.undo'), () => {
            this.ctx.undoManager.undo();
            this.ctx.emit('historyChanged');
            this.ctx.emit('sceneChanged');
            this.ctx.ensurePrimitiveMeshes();
        });
        addItem(Redo2, t('toolbar.redo'), () => {
            this.ctx.undoManager.redo();
            this.ctx.emit('historyChanged');
            this.ctx.emit('sceneChanged');
            this.ctx.ensurePrimitiveMeshes();
        });

        addDivider();

        addItem(Play, t('toolbar.publish'), () => {
            if (this.ctx.state.projectId) this.showPublishModal();
        });
        addItem(Settings, t('toolbar.settings'), () => this.showSettingsModal());

        this.el.appendChild(this.overflowMenu);
    }

    private bindEvents(): void {
        this.ctx.on('gizmoModeChanged', (mode: string) => {
            this.translateBtn.classList.toggle('active', mode === 'translate');
            this.rotateBtn.classList.toggle('active', mode === 'rotate');
            this.scaleBtn.classList.toggle('active', mode === 'scale');
        });

        this.ctx.on('cameraModeChanged', (mode: string) => {
            const isFly = mode === 'fly';
            this.cameraModeBtn.innerHTML = '';
            this.cameraModeBtn.appendChild(icon(isFly ? Crosshair : MousePointer2, 15));
            const span = document.createElement('span');
            span.textContent = isFly ? ` ${t('toolbar.flyLabel')}` : ` ${t('toolbar.orbitLabel')}`;
            this.cameraModeBtn.appendChild(span);
            this.cameraModeBtn.title = isFly ? t('toolbar.flyMode') : t('toolbar.orbitMode');
            this.cameraModeBtn.classList.toggle('active', isFly);
        });

        this.ctx.on('gizmoSpaceChanged', (space: string) => {
            const isLocal = space === 'local';
            this.gizmoSpaceBtn.innerHTML = '';
            this.gizmoSpaceBtn.appendChild(icon(isLocal ? Box : Globe, 15));
            const span = document.createElement('span');
            span.textContent = isLocal ? ` ${t('toolbar.localLabel')}` : ` ${t('toolbar.globalLabel')}`;
            this.gizmoSpaceBtn.appendChild(span);
            this.gizmoSpaceBtn.title = isLocal ? t('toolbar.localSpace') : t('toolbar.globalSpace');
            this.gizmoSpaceBtn.classList.toggle('active', isLocal);
        });

        this.ctx.on('playModeChanged', (isPlaying: boolean) => {
            this.playBtn.style.display = isPlaying ? 'none' : '';
            this.stopBtn.style.display = isPlaying ? '' : 'none';
            if (isPlaying) {
                this.playBtn.classList.add('active');
            } else {
                this.playBtn.classList.remove('active');
                this.playBtn.classList.remove('disabled');
                this.playBtn.title = t('toolbar.playCtrlP');
                (this as any)._mpWrapper.style.display = 'none';
                this.mpDropdown.style.display = 'none';
            }
            this.updatePreviewClientVisibility();
        });

        // Project data changes (load, edit) may flip multiplayer on/off.
        this.ctx.on('projectLoaded', () => this.updatePreviewClientVisibility());
        this.ctx.on('projectSaved', () => this.updatePreviewClientVisibility());

        this.ctx.on('multiplayerRoomCreated', (data: any) => {
            const { joinLink } = data;
            this.mpLinkText.textContent = joinLink;
            (this.mpLinkText as HTMLAnchorElement).href = joinLink;
            this.mpPlayerCount.textContent = t('toolbar.playerConnected').replace('{count}', '1');
            (this as any)._mpWrapper.style.display = '';
        });
        this.ctx.multiplayer.on('playerJoined', () => {
            const count = this.ctx.multiplayer.remotePlayerCount + 1;
            this.mpPlayerCount.textContent = (count !== 1 ? t('toolbar.playersConnected') : t('toolbar.playerConnected')).replace('{count}', String(count));
        });
        this.ctx.multiplayer.on('playerLeft', () => {
            const count = this.ctx.multiplayer.remotePlayerCount + 1;
            this.mpPlayerCount.textContent = (count !== 1 ? t('toolbar.playersConnected') : t('toolbar.playerConnected')).replace('{count}', String(count));
        });

        this.ctx.on('historyChanged', () => {
            this.undoBtn.classList.toggle('disabled', !this.ctx.undoManager.canUndo());
            this.redoBtn.classList.toggle('disabled', !this.ctx.undoManager.canRedo());
        });

        this.ctx.on('dirtyChanged', (dirty: boolean) => {
            const name = this.ctx.state.projectData?.name ?? t('toolbar.untitled');
            this.projectNameEl.textContent = dirty ? `${name} *` : name;
            this.saveBtn.classList.toggle('disabled', !dirty);
        });

        const loadingLabel = document.createElement('span');
        loadingLabel.className = 'toolbar-loading-label';
        loadingLabel.style.cssText = 'font-size:11px;color:#f59e0b;margin-left:4px;display:none;';
        this.playBtn.parentElement?.appendChild(loadingLabel);

        const enablePlayBtn = () => {
            if (!this.ctx.state.isPlaying && this.ctx.assetsLoadingCount === 0) {
                this.playBtn.classList.remove('disabled');
                this.playBtn.title = t('toolbar.playCtrlP');
                loadingLabel.style.display = 'none';
            }
        };

        this.ctx.on('assetLoadProgress', (progress: { loaded: number; total: number }) => {
            if (progress.total > 0 && progress.loaded < progress.total && !this.ctx.state.isPlaying) {
                this.playBtn.classList.add('disabled');
                this.playBtn.title = `Loading assets (${progress.loaded}/${progress.total})...`;
                loadingLabel.textContent = `Loading ${progress.loaded}/${progress.total}`;
                loadingLabel.style.display = 'inline';
            } else {
                enablePlayBtn();
            }
        });

        this.ctx.on('sceneChanged', () => enablePlayBtn());

        this.ctx.on('projectLoaded', () => {
            const name = this.ctx.state.projectData?.name ?? t('toolbar.untitled');
            this.projectNameEl.textContent = name;
        });

        this.ctx.on('projectSaved', () => {
            this.showToast(t('toolbar.projectSaved'), 'success');
        });

        this.ctx.on('collabPresenceChanged', (users: CollabUser[]) => {
            this.collabUsers = users;
            this.renderPresence();
        });

        this.ctx.on('collabUserJoined', (user: CollabUser) => {
            if (!this.collabUsers.find(u => u.clientId === user.clientId)) {
                this.collabUsers.push(user);
            }
            this.renderPresence();
            this.addCollabSystemMessage(`${user.displayName} ${t('toolbar.joined')}`);
        });

        this.ctx.on('collabUserLeft', (data: { clientId: string; displayName: string }) => {
            this.collabUsers = this.collabUsers.filter(u => u.clientId !== data.clientId);
            this.renderPresence();
            this.addCollabSystemMessage(`${data.displayName} ${t('toolbar.left')}`);
        });

        this.ctx.on('collabChatMessage', (data: CollabChatMsg) => {
            this.addCollabChatMessage(data);
        });

        this.ctx.backend.onWsMessage('multiplayer_room', (data: any) => {
            const host = data.hostName || 'A collaborator';
            this.showToast(`${host} ${t('toolbar.startedMultiplayer')}`, 'success');
            const div = document.createElement('div');
            div.className = 'collab-chat-msg collab-chat-msg-system';
            const strong = document.createElement('strong');
            strong.textContent = host;
            div.appendChild(strong);
            div.appendChild(document.createTextNode(' started multiplayer: '));
            const a = document.createElement('a');
            a.href = data.joinLink;
            a.target = '_blank';
            a.textContent = data.joinLink;
            a.style.cssText = 'color:#7cacf8;text-decoration:underline;cursor:pointer;';
            div.appendChild(a);
            this.collabChatMessages.appendChild(div);
            this.collabChatMessages.scrollTop = this.collabChatMessages.scrollHeight;
        });

        this.ctx.on('multiplayerRoomClosed', (message: string) => {
            this.showToast(message || 'The host has ended the session.', 'error');
        });

        this.ctx.on('multiplayerDisconnected', () => {
            this.showToast('Disconnected from multiplayer session.', 'error');
        });
    }

    setProjectName(name: string): void {
        this.projectNameEl.textContent = name;
    }

    /**
     * Wire the mobile-landscape AI Assistant toolbar button. Called by
     * editor_view.ts after MobileEditorLayout is constructed. The
     * `isOpen` callback lets the button reflect the chat sheet's open
     * state visually (active class).
     *
     * No-op on desktop / portrait builds where aiChatBtn is null.
     */
    bindMobileChat(toggle: () => void, isOpen: () => boolean): void {
        if (!this.aiChatBtn) return;
        const btn = this.aiChatBtn;
        btn.addEventListener('click', () => {
            toggle();
            btn.classList.toggle('active', isOpen());
        });
    }

    /** Mirror the chat sheet's open state to the toolbar button highlight. */
    setMobileChatOpen(open: boolean): void {
        if (!this.aiChatBtn) return;
        this.aiChatBtn.classList.toggle('active', open);
    }

    private createGroup(): HTMLElement {
        const g = document.createElement('div');
        g.className = 'toolbar-group';
        return g;
    }

    /**
     * Show the "+ Preview Client" button only for projects that declare
     * multiplayer.enabled in their flow JSON. The button opens a second
     * editor tab with ?auto_play=1, so the dev can host in one tab and
     * join in the other without leaving the browser.
     *
     * Hidden on mobile: a phone can only practically run one client at a
     * time (browser memory + battery), and the "+ Client" affordance
     * confuses touch users who are just trying to play, not host a
     * second peer side-by-side with themselves.
     */
    private updatePreviewClientVisibility(): void {
        if (isMobile()) {
            this.previewClientBtn.style.display = 'none';
            return;
        }
        // Visible whenever the project declares multiplayer — devs often want
        // to open the second client first, line up two windows, and then hit
        // play. The new tab uses ?auto_play=1 so it'll start its own match
        // independently if the host hasn't pressed play yet.
        const pd: any = this.ctx.state.projectData;
        const mpEnabled = pd?.multiplayerConfig?.enabled
            || pd?.projectConfig?.multiplayerConfig?.enabled
            || this.detectMultiplayerInFlow(pd);
        this.previewClientBtn.style.display = mpEnabled ? '' : 'none';
    }

    private detectMultiplayerInFlow(projectData: any): boolean {
        const files = projectData?.files;
        if (!files || typeof files !== 'object') return false;
        const flow = files['01_flow.json'];
        if (typeof flow !== 'string') return false;
        try {
            const parsed = JSON.parse(flow);
            return !!parsed?.multiplayer?.enabled;
        } catch {
            return false;
        }
    }

    private createButton(label: string, iconStr: string, className: string, onClick: () => void): HTMLElement {
        const btn = document.createElement('button');
        btn.className = className;
        btn.textContent = (iconStr && label) ? `${iconStr} ${label}` : (iconStr || label);
        btn.addEventListener('click', onClick);
        return btn;
    }

    private createIconButton(iconDef: any, label: string, className: string, onClick: () => void): HTMLElement {
        const btn = document.createElement('button');
        btn.className = className;
        btn.appendChild(icon(iconDef, 15));
        if (label) {
            const span = document.createElement('span');
            span.textContent = ` ${label}`;
            btn.appendChild(span);
        }
        btn.addEventListener('click', onClick);
        return btn;
    }

    private addSeparator(): void {
        const sep = document.createElement('div');
        sep.className = 'separator';
        this.el.appendChild(sep);
    }

    private async startRenameProject(): Promise<void> {
        const currentName = this.ctx.state.projectData?.name ?? t('toolbar.untitled');
        const newName = await showPromptModal(t('toolbar.renameProject'), currentName, t('toolbar.projectNamePlaceholder'));
        if (!newName || newName === currentName) return;

        if (this.ctx.state.projectData) {
            this.ctx.state.projectData.name = newName;
        }
        this.projectNameEl.textContent = newName;

        if (this.ctx.state.projectId) {
            try {
                await this.ctx.backend.renameProject(this.ctx.state.projectId, newName);
                const pd: any = this.ctx.state.projectData;
                const uid = this.ctx.cloudSync.currentUserId();
                if (pd?.isCloud && this.ctx.backend.isSelfHosted && uid) {
                    try {
                        const res = await this.ctx.backend.renameProjectProd(this.ctx.state.projectId, newName);
                        if (res?.updatedAt) {
                            await this.ctx.backend.markCloudLocal(this.ctx.state.projectId, {
                                cloudUserId: uid, cloudUpdatedAt: res.updatedAt,
                            });
                            pd.cloudPulledUpdatedAt = res.updatedAt;
                        }
                    } catch (e) { console.warn('Cloud rename push failed:', e); }
                }
                this.showToast(t('toolbar.projectRenamed'), 'success');
            } catch (e) {
                console.error('Failed to rename project:', e);
                this.showToast(t('toolbar.renameFailed'), 'error');
            }
        }
    }

    private showShareModal(): void {
        const projectId = this.ctx.state.projectId;
        if (!projectId) return;

        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

        const addLabel = document.createElement('label');
        addLabel.textContent = t('share.addPeople');
        addLabel.style.cssText = 'font-weight:600;font-size:13px;';
        body.appendChild(addLabel);

        const addRow = document.createElement('div');
        addRow.style.cssText = 'display:flex;gap:8px;align-items:center;';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = t('share.emailPlaceholder');
        input.style.cssText = 'flex:1;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-size:13px;';
        addRow.appendChild(input);

        const permSelect = document.createElement('select');
        permSelect.style.cssText = 'padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-size:13px;';
        permSelect.innerHTML = `<option value="editor">${t('share.editor')}</option><option value="viewer">${t('share.viewer')}</option>`;
        addRow.appendChild(permSelect);

        const addBtn = document.createElement('button');
        addBtn.textContent = t('share.share');
        addBtn.style.cssText = 'padding:8px 16px;background:#69bbf3;color:#1e1e1e;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;';
        addRow.appendChild(addBtn);

        body.appendChild(addRow);

        const statusMsg = document.createElement('div');
        statusMsg.style.cssText = 'font-size:12px;display:none;';
        body.appendChild(statusMsg);

        const listLabel = document.createElement('label');
        listLabel.textContent = t('share.peopleWithAccess');
        listLabel.style.cssText = 'font-weight:600;font-size:13px;margin-top:8px;';
        body.appendChild(listLabel);

        const listContainer = document.createElement('div');
        listContainer.style.cssText = 'display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;';
        body.appendChild(listContainer);

        const renderShares = async () => {
            listContainer.innerHTML = '';
            try {
                const data = await this.ctx.backend.getProjectShares(projectId);
                const ownerRow = document.createElement('div');
                ownerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px;border-radius:6px;background:var(--bg-input);';
                ownerRow.innerHTML = `
                    <div style="display:flex;align-items:center;gap:8px;">
                        <div style="width:28px;height:28px;border-radius:50%;background:#69bbf3;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;color:#1e1e1e;">${(data.owner.username || data.owner.email)[0].toUpperCase()}</div>
                        <div>
                            <div style="font-size:13px;font-weight:500;color:var(--text);">${data.owner.username || data.owner.email}</div>
                            <div style="font-size:11px;color:var(--text-dim);">${data.owner.email}</div>
                        </div>
                    </div>
                    <span style="font-size:11px;color:var(--text-dim);padding:2px 8px;background:var(--bg);border-radius:4px;">Owner</span>
                `;
                listContainer.appendChild(ownerRow);

                for (const share of data.shares) {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px;border-radius:6px;background:var(--bg-input);';

                    const infoDiv = document.createElement('div');
                    infoDiv.style.cssText = 'display:flex;align-items:center;gap:8px;';
                    const avatar = document.createElement('div');
                    avatar.style.cssText = 'width:28px;height:28px;border-radius:50%;background:#8648e6;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;color:#fff;';
                    avatar.textContent = share.email[0].toUpperCase();
                    infoDiv.appendChild(avatar);

                    // share.email is user-authored (invitee typed it into
                    // the Share dialog). Use textContent so a malicious
                    // address like `<img src=x onerror=…>@x` can't XSS the
                    // project owner when they open the Share list.
                    const textDiv = document.createElement('div');
                    const emailEl = document.createElement('div');
                    emailEl.style.cssText = 'font-size:13px;font-weight:500;color:var(--text);';
                    emailEl.textContent = share.email;
                    textDiv.appendChild(emailEl);
                    infoDiv.appendChild(textDiv);
                    row.appendChild(infoDiv);

                    const actions = document.createElement('div');
                    actions.style.cssText = 'display:flex;align-items:center;gap:8px;';

                    const badge = document.createElement('span');
                    badge.textContent = share.permission.charAt(0).toUpperCase() + share.permission.slice(1);
                    badge.style.cssText = 'font-size:11px;color:var(--text-dim);padding:2px 8px;background:var(--bg);border-radius:4px;';
                    actions.appendChild(badge);

                    const removeBtn = document.createElement('button');
                    removeBtn.textContent = '\u00d7';
                    removeBtn.title = t('share.removeAccess');
                    removeBtn.style.cssText = 'background:none;border:none;color:#e53935;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;';
                    removeBtn.addEventListener('click', async () => {
                        try {
                            await this.ctx.backend.removeProjectShare(projectId, share.userId);
                            renderShares();
                        } catch (e: any) {
                            statusMsg.textContent = e.message || 'Failed to remove.';
                            statusMsg.style.cssText = 'font-size:12px;display:block;color:#e53935;';
                        }
                    });
                    actions.appendChild(removeBtn);

                    row.appendChild(actions);
                    listContainer.appendChild(row);
                }

                if (data.shares.length === 0) {
                    const emptyMsg = document.createElement('div');
                    emptyMsg.textContent = t('share.notSharedYet');
                    emptyMsg.style.cssText = 'font-size:12px;color:var(--text-dim);padding:8px;text-align:center;';
                    listContainer.appendChild(emptyMsg);
                }
            } catch {
                listContainer.innerHTML = `<div style="font-size:12px;color:var(--text-dim);padding:8px;">${t('share.couldNotLoad')}</div>`;
            }
        };

        renderShares();

        addBtn.addEventListener('click', async () => {
            const identifier = input.value.trim();
            if (!identifier) {
                statusMsg.textContent = t('share.enterEmailOrUsername');
                statusMsg.style.cssText = 'font-size:12px;display:block;color:#e53935;';
                return;
            }
            addBtn.disabled = true;
            addBtn.textContent = '...';
            try {
                const result = await this.ctx.backend.shareProject(projectId, identifier, permSelect.value);
                input.value = '';
                statusMsg.textContent = result.user?.is_stub
                    ? t('share.invitationSent').replace('{email}', result.user.email)
                    : t('share.sharedWith').replace('{email}', result.user?.email || identifier);
                statusMsg.style.cssText = 'font-size:12px;display:block;color:#4caf50;';
                renderShares();
            } catch (e: any) {
                statusMsg.textContent = e.message || 'Failed to share.';
                statusMsg.style.cssText = 'font-size:12px;display:block;color:#e53935;';
            } finally {
                addBtn.disabled = false;
                addBtn.textContent = t('share.share');
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addBtn.click();
        });

        const { close } = showModal({
            title: t('share.title'),
            body,
            width: '480px',
            buttons: [
                { label: t('share.done'), primary: true, action: () => close() },
            ],
        });

        input.focus();
    }

    private showFeedbackModal(): void {
        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

        const msgLabel = document.createElement('label');
        msgLabel.textContent = t('feedbackModal.whatFeedback');
        msgLabel.style.cssText = 'font-weight:600;font-size:13px;';
        body.appendChild(msgLabel);

        const textarea = document.createElement('textarea');
        textarea.placeholder = t('feedbackModal.placeholder');
        textarea.rows = 5;
        textarea.style.cssText = 'width:100%;resize:vertical;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-family:inherit;font-size:13px;';
        body.appendChild(textarea);

        // Image upload area
        const imageLabel = document.createElement('label');
        imageLabel.textContent = t('feedbackModal.screenshotsLabel');
        imageLabel.style.cssText = 'font-weight:600;font-size:13px;';
        body.appendChild(imageLabel);

        const imageFiles: File[] = [];
        const previewContainer = document.createElement('div');
        previewContainer.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
        body.appendChild(previewContainer);

        const uploadBtn = document.createElement('button');
        uploadBtn.textContent = t('feedbackModal.addImage');
        uploadBtn.style.cssText = 'padding:6px 12px;border:1px dashed var(--border);border-radius:6px;background:transparent;color:var(--text-dim);cursor:pointer;font-size:12px;';
        body.appendChild(uploadBtn);

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.multiple = true;
        fileInput.style.display = 'none';
        body.appendChild(fileInput);

        uploadBtn.addEventListener('click', () => fileInput.click());

        const renderPreviews = () => {
            previewContainer.innerHTML = '';
            for (let i = 0; i < imageFiles.length; i++) {
                const wrapper = document.createElement('div');
                wrapper.style.cssText = 'position:relative;width:60px;height:60px;border-radius:4px;overflow:hidden;border:1px solid var(--border);';
                const img = document.createElement('img');
                img.src = URL.createObjectURL(imageFiles[i]);
                img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
                const removeBtn = document.createElement('div');
                removeBtn.textContent = '×';
                removeBtn.style.cssText = 'position:absolute;top:0;right:0;width:18px;height:18px;background:rgba(0,0,0,0.7);color:white;text-align:center;line-height:18px;cursor:pointer;font-size:14px;';
                removeBtn.addEventListener('click', () => { imageFiles.splice(i, 1); renderPreviews(); });
                wrapper.appendChild(img);
                wrapper.appendChild(removeBtn);
                previewContainer.appendChild(wrapper);
            }
            uploadBtn.style.display = imageFiles.length >= 5 ? 'none' : '';
        };

        fileInput.addEventListener('change', () => {
            const files = Array.from(fileInput.files || []);
            for (const file of files) {
                if (imageFiles.length >= 5) break;
                if (file.size > 5 * 1024 * 1024) {
                    errorMsg.textContent = t('feedbackModal.exceedsLimit').replace('{name}', file.name);
                    errorMsg.style.display = 'block';
                    continue;
                }
                imageFiles.push(file);
            }
            fileInput.value = '';
            renderPreviews();
        });

        const errorMsg = document.createElement('div');
        errorMsg.style.cssText = 'color:#e53935;font-size:12px;display:none;';
        body.appendChild(errorMsg);

        const { close } = showModal({
            title: t('feedbackModal.title'),
            body,
            width: '480px',
            buttons: [
                { label: t('feedbackModal.cancel'), action: () => close() },
                {
                    label: t('feedbackModal.send'),
                    primary: true,
                    action: async () => {
                        const msg = textarea.value.trim();
                        if (!msg) {
                            errorMsg.textContent = t('feedbackModal.enterFeedback');
                            errorMsg.style.display = 'block';
                            return;
                        }
                        try {
                            await this.ctx.backend.sendFeedback(this.ctx.state.projectId!, msg, imageFiles);
                            close();
                            this.showToast(t('feedbackModal.sent'), 'success');
                        } catch (e: any) {
                            errorMsg.textContent = e.message || 'Failed to send feedback.';
                            errorMsg.style.display = 'block';
                        }
                    },
                },
            ],
        });

        textarea.focus();
    }

    private showSettingsModal(): void {
        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex-direction:column;gap:16px;';

        // Chat Agent picker — which provider handles the conversational LLM
        // calls. "LLM API" uses the direct AI_BASE_URL when configured; the
        // rest drive a local CLI as a chat completion proxy. Only shows
        // providers that are actually available on the backend.
        const cliAgents = this.ctx.state.availableAgents ?? [];
        const chatOptions: { value: string; label: string }[] = [];
        if (this.ctx.state.llmApiAvailable) chatOptions.push({ value: 'llm_api', label: 'LLM API' });
        for (const a of cliAgents) {
            const label = a.label.replace(/^Editing Agent:\s*/, '');
            chatOptions.push({ value: a.id, label });
        }
        let chatSelect: HTMLSelectElement | null = null;
        if (chatOptions.length >= 2) {
            const chatRow = document.createElement('div');
            chatRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
            const chatLabel = document.createElement('label');
            chatLabel.textContent = t('settings.chatAgent');
            chatLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);';
            chatSelect = document.createElement('select');
            chatSelect.style.cssText = 'width:100%;height:28px;';
            const currentChat = localStorage.getItem('chat_agent')
                ?? (this.ctx.state.llmApiAvailable ? 'llm_api' : chatOptions[0].value);
            for (const opt of chatOptions) {
                const el = document.createElement('option');
                el.value = opt.value;
                el.textContent = opt.label;
                if (opt.value === currentChat) el.selected = true;
                chatSelect.appendChild(el);
            }
            const chatHint = document.createElement('span');
            chatHint.style.cssText = 'font-size:11px;color:var(--text-disabled);';
            chatHint.textContent = t('settings.chatAgentHint');
            chatRow.appendChild(chatLabel);
            chatRow.appendChild(chatSelect);
            chatRow.appendChild(chatHint);
            body.appendChild(chatRow);
        }

        // Editing Agent picker — only when 2+ CLI fixers are installed on the
        // backend. Persisted in projectConfig.editingAgent and used by the
        // fixer whenever the LLM escalates via FIX_GAME (Auto / Small LLM).
        let agentSelect: HTMLSelectElement | null = null;
        if (cliAgents.length >= 2) {
            const agentRow = document.createElement('div');
            agentRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
            const agentLabel = document.createElement('label');
            agentLabel.textContent = t('settings.editingAgent');
            agentLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);';
            agentSelect = document.createElement('select');
            agentSelect.style.cssText = 'width:100%;height:28px;';
            const currentAgent = localStorage.getItem('editing_agent') ?? 'claude';
            for (const a of cliAgents) {
                const opt = document.createElement('option');
                opt.value = a.id;
                opt.textContent = a.label;
                if (a.id === currentAgent) opt.selected = true;
                agentSelect.appendChild(opt);
            }
            const agentHint = document.createElement('span');
            agentHint.style.cssText = 'font-size:11px;color:var(--text-disabled);';
            agentHint.textContent = t('settings.editingAgentHint');
            agentRow.appendChild(agentLabel);
            agentRow.appendChild(agentSelect);
            agentRow.appendChild(agentHint);
            body.appendChild(agentRow);
        }

        const gfxRow = document.createElement('div');
        gfxRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
        const gfxLabel = document.createElement('label');
        gfxLabel.textContent = t('settings.graphicsQuality');
        gfxLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);';
        const gfxSelect = document.createElement('select');
        gfxSelect.style.cssText = 'width:100%;height:28px;';
        // Hints are backend-specific — the WebGL2 fallback ships a
        // reduced pipeline (no FXAA / MSAA / HBAO / SSR / bloom) so we
        // describe what's actually on rather than promising features
        // that won't render on potato hardware.
        const isWebGL2 = (window as any).__ppGfxBackend === 'webgl2';
        const qualities = isWebGL2 ? [
            { value: 'low',    label: 'Low',    hint: 'WebGL2 — no shadows' },
            { value: 'medium', label: 'Medium', hint: 'WebGL2 — soft shadows' },
            { value: 'high',   label: 'High',   hint: 'WebGL2 — sharp shadows' },
        ] : [
            { value: 'low',    label: 'Low',    hint: 'Basic rendering, no shadows' },
            { value: 'medium', label: 'Medium', hint: 'Shadows, FXAA anti-aliasing, HBAO' },
            { value: 'high',   label: 'High',   hint: 'Shadows, MSAA anti-aliasing, HBAO, screen-space reflections, bloom' },
        ];
        const currentQuality = (localStorage.getItem('graphics_quality') as string) ?? 'medium';
        for (const q of qualities) {
            const opt = document.createElement('option');
            opt.value = q.value;
            opt.textContent = q.label;
            if (q.value === currentQuality) opt.selected = true;
            gfxSelect.appendChild(opt);
        }
        const gfxHint = document.createElement('span');
        gfxHint.style.cssText = 'font-size:11px;color:var(--text-disabled);';
        gfxHint.textContent = qualities.find(q => q.value === currentQuality)?.hint ?? '';
        gfxSelect.addEventListener('change', () => {
            gfxHint.textContent = qualities.find(q => q.value === gfxSelect.value)?.hint ?? '';
        });
        gfxRow.appendChild(gfxLabel);
        gfxRow.appendChild(gfxSelect);
        gfxRow.appendChild(gfxHint);
        body.appendChild(gfxRow);

        // Cloud sync section — only shown on self-hosted instances.
        // Mirrors the editor's promote toast but survives the user's
        // previous dismissal. Two states:
        //   - Not cloud yet → "Promote to Cloud" button.
        //   - Already cloud → static "Synced to parallaxpro.ai" line.
        if (this.ctx.backend.isSelfHosted) {
            const cloudRow = document.createElement('div');
            cloudRow.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:10px 12px;background:var(--bg-secondary);border-radius:6px;';
            const cloudLabel = document.createElement('div');
            cloudLabel.textContent = t('settings.cloudSync');
            cloudLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);';
            cloudRow.appendChild(cloudLabel);
            this.renderCloudSettingsSection(cloudRow);
            body.appendChild(cloudRow);
        }

        const { close } = showModal({
            title: t('toolbar.settings'),
            body,
            width: '400px',
            closeOnBackdrop: false,
            buttons: [
                { label: t('settings.cancel'), action: () => close() },
                {
                    label: t('settings.save'),
                    primary: true,
                    action: () => {
                        if (agentSelect) localStorage.setItem('editing_agent', agentSelect.value);
                        if (chatSelect) localStorage.setItem('chat_agent', chatSelect.value);
                        const selectedQuality = gfxSelect.value as 'low' | 'medium' | 'high';
                        localStorage.setItem('graphics_quality', selectedQuality);
                        this.ctx.setGraphicsQuality(selectedQuality);
                        close();
                    },
                },
            ],
        });
    }

    /**
     * Render the Cloud Sync section of the Settings modal. Extracted
     * so the Promote button can re-render itself in place after
     * successfully syncing (no modal close/reopen needed).
     */
    private renderCloudSettingsSection(container: HTMLElement): void {
        // Remove the section's body (keep the label — first child).
        while (container.children.length > 1) container.removeChild(container.lastChild!);

        const pd: any = this.ctx.state.projectData;
        const isCloud = !!pd?.isCloud;
        const signedIn = !!this.ctx.cloudSync.currentUserId();

        if (!signedIn) {
            const hint = document.createElement('div');
            hint.style.cssText = 'font-size:12px;color:var(--text-secondary);line-height:1.4;';
            hint.textContent = isCloud
                ? t('settings.cloudSignedOutCloudHint')
                : t('settings.cloudSignedOutHint');
            container.appendChild(hint);

            const btn = document.createElement('button');
            btn.textContent = t('settings.cloudSignIn');
            btn.style.cssText = 'align-self:flex-start;padding:6px 14px;background:#8648e6;color:#fff;border:0;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;';
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = t('settings.cloudSigningIn');
                try {
                    const { ensureLoggedIn } = await import('../backend/auth_session.js');
                    await ensureLoggedIn();
                    // Re-render this section in place so it flips from
                    // "Sign in" to either "Promote to Cloud" or the
                    // green synced state — whichever applies now.
                    this.renderCloudSettingsSection(container);
                    // If this is already a cloud project, push whatever
                    // was edited offline right away.
                    if (isCloud && this.ctx.state.projectId) {
                        this.ctx.cloudSync.schedulePush(this.ctx.state.projectId);
                    }
                    this.showToast(t('settings.signedInToast'), 'success');
                } catch (e: any) {
                    btn.disabled = false;
                    btn.textContent = t('settings.cloudSignIn');
                    console.warn('[auth] sign-in cancelled:', e?.message ?? e);
                }
            });
            container.appendChild(btn);
            return;
        }

        if (isCloud) {
            const status = document.createElement('div');
            status.style.cssText = 'font-size:12.5px;color:#7bca9b;display:flex;align-items:center;gap:6px;';
            status.textContent = t('settings.cloudSyncedCheck');
            container.appendChild(status);
            return;
        }

        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:12px;color:var(--text-secondary);line-height:1.4;';
        hint.textContent = t('settings.cloudHint');
        container.appendChild(hint);

        const btn = document.createElement('button');
        btn.textContent = t('settings.cloudPromote');
        btn.style.cssText = 'align-self:flex-start;padding:6px 14px;background:#8648e6;color:#fff;border:0;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;';
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = t('settings.cloudPromoting');
            const result = await this.ctx.promoteCurrentProjectToCloud();
            if (result.ok) {
                // Also clear any per-project "don't show toast" flag so a
                // future unsynced project still gets offered if the user
                // dismissed this one in the past.
                try { localStorage.removeItem(`pp_promote_dismissed:${this.ctx.state.projectId}`); } catch {}
                this.renderCloudSettingsSection(container);
                this.showToast(t('settings.cloudProjectSynced'), 'success');
            } else {
                btn.disabled = false;
                btn.textContent = t('settings.cloudPromote');
                alert(result.reason);
            }
        });
        container.appendChild(btn);
    }

    private getUsername(): string {
        try {
            const token = localStorage.getItem('auth_token') ?? localStorage.getItem('token');
            if (!token) return '';
            const payload = JSON.parse(atob(token.split('.')[1]));
            return payload.username || '';
        } catch { return ''; }
    }

    private isHosted(): boolean {
        const h = window.location.hostname;
        return h === 'parallaxpro.ai' || h === 'www.parallaxpro.ai';
    }

    private async showPublishModal(): Promise<void> {
        const projectId = this.ctx.state.projectId;
        if (!projectId) return;
        await new PublishFlow(this.ctx).open(projectId, {
            id: projectId,
            name: this.ctx.state.projectData?.name,
            thumbnail: this.ctx.state.projectData?.thumbnail as string | null | undefined,
        });
    }


    /** Drive the little cloud-sync status pill off cloudSync events. Pill
     *  is visible only when the current project is a cloud project on
     *  self-hosted — and flips between synced / syncing / unsynced /
     *  signed-out / error states. */
    private wireSyncStatus(): void {
        type S = 'synced' | 'syncing' | 'unsynced' | 'signed-out' | 'error';
        const paint = (state: S, title: string) => {
            const spec = ({
                'synced':      { text: '✓ Synced',       bg: '#1f6f43', fg: '#cdeedc' },
                'syncing':     { text: '↻ Syncing…',    bg: '#2a4d9a', fg: '#c7daff' },
                'unsynced':    { text: '↑ Unsynced',     bg: '#9a6300', fg: '#ffe6b2' },
                'signed-out':  { text: 'Sign in to sync', bg: '#4a3f8a', fg: '#d7ccff' },
                'error':       { text: '⚠ Sync failed',  bg: '#8a1b1b', fg: '#ffd3d3' },
            } as Record<S, { text: string; bg: string; fg: string }>)[state];
            this.syncStatusEl.style.display = 'inline-flex';
            this.syncStatusEl.textContent = spec.text;
            this.syncStatusEl.style.background = spec.bg;
            this.syncStatusEl.style.color = spec.fg;
            this.syncStatusEl.title = title;
            this.syncStatusEl.style.cursor = (state === 'signed-out' || state === 'error' || state === 'unsynced') ? 'pointer' : 'default';
        };

        this.syncStatusEl.addEventListener('click', async () => {
            const pd: any = this.ctx.state.projectData;
            if (!pd?.isCloud || !this.ctx.backend.isSelfHosted) return;
            if (!this.ctx.cloudSync.currentUserId()) {
                const { ensureLoggedIn } = await import('../backend/auth_session.js');
                try {
                    await ensureLoggedIn();
                    if (this.ctx.state.projectId) this.ctx.cloudSync.schedulePush(this.ctx.state.projectId);
                } catch {}
            } else if (this.ctx.state.projectId) {
                // Manual retry — force a push now rather than waiting for
                // the next debounce.
                this.ctx.cloudSync.schedulePush(this.ctx.state.projectId);
            }
        });
        const refresh = () => {
            const pd: any = this.ctx.state.projectData;
            if (!pd?.isCloud || !this.ctx.backend.isSelfHosted) {
                this.syncStatusEl.style.display = 'none';
                return;
            }
            if (!this.ctx.cloudSync.currentUserId()) {
                paint('signed-out', 'Signed out — saves stay local until you sign in.');
                return;
            }
            const localT = Date.parse(pd.updatedAt || 0);
            const lastSync = Date.parse(pd.cloudPulledUpdatedAt || 0);
            if (localT > lastSync) paint('unsynced', 'Local edits not yet on parallaxpro.ai.');
            else paint('synced', `Last synced ${formatServerTime(pd.cloudPulledUpdatedAt)}`);
        };
        refresh();

        this.ctx.on('projectLoaded', refresh);
        this.ctx.on('projectSaved', refresh);
        this.ctx.on('cloudPromoted', refresh);
        this.ctx.cloudSync.on('pushing', (e: any) => {
            if (e.projectId === this.ctx.state.projectId) paint('syncing', 'Pushing to parallaxpro.ai…');
        });
        this.ctx.cloudSync.on('pushed', (e: any) => {
            if (e.projectId === this.ctx.state.projectId) {
                const pd: any = this.ctx.state.projectData;
                if (pd) pd.cloudPulledUpdatedAt = e.updatedAt ?? pd.cloudPulledUpdatedAt;
                paint('synced', `Synced at ${formatServerTime(e.updatedAt, 'now')}`);
            }
        });
        this.ctx.cloudSync.on('pulled', (e: any) => {
            if (e.projectId === this.ctx.state.projectId) paint('synced', 'Pulled latest from parallaxpro.ai');
        });
        this.ctx.cloudSync.on('error', (e: any) => {
            if (e.projectId === this.ctx.state.projectId) paint('error', e?.payload?.message || 'Sync failed. Will retry on next save.');
        });
        this.ctx.cloudSync.on('auth_required', (e: any) => {
            if (e.projectId === this.ctx.state.projectId) paint('signed-out', 'Your session expired — sign in to resume syncing.');
        });
    }

    showToast(message: string, type: string): void {
        let container = document.querySelector('.toast-container') as HTMLElement;
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    private renderPresence(): void {
        this.presenceContainer.innerHTML = '';
        const others = this.collabUsers.filter(u => u.clientId !== this.ctx.collabClientId);
        const hasOthers = others.length > 0;

        this.collabChatBtn.style.display = (hasOthers || this.collabMessages.length > 0) ? '' : 'none';

        if (!hasOthers) {
            this.presenceContainer.style.display = 'none';
            return;
        }
        this.presenceContainer.style.display = 'flex';

        const maxShow = 4;
        const toShow = others.slice(0, maxShow);
        for (const user of toShow) {
            const wrapper = document.createElement('div');
            wrapper.className = 'collab-avatar-wrapper';

            const avatar = document.createElement('div');
            avatar.className = 'collab-avatar';
            avatar.style.background = user.color;
            const initials = user.displayName.split(/[-\s]/).map(w => w[0]?.toUpperCase() ?? '').join('').slice(0, 2);
            avatar.textContent = initials;

            const tooltip = document.createElement('div');
            tooltip.className = 'collab-avatar-tooltip';
            tooltip.textContent = user.displayName;

            avatar.addEventListener('click', () => {
                const visible = tooltip.classList.toggle('visible');
                if (visible) setTimeout(() => tooltip.classList.remove('visible'), 2000);
            });

            wrapper.appendChild(avatar);
            wrapper.appendChild(tooltip);
            this.presenceContainer.appendChild(wrapper);
        }
        if (others.length > maxShow) {
            const more = document.createElement('div');
            more.className = 'collab-avatar collab-avatar-more';
            more.textContent = `+${others.length - maxShow}`;
            more.title = others.slice(maxShow).map(u => u.displayName).join(', ');
            this.presenceContainer.appendChild(more);
        }
    }

    private toggleCollabChat(): void {
        this.collabChatVisible = !this.collabChatVisible;
        this.collabChatPanel.style.display = this.collabChatVisible ? 'flex' : 'none';
        this.collabChatBtn.classList.toggle('active', this.collabChatVisible);
        if (this.collabChatVisible) {
            const rect = this.collabChatBtn.getBoundingClientRect();
            this.collabChatPanel.style.top = `${rect.bottom + 4}px`;
            this.collabChatPanel.style.right = `${window.innerWidth - rect.right}px`;
            this.unreadCount = 0;
            this.unreadBadge.style.display = 'none';
            setTimeout(() => this.collabChatInput.focus(), 50);
            this.collabChatMessages.scrollTop = this.collabChatMessages.scrollHeight;
        }
    }

    private addCollabChatMessage(msg: CollabChatMsg): void {
        this.collabMessages.push(msg);
        this.collabChatBtn.style.display = '';

        const div = document.createElement('div');
        div.className = 'collab-chat-msg' + (msg.isLocal ? ' collab-chat-msg-local' : '');

        const nameSpan = document.createElement('span');
        nameSpan.className = 'collab-chat-msg-name';
        nameSpan.style.color = msg.color;
        nameSpan.textContent = msg.isLocal ? t('toolbar.you') : msg.sender;

        const textSpan = document.createElement('span');
        textSpan.className = 'collab-chat-msg-text';
        textSpan.textContent = msg.text;

        div.appendChild(nameSpan);
        div.appendChild(textSpan);
        this.collabChatMessages.appendChild(div);
        this.collabChatMessages.scrollTop = this.collabChatMessages.scrollHeight;

        if (!this.collabChatVisible && !msg.isLocal) {
            this.unreadCount++;
            this.unreadBadge.textContent = String(this.unreadCount);
            this.unreadBadge.style.display = '';
        }
    }

    private addCollabSystemMessage(text: string): void {
        const div = document.createElement('div');
        div.className = 'collab-chat-msg collab-chat-msg-system';
        div.textContent = text;
        this.collabChatMessages.appendChild(div);
        this.collabChatMessages.scrollTop = this.collabChatMessages.scrollHeight;
    }
}
