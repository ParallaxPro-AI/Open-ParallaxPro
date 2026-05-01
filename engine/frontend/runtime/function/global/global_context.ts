import { GPUDeviceManager } from '../../platform/gpu/gpu_device.js';
import { GL2DeviceManager } from '../../platform/gpu/gl2_device.js';
import { CanvasManager } from '../../platform/canvas/canvas_manager.js';
import { InputDevice } from '../../platform/input/input_device.js';
import { HttpClient } from '../../platform/network/http_client.js';
import { LocalCache } from '../../platform/storage/local_cache.js';

import { RenderSystem } from '../render/render_system.js';
import { RenderSystemWebGL2 } from '../render/gl2/render_system_gl2.js';
import { IRenderer, GfxBackend } from '../render/i_renderer.js';
import { PhysicsSystem } from '../physics/physics_system.js';
import { AnimationSystem } from '../animation/animation_system.js';
import { AudioSystem } from '../audio/audio_system.js';
import { InputSystem, connectInputDevice } from '../input/input_system.js';
import { attachMobileInputOverlay, MobileInputOverlay } from '../../../../shared/input/mobile_input_overlay.js';
import { ControlManifest } from '../../../../shared/input/control_manifest.js';
import { ScriptSystem } from '../scripting/script_system.js';
import { NetworkSystem } from '../network/network_system.js';
import { MultiplayerSession } from '../network/multiplayer_session.js';
import { WorldManager } from '../framework/world_manager.js';
import { Vec3 } from '../../core/math/vec3.js';
import { SeededRandom } from '../../core/math/seeded_random.js';
import { setUseFacingRegistry } from '../../../editor/src/utils/glb_loader.js';

/**
 * Central registry holding all engine systems.
 * Provides ordered initialization and shutdown of all subsystems.
 *
 * Backend selection: WebGPU is preferred. WebGL2 is the fallback for
 * browsers without WebGPU (older iOS, Firefox-without-flag, etc.). The
 * `backend` field is set in `startSystems` based on the caller's choice
 * (defaulting to 'webgpu' for backward compatibility with old callers
 * that don't pass it).
 */
export class RuntimeGlobalContext {
    backend: GfxBackend = 'webgpu';
    readonly gpuDevice: GPUDeviceManager = new GPUDeviceManager();
    readonly gl2Device: GL2DeviceManager = new GL2DeviceManager();
    readonly canvasManager: CanvasManager = new CanvasManager();
    readonly inputDevice: InputDevice = new InputDevice();
    readonly httpClient: HttpClient = new HttpClient();
    readonly localCache: LocalCache = new LocalCache();

    /**
     * Live renderer. Default-constructs the WebGPU `RenderSystem` so the
     * field is always populated (legacy callers reference it before
     * `startSystems` has run). Replaced with `RenderSystemWebGL2` in
     * `startSystems` when backend === 'webgl2'.
     */
    renderSystem: IRenderer = new RenderSystem();
    readonly physicsSystem: PhysicsSystem = new PhysicsSystem();
    readonly animationSystem: AnimationSystem = new AnimationSystem();
    readonly audioSystem: AudioSystem = new AudioSystem();
    readonly inputSystem: InputSystem = new InputSystem();
    readonly scriptSystem: ScriptSystem = new ScriptSystem();
    readonly networkSystem: NetworkSystem = new NetworkSystem();
    readonly multiplayerSession: MultiplayerSession = new MultiplayerSession();
    readonly worldManager: WorldManager = new WorldManager();
    readonly random: SeededRandom = new SeededRandom();

    projectConfig: any = null;
    /** Mobile-controls overlay handle, created during startSystems if a controlsManifest is provided. */
    mobileOverlay: MobileInputOverlay | null = null;

