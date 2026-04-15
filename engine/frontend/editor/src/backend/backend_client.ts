import { redirectToLogin } from '../main.js';
import { getStoredToken as getCliToken, clearStoredToken as clearCliToken } from './auth_session.js';

// Absolute origin for the hosted production backend. When the editor is
// running on localhost the publish flow talks directly to this origin so
// games show up on parallaxpro.ai, not in the user's local DB.
const PROD_ORIGIN = 'https://parallaxpro.ai';

function isSelfHostedOrigin(): boolean {
    const h = window.location.hostname;
    return h !== 'parallaxpro.ai' && h !== 'www.parallaxpro.ai';
}

export class AuthRequiredError extends Error {
    constructor() { super('Authentication required'); this.name = 'AuthRequiredError'; }
}

export class ApiError extends Error {
    status: number;
    payload: any;
    constructor(message: string, status: number, payload: any) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.payload = payload;
    }
}

export class BackendClient {
    private baseUrl: string;
    private ws: WebSocket | null = null;
    private wsMessageHandlers: Map<string, ((data: any) => void)[]> = new Map();
    private reconnectTimer: number = 0;
    private reconnectAttempts: number = 0;
    private _connected: boolean = false;

    constructor(apiBasePath: string = '/api/engine') {
        this.baseUrl = apiBasePath;
    }

    getBaseUrl(): string {
        return this.baseUrl.replace('/api/engine', '');
    }

    get isConnected(): boolean {
        return this._connected;
    }

    get isSelfHosted(): boolean {
        return isSelfHostedOrigin();
    }

    private getAuthToken(): string | null {
        // fetchProd targets parallaxpro.ai. Use the cli-login token (stored
        // under a dedicated key on self-hosted setups, or the hosted
        // auth_token on parallaxpro.ai itself) — NOT the local backend's
        // session token, which would fail verification against prod's JWT
        // secret.
        return getCliToken();
    }

    async listProjects(): Promise<any[]> {
        const all: any[] = [];
        let page = 1;
        while (true) {
            const res = await this.fetch(`/projects?page=${page}&limit=100`);
            const batch = res.projects ?? [];
            all.push(...batch);
            if (batch.length < 100 || all.length >= (res.total ?? Infinity)) break;
            page++;
        }
        return all;
    }

    async loadProject(projectId: string): Promise<any> {
        return this.fetch(`/projects/${projectId}`);
    }

    async listTemplates(search?: string): Promise<any> {
        const params = search ? `?search=${encodeURIComponent(search)}` : '';
        return this.fetch(`/projects/templates${params}`);
    }

    async createProject(name?: string, prompt?: string, templateId?: string): Promise<any> {
        return this.fetch('/projects', {
            method: 'POST',
            body: JSON.stringify({ name, prompt, templateId }),
        });
    }

    async deleteProject(projectId: string): Promise<void> {
        await this.fetch(`/projects/${projectId}`, { method: 'DELETE' });
    }

    async renameProject(projectId: string, newName: string): Promise<any> {
        return this.fetch(`/projects/${projectId}`, {
            method: 'PUT',
            body: JSON.stringify({ name: newName }),
        });
    }

    async duplicateProject(projectId: string): Promise<any> {
        return this.fetch(`/projects/${projectId}/duplicate`, { method: 'POST' });
    }

    async saveProject(projectId: string, data: any): Promise<any> {
        return this.fetch(`/projects/${projectId}/files`, {
            method: 'PUT',
            body: JSON.stringify({ files: data }),
        });
    }

    async publishProject(projectId: string, name: string, slug: string, visibility: string, version: string, changelog?: string): Promise<any> {
        return this.fetch(`/projects/${projectId}/publish`, {
            method: 'POST',
            body: JSON.stringify({ name, slug, visibility, version, changelog }),
        });
    }

    async unpublishProject(projectId: string): Promise<any> {
        return this.fetch(`/projects/${projectId}/publish`, { method: 'DELETE' });
    }

    async updatePublishSettings(projectId: string, name: string, slug: string, visibility: string): Promise<any> {
        return this.fetch(`/projects/${projectId}/publish`, {
            method: 'PUT',
            body: JSON.stringify({ name, slug, visibility }),
        });
    }

    async listVersions(projectId: string): Promise<any> {
        return this.fetch(`/projects/${projectId}/versions`);
    }

    async setLiveVersion(projectId: string, versionId: string): Promise<any> {
        return this.fetch(`/projects/${projectId}/set-live-version`, {
            method: 'POST',
            body: JSON.stringify({ versionId }),
        });
    }

