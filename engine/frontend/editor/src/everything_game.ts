/**
 * Everything Game runtime entry point.
 *
 * Boots the ParallaxPro engine against a canvas, loads the pre-generated
 * heightmap terrain + streamed OSM world (buildings/roads/props) from the
 * everything_game asset bundle, and runs a first-person free-fly camera —
 * no per-project publishing flow, no owner/slug lookup. The world is part
 * of the platform.
 *
 * Per-frame work is hooked into the engine's post-animation callback so
 * it runs after input but before render each frame.
 */

import './styles/theme.css';

import { ParallaxEngine } from '../../runtime/engine.js';
import { registerBuiltInComponents } from '../../runtime/function/framework/register_components.js';
import { Scene } from '../../runtime/function/framework/scene.js';
import { Vec3 } from '../../runtime/core/math/vec3.js';
import { Mat4 } from '../../runtime/core/math/mat4.js';
import { Quat } from '../../runtime/core/math/quat.js';
import { EditorContext } from './editor_context.js';

import { HeightmapTerrain } from '../../runtime/function/streaming/heightmap_terrain.js';
import { StreamedBuildings } from '../../../../everything_game/003_runtime/streaming/streamed_buildings.js';
import { StreamedRoads } from '../../../../everything_game/003_runtime/streaming/streamed_roads.js';
import { StreamedProps } from '../../../../everything_game/003_runtime/streaming/streamed_props.js';
import { loadTerrainTextureArrays } from '../../../../everything_game/003_runtime/streaming/terrain_texture_cache.js';

// ── Config ──────────────────────────────────────────────────────────
// Asset paths match the published template's defaults
// (engine/backend/.../game_templates/v0.2/everything_game/03_worlds.json).
const ASSET_BASE_CHUNKS = '/assets/official/everything_game/chunks/';
const HEIGHTMAP_META_URL = '/assets/official/everything_game/terrain/heightmap_meta.json';
const STREAM_LOAD_RADIUS = 3;
const STREAM_UNLOAD_RADIUS = 5;
const BUILDING_BASE_COLOR: [number, number, number, number] = [0.74, 0.71, 0.66, 1.0];
const WATER_LEVEL = 0.5;

// Spawn point (Bay Area start from the template).
const SPAWN_POS = new Vec3(27984, 29, 17301);

// Camera tuning — far clip is generous since the streamed world is huge.
const CAM_FOV = 70 * (Math.PI / 180);
const CAM_NEAR = 1;
const CAM_FAR = 200000;

// Free-fly controls.
const MOVE_SPEED = 60;         // m/s base
const SPRINT_MULT = 4;         // Shift boost
const MOUSE_SENS = 0.0022;     // radians per pixel

const SPLASH_DURATION = 2600;  // ms — matches play.html

// ── DOM refs ────────────────────────────────────────────────────────
const splashScreen = document.getElementById('splash-screen')!;
const loadingScreen = document.getElementById('loading-screen')!;
const errorScreen = document.getElementById('error-screen')!;
const errorDetail = document.getElementById('error-detail')!;
const progressFill = document.getElementById('loading-progress-fill')!;
const loadingText = document.querySelector('#loading-screen .loading-text') as HTMLElement;
const fpsCounter = document.getElementById('fps-counter')!;
const clickOverlay = document.getElementById('click-overlay')!;
const gameContainer = document.getElementById('game-container')!;

function showError(msg: string): void {
    splashScreen.style.display = 'none';
    loadingScreen.style.display = 'none';
    errorDetail.textContent = msg;
    errorScreen.style.display = 'flex';
}

function setLoadingText(msg: string): void {
    if (loadingText) loadingText.textContent = msg;
}

