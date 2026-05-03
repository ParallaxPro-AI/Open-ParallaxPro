import { EditorContext } from '../editor_context.js';
import { showConfirmModal, showPromptModal, showModal } from '../widgets/modal.js';
import { showContextMenu } from '../widgets/context_menu.js';
import { icon, MoreVertical, Check, FolderOpen, Plus, LogIn, LogOut, ExternalLink, Square, X } from '../widgets/icons.js';
import { ensureLoggedIn, getStoredToken, clearStoredToken, decodeToken } from '../backend/auth_session.js';
import { formatServerTime } from '../utils/format_time.js';
import { t } from '../i18n/index.js';

export class ProjectListView {
    readonly el: HTMLElement;
    private ctx: EditorContext;
    private gridEl: HTMLElement;
    private paginationEl: HTMLElement;
    private toolbarEl: HTMLElement;
    private selectCountEl: HTMLElement;
    private selectAllCheckbox: HTMLElement;
    private searchInput: HTMLInputElement;
    private searchRowEl: HTMLElement;
    private projects: any[] = [];
    private selectedIds: Set<string> = new Set();
    // Anchor for shift-click range selection — id of the last project the
    // user explicitly clicked (checkbox or shift-click on card body).
    private lastSelectedId: string | null = null;
    private onOpenProject: ((projectId: string, initialPrompt?: string) => void) | null = null;
    private searchQuery: string = '';
    private statusFilter: 'all' | 'published' | 'draft' = 'all';
    private currentPage: number = 1;
    // pageSize grows with viewport so wide screens fill every visible row
    // instead of leaving a "halo" of empty space below two rows. Recomputed
    // from gridEl dimensions + the first card's measured height on resize.
    private pageSize: number = 12;
    private resizeObserver: ResizeObserver | null = null;
    private activeTab: 'all' | 'my' | 'cloud' = 'all';
    private tabBar!: HTMLElement;
    private statusFilterEl!: HTMLSelectElement;
    private authSlot!: HTMLElement;
    // Poll /projects every 10s while any card is generating so the elapsed
    // timer and live status stay fresh without a WS subscription from the
    // list view. 0 when idle.
    private generationPollTimer: number = 0;
    // Re-tick the GENERATING badge's elapsed time every second without
    // re-fetching. 0 when no running cards.
    private generationTickTimer: number = 0;

    constructor() {
        this.ctx = EditorContext.instance;
        this.el = document.createElement('div');
        this.el.className = 'project-list-view';

        // Keep the list in sync when publish state changes anywhere —
        // the Publish modal fires these after a successful submit.
        const refresh = () => this.loadProjects();
        this.ctx.on('projectPublished', refresh);
        this.ctx.on('projectUnpublished', refresh);
        // Re-fetch on window-focus so changes on other machines / the
        // hosted editor appear without a manual tab switch.
        window.addEventListener('focus', refresh);

        const header = document.createElement('div');
        header.className = 'project-list-header';

        const logoLink = document.createElement('a');
        logoLink.href = `${import.meta.env.BASE_URL}`;
        logoLink.className = 'logo-link';
        const logo = document.createElement('img');
        logo.className = 'toolbar-logo';
        logo.src = `${import.meta.env.BASE_URL}logos/main_logo_horizontal.png`;
        logo.alt = 'ParallaxPro';
        logoLink.appendChild(logo);
        header.appendChild(logoLink);

        const spacer = document.createElement('div');
        spacer.className = 'toolbar-spacer';
        header.appendChild(spacer);

        const createBtn = document.createElement('button');
        createBtn.className = 'toolbar-btn publish-btn';
        createBtn.textContent = t('projectList.newProject');
        createBtn.addEventListener('click', () => this.createProject());
        header.appendChild(createBtn);

        // "Exit" only makes sense on parallaxpro.ai (goes back to the
        // landing page). On self-hosted instances there's nowhere to
        // exit to, so swap it out for an auth widget that lets the
        // user sign in to parallaxpro.ai (so publish-from-local
        // works) or sign out of the session.
        if (this.ctx.backend.isSelfHosted) {
            this.authSlot = document.createElement('div');
            this.authSlot.style.display = 'flex';
            this.renderAuthSlot();
            header.appendChild(this.authSlot);
        } else {
            const exitBtn = document.createElement('button');
            exitBtn.className = 'toolbar-btn exit-btn';
            exitBtn.appendChild(icon(LogOut, 15));
            const exitLabel = document.createElement('span');
            exitLabel.textContent = ` ${t('projectList.exit')}`;
            exitBtn.appendChild(exitLabel);
            exitBtn.title = t('projectList.backToLanding');
            exitBtn.addEventListener('click', () => {
                window.location.href = '/';
            });
            header.appendChild(exitBtn);
        }

        this.el.appendChild(header);

        // Anon-session banner — visible only when the JWT in localStorage
        // has isAnonymous=true. Urgent (amber) because losing localStorage
        // means losing the account. Inline signup/login buttons keep the
        // conversion path one click away.
        const token = getStoredToken();
        const decoded = token ? decodeToken(token) : null;
        if (decoded && (decoded as any).isAnonymous) {
            const anonBanner = document.createElement('div');
            anonBanner.className = 'project-list-notice anon-notice';
            const msg = document.createElement('span');
            msg.textContent = t('projectList.anonBanner') + ' ';
            anonBanner.appendChild(msg);
            const signupBtn = document.createElement('a');
            signupBtn.href = window.location.hostname === 'localhost'
                ? 'http://localhost:5173/signup'
                : 'https://parallaxpro.ai/signup';
            signupBtn.textContent = t('projectList.anonSignup');
            signupBtn.className = 'anon-notice-btn';
            anonBanner.appendChild(signupBtn);
            const loginBtn = document.createElement('a');
            loginBtn.href = window.location.hostname === 'localhost'
                ? 'http://localhost:5173/login'
                : 'https://parallaxpro.ai/login';
            loginBtn.textContent = t('projectList.anonLogin');
            loginBtn.className = 'anon-notice-btn anon-notice-btn-secondary';
            anonBanner.appendChild(loginBtn);
            this.el.appendChild(anonBanner);
        }

        // Heads-up banner — we restart the backend often while ironing
        // out issues, and we want users to know up-front that their
        // projects are safe but an in-flight AI build may be killed.
        // Sits between the header and the toolbar so it's always in
        // view without covering content.
        const notice = document.createElement('div');
        notice.className = 'project-list-notice';
        notice.textContent = t('projectList.restartNotice');
        this.el.appendChild(notice);

        this.toolbarEl = document.createElement('div');
        this.toolbarEl.className = 'project-list-toolbar';
        this.toolbarEl.style.display = 'none';

        this.selectAllCheckbox = document.createElement('div');
        this.selectAllCheckbox.className = 'project-select-all-checkbox';
        this.selectAllCheckbox.addEventListener('click', () => this.toggleSelectAll());
        this.toolbarEl.appendChild(this.selectAllCheckbox);

        const selectAllLabel = document.createElement('span');
        selectAllLabel.className = 'select-all-label';
        selectAllLabel.textContent = t('projectList.selectAll');
        selectAllLabel.style.cursor = 'pointer';
        selectAllLabel.addEventListener('click', () => this.toggleSelectAll());
        this.toolbarEl.appendChild(selectAllLabel);

        this.selectCountEl = document.createElement('span');
        this.selectCountEl.className = 'select-count';
        this.toolbarEl.appendChild(this.selectCountEl);

        const deleteSelBtn = document.createElement('button');
        deleteSelBtn.className = 'danger';
        deleteSelBtn.textContent = t('projectList.deleteSelected');
        deleteSelBtn.addEventListener('click', () => this.deleteSelected());
        this.toolbarEl.appendChild(deleteSelBtn);

        this.el.appendChild(this.toolbarEl);

        this.searchRowEl = document.createElement('div');
        const searchRow = this.searchRowEl;
        searchRow.className = 'project-search-row';

        this.searchInput = document.createElement('input');
        this.searchInput.type = 'text';
        this.searchInput.className = 'project-search-input';
        this.searchInput.placeholder = t('projectList.searchPlaceholder');
        this.searchInput.addEventListener('input', () => {
            this.searchQuery = this.searchInput.value.trim().toLowerCase();
            this.currentPage = 1;
            this.pushPageToUrl();
            this.render();
        });
        searchRow.appendChild(this.searchInput);

        this.statusFilterEl = document.createElement('select');
        this.statusFilterEl.className = 'project-status-filter';
        this.statusFilterEl.innerHTML = `<option value="all">${t('projectList.statusAll')}</option><option value="published">${t('projectList.statusPublished')}</option><option value="draft">${t('projectList.statusDraft')}</option>`;
        this.statusFilterEl.addEventListener('change', () => {
            this.statusFilter = this.statusFilterEl.value as 'all' | 'published' | 'draft';
            this.currentPage = 1;
            this.render();
        });
        searchRow.appendChild(this.statusFilterEl);

        this.el.appendChild(searchRow);

        this.tabBar = document.createElement('div');
        this.tabBar.className = 'project-tabs';

        // On parallaxpro.ai/editor/ every project is inherently cloud —
        // the local/cloud split doesn't apply, so the tab bar adds
        // noise without meaning. Skip it and always use the 'all' load
        // path (which on hosted is just listProjects + publish merge).
        if (this.ctx.backend.isSelfHosted) {
            const tabs: { key: 'all' | 'my' | 'cloud'; label: string; el?: HTMLElement }[] = [
                { key: 'all', label: t('projectList.tabAll') },
                { key: 'my', label: t('projectList.tabLocal') },
                { key: 'cloud', label: t('projectList.tabCloud') },
            ];
            for (const tab of tabs) {
                const btn = document.createElement('button');
                btn.className = 'project-tab' + (tab.key === this.activeTab ? ' active' : '');
                btn.textContent = tab.label;
                btn.addEventListener('click', () => {
                    if (this.activeTab === tab.key) return;
                    this.activeTab = tab.key;
                    for (const other of tabs) other.el!.classList.toggle('active', other.key === tab.key);
                    this.currentPage = 1;
                    this.selectedIds.clear();
                    this.loadProjects();
                });
                tab.el = btn;
                this.tabBar.appendChild(btn);
            }
            this.el.appendChild(this.tabBar);
        }

        this.gridEl = document.createElement('div');
        this.gridEl.className = 'project-grid';
        this.el.appendChild(this.gridEl);

        this.paginationEl = document.createElement('div');
        this.paginationEl.className = 'project-pagination';
        this.el.appendChild(this.paginationEl);

        const pageParam = new URLSearchParams(window.location.search).get('page');
        if (pageParam) this.currentPage = Math.max(1, parseInt(pageParam) || 1);

        this.resizeObserver = new ResizeObserver(() => this.recomputePageSize());
        this.resizeObserver.observe(this.gridEl);

        this.loadProjects();
    }

