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

    /** Cached panel HTML keyed by path. On mobile we defer iframe creation
     *  until the panel actually needs to be shown — the original eager
     *  loadUI was attaching all 15+ panel iframes at boot, blowing through
     *  the iOS WKWebView WebContent process memory ceiling once the game
     *  world started spawning on top of them. */
    private cachedContent: Map<string, string> = new Map();
    /** True when we're running inside iOS Safari / WKWebView. The mobile
     *  code path lazy-creates iframes on show + fully removes them on hide
     *  so peak iframe count tracks visible-panels rather than total-panels. */
    private readonly isMobile: boolean = (typeof navigator !== 'undefined') &&
        /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent);
    /** Mobile-only: ALL HUD panels share ONE iframe instead of one each.
     *  Every attempted per-HUD-iframe approach (lazy loadUI, rAF
     *  staggering, 250ms staggering, aggressive unload of lobby panels)
     *  still crashed the iOS WebContent process at in_game because the
     *  baseline cost of each iframe is ~10–15MB regardless of content
     *  and 6 of them concurrent with WebGPU world init exceeds the
     *  process memory ceiling.
     *
     *  Bundle approach: keep one iframe (`hudBundleIframe`) whose
     *  srcdoc loads a small dispatcher; each HUD panel gets injected
     *  into the bundle's <body> as a <section data-panel-path="…">
     *  via postMessage. Visibility is toggled by setting/clearing
     *  data-shown="1" on the section, which a CSS rule keys off of.
     *  Panel scripts that listen for window.addEventListener('message',
     *  …, gameState) still work because they share the bundle's window
     *  with every other HUD — postMessage targets one window, all
     *  listeners fire (this is fine: HUDs filter on flag names anyway). */
    private hudBundleIframe: HTMLIFrameElement | null = null;
    private hudBundleReady = false;
    private hudBundlePendingMessages: any[] = [];
    private hudBundleAttachedPaths: Set<string> = new Set();
    /** [lobby-debug] last-logged sendState signature per path so we only emit
     *  the per-frame mgr trace when the state actually changes — otherwise
     *  it floods at ~60Hz. Cleared on UNLOAD so the next ATTACH re-logs. */
    private debugLastState: Map<string, string> = new Map();

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
        // Always cache, regardless of platform. Mobile uses the cache to
        // lazy-attach on first show; desktop never reads it but the cost
        // is trivial (a string ref).
        this.cachedContent.set(path, htmlContent);
        this.unloadUI(path);
        if (this.isMobile) {
            // Defer iframe creation. sendState's lazy-attach will pick it
            // up when the panel needs to be visible.
            return;
        }
        this._attachIframe(path, htmlContent);
    }

    /** Mobile bundle: lazy-create the single iframe that hosts ALL HUDs.
     *  Returns it (creating on first call). Returns null only if there
     *  is no container yet — caller can retry on next sendState. */
    private _ensureHudBundle(): HTMLIFrameElement | null {
        if (this.hudBundleIframe) return this.hudBundleIframe;
        const container = this.container || document.querySelector('.viewport-canvas-container') as HTMLElement | null;
        if (!container) return null;

        const iframe = document.createElement('iframe');
        iframe.dataset.bundle = 'hud';
        iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;background:transparent;pointer-events:none;z-index:15;';

        // Wrapper script: a small dispatcher that listens for
        // __pp_addPanel and __pp_setVisible postMessages and applies
        // them to <section data-panel-path="…"> children. Inline
        // scripts inside injected HTML are reactivated via the
        // copy-then-replace trick (innerHTML doesn't execute scripts).
        // postMessage events of type 'gameState' are NOT relayed —
        // they reach every listener registered in this iframe's window
        // automatically because all panels share the same window.
        const srcdoc = `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:100%;height:100%;background:transparent;overflow:hidden;pointer-events:none;font-family:'Segoe UI',sans-serif;color:white;position:relative;}
button,input,select,a,[data-interactive]{cursor:pointer;}
section[data-panel-path]{position:absolute;inset:0;display:none;pointer-events:none;}
section[data-panel-path][data-shown="1"]{display:block;}
.virtual-hover{filter:brightness(1.3) !important;outline:1px solid rgba(255,255,255,0.3) !important;}
button.virtual-hover,a.virtual-hover,[data-interactive].virtual-hover{filter:brightness(1.4) !important;outline:1px solid rgba(255,255,255,0.5) !important;}
</style></head><body><script>
function __ppForwardErr(kind,msg,stack){try{window.parent.postMessage({type:'pp_iframe_error',kind:kind,message:String(msg||''),stack:String(stack||'')},'*');}catch(_){}}
window.addEventListener('error',function(e){__ppForwardErr('error',e.message||(e.error&&e.error.message)||'iframe error',(e.error&&e.error.stack)||'');});
window.addEventListener('unhandledrejection',function(e){var r=e.reason;__ppForwardErr('rejection',(r&&r.message)||String(r),(r&&r.stack)||'');});
function __ppAddPanel(path, html){
    if (document.querySelector('section[data-panel-path="'+path+'"]')) return;
    var s = document.createElement('section');
    s.setAttribute('data-panel-path', path);
    s.innerHTML = html;
    document.body.appendChild(s);
    var scripts = s.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
        var orig = scripts[i];
        var copy = document.createElement('script');
        for (var j = 0; j < orig.attributes.length; j++) copy.setAttribute(orig.attributes[j].name, orig.attributes[j].value);
        copy.text = orig.text;
        orig.parentNode.replaceChild(copy, orig);
    }
    s.querySelectorAll('button,input,select,a,[onclick],[data-interactive]').forEach(function(el){ el.style.pointerEvents='auto'; });
}
function __ppSetVisible(path, visible){
    var el = document.querySelector('section[data-panel-path="'+path+'"]');
    if (!el) return;
    if (visible) el.setAttribute('data-shown', '1');
    else el.removeAttribute('data-shown');
}
window.addEventListener('message', function(e){
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === '__pp_addPanel') __ppAddPanel(d.path, d.html);
    else if (d.type === '__pp_setVisible') __ppSetVisible(d.path, !!d.visible);
});
try { window.parent.postMessage({type:'__pp_bundleReady'}, '*'); } catch(_){}
</script></body></html>`;
        iframe.srcdoc = srcdoc;
        container.appendChild(iframe);
        this.hudBundleIframe = iframe;

        // Register the bundle in `overlays` immediately so the
        // ResizeObserver loop iterates it on rotation / window resize
        // and applyScale stays in sync. Sentinel key prevents collisions
        // with real panel paths.
        this.overlays.set('__hud_bundle__', iframe);

        // Make sure the resize observer is running and currentZoom is
        // computed for this container — the bundle inherits 1920-px
        // design width like the per-panel iframes do, and panels
        // authored at 1920×1080 render at full physical size inside a
        // ~400px-wide phone viewport without this scale-down.
        this._ensureResizeObserver(container);
        this.applyScale(iframe);

        // Drain queued messages once the bundle's dispatcher is up.
        const onMsg = (e: MessageEvent) => {
            if (e.source !== iframe.contentWindow) return;
            if (e.data?.type === '__pp_bundleReady') {
                this.hudBundleReady = true;
                window.removeEventListener('message', onMsg);
                for (const m of this.hudBundlePendingMessages) {
                    try { iframe.contentWindow?.postMessage(m, '*'); } catch {}
                }
                this.hudBundlePendingMessages = [];
            }
        };
        window.addEventListener('message', onMsg);
        return iframe;
    }

    private _bundlePost(message: any): void {
        if (!this.hudBundleIframe) return;
        if (!this.hudBundleReady) {
            this.hudBundlePendingMessages.push(message);
            return;
        }
        try { this.hudBundleIframe.contentWindow?.postMessage(message, '*'); } catch {}
    }

    /** Mobile-only HUD attach via the bundle. Idempotent. */
    private _attachHudToBundle(path: string, html: string): void {
        const iframe = this._ensureHudBundle();
        if (!iframe) return;  // No container yet — sendState will retry on the next push.
        if (this.hudBundleAttachedPaths.has(path)) return;
        this.hudBundleAttachedPaths.add(path);
        this._bundlePost({ type: '__pp_addPanel', path, html });
    }

    /** Lazy-install the container's ResizeObserver so panels auto-scale
     *  when the window rotates or resizes. Both _attachIframe and
     *  _ensureHudBundle call this; idempotent. */
    private _ensureResizeObserver(container: HTMLElement): void {
        if (this.resizeObserver) return;
        const updateZoom = () => {
            const w = container.clientWidth || 1920;
            this.currentZoom = Math.min(w / 1920, 1);
            for (const f of this.overlays.values()) this.applyScale(f);
        };
        updateZoom();
        this.resizeObserver = new ResizeObserver(updateZoom);
        this.resizeObserver.observe(container);
    }

    /** Hide a HUD panel from the bundle without removing it. Cheap; no
     *  DOM teardown needed because the bundle owns one iframe for all
     *  HUDs and we're just toggling display via CSS. */
    private _setHudVisibility(path: string, visible: boolean): void {
        if (!this.hudBundleAttachedPaths.has(path)) return;
        this._bundlePost({ type: '__pp_setVisible', path, visible });
    }

    /** Mobile-only synchronous attach for non-HUD modal panels. HUDs go
     *  through the shared bundle (see _attachHudToBundle); this is for
     *  lobby_browser, lobby_room, etc. — modal-style panels that only
     *  show one at a time. Desktop uses the eager loadUI path instead. */
    private _attachModal(path: string, htmlContent: string, isHud: boolean): void {
        this._attachIframe(path, htmlContent);
        const created = this.overlays.get(path);
        if (created) {
            created.style.display = '';
            created.style.pointerEvents = isHud ? 'none' : 'auto';
        }
    }

    /** Synchronous iframe attach (desktop or mobile-modal-panel). HUDs on
     *  mobile go through the bundle path instead — see _attachHudToBundle. */
    private _attachIframe(path: string, htmlContent: string): void {
        const container = this.container || document.querySelector('.viewport-canvas-container') as HTMLElement | null;
        if (!container) return;

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:none;background:transparent;pointer-events:none;z-index:15;display:none;';

        // Wrapper script. On mobile we omit the persistent
        // MutationObserver — its closure stays alive for the iframe's
        // lifetime, observes every DOM change, and re-runs
        // querySelectorAll on every mutation. HUDs (the bulk of mobile
        // panels) don't add new interactive elements after init, so a
        // single querySelectorAll at load is enough. Saves ~1MB of
        // resident JS engine state per iframe times ~6 HUDs in-game.
        const interactiveAutoSelector = `document.querySelectorAll('button,input,select,a,[onclick],[data-interactive]').forEach(el=>el.style.pointerEvents='auto');`;
        const mobileWrapperScript = `${interactiveAutoSelector}__ppCheckpoint('iframe loaded: ${path}');`;
        const desktopWrapperScript = `${interactiveAutoSelector}new MutationObserver(()=>{${interactiveAutoSelector}}).observe(document.body,{childList:true,subtree:true});__ppCheckpoint('iframe loaded: ${path}');`;
        const wrapperScript = this.isMobile ? mobileWrapperScript : desktopWrapperScript;
        // [lobby-debug] body-level touch + message tracking, only enabled for
        // the lobby_browser panel so we don't spam every iframe's console.
        // Logs every touchstart/touchend/click target inside the iframe so we
        // can see whether the second-tap-after-row-select is reaching the
        // panel at all on mobile, and what target it lands on.
        const debugLobbyScript = path.includes('lobby_browser')
          ? `(function(){
              // Console-patch FIRST so plog's console.log forwards to parent.
              // Scoped here (not the global wrapper) so HUDs etc. don't all
              // postMessage every console call. Each call is also tagged with
              // panel='${path}' so the parent listener can dedupe to a single
              // log line.
              try{var levels=['log','info','warn','error','debug'];for(var i=0;i<levels.length;i++){(function(lvl){var orig=console[lvl]||console.log;console[lvl]=function(){var parts=[];for(var j=0;j<arguments.length;j++){var a=arguments[j];if(typeof a==='string')parts.push(a);else{try{parts.push(JSON.stringify(a));}catch(_){parts.push(String(a));}}}try{window.parent.postMessage({type:'pp_iframe_console',level:lvl,panel:'${path}',message:parts.join(' ')},'*');}catch(_){}try{orig.apply(console,arguments);}catch(_){}};})(levels[i]);}}catch(_){}
              function plog(m){try{console.log('[lobby-debug] iframe ${path} '+m);}catch(_){}}
              function tdesc(t){if(!t)return 'null';var c=(t.className&&t.className.baseVal!==undefined)?t.className.baseVal:(t.className||'');return (t.tagName||'?')+(t.id?'#'+t.id:'')+(c?'.'+String(c).split(' ').join('.'):'');}
              ['touchstart','touchend','click'].forEach(function(ev){document.addEventListener(ev,function(e){plog(ev+' target='+tdesc(e.target));},true);});
              window.addEventListener('message',function(e){if(!e.data||e.data.type!=='gameState')return;var s=e.data.state||{};plog('msg gameState lobbies='+(s.lobbies?s.lobbies.length:'none')+' visible='+s.lobby_browserVisible+' phase='+(s.multiplayer&&s.multiplayer.phase));});
              plog('debug installed');
            })();`
          : '';

        const wrapped = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:100%;height:100%;background:transparent;overflow:hidden;pointer-events:none;font-family:'Segoe UI',sans-serif;color:white;}
