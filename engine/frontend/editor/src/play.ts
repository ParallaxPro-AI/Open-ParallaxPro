import './styles/theme.css';

import { ParallaxEditor } from './editor.js';
import { EditorContext } from './editor_context.js';
import { StreamingManager } from './streaming_manager.js';

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
    // When play.ts runs inside an iframe (e.g. the /everything-game wrapper
    // or any third-party embed of /play/:owner/:slug) we want the signup
    // flow to send the user back to the wrapper page they originally saw,
    // not the bare /play URL — otherwise after signup they land inside a
    // nested-iframe view of the same wrapper.
    let redirectTo = window.location.href;
    try {
        if (window.top && window.top !== window) {
            redirectTo = window.top.location.href;
        }
    } catch {
        // Cross-origin parent (third-party embed) — redirect back to the
        // play URL itself, which still works as a standalone page.
    }
    return `${window.location.origin}/signup?redirect=${encodeURIComponent(redirectTo)}`;
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
// Attach the listener + announce readiness synchronously at module load
// rather than inside waitForBootstrap(). If we wait for the boot() async
// chain to reach waitForBootstrap before attaching, the parent's
// 'pp-play-bootstrap' message can arrive in between and be missed — the
// parent's `iframe.load` listener fires as soon as the iframe document
// loads, which can beat the listener attachment when the boot path is
// slow (asset decode, wasm instantiate, etc.).
const _bootstrapListenerPromise: Promise<PlayBootstrap | null> = (() => {
    if (window.parent === window) return Promise.resolve(null);
    return new Promise((resolve) => {
        const onMsg = (e: MessageEvent) => {
            const d = e.data;
            if (!d || d.type !== 'pp-play-bootstrap') return;
            window.removeEventListener('message', onMsg);
            _cachedBootstrap = { game: d.game, user: d.user, mpTicket: d.mpTicket };
            resolve(_cachedBootstrap);
        };
        window.addEventListener('message', onMsg);
        // Tell the parent we're ready to receive the bootstrap. Handles the
        // race where the parent's iframe.onload fired before React's
        // useEffect attached its handler — without this cue the bootstrap
        // never arrives and the game boots without a ticket (appearing as
        // "guest-XXXX" in multiplayer).
        try { window.parent.postMessage({ type: 'pp-play-ready' }, '*'); } catch {}
    });
})();
function waitForBootstrap(timeoutMs: number): Promise<PlayBootstrap | null> {
    if (_cachedBootstrap) return Promise.resolve(_cachedBootstrap);
    // Race the already-listening promise against a timeout.
    return Promise.race([
        _bootstrapListenerPromise,
        new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ]);
}

// Publicize for multiplayer_manager.ts etc. so they can use the ticket
// rather than trying (and failing) to read localStorage in the sandbox.
(window as any).__ppPlayBootstrap = () => _cachedBootstrap;

async function boot(): Promise<void> {
    // Top-level visit to games.parallaxpro.ai has no auth context (different
    // origin from parallaxpro.ai where the JWT lives). Bounce to the main-
    // site wrapper so the user's session carries through the iframe
    // bootstrap path. Skipped when embedded in an iframe (that's the
    // wrapper itself) or when on localhost / archived bundle paths on the
    // main site.
    if (window.parent === window
        && (window.location.hostname === 'games.parallaxpro.ai'
            || window.location.hostname === 'www.games.parallaxpro.ai')) {
        const urlParams = new URLSearchParams(window.location.search);
        const pathOwnerSlug = window.location.pathname.replace(/^\/play\/?/, '').split('/').filter(Boolean);
        const owner = urlParams.get('owner') || pathOwnerSlug[0];
        const slug = urlParams.get('slug') || pathOwnerSlug[1];
        if (owner && slug) {
            window.location.replace(`https://parallaxpro.ai/games/${owner}/${slug}`);
            return;
        }
    }

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
    const bootstrap = await waitForBootstrap(1500);

    // localStorage is unreadable in an opaque-origin sandbox (throws or
    // returns empty). Guard it so we degrade gracefully rather than crash.
    let token: string | null = null;
    try {
        token = localStorage.getItem('auth_token') || localStorage.getItem('token');
    } catch { token = null; }
    const isLoggedIn = !!token || !!bootstrap?.user;

    if (isMultiplayerJoin && !isLoggedIn) {
        navigateTopToSignup();
        return;
    }

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
        const ourHash = typeof __ENGINE_GIT_HASH__ !== 'undefined' ? __ENGINE_GIT_HASH__ : 'unknown';
        const wantHash: string | null = gameData.engineGitHash || null;
        const alreadyInArchive = /^\/engine-bundles\//.test(window.location.pathname);
        if (wantHash && ourHash && ourHash !== 'unknown' && wantHash !== ourHash && !alreadyInArchive) {
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
    if (isMultiplayerGame && !isLoggedIn) {
        splashScreen.style.display = 'none';
        showError('This is a multiplayer game. Please sign up or log in to play.');
        const homeLink = document.getElementById('error-home-link') as HTMLAnchorElement | null;
        if (homeLink) {
            homeLink.textContent = 'Sign up to play';
            homeLink.href = getSignupUrl();
            homeLink.target = '_top';
        }
        return;
    }

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
