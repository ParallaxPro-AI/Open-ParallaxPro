import RAPIER from '@dimforge/rapier3d-compat';
import { Vec3 } from '../../core/math/vec3.js';
import { Quat } from '../../core/math/quat.js';
import { Scene } from '../framework/scene.js';
import { Entity } from '../framework/entity.js';
import { RigidbodyComponent, BodyType } from '../framework/components/rigidbody_component.js';
import { ColliderComponent, ShapeType } from '../framework/components/collider_component.js';
import { TransformComponent } from '../framework/components/transform_component.js';
import { VehicleComponent } from '../framework/components/vehicle_component.js';
import { TerrainComponent } from '../framework/components/terrain_component.js';
import { MeshRendererComponent } from '../framework/components/mesh_renderer_component.js';

let rapierInitialized = false;
const rapierInitPromise = RAPIER.init().then(() => { rapierInitialized = true; });

/**
 * Physics system backed by Rapier WASM.
 *
 * Manages rigid body creation, collider setup, fixed-timestep simulation,
 * collision event draining, grounded state detection, and vehicle simulation.
 */
export class PhysicsSystem {
    private world: RAPIER.World | null = null;
    private eventQueue: RAPIER.EventQueue | null = null;
    private fixedTimestep: number = 1 / 60;
    private accumulator: number = 0;
    private maxSubSteps: number = 5;

    // Rapier WASM's gravity getter returns an object with undefined .y,
    // so we store gravity separately and apply it manually each substep.
    private _gravity: { x: number; y: number; z: number } = { x: 0, y: -9.81, z: 0 };

    // Entity <-> Rapier mappings
    private entityToBody: Map<number, RAPIER.RigidBody> = new Map();
    private entityToCollider: Map<number, RAPIER.Collider> = new Map();
    private bodyHandleToEntity: Map<number, number> = new Map();
    private colliderHandleToEntity: Map<number, number> = new Map();
    private entityCenterOffset: Map<number, Vec3> = new Map();

    private warnedColliderOnly: Set<number> = new Set();
    // Dedupe per-entity runtime warnings so physics hot paths don't spam
    // the console every frame for the same broken/falling entity.
    private warnedNaN: Set<number> = new Set();
    private warnedFell: Set<number> = new Set();

    // Contact tracking for enter/stay/exit dispatch
    private activeContacts: Set<string> = new Set();
    private activeTriggers: Set<string> = new Set();
    private frameContactEvents: { type: 'enter' | 'stay' | 'exit'; a: number; b: number }[] = [];
    private frameTriggerEvents: { type: 'enter' | 'stay' | 'exit'; a: number; b: number }[] = [];

    getWorld(): RAPIER.World | null { return this.world; }

    async initialize(gravity?: Vec3, fixedTimestep?: number): Promise<void> {
        if (!rapierInitialized) await rapierInitPromise;

        const g = gravity ?? new Vec3(0, -9.81, 0);
        this._gravity = { x: g.x, y: g.y, z: g.z };
        this.world = new RAPIER.World({ x: g.x, y: g.y, z: g.z });
        this.eventQueue = new RAPIER.EventQueue(true);

        if (fixedTimestep !== undefined && fixedTimestep > 0) {
            this.fixedTimestep = fixedTimestep;
        }
    }

    tick(deltaTime: number, scene?: Scene | null): number {
        if (deltaTime <= 0) return 0;

        // Lazy re-create world if it was freed
        if (!this.world) {
            if (!rapierInitialized) return 0;
            this.world = new RAPIER.World({ x: this._gravity.x, y: this._gravity.y, z: this._gravity.z });
            this.eventQueue = new RAPIER.EventQueue(true);
        }
        if (!this.eventQueue) {
            this.eventQueue = new RAPIER.EventQueue(true);
        }

        if (scene) this.syncEntitiesToPhysics(scene);

        const clampedDelta = Math.min(deltaTime, this.fixedTimestep * this.maxSubSteps);
        this.accumulator += clampedDelta;

        this.frameContactEvents = [];
        this.frameTriggerEvents = [];

        let steps = 0;
        while (this.accumulator >= this.fixedTimestep && steps < this.maxSubSteps) {
            if (scene) this.applyPreStepForces(scene);
            if (scene) this.simulateVehicles(scene, this.fixedTimestep);
            this.world.step(this.eventQueue);
            steps++;
            this.accumulator -= this.fixedTimestep;
        }

        if (steps > 0) {
            this.drainCollisionEvents();
            if (scene) {
                this.updateGroundedState(scene);
                this.syncPhysicsToEntities(scene);
            }
        }

        return steps;
    }

