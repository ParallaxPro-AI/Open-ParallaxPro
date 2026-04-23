import { ParallaxEngine } from '../../runtime/engine.js';
import { registerBuiltInComponents } from '../../runtime/function/framework/register_components.js';
import { EditorContext } from './editor_context.js';

export class ParallaxEditor {
    private engine: ParallaxEngine;
    private canvas: HTMLCanvasElement | null = null;

    constructor() {
        this.engine = new ParallaxEngine();
    }

    async initialize(canvas: HTMLCanvasElement, projectData?: any): Promise<void> {
        this.canvas = canvas;

        registerBuiltInComponents();

        // Field-name compatibility: editor_view passes the raw projectData (whose
        // canonical field is `projectConfig`), while play.ts wraps it as `config`.
        // Read both so we get the real config in either path.
        const projectConfig = projectData?.projectConfig ?? projectData?.config ?? {
            name: 'Untitled',
            settings: {},
        };

        await this.engine.startEngine(canvas, projectConfig);
        this.engine.setEditorMode(true);

        const ctx = EditorContext.instance;
        ctx.engine = this.engine;

        const scenes = projectData?.scenes;
        const mainSceneData = projectData?.scene
            ?? scenes?.['scenes/main.scene.json']
            ?? null;

        if (mainSceneData) {
            await ctx.loadSceneFromData(mainSceneData);
            if (scenes) {
                for (const [key, data] of Object.entries(scenes)) {
                    if (key === 'scenes/main.scene.json') continue;
                    if (data && typeof data === 'object') {
                        const wm = this.engine.globalContext.worldManager;
                        await wm.loadSceneFromData(data as Record<string, any>);
                    }
                }
            }
        } else if (scenes && Object.keys(scenes).length > 0) {
            const firstKey = Object.keys(scenes)[0];
            await ctx.loadSceneFromData(scenes[firstKey]);
            for (const [key, data] of Object.entries(scenes)) {
                if (key === firstKey) continue;
                if (data && typeof data === 'object') {
                    const wm = this.engine.globalContext.worldManager;
                    await wm.loadSceneFromData(data as Record<string, any>);
                }
            }
        } else {
            throw new Error('No scene data found. The editor requires the backend to provide project data.');
        }

        ctx.ensurePrimitiveMeshes();
        ctx.on('sceneChanged', () => ctx.ensurePrimitiveMeshes());
        ctx.on('entityCreated', () => ctx.ensurePrimitiveMeshes());
        ctx.on('componentAdded', () => ctx.ensurePrimitiveMeshes());
        ctx.on('propertyChanged', (data: any) => {
            const { entityId, componentType, field } = data;
            if (componentType === 'MeshRendererComponent' && field === 'meshType') {
                const scene = ctx.getActiveScene();
                if (!scene) return;
                const entity = scene.getEntity(entityId);
                if (!entity) return;
                const mr = entity.getComponent('MeshRendererComponent') as any;
                if (mr) {
                    mr.gpuMesh = null;
                }
                ctx.ensurePrimitiveMeshes();
            }
        });
    }

    play(): void {
        this.engine.setEditorMode(false);
    }

    stop(): void {
        this.engine.setEditorMode(true);
    }

    shutdown(): void {
        this.engine.shutdown();
    }

    getEngine(): ParallaxEngine {
        return this.engine;
    }

    getCanvas(): HTMLCanvasElement | null {
        return this.canvas;
    }
}
