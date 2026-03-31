const INTERACTIVE_SELECTOR = 'button,input,select,a,[data-interactive],[onclick]';

export class HTMLUIManager {
    private overlays: Map<string, HTMLIFrameElement> = new Map();
    private container: HTMLElement | null = null;
    private cleanups: Map<string, () => void> = new Map();
    private resizeObserver: ResizeObserver | null = null;
    private tabInterceptor: ((e: KeyboardEvent) => void) | null = null;
    private currentZoom: number = 1;
    private lastHoveredEl: HTMLElement | null = null;
    private cursorRelX: number = 0;
    private cursorRelY: number = 0;
    private focusedIframe: HTMLIFrameElement | null = null;

    onUICommand: ((data: any) => void) | null = null;

    setContainer(el: HTMLElement): void { this.container = el; }

    setVisible(visible: boolean): void {
        for (const iframe of this.overlays.values()) {
            iframe.style.visibility = visible ? '' : 'hidden';
        }
    }

    loadUI(path: string, htmlContent: string): void {
        this.unloadUI(path);
        const container = this.container || document.querySelector('.viewport-canvas-container') as HTMLElement | null;
        if (!container) return;

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;background:transparent;pointer-events:none;z-index:15;display:none;';

        const wrapped = `<!DOCTYPE html><html><head><style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:100%;height:100%;background:transparent;overflow:hidden;pointer-events:none;font-family:'Segoe UI',sans-serif;color:white;}
button,input,select,a,[data-interactive]{cursor:pointer;}
.virtual-hover{filter:brightness(1.3) !important;outline:1px solid rgba(255,255,255,0.3) !important;}
button.virtual-hover,a.virtual-hover,[data-interactive].virtual-hover{filter:brightness(1.4) !important;outline:1px solid rgba(255,255,255,0.5) !important;}
</style></head><body>${htmlContent}
<script>
document.querySelectorAll('button,input,select,a,[onclick],[data-interactive]').forEach(el=>el.style.pointerEvents='auto');
new MutationObserver(()=>{document.querySelectorAll('button,input,select,a,[onclick],[data-interactive]').forEach(el=>el.style.pointerEvents='auto');}).observe(document.body,{childList:true,subtree:true});
</script></body></html>`;

        iframe.srcdoc = wrapped;
        container.appendChild(iframe);
        this.overlays.set(path, iframe);

        // Scale UI based on viewport size (designed for 1920px width)
        if (!this.resizeObserver) {
            const updateZoom = () => {
                const w = container.clientWidth || 1920;
                this.currentZoom = Math.min(w / 1920, 1);
                for (const f of this.overlays.values()) {
                    (f.style as any).zoom = String(this.currentZoom);
                }
            };
            updateZoom();
            this.resizeObserver = new ResizeObserver(updateZoom);
            this.resizeObserver.observe(container);
        }

        // Prevent Tab from cycling through page elements during play
        if (!this.tabInterceptor) {
            this.tabInterceptor = (e: KeyboardEvent) => {
                if (e.key === 'Tab') e.preventDefault();
            };
            document.addEventListener('keydown', this.tabInterceptor, true);
        }

        const getInteractiveAt = (clientX: number, clientY: number): HTMLElement | null => {
            try {
                const doc = iframe.contentDocument;
                if (!doc) return null;
                const rect = iframe.getBoundingClientRect();
                const x = clientX - rect.left;
                const y = clientY - rect.top;
                if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
                const el = doc.elementFromPoint(x, y);
                if (!el || el === doc.documentElement || el === doc.body) return null;
                const interactive = el.closest(INTERACTIVE_SELECTOR) as HTMLElement;
                if (interactive) return interactive;
                const pe = iframe.contentWindow?.getComputedStyle(el)?.pointerEvents;
                if (pe === 'auto' || pe === 'all') return el as HTMLElement;
                return null;
            } catch {
                return null;
            }
        };

        const onMouseDown = (e: MouseEvent) => {
            if (getInteractiveAt(e.clientX, e.clientY)) e.stopPropagation();
        };
        const onMouseUp = (e: MouseEvent) => {
            if (getInteractiveAt(e.clientX, e.clientY)) e.stopPropagation();
        };
        const onClick = (e: MouseEvent) => {
            const el = getInteractiveAt(e.clientX, e.clientY);
            if (el) {
                e.stopPropagation();
                el.click();
            }
        };
        const onMouseMove = (e: MouseEvent) => {
            const el = getInteractiveAt(e.clientX, e.clientY);
            container.style.cursor = el ? 'pointer' : '';
        };

        container.addEventListener('mousedown', onMouseDown, true);
        container.addEventListener('mouseup', onMouseUp, true);
        container.addEventListener('click', onClick, true);
        container.addEventListener('mousemove', onMouseMove);

        const onMessage = (e: MessageEvent) => {
            if (e.source === iframe.contentWindow && e.data?.type === 'game_command') {
                this.onUICommand?.(e.data);
            }
        };
        window.addEventListener('message', onMessage);

        this.cleanups.set(path, () => {
            container.removeEventListener('mousedown', onMouseDown, true);
            container.removeEventListener('mouseup', onMouseUp, true);
            container.removeEventListener('click', onClick, true);
            container.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('message', onMessage);
            container.style.cursor = '';
        });
    }

    /**
     * Send a partial state update to all UI overlays.
     */
    sendState(state: any): void {
        for (const iframe of this.overlays.values()) {
            try {
                iframe.contentWindow?.dispatchEvent(new CustomEvent('gamestate', { detail: state }));
                iframe.contentWindow?.postMessage({ type: 'gameState', state }, '*');
            } catch { /* iframe may be unloaded */ }
        }
    }

