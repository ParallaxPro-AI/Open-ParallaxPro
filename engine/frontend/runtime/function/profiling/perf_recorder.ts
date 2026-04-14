/**
 * PerfRecorder: rolling per-phase + per-frame timing used by the editor's
 * Performance Profiler panel. Callers bracket work with beginPhase/endPhase
 * and wrap whole frames with beginFrame/endFrame; snapshot() produces a
 * read-only view suitable for UI rendering.
 */

const FRAME_BUFFER_SIZE = 120;

export interface PhaseStats {
    /** Phase key (e.g. "input", "scripts.update", "render"). */
    name: string;
    /** Mean over the ring buffer, in milliseconds. */
    avgMs: number;
    maxMs: number;
    /** 95th percentile over the ring buffer, in milliseconds. */
    p95Ms: number;
    /** Share of total frame time, 0..1. */
    pct: number;
}

export interface FrameMsStats {
    last: number;
    avg: number;
    min: number;
    max: number;
    p95: number;
}

export interface MemoryStats {
    /** False on browsers that don't expose `performance.memory` (Firefox/Safari). */
    supported: boolean;
    usedMB: number;
    totalMB: number;
    /** Rolling MB samples for the chart. Length matches frameMsHistory. */
    historyMB: number[];
}

export interface PerfSnapshotCore {
    frameMs: FrameMsStats;
    /** Last FRAME_BUFFER_SIZE frame times, oldest→newest, in milliseconds. */
    frameMsHistory: number[];
    phases: PhaseStats[];
    memory: MemoryStats;
}

export class PerfRecorder {
    private frameStart: number = 0;
    private phaseStart: number = 0;
    private currentPhase: string | null = null;

    // Insertion-ordered list so the UI renders phases in the order the
    // engine runs them, not alphabetically.
    private phaseNames: string[] = [];
    private phaseHistory: Map<string, Float32Array> = new Map();

    private frameMsHistory = new Float32Array(FRAME_BUFFER_SIZE);
    private memoryHistory = new Float32Array(FRAME_BUFFER_SIZE);

    private ringIndex = 0;
    private ringFill = 0;

    beginFrame(): void {
        this.frameStart = performance.now();
        // Zero this slot across all known phases so that phases which don't
        // run on this frame (editor-mode branches) don't leak stale values
        // from FRAME_BUFFER_SIZE frames ago.
        for (const arr of this.phaseHistory.values()) {
            arr[this.ringIndex] = 0;
        }
    }

    beginPhase(name: string): void {
        this.phaseStart = performance.now();
        this.currentPhase = name;
    }

    endPhase(): void {
        if (this.currentPhase === null) return;
        const elapsed = performance.now() - this.phaseStart;
        let arr = this.phaseHistory.get(this.currentPhase);
        if (!arr) {
            arr = new Float32Array(FRAME_BUFFER_SIZE);
            this.phaseHistory.set(this.currentPhase, arr);
            this.phaseNames.push(this.currentPhase);
        }
        arr[this.ringIndex] += elapsed;
        this.currentPhase = null;
    }

    endFrame(): void {
        const total = performance.now() - this.frameStart;
        this.frameMsHistory[this.ringIndex] = total;

        const mem = (performance as any).memory;
        if (mem) {
            this.memoryHistory[this.ringIndex] = mem.usedJSHeapSize / (1024 * 1024);
        }

        this.ringIndex = (this.ringIndex + 1) % FRAME_BUFFER_SIZE;
        this.ringFill = Math.min(this.ringFill + 1, FRAME_BUFFER_SIZE);
    }

    snapshot(): PerfSnapshotCore {
        const n = this.ringFill;
        if (n === 0) {
            return {
                frameMs: { last: 0, avg: 0, min: 0, max: 0, p95: 0 },
                frameMsHistory: [],
                phases: [],
                memory: { supported: !!(performance as any).memory, usedMB: 0, totalMB: 0, historyMB: [] },
            };
        }

        const frameMs = this.summarize(this.frameMsHistory, n);
        const frameMsHistory = this.ordered(this.frameMsHistory, n);

        let totalPhaseAvg = 0;
        const phaseRaw: Array<{ name: string; avg: number; max: number; p95: number }> = [];
        for (const name of this.phaseNames) {
            const arr = this.phaseHistory.get(name)!;
            const s = this.summarize(arr, n);
            phaseRaw.push({ name, avg: s.avg, max: s.max, p95: s.p95 });
            totalPhaseAvg += s.avg;
        }
        const phases: PhaseStats[] = phaseRaw.map(p => ({
            name: p.name,
            avgMs: p.avg,
            maxMs: p.max,
            p95Ms: p.p95,
            pct: totalPhaseAvg > 0 ? p.avg / totalPhaseAvg : 0,
        }));

        const mem = (performance as any).memory;
        const memory: MemoryStats = {
            supported: !!mem,
            usedMB: mem ? mem.usedJSHeapSize / (1024 * 1024) : 0,
            totalMB: mem ? mem.totalJSHeapSize / (1024 * 1024) : 0,
            historyMB: mem ? this.ordered(this.memoryHistory, n) : [],
        };

        return { frameMs, frameMsHistory, phases, memory };
    }

    private summarize(arr: Float32Array, n: number): FrameMsStats {
        // Read only the n valid samples from the ring, preserving chronological order.
        const samples = this.ordered(arr, n);
        let sum = 0, min = Infinity, max = -Infinity;
        for (const v of samples) {
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
        }
        const avg = sum / n;
        // Copy then sort for percentile (don't mutate the ring).
        const sorted = Float32Array.from(samples);
        sorted.sort();
        const p95Idx = Math.min(n - 1, Math.floor(n * 0.95));
        const last = arr[(this.ringIndex - 1 + FRAME_BUFFER_SIZE) % FRAME_BUFFER_SIZE];
        return { last, avg, min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max, p95: sorted[p95Idx] };
    }

    /** Copy the n valid ring-buffer samples in chronological (oldest→newest) order. */
    private ordered(arr: Float32Array, n: number): number[] {
        const out: number[] = new Array(n);
        // Oldest sample is `n` slots behind the write head (ringIndex points to
        // the next slot to write). When the ring isn't full, oldest is at 0.
        const start = this.ringFill < FRAME_BUFFER_SIZE ? 0 : this.ringIndex;
        for (let i = 0; i < n; i++) {
            out[i] = arr[(start + i) % FRAME_BUFFER_SIZE];
        }
        return out;
    }
}
