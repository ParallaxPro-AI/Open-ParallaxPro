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
        // iOS Safari requires AudioContext creation + resume inside a
        // user gesture. touchend is more reliable than touchstart on iOS.
        // Listen on document (capture) so overlay taps are caught too.
        const resumeAudio = () => {
            this.globalContext.audioSystem.resume();
            for (const [target, events, opts] of audioListeners) {
                for (const ev of events) target.removeEventListener(ev, resumeAudio, opts as any);
            }
        };
        const audioListeners: [EventTarget, string[], boolean | undefined][] = [
            [canvasElement, ['click', 'keydown', 'touchstart', 'touchend'], undefined],
            [document, ['click', 'touchstart', 'touchend'], true],
        ];
        for (const [target, events, opts] of audioListeners) {
            for (const ev of events) target.addEventListener(ev, resumeAudio, opts as any);
        }

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
     *
     * On entering editor mode (Stop), reset per-Play state so a subsequent
     * Play starts clean: animators get stop()'d so they don't drag stale
     * currentClip/currentTime into the second Play, and script instances
     * are marked unstarted so their `onStart` re-fires. Without these,
     * users observed "animations stop working after Play→Stop→Play"
     * because behaviors that cached `_currentAnim` from first Play
     * never called playAnimation again and the animator silently
     * no-op'd. Documented in iteration-6 user report on multiple games.
     */
    setEditorMode(enabled: boolean): void {
        this.isEditorMode = enabled;
        if (enabled) {
            this.globalContext.physicsSystem.shutdown();
            // Reset animators so second Play starts from a clean state.
            // We call stop() (zeros currentTime, isPlaying=false) rather
            // than onDestroy() (clears clips + skeleton — too aggressive
            // because we'd have to re-initialize from JSON on next Play).
            if (this.activeScene) {
                for (const entity of this.activeScene.entities.values()) {
                    const animator: any = entity.getComponent('AnimatorComponent');
                    if (animator?.stop) {
                        try { animator.stop(); } catch (e) { /* swallow */ }
                    }
                }
            }
            // Mark scripts as unstarted so onStart re-fires on next Play.
            this.globalContext.scriptSystem.resetForReplay();
            // Drop cached skinning bind groups. The cache key is
            // `${idx}_${jointBuf.label}` and every joint buffer uses the
            // same label `'joint_matrices'` (render_system.ts:267), so
            // the key is effectively just the model-pool index. Across
            // a Play→Stop→Play cycle, entity render order can shift and
            // the cached bind group at a slot ends up referencing the
            // wrong (model, joint) pair → characters render in T-pose
            // even though the animator ticks correctly. User report
            // (iteration 6, multi-game): "after I press Play on the
            // editor, then Stop, then Play again, the animations all
            // don't work anymore."
            try { this.globalContext.renderSystem.clearSkinningCaches(); } catch { /* swallow */ }
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