    /**
     * Set visibility and pointer-events for overlays based on state flags.
     * For an overlay loaded at path "foo/bar.html", checks `state.barVisible`.
     */
    applyVisibility(state: any): void {
        for (const [path, iframe] of this.overlays.entries()) {
            const name = path.replace(/^.*\//, '').replace('.html', '');
            const flag = name + 'Visible';

            if (flag in state) {
                const show = !!state[flag];
                iframe.style.display = show ? '' : 'none';
                if (this.focusedIframe !== iframe) {
                    iframe.style.pointerEvents = show ? 'auto' : 'none';
                }
            }
        }
    }

    /**
     * Update the virtual cursor position and handle hover/click.
     */
    updateCursor(cursorState: { visible: boolean; x: number; y: number } | null, click?: { x: number; y: number }): void {
        const container = this.container || document.querySelector('.viewport-canvas-container') as HTMLElement | null;
        if (!container) return;

        if (cursorState?.visible) {
            this.cursorRelX = cursorState.x;
            this.cursorRelY = cursorState.y;

            let el = document.getElementById('__virtual_cursor__');
            if (!el) {
                el = document.createElement('div');
                el.id = '__virtual_cursor__';
                el.style.cssText =
                    'position:absolute;z-index:99999;pointer-events:none;width:24px;height:24px;' +
                    'border:2px solid #ffffff;border-radius:50%;' +
                    'box-shadow:0 0 6px rgba(0,0,0,0.9),0 0 12px rgba(255,255,255,0.4);' +
                    'transform:translate(-50%,-50%);background:rgba(255,255,255,0.08);';
                const dot = document.createElement('div');
                dot.style.cssText = 'position:absolute;top:50%;left:50%;width:4px;height:4px;background:white;border-radius:50%;transform:translate(-50%,-50%);';
                el.appendChild(dot);
                container.appendChild(el);
            }
            el.style.left = cursorState.x + 'px';
            el.style.top = cursorState.y + 'px';
            el.style.display = 'block';

            // Virtual hover
            const hovered = this.getElementAtCursor(this.cursorRelX, this.cursorRelY);
            if (hovered !== this.lastHoveredEl) {
                this.lastHoveredEl?.classList.remove('virtual-hover');
                hovered?.classList.add('virtual-hover');
                this.lastHoveredEl = hovered;
            }
        } else {
            const el = document.getElementById('__virtual_cursor__');
            if (el) el.remove();
            if (this.lastHoveredEl) {
                this.lastHoveredEl.classList.remove('virtual-hover');
                this.lastHoveredEl = null;
            }
        }

        container.style.cursor = cursorState?.visible ? 'default' : 'none';

        if (click) {
            this.virtualClick(click.x, click.y);
        }
    }

    sendEntityPositions(positions: any[]): void {
        for (const iframe of this.overlays.values()) {
            try {
                iframe.contentWindow?.dispatchEvent(new CustomEvent('entity_positions', { detail: positions }));
            } catch { /* iframe may be unloaded */ }
        }
    }

    unloadUI(path: string): void {
        const cleanup = this.cleanups.get(path);
        if (cleanup) { cleanup(); this.cleanups.delete(path); }
        const iframe = this.overlays.get(path);
        if (iframe) {
            iframe.remove();
            this.overlays.delete(path);
        }
    }

    destroyAll(): void {
        for (const path of [...this.overlays.keys()]) this.unloadUI(path);
        if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }
        if (this.tabInterceptor) { document.removeEventListener('keydown', this.tabInterceptor, true); this.tabInterceptor = null; }
        const vc = document.getElementById('__virtual_cursor__');
        if (vc) vc.remove();
        this.lastHoveredEl = null;
    }

    private getElementAtCursor(x: number, y: number): HTMLElement | null {
        const zoom = this.currentZoom || 1;
        const ix = x / zoom;
        const iy = y / zoom;
        for (const iframe of this.overlays.values()) {
            if (iframe.style.pointerEvents === 'none') continue;
            try {
                const doc = iframe.contentDocument;
                if (!doc) continue;
                const el = doc.elementFromPoint(ix, iy);
                if (!el || el === doc.documentElement || el === doc.body) continue;
                const interactive = el.closest(INTERACTIVE_SELECTOR) as HTMLElement;
                return interactive || el as HTMLElement;
            } catch { /* cross-origin iframe */ }
        }
        return null;
    }

    private virtualClick(x: number, y: number): void {
        for (const iframe of this.overlays.values()) {
            if (iframe.style.pointerEvents === 'none') continue;
            try {
                const doc = iframe.contentDocument;
                if (!doc) continue;
                const zoom = this.currentZoom || 1;
                const ix = x / zoom;
                const iy = y / zoom;
                if (ix < 0 || iy < 0) continue;

                const el = doc.elementFromPoint(ix, iy);
                if (!el || el === doc.documentElement || el === doc.body) continue;

                const target = el.closest(INTERACTIVE_SELECTOR) as HTMLElement || el;

                const opts: MouseEventInit = { clientX: ix, clientY: iy, bubbles: true, cancelable: true };
                target.dispatchEvent(new MouseEvent('mousedown', opts));
                target.dispatchEvent(new MouseEvent('mouseup', opts));
                target.click();

                // Focus input elements so keyboard input works
                const tag = target.tagName?.toUpperCase();
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
                    try { document.exitPointerLock(); } catch { /* may not be locked */ }
                    iframe.style.pointerEvents = 'auto';
                    iframe.focus();
                    setTimeout(() => { target.focus(); }, 0);
                    this.focusedIframe = iframe;
                    target.addEventListener('blur', () => {
                        if (this.focusedIframe === iframe) {
                            this.focusedIframe = null;
                        }
                    }, { once: true });
                }
                return;
            } catch { /* cross-origin iframe */ }
        }
    }
}