    getFixedTimestep(): number { return this.fixedTimestep; }
    setFixedTimestep(dt: number): void { if (dt > 0) this.fixedTimestep = dt; }
    setMaxSubSteps(max: number): void { this.maxSubSteps = max; }
    getInterpolationAlpha(): number { return this.accumulator / this.fixedTimestep; }

    shutdown(): void {
        if (this.world) {
            for (const body of [...this.entityToBody.values()]) {
                try { this.world.removeRigidBody(body); } catch {}
            }
        }
        this.entityToBody.clear();
        this.entityToCollider.clear();
        this.bodyHandleToEntity.clear();
        this.colliderHandleToEntity.clear();
        this.entityCenterOffset.clear();
        this.frameContactEvents = [];
        this.frameTriggerEvents = [];
        this.activeContacts.clear();
        this.activeTriggers.clear();
        this.warnedColliderOnly.clear();
        this.accumulator = 0;
        this._gravity = { x: 0, y: -9.81, z: 0 };
        if (this.world) {
            this.world.gravity = { x: 0, y: -9.81, z: 0 };
        }
    }

    getContactEvents(): { type: 'enter' | 'stay' | 'exit'; a: number; b: number }[] {
        return this.frameContactEvents;
    }

    getTriggerEvents(): { type: 'enter' | 'stay' | 'exit'; a: number; b: number }[] {
        return this.frameTriggerEvents;
    }

    raycastWorld(
        origin: Vec3, direction: Vec3, maxDist: number, excludeEntityId?: number
    ): { entityId: number; distance: number; point: Vec3; normal: Vec3 } | null {
        if (!this.world) return null;

        const ray = new RAPIER.Ray(
            { x: origin.x, y: origin.y, z: origin.z },
            { x: direction.x, y: direction.y, z: direction.z }
        );

        const hit = this.world.castRay(ray, maxDist, true);
        if (!hit) return null;

        const entityId = this.colliderHandleToEntity.get(hit.collider.handle);
        if (entityId === undefined || entityId === excludeEntityId) return null;

        const toi = hit.timeOfImpact;
        const point = new Vec3(
            origin.x + direction.x * toi,
            origin.y + direction.y * toi,
            origin.z + direction.z * toi
        );

        const normal = (hit as any).normal;
        return {
            entityId,
            distance: toi,
            point,
            normal: normal ? new Vec3(normal.x, normal.y, normal.z) : new Vec3(0, 1, 0),
        };
    }

    // -- Sync entities -> Rapier --

    private syncEntitiesToPhysics(scene: Scene): void {
        if (!this.world) return;

        const activeEntityIds = new Set<number>();

        for (const entity of scene.entities.values()) {
            if (!entity.active) continue;
            const rb = entity.getComponent('RigidbodyComponent') as RigidbodyComponent | null;
            const collider = entity.getComponent('ColliderComponent') as ColliderComponent | null;

            if (!rb && collider && !this.warnedColliderOnly.has(entity.id)) {
                this.warnedColliderOnly.add(entity.id);
                continue;
            }
            if (!rb) continue;

            activeEntityIds.add(entity.id);

            const existingBody = this.entityToBody.get(entity.id);

            if (existingBody) {
                try {
                    // Rapier bodyType(): 0=Dynamic, 1=Fixed, 2=KinematicPositionBased
                    const currentType = existingBody.bodyType();
                    const rapierWanted = rb.bodyType === BodyType.STATIC ? 1
                        : rb.bodyType === BodyType.KINEMATIC ? 2 : 0;

                    if (currentType !== rapierWanted || rb._forceRecreate) {
                        rb._forceRecreate = false;
                        this.removeEntityPhysics(entity.id, existingBody);
                        this.createBody(entity, rb, collider);
                    } else {
                        this.updateExistingBody(entity, rb, existingBody);
                    }
                } catch {
                    this.updateExistingBody(entity, rb, existingBody);
                }
            } else {
                this.createBody(entity, rb, collider);
            }
        }

        // Remove bodies for entities no longer in scene
        for (const [entityId, body] of [...this.entityToBody]) {
            if (!activeEntityIds.has(entityId)) {
                this.removeEntityPhysics(entityId, body);
            }
        }
    }

