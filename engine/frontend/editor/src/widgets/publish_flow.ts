/**
 * Unified publish UX. Both the toolbar's Publish button and the
 * project list's "Publish" menu item route through here so users
 * see one consistent modal with the same validation, thumbnail
 * picker, manage-versions screen, and engine-hash warnings.
 *
 * Each call to `new PublishFlow(ctx).open(projectId, meta)` is its
 * own session — the pending-thumbnail File only lives for as long
 * as that modal is open.
 */

import type { EditorContext } from '../editor_context.js';
import { ApiError, AuthRequiredError } from '../backend/backend_client.js';
import { ensureLoggedIn, clearStoredToken } from '../backend/auth_session.js';
import { showModal } from './modal.js';

export interface PublishProjectMeta {
    id?: string;
    name?: string | null;
    thumbnail?: string | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

function isValidSemver(v: string): boolean {
    const parts = v.split('.').map(Number);
    if (parts.length < 1 || parts.length > 3) return false;
    return parts.every((p) => !isNaN(p) && p >= 0 && Number.isInteger(p));
}

function toast(message: string, type: 'success' | 'error' | 'info'): void {
    let container = document.querySelector('.toast-container') as HTMLElement;
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}

function getUsernameFromToken(): string {
    try {
        const token = localStorage.getItem('pp_cli_token')
            ?? localStorage.getItem('auth_token')
            ?? localStorage.getItem('token');
        if (!token) return '';
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.username || '';
    } catch { return ''; }
}

export class PublishFlow {
    private ctx: EditorContext;
    private _pendingThumbnail: File | null = null;

    constructor(ctx: EditorContext) {
        this.ctx = ctx;
    }

    /** Entry point. Ensures auth on self-hosted, saves pending edits
     *  if the project is currently open, then routes to first-publish
     *  or manage based on whether the server already has a published
     *  game at this id. */
    async open(projectId: string, meta: PublishProjectMeta = {}): Promise<void> {
        if (!projectId) return;
        this._pendingThumbnail = null;

        // If the user is currently editing THIS project, flush unsaved
        // work first so the publish snapshot matches what they see.
        if (this.ctx.state.projectId === projectId && this.ctx.state.projectDirty) {
            await this.ctx.saveProject();
        }

        if (this.ctx.backend.isSelfHosted) {
            try {
                await ensureLoggedIn();
            } catch (e: any) {
                toast(e?.message || 'Sign-in cancelled.', 'error');
                return;
            }
        }

        let pubData: any;
        try {
            if (this.ctx.backend.isSelfHosted) {
                try {
                    pubData = await this.ctx.backend.listVersionsProd(projectId);
                } catch (e: any) {
                    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
                        pubData = { published: false, versions: [] };
                    } else if (e instanceof AuthRequiredError) {
                        clearStoredToken();
                        toast('Your session expired. Try publishing again.', 'error');
                        return;
                    } else {
                        throw e;
                    }
                }
            } else {
                pubData = await this.ctx.backend.listVersions(projectId);
            }
        } catch (e: any) {
            pubData = { published: false, versions: [] };
            console.warn('[Publish] failed to fetch publish state:', e?.message ?? e);
        }

        if (pubData.published) {
            this.showManageModal(projectId, pubData);
        } else {
            this.showFirstPublishModal(projectId, meta);
        }
    }

    // ── Modals ────────────────────────────────────────────────────────

