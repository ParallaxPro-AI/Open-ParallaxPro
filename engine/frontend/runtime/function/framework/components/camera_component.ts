import { Mat4 } from '../../../core/math/mat4.js';
import { MathUtils } from '../../../core/math/math_utils.js';
import { Frustum } from '../../../core/math/frustum.js';
import { Component } from '../component.js';

export enum CameraMode {
    PERSPECTIVE = 0,
    ORTHOGRAPHIC = 1,
}

/**
 * CameraComponent provides view and projection matrix computation.
 *
 * The camera with the highest priority is the active render camera.
 * View matrix is derived from the entity's world transform (inverse).
 * Projection matrix is computed from camera parameters and canvas aspect ratio.
 */
export class CameraComponent extends Component {
    mode: CameraMode = CameraMode.PERSPECTIVE;
    fov: number = 60;
    nearClip: number = 0.1;
    farClip: number = 1000;
    orthoSize: number = 10;
    priority: number = 0;

    getViewMatrix(): Mat4 {
        const worldMatrix = this.entity.getWorldMatrix();
        return worldMatrix.inverse() ?? new Mat4();
    }

    getProjectionMatrix(aspectRatio: number): Mat4 {
        if (this.mode === CameraMode.PERSPECTIVE) {
            const fovRad = this.fov * MathUtils.DEG2RAD;
            return Mat4.perspective(fovRad, aspectRatio, this.nearClip, this.farClip);
        } else {
            const halfHeight = this.orthoSize;
            const halfWidth = halfHeight * aspectRatio;
            return Mat4.ortho(
                -halfWidth, halfWidth,
                -halfHeight, halfHeight,
                this.nearClip, this.farClip
            );
        }
    }

    getVPMatrix(aspectRatio: number): Mat4 {
        const view = this.getViewMatrix();
        const projection = this.getProjectionMatrix(aspectRatio);
        return projection.multiply(view);
    }

    getFrustum(aspectRatio: number): Frustum {
        const vp = this.getVPMatrix(aspectRatio);
        return Frustum.fromVPMatrix(vp);
    }

    initialize(data: Record<string, any>): void {
        this.mode = data.mode ?? CameraMode.PERSPECTIVE;
        this.fov = data.fov ?? 60;
        this.nearClip = data.nearClip ?? data.near ?? 0.1;
        this.farClip = data.farClip ?? data.far ?? 1000;
        this.orthoSize = data.orthoSize ?? 10;
        this.priority = data.priority ?? (data.isMain ? 100 : 0);
    }

    toJSON(): Record<string, any> {
        return {
            mode: this.mode,
            fov: this.fov,
            nearClip: this.nearClip,
            farClip: this.farClip,
            orthoSize: this.orthoSize,
            priority: this.priority,
        };
    }
}
