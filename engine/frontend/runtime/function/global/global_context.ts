import { GPUDeviceManager } from '../../platform/gpu/gpu_device.js';
import { CanvasManager } from '../../platform/canvas/canvas_manager.js';
import { InputDevice } from '../../platform/input/input_device.js';
import { HttpClient } from '../../platform/network/http_client.js';
import { LocalCache } from '../../platform/storage/local_cache.js';

import { RenderSystem } from '../render/render_system.js';
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
 */
export class RuntimeGlobalContext {
    readonly gpuDevice: GPUDeviceManager = new GPUDeviceManager();
    readonly canvasManager: CanvasManager = new CanvasManager();
    readonly inputDevice: InputDevice = new InputDevice();
    readonly httpClient: HttpClient = new HttpClient();
    readonly localCache: LocalCache = new LocalCache();

    readonly renderSystem: RenderSystem = new RenderSystem();
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

    async startSystems(canvas: HTMLCanvasElement, projectConfig?: any): Promise<void> {
        this.projectConfig = projectConfig ?? null;

        // Asset-normalization registry (MODEL_FACING.json) is opt-in per
        // project. New projects are stamped with `useFacingRegistry: true`
        // by every "create project" path. Old projects (saved before that
        // field existed) leave it undefined → engine treats as off → their
        // hand-tuned mesh.scale / modelRotationY values apply unchanged.
        setUseFacingRegistry(projectConfig?.useFacingRegistry === true);

        // Platform layer
        this.canvasManager.initialize(canvas);
        await this.gpuDevice.initialize(canvas);
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
            this.mobileOverlay = attachMobileInputOverlay({
                canvas,
                inputSystem: this.inputSystem,
                manifest: controlsManifest,
            });
            // Non-overlay touch path (primary touch as mouse) is suppressed
            // when the overlay is active. The overlay owns viewport-tap
            // handling itself and routes it through injectMouseButtonDown,
            // so the legacy primary-touch shim would double-fire.
            this.inputDevice.suppressLegacyTouchAsMouse = this.mobileOverlay.isEnabled();
        } catch (e) {
            console.warn('[engine] mobile overlay attach failed:', e);
        }

        const gravity = projectConfig?.settings?.physics?.gravity;
        const fixedTimestep = projectConfig?.settings?.physics?.fixedTimestep;
        await this.physicsSystem.initialize(
            gravity ? new Vec3(gravity[0], gravity[1], gravity[2]) : undefined,
            fixedTimestep
        );

        await this.renderSystem.initialize(this.gpuDevice, this.canvasManager);
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
        this.gpuDevice.destroy();
        this.canvasManager.destroy();

        this.projectConfig = null;
    }
}