    private showFirstPublishModal(projectId: string, meta: PublishProjectMeta): void {
        const projectName = meta.name ?? 'Untitled Project';
        const autoSlug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
        const owner = getUsernameFromToken();
        const host = this.ctx.backend.isSelfHosted ? 'parallaxpro.ai' : window.location.host;
        const urlPrefix = owner ? `${host}/games/${owner}/` : `${host}/games/.../`;

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
        visSelect.innerHTML = '<option value="public">Public</option><option value="unlisted">Unlisted</option>';
        body.appendChild(this.makeField('Visibility', () => visSelect));

        body.appendChild(this.makeThumbnailField(projectId, meta.thumbnail ?? null));

        const errorMsg = document.createElement('div');
        errorMsg.style.cssText = 'color:#e74c3c;font-size:12px;display:none;';
        body.appendChild(errorMsg);

        const { close } = showModal({
            title: 'Publish Game',
            body, width: '440px', closeOnBackdrop: false,
            buttons: [
                { label: 'Cancel', action: () => close() },
                {
                    label: 'Publish', primary: true, action: async () => {
                        const gameName = nameInput.value.trim();
                        const gameSlug = slugInput.value.trim();
                        const version = versionInput.value.trim();
                        if (!gameName) { errorMsg.textContent = 'Game name is required.'; errorMsg.style.display = 'block'; return; }
                        if (!gameSlug || !SLUG_RE.test(gameSlug)) {
                            errorMsg.textContent = 'Slug must be 3-64 chars, lowercase alphanumeric and hyphens.'; errorMsg.style.display = 'block'; return;
                        }
                        if (!version || !isValidSemver(version)) {
                            errorMsg.textContent = 'Enter a valid version (e.g., 1.0.0).'; errorMsg.style.display = 'block'; return;
                        }
                        try {
                            const result = await this.submit(projectId, {
                                name: gameName, slug: gameSlug, visibility: visSelect.value,
                                version, changelog: changelogInput.value.trim(),
                            });
                            close();
                            this.ctx.emit('projectPublished', { projectId, ...result });
                            this.showSuccessModal(result);
                        } catch (e: any) {
                            if (e?.__engineMismatchHandled) { close(); return; }
                            errorMsg.textContent = e.message?.replace(/^API error \d+: /, '') || 'Publish failed.';
                            try { errorMsg.textContent = JSON.parse(e.message?.replace(/^API error \d+: /, '') || '{}').error || errorMsg.textContent; } catch {}
                            errorMsg.style.display = 'block';
                        }
                    },
                },
            ],
        });
    }

