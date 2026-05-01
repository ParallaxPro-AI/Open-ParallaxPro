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
    /** Capability-based mobile detection — touch-capable AND primary
     *  pointer is coarse. UA-regex alone missed iPadOS 13+ Desktop
     *  Site mode (UA reports as Mac, no "iPad" substring). */
    private readonly isMobile: boolean = (typeof navigator !== 'undefined') && (
        (('ontouchstart' in window) || ((navigator as any)?.maxTouchPoints ?? 0) > 0)
        && (typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)')?.matches ?? false))
    );
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
    /** Hash of the last `state.lobbies` value posted into iframes. lobby_browser
     *  re-renders on every gameState push that contains state.lobbies (rebuilds
     *  the row list via listEl.innerHTML=''). At 60Hz that DOM churn makes
     *  iOS WKWebView suppress the click synthesised after a button touchend —
     *  touchstart + touchend would fire on BUTTON#btn-host with no following
     *  click event. Stripping state.lobbies from the postMessage payload when
     *  it hasn't changed lets the iframe stay stable between actual lobby-list
     *  updates so iOS dispatches clicks normally. */
    private lastLobbiesHash: string | null = null;
    /** Panels that opted into the cross-platform layout via
     *  `<meta name="pp-responsive">` in their HTML. These panels:
     *    - skip the 1920px design-width down-scale (they author for the
     *      real device viewport using rem/clamp/% directly).
     *    - get the responsive base CSS injected by the wrapper, which
     *      defines `--pp-bottom-clear` (joystick reserve), font-size
     *      clamp, and safe-area padding. The base rules fire only
     *      under `@media (pointer: coarse)`, so desktop renders the
     *      same HTML at full size with no platform branching. */
    private responsivePaths: Set<string> = new Set();
    private static readonly RESPONSIVE_META_RE = /<meta\s+[^>]*name\s*=\s*["']pp-responsive["']/i;

    onUICommand: ((data: any) => void) | null = null;
    /** Fires whenever sendState detects that a top-level modal panel
     *  (lobby_browser, lobby_room, main_menu, pause_menu, game_over,
     *  host_config, etc — anything whose path doesn't start with `hud/`)
     *  has become visible or hidden. Used to suspend the mobile joystick
     *  + action rail during full-screen UI screens. Cursor-visibility
     *  was the prior signal but it's wrong for click-to-play games with
     *  camera pan (4X strategy, RTS, MOBA, tower defense): the cursor is
     *  visible during gameplay there because clicks ARE the gameplay,
     *  and the joystick is also needed for WASD-style camera pan. The
     *  modal-visible signal correctly distinguishes "in a UI screen"
     *  from "playing the game with a HUD overlay". */
    onModalPanelVisible: ((visible: boolean) => void) | null = null;
    /** Latest modal-panel-visible value seen by sendState. Public so the
     *  editor's 1s suspension re-asserter can read the current desired
     *  joystick-suspension state without wiring through the callback
     *  path. Stays null until the first sendState sets it. */
    lastModalVisible: boolean | null = null;

    private applyScale(f: HTMLIFrameElement): void {
        // Mobile-only branch for responsive panels: apply a mild 0.82x
        // scale so a 390px phone gets ~476px of effective design width.
        // Full 1x rendered "zoomed in" on a phone; the desktop scale
        // (0.21x on a phone) was unreadably small. 0.82 is the sweet
        // spot. Desktop responsive panels fall through to the same
        // scale logic legacy panels use — desktop UI must remain
        // pixel-identical to its pre-responsive-overhaul rendering.
        const isResponsive = f.dataset.ppResponsive === '1';
        const isCoarse = typeof window !== 'undefined'
            && window.matchMedia?.('(pointer: coarse)')?.matches === true;
        if (isResponsive && isCoarse) {
            const s = 0.82;
            f.style.transform = `scale(${s})`;
            f.style.transformOrigin = 'top left';
            f.style.width = `${100 / s}%`;
            f.style.height = `${100 / s}%`;
            return;
        }
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
        if (HTMLUIManager.RESPONSIVE_META_RE.test(htmlContent)) {
            this.responsivePaths.add(path);
        } else {
            this.responsivePaths.delete(path);
        }
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
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:100%;height:100%;background:transparent;overflow:hidden;pointer-events:none;font-family:'Segoe UI',sans-serif;color:white;position:relative;}
button,input,select,a,[data-interactive]{cursor:pointer;}
section[data-panel-path]{position:absolute;inset:0;display:none;pointer-events:none;}
section[data-panel-path][data-shown="1"]{display:block;}
.virtual-hover{filter:brightness(1.3) !important;outline:1px solid rgba(255,255,255,0.3) !important;}
button.virtual-hover,a.virtual-hover,[data-interactive].virtual-hover{filter:brightness(1.4) !important;outline:1px solid rgba(255,255,255,0.5) !important;}
/* Responsive base, scoped per-section so a single bundle can mix
   responsive HUDs with legacy non-responsive ones safely. The
   non-responsive sections inherit nothing from these vars/media
   rules. Desktop sees --pp-bottom-clear=0; mobile sees ~160px
   reserved for the joystick + button-rail footprint. */
section[data-pp-responsive]{--pp-bottom-clear:0px;--pp-top-clear:0px;}
/* desktop-only / mobile-only visibility helpers. Universal — apply
   regardless of responsive opt-in so legacy panels can use them too. */
@media (pointer: coarse){
[data-pp-desktop-only],.pp-desktop-only{display:none!important;}
}
@media not (pointer: coarse){
[data-pp-mobile-only],.pp-mobile-only{display:none!important;}
}
@media (pointer: coarse){
section[data-pp-responsive]{--pp-bottom-clear:var(--pp-joystick-h, 0px);--pp-top-clear:max(56px,env(safe-area-inset-top));padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);padding-top:env(safe-area-inset-top);}
section[data-pp-responsive] button,section[data-pp-responsive] [role="button"],section[data-pp-responsive] [data-interactive]{min-height:44px;min-width:44px;}
/* Two-tier corner-lift: bottom-LEFT clears the joystick (~140px); the
   bottom-RIGHT action rail stacks 4+ buttons in two columns (~280px)
   and needs more lift. Anchored neither-side defaults to joystick-side. */
section[data-pp-responsive] [style*="position:fixed"][style*="bottom"][style*="left"]:not([style*="bottom:0"]):not([data-pp-no-lift]),
section[data-pp-responsive] [style*="position: fixed"][style*="bottom"][style*="left"]:not([style*="bottom: 0"]):not([data-pp-no-lift]),
section[data-pp-responsive] [style*="position:absolute"][style*="bottom"][style*="left"]:not([style*="bottom:0"]):not([data-pp-no-lift]),
section[data-pp-responsive] [style*="position: absolute"][style*="bottom"][style*="left"]:not([style*="bottom: 0"]):not([data-pp-no-lift]){
bottom:max(var(--pp-joystick-h, 0px),calc(env(safe-area-inset-bottom) + var(--pp-joystick-h, 0px)))!important;
}
section[data-pp-responsive] [style*="position:fixed"][style*="bottom"][style*="right"]:not([style*="bottom:0"]):not([data-pp-no-lift]),
section[data-pp-responsive] [style*="position: fixed"][style*="bottom"][style*="right"]:not([style*="bottom: 0"]):not([data-pp-no-lift]),
section[data-pp-responsive] [style*="position:absolute"][style*="bottom"][style*="right"]:not([style*="bottom:0"]):not([data-pp-no-lift]),
section[data-pp-responsive] [style*="position: absolute"][style*="bottom"][style*="right"]:not([style*="bottom: 0"]):not([data-pp-no-lift]){
bottom:max(var(--pp-rail-h, 0px),calc(env(safe-area-inset-bottom) + var(--pp-rail-h, 0px)))!important;
}
section[data-pp-responsive] [style*="position:fixed"][style*="bottom"]:not([style*="bottom:0"]):not([style*="left"]):not([style*="right"]):not([data-pp-no-lift]),
section[data-pp-responsive] [style*="position: fixed"][style*="bottom"]:not([style*="bottom: 0"]):not([style*="left"]):not([style*="right"]):not([data-pp-no-lift]),
section[data-pp-responsive] [style*="position:absolute"][style*="bottom"]:not([style*="bottom:0"]):not([style*="left"]):not([style*="right"]):not([data-pp-no-lift]),
section[data-pp-responsive] [style*="position: absolute"][style*="bottom"]:not([style*="bottom: 0"]):not([style*="left"]):not([style*="right"]):not([data-pp-no-lift]){
bottom:max(var(--pp-joystick-h, 0px),calc(env(safe-area-inset-bottom) + var(--pp-joystick-h, 0px)))!important;
}
/* Universal width cap to prevent horizontal overflow of fixed-width
   panels designed at 1920px on small viewports. */
section[data-pp-responsive] [style*="position:fixed"][style*="right"]:not([data-pp-no-cap]),
section[data-pp-responsive] [style*="position: fixed"][style*="right"]:not([data-pp-no-cap]),
section[data-pp-responsive] [style*="position:absolute"][style*="right"]:not([data-pp-no-cap]),
section[data-pp-responsive] [style*="position: absolute"][style*="right"]:not([data-pp-no-cap]),
section[data-pp-responsive] [style*="position:fixed"][style*="left"]:not([data-pp-no-cap]),
section[data-pp-responsive] [style*="position: fixed"][style*="left"]:not([data-pp-no-cap]),
section[data-pp-responsive] [style*="position:absolute"][style*="left"]:not([data-pp-no-cap]),
section[data-pp-responsive] [style*="position: absolute"][style*="left"]:not([data-pp-no-cap]){
max-width:calc(100vw - 16px)!important;
}
}
</style></head><body><script>
function __ppForwardErr(kind,msg,stack){try{window.parent.postMessage({type:'pp_iframe_error',kind:kind,message:String(msg||''),stack:String(stack||'')},'*');}catch(_){}}
window.addEventListener('error',function(e){__ppForwardErr('error',e.message||(e.error&&e.error.message)||'iframe error',(e.error&&e.error.stack)||'');});
window.addEventListener('unhandledrejection',function(e){var r=e.reason;__ppForwardErr('rejection',(r&&r.message)||String(r),(r&&r.stack)||'');});
// Mirror parent's --pp-rail-h / --pp-joystick-h into this bundle iframe's
// :root every 500ms so the corner-lift CSS uses the live measured rail
// height instead of a hardcoded number. Divide by the iframe's mobile
// scale (0.82, must match MOBILE_RESPONSIVE_SCALE in applyScale) so
// N visible-pixels published by the parent map to N/0.82 logical-pixels
// inside the iframe. srcdoc inherits parent origin.
(function(){var SCALE=0.82;function pull(){try{var cs=window.parent.document.documentElement.style;var rh=cs.getPropertyValue('--pp-rail-h');var jh=cs.getPropertyValue('--pp-joystick-h');if(rh){var rp=parseFloat(rh);if(rp>0)document.documentElement.style.setProperty('--pp-rail-h',Math.ceil(rp/SCALE)+'px');}if(jh){var jp=parseFloat(jh);if(jp>0)document.documentElement.style.setProperty('--pp-joystick-h',Math.ceil(jp/SCALE)+'px');}}catch(_){}}pull();setInterval(pull,500);})();
// Rewrite a HUD's CSS so every rule is scoped to its <section>. The
// mobile bundle puts all HUDs in ONE iframe to dodge iOS WKWebView's
// per-iframe memory cost — but that means every HUD's CSS lives in
// the same document scope. Generic class names (.panel, .row, .bar,
// .title, .label, .item) collide: e.g. ship_status declares
// ".panel { position:fixed; bottom:16px; left:50%; ...pirate gradient }"
// which clobbers voice_chat's tiny corner ".panel { top:195px; left:12px }".
// Voice chat ended up rendering as a giant centered pirate box inside
// buccaneer_bay games. Walk the CSS, prepend the section selector to
// each top-level rule, remap body/html/:root to the section itself,
// descend into @media / @supports / @container / @layer to scope
// nested rules, leave @keyframes / @font-face / @page alone (those
// are name-scoped, not selector-scoped — renaming would break panel
// scripts referencing them).
function __ppScopeCSS(css, scope){
    var result = '';
    var i = 0;
    var len = css.length;
    function consumeBody(){
        var depth = 1;
        var body = '';
        i++;
        while (i < len && depth > 0){
            var c = css[i];
            if (c === '{') depth++;
            else if (c === '}') depth--;
            if (depth > 0) body += c;
            i++;
        }
        return body;
    }
    while (i < len){
        while (i < len && /\\s/.test(css[i])){ result += css[i]; i++; }
        if (i >= len) break;
        // Strip CSS comments — they can contain {} and break our brace tracking.
        if (css[i] === '/' && css[i+1] === '*'){
            var endC = css.indexOf('*/', i+2);
            if (endC < 0) break;
            result += css.slice(i, endC+2);
            i = endC + 2;
            continue;
        }
        var startSel = i;
        while (i < len && css[i] !== '{' && css[i] !== ';'){
            // Track strings so braces inside content:"…" don't fool us.
            if (css[i] === '"' || css[i] === "'"){
                var q = css[i++];
                while (i < len && css[i] !== q){
                    if (css[i] === '\\\\') i++;
                    i++;
                }
            }
            i++;
        }
        var sel = css.slice(startSel, i).trim();
        if (i < len && css[i] === ';'){ result += sel + ';'; i++; continue; }
        if (i >= len){ result += sel; break; }
        if (sel.charAt(0) === '@'){
            var kwm = sel.match(/^@([a-zA-Z-]+)/);
            var kw = kwm ? kwm[1].toLowerCase() : '';
            var body = consumeBody();
            if (kw === 'media' || kw === 'supports' || kw === 'container' || kw === 'layer' || kw === 'scope'){
                result += sel + '{' + __ppScopeCSS(body, scope) + '}';
            } else {
                // @keyframes / @font-face / @page / @counter-style / @property / @import — global by name; emit as-is.
                result += sel + '{' + body + '}';
            }
        } else {
            var scoped = sel.split(',').map(function(s){
                s = s.trim();
                if (!s) return '';
                if (s === 'body' || s === 'html' || s === ':root') return scope;
                if (/^(body|html|:root)\\b/.test(s)){
                    var rest = s.replace(/^(body|html|:root)/, '');
                    if (rest.charAt(0) === '.' || rest.charAt(0) === '#' || rest.charAt(0) === '['){
                        return scope + rest;
                    }
                    return scope + ' ' + rest.trim();
                }
                return scope + ' ' + s;
            }).filter(Boolean).join(', ');
            var body2 = consumeBody();
            result += scoped + '{' + body2 + '}';
        }
    }
    return result;
}
function __ppAddPanel(path, html, responsive){
    if (document.querySelector('section[data-panel-path="'+path+'"]')) return;
    var s = document.createElement('section');
    s.setAttribute('data-panel-path', path);
    if (responsive) s.setAttribute('data-pp-responsive', '1');
    // Scope every <style> block in this panel to its section so
    // generic class names (.panel, .row, .bar) don't bleed across HUDs.
    var scope = 'section[data-panel-path="' + path + '"]';
    html = html.replace(/<style([^>]*)>([\\s\\S]*?)<\\/style>/gi, function(m, attrs, css){
        try { return '<style' + attrs + '>' + __ppScopeCSS(css, scope) + '</style>'; }
        catch(_) { return m; }
    });
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
    if (d.type === '__pp_addPanel') __ppAddPanel(d.path, d.html, !!d.responsive);
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

        // game_command relay for the bundle. Per-panel iframes (desktop +
        // modal mobile) register this in _attachIframe; the bundle was
        // missing it, so HUDs inside the bundle (sidebar's `emit(
        // 'open_orders')`, etc.) posted game_command messages that landed
        // on this window with no listener — every clickable HUD button
        // on mobile was silently dropped. Sidebar already sets
        // `panel: 'hud/<name>'` in the payload so we don't need a path
        // lookup; just forward to onUICommand.
        const onBundleCommand = (e: MessageEvent) => {
            if (e.source !== iframe.contentWindow) return;
            if (e.data?.type !== 'game_command') return;
            this.onUICommand?.({ ...e.data });
        };
        window.addEventListener('message', onBundleCommand);
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
        const responsive = this.responsivePaths.has(path);
        this._bundlePost({ type: '__pp_addPanel', path, html, responsive });
        // Bundle iframe is responsive iff every panel in it is. Only
        // then can we safely skip the 1920px design-width down-scale —
        // a mixed bundle has at least one panel that needs the scale,
        // so the bundle keeps it.
        const allResponsive = [...this.hudBundleAttachedPaths].every(p => this.responsivePaths.has(p));
        if (allResponsive) iframe.dataset.ppResponsive = '1';
        else delete iframe.dataset.ppResponsive;
        this.applyScale(iframe);
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
        const isResponsive = this.responsivePaths.has(path);
        if (isResponsive) iframe.dataset.ppResponsive = '1';

        // Wrapper script. On mobile we omit the persistent
        // MutationObserver — its closure stays alive for the iframe's
        // lifetime, observes every DOM change, and re-runs
        // querySelectorAll on every mutation. HUDs (the bulk of mobile
        // panels) don't add new interactive elements after init, so a
        // single querySelectorAll at load is enough. Saves ~1MB of
        // resident JS engine state per iframe times ~6 HUDs in-game.
        const interactiveAutoSelector = `document.querySelectorAll('button,input,select,a,[onclick],[data-interactive]').forEach(el=>el.style.pointerEvents='auto');`;
        // Bridge parent's --pp-rail-h / --pp-joystick-h CSS vars (set by
        // mobile_input_overlay's runtime measurement of the actual rail
        // and joystick heights) into this iframe's :root so the corner-
        // lift rules below can use them. srcdoc inherits parent origin,
        // so window.parent.document is reachable. rAF loop handles
        // resize / orientation changes / dynamic action additions.
        // The iframe is scaled by 0.82 on mobile (matches MOBILE_RESPONSIVE_SCALE
        // in applyScale), so a parent-published value of N visible-pixels
        // corresponds to N/0.82 logical-pixels inside the iframe. Divide
        // before setting so HUDs lift to the right *visible* position.
        // Desktop iframes don't fire the lift rule (gated on @media coarse)
        // so the divide-by-mobile-scale is a no-op there.
        const ppMirrorVars = `(function(){var SCALE=0.82;function pull(){try{var cs=window.parent.document.documentElement.style;var rh=cs.getPropertyValue('--pp-rail-h');var jh=cs.getPropertyValue('--pp-joystick-h');if(rh){var rp=parseFloat(rh);if(rp>0)document.documentElement.style.setProperty('--pp-rail-h',Math.ceil(rp/SCALE)+'px');}if(jh){var jp=parseFloat(jh);if(jp>0)document.documentElement.style.setProperty('--pp-joystick-h',Math.ceil(jp/SCALE)+'px');}}catch(_){}}pull();setInterval(pull,500);})();`;
        const mobileWrapperScript = `${interactiveAutoSelector}${ppMirrorVars}__ppCheckpoint('iframe loaded: ${path}');`;
        const desktopWrapperScript = `${interactiveAutoSelector}${ppMirrorVars}new MutationObserver(()=>{${interactiveAutoSelector}}).observe(document.body,{childList:true,subtree:true});__ppCheckpoint('iframe loaded: ${path}');`;
        const wrapperScript = this.isMobile ? mobileWrapperScript : desktopWrapperScript;

        const htmlAttrs = isResponsive ? ' data-pp-responsive="1"' : '';
        const wrapped = `<!DOCTYPE html><html${htmlAttrs}><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,viewport-fit=cover"><style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:100%;height:100%;background:transparent;overflow:hidden;pointer-events:none;font-family:'Segoe UI',sans-serif;color:white;}
button,input,select,a,[data-interactive]{cursor:pointer;}
.virtual-hover{filter:brightness(1.3) !important;outline:1px solid rgba(255,255,255,0.3) !important;}
button.virtual-hover,a.virtual-hover,[data-interactive].virtual-hover{filter:brightness(1.4) !important;outline:1px solid rgba(255,255,255,0.5) !important;}
/* Responsive base — fires only for panels that opted in via
   <meta name="pp-responsive">. Desktop value of --pp-bottom-clear
   is 0, so the same HTML reads at full size on a wide monitor.
   Mobile branch fires under @media (pointer: coarse) — coarse
   pointer is a device-level capability, not iframe-viewport-
   dependent, so it works correctly even though our scale-down
   path is bypassed for these panels. */
:root[data-pp-responsive]{--pp-bottom-clear:0px;--pp-top-clear:0px;}
/* Hide elements that only make sense on desktop (keyboard hints,
   mouse-button cues, "Press P to pause" prompts) when the device is
   touch-primary. Pair: [data-pp-mobile-only] / .pp-mobile-only for
   elements that should ONLY render on mobile. Both rules apply
   universally — legacy non-responsive panels can use them too. */
@media (pointer: coarse){
[data-pp-desktop-only],.pp-desktop-only{display:none!important;}
}
@media not (pointer: coarse){
[data-pp-mobile-only],.pp-mobile-only{display:none!important;}
}
@media (pointer: coarse){
:root[data-pp-responsive]{--pp-bottom-clear:var(--pp-joystick-h, 0px);--pp-top-clear:max(56px,env(safe-area-inset-top));}
:root[data-pp-responsive] body{padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right);padding-top:env(safe-area-inset-top);}
:root[data-pp-responsive] button,:root[data-pp-responsive] [role="button"],:root[data-pp-responsive] [data-interactive]{min-height:44px;min-width:44px;}
/* Universal corner-lift: bottom-anchored fixed/absolute elements in a
   responsive panel get pushed above the joystick + action-rail
   footprint on mobile. Two-tier because the action rail (bottom-right)
   stacks 4+ buttons in two columns and is much taller than the
   single-element joystick (bottom-left). !important beats inline
   declarations; panels can opt out per-element via [data-pp-no-lift]. */
/* Bottom-LEFT: above joystick (~140px + safe-area). 200px reserve. */
:root[data-pp-responsive] [style*="position:fixed"][style*="bottom"][style*="left"]:not([style*="bottom:0"]):not([data-pp-no-lift]),
:root[data-pp-responsive] [style*="position: fixed"][style*="bottom"][style*="left"]:not([style*="bottom: 0"]):not([data-pp-no-lift]),
:root[data-pp-responsive] [style*="position:absolute"][style*="bottom"][style*="left"]:not([style*="bottom:0"]):not([data-pp-no-lift]),
:root[data-pp-responsive] [style*="position: absolute"][style*="bottom"][style*="left"]:not([style*="bottom: 0"]):not([data-pp-no-lift]){
bottom:max(var(--pp-joystick-h, 0px),calc(env(safe-area-inset-bottom) + var(--pp-joystick-h, 0px)))!important;
}
/* Bottom-RIGHT: above the taller action rail (~280px). */
:root[data-pp-responsive] [style*="position:fixed"][style*="bottom"][style*="right"]:not([style*="bottom:0"]):not([data-pp-no-lift]),
:root[data-pp-responsive] [style*="position: fixed"][style*="bottom"][style*="right"]:not([style*="bottom: 0"]):not([data-pp-no-lift]),
:root[data-pp-responsive] [style*="position:absolute"][style*="bottom"][style*="right"]:not([style*="bottom:0"]):not([data-pp-no-lift]),
:root[data-pp-responsive] [style*="position: absolute"][style*="bottom"][style*="right"]:not([style*="bottom: 0"]):not([data-pp-no-lift]){
bottom:max(var(--pp-rail-h, 0px),calc(env(safe-area-inset-bottom) + var(--pp-rail-h, 0px)))!important;
}
/* Bottom-anchored without explicit left/right (centered or grid-placed):
   default to the smaller joystick-side reserve; safer than over-lifting
   centered HUDs. */
:root[data-pp-responsive] [style*="position:fixed"][style*="bottom"]:not([style*="bottom:0"]):not([style*="left"]):not([style*="right"]):not([data-pp-no-lift]),
:root[data-pp-responsive] [style*="position: fixed"][style*="bottom"]:not([style*="bottom: 0"]):not([style*="left"]):not([style*="right"]):not([data-pp-no-lift]),
:root[data-pp-responsive] [style*="position:absolute"][style*="bottom"]:not([style*="bottom:0"]):not([style*="left"]):not([style*="right"]):not([data-pp-no-lift]),
:root[data-pp-responsive] [style*="position: absolute"][style*="bottom"]:not([style*="bottom: 0"]):not([style*="left"]):not([style*="right"]):not([data-pp-no-lift]){
bottom:max(var(--pp-joystick-h, 0px),calc(env(safe-area-inset-bottom) + var(--pp-joystick-h, 0px)))!important;
}
/* Universal width cap: any inline-positioned fixed/absolute element
   gets max-width capped to viewport so panels designed at 1920px never
   overflow on a phone. Author can opt out per-element with [data-pp-no-cap]
   or override via a class selector with higher specificity. */
:root[data-pp-responsive] [style*="position:fixed"][style*="right"]:not([data-pp-no-cap]),
:root[data-pp-responsive] [style*="position: fixed"][style*="right"]:not([data-pp-no-cap]),
:root[data-pp-responsive] [style*="position:absolute"][style*="right"]:not([data-pp-no-cap]),
:root[data-pp-responsive] [style*="position: absolute"][style*="right"]:not([data-pp-no-cap]),
:root[data-pp-responsive] [style*="position:fixed"][style*="left"]:not([data-pp-no-cap]),
:root[data-pp-responsive] [style*="position: fixed"][style*="left"]:not([data-pp-no-cap]),
:root[data-pp-responsive] [style*="position:absolute"][style*="left"]:not([data-pp-no-cap]),
:root[data-pp-responsive] [style*="position: absolute"][style*="left"]:not([data-pp-no-cap]){
max-width:calc(100vw - 16px)!important;
}
}
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
        // Detect modal-panel visibility transitions and fan out to the
        // suspension callback. Walk every loaded panel; if any non-HUD
        // (lobby_*, main_menu, pause_menu, game_over, host_config, etc)
        // has its `<name>Visible` flag true in the current state, a modal
        // is showing and the joystick should suspend. HUDs don't trigger
        // suspension because their visibility represents in-game state,
        // not "user is in a UI screen". Edge-triggered.
        let anyModalVisible = false;
        for (const path of this.cachedContent.keys()) {
            const f = this.flagFor(path);
            if (!f.isHud && state?.[f.flag] === true) { anyModalVisible = true; break; }
        }
        if (anyModalVisible !== this.lastModalVisible) {
            this.lastModalVisible = anyModalVisible;
            try { this.onModalPanelVisible?.(anyModalVisible); } catch { /* swallow */ }
        }

        // Dedupe state.lobbies before fanning out to iframes. lobby_browser
        // re-renders its row list on every gameState push that contains
        // state.lobbies — at 60Hz that's a constant listEl.innerHTML='' DOM
        // wipe, which on iOS WKWebView blocks the synthesized click event
        // after a button touchend (root cause of "buttons unresponsive on
        // iOS lobby browser"). When lobbies hasn't changed, post the
        // payload without the field so the iframe's `if (state.lobbies)`
        // gate skips render(). Only the postMessage payload is touched —
        // the visibility decisions below still see the original state.
        let postState: any = state;
        if (state && 'lobbies' in state) {
            const hash = JSON.stringify(state.lobbies);
            if (this.lastLobbiesHash === hash) {
                postState = { ...state };
                delete postState.lobbies;
            } else {
                this.lastLobbiesHash = hash;
            }
        }
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
                if (shouldShow && !existing) {
                    this._attachModal(path, html, false);
                } else if (!shouldShow && existing) {
                    if (this.focusedIframe === existing) this.focusedIframe = null;
                    this.unloadUI(path);
                } else if (existing) {
                    try { existing.contentWindow?.postMessage({ type: 'gameState', state: postState }, '*'); } catch {}
                }
            }

            // Forward gameState into the HUD bundle so panel scripts
            // listening for window.message events get their updates.
            if (this.hudBundleIframe) {
                try { this.hudBundleIframe.contentWindow?.postMessage({ type: 'gameState', state: postState }, '*'); } catch {}
            }
        } else {
        for (const [path, iframe] of this.overlays.entries()) {
            try {
                iframe.contentWindow?.postMessage({ type: 'gameState', state: postState }, '*');
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
        this.responsivePaths.clear();
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
