import { Vec3 } from '../../core/math/vec3.js';
import { Quat } from '../../core/math/quat.js';
import { InputSystem } from '../input/input_system.js';
import type { AudioSystem } from '../audio/audio_system.js';
import type { EventRegistry } from '../../../../shared/events/event_registry.js';

/** Script-facing audio interface (subset of AudioSystem). */
export type GameAudio = Pick<AudioSystem, 'playSound' | 'playMusic' | 'stopMusic' | 'setGroupVolume' | 'getGroupVolume' | 'preload'>;
import { UIElement, UIText, UIImage, UIButton, UIPanel, UIProgressBar, UITextInput, UIScrollView, UISlider, UIDropdown, UIGrid, attachTooltip } from '../ui/game_ui.js';
import type {
    UITextOptions, UIImageOptions, UIButtonOptions, UIPanelOptions, UIProgressBarOptions,
    UITextInputOptions, UIScrollViewOptions, UISliderOptions, UIDropdownOptions, UIGridOptions, UITooltipOptions,
    UIAnchor, UIBaseOptions,
} from '../ui/game_ui.js';

export { UIElement, UIText, UIImage, UIButton, UIPanel, UIProgressBar, UITextInput, UIScrollView, UISlider, UIDropdown, UIGrid, attachTooltip };
export type {
    UITextOptions, UIImageOptions, UIButtonOptions, UIPanelOptions, UIProgressBarOptions,
    UITextInputOptions, UIScrollViewOptions, UISliderOptions, UIDropdownOptions, UIGridOptions, UITooltipOptions,
    UIAnchor, UIBaseOptions,
};

export interface Transform {
    position: Vec3;
    rotation: Quat;
    scale: Vec3;
}

export interface TimeInfo {
    time: number;
    deltaTime: number;
    frameCount: number;
}

export interface RaycastHit {
    entityId: number;
    entityName: string;
    distance: number;
    point: Vec3;
    normal: Vec3;
}

/**
 * UI system for rendering HUD elements on the game viewport.
 */
export interface GameUI {
    createText(options?: UITextOptions): UIText;
    createImage(options?: UIImageOptions): UIImage;
    createButton(options?: UIButtonOptions): UIButton;
    createPanel(options?: UIPanelOptions): UIPanel;
    createProgressBar(options?: UIProgressBarOptions): UIProgressBar;
    createTextInput(options?: UITextInputOptions): UITextInput;
    createScrollView(options?: UIScrollViewOptions): UIScrollView;
    createSlider(options?: UISliderOptions): UISlider;
    createDropdown(options?: UIDropdownOptions): UIDropdown;
    createGrid(options?: UIGridOptions): UIGrid;
    getOverlay(): HTMLElement;
    destroyAll(): void;
}

/**
 * Entity reference for scripts.
 */
export interface ScriptEntity {
    id: number;
    name: string;
    active: boolean;
    transform: Transform;
    tags: string[];
    getComponent<T>(type: string): T | null;
    addComponent(type: string, data?: Record<string, any>): any;
    setActive(active: boolean): void;
    getScript(className: string): any;
    setMaterialColor(r: number, g: number, b: number, a?: number): void;
    setMaterialProperty(name: string, value: any): void;
    addTag(tag: string): void;
    removeTag(tag: string): void;
}

/**
 * Scene interface for scripts.
 */
export interface ScriptScene {
    findEntityByName(name: string): ScriptEntity | null;
    findEntitiesByName(name: string): ScriptEntity[];
    findEntitiesByTag(tag: string): ScriptEntity[];
    spawnEntity(name: string): ScriptEntity;
    destroyEntity(id: number): void;
    setMeshData(entityId: number, positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array): void;
    raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): RaycastHit | null;
    events: EventRegistry;

    // -- Entity convenience methods (ID-based) --
    createEntity(name: string): number;
    getAllEntities(): { id: number; name: string }[];
    getPosition(entityId: number): { x: number; y: number; z: number };
    setPosition(entityId: number, x: number, y: number, z: number): void;
    setScale(entityId: number, x: number, y: number, z: number): void;
    setRotationEuler(entityId: number, x: number, y: number, z: number): void;
    getComponent<T>(entityId: number, type: string): T | null;
    addComponent(entityId: number, type: string, data?: Record<string, any>): void;
    addTag(entityId: number, tag: string): void;
    removeTag(entityId: number, tag: string): void;
    lookAt(entityId: number, targetX: number, targetY: number, targetZ: number): void;

    // -- Screen-to-world --
    screenToWorldRay(screenX: number, screenY: number): { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } } | null;
    screenRaycast(screenX: number, screenY: number, maxDist?: number): RaycastHit | null;
    screenPointToGround(screenX: number, screenY: number, groundY?: number): { x: number; y: number; z: number } | null;
    worldToScreen(worldX: number, worldY: number, worldZ: number): { x: number; y: number } | null;

    // -- Terrain --
    getTerrainHeight(x: number, z: number): number;
    getTerrainNormal(x: number, z: number): { x: number; y: number; z: number };

    // -- Scene transitions --
    loadScene(sceneName: string, fadeMs?: number): void;
    getSceneNames(): string[];

    // -- Local save/load --
    saveData(key: string, data: any): void;
    loadData(key: string): any;
    deleteData(key: string): void;
    listSaveKeys(): string[];

    // -- Environment --
    setTimeOfDay(hour: number): void;
    getTimeOfDay(): number;
    setFog(enabled: boolean, color?: [number, number, number], near?: number, far?: number): void;
}

/**
 * Base class that user scripts extend. Provides access to the entity,
 * transform, scene, time, input, UI, and audio systems.
 */
export abstract class GameScript {
    entity!: ScriptEntity;
    transform!: Transform;
    scene!: ScriptScene;
    time!: TimeInfo;
    input!: InputSystem;
    ui!: GameUI;
    audio!: GameAudio;

    onStart(): void {}
    onUpdate(_dt?: number): void {}
    onLateUpdate(_dt?: number): void {}
    onFixedUpdate(_fixedDt: number): void {}
    onDestroy(): void {}

    /** Called once when a collision with another entity begins. */
    onCollisionEnter(_otherEntityId: number): void {}
    /** Called every frame while a collision with another entity persists. */
    onCollisionStay(_otherEntityId: number): void {}
    /** Called once when a collision with another entity ends. */
    onCollisionExit(_otherEntityId: number): void {}

    /** Called once when this entity enters a trigger volume (or a trigger enters this entity). */
    onTriggerEnter(_otherEntityId: number): void {}
    /** Called every frame while this entity overlaps a trigger volume. */
    onTriggerStay(_otherEntityId: number): void {}
    /** Called once when this entity exits a trigger volume. */
    onTriggerExit(_otherEntityId: number): void {}
}
