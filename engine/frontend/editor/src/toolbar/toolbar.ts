import { EditorContext } from '../editor_context.js';
import { showModal, showPromptModal, showConfirmModal } from '../widgets/modal.js';
import { icon, Save, Undo2, Redo2, Move, RotateCw, Maximize2, Play, Square, Settings, MousePointer2, Crosshair, Globe, Box } from '../widgets/icons.js';

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

    constructor() {
        this.ctx = EditorContext.instance;
        this.el = document.createElement('div');
        this.el.className = 'toolbar';
        this.build();
        this.bindEvents();

        document.addEventListener('mousedown', (e) => {
            if (this.collabChatVisible &&
                !this.collabChatPanel.contains(e.target as Node) &&
                !this.collabChatBtn.contains(e.target as Node)) {
                this.collabChatVisible = false;
                this.collabChatPanel.style.display = 'none';
                this.collabChatBtn.classList.remove('active');
            }
        });
    }

    private build(): void {
        const logo = document.createElement('img');
        logo.className = 'toolbar-logo';
        logo.src = `${import.meta.env.BASE_URL}logos/main_logo_horizontal.png`;
        logo.alt = 'ParallaxPro';
        logo.title = 'Back to Projects';
        logo.style.cursor = 'pointer';
        logo.addEventListener('click', () => {
            if (this.ctx.state.projectDirty) {
                if (!confirm('You have unsaved changes. Leave without saving?')) return;
            }
            const url = new URL(window.location.href);
            url.searchParams.delete('project');
            window.location.href = url.toString();
        });
        this.el.appendChild(logo);

        this.addSeparator();

        this.projectNameEl = document.createElement('span');
        this.projectNameEl.className = 'toolbar-project-name';
        this.projectNameEl.textContent = 'Untitled Project';
        this.projectNameEl.title = 'Click to rename';
        this.projectNameEl.style.cursor = 'pointer';
        this.projectNameEl.addEventListener('click', () => this.startRenameProject());
        this.el.appendChild(this.projectNameEl);

        this.addSeparator();

        const fileGroup = this.createGroup();
        this.saveBtn = this.createIconButton(Save, 'Save', 'toolbar-btn disabled', () => this.ctx.saveProject());
        this.saveBtn.title = 'Save (Ctrl+S)';
        fileGroup.appendChild(this.saveBtn);

        this.undoBtn = this.createIconButton(Undo2, '', 'toolbar-btn disabled', () => {
            this.ctx.undoManager.undo();
            this.ctx.emit('historyChanged');
            this.ctx.emit('sceneChanged');
            this.ctx.ensurePrimitiveMeshes();
        });
        this.undoBtn.title = 'Undo (Ctrl+Z)';
        fileGroup.appendChild(this.undoBtn);

        this.redoBtn = this.createIconButton(Redo2, '', 'toolbar-btn disabled', () => {
            this.ctx.undoManager.redo();
            this.ctx.emit('historyChanged');
            this.ctx.emit('sceneChanged');
            this.ctx.ensurePrimitiveMeshes();
        });
        this.redoBtn.title = 'Redo (Ctrl+Y / Ctrl+Shift+Z)';
        fileGroup.appendChild(this.redoBtn);

        this.el.appendChild(fileGroup);
        this.addSeparator();

        const transformGroup = this.createGroup();
        this.translateBtn = this.createIconButton(Move, 'Move', 'toolbar-btn active', () => this.ctx.setGizmoMode('translate'));
        this.translateBtn.title = 'Translate (1)';
        transformGroup.appendChild(this.translateBtn);

        this.rotateBtn = this.createIconButton(RotateCw, 'Rotate', 'toolbar-btn', () => this.ctx.setGizmoMode('rotate'));
        this.rotateBtn.title = 'Rotate (2)';
        transformGroup.appendChild(this.rotateBtn);

        this.scaleBtn = this.createIconButton(Maximize2, 'Scale', 'toolbar-btn', () => this.ctx.setGizmoMode('scale'));
        this.scaleBtn.title = 'Scale (3)';
        transformGroup.appendChild(this.scaleBtn);

        this.el.appendChild(transformGroup);
        this.addSeparator();

        const cameraGroup = this.createGroup();
        this.cameraModeBtn = this.createIconButton(MousePointer2, 'Orbit', 'toolbar-btn', () => this.ctx.toggleCameraMode());
        this.cameraModeBtn.title = 'Toggle Orbit / Fly (4)';
        cameraGroup.appendChild(this.cameraModeBtn);

        this.gizmoSpaceBtn = this.createIconButton(Globe, 'Global', 'toolbar-btn', () => this.ctx.toggleGizmoSpace());
        this.gizmoSpaceBtn.title = 'Toggle Global / Local (5)';
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
        this.collabChatBtn.title = 'Team Chat';
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
            <div class="collab-chat-header">Team Chat</div>
            <div class="collab-chat-messages"></div>
            <div class="collab-chat-input-row">
                <input type="text" class="collab-chat-input" placeholder="Type a message..." />
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
        this.playBtn = this.createIconButton(Play, 'Play', 'toolbar-btn play-btn disabled', () => {
            if (this.playBtn.classList.contains('disabled')) return;
            this.ctx.play();
        });
        this.playBtn.title = 'Loading...';
        playGroup.appendChild(this.playBtn);

        this.stopBtn = this.createIconButton(Square, 'Stop', 'toolbar-btn stop-btn', () => this.ctx.stop());
        this.stopBtn.title = 'Stop';
        this.stopBtn.style.display = 'none';
        playGroup.appendChild(this.stopBtn);

        const mpWrapper = document.createElement('div');
        mpWrapper.style.cssText = 'position:relative;display:none;';
        this.mpBtn = document.createElement('button');
        this.mpBtn.className = 'toolbar-btn';
        this.mpBtn.style.cssText = 'font-size:11px;padding:4px 10px;cursor:pointer;white-space:nowrap;';
        this.mpBtn.textContent = 'Multiplayer';
        this.mpBtn.title = 'Multiplayer room link';
        mpWrapper.appendChild(this.mpBtn);

        this.mpDropdown = document.createElement('div');
        this.mpDropdown.style.cssText = 'display:none;position:absolute;top:100%;right:0;margin-top:4px;background:var(--bg-panel,#1e1e2e);border:1px solid var(--border-color,#333);border-radius:6px;padding:10px 14px;min-width:260px;z-index:10001;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
        const mpLabel = document.createElement('div');
        mpLabel.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.5);margin-bottom:4px;';
        mpLabel.textContent = 'Share this link to invite players:';
        this.mpDropdown.appendChild(mpLabel);

        this.mpLinkText = document.createElement('a');
        this.mpLinkText.style.cssText = 'font-size:11px;color:#4fc3f7;word-break:break-all;margin-bottom:6px;display:block;text-decoration:underline;cursor:pointer;';
        (this.mpLinkText as HTMLAnchorElement).target = '_blank';
        this.mpDropdown.appendChild(this.mpLinkText);

        const mpCopyBtn = document.createElement('button');
        mpCopyBtn.textContent = 'Copy Link';
        mpCopyBtn.style.cssText = 'font-size:11px;padding:4px 12px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:white;border-radius:4px;cursor:pointer;width:100%;';
        mpCopyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(this.mpLinkText.textContent || '').then(() => {
                mpCopyBtn.textContent = 'Copied!';
                setTimeout(() => { mpCopyBtn.textContent = 'Copy Link'; }, 1500);
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

        const publishBtn = this.createButton('Publish', '', 'toolbar-btn publish-btn', () => {
            if (this.ctx.state.projectId) this.showPublishModal();
        });
        this.el.appendChild(publishBtn);

        const feedbackBtn = this.createButton('Feedback', '', 'toolbar-btn', () => {
            this.showFeedbackModal();
        });
        this.el.appendChild(feedbackBtn);

        const settingsBtn = this.createIconButton(Settings, '', 'toolbar-btn', () => {
            this.showSettingsModal();
        });
        settingsBtn.title = 'Settings';
        this.el.appendChild(settingsBtn);
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
            span.textContent = isFly ? ' Fly' : ' Orbit';
            this.cameraModeBtn.appendChild(span);
            this.cameraModeBtn.title = isFly ? 'Fly mode (4)' : 'Orbit mode (4)';
            this.cameraModeBtn.classList.toggle('active', isFly);
        });

        this.ctx.on('gizmoSpaceChanged', (space: string) => {
            const isLocal = space === 'local';
            this.gizmoSpaceBtn.innerHTML = '';
            this.gizmoSpaceBtn.appendChild(icon(isLocal ? Box : Globe, 15));
            const span = document.createElement('span');
            span.textContent = isLocal ? ' Local' : ' Global';
            this.gizmoSpaceBtn.appendChild(span);
            this.gizmoSpaceBtn.title = isLocal ? 'Local space (5)' : 'Global space (5)';
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
                this.playBtn.title = 'Play (Ctrl+P)';
                (this as any)._mpWrapper.style.display = 'none';
                this.mpDropdown.style.display = 'none';
            }
        });

        this.ctx.on('multiplayerRoomCreated', (data: any) => {
            const { joinLink } = data;
            this.mpLinkText.textContent = joinLink;
            (this.mpLinkText as HTMLAnchorElement).href = joinLink;
            this.mpPlayerCount.textContent = '1 player connected';
            (this as any)._mpWrapper.style.display = '';
        });
        this.ctx.multiplayer.on('playerJoined', () => {
            const count = this.ctx.multiplayer.remotePlayerCount + 1;
            this.mpPlayerCount.textContent = `${count} player${count !== 1 ? 's' : ''} connected`;
        });
        this.ctx.multiplayer.on('playerLeft', () => {
            const count = this.ctx.multiplayer.remotePlayerCount + 1;
            this.mpPlayerCount.textContent = `${count} player${count !== 1 ? 's' : ''} connected`;
        });

        this.ctx.on('historyChanged', () => {
            this.undoBtn.classList.toggle('disabled', !this.ctx.undoManager.canUndo());
            this.redoBtn.classList.toggle('disabled', !this.ctx.undoManager.canRedo());
        });

        this.ctx.on('dirtyChanged', (dirty: boolean) => {
            const name = this.ctx.state.projectData?.name ?? 'Untitled Project';
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
                this.playBtn.title = 'Play (Ctrl+P)';
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
            const name = this.ctx.state.projectData?.name ?? 'Untitled Project';
            this.projectNameEl.textContent = name;
        });

        this.ctx.on('projectSaved', () => {
            this.showToast('Project saved', 'success');
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
            this.addCollabSystemMessage(`${user.displayName} joined`);
        });

        this.ctx.on('collabUserLeft', (data: { clientId: string; displayName: string }) => {
            this.collabUsers = this.collabUsers.filter(u => u.clientId !== data.clientId);
            this.renderPresence();
            this.addCollabSystemMessage(`${data.displayName} left`);
        });

        this.ctx.on('collabChatMessage', (data: CollabChatMsg) => {
            this.addCollabChatMessage(data);
        });

        this.ctx.backend.onWsMessage('multiplayer_room', (data: any) => {
            const host = data.hostName || 'A collaborator';
            this.showToast(`${host} started a multiplayer session`, 'success');
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

    private createGroup(): HTMLElement {
        const g = document.createElement('div');
        g.className = 'toolbar-group';
        return g;
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
        const currentName = this.ctx.state.projectData?.name ?? 'Untitled Project';
        const newName = await showPromptModal('Rename Project', currentName, 'Project name');
        if (!newName || newName === currentName) return;

        if (this.ctx.state.projectData) {
            this.ctx.state.projectData.name = newName;
        }
        this.projectNameEl.textContent = newName;

        if (this.ctx.state.projectId) {
            try {
                await this.ctx.backend.renameProject(this.ctx.state.projectId, newName);
                this.showToast('Project renamed', 'success');
            } catch (e) {
                console.error('Failed to rename project:', e);
                this.showToast('Rename failed', 'error');
            }
        }
    }

    private showShareModal(): void {
        const projectId = this.ctx.state.projectId;
        if (!projectId) return;

        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

        const addLabel = document.createElement('label');
        addLabel.textContent = 'Add people';
        addLabel.style.cssText = 'font-weight:600;font-size:13px;';
        body.appendChild(addLabel);

        const addRow = document.createElement('div');
        addRow.style.cssText = 'display:flex;gap:8px;align-items:center;';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Email or username';
        input.style.cssText = 'flex:1;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-size:13px;';
        addRow.appendChild(input);

        const permSelect = document.createElement('select');
        permSelect.style.cssText = 'padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-size:13px;';
        permSelect.innerHTML = '<option value="editor">Editor</option><option value="viewer">Viewer</option>';
        addRow.appendChild(permSelect);

        const addBtn = document.createElement('button');
        addBtn.textContent = 'Share';
        addBtn.style.cssText = 'padding:8px 16px;background:#69bbf3;color:#1e1e1e;border:none;border-radius:6px;font-weight:600;cursor:pointer;font-size:13px;';
        addRow.appendChild(addBtn);

        body.appendChild(addRow);

        const statusMsg = document.createElement('div');
        statusMsg.style.cssText = 'font-size:12px;display:none;';
        body.appendChild(statusMsg);

        const listLabel = document.createElement('label');
        listLabel.textContent = 'People with access';
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

                    const textDiv = document.createElement('div');
                    textDiv.innerHTML = `<div style="font-size:13px;font-weight:500;color:var(--text);">${share.email}</div>`;
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
                    removeBtn.title = 'Remove access';
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
                    emptyMsg.textContent = 'Not shared with anyone yet.';
                    emptyMsg.style.cssText = 'font-size:12px;color:var(--text-dim);padding:8px;text-align:center;';
                    listContainer.appendChild(emptyMsg);
                }
            } catch {
                listContainer.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:8px;">Could not load shares.</div>';
            }
        };

        renderShares();

        addBtn.addEventListener('click', async () => {
            const identifier = input.value.trim();
            if (!identifier) {
                statusMsg.textContent = 'Enter an email or username.';
                statusMsg.style.cssText = 'font-size:12px;display:block;color:#e53935;';
                return;
            }
            addBtn.disabled = true;
            addBtn.textContent = '...';
            try {
                const result = await this.ctx.backend.shareProject(projectId, identifier, permSelect.value);
                input.value = '';
                statusMsg.textContent = result.user?.is_stub
                    ? `Invitation email sent to ${result.user.email}`
                    : `Shared with ${result.user?.email || identifier}`;
                statusMsg.style.cssText = 'font-size:12px;display:block;color:#4caf50;';
                renderShares();
            } catch (e: any) {
                statusMsg.textContent = e.message || 'Failed to share.';
                statusMsg.style.cssText = 'font-size:12px;display:block;color:#e53935;';
            } finally {
                addBtn.disabled = false;
                addBtn.textContent = 'Share';
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addBtn.click();
        });

        const { close } = showModal({
            title: 'Share Project',
            body,
            width: '480px',
            buttons: [
                { label: 'Done', primary: true, action: () => close() },
            ],
        });

        input.focus();
    }

    private showFeedbackModal(): void {
        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

        const msgLabel = document.createElement('label');
        msgLabel.textContent = 'What feedback do you have?';
        msgLabel.style.cssText = 'font-weight:600;font-size:13px;';
        body.appendChild(msgLabel);

        const textarea = document.createElement('textarea');
        textarea.placeholder = 'Describe the issue, suggestion, or feedback...';
        textarea.rows = 5;
        textarea.style.cssText = 'width:100%;resize:vertical;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);font-family:inherit;font-size:13px;';
        body.appendChild(textarea);

        // Image upload area
        const imageLabel = document.createElement('label');
        imageLabel.textContent = 'Screenshots (optional, max 5 images, 5MB each)';
        imageLabel.style.cssText = 'font-weight:600;font-size:13px;';
        body.appendChild(imageLabel);

        const imageFiles: File[] = [];
        const previewContainer = document.createElement('div');
        previewContainer.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
        body.appendChild(previewContainer);

        const uploadBtn = document.createElement('button');
        uploadBtn.textContent = '+ Add Image';
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
                    errorMsg.textContent = `${file.name} exceeds 5MB limit.`;
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
            title: 'Send Feedback',
            body,
            width: '480px',
            buttons: [
                { label: 'Cancel', action: () => close() },
                {
                    label: 'Send',
                    primary: true,
                    action: async () => {
                        const msg = textarea.value.trim();
                        if (!msg) {
                            errorMsg.textContent = 'Please enter your feedback.';
                            errorMsg.style.display = 'block';
                            return;
                        }
                        try {
                            await this.ctx.backend.sendFeedback(this.ctx.state.projectId!, msg, imageFiles);
                            close();
                            this.showToast('Feedback sent! Thank you.', 'success');
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

        const nameRow = document.createElement('div');
        nameRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
        const nameLabel = document.createElement('label');
        nameLabel.textContent = 'Project Name';
        nameLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = this.ctx.state.projectData?.name ?? 'Untitled Project';
        nameInput.style.cssText = 'width:100%;height:28px;';
        nameRow.appendChild(nameLabel);
        nameRow.appendChild(nameInput);
        body.appendChild(nameRow);

        const gfxRow = document.createElement('div');
        gfxRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
        const gfxLabel = document.createElement('label');
        gfxLabel.textContent = 'Graphics Quality';
        gfxLabel.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);';
        const gfxSelect = document.createElement('select');
        gfxSelect.style.cssText = 'width:100%;height:28px;';
        const qualities = [
            { value: 'low', label: 'Low', hint: 'Basic rendering, no shadows' },
            { value: 'medium', label: 'Medium', hint: 'Shadows, FXAA anti-aliasing, HBAO' },
            { value: 'high', label: 'High', hint: 'Shadows, MSAA anti-aliasing, HBAO, screen-space reflections, bloom' },
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

        const { close } = showModal({
            title: 'Project Settings',
            body,
            width: '400px',
            closeOnBackdrop: false,
            buttons: [
                { label: 'Cancel', action: () => close() },
                {
                    label: 'Save',
                    primary: true,
                    action: () => {
                        const newName = nameInput.value.trim();
                        if (newName && this.ctx.state.projectData) {
                            this.ctx.state.projectData.name = newName;
                            this.projectNameEl.textContent = newName;
                        }
                        const selectedQuality = gfxSelect.value as 'low' | 'medium' | 'high';
                        localStorage.setItem('graphics_quality', selectedQuality);
                        this.ctx.setGraphicsQuality(selectedQuality);
                        this.ctx.markDirty();
                        close();
                    },
                },
            ],
        });
    }

    private getUsername(): string {
        try {
            const token = localStorage.getItem('auth_token') ?? localStorage.getItem('token');
            if (!token) return '';
            const payload = JSON.parse(atob(token.split('.')[1]));
            return payload.username || '';
        } catch { return ''; }
    }

    private async showPublishModal(): Promise<void> {
        const projectId = this.ctx.state.projectId;
        if (!projectId) return;

        if (this.ctx.state.projectDirty) {
            await this.ctx.saveProject();
        }

        let pubData: any;
        try {
            pubData = await this.ctx.backend.listVersions(projectId);
        } catch {
            pubData = { published: false, versions: [] };
        }

        if (pubData.published) {
            this.showPublishManageModal(pubData);
        } else {
            this.showFirstPublishModal();
        }
    }

    private showFirstPublishModal(): void {
        const projectName = this.ctx.state.projectData?.name ?? 'Untitled Project';
        const autoSlug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
        const owner = this.getUsername();
        const urlPrefix = owner ? `${window.location.host}/play/${owner}/` : `${window.location.host}/play/.../`;

        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex-direction:column;gap:14px;';

        body.appendChild(this.makeField('Game Name', () => {
            const inp = document.createElement('input');
            inp.type = 'text'; inp.value = projectName; inp.placeholder = 'My Awesome Game';
            inp.style.cssText = 'width:100%;height:28px;';
            return inp;
        }));
        const nameInput = body.querySelector('input')!;

        const slugRow = this.makeField('URL Slug', () => {
            const inp = document.createElement('input');
            inp.type = 'text'; inp.value = autoSlug; inp.placeholder = 'my-awesome-game';
            inp.style.cssText = 'width:100%;height:28px;';
            return inp;
        });
        const slugHint = document.createElement('span');
        slugHint.style.cssText = 'font-size:11px;color:var(--text-disabled);';
        slugHint.textContent = `${urlPrefix}${autoSlug || '...'}`;
        slugRow.appendChild(slugHint);
        body.appendChild(slugRow);
        const slugInput = slugRow.querySelector('input')!;

        slugInput.addEventListener('input', () => { slugHint.textContent = `${urlPrefix}${slugInput.value || '...'}`; });
        nameInput.addEventListener('input', () => {
            const s = nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
            slugInput.value = s;
            slugHint.textContent = `${urlPrefix}${s || '...'}`;
        });

        body.appendChild(this.makeField('Version', () => {
            const inp = document.createElement('input');
            inp.type = 'text'; inp.value = '1.0.0'; inp.placeholder = '1.0.0';
            inp.style.cssText = 'width:100%;height:28px;';
            return inp;
        }));
        const versionInput = body.querySelectorAll('input')[2] as HTMLInputElement;

        body.appendChild(this.makeField('Changelog (optional)', () => {
            const ta = document.createElement('textarea');
            ta.placeholder = 'What\'s in this version...';
            ta.style.cssText = 'width:100%;height:60px;resize:vertical;font-family:inherit;font-size:13px;';
            return ta;
        }));
        const changelogInput = body.querySelector('textarea')!;

        const visSelect = document.createElement('select');
        visSelect.style.cssText = 'width:100%;height:28px;';
        visSelect.innerHTML = '<option value="public">Public</option><option value="unlisted">Unlisted</option><option value="private">Private</option>';
        body.appendChild(this.makeField('Visibility', () => visSelect));

        body.appendChild(this.makeThumbnailField());

        const errorMsg = document.createElement('div');
        errorMsg.style.cssText = 'color:#e74c3c;font-size:12px;display:none;';
        body.appendChild(errorMsg);

        const { close } = showModal({
            title: 'Publish Game',
            body, width: '440px', closeOnBackdrop: false,
            buttons: [
                { label: 'Cancel', action: () => close() },
                { label: 'Publish', primary: true, action: async () => {
                    const gameName = nameInput.value.trim();
                    const gameSlug = slugInput.value.trim();
                    const version = versionInput.value.trim();
                    if (!gameName) { errorMsg.textContent = 'Game name is required.'; errorMsg.style.display = 'block'; return; }
                    if (!gameSlug || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(gameSlug)) {
                        errorMsg.textContent = 'Slug must be 3-64 chars, lowercase alphanumeric and hyphens.'; errorMsg.style.display = 'block'; return;
                    }
                    if (!version || !this.isValidSemver(version)) {
                        errorMsg.textContent = 'Enter a valid version (e.g., 1.0.0).'; errorMsg.style.display = 'block'; return;
                    }
                    try {
                        const result = await this.ctx.backend.publishProject(this.ctx.state.projectId!, gameName, gameSlug, visSelect.value, version, changelogInput.value.trim());
                        close();
                        this.showPublishSuccessModal(result);
                    } catch (e: any) {
                        errorMsg.textContent = e.message?.replace(/^API error \d+: /, '') || 'Publish failed.';
                        try { errorMsg.textContent = JSON.parse(e.message?.replace(/^API error \d+: /, '') || '{}').error || errorMsg.textContent; } catch {}
                        errorMsg.style.display = 'block';
                    }
                }},
            ],
        });
    }

    private showPublishManageModal(pubData: any): void {
        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

        const infoSection = document.createElement('div');
        infoSection.style.cssText = 'padding:12px;background:var(--bg-secondary);border-radius:6px;';
        infoSection.innerHTML = `<div style="font-weight:600;font-size:14px;">${pubData.name}</div>
            <div style="font-size:11px;color:var(--text-disabled);">Live: v${pubData.liveVersion} - ${pubData.versions.length} version(s) - ${pubData.visibility}</div>`;
        body.appendChild(infoSection);

        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto;';
        for (const v of pubData.versions) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-secondary);border-radius:4px;';
            row.innerHTML = `<span style="font-weight:600;min-width:60px;">v${v.version}</span>`;
            if (v.isLive) {
                const badge = document.createElement('span');
                badge.textContent = 'LIVE';
                badge.style.cssText = 'background:#27ae60;color:white;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;';
                row.appendChild(badge);
            }
            list.appendChild(row);
        }
        body.appendChild(list);

        const { close } = showModal({
            title: 'Publish',
            body, width: '440px',
            buttons: [{ label: 'Close', action: () => close() }],
        });
    }

    private showPublishSuccessModal(result: any): void {
        const url = result.url || `${window.location.origin}/play/${result.owner}/${result.slug}`;
        const successBody = document.createElement('div');
        successBody.style.cssText = 'display:flex;flex-direction:column;gap:12px;';
        const msg = document.createElement('div');
        msg.textContent = `Version ${result.version} is now live!`;
        msg.style.cssText = 'font-size:14px;color:var(--text-primary);';
        successBody.appendChild(msg);
        const link = document.createElement('a');
        link.href = url; link.target = '_blank'; link.textContent = url;
        link.style.cssText = 'font-size:13px;color:var(--accent);word-break:break-all;';
        successBody.appendChild(link);
        const { close } = showModal({
            title: 'Published!', body: successBody, width: '420px',
            buttons: [{ label: 'Done', primary: true, action: () => close() }],
        });
    }

    private makeField(label: string, createInput: () => HTMLElement): HTMLElement {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
        const lbl = document.createElement('label');
        lbl.textContent = label;
        lbl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);';
        row.appendChild(lbl);
        row.appendChild(createInput());
        return row;
    }

    private makeThumbnailField(): HTMLElement {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
        const lbl = document.createElement('label');
        lbl.textContent = 'Thumbnail (optional)';
        lbl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-secondary);';
        row.appendChild(lbl);

        const inner = document.createElement('div');
        inner.style.cssText = 'display:flex;align-items:center;gap:10px;';

        const thumbPreview = document.createElement('div');
        thumbPreview.style.cssText = 'width:120px;height:68px;border-radius:4px;border:1px dashed var(--border);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;background:var(--bg-secondary);';

        const currentThumb = this.ctx.state.projectData?.thumbnail as string | null;
        if (currentThumb) {
            const img = document.createElement('img');
            img.src = currentThumb;
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
            thumbPreview.appendChild(img);
        } else {
            const ph = document.createElement('span');
            ph.textContent = 'No image';
            ph.style.cssText = 'font-size:11px;color:var(--text-disabled);';
            thumbPreview.appendChild(ph);
        }
        inner.appendChild(thumbPreview);

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
        fileInput.style.display = 'none';

        const uploadBtn = document.createElement('button');
        uploadBtn.textContent = currentThumb ? 'Change' : 'Upload';
        uploadBtn.style.cssText = 'padding:4px 12px;font-size:12px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);cursor:pointer;';
        uploadBtn.addEventListener('click', (e) => { e.preventDefault(); fileInput.click(); });

        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file || !this.ctx.state.projectId) return;
            try {
                const result = await this.ctx.backend.uploadThumbnail(this.ctx.state.projectId, file);
                if (this.ctx.state.projectData) this.ctx.state.projectData.thumbnail = result.thumbnail;
                thumbPreview.innerHTML = '';
                const img = document.createElement('img');
                img.src = result.thumbnail;
                img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
                thumbPreview.appendChild(img);
                uploadBtn.textContent = 'Change';
            } catch (e: any) {
                alert(e.message || 'Failed to upload thumbnail.');
            }
            fileInput.value = '';
        });

        inner.appendChild(uploadBtn);
        inner.appendChild(fileInput);
        row.appendChild(inner);
        return row;
    }

    private isValidSemver(v: string): boolean {
        const parts = v.split('.').map(Number);
        if (parts.length < 1 || parts.length > 3) return false;
        return parts.every(p => !isNaN(p) && p >= 0 && Number.isInteger(p));
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
        nameSpan.textContent = msg.isLocal ? 'You' : msg.sender;

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
