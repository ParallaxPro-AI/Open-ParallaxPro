import { Entity } from './entity.js';
import { IdAllocator } from '../../core/id/id_allocator.js';
import { EnvironmentData } from '../../resource/types/environment_data.js';
import { Vec3 } from '../../core/math/vec3.js';
import { Quat } from '../../core/math/quat.js';
import { Mat4 } from '../../core/math/mat4.js';
import { RenderMeshInstance, RenderDirectionalLight, RenderPointLight, RenderSpotLight, RenderCamera, RenderFogData } from '../render/render_scene.js';
import { MeshRendererComponent } from './components/mesh_renderer_component.js';
import { LightComponent, LightType } from './components/light_component.js';
import { CameraComponent } from './components/camera_component.js';
import { TerrainComponent } from './components/terrain_component.js';
import { ParticleEmitter, PRESETS as PARTICLE_PRESETS } from '../particle/particle_emitter.js';
import { ParticleRenderData } from '../render/particle_renderer.js';

/**
 * A Scene is a container for all entities in a game level.
 *
 * Provides entity lifecycle management, hierarchy queries, component-based queries,
 * JSON serialization, environment settings, and render data collection.
 */
export class Scene {
    readonly id: number;
    name: string;
    entities: Map<number, Entity> = new Map();
    environment: EnvironmentData;

    private particleEmitters: Map<number, ParticleEmitter> = new Map();
    private nextParticleId = 1;
    private tagIndex: Map<string, Set<number>> = new Map();
    private nameIndex: Map<string, Set<number>> = new Map();

    private idAllocator: IdAllocator;

    constructor(sceneData?: Record<string, any>) {
        this.idAllocator = new IdAllocator();

        if (sceneData) {
            this.id = sceneData.id ?? 1;
            this.name = sceneData.name ?? 'Untitled Scene';
            this.environment = sceneData.environment
                ? EnvironmentData.fromJSON(sceneData.environment)
                : new EnvironmentData();
        } else {
            this.id = 1;
            this.name = 'Untitled Scene';
            this.environment = new EnvironmentData();
        }
    }

    // -- Tick -----------------------------------------------------------------

    tick(deltaTime: number): void {
        for (const entity of this.entities.values()) {
            if (entity.active) {
                entity.tick(deltaTime);
            }
        }
    }

    // -- Entity Management ----------------------------------------------------

    createEntity(name: string = 'Entity', parentId: number | null = null): Entity {
        const id = this.idAllocator.allocate();
        const entity = new Entity(id, name, this);
        this.entities.set(id, entity);
        this._indexAddName(id, name);

        if (parentId !== null) {
            const parent = this.entities.get(parentId);
            if (parent) {
                entity.setParent(parent);
            }
        }

        return entity;
    }

    destroyEntity(entityId: number): void {
        const entity = this.entities.get(entityId);
        if (!entity) return;

        const toRemove: number[] = [];
        const collectDescendants = (e: Entity): void => {
            toRemove.push(e.id);
            for (const child of e.children) {
                collectDescendants(child);
            }
        };
        collectDescendants(entity);

        entity.destroy();

        for (const id of toRemove) {
            this._indexRemoveEntity(id);
            this.entities.delete(id);
            this.idAllocator.free(id);
        }
    }

    getEntity(entityId: number): Entity | null {
        return this.entities.get(entityId) ?? null;
    }

    findEntityByName(name: string): Entity | null {
        const ids = this.nameIndex.get(name);
        if (ids) {
            for (const id of ids) {
                const e = this.entities.get(id);
                if (e) return e;
            }
        }
        return null;
    }

    findEntitiesByTag(tag: string): Entity[] {
        let ids = this.tagIndex.get(tag);
        if (!ids) {
            const alt = tag.startsWith('#') ? tag.slice(1) : '#' + tag;
            ids = this.tagIndex.get(alt);
        }
        if (!ids) return [];
        const result: Entity[] = [];
        for (const id of ids) {
            const e = this.entities.get(id);
            if (e) result.push(e);
        }
        return result;
    }

    // -- Index maintenance (called by Entity) ---------------------------------

