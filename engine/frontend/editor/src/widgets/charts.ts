interface LineChartSeries {
    label: string;
    data: number[];
    color: string;
}

interface LineChartOptions {
    labels: string[];
    series: LineChartSeries[];
    height?: number;
}

/** Draw a multi-series line chart on a canvas element. */
export function drawLineChart(canvas: HTMLCanvasElement, opts: LineChartOptions): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = opts.height ?? 180;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const pad = { top: 20, right: 14, bottom: 32, left: 44 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    let maxVal = 0;
    for (const s of opts.series) {
        for (const v of s.data) if (v > maxVal) maxVal = v;
    }
    if (maxVal === 0) maxVal = 1;
    const niceMax = Math.ceil(maxVal * 1.15);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
        const y = pad.top + ch - (ch / gridSteps) * i;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'right';
        ctx.fillText(String(Math.round((niceMax / gridSteps) * i)), pad.left - 6, y + 3);
    }

    // X labels
    const labelCount = opts.labels.length;
    const maxLabels = Math.min(labelCount, 8);
    const step = Math.max(1, Math.floor(labelCount / maxLabels));
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    for (let i = 0; i < labelCount; i += step) {
        const x = pad.left + (i / Math.max(1, labelCount - 1)) * cw;
        ctx.fillText(opts.labels[i], x, h - 8);
    }

    // Draw series
    for (const series of opts.series) {
        if (series.data.length === 0) continue;
        ctx.strokeStyle = series.color;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (let i = 0; i < series.data.length; i++) {
            const x = pad.left + (i / Math.max(1, series.data.length - 1)) * cw;
            const y = pad.top + ch - (series.data[i] / niceMax) * ch;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Area fill
        ctx.globalAlpha = 0.08;
        ctx.lineTo(pad.left + cw, pad.top + ch);
        ctx.lineTo(pad.left, pad.top + ch);
        ctx.closePath();
        ctx.fillStyle = series.color;
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    // Legend
    let lx = pad.left;
    ctx.font = '10px system-ui';
    for (const s of opts.series) {
        ctx.fillStyle = s.color;
        ctx.fillRect(lx, 4, 10, 10);
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.textAlign = 'left';
        ctx.fillText(s.label, lx + 14, 12);
        lx += ctx.measureText(s.label).width + 30;
    }
}

interface BarChartEntry {
    label: string;
    value: number;
    color?: string;
}

interface BarChartOptions {
    entries: BarChartEntry[];
    height?: number;
    barColor?: string;
}

/** Draw a horizontal bar chart. */
export function drawBarChart(canvas: HTMLCanvasElement, opts: BarChartOptions): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const entries = opts.entries.slice(0, 8);
    const barH = 22;
    const gap = 6;
    const h = opts.height ?? (entries.length * (barH + gap) + 10);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const maxVal = Math.max(1, ...entries.map(e => e.value));
    const labelW = 90;
    const valueW = 50;
    const barArea = w - labelW - valueW - 10;

    for (let i = 0; i < entries.length; i++) {
        const y = i * (barH + gap) + 4;
        const e = entries[i];

        // Label
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '11px system-ui';
        ctx.textAlign = 'left';
        const displayLabel = e.label.length > 14 ? e.label.slice(0, 13) + '...' : e.label;
        ctx.fillText(displayLabel, 0, y + barH / 2 + 4);

        // Bar
        const bw = Math.max(2, (e.value / maxVal) * barArea);
        const color = e.color || opts.barColor || '#8648e6';
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(labelW, y, bw, barH, 4);
        ctx.fill();

        // Value
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.textAlign = 'left';
        ctx.fillText(String(e.value), labelW + bw + 6, y + barH / 2 + 4);
    }
}

interface DonutSegment {
    label: string;
    value: number;
    color: string;
}

/** Draw a donut chart with center label. */
export function drawDonutChart(canvas: HTMLCanvasElement, segments: DonutSegment[], size?: number): void {
    const dpr = window.devicePixelRatio || 1;
    const s = size ?? 120;
    canvas.width = s * dpr;
    canvas.height = s * dpr;
    canvas.style.width = `${s}px`;
    canvas.style.height = `${s}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const total = segments.reduce((a, b) => a + b.value, 0);
    if (total === 0) return;

    const cx = s / 2, cy = s / 2, r = s / 2 - 4, innerR = r * 0.6;
    let angle = -Math.PI / 2;

    for (const seg of segments) {
        const sweep = (seg.value / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, angle, angle + sweep);
        ctx.arc(cx, cy, innerR, angle + sweep, angle, true);
        ctx.closePath();
        ctx.fillStyle = seg.color;
        ctx.fill();
        angle += sweep;
    }

    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = 'bold 16px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(total), cx, cy);
}
