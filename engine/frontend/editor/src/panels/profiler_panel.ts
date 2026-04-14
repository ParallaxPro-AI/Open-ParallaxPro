import { EditorContext } from '../editor_context.js';

/**
 * Performance Profiler panel: live view of engine.getPerfSnapshot().
 * Polls at 10 Hz and renders:
 *   - Headline counters (FPS, frame ms, memory)
 *   - Frame-time history sparkline
 *   - CPU phase breakdown (avg / max / p95 with inline bars)
 *   - Render-pass timings (CPU submit time) + stats
 *   - Per-script costs (sortable by totalMs)
 *   - Entity / script / mesh counts
 *   - Memory-usage sparkline (Chrome only)
 */
export class ProfilerPanel {
    readonly el: HTMLElement;
    private ctx: EditorContext;
    private pollTimer: number | null = null;

    private fpsEl: HTMLElement;
    private smoothnessEl: HTMLElement;
    private frameMsEl: HTMLElement;
    private memoryEl: HTMLElement;

    private frameChart: HTMLCanvasElement;
    private memoryChart: HTMLCanvasElement;
    private memoryChartWrap: HTMLElement;

    private budgetBar: HTMLElement;
    private budgetLegend: HTMLElement;

    private phaseTbody: HTMLTableSectionElement;
    private passTbody: HTMLTableSectionElement;
    private scriptTbody: HTMLTableSectionElement;

    private statsDrawEl: HTMLElement;
    private statsTrisEl: HTMLElement;
    private statsMeshesEl: HTMLElement;
    private statsEntitiesEl: HTMLElement;
    private statsScriptsCountEl: HTMLElement;
    private statsMeshesTotalEl: HTMLElement;

    private lastSnapshot: any = null;
    private copyBtn!: HTMLButtonElement;

