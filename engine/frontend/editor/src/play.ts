import './styles/theme.css';

import { ParallaxEditor } from './editor.js';
import { EditorContext } from './editor_context.js';
import { StreamingManager } from './streaming_manager.js';
import { initMobileControls } from './play_mobile_controls.js';

const splashScreen = document.getElementById('splash-screen')!;
const loadingScreen = document.getElementById('loading-screen')!;
const errorScreen = document.getElementById('error-screen')!;
const errorDetail = document.getElementById('error-detail')!;
const gameContainer = document.getElementById('game-container')!;
const settingsBtn = document.getElementById('settings-btn')!;
const settingsPanel = document.getElementById('settings-panel')!;

const progressFill = document.getElementById('loading-progress-fill')!;
const loadingText = document.querySelector('#loading-screen .loading-text') as HTMLElement;

const SPLASH_DURATION = 2600;

function showError(message: string): void {
    splashScreen.style.display = 'none';
    loadingScreen.style.display = 'none';
    errorDetail.textContent = message;
    errorScreen.style.display = 'flex';
    const homeLink = document.getElementById('error-home-link') as HTMLAnchorElement | null;
    if (homeLink) {
        homeLink.href = '/';
    }
}

function waitForSplash(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, SPLASH_DURATION));
}

function getSignupUrl(): string {
    // Signup always lives on the main site (parallaxpro.ai), never on the
    // games subdomain — games.parallaxpro.ai has no /signup route and
    // previously 404'd. When we're embedded in an iframe under
    // parallaxpro.ai/games/..., prefer the top URL so after signup the
    // user lands back on that wrapper page; otherwise rebuild a best-
    // guess wrapper URL from our own path so the redirect target is
    // always somewhere that HAS auth context.
    let redirectTo = '';
    try {
        if (window.top && window.top !== window) {
            redirectTo = window.top.location.href;
        }
    } catch { /* cross-origin parent — fall through */ }
    if (!redirectTo) {
        // Derive /games/<owner>/<slug> from URL so post-signup we come
        // back to the main-site wrapper, not the bare games.parallaxpro.ai
        // URL (which has no session).
        const p = new URLSearchParams(window.location.search);
        const parts = window.location.pathname.replace(/^\/play\/?/, '').split('/').filter(Boolean);
        const owner = p.get('owner') || parts[0];
        const slug = p.get('slug') || parts[1];
        redirectTo = owner && slug
            ? `https://parallaxpro.ai/games/${owner}/${slug}`
            : 'https://parallaxpro.ai/';
    }
    return `https://parallaxpro.ai/signup?redirect=${encodeURIComponent(redirectTo)}`;
}

// Navigate the top window to `url` so the signup page replaces the whole
// page rather than loading inside the iframe.
function navigateTopToSignup(): void {
    const url = getSignupUrl();
    try {
        if (window.top && window.top !== window) {
            window.top.location.href = url;
            return;
        }
    } catch { /* cross-origin parent — fall through */ }
    window.location.href = url;
}

