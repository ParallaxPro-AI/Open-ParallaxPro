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

    private applyScale(f: HTMLIFrameElement): void {
        const s = this.currentZoom;
        if (s < 1) {
            f.style.transform = `scale(${s})`;
            f.style.transformOrigin = 'top left';
            f.style.width = `${100 / s}%`;
            f.style.height = `${100 / s}%`;
        } else {
            f.style.transform = '';
            f.style.width = '100%';
            f.style.height = '100%';
        }
    }

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

        const wrapped = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>
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
        this.applyScale(iframe);

        // Scale UI based on viewport size (designed for 1920px width).
        // Uses transform:scale + enlarged dimensions so the iframe fills
        // the container while its content is scaled down. CSS zoom would
        // shrink the iframe's layout box, leaving dead space.
        if (!this.resizeObserver) {
            const updateZoom = () => {
                const w = container.clientWidth || 1920;
                this.currentZoom = Math.min(w / 1920, 1);
                for (const f of this.overlays.values()) {
                    this.applyScale(f);
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

        // When the iframe is pointer-events:auto the browser already routes
        // native mouse events to the target inside it — we don't need (and
        // can't afford) to synthesise a second click, that'd toggle
        // two-state buttons twice and make them appear unresponsive. Only
        // synthesise when the iframe is click-through (pointer-events:none)
        // such as an unhovered HUD or a full-screen panel driven purely by
        // the virtual cursor.
        const onMouseDown = (e: MouseEvent) => {
            if (iframe.style.pointerEvents === 'auto') return;
            if (getInteractiveAt(e.clientX, e.clientY)) e.stopPropagation();
        };
        const onMouseUp = (e: MouseEvent) => {
            if (iframe.style.pointerEvents === 'auto') return;
            if (getInteractiveAt(e.clientX, e.clientY)) e.stopPropagation();
        };
        const onClick = (e: MouseEvent) => {
            if (iframe.style.pointerEvents === 'auto') return;
            const el = getInteractiveAt(e.clientX, e.clientY);
            if (el) {
                e.stopPropagation();
                el.click();
            }
        };
        const onMouseMove = (e: MouseEvent) => {
            const el = getInteractiveAt(e.clientX, e.clientY);
            container.style.cursor = el ? 'pointer' : '';
            // For HUD panels (click-through by default), flip the iframe to
            // pointer-events:auto while the cursor is over one of its
            // interactive children so native clicks land; else back to none
            // so the rest of the screen stays click-through to the canvas.
            // getInteractiveAt is closure-bound to this iframe, so a non-null
            // `el` means the mouse is over an interactive element inside it.
            const pName = path.replace('ui/', '').replace('.html', '');
            const isHud = pName.startsWith('hud/') || pName === 'game_hud';
            if (isHud && iframe.style.display !== 'none') {
                iframe.style.pointerEvents = el ? 'auto' : 'none';
            }
        };

        container.addEventListener('mousedown', onMouseDown, true);
        container.addEventListener('mouseup', onMouseUp, true);
        container.addEventListener('click', onClick, true);
        container.addEventListener('mousemove', onMouseMove);

        const panelName = path.replace('ui/', '').replace('.html', '');
        const onMessage = (e: MessageEvent) => {
            if (e.source === iframe.contentWindow && e.data?.type === 'game_command') {
                this.onUICommand?.({ ...e.data, panel: panelName });
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
     * Send a partial state update to all UI overlays (does NOT toggle visibility).
     */
    sendStatePartial(state: any): void {
        for (const iframe of this.overlays.values()) {
            try {
                iframe.contentWindow?.postMessage({ type: 'gameState', state }, '*');
            } catch { /* iframe may be unloaded */ }
        }
    }

    /**
     * Send full state update: dispatch to iframes, toggle panel visibility,
     * render virtual cursor, handle hover/clicks.
     */
    sendState(state: any): void {
        for (const [path, iframe] of this.overlays.entries()) {
            try {
                iframe.contentWindow?.postMessage({ type: 'gameState', state }, '*');
            } catch { /* iframe may be unloaded */ }

            const name = path.replace('ui/', '').replace('.html', '');

            // HUD components (hud/*.html) — each shown only by its own flag
            if (name.startsWith('hud/') || name === 'game_hud') {
                const specificFlag = name.replace(/[^a-zA-Z0-9_]/g, '') + 'Visible';
                const wasVisible = iframe.style.display !== 'none';
                const show = state[specificFlag] === true;
                iframe.style.display = show ? '' : 'none';
                // Only force pointer-events:none when hiding or just shown
                // (default). The mousemove handler flips it to auto while the
                // cursor is over an interactive child, so don't clobber that.
                if (!show) iframe.style.pointerEvents = 'none';
                else if (!wasVisible) iframe.style.pointerEvents = 'none';
                continue;
            }

            // Direct match: filename -> state flag.
            // Must use the SAME alphanumeric-stripping convention that
            // ui_bridge.ts uses when it sets the flag. Without this,
            // panels under a subfolder (e.g. `ui/panel/cooking_minigame.html`)
            // get flag "panelcooking_minigameVisible" written by the
            // bridge but read here as "panel/cooking_minigameVisible"
            // — slash mismatch — so the iframe stays display:none and
            // the panel never appears even though show_ui fired. The
            // HUD branch above already strips; this is the same fix
            // for the rest.
            const flag = name.replace(/[^a-zA-Z0-9_]/g, '') + 'Visible';
            if (flag in state) {
                const show = !!state[flag];
                iframe.style.display = show ? '' : 'none';
                if (this.focusedIframe !== iframe) {
                    iframe.style.pointerEvents = show ? 'auto' : 'none';
                }
            }
        }

        // Virtual cursor
        if (!this.container) {
            const found = document.querySelector('.viewport-canvas-container') as HTMLElement | null;
            if (found) this.container = found;
        }
        const container = this.container;
        // Match shouldShowMobileOverlay() in mobile_input_overlay.ts so
        // the virtual-cursor logic and overlay attach decisions agree —
        // touch capable AND primary pointer is coarse (finger). The
        // earlier `innerWidth < 1024` gate was captured once per frame
        // here but still produced flicker during CSS settling on iframe
        // load.
        const _hasTouch = ('ontouchstart' in window) || ((navigator as any)?.maxTouchPoints ?? 0) > 0;
        const _coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? true;
        const isMobileDevice = _hasTouch && _coarse;
        const wantCursor = !isMobileDevice && !!(state._cursor && state._cursor.visible && container);

        if (wantCursor) {
            this.cursorRelX = state._cursor.x;
            this.cursorRelY = state._cursor.y;

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
                container!.appendChild(el);
            }
            el.style.left = this.cursorRelX + 'px';
            el.style.top = this.cursorRelY + 'px';
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

        if (container && !isMobileDevice) {
            container.style.cursor = wantCursor ? 'default' : 'none';
        }

        // Handle virtual cursor clicks (skip on mobile — real taps work directly)
        if (!isMobileDevice && state._cursorClick && this.container) {
            this.virtualClick(state._cursorClick.x, state._cursorClick.y);
            delete state._cursorClick;
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
            // Skip only truly hidden iframes. HUDs default to
            // pointer-events:none (so real mouse click-throughs to the 3D
            // scene) — but the virtual cursor is a separate input path and
            // must still be able to hover/click their interactive children,
            // which have pointer-events:auto set by panel CSS.
            if (iframe.style.display === 'none') continue;
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
            // See getElementAtCursor for rationale — gate on visibility,
            // not pointer-events, so HUDs can receive virtual-cursor clicks.
            if (iframe.style.display === 'none') continue;
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

                // Focus input elements so keyboard input works — but
                // leave pointer lock + iframe.pointer-events alone. The
                // virtual cursor stays engaged, the real OS cursor stays
                // hidden, and keyboard events still route to the focused
                // input because focus is independent of pointer lock.
                // Previously we exited pointer lock and flipped the
                // iframe to pointer-events: auto, which made clicking the
                // lobby-name textbox feel like the game had just "let go
                // of" the cursor — the whole point of virtual cursor is
                // to stay in-game.
                const tag = target.tagName?.toUpperCase();
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
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
