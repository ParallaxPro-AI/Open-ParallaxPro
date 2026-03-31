import { Vec3 } from '../../../runtime/core/math/vec3.js';
import { Mat4 } from '../../../runtime/core/math/mat4.js';
import { EditorContext } from '../editor_context.js';

/**
 * Editor camera with two navigation modes:
 *
 * Orbit mode (default):
 *  - Ctrl/Cmd + left-drag: orbit around target
 *  - Shift + left-drag: pan
 *  - Right-click drag: orbit
 *  - Middle-click drag: pan
 *  - Scroll wheel: zoom
 *
 * Fly mode:
 *  - WASD: move forward/back/left/right
 *  - Q/E: move down/up
 *  - Left-drag: mouse look (FPS-style)
 *  - Scroll wheel: adjust fly speed
 */
export class EditorCamera {
    /** Camera target (orbit center). */
    target: Vec3 = new Vec3(0, 0, 0);

    /** Spherical coordinates relative to target. */
    private yaw: number = 0.4;
    private pitch: number = 0.5;
    private distance: number = 15;

    /** Camera properties. */
    fov: number = 60 * (Math.PI / 180);
    near: number = 0.1;
    far: number = 1000;
    aspect: number = 1;

    /** Fly mode state. */
    private flyMode: boolean = false;
    private flyPosition: Vec3 = new Vec3(0, 5, 15);
    private flyYaw: number = 0;
    private flyPitch: number = 0;
    private flySpeed: number = 10;
    private keysDown: Set<string> = new Set();

    /** When true, all input is ignored (e.g. Game tab during play mode). */
    disabled: boolean = false;

    /** Interaction state. */
    private isOrbiting: boolean = false;
    private isPanning: boolean = false;
    private lastMouseX: number = 0;
    private lastMouseY: number = 0;

    private canvas: HTMLCanvasElement | null = null;

    /** Computed matrices. */
    private viewMatrix: Mat4 = new Mat4();
    private projectionMatrix: Mat4 = new Mat4();
    private viewProjectionMatrix: Mat4 = new Mat4();

    private getNavMode(): 'orbit' | 'fly' {
        return EditorContext.instance.state.cameraMode;
    }

    attach(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;

        canvas.addEventListener('mousedown', this.onMouseDown);
        canvas.addEventListener('wheel', this.onWheel, { passive: false });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('blur', this.onBlur);

        EditorContext.instance.on('cameraModeChanged', (mode: string) => {
            if (mode === 'fly' && !this.flyMode) {
                this.flyPosition = this.getOrbitPosition();
                this.flyYaw = this.yaw + Math.PI;
                this.flyPitch = -this.pitch;
                this.flyMode = true;
            } else if (mode !== 'fly' && this.flyMode) {
                this.target = this.flyPosition.add(
                    new Vec3(
                        Math.cos(this.flyPitch) * Math.sin(this.flyYaw) * this.distance,
                        Math.sin(this.flyPitch) * this.distance,
                        Math.cos(this.flyPitch) * Math.cos(this.flyYaw) * this.distance,
                    )
                );
                this.yaw = this.flyYaw + Math.PI;
                this.pitch = -this.flyPitch;
                this.flyMode = false;
            }
        });
    }

    detach(): void {
        if (this.canvas) {
            this.canvas.removeEventListener('mousedown', this.onMouseDown);
            this.canvas.removeEventListener('wheel', this.onWheel);
        }
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('blur', this.onBlur);
    }

    /** Update the camera matrices. Call each frame. */
    update(deltaTime: number): void {
        if (this.canvas) {
            this.aspect = this.canvas.clientWidth / Math.max(this.canvas.clientHeight, 1);
        }

        if (this.getNavMode() === 'fly' && this.flyMode) {
            this.updateFlyMode(deltaTime);
        }

        this.computeMatrices();
    }

    /** Focus on a world-space position. */
    focusOn(position: Vec3, radius: number = 3): void {
        this.target.copy(position);
        this.distance = Math.max(radius * 2.5, 3);
        this.flyMode = false;
    }