button,input,select,a,[data-interactive]{cursor:pointer;}
.virtual-hover{filter:brightness(1.3) !important;outline:1px solid rgba(255,255,255,0.3) !important;}
button.virtual-hover,a.virtual-hover,[data-interactive].virtual-hover{filter:brightness(1.4) !important;outline:1px solid rgba(255,255,255,0.5) !important;}
</style></head><body>${htmlContent}
<script>
// Forward iframe-internal errors to the parent. iOS Safari reloads on
// repeated unhandled errors (no inspector available), and panel scripts
// (lobby_browser, etc.) live in a separate document scope so the parent
// window.onerror doesn't see them. postMessage lets the parent's
// error_tracker enqueue + show its on-screen banner.
function __ppForwardErr(kind,msg,stack){try{window.parent.postMessage({type:'pp_iframe_error',kind:kind,message:String(msg||''),stack:String(stack||'')},'*');}catch(_){/* swallow */}}
function __ppCheckpoint(name){try{if(window.parent&&window.parent.ppCheckpoint)window.parent.ppCheckpoint(name);}catch(_){/* swallow */}}
window.addEventListener('error',function(e){__ppForwardErr('error',e.message||(e.error&&e.error.message)||'iframe error',(e.error&&e.error.stack)||'');});
window.addEventListener('unhandledrejection',function(e){var r=e.reason;__ppForwardErr('rejection',(r&&r.message)||String(r),(r&&r.stack)||'');});
${wrapperScript}
${debugLobbyScript}
</script></body></html>`;

        iframe.srcdoc = wrapped;
        container.appendChild(iframe);
        this.overlays.set(path, iframe);
        this.applyScale(iframe);

        // Scale UI based on viewport size (designed for 1920px width).
        // Uses transform:scale + enlarged dimensions so the iframe fills
        // the container while its content is scaled down. CSS zoom would
        // shrink the iframe's layout box, leaving dead space.
        this._ensureResizeObserver(container);

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
                const win = iframe.contentWindow;
                const rect = iframe.getBoundingClientRect();
                const xv = clientX - rect.left;
                const yv = clientY - rect.top;
                if (xv < 0 || yv < 0 || xv > rect.width || yv > rect.height) return null;
                // applyScale puts a transform: scale() on the iframe so
                // visual rect.width != content layout width. Convert
                // visual click coords → layout coords for elementFromPoint.
                const layoutW = win?.innerWidth || rect.width;
                const layoutH = win?.innerHeight || rect.height;
                const sx = rect.width / layoutW || 1;
                const sy = rect.height / layoutH || 1;
                const x = xv / sx;
                const y = yv / sy;
                const el = doc.elementFromPoint(x, y);
                if (!el || el === doc.documentElement || el === doc.body) return null;
                const interactive = el.closest(INTERACTIVE_SELECTOR) as HTMLElement;
                if (interactive) return interactive;
                // Fallback: walk ancestors looking for the nearest one with
                // `cursor: pointer`. Picks up the common HUD pattern of
                // <div class="card" style="cursor:pointer"> with a click
                // handler attached via addEventListener — these have no
                // [data-interactive] marker but ARE clickable. Without
                // this, those HUDs were broken on BOTH desktop (iframe
                // pointer-events stays at none → click hits canvas) and
                // mobile (synth-click selector missed them too).
                let cur: Element | null = el;
                while (cur && cur !== doc.body && cur !== doc.documentElement) {
                    const cs = win?.getComputedStyle(cur);
                    if (cs && cs.cursor === 'pointer') return cur as HTMLElement;
                    cur = cur.parentElement;
                }
                const pe = win?.getComputedStyle(el)?.pointerEvents;
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
        // Confirm the parent-side message listener is wired — without this it's
        // ambiguous whether iframe logs are missing because they never fired or
        // because the listener never ran.
        try { console.log('[lobby-debug] mgr listener wired for ' + panelName); } catch {}
        const onMessage = (e: MessageEvent) => {
            if (e.source === iframe.contentWindow && e.data?.type === 'game_command') {
                this.onUICommand?.({ ...e.data, panel: panelName });
            }
            // Re-emit iframe console.logs into the parent's console so the
            // ios_bridge console-patch (top document only) picks them up and
            // forwards them to native via postNative — otherwise iframe logs
            // never reach Xcode / [WebView log] capture. Dedupe across the
            // N iframe onMessage listeners by only re-logging when the
            // message's `panel` field matches THIS listener's path. The
            // strict `e.source === iframe.contentWindow` check used to do
            // that, but on iOS WKWebView source pointers can drift across
            // srcdoc, so we filter by panel field instead.
            if (e.data?.type === 'pp_iframe_console' && e.data?.panel === path) {
                const lvl = (e.data.level === 'warn' || e.data.level === 'error' || e.data.level === 'info' || e.data.level === 'debug') ? e.data.level : 'log';
                try { (console as any)[lvl]('[iframe ' + panelName + '] ' + e.data.message); } catch {}
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

    /** Compute the sendState visibility flag for a panel path. Mirrors
     *  the alphanumeric-stripping convention ui_bridge.ts uses when
     *  emitting `<name>Visible` flags. Returns the flag name and whether
     *  the panel is HUD-style (HUD panels are always managed via their
     *  specific flag; non-HUDs only react when the flag is present in
     *  the state object — see existing branches in the desktop path).
     */
    private flagFor(path: string): { name: string; flag: string; isHud: boolean } {
        const name = path.replace('ui/', '').replace('.html', '');
        const isHud = name.startsWith('hud/') || name === 'game_hud';
        const flag = name.replace(/[^a-zA-Z0-9_]/g, '') + 'Visible';
        return { name, flag, isHud };
    }

    /**
     * Send full state update: dispatch to iframes, toggle panel visibility,
     * render virtual cursor, handle hover/clicks.
     */
    sendState(state: any): void {
        // Mobile path: lazy-attach iframes that should be visible, fully
        // unload iframes that should be hidden. Keeps peak iframe count
        // pinned to "currently visible" rather than "all panels in the
        // game", which is what kills the iOS WebContent process when
        // CTF/multiplayer drops 16 panels into the page at boot.
        if (this.isMobile) {
            // Mobile path: HUDs share ONE bundle iframe (memory savings);
            // non-HUD modal panels still get one-iframe-each but get
            // aggressively unloaded when their flag is missing or false.
            for (const [path, html] of this.cachedContent.entries()) {
                const { flag, isHud } = this.flagFor(path);
                const shouldShow = state[flag] === true;

                if (isHud) {
                    // Bundle: attach once, toggle visibility forever.
                    if (shouldShow && !this.hudBundleAttachedPaths.has(path)) {
                        this._attachHudToBundle(path, html);
                    }
                    if (this.hudBundleAttachedPaths.has(path)) {
                        this._setHudVisibility(path, shouldShow);
                    }
                    continue;
                }

                // Non-HUD: aggressive unload of any panel whose flag
                // isn't an explicit `true` in this push. mp_bridge omits
                // lobby panels' flags after the user enters in_game, so
                // absence == hide.
                const existing = this.overlays.get(path);
                // [lobby-debug] trace the lobby_browser show/hide decision —
                // log only when the (shouldShow, existing, lobbies) signature
                // changes. Per-frame logging at ~60Hz floods the console.
                if (path.includes('lobby_browser')) {
                    const sig = String(shouldShow) + '|' + String(!!existing) + '|' + (state.lobbies ? state.lobbies.length : 'none');
                    if (this.debugLastState.get(path) !== sig) {
                        this.debugLastState.set(path, sig);
                        try { console.log('[lobby-debug] mgr sendState(mobile) path=' + path + ' shouldShow=' + shouldShow + ' existing=' + !!existing + ' lobbies=' + (state.lobbies ? state.lobbies.length : 'none')); } catch {}
                    }
                }
                if (shouldShow && !existing) {
                    if (path.includes('lobby_browser')) { try { console.log('[lobby-debug] mgr ATTACH ' + path); } catch {} }
                    this._attachModal(path, html, false);
                } else if (!shouldShow && existing) {
                    if (path.includes('lobby_browser')) { try { console.log('[lobby-debug] mgr UNLOAD ' + path); } catch {} this.debugLastState.delete(path); }
                    if (this.focusedIframe === existing) this.focusedIframe = null;
                    this.unloadUI(path);
                } else if (existing) {
                    try { existing.contentWindow?.postMessage({ type: 'gameState', state }, '*'); } catch {}
                }
            }

            // Forward gameState into the HUD bundle so panel scripts
            // listening for window.message events get their updates.
            if (this.hudBundleIframe) {
                try { this.hudBundleIframe.contentWindow?.postMessage({ type: 'gameState', state }, '*'); } catch {}
            }
        } else {
        for (const [path, iframe] of this.overlays.entries()) {
            try {
                iframe.contentWindow?.postMessage({ type: 'gameState', state }, '*');
            } catch { /* iframe may be unloaded */ }

            const { flag, isHud } = this.flagFor(path);

            // HUD components (hud/*.html) — each shown only by its own flag
            if (isHud) {
                const wasVisible = iframe.style.display !== 'none';
                const show = state[flag] === true;
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
            // ui_bridge.ts uses when it sets the flag.
            if (flag in state) {
                const show = !!state[flag];
                iframe.style.display = show ? '' : 'none';
                if (this.focusedIframe !== iframe) {
                    iframe.style.pointerEvents = show ? 'auto' : 'none';
                }
                // [lobby-debug] trace lobby_browser flag-driven show/hide on
                // desktop — same dedupe pattern as mobile.
                if (path.includes('lobby_browser')) {
                    const sig = 'd|' + String(show) + '|' + iframe.style.pointerEvents + '|' + String(this.focusedIframe === iframe);
                    if (this.debugLastState.get(path) !== sig) {
                        this.debugLastState.set(path, sig);
                        try { console.log('[lobby-debug] mgr sendState(desktop) path=' + path + ' show=' + show + ' iframePE=' + iframe.style.pointerEvents + ' focused=' + (this.focusedIframe === iframe)); } catch {}
                    }
                }
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

        // Handle virtual cursor clicks. Was previously gated by
        // !isMobileDevice on the assumption that real taps reach HUD
        // elements directly — they don't: HUD iframes are pointer-
        // events:none so taps fall through to canvas. On real mobile the
        // synth path is mobile_input_overlay (preventDefault on
        // touchstart blocks the canvas mousedown so _cursorClick never
        // sets). On Chrome DevTools mobile emulation that suppression
        // doesn't always happen, leaving the HUD unclickable. virtualClick
        // is the safety net: if _cursorClick made it here at all, try to
        // land it on a HUD element.
        if (state._cursorClick && this.container) {
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
        // Drop the lazy-mode HTML cache too so a re-init starts cleanly.
        this.cachedContent.clear();
        // Tear down the mobile HUD bundle iframe.
        if (this.hudBundleIframe) {
            try { this.hudBundleIframe.remove(); } catch {}
            this.hudBundleIframe = null;
        }
        this.hudBundleReady = false;
        this.hudBundleAttachedPaths.clear();
        this.hudBundlePendingMessages = [];
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

                let target = el.closest(INTERACTIVE_SELECTOR) as HTMLElement | null;
                if (!target) {
                    // Cursor:pointer ancestor fallback (matches getInteractiveAt).
                    const win = iframe.contentWindow;
                    let cur: Element | null = el;
                    while (cur && cur !== doc.body && cur !== doc.documentElement) {
                        const cs = win?.getComputedStyle(cur);
                        if (cs && cs.cursor === 'pointer') { target = cur as HTMLElement; break; }
                        cur = cur.parentElement;
                    }
                }
                if (!target) target = el as HTMLElement;

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
