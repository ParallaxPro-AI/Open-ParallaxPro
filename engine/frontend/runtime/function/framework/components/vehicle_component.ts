import { Component } from '../component.js';
import { Vec3 } from '../../../core/math/vec3.js';

export interface WheelDef {
    localPosition: Vec3;
    isSteered: boolean;
    isDriven: boolean;
}

export interface WheelState {
    suspensionLength: number;
    suspensionForce: number;
    isGrounded: boolean;
    groundNormal: Vec3;
    groundHitPoint: Vec3;
    spinAngle: number;
    slipAngle: number;
    slipRatio: number;
}

/**
 * VehicleComponent implements raycast-based vehicle physics.
 *
 * Supports 4-wheel vehicles with suspension, steering, motor, and braking.
 * Each wheel casts a ray downward to simulate suspension and ground contact.
 */
export class VehicleComponent extends Component {
    maxMotorForce: number = 8;
    maxBrakeForce: number = 15;
    maxSteerAngle: number = 35;
    suspensionRestLength: number = 0.5;
    suspensionStiffness: number = 20;
    dampingCompression: number = 1.5;
    dampingRelaxation: number = 2.0;
    wheelRadius: number = 0.4;
    frictionSlip: number = 1.5;
    rollInfluence: number = 0.1;

    steerInput: number = 0;
    throttleInput: number = 0;
    brakeInput: number = 0;

    wheels: WheelDef[] = [];
    wheelStates: WheelState[] = [];
    speed: number = 0;
    rpm: number = 0;

    initialize(data: Record<string, any>): void {
        this.maxMotorForce = data.maxMotorForce ?? 8;
        this.maxBrakeForce = data.maxBrakeForce ?? 15;
        this.maxSteerAngle = data.maxSteerAngle ?? 35;
        this.suspensionRestLength = data.suspensionRestLength ?? 0.5;
        this.suspensionStiffness = data.suspensionStiffness ?? 20;
        this.dampingCompression = data.dampingCompression ?? 1.5;
        this.dampingRelaxation = data.dampingRelaxation ?? 2.0;
        this.wheelRadius = data.wheelRadius ?? 0.4;
        this.frictionSlip = data.frictionSlip ?? 1.5;
        this.rollInfluence = data.rollInfluence ?? 0.1;

        if (Array.isArray(data.wheels)) {
            const wy = this.suspensionRestLength + this.wheelRadius;
            this.wheels = data.wheels.map((w: any) => {
                let ly = w.localPosition?.y ?? 0;
                if (ly <= 0) ly = wy;
                return {
                    localPosition: new Vec3(w.localPosition?.x ?? 0, ly, w.localPosition?.z ?? 0),
                    isSteered: w.isSteered ?? false,
                    isDriven: w.isDriven ?? false,
                };
            });
        } else {
            const wy = this.suspensionRestLength + this.wheelRadius;
            this.wheels = [
                { localPosition: new Vec3(-0.8, wy, 1.2), isSteered: true, isDriven: false },
                { localPosition: new Vec3(0.8, wy, 1.2), isSteered: true, isDriven: false },
                { localPosition: new Vec3(-0.8, wy, -1.2), isSteered: false, isDriven: true },
                { localPosition: new Vec3(0.8, wy, -1.2), isSteered: false, isDriven: true },
            ];
        }

        this.wheelStates = this.wheels.map(() => ({
            suspensionLength: this.suspensionRestLength,
            suspensionForce: 0,
            isGrounded: false,
            groundNormal: new Vec3(0, 1, 0),
            groundHitPoint: new Vec3(0, 0, 0),
            spinAngle: 0,
            slipAngle: 0,
            slipRatio: 0,
        }));

        this.markDirty();
    }

    onDestroy(): void {
        this.wheels = [];
        this.wheelStates = [];
    }

    toJSON(): Record<string, any> {
        return {
            maxMotorForce: this.maxMotorForce,
            maxBrakeForce: this.maxBrakeForce,
            maxSteerAngle: this.maxSteerAngle,
            suspensionRestLength: this.suspensionRestLength,
            suspensionStiffness: this.suspensionStiffness,
            dampingCompression: this.dampingCompression,
            dampingRelaxation: this.dampingRelaxation,
            wheelRadius: this.wheelRadius,
            frictionSlip: this.frictionSlip,
            rollInfluence: this.rollInfluence,
            wheels: this.wheels.map(w => ({
                localPosition: { x: w.localPosition.x, y: w.localPosition.y, z: w.localPosition.z },
                isSteered: w.isSteered,
                isDriven: w.isDriven,
            })),
        };
    }
}
