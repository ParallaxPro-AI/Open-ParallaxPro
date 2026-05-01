/**
 * GPU backend detection. Probes WebGPU first (preferred — used by the
 * full pipeline with shadows, HBAO, SSR, bloom, decals). Falls back to
 * WebGL2 (a reduced-feature pipeline: lit geometry + skybox + skinning
 * only) when WebGPU is unavailable. Both-fail produces a single
 * unsupported-browser overlay.
 *
 * Caught at boot in main.ts / play.ts so the user sees the message
 * before the heavy bundle loads and a frozen splash.
 */

import { GfxBackend } from '../../../runtime/function/render/i_renderer.js';

export interface WebGPUSupportResult {
    supported: boolean;
    reason?: string;
}

/**
 * Synchronous WebGPU presence check. `navigator.gpu` is the cheapest
 * proxy — full readiness requires `requestAdapter()` which is async.
 * Kept exported for legacy call sites; new code should use
 * `detectBackend()` instead.
 */
export function checkWebGPUSupport(): WebGPUSupportResult {
    if (typeof navigator === 'undefined' || !(navigator as any).gpu) {
        return { supported: false, reason: 'navigator.gpu is undefined' };
    }
    return { supported: true };
}

/**
 * Real backend probe. Tries WebGPU adapter first, then WebGL2 context
 * on a throwaway canvas. Returns `null` only when neither works —
 * that's the single case that should display the unsupported overlay.
 */
export async function detectBackend(): Promise<GfxBackend | null> {
    // ?backend=webgl2 / ?backend=webgpu URL override for testing the
    // fallback path without disabling WebGPU at the browser level.
    // Survives reloads (unlike a console-side `navigator.gpu = undefined`
    // override, which gets wiped by the new document).
    let forced: GfxBackend | null = null;
    try {
        const sp = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
        const v = sp.get('backend');
        if (v === 'webgl2' || v === 'webgpu') forced = v;
    } catch { /* swallow */ }

    if (forced !== 'webgl2') {
        if (typeof navigator !== 'undefined' && (navigator as any).gpu) {
            try {
                const adapter = await (navigator as any).gpu.requestAdapter({ powerPreference: 'high-performance' });
                if (adapter) return 'webgpu';
            } catch { /* fall through to WebGL2 */ }
        }
    }

    if (typeof document !== 'undefined') {
        try {
            const probe = document.createElement('canvas');
            const ctx = probe.getContext('webgl2');
            if (ctx) {
                const lose = (ctx as WebGL2RenderingContext).getExtension('WEBGL_lose_context');
                if (lose) lose.loseContext();
                return 'webgl2';
            }
        } catch { /* fall through */ }
    }

    return null;
}

/**
 * Mount a fullscreen, non-dismissable error overlay shown only when
 * BOTH WebGPU and WebGL2 are unavailable. Call once and stop further
 * boot.
 */
export function showNoGpuScreen(): void {
    if (typeof document === 'undefined') return;
    for (const id of ['splash-screen', 'loading-screen', 'error-screen']) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }

    const overlay = document.createElement('div');
    overlay.id = 'no-gpu-overlay';
    overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483646;background:#0f1117;color:#e7e9ee;' +
        'display:flex;align-items:center;justify-content:center;padding:24px;' +
        'font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;-webkit-font-smoothing:antialiased;';
    overlay.innerHTML =
        '<div style="max-width:520px;text-align:center;">' +
            '<div style="font-size:56px;margin-bottom:18px;">&#x26A0;&#xFE0F;</div>' +
            '<div style="font-size:22px;font-weight:700;margin-bottom:10px;letter-spacing:0.2px;">WebGPU and WebGL2 are not supported</div>' +
            '<div style="font-size:14px;line-height:1.55;color:#9aa3b3;margin-bottom:20px;">' +
                'ParallaxPro needs a recent browser with hardware-accelerated graphics. ' +
                'Please try Chrome, Edge, Firefox, or Safari 16+ on a desktop or modern mobile device.' +
            '</div>' +
        '</div>';

    if (document.body) document.body.appendChild(overlay);
    else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(overlay));
}

/**
 * Legacy shim. Old callers expected a "WebGPU not supported" screen;
 * preserved so external imports keep compiling, but routes through the
 * new no-gpu screen since the fallback path now handles WebGPU-missing
 * automatically (it probes WebGL2 next).
 */
export function showWebGPUUnsupportedScreen(): void {
    showNoGpuScreen();
}