    async revertToVersion(projectId: string, versionId: string): Promise<any> {
        return this.fetch(`/projects/${projectId}/revert-to-version`, {
            method: 'POST',
            body: JSON.stringify({ versionId }),
        });
    }

    async sendFeedback(projectId: string, message: string, images: File[]): Promise<any> {
        const formData = new FormData();
        formData.append('message', message);
        for (const file of images) {
            formData.append('images', file);
        }

        const hostname = window.location.hostname;
        const isHosted = hostname === 'parallaxpro.ai' || hostname === 'www.parallaxpro.ai';

        if (isHosted) {
            const token = localStorage.getItem('auth_token') ?? localStorage.getItem('token');
            const res = await window.fetch(`${this.baseUrl}/projects/${projectId}/feedback`, {
                method: 'POST',
                headers: token ? { 'Authorization': `Bearer ${token}` } : {},
                body: formData,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`API error ${res.status}: ${text}`);
            }
            return res.json();
        } else {
            // Self-hosted: send feedback to parallaxpro.ai
            formData.append('source', 'self-hosted');
            formData.append('origin', window.location.origin);
            const res = await window.fetch('https://parallaxpro.ai/api/engine/feedback', {
                method: 'POST',
                body: formData,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`API error ${res.status}: ${text}`);
            }
            return res.json();
        }
    }

    async shareProject(projectId: string, identifier: string, permission: string = 'editor'): Promise<any> {
        return this.fetch(`/projects/${projectId}/share`, {
            method: 'POST',
            body: JSON.stringify({ identifier, permission }),
        });
    }

    async getProjectShares(projectId: string): Promise<any> {
        return this.fetch(`/projects/${projectId}/shares`);
    }

    async removeProjectShare(projectId: string, userId: number): Promise<void> {
        await this.fetch(`/projects/${projectId}/share/${userId}`, { method: 'DELETE' });
    }

    async listSharedProjects(): Promise<any[]> {
        const res = await this.fetch('/projects/shared');
        return res.projects ?? [];
    }

    async deleteVersion(projectId: string, versionId: string): Promise<any> {
        return this.fetch(`/projects/${projectId}/versions/${versionId}`, { method: 'DELETE' });
    }

    async getPublishInfo(): Promise<Record<string, { publishedSlug: string; publishedOwner: string; publishedVersion: string; visibility: string }>> {
        try {
            const res = await this.fetch('/projects/publish-info');
            return res.info ?? {};
        } catch {
            return {};
        }
    }

    async uploadThumbnail(projectId: string, file: File): Promise<{ success: boolean; thumbnail: string }> {
        if (file.size > 5 * 1024 * 1024) {
            throw new Error('Image must be under 5 MB.');
        }
        const token = localStorage.getItem('auth_token') ?? localStorage.getItem('token');
        const formData = new FormData();
        formData.append('thumbnail', file);
        const res = await window.fetch(`${this.baseUrl}/projects/${projectId}/thumbnail`, {
            method: 'POST',
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
            body: formData,
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`API error ${res.status}: ${err}`);
        }
        return res.json();
    }

    async deleteThumbnail(projectId: string): Promise<void> {
        await this.fetch(`/projects/${projectId}/thumbnail`, { method: 'DELETE' });
    }

    async searchAssets(opts: { search?: string; category?: string; source?: string; pack?: string; page?: number; limit?: number }): Promise<any> {
        const params = new URLSearchParams();
        if (opts.search) params.set('search', opts.search);
        if (opts.category) params.set('category', opts.category);
        if (opts.source) params.set('source', opts.source);
        if (opts.pack) params.set('pack', opts.pack);
        if (opts.page) params.set('page', String(opts.page));
        if (opts.limit) params.set('limit', String(opts.limit));
        return this.fetch(`/assets?${params.toString()}`);
    }

    async getAssetCategories(): Promise<{ name: string; count: number }[]> {
        const res = await this.fetch('/assets/categories');
        return res.categories ?? [];
    }

    async browseAssets(category: string, source?: string): Promise<any> {
        const params = new URLSearchParams({ category });
        if (source) params.set('source', source);
        return this.fetch(`/assets/browse?${params.toString()}`);
    }

