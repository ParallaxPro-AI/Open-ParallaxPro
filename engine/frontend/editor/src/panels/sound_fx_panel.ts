/**
 * sound_fx_panel.ts — "Sound Effects" tab in the AI Assistant column.
 *
 * Two modes:
 *   1. Upload — pick an audio file (≤10s, ≤2MB).
 *   2. Record — mic capture via MediaRecorder, decoded back through
 *      Web Audio and re-encoded as 22.05 kHz mono WAV.
 *
 * After capture, the user labels the clip and saves it to
 * /api/engine/sfx/upload. The library grid lists their clips with play
 * controls, "+ chat" (mirrors model_gen), and delete.
 *
 * Privacy: clips are stored under /assets/generated-audio/<aa>/<bb>/<token>.<ext>
 * and served publicly by URL. Anyone holding the URL can fetch the file —
 * the panel banner makes this explicit. The DB-side privacy layer keeps
 * other users' clips out of LIST_ASSETS.
 */

import { AudioListenerComponent } from '../../../runtime/function/framework/components/audio_listener_component.js';
import { t } from '../i18n/index.js';
import { icon, Volume2, Trash2, RefreshCw, Mic, Square } from '../widgets/icons.js';

const API_BASE = '/api/engine/sfx';
const MAX_DURATION_MS = 10_000;
const MAX_LABEL_LEN = 50;
const TARGET_SAMPLE_RATE = 22_050;
const LIBRARY_PAGE_SIZE = 50;
const SCROLL_LOAD_THRESHOLD_PX = 200;

type Mode = 'upload' | 'record';

interface ClipRow {
    id: string;
    label: string;
    file_path: string;
    extension: string;
    duration_ms: number;
    file_bytes: number;
    source: 'upload' | 'recording';
    created_at: number;
}

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
    if (!res.ok) {
        const body = await res.json().catch(() => ({} as any));
        const err = new Error(body?.error || `API error ${res.status}`);
        (err as any).status = res.status;
        throw err;
    }
    return res.json();
}