    private removeEntityPhysics(entityId: number, body: RAPIER.RigidBody): void {
        const col = this.entityToCollider.get(entityId);
        if (col) {
            try { this.world!.removeCollider(col, false); } catch {}
            this.colliderHandleToEntity.delete(col.handle);
            this.entityToCollider.delete(entityId);
        }
        try { this.world!.removeRigidBody(body); } catch {}
        this.bodyHandleToEntity.delete(body.handle);
        this.entityToBody.delete(entityId);
        this.entityCenterOffset.delete(entityId);
    }

    private createBody(entity: Entity, rb: RigidbodyComponent, collider: ColliderComponent | null): void {
        if (!this.world) return;

        const tc = entity.getComponent('TransformComponent') as TransformComponent;
        if (!tc) return;

        const worldPos = tc.getWorldPosition();
        const worldRot = tc.getWorldRotation();
        const worldScale = tc.getWorldScale();

        const colDesc = this.buildColliderDesc(entity, collider, worldScale);
        if (!colDesc) return;

        // Compute center offset from collider
        const center = collider?.center ?? { x: 0, y: 0, z: 0 };
        const offset = new Vec3(center.x * worldScale.x, center.y * worldScale.y, center.z * worldScale.z);
        this.entityCenterOffset.set(entity.id, offset);

        const bodyX = worldPos.x + offset.x;
        const bodyY = worldPos.y + offset.y;
        const bodyZ = worldPos.z + offset.z;

        let bodyDesc: RAPIER.RigidBodyDesc;
        if (rb.bodyType === BodyType.STATIC) {
            bodyDesc = RAPIER.RigidBodyDesc.fixed();
        } else if (rb.bodyType === BodyType.KINEMATIC) {
            bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
        } else {
            bodyDesc = RAPIER.RigidBodyDesc.dynamic();
        }

        if (isNaN(bodyX) || isNaN(bodyY) || isNaN(bodyZ)) {
            console.warn(`[PhysicsSystem] NaN position at body creation for ${entity.name} - skipping`);
            return;
        }

        bodyDesc.setTranslation(bodyX, bodyY, bodyZ);
        bodyDesc.setRotation({ x: worldRot.x, y: worldRot.y, z: worldRot.z, w: worldRot.w });
        bodyDesc.setLinearDamping(rb.linearDamping);
        bodyDesc.setAngularDamping(rb.angularDamping);
        bodyDesc.setGravityScale(rb.gravityScale);
        if (rb.enableCCD) bodyDesc.setCcdEnabled(true);
        if (rb.freezeRotation) bodyDesc.lockRotations();

        const body = this.world.createRigidBody(bodyDesc);

        // Create collider attached to body
        colDesc.setRestitution(rb.restitution);
        colDesc.setFriction(rb.friction);
        if (collider?.isTrigger) colDesc.setSensor(true);
        colDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

        // Rotate collider to match mesh model rotation (e.g. 180-degree Y flip)
        const mr = entity.getComponent('MeshRendererComponent') as any;
        const hasModelRot = mr && (mr.modelRotationX || mr.modelRotationY || mr.modelRotationZ);
        if (hasModelRot && collider?.shapeType !== ShapeType.MESH) {
            const deg2rad = Math.PI / 180;
            const q = Quat.fromEuler(
                (mr.modelRotationX || 0) * deg2rad,
                (mr.modelRotationY || 0) * deg2rad,
                (mr.modelRotationZ || 0) * deg2rad,
            );
            colDesc.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
        }

        const col = this.world.createCollider(colDesc, body);

        // Set mass after collider creation so body.mass() includes collider contribution
        if (rb.bodyType === BodyType.DYNAMIC && rb.mass > 0) {
            const currentMass = body.mass();
            if (currentMass > 0 && !isNaN(currentMass)) {
                body.setAdditionalMass(Math.max(0, rb.mass - currentMass), true);
            } else {
                body.setAdditionalMass(rb.mass, true);
            }
        }

        this.entityToBody.set(entity.id, body);
        this.entityToCollider.set(entity.id, col);
        this.bodyHandleToEntity.set(body.handle, entity.id);
        this.colliderHandleToEntity.set(col.handle, entity.id);
        rb.physicsBodyId = body.handle;

        if (rb.bodyType === BodyType.DYNAMIC) {
            body.wakeUp();
        }
    }