    async startSystems(canvas: HTMLCanvasElement, projectConfig?: any, backend: GfxBackend = 'webgpu'): Promise<void> {
        this.projectConfig = projectConfig ?? null;
        this.backend = backend;
        console.log(`[engine] gfx backend: ${backend}`);

        // Asset-normalization registry (MODEL_FACING.json) is opt-in per
        // project. New projects are stamped with `useFacingRegistry: true`
        // by every "create project" path. Old projects (saved before that
        // field existed) leave it undefined → engine treats as off → their
        // hand-tuned mesh.scale / modelRotationY values apply unchanged.
        // Default to ON — only legacy projects with hand-tuned mesh.scale +
        // modelRotationY should opt out, and they do that by setting
        // `useFacingRegistry: false` explicitly. Earlier the default was
        // OFF and only new-from-template projects (projects.ts:243) got
        // the flag flipped on; regen / open-old-project paths missed it,
        // leaving every model unscaled / unrotated until the user noticed
        // and rage-edited project_data by hand.
        setUseFacingRegistry(projectConfig?.useFacingRegistry !== false);

        // Platform layer
        this.canvasManager.initialize(canvas);
        if (backend === 'webgpu') {
            await this.gpuDevice.initialize(canvas);
        } else {
            this.gl2Device.initialize(canvas);
            // Replace the default-constructed WebGPU RenderSystem with
            // the WebGL2 sibling. Runs once per process; the next play
            // session reuses the same context.
            this.renderSystem = new RenderSystemWebGL2();
        }
        this.inputDevice.initialize(canvas);

        // Function layer (in dependency order)
        connectInputDevice(this.inputSystem, this.inputDevice);

        // Mobile control overlay — manifest-driven on-screen joystick + buttons
        // for touch devices. The overlay injects into the same InputSystem the
        // desktop pipeline uses, so behaviors that poll `isKeyDown(...)` work
        // unchanged on mobile. No-op on non-touch devices.
        const controlsManifest: ControlManifest | undefined =
            projectConfig?.controlsManifest || projectConfig?.controls;
        try {
            // Non-overlay touch path (primary touch as mouse) is suppressed
            // when the overlay is active. The overlay owns viewport-tap
            // handling itself and routes it through injectMouseButtonDown,
            // so the legacy primary-touch shim would double-fire. We flip
            // this flag in `onAttach` rather than after the attach call so
            // the deferred-attach path (overlay materializes later, after
            // matchMedia settles) also gets the suppression — otherwise
            // the legacy shim keeps firing forever and double-fires every
            // tap once the deferred overlay finally shows up.
            // Multiplayer detection drives whether the system tray's
            // Chat / Voice buttons are included. flow.multiplayer.enabled
            // is the canonical signal — text_chat + voice_chat HUDs are
            // no-ops without other peers.
            const isMultiplayer = projectConfig?.multiplayer?.enabled === true;
            this.mobileOverlay = attachMobileInputOverlay({
                canvas,
                inputSystem: this.inputSystem,
                manifest: controlsManifest,
                isMultiplayer,
                onAttach: ({ enabled }) => {
                    this.inputDevice.suppressLegacyTouchAsMouse = enabled;
                },
            });
        } catch (e) {
            console.warn('[engine] mobile overlay attach failed:', e);
        }

        const gravity = projectConfig?.settings?.physics?.gravity;
        const fixedTimestep = projectConfig?.settings?.physics?.fixedTimestep;
        await this.physicsSystem.initialize(
            gravity ? new Vec3(gravity[0], gravity[1], gravity[2]) : undefined,
            fixedTimestep
        );

        if (backend === 'webgpu') {
            await (this.renderSystem as RenderSystem).initialize(this.gpuDevice, this.canvasManager);
        } else {
            await (this.renderSystem as RenderSystemWebGL2).initialize(this.gl2Device, this.canvasManager);
        }
        this.animationSystem.initialize();
        this.audioSystem.initialize();
        this.scriptSystem.initialize(this.inputSystem);

        const interpolationDelay = projectConfig?.settings?.network?.interpolationDelay;
        const tickRate = projectConfig?.settings?.network?.tickRate;
        this.networkSystem.initialize(interpolationDelay, tickRate);

        await this.worldManager.initialize(null, null);

        const dbName = projectConfig?.name ? `parallaxpro_${projectConfig.name}` : 'parallaxpro_cache';
        await this.localCache.initialize(dbName);
    }

    shutdownSystems(): void {
        this.multiplayerSession.disconnect();
        this.networkSystem.shutdown();
        this.scriptSystem.shutdown();
        this.audioSystem.shutdown();
        this.animationSystem.shutdown();
        this.renderSystem.shutdown();
        this.physicsSystem.shutdown();
        this.inputSystem.shutdown();

        if (this.mobileOverlay) {
            try { this.mobileOverlay.destroy(); } catch { /* swallow */ }
            this.mobileOverlay = null;
        }

        this.inputDevice.destroy();
        if (this.backend === 'webgpu') {
            this.gpuDevice.destroy();
        } else {
            this.gl2Device.destroy();
        }
        this.canvasManager.destroy();

        this.projectConfig = null;
    }
}