    /** Set camera position and orbit target directly. */
    setPositionAndTarget(position: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }): void {
        this.target.set(target.x, target.y, target.z);
        const dx = position.x - target.x;
        const dy = position.y - target.y;
        const dz = position.z - target.z;
        this.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (this.distance < 0.01) this.distance = 5;
        this.yaw = Math.atan2(dx, dz);
        this.pitch = Math.asin(Math.max(-1, Math.min(1, dy / this.distance)));
        this.flyMode = false;
    }

    getPosition(): Vec3 {
        if (this.flyMode) {
            return this.flyPosition.clone();
        }
        return this.getOrbitPosition();
    }

    getViewMatrix(): Mat4 {
        return this.viewMatrix;
    }

    getProjectionMatrix(): Mat4 {
        return this.projectionMatrix;
    }

    getViewProjectionMatrix(): Mat4 {
        return this.viewProjectionMatrix;
    }

    toJSON(): any {
        return {
            target: { x: this.target.x, y: this.target.y, z: this.target.z },
            yaw: this.yaw,
            pitch: this.pitch,
            distance: this.distance,
            flyPosition: { x: this.flyPosition.x, y: this.flyPosition.y, z: this.flyPosition.z },
            flyYaw: this.flyYaw,
            flyPitch: this.flyPitch,
            flySpeed: this.flySpeed,
            flyMode: this.flyMode,
        };
    }

    fromJSON(data: any): void {
        if (!data) return;
        if (data.target) this.target = new Vec3(data.target.x, data.target.y, data.target.z);
        if (data.yaw != null) this.yaw = data.yaw;
        if (data.pitch != null) this.pitch = data.pitch;
        if (data.distance != null) this.distance = data.distance;
        if (data.flyPosition) this.flyPosition = new Vec3(data.flyPosition.x, data.flyPosition.y, data.flyPosition.z);
        if (data.flyYaw != null) this.flyYaw = data.flyYaw;
        if (data.flyPitch != null) this.flyPitch = data.flyPitch;
        if (data.flySpeed != null) this.flySpeed = data.flySpeed;
        if (data.flyMode != null) this.flyMode = data.flyMode;
    }

    // ── Private ────────────────────────────────────────────────────────

    private getOrbitPosition(): Vec3 {
        const x = this.target.x + this.distance * Math.cos(this.pitch) * Math.sin(this.yaw);
        const y = this.target.y + this.distance * Math.sin(this.pitch);
        const z = this.target.z + this.distance * Math.cos(this.pitch) * Math.cos(this.yaw);
        return new Vec3(x, y, z);
    }

    private computeMatrices(): void {
        const eye = this.flyMode ? this.flyPosition : this.getOrbitPosition();
        const up = new Vec3(0, 1, 0);

        if (this.flyMode) {
            const dir = new Vec3(
                Math.cos(this.flyPitch) * Math.sin(this.flyYaw),
                Math.sin(this.flyPitch),
                Math.cos(this.flyPitch) * Math.cos(this.flyYaw),
            );
            const lookTarget = eye.add(dir);
            Mat4.lookAt(eye, lookTarget, up, this.viewMatrix);
        } else {
            Mat4.lookAt(eye, this.target, up, this.viewMatrix);
        }

        Mat4.perspective(this.fov, this.aspect, this.near, this.far, this.projectionMatrix);
        this.projectionMatrix.multiply(this.viewMatrix, this.viewProjectionMatrix);
    }

    private updateFlyMode(deltaTime: number): void {
        const sprint = this.keysDown.has('shift') ? 2 : 1;
        const speed = this.flySpeed * deltaTime * sprint;

        const forward = new Vec3(
            Math.cos(this.flyPitch) * Math.sin(this.flyYaw),
            0,
            Math.cos(this.flyPitch) * Math.cos(this.flyYaw),
        ).normalize();

        const right = new Vec3(0, 1, 0).cross(forward).normalize().negate();
        const up = new Vec3(0, 1, 0);

        if (this.keysDown.has('w')) this.flyPosition = this.flyPosition.add(forward.scale(speed));
        if (this.keysDown.has('s')) this.flyPosition = this.flyPosition.sub(forward.scale(speed));
        if (this.keysDown.has('a')) this.flyPosition = this.flyPosition.sub(right.scale(speed));
        if (this.keysDown.has('d')) this.flyPosition = this.flyPosition.add(right.scale(speed));
        if (this.keysDown.has('e') || this.keysDown.has(' ')) this.flyPosition = this.flyPosition.add(up.scale(speed));
        if (this.keysDown.has('q') || this.keysDown.has('control')) this.flyPosition = this.flyPosition.sub(up.scale(speed));
    }

    // ── Event Handlers ──────────────────────────────────────────────────

    private onMouseDown = (e: MouseEvent): void => {
        if (this.disabled) return;
        const mode = this.getNavMode();

        if (e.button === 0) {
            if (mode === 'fly') {
                e.preventDefault();
                this.isOrbiting = true;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
                this.canvas?.requestPointerLock();
            } else if (e.shiftKey) {
                e.preventDefault();
                this.isPanning = true;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
            } else if (e.ctrlKey || e.metaKey || e.altKey) {
                e.preventDefault();
                this.isOrbiting = true;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
            }
        } else if (e.button === 2) {
            this.isOrbiting = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            if (mode === 'fly') this.canvas?.requestPointerLock();
        } else if (e.button === 1) {
            e.preventDefault();
            this.isPanning = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
        }
    };

    private onMouseMove = (e: MouseEvent): void => {
        if (this.disabled) return;
        const locked = document.pointerLockElement === this.canvas;
        const dx = locked ? e.movementX : e.clientX - this.lastMouseX;
        const dy = locked ? e.movementY : e.clientY - this.lastMouseY;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        if (this.isOrbiting) {
            const sensitivity = 0.005;
            if (this.flyMode) {
                this.flyYaw -= dx * sensitivity;
                this.flyPitch -= dy * sensitivity;
                this.flyPitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.flyPitch));
            } else {
                this.yaw -= dx * sensitivity;
                this.pitch += dy * sensitivity;
                this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
            }
        }

        if (this.isPanning && !this.flyMode) {
            const panSpeed = this.distance * 0.002;
            const eye = this.getOrbitPosition();
            const forward = this.target.sub(eye).normalize();
            const worldUp = new Vec3(0, 1, 0);
            const right = forward.cross(worldUp).normalize();
            const up = right.cross(forward).normalize();

            this.target = this.target.sub(right.scale(dx * panSpeed));
            this.target = this.target.add(up.scale(dy * panSpeed));
        }
    };

    private onMouseUp = (e: MouseEvent): void => {
        if (e.button === 0) {
            this.isPanning = false;
            this.isOrbiting = false;
        }
        if (e.button === 2) {
            this.isOrbiting = false;
        }
        if (e.button === 1) {
            this.isPanning = false;
        }
        if (document.pointerLockElement === this.canvas) {
            document.exitPointerLock();
        }
    };

    private onWheel = (e: WheelEvent): void => {
        if (this.disabled) { e.preventDefault(); return; }
        e.preventDefault();
        if (this.flyMode) {
            this.flySpeed = Math.max(1, Math.min(100, this.flySpeed - e.deltaY * 0.01));
        } else {
            const zoomFactor = 1 + e.deltaY * 0.001;
            this.distance = Math.max(0.5, Math.min(500, this.distance * zoomFactor));
        }
    };

    private isTextInput(e: KeyboardEvent): boolean {
        const t = e.target as HTMLElement;
        return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
    }

    private static readonly FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', ' ', 'control', 'shift']);

    private onKeyDown = (e: KeyboardEvent): void => {
        if (this.isTextInput(e)) return;
        if (this.disabled) return;
        this.keysDown.add(e.key.toLowerCase());
        if (this.flyMode && EditorCamera.FLY_KEYS.has(e.key.toLowerCase())) {
            e.preventDefault();
        }
    };

    private onKeyUp = (e: KeyboardEvent): void => {
        if (this.isTextInput(e)) return;
        this.keysDown.delete(e.key.toLowerCase());
    };

    private onBlur = (): void => {
        this.keysDown.clear();
        this.isOrbiting = false;
        this.isPanning = false;
    };
}
