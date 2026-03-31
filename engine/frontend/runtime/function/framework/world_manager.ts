import { Scene } from './scene.js';

/**
 * Manages scene lifecycle: load, unload, switch, and tick.
 *
 * Only one scene is active (ticking) at a time, but multiple can be loaded.
 * Supports scene transitions with fade effects and a scene data registry
 * for runtime scene switching by name.
 */
export class WorldManager {
    private scenes: Map<number, Scene> = new Map();
    private activeScene: Scene | null = null;
    private projectManager: any = null;
    private assetManager: any = null;
    private sceneIdCounter: number = 1;

    private sceneDataRegistry: Map<string, Record<string, any>> = new Map();
    private transitionOverlay: HTMLElement | null = null;
    private isTransitioning: boolean = false;

    /** Callback invoked after a scene is loaded (e.g. to reinitialize scripts). */
    onSceneLoaded: ((scene: Scene) => void) | null = null;

    async initialize(projectManager: any, assetManager: any): Promise<void> {
        this.projectManager = projectManager;
        this.assetManager = assetManager;
    }

    async loadScene(sceneURL: string): Promise<Scene> {
        let sceneData: Record<string, any>;

        if (this.projectManager && typeof this.projectManager.loadSceneData === 'function') {
            sceneData = await this.projectManager.loadSceneData(sceneURL);
        } else if (typeof fetch !== 'undefined') {
            const response = await fetch(sceneURL);
            sceneData = await response.json();
        } else {
            throw new Error(`Cannot load scene from URL: ${sceneURL}`);
        }

        return this.loadSceneFromData(sceneData);
    }

    async loadSceneFromData(sceneData: Record<string, any>): Promise<Scene> {
        const scene = Scene.fromJSON(sceneData);
        (scene as any).id = this.sceneIdCounter++;
        this.scenes.set(scene.id, scene);

        if (!this.activeScene) {
            this.activeScene = scene;
        }

        return scene;
    }

    async unloadScene(sceneId: number): Promise<void> {
        const scene = this.scenes.get(sceneId);
        if (!scene) return;

        const entityIds = Array.from(scene.entities.keys());
        for (const id of entityIds) {
            scene.destroyEntity(id);
        }

        this.scenes.delete(sceneId);

        if (this.activeScene && this.activeScene.id === sceneId) {
            this.activeScene = null;
        }
    }

    async loadDefaultScene(): Promise<void> {
        if (this.projectManager && typeof this.projectManager.getConfig === 'function') {
            const config = this.projectManager.getConfig();
            if (config && config.defaultSceneURL) {
                await this.loadScene(config.defaultSceneURL);
                return;
            }
        }

        const scene = this.createEmptyScene('Default Scene');
        this.activeScene = scene;
    }

    async saveCurrentScene(): Promise<void> {
        if (!this.activeScene) return;

        const sceneData = this.activeScene.toJSON();

        if (this.projectManager && typeof this.projectManager.saveSceneData === 'function') {
            await this.projectManager.saveSceneData(sceneData);
        }
    }

    // -- Tick -----------------------------------------------------------------

    tick(deltaTime: number): void {
        if (this.activeScene) {
            this.activeScene.tick(deltaTime);
        }
    }

    // -- Scene Management -----------------------------------------------------

    getActiveScene(): Scene | null {
        return this.activeScene;
    }

    setActiveScene(sceneId: number): void {
        const scene = this.scenes.get(sceneId);
        if (scene) {
            this.activeScene = scene;
        }
    }

    createEmptyScene(name: string = 'Untitled Scene'): Scene {
        const scene = new Scene();
        (scene as any).id = this.sceneIdCounter++;
        (scene as any).name = name;
        this.scenes.set(scene.id, scene);

        if (!this.activeScene) {
            this.activeScene = scene;
        }

        return scene;
    }

    getScene(sceneId: number): Scene | null {
        return this.scenes.get(sceneId) ?? null;
    }

    getLoadedScenes(): Scene[] {
        return Array.from(this.scenes.values());
    }

    // -- Scene Data Registry --------------------------------------------------

    registerSceneData(name: string, data: Record<string, any>): void {
        this.sceneDataRegistry.set(name, data);
    }

    getRegisteredSceneNames(): string[] {
        return Array.from(this.sceneDataRegistry.keys());
    }

    clearSceneDataRegistry(): void {
        this.sceneDataRegistry.clear();
    }

    // -- Scene Transitions ----------------------------------------------------

    async transitionToScene(sceneName: string, fadeMs: number = 300): Promise<void> {
        if (this.isTransitioning) return;

        let sceneData = this.sceneDataRegistry.get(sceneName);
        if (!sceneData) {
            sceneData = this.sceneDataRegistry.get(sceneName + '.scene.json');
            if (!sceneData) {
                sceneData = this.sceneDataRegistry.get('scenes/' + sceneName + '.scene.json');
            }
        }
        if (!sceneData) {
            console.warn(`[WorldManager] Scene not found: ${sceneName}`);
            return;
        }

        this.isTransitioning = true;

        if (fadeMs > 0 && typeof document !== 'undefined') {
            await this.fadeOut(fadeMs / 2);
        }

        if (this.activeScene) {
            await this.unloadScene(this.activeScene.id);
        }

        const newScene = await this.loadSceneFromData(sceneData);
        this.activeScene = newScene;

        if (this.onSceneLoaded) {
            this.onSceneLoaded(newScene);
        }

        if (fadeMs > 0 && typeof document !== 'undefined') {
            await this.fadeIn(fadeMs / 2);
        }

        this.isTransitioning = false;
    }

    getIsTransitioning(): boolean {
        return this.isTransitioning;
    }

    cleanupTransition(): void {
        if (this.transitionOverlay) {
            this.transitionOverlay.remove();
            this.transitionOverlay = null;
        }
        this.isTransitioning = false;
    }

    // -- Fade helpers ---------------------------------------------------------

    private ensureTransitionOverlay(): HTMLElement {
        if (!this.transitionOverlay && typeof document !== 'undefined') {
            this.transitionOverlay = document.createElement('div');
            this.transitionOverlay.style.cssText = `
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: black;
                opacity: 0;
                pointer-events: none;
                z-index: 99999;
                transition: none;
            `;
            document.body.appendChild(this.transitionOverlay);
        }
        return this.transitionOverlay!;
    }

    private fadeOut(durationMs: number): Promise<void> {
        return new Promise((resolve) => {
            const overlay = this.ensureTransitionOverlay();
            overlay.style.transition = `opacity ${durationMs}ms ease-in`;
            overlay.style.opacity = '0';
            overlay.style.pointerEvents = 'all';
            // Force reflow before transition
            overlay.offsetHeight;
            overlay.style.opacity = '1';
            setTimeout(resolve, durationMs);
        });
    }

    private fadeIn(durationMs: number): Promise<void> {
        return new Promise((resolve) => {
            const overlay = this.ensureTransitionOverlay();
            overlay.style.transition = `opacity ${durationMs}ms ease-out`;
            overlay.style.opacity = '1';
            // Force reflow before transition
            overlay.offsetHeight;
            overlay.style.opacity = '0';
            setTimeout(() => {
                overlay.style.pointerEvents = 'none';
                resolve();
            }, durationMs);
        });
    }
}
