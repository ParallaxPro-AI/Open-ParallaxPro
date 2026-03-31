import { Vec3 } from '../../../core/math/vec3.js';
import { Component } from '../component.js';

import { BodyType } from '../../../../../shared/types/physics_enums.js';
export { BodyType };

/**
 * RigidbodyComponent defines physics body properties for an entity.
 *
 * Dynamic bodies are simulated by the PhysicsSystem (transform driven by physics).
 * Kinematic bodies are moved by game logic (physics responds but doesn't move them).
 * Static bodies don't move at all.
 *
 * Forces, impulses, and torques are queued and applied by the PhysicsSystem each tick.
 */
export class RigidbodyComponent extends Component {
    bodyType: BodyType = BodyType.DYNAMIC;
    mass: number = 1.0;
    linearDamping: number = 0.5;
    angularDamping: number = 0.5;
    friction: number = 0.5;
    restitution: number = 0.3;
    gravityScale: number = 1.0;
    freezeRotation: boolean = false;
    enableCCD: boolean = false;

    get useGravity(): boolean {
        return this.gravityScale > 0;
    }
    set useGravity(value: boolean) {
        this.gravityScale = value ? 1.0 : 0;
    }

    /** Whether this body is touching a surface below it (set by physics system) */
    isGrounded: boolean = false;

    /** Handle into the PhysicsWorld (set by physics system) */
    physicsBodyId: number = -1;

    /** Force the physics system to destroy and recreate this body next tick */
    _forceRecreate: boolean = false;

    /** Flag indicating script has overridden velocity this frame */
    _velocityDirty: boolean = false;

    /** Pending teleport position (set by script, consumed by PhysicsSystem) */
    _teleportPosition: Vec3 | null = null;

    private pendingForces: Vec3[] = [];
    private pendingImpulses: Vec3[] = [];
    private pendingTorques: Vec3[] = [];
    private _linearVelocity: Vec3;
    private _angularVelocity: Vec3;

    get linearVelocity(): Vec3 { return this._linearVelocity; }
    set linearVelocity(v: any) {
        if (v instanceof Vec3) {
            this._linearVelocity.copy(v);
        } else if (v && typeof v === 'object') {
            this._linearVelocity.x = v.x ?? 0;
            this._linearVelocity.y = v.y ?? 0;
            this._linearVelocity.z = v.z ?? 0;
        }
        this._velocityDirty = true;
    }

    get angularVelocity(): Vec3 { return this._angularVelocity; }
    set angularVelocity(v: any) {
        if (v instanceof Vec3) {
            this._angularVelocity.copy(v);
        } else if (v && typeof v === 'object') {
            this._angularVelocity.x = v.x ?? 0;
            this._angularVelocity.y = v.y ?? 0;
            this._angularVelocity.z = v.z ?? 0;
        }
    }

    get velocity(): Vec3 { return this._linearVelocity; }
    set velocity(v: any) { this.linearVelocity = v; }

    constructor() {
        super();
        this._linearVelocity = new Vec3(0, 0, 0);
        this._angularVelocity = new Vec3(0, 0, 0);
    }

    // -- Force / Impulse API --------------------------------------------------

    addForce(forceOrX: Vec3 | number, y?: number, z?: number): void {
        this.pendingForces.push(this.toVec3(forceOrX, y, z));
    }

    addImpulse(impulseOrX: Vec3 | number, y?: number, z?: number): void {
        this.pendingImpulses.push(this.toVec3(impulseOrX, y, z));
    }

    applyForce(forceOrX: Vec3 | number, y?: number, z?: number): void {
        this.addForce(forceOrX, y, z);
    }

    applyImpulse(impulseOrX: Vec3 | number, y?: number, z?: number): void {
        this.addImpulse(impulseOrX, y, z);
    }

    addTorque(torqueOrX: Vec3 | number, y?: number, z?: number): void {
        this.pendingTorques.push(this.toVec3(torqueOrX, y, z));
    }

    setLinearVelocity(velocityOrX: Vec3 | number, y?: number, z?: number): void {
        this._linearVelocity.copy(this.toVec3(velocityOrX, y, z));
        this._velocityDirty = true;
    }

