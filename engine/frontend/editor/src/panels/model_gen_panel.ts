/**
 * model_gen_panel.ts — "3D Model Generate" tab in the AI Assistant column.
 *
 * Two-step flow:
 *   1. Preview — fal.ai text-to-image OR user upload — show as preview.
 *   2. Confirm — TRELLIS image-to-3D, queued and polled.
 *
 * Self-contained. On a self-hosted Open-ParallaxPro clone without the
 * model_gen plugin, the first /preview call returns 404 and the panel
 * renders a "feature not available" stub. Generated GLBs drag into the
 * scene with the same payload shape as curated 3D assets.
 */

import { t } from '../i18n/index.js';

interface GeneratedModel {
    id: string;
    glb_path: string;
    thumb_path: string;
    bbox?: any;
    est_scale_m?: number | null;
    up_axis?: string;
    forward_axis?: string;
    poly_count?: number;
    tex_size?: number;
    visibility?: 'shared' | 'private';
}

interface LibraryItem {
    job_id: string;
    kind: 'text' | 'image';
    prompt: string | null;
    status: string;
    error: string | null;
    created_at: number;
    model: GeneratedModel | null;
}

interface ActiveJob {
    job_id: string;
    status: string;
    queue_position?: number;
    last_progress?: string | null;
    prompt: string | null;
    /** Concatenated key (status + last_progress) of the current stage. */
    stage_key?: string;
    /** Server-side wall-clock ms when the current stage actually started.
     *  Comes from last_progress_at / claimed_at / created_at depending
     *  on stage. Survives page refresh — timer keeps counting. */
    stage_started_at?: number;
    /** Server-supplied error string when status === 'failed'. We KEEP the
     *  job in the activeJobs map after a failure so the user sees it
     *  failed instead of silently disappearing — they dismiss with a × ;
     *  removed jobs only become invisible after explicit dismiss. */
    error?: string | null;
}

const API_BASE = '/api/engine/models';
const POLL_INTERVAL_MS = 3000;
const LIBRARY_PAGE_SIZE = 50;
/** Pixels-from-bottom that triggers a loadMore. */
const SCROLL_LOAD_THRESHOLD_PX = 200;
/** Mirror of MIN_PROMPT_LEN on the server. Backend rejects shorter
 *  prompts; we gate the button so users get instant feedback. */
const MIN_PROMPT_LEN = 5;
/** Mirror of PREVIEW_COOLDOWN_MS on the server. Used as the default
 *  countdown when starting cooldown on a successful preview; the 429
 *  cooldown response carries its own retry_after_ms which wins. */
const PREVIEW_COOLDOWN_MS = 30_000;

type Mode = 'text' | 'image';
type Step = 'idle' | 'previewed' | 'submitting';

function authHeaders(): Record<string, string> {
    const token = localStorage.getItem('auth_token') ?? localStorage.getItem('token');
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
}

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(API_BASE + path, {
        ...init,
        headers: { ...authHeaders(), ...(init?.headers as Record<string, string> ?? {}) },
    });
    if (res.status === 404) {
        const err = new Error('not_available');
        (err as any).status = 404;
        throw err;
    }
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body?.message || body?.error || `API error ${res.status}`);
        (err as any).status = res.status;
        (err as any).payload = body;
        throw err;
    }
    return res.json();
}

