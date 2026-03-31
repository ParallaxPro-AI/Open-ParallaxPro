import { RuntimeGlobalContext } from './function/global/global_context.js';
import { Scene } from './function/framework/scene.js';

export class ParallaxEngine {
    globalContext: RuntimeGlobalContext = new RuntimeGlobalContext();
    isQuit: boolean = false;
    isRunning: boolean = false;
    isEditorMode: boolean = false;

    private lastTimestamp: number = 0;
    private fps: number = 0;
    private frameCount: number = 0;
    private fpsAccumulator: number = 0;
    private postRenderCallbacks: Array<() => void> = [];
    private postAnimationCallbacks: Array<(dt: number) => void> = [];
    private animFrameId: number = 0;
    private totalTime: number = 0;
    private activeScene: Scene | null = null;

    async startEngine(canvasElement: HTMLCanvasElement, projectConfig: any): Promise<void> {
        await this.initialize();
        await this.globalContext.startSystems(canvasElement, projectConfig);

        // Resume audio context on first user interaction
        const resumeAudio = () => {
            this.globalContext.audioSystem.resume();
            canvasElement.removeEventListener('click', resumeAudio);
            canvasElement.removeEventListener('keydown', resumeAudio);
        };
        canvasElement.addEventListener('click', resumeAudio);
        canvasElement.addEventListener('keydown', resumeAudio);

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

        const loop = () => {
            if (this.isQuit) {
                this.isRunning = false;
                return;
            }

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

        // 1. Input
        ctx.inputSystem.tick();

        // 2. Network
        if (gameMode) {
            ctx.networkSystem.tick(deltaTime);
        }

        // 3. Scripts update
        if (gameMode) {
            ctx.scriptSystem.setTimeInfo(this.totalTime, deltaTime, this.frameCount);
            ctx.scriptSystem.tickUpdate();
        }

        // 4. Physics + fixed update
        if (gameMode) {
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
        }

        // 5. Animation
        ctx.animationSystem.tick(deltaTime);

        // 5.1 Tick ECS AnimatorComponents and update GPU joint matrices
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

        // 5.5 Post-animation callbacks (CPU skinning)
        for (const callback of this.postAnimationCallbacks) {
            try {
                callback(deltaTime);
            } catch (e) {
                console.error('[Engine] Post-animation callback error:', e);
            }
        }

        // 6. Scripts late update
        if (gameMode) {
            ctx.scriptSystem.tickLateUpdate();
        }

        // 6.5 Particle systems
        if (this.activeScene) {
            this.activeScene.tickParticles(deltaTime);
        }

        // 7. World manager
        ctx.worldManager.tick(deltaTime);

        // 7.5. Day/Night cycle
        if (gameMode && this.activeScene) {
            const env = this.activeScene.environment;
            if (env.dayNightCycleSpeed > 0) {
                env.timeOfDay += (deltaTime * env.dayNightCycleSpeed) / 3600;
                env.timeOfDay = env.timeOfDay % 24;
                if (env.timeOfDay < 0) env.timeOfDay += 24;
            }
        }

        // 8. Audio
        if (gameMode) {
            ctx.audioSystem.tick(deltaTime);
        }

        // 9. Render
        ctx.renderSystem.tick(deltaTime, this.activeScene);

        // 10. Post-render callbacks
        for (const callback of this.postRenderCallbacks) {
            try {
                callback();
            } catch (e) {
                console.error('[Engine] Post-render callback error:', e);
            }
        }

        // 11. FPS calculation
        this.calculateFPS(deltaTime);

        // 12. Input endFrame
        ctx.inputSystem.endFrame();
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