    // Compute pageSize = cols × rows that fit in gridEl. Mirrors the CSS
    // `minmax(260px, 1fr)` + 20px gap + 24px horizontal padding. Card
    // height is measured off the first rendered card, or a 260px
    // fallback when the grid is empty so the first render still looks full.
    private recomputePageSize(): void {
        const w = this.gridEl.clientWidth;
        const h = this.gridEl.clientHeight;
        if (w <= 0 || h <= 0) return;

        const gap = 20;
        const hPad = 48; // 24px left + 24px right
        const vPad = 28; // 4px top + 24px bottom
        const minCardW = 260;

        const usableW = Math.max(minCardW, w - hPad);
        const cols = Math.max(1, Math.floor((usableW + gap) / (minCardW + gap)));

        const firstCard = this.gridEl.querySelector('.project-card') as HTMLElement | null;
        const cardH = firstCard?.offsetHeight || 260;
        const usableH = Math.max(cardH, h - vPad);
        // Round instead of floor so a near-miss (e.g. grid is 500px tall and
        // two rows want 508px) rounds up to fit both rows. The grid's own
        // overflow-y:auto handles the tiny overshoot cleanly, and this
        // prevents visible "halo" empty space when the viewport is barely
        // short of a whole row.
        const rows = Math.max(1, Math.round((usableH + gap) / (cardH + gap)));

        const next = Math.max(cols * rows, 6);
        if (next !== this.pageSize) {
            this.pageSize = next;
            this.render();
        }
    }

    onOpen(callback: (projectId: string, initialPrompt?: string) => void): void {
        this.onOpenProject = callback;
    }

    private pushPageToUrl(): void {
        const url = new URL(window.location.href);
        if (this.currentPage > 1) {
            url.searchParams.set('page', String(this.currentPage));
        } else {
            url.searchParams.delete('page');
        }
        window.history.replaceState({}, '', url.toString());
    }

    private async loadProjects(): Promise<void> {
        try {
            if (this.activeTab === 'cloud') {
                this.projects = await this.loadCloudProjects();
            } else if (this.activeTab === 'all') {
                this.projects = await this.loadAllProjects();
            } else {
                this.projects = await this.loadMyProjects();
            }
        } catch {
            this.projects = [];
        }
        this.render();
        this.refreshGenerationTimers();
    }

    /** Start/stop the polling + per-second tick timers based on whether
     *  any loaded card is currently generating. Invoked after every
     *  loadProjects + after the render that follows. */
    private refreshGenerationTimers(): void {
        const anyActive = this.projects.some((p: any) => p?.generation?.active);

        if (anyActive && !this.generationPollTimer) {
            // 10s is the project-list poll cadence agreed with the
            // backend: cheap SQL, enough latency to feel live without
            // hammering the server.
            this.generationPollTimer = window.setInterval(() => {
                this.loadProjects();
            }, 10000);
        } else if (!anyActive && this.generationPollTimer) {
            clearInterval(this.generationPollTimer);
            this.generationPollTimer = 0;
        }

        if (anyActive && !this.generationTickTimer) {
            // Per-second redraw of just the elapsed-time spans so the
            // timer ticks visibly between 10s polls. We DON'T re-render
            // the whole grid — this just mutates textContent on the
            // timer nodes we stamped with data-generation-started-at.
            this.generationTickTimer = window.setInterval(() => {
                this.tickGenerationTimers();
            }, 1000);
        } else if (!anyActive && this.generationTickTimer) {
            clearInterval(this.generationTickTimer);
            this.generationTickTimer = 0;
        }
    }

    private tickGenerationTimers(): void {
        const nodes = this.gridEl.querySelectorAll<HTMLElement>('[data-generation-started-at]');
        const now = Date.now();
        for (const node of Array.from(nodes)) {
            const startedAt = Number(node.dataset.generationStartedAt || '0');
            if (!startedAt) continue;
            node.textContent = formatElapsed(now - startedAt);
        }
    }

    /** Local-only projects (cloud ones are exclusively under the Cloud
     *  tab to avoid showing every synced project in two places). Still
     *  merged with publish info in case a local-only project was
     *  published elsewhere (legacy pre-cloud rows). */
    private async loadMyProjects(): Promise<any[]> {
        const all = await this.ctx.backend.listProjects();
        const localOnly = all.filter((p: any) => !p.isCloud);
        await this.mergePublishInfo(localOnly);
        return localOnly;
    }

    /** Superset of My Projects + remote-only cloud projects, with cloud
     *  sync state stamped on each card. No login → same as My Projects. */
    private async loadAllProjects(): Promise<any[]> {
        const userId = this.ctx.cloudSync.currentUserId();
        const [localAll, remoteAll] = await Promise.all([
            this.ctx.backend.listProjects().catch(() => []),
            userId ? this.ctx.backend.listCloudProjectsProd().catch(() => []) : Promise.resolve([]),
        ]);
        const remoteById = new Map<string, any>((remoteAll as any[]).map((p: any) => [p.id, p]));
        const localById = new Map<string, any>((localAll as any[]).map((p: any) => [p.id, p]));

        const merged: any[] = [];
        for (const local of localAll) {
            const remote = remoteById.get(local.id);
            let state: string | null = null;
            let remoteUpdatedAt: string | undefined;
            if (local.isCloud) {
                if (!userId) {
                    // Signed out — we can't tell whether the remote still
                    // exists or is ahead. Don't lie with "removed".
                    state = 'signed-out';
                } else {
                    state = remote ? this.computeCloudState(local, remote) : 'removed-remotely';
                }
                remoteUpdatedAt = remote?.updatedAt;
            }
            merged.push({ ...local, _cloudState: state, _remoteOnly: false, _remoteUpdatedAt: remoteUpdatedAt });
        }
        for (const remote of remoteAll) {
            if (localById.has(remote.id)) continue;
            merged.push({
                id: remote.id,
                name: remote.name,
                status: remote.status ?? 'draft',
                thumbnail: remote.thumbnail
                    ? (remote.thumbnail.startsWith('http') ? remote.thumbnail : `https://parallaxpro.ai${remote.thumbnail}`)
                    : null,
                updatedAt: remote.updatedAt,
                _cloudState: 'remote-only',
                _remoteOnly: true,
                _remoteUpdatedAt: remote.updatedAt,
            });
        }
        await this.mergePublishInfo(merged);
        merged.sort((a, b) => {
            const at = Math.max(Date.parse(a.updatedAt || 0), Date.parse(a._remoteUpdatedAt || 0));
            const bt = Math.max(Date.parse(b.updatedAt || 0), Date.parse(b._remoteUpdatedAt || 0));
            return bt - at;
        });
        return merged;
    }

    /** Stamp publishedSlug / Owner / Version + absolute-URL thumbnail on
     *  any project the server considers live. Shared across tabs so
     *  badge behaviour stays consistent. Silently falls through when
     *  the user isn't signed in or prod is unreachable. */
    private async mergePublishInfo(projects: any[]): Promise<void> {
        const pubInfo = this.ctx.backend.isSelfHosted
            ? await this.ctx.backend.getPublishInfoProd()
            : await this.ctx.backend.getPublishInfo();
        for (const p of projects) {
            const info = pubInfo[p.id];
            if (!info) continue;
            p.publishedSlug = info.publishedSlug;
            p.publishedOwner = info.publishedOwner;
            p.publishedVersion = info.publishedVersion;
            p.status = 'published';
            const thumb = (info as any).thumbnail;
            if (thumb && this.ctx.backend.isSelfHosted) {
                p.thumbnail = thumb.startsWith('http') ? thumb : `https://parallaxpro.ai${thumb}`;
            }
        }
    }

    /**
     * Union local cloud projects (is_cloud=1) with prod projects, deciding
     * each card's sync state. Requires a valid cli-login token — returns
     * [] with an inline login prompt rendered in the grid when absent.
     */
    private async loadCloudProjects(): Promise<any[]> {
        const userId = this.ctx.cloudSync.currentUserId();
        if (!userId) return [];

        const [localAll, remoteAll] = await Promise.all([
            this.ctx.backend.listProjects().catch(() => []),
            this.ctx.backend.listCloudProjectsProd().catch(() => []),
        ]);

        const localById = new Map<string, any>();
        for (const p of localAll) {
            if (p.isCloud && p.cloudUserId === userId) localById.set(p.id, p);
        }
        const remoteById = new Map<string, any>(remoteAll.map((p: any) => [p.id, p]));

        const merged: any[] = [];
        for (const r of remoteAll) {
            const local = localById.get(r.id);
            if (!local) {
                merged.push({
                    id: r.id,
                    name: r.name,
                    status: r.status ?? 'draft',
                    thumbnail: r.thumbnail
                        ? (r.thumbnail.startsWith('http') ? r.thumbnail : `https://parallaxpro.ai${r.thumbnail}`)
                        : null,
                    updatedAt: r.updatedAt,
                    _cloudState: 'remote-only',
                    _remoteOnly: true,
                    _remoteUpdatedAt: r.updatedAt,
                });
                continue;
            }
            const state = this.computeCloudState(local, r);
            merged.push({
                ...local,
                _cloudState: state,
                _remoteOnly: false,
                _remoteUpdatedAt: r.updatedAt,
            });
        }
        // Local cloud projects the server doesn't know about anymore —
        // deleted elsewhere. Surface so user can keep local or drop.
        for (const local of localById.values()) {
            if (!remoteById.has(local.id)) {
                merged.push({
                    ...local,
                    _cloudState: 'removed-remotely',
                    _remoteOnly: false,
                });
            }
        }
        // Sort by most recently updated first (remote or local, whichever is newer)
        merged.sort((a, b) => {
            const at = Math.max(Date.parse(a.updatedAt || 0), Date.parse(a._remoteUpdatedAt || 0));
            const bt = Math.max(Date.parse(b.updatedAt || 0), Date.parse(b._remoteUpdatedAt || 0));
            return bt - at;
        });
        return merged;
    }