    constructor() {
        this.ctx = EditorContext.instance;

        this.el = document.createElement('div');
        this.el.className = 'profiler-panel';
        this.el.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding:12px;overflow-y:auto;height:100%;box-sizing:border-box;color:#c8d0e0;font-size:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

        // ── Headline ────────────────────────────────────────────────
        const headline = document.createElement('div');
        headline.style.cssText = 'display:flex;gap:20px;align-items:center;flex-wrap:wrap;';
        this.fpsEl = this.bigStat(headline, '-- FPS', '#6ea8fe');
        this.smoothnessEl = document.createElement('div');
        this.smoothnessEl.style.cssText = 'font-size:13px;font-weight:600;padding:4px 10px;border-radius:12px;background:#1a2238;color:#8896b4;';
        this.smoothnessEl.textContent = '—';
        headline.appendChild(this.smoothnessEl);

        this.copyBtn = document.createElement('button');
        this.copyBtn.type = 'button';
        this.copyBtn.textContent = 'Copy stats';
        this.copyBtn.style.cssText = 'margin-left:auto;padding:6px 14px;font-size:12px;font-weight:600;color:#c8d0e0;background:#1a2238;border:1px solid #2a3554;border-radius:4px;cursor:pointer;font-family:inherit;';
        this.copyBtn.addEventListener('mouseenter', () => { this.copyBtn.style.background = '#223055'; });
        this.copyBtn.addEventListener('mouseleave', () => { this.copyBtn.style.background = '#1a2238'; });
        this.copyBtn.addEventListener('click', () => this.copyStats());
        headline.appendChild(this.copyBtn);

        this.el.appendChild(headline);

        // ── Frame time chart (simple) ───────────────────────────────
        const frameSection = this.section('Smoothness (last 2 seconds)', 'Lower and flatter is better. The red line marks a smooth 60 fps.');
        this.frameChart = document.createElement('canvas');
        this.frameChart.width = 600;
        this.frameChart.height = 90;
        this.frameChart.style.cssText = 'width:100%;height:90px;background:#0e1220;border:1px solid #1e253a;border-radius:4px;display:block;';
        frameSection.appendChild(this.frameChart);
        this.el.appendChild(frameSection);

        // ── "Where your frame time goes" — simple stacked bar ───────
        const budgetSection = this.section('Where your frame time goes', 'Grouped view of what the engine is spending time on each frame.');
        this.budgetBar = document.createElement('div');
        this.budgetBar.style.cssText = 'display:flex;height:22px;background:#0e1220;border:1px solid #1e253a;border-radius:4px;overflow:hidden;';
        this.budgetLegend = document.createElement('div');
        this.budgetLegend.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px 14px;font-size:12px;';
        budgetSection.appendChild(this.budgetBar);
        budgetSection.appendChild(this.budgetLegend);
        this.el.appendChild(budgetSection);

        // ── Quick stats (what's on screen) ──────────────────────────
        const quickSection = this.section('What\u2019s on screen', '');
        const quickGrid = document.createElement('div');
        quickGrid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;';
        this.statsDrawEl = this.miniStat(quickGrid, 'Draw calls');
        this.statsTrisEl = this.miniStat(quickGrid, 'Triangles');
        this.statsEntitiesEl = this.miniStat(quickGrid, 'Entities');
        quickSection.appendChild(quickGrid);
        this.el.appendChild(quickSection);

        // ── Details (technical) ─────────────────────────────────────
        const details = document.createElement('details');
        details.style.cssText = 'display:flex;flex-direction:column;gap:12px;border-top:1px solid #1e253a;padding-top:10px;';
        const summary = document.createElement('summary');
        summary.textContent = 'Show details';
        summary.style.cssText = 'cursor:pointer;font-size:12px;font-weight:600;color:#8896b4;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;';
        details.appendChild(summary);

        const detailsBody = document.createElement('div');
        detailsBody.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

        // Headline extras
        const headlineExtra = document.createElement('div');
        headlineExtra.style.cssText = 'display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;';
        this.frameMsEl = this.bigStat(headlineExtra, '-- ms', '#9bdb6a');
        this.memoryEl = this.bigStat(headlineExtra, '-- MB', '#e09f54');
        detailsBody.appendChild(headlineExtra);

        // CPU phase table
        const phaseSection = this.section('CPU phases (per tickOneFrame)', 'Each phase timed separately \u2014 bar shows share of total tick time.');
        this.phaseTbody = this.makeTable(phaseSection, ['Phase', 'Avg', 'Max', 'P95', '%']);
        detailsBody.appendChild(phaseSection);

        // Render pass table
        const passSection = this.section('Render passes (CPU submit, ms)', 'Approximate per-pass cost \u2014 CPU time spent assembling and submitting commands. Not true GPU time.');
        this.passTbody = this.makeTable(passSection, ['Pass', 'Avg', 'Max']);
        detailsBody.appendChild(passSection);

        // Extra renderer stat
        const rendererSection = this.section('Renderer (last frame)', '');
        const rendererGrid = document.createElement('div');
        rendererGrid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;';
        this.statsMeshesEl = this.miniStat(rendererGrid, 'Meshes drawn');
        this.statsScriptsCountEl = this.miniStat(rendererGrid, 'Scripts');
        this.statsMeshesTotalEl = this.miniStat(rendererGrid, 'Meshes total');
        rendererSection.appendChild(rendererGrid);
        detailsBody.appendChild(rendererSection);

        // Script cost table
        const scriptSection = this.section('Per-script cost (this frame)', 'Sum of onUpdate / onFixedUpdate / onLateUpdate time across all entities sharing the same script.');
        this.scriptTbody = this.makeTable(scriptSection, ['Script', 'Total ms', 'Calls', 'Avg ms/call']);
        detailsBody.appendChild(scriptSection);

        // Memory chart
        this.memoryChartWrap = this.section('JS heap (MB)', 'Chrome-only \u2014 useful for spotting leaks.');
        this.memoryChart = document.createElement('canvas');
        this.memoryChart.width = 600;
        this.memoryChart.height = 70;
        this.memoryChart.style.cssText = 'width:100%;height:70px;background:#0e1220;border:1px solid #1e253a;border-radius:4px;display:block;';
        this.memoryChartWrap.appendChild(this.memoryChart);
        detailsBody.appendChild(this.memoryChartWrap);

        details.appendChild(detailsBody);
        this.el.appendChild(details);

        this.startPolling();
    }

    // ── Helpers ─────────────────────────────────────────────────────

    private section(title: string, hint: string): HTMLElement {
        const wrap = document.createElement('section');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
        const h = document.createElement('div');
        h.textContent = title;
        h.style.cssText = 'font-size:11px;font-weight:600;color:#8896b4;text-transform:uppercase;letter-spacing:0.06em;';
        wrap.appendChild(h);
        if (hint) {
            const p = document.createElement('div');
            p.textContent = hint;
            p.style.cssText = 'font-size:11px;color:#6a7591;line-height:1.4;';
            wrap.appendChild(p);
        }
        return wrap;
    }

