/**
 * Early WebGPU support check. Engine init also throws "WebGPU is not
 * supported" inside GPUDeviceManager.initialize, but by then the user
 * has already loaded the heavy editor/play bundle and is staring at a
 * loading spinner that never finishes (iOS Safari) or a generic error
 * dialog. Catching this at module-load gives a clear, actionable
 * message before any of that runs.
 *
 * Targets the iOS Safari case primarily — WebGPU is behind a flag in
 * iOS 17+ and unsupported entirely on older versions. Also catches
 * Firefox-without-WebGPU-flag, very old Chrome, in-app browsers.
 */

export interface WebGPUSupportResult {
    supported: boolean;
    reason?: string;
}

export function checkWebGPUSupport(): WebGPUSupportResult {
    if (typeof navigator === 'undefined' || !(navigator as any).gpu) {
        return { supported: false, reason: 'navigator.gpu is undefined' };
    }
    return { supported: true };
}

/**
 * Mount a fullscreen, non-dismissable error overlay. Returns nothing —
 * caller should not continue past this point.
 */
export function showWebGPUUnsupportedScreen(): void {
    if (typeof document === 'undefined') return;
    // If the splash / loading screens exist (play.html), hide them so
    // the WebGPU message is the only thing visible.
    for (const id of ['splash-screen', 'loading-screen', 'error-screen']) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }

    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/i.test(ua);
    const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
    const isFirefox = /firefox/i.test(ua);

    let suggestion = 'Try Chrome or Edge on desktop, or a recent Chromium-based browser on Android.';
    if (isIOS) {
        suggestion = 'WebGPU is required to run the engine, but iPhone Safari does not support it yet. Please use a desktop browser (Chrome, Edge, or Safari 16.4+) to play.';
    } else if (isSafari) {
        suggestion = 'Safari supports WebGPU starting in macOS 14 / Safari 16.4. Update your browser, or try Chrome or Edge.';
    } else if (isFirefox) {
        suggestion = 'Firefox does not enable WebGPU by default. Use Chrome or Edge, or enable WebGPU in about:config under dom.webgpu.enabled.';
    }

    const overlay = document.createElement('div');
    overlay.id = 'webgpu-unsupported-overlay';
    overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483646;background:#0f1117;color:#e7e9ee;' +
        'display:flex;align-items:center;justify-content:center;padding:24px;' +
        'font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;-webkit-font-smoothing:antialiased;';
    overlay.innerHTML =
        '<div style="max-width:520px;text-align:center;">' +
            '<div style="font-size:56px;margin-bottom:18px;">&#x26A0;&#xFE0F;</div>' +
            '<div style="font-size:22px;font-weight:700;margin-bottom:10px;letter-spacing:0.2px;">WebGPU is not supported in this browser</div>' +
            '<div style="font-size:14px;line-height:1.55;color:#9aa3b3;margin-bottom:20px;">' +
                suggestion +
            '</div>' +
            '<div style="font-size:11px;color:#5a6376;border-top:1px solid rgba(255,255,255,0.08);padding-top:14px;margin-top:10px;">' +
                'ParallaxPro renders games with WebGPU for performance. We can\'t fall back to WebGL.' +
            '</div>' +
        '</div>';

    if (document.body) document.body.appendChild(overlay);
    else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(overlay));
}