    private buildColliderDesc(entity: Entity, collider: ColliderComponent | null, worldScale: Vec3): RAPIER.ColliderDesc | null {
        if (!collider) {
            const hx = Math.abs(worldScale.x) * 0.5;
            const hy = Math.abs(worldScale.y) * 0.5;
            const hz = Math.abs(worldScale.z) * 0.5;
            return RAPIER.ColliderDesc.cuboid(Math.max(0.01, hx), Math.max(0.01, hy), Math.max(0.01, hz));
        }

        const sx = Math.abs(worldScale.x);
        const sy = Math.abs(worldScale.y);
        const sz = Math.abs(worldScale.z);

        switch (collider.shapeType) {
            case ShapeType.BOX: {
                const he = collider.halfExtents ?? { x: 0.5, y: 0.5, z: 0.5 };
                return RAPIER.ColliderDesc.cuboid(
                    Math.max(0.01, he.x * sx),
                    Math.max(0.01, he.y * sy),
                    Math.max(0.01, he.z * sz)
                );
            }
            case ShapeType.SPHERE: {
                const maxS = Math.max(sx, sy, sz);
                return RAPIER.ColliderDesc.ball(Math.max(0.01, (collider.radius ?? 0.5) * maxS));
            }
            case ShapeType.CAPSULE: {
                const maxHorizS = Math.max(sx, sz);
                const r = Math.max(0.01, (collider.radius ?? 0.5) * maxHorizS);
                const totalH = Math.max(0.02, (collider.height ?? 1.0) * sy);
                const cylHalfH = Math.max(0.01, totalH / 2 - r);
                return RAPIER.ColliderDesc.capsule(cylHalfH, r);
            }
            case ShapeType.MESH: {
                let positions: Float32Array | null = collider.collisionPositions ?? null;
                let indices: Uint32Array | null = collider.collisionIndices ?? null;

                if (!positions || !indices) {
                    const mr = entity.getComponent('MeshRendererComponent') as MeshRendererComponent | null;
                    if (mr) {
                        const md = (mr as any).meshData;
                        if (md?.positions && md?.indices) {
                            positions = md.positions instanceof Float32Array ? md.positions : new Float32Array(md.positions);
                            indices = md.indices instanceof Uint32Array ? md.indices : new Uint32Array(md.indices);
                        }
                    }
                }

                if (positions && indices) {
                    // Scale positions (Rapier trimesh doesn't auto-scale)
                    if (sx !== 1 || sy !== 1 || sz !== 1) {
                        const scaled = new Float32Array(positions.length);
                        for (let i = 0; i < positions.length; i += 3) {
                            scaled[i] = positions[i] * sx;
                            scaled[i + 1] = positions[i + 1] * sy;
                            scaled[i + 2] = positions[i + 2] * sz;
                        }
                        positions = scaled;
                    }

                    // Rotate positions to match mesh model rotation
                    const mrComp = entity.getComponent('MeshRendererComponent') as any;
                    if (mrComp && (mrComp.modelRotationX || mrComp.modelRotationY || mrComp.modelRotationZ)) {
                        positions = this.rotatePositions(positions, mrComp);
                    }

                    return RAPIER.ColliderDesc.trimesh(positions, indices);
                }

                return RAPIER.ColliderDesc.cuboid(sx * 0.5, sy * 0.5, sz * 0.5);
            }
            case ShapeType.TERRAIN: {
                const terrain = entity.getComponent('TerrainComponent') as TerrainComponent | null;
                if (terrain && terrain.heightData) {
                    const res = terrain.resolution ?? 64;
                    const heights = new Float32Array(res * res);
                    for (let i = 0; i < Math.min(heights.length, terrain.heightData.length); i++) {
                        heights[i] = terrain.heightData[i] * (terrain.heightScale ?? 1);
                    }
                    const scale = new RAPIER.Vector3(
                        (terrain.width ?? 100) / (res - 1),
                        1,
                        (terrain.depth ?? 100) / (res - 1)
                    );
                    return RAPIER.ColliderDesc.heightfield(res, res, heights, scale);
                }
                return RAPIER.ColliderDesc.cuboid(50, 0.5, 50);
            }
            default:
                return RAPIER.ColliderDesc.cuboid(sx * 0.5, sy * 0.5, sz * 0.5);
        }
    }