    private showManageModal(projectId: string, pubData: any): void {
        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

        const infoSection = document.createElement('div');
        infoSection.style.cssText = 'padding:12px;background:var(--bg-secondary);border-radius:6px;';
        const origin = this.ctx.backend.isSelfHosted ? 'https://parallaxpro.ai' : window.location.origin;
        const gameUrl = `${origin}/games/${pubData.owner}/${pubData.slug}`;
        infoSection.innerHTML = `<div style="font-weight:600;font-size:14px;">${pubData.name}</div>
            <div style="font-size:11px;color:var(--text-disabled);margin-top:4px;">Live: v${pubData.liveVersion} &middot; ${pubData.versions.length} version(s) &middot; ${pubData.visibility}</div>
            <a href="${gameUrl}" target="_blank" style="font-size:11px;color:var(--accent);text-decoration:none;">${gameUrl}</a>`;
        body.appendChild(infoSection);

        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;';

        const buildVersionList = () => {
            list.innerHTML = '';
            for (const v of pubData.versions) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-secondary);border-radius:4px;';

                const label = document.createElement('span');
                label.style.cssText = 'font-weight:600;min-width:60px;';
                label.textContent = `v${v.version}`;
                row.appendChild(label);

                if (v.isLive) {
                    const badge = document.createElement('span');
                    badge.textContent = 'LIVE';
                    badge.style.cssText = 'background:#27ae60;color:white;font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;';
                    row.appendChild(badge);
                }

                if (v.changelog) {
                    const cl = document.createElement('span');
                    cl.textContent = v.changelog.slice(0, 40) + (v.changelog.length > 40 ? '...' : '');
                    cl.style.cssText = 'font-size:11px;color:var(--text-disabled);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                    row.appendChild(cl);
                } else {
                    row.appendChild(Object.assign(document.createElement('span'), { style: 'flex:1;' } as any));
                }

                const actions = document.createElement('div');
                actions.style.cssText = 'display:flex;gap:4px;margin-left:auto;';

                if (!v.isLive) {
                    const setLiveBtn = document.createElement('button');
                    setLiveBtn.textContent = 'Set Live';
                    setLiveBtn.style.cssText = 'padding:2px 8px;font-size:11px;background:var(--accent);color:white;border:none;border-radius:3px;cursor:pointer;';
                    setLiveBtn.addEventListener('click', async () => {
                        try {
                            if (this.ctx.backend.isSelfHosted) {
                                await this.ctx.backend.setLiveVersionProd(projectId, v.id);
                            } else {
                                await this.ctx.backend.setLiveVersion(projectId, v.id);
                            }
                            for (const ver of pubData.versions) ver.isLive = ver.id === v.id;
                            pubData.liveVersion = v.version;
                            buildVersionList();
                        } catch (e: any) {
                            alert(e.message || 'Failed to set live version.');
                        }
                    });
                    actions.appendChild(setLiveBtn);
                }

                const revertBtn = document.createElement('button');
                revertBtn.textContent = 'Checkout';
                revertBtn.style.cssText = 'padding:2px 8px;font-size:11px;background:var(--bg-input);border:1px solid var(--border);color:var(--text-secondary);border-radius:3px;cursor:pointer;';
                revertBtn.addEventListener('click', async () => {
                    if (!confirm(`Revert project to v${v.version}? Your current editor state will be replaced.`)) return;
                    try {
                        if (this.ctx.backend.isSelfHosted) {
                            const src = await this.ctx.backend.getVersionSourceProd(projectId, v.id);
                            if (!src.files) throw new Error('This version has no source files to restore.');
                            await this.ctx.backend.replaceProjectData(projectId, { projectConfig: src.projectConfig, files: src.files });
                        } else {
                            await this.ctx.backend.revertToVersion(projectId, v.id);
                        }
                        close();
                        if (this.ctx.state.projectId === projectId) window.location.reload();
                    } catch (e: any) {
                        alert(e.message || 'Failed to revert.');
                    }
                });
                actions.appendChild(revertBtn);

                row.appendChild(actions);
                list.appendChild(row);
            }
        };
        buildVersionList();
        body.appendChild(list);

        const newVerSection = document.createElement('div');
        newVerSection.style.cssText = 'padding:12px;background:var(--bg-secondary);border-radius:6px;display:flex;flex-direction:column;gap:8px;';
        const newVerTitle = document.createElement('div');
        newVerTitle.textContent = 'Publish New Version';
        newVerTitle.style.cssText = 'font-weight:600;font-size:12px;color:var(--text-secondary);';
        newVerSection.appendChild(newVerTitle);

        const newVerRow = document.createElement('div');
        newVerRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
        const vInput = document.createElement('input');
        vInput.type = 'text';
        const latestVer = pubData.versions[0]?.version || '1.0.0';
        const parts = latestVer.split('.').map(Number);
        parts[parts.length - 1]++;
        vInput.value = parts.join('.');
        vInput.placeholder = '1.0.1';
        vInput.style.cssText = 'width:80px;height:28px;padding:0 8px;font-size:13px;';
        newVerRow.appendChild(vInput);

        const clInput = document.createElement('input');
        clInput.type = 'text';
        clInput.placeholder = 'Changelog (optional)';
        clInput.style.cssText = 'flex:1;height:28px;padding:0 8px;font-size:13px;';
        newVerRow.appendChild(clInput);

        const pubBtn = document.createElement('button');
        pubBtn.textContent = 'Publish';
        pubBtn.style.cssText = 'padding:4px 14px;font-size:12px;background:var(--accent);color:white;border:none;border-radius:4px;cursor:pointer;font-weight:600;';
        newVerRow.appendChild(pubBtn);
        newVerSection.appendChild(newVerRow);

        const newVerError = document.createElement('div');
        newVerError.style.cssText = 'color:#e74c3c;font-size:11px;display:none;';
        newVerSection.appendChild(newVerError);

        pubBtn.addEventListener('click', async () => {
            const ver = vInput.value.trim();
            if (!ver || !isValidSemver(ver)) { newVerError.textContent = 'Enter a valid version.'; newVerError.style.display = 'block'; return; }
            try {
                const result = await this.submit(projectId, {
                    name: pubData.name, slug: pubData.slug, visibility: pubData.visibility,
                    version: ver, changelog: clInput.value.trim(),
                });
                pubData.versions.unshift({ id: result.gameId, version: ver, changelog: clInput.value.trim(), isLive: true });
                for (const v2 of pubData.versions) { if (v2 !== pubData.versions[0]) v2.isLive = false; }
                pubData.liveVersion = ver;
                buildVersionList();
                vInput.value = '';
                clInput.value = '';
                newVerError.style.display = 'none';
                this.ctx.emit('projectPublished', { projectId, ...result });
                toast(`v${ver} published!`, 'success');
            } catch (e: any) {
                if (e?.__engineMismatchHandled) { close(); return; }
                newVerError.textContent = e.message?.replace(/^API error \d+: /, '') || 'Publish failed.';
                try { newVerError.textContent = JSON.parse(e.message?.replace(/^API error \d+: /, '') || '{}').error || newVerError.textContent; } catch {}
                newVerError.style.display = 'block';
            }
        });
        body.appendChild(newVerSection);

        const dangerSection = document.createElement('div');
        dangerSection.style.cssText = 'display:flex;justify-content:flex-end;';
        const unpubBtn = document.createElement('button');
        unpubBtn.textContent = 'Unpublish Game';
        unpubBtn.style.cssText = 'padding:4px 12px;font-size:11px;background:transparent;border:1px solid #e74c3c;color:#e74c3c;border-radius:4px;cursor:pointer;';
        unpubBtn.addEventListener('click', async () => {
            if (!confirm('Unpublish this game? It will no longer be accessible to players.')) return;
            try {
                if (this.ctx.backend.isSelfHosted) {
                    await this.ctx.backend.unpublishProd(projectId);
                } else {
                    await this.ctx.backend.unpublishProject(projectId);
                }
                close();
                this.ctx.emit('projectUnpublished', { projectId });
                toast('Game unpublished.', 'info');
            } catch (e: any) {
                alert(e.message || 'Failed to unpublish.');
            }
        });
        dangerSection.appendChild(unpubBtn);
        body.appendChild(dangerSection);

        const { close } = showModal({
            title: 'Manage Published Game',
            body, width: '520px',
            buttons: [{ label: 'Close', action: () => close() }],
        });
    }

    private showSuccessModal(result: any): void {
        const origin = this.ctx.backend.isSelfHosted ? 'https://parallaxpro.ai' : window.location.origin;
        const url = result.url || `${origin}/games/${result.owner}/${result.slug}`;
        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex-direction:column;gap:12px;';
        const msg = document.createElement('div');
        msg.textContent = `Version ${result.version} is now live!`;
        msg.style.cssText = 'font-size:14px;color:var(--text-primary);';
        body.appendChild(msg);
        const link = document.createElement('a');
        link.href = url; link.target = '_blank'; link.textContent = url;
        link.style.cssText = 'font-size:13px;color:var(--accent);word-break:break-all;';
        body.appendChild(link);
        const { close } = showModal({
            title: 'Published!', body, width: '420px',
            buttons: [{ label: 'Done', primary: true, action: () => close() }],
        });
    }

    private showEngineMismatchModal(payload: any, yourHash: string): void {
        const body = document.createElement('div');
        body.style.cssText = 'display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.5;';

        const headline = document.createElement('div');
        headline.style.cssText = 'font-size:14px;color:var(--text-primary);';
        headline.textContent = payload.error === 'rejected_engine_hash'
            ? "Your editor is running an engine version that's been blocked from publishing."
            : "Your editor is running an engine version parallaxpro.ai doesn't recognize yet.";
        body.appendChild(headline);

        const versions = document.createElement('div');
        versions.style.cssText = 'background:var(--bg-secondary);padding:10px 12px;border-radius:6px;font-family:monospace;font-size:11.5px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px;';
        versions.innerHTML =
            `<div>Your commit:&nbsp;&nbsp;<strong style="color:var(--text-primary)">${(yourHash || '').slice(0, 12)}</strong></div>` +
            (payload.latestHash
                ? `<div>Latest supported:&nbsp;<strong style="color:var(--accent)">${String(payload.latestHash).slice(0, 12)}</strong>${payload.latestSemver ? ` (v${payload.latestSemver})` : ''}</div>`
                : '');
        body.appendChild(versions);

        const tip = document.createElement('div');
        tip.style.cssText = 'color:var(--text-secondary);';
        tip.innerHTML = 'The simplest fix: <code>git checkout production</code> in your Open-ParallaxPro checkout (tracks exactly what parallaxpro.ai runs), restart the editor, then try Publish again.';
        body.appendChild(tip);

        const { close } = showModal({
            title: 'Engine version not supported',
            body, width: '480px',
            buttons: [{ label: 'Got it', primary: true, action: () => close() }],
        });
    }

    // ── Core publish logic ────────────────────────────────────────────

    private async submit(projectId: string, opts: { name: string; slug: string; visibility: string; version: string; changelog: string }): Promise<any> {
        if (!this.ctx.backend.isSelfHosted) {
            return this.ctx.backend.publishProject(projectId, opts.name, opts.slug, opts.visibility, opts.version, opts.changelog);
        }

        const hash = typeof __ENGINE_GIT_HASH__ !== 'undefined' ? __ENGINE_GIT_HASH__ : 'unknown';
        if (!hash || hash === 'unknown') {
            throw new Error("Cannot detect your editor's git commit. Clone Open-ParallaxPro via `git clone` so publish can tag the engine version.");
        }

        // Flush any in-flight / debounced background cloud-push first —
        // otherwise the publish flow's cloud-upsert can race with an
        // auto-save push and OCC-reject with a stale cloudPulledUpdatedAt.
        try { await this.ctx.cloudSync.flushNow(projectId); } catch { /* non-fatal */ }

        let project: any;
        try {
            project = await this.ctx.backend.loadProject(projectId);
        } catch (e: any) {
            throw new Error(`Couldn't read the local project before publishing: ${e?.message ?? e}`);
        }
        if (!project?.files) {
            throw new Error("This project is missing a files tree — can't publish. Try re-saving first.");
        }

        try {
            const upsert = await this.ctx.backend.cloudUpsertProd({
                id: projectId,
                name: opts.name,
                projectData: { projectConfig: project.projectConfig ?? { name: opts.name }, files: project.files },
                expectedUpdatedAt: project.cloudPulledUpdatedAt,
                engineGitHash: hash,
                force: !project.isCloud,
            });

            // Track the freshest updatedAt through each server mutation so
            // the final markCloudLocal matches what prod holds; otherwise
            // the next push 409s on a stale OCC value.
            let latestUpdatedAt = upsert.updatedAt;

            const thumbFile = await this.resolveThumbnail(project.thumbnail);
            if (thumbFile) {
                const t = await this.ctx.backend.cloudThumbnailProd(projectId, thumbFile);
                upsert.thumbnail = t.thumbnail;
                if (t.updatedAt) latestUpdatedAt = t.updatedAt;
            }

            const userId = this.ctx.cloudSync.currentUserId();
            if (userId) {
                await this.ctx.backend.markCloudLocal(projectId, {
                    cloudUserId: userId,
                    cloudUpdatedAt: latestUpdatedAt,
                    editedEngineHash: upsert.editedEngineHash,
                    thumbnail: upsert.thumbnail
                        ? (upsert.thumbnail.startsWith('http') ? upsert.thumbnail : `https://parallaxpro.ai${upsert.thumbnail}`)
                        : null,
                });
                if (this.ctx.state.projectId === projectId && this.ctx.state.projectData) {
                    (this.ctx.state.projectData as any).isCloud = true;
                }
            }

            return await this.ctx.backend.publishProjectProd(
                projectId, opts.name, opts.slug, opts.visibility, opts.version, opts.changelog,
            );
        } catch (e: any) {
            if (e instanceof AuthRequiredError) {
                clearStoredToken();
                toast('Your session expired. Try publishing again.', 'error');
                const sentinel: any = new Error('auth expired');
                sentinel.__engineMismatchHandled = true;
                throw sentinel;
            }
            if (e instanceof ApiError) {
                const payload = e.payload || {};
                if (payload?.error === 'unknown_engine_hash' || payload?.error === 'rejected_engine_hash') {
                    this.showEngineMismatchModal(payload, hash);
                    const sentinel: any = new Error(payload.message || 'Engine version mismatch');
                    sentinel.__engineMismatchHandled = true;
                    throw sentinel;
                }
                if (payload?.error === 'conflict') {
                    throw new Error('Remote changes detected — open the project and Publish again to resolve.');
                }
                if (payload?.error) throw new Error(payload.error);
            }
            throw e;
        }
    }

    private async resolveThumbnail(projectThumbnailUrl?: string | null): Promise<File | null> {
        if (this._pendingThumbnail) return this._pendingThumbnail;
        if (!projectThumbnailUrl) return null;
        try {
            const res = await window.fetch(projectThumbnailUrl);
            if (!res.ok) return null;
            const blob = await res.blob();
            const ext = (projectThumbnailUrl.match(/\.(png|jpg|jpeg|webp|gif)$/i)?.[1] || 'png').toLowerCase();
            return new File([blob], `thumbnail.${ext}`, { type: blob.type || `image/${ext === 'jpg' ? 'jpeg' : ext}` });
        } catch {
            return null;
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────

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

    private makeThumbnailField(projectId: string, currentThumbnail: string | null): HTMLElement {
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

        if (currentThumbnail) {
            const img = document.createElement('img');
            img.src = currentThumbnail;
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
        uploadBtn.textContent = currentThumbnail ? 'Change' : 'Upload';
        uploadBtn.style.cssText = 'padding:4px 12px;font-size:12px;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);cursor:pointer;';
        uploadBtn.addEventListener('click', (e) => { e.preventDefault(); fileInput.click(); });

        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            try {
                let previewSrc: string;
                if (this.ctx.backend.isSelfHosted) {
                    // OSS backend has no /thumbnail route; stash the File
                    // and preview via object URL. Actual upload happens as
                    // part of submit() via cloud-thumbnail.
                    previewSrc = URL.createObjectURL(file);
                } else {
                    const result = await this.ctx.backend.uploadThumbnail(projectId, file);
                    if (this.ctx.state.projectId === projectId && this.ctx.state.projectData) {
                        (this.ctx.state.projectData as any).thumbnail = result.thumbnail;
                    }
                    previewSrc = result.thumbnail;
                }
                this._pendingThumbnail = file;
                thumbPreview.innerHTML = '';
                const img = document.createElement('img');
                img.src = previewSrc;
                img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
                thumbPreview.appendChild(img);
                uploadBtn.textContent = 'Change';
            } catch (e: any) {
                alert(e?.message || 'Failed to upload thumbnail.');
            }
            fileInput.value = '';
        });

        inner.appendChild(uploadBtn);
        inner.appendChild(fileInput);
        row.appendChild(inner);
        return row;
    }
}