    private bigStat(parent: HTMLElement, initial: string, color: string): HTMLElement {
        const el = document.createElement('div');
        el.style.cssText = `font-size:22px;font-weight:600;color:${color};font-variant-numeric:tabular-nums;`;
        el.textContent = initial;
        parent.appendChild(el);
        return el;
    }

    private miniStat(parent: HTMLElement, label: string): HTMLElement {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;flex-direction:column;';
        const l = document.createElement('div');
        l.style.cssText = 'font-size:10px;color:#6a7591;text-transform:uppercase;letter-spacing:0.05em;';
        l.textContent = label;
        const v = document.createElement('div');
        v.style.cssText = 'font-size:16px;font-weight:600;color:#dbe1ef;font-variant-numeric:tabular-nums;';
        v.textContent = '--';
        wrap.appendChild(l); wrap.appendChild(v);
        parent.appendChild(wrap);
        return v;
    }

    private makeTable(parent: HTMLElement, headers: string[]): HTMLTableSectionElement {
        const table = document.createElement('table');
        table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;';
        const thead = document.createElement('thead');
        const trH = document.createElement('tr');
        for (const h of headers) {
            const th = document.createElement('th');
            th.textContent = h;
            th.style.cssText = 'text-align:left;padding:4px 8px;border-bottom:1px solid #1e253a;font-weight:600;color:#8896b4;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;';
            trH.appendChild(th);
        }
        thead.appendChild(trH);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        table.appendChild(tbody);
        parent.appendChild(table);
        return tbody;
    }

    // ── Polling + rendering ─────────────────────────────────────────

    private startPolling(): void {
        const tick = () => this.update();
        tick();
        this.pollTimer = window.setInterval(tick, 100);
    }