    private computeCloudState(local: any, remote: any): 'synced' | 'local-newer' | 'remote-newer' {
        const localT = Date.parse(local.updatedAt || 0);
        const remoteT = Date.parse(remote.updatedAt || 0);
        const lastSync = Date.parse(local.cloudPulledUpdatedAt || 0);
        // Local has saves newer than last sync → we have un-pushed work.
        if (localT > lastSync && localT >= remoteT) return 'local-newer';
        // Remote moved since last sync → they have changes we don't.
        if (remoteT > lastSync) return 'remote-newer';
        return 'synced';
    }

    private getFilteredProjects(): any[] {
        let result = this.projects;
        if (this.searchQuery) {
            result = result.filter(p =>
                (p.name ?? '').toLowerCase().includes(this.searchQuery)
            );
        }
        if (this.statusFilter !== 'all') {
            result = result.filter(p => {
                const isPublished = p.status === 'published' && p.publishedSlug;
                return this.statusFilter === 'published' ? isPublished : !isPublished;
            });
        }
        return result;
    }

    private render(): void {
        this.gridEl.innerHTML = '';

        // Cloud tab: if the user isn't logged in to parallaxpro.ai, the
        // tab is useless until they sign in. Render an inline prompt
        // that triggers the same popup login the header button uses.
        if (this.activeTab === 'cloud' && !this.ctx.cloudSync.currentUserId()) {
            const prompt = document.createElement('div');
            prompt.className = 'project-empty-state';
            prompt.style.gridColumn = '1 / -1';
            const title = document.createElement('div');
            title.className = 'empty-text';
            title.textContent = t('projectList.cloudSignIn');
            title.style.marginBottom = '16px';
            prompt.appendChild(title);
            const btn = document.createElement('button');
            btn.className = 'toolbar-btn publish-btn';
            btn.textContent = t('projectList.cloudSignInButton');
            btn.addEventListener('click', async () => {
                const { ensureLoggedIn } = await import('../backend/auth_session.js');
                try {
                    await ensureLoggedIn();
                    this.renderAuthSlot();
                    this.loadProjects();
                } catch (e: any) {
                    console.warn('[auth] sign-in cancelled:', e?.message ?? e);
                }
            });
            prompt.appendChild(btn);
            this.gridEl.appendChild(prompt);
            this.paginationEl.innerHTML = '';
            return;
        }

        const filtered = this.getFilteredProjects();

        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'project-empty-state';
            empty.style.gridColumn = '1 / -1';

            const emptyIcon = document.createElement('div');
            emptyIcon.className = 'empty-icon';
            emptyIcon.appendChild(icon(FolderOpen, 48));
            empty.appendChild(emptyIcon);

            const text = document.createElement('div');
            text.className = 'empty-text';
            text.textContent = this.searchQuery
                ? t('projectList.emptySearch')
                : this.activeTab === 'cloud'
                    ? t('projectList.emptyCloud')
                    : t('projectList.emptyDefault');
            empty.appendChild(text);

            this.gridEl.appendChild(empty);
            this.paginationEl.innerHTML = '';
            return;
        }

        const totalPages = Math.ceil(filtered.length / this.pageSize);
        if (this.currentPage > totalPages) this.currentPage = totalPages;
        const start = (this.currentPage - 1) * this.pageSize;
        const pageProjects = filtered.slice(start, start + this.pageSize);

        for (const project of pageProjects) {
            this.gridEl.appendChild(this.createProjectCard(project));
        }

        this.renderPagination(totalPages, filtered.length);