    /**
     * Set only horizontal velocity (X and Z), preserving Y.
     * Recommended for movement scripts so the physics solver controls vertical velocity.
     */
    setHorizontalVelocity(x: number, z: number): void {
        this._linearVelocity.x = x;
        this._linearVelocity.z = z;
        this._velocityDirty = true;
    }

    setAngularVelocity(velocityOrX: Vec3 | number, y?: number, z?: number): void {
        this._angularVelocity.copy(this.toVec3(velocityOrX, y, z));
        this._velocityDirty = true;
    }

    getLinearVelocity(): Vec3 {
        return this._linearVelocity.clone();
    }

    getAngularVelocity(): Vec3 {
        return this._angularVelocity.clone();
    }

    /** Teleport this body to a new position and zero velocity. */
    teleport(posOrX: Vec3 | number, y?: number, z?: number): void {
        this._teleportPosition = this.toVec3(posOrX, y, z);
        this._linearVelocity.set(0, 0, 0);
        this._angularVelocity.set(0, 0, 0);
        this._velocityDirty = true;
    }

    // -- Pending force consumption (used by PhysicsSystem) --------------------

    consumeForces(): Vec3[] {
        const forces = this.pendingForces;
        this.pendingForces = [];
        return forces;
    }

    consumeImpulses(): Vec3[] {
        const impulses = this.pendingImpulses;
        this.pendingImpulses = [];
        return impulses;
    }

    consumeTorques(): Vec3[] {
        const torques = this.pendingTorques;
        this.pendingTorques = [];
        return torques;
    }

    // -- Lifecycle ------------------------------------------------------------

    initialize(data: Record<string, any>): void {
        const bt = data.bodyType ?? BodyType.DYNAMIC;
        if (typeof bt === 'string') {
            const map: Record<string, BodyType> = {
                static: BodyType.STATIC,
                dynamic: BodyType.DYNAMIC,
                kinematic: BodyType.KINEMATIC,
            };
            this.bodyType = map[bt.toLowerCase()] ?? BodyType.DYNAMIC;
        } else {
            this.bodyType = bt;
        }
        this.mass = data.mass ?? 1.0;
        this.linearDamping = data.linearDamping ?? 0.5;
        this.angularDamping = data.angularDamping ?? 0.5;
        this.friction = data.friction ?? 0.5;
        this.restitution = data.restitution ?? 0.3;
        if (data.useGravity !== undefined) {
            this.gravityScale = data.useGravity ? 1.0 : 0;
        } else {
            this.gravityScale = data.gravityScale ?? 1.0;
        }
        this.freezeRotation = data.freezeRotation ?? false;
        this.enableCCD = data.enableCCD ?? false;

        if (data.linearVelocity) {
            this._linearVelocity.set(
                data.linearVelocity.x ?? 0,
                data.linearVelocity.y ?? 0,
                data.linearVelocity.z ?? 0
            );
        }
        if (data.angularVelocity) {
            this._angularVelocity.set(
                data.angularVelocity.x ?? 0,
                data.angularVelocity.y ?? 0,
                data.angularVelocity.z ?? 0
            );
        }

        this.markDirty();
    }

    onDestroy(): void {
        this.physicsBodyId = -1;
        this.pendingForces.length = 0;
        this.pendingImpulses.length = 0;
        this.pendingTorques.length = 0;
    }

    toJSON(): Record<string, any> {
        return {
            bodyType: this.bodyType,
            mass: this.mass,
            linearDamping: this.linearDamping,
            angularDamping: this.angularDamping,
            friction: this.friction,
            restitution: this.restitution,
            gravityScale: this.gravityScale,
            useGravity: this.useGravity,
            freezeRotation: this.freezeRotation,
            enableCCD: this.enableCCD,
        };
    }

    private toVec3(a: any, b?: number, c?: number): Vec3 {
        if (a instanceof Vec3) return a.clone();
        if (typeof a === 'object' && a !== null) return new Vec3(a.x ?? 0, a.y ?? 0, a.z ?? 0);
        return new Vec3(a ?? 0, b ?? 0, c ?? 0);
    }
}