async function uploadImage(file: File): Promise<{ preview_url: string }> {
    const fd = new FormData();
    fd.append('image', file);
    const token = localStorage.getItem('auth_token') ?? localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/preview/upload`, { method: 'POST', headers, body: fd });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || body?.error || `upload failed ${res.status}`);
    }
    return res.json();
}

export class ModelGenPanel {
    readonly el: HTMLElement;

    private healthBanner!: HTMLDivElement;
    private healthLeft!: HTMLSpanElement;
    private healthTimer: number | null = null;
    private usageLabel!: HTMLSpanElement;
    private modeTabs!: HTMLDivElement;
    private formArea!: HTMLDivElement;
    private previewArea!: HTMLDivElement;
    private statusBar!: HTMLDivElement;
    private libraryGrid!: HTMLDivElement;
    private librarySearchInput!: HTMLInputElement;
    private librarySearchTimer: number | null = null;
    private activeSection!: HTMLDivElement;
    private activeList!: HTMLDivElement;

    private mode: Mode = 'text';
    private step: Step = 'idle';
    private currentPreviewUrl: string | null = null;
    private currentPrompt: string | null = null;
    /** Hardcoded for now — UI surfaced quality presets felt like clutter
     *  for the default user. Backend still accepts the param if we ever
     *  want to expose Fast / Standard / High again. */
    private readonly currentQuality: string = 'standard';

    /** Which library scope to render — user's own generations vs the
     *  full shared community pool. */
    private libraryScope: 'mine' | 'community' = 'mine';

    private pollTimer: number | null = null;
    private activeJobs = new Map<string, ActiveJob>();
    private library: LibraryItem[] = [];
    private mounted = false;

    /** Cursor-based infinite scroll state for the current scope/search.
     *  Reset on scope change, search input, or manual refresh. */
    private libraryOldestTs: number | null = null;
    private libraryExhausted = false;
    private libraryLoading = false;

    constructor() {
        this.el = document.createElement('div');
        this.el.className = 'mg-panel';
        this.buildUI();
    }

    onShow(): void {
        if (!this.mounted) {
            this.mounted = true;
            this.refreshLibrary();
            this.refreshHealth();
            this.refreshUsage();
        }
        // Re-check health every 30s while the tab is visible.
        if (this.healthTimer == null) {
            this.healthTimer = window.setInterval(() => this.refreshHealth(), 30000);
        }
    }

    // ── UI build ─────────────────────────────────────────────────────

    private buildUI(): void {
        // GPU pool health banner — small dot + label at top of the tab.
        // Right side carries the user's "daily N%" usage so they always
        // see how much budget is left without leaving the panel.
        this.healthBanner = document.createElement('div');
        this.healthBanner.className = 'mg-health';
        this.healthLeft = document.createElement('span');
        this.healthLeft.className = 'mg-health-left';
        this.healthLeft.innerHTML = `<span class="mg-health-dot unknown"></span><span>${escapeHtml(t('modelGen.health.checking'))}</span>`;
        this.healthBanner.appendChild(this.healthLeft);
        this.usageLabel = document.createElement('span');
        this.usageLabel.className = 'mg-usage';
        this.usageLabel.textContent = '';
        this.usageLabel.title = 'Daily generation budget. Resets at midnight UTC.';
        this.healthBanner.appendChild(this.usageLabel);
        this.el.appendChild(this.healthBanner);

        // Sharing notice — two practical things the user needs to know:
        // (1) check Community before generating, and (2) generated content
        // is public.
        const notice = document.createElement('div');
        notice.className = 'mg-notice';
        notice.innerHTML =
            `<b>${escapeHtml(t('modelGen.notice.searchFirstBold'))}</b> ${escapeHtml(t('modelGen.notice.searchFirstBody'))}<br>` +
            `<b>${escapeHtml(t('modelGen.notice.publicBold'))}</b> ${escapeHtml(t('modelGen.notice.publicBody'))}`;
        this.el.appendChild(notice);

        // Mode tabs (Text / Image). Image is disabled for now — TRELLIS.2's
        // image-to-3D pipeline is wired up but we want to ship text-only first
        // (avoids a second NSFW classifier round-trip on every upload + lets
        // us validate generations end-to-end before users can upload arbitrary
        // images). Re-enable by removing the disabled flag.
        this.modeTabs = document.createElement('div');
        this.modeTabs.className = 'mg-mode-tabs';
        const textBtn = this.makeModeButton('text', t('modelGen.mode.fromText'));
        const imageBtn = this.makeModeButton('image', t('modelGen.mode.fromImage'), true);
        this.modeTabs.appendChild(textBtn);
        this.modeTabs.appendChild(imageBtn);
        this.el.appendChild(this.modeTabs);

        // Form area (varies by mode + step)
        this.formArea = document.createElement('div');
        this.formArea.className = 'mg-card';
        this.el.appendChild(this.formArea);

        // Preview area (shown when step = previewed)
        this.previewArea = document.createElement('div');
        this.previewArea.className = 'mg-card';
        this.previewArea.style.display = 'none';
        this.el.appendChild(this.previewArea);

        // Status bar (errors, info)
        this.statusBar = document.createElement('div');
        this.statusBar.className = 'mg-status';
        this.el.appendChild(this.statusBar);

        // Active jobs list
        this.activeSection = document.createElement('div');
        this.activeSection.className = 'mg-section';
        this.activeSection.style.display = 'none';
        const activeHeader = document.createElement('div');
        activeHeader.textContent = t('modelGen.active.header');
        activeHeader.className = 'mg-section-header';
        this.activeSection.appendChild(activeHeader);
        this.activeList = document.createElement('div');
        this.activeList.className = 'mg-section';
        this.activeSection.appendChild(this.activeList);
        this.el.appendChild(this.activeSection);

        // Library scope tabs (My / Community) + refresh
        const libHeader = document.createElement('div');
        libHeader.className = 'mg-lib-header';
        const makeScopeBtn = (s: 'mine' | 'community', label: string) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.dataset.scope = s;
            b.className = 'mg-scope-tab';
            b.addEventListener('click', () => this.setLibraryScope(s));
            return b;
        };
        const myBtn = makeScopeBtn('mine', t('modelGen.library.scopeMine'));
        const commBtn = makeScopeBtn('community', t('modelGen.library.scopeCommunity'));
        libHeader.appendChild(myBtn);
        libHeader.appendChild(commBtn);
        const refreshBtn = document.createElement('button');
        refreshBtn.textContent = '↻';
        refreshBtn.title = t('modelGen.library.refresh');
        refreshBtn.className = 'mg-lib-refresh';
        refreshBtn.addEventListener('click', () => this.refreshLibrary());
        libHeader.appendChild(refreshBtn);
        this.el.appendChild(libHeader);
        this.updateScopeButtons();

        // Multi-lingual search input. Debounced; empty value falls back to
        // the recent-first list.
        this.librarySearchInput = document.createElement('input');
        this.librarySearchInput.type = 'search';
        this.librarySearchInput.placeholder = t('modelGen.library.search');
        this.librarySearchInput.className = 'mg-search';
        this.librarySearchInput.addEventListener('input', () => {
            if (this.librarySearchTimer != null) window.clearTimeout(this.librarySearchTimer);
            this.librarySearchTimer = window.setTimeout(() => this.refreshLibrary(), 250);
        });
        this.el.appendChild(this.librarySearchInput);

        this.libraryGrid = document.createElement('div');
        this.libraryGrid.className = 'mg-lib-grid';
        this.libraryGrid.innerHTML = `<div class="mg-lib-empty">${escapeHtml(t('modelGen.library.empty'))}</div>`;
        this.el.appendChild(this.libraryGrid);

        // Infinite scroll on the panel's own scroll container. Search
        // mode skips loadMore (semantic search returns ranked top-N,
        // doesn't paginate cleanly).
        this.el.addEventListener('scroll', () => {
            const remaining = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight;
            if (remaining < SCROLL_LOAD_THRESHOLD_PX) this.loadMoreLibrary();
        });

        this.renderForm();
    }

    private makeModeButton(mode: Mode, label: string, disabled = false): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.dataset.mode = mode;
        btn.textContent = label;
        // Visually-present-but-unclickable state. Blur + low opacity +
        // not-allowed cursor signal "off"; tab stays in the bar so users
        // see the feature is on the roadmap. No click handler — clicks
        // are inert.
        btn.className = disabled ? 'mg-mode-tab disabled' : 'mg-mode-tab';
        if (!disabled) btn.addEventListener('click', () => this.setMode(mode));
        return btn;
    }

    private setMode(mode: Mode): void {
        this.mode = mode;
        this.step = 'idle';
        this.currentPreviewUrl = null;
        this.currentPrompt = null;
        this.statusBar.textContent = '';
        this.previewArea.style.display = 'none';
        this.updateModeTabs();
        this.renderForm();
    }

    private updateModeTabs(): void {
        for (const el of Array.from(this.modeTabs.children) as HTMLButtonElement[]) {
            const isActive = el.dataset.mode === this.mode;
            el.classList.toggle('active', isActive);
        }
    }

    // ── Form (varies by mode) ────────────────────────────────────────

    private renderForm(): void {
        this.formArea.innerHTML = '';
        if (this.mode === 'text') this.renderTextForm();
        else this.renderImageForm();
        this.updateModeTabs();
    }

    private renderTextForm(): void {
        const label = document.createElement('label');
        label.textContent = t('modelGen.text.label');
        label.className = 'mg-label';
        this.formArea.appendChild(label);

        const wrapper = document.createElement('div');
        wrapper.className = 'mg-input-wrapper';

        const promptInput = document.createElement('textarea');
        promptInput.placeholder = t('modelGen.text.placeholder');
        promptInput.maxLength = 300;
        promptInput.value = this.currentPrompt ?? '';
        promptInput.className = 'mg-textarea';
        promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); previewBtn.click(); }
        });
        wrapper.appendChild(promptInput);

        const previewBtn = document.createElement('button');
        previewBtn.textContent = t('modelGen.text.previewBtn');
        previewBtn.className = 'mg-preview-btn';
        previewBtn.addEventListener('click', async () => {
            const prompt = promptInput.value.trim();
            if (!prompt) { this.statusBar.textContent = t('modelGen.text.needPrompt'); return; }
            if (prompt.length < MIN_PROMPT_LEN) {
                this.statusBar.textContent = t('modelGen.text.tooShort').replace('{min}', String(MIN_PROMPT_LEN));
                return;
            }
            this.currentPrompt = prompt;
            previewBtn.disabled = true;
            this.statusBar.textContent = t('modelGen.text.generating');
            // Decide in the try/catch whether to start a cooldown after this
            // press. Cache hits and validation failures don't cool down; a
            // paid fal call or a server cooldown 429 does. The finally block
            // either re-enables the button or hands off to the countdown.
            let cooldownMs = 0;
            try {
                const resp = await api<any>('/preview/text', {
                    method: 'POST',
                    body: JSON.stringify({ prompt, quality: this.currentQuality }),
                });
                if (typeof resp.usage_pct === 'number') this.renderUsage(resp.usage_pct, resp.limit_pct ?? 100, null);
                if (resp.cache_hit && resp.model) {
                    this.statusBar.textContent = t('modelGen.submit.cacheHit');
                    setTimeout(() => { this.statusBar.textContent = ''; }, 4000);
                    this.refreshLibrary();
                    return;
                }
                this.currentPreviewUrl = resp.preview_url;
                this.step = 'previewed';
                this.statusBar.textContent = '';
                this.showPreview();
                cooldownMs = PREVIEW_COOLDOWN_MS;
            } catch (e: any) {
                if (e?.status === 429 && e?.payload?.error === 'preview_cooldown') {
                    this.statusBar.textContent = e.payload.message || e.message;
                    cooldownMs = typeof e.payload.retry_after_ms === 'number'
                        ? e.payload.retry_after_ms
                        : PREVIEW_COOLDOWN_MS;
                } else if (e?.status === 429 && e?.payload?.error === 'daily_limit_reached') {
                    this.statusBar.textContent = e.message;
                    if (typeof e.payload.usage_pct === 'number') this.renderUsage(e.payload.usage_pct, e.payload.limit_pct ?? 100, null);
                } else if (e?.status === 402 && e?.payload?.error === 'signup_required') {
                    // Anonymous users hit this from requireRealUser. Use the
                    // server's friendly message verbatim — it already nudges
                    // them to sign up.
                    this.statusBar.textContent = e.payload.message || 'Sign up for a free account to use 3D model generation.';
                    this.statusBar.style.color = '#fbbf24';
                } else {
                    this.statusBar.textContent = t('modelGen.errorPrefix').replace('{message}', e.message || t('modelGen.text.previewFailed'));
                }
            } finally {
                if (cooldownMs > 0) {
                    this.startPreviewCooldown(previewBtn, cooldownMs);
                } else {
                    previewBtn.disabled = false;
                }
            }
        });
        const actions = document.createElement('div');
        actions.className = 'mg-input-actions';
        actions.appendChild(previewBtn);
        wrapper.appendChild(actions);
        this.formArea.appendChild(wrapper);
    }

    private renderImageForm(): void {
        const label = document.createElement('label');
        label.textContent = t('modelGen.image.label');
        label.className = 'mg-label';
        this.formArea.appendChild(label);

        const dropZone = document.createElement('label');
        dropZone.className = 'mg-dropzone';
        dropZone.innerHTML = `<div class="mg-dropzone-primary">${escapeHtml(t('modelGen.image.dropPrimary'))}</div><div class="mg-dropzone-hint">${escapeHtml(t('modelGen.image.dropHint'))}</div>`;

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/png,image/jpeg,image/webp';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => this.handleImageUpload(fileInput.files?.[0]));
        dropZone.appendChild(fileInput);

        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
        dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('drag-over'); });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            this.handleImageUpload(e.dataTransfer?.files?.[0]);
        });

        this.formArea.appendChild(dropZone);
    }

    private async handleImageUpload(file?: File | null): Promise<void> {
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) {
            this.statusBar.textContent = t('modelGen.image.tooLarge');
            return;
        }
        this.statusBar.textContent = t('modelGen.image.uploading');
        try {
            const resp = await uploadImage(file);
            this.currentPreviewUrl = resp.preview_url;
            this.currentPrompt = null;
            this.step = 'previewed';
            this.statusBar.textContent = '';
            this.showPreview();
        } catch (e: any) {
            this.statusBar.textContent = t('modelGen.errorPrefix').replace('{message}', e.message || t('modelGen.image.uploadFailed'));
        }
    }

    // ── Preview + confirm ────────────────────────────────────────────

    private showPreview(): void {
        this.previewArea.innerHTML = '';
        this.previewArea.style.display = 'flex';

        const label = document.createElement('div');
        label.textContent = this.mode === 'text' ? t('modelGen.preview.labelText') : t('modelGen.preview.labelImage');
        label.className = 'mg-label';
        this.previewArea.appendChild(label);

        const img = document.createElement('img');
        img.src = this.currentPreviewUrl ?? '';
        img.className = 'mg-preview-img';
        this.previewArea.appendChild(img);

        const row = document.createElement('div');
        row.className = 'mg-row';

        const refineBtn = document.createElement('button');
        refineBtn.textContent = this.mode === 'text' ? t('modelGen.preview.refinePrompt') : t('modelGen.preview.chooseDifferent');
        refineBtn.style.flex = '1';
        refineBtn.addEventListener('click', () => {
            this.step = 'idle';
            this.currentPreviewUrl = null;
            this.previewArea.style.display = 'none';
            this.statusBar.textContent = '';
        });
        row.appendChild(refineBtn);

        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = t('modelGen.preview.confirm');
        confirmBtn.className = 'primary';
        confirmBtn.style.flex = '1';
        confirmBtn.addEventListener('click', async () => {
            if (confirmBtn.disabled) return;
            confirmBtn.disabled = true;
            try {
                await this.confirm();
            } finally {
                confirmBtn.disabled = false;
            }
        });
        row.appendChild(confirmBtn);
        this.previewArea.appendChild(row);
    }

    private async confirm(): Promise<void> {
        if (!this.currentPreviewUrl) return;
        this.step = 'submitting';
        this.statusBar.textContent = t('modelGen.submit.submitting');
        try {
            const body: any = {
                preview_url: this.currentPreviewUrl,
                quality: this.currentQuality,
            };
            if (this.currentPrompt) body.prompt = this.currentPrompt;
            const resp = await api<any>('/generate', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            if (typeof resp.usage_pct === 'number') this.renderUsage(resp.usage_pct, resp.limit_pct ?? 100, null);
            if (resp.cache_hit && resp.model) {
                this.statusBar.textContent = t('modelGen.submit.cacheHit');
                this.refreshLibrary();
            } else {
                this.activeJobs.set(resp.job_id, {
                    job_id: resp.job_id,
                    status: 'queued',
                    queue_position: resp.queue_position,
                    prompt: this.currentPrompt,
                });
                this.renderActive();
                this.startPolling();
                // No status text — the In-flight section below already
                // shows "<prompt> — queue #N" for this job.
                this.statusBar.textContent = '';
            }
            // Reset form back to idle
            this.step = 'idle';
            this.currentPreviewUrl = null;
            this.previewArea.style.display = 'none';
            this.renderForm();
        } catch (e: any) {
            if (e?.status === 429 && e?.payload?.error === 'daily_limit_reached') {
                this.statusBar.textContent = e.message;
                if (typeof e.payload.usage_pct === 'number') this.renderUsage(e.payload.usage_pct, e.payload.limit_pct ?? 100, null);
            } else if (e?.status === 402 && e?.payload?.error === 'signup_required') {
                this.statusBar.textContent = e.payload.message || 'Sign up for a free account to use 3D model generation.';
                this.statusBar.style.color = '#fbbf24';
            } else {
                this.statusBar.textContent = t('modelGen.errorPrefix').replace('{message}', e.message || t('modelGen.submit.submitFailed'));
            }
            this.step = 'previewed';
        }
    }

    // ── Polling + library (unchanged from v1) ─────────────────────────

    private startPolling(): void {
        if (this.pollTimer != null) return;
        this.pollTimer = window.setInterval(() => this.pollAll(), POLL_INTERVAL_MS);
    }
    private stopPolling(): void {
        if (this.pollTimer != null) { window.clearInterval(this.pollTimer); this.pollTimer = null; }
    }

    private async pollAll(): Promise<void> {
        if (this.activeJobs.size === 0) { this.stopPolling(); return; }
        // Only poll non-terminal jobs. Failed jobs sit in activeJobs as
        // sticky failure rows until the user dismisses them; re-polling
        // them returns the same error every time.
        const inflightIds = Array.from(this.activeJobs.values())
            .filter(j => j.status !== 'failed')
            .map(j => j.job_id);
        if (inflightIds.length === 0) {
            this.stopPolling();
            this.stopActiveTimerTick();
            return;
        }
        const toRemove: string[] = [];
        const updates = await Promise.all(
            inflightIds.map(async id => {
                try { return await api<any>(`/jobs/${encodeURIComponent(id)}`); }
                catch { return null; }
            })
        );
        let libraryDirty = false;
        for (const j of updates) {
            if (!j) continue;
            const existing = this.activeJobs.get(j.job_id);
            if (!existing) continue;
            if (j.status === 'done' || j.status === 'canceled') {
                // 'done' moves to library on libraryDirty=true; 'canceled'
                // is user-initiated so they already know.
                toRemove.push(j.job_id);
                if (j.status === 'done') libraryDirty = true;
            } else if (j.status === 'failed') {
                // Keep the job visible with a failure indicator + dismiss
                // button. Update the entry in-place so renderActive picks
                // up the error message. Stops the spinner via the new
                // status; the timer tick keeps showing how long it ran.
                this.activeJobs.set(j.job_id, {
                    job_id: j.job_id,
                    status: 'failed',
                    last_progress: j.last_progress,
                    prompt: existing.prompt,
                    stage_started_at: existing.stage_started_at,
                    error: typeof j.error === 'string' && j.error.length > 0 ? j.error : null,
                });
            } else {
                const newKey = `${j.status}|${j.last_progress || ''}`;
                // Server-supplied timestamps so the timer reflects
                // actual wall-clock time, not when the editor first
                // observed the stage. Refresh-safe.
                const serverStart = (j.last_progress_at ?? j.claimed_at ?? j.created_at) as number | undefined;
                this.activeJobs.set(j.job_id, {
                    job_id: j.job_id,
                    status: j.status,
                    queue_position: j.queue_position,
                    last_progress: j.last_progress,
                    prompt: existing.prompt,
                    stage_key: newKey,
                    stage_started_at: serverStart ?? existing.stage_started_at,
                });
            }
        }
        for (const id of toRemove) this.activeJobs.delete(id);
        this.renderActive();
        if (libraryDirty) this.refreshLibrary();
        // Stop polling + timer once no non-terminal jobs remain. Failed
        // sticky rows can sit indefinitely; they don't need ticks.
        const stillInflight = Array.from(this.activeJobs.values()).some(j => j.status !== 'failed');
        if (!stillInflight) {
            this.stopPolling();
            this.stopActiveTimerTick();
        }
    }

    /** Stage classification, 1..5:
     *    1  queued
     *    2  starting (worker just claimed)
     *    3  fetching source image
     *    4  generating
     *    5  uploading
     *
     *  Status can move BACKWARDS too: if the worker drops mid-job, the
     *  reaper requeues it (status: generating → queued, worker_id null)
     *  and the next poll surfaces stage 1 again. This is a feature, not
     *  a bug — show the user where the job actually is right now. */
    private stageInfo(j: ActiveJob): { label: string; index: number; total: number } | null {
        const lp = (j.last_progress || '').toLowerCase();
        const T = 5;
        if (j.status === 'queued') return { label: t('modelGen.active.stageQueued'), index: 1, total: T };
        if (j.status === 'claimed') return { label: t('modelGen.active.stageStarting'), index: 2, total: T };
        if (j.status === 'uploading') return { label: t('modelGen.active.stageUploading'), index: 5, total: T };
        if (j.status === 'orienting') return { label: t('modelGen.active.stageOrienting'), index: 5, total: T };
        if (j.status === 'generating') {
            if (lp.includes('download')) return { label: t('modelGen.active.stageFetching'), index: 3, total: T };
            if (lp.includes('running') || lp === '') return { label: t('modelGen.active.stageGenerating'), index: 4, total: T };
            // Server-supplied free-form progress text (e.g. step counts);
            // pass through untranslated.
            return { label: lp || t('modelGen.active.stageGenerating'), index: 4, total: T };
        }
        return null;
    }

    private renderActive(): void {
        if (this.activeJobs.size === 0) {
            this.activeSection.style.display = 'none';
            this.activeList.innerHTML = '';
            this.stopActiveTimerTick();
            return;
        }
        this.activeSection.style.display = 'flex';
        this.activeList.innerHTML = '';
        let hasInflight = false;
        for (const j of this.activeJobs.values()) {
            const row = document.createElement('div');
            row.className = 'mg-job-row';
            if (j.status === 'failed') row.classList.add('failed');
            const dot = document.createElement('span');
            dot.className = 'mg-job-dot';
            if (j.status === 'failed') dot.classList.add('failed');
            row.appendChild(dot);
            const text = document.createElement('span');
            text.className = 'mg-job-text';

            if (j.status === 'failed') {
                // Sticky failure row — stays visible until the user
                // dismisses, so a generation that errored doesn't
                // silently disappear. The error string comes straight
                // from the server's job.error column.
                const reason = (j.error && j.error.trim().length > 0)
                    ? j.error
                    : t('modelGen.active.failedUnknown');
                text.innerHTML =
                    `${escapeHtml(j.prompt || t('modelGen.active.uploadedImage'))} ` +
                    `<span class="mg-job-stage">— ${escapeHtml(t('modelGen.active.failedLabel'))}: ${escapeHtml(reason)}</span>`;
                row.appendChild(text);

                const dismissBtn = document.createElement('button');
                dismissBtn.type = 'button';
                dismissBtn.className = 'mg-job-cancel';
                dismissBtn.textContent = '✕';
                dismissBtn.title = t('modelGen.active.dismissFailed');
                dismissBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.dismissJob(j.job_id);
                });
                row.appendChild(dismissBtn);
                this.activeList.appendChild(row);
                continue;
            }

            hasInflight = true;
            const stage = this.stageInfo(j);
            // Always show position when queued (#1, #2, ...). When 0
            // jobs are ahead this is "#1", which is more honest than
            // hiding the indicator.
            const queuedHint = (stage && stage.index === 1 && j.queue_position != null)
                ? ` (#${j.queue_position + 1})` : '';
            const stageStr = stage
                ? `[${stage.index}/${stage.total}] ${stage.label}${queuedHint}`
                : (j.last_progress || j.status);
            const elapsed = j.stage_started_at ? Math.max(0, Math.floor((Date.now() - j.stage_started_at) / 1000)) : 0;
            text.innerHTML = `${escapeHtml(j.prompt || t('modelGen.active.uploadedImage'))} <span class="mg-job-stage">— ${escapeHtml(stageStr)} · ${elapsed}s</span>`;
            row.appendChild(text);

            // Cancel control — only while status is still 'queued' (no
            // worker has it yet). After a worker claims the job, GPU
            // time is being spent and it's too late to refund — the
            // server returns 409 to enforce that, but we hide the
            // button proactively to avoid the user pressing it in vain.
            if (j.status === 'queued') {
                const cancelBtn = document.createElement('button');
                cancelBtn.type = 'button';
                cancelBtn.className = 'mg-job-cancel';
                cancelBtn.textContent = '✕';
                cancelBtn.title = 'Cancel — only works while still queued';
                cancelBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.cancelJob(j.job_id);
                });
                row.appendChild(cancelBtn);
            }
            this.activeList.appendChild(row);
        }
        // Only tick the stage timer when there's a non-terminal job to
        // tick for; a list of pure failure rows doesn't need re-renders.
        if (hasInflight) this.startActiveTimerTick();
        else this.stopActiveTimerTick();
    }

    /** Dismiss a sticky failed-job row from the active list. The job row
     *  in the DB stays — this is purely a session-local UI hide. */
    private dismissJob(jobId: string): void {
        this.activeJobs.delete(jobId);
        this.renderActive();
    }

    private async cancelJob(jobId: string): Promise<void> {
        try {
            const resp = await api<any>(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
            // Optimistic local removal — server has flipped status to
            // 'canceled', the next /library poll won't include it.
            this.activeJobs.delete(jobId);
            this.renderActive();
            // Server refunded 2% — always pull a fresh /usage so the
            // displayed N% / 100% normalization uses the right per-tier
            // limit (cancel response only carries usage_pct, not the
            // tier limit, so an optimistic update would briefly show
            // the wrong number for free users).
            this.refreshUsage();
            this.statusBar.textContent = `Canceled. Refunded ${resp?.refunded_pct ?? 2}%.`;
        } catch (e: any) {
            if (e?.status === 409) {
                // Worker claimed between render and click. Show a
                // gentle hint and re-poll so the row flips out of the
                // "queued + cancellable" state on the next render.
                this.statusBar.textContent = 'Too late — a worker just started this job.';
                this.pollAll();
            } else {
                this.statusBar.textContent = `Cancel failed: ${e?.message ?? e}`;
            }
        }
    }

    private activeTimerTimer: number | null = null;
    private startActiveTimerTick(): void {
        if (this.activeTimerTimer != null) return;
        this.activeTimerTimer = window.setInterval(() => {
            // Only re-render the elapsed numbers; nothing else changes
            // between polls.
            this.renderActiveLight();
        }, 1000);
    }
    private stopActiveTimerTick(): void {
        if (this.activeTimerTimer != null) { window.clearInterval(this.activeTimerTimer); this.activeTimerTimer = null; }
    }
    private renderActiveLight(): void {
        // Re-build innerHTML only for the elapsed cells. Cheaper than
        // tearing down and re-creating dot/animation/etc.
        const rows = this.activeList.children;
        let i = 0;
        for (const j of this.activeJobs.values()) {
            const row = rows[i++] as HTMLElement | undefined;
            if (!row) break;
            // Failed rows are sticky-static — error message is final, no
            // elapsed counter to refresh. Skip the in-place rewrite so we
            // don't clobber the rendered failure markup.
            if (j.status === 'failed') continue;
            const span = row.children[1] as HTMLElement | undefined;
            if (!span) continue;
            const stage = this.stageInfo(j);
            // Always show position when queued (#1, #2, ...). When 0
            // jobs are ahead this is "#1", which is more honest than
            // hiding the indicator.
            const queuedHint = (stage && stage.index === 1 && j.queue_position != null)
                ? ` (#${j.queue_position + 1})` : '';
            const stageStr = stage
                ? `[${stage.index}/${stage.total}] ${stage.label}${queuedHint}`
                : (j.last_progress || j.status);
            const elapsed = j.stage_started_at ? Math.max(0, Math.floor((Date.now() - j.stage_started_at) / 1000)) : 0;
            span.innerHTML = `${escapeHtml(j.prompt || '(uploaded image)')} <span class="mg-job-stage">— ${escapeHtml(stageStr)} · ${elapsed}s</span>`;
        }
    }

    private async refreshHealth(): Promise<void> {
        try {
            const r = await fetch(API_BASE + '/health', { headers: authHeaders() });
            if (!r.ok) throw new Error(String(r.status));
            const { workers_online: n, queue_depth: q } = await r.json();
            this.renderHealth(n, q);
        } catch {
            this.renderHealth(-1, -1);
        }
    }

    private renderHealth(online: number, queue: number): void {
        let cls: string, label: string;
        if (online === -1) {
            cls = 'unknown';
            label = t('modelGen.health.unavailable');
        } else if (online === 0) {
            cls = 'offline';
            label = t('modelGen.health.offline');
        } else {
            cls = 'online';
            const key = online === 1 ? 'modelGen.health.onlineSingular' : 'modelGen.health.onlinePlural';
            label = t(key).replace('{count}', String(online));
            if (queue > 0) label += t('modelGen.health.queuedSuffix').replace('{count}', String(queue));
        }
        // Update only the LEFT portion — the right side (usage label)
        // is independent and shouldn't get clobbered on every health
        // refresh poll.
        this.healthLeft.innerHTML = `<span class="mg-health-dot ${cls}"></span><span>${escapeHtml(label)}</span>`;
    }

    /** Anonymous users have a 0% cap — server hard-blocks /preview and
     *  /generate. We track this so click handlers can short-circuit
     *  with a friendly sign-up prompt instead of the bare 402 error. */
    private isAnonymousTier = false;

    /** Disable a button and tick down a "(Ns)" suffix once a second
     *  until the cooldown expires, then restore. Used after a paid
     *  preview to stop the user from spamming the button while they
     *  evaluate the result. The button reference may be detached if
     *  the panel re-renders mid-countdown — the harmless ticks just
     *  fall off the DOM. */
    private startPreviewCooldown(btn: HTMLButtonElement, ms: number): void {
        const originalText = btn.textContent ?? '';
        btn.disabled = true;
        let remaining = Math.max(1, Math.ceil(ms / 1000));
        const tick = (): void => {
            btn.textContent = `${originalText} (${remaining}s)`;
            remaining -= 1;
            if (remaining < 0) {
                btn.textContent = originalText;
                btn.disabled = false;
                return;
            }
            setTimeout(tick, 1000);
        };
        tick();
    }

    /** Refresh the "daily N%" label. Called on tab show + after every
     *  preview/generate/cancel response (those carry usage_pct so we
     *  could update without an extra fetch — but keeping the GET as
     *  the source of truth covers refunds + edge cases). */
    private async refreshUsage(): Promise<void> {
        try {
            const r = await fetch(API_BASE + '/usage', { headers: authHeaders() });
            if (!r.ok) { this.renderUsage(null, null, null); return; }
            const { usage_pct, limit_pct, tier } = await r.json();
            this.renderUsage(usage_pct, limit_pct, tier ?? null);
        } catch {
            this.renderUsage(null, null, null);
        }
    }

    private renderUsage(used: number | null, limit: number | null, tier: string | null): void {
        this.isAnonymousTier = tier === 'anonymous';
        if (this.isAnonymousTier) {
            this.usageLabel.textContent = 'Sign up to use';
            this.usageLabel.classList.remove('mg-usage-warn');
            this.usageLabel.classList.add('mg-usage-cap');
            this.usageLabel.title = 'Anonymous users can browse the community library but need a free account to generate.';
            return;
        }
        if (used == null || limit == null || limit <= 0) {
            this.usageLabel.textContent = '';
            this.usageLabel.classList.remove('mg-usage-warn', 'mg-usage-cap');
            this.usageLabel.title = 'Daily generation budget. Resets at midnight UTC.';
            return;
        }
        // Normalize the display to "/100%" regardless of tier. Internally
        // free=25, pro=100; users compared "5%/25%" (free) vs "5%/100%"
        // (pro) and read the free tier as smaller-than-it-is. Showing
        // both as fraction-of-100 makes "you've used X% of your daily
        // budget" mean the same thing for everyone. Warn/cap thresholds
        // run on the normalized scale so a free user gets the amber
        // warning at the same proportional usage as a pro user.
        const displayedUsed = Math.min(100, Math.max(0, Math.round(used * 100 / limit)));
        const displayedRemaining = 100 - displayedUsed;
        this.usageLabel.textContent = `daily ${displayedUsed}% / 100%`;
        this.usageLabel.classList.toggle('mg-usage-warn', displayedRemaining < 10 && displayedRemaining > 0);
        this.usageLabel.classList.toggle('mg-usage-cap', displayedRemaining <= 0);
        this.usageLabel.title = `Daily generation budget (${tier ?? 'free'} tier). Resets at midnight UTC.`;
    }

    private setLibraryScope(scope: 'mine' | 'community'): void {
        if (scope === this.libraryScope) return;
        this.libraryScope = scope;
        this.updateScopeButtons();
        this.refreshLibrary();
    }

    private updateScopeButtons(): void {
        for (const btn of Array.from(this.el.querySelectorAll('button[data-scope]')) as HTMLButtonElement[]) {
            btn.classList.toggle('active', btn.dataset.scope === this.libraryScope);
        }
    }

    private async refreshLibrary(): Promise<void> {
        // Reset pagination state for the new fetch context.
        this.libraryOldestTs = null;
        this.libraryExhausted = false;
        this.libraryLoading = false;

        const q = this.librarySearchInput?.value?.trim() ?? '';
        const base = this.libraryScope === 'community' ? '/community' : '/library';
        // Search uses the larger ranked-top-N response; default view
        // pages with the smaller LIBRARY_PAGE_SIZE.
        const url = q
            ? `${base}?limit=100&q=${encodeURIComponent(q)}`
            : `${base}?limit=${LIBRARY_PAGE_SIZE}`;
        try {
            const resp = await api<any>(url);
            this.library = resp.items ?? [];
            // Rehydrate in-flight jobs from /library only — community
            // doesn't include in-flight rows for other users.
            if (!q && this.libraryScope === 'mine') this.rehydrateActiveJobs();
            // Search results are ranked top-N — never paginate them.
            // Default view: track the oldest ts as the next-page cursor;
            // if we got a partial page, mark exhausted.
            if (q) {
                this.libraryExhausted = true;
            } else {
                this.updateLibraryCursor(this.library);
                if (this.library.length < LIBRARY_PAGE_SIZE) this.libraryExhausted = true;
            }
            this.renderLibrary(q.length > 0);
        } catch (e: any) {
            if ((e as any).status === 404) {
                this.libraryGrid.innerHTML = `<div class="mg-lib-empty">${escapeHtml(t('modelGen.library.notAvailable'))}</div>`;
                this.libraryExhausted = true;
            }
        }
    }

    private async loadMoreLibrary(): Promise<void> {
        if (this.libraryLoading || this.libraryExhausted) return;
        if (this.libraryOldestTs == null) return;
        // No infinite scroll while searching — backend returns ranked
        // top-N for search and re-fetching with a cursor would mix
        // ordering semantics.
        const q = this.librarySearchInput?.value?.trim() ?? '';
        if (q) return;

        this.libraryLoading = true;
        const base = this.libraryScope === 'community' ? '/community' : '/library';
        const url = `${base}?limit=${LIBRARY_PAGE_SIZE}&before_ts=${this.libraryOldestTs}`;
        try {
            const resp = await api<any>(url);
            const items: LibraryItem[] = resp.items ?? [];
            if (items.length === 0) {
                this.libraryExhausted = true;
                return;
            }
            this.library.push(...items);
            this.updateLibraryCursor(items);
            if (items.length < LIBRARY_PAGE_SIZE) this.libraryExhausted = true;
            this.appendLibraryItems(items);
        } catch {
            // Network blip — leave state alone so next scroll retries.
        } finally {
            this.libraryLoading = false;
        }
    }

    /** Track the oldest created_at across `items` so the next fetch
     *  can ask for rows older than that. Items arrive newest-first. */
    private updateLibraryCursor(items: LibraryItem[]): void {
        for (const it of items) {
            const ts = it.created_at;
            if (typeof ts !== 'number') continue;
            if (this.libraryOldestTs == null || ts < this.libraryOldestTs) {
                this.libraryOldestTs = ts;
            }
        }
    }

    private rehydrateActiveJobs(): void {
        const ACTIVE = new Set(['queued', 'claimed', 'generating', 'orienting', 'uploading']);
        let changed = false;
        for (const it of this.library) {
            if (!ACTIVE.has(it.status)) continue;
            if (this.activeJobs.has(it.job_id)) continue;
            // Library payload only has created_at; the first /jobs/:id
            // poll fills in last_progress_at / claimed_at. Seed the
            // timer with created_at so refresh shows non-zero "Ns"
            // immediately rather than 0s for one poll cycle.
            this.activeJobs.set(it.job_id, {
                job_id: it.job_id,
                status: it.status,
                prompt: it.prompt,
                stage_started_at: (it as any).created_at,
            });
            changed = true;
        }
        if (changed) {
            this.renderActive();
            this.startPolling();
        }
    }

    private renderLibrary(isSearch = false): void {
        this.libraryGrid.innerHTML = '';
        const successful = this.library.filter(it => it.model);
        if (successful.length === 0) {
            const msg = isSearch
                ? t('modelGen.library.emptyMatches')
                : (this.libraryScope === 'community' ? t('modelGen.library.emptyCommunity') : t('modelGen.library.empty'));
            this.libraryGrid.innerHTML = `<div class="mg-lib-empty">${escapeHtml(msg)}</div>`;
            return;
        }
        for (const item of successful) this.libraryGrid.appendChild(this.buildLibraryCard(item));
    }

    /** Append-only render for new pages. Skips the empty-state path. */
    private appendLibraryItems(items: LibraryItem[]): void {
        for (const item of items) {
            if (!item.model) continue;
            this.libraryGrid.appendChild(this.buildLibraryCard(item));
        }
    }

    private buildLibraryCard(item: LibraryItem): HTMLElement {
        const m = item.model!;
        const card = document.createElement('div');
        card.className = 'mg-lib-card';
        card.title = item.prompt || '';
        card.draggable = true;

        const dragAsset = {
            name: (item.prompt || 'generated').replace(/[^\w\-_ ]/g, '').trim().slice(0, 40) || 'generated',
            category: '3D Models',
            extension: 'glb',
            fileUrl: m.glb_path,
            thumbnailUrl: m.thumb_path,
            source: 'generated',
            pack: 'my-generations',
            est_scale_m: m.est_scale_m,
            up_axis: m.up_axis,
            forward_axis: m.forward_axis,
        };
        card.addEventListener('dragstart', (e) => {
            e.dataTransfer?.setData('application/x-parallax-asset', JSON.stringify(dragAsset));
        });

        // <img> is more reliable than background-image (the `background:`
        // shorthand resets background-image; ordering bugs leave the
        // thumb invisible). Also gives an onerror hook if the URL is
        // unreachable.
        const thumb = document.createElement('div');
        thumb.className = 'mg-lib-card-thumb';
        if (m.thumb_path) {
            const img = document.createElement('img');
            img.src = m.thumb_path;
            img.alt = item.prompt || '';
            img.loading = 'lazy';
            img.onerror = () => { img.style.display = 'none'; };
            thumb.appendChild(img);
        } else {
            thumb.textContent = '□';
        }
        card.appendChild(thumb);

        // "Use in chat" button — overlaid on the thumbnail. Posts a
        // document-level CustomEvent that AiChatPanel listens for. Stops
        // propagation so the card's drag handler doesn't fire on click.
        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.className = 'mg-lib-card-use';
        useBtn.title = 'Add this model as a hint for the AI Assistant';
        useBtn.textContent = '+ chat';
        useBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            // Scale + facing + bbox aren't passed: the GLB loader bakes
            // est_scale_m and forward_axis into the geometry at runtime,
            // so the AI sees a 1m-cube-equivalent attached asset just
            // like a kenney/poly_haven library asset.
            const detail = {
                id: m.id,
                path: m.glb_path,
                thumbUrl: m.thumb_path,
                prompt: item.prompt || 'generated model',
            };
            document.dispatchEvent(new CustomEvent('parallax:chat-attach-asset', { detail }));
            // Visual feedback — flip the button briefly to confirm.
            const originalText = useBtn.textContent;
            useBtn.textContent = 'added';
            useBtn.classList.add('mg-lib-card-use-added');
            window.setTimeout(() => {
                useBtn.textContent = originalText;
                useBtn.classList.remove('mg-lib-card-use-added');
            }, 1200);
        });
        thumb.appendChild(useBtn);

        const label = document.createElement('div');
        label.className = 'mg-lib-card-label';
        label.textContent = item.prompt || '—';
        card.appendChild(label);
        return card;
    }
}

function escapeHtml(s: string): string {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