    /** Rotate vertex positions by the mesh renderer's model rotation. */
    private rotatePositions(positions: Float32Array, mrComp: any): Float32Array {
        const deg2rad = Math.PI / 180;
        const q = Quat.fromEuler(
            (mrComp.modelRotationX || 0) * deg2rad,
            (mrComp.modelRotationY || 0) * deg2rad,
            (mrComp.modelRotationZ || 0) * deg2rad,
        );
        const rotated = new Float32Array(positions.length);
        for (let i = 0; i < positions.length; i += 3) {
            const vx = positions[i], vy = positions[i + 1], vz = positions[i + 2];
            const ix = q.w * vx + q.y * vz - q.z * vy;
            const iy = q.w * vy + q.z * vx - q.x * vz;
            const iz = q.w * vz + q.x * vy - q.y * vx;
            const iw = -q.x * vx - q.y * vy - q.z * vz;
            rotated[i]     = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
            rotated[i + 1] = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
            rotated[i + 2] = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
        }
        return rotated;
    }

    private updateExistingBody(entity: Entity, rb: RigidbodyComponent, body: RAPIER.RigidBody): void {
        const tc = entity.getComponent('TransformComponent') as TransformComponent;
        if (!tc) return;

        const offset = this.entityCenterOffset.get(entity.id) ?? new Vec3(0, 0, 0);

        if (rb.bodyType === BodyType.KINEMATIC) {
            const wp = tc.getWorldPosition();
            const wr = tc.getWorldRotation();
            body.setNextKinematicTranslation({ x: wp.x + offset.x, y: wp.y + offset.y, z: wp.z + offset.z });
            body.setNextKinematicRotation({ x: wr.x, y: wr.y, z: wr.z, w: wr.w });
        }

        // Handle teleport requests
        if ((rb as any)._teleportPosition) {
            const tp = (rb as any)._teleportPosition;
            body.setTranslation({ x: tp.x + offset.x, y: tp.y + offset.y, z: tp.z + offset.z }, true);
            body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            body.setAngvel({ x: 0, y: 0, z: 0 }, true);
            (rb as any)._teleportPosition = null;
            body.wakeUp();
        }

        body.lockRotations(!!rb.freezeRotation, true);
        if (rb.enableCCD) body.enableCcd(true);
        body.setGravityScale(rb.gravityScale, false);
        body.setLinearDamping(rb.linearDamping);
        body.setAngularDamping(rb.angularDamping);
    }

    // -- Pre-step: apply forces, impulses, velocity overrides --

    private applyPreStepForces(scene: Scene): void {
        for (const [entityId, body] of this.entityToBody) {
            const entity = scene.getEntity(entityId);
            if (!entity) continue;
            const rb = entity.getComponent('RigidbodyComponent') as RigidbodyComponent | null;
            if (!rb || rb.bodyType !== BodyType.DYNAMIC) continue;

            if (body.isSleeping()) body.wakeUp();

            // Detect velocity override from scripts
            const bodyVel = body.linvel();
            const rbVel = rb.linearVelocity;
            const velChanged = (rb as any)._velocityDirty
                || Math.abs(rbVel.x - bodyVel.x) > 0.001
                || Math.abs(rbVel.y - bodyVel.y) > 0.001
                || Math.abs(rbVel.z - bodyVel.z) > 0.001;

            if (velChanged) {
                body.setLinvel({ x: rbVel.x, y: rbVel.y, z: rbVel.z }, true);
                const av = rb.angularVelocity;
                body.setAngvel({ x: av.x, y: av.y, z: av.z }, true);
                (rb as any)._velocityDirty = false;
            }

            for (const f of rb.consumeForces()) {
                body.addForce({ x: f.x, y: f.y, z: f.z }, true);
            }
            for (const imp of rb.consumeImpulses()) {
                body.applyImpulse({ x: imp.x, y: imp.y, z: imp.z }, true);
            }
            for (const t of rb.consumeTorques()) {
                body.addTorque({ x: t.x, y: t.y, z: t.z }, true);
            }

            // Apply gravity manually (see _gravity field comment)
            const lv = body.linvel();
            body.setLinvel({ x: lv.x, y: lv.y + this._gravity.y * this.fixedTimestep, z: lv.z }, true);
        }
    }

    // -- Post-step: sync physics -> entities --