function showGuestBanner(): void {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:200000;background:linear-gradient(135deg,#1a1a2e,#16213e);border-bottom:1px solid rgba(134,72,230,0.4);padding:10px 16px;display:flex;align-items:center;justify-content:center;gap:12px;font-family:system-ui,sans-serif;';
    banner.innerHTML = `
        <span style="color:rgba(255,255,255,0.8);font-size:13px;">Playing as guest — your progress won't be saved.</span>
        <a href="${getSignupUrl()}" target="_top" style="padding:5px 14px;background:#8648e6;color:white;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;white-space:nowrap;">Sign up free</a>
        <button id="guest-banner-close" style="background:none;border:none;color:rgba(255,255,255,0.5);font-size:18px;cursor:pointer;padding:0 4px;line-height:1;">&times;</button>
    `;
    document.body.appendChild(banner);
    document.getElementById('guest-banner-close')!.addEventListener('click', () => banner.remove());
    setTimeout(() => { if (banner.parentNode) banner.remove(); }, 10000);
}

const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown']);
window.addEventListener('keydown', (e) => { if (scrollKeys.has(e.key)) e.preventDefault(); });

/**
 * When /play/... is embedded in the parallaxpro.ai PlayGamePage iframe, the
 * iframe is sandboxed *without* allow-same-origin — so localStorage is
 * unreadable and the 7-day JWT that used to live there is unreachable. The
 * parent posts us a bootstrap payload containing the game data (pre-fetched
 * with auth, so private games still load) and a short-lived multiplayer WS
 * ticket. When running as a top-level document (or in an older build that
 * still has allow-same-origin), no bootstrap arrives and we fall back to
 * the original localStorage + fetch path.
 */
interface PlayBootstrap {
    game: any;
    user: { id: number; username: string; email: string } | null;
    mpTicket: string | null;
}
let _cachedBootstrap: PlayBootstrap | null = null;
// Attach the listener + ping the parent synchronously at module load.
// The listener stays attached for the life of the document so a later
// bootstrap (e.g. after the parent re-navigates to a different game)
// still updates _cachedBootstrap. A periodic retry is necessary because
// the parent's message handler is inside a React useEffect gated on
// game data being fetched — if our first ping lands before that effect
// runs, the parent drops it. We keep pinging until we get a bootstrap
// back, or give up after a cap so we don't ping forever on genuinely
// orphaned iframes (preview clients, detached tabs).
const _bootstrapListenerPromise: Promise<PlayBootstrap | null> = (() => {
    if (window.parent === window) return Promise.resolve(null);
    return new Promise((resolve) => {
        let resolved = false;
        window.addEventListener('message', (e: MessageEvent) => {
            const d = e.data;
            if (!d || d.type !== 'pp-play-bootstrap') return;
            _cachedBootstrap = { game: d.game, user: d.user, mpTicket: d.mpTicket };
            if (!resolved) {
                resolved = true;
                resolve(_cachedBootstrap);
            }
        });
        let attempts = 0;
        const ping = () => {
            if (resolved) return;
            attempts++;
            try { window.parent.postMessage({ type: 'pp-play-ready' }, '*'); } catch {}
            // 15 attempts × 400ms ≈ 6s total retry window. Beyond that we
            // stop pinging (the waitForBootstrap timeout will fall through).
            if (attempts < 15) setTimeout(ping, 400);
        };
        ping();
    });
})();
function waitForBootstrap(timeoutMs: number): Promise<PlayBootstrap | null> {
    if (_cachedBootstrap) return Promise.resolve(_cachedBootstrap);
    return Promise.race([
        _bootstrapListenerPromise,
        new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ]);
}

// Publicize for multiplayer_manager.ts etc. so they can use the ticket
// rather than trying (and failing) to read localStorage in the sandbox.
(window as any).__ppPlayBootstrap = () => _cachedBootstrap;

/**
 * Direct-visit auth handoff for top-level loads on games.parallaxpro.ai.
 * The games subdomain has no session cookie / localStorage because it's
 * a different origin from parallaxpro.ai where JWTs live — we bridge the
 * gap two ways, silent-first then user-initiated:
 *
 * 1. Silent: hidden iframe to https://parallaxpro.ai/auth-bridge.html
 *    which reads the main-origin JWT, mints a WS ticket, fetches the
 *    authed gameData, and postMessages the lot back here. The JWT itself
 *    never crosses origins.
 *
 * 2. Popup: if the silent bridge reports no session, show a "Sign in to
 *    play" banner whose button opens parallaxpro.ai/play-auth in a
 *    popup; the popup prompts login if needed, then does the same
 *    handoff as the bridge and closes itself.
 *
 * Both paths feed into `_cachedBootstrap` so the rest of the boot path
 * (gameData, mpTicket consumption in mp_bridge/lobby_client) is
 * identical to the iframe-wrapper case.
 */
const MAIN_ORIGIN = 'https://parallaxpro.ai';
function isTopLevelOnGamesOrigin(): boolean {
    return window.parent === window
        && (window.location.hostname === 'games.parallaxpro.ai'
            || window.location.hostname === 'www.games.parallaxpro.ai');
}
function trySilentAuthBridge(owner: string, slug: string, timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const frame = document.createElement('iframe');
        frame.style.display = 'none';
        frame.setAttribute('aria-hidden', 'true');
        const onMsg = (e: MessageEvent) => {
            if (e.origin !== MAIN_ORIGIN) return;
            if (!e.data || e.data.type !== 'pp-auth-bridge') return;
            if (settled) return;
            settled = true;
            window.removeEventListener('message', onMsg);
            try { frame.remove(); } catch {}
            if (e.data.loggedIn) {
                _cachedBootstrap = {
                    game: e.data.game || null,
                    user: e.data.user || null,
                    mpTicket: e.data.mpTicket || null,
                };
                resolve(true);
            } else {
                resolve(false);
            }
        };
        window.addEventListener('message', onMsg);
        setTimeout(() => {
            if (settled) return;
            settled = true;
            window.removeEventListener('message', onMsg);
            try { frame.remove(); } catch {}
            resolve(false);
        }, timeoutMs);
        frame.src = `${MAIN_ORIGIN}/auth-bridge.html?owner=${encodeURIComponent(owner)}&slug=${encodeURIComponent(slug)}`;
        document.body.appendChild(frame);
    });
}
function showSignInToPlayBanner(owner: string, slug: string): Promise<boolean> {
    return new Promise((resolve) => {
        const banner = document.createElement('div');
        banner.style.cssText = 'position:fixed;inset:0;z-index:300000;background:rgba(10,10,20,0.92);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;';
        banner.innerHTML = `
            <div style="background:#1a1a2e;border:1px solid rgba(134,72,230,0.4);border-radius:12px;padding:28px 32px;max-width:420px;text-align:center;color:#fff;">
                <h2 style="margin:0 0 8px;font-size:20px;">Sign in to play multiplayer</h2>
                <p style="margin:0 0 20px;font-size:13px;color:rgba(255,255,255,0.7);line-height:1.5;">Multiplayer games need a ParallaxPro account so other players can see your username.</p>
                <button id="pp-signin-btn" style="padding:10px 24px;background:#8648e6;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">Sign in</button>
            </div>
        `;
        document.body.appendChild(banner);
        const cleanup = () => { try { banner.remove(); } catch {} };
        document.getElementById('pp-signin-btn')!.addEventListener('click', () => {
            const popupUrl = `${MAIN_ORIGIN}/play-auth?owner=${encodeURIComponent(owner)}&slug=${encodeURIComponent(slug)}&origin=${encodeURIComponent(window.location.origin)}`;
            // On mobile, popups are unreliable — redirect the whole page.
            // play-auth will redirect back after login.
            const isMobile = ('ontouchstart' in window) && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
            if (isMobile) {
                window.location.href = popupUrl + '&redirect=1';
                return;
            }
            const popup = window.open(popupUrl, 'pp-play-auth', 'width=520,height=680');
            if (!popup) {
                cleanup();
                resolve(false);
                return;
            }
            const onMsg = (e: MessageEvent) => {
                if (e.origin !== MAIN_ORIGIN) return;
                if (!e.data || e.data.type !== 'pp-play-auth') return;
                window.removeEventListener('message', onMsg);
                clearInterval(poll);
                cleanup();
                if (e.data.loggedIn) {
                    _cachedBootstrap = {
                        game: e.data.game || null,
                        user: e.data.user || null,
                        mpTicket: e.data.mpTicket || null,
                    };
                    resolve(true);
                } else {
                    resolve(false);
                }
            };
            window.addEventListener('message', onMsg);
            // Detect the user closing the popup without completing.
            const poll = setInterval(() => {
                let closed = false;
                try { closed = popup.closed; } catch { closed = true; }
                if (closed) {
                    clearInterval(poll);
                    window.removeEventListener('message', onMsg);
                    cleanup();
                    resolve(false);
                }
            }, 500);
        });
    });
}

