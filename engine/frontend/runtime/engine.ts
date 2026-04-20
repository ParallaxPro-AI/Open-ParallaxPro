import { RuntimeGlobalContext } from './function/global/global_context.js';
import { Scene } from './function/framework/scene.js';
import { PerfRecorder, PerfSnapshotCore } from './function/profiling/perf_recorder.js';

export interface PerfSnapshot extends PerfSnapshotCore {
    fps: number;
    scripts: Array<{ name: string; totalMs: number; calls: number }>;
    gpu: {
        supported: boolean;
        passes: Array<{ name: string; avgMs: number; maxMs: number }>;
    };
    renderer: {
        drawCalls: number;
        triangles: number;
        meshesRendered: number;
        meshesTotal: number;
    };
    counts: {
        entities: number;
        scripts: number;
        meshes: number;
    };
}

export class ParallaxEngine {
    globalContext: RuntimeGlobalContext = new RuntimeGlobalContext();
    isQuit: boolean = false;
    isRunning: boolean = false;
    isEditorMode: boolean = false;
    readonly perf: PerfRecorder = new PerfRecorder();

    private lastTimestamp: number = 0;
    private fps: number = 0;
    private frameCount: number = 0;
    private fpsAccumulator: number = 0;
    private postRenderCallbacks: Array<() => void> = [];
    private postAnimationCallbacks: Array<(dt: number) => void> = [];
    private animFrameId: number = 0;
    private totalTime: number = 0;
    private activeScene: Scene | null = null;
    /**
     * Completion promise for the PREVIOUS frame's GPU submission. The loop
     * awaits this before starting the next frame's CPU work, which caps
     * GPU queue depth at ~2 and keeps input lag tracking GPU frame time
     * instead of piling up to ~400 ms on slow-GPU machines.
     */
    private prevFrameGPUDone: Promise<void> | null = null;

    async startEngine(canvasElement: HTMLCanvasElement, projectConfig: any): Promise<void> {
        await this.initialize();
        await this.globalContext.startSystems(canvasElement, projectConfig);

        // Resume audio context on first user interaction.
        // Mobile browsers require the resume to happen inside a user
        // gesture handler. Listen on document too so taps on touch
        // control overlays (which sit above the canvas) still unlock.
        const resumeAudio = () => {
            this.globalContext.audioSystem.resume();
            canvasElement.removeEventListener('click', resumeAudio);
            canvasElement.removeEventListener('keydown', resumeAudio);
            canvasElement.removeEventListener('touchstart', resumeAudio);
            document.removeEventListener('click', resumeAudio, true);
            document.removeEventListener('touchstart', resumeAudio, true);
        };
        canvasElement.addEventListener('click', resumeAudio);
        canvasElement.addEventListener('keydown', resumeAudio);
        canvasElement.addEventListener('touchstart', resumeAudio);
        document.addEventListener('click', resumeAudio, true);
        document.addEventListener('touchstart', resumeAudio, true);

        this.run();
    }

    async initialize(): Promise<void> {
        this.isQuit = false;
        this.isRunning = false;
        this.lastTimestamp = 0;
        this.fps = 0;
        this.frameCount = 0;
        this.fpsAccumulator = 0;
        this.totalTime = 0;
    }

    run(): void {
        this.isRunning = true;
        this.lastTimestamp = performance.now() / 1000;

        const loop = async () => {
            if (this.isQuit) {
                this.isRunning = false;
                return;
            }

            // Frame pacing: block on the previous frame's GPU completion
            // before starting this one. Without this, rAF keeps submitting
            // at ~35 Hz while the GPU drains at ~20 Hz, building an 8-deep
            // queue and ~400 ms of input lag that feels like single-digit
            // fps even when the canvas technically paints often. After
            // this, queue depth is ~2 and perceived responsiveness tracks
            // actual GPU throughput.
            if (this.prevFrameGPUDone) {
                try { await this.prevFrameGPUDone; } catch { /* ignore */ }
                this.prevFrameGPUDone = null;
            }

            if (this.isQuit) { this.isRunning = false; return; }

            const now = performance.now() / 1000;
            let deltaTime = now - this.lastTimestamp;
            this.lastTimestamp = now;

            // Clamp delta time to prevent huge jumps (e.g. after tab switch)
            deltaTime = Math.min(deltaTime, 0.1);

            this.totalTime += deltaTime;
            this.frameCount++;

            try {
                this.tickOneFrame(deltaTime);
            } catch (e) {
                console.error('[Engine] Error in game loop frame:', e);
            }

            // Capture a completion handle for this frame's just-submitted
            // GPU work so the next iteration can await it.
            try {
                const device = this.globalContext.gpuDevice.getDevice();
                this.prevFrameGPUDone = device.queue.onSubmittedWorkDone();
            } catch { this.prevFrameGPUDone = null; }

            this.animFrameId = requestAnimationFrame(loop);
        };

        this.animFrameId = requestAnimationFrame(loop);
    }