    destroy(): void {
        if (this.pollTimer !== null) {
            window.clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private update(): void {
        const engine: any = this.ctx.engine;
        if (!engine || typeof engine.getPerfSnapshot !== 'function') {
            this.fpsEl.textContent = 'Engine not running';
            return;
        }
        const snap = engine.getPerfSnapshot();
        this.lastSnapshot = snap;

        // Headline: FPS (color-coded) + smoothness label
        const fps = snap.fps;
        let fpsColor = '#6ea8fe';
        let smoothLabel = '—';
        let smoothBg = '#1a2238';
        let smoothFg = '#8896b4';
        if (fps >= 55) { fpsColor = '#9bdb6a'; smoothLabel = 'Smooth'; smoothBg = '#1b2d19'; smoothFg = '#9bdb6a'; }
        else if (fps >= 40) { fpsColor = '#d4c45a'; smoothLabel = 'OK'; smoothBg = '#2d2917'; smoothFg = '#d4c45a'; }
        else if (fps >= 20) { fpsColor = '#e09f54'; smoothLabel = 'Choppy'; smoothBg = '#2d2217'; smoothFg = '#e09f54'; }
        else if (fps > 0) { fpsColor = '#d84c4c'; smoothLabel = 'Laggy'; smoothBg = '#2d1a1a'; smoothFg = '#d84c4c'; }
        this.fpsEl.textContent = `${fps} FPS`;
        this.fpsEl.style.color = fpsColor;
        this.smoothnessEl.textContent = smoothLabel;
        this.smoothnessEl.style.background = smoothBg;
        this.smoothnessEl.style.color = smoothFg;

        // Detail stats
        this.frameMsEl.textContent = `${snap.frameMs.avg.toFixed(2)} ms (max ${snap.frameMs.max.toFixed(1)})`;
        if (snap.memory.supported) {
            this.memoryEl.textContent = `${snap.memory.usedMB.toFixed(1)} MB / ${snap.memory.totalMB.toFixed(0)} MB`;
            this.memoryChartWrap.style.display = '';
        } else {
            this.memoryEl.textContent = 'mem: n/a';
            this.memoryChartWrap.style.display = 'none';
        }

        this.drawFrameChart(snap.frameMsHistory);
        if (snap.memory.supported) {
            this.drawLineChart(this.memoryChart, snap.memory.historyMB, '#e09f54', 0);
        }

        this.renderBudget(snap.phases);
        this.renderPhases(snap.phases);
        this.renderPasses(snap.gpu?.passes ?? []);
        this.renderScripts(snap.scripts ?? []);

        const r = snap.renderer;
        this.statsDrawEl.textContent = String(r.drawCalls);
        this.statsTrisEl.textContent = r.triangles.toLocaleString();
        this.statsMeshesEl.textContent = `${r.meshesRendered} / ${r.meshesTotal}`;

        const c = snap.counts;
        this.statsEntitiesEl.textContent = String(c.entities);
        this.statsScriptsCountEl.textContent = String(c.scripts);
        this.statsMeshesTotalEl.textContent = String(c.meshes);
    }

    // ── Grouped "where time goes" bar ───────────────────────────────
    private renderBudget(phases: Array<{ name: string; avgMs: number }>): void {
        // Bucket raw phases into friendly groups users can reason about.
        const BUCKETS: Array<{ label: string; color: string; match: (n: string) => boolean }> = [
            { label: 'Scripts',   color: '#8860e6', match: n => n.startsWith('scripts') },
            { label: 'Physics',   color: '#d84c94', match: n => n === 'physics' },
            { label: 'Animation', color: '#6ea8fe', match: n => n === 'animation' || n === 'post-animation' || n === 'particles' },
            { label: 'Rendering', color: '#9bdb6a', match: n => n === 'render' || n === 'post-render' },
            { label: 'Other',     color: '#6a7591', match: _ => true },
        ];
        const totals = BUCKETS.map(() => 0);
        for (const p of phases) {
            for (let i = 0; i < BUCKETS.length; i++) {
                if (BUCKETS[i].match(p.name)) { totals[i] += p.avgMs; break; }
            }
        }
        const sum = totals.reduce((a, b) => a + b, 0);

        this.budgetBar.innerHTML = '';
        this.budgetLegend.innerHTML = '';
        if (sum <= 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:8px;color:#6a7591;font-size:12px;';
            empty.textContent = 'No data yet.';
            this.budgetLegend.appendChild(empty);
            return;
        }

        for (let i = 0; i < BUCKETS.length; i++) {
            const ms = totals[i];
            if (ms <= 0) continue;
            const pct = (ms / sum) * 100;

            const seg = document.createElement('div');
            seg.style.cssText = `flex:${pct} 0 0;background:${BUCKETS[i].color};`;
            seg.title = `${BUCKETS[i].label} — ${ms.toFixed(2)} ms (${pct.toFixed(0)}%)`;
            this.budgetBar.appendChild(seg);

            const legendItem = document.createElement('div');
            legendItem.style.cssText = 'display:flex;align-items:center;gap:6px;';
            const swatch = document.createElement('span');
            swatch.style.cssText = `display:inline-block;width:10px;height:10px;background:${BUCKETS[i].color};border-radius:2px;`;
            legendItem.appendChild(swatch);
            const label = document.createElement('span');
            label.textContent = `${BUCKETS[i].label} \u2014 ${ms.toFixed(2)} ms (${pct.toFixed(0)}%)`;
            label.style.color = '#c8d0e0';
            legendItem.appendChild(label);
            this.budgetLegend.appendChild(legendItem);
        }
    }

    private renderPhases(phases: Array<{ name: string; avgMs: number; maxMs: number; p95Ms: number; pct: number }>): void {
        const rows = phases.map(p => {
            const bar = `<div style="position:relative;height:12px;background:#141a2c;border-radius:2px;overflow:hidden;"><div style="position:absolute;inset:0 ${(100 - p.pct * 100).toFixed(1)}% 0 0;background:linear-gradient(90deg,#6ea8fe,#9bdb6a);"></div></div>`;
            return `
                <tr>
                    <td style="padding:4px 8px;border-bottom:1px solid #161b2e;">${escapeHtml(p.name)}</td>
                    <td style="padding:4px 8px;border-bottom:1px solid #161b2e;">${p.avgMs.toFixed(3)}</td>
                    <td style="padding:4px 8px;border-bottom:1px solid #161b2e;color:#e09f54;">${p.maxMs.toFixed(3)}</td>
                    <td style="padding:4px 8px;border-bottom:1px solid #161b2e;">${p.p95Ms.toFixed(3)}</td>
                    <td style="padding:4px 8px;border-bottom:1px solid #161b2e;min-width:100px;">${bar}</td>
                </tr>
            `;
        }).join('');
        this.phaseTbody.innerHTML = rows || '<tr><td colspan="5" style="padding:8px;color:#6a7591;">No data yet.</td></tr>';
    }

    private renderPasses(passes: Array<{ name: string; avgMs: number; maxMs: number }>): void {
        const rows = passes.map(p => `
            <tr>
                <td style="padding:4px 8px;border-bottom:1px solid #161b2e;">${escapeHtml(p.name)}</td>
                <td style="padding:4px 8px;border-bottom:1px solid #161b2e;">${p.avgMs.toFixed(3)}</td>
                <td style="padding:4px 8px;border-bottom:1px solid #161b2e;color:#e09f54;">${p.maxMs.toFixed(3)}</td>
            </tr>
        `).join('');
        this.passTbody.innerHTML = rows || '<tr><td colspan="3" style="padding:8px;color:#6a7591;">No render passes measured.</td></tr>';
    }

    private renderScripts(scripts: Array<{ name: string; totalMs: number; calls: number }>): void {
        const rows = scripts.slice(0, 30).map(s => {
            const avg = s.calls > 0 ? (s.totalMs / s.calls) : 0;
            return `
                <tr>
                    <td style="padding:4px 8px;border-bottom:1px solid #161b2e;">${escapeHtml(s.name)}</td>
                    <td style="padding:4px 8px;border-bottom:1px solid #161b2e;">${s.totalMs.toFixed(3)}</td>
                    <td style="padding:4px 8px;border-bottom:1px solid #161b2e;">${s.calls}</td>
                    <td style="padding:4px 8px;border-bottom:1px solid #161b2e;">${avg.toFixed(4)}</td>
                </tr>
            `;
        }).join('');
        this.scriptTbody.innerHTML = rows || '<tr><td colspan="4" style="padding:8px;color:#6a7591;">No scripts active (press Play to see timings).</td></tr>';
    }

    // ── Charts ──────────────────────────────────────────────────────

    private drawFrameChart(history: number[]): void {
        const c = this.frameChart;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const targetW = c.clientWidth * dpr;
        const targetH = c.clientHeight * dpr;
        if (c.width !== targetW) c.width = targetW;
        if (c.height !== targetH) c.height = targetH;
        const w = c.width, h = c.height;
        ctx.clearRect(0, 0, w, h);

        // Guidelines at 16.67ms (60fps) and 33.3ms (30fps).
        const yMax = Math.max(33.3, ...history, 16.67) * 1.1;

        const guideline = (ms: number, color: string, dash: number[]) => {
            const y = h - (ms / yMax) * h;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.setLineDash(dash);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = color;
            ctx.font = `${10 * dpr}px sans-serif`;
            ctx.textAlign = 'right';
            ctx.fillText(`${ms.toFixed(1)}`, w - 4, y - 2);
        };
        guideline(16.67, '#7a3a3a', [4 * dpr, 4 * dpr]);
        guideline(33.3, '#7a623a', [4 * dpr, 4 * dpr]);

        if (history.length < 2) return;

        // Line
        ctx.strokeStyle = '#9bdb6a';
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        for (let i = 0; i < history.length; i++) {
            const x = (i / (history.length - 1)) * w;
            const y = h - (history[i] / yMax) * h;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    private drawLineChart(c: HTMLCanvasElement, history: number[], color: string, yMinHint: number): void {
        const ctx = c.getContext('2d');
        if (!ctx) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const targetW = c.clientWidth * dpr;
        const targetH = c.clientHeight * dpr;
        if (c.width !== targetW) c.width = targetW;
        if (c.height !== targetH) c.height = targetH;
        const w = c.width, h = c.height;
        ctx.clearRect(0, 0, w, h);
        if (history.length < 2) return;

        let yMin = Infinity, yMax = -Infinity;
        for (const v of history) {
            if (v < yMin) yMin = v;
            if (v > yMax) yMax = v;
        }
        if (yMinHint && yMin > yMinHint) yMin = yMinHint;
        if (yMax - yMin < 1) yMax = yMin + 1;

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        for (let i = 0; i < history.length; i++) {
            const x = (i / (history.length - 1)) * w;
            const y = h - ((history[i] - yMin) / (yMax - yMin)) * h;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // y-axis label — "min – max"
        ctx.fillStyle = '#6a7591';
        ctx.font = `${10 * dpr}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(`${yMin.toFixed(1)} – ${yMax.toFixed(1)}`, 4 * dpr, 10 * dpr);
    }

    // ── Copy stats ──────────────────────────────────────────────────

    private async copyStats(): Promise<void> {
        if (!this.lastSnapshot) return;
        const text = this.formatSnapshot(this.lastSnapshot);
        try {
            await navigator.clipboard.writeText(text);
            this.flashCopyButton('Copied!');
        } catch {
            // Clipboard API can fail in insecure contexts; fall back to a hidden textarea.
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); this.flashCopyButton('Copied!'); }
            catch { this.flashCopyButton('Copy failed'); }
            ta.remove();
        }
    }

    private flashCopyButton(label: string): void {
        const prev = this.copyBtn.textContent;
        this.copyBtn.textContent = label;
        this.copyBtn.disabled = true;
        window.setTimeout(() => {
            this.copyBtn.textContent = prev;
            this.copyBtn.disabled = false;
        }, 1200);
    }

    private formatSnapshot(snap: any): string {
        const lines: string[] = [];
        lines.push(`ParallaxPro Performance — ${new Date().toISOString()}`);
        lines.push('');
        lines.push(`FPS:        ${snap.fps}`);
        lines.push(`Frame time: avg ${snap.frameMs.avg.toFixed(2)} ms   min ${snap.frameMs.min.toFixed(2)}   max ${snap.frameMs.max.toFixed(2)}   p95 ${snap.frameMs.p95.toFixed(2)}   last ${snap.frameMs.last.toFixed(2)}`);
        if (snap.memory?.supported) {
            lines.push(`JS heap:    ${snap.memory.usedMB.toFixed(1)} MB used / ${snap.memory.totalMB.toFixed(0)} MB total`);
        }

        lines.push('');
        lines.push('CPU phases (ms)');
        lines.push(pad('Phase', 22) + pad('avg', 10) + pad('max', 10) + pad('p95', 10) + pad('share', 8));
        for (const p of snap.phases || []) {
            lines.push(
                pad(p.name, 22) +
                pad(p.avgMs.toFixed(3), 10) +
                pad(p.maxMs.toFixed(3), 10) +
                pad(p.p95Ms.toFixed(3), 10) +
                pad(`${(p.pct * 100).toFixed(1)}%`, 8)
            );
        }

        lines.push('');
        const gpu = snap.gpu || { passes: [] };
        lines.push(`Render passes (${gpu.mode === 'cpu-submit' ? 'CPU submit, ms' : 'GPU, ms'})`);
        lines.push(pad('Pass', 22) + pad('avg', 10) + pad('max', 10));
        for (const p of gpu.passes || []) {
            lines.push(pad(p.name, 22) + pad(p.avgMs.toFixed(3), 10) + pad(p.maxMs.toFixed(3), 10));
        }

        lines.push('');
        const r = snap.renderer || {};
        lines.push('Renderer (last frame)');
        lines.push(`  Draw calls:     ${r.drawCalls ?? 0}`);
        lines.push(`  Triangles:      ${(r.triangles ?? 0).toLocaleString()}`);
        lines.push(`  Meshes drawn:   ${r.meshesRendered ?? 0} / ${r.meshesTotal ?? 0}`);

        lines.push('');
        const c = snap.counts || {};
        lines.push('Scene counts');
        lines.push(`  Entities:       ${c.entities ?? 0}`);
        lines.push(`  Scripts:        ${c.scripts ?? 0}`);
        lines.push(`  Meshes total:   ${c.meshes ?? 0}`);

        const scripts = snap.scripts || [];
        if (scripts.length > 0) {
            lines.push('');
            lines.push('Per-script cost (this frame)');
            lines.push(pad('Script', 30) + pad('total ms', 12) + pad('calls', 8) + pad('avg ms/call', 12));
            for (const s of scripts.slice(0, 30)) {
                const avg = s.calls > 0 ? (s.totalMs / s.calls) : 0;
                lines.push(
                    pad(s.name, 30) +
                    pad(s.totalMs.toFixed(3), 12) +
                    pad(String(s.calls), 8) +
                    pad(avg.toFixed(4), 12)
                );
            }
        }

        return lines.join('\n');
    }
}

function pad(s: string, width: number): string {
    if (s.length >= width) return s + ' ';
    return s + ' '.repeat(width - s.length);
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