    /** @internal */ _indexAddTag(entityId: number, tag: string): void {
        if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set());
        this.tagIndex.get(tag)!.add(entityId);
    }

    /** @internal */ _indexRemoveTag(entityId: number, tag: string): void {
        const set = this.tagIndex.get(tag);
        if (set) { set.delete(entityId); if (set.size === 0) this.tagIndex.delete(tag); }
    }

    /** @internal */ _indexAddName(entityId: number, name: string): void {
        if (!this.nameIndex.has(name)) this.nameIndex.set(name, new Set());
        this.nameIndex.get(name)!.add(entityId);
    }

    /** @internal */ _indexRemoveName(entityId: number, name: string): void {
        const set = this.nameIndex.get(name);
        if (set) { set.delete(entityId); if (set.size === 0) this.nameIndex.delete(name); }
    }

    /** @internal */ _indexRemoveEntity(entityId: number): void {
        const entity = this.entities.get(entityId);
        if (!entity) return;
        this._indexRemoveName(entityId, entity.name);
        for (const tag of entity.tags) {
            this._indexRemoveTag(entityId, tag);
        }
    }

    getRootEntities(): Entity[] {
        const roots: Entity[] = [];
        for (const entity of this.entities.values()) {
            if (!entity.parent) {
                roots.push(entity);
            }
        }
        return roots;
    }

    // -- Hierarchy ------------------------------------------------------------

    getEntityChildren(entityId: number): Entity[] {
        const entity = this.entities.get(entityId);
        return entity ? [...entity.children] : [];
    }

    reparentEntity(entityId: number, newParentId: number | null): void {
        const entity = this.entities.get(entityId);
        if (!entity) return;

        if (newParentId === null) {
            entity.setParent(null);
        } else {
            const newParent = this.entities.get(newParentId);
            if (newParent) {
                entity.setParent(newParent);
            }
        }
    }

    reorderEntity(entityId: number, newParentId: number | null, siblingIndex: number): void {
        const entity = this.entities.get(entityId);
        if (!entity) return;

        if (newParentId === null) {
            if (entity.parent) {
                entity.parent.removeChild(entity);
                entity.parent = null;
            }
            this.reorderRootEntity(entityId, siblingIndex);
        } else {
            const newParent = this.entities.get(newParentId);
            if (newParent) {
                entity.setParentAtIndex(newParent, siblingIndex);
            }
        }
    }

    private reorderRootEntity(entityId: number, index: number): void {
        const roots = this.getRootEntities();
        const filtered = roots.filter(r => r.id !== entityId);
        const entity = this.entities.get(entityId)!;
        filtered.splice(index, 0, entity);

        const newMap = new Map<number, Entity>();
        const rootIds = new Set(filtered.map(r => r.id));
        let rootIdx = 0;

        for (const [id, ent] of this.entities) {
            if (rootIds.has(id) || id === entityId) {
                continue;
            }
            while (rootIdx < filtered.length) {
                newMap.set(filtered[rootIdx].id, filtered[rootIdx]);
                rootIdx++;
            }
            newMap.set(id, ent);
        }
        while (rootIdx < filtered.length) {
            newMap.set(filtered[rootIdx].id, filtered[rootIdx]);
            rootIdx++;
        }
        for (const [id, ent] of this.entities) {
            if (!newMap.has(id)) {
                newMap.set(id, ent);
            }
        }
        this.entities = newMap;
    }

    // -- Component Queries ----------------------------------------------------

    getEntitiesWithComponent(componentType: string): Entity[] {
        const result: Entity[] = [];
        for (const entity of this.entities.values()) {
            if (entity.hasComponent(componentType)) {
                result.push(entity);
            }
        }
        return result;
    }

    getEntitiesWithComponents(componentTypes: string[]): Entity[] {
        const result: Entity[] = [];
        for (const entity of this.entities.values()) {
            let hasAll = true;
            for (const type of componentTypes) {
                if (!entity.hasComponent(type)) {
                    hasAll = false;
                    break;
                }
            }
            if (hasAll) {
                result.push(entity);
            }
        }
        return result;
    }

    // -- Render Data Collection -----------------------------------------------

    private _activeCameraPos: Vec3 | null = null;

    getMeshInstances(): RenderMeshInstance[] {
        const result: RenderMeshInstance[] = [];

        // Cache camera position for LOD selection
        this._activeCameraPos = null;
        for (const e of this.entities.values()) {
            if (!e.active) continue;
            if (e.getComponent('CameraComponent')) {
                this._activeCameraPos = e.getWorldPosition();
                break;
            }
        }

        for (const entity of this.entities.values()) {
            if (!entity.active) continue;
            const mr = entity.getComponent('MeshRendererComponent') as MeshRendererComponent | null;
            if (!mr || !mr.visible || !mr.gpuMesh) continue;

            // LOD selection
            let activeMesh = mr.gpuMesh;
            if ((mr.gpuMeshLOD1 || mr.gpuMeshLOD2) && this._activeCameraPos) {
                const wp = entity.getWorldPosition();
                const dx = wp.x - this._activeCameraPos.x;
                const dy = wp.y - this._activeCameraPos.y;
                const dz = wp.z - this._activeCameraPos.z;
                const distSq = dx * dx + dy * dy + dz * dz;
                if (distSq > 200 * 200 && mr.gpuMeshLOD2) {
                    activeMesh = mr.gpuMeshLOD2;
                } else if (distSq > 80 * 80 && mr.gpuMeshLOD1) {
                    activeMesh = mr.gpuMeshLOD1;
                }
            }

            const animator = entity.getComponent('AnimatorComponent') as any;
            const jointMatricesBuffer = animator?.gpuJointMatricesBuffer ?? undefined;

            let modelMatrix = entity.getWorldMatrix();

            // Apply mesh-level offset and rotation in model space
            if (mr.modelRotationX !== 0 || mr.modelRotationY !== 0 || mr.modelRotationZ !== 0 || mr.modelOffsetY !== 0) {
                const deg2rad = Math.PI / 180;
                const meshRot = Quat.fromEuler(mr.modelRotationX * deg2rad, mr.modelRotationY * deg2rad, mr.modelRotationZ * deg2rad);
                const meshOffset = new Vec3(0, mr.modelOffsetY, 0);
                const meshTransform = Mat4.compose(meshOffset, meshRot, new Vec3(1, 1, 1));
                modelMatrix = modelMatrix.multiply(meshTransform);
            }

            const overrides = mr.materialOverrides;
            const localRadius = overrides.boundRadius ?? activeMesh.boundRadius ?? 1;
            const scale = entity.getWorldScale();
            const maxScale = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
            const boundCenter = entity.getWorldPosition();
            const boundRadius = localRadius * maxScale;

            // Multi-material sub-mesh rendering
            if (activeMesh === mr.gpuMesh && mr.gpuSubMeshes && mr.gpuSubMeshes.length > 0) {
                for (const sub of mr.gpuSubMeshes) {
                    result.push({
                        meshHandle: activeMesh,
                        modelMatrix,
                        baseColor: sub.baseColor,
                        metallic: overrides.metallic ?? 0,
                        roughness: overrides.roughness ?? 0.5,
                        emissive: overrides.emissive ?? [0, 0, 0],
                        boundCenter,
                        boundRadius,
                        baseColorTexture: sub.gpuTexture ?? undefined,
                        normalMapTexture: sub.gpuNormalMap ?? undefined,
                        firstIndex: sub.firstIndex,
                        drawIndexCount: sub.indexCount,
                        alphaMode: sub.alphaMode,
                        waterEffect: overrides.waterEffect ?? false,
                        jointMatricesBuffer,
                    });
                }
            } else {
                const bc = overrides.baseColor ?? [1, 1, 1, 1];
                result.push({
                    meshHandle: activeMesh,
                    modelMatrix,
                    baseColor: bc,
                    metallic: overrides.metallic ?? 0,
                    roughness: overrides.roughness ?? 0.5,
                    emissive: overrides.emissive ?? [0, 0, 0],
                    boundCenter,
                    boundRadius,
                    baseColorTexture: mr.gpuBaseColorTexture ?? undefined,
                    normalMapTexture: mr.gpuNormalMapTexture ?? undefined,
                    waterEffect: overrides.waterEffect ?? false,
                    uvScaleX: overrides.uvScaleX ?? 1.0,
                    uvScaleY: overrides.uvScaleY ?? 1.0,
                    jointMatricesBuffer,
                    alphaMode: bc[3] < 1 ? 'BLEND' : undefined,
                });
            }
        }

        // Terrain mesh instances
        for (const entity of this.entities.values()) {
            if (!entity.active) continue;
            const terrain = entity.getComponent('TerrainComponent') as TerrainComponent | null;
            if (!terrain || !terrain.gpuMesh) continue;

            result.push({
                meshHandle: terrain.gpuMesh,
                modelMatrix: entity.getWorldMatrix(),
                baseColor: terrain.baseColor as [number, number, number, number],
                metallic: terrain.metallic,
                roughness: terrain.roughness,
                emissive: [0, 0, 0] as [number, number, number],
                boundCenter: entity.getWorldPosition(),
                boundRadius: Math.max(terrain.width, terrain.depth) * 0.75,
            });
        }

        return result;
    }

    getDirectionalLights(): RenderDirectionalLight[] {
        const result: RenderDirectionalLight[] = [];
        for (const entity of this.entities.values()) {
            if (!entity.active) continue;
            const light = entity.getComponent('LightComponent') as LightComponent | null;
            if (!light || light.lightType !== LightType.DIRECTIONAL) continue;

            const worldMatrix = entity.getWorldMatrix();
            const dir = new Vec3(
                -worldMatrix.data[8],
                -worldMatrix.data[9],
                -worldMatrix.data[10]
            ).normalize();

            result.push({
                direction: dir,
                color: new Vec3(light.color.r, light.color.g, light.color.b),
                intensity: light.intensity,
            });
        }
        return result;
    }

    getPointLights(): RenderPointLight[] {
        const result: RenderPointLight[] = [];
        for (const entity of this.entities.values()) {
            if (!entity.active) continue;
            const light = entity.getComponent('LightComponent') as LightComponent | null;
            if (!light || light.lightType !== LightType.POINT) continue;

            result.push({
                position: entity.getWorldPosition(),
                color: new Vec3(light.color.r, light.color.g, light.color.b),
                intensity: light.intensity,
                range: light.range,
            });
        }
        return result;
    }

    getSpotLights(): RenderSpotLight[] {
        const result: RenderSpotLight[] = [];
        for (const entity of this.entities.values()) {
            if (!entity.active) continue;
            const light = entity.getComponent('LightComponent') as LightComponent | null;
            if (!light || light.lightType !== LightType.SPOT) continue;

            const worldMatrix = entity.getWorldMatrix();
            const dir = new Vec3(
                -worldMatrix.data[8],
                -worldMatrix.data[9],
                -worldMatrix.data[10]
            ).normalize();

            result.push({
                position: entity.getWorldPosition(),
                direction: dir,
                color: new Vec3(light.color.r, light.color.g, light.color.b),
                intensity: light.intensity,
                range: light.range,
                innerConeAngle: light.innerConeAngle,
                outerConeAngle: light.outerConeAngle,
            });
        }
        return result;
    }

    getFogData(): RenderFogData {
        return {
            enabled: this.environment.fog.enabled,
            color: new Vec3(this.environment.fog.color[0], this.environment.fog.color[1], this.environment.fog.color[2]),
            near: this.environment.fog.near,
            far: this.environment.fog.far,
        };
    }

    getTimeOfDay(): number {
        return this.environment.timeOfDay;
    }

    getActiveCamera(): RenderCamera | null {
        let bestCam: CameraComponent | null = null;
        let bestEntity: Entity | null = null;
        for (const entity of this.entities.values()) {
            if (!entity.active) continue;
            const cam = entity.getComponent('CameraComponent') as CameraComponent | null;
            if (!cam) continue;
            if (!bestCam || cam.priority > bestCam.priority) {
                bestCam = cam;
                bestEntity = entity;
            }
        }
        if (!bestCam || !bestEntity) return null;

        const canvas = typeof document !== 'undefined'
            ? document.querySelector('.viewport-canvas-container canvas') as HTMLCanvasElement | null
            : null;
        const aspectRatio = canvas
            ? canvas.clientWidth / canvas.clientHeight
            : (typeof window !== 'undefined' ? window.innerWidth / window.innerHeight : 16 / 9);

        return {
            viewMatrix: bestCam.getViewMatrix(),
            projectionMatrix: bestCam.getProjectionMatrix(aspectRatio),
            position: bestEntity.getWorldPosition(),
            near: bestCam.nearClip,
            far: bestCam.farClip,
            fovY: bestCam.fov,
        };
    }

    getAmbientColor(): Vec3 {
        const c = this.environment.ambientLight.color;
        return new Vec3(c[0], c[1], c[2]);
    }

    getAmbientIntensity(): number {
        return this.environment.ambientLight.intensity;
    }

    // -- Serialization --------------------------------------------------------

    toJSON(): Record<string, any> {
        const entitiesData: Record<string, any>[] = [];
        const visited = new Set<number>();

        const serializeEntity = (entity: Entity) => {
            if (visited.has(entity.id)) return;
            visited.add(entity.id);
            entitiesData.push(entity.toJSON());
            for (const child of entity.children) {
                serializeEntity(child);
            }
        };

        for (const entity of this.entities.values()) {
            if (!entity.parent) {
                serializeEntity(entity);
            }
        }
        for (const entity of this.entities.values()) {
            if (!visited.has(entity.id)) {
                entitiesData.push(entity.toJSON());
            }
        }

        return {
            name: this.name,
            entities: entitiesData,
            environment: this.environment.toJSON(),
        };
    }

    static fromJSON(sceneData: Record<string, any>): Scene {
        const scene = new Scene();
        scene.name = sceneData.name ?? 'Untitled Scene';

        if (sceneData.environment) {
            scene.environment = EnvironmentData.fromJSON(sceneData.environment);
        }

        const entitiesData: Record<string, any>[] = sceneData.entities ?? [];
        const parentMap = new Map<number, number | null>();

        // Ensure allocator knows about all explicit IDs to avoid conflicts
        for (const entityData of entitiesData) {
            if (entityData.id != null && entityData.id > 0) {
                scene.idAllocator.ensureMinimum(entityData.id);
            }
        }
        // Assign IDs to entities missing them
        for (const entityData of entitiesData) {
            if (entityData.id == null || entityData.id === 0) {
                entityData.id = scene.idAllocator.allocate();
            }
        }

        for (const entityData of entitiesData) {
            const entity = Entity.fromJSON(entityData, scene);
            scene.entities.set(entity.id, entity);
            scene.idAllocator.ensureMinimum(entity.id);
            parentMap.set(entity.id, entityData.parentId ?? null);
            scene._indexAddName(entity.id, entity.name);
            for (const tag of entity.tags) scene._indexAddTag(entity.id, tag);
        }

        // Rebuild hierarchy
        for (const [entityId, parentId] of parentMap) {
            if (parentId !== null) {
                const entity = scene.entities.get(entityId);
                const parent = scene.entities.get(parentId);
                if (entity && parent) {
                    entity.setParent(parent);
                }
            }
        }

        return scene;
    }

    // -- Particle System ------------------------------------------------------

    spawnParticles(presetName: string, x: number, y: number, z: number, overrides?: Record<string, any>): number {
        const preset = PARTICLE_PRESETS[presetName];
        if (!preset) return -1;
        const merged = { ...preset };
        if (overrides) {
            for (const key of Object.keys(overrides)) {
                (merged as any)[key] = overrides[key];
            }
        }
        const id = this.nextParticleId++;
        const emitter = new ParticleEmitter(merged);
        emitter.worldX = x; emitter.worldY = y; emitter.worldZ = z;
        this.particleEmitters.set(id, emitter);
        return id;
    }

    stopParticles(emitterId: number): void {
        const emitter = this.particleEmitters.get(emitterId);
        if (emitter) emitter.active = false;
    }

    removeParticles(emitterId: number): void {
        this.particleEmitters.delete(emitterId);
    }

    tickParticles(dt: number): void {
        for (const [id, emitter] of this.particleEmitters) {
            emitter.tick(dt);
            if (emitter.isDead) this.particleEmitters.delete(id);
        }
    }

    getParticleRenderData(): ParticleRenderData[] {
        const result: ParticleRenderData[] = [];
        for (const emitter of this.particleEmitters.values()) {
            const data = emitter.getRenderData();
            if (data) result.push(data);
        }
        return result;
    }

}