    private syncPhysicsToEntities(scene: Scene): void {
        for (const [entityId, body] of this.entityToBody) {
            const entity = scene.getEntity(entityId);
            if (!entity) continue;
            const rb = entity.getComponent('RigidbodyComponent') as RigidbodyComponent | null;
            if (!rb || rb.bodyType !== BodyType.DYNAMIC) continue;

            const tc = entity.getComponent('TransformComponent') as TransformComponent;
            if (!tc) continue;

            // Read velocity from Rapier
            const lv = body.linvel();
            const av = body.angvel();
            rb.linearVelocity.set(lv.x, lv.y, lv.z);
            rb.angularVelocity.set(av.x, av.y, av.z);
            (rb as any)._velocityDirty = false;

            // Read position (subtract center offset)
            const pos = body.translation();
            const offset = this.entityCenterOffset.get(entityId) ?? new Vec3(0, 0, 0);
            let worldX = pos.x - offset.x;
            let worldY = pos.y - offset.y;
            let worldZ = pos.z - offset.z;

            if (isNaN(worldX) || isNaN(worldY) || isNaN(worldZ)) {
                if (!this.warnedNaN.has(entityId)) {
                    console.warn(`[PhysicsSystem] NaN position on entity ${entityId} (${entity.name}) - skipping sync`);
                    this.warnedNaN.add(entityId);
                }
                continue;
            }

            // Respawn entities that fell through the world
            if (worldY < -100) {
                if (!this.warnedFell.has(entityId)) {
                    console.warn(`[PhysicsSystem] Entity ${entity.name} fell to y=${worldY.toFixed(0)}, respawning at y=5`);
                    this.warnedFell.add(entityId);
                }
                worldX = 0; worldY = 5; worldZ = 0;
                body.setTranslation({ x: offset.x, y: 5 + offset.y, z: offset.z }, true);
                body.setLinvel({ x: 0, y: 0, z: 0 }, true);
                body.setAngvel({ x: 0, y: 0, z: 0 }, true);
            }

            // Handle parent-child hierarchy
            const parent = entity.parent;
            if (parent) {
                const ptc = parent.getComponent('TransformComponent') as TransformComponent;
                if (ptc) {
                    const invParent = ptc.getWorldMatrix().inverse();
                    if (invParent) {
                        const localPos = invParent.transformPoint(new Vec3(worldX, worldY, worldZ));
                        tc.position.set(localPos.x, localPos.y, localPos.z);
                    } else {
                        tc.position.set(worldX, worldY, worldZ);
                    }
                }
            } else {
                tc.position.set(worldX, worldY, worldZ);
            }
            tc.invalidate();

            // Sync rotation (skip if rotation is locked)
            if (!rb.freezeRotation) {
                const rot = body.rotation();
                if (parent) {
                    const ptc = parent.getComponent('TransformComponent') as TransformComponent;
                    if (ptc) {
                        const parentRot = ptc.getWorldRotation();
                        const invParentRot = new Quat(-parentRot.x, -parentRot.y, -parentRot.z, parentRot.w);
                        const localRot = invParentRot.multiply(new Quat(rot.x, rot.y, rot.z, rot.w));
                        tc.rotation.set(localRot.x, localRot.y, localRot.z, localRot.w);
                    }
                } else {
                    tc.rotation.set(rot.x, rot.y, rot.z, rot.w);
                }
                tc.invalidate();
            }
        }
    }

    // -- Grounded state detection --

    private updateGroundedState(scene: Scene): void {
        if (!this.world) return;

        // Reset grounded flags
        for (const [entityId] of this.entityToBody) {
            const entity = scene.getEntity(entityId);
            if (!entity) continue;
            const rb = entity.getComponent('RigidbodyComponent') as RigidbodyComponent | null;
            if (rb && rb.bodyType === BodyType.DYNAMIC) rb.isGrounded = false;
        }

        // Check persistent contacts
        for (const [entityId, collider] of this.entityToCollider) {
            const entity = scene.getEntity(entityId);
            if (!entity) continue;
            const rb = entity.getComponent('RigidbodyComponent') as RigidbodyComponent | null;
            if (!rb || rb.bodyType !== BodyType.DYNAMIC) continue;

            const body = this.entityToBody.get(entityId);
            if (!body) continue;

            for (const [otherEid, otherCol] of this.entityToCollider) {
                if (otherEid === entityId) continue;
                try {
                    this.world.contactPair(collider, otherCol, (manifold: any) => {
                        if (!manifold) return;
                        const n = typeof manifold.normal === 'function' ? manifold.normal() : manifold.normal;
                        if (n && n.y > 0.5) rb.isGrounded = true;
                    });
                } catch {}
                if (rb.isGrounded) break;
            }

            // Contact-manifold check is authoritative. We used to have a
            // `abs(linvel.y) < 0.5 → isGrounded = true` fallback here. It
            // fired at the apex of every jump (vy crosses zero briefly
            // there) and silently told scripts the character was grounded
            // mid-air — enabling infinite space-spam jumping in every game
            // that read rb.isGrounded. If the contact pair doesn't find a
            // manifold with upward normal, we are NOT grounded; a short
            // downray fallback below handles the case where Rapier hasn't
            // generated a persistent contact yet (e.g. just landed this
            // frame, within narrow-phase numerical tolerance).
            if (!rb.isGrounded) {
                // Short downward ray from the body center. Range = 1.2× the
                // body's Y half-extent + 0.1 tolerance, so a capsule resting
                // on geometry reports grounded without reporting it mid-air.
                const t = body.translation();
                let halfY = 0.5;
                try {
                    // collider.halfExtents() / .halfHeight() depending on shape;
                    // fall back to 0.5 if API not present.
                    const shape: any = collider.shape;
                    if (shape?.halfExtents) {
                        const he = shape.halfExtents();
                        if (he?.y !== undefined) halfY = he.y;
                    } else if (typeof shape?.halfHeight === 'function') {
                        halfY = shape.halfHeight() + (shape.radius ? shape.radius() : 0);
                    } else if (shape?.radius !== undefined) {
                        halfY = typeof shape.radius === 'function' ? shape.radius() : shape.radius;
                    }
                } catch {}
                const rayLen = halfY * 1.2 + 0.1;
                try {
                    const ray = new RAPIER.Ray({ x: t.x, y: t.y, z: t.z }, { x: 0, y: -1, z: 0 });
                    const hit = this.world.castRay(ray, rayLen, true, undefined, undefined, undefined, body);
                    if (hit && hit.timeOfImpact <= rayLen) rb.isGrounded = true;
                } catch {}
            }
        }
    }

