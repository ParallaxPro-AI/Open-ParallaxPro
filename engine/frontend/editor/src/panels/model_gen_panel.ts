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
}

const API_BASE = '/api/engine/models';
const POLL_INTERVAL_MS = 3000;

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
    private healthTimer: number | null = null;
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

    private pollTimer: number | null = null;
    private activeJobs = new Map<string, ActiveJob>();
    private library: LibraryItem[] = [];
    private mounted = false;

    constructor() {
        this.el = document.createElement('div');
        this.el.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;overflow-y:auto;padding:12px;gap:12px';
        this.buildUI();
    }

    onShow(): void {
        if (!this.mounted) {
            this.mounted = true;
            this.refreshLibrary();
            this.refreshHealth();
        }
        // Re-check health every 30s while the tab is visible.
        if (this.healthTimer == null) {
            this.healthTimer = window.setInterval(() => this.refreshHealth(), 30000);
        }
    }

    // ── UI build ─────────────────────────────────────────────────────

    private buildUI(): void {
        // GPU pool health banner — small dot + label at top of the tab.
        this.healthBanner = document.createElement('div');
        this.healthBanner.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:#666';
        this.healthBanner.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#666"></span><span>checking…</span>';
        this.el.appendChild(this.healthBanner);

        // Mode tabs (Text / Image)
        this.modeTabs = document.createElement('div');
        this.modeTabs.style.cssText = 'display:flex;gap:6px';
        const textBtn = this.makeModeButton('text', 'From Text');
        const imageBtn = this.makeModeButton('image', 'From Image');
        this.modeTabs.appendChild(textBtn);
        this.modeTabs.appendChild(imageBtn);
        this.el.appendChild(this.modeTabs);

        // Form area (varies by mode + step)
        this.formArea = document.createElement('div');
        this.formArea.style.cssText = 'display:flex;flex-direction:column;gap:8px;background:#141420;border:1px solid #222;border-radius:8px;padding:10px';
        this.el.appendChild(this.formArea);

        // Preview area (shown when step = previewed)
        this.previewArea = document.createElement('div');
        this.previewArea.style.cssText = 'display:none;flex-direction:column;gap:8px;background:#141420;border:1px solid #222;border-radius:8px;padding:10px';
        this.el.appendChild(this.previewArea);

        // Status bar (errors, info)
        this.statusBar = document.createElement('div');
        this.statusBar.style.cssText = 'font-size:11px;color:#888;min-height:14px';
        this.el.appendChild(this.statusBar);

        // Active jobs list
        this.activeSection = document.createElement('div');
        this.activeSection.style.cssText = 'display:none;flex-direction:column;gap:4px';
        const activeHeader = document.createElement('div');
        activeHeader.textContent = 'In flight';
        activeHeader.style.cssText = 'font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.4px';
        this.activeSection.appendChild(activeHeader);
        this.activeList = document.createElement('div');
        this.activeList.style.cssText = 'display:flex;flex-direction:column;gap:4px';
        this.activeSection.appendChild(this.activeList);
        this.el.appendChild(this.activeSection);

        // Library header + search
        const libHeader = document.createElement('div');
        libHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';
        const libTitle = document.createElement('div');
        libTitle.textContent = 'My Generations';
        libTitle.style.cssText = 'font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.4px;flex:none';
        libHeader.appendChild(libTitle);
        const refreshBtn = document.createElement('button');
        refreshBtn.textContent = '↻';
        refreshBtn.title = 'Refresh library';
        refreshBtn.style.cssText = 'background:none;border:0;color:#888;cursor:pointer;font-size:14px;flex:none';
        refreshBtn.addEventListener('click', () => this.refreshLibrary());
        libHeader.appendChild(refreshBtn);
        this.el.appendChild(libHeader);

        // Multi-lingual search input. Debounced; empty value falls back to
        // the recent-first list.
        this.librarySearchInput = document.createElement('input');
        this.librarySearchInput.type = 'search';
        this.librarySearchInput.placeholder = 'Search your generations…';
        this.librarySearchInput.style.cssText = 'width:100%;background:#0e0e18;border:1px solid #333;color:#e0e0e0;border-radius:4px;padding:6px 10px;font-size:12px';
        this.librarySearchInput.addEventListener('input', () => {
            if (this.librarySearchTimer != null) window.clearTimeout(this.librarySearchTimer);
            this.librarySearchTimer = window.setTimeout(() => this.refreshLibrary(), 250);
        });
        this.el.appendChild(this.librarySearchInput);

        this.libraryGrid = document.createElement('div');
        this.libraryGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px';
        this.libraryGrid.innerHTML = '<div style="grid-column:1/-1;color:#666;font-size:12px;text-align:center;padding:24px">No generations yet.</div>';
        this.el.appendChild(this.libraryGrid);

        this.renderForm();
    }

    private makeModeButton(mode: Mode, label: string): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.dataset.mode = mode;
        btn.style.cssText = 'flex:1;padding:6px 10px;background:#141420;border:1px solid #222;color:#888;border-radius:4px;cursor:pointer;font-size:12px';
        btn.addEventListener('click', () => this.setMode(mode));
        return btn;
    }

    private setMode(mode: Mode): void {
        this.mode = mode;
        this.step = 'idle';
        this.currentPreviewUrl = null;
        this.currentPrompt = null;
        this.statusBar.textContent = '';
        this.previewArea.style.display = 'none';
        for (const el of Array.from(this.modeTabs.children) as HTMLButtonElement[]) {
            const isActive = el.dataset.mode === mode;
            el.style.background = isActive ? '#6366f1' : '#141420';
            el.style.color = isActive ? '#fff' : '#888';
            el.style.borderColor = isActive ? '#6366f1' : '#222';
        }
        this.renderForm();
    }

    // ── Form (varies by mode) ────────────────────────────────────────

    private renderForm(): void {
        this.formArea.innerHTML = '';
        if (this.mode === 'text') this.renderTextForm();
        else this.renderImageForm();

        // Mode button styling
        for (const el of Array.from(this.modeTabs.children) as HTMLButtonElement[]) {
            const isActive = el.dataset.mode === this.mode;
            el.style.background = isActive ? '#6366f1' : '#141420';
            el.style.color = isActive ? '#fff' : '#888';
            el.style.borderColor = isActive ? '#6366f1' : '#222';
        }
    }

    private renderTextForm(): void {
        const label = document.createElement('label');
        label.textContent = 'Describe a 3D model:';
        label.style.cssText = 'font-size:12px;color:#aaa';
        this.formArea.appendChild(label);

        const promptInput = document.createElement('textarea');
        promptInput.placeholder = 'e.g. "wooden barrel", "low-poly tree", "anime sword"';
        promptInput.maxLength = 300;
        promptInput.rows = 2;
        promptInput.value = this.currentPrompt ?? '';
        promptInput.style.cssText = 'background:#0e0e18;border:1px solid #333;color:#e0e0e0;border-radius:4px;padding:8px;font-family:inherit;font-size:13px;resize:vertical';
        promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); previewBtn.click(); }
        });
        this.formArea.appendChild(promptInput);

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:flex-end';

        const previewBtn = document.createElement('button');
        previewBtn.textContent = 'Preview Image';
        previewBtn.style.cssText = 'background:#6366f1;color:#fff;border:0;border-radius:4px;padding:6px 16px;font-size:13px;cursor:pointer';
        previewBtn.addEventListener('click', async () => {
            const prompt = promptInput.value.trim();
            if (!prompt) { this.statusBar.textContent = 'Enter a prompt first.'; return; }
            this.currentPrompt = prompt;
            previewBtn.disabled = true;
            this.statusBar.textContent = 'Generating preview…';
            try {
                const resp = await api<any>('/preview/text', {
                    method: 'POST',
                    body: JSON.stringify({ prompt, quality: this.currentQuality }),
                });
                if (resp.cache_hit && resp.model) {
                    this.statusBar.textContent = '✓ Found a matching shared model — added to library.';
                    setTimeout(() => { this.statusBar.textContent = ''; }, 4000);
                    this.refreshLibrary();
                    return;
                }
                this.currentPreviewUrl = resp.preview_url;
                this.step = 'previewed';
                this.statusBar.textContent = '';
                this.showPreview();
            } catch (e: any) {
                this.statusBar.textContent = `Error: ${e.message || 'preview failed'}`;
            } finally {
                previewBtn.disabled = false;
            }
        });
        row.appendChild(previewBtn);
        this.formArea.appendChild(row);
    }

    private renderImageForm(): void {
        const label = document.createElement('label');
        label.textContent = 'Upload an image of the subject:';
        label.style.cssText = 'font-size:12px;color:#aaa';
        this.formArea.appendChild(label);

        const dropZone = document.createElement('label');
        dropZone.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:120px;border:1px dashed #444;border-radius:6px;cursor:pointer;background:#0e0e18';
        dropZone.innerHTML = '<div style="font-size:13px;color:#aaa">Click to choose or drag an image</div><div style="font-size:11px;color:#666">PNG, JPG, or WEBP — up to 8MB</div>';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/png,image/jpeg,image/webp';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => this.handleImageUpload(fileInput.files?.[0]));
        dropZone.appendChild(fileInput);

        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = '#6366f1'; });
        dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = '#444'; });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = '#444';
            this.handleImageUpload(e.dataTransfer?.files?.[0]);
        });

        this.formArea.appendChild(dropZone);
    }

    private async handleImageUpload(file?: File | null): Promise<void> {
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) {
            this.statusBar.textContent = 'Image must be under 8MB.';
            return;
        }
        this.statusBar.textContent = 'Uploading…';
        try {
            const resp = await uploadImage(file);
            this.currentPreviewUrl = resp.preview_url;
            this.currentPrompt = null;
            this.step = 'previewed';
            this.statusBar.textContent = '';
            this.showPreview();
        } catch (e: any) {
            this.statusBar.textContent = `Error: ${e.message || 'upload failed'}`;
        }
    }

    // ── Preview + confirm ────────────────────────────────────────────

    private showPreview(): void {
        this.previewArea.innerHTML = '';
        this.previewArea.style.display = 'flex';

        const label = document.createElement('div');
        label.textContent = this.mode === 'text' ? 'Preview — confirm to generate the 3D model from this image:' : 'Preview — confirm to generate:';
        label.style.cssText = 'font-size:12px;color:#aaa';
        this.previewArea.appendChild(label);

        const img = document.createElement('img');
        img.src = this.currentPreviewUrl ?? '';
        img.style.cssText = 'max-width:100%;max-height:280px;align-self:center;border-radius:6px;background:#0e0e18';
        this.previewArea.appendChild(img);

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px';

        const refineBtn = document.createElement('button');
        refineBtn.textContent = this.mode === 'text' ? 'Refine prompt' : 'Choose different file';
        refineBtn.style.cssText = 'flex:1;background:#222;color:#ccc;border:0;border-radius:4px;padding:8px;font-size:13px;cursor:pointer';
        refineBtn.addEventListener('click', () => {
            this.step = 'idle';
            this.currentPreviewUrl = null;
            this.previewArea.style.display = 'none';
            this.statusBar.textContent = '';
        });
        row.appendChild(refineBtn);

        const confirmBtn = document.createElement('button');
        confirmBtn.textContent = 'Confirm & Generate 3D';
        confirmBtn.style.cssText = 'flex:1;background:#6366f1;color:#fff;border:0;border-radius:4px;padding:8px;font-size:13px;cursor:pointer';
        confirmBtn.addEventListener('click', () => this.confirm());
        row.appendChild(confirmBtn);
        this.previewArea.appendChild(row);
    }

    private async confirm(): Promise<void> {
        if (!this.currentPreviewUrl) return;
        this.step = 'submitting';
        this.statusBar.textContent = 'Submitting…';
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
            if (resp.cache_hit && resp.model) {
                this.statusBar.textContent = '✓ Found a matching shared model — added to library.';
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
                this.statusBar.textContent = `Job queued${resp.queue_position != null ? ` — position #${resp.queue_position + 1}` : ''}.`;
            }
            // Reset form back to idle
            this.step = 'idle';
            this.currentPreviewUrl = null;
            this.previewArea.style.display = 'none';
            this.renderForm();
        } catch (e: any) {
            this.statusBar.textContent = `Error: ${e.message || 'submit failed'}`;
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
        const toRemove: string[] = [];
        const updates = await Promise.all(
            Array.from(this.activeJobs.keys()).map(async id => {
                try { return await api<any>(`/jobs/${encodeURIComponent(id)}`); }
                catch { return null; }
            })
        );
        let libraryDirty = false;
        for (const j of updates) {
            if (!j) continue;
            const existing = this.activeJobs.get(j.job_id);
            if (!existing) continue;
            if (j.status === 'done' || j.status === 'failed' || j.status === 'canceled') {
                toRemove.push(j.job_id);
                if (j.status === 'done') libraryDirty = true;
            } else {
                this.activeJobs.set(j.job_id, {
                    job_id: j.job_id,
                    status: j.status,
                    queue_position: j.queue_position,
                    last_progress: j.last_progress,
                    prompt: existing.prompt,
                });
            }
        }
        for (const id of toRemove) this.activeJobs.delete(id);
        this.renderActive();
        if (libraryDirty) this.refreshLibrary();
        if (this.activeJobs.size === 0) this.stopPolling();
    }

    private renderActive(): void {
        if (this.activeJobs.size === 0) {
            this.activeSection.style.display = 'none';
            this.activeList.innerHTML = '';
            return;
        }
        this.activeSection.style.display = 'flex';
        this.activeList.innerHTML = '';
        for (const j of this.activeJobs.values()) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;background:#141420;border:1px solid #222;border-radius:4px;font-size:12px';
            const dot = document.createElement('span');
            dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#fbbf24;flex:none;animation:mg-pulse 1s infinite';
            row.appendChild(dot);
            const text = document.createElement('span');
            text.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
            const detail = j.status === 'queued' && j.queue_position != null
                ? `queue #${j.queue_position + 1}`
                : (j.last_progress || j.status);
            text.innerHTML = `<span style="color:#e0e0e0">${escapeHtml(j.prompt || '(uploaded image)')}</span> <span style="color:#888">— ${escapeHtml(detail)}</span>`;
            row.appendChild(text);
            this.activeList.appendChild(row);
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
        let color: string, label: string;
        if (online === -1) {
            color = '#666';
            label = 'GPU service unavailable';
        } else if (online === 0) {
            color = '#fca5a5';
            label = 'Offline — no GPU workers connected';
        } else {
            color = '#4ade80';
            label = `Online · ${online} worker${online === 1 ? '' : 's'}` + (queue > 0 ? ` · ${queue} queued` : '');
        }
        this.healthBanner.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${color}"></span><span>${escapeHtml(label)}</span>`;
    }

    private async refreshLibrary(): Promise<void> {
        const q = this.librarySearchInput?.value?.trim() ?? '';
        const url = q
            ? `/library?limit=100&q=${encodeURIComponent(q)}`
            : '/library?limit=100';
        try {
            const resp = await api<any>(url);
            this.library = resp.items ?? [];
            // Rehydrate in-flight jobs after a page refresh — without
            // this, jobs the user submitted before refreshing vanish
            // from the UI even though they're still running. Skips when
            // a search is active (search results are completed models).
            if (!q) this.rehydrateActiveJobs();
            this.renderLibrary(q.length > 0);
        } catch (e: any) {
            if ((e as any).status === 404) {
                this.libraryGrid.innerHTML = '<div style="grid-column:1/-1;color:#888;font-size:12px;text-align:center;padding:24px;line-height:1.6">3D model generation isn\'t available on this backend.</div>';
            }
        }
    }

    private rehydrateActiveJobs(): void {
        const ACTIVE = new Set(['queued', 'claimed', 'generating', 'orienting', 'uploading']);
        let changed = false;
        for (const it of this.library) {
            if (!ACTIVE.has(it.status)) continue;
            if (this.activeJobs.has(it.job_id)) continue;
            this.activeJobs.set(it.job_id, {
                job_id: it.job_id,
                status: it.status,
                prompt: it.prompt,
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
            const msg = isSearch ? 'No matches.' : 'No generations yet.';
            this.libraryGrid.innerHTML = `<div style="grid-column:1/-1;color:#666;font-size:12px;text-align:center;padding:24px">${msg}</div>`;
            return;
        }
        for (const item of successful) this.libraryGrid.appendChild(this.buildLibraryCard(item));
    }

    private buildLibraryCard(item: LibraryItem): HTMLElement {
        const m = item.model!;
        const card = document.createElement('div');
        card.className = 'asset-card';
        card.title = item.prompt || '';
        card.draggable = true;
        card.style.cssText = 'background:#141420;border:1px solid #222;border-radius:6px;cursor:grab;overflow:hidden';

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

        const thumb = document.createElement('div');
        thumb.style.cssText = 'aspect-ratio:1;background:#0e0e18 center/cover no-repeat;border-bottom:1px solid #222';
        if (m.thumb_path) thumb.style.backgroundImage = `url(${m.thumb_path})`;
        card.appendChild(thumb);

        const label = document.createElement('div');
        label.style.cssText = 'padding:4px 6px;font-size:11px;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        label.textContent = item.prompt || '—';
        card.appendChild(label);
        return card;
    }
}

function escapeHtml(s: string): string {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

if (typeof document !== 'undefined' && !document.getElementById('mg-pulse-css')) {
    const style = document.createElement('style');
    style.id = 'mg-pulse-css';
    style.textContent = `@keyframes mg-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`;
    document.head.appendChild(style);
}
