import { Entity } from '../../runtime/function/framework/entity.js';
import { Scene } from '../../runtime/function/framework/scene.js';
import { addDefaultSceneEntities } from './default_scene.js';
import {
    CreateEntityCommand,
    DeleteEntityCommand,
    RenameEntityCommand,
    ChangePropertyCommand,
    AddComponentCommand,
    RemoveComponentCommand,
    AddTagCommand,
    RemoveTagCommand,
    SetEntityActiveCommand,
    SetComponentEnabledCommand,
    ReparentEntityCommand,
    ResetComponentCommand,
    ChangeEnvironmentPropertyCommand,
} from './history/commands.js';

export interface ActionHost {
    getActiveScene(): Scene | null;
    undoManager: { execute(cmd: any): void; undo(): void; redo(): void };
    emit(event: string, data?: any): void;
    ensurePrimitiveMeshes(): void;
    setGizmoMode(mode: 'translate' | 'rotate' | 'scale'): void;
    setCameraMode(mode: 'orbit' | 'fly'): void;
    setGizmoSpace(space: 'global' | 'local'): void;
    setGraphicsQuality(quality: 'low' | 'medium' | 'high'): void;
    play(): void;
    stop(): void;
    markDirty(): void;
    clearSelection(): void;
    setSelection(entityIds: number[]): void;
    state: { hiddenEntities: Set<number> };
    engine: any;
}

function findEntityByName(scene: Scene, name: string): Entity | null {
    for (const e of scene.entities.values()) {
        if (e.name === name) return e;
    }
    return null;
}

export function handleEditorActions(actions: any[], ctx: ActionHost): void {
    for (const action of actions) {
        try {
            executeOneAction(action, ctx);
        } catch (err) {
            console.error(`[EditorActions] Failed to execute action "${action?.action}":`, err);
        }
    }
}