    // -- Collision event draining --

    private drainCollisionEvents(): void {
        if (!this.eventQueue || !this.world) return;

        // Collect this frame's active pairs from Rapier events
        const frameContacts = new Set<string>();
        const frameTriggers = new Set<string>();

        this.eventQueue.drainCollisionEvents((handle1: number, handle2: number, started: boolean) => {
            const eid1 = this.colliderHandleToEntity.get(handle1);
            const eid2 = this.colliderHandleToEntity.get(handle2);
            if (eid1 === undefined || eid2 === undefined) return;

            const a = Math.min(eid1, eid2);
            const b = Math.max(eid1, eid2);
            const key = `${a}:${b}`;

            // Determine if either collider is a trigger (sensor)
            const col1 = this.world!.getCollider(handle1);
            const col2 = this.world!.getCollider(handle2);
            const isTrigger = (col1?.isSensor() ?? false) || (col2?.isSensor() ?? false);

            if (started) {
                if (isTrigger) {
                    frameTriggers.add(key);
                } else {
                    frameContacts.add(key);
                }
            } else {
                // Contact ended — remove from active tracking
                if (isTrigger) {
                    if (this.activeTriggers.has(key)) {
                        this.frameTriggerEvents.push({ type: 'exit', a, b });
                        this.activeTriggers.delete(key);
                    }
                } else {
                    if (this.activeContacts.has(key)) {
                        this.frameContactEvents.push({ type: 'exit', a, b });
                        this.activeContacts.delete(key);
                    }
                }
            }

        });

        // Compute enter/stay for contacts
        for (const key of frameContacts) {
            const [aStr, bStr] = key.split(':');
            const a = parseInt(aStr), b = parseInt(bStr);
            if (this.activeContacts.has(key)) {
                this.frameContactEvents.push({ type: 'stay', a, b });
            } else {
                this.frameContactEvents.push({ type: 'enter', a, b });
                this.activeContacts.add(key);
            }
        }

        // Compute enter/stay for triggers
        for (const key of frameTriggers) {
            const [aStr, bStr] = key.split(':');
            const a = parseInt(aStr), b = parseInt(bStr);
            if (this.activeTriggers.has(key)) {
                this.frameTriggerEvents.push({ type: 'stay', a, b });
            } else {
                this.frameTriggerEvents.push({ type: 'enter', a, b });
                this.activeTriggers.add(key);
            }
        }

        // Drain contact force events to prevent queue overflow
        this.eventQueue.drainContactForceEvents(() => {});
    }

    // -- Vehicle simulation (raycast suspension) --

