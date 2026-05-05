/**
 * model_gen_panel.ts — "AI Generate" tab in the assets panel.
 *
 * Self-contained: a simple input + status list + library grid that calls
 * /api/engine/models/* on the hosted backend. On a self-hosted clone of
 * Open-ParallaxPro that doesn't run the model_gen plugin, the first fetch
 * returns 404 and we render a friendly "feature not available" stub
 * instead of breaking the panel.
 *
 * Generated GLBs drop into the scene via the same drag payload shape as
 * curated 3D models (`application/x-parallax-asset`), so the existing
 * drop handler picks them up without changes. Scale + orientation
 * defaults to Y-up / -Z-forward; users adjust with the standard transform
 * tools after the asset lands in the scene.
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

function getAuthHeaders(): Record<string, string> {
    const token = localStorage.getItem('auth_token') ?? localStorage.getItem('token');
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
}

async function api<T = any>(path: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(API_BASE + path, {
        ...opts,
        headers: { ...getAuthHeaders(), ...(opts?.headers as Record<string, string> ?? {}) },
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

export class ModelGenPanel {
    readonly el: HTMLElement;
    private libraryGrid!: HTMLDivElement;
    private activeList!: HTMLDivElement;
    private activeSection!: HTMLDivElement;
    private promptInput!: HTMLTextAreaElement;
    private qualitySelect!: HTMLSelectElement;
    private submitBtn!: HTMLButtonElement;
    private statusBar!: HTMLDivElement;
    private pollTimer: number | null = null;
    private activeJobs = new Map<string, ActiveJob>();
    private library: LibraryItem[] = [];
    private mounted = false;
    private featureUnavailable = false;

    constructor() {
        this.el = document.createElement('div');
        this.el.className = 'model-gen-panel';
        this.el.style.padding = '12px';
        this.el.style.overflowY = 'auto';
        this.buildUI();
    }

    /** Called once when the tab content is first shown. */
    onShow(): void {
        if (!this.mounted) {
            this.mounted = true;
            this.refreshLibrary();
        }
    }

    private buildUI(): void {
        // ── Generate form ─────────────────────────────────────────
        const form = document.createElement('div');
        form.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:12px;padding:10px;background:#141420;border:1px solid #222;border-radius:8px';

        const promptLabel = document.createElement('label');
        promptLabel.textContent = 'Generate a 3D model from a text prompt:';
        promptLabel.style.cssText = 'font-size:12px;color:#aaa';
        form.appendChild(promptLabel);

        this.promptInput = document.createElement('textarea');
        this.promptInput.placeholder = 'e.g. "wooden barrel", "low-poly tree", "anime sword"';
        this.promptInput.maxLength = 300;
        this.promptInput.rows = 2;
        this.promptInput.style.cssText = 'background:#0e0e18;border:1px solid #333;color:#e0e0e0;border-radius:4px;padding:8px;font-family:inherit;font-size:13px;resize:vertical';
        this.promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.submit(); }
        });
        form.appendChild(this.promptInput);

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center';

        const qualityLabel = document.createElement('span');
        qualityLabel.textContent = 'Quality:';
        qualityLabel.style.cssText = 'font-size:12px;color:#aaa';
        row.appendChild(qualityLabel);

        this.qualitySelect = document.createElement('select');
        this.qualitySelect.style.cssText = 'background:#0e0e18;border:1px solid #333;color:#e0e0e0;border-radius:4px;padding:4px 8px;font-size:12px';
        for (const [value, label] of [['fast', 'Fast (~10s)'], ['standard', 'Standard (~50s)'], ['high', 'High (~70s)']]) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            if (value === 'standard') opt.selected = true;
            this.qualitySelect.appendChild(opt);
        }
        row.appendChild(this.qualitySelect);

        const spacer = document.createElement('div');
        spacer.style.flex = '1';
        row.appendChild(spacer);

        this.submitBtn = document.createElement('button');
        this.submitBtn.textContent = 'Generate';
        this.submitBtn.style.cssText = 'background:#6366f1;color:#fff;border:0;border-radius:4px;padding:6px 16px;font-size:13px;cursor:pointer';
        this.submitBtn.addEventListener('click', () => this.submit());
        row.appendChild(this.submitBtn);
        form.appendChild(row);

        this.statusBar = document.createElement('div');
        this.statusBar.style.cssText = 'font-size:11px;color:#888;min-height:14px';
        form.appendChild(this.statusBar);

        this.el.appendChild(form);

        // ── Active jobs ────────────────────────────────────────────
        this.activeSection = document.createElement('div');
        this.activeSection.style.cssText = 'margin-bottom:12px;display:none';

        const activeHeader = document.createElement('div');
        activeHeader.textContent = 'In flight';
        activeHeader.style.cssText = 'font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:6px';
        this.activeSection.appendChild(activeHeader);

        this.activeList = document.createElement('div');
        this.activeList.style.cssText = 'display:flex;flex-direction:column;gap:4px';
        this.activeSection.appendChild(this.activeList);

        this.el.appendChild(this.activeSection);

        // ── Library grid ───────────────────────────────────────────
        const libHeader = document.createElement('div');
        libHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';

        const libTitle = document.createElement('div');
        libTitle.textContent = 'My Generations';
        libTitle.style.cssText = 'font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.4px';
        libHeader.appendChild(libTitle);

        const refreshBtn = document.createElement('button');
        refreshBtn.textContent = '↻';
        refreshBtn.title = 'Refresh library';
        refreshBtn.style.cssText = 'background:none;border:0;color:#888;cursor:pointer;font-size:14px';
        refreshBtn.addEventListener('click', () => this.refreshLibrary());
        libHeader.appendChild(refreshBtn);
        this.el.appendChild(libHeader);

        this.libraryGrid = document.createElement('div');
        this.libraryGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px';
        this.libraryGrid.innerHTML = '<div style="grid-column:1/-1;color:#666;font-size:12px;text-align:center;padding:24px">No generations yet. Try a prompt above.</div>';
        this.el.appendChild(this.libraryGrid);
    }

    private async submit(): Promise<void> {
        const prompt = this.promptInput.value.trim();
        if (!prompt) { this.statusBar.textContent = 'Enter a prompt first.'; return; }
        const quality = this.qualitySelect.value;

        this.submitBtn.disabled = true;
        this.statusBar.textContent = 'Submitting…';

        try {
            const resp = await api<any>('/generate', {
                method: 'POST',
                body: JSON.stringify({ prompt, quality }),
            });
            this.statusBar.textContent = '';
            this.promptInput.value = '';

            if (resp.cache_hit && resp.model) {
                // Free, instant. Drop straight into the library.
                this.statusBar.textContent = '✓ Found a matching shared model — added to library.';
                setTimeout(() => { this.statusBar.textContent = ''; }, 4000);
                this.refreshLibrary();
                return;
            }

            this.activeJobs.set(resp.job_id, {
                job_id: resp.job_id,
                status: 'queued',
                queue_position: resp.queue_position,
                prompt,
            });
            this.renderActive();
            this.startPolling();
        } catch (e: any) {
            const msg = (e as any)?.payload?.message || e.message || 'Failed to submit.';
            this.statusBar.textContent = `Error: ${msg}`;
            if ((e as any).status === 404) this.featureUnavailable = true;
        } finally {
            this.submitBtn.disabled = false;
        }
    }

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
        this.activeSection.style.display = '';
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
            text.innerHTML = `<span style="color:#e0e0e0">${escapeHtml(j.prompt || '')}</span> <span style="color:#888">— ${escapeHtml(detail)}</span>`;
            row.appendChild(text);
            this.activeList.appendChild(row);
        }
    }

    private async refreshLibrary(): Promise<void> {
        try {
            const resp = await api<any>('/library?limit=100');
            this.library = resp.items ?? [];
            this.renderLibrary();
        } catch (e: any) {
            if ((e as any).status === 404) {
                this.featureUnavailable = true;
                this.libraryGrid.innerHTML = '<div style="grid-column:1/-1;color:#888;font-size:12px;text-align:center;padding:24px;line-height:1.6">3D model generation isn\'t available on this backend.<br><span style="color:#666">Run the hosted server with the model_gen plugin enabled.</span></div>';
            }
        }
    }

    private renderLibrary(): void {
        this.libraryGrid.innerHTML = '';
        if (this.library.length === 0) {
            this.libraryGrid.innerHTML = '<div style="grid-column:1/-1;color:#666;font-size:12px;text-align:center;padding:24px">No generations yet. Try a prompt above.</div>';
            return;
        }
        // Show only successful items in the grid; in-flight jobs show in the active list above.
        const successful = this.library.filter(it => it.model);
        for (const item of successful) this.libraryGrid.appendChild(this.buildLibraryCard(item));
    }

    private buildLibraryCard(item: LibraryItem): HTMLElement {
        const m = item.model!;
        const card = document.createElement('div');
        card.className = 'asset-card';
        card.title = item.prompt || '';
        card.draggable = true;
        card.style.cssText = 'background:#141420;border:1px solid #222;border-radius:6px;cursor:grab;overflow:hidden';

        // Match the curated-asset drag payload shape so the existing scene
        // drop handler doesn't need to know this came from generation.
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

// One-time keyframes injection for the pulse animation.
if (typeof document !== 'undefined' && !document.getElementById('mg-pulse-css')) {
    const style = document.createElement('style');
    style.id = 'mg-pulse-css';
    style.textContent = `@keyframes mg-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`;
    document.head.appendChild(style);
}