    /**
     * Fetch against the hosted production backend (parallaxpro.ai) directly
     * instead of the local backend proxy. Used by the publish-from-local
     * flow so self-hosted editors can publish games to the hosted site.
     *
     * - Throws `AuthRequiredError` when no token is available (caller should
     *   run the auth popup and retry).
     * - Surfaces the parsed JSON `{error, message, ...}` on non-2xx so UI
     *   can branch on engine-hash errors etc.
     */
    async fetchProd(path: string, options?: RequestInit): Promise<any> {
        const token = this.getAuthToken();
        if (!token) throw new AuthRequiredError();
        const headers: Record<string, string> = {
            ...(options?.headers as Record<string, string> ?? {}),
            Authorization: `Bearer ${token}`,
        };
        // Only set JSON content-type when the body is a string (JSON) — for
        // FormData we must not set it so the browser picks the right
        // multipart boundary.
        if (options?.body && typeof options.body === 'string' && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
        const res = await window.fetch(`${PROD_ORIGIN}/api/engine${path}`, { ...options, headers });
        const ct = res.headers.get('content-type') || '';
        const body = ct.includes('application/json') ? await res.json().catch(() => ({})) : await res.text().catch(() => '');
        if (res.status === 401) {
            clearCliToken();
            throw new AuthRequiredError();
        }
        if (!res.ok) {
            const err = new ApiError(
                typeof body === 'object' && body?.error ? String(body.error) : `HTTP ${res.status}`,
                res.status,
                typeof body === 'object' ? body : null,
            );
            throw err;
        }
        return body;
    }

    /** Publish a local project straight to parallaxpro.ai (requires auth token). */
    async publishFromLocal(opts: {
        name: string;
        slug: string;
        visibility: string;
        version: string;
        changelog?: string;
        projectData: unknown;
        engineGitHash: string;
        thumbnail?: File | null;
    }): Promise<{ success: true; projectId: string; gameId: string; slug: string; owner: string; version: string; url: string }> {
        const fd = new FormData();
        fd.append('name', opts.name);
        fd.append('slug', opts.slug);
        fd.append('visibility', opts.visibility);
        fd.append('version', opts.version);
        if (opts.changelog) fd.append('changelog', opts.changelog);
        fd.append('engineGitHash', opts.engineGitHash);
        fd.append('projectData', JSON.stringify(opts.projectData));
        if (opts.thumbnail) fd.append('thumbnail', opts.thumbnail);
        return this.fetchProd('/projects/publish-from-local', { method: 'POST', body: fd });
    }

    async listVersionsProd(prodProjectId: string): Promise<any> {
        return this.fetchProd(`/projects/${prodProjectId}/versions`);
    }

    async unpublishProd(prodProjectId: string): Promise<any> {
        return this.fetchProd(`/projects/${prodProjectId}/publish`, { method: 'DELETE' });
    }

    async updatePublishSettingsProd(prodProjectId: string, name: string, slug: string, visibility: string): Promise<any> {
        return this.fetchProd(`/projects/${prodProjectId}/publish`, {
            method: 'PUT',
            body: JSON.stringify({ name, slug, visibility }),
        });
    }

    async setLiveVersionProd(prodProjectId: string, versionId: string): Promise<any> {
        return this.fetchProd(`/projects/${prodProjectId}/set-live-version`, {
            method: 'POST',
            body: JSON.stringify({ versionId }),
        });
    }

    async uploadThumbnailProd(prodProjectId: string, file: File): Promise<{ success: boolean; thumbnail: string }> {
        if (file.size > 5 * 1024 * 1024) throw new Error('Image must be under 5 MB.');
        const fd = new FormData();
        fd.append('thumbnail', file);
        return this.fetchProd(`/projects/${prodProjectId}/thumbnail`, { method: 'POST', body: fd });
    }

    async getEngineBundles(): Promise<{ latestHash: string | null; latestSemver: string | null; bundles: { hash: string; semver: string | null; status: string; addedAt: string }[] }> {
        const res = await window.fetch(`${PROD_ORIGIN}/api/engine/engine-bundles`);
        if (!res.ok) throw new Error(`Failed to load engine bundle registry (${res.status})`);
        return res.json();
    }

    private async fetch(path: string, options?: RequestInit): Promise<any> {
        const token = localStorage.getItem('auth_token') ?? localStorage.getItem('token');
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        const res = await window.fetch(`${this.baseUrl}${path}`, {
            ...options,
            headers: { ...headers, ...(options?.headers as Record<string, string> ?? {}) },
        });

        if (res.status === 401) {
            localStorage.removeItem('auth_token');
            localStorage.removeItem('token');
            redirectToLogin();
            throw new Error('Authentication expired');
        }

        if (res.status === 403) {
            throw new Error('Access denied: you do not own this project');
        }

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`API error ${res.status}: ${text}`);
        }

        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            return res.json();
        }
        return {};
    }

    connectWebSocket(projectId: string): void {
        this.disconnectWebSocket();
        this.reconnectAttempts = 0;
        this._connected = false;
        this._openWebSocket(projectId);
    }

    private async _openWebSocket(projectId: string): Promise<void> {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

        // Get a short-lived ticket instead of putting the JWT in the URL
        let wsParam = '';
        try {
            const res = await this.fetch('/ws-ticket', { method: 'POST' });
            if (res.ticket) {
                wsParam = `ticket=${res.ticket}`;
            }
        } catch {
            // Fallback to token in URL (dev mode or if ticket endpoint unavailable)
            const token = localStorage.getItem('auth_token') ?? localStorage.getItem('token') ?? '';
            wsParam = `token=${token}`;
        }

        const url = `${protocol}//${window.location.host}/ws/engine?project=${projectId}&${wsParam}`;

        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            const wasReconnect = this.reconnectAttempts > 0;
            this.reconnectAttempts = 0;
            this._connected = true;
            if (wasReconnect) {
                this._fireHandlers('__ws_reconnected', {});
            }
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                const type = msg.type as string;
                const handlers = this.wsMessageHandlers.get(type);
                if (handlers) {
                    for (const h of handlers) {
                        h(msg.data);
                    }
                }
            } catch (e) {
                console.error('[BackendClient] Failed to parse ws message:', e);
            }
        };

        this.ws.onclose = (event) => {
            if (event.code === 4001) {
                localStorage.removeItem('auth_token');
                localStorage.removeItem('token');
                redirectToLogin();
                return;
            }
            if (event.code === 4003) {
                console.error('[BackendClient] Access denied to project');
                return;
            }
            if (this._connected) {
                this._connected = false;
                this._fireHandlers('__ws_disconnected', {});
            }
            this._scheduleReconnect(projectId);
        };

        this.ws.onerror = (err) => {
            console.error('[BackendClient] WebSocket error:', err);
        };
    }

    disconnectWebSocket(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = 0;
        }
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
            this.ws = null;
        }
        this._connected = false;
    }

    onWsMessage(type: string, handler: (data: any) => void): void {
        if (!this.wsMessageHandlers.has(type)) {
            this.wsMessageHandlers.set(type, []);
        }
        this.wsMessageHandlers.get(type)!.push(handler);
    }

    sendWsMessage(type: string, data: any): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type, data }));
        }
    }

    sendChatMessage(message: string, agent?: string, chatAgent?: string, editingAgent?: string): void {
        const payload: { content: string; agent?: string; chatAgent?: string; editingAgent?: string } = { content: message };
        if (agent) payload.agent = agent;
        if (chatAgent) payload.chatAgent = chatAgent;
        if (editingAgent) payload.editingAgent = editingAgent;
        this.sendWsMessage('chat_message', payload);
    }

    sendFileSave(path: string, content: string): void {
        this.sendWsMessage('file_save', { path, content });
    }

    sendListSessions(): void {
        this.sendWsMessage('list_chat_sessions', {});
    }

    sendSwitchSession(sessionId: string): void {
        this.sendWsMessage('switch_chat_session', { sessionId });
    }

    sendRevertToMessage(messageId: number): void {
        this.sendWsMessage('revert_to_message', { messageId });
    }

    sendRevertToBeforeMessage(messageId: number): void {
        this.sendWsMessage('revert_to_before_message', { messageId });
    }

    sendCollabSceneSync(scenes: Record<string, any>): void {
        this.sendWsMessage('collab_scene_sync', { scenes });
    }

    sendCollabChat(text: string): void {
        this.sendWsMessage('collab_chat_message', { text });
    }

    sendCollabCursor(selectedEntity: string | null): void {
        this.sendWsMessage('collab_cursor', { selectedEntity });
    }

    private _fireHandlers(type: string, data: any): void {
        const handlers = this.wsMessageHandlers.get(type);
        if (handlers) {
            for (const h of handlers) {
                h(data);
            }
        }
    }

    private _scheduleReconnect(projectId: string): void {
        if (this.reconnectAttempts >= 10) {
            this._fireHandlers('__ws_reconnect_failed', {});
            return;
        }
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        this._fireHandlers('__ws_reconnecting', { attempt: this.reconnectAttempts, maxAttempts: 10 });
        this.reconnectTimer = window.setTimeout(() => {
            this._openWebSocket(projectId);
        }, delay);
    }
}