        // First render uses a 260px fallback for card height; now that a
        // card is in the DOM, remeasure so rowCount matches reality.
        requestAnimationFrame(() => this.recomputePageSize());
    }

    private renderPagination(totalPages: number, totalItems: number): void {
        this.paginationEl.innerHTML = '';
        if (totalPages <= 1) return;

        const info = document.createElement('span');
        info.className = 'pagination-info';
        const start = (this.currentPage - 1) * this.pageSize + 1;
        const end = Math.min(this.currentPage * this.pageSize, totalItems);
        info.textContent = `${start}–${end} of ${totalItems}`;
        this.paginationEl.appendChild(info);

        const prevBtn = document.createElement('button');
        prevBtn.className = 'pagination-btn';
        prevBtn.textContent = t('projectList.prev');
        prevBtn.disabled = this.currentPage <= 1;
        prevBtn.addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.pushPageToUrl();
                this.render();
            }
        });
        this.paginationEl.appendChild(prevBtn);

        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || Math.abs(i - this.currentPage) <= 1) {
                const pageBtn = document.createElement('button');
                pageBtn.className = 'pagination-btn' + (i === this.currentPage ? ' active' : '');
                pageBtn.textContent = String(i);
                pageBtn.addEventListener('click', () => {
                    this.currentPage = i;
                    this.pushPageToUrl();
                    this.render();
                });
                this.paginationEl.appendChild(pageBtn);
            } else if (i === 2 && this.currentPage > 3 || i === totalPages - 1 && this.currentPage < totalPages - 2) {
                const dots = document.createElement('span');
                dots.className = 'pagination-dots';
                dots.textContent = '\u2026';
                this.paginationEl.appendChild(dots);
            }
        }

        const nextBtn = document.createElement('button');
        nextBtn.className = 'pagination-btn';
        nextBtn.textContent = t('projectList.next');
        nextBtn.disabled = this.currentPage >= totalPages;
        nextBtn.addEventListener('click', () => {
            if (this.currentPage < totalPages) {
                this.currentPage++;
                this.pushPageToUrl();
                this.render();
            }
        });
        this.paginationEl.appendChild(nextBtn);
    }

    private createProjectCard(project: any): HTMLElement {
        const card = document.createElement('div');
        card.className = 'project-card';
        if (this.selectedIds.has(project.id)) card.classList.add('selected');

        {
            const checkbox = document.createElement('div');
            checkbox.className = 'project-card-checkbox';
            if (this.selectedIds.has(project.id)) {
                checkbox.classList.add('checked');
                checkbox.appendChild(icon(Check, 14));
            }
            checkbox.addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.shiftKey) {
                    this.selectRangeTo(project.id);
                    return;
                }
                this.toggleSelect(project.id);
            });
            card.appendChild(checkbox);
        }

        const thumb = document.createElement('div');
        thumb.className = 'project-card-thumbnail';
        if (project.thumbnail) {
            const img = document.createElement('img');
            img.src = project.thumbnail;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            thumb.appendChild(img);
        } else {
            thumb.appendChild(icon(FolderOpen, 40, { stroke: '#ccc' }));
        }
        card.appendChild(thumb);

        const info = document.createElement('div');
        info.className = 'project-card-info';

        const nameRow = document.createElement('div');
        nameRow.className = 'project-card-name-row';

        const name = document.createElement('div');
        name.className = 'project-card-name';
        name.textContent = project.name ?? t('projectList.untitled');
        nameRow.appendChild(name);

        const isPublished = project.status === 'published' && project.publishedSlug;
        const badge = document.createElement('span');
        if (project.legacy) {
            badge.className = 'project-status-badge deprecated';
            badge.textContent = t('projectList.deprecated');
            badge.title = 'Stored in the pre-template-unification format. Click the project to learn how to open it.';
        } else {
            badge.className = `project-status-badge ${isPublished ? 'published' : 'draft'}`;
            const versionInfo = project.publishedVersion ? ` V${project.publishedVersion}` : '';
            badge.textContent = isPublished ? `${t('projectList.published')}${versionInfo}` : t('projectList.draft');
        }
        nameRow.appendChild(badge);

        // Cloud sync badge, only on the Cloud Projects tab where
        // _cloudState is populated.
        if (project._cloudState) {
            const cloudBadge = document.createElement('span');
            cloudBadge.style.cssText = 'font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;margin-left:6px;';
            const spec = ({
                'synced':            { text: '✓ Synced',          bg: '#1f6f43', fg: '#cdeedc' },
                'local-newer':       { text: '↑ Unsynced',        bg: '#9a6300', fg: '#ffe6b2' },
                'remote-newer':      { text: '↓ Updated online',  bg: '#2a4d9a', fg: '#c7daff' },
                'remote-only':       { text: 'Not downloaded',    bg: '#3a3a3a', fg: '#c9c9c9' },
                'removed-remotely':  { text: '⚠ Removed online',  bg: '#8a1b1b', fg: '#ffd3d3' },
                'signed-out':        { text: 'Sign in to sync',   bg: '#4a3f8a', fg: '#d7ccff' },
            } as Record<string, { text: string; bg: string; fg: string }>)[project._cloudState];
            if (spec) {
                cloudBadge.textContent = spec.text;
                cloudBadge.style.background = spec.bg;
                cloudBadge.style.color = spec.fg;
                nameRow.appendChild(cloudBadge);
            }
        }

        info.appendChild(nameRow);

        if (project.legacy) {
            card.classList.add('legacy');
        }

        // Generation state block (background CREATE_GAME build). Active
        // runs show an elapsed timer + live status + STOP button; the
        // post-run `lastError` sticks around as a dismissible "Build
        // failed" row until the next generation attempt.
        if (project.generation) {
            card.appendChild(this.createGenerationBlock(project));
            if (project.generation.active) {
                card.classList.add('generating');
            } else if (project.generation.lastError) {
                card.classList.add('generation-failed');
            } else if (project.generation.lastSuccessAt) {
                card.classList.add('generation-success');
            }
        }

        // Always render the published-link slot — an invisible placeholder
        // when the project isn't published — so every card has the same
        // natural height. Without this, published cards are ~20px taller
        // than drafts, which causes recomputePageSize() to oscillate
        // depending on which card happens to be first on the current page.
        const linkRow = document.createElement('a');
        linkRow.className = 'project-published-link';
        if (isPublished) {
            // Published games always live on parallaxpro.ai — even when
            // we're rendering from localhost — so the link has to point
            // there, not at window.location.origin.
            const origin = this.ctx.backend.isSelfHosted ? 'https://parallaxpro.ai' : window.location.origin;
            const playUrl = `${origin}/games/${project.publishedOwner}/${project.publishedSlug}`;
            linkRow.href = playUrl;
            linkRow.target = '_blank';
            linkRow.addEventListener('click', (e) => e.stopPropagation());
            linkRow.appendChild(icon(ExternalLink, 12));
            const linkText = document.createElement('span');
            linkText.textContent = `/games/${project.publishedOwner}/${project.publishedSlug}`;
            linkRow.appendChild(linkText);
        } else {
            linkRow.setAttribute('aria-hidden', 'true');
            linkRow.style.visibility = 'hidden';
            // nbsp so line-height applies and the row reserves its full height
            const placeholder = document.createElement('span');
            placeholder.textContent = '\u00A0';
            linkRow.appendChild(placeholder);
        }
        info.appendChild(linkRow);

        const bottom = document.createElement('div');
        bottom.className = 'project-card-bottom';

        const dates = document.createElement('div');
        dates.className = 'project-card-dates';

        if (project.createdAt) {
            const created = document.createElement('div');
            created.className = 'project-card-date';
            created.textContent = `Created: ${new Date(project.createdAt.endsWith('Z') ? project.createdAt : project.createdAt + 'Z').toLocaleString()}`;
            dates.appendChild(created);
        }

        if (project.updatedAt) {
            const modified = document.createElement('div');
            modified.className = 'project-card-date';
            modified.textContent = `Modified: ${formatServerTime(project.updatedAt, '')}`;
            dates.appendChild(modified);
        }

        bottom.appendChild(dates);

        const actions = document.createElement('div');
        actions.className = 'project-card-actions';

        const menuBtn = document.createElement('button');
        menuBtn.className = 'menu-btn';
        menuBtn.title = t('projectList.moreActions');
        menuBtn.appendChild(icon(MoreVertical, 16));
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showProjectMenu(project, e.clientX, e.clientY);
        });
        actions.appendChild(menuBtn);

        bottom.appendChild(actions);
        info.appendChild(bottom);
        card.appendChild(info);

        card.addEventListener('click', async (e) => {
            // Shift-click on a card extends the current selection from the
            // anchor (last explicitly selected project) through this one —
            // same semantics as Finder / Windows Explorer. Skip opening.
            if (e.shiftKey) {
                window.getSelection()?.removeAllRanges();
                this.selectRangeTo(project.id);
                return;
            }
            if (project.legacy) {
                this.showDeprecatedModal(project);
                return;
            }
            // Locked by a background generation — don't even attempt to
            // open. The editor would just bounce back, which is visually
            // worse than doing nothing here.
            if (project.generation?.active) return;
            await this.openProjectWithChecks(project, card);
        });

        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showProjectMenu(project, e.clientX, e.clientY);
        });

        return card;
    }

    /**
     * Open a project, pulling from cloud first if needed and warning
     * about engine-version mismatches on cloud projects. Hook point
     * for all "click to open" paths — replaces the raw
     * onOpenProject call so the checks aren't bypassed by any card.
     */
    private async openProjectWithChecks(project: any, card?: HTMLElement): Promise<void> {
        // Cloud project whose remote got deleted elsewhere — confusing to
        // open without resolving first. Ask the user whether to keep it
        // as a local-only project (demote is_cloud) or delete it too.
        if (project._cloudState === 'removed-remotely') {
            const choice = await this.promptRemovedRemotely(project);
            if (choice === 'cancel') return;
            if (choice === 'delete') { this.deleteProject(project); return; }
            if (choice === 'demote') {
                try { await this.ctx.backend.unmarkCloudLocal(project.id); }
                catch (e: any) { alert(e?.message || 'Failed to demote to local-only.'); return; }
                project.isCloud = false;
                project._cloudState = null;
                this.loadProjects();
                // Fall through to open the now-local project.
            }
        }

        if (project._cloudState === 'remote-only' || project._cloudState === 'remote-newer') {
            card?.classList.add('disabled');
            try {
                await this.ctx.cloudSync.pull(project.id);
            } catch (e: any) {
                card?.classList.remove('disabled');
                alert(e?.message || 'Failed to pull cloud project.');
                return;
            }
        }

        // Engine-version mismatch check: cloud projects carry the hash
        // of the last editor that wrote them. If our local build is a
        // different commit, warn before opening — the source format
        // could have drifted (fields added, renamed, or removed).
        // Hash mismatch is soft: user can still force-open.
        let projectEngineHash: string | null = project.editedEngineHash ?? null;
        if (!projectEngineHash && project._cloudState && project._cloudState !== 'remote-only') {
            // Post-pull local row is authoritative for the hash; reread.
            try {
                const fresh = await this.ctx.backend.loadProject(project.id);
                projectEngineHash = fresh.editedEngineHash ?? null;
            } catch {}
        }
        const ourHash = typeof __ENGINE_GIT_HASH__ !== 'undefined' ? __ENGINE_GIT_HASH__ : 'unknown';
        if (projectEngineHash && ourHash && ourHash !== 'unknown' && projectEngineHash !== ourHash) {
            // Don't re-nag if the user already clicked "Open anyway" for
            // this exact (projectHash, ourHash) pair. A fresh warning
            // triggers when either hash changes — e.g. they `git pull`
            // locally, or another machine saves the project on a new
            // engine commit.
            const ackKey = `pp_hash_ack:${project.id}`;
            const ackValue = `${ourHash}::${projectEngineHash}`;
            let alreadyAcked = false;
            try { alreadyAcked = localStorage.getItem(ackKey) === ackValue; } catch {}
            if (!alreadyAcked) {
                const proceed = await this.showEngineMismatchWarning(projectEngineHash, ourHash);
                if (!proceed) { card?.classList.remove('disabled'); return; }
                try { localStorage.setItem(ackKey, ackValue); } catch {}
            }
        }

        this.onOpenProject?.(project.id);
    }

    /**
     * Three-way choice dialog for a cloud project whose remote has been
     * deleted elsewhere. Returns 'demote' to flip is_cloud=0 and keep
     * editing locally, 'delete' to wipe the local copy too, or
     * 'cancel' to leave things as-is.
     */
    private promptRemovedRemotely(project: any): Promise<'demote' | 'delete' | 'cancel'> {
        return new Promise((resolve) => {
            const name = project.name ?? 'Untitled';
            const body = document.createElement('div');
            body.style.cssText = 'display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5;';
            const top = document.createElement('div');
            top.innerHTML = `<strong>"${escapeHtml(name)}"</strong> was deleted on parallaxpro.ai. You still have a local copy — what would you like to do?`;
            body.appendChild(top);

            let settled = false;
            let close = () => {};
            const pick = (c: 'demote' | 'delete' | 'cancel') => { if (!settled) { settled = true; close(); resolve(c); } };

            const modal = showModal({
                title: t('projectList.cloudCopyDeleted'),
                body, width: '440px', closeOnBackdrop: false,
                buttons: [
                    { label: t('settings.cancel'), action: () => pick('cancel') },
                    { label: t('projectList.deleteLocalToo'), danger: true, action: () => pick('delete') },
                    { label: t('projectList.keepAsLocalOnly'), primary: true, action: () => pick('demote') },
                ],
            });
            close = modal.close;
        });
    }

    private showEngineMismatchWarning(projectHash: string, ourHash: string): Promise<boolean> {
        return new Promise((resolve) => {
            const body = document.createElement('div');
            body.style.cssText = 'display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.5;';
            const title = document.createElement('div');
            title.style.cssText = 'color:var(--text-primary);';
            title.textContent = "This project was last edited on a different engine version. Opening or saving it may drop fields the other version added.";
            body.appendChild(title);
            const row = document.createElement('div');
            row.style.cssText = 'background:var(--bg-secondary);padding:10px 12px;border-radius:6px;font-family:monospace;font-size:11.5px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px;';
            row.innerHTML =
                `<div>Your engine:&nbsp;<strong style="color:var(--text-primary);">${projectHash === ourHash ? ourHash.slice(0, 12) : ourHash.slice(0, 12)}</strong></div>` +
                `<div>Project edited on:&nbsp;<strong style="color:var(--accent);">${projectHash.slice(0, 12)}</strong></div>`;
            body.appendChild(row);
            const hint = document.createElement('div');
            hint.style.cssText = 'color:var(--text-secondary);';
            hint.innerHTML = 'Tip: <code>git checkout production</code> in your Open-ParallaxPro checkout to track the commit parallaxpro.ai runs (most stable). Or <code>git pull</code> on <code>main</code> for bleeding-edge.';
            body.appendChild(hint);
            let done = false;
            const { close } = showModal({
                title: 'Engine version mismatch',
                body, width: '480px', closeOnBackdrop: false,
                buttons: [
                    { label: 'Cancel', action: () => { if (!done) { done = true; close(); resolve(false); } } },
                    { label: 'Open anyway', primary: true, action: () => { if (!done) { done = true; close(); resolve(true); } } },
                ],
            });
        });
    }

    private showDeprecatedModal(project: any): void {
        const body = document.createElement('div');
        body.style.fontSize = '14px';
        body.style.lineHeight = '1.5';

        const intro = document.createElement('p');
        intro.style.margin = '0 0 12px 0';
        intro.innerHTML = `<strong>${escapeHtml(project.name ?? 'This project')}</strong> was created before the template-unification update and is stored in the old project format. The current build of ParallaxPro can no longer open it.`;
        body.appendChild(intro);

        const action = document.createElement('p');
        action.style.margin = '0 0 12px 0';
        action.textContent = 'To open it, run a build of ParallaxPro from before the migration:';
        body.appendChild(action);

        const code = document.createElement('pre');
        code.style.background = 'rgba(255,255,255,0.06)';
        code.style.border = '1px solid rgba(255,255,255,0.1)';
        code.style.borderRadius = '6px';
        code.style.padding = '10px 12px';
        code.style.fontSize = '12px';
        code.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        code.style.margin = '0 0 12px 0';
        code.style.overflowX = 'auto';
        code.textContent = `git clone https://github.com/ParallaxPro-AI/Open-ParallaxPro.git
cd Open-ParallaxPro
git checkout da571fe   # last commit before template unification`;
        body.appendChild(code);

        const link = document.createElement('p');
        link.style.margin = '0 0 12px 0';
        link.innerHTML = `Source: <a href="https://github.com/ParallaxPro-AI/Open-ParallaxPro" target="_blank" rel="noopener" style="color: #66bb6a;">github.com/ParallaxPro-AI/Open-ParallaxPro</a>`;
        body.appendChild(link);

        const tip = document.createElement('p');
        tip.style.margin = '0';
        tip.style.color = '#aaa';
        tip.style.fontSize = '12px';
        tip.textContent = 'Tip: once you reopen this project on the older build, you can recreate it on the new build to migrate.';
        body.appendChild(tip);

        const handle = showModal({
            title: 'Project requires older ParallaxPro build',
            body,
            width: '520px',
            buttons: [{ label: 'Got it', primary: true, action: () => handle.close() }],
        });
    }

    private toggleSelectAll(): void {
        const filtered = this.getFilteredProjects();
        const allFilteredSelected =
            filtered.length > 0 && filtered.every((p) => this.selectedIds.has(p.id));
        if (allFilteredSelected) {
            for (const p of filtered) {
                this.selectedIds.delete(p.id);
            }
        } else {
            for (const p of filtered) {
                this.selectedIds.add(p.id);
            }
        }
        this.lastSelectedId = null;
        this.updateSelectionUI();
    }

    private toggleSelect(projectId: string): void {
        if (this.selectedIds.has(projectId)) {
            this.selectedIds.delete(projectId);
        } else {
            this.selectedIds.add(projectId);
        }
        this.lastSelectedId = projectId;
        this.updateSelectionUI();
    }

    /**
     * Shift-click range selection. Adds every project between the anchor
     * (last explicitly selected) and the target — inclusive — to the
     * current selection, preserving anything already selected outside the
     * range. Range is computed against the filtered project list so it
     * works across pagination boundaries.
     */
    private selectRangeTo(projectId: string): void {
        const filtered = this.getFilteredProjects();
        if (filtered.length === 0) return;

        // No anchor yet (first selection), or the anchor has been filtered
        // out by the current search/status → fall back to single-select.
        const anchorIdx = this.lastSelectedId
            ? filtered.findIndex(p => p.id === this.lastSelectedId)
            : -1;
        const targetIdx = filtered.findIndex(p => p.id === projectId);
        if (targetIdx < 0) return;

        if (anchorIdx < 0) {
            this.selectedIds.add(projectId);
            this.lastSelectedId = projectId;
            this.updateSelectionUI();
            return;
        }

        const [lo, hi] = anchorIdx <= targetIdx
            ? [anchorIdx, targetIdx]
            : [targetIdx, anchorIdx];
        for (let i = lo; i <= hi; i++) {
            this.selectedIds.add(filtered[i].id);
        }
        this.lastSelectedId = projectId;
        this.updateSelectionUI();
    }

    private updateSelectionUI(): void {
        const count = this.selectedIds.size;
        const filtered = this.getFilteredProjects();
        const filteredSelectedCount = filtered.reduce(
            (n, p) => n + (this.selectedIds.has(p.id) ? 1 : 0),
            0,
        );
        this.toolbarEl.style.display = count > 0 ? 'flex' : 'none';
        this.searchRowEl.style.display = count > 0 ? 'none' : '';
        this.selectCountEl.textContent = `${filteredSelectedCount} of ${filtered.length} selected`;

        const allSelected = filtered.length > 0 && filteredSelectedCount === filtered.length;
        const someSelected = filteredSelectedCount > 0 && filteredSelectedCount < filtered.length;
        this.selectAllCheckbox.classList.toggle('checked', allSelected);
        this.selectAllCheckbox.classList.toggle('indeterminate', someSelected);
        this.selectAllCheckbox.innerHTML = '';
        if (allSelected) {
            this.selectAllCheckbox.appendChild(icon(Check, 12));
        } else if (someSelected) {
            const dash = document.createElement('span');
            dash.textContent = '\u2013';
            dash.style.color = '#fff';
            dash.style.fontSize = '12px';
            dash.style.lineHeight = '1';
            this.selectAllCheckbox.appendChild(dash);
        }

        const start = (this.currentPage - 1) * this.pageSize;
        const pageProjects = filtered.slice(start, start + this.pageSize);
        const cards = this.gridEl.querySelectorAll('.project-card');
        cards.forEach((card, idx) => {
            const checkbox = card.querySelector('.project-card-checkbox');
            if (!checkbox) return;
            if (idx >= pageProjects.length) return;
            const pid = pageProjects[idx].id;
            const isSelected = this.selectedIds.has(pid);
            card.classList.toggle('selected', isSelected);
            checkbox.classList.toggle('checked', isSelected);
            checkbox.innerHTML = '';
            if (isSelected) {
                checkbox.appendChild(icon(Check, 14));
            }
        });
    }

    private async deleteSelected(): Promise<void> {
        const count = this.selectedIds.size;
        if (count === 0) return;

        const confirmed = await showConfirmModal(
            'Delete projects',
            (() => {
                const byId = new Map(this.projects.map((p) => [p.id, p]));
                const cloudCount = [...this.selectedIds].filter((id) => {
                    const p = byId.get(id);
                    return p?.isCloud || p?._cloudState === 'remote-only';
                }).length;
                const base = `Delete ${count} project${count !== 1 ? 's' : ''}? This cannot be undone.`;
                if (cloudCount === 0) return base;
                const signedIn = !!this.ctx.cloudSync.currentUserId();
                if (signedIn) {
                    return `${base}<div style="margin-top:12px;padding:10px 12px;background:rgba(138,27,27,0.2);border:1px solid rgba(220,80,80,0.4);border-radius:6px;font-size:12.5px;line-height:1.5;">`
                        + `<strong>⚠ ${cloudCount} of these ${cloudCount === 1 ? 'is a cloud project' : 'are cloud projects'}.</strong><br>`
                        + `Deleting ${cloudCount === 1 ? 'it' : 'them'} also removes ${cloudCount === 1 ? 'it' : 'them'} from parallaxpro.ai — source tree, published game, and version history all go away permanently.`
                        + `</div>`;
                }
                return `${base}<div style="margin-top:12px;padding:10px 12px;background:rgba(154,99,0,0.2);border:1px solid rgba(234,170,70,0.4);border-radius:6px;font-size:12.5px;line-height:1.5;">`
                    + `<strong>You're signed out</strong> — the ${cloudCount === 1 ? 'cloud copy' : `${cloudCount} cloud copies`} on parallaxpro.ai <strong>won't be deleted</strong>. Sign in first to cascade the delete.`
                    + `</div>`;
            })(),
        );
        if (!confirmed) return;

        const idsToDelete = [...this.selectedIds];
        const byId = new Map(this.projects.map((p) => [p.id, p]));
        for (const id of idsToDelete) {
            try {
                const proj = byId.get(id);
                if (proj?._cloudState === 'remote-only') {
                    await this.ctx.backend.deleteProjectProd(id);
                } else {
                    await this.ctx.backend.deleteProject(id);
                    if (proj?.isCloud) {
                        try { await this.ctx.backend.deleteProjectProd(id); }
                        catch (e: any) {
                            if (!(e?.status === 404)) console.warn('[delete] remote cascade failed:', e?.message ?? e);
                        }
                    }
                }
                this.projects = this.projects.filter(p => p.id !== id);
            } catch (e) {
                console.error('Failed to delete project:', id, e);
            }
        }
        this.selectedIds.clear();
        this.render();
        this.updateSelectionUI();
    }

    private showProjectMenu(project: any, x: number, y: number): void {
        const isPublished = project.status === 'published' && project.publishedSlug;

        const items: any[] = [
            { label: t('projectList.open'), action: () => this.onOpenProject?.(project.id) },
        ];

        {
            items.push({ label: t('projectList.rename'), action: () => this.renameProject(project) });
            items.push({ label: t('projectList.duplicate'), action: () => this.duplicateProject(project) });
            items.push({ label: project.thumbnail ? t('projectList.changeThumbnail') : t('projectList.setThumbnail'), action: () => this.setThumbnail(project) });
            if (project.thumbnail) {
                items.push({ label: t('projectList.removeThumbnail'), action: () => this.removeThumbnail(project) });
            }
            items.push({ label: '', separator: true });

            if (isPublished) {
                items.push({
                    label: t('projectList.viewPublishedGame'),
                    action: () => {
                        const origin = this.ctx.backend.isSelfHosted ? 'https://parallaxpro.ai' : window.location.origin;
                        window.open(`${origin}/games/${project.publishedOwner}/${project.publishedSlug}`, '_blank');
                    },
                });
                items.push({ label: t('projectList.updatePublish'), action: () => this.publishProject(project) });
                items.push({ label: t('projectList.unpublish'), action: () => this.unpublishProject(project) });
            } else {
                items.push({ label: t('toolbar.publish'), action: () => this.publishProject(project) });
            }

            items.push({ label: '', separator: true });
            items.push({ label: t('projectList.delete'), danger: true, action: () => this.deleteProject(project) });
        }

        showContextMenu(x, y, items);
    }

    private getNextProjectName(): string {
        let maxNum = 0;
        for (const p of this.projects) {
            const match = (p.name ?? '').match(/^project-(\d+)$/);
            if (match) {
                maxNum = Math.max(maxNum, parseInt(match[1]));
            }
        }
        return `project-${maxNum + 1}`;
    }

    private createProject(): void {
        const body = document.createElement('div');
        body.style.display = 'flex';
        body.style.flexDirection = 'column';
        body.style.gap = '16px';

        // ── Section 1: Generate from prompt ──
        const promptSection = document.createElement('div');
        promptSection.style.display = 'flex';
        promptSection.style.flexDirection = 'column';
        promptSection.style.gap = '8px';

        const label = document.createElement('label');
        label.textContent = t('projectList.generateFromPrompt');
        label.style.fontSize = '13px';
        label.style.fontWeight = '600';
        label.style.color = 'var(--text-secondary)';
        promptSection.appendChild(label);

        const promptHint = document.createElement('div');
        promptHint.textContent = t('projectList.generateHint');
        promptHint.style.fontSize = '11px';
        promptHint.style.color = 'var(--text-tertiary, #888)';
        promptSection.appendChild(promptHint);

        const textarea = document.createElement('textarea');
        textarea.placeholder = t('projectList.generatePlaceholder');
        textarea.maxLength = 2000;
        textarea.style.width = '100%';
        textarea.style.height = '100px';
        textarea.style.resize = 'vertical';
        textarea.style.fontSize = '13px';
        textarea.style.lineHeight = '1.5';
        textarea.style.padding = '8px 10px';
        textarea.style.background = 'var(--bg-input)';
        textarea.style.border = '1px solid var(--border)';
        textarea.style.borderRadius = 'var(--radius-sm)';
        textarea.style.color = 'var(--text-primary)';
        textarea.style.fontFamily = 'var(--font-family)';
        promptSection.appendChild(textarea);

        body.appendChild(promptSection);

        // ── Divider with "or" ──
        const divider = document.createElement('div');
        divider.style.display = 'flex';
        divider.style.alignItems = 'center';
        divider.style.gap = '12px';
        const divLine1 = document.createElement('div');
        divLine1.style.flex = '1';
        divLine1.style.height = '1px';
        divLine1.style.background = 'var(--border)';
        const divText = document.createElement('span');
        divText.textContent = t('projectList.or');
        divText.style.fontSize = '12px';
        divText.style.color = 'var(--text-tertiary, #888)';
        divText.style.flexShrink = '0';
        const divLine2 = document.createElement('div');
        divLine2.style.flex = '1';
        divLine2.style.height = '1px';
        divLine2.style.background = 'var(--border)';
        divider.appendChild(divLine1);
        divider.appendChild(divText);
        divider.appendChild(divLine2);
        body.appendChild(divider);

        // ── Section 2: Build from template ──
        const templateSection = document.createElement('div');
        templateSection.style.display = 'flex';
        templateSection.style.flexDirection = 'column';
        templateSection.style.gap = '8px';

        const templateLabel = document.createElement('label');
        templateLabel.textContent = t('projectList.buildFromTemplate');
        templateLabel.style.fontSize = '13px';
        templateLabel.style.fontWeight = '600';
        templateLabel.style.color = 'var(--text-secondary)';
        templateSection.appendChild(templateLabel);

        const templateHint = document.createElement('div');
        templateHint.textContent = t('projectList.templateHint');
        templateHint.style.fontSize = '11px';
        templateHint.style.color = 'var(--text-tertiary, #888)';
        templateSection.appendChild(templateHint);

        // Search input
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = t('projectList.templateSearch');
        searchInput.style.width = '100%';
        searchInput.style.fontSize = '13px';
        searchInput.style.padding = '7px 10px';
        searchInput.style.background = 'var(--bg-input)';
        searchInput.style.border = '1px solid var(--border)';
        searchInput.style.borderRadius = 'var(--radius-sm)';
        searchInput.style.color = 'var(--text-primary)';
        searchInput.style.fontFamily = 'var(--font-family)';
        templateSection.appendChild(searchInput);

        // Template list container
        const templateList = document.createElement('div');
        templateList.style.maxHeight = '180px';
        templateList.style.overflowY = 'auto';
        templateList.style.display = 'flex';
        templateList.style.flexDirection = 'column';
        templateList.style.gap = '4px';
        templateList.style.border = '1px solid var(--border)';
        templateList.style.borderRadius = 'var(--radius-sm)';
        templateList.style.padding = '4px';
        templateList.style.background = 'var(--bg-input)';
        templateSection.appendChild(templateList);

        let allTemplates: any[] = [];
        let selectedTemplateId = '';
        // When allTemplates came back from the semantic search endpoint it
        // is already ranked; re-filtering by substring would drop the
        // matches whose relevance the embedder picked up. `isRanked` skips
        // the client-side substring pass in that mode.
        let isRanked = false;

        const renderTemplateList = (filter: string) => {
            templateList.innerHTML = '';
            const query = filter.toLowerCase();
            const filtered = (isRanked || !query)
                ? allTemplates
                : allTemplates.filter(tmpl =>
                    tmpl.name.toLowerCase().includes(query) || tmpl.id.toLowerCase().includes(query) || (tmpl.description || '').toLowerCase().includes(query)
                );
            if (filtered.length === 0) {
                const empty = document.createElement('div');
                empty.textContent = query ? t('projectList.noTemplatesMatch') : t('projectList.loadingTemplates');
                empty.style.fontSize = '12px';
                empty.style.color = 'var(--text-tertiary, #888)';
                empty.style.padding = '8px';
                empty.style.textAlign = 'center';
                templateList.appendChild(empty);
                return;
            }
            for (const tmpl of filtered) {
                const item = document.createElement('div');
                item.style.display = 'flex';
                item.style.alignItems = 'center';
                item.style.justifyContent = 'space-between';
                item.style.padding = '6px 8px';
                item.style.borderRadius = '4px';
                item.style.cursor = 'pointer';
                item.style.fontSize = '12px';
                item.style.transition = 'background 0.1s';
                item.style.background = tmpl.id === selectedTemplateId ? 'var(--accent-bg, rgba(59,130,246,0.15))' : 'transparent';
                item.style.border = tmpl.id === selectedTemplateId ? '1px solid var(--accent, #3b82f6)' : '1px solid transparent';

                const info = document.createElement('div');
                const nameEl = document.createElement('div');
                nameEl.style.fontWeight = '600';
                nameEl.style.color = 'var(--text-primary)';
                nameEl.textContent = tmpl.name;
                const descEl = document.createElement('div');
                descEl.style.fontSize = '11px';
                descEl.style.color = 'var(--text-tertiary, #888)';
                descEl.style.marginTop = '1px';
                descEl.textContent = `${tmpl.description} · ${tmpl.entityCount} entities`;
                info.appendChild(nameEl);
                info.appendChild(descEl);
                item.appendChild(info);

                item.addEventListener('mouseenter', () => { if (tmpl.id !== selectedTemplateId) item.style.background = 'var(--bg-hover, rgba(255,255,255,0.04))'; });
                item.addEventListener('mouseleave', () => { if (tmpl.id !== selectedTemplateId) item.style.background = 'transparent'; });
                item.addEventListener('click', () => {
                    selectedTemplateId = selectedTemplateId === tmpl.id ? '' : tmpl.id;
                    renderTemplateList(searchInput.value);
                    // Mutual exclusion
                    textarea.disabled = !!selectedTemplateId;
                    textarea.style.opacity = selectedTemplateId ? '0.4' : '1';
                });
                templateList.appendChild(item);
            }
        };

        // Load templates from backend (catalog order)
        this.ctx.backend.listTemplates().then((data: any) => {
            allTemplates = data?.templates || [];
            isRanked = false;
            renderTemplateList('');
        }).catch(() => {});

        // Search: instant client-side substring filter while typing, then a
        // debounced semantic search that replaces the list with the
        // embedder's ranked results. Clearing the query restores catalog order.
        let searchTimer: any = null;
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.trim();

            if (searchTimer) clearTimeout(searchTimer);

            if (query.length === 0) {
                // Restore catalog order and re-enable substring filter.
                this.ctx.backend.listTemplates().then((data: any) => {
                    allTemplates = data?.templates || allTemplates;
                    isRanked = false;
                    renderTemplateList('');
                }).catch(() => {
                    isRanked = false;
                    renderTemplateList('');
                });
                return;
            }

            // Instant substring filter off whatever list we're currently
            // showing. If the list is already ranked, the substring pass is
            // skipped inside renderTemplateList so we don't hide semantic hits.
            renderTemplateList(searchInput.value);

            if (query.length >= 2) {
                searchTimer = setTimeout(() => {
                    this.ctx.backend.listTemplates(query).then((data: any) => {
                        if (searchInput.value.trim() === query) {
                            allTemplates = data?.templates || allTemplates;
                            isRanked = true;
                            renderTemplateList(query);
                        }
                    }).catch(() => {});
                }, 300);
            }
        });

        body.appendChild(templateSection);

        // ── Mutual exclusion ──
        textarea.addEventListener('input', () => {
            const hasPrompt = textarea.value.trim().length > 0;
            if (hasPrompt) {
                selectedTemplateId = '';
                renderTemplateList(searchInput.value);
            }
            searchInput.disabled = hasPrompt;
            searchInput.style.opacity = hasPrompt ? '0.4' : '1';
            templateList.style.opacity = hasPrompt ? '0.4' : '1';
            templateList.style.pointerEvents = hasPrompt ? 'none' : 'auto';
        });

        // ── Submit handlers ──
        const submitPrompt = async (prompt: string) => {
            const name = this.getNextProjectName();
            try {
                const project = await this.ctx.backend.createProject(undefined, prompt);
                const pid = project.projectId ?? project.id;
                this.projects.unshift({ id: pid, name: project.name ?? name, prompt, ...project });
                this.render();
                this.onOpenProject?.(pid, prompt);
            } catch (e) {
                console.error('Failed to create project:', e);
            }
        };

        const submitTemplate = async (templateId: string) => {
            const name = this.getNextProjectName();
            try {
                const project = await this.ctx.backend.createProject(undefined, undefined, templateId);
                const pid = project.projectId ?? project.id;
                this.projects.unshift({ id: pid, name: project.name ?? name, ...project });
                this.render();
                this.onOpenProject?.(pid);
            } catch (e) {
                console.error('Failed to create project from template:', e);
            }
        };

        const { close } = showModal({
            title: t('projectList.newProjectModal'),
            body,
            width: '520px',
            buttons: [
                { label: t('settings.cancel'), action: () => close() },
                {
                    label: t('projectList.generate'),
                    primary: true,
                    action: async () => {
                        if (selectedTemplateId) {
                            close();
                            await submitTemplate(selectedTemplateId);
                            return;
                        }
                        const prompt = textarea.value.trim();
                        if (!prompt) return;
                        close();
                        await submitPrompt(prompt);
                    },
                },
            ],
        });

        textarea.focus();

        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                const prompt = textarea.value.trim();
                if (!prompt) return;
                close();
                submitPrompt(prompt);
            }
        });
    }

    private async renameProject(project: any): Promise<void> {
        const newName = await showPromptModal(t('projectList.renameProject'), project.name, t('projectList.newNamePlaceholder'));
        if (!newName) return;
        try {
            await this.ctx.backend.renameProject(project.id, newName);
            project.name = newName;
            // Cloud project names live on prod too — mirror the rename
            // so other machines don't keep showing the old name. Also
            // roll the returned updatedAt into local's
            // cloud_pulled_updated_at so the next push's OCC check
            // uses the fresh value (otherwise a save right after a
            // rename would 409 with a stale expectedUpdatedAt).
            const userId = this.ctx.cloudSync.currentUserId();
            if (project.isCloud && this.ctx.backend.isSelfHosted && userId) {
                try {
                    const res = await this.ctx.backend.renameProjectProd(project.id, newName);
                    if (res?.updatedAt) {
                        await this.ctx.backend.markCloudLocal(project.id, {
                            cloudUserId: userId, cloudUpdatedAt: res.updatedAt,
                        });
                    }
                } catch (e) { console.warn('Cloud rename push failed:', e); }
            }
            this.render();
        } catch (e) {
            console.error('Failed to rename project:', e);
        }
    }

    private async duplicateProject(project: any): Promise<void> {
        try {
            const newProject = await this.ctx.backend.duplicateProject(project.id);
            this.projects.unshift(newProject);
            this.render();
        } catch (e) {
            console.error('Failed to duplicate project:', e);
        }
    }

    private async deleteProject(project: any): Promise<void> {
        const touchesCloud = project.isCloud || project._cloudState === 'remote-only';
        const signedIn = !!this.ctx.cloudSync.currentUserId();
        const name = escapeHtml(project.name ?? 'Untitled');
        let message: string;
        let title: string;
        if (!touchesCloud) {
            title = 'Delete project';
            message = `Are you sure you want to delete <strong>${name}</strong>? This cannot be undone.`;
        } else if (signedIn) {
            title = 'Delete cloud project';
            message = `<div style="margin-bottom:12px;">Delete <strong>${name}</strong>?</div>`
                + `<div style="padding:10px 12px;background:rgba(138,27,27,0.2);border:1px solid rgba(220,80,80,0.4);border-radius:6px;font-size:12.5px;line-height:1.5;">`
                + `<strong>⚠ This also deletes the project on parallaxpro.ai.</strong><br>`
                + `Other machines lose the source tree, and if this project is published the game at <code>/games/&lt;you&gt;/&lt;slug&gt;</code> and every version in its history go offline. All of it is permanent.`
                + `</div>`;
        } else {
            title = 'Delete local copy';
            message = `<div style="margin-bottom:12px;">Delete the local copy of <strong>${name}</strong>?</div>`
                + `<div style="padding:10px 12px;background:rgba(154,99,0,0.2);border:1px solid rgba(234,170,70,0.4);border-radius:6px;font-size:12.5px;line-height:1.5;">`
                + `<strong>You're signed out</strong> — the copy on parallaxpro.ai <strong>won't be deleted</strong>. Sign in first if you want the cascade.`
                + `</div>`;
        }
        const confirmed = await showConfirmModal(title, message);
        if (!confirmed) return;
        try {
            // Remote-only cards never had a local row — just delete on prod.
            if (project._cloudState === 'remote-only') {
                await this.ctx.backend.deleteProjectProd(project.id);
            } else {
                await this.ctx.backend.deleteProject(project.id);
                // Cascade to prod when this was a cloud project. Swallow 404s
                // since the server may have already deleted it.
                if (project.isCloud) {
                    try { await this.ctx.backend.deleteProjectProd(project.id); }
                    catch (e: any) {
                        if (!(e?.status === 404)) console.warn('[delete] remote cascade failed:', e?.message ?? e);
                    }
                }
            }
            this.projects = this.projects.filter(p => p.id !== project.id);
            this.selectedIds.delete(project.id);
            this.render();
            this.updateSelectionUI();
        } catch (e) {
            console.error('Failed to delete project:', e);
        }
    }

    private async publishProject(project: any): Promise<void> {
        // Shared flow with the toolbar's Publish button — same modal,
        // same validation, same self-hosted / hosted branches.
        const { PublishFlow } = await import('../widgets/publish_flow.js');
        await new PublishFlow(this.ctx).open(project.id, {
            id: project.id,
            name: project.name,
            thumbnail: project.thumbnail,
        });
        // Re-sync the list so the card reflects any new publish state.
        this.loadProjects();
    }

    private async setThumbnail(project: any): Promise<void> {
        // Warn when changing a cloud project's thumbnail while signed
        // out — local updates, prod stays old, other machines see the
        // drift until the next signed-in change.
        if (project.isCloud && this.ctx.backend.isSelfHosted && !this.ctx.cloudSync.currentUserId()) {
            const ok = await showConfirmModal(
                'Change thumbnail locally?',
                `You're signed out — the thumbnail on parallaxpro.ai won't be updated, so other machines will keep showing the old image until you change it again while signed in. Continue?`,
            );
            if (!ok) return;
        }
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            try {
                const result = await this.ctx.backend.uploadThumbnail(project.id, file);
                project.thumbnail = result.thumbnail;
                // Cloud projects mirror to prod so other machines see
                // the same thumbnail. Swallow the error — local already
                // saved, so at worst the other laptops show the old
                // image until the next successful sync.
                const uid = this.ctx.cloudSync.currentUserId();
                if (project.isCloud && this.ctx.backend.isSelfHosted && uid) {
                    try {
                        const prod = await this.ctx.backend.cloudThumbnailProd(project.id, file);
                        const abs = prod.thumbnail.startsWith('http')
                            ? prod.thumbnail
                            : `https://parallaxpro.ai${prod.thumbnail}`;
                        project.thumbnail = abs;
                        // Sync prod's new updated_at into local's OCC
                        // tracker so subsequent saves don't 409.
                        await this.ctx.backend.markCloudLocal(project.id, {
                            cloudUserId: uid, cloudUpdatedAt: prod.updatedAt, thumbnail: abs,
                        });
                    } catch (e) {
                        console.warn('Cloud thumbnail push failed:', e);
                    }
                }
                this.render();
            } catch (e) {
                console.error('Failed to upload thumbnail:', e);
            }
        });
        fileInput.click();
    }

    private async removeThumbnail(project: any): Promise<void> {
        try {
            await this.ctx.backend.deleteThumbnail(project.id);
            // Mirror the delete to prod for cloud projects so the card
            // doesn't keep showing an orphan image elsewhere.
            const uid = this.ctx.cloudSync.currentUserId();
            if (project.isCloud && this.ctx.backend.isSelfHosted && uid) {
                try {
                    const res = await this.ctx.backend.fetchProd(`/projects/${project.id}/thumbnail`, { method: 'DELETE' });
                    if (res?.updatedAt) {
                        await this.ctx.backend.markCloudLocal(project.id, {
                            cloudUserId: uid, cloudUpdatedAt: res.updatedAt,
                        });
                    }
                } catch (e) { console.warn('Cloud thumbnail delete failed:', e); }
            }
            project.thumbnail = null;
            this.render();
        } catch (e) {
            console.error('Failed to remove thumbnail:', e);
        }
    }

    private async unpublishProject(project: any): Promise<void> {
        const confirmed = await showConfirmModal(
            t('projectList.unpublishGame'),
            `This will take "${project.name}" offline. Players will no longer be able to access the published version.`
        );
        if (!confirmed) return;
        try {
            // Self-hosted's local OSS backend has no /publish route —
            // use the prod endpoint via fetchProd. Published projects
            // always exist on prod (share the same id), so this works.
            if (this.ctx.backend.isSelfHosted) {
                await this.ctx.backend.unpublishProd(project.id);
            } else {
                await this.ctx.backend.unpublishProject(project.id);
            }
            project.status = 'draft';
            project.publishedSlug = null;
            project.publishedOwner = null;
            this.render();
        } catch (e: any) {
            console.error('Failed to unpublish:', e);
            alert(e?.message === 'Authentication required'
                ? 'Your parallaxpro.ai session expired. Sign in and try again.'
                : e?.message || 'Failed to unpublish.');
        }
    }

    /**
     * Render the auth slot in the header (self-hosted only). Swaps between:
     *   - A "Login" button when no cli-login token is stored.
     *   - An avatar + dropdown (username, "Log out") when signed in.
     * Logging in/out both re-render the list so publish badges update.
     */
    private renderAuthSlot(): void {
        this.authSlot.innerHTML = '';
        const token = getStoredToken();
        const payload = token ? decodeToken(token) : null;
        const username = payload?.username || null;

        if (!username) {
            const loginBtn = document.createElement('button');
            loginBtn.className = 'toolbar-btn exit-btn';
            loginBtn.appendChild(icon(LogIn, 15));
            const lbl = document.createElement('span');
            lbl.textContent = ` ${t('projectList.login')}`;
            loginBtn.appendChild(lbl);
            loginBtn.title = t('projectList.loginTooltip');
            loginBtn.addEventListener('click', async () => {
                loginBtn.classList.add('disabled');
                try {
                    await ensureLoggedIn();
                    this.renderAuthSlot();
                    // Kick a reload so publish badges + thumbnails show up on
                    // already-published projects the user now has access to.
                    this.loadProjects();
                } catch (e: any) {
                    loginBtn.classList.remove('disabled');
                    console.warn('[auth] login cancelled:', e?.message ?? e);
                }
            });
            this.authSlot.appendChild(loginBtn);
            return;
        }

        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;display:flex;align-items:center;';

        const avatar = document.createElement('button');
        avatar.className = 'toolbar-btn';
        avatar.title = `Signed in as ${username}`;
        avatar.style.cssText = 'padding:4px 10px;display:flex;align-items:center;gap:8px;';
        avatar.appendChild(this.buildAvatar(username));
        const nameSpan = document.createElement('span');
        nameSpan.textContent = username;
        nameSpan.style.cssText = 'font-size:13px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        avatar.appendChild(nameSpan);

        const menu = document.createElement('div');
        menu.style.cssText = 'position:absolute;right:0;top:calc(100% + 6px);min-width:160px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,0.25);padding:4px 0;z-index:1000;display:none;';

        const emailRow = document.createElement('div');
        emailRow.style.cssText = 'padding:8px 12px;font-size:11px;color:var(--text-disabled);border-bottom:1px solid var(--border);';
        emailRow.textContent = payload?.email || '';
        if (payload?.email) menu.appendChild(emailRow);

        const logoutItem = document.createElement('button');
        logoutItem.style.cssText = 'width:100%;padding:8px 12px;display:flex;align-items:center;gap:8px;background:transparent;border:0;color:var(--text-primary);cursor:pointer;font-size:13px;text-align:left;';
        logoutItem.appendChild(icon(LogOut, 14));
        const logoutLabel = document.createElement('span');
        logoutLabel.textContent = t('projectList.logout');
        logoutItem.appendChild(logoutLabel);
        logoutItem.addEventListener('mouseenter', () => { logoutItem.style.background = 'var(--bg-input)'; });
        logoutItem.addEventListener('mouseleave', () => { logoutItem.style.background = 'transparent'; });
        logoutItem.addEventListener('click', () => {
            clearStoredToken();
            this.renderAuthSlot();
            this.loadProjects();
        });
        menu.appendChild(logoutItem);

        wrap.appendChild(avatar);
        wrap.appendChild(menu);

        let open = false;
        const closeOnOutside = (e: MouseEvent) => {
            if (!wrap.contains(e.target as Node)) {
                menu.style.display = 'none';
                open = false;
                document.removeEventListener('click', closeOnOutside);
            }
        };
        avatar.addEventListener('click', (e) => {
            e.stopPropagation();
            open = !open;
            menu.style.display = open ? 'block' : 'none';
            if (open) setTimeout(() => document.addEventListener('click', closeOnOutside), 0);
        });

        this.authSlot.appendChild(wrap);
    }

    /** Tiny deterministic initial-avatar — no external service needed. */
    private buildAvatar(username: string): HTMLElement {
        const av = document.createElement('div');
        const letter = (username[0] || '?').toUpperCase();
        // Hash username → one of a handful of hues so repeat visits stay consistent.
        let h = 0;
        for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) >>> 0;
        const hue = h % 360;
        av.textContent = letter;
        av.style.cssText = `width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:600;flex-shrink:0;background:hsl(${hue},55%,45%);`;
        return av;
    }

    /** Called by main.ts's clearView when swapping to the editor. Without
     *  this, our generation poll + tick timers keep firing against an
     *  orphaned DOM — harmless but wasteful (and the console gets noisy
     *  if the backend starts 401ing after sign-out). */
    destroy(): void {
        if (this.generationPollTimer) {
            clearInterval(this.generationPollTimer);
            this.generationPollTimer = 0;
        }
        if (this.generationTickTimer) {
            clearInterval(this.generationTickTimer);
            this.generationTickTimer = 0;
        }
        if (this.resizeObserver) {
            try { this.resizeObserver.disconnect(); } catch {}
            this.resizeObserver = null;
        }
    }

    /**
     * Build the generation-state block for a project card. Shows the
     * live elapsed timer + current status + STOP while a job is active,
     * or a "Build failed" row with the error when the last run failed.
     */
    private createGenerationBlock(project: any): HTMLElement {
        const block = document.createElement('div');
        block.className = 'project-generation-block';
        const gen = project.generation || {};

        if (gen.active) {
            const queued = gen.queuePosition && gen.queuePosition.position > 0;

            const header = document.createElement('div');
            header.className = 'project-generation-header';

            const badge = document.createElement('span');
            badge.className = queued ? 'project-generation-badge queued' : 'project-generation-badge running';
            // 'fix' = mobile-background FIX_GAME (file patch, fast, no email);
            // 'create' (default) = full from-scratch CREATE_GAME.
            const isFix = gen.kind === 'fix';
            badge.textContent = queued
                ? `QUEUED #${gen.queuePosition.position}`
                : (isFix ? 'FIXING' : 'GENERATING');
            header.appendChild(badge);

            // Elapsed: live-ticking span. The per-second tick timer finds
            // these by `data-generation-started-at` and mutates their
            // textContent — no re-render needed.
            const startedMs = gen.startedAt ? Date.parse(gen.startedAt) : Date.now();
            const timer = document.createElement('span');
            timer.className = 'project-generation-elapsed';
            timer.dataset.generationStartedAt = String(startedMs);
            timer.textContent = formatElapsed(Date.now() - startedMs);
            header.appendChild(timer);

            const stopBtn = document.createElement('button');
            stopBtn.className = 'project-generation-stop';
            stopBtn.title = t('projectList.stopTooltip');
            stopBtn.appendChild(icon(Square, 12));
            const stopLabel = document.createElement('span');
            stopLabel.textContent = t('projectList.stopBuild');
            stopBtn.appendChild(stopLabel);
            stopBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const ok = await showConfirmModal(
                    t('projectList.stopBuildConfirmTitle'),
                    t('projectList.stopBuildConfirmMsg'),
                );
                if (!ok) return;
                try {
                    await this.ctx.backend.stopGeneration(project.id);
                } catch (err: any) {
                    // 404 just means the job finished between click and
                    // request — treat as a no-op.
                    if (err?.status !== 404) {
                        alert(err?.message || 'Failed to stop the build.');
                    }
                }
                this.loadProjects();
            });
            header.appendChild(stopBtn);

            block.appendChild(header);

            if (gen.lastStatus) {
                const status = document.createElement('div');
                status.className = 'project-generation-status';
                status.textContent = gen.lastStatus;
                block.appendChild(status);
            }

            if (gen.description) {
                const desc = document.createElement('div');
                desc.className = 'project-generation-desc';
                desc.textContent = gen.description.length > 140
                    ? gen.description.slice(0, 137) + '\u2026'
                    : gen.description;
                desc.title = gen.description;
                block.appendChild(desc);
            }

            // Stale-heartbeat warning: fires when the CLI hasn't emitted
            // a tool-use event in a while. The threshold is 10 min
            // because healthy runs regularly pause for several minutes
            // during model reasoning or long bash calls (validate.sh
            // runs a 180-frame headless smoke test, and agents
            // commonly chain 3-4 minute thinking passes between
            // edits) — tighter thresholds cried wolf on good runs.
            if (gen.lastHeartbeatAt) {
                const since = Date.now() - Date.parse(gen.lastHeartbeatAt);
                if (since > 10 * 60 * 1000) {
                    const warn = document.createElement('div');
                    warn.className = 'project-generation-warn';
                    warn.textContent = `No progress in ${formatElapsed(since)} — build may be stuck.`;
                    block.appendChild(warn);
                }
            }
        } else if (gen.lastError) {
            const header = document.createElement('div');
            header.className = 'project-generation-header';

            const badge = document.createElement('span');
            badge.className = 'project-generation-badge failed';
            badge.textContent = t('projectList.buildFailed');
            header.appendChild(badge);

            const dismiss = document.createElement('button');
            dismiss.className = 'project-generation-stop';
            dismiss.title = 'Dismiss (will clear next time a build runs)';
            dismiss.appendChild(icon(X, 12));
            dismiss.addEventListener('click', (e) => {
                e.stopPropagation();
                // Optimistic UI first — clear locally so the tile
                // disappears immediately. Then ask the backend to wipe
                // generation_last_error so the notice doesn't come back
                // the next time the list re-fetches (opening a project
                // then returning would otherwise re-render it).
                if (project.generation) project.generation = null;
                this.render();
                this.refreshGenerationTimers();
                this.ctx.backend.dismissGenerationError(project.id).catch((err: any) => {
                    console.warn('[projects] dismissGenerationError failed:', err?.message);
                });
            });
            header.appendChild(dismiss);

            block.appendChild(header);

            const err = document.createElement('div');
            err.className = 'project-generation-error';
            err.textContent = gen.lastError;
            // The strip truncates long errors — full text on hover.
            err.title = gen.lastError;
            block.appendChild(err);
        } else if (gen.lastSuccessAt) {
            // Compact green strip, mirrors the failed variant.
            // Auto-cleared server-side the next time the user opens
            // the project (GET /:id nulls generation_last_success_at).
            // Click anywhere outside the X still opens the project —
            // the top-level card click handler takes it from there.
            const header = document.createElement('div');
            header.className = 'project-generation-header';

            const badge = document.createElement('span');
            badge.className = 'project-generation-badge success';
            badge.textContent = t('projectList.justBuilt');
            header.appendChild(badge);

            const hint = document.createElement('span');
            hint.className = 'project-generation-status';
            hint.textContent = t('projectList.clickToOpen');
            header.appendChild(hint);

            const dismiss = document.createElement('button');
            dismiss.className = 'project-generation-stop';
            dismiss.title = 'Dismiss';
            dismiss.appendChild(icon(X, 12));
            dismiss.addEventListener('click', (e) => {
                e.stopPropagation();
                if (project.generation) project.generation = null;
                this.render();
                this.refreshGenerationTimers();
                this.ctx.backend.dismissGenerationSuccess(project.id).catch((err: any) => {
                    console.warn('[projects] dismissGenerationSuccess failed:', err?.message);
                });
            });
            header.appendChild(dismiss);

            block.appendChild(header);
        }

        // Individual interactive children (STOP, dismiss X) already
        // stopPropagation on their own click handlers. Clicks on the
        // rest of the block are allowed to bubble to the card so the
        // user can click anywhere on a just-built / failed card to
        // open the project. The running-state card's top-level handler
        // is a no-op while gen.active anyway.

        return block;
    }
}

/** Elapsed duration in ms → "3m 22s" / "45s" / "1h 3m". */
function formatElapsed(ms: number): string {
    if (!isFinite(ms) || ms < 0) return '0s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${rm}m`;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]!));
}