async function boot(): Promise<void> {
    // Direct visits to games.parallaxpro.ai/play/... are allowed — single-
    // player public games just work, multiplayer falls through to the
    // "sign up to play" gate because there's no auth context on this
    // origin. Users who want multiplayer should start from
    // parallaxpro.ai/games/<owner>/<slug> (the main-site wrapper) where
    // the iframe bootstrap carries their session across the boundary.

    const pathParts = window.location.pathname.replace(/^\/play\/?/, '').split('/').filter(Boolean);

    const urlParams = new URLSearchParams(window.location.search);
    const roomId = urlParams.get('room');
    // Multiplayer still comes in via /play/multiplayer?room=X. A pathParts
    // check is sufficient when play.html is served at that URL; when the
    // engine-version bootstrap has redirected us into an archived bundle
    // (/engine-bundles/<hash>/play.html) the path no longer carries
    // /play/multiplayer, so fall back to the `room` query param alone.
    const isMultiplayerJoin = (pathParts[0] === 'multiplayer' && !!roomId)
        || (!!roomId && pathParts.length < 2 && !urlParams.get('slug'));

    // owner/slug can come from the URL path (/play/:owner/:slug) or from
    // query params (?owner=X&slug=Y). The query-param form is used when
    // the engine-version router has redirected play into a versioned
    // bundle at /engine-bundles/<hash>/play.html, where the path no
    // longer contains owner/slug.
    const queryOwner = urlParams.get('owner');
    const querySlug = urlParams.get('slug');

    if (!isMultiplayerJoin && pathParts.length < 2 && !(queryOwner && querySlug)) {
        showError('No game specified.');
        return;
    }

    // In a sandboxed iframe (the /games/:owner/:slug wrapper), the parent
    // posts a bootstrap with pre-fetched gameData + mp ticket. Outside an
    // iframe this returns null quickly.
    // 6s window: matches the periodic ping loop (15 × 400ms) so the boot
    // path doesn't time out before the last retry has had a chance to
    // land. Outside an iframe this returns immediately.
    let bootstrap = await waitForBootstrap(6000);

    // Direct top-level visit to games.parallaxpro.ai: no parent bootstrap.
    // Step 1 — silent auth-bridge. If the user is logged in on the main
    //          site, this returns gameData + mp ticket with no UI.
    // Step 2 — if silent said "not logged in", peek at gameData via an
    //          unauth GET (works for public games) to decide whether we
    //          even need to prompt. Multiplayer → show "Sign in to play"
    //          banner → popup. Single-player public → just play as guest.
    // TODO: re-enable auth bridge once cross-origin flow is stable on mobile.
    // For now, skip all auth on games.parallaxpro.ai — everyone plays as guest.
    if (!bootstrap && isTopLevelOnGamesOrigin()) {
        const owner = queryOwner || pathParts[0] || '';
        const slug  = querySlug  || pathParts[1] || '';
        if (owner && slug) {
            let gd: any = null;
            try {
                const res = await fetch(`/api/engine/games/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`);
                if (res.ok) gd = await res.json();
            } catch {}
            if (gd) {
                _cachedBootstrap = { game: gd, user: null, mpTicket: null };
            }
            bootstrap = _cachedBootstrap;
        }
    }

    // localStorage is unreadable in an opaque-origin sandbox (throws or
    // returns empty). Guard it so we degrade gracefully rather than crash.
    let token: string | null = null;
    try {
        token = localStorage.getItem('auth_token') || localStorage.getItem('token');
    } catch { token = null; }
    const isLoggedIn = !!token || !!bootstrap?.user;

    // Multiplayer join works for guests too — they appear as "Guest".

    const splashPromise = waitForSplash();

    let gameData: any;

    if (isMultiplayerJoin) {
        try {
            const res = await fetch(`/api/engine/multiplayer/rooms/${roomId}/project`);
            if (res.ok) {
                gameData = await res.json();
            } else {
                showError('This multiplayer room no longer exists. The host may have left or the session has ended.');
                return;
            }
        } catch {
            showError('Network error. Please try again.');
            return;
        }
    } else if (bootstrap?.game) {
        // Parent already fetched (with auth, so private games work) and
        // handed us the game data. Skip our own fetch — in the sandbox it
        // would be CORS-blocked anyway now that the iframe is opaque-origin.
        gameData = bootstrap.game;
    } else {
        const owner = queryOwner || pathParts[0];
        const slug = querySlug || pathParts[1];
        try {
            const headers: Record<string, string> = {};
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const res = await fetch(`/api/engine/games/${owner}/${slug}`, { headers });
            if (!res.ok) {
                if (res.status === 404) {
                    showError('This game may have been removed or made private.');
                } else {
                    showError(`Failed to load game (${res.status}).`);
                }
                return;
            }
            gameData = await res.json();
        } catch {
            showError('Network error. Please try again.');
            return;
        }

        // Engine-version routing: if the game was published against a
        // different engine commit than this bundle was built with, hop
        // over to the matching archived bundle so runtime deserialization
        // can trust the shapes in gameData. Skipped when we have no hash
        // of our own (local git-less checkout), the game predates the
        // engine_bundles registry and carries no hash, or no archive
        // exists on prod for the target hash. A HEAD probe isn't
        // trustworthy because nginx falls through to the landing-page
        // SPA for unknown paths, so we consult the registry directly.
        //
        // Also skipped when we're in an iframe (wrapped by
        // parallaxpro.ai/games/...) — the archived bundles don't have
        // the cross-origin bootstrap handshake code, so redirecting into
        // them loses the auth ticket and drops the user to guest. Current
        // engine is backward-compatible with recent game data shapes; if
        // that ever breaks we'll revisit with a more targeted fix.
        const ourHash = typeof __ENGINE_GIT_HASH__ !== 'undefined' ? __ENGINE_GIT_HASH__ : 'unknown';
        const wantHash: string | null = gameData.engineGitHash || null;
        const alreadyInArchive = /^\/engine-bundles\//.test(window.location.pathname);
        const inIframe = window.parent !== window;
        if (wantHash && ourHash && ourHash !== 'unknown' && wantHash !== ourHash && !alreadyInArchive && !inIframe) {
            let shouldRedirect = false;
            try {
                const regRes = await fetch('/api/engine/engine-bundles');
                if (regRes.ok) {
                    const reg = await regRes.json();
                    const matched = (reg.bundles || []).find((b: any) => b.hash === wantHash && b.status !== 'rejected' && b.archiveExists);
                    shouldRedirect = !!matched;
                }
            } catch {}
            if (shouldRedirect) {
                const params = new URLSearchParams(window.location.search);
                params.set('owner', owner);
                params.set('slug', slug);
                window.location.replace(`/engine-bundles/${encodeURIComponent(wantHash)}/play.html?${params.toString()}`);
                return;
            }
            console.warn(`[play] engine hash ${wantHash.slice(0, 7)} has no archived bundle; falling back to current engine (${ourHash.slice(0, 7)})`);
        }
    }

    const scripts = gameData.scripts || {};
    const mpConfig = gameData.multiplayerConfig || gameData.projectConfig?.multiplayerConfig;
    const isMultiplayerGame = !!mpConfig?.enabled
        || Object.keys(scripts).some(k => k.includes('network_sync'));
    // Multiplayer games no longer require auth — guests play as "Guest".

    document.title = `${gameData.name} - ParallaxPro`;

    gameContainer.classList.add('viewport-canvas-container');

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    gameContainer.appendChild(canvas);

    const editor = new ParallaxEditor();
    await editor.initialize(canvas, {
        config: gameData.projectConfig,
        scenes: gameData.scenes,
    });

    const ctx = EditorContext.instance;
    (window as any).__editorContext = ctx;
    ctx.state.projectData = {
        name: gameData.name,
        scenes: gameData.scenes,
        scripts: gameData.scripts || {},
        compiledScripts: gameData.compiledScripts || {},
        uiFiles: gameData.uiFiles || {},
        projectConfig: gameData.projectConfig,
        // Needed so play_mode_helpers can plumb min/max players and the
        // tick rate into mp_bridge — without this, the published Start
        // button never gets gated and below-min abandonment never fires.
        multiplayerConfig: gameData.multiplayerConfig || null,
        // Used as the multiplayer lobby shard key. updatedAt bumps on
        // every republish (even republishing as the same version string),
        // so it's stricter than version alone — different bytes always
        // get different shards. publishedAt is the fallback if the play
        // API hasn't been updated to include updatedAt yet.
        updatedAt: gameData.updatedAt || gameData.publishedAt || null,
    } as any;

    if (gameData.id) ctx.state.projectId = gameData.id;

    // Sandboxed opaque-origin iframes make localStorage throw — guard so
    // the game still boots with the default quality instead of dying.
    let quality: 'low' | 'medium' | 'high' = 'medium';
    try { quality = (localStorage.getItem('graphics_quality') as any) ?? 'medium'; } catch {}
    ctx.setGraphicsQuality(quality);

    ctx.ensurePrimitiveMeshes();

    // Set up streaming (heightmap terrain, OSM buildings/roads/props) from
    // scene data. Unlike the editor — which mounts ViewportPanel — the play
    // path has no panel, so we wire the same manager directly here and drive
    // its per-frame updates off the active scene camera.
    const streaming = new StreamingManager(ctx);
    streaming.init();
    const engine = editor.getEngine();
    engine.onPostAnimation(() => {
        const scene = ctx.getActiveScene();
        if (!scene) return;
        const cam = scene.getActiveCamera();
        if (!cam) return;
        streaming.update(cam.position);
    });

    await splashPromise;
    splashScreen.style.display = 'none';
    loadingScreen.style.display = 'flex';

    const updateProgress = () => {
        const progress = ctx.getAssetLoadProgress();
        if (progress.total > 0) {
            const pct = Math.round((progress.loaded / progress.total) * 90);
            progressFill.style.width = `${pct}%`;
            loadingText.textContent = `Loading assets (${progress.loaded}/${progress.total})`;
        }
    };
    const progressInterval = setInterval(updateProgress, 100);

    await ctx.waitForAllAssetsLoaded();
    clearInterval(progressInterval);

    progressFill.style.width = '95%';
    loadingText.textContent = 'Finalizing...';
    if ((ctx as any).skinning?.waitForPendingSkinning) {
        await (ctx as any).skinning.waitForPendingSkinning();
    }
    progressFill.style.width = '100%';

    loadingScreen.style.display = 'none';
    settingsBtn.style.display = 'flex';

    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = settingsPanel.style.display === 'flex';
        settingsPanel.style.display = open ? 'none' : 'flex';
    });
    document.addEventListener('click', () => {
        settingsPanel.style.display = 'none';
    });
    settingsPanel.addEventListener('click', (e) => e.stopPropagation());

    let currentQuality = 'medium';
    try { currentQuality = localStorage.getItem('graphics_quality') || 'medium'; } catch {}
    const qualityBtns = settingsPanel.querySelectorAll('.quality-btn');
    qualityBtns.forEach((btn) => {
        if ((btn as HTMLElement).dataset.quality === currentQuality) {
            btn.classList.add('active');
        }
        btn.addEventListener('click', () => {
            const q = (btn as HTMLElement).dataset.quality as 'low' | 'medium' | 'high';
            try { localStorage.setItem('graphics_quality', q); } catch {}
            ctx.setGraphicsQuality(q);
            qualityBtns.forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });

    const fpsCounter = document.getElementById('fps-counter')!;
    fpsCounter.style.display = 'block';
    let frameCount = 0;
    let lastFpsTime = performance.now();
    const updateFps = () => {
        frameCount++;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
            fpsCounter.textContent = `${frameCount} FPS`;
            frameCount = 0;
            lastFpsTime = now;
        }
        requestAnimationFrame(updateFps);
    };
    requestAnimationFrame(updateFps);

    if (isMultiplayerJoin && roomId) {
        const url = new URL(window.location.href);
        url.searchParams.set('room', roomId);
        window.history.replaceState({}, '', url.toString());
    }

    ctx.play();

    if (isMultiplayerJoin) {
        const showDisconnectOverlay = (data?: any) => {
            ctx.stop();
            if (document.pointerLockElement) document.exitPointerLock();
            if (relockOverlay) { relockOverlay.remove(); relockOverlay = null; }

            const reason = data?.reason || '';
            const isKicked = reason === 'kicked' || reason === 'blocked';
            const title = isKicked ? 'You Were Kicked' : 'Host Left the Game';
            const desc = isKicked
                ? 'The host has removed you from the game.'
                : 'The host has ended the multiplayer session. Thanks for playing!';

            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:200000;cursor:default;';

            const card = document.createElement('div');
            card.style.cssText = 'background:#1a1a2e;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:40px 48px;text-align:center;max-width:420px;';
            card.innerHTML = `
                <h2 style="color:white;margin:0 0 12px;font-size:22px;">${title}</h2>
                <p style="color:rgba(255,255,255,0.6);margin:0 0 28px;font-size:15px;line-height:1.5;">${desc}</p>
                <a href="/" style="display:inline-block;padding:12px 32px;background:#8648e6;color:white;border-radius:8px;text-decoration:none;font-size:15px;font-weight:600;cursor:pointer;">Back to Home</a>
            `;

            overlay.appendChild(card);
            document.body.appendChild(overlay);
        };

        ctx.multiplayer.on('roomClosed', showDisconnectOverlay);
        ctx.multiplayer.on('kicked', (data: any) => {
            showDisconnectOverlay(data);
        });
    }

    if (!isLoggedIn) showGuestBanner();

    let relockOverlay: HTMLElement | null = null;
    {
        const isMobile = ('ontouchstart' in window) && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        if (!isMobile) {
            const showOverlay = () => {
                if (relockOverlay) return;
                relockOverlay = document.createElement('div');
                relockOverlay.style.cssText = 'position:absolute;inset:0;z-index:150000;cursor:pointer;';
                relockOverlay.addEventListener('mousedown', () => {
                    try { canvas.requestPointerLock(); } catch (_) {}
                });
                gameContainer.appendChild(relockOverlay);
            };
            const hideOverlay = () => {
                if (relockOverlay) { relockOverlay.remove(); relockOverlay = null; }
            };
            document.addEventListener('pointerlockchange', () => {
                if (document.pointerLockElement) {
                    hideOverlay();
                } else {
                    showOverlay();
                }
            });
            showOverlay();
        }
    }

    initMobileControls(gameContainer);

    const resize = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', resize);
    resize();
}

boot().catch((e) => {
    console.error('Failed to start game:', e);
    showError(e.message || 'Unknown error.');
});
