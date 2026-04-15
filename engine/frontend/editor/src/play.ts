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
    return `${window.location.origin}/signup?redirect=${encodeURIComponent(window.location.href)}`;
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

async function boot(): Promise<void> {
    const pathParts = window.location.pathname.replace(/^\/play\/?/, '').split('/').filter(Boolean);

    const urlParams = new URLSearchParams(window.location.search);
    const roomId = urlParams.get('room');
    const isMultiplayerJoin = pathParts[0] === 'multiplayer' && !!roomId;

    if (!isMultiplayerJoin && pathParts.length < 2) {
        showError('No game specified.');
        return;
    }

    const token = localStorage.getItem('auth_token') || localStorage.getItem('token');
    const isLoggedIn = !!token;

    if (isMultiplayerJoin && !isLoggedIn) {
        window.location.href = getSignupUrl();
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
    } else {
        const [owner, slug] = pathParts;
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
    }

    const scripts = gameData.scripts || {};
    const isMultiplayerGame = Object.keys(scripts).some(k => k.includes('network_sync'));
    if (isMultiplayerGame && !isLoggedIn) {
        splashScreen.style.display = 'none';
        showError('This is a multiplayer game. Please sign up or log in to play.');
        const homeLink = document.getElementById('error-home-link') as HTMLAnchorElement | null;
        if (homeLink) {
            homeLink.textContent = 'Sign up to play';
            homeLink.href = getSignupUrl();
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
        // Used as the multiplayer lobby shard key. updatedAt bumps on
        // every republish (even republishing as the same version string),
        // so it's stricter than version alone — different bytes always
        // get different shards. publishedAt is the fallback if the play
        // API hasn't been updated to include updatedAt yet.
        updatedAt: gameData.updatedAt || gameData.publishedAt || null,
    } as any;

    if (gameData.id) ctx.state.projectId = gameData.id;

    const quality = (localStorage.getItem('graphics_quality') as 'low' | 'medium' | 'high') ?? 'medium';
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

    const currentQuality = localStorage.getItem('graphics_quality') || 'medium';
    const qualityBtns = settingsPanel.querySelectorAll('.quality-btn');
    qualityBtns.forEach((btn) => {
        if ((btn as HTMLElement).dataset.quality === currentQuality) {
            btn.classList.add('active');
        }
        btn.addEventListener('click', () => {
            const q = (btn as HTMLElement).dataset.quality as 'low' | 'medium' | 'high';
            localStorage.setItem('graphics_quality', q);
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