function executeOneAction(action: any, ctx: ActionHost): void {
    const actionName = action?.action;
    if (!actionName) return;

    const scene = ctx.getActiveScene();

    switch (actionName) {

        case 'add_entity': {
            const entityType = action.type ?? 'empty';
            const name = action.name ?? entityType.charAt(0).toUpperCase() + entityType.slice(1);
            if (scene && findEntityByName(scene, name)) {
                break;
            }
            const parentEntity = action.parent && scene ? findEntityByName(scene, action.parent) : null;
            const parentId = parentEntity ? parentEntity.id : null;

            let components: { type: string; data?: Record<string, any> }[] | undefined;

            if (action.components && typeof action.components === 'object' && !Array.isArray(action.components)) {
                components = [];
                const pos = action.position ?? { x: 0, y: 0, z: 0 };
                const scale = action.scale ?? { x: 1, y: 1, z: 1 };
                components.push({
                    type: 'TransformComponent',
                    data: {
                        position: { x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0 },
                        rotation: { x: 0, y: 0, z: 0, w: 1 },
                        scale: { x: scale.x ?? 1, y: scale.y ?? 1, z: scale.z ?? 1 }
                    }
                });
                for (const [key, data] of Object.entries(action.components)) {
                    let compType = key;
                    if (!compType.endsWith('Component')) compType += 'Component';
                    if (compType === 'TransformComponent') continue;
                    const compData: Record<string, any> = (data && typeof data === 'object') ? { ...(data as Record<string, any>) } : {};
                    if (compType === 'RigidbodyComponent' && typeof compData.bodyType === 'string') {
                        const btMap: Record<string, number> = { static: 0, dynamic: 1, kinematic: 2 };
                        compData.bodyType = btMap[compData.bodyType] ?? 1;
                    }
                    if (compType === 'ColliderComponent' && compData.type) {
                        compData.shape = compData.type;
                        delete compData.type;
                    }
                    components.push({ type: compType, data: compData });
                }
            } else if (action.components && Array.isArray(action.components)) {
                components = action.components;
                if (action.position && !components!.some((c: any) => c.type === 'TransformComponent')) {
                    const pos = action.position;
                    components!.unshift({
                        type: 'TransformComponent',
                        data: {
                            position: { x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0 },
                            rotation: { x: 0, y: 0, z: 0, w: 1 },
                            scale: { x: 1, y: 1, z: 1 }
                        }
                    });
                }
            } else {
                const actionPos = action.position ?? (action.x !== undefined ? { x: action.x, y: action.y ?? 0, z: action.z ?? 0 } : null);
                const actionScale = action.scale ?? null;
                const defaultPos = (type: string) => actionPos ?? (type === 'plane' ? { x: 0, y: 0, z: 0 } : { x: 0, y: 1, z: 0 });
                const defaultScale = (type: string) => actionScale ?? (type === 'plane' ? { x: 5, y: 1, z: 5 } : { x: 1, y: 1, z: 1 });
                const makeTransform = (type: string) => ({ type: 'TransformComponent', data: { position: defaultPos(type), rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: defaultScale(type) } });

                switch (entityType) {
                    case 'cube':
                        components = [ makeTransform('cube'), { type: 'MeshRendererComponent', data: { meshType: 'cube' } } ];
                        break;
                    case 'sphere':
                        components = [ makeTransform('sphere'), { type: 'MeshRendererComponent', data: { meshType: 'sphere' } } ];
                        break;
                    case 'plane':
                        components = [ makeTransform('plane'), { type: 'MeshRendererComponent', data: { meshType: 'plane' } } ];
                        break;
                    case 'cylinder':
                        components = [ makeTransform('cylinder'), { type: 'MeshRendererComponent', data: { meshType: 'cylinder' } } ];
                        break;
                    case 'cone':
                        components = [ makeTransform('cone'), { type: 'MeshRendererComponent', data: { meshType: 'cone' } } ];
                        break;
                    case 'capsule':
                        components = [ makeTransform('capsule'), { type: 'MeshRendererComponent', data: { meshType: 'capsule' } } ];
                        break;
                    case 'directional_light':
                        components = [
                            { type: 'TransformComponent', data: { position: actionPos ?? { x: 0, y: 10, z: 0 }, rotation: { x: -0.3, y: 0.5, z: 0, w: 0.85 }, scale: { x: 1, y: 1, z: 1 } } },
                            { type: 'LightComponent', data: { lightType: 0, color: { r: 1, g: 0.95, b: 0.9, a: 1 }, intensity: 1.0 } },
                        ];
                        break;
                    case 'point_light':
                        components = [
                            { type: 'TransformComponent', data: { position: actionPos ?? { x: 0, y: 3, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } },
                            { type: 'LightComponent', data: { lightType: 1, color: { r: 1, g: 1, b: 1, a: 1 }, intensity: 1.0, range: 10 } },
                        ];
                        break;
                    case 'camera':
                        components = [
                            { type: 'TransformComponent', data: { position: actionPos ?? { x: 0, y: 2, z: 10 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } },
                            { type: 'CameraComponent', data: { fov: 60, near: 0.1, far: 1000 } },
                        ];
                        break;
                    case 'empty':
                    default:
                        if (action.position) {
                            const pos = action.position;
                            components = [{
                                type: 'TransformComponent',
                                data: {
                                    position: { x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0 },
                                    rotation: { x: 0, y: 0, z: 0, w: 1 },
                                    scale: { x: 1, y: 1, z: 1 }
                                }
                            }];
                        }
                        break;
                }
            }

            if (action.materialOverrides && components) {
                const meshComp = components.find((c: any) => c.type === 'MeshRendererComponent');
                if (meshComp) {
                    if (!meshComp.data) meshComp.data = {};
                    meshComp.data.materialOverrides = action.materialOverrides;
                }
            }

            const cmd = new CreateEntityCommand(name, parentId, components);
            ctx.undoManager.execute(cmd);
            ctx.emit('historyChanged');
            ctx.ensurePrimitiveMeshes();
            break;
        }

        case 'add_asset': {
            const assetPath = action.assetPath;
            if (!assetPath) break;
            const name = action.name ?? assetPath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'Asset';
            const pos = action.position ?? { x: 0, y: 0, z: 0 };
            const components: { type: string; data?: Record<string, any> }[] = [
                { type: 'TransformComponent', data: { position: { x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } },
                { type: 'MeshRendererComponent', data: { meshType: 'custom', meshAsset: assetPath } },
            ];
            const cmd = new CreateEntityCommand(name, null, components);
            ctx.undoManager.execute(cmd);
            ctx.emit('historyChanged');
            ctx.ensurePrimitiveMeshes();
            break;
        }

        case 'delete_entity': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            const cmd = new DeleteEntityCommand(entity.id);
            ctx.undoManager.execute(cmd);
            ctx.emit('historyChanged');
            break;
        }

        case 'rename_entity': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            const cmd = new RenameEntityCommand(entity.id, entity.name, action.newName);
            ctx.undoManager.execute(cmd);
            ctx.emit('historyChanged');
            break;
        }

        case 'duplicate_entity': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            const data = entity.toJSON();
            const compData = data.components?.map((c: any) => ({ type: c.type, data: c.data }));
            const cmd = new CreateEntityCommand(
                `${entity.name} (copy)`,
                entity.parent ? entity.parent.id : null,
                compData,
            );
            ctx.undoManager.execute(cmd);
            ctx.emit('historyChanged');
            ctx.ensurePrimitiveMeshes();
            break;
        }

        case 'set_position': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            const tc = entity.getComponent('TransformComponent') as any;
            if (!tc) break;
            const oldPos = { x: tc.position.x, y: tc.position.y, z: tc.position.z };
            const newPos = { x: action.x ?? 0, y: action.y ?? 0, z: action.z ?? 0 };
            const cmd = new ChangePropertyCommand(entity.id, 'TransformComponent', 'position', oldPos, newPos);
            ctx.undoManager.execute(cmd);
            ctx.emit('historyChanged');
            break;
        }

        case 'set_rotation': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            const tc = entity.getComponent('TransformComponent') as any;
            if (!tc) break;
            const oldRot = { x: tc.rotation.x, y: tc.rotation.y, z: tc.rotation.z, w: tc.rotation.w };
            const newRot = { x: action.x ?? 0, y: action.y ?? 0, z: action.z ?? 0 };
            const cmd = new ChangePropertyCommand(entity.id, 'TransformComponent', 'rotation', oldRot, newRot);
            ctx.undoManager.execute(cmd);
            ctx.emit('historyChanged');
            break;
        }

        case 'set_scale': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            const tc = entity.getComponent('TransformComponent') as any;
            if (!tc) break;
            const oldScale = { x: tc.scale.x, y: tc.scale.y, z: tc.scale.z };
            const newScale = { x: action.x ?? 1, y: action.y ?? 1, z: action.z ?? 1 };
            const cmd = new ChangePropertyCommand(entity.id, 'TransformComponent', 'scale', oldScale, newScale);
            ctx.undoManager.execute(cmd);
            ctx.emit('historyChanged');
            break;
        }

        case 'add_component': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            let compType = action.component;
            if (compType && !compType.endsWith('Component')) compType += 'Component';
            if (compType === 'ScriptComponent' && entity.getComponent('ScriptComponent')) {
                const existingSC = entity.getComponent('ScriptComponent') as any;
                const newURL = action.data?.scriptURL || action.properties?.scriptURL || '';
                if (newURL) {
                    const mainURL = existingSC.scriptURL || '';
                    const alreadyAttached = mainURL === newURL ||
                        existingSC.additionalScripts.some((s: any) => s.scriptURL === newURL);
                    if (!alreadyAttached) {
                        existingSC.mergeScript({ scriptURL: newURL, properties: action.properties || action.data || {} });
                        existingSC.markDirty();
                        ctx.markDirty();
                        ctx.emit('componentAdded', { entityId: entity.id, componentType: 'ScriptComponent' });
                    }
                }
            } else {
                const cmd = new AddComponentCommand(entity.id, action.component, action.properties || action.data);
                ctx.undoManager.execute(cmd);
                ctx.emit('historyChanged');
                ctx.ensurePrimitiveMeshes();
            }
            break;
        }

        case 'set_component': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            const comp = entity.getComponent(action.component) as any;
            if (!comp) { console.warn(`[EditorActions] Component not found: "${action.component}" on "${action.entity}"`); break; }
            const oldValue = comp[action.property];
            let oldClone = oldValue;
            if (oldValue && typeof oldValue === 'object') {
                if ('w' in oldValue) oldClone = { x: oldValue.x, y: oldValue.y, z: oldValue.z, w: oldValue.w };
                else if ('z' in oldValue) oldClone = { x: oldValue.x, y: oldValue.y, z: oldValue.z };
                else if ('r' in oldValue) oldClone = { r: oldValue.r, g: oldValue.g, b: oldValue.b, a: oldValue.a };
                else oldClone = JSON.parse(JSON.stringify(oldValue));
            }
            const cmd = new ChangePropertyCommand(entity.id, action.component, action.property, oldClone, action.value);
            ctx.undoManager.execute(cmd);
            ctx.emit('historyChanged');
            break;
        }

        case 'remove_component': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            const cmd = new RemoveComponentCommand(entity.id, action.component);
            ctx.undoManager.execute(cmd);
            ctx.emit('historyChanged');
            break;
        }

        case 'add_tag': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            const addTagCmd = new AddTagCommand(entity.id, action.tag);
            ctx.undoManager.execute(addTagCmd);
            ctx.emit('historyChanged');
            break;
        }

        case 'remove_tag': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            const removeTagCmd = new RemoveTagCommand(entity.id, action.tag);
            ctx.undoManager.execute(removeTagCmd);
            ctx.emit('historyChanged');
            break;
        }

        case 'undo': {
            ctx.undoManager.undo();
            ctx.emit('historyChanged');
            ctx.emit('sceneChanged');
            break;
        }

        case 'redo': {
            ctx.undoManager.redo();
            ctx.emit('historyChanged');
            ctx.emit('sceneChanged');
            break;
        }

        case 'select': {
            if (!scene) break;
            const names = Array.isArray(action.entity) ? action.entity : [action.entity];
            const ids: number[] = [];
            for (const n of names) {
                const e = findEntityByName(scene, n);
                if (e) ids.push(e.id);
                else console.warn(`[EditorActions] Entity not found for select: "${n}"`);
            }
            if (ids.length > 0) ctx.setSelection(ids);
            break;
        }

        case 'deselect_all': {
            ctx.clearSelection();
            break;
        }

        case 'focus_entity': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            ctx.emit('focusEntity', entity.id);
            break;
        }

        case 'play': {
            ctx.play();
            break;
        }

        case 'stop': {
            ctx.stop();
            break;
        }

        case 'set_gizmo_mode': {
            if (action.mode === 'translate' || action.mode === 'rotate' || action.mode === 'scale') {
                ctx.setGizmoMode(action.mode);
            }
            break;
        }

        case 'set_camera_mode': {
            if (action.mode === 'orbit' || action.mode === 'fly') {
                ctx.setCameraMode(action.mode);
            }
            break;
        }

        case 'set_gizmo_space': {
            if (action.space === 'global' || action.space === 'local') {
                ctx.setGizmoSpace(action.space);
            }
            break;
        }

        case 'set_graphics_quality': {
            if (action.quality === 'low' || action.quality === 'medium' || action.quality === 'high') {
                ctx.setGraphicsQuality(action.quality);
            }
            break;
        }

        case 'set_project_name': {
            if (action.name) {
                document.title = action.name + ' - ParallaxPro Editor';
                ctx.emit('projectNameChanged', action.name);
            }
            break;
        }

        case 'set_ambient_light': {
            if (typeof action.intensity === 'number' && ctx.engine) {
                const rs = ctx.engine.globalContext.renderSystem as any;
                if (rs.setAmbientIntensity) {
                    rs.setAmbientIntensity(action.intensity);
                } else if (rs.ambientIntensity !== undefined) {
                    rs.ambientIntensity = action.intensity;
                }
            }
            break;
        }

        case 'hide_entity': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            ctx.state.hiddenEntities.add(entity.id);
            ctx.emit('sceneChanged');
            break;
        }

        case 'show_entity': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            ctx.state.hiddenEntities.delete(entity.id);
            ctx.emit('sceneChanged');
            break;
        }

        case 'set_active': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            const newActive = action.active !== false;
            if (entity.active !== newActive) {
                const cmd = new SetEntityActiveCommand(entity.id, entity.active, newActive);
                ctx.undoManager.execute(cmd);
                ctx.emit('historyChanged');
            }
            break;
        }

        case 'set_component_enabled': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            const comp = entity.getComponent(action.component);
            if (!comp) { console.warn(`[EditorActions] Component not found: "${action.component}" on "${action.entity}"`); break; }
            const newEnabled = action.enabled !== false;
            if (comp.enabled !== newEnabled) {
                const cmd = new SetComponentEnabledCommand(entity.id, action.component, comp.enabled, newEnabled);
                ctx.undoManager.execute(cmd);
                ctx.emit('historyChanged');
            }
            break;
        }

        case 'reset_component': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            if (!entity.getComponent(action.component)) { console.warn(`[EditorActions] Component not found: "${action.component}" on "${action.entity}"`); break; }
            const cmd = new ResetComponentCommand(entity.id, action.component);
            ctx.undoManager.execute(cmd);
            ctx.emit('historyChanged');
            break;
        }

        case 'reparent_entity': {
            if (!scene) break;
            const entity = findEntityByName(scene, action.entity);
            if (!entity) { console.warn(`[EditorActions] Entity not found: "${action.entity}"`); break; }
            let newParentId: number | null = null;
            if (action.parent) {
                const parentEntity = findEntityByName(scene, action.parent);
                if (!parentEntity) { console.warn(`[EditorActions] Parent not found: "${action.parent}"`); break; }
                newParentId = parentEntity.id;
            }
            const cmd = new ReparentEntityCommand(entity.id, newParentId);
            ctx.undoManager.execute(cmd);
            ctx.emit('historyChanged');
            break;
        }

        case 'set_environment': {
            if (!ctx.engine) break;
            const wm = ctx.engine.globalContext.worldManager;
            if (!wm) break;
            const activeScene = wm.getActiveScene();
            if (!activeScene) break;
            const env = (activeScene as any).environment;
            if (!env) break;

            const props = action.properties;
            if (props && typeof props === 'object') {
                for (const [path, newValue] of Object.entries(props)) {
                    const parts = path.split('.');
                    let target: any = env;
                    for (let i = 0; i < parts.length - 1; i++) {
                        target = target?.[parts[i]];
                    }
                    const oldValue = target?.[parts[parts.length - 1]];
                    let oldClone = oldValue;
                    if (oldValue && typeof oldValue === 'object') {
                        oldClone = JSON.parse(JSON.stringify(oldValue));
                    }
                    const cmd = new ChangeEnvironmentPropertyCommand(activeScene.id, path, oldClone, newValue);
                    ctx.undoManager.execute(cmd);
                }
                ctx.emit('historyChanged');
            }
            break;
        }

        case 'create_scene': {
            if (!ctx.engine) break;
            const wm = ctx.engine.globalContext.worldManager;
            if (!wm) break;
            const sceneName = action.name || 'New Scene';
            const newScene = wm.createEmptyScene(sceneName);
            addDefaultSceneEntities(newScene);
            if (action.setActive !== false) {
                wm.setActiveScene(newScene.id);
                ctx.engine.setActiveScene(newScene);
            }
            ctx.ensurePrimitiveMeshes();
            ctx.markDirty();
            ctx.emit('sceneChanged');
            break;
        }

        case 'delete_scene': {
            if (!ctx.engine) break;
            const wm = ctx.engine.globalContext.worldManager;
            if (!wm) break;
            const scenes = wm.getLoadedScenes();
            if (scenes.length <= 1) { console.warn('[EditorActions] Cannot delete the last scene'); break; }
            const sceneName = action.name;
            const targetScene = scenes.find((s: any) => (s.name || '').toLowerCase() === (sceneName || '').toLowerCase());
            if (!targetScene) { console.warn(`[EditorActions] Scene not found: "${sceneName}"`); break; }
            const wasActive = wm.getActiveScene()?.id === targetScene.id;
            wm.unloadScene(targetScene.id);
            if (wasActive) {
                const remaining = wm.getLoadedScenes();
                if (remaining.length > 0) {
                    wm.setActiveScene(remaining[0].id);
                    ctx.engine.setActiveScene(remaining[0]);
                }
            }
            ctx.markDirty();
            ctx.emit('sceneChanged');
            break;
        }

        case 'rename_scene': {
            if (!ctx.engine) break;
            const wm = ctx.engine.globalContext.worldManager;
            if (!wm) break;
            const scenes = wm.getLoadedScenes();
            const targetScene = scenes.find((s: any) => (s.name || '').toLowerCase() === (action.scene || '').toLowerCase());
            if (!targetScene) { console.warn(`[EditorActions] Scene not found: "${action.scene}"`); break; }
            (targetScene as any).name = action.newName;
            ctx.markDirty();
            ctx.emit('sceneChanged');
            break;
        }

        case 'switch_scene': {
            if (!ctx.engine) break;
            const wm = ctx.engine.globalContext.worldManager;
            if (!wm) break;
            const scenes = wm.getLoadedScenes();
            const targetScene = scenes.find((s: any) => (s.name || '').toLowerCase() === (action.name || '').toLowerCase());
            if (!targetScene) { console.warn(`[EditorActions] Scene not found: "${action.name}"`); break; }
            wm.setActiveScene(targetScene.id);
            ctx.engine.setActiveScene(targetScene);
            ctx.ensurePrimitiveMeshes();
            ctx.markDirty();
            ctx.emit('sceneChanged');
            break;
        }

        case 'set_editor_camera': {
            ctx.emit('setEditorCamera', {
                position: action.position,
                target: action.target,
            });
            break;
        }

        default:
            console.warn(`[EditorActions] Unknown action: "${actionName}"`);
            break;
    }
}