    stop(): void {
        this.isQuit = true;
        if (this.animFrameId) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = 0;
        }
        this.isRunning = false;
    }

    /**
     * Toggle editor mode. In editor mode, physics/scripts/network are paused.
     * Physics is only shut down when returning to editor mode, not when entering
     * play mode -- the physics state is already clean from the previous stop() call.
     */
    setEditorMode(enabled: boolean): void {
        this.isEditorMode = enabled;
        if (enabled) {
            this.globalContext.physicsSystem.shutdown();
        }
    }

    setActiveScene(scene: Scene | null): void {
        this.activeScene = scene;
    }

    shutdown(): void {
        this.stop();
        this.globalContext.shutdownSystems();
        this.postRenderCallbacks.length = 0;
        this.postAnimationCallbacks.length = 0;
        this.activeScene = null;
    }

    /**
     * Tick one frame of the engine.
     *
     * Frame order:
     * 1.  Input (always)
     * 2.  Network (game mode only)
     * 3.  Scripts update (game mode only)
     * 4.  Physics (game mode only)
     * 5.  Animation (always)
     * 6.  Scripts late update (game mode only)
     * 7.  World manager (always)
     * 8.  Audio (game mode only)
     * 9.  Render (always)
     * 10. Post-render callbacks
     * 11. FPS calculation
     * 12. Input endFrame
     */
    tickOneFrame(deltaTime: number): void {
        const ctx = this.globalContext;
        const gameMode = !this.isEditorMode;
        const perf = this.perf;

        perf.beginFrame();

        perf.beginPhase('input');
        ctx.inputSystem.tick();
        perf.endPhase();

        if (gameMode) {
            perf.beginPhase('network');
            ctx.networkSystem.tick(deltaTime);
            ctx.multiplayerSession.tick(deltaTime, this.totalTime);
            perf.endPhase();
        }

        if (gameMode) {
            perf.beginPhase('scripts.update');
            ctx.scriptSystem.setTimeInfo(this.totalTime, deltaTime, this.frameCount);
            ctx.scriptSystem.tickUpdate();
            perf.endPhase();
        }

        if (gameMode) {
            perf.beginPhase('physics');
            try {
                const physicsSteps = ctx.physicsSystem.tick(deltaTime, this.activeScene);

                const fixedDt = ctx.physicsSystem.getFixedTimestep();
                for (let i = 0; i < physicsSteps; i++) {
                    ctx.scriptSystem.tickFixedUpdate(fixedDt);
                }

                for (const evt of ctx.physicsSystem.getContactEvents()) {
                    ctx.scriptSystem.notifyContactEvent(evt.type, evt.a, evt.b);
                }
                for (const evt of ctx.physicsSystem.getTriggerEvents()) {
                    ctx.scriptSystem.notifyTriggerEvent(evt.type, evt.a, evt.b);
                }
            } catch (e) {
                console.error('[Engine] Physics tick error:', e);
            }
            perf.endPhase();
        }

        perf.beginPhase('animation');
        ctx.animationSystem.tick(deltaTime);
        if (this.activeScene) {
            for (const entity of this.activeScene.entities.values()) {
                if (!entity.active) continue;
                const animator = entity.getComponent('AnimatorComponent') as any;
                if (!animator) continue;

                if (!animator.isPlaying) continue;
                animator.tick(deltaTime);
                if (animator.gpuJointMatricesBuffer && animator.jointMatrices?.length > 0) {
                    ctx.renderSystem.updateJointMatrices(animator.gpuJointMatricesBuffer, animator.jointMatrices);
                }
            }
        }
        perf.endPhase();

        perf.beginPhase('post-animation');
        for (const callback of this.postAnimationCallbacks) {
            try {
                callback(deltaTime);
            } catch (e) {
                console.error('[Engine] Post-animation callback error:', e);
            }
        }
        perf.endPhase();

        if (gameMode) {
            perf.beginPhase('scripts.lateUpdate');
            ctx.scriptSystem.tickLateUpdate();
            perf.endPhase();
        }

        perf.beginPhase('particles');
        if (this.activeScene) {
            this.activeScene.tickParticles(deltaTime);
        }
        perf.endPhase();

        perf.beginPhase('worldManager');
        ctx.worldManager.tick(deltaTime);
        perf.endPhase();

        // Day/Night is trivial (arithmetic only) — fold into worldManager phase.
        if (gameMode && this.activeScene) {
            const env = this.activeScene.environment;
            if (env.dayNightCycleSpeed > 0) {
                env.timeOfDay += (deltaTime * env.dayNightCycleSpeed) / 3600;
                env.timeOfDay = env.timeOfDay % 24;
                if (env.timeOfDay < 0) env.timeOfDay += 24;
            }
        }

        if (gameMode) {
            perf.beginPhase('audio');
            ctx.audioSystem.tick(deltaTime);
            perf.endPhase();
        }

        perf.beginPhase('render');
        ctx.renderSystem.tick(deltaTime, this.activeScene);
        perf.endPhase();

        perf.beginPhase('post-render');
        for (const callback of this.postRenderCallbacks) {
            try {
                callback();
            } catch (e) {
                console.error('[Engine] Post-render callback error:', e);
            }
        }
        perf.endPhase();

        this.calculateFPS(deltaTime);
        ctx.inputSystem.endFrame();

        perf.endFrame();
    }

    private calculateFPS(deltaTime: number): void {
        this.fpsAccumulator += deltaTime;
        if (this.fpsAccumulator >= 1.0) {
            this.fps = Math.round(1.0 / deltaTime);
            this.fpsAccumulator = 0;
        }
    }

    getFPS(): number { return this.fps; }
    getTotalTime(): number { return this.totalTime; }
    getFrameCount(): number { return this.frameCount; }

    /**
     * Produce a rolling-window snapshot of engine performance for the
     * editor's Performance Profiler panel. Combines PerfRecorder's
     * per-phase history with subsystem-specific stats (script timings,
     * renderer draw-call counts, GPU pass timings, object counts).
     * Cheap to call — aggregation is O(phases × FRAME_BUFFER_SIZE).
     */
    getPerfSnapshot(): PerfSnapshot {
        const core = this.perf.snapshot();
        const ctx = this.globalContext;
        const scriptSystem: any = ctx.scriptSystem;
        const renderSystem: any = ctx.renderSystem;

        const scripts = typeof scriptSystem.getScriptTimings === 'function'
            ? scriptSystem.getScriptTimings()
            : [];
        const gpu = typeof renderSystem.getGpuTimings === 'function'
            ? renderSystem.getGpuTimings()
            : { supported: false, passes: [] };
        const renderer = typeof renderSystem.getRenderStats === 'function'
            ? renderSystem.getRenderStats()
            : { drawCalls: 0, triangles: 0, meshesRendered: 0, meshesTotal: 0 };
        const meshCount = renderSystem.renderScene?.meshes?.length ?? 0;

        return {
            ...core,
            fps: this.fps,
            scripts,
            gpu,
            renderer,
            counts: {
                entities: this.activeScene?.entities.size ?? 0,
                scripts: typeof scriptSystem.getInstanceCount === 'function' ? scriptSystem.getInstanceCount() : 0,
                meshes: meshCount,
            },
        };
    }

    onPostRender(callback: () => void): void {
        this.postRenderCallbacks.push(callback);
    }

    removePostRender(callback: () => void): void {
        const index = this.postRenderCallbacks.indexOf(callback);
        if (index !== -1) {
            this.postRenderCallbacks.splice(index, 1);
        }
    }

    onPostAnimation(callback: (dt: number) => void): void {
        this.postAnimationCallbacks.push(callback);
    }

    removePostAnimation(callback: (dt: number) => void): void {
        const index = this.postAnimationCallbacks.indexOf(callback);
        if (index !== -1) {
            this.postAnimationCallbacks.splice(index, 1);
        }
    }
}
