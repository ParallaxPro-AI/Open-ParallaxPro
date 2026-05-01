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

    /**
     * Mirror of `engine.isEditorMode`, kept in sync by ParallaxEngine on
     * `setEditorMode()` and `setActiveScene()` so render-time code (which
     * doesn't have a direct engine handle) can branch on edit-vs-play.
     * `hideFromOwner` reads this so the player's body mesh stays visible
     * while authoring — hiding only kicks in once Play starts. Default is
     * false (play mode) so a Scene used outside an engine context behaves
     * as the published runtime would.
     */
    isEditorMode: boolean = false;

    private particleEmitters: Map<number, ParticleEmitter> = new Map();
    private nextParticleId = 1;
    private tagIndex: Map<string, Set<number>> = new Map();
    private nameIndex: Map<string, Set<number>> = new Map();

    /**
     * Named prefab blueprints emitted by the level_assembler. Each value
     * is a component bundle (same shape as entries in scene.entities)
     * minus a persistent id / parentId. Use instantiatePrefab() to stamp
     * one into the scene at a given position with a fresh id.
     */
    private prefabBlueprints: Map<string, Record<string, any>> = new Map();

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

    // -- Prefabs --------------------------------------------------------------

    /**
     * Populate the prefab registry from the serialized scene blob. Called
     * once from the scene-load path; games don't need to invoke this
     * directly.
     */
    registerPrefabs(blueprints: Record<string, any> | undefined | null): void {
        if (!blueprints) return;
        for (const [name, bp] of Object.entries(blueprints)) {
            if (bp && typeof bp === 'object') {
                this.prefabBlueprints.set(name, bp);
            }
        }
    }

    hasPrefab(name: string): boolean {
        return this.prefabBlueprints.has(name);
    }

    /**
     * Instantiate a named prefab with a fresh id. Returns the new Entity,
     * or null when the prefab name isn't registered.
     *
     * Options:
     *   - position / rotation / scale: override the template's transform.
     *   - name: override the entity's display name (default: prefab name).
     *   - skipBehaviors: drop the ScriptComponent so no movement / combat
     *     / input behaviors run. Network-proxy use case — the proxy is
     *     driven entirely by inbound snapshots, not local input.
     *   - kinematicPhysics: downgrade a dynamic Rigidbody to kinematic so
     *     the proxy doesn't fight its own snapshot-driven transform. Only
     *     mutates RigidbodyComponent.bodyType; collider stays.
     *   - extraComponents: appended after the prefab's own components,
     *     overwriting any of the same type. Adapter uses this to stamp
     *     NetworkIdentityComponent onto proxies.
     */
    instantiatePrefab(
        name: string,
        opts: {
            position?: { x: number; y: number; z: number } | [number, number, number];
            rotation?: { x: number; y: number; z: number; w: number } | [number, number, number, number];
            scale?: { x: number; y: number; z: number } | [number, number, number];
            name?: string;
            skipBehaviors?: boolean;
            kinematicPhysics?: boolean;
            extraComponents?: Array<{ type: string; data?: Record<string, any> }>;
        } = {},
    ): Entity | null {
        const blueprint = this.prefabBlueprints.get(name);
        if (!blueprint) return null;

        // Clone so we can mutate freely without corrupting the registry.
        const entityData = JSON.parse(JSON.stringify(blueprint));
        entityData.id = this.idAllocator.allocate();
        entityData.name = opts.name ?? (entityData.name || name);
        if (entityData.parentId !== undefined) delete entityData.parentId;

        const components: any[] = Array.isArray(entityData.components) ? entityData.components : [];

        // Transform overrides — position/rotation/scale take precedence over
        // whatever the prefab baked in.
        const tc = components.find((c: any) => c.type === 'TransformComponent');
        if (tc) {
            const td = (tc.data = tc.data || {});
            if (opts.position) {
                const p: any = opts.position;
                td.position = Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : { x: p.x, y: p.y, z: p.z };
            }
            if (opts.rotation) {
                const r: any = opts.rotation;
                td.rotation = Array.isArray(r) ? { x: r[0], y: r[1], z: r[2], w: r[3] } : { x: r.x, y: r.y, z: r.z, w: r.w };
            }
            if (opts.scale) {
                const s: any = opts.scale;
                td.scale = Array.isArray(s) ? { x: s[0], y: s[1], z: s[2] } : { x: s.x, y: s.y, z: s.z };
            }
        }

        if (opts.skipBehaviors) {
            entityData.components = components.filter((c: any) => c.type !== 'ScriptComponent');
        }

        if (opts.kinematicPhysics) {
            for (const c of entityData.components) {
                if (c.type === 'RigidbodyComponent') {
                    c.data = c.data || {};
                    c.data.bodyType = 'kinematic';
                }
            }
        }

        if (opts.extraComponents) {
            for (const extra of opts.extraComponents) {
                if (!extra?.type) continue;
                const existing = entityData.components.find((c: any) => c.type === extra.type);
                if (existing) existing.data = { ...(existing.data || {}), ...(extra.data || {}) };
                else entityData.components.push({ type: extra.type, data: extra.data || {} });
            }
        }

        const entity = Entity.fromJSON(entityData, this);
        this.entities.set(entity.id, entity);
        this.idAllocator.ensureMinimum(entity.id);
        this._indexAddName(entity.id, entity.name);
        for (const tag of entity.tags) this._indexAddTag(entity.id, tag);
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

    /** Last-rendered active camera world position. Updated by
     *  `getMeshInstances()` (which runs once per frame during the
     *  render path); other systems that need a cheap camera-distance
     *  reference can read this without re-walking the entity list.
     *  Up to 1 frame stale relative to the camera's current transform —
     *  fine for distance-gated optimizations (LOD, animator skip). */
    getActiveCameraPos(): Vec3 | null { return this._activeCameraPos; }

    /** True if a point is inside an entity's rendered volume. Uses collider
     * bounds when present (authoritative), else falls back to a capsule
     * inscribed around the origin scaled by transform.scale. Tolerant
     * enough for "camera sits at the player's head and we want to hide the
     * player's mesh" — doesn't need precise mesh bounds. */
    private _cameraInsideEntity(entity: Entity, camPos: Vec3): boolean {
        const tc: any = entity.getComponent('TransformComponent');
        if (!tc) return false;
        const p = tc.position;
        const s = tc.scale ?? { x: 1, y: 1, z: 1 };
        const cc: any = entity.getComponent('ColliderComponent');
        // Vertical tolerance beyond the collider: an FPS camera is at
        // player_y + eyeHeight (typically 1.5–1.7m above player center),
        // which sits just ABOVE a human-height capsule's top. Require
        // XZ-in-bounds + a Y range that extends the collider upward by
        // VERTICAL_PAD so the FPS case is captured. Third-person
        // cameras (3-5m behind/above) fall outside XZ and still render
        // the player.
        //
        // Horizontal pad: position-follow cameras (most FPS templates) update
        // in a behavior tick that runs *after* the physics tick that moved
        // the player, so during high velocity (sprint, knockback, dash) the
        // camera's world position briefly lags behind the player by up to
        // velocity × tick-dt. At 8 m/s and 60Hz that's ~0.13m, easily 0.3m
        // over 2-3 ticks. Without slack, those frames render the player's
        // body for one tick → visible flicker during sprint. 0.5m matches
        // realistic sprint lag without leaking the body to truly external
        // (third-person) cameras, which sit several meters out.
        const VERTICAL_PAD_UP = 2.0;     // catches eyeHeight up to 2m
        const VERTICAL_PAD_DOWN = 0.5;   // player crouched slightly
        const HORIZONTAL_PAD = 0.5;      // absorbs camera-follow lag at sprint velocity
        if (cc) {
            const he: any = cc.halfExtents;
            if (cc.shapeType === 2 /* CAPSULE */) {
                const r = (cc.radius ?? 0.5) * Math.max(Math.abs(s.x), Math.abs(s.z));
                const h = (cc.height ?? 1.0) * Math.abs(s.y);
                const rPad = r + HORIZONTAL_PAD;
                const dx = camPos.x - p.x;
                const dz = camPos.z - p.z;
                if (dx * dx + dz * dz > rPad * rPad) return false;
                return camPos.y >= p.y - h * 0.5 - r - VERTICAL_PAD_DOWN
                    && camPos.y <= p.y + h * 0.5 + r + VERTICAL_PAD_UP;
            }
            if (cc.shapeType === 1 /* SPHERE */) {
                const r = (cc.radius ?? 0.5) * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
                const rPad = r + HORIZONTAL_PAD;
                const dx = camPos.x - p.x, dy = camPos.y - p.y, dz = camPos.z - p.z;
                return dx * dx + dz * dz <= rPad * rPad && Math.abs(dy) <= r + VERTICAL_PAD_UP;
            }
            // Default: AABB of halfExtents × scale + vertical + horizontal pad.
            if (he && typeof he.x === 'number') {
                const hx = he.x * Math.abs(s.x);
                const hy = he.y * Math.abs(s.y);
                const hz = he.z * Math.abs(s.z);
                return camPos.x >= p.x - hx - HORIZONTAL_PAD && camPos.x <= p.x + hx + HORIZONTAL_PAD
                    && camPos.y >= p.y - hy - VERTICAL_PAD_DOWN && camPos.y <= p.y + hy + VERTICAL_PAD_UP
                    && camPos.z >= p.z - hz - HORIZONTAL_PAD && camPos.z <= p.z + hz + HORIZONTAL_PAD;
            }
        }
        // No collider: unit-cube inscribed at origin, scaled by transform.
        const hx = 0.5 * Math.abs(s.x);
        const hy = 0.5 * Math.abs(s.y);
        const hz = 0.5 * Math.abs(s.z);
        return camPos.x >= p.x - hx - HORIZONTAL_PAD && camPos.x <= p.x + hx + HORIZONTAL_PAD
            && camPos.y >= p.y - hy - VERTICAL_PAD_DOWN && camPos.y <= p.y + hy + VERTICAL_PAD_UP
            && camPos.z >= p.z - hz - HORIZONTAL_PAD && camPos.z <= p.z + hz + HORIZONTAL_PAD;
    }

    getMeshInstances(): RenderMeshInstance[] {
        const result: RenderMeshInstance[] = [];

        // Cache camera position for LOD selection. Also remember the chain of
        // entity IDs from the camera entity up through its parents — the
        // `hideFromOwner` check on each MeshRenderer skips the mesh iff its
        // entity is on that chain (i.e. the camera is this entity or a
        // descendant of this entity). Standard setup for FPS: player entity
        // has the visible body mesh, camera is a child of the player; the
        // mesh is hidden from the player's own view but still renders for
        // spectators / other cameras in editor mode.
        this._activeCameraPos = null;
        const cameraOwnerChain = new Set<number>();
        for (const e of this.entities.values()) {
            if (!e.active) continue;
            if (e.getComponent('CameraComponent')) {
                this._activeCameraPos = e.getWorldPosition();
                let cur: any = e;
                while (cur) {
                    cameraOwnerChain.add(cur.id);
                    cur = cur.parent ?? null;
                }
                break;
            }
        }

        for (const entity of this.entities.values()) {
            if (!entity.active) continue;
            const mr = entity.getComponent('MeshRendererComponent') as MeshRendererComponent | null;
            if (!mr || !mr.visible || !mr.gpuMesh) continue;
            // Owner-hide: skip meshes whose entity is the ancestor chain of
            // the active camera. Two paths:
            //   (a) Scene-graph: the camera is a child of this entity. Used
            //       by games that parent the camera under a player prefab.
            //   (b) Position-follow: a separate camera entity whose behavior
            //       snaps it to the player's head each frame (the far more
            //       common FPS pattern authored by the CLI — run 43744221
            //       had a top-level Camera entity with a fps_camera behavior
            //       that set its position from the player's transform, no
            //       parent link). Detected here by checking whether the
            //       active camera's WORLD position is inside the mesh
            //       entity's AABB — "if the camera lives inside your body,
            //       don't render your body". Independent of scene-graph
            //       structure, so it catches the behavior-driven pattern.
            //
            // Editor-mode bypass: while authoring (engine.isEditorMode === true),
            // always render the mesh so the user can see what they're editing.
            // Without this, a player entity flagged hideFromOwner = true would
            // disappear in the editor viewport the moment its position-follow
            // camera matched up — making the mesh invisible exactly when you
            // want to inspect/transform it.
            if (mr.hideFromOwner && !this.isEditorMode) {
                if (cameraOwnerChain.has(entity.id)) continue;
                if (this._activeCameraPos && this._cameraInsideEntity(entity, this._activeCameraPos)) continue;
            }

            // LOD selection
            let activeMesh = mr.gpuMesh;
            if ((mr.gpuMeshLOD1 || mr.gpuMeshLOD2) && this._activeCameraPos) {
                const wp = entity.getWorldPosition();
                const dx = wp.x - this._activeCameraPos.x;
                const dy = wp.y - this._activeCameraPos.y;
                const dz = wp.z - this._activeCameraPos.z;
                const distSq = dx * dx + dy * dy + dz * dz;
                if (distSq > 400 * 400 && mr.gpuMeshLOD2) {
                    activeMesh = mr.gpuMeshLOD2;
                } else if (distSq > 160 * 160 && mr.gpuMeshLOD1) {
                    activeMesh = mr.gpuMeshLOD1;
                }
            }

            const animator = entity.getComponent('AnimatorComponent') as any;
            const jointMatricesBuffer = animator?.gpuJointMatricesBuffer ?? undefined;

            let modelMatrix = entity.getWorldMatrix();

            // Apply mesh-level offset and rotation in model space.
            // The output Mat4 is cached on the component — reusing the
            // same reference across frames is required because shadow_pass
            // keys its GPU-buffer pool by Mat4 identity. A fresh Mat4 per
            // frame creates a fresh GPUBuffer + GPUBindGroup per frame and
            // the pool grows without bound.
            //
            // Two contributors to the mesh-local transform:
            //   (a) per-entity modelRotation* / modelOffsetY (legacy / artist tweaks)
            //   (b) per-mesh registry facing transform on the parsed mesh
            //       (only present for SKINNED meshes — for static meshes the
            //       loader bakes it into vertex positions already)
            const facingRot = (mr.meshData as any)?.facingRotMatrix as Float32Array | undefined;
            const facingScale = (mr.meshData as any)?.facingScale as number | undefined;
            const hasFacing = !!facingRot || (facingScale !== undefined && facingScale !== 1);
            const hasUserXform = mr.modelRotationX !== 0 || mr.modelRotationY !== 0 || mr.modelRotationZ !== 0 || mr.modelOffsetY !== 0;

            if (hasUserXform || hasFacing) {
                // Cache invalidation: rebuild on rotation/offset change OR when
                // meshData identity changes (new mesh asset → maybe different facing).
                if (mr._meshTransformCache === null ||
                    mr._meshTransformRotX !== mr.modelRotationX ||
                    mr._meshTransformRotY !== mr.modelRotationY ||
                    mr._meshTransformRotZ !== mr.modelRotationZ ||
                    mr._meshTransformOffY !== mr.modelOffsetY ||
                    mr._meshTransformMeshData !== mr.meshData) {
                    const deg2rad = Math.PI / 180;
                    const meshRot = Quat.fromEuler(mr.modelRotationX * deg2rad, mr.modelRotationY * deg2rad, mr.modelRotationZ * deg2rad);
                    const meshOffset = new Vec3(0, mr.modelOffsetY, 0);
                    const userXform = Mat4.compose(meshOffset, meshRot, new Vec3(1, 1, 1));

                    if (hasFacing) {
                        // Build facing 4x4 from the row-major 3x3 rotation matrix
                        // and uniform scale. Mat4 stores column-major.
                        const s = (facingScale ?? 1);
                        const facingMat = new Mat4();
                        if (facingRot) {
                            const R = facingRot;
                            facingMat.set(
                                R[0] * s, R[3] * s, R[6] * s, 0,   // col 0
                                R[1] * s, R[4] * s, R[7] * s, 0,   // col 1
                                R[2] * s, R[5] * s, R[8] * s, 0,   // col 2
                                0,        0,        0,        1,
                            );
                        } else {
                            // Pure scale, no rotation
                            facingMat.setIdentity();
                            facingMat.data[0] = s; facingMat.data[5] = s; facingMat.data[10] = s;
                        }
                        // Apply facing first (innermost), then user xform
                        mr._meshTransformCache = userXform.multiply(facingMat);
                    } else {
                        mr._meshTransformCache = userXform;
                    }

                    mr._meshTransformRotX = mr.modelRotationX;
                    mr._meshTransformRotY = mr.modelRotationY;
                    mr._meshTransformRotZ = mr.modelRotationZ;
                    mr._meshTransformOffY = mr.modelOffsetY;
                    mr._meshTransformMeshData = mr.meshData;
                }
                // Composite world × meshTransform into a persistent output
                // buffer. Mat4.multiply(out) mutates 'out' in place and
                // returns it, so modelMatrix is the same reference every
                // frame.
                if (mr._modelMatrixCache === null) mr._modelMatrixCache = new Mat4();
                modelMatrix = modelMatrix.multiply(mr._meshTransformCache, mr._modelMatrixCache);
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
                    waterLevel: overrides.waterLevel,
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
                waterLevel: terrain.waterLevel,
                gpuTerrainTextures: terrain.gpuTerrainTextures,
                roadAtlasNear: terrain.gpuRoadAtlasNear,
                roadAtlasFar: terrain.gpuRoadAtlasFar,
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
                shadowDistance: light.shadowDistance,
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

        // Round-trip the prefab registry: without this, the Play→Stop
        // snapshot (editor_context.prePlaySceneSnapshot = scene.toJSON())
        // loses every prefab blueprint. On the next Play the script's
        // spawnEntity("enemy_goblin") throws "unknown entity definition"
        // because hasPrefab returns false against a freshly-loaded scene
        // with an empty registry. Observed on tower-defense project
        // 9af663e0 — enemies invisible, wave counter ticking down to zero
        // because _spawnQueue.shift() runs before spawnEntity throws.
        const prefabsOut: Record<string, any> = {};
        for (const [name, bp] of this.prefabBlueprints) prefabsOut[name] = bp;

        return {
            name: this.name,
            entities: entitiesData,
            environment: this.environment.toJSON(),
            prefabs: prefabsOut,
        };
    }

    static fromJSON(sceneData: Record<string, any>): Scene {
        const scene = new Scene();
        scene.name = sceneData.name ?? 'Untitled Scene';

        if (sceneData.environment) {
            scene.environment = EnvironmentData.fromJSON(sceneData.environment);
        }

        if (sceneData.prefabs) {
            scene.registerPrefabs(sceneData.prefabs);
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
