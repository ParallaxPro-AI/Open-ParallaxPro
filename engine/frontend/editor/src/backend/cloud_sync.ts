/**
 * Cloud sync glue for self-hosted editors: every save on a cloud
 * project gets debounced + pushed to parallaxpro.ai. Pulls happen
 * lazily (when a cloud project is opened or the Cloud tab is shown).
 *
 * The BackendClient handles the actual HTTP; this module owns the
 * debounce queue, coalesces rapid saves, and turns server responses
 * into events the UI can subscribe to:
 *
 *   on('pushing',      ({projectId}))           — push started
 *   on('pushed',       ({projectId, updatedAt}))— push succeeded
 *   on('conflict',     ({projectId, payload}))  — 409 from server
 *   on('auth_required',({projectId}))           — token missing/expired
 *   on('error',        ({projectId, payload}))  — network / 5xx
 *
 * The UI listens for 'conflict' → renders the resolution modal and
 * hands control back via forcePush() or dropLocalState().
 */

import type { BackendClient } from './backend_client.js';
import { ApiError, AuthRequiredError } from './backend_client.js';
import { getStoredToken, decodeToken } from './auth_session.js';

const DEBOUNCE_MS = 2000;

type Listener = (e: any) => void;

interface PushState {
    timer: number;
    inFlight: boolean;
    queuedAgain: boolean;
}

function absoluteThumbnail(url: string | null | undefined): string | null {
    if (!url) return null;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return `https://parallaxpro.ai${url}`;
}

export class CloudSync {
    private backend: BackendClient;
    private pushStates: Map<string, PushState> = new Map();
    private listeners: Map<string, Listener[]> = new Map();

    constructor(backend: BackendClient) {
        this.backend = backend;
    }

    on(event: string, listener: Listener): void {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event)!.push(listener);
    }

    private emit(event: string, payload: any): void {
        (this.listeners.get(event) || []).forEach((l) => {
            try { l(payload); } catch (e) { console.error('[cloudSync] listener error', e); }
        });
    }

    /** Return the prod user id from the stored cli-login JWT, or null. */
    currentUserId(): number | null {
        const token = getStoredToken();
        const payload = token ? decodeToken(token) : null;
        return payload?.id ?? null;
    }

    /**
     * Debounced push. Safe to call on every keystroke — only one push
     * per DEBOUNCE_MS window, with follow-up saves coalesced until the
     * in-flight request returns.
     */
    schedulePush(projectId: string): void {
        if (!projectId) return;
        if (!this.currentUserId()) return; // not logged in, skip silently
        let st = this.pushStates.get(projectId);
        if (!st) {
            st = { timer: 0, inFlight: false, queuedAgain: false };
            this.pushStates.set(projectId, st);
        }
        if (st.inFlight) {
            st.queuedAgain = true;
            return;
        }
        if (st.timer) window.clearTimeout(st.timer);
        st.timer = window.setTimeout(() => this.flush(projectId), DEBOUNCE_MS);
    }

    /** Force the queued push to run right now (e.g. before window unload). */
    async flushNow(projectId: string): Promise<void> {
        const st = this.pushStates.get(projectId);
        if (!st || st.inFlight) return;
        if (st.timer) { window.clearTimeout(st.timer); st.timer = 0; }
        await this.flush(projectId);
    }

    /** Force-push, ignoring OCC. Called by the conflict resolution modal. */
    async forcePush(projectId: string): Promise<void> {
        await this.doPush(projectId, { force: true });
    }

    private async flush(projectId: string): Promise<void> {
        const st = this.pushStates.get(projectId);
        if (!st) return;
        st.timer = 0;
        st.inFlight = true;
        try {
            this.emit('pushing', { projectId });
            await this.doPush(projectId, {});
        } catch {
            // Error already emitted in doPush; swallow so the queue survives.
        } finally {
            st.inFlight = false;
            if (st.queuedAgain) {
                st.queuedAgain = false;
                this.schedulePush(projectId);
            }
        }
    }

    private async doPush(projectId: string, opts: { force?: boolean }): Promise<void> {
        const userId = this.currentUserId();
        if (!userId) { this.emit('auth_required', { projectId }); return; }
        const engineGitHash = typeof __ENGINE_GIT_HASH__ !== 'undefined' ? __ENGINE_GIT_HASH__ : 'unknown';

        let proj: any;
        try {
            proj = await this.backend.loadProject(projectId);
        } catch (e) {
            this.emit('error', { projectId, payload: e });
            throw e;
        }
        if (!proj?.isCloud) return; // no longer cloud; bail quietly

        try {
            const res = await this.backend.cloudUpsertProd({
                id: projectId,
                name: proj.name,
                projectData: { projectConfig: proj.projectConfig ?? { name: proj.name }, files: proj.files ?? {} },
                expectedUpdatedAt: opts.force ? null : proj.cloudPulledUpdatedAt ?? null,
                engineGitHash,
                force: !!opts.force,
            });
            await this.backend.markCloudLocal(projectId, {
                cloudUserId: userId,
                cloudUpdatedAt: res.updatedAt,
                editedEngineHash: res.editedEngineHash ?? engineGitHash,
                thumbnail: absoluteThumbnail(res.thumbnail),
            });
            this.emit('pushed', { projectId, updatedAt: res.updatedAt });
        } catch (e: any) {
            if (e instanceof ApiError && e.payload?.error === 'conflict') {
                this.emit('conflict', { projectId, payload: e.payload });
                throw e;
            }
            if (e instanceof AuthRequiredError) {
                this.emit('auth_required', { projectId });
                throw e;
            }
            this.emit('error', { projectId, payload: e });
            throw e;
        }
    }

    /** Pull prod state for a project into the local backend. Upserts
     *  the row and marks it cloud so subsequent saves push. */
    async pull(projectId: string): Promise<{ updatedAt: string; editedEngineHash: string | null } | null> {
        const userId = this.currentUserId();
        if (!userId) { this.emit('auth_required', { projectId }); return null; }

        let remote: any;
        try {
            remote = await this.backend.loadProjectProd(projectId);
        } catch (e: any) {
            if (e instanceof AuthRequiredError) { this.emit('auth_required', { projectId }); return null; }
            throw e;
        }
        await this.backend.cloudPullLocal(projectId, {
            name: remote.name,
            projectConfig: remote.projectConfig ?? { name: remote.name },
            files: remote.files ?? {},
            thumbnail: absoluteThumbnail(remote.thumbnail),
            cloudUpdatedAt: remote.updatedAt,
            cloudUserId: userId,
            editedEngineHash: remote.editedEngineHash ?? null,
        });
        this.emit('pulled', { projectId, updatedAt: remote.updatedAt });
        return { updatedAt: remote.updatedAt, editedEngineHash: remote.editedEngineHash ?? null };
    }

    /** Called after local uploads a thumbnail on a cloud project. */
    async pushThumbnail(projectId: string, file: File): Promise<void> {
        try {
            const res = await this.backend.cloudThumbnailProd(projectId, file);
            // prod's updated_at bumps on thumbnail too; resync local so
            // the next full push isn't rejected as a conflict.
            const userId = this.currentUserId();
            if (userId) {
                await this.backend.markCloudLocal(projectId, {
                    cloudUserId: userId,
                    cloudUpdatedAt: res.updatedAt,
                    thumbnail: absoluteThumbnail(res.thumbnail),
                });
            }
            this.emit('pushed', { projectId, updatedAt: res.updatedAt });
        } catch (e) {
            this.emit('error', { projectId, payload: e });
            throw e;
        }
    }
}