function setProgress(pct: number): void {
    progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

// ── Block keyboard-triggered page scrolling when the iframe has focus ──
const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown', 'Home', 'End']);
window.addEventListener('keydown', (e) => { if (scrollKeys.has(e.key)) e.preventDefault(); }, { capture: true });

// ── Main boot ───────────────────────────────────────────────────────
async function boot(): Promise<void> {
    const splashPromise = new Promise<void>((r) => setTimeout(r, SPLASH_DURATION));

    registerBuiltInComponents();

    const canvas = document.createElement('canvas');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    gameContainer.appendChild(canvas);

    const engine = new ParallaxEngine();
    (window as any).__everythingGameEngine = engine;

    setLoadingText('Starting engine…');
    setProgress(10);

    await engine.startEngine(canvas, {
        name: 'EverythingGame',
        settings: {
            // We drive all movement ourselves, no physics/gravity needed yet.
            physics: { gravity: [0, 0, 0] },
        },
    });

    // Game mode (not editor) so render/tick runs normally.
    engine.setEditorMode(false);

    const ctx = engine.globalContext;
    const renderSystem = ctx.renderSystem;
    const inputSystem = ctx.inputSystem;

    // ── Scene ───────────────────────────────────────────────────────
    const scene = new Scene();
    scene.name = 'Bay Area';
    // Tune ambient to the template values.
    scene.environment.ambientLight = {
        color: [0.45, 0.48, 0.55],
        intensity: 0.35,
    };
    engine.setActiveScene(scene);
    // Register with worldManager so scene.tick() drives entity/component updates.
    (scene as any).id = 1;
    (ctx.worldManager as any).scenes.set(scene.id, scene);
    (ctx.worldManager as any).activeScene = scene;

    // Reuse the editor's singleton context for mesh uploads + graphics quality.
    // It's the same plumbing published games use via play.ts.
    const editorCtx = EditorContext.instance;
    editorCtx.engine = engine;
    const savedQuality = (localStorage.getItem('graphics_quality') as 'low' | 'medium' | 'high') ?? 'medium';
    editorCtx.setGraphicsQuality(savedQuality);

    // ── Sun ─────────────────────────────────────────────────────────
    // A directional LightComponent pulls its direction from the entity's
    // TransformComponent forward. We build a quaternion that rotates
    // (0, 0, -1) onto the template's sun_direction.
    {
        const sunDir = new Vec3(0.3, -0.8, 0.2).normalize();
        const defaultFwd = new Vec3(0, 0, -1);
        // axis = defaultFwd × sunDir, angle = acos(defaultFwd · sunDir)
        const dot = defaultFwd.x * sunDir.x + defaultFwd.y * sunDir.y + defaultFwd.z * sunDir.z;
        const ax = defaultFwd.y * sunDir.z - defaultFwd.z * sunDir.y;
        const ay = defaultFwd.z * sunDir.x - defaultFwd.x * sunDir.z;
        const az = defaultFwd.x * sunDir.y - defaultFwd.y * sunDir.x;
        const axLen = Math.hypot(ax, ay, az);
        const sunRot = axLen > 1e-6
            ? Quat.fromAxisAngle(new Vec3(ax / axLen, ay / axLen, az / axLen), Math.acos(Math.max(-1, Math.min(1, dot))))
            : new Quat();

        const sun = scene.createEntity('Sun');
        sun.addTag('sun');
        sun.addComponent('TransformComponent', {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: sunRot.data[0], y: sunRot.data[1], z: sunRot.data[2], w: sunRot.data[3] },
        });
        sun.addComponent('LightComponent', {
            lightType: 'directional',
            color: [1.0, 0.96, 0.88, 1.0],
            intensity: 5.0,
            castShadows: false,
        });
    }

    // ── Heightmap terrain ───────────────────────────────────────────
    setLoadingText('Loading terrain…');
    setProgress(25);

    const terrain = new HeightmapTerrain(scene, {
        metaUrl: HEIGHTMAP_META_URL,
        waterLevel: WATER_LEVEL,
    });

    // Textures are loaded asynchronously once the heightmap geometry lands.
    // We wait for onReady before declaring the world ready — ensures the
    // first rendered frame has the terrain in place.
    const terrainReady = new Promise<void>((resolve) => {
        terrain.onReady = () => resolve();
    });

    // ── Streamed buildings / roads / props ──────────────────────────
    setLoadingText('Connecting to world…');
    setProgress(45);

    const streamedBuildings = new StreamedBuildings(scene, renderSystem, {
        assetBasePath: ASSET_BASE_CHUNKS,
        loadRadius: STREAM_LOAD_RADIUS,
        unloadRadius: STREAM_UNLOAD_RADIUS,
        baseColor: BUILDING_BASE_COLOR,
    });

    const device = renderSystem.getDevice();
    if (!device) {
        showError('GPU device unavailable.');
        return;
    }
    const streamedRoads = new StreamedRoads(device, { assetBasePath: ASSET_BASE_CHUNKS });

    const streamedProps = new StreamedProps(scene, renderSystem, {
        assetBasePath: ASSET_BASE_CHUNKS,
        loadRadius: STREAM_LOAD_RADIUS,
        unloadRadius: STREAM_UNLOAD_RADIUS,
    });

    // Wait for terrain heightmap, then wire in the PBR ground + road overlay.
    await terrainReady;
    setLoadingText('Loading ground textures…');
    setProgress(70);

    // Upload the heightmap mesh + any placed primitives to GPU. Mirrors the
    // editor's ViewportPanel.initHeightmapTerrain -> onReady path.
    editorCtx.ensurePrimitiveMeshes();

    try {
        const arrays = await loadTerrainTextureArrays(device, {
            worldWidth:   terrain.worldWidth,
            worldDepth:   terrain.worldDepth,
            originX:      terrain.originX,
            originZ:      terrain.originZ,
            contentWidth: terrain.contentWidth,
            contentDepth: terrain.contentDepth,
        });
        terrain.applyTerrainTextures(
            arrays,
            streamedRoads.atlas.nearTexture,
            streamedRoads.atlas.farTexture,
        );
    } catch (err) {
        console.warn('[EverythingGame] Terrain textures failed to load:', err);
    }

    // ── Camera state (free-fly) ─────────────────────────────────────
    const camPos = new Vec3(SPAWN_POS.x, SPAWN_POS.y, SPAWN_POS.z);
    let yaw = 0;   // radians, around +Y
    let pitch = 0; // radians, around camera-right

    // Hook per-frame camera + stream updates into the engine loop, after
    // input ticks and before render. `onPostAnimation` runs at step 5.5 of
    // the engine frame, which is ideal timing.
    engine.onPostAnimation((dt: number) => {
        // Mouse look (only when pointer is locked — otherwise deltas from
        // the overlay drag would yank the view).
        if (document.pointerLockElement === canvas) {
            const dx = inputSystem.getMouseDeltaX();
            const dy = inputSystem.getMouseDeltaY();
            yaw -= dx * MOUSE_SENS;
            pitch -= dy * MOUSE_SENS;
            const maxPitch = Math.PI / 2 - 0.01;
            if (pitch > maxPitch) pitch = maxPitch;
            if (pitch < -maxPitch) pitch = -maxPitch;
        }

        // Forward/right vectors from yaw (ignore pitch for horizontal motion
        // — classic FPS feel where looking up doesn't fling you skyward).
        const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
        const forward = new Vec3(-sinY, 0, -cosY);
        const right = new Vec3(cosY, 0, -sinY);

        let vx = 0, vy = 0, vz = 0;
        if (inputSystem.isKeyDown('KeyW')) { vx += forward.x; vy += forward.y; vz += forward.z; }
        if (inputSystem.isKeyDown('KeyS')) { vx -= forward.x; vy -= forward.y; vz -= forward.z; }
        if (inputSystem.isKeyDown('KeyD')) { vx += right.x; vy += right.y; vz += right.z; }
        if (inputSystem.isKeyDown('KeyA')) { vx -= right.x; vy -= right.y; vz -= right.z; }
        if (inputSystem.isKeyDown('Space')) { vy += 1; }
        if (inputSystem.isKeyDown('ShiftLeft') || inputSystem.isKeyDown('ShiftRight')) {
            // Shift doubles as sprint when paired with WASD, and as descend otherwise.
            if (vx !== 0 || vz !== 0) {
                vx *= SPRINT_MULT; vy *= SPRINT_MULT; vz *= SPRINT_MULT;
            } else {
                vy -= 1;
            }
        }

        const len = Math.hypot(vx, vy, vz);
        if (len > 0) {
            const step = MOVE_SPEED * dt;
            camPos.x += (vx / len) * step;
            camPos.y += (vy / len) * step;
            camPos.z += (vz / len) * step;
        }

        // Build view/projection and push to render system.
        const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
        const look = new Vec3(
            camPos.x + (-sinY * cosP),
            camPos.y + sinP,
            camPos.z + (-cosY * cosP),
        );
        const up = new Vec3(0, 1, 0);
        const view = Mat4.lookAt(camPos, look, up);
        const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
        const proj = Mat4.perspective(CAM_FOV, aspect, CAM_NEAR, CAM_FAR);

        renderSystem.setActiveCamera({
            viewMatrix: view,
            projectionMatrix: proj,
            position: camPos,
            near: CAM_NEAR,
            far: CAM_FAR,
            fovY: CAM_FOV,
        });

        // Camera-driven streaming updates.
        terrain.update(camPos);
        streamedBuildings.update(camPos);
        streamedRoads.update(camPos);
        renderSystem.setDecals(streamedRoads.collectDecals());
        streamedProps.update(camPos);
    });

    // ── Canvas sizing ───────────────────────────────────────────────
    const resize = () => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(window.innerWidth * dpr);
        canvas.height = Math.floor(window.innerHeight * dpr);
        renderSystem.onCanvasResize(canvas.width, canvas.height);
    };
    window.addEventListener('resize', resize);
    resize();

    // ── Pointer lock for mouse look ─────────────────────────────────
    const requestLock = () => {
        try { canvas.requestPointerLock(); } catch { /* ignore */ }
    };
    clickOverlay.addEventListener('mousedown', requestLock);
    canvas.addEventListener('mousedown', () => {
        if (document.pointerLockElement !== canvas) requestLock();
    });
    document.addEventListener('pointerlockchange', () => {
        clickOverlay.style.display = document.pointerLockElement === canvas ? 'none' : 'flex';
    });

    // ── FPS counter ─────────────────────────────────────────────────
    let frames = 0;
    let lastFpsTime = performance.now();
    const tickFps = () => {
        frames++;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
            fpsCounter.textContent = `${frames} FPS`;
            frames = 0;
            lastFpsTime = now;
        }
        requestAnimationFrame(tickFps);
    };
    requestAnimationFrame(tickFps);

    // ── Reveal ──────────────────────────────────────────────────────
    setProgress(95);
    setLoadingText('Finalizing…');
    await splashPromise;
    splashScreen.style.display = 'none';
    loadingScreen.style.display = 'flex';
    // Give the first chunks a moment to land before hiding the loading
    // screen so the player doesn't see a blank world.
    await new Promise((r) => setTimeout(r, 400));
    setProgress(100);
    loadingScreen.style.display = 'none';

    fpsCounter.style.display = 'block';
    clickOverlay.style.display = 'flex';
}

boot().catch((err) => {
    console.error('[EverythingGame] Boot failed:', err);
    showError(err?.message || 'Unknown error while loading the world.');
});