async function uploadClip(blob: Blob, label: string, source: 'upload' | 'recording'): Promise<ClipRow> {
    const fd = new FormData();
    // Server's mime allowlist accepts wav/mp3/ogg/flac. The blob's type
    // already covers wav from the encoder + the original mime for uploads.
    const filename = source === 'recording' ? 'recording.wav' : 'clip';
    fd.append('audio', blob, filename);
    fd.append('label', label);
    fd.append('source', source);
    const token = localStorage.getItem('auth_token') ?? localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/upload`, { method: 'POST', headers, body: fd });
    if (!res.ok) {
        const body = await res.json().catch(() => ({} as any));
        throw new Error(body?.error || `upload failed ${res.status}`);
    }
    return res.json();
}

export class SoundFxPanel {
    readonly el: HTMLElement;

    private privacyBanner!: HTMLDivElement;
    private modeTabs!: HTMLDivElement;
    private formArea!: HTMLDivElement;
    private previewArea!: HTMLDivElement;
    private statusBar!: HTMLDivElement;
    private libraryGrid!: HTMLDivElement;
    private usageLabel!: HTMLSpanElement;

    private mode: Mode = 'upload';
    private mounted = false;

    /** Staged blob waiting for user to label + save. Cleared on save / cancel /
     *  mode-switch. URL.createObjectURL output stored alongside so we can
     *  revoke when staging is dismissed. */
    private staged: { blob: Blob; durationMs: number; previewUrl: string; source: 'upload' | 'recording' } | null = null;

    /** Active mic recording state. Cleared on stop / cancel / panel hide. */
    private recording: {
        stream: MediaStream;
        recorder: MediaRecorder;
        chunks: BlobPart[];
        startedAt: number;
        timerId: number;
        autoStopId: number;
        recBtn: HTMLButtonElement;
        timerEl: HTMLSpanElement;
    } | null = null;

    private library: ClipRow[] = [];
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
            this.refreshUsage();
        }
    }

    /** Force-stop any in-flight recording. Called by EditorView on tab leave
     *  so the mic LED doesn't stay on after the user switches to Chat. */
    cancelRecording(): void {
        if (this.recording) this.stopRecording(/*save=*/false);
    }

    // ── UI build ─────────────────────────────────────────────────────────

    private buildUI(): void {
        // Privacy banner — short, prominent. Three things the user needs to
        // grok: (a) clips are unlisted, only they can use them in chat / AI
        // search, (b) the file URLs are NOT behind auth — anyone who has or
        // guesses one can fetch the audio, (c) anyone playing a published
        // game can extract any audio it uses.
        this.privacyBanner = document.createElement('div');
        this.privacyBanner.className = 'mg-notice';
        this.privacyBanner.innerHTML =
            `<b>${escapeHtml(t('soundFx.notice.privateBold'))}</b> ${escapeHtml(t('soundFx.notice.privateBody'))} ` +
            `${escapeHtml(t('soundFx.notice.extract'))} ` +
            `${escapeHtml(t('soundFx.notice.tokenHint'))}`;
        this.el.appendChild(this.privacyBanner);

        // Daily-count badge.
        const usageRow = document.createElement('div');
        usageRow.className = 'mg-health';
        const usageLeft = document.createElement('span');
        usageLeft.textContent = t('soundFx.header');
        usageLeft.style.fontWeight = '600';
        usageRow.appendChild(usageLeft);
        this.usageLabel = document.createElement('span');
        this.usageLabel.className = 'mg-usage';
        this.usageLabel.textContent = '';
        this.usageLabel.title = t('soundFx.usageTooltip');
        usageRow.appendChild(this.usageLabel);
        this.el.appendChild(usageRow);

        // Mode tabs.
        this.modeTabs = document.createElement('div');
        this.modeTabs.className = 'mg-mode-tabs';
        const uploadBtn = this.makeModeButton('upload', t('soundFx.mode.upload'));
        const recordBtn = this.makeModeButton('record', t('soundFx.mode.record'));
        // Hide Record on browsers without getUserMedia.
        if (!navigator.mediaDevices?.getUserMedia) {
            recordBtn.style.display = 'none';
        }
        this.modeTabs.appendChild(uploadBtn);
        this.modeTabs.appendChild(recordBtn);
        this.el.appendChild(this.modeTabs);

        // Active form area.
        this.formArea = document.createElement('div');
        this.formArea.className = 'mg-card';
        this.el.appendChild(this.formArea);

        // Preview / label area (shown after a file is staged).
        this.previewArea = document.createElement('div');
        this.previewArea.className = 'mg-card';
        this.previewArea.style.display = 'none';
        this.el.appendChild(this.previewArea);

        // Status bar.
        this.statusBar = document.createElement('div');
        this.statusBar.className = 'mg-status';
        this.el.appendChild(this.statusBar);

        // Library header.
        const libHeader = document.createElement('div');
        libHeader.className = 'mg-lib-header';
        const libTitle = document.createElement('span');
        libTitle.textContent = t('soundFx.library.header');
        libTitle.style.fontWeight = '600';
        libTitle.style.padding = '4px 8px';
        libHeader.appendChild(libTitle);
        const refreshBtn = document.createElement('button');
        refreshBtn.title = t('soundFx.library.refresh');
        refreshBtn.className = 'mg-lib-refresh';
        refreshBtn.style.cssText += 'display:inline-flex;align-items:center;justify-content:center;';
        refreshBtn.appendChild(icon(RefreshCw, 14));
        refreshBtn.addEventListener('click', () => this.refreshLibrary());
        libHeader.appendChild(refreshBtn);
        this.el.appendChild(libHeader);

        this.libraryGrid = document.createElement('div');
        this.libraryGrid.className = 'mg-lib-grid';
        this.libraryGrid.innerHTML = `<div class="mg-lib-empty">${escapeHtml(t('soundFx.library.empty'))}</div>`;
        this.el.appendChild(this.libraryGrid);

        this.el.addEventListener('scroll', () => {
            const remaining = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight;
            if (remaining < SCROLL_LOAD_THRESHOLD_PX) this.loadMoreLibrary();
        });

        this.renderForm();
        this.updateModeTabs();
    }

    private makeModeButton(mode: Mode, label: string): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.dataset.mode = mode;
        btn.textContent = label;
        btn.className = 'mg-mode-tab';
        btn.addEventListener('click', () => this.setMode(mode));
        return btn;
    }

    private setMode(mode: Mode): void {
        if (this.mode === mode) return;
        // Switching modes mid-recording = cancel.
        if (this.recording) this.stopRecording(/*save=*/false);
        this.dismissStaged();
        this.mode = mode;
        this.statusBar.textContent = '';
        this.renderForm();
        this.updateModeTabs();
    }

    private updateModeTabs(): void {
        for (const el of Array.from(this.modeTabs.children) as HTMLButtonElement[]) {
            el.classList.toggle('active', el.dataset.mode === this.mode);
        }
    }

    private renderForm(): void {
        this.formArea.innerHTML = '';
        if (this.mode === 'upload') this.renderUploadForm();
        else this.renderRecordForm();
    }

    // ── Upload mode ──────────────────────────────────────────────────────

    private renderUploadForm(): void {
        const dropZone = document.createElement('label');
        dropZone.className = 'mg-dropzone';
        dropZone.innerHTML =
            `<div class="mg-dropzone-primary">${escapeHtml(t('soundFx.upload.dropPrimary'))}</div>` +
            `<div class="mg-dropzone-hint">${escapeHtml(t('soundFx.upload.dropHint'))}</div>`;

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'audio/wav,audio/mpeg,audio/ogg,audio/flac,audio/x-wav,audio/x-flac';
        fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => this.handleFileSelected(fileInput.files?.[0]));
        dropZone.appendChild(fileInput);

        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            this.handleFileSelected(e.dataTransfer?.files?.[0]);
        });

        this.formArea.appendChild(dropZone);
    }

    private async handleFileSelected(file?: File | null): Promise<void> {
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            this.statusBar.textContent = t('soundFx.upload.tooLarge')
                .replace('{mb}', (file.size / (1024 * 1024)).toFixed(1));
            return;
        }

        this.statusBar.textContent = t('soundFx.upload.reading');
        const durationMs = await probeAudioDurationMs(file).catch(() => 0);
        if (!durationMs) {
            this.statusBar.textContent = t('soundFx.upload.parseFailed');
            return;
        }
        if (durationMs > MAX_DURATION_MS) {
            this.statusBar.textContent = t('soundFx.upload.tooLong')
                .replace('{s}', (durationMs / 1000).toFixed(1))
                .replace('{max}', (MAX_DURATION_MS / 1000).toFixed(0));
            return;
        }

        this.statusBar.textContent = '';
        this.stageForSave(file, durationMs, 'upload');
    }

    // ── Record mode ──────────────────────────────────────────────────────

    private renderRecordForm(): void {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.flexDirection = 'column';
        wrap.style.alignItems = 'center';
        wrap.style.gap = '12px';
        wrap.style.padding = '20px 8px';

        const recBtn = document.createElement('button');
        recBtn.className = 'primary';
        recBtn.style.cssText = 'padding:10px 22px;font-size:14px;border-radius:999px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;';
        this.renderRecordBtn(recBtn, /*recording=*/false);
        wrap.appendChild(recBtn);

        const timerEl = document.createElement('span');
        timerEl.textContent = `0.0 / ${(MAX_DURATION_MS / 1000).toFixed(1)}s`;
        timerEl.style.cssText = 'font-variant-numeric:tabular-nums;color:var(--text-secondary);font-size:12px;';
        wrap.appendChild(timerEl);

        const hint = document.createElement('div');
        hint.textContent = t('soundFx.record.hint');
        hint.style.cssText = 'color:var(--text-secondary);font-size:11px;';
        wrap.appendChild(hint);

        recBtn.addEventListener('click', () => {
            if (this.recording) this.stopRecording(/*save=*/true);
            else this.startRecording(recBtn, timerEl);
        });

        this.formArea.appendChild(wrap);
    }

    private async startRecording(recBtn: HTMLButtonElement, timerEl: HTMLSpanElement): Promise<void> {
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e: any) {
            this.statusBar.textContent = t('soundFx.record.micDenied').replace('{reason}', e?.message ?? 'unknown');
            return;
        }

        let recorder: MediaRecorder;
        try {
            recorder = new MediaRecorder(stream);
        } catch (e: any) {
            stream.getTracks().forEach(track => track.stop());
            this.statusBar.textContent = t('soundFx.record.recorderUnavailable').replace('{reason}', e?.message ?? 'unknown');
            return;
        }

        const chunks: BlobPart[] = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

        const startedAt = performance.now();
        const timerId = window.setInterval(() => {
            const elapsed = (performance.now() - startedAt) / 1000;
            timerEl.textContent = `${elapsed.toFixed(1)} / ${(MAX_DURATION_MS / 1000).toFixed(1)}s`;
        }, 100);
        const autoStopId = window.setTimeout(() => {
            if (this.recording) this.stopRecording(/*save=*/true);
        }, MAX_DURATION_MS);

        this.recording = { stream, recorder, chunks, startedAt, timerId, autoStopId, recBtn, timerEl };
        this.renderRecordBtn(recBtn, /*recording=*/true);
        recBtn.classList.add('recording');
        this.statusBar.textContent = '';

        recorder.start();
    }

    /** Re-render the record button with the right icon + label for the
     *  current state. Idle = mic icon + "Record"; recording = stop icon
     *  + "Stop". Replaces the inner content so the click handler binding
     *  on the button itself stays intact. */
    private renderRecordBtn(btn: HTMLButtonElement, recording: boolean): void {
        btn.innerHTML = '';
        btn.appendChild(icon(recording ? Square : Mic, 14));
        const text = document.createElement('span');
        text.textContent = recording ? t('soundFx.record.btnStop') : t('soundFx.record.btnStart');
        btn.appendChild(text);
    }

    private async stopRecording(save: boolean): Promise<void> {
        const r = this.recording;
        if (!r) return;
        // Detach so any subsequent calls (timers, tab-switch) are no-ops.
        this.recording = null;

        clearInterval(r.timerId);
        clearTimeout(r.autoStopId);

        // MediaRecorder.stop() fires onstop after flushing the last chunk.
        await new Promise<void>((resolve) => {
            const finalize = () => resolve();
            r.recorder.addEventListener('stop', finalize, { once: true });
            try { r.recorder.stop(); } catch { resolve(); }
        });

        // ALWAYS release the mic stream — otherwise iOS leaves the recording
        // banner up and Chrome shows a persistent mic indicator.
        r.stream.getTracks().forEach(track => track.stop());

        this.renderRecordBtn(r.recBtn, /*recording=*/false);
        r.recBtn.classList.remove('recording');
        const elapsedMs = performance.now() - r.startedAt;
        r.timerEl.textContent = `0.0 / ${(MAX_DURATION_MS / 1000).toFixed(1)}s`;

        if (!save) return;
        if (r.chunks.length === 0) {
            this.statusBar.textContent = t('soundFx.record.noAudio');
            return;
        }

        this.statusBar.textContent = t('soundFx.record.encoding');
        try {
            const recBlob = new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' });
            const wav = await encodeRecordingToWav(recBlob);
            const durationMs = Math.min(elapsedMs, MAX_DURATION_MS);
            this.statusBar.textContent = '';
            this.stageForSave(wav, Math.round(durationMs), 'recording');
        } catch (e: any) {
            this.statusBar.textContent = t('soundFx.record.encodeFailed').replace('{reason}', e?.message ?? 'unknown');
        }
    }

    // ── Staging + save ───────────────────────────────────────────────────

    private stageForSave(blob: Blob, durationMs: number, source: 'upload' | 'recording'): void {
        // Drop any prior stage.
        this.dismissStaged();

        const previewUrl = URL.createObjectURL(blob);
        this.staged = { blob, durationMs, previewUrl, source };

        this.previewArea.innerHTML = '';
        this.previewArea.style.display = 'flex';
        this.previewArea.style.flexDirection = 'column';
        this.previewArea.style.gap = '8px';

        const head = document.createElement('div');
        head.textContent = source === 'recording'
            ? t('soundFx.staged.headerRecording')
            : t('soundFx.staged.headerUpload');
        head.className = 'mg-label';
        this.previewArea.appendChild(head);

        const meta = document.createElement('div');
        meta.style.cssText = 'font-size:11px;color:var(--text-secondary);';
        meta.textContent = `${(durationMs / 1000).toFixed(1)}s · ${formatBytes(blob.size)}`;
        this.previewArea.appendChild(meta);

        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = previewUrl;
        audio.style.width = '100%';
        this.previewArea.appendChild(audio);

        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.placeholder = t('soundFx.staged.labelPlaceholder');
        labelInput.maxLength = MAX_LABEL_LEN;
        labelInput.className = 'mg-textarea';
        labelInput.style.cssText = 'padding:6px 8px;font-size:13px;width:100%;box-sizing:border-box;';
        this.previewArea.appendChild(labelInput);

        const row = document.createElement('div');
        row.className = 'mg-row';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = t('soundFx.staged.cancel');
        cancelBtn.style.flex = '1';
        cancelBtn.addEventListener('click', () => this.dismissStaged());
        row.appendChild(cancelBtn);

        const saveBtn = document.createElement('button');
        saveBtn.textContent = t('soundFx.staged.save');
        saveBtn.className = 'primary';
        saveBtn.style.flex = '1';
        saveBtn.addEventListener('click', () => this.saveStaged(labelInput.value, saveBtn));
        row.appendChild(saveBtn);
        this.previewArea.appendChild(row);

        labelInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
        });
        labelInput.focus();
    }

    private dismissStaged(): void {
        if (this.staged) {
            try { URL.revokeObjectURL(this.staged.previewUrl); } catch {}
            this.staged = null;
        }
        this.previewArea.style.display = 'none';
        this.previewArea.innerHTML = '';
    }

    private async saveStaged(rawLabel: string, saveBtn: HTMLButtonElement): Promise<void> {
        const s = this.staged;
        if (!s) return;
        const label = rawLabel.trim();
        if (label.length === 0) {
            this.statusBar.textContent = t('soundFx.staged.needLabel');
            return;
        }
        if (label.length > MAX_LABEL_LEN) {
            this.statusBar.textContent = t('soundFx.staged.labelTooLong').replace('{max}', String(MAX_LABEL_LEN));
            return;
        }
        saveBtn.disabled = true;
        this.statusBar.textContent = t('soundFx.save.uploading');
        try {
            const row = await uploadClip(s.blob, label, s.source);
            this.library.unshift(row);
            this.libraryOldestTs = row.created_at;
            this.dismissStaged();
            this.renderLibrary();
            const savedMsg = t('soundFx.save.saved');
            this.statusBar.textContent = savedMsg;
            window.setTimeout(() => { if (this.statusBar.textContent === savedMsg) this.statusBar.textContent = ''; }, 2000);
            this.refreshUsage();
        } catch (e: any) {
            this.statusBar.textContent = t('soundFx.save.failed').replace('{reason}', e?.message ?? 'unknown');
        } finally {
            saveBtn.disabled = false;
        }
    }

    // ── Library ──────────────────────────────────────────────────────────

    private async refreshLibrary(): Promise<void> {
        this.library = [];
        this.libraryOldestTs = null;
        this.libraryExhausted = false;
        this.libraryLoading = false;
        this.libraryGrid.innerHTML = `<div class="mg-lib-empty">${escapeHtml(t('soundFx.library.loading'))}</div>`;
        try {
            const resp = await api<{ items: ClipRow[]; has_more: boolean }>(
                `/library?limit=${LIBRARY_PAGE_SIZE}`
            );
            this.library = resp.items;
            if (this.library.length > 0) {
                this.libraryOldestTs = this.library[this.library.length - 1].created_at;
            }
            this.libraryExhausted = !resp.has_more;
            this.renderLibrary();
        } catch (e: any) {
            // Escape the localized template + the dynamic reason separately,
            // then substitute. Avoids double-escaping the user-supplied
            // reason (escapeHtml(template) leaves '{reason}' alone).
            const tpl = escapeHtml(t('soundFx.library.couldNotLoad'));
            const reason = escapeHtml(e?.message ?? 'unknown');
            this.libraryGrid.innerHTML = `<div class="mg-lib-empty">${tpl.replace('{reason}', reason)}</div>`;
        }
    }

    private async loadMoreLibrary(): Promise<void> {
        if (this.libraryLoading || this.libraryExhausted || this.libraryOldestTs == null) return;
        this.libraryLoading = true;
        try {
            const resp = await api<{ items: ClipRow[]; has_more: boolean }>(
                `/library?limit=${LIBRARY_PAGE_SIZE}&before_ts=${this.libraryOldestTs}`
            );
            this.library.push(...resp.items);
            if (resp.items.length > 0) {
                this.libraryOldestTs = resp.items[resp.items.length - 1].created_at;
            }
            this.libraryExhausted = !resp.has_more;
            this.renderLibrary();
        } catch { /* swallow — leave existing rows */ }
        finally { this.libraryLoading = false; }
    }

    private renderLibrary(): void {
        if (this.library.length === 0) {
            this.libraryGrid.innerHTML = `<div class="mg-lib-empty">${escapeHtml(t('soundFx.library.empty'))}</div>`;
            return;
        }
        this.libraryGrid.innerHTML = '';
        for (const row of this.library) {
            this.libraryGrid.appendChild(this.buildLibraryCard(row));
        }
    }

    private buildLibraryCard(row: ClipRow): HTMLElement {
        const card = document.createElement('div');
        card.className = 'mg-lib-card';
        card.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px;';

        // Top row: speaker icon thumbnail + duration badge.
        const thumb = document.createElement('div');
        thumb.className = 'mg-lib-card-thumb';
        thumb.style.cssText = 'display:flex;align-items:center;justify-content:center;background:var(--bg-secondary);border-radius:4px;height:80px;position:relative;color:var(--text-secondary);';
        thumb.appendChild(icon(Volume2, 32));

        const durBadge = document.createElement('span');
        durBadge.textContent = `${(row.duration_ms / 1000).toFixed(1)}s`;
        durBadge.style.cssText = 'position:absolute;top:4px;right:4px;background:rgba(0,0,0,0.55);color:#fff;border-radius:4px;font-size:10px;padding:2px 6px;';
        thumb.appendChild(durBadge);

        // "+ chat" — reuse model_gen's exact event name. AiChatPanel
        // discriminates audio vs 3D paths by prefix.
        const useBtn = document.createElement('button');
        useBtn.type = 'button';
        useBtn.className = 'mg-lib-card-use';
        useBtn.title = t('soundFx.library.addToChatTooltip');
        useBtn.textContent = '+ chat';
        useBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const detail = {
                id: row.id,
                path: row.file_path,
                thumbUrl: '',
                prompt: row.label,
            };
            document.dispatchEvent(new CustomEvent('parallax:chat-attach-asset', { detail }));
            const orig = useBtn.textContent;
            useBtn.textContent = 'added';
            useBtn.classList.add('mg-lib-card-use-added');
            window.setTimeout(() => {
                useBtn.textContent = orig;
                useBtn.classList.remove('mg-lib-card-use-added');
            }, 1200);
        });
        thumb.appendChild(useBtn);
        card.appendChild(thumb);

        const label = document.createElement('div');
        label.className = 'mg-lib-card-label';
        label.textContent = row.label;
        label.title = row.label;
        card.appendChild(label);

        // Inline player + delete.
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.src = row.file_path;
        audio.style.width = '100%';
        card.appendChild(audio);

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;justify-content:flex-end;';
        const delBtn = document.createElement('button');
        delBtn.title = t('soundFx.library.deleteTooltip');
        delBtn.style.cssText = 'background:transparent;border:0;cursor:pointer;color:var(--text-secondary);padding:2px 6px;display:inline-flex;align-items:center;';
        delBtn.appendChild(icon(Trash2, 14));
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!window.confirm(t('soundFx.library.deleteConfirm').replace('{label}', row.label))) return;
            delBtn.disabled = true;
            try {
                await api(`/${row.id}/delete`, { method: 'POST' });
                this.library = this.library.filter(c => c.id !== row.id);
                this.renderLibrary();
                this.refreshUsage();
            } catch (err: any) {
                this.statusBar.textContent = t('soundFx.library.deleteFailed').replace('{reason}', err?.message ?? 'unknown');
            } finally {
                delBtn.disabled = false;
            }
        });
        actions.appendChild(delBtn);
        card.appendChild(actions);

        return card;
    }

    // ── Usage badge ──────────────────────────────────────────────────────

    private async refreshUsage(): Promise<void> {
        try {
            const resp = await api<{ today: number; limit: number }>(`/usage`);
            this.usageLabel.textContent = t('soundFx.daily')
                .replace('{today}', String(resp.today))
                .replace('{limit}', String(resp.limit));
        } catch {
            this.usageLabel.textContent = '';
        }
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Probe duration of a user-uploaded audio file using the engine's shared
 *  AudioContext. Returns 0 on parse failure (not throwing — the panel
 *  surfaces a friendly message). */
async function probeAudioDurationMs(file: File): Promise<number> {
    const ctx = AudioListenerComponent.getAudioContext();
    if (!ctx) return 0;
    const buf = await file.arrayBuffer();
    try {
        const decoded = await ctx.decodeAudioData(buf.slice(0));
        return Math.round(decoded.duration * 1000);
    } catch {
        return 0;
    }
}

/** Decode a MediaRecorder blob via decodeAudioData, downsample to 22.05 kHz
 *  mono, then encode WAV. Cross-browser: any format the browser will record
 *  (webm/Opus, mp4/AAC) is also one it can decode here. The output is WAV,
 *  which the engine's audio loader supports natively (assets.ts:39). */
async function encodeRecordingToWav(blob: Blob): Promise<Blob> {
    const ctx = AudioListenerComponent.getAudioContext();
    if (!ctx) throw new Error('AudioContext unavailable');
    const arr = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arr);

    // Downsample / mono-mix via OfflineAudioContext. Length is computed in
    // target-rate frames so the rendered buffer's sample count matches.
    const targetRate = TARGET_SAMPLE_RATE;
    const targetLen = Math.max(1, Math.round((decoded.duration) * targetRate));
    const offline = new OfflineAudioContext(1, targetLen, targetRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return encodePCMToWav(rendered.getChannelData(0), targetRate);
}

/** Encode a Float32 PCM buffer to a 16-bit mono WAV Blob. Inline encoder
 *  (~40 LOC) — not worth a dedicated file. Layout: 44-byte RIFF header,
 *  followed by little-endian Int16 samples. */
function encodePCMToWav(samples: Float32Array, sampleRate: number): Blob {
    const numChannels = 1;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples.length * bytesPerSample;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);

    writeString(v, 0, 'RIFF');
    v.setUint32(4, 36 + dataSize, true);
    writeString(v, 8, 'WAVE');
    writeString(v, 12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);                  // PCM format
    v.setUint16(22, numChannels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, byteRate, true);
    v.setUint16(32, blockAlign, true);
    v.setUint16(34, 16, true);                 // bits per sample
    writeString(v, 36, 'data');
    v.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
}

function writeString(v: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) v.setUint8(offset + i, str.charCodeAt(i));
}