    private simulateVehicles(scene: Scene, dt: number): void {
        if (!this.world) return;

        for (const entity of scene.entities.values()) {
            if (!entity.active) continue;
            const vehicle = entity.getComponent('VehicleComponent') as VehicleComponent | null;
            if (!vehicle) continue;
            const rb = entity.getComponent('RigidbodyComponent') as RigidbodyComponent | null;
            if (!rb) continue;
            const body = this.entityToBody.get(entity.id);
            if (!body) continue;

            const tc = entity.getComponent('TransformComponent') as TransformComponent;
            if (!tc) continue;

            const pos = body.translation();
            const rot = body.rotation();
            const q = new Quat(rot.x, rot.y, rot.z, rot.w);

            const forward = q.multiplyVector(new Vec3(0, 0, -1));
            const right = q.multiplyVector(new Vec3(1, 0, 0));
            const up = q.multiplyVector(new Vec3(0, 1, 0));

            const scale = tc.getWorldScale();
            const steerAngle = (vehicle.steerInput ?? 0) * (vehicle.maxSteerAngle ?? 35) * Math.PI / 180;
            const throttle = vehicle.throttleInput ?? 0;
            const brake = vehicle.brakeInput ?? 0;

            let totalForceX = 0, totalForceY = 0, totalForceZ = 0;
            let groundedWheels = 0;

            const wheels = vehicle.wheels ?? [];
            if (!vehicle.wheelStates) {
                vehicle.wheelStates = wheels.map(() => ({
                    isGrounded: false,
                    suspensionLength: vehicle.suspensionRestLength ?? 0.5,
                    suspensionForce: 0,
                    groundNormal: new Vec3(0, 1, 0),
                    groundHitPoint: new Vec3(0, 0, 0),
                    spinAngle: 0,
                    slipAngle: 0,
                    slipRatio: 0,
                }));
            }

            for (let i = 0; i < wheels.length; i++) {
                const wheel = wheels[i];
                const state = vehicle.wheelStates[i];

                const lx = (wheel.localPosition?.x ?? 0) * scale.x;
                const ly = (wheel.localPosition?.y ?? 0) * scale.y;
                const lz = (wheel.localPosition?.z ?? 0) * scale.z;
                const wx = pos.x + right.x * lx + up.x * ly + forward.x * lz;
                const wy = pos.y + right.y * lx + up.y * ly + forward.y * lz;
                const wz = pos.z + right.z * lx + up.z * ly + forward.z * lz;

                const rayLength = (vehicle.suspensionRestLength ?? 0.5) + (vehicle.wheelRadius ?? 0.4);
                const ray = new RAPIER.Ray({ x: wx, y: wy, z: wz }, { x: -up.x, y: -up.y, z: -up.z });

                const hit = this.world.castRay(ray, rayLength, true, undefined, undefined, undefined, body);
                if (hit) {
                    state.isGrounded = true;
                    groundedWheels++;
                    const compression = (vehicle.suspensionRestLength ?? 0.5) - (hit.timeOfImpact - (vehicle.wheelRadius ?? 0.4));

                    // Suspension spring force
                    const suspForce = Math.max(0, compression * (vehicle.suspensionStiffness ?? 20));
                    state.suspensionForce = suspForce;
                    totalForceX += up.x * suspForce * dt;
                    totalForceY += up.y * suspForce * dt;
                    totalForceZ += up.z * suspForce * dt;

                    // Drive force
                    if (wheel.isDriven) {
                        const motorF = throttle * (vehicle.maxMotorForce ?? 8) * dt;
                        let wfx = forward.x, wfz = forward.z;
                        if (wheel.isSteered) {
                            const cs = Math.cos(steerAngle), sn = Math.sin(steerAngle);
                            wfx = forward.x * cs + right.x * sn;
                            wfz = forward.z * cs + right.z * sn;
                        }
                        totalForceX += wfx * motorF;
                        totalForceZ += wfz * motorF;
                    }

                    // Brake force
                    if (brake > 0) {
                        const lv = body.linvel();
                        const speed = Math.sqrt(lv.x * lv.x + lv.z * lv.z);
                        if (speed > 0.1) {
                            const brakeF = brake * (vehicle.maxBrakeForce ?? 15) * dt / speed;
                            totalForceX -= lv.x * Math.min(brakeF, 1);
                            totalForceZ -= lv.z * Math.min(brakeF, 1);
                        }
                    }
                } else {
                    state.isGrounded = false;
                    state.suspensionForce = 0;
                }
            }

            if (groundedWheels > 0) {
                const lv = body.linvel();
                body.setLinvel({
                    x: lv.x + totalForceX,
                    y: lv.y + totalForceY,
                    z: lv.z + totalForceZ,
                }, true);
            }

            const vel = body.linvel();
            vehicle.speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
        }
    }
}
