import { EditorContext } from '../editor_context.js';
import { EditorCamera } from '../input/editor_camera.js';
import { Vec3 } from '../../../runtime/core/math/vec3.js';
import { Mat4 } from '../../../runtime/core/math/mat4.js';
import { Quat } from '../../../runtime/core/math/quat.js';
import { CameraComponent } from '../../../runtime/function/framework/components/camera_component.js';
import { LightComponent, LightType } from '../../../runtime/function/framework/components/light_component.js';
import { ColliderComponent, ShapeType } from '../../../runtime/function/framework/components/collider_component.js';
import { VehicleComponent } from '../../../runtime/function/framework/components/vehicle_component.js';
import { TerrainComponent } from '../../../runtime/function/framework/components/terrain_component.js';
import { ChangePropertyCommand, BatchCommand } from '../history/commands.js';
import { isMobile } from '../utils/mobile.js';

type Axis = 'x' | 'y' | 'z' | 'all' | null;
type ColliderHandle = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'
    | 'cap+y' | 'cap-y' | 'cap+x' | 'cap-x' | 'cap+z' | 'cap-z' | null;

/**
 * Transform gizmo rendering and interaction system.
 *
 * Draws translate arrows, rotate rings, or scale cube endpoints
 * on a 2D canvas overlay. Handles drag operations, axis highlighting,
 * and snap support.
 */
export class GizmoSystem {
    private ctx: EditorContext;
    private camera: EditorCamera;
    private overlayCanvas: HTMLCanvasElement | null = null;
    private overlayCtx2D: CanvasRenderingContext2D | null = null;

    private hoveredAxis: Axis = null;
    private draggingAxis: Axis = null;
    private dragStartScreenPos: { x: number; y: number } = { x: 0, y: 0 };
    private dragStartValue: Vec3 = new Vec3();
    private dragStartQuat: { x: number; y: number; z: number; w: number } = { x: 0, y: 0, z: 0, w: 1 };
    private dragStartAngle: number = 0;
    private multiDragStarts: Map<number, { pos: Vec3; scale: Vec3; quat: { x: number; y: number; z: number; w: number } }> = new Map();
    private interacting: boolean = false;

    // Collider handle state
    private hoveredColliderHandle: ColliderHandle = null;
    private draggingColliderHandle: ColliderHandle = null;
    private colliderDragStartHalfExtents: Vec3 = new Vec3();
    private colliderDragStartCenter: Vec3 = new Vec3();
    private colliderDragStartScreenPos: { x: number; y: number } = { x: 0, y: 0 };
    private capsuleDragStartRadius: number = 0;
    private capsuleDragStartHeight: number = 0;

    // Terrain sculpt state
    private sculptBrushWorldPos: Vec3 | null = null;
    private sculpting: boolean = false;
    private sculptHeightSnapshot: Float32Array | null = null;
    private sculptTerrainEntityId: number = -1;

    private readonly axisColors = {
        x: '#e74c3c',
        y: '#2ecc71',
        z: '#3498db',
    };

    private readonly axisHighlightColors = {
        x: '#ff7675',
        y: '#55efc4',
        z: '#74b9ff',
    };

    constructor(camera: EditorCamera) {
        this.ctx = EditorContext.instance;
        this.camera = camera;
    }

    private touchTarget: HTMLCanvasElement | null = null;

    attachOverlay(canvas: HTMLCanvasElement): void {
        this.overlayCanvas = canvas;
        this.overlayCtx2D = canvas.getContext('2d');

        canvas.addEventListener('mousemove', this.onMouseMove);
        canvas.addEventListener('mousedown', this.onMouseDown);
        window.addEventListener('mousemove', this.onDragMove);
        window.addEventListener('mouseup', this.onMouseUp);

        canvas.addEventListener('touchstart', this.onGizmoTouchStart, { passive: false });
        canvas.addEventListener('touchmove', this.onGizmoTouchMove, { passive: false });
        canvas.addEventListener('touchend', this.onGizmoTouchEnd, { passive: false });
        canvas.addEventListener('touchcancel', this.onGizmoTouchEnd, { passive: false });
    }

    attachTouchTarget(canvas: HTMLCanvasElement): void {
        this.touchTarget = canvas;
        canvas.addEventListener('touchstart', this.onGizmoTouchStart, { passive: false });
        canvas.addEventListener('touchmove', this.onGizmoTouchMove, { passive: false });
        canvas.addEventListener('touchend', this.onGizmoTouchEnd, { passive: false });
        canvas.addEventListener('touchcancel', this.onGizmoTouchEnd, { passive: false });
    }

    detach(): void {
        if (this.overlayCanvas) {
            this.overlayCanvas.removeEventListener('mousemove', this.onMouseMove);
            this.overlayCanvas.removeEventListener('mousedown', this.onMouseDown);
            this.overlayCanvas.removeEventListener('touchstart', this.onGizmoTouchStart);
            this.overlayCanvas.removeEventListener('touchmove', this.onGizmoTouchMove);
            this.overlayCanvas.removeEventListener('touchend', this.onGizmoTouchEnd);
            this.overlayCanvas.removeEventListener('touchcancel', this.onGizmoTouchEnd);
        }
        if (this.touchTarget) {
            this.touchTarget.removeEventListener('touchstart', this.onGizmoTouchStart);
            this.touchTarget.removeEventListener('touchmove', this.onGizmoTouchMove);
            this.touchTarget.removeEventListener('touchend', this.onGizmoTouchEnd);
            this.touchTarget.removeEventListener('touchcancel', this.onGizmoTouchEnd);
        }
        window.removeEventListener('mousemove', this.onDragMove);
        window.removeEventListener('mouseup', this.onMouseUp);
    }

    isInteracting(): boolean {
        return this.interacting;
    }

    /** Draw gizmo overlays for the selected entity. */
    draw(): void {
        if (!this.overlayCtx2D || !this.overlayCanvas) return;
        const canvas = this.overlayCanvas;
        const g = this.overlayCtx2D;

        if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
            canvas.width = canvas.clientWidth;
            canvas.height = canvas.clientHeight;
        }

        g.clearRect(0, 0, canvas.width, canvas.height);

        if (!this.ctx.state.isPlaying) {
            this.drawCameraFrustums(g, canvas.width, canvas.height);
            this.drawSpotLightCones(g);
        }

        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0 || this.ctx.state.isPlaying) return;

        const entity = selected[0];
        const worldPos = entity.getWorldPosition();
        const screenPos = this.worldToScreen(worldPos);
        if (!screenPos) return;

        const mode = this.ctx.state.gizmoMode;
        const gizmoLength = 80;

        if (mode === 'translate') {
            this.drawArrow(g, screenPos, 'x', gizmoLength);
            this.drawArrow(g, screenPos, 'y', gizmoLength);
            this.drawArrow(g, screenPos, 'z', gizmoLength);
        } else if (mode === 'rotate') {
            this.drawRing(g, screenPos, 'x', gizmoLength * 0.8);
            this.drawRing(g, screenPos, 'y', gizmoLength * 0.8);
            this.drawRing(g, screenPos, 'z', gizmoLength * 0.8);
        } else if (mode === 'scale') {
            this.drawScaleAxis(g, screenPos, 'x', gizmoLength);
            this.drawScaleAxis(g, screenPos, 'y', gizmoLength);
            this.drawScaleAxis(g, screenPos, 'z', gizmoLength);

            const isAllHovered = this.hoveredAxis === 'all' || this.draggingAxis === 'all';
            const centerSize = 7;
            g.fillStyle = isAllHovered ? '#ffffff' : '#cccccc';
            g.fillRect(screenPos.x - centerSize, screenPos.y - centerSize, centerSize * 2, centerSize * 2);
            g.strokeStyle = isAllHovered ? '#ffffff' : '#888888';
            g.lineWidth = 1;
            g.strokeRect(screenPos.x - centerSize, screenPos.y - centerSize, centerSize * 2, centerSize * 2);
        }

        // Selection highlight box around selected entities
        for (const ent of selected) {
            const mr = ent.getComponent('MeshRendererComponent') as any;
            const terrain = ent.getComponent('TerrainComponent') as any;
            let bMin: Vec3, bMax: Vec3;
            if (terrain) {
                const hw = terrain.width / 2;
                const hd = terrain.depth / 2;
                bMin = new Vec3(-hw, 0, -hd);
                bMax = new Vec3(hw, terrain.heightScale, hd);
            } else if (mr?.gpuMesh?.boundMin && mr?.gpuMesh?.boundMax) {
                bMin = mr.gpuMesh.boundMin;
                bMax = mr.gpuMesh.boundMax;
            } else {
                bMin = new Vec3(-0.5, -0.5, -0.5);
                bMax = new Vec3(0.5, 0.5, 0.5);
            }

            const worldMatrix = ent.getWorldMatrix();
            let sMinX = Infinity, sMinY = Infinity;
            let sMaxX = -Infinity, sMaxY = -Infinity;
            let allVisible = true;
            for (let i = 0; i < 8; i++) {
                const cx = (i & 1) ? bMax.x : bMin.x;
                const cy = (i & 2) ? bMax.y : bMin.y;
                const cz = (i & 4) ? bMax.z : bMin.z;
                const wp = worldMatrix.transformPoint(new Vec3(cx, cy, cz));
                const sp = this.worldToScreen(wp);
                if (!sp) { allVisible = false; break; }
                if (sp.x < sMinX) sMinX = sp.x;
                if (sp.x > sMaxX) sMaxX = sp.x;
                if (sp.y < sMinY) sMinY = sp.y;
                if (sp.y > sMaxY) sMaxY = sp.y;
            }

            if (allVisible && sMaxX > sMinX && sMaxY > sMinY) {
                const pad = 4;
                g.strokeStyle = '#69bbf3';
                g.lineWidth = 1;
                g.strokeRect(sMinX - pad, sMinY - pad, (sMaxX - sMinX) + pad * 2, (sMaxY - sMinY) + pad * 2);
            }
        }

        this.drawColliderOverlays(g);
        this.drawVehicleOverlays(g);

        if (this.ctx.state.terrainSculptActive && this.sculptBrushWorldPos) {
            this.drawTerrainBrushPreview(g);
        }
    }

    // ── Drawing Helpers ─────────────────────────────────────────────────

    /**
     * Get the world-space direction for a local axis of the selected entity,
     * accounting for entity rotation.
     */
    private getLocalAxisWorld(axis: 'x' | 'y' | 'z'): Vec3 {
        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0) {
            if (axis === 'x') return new Vec3(1, 0, 0);
            if (axis === 'y') return new Vec3(0, 1, 0);
            return new Vec3(0, 0, 1);
        }
        const m = selected[0].getWorldMatrix().data;
        if (axis === 'x') return new Vec3(m[0], m[1], m[2]).normalize();
        if (axis === 'y') return new Vec3(m[4], m[5], m[6]).normalize();
        return new Vec3(m[8], m[9], m[10]).normalize();
    }

    /**
     * Get the world-space axis direction based on the current gizmo space setting.
     * Rotate always uses local. Translate/scale use global or local per toggle.
     */
    private getEffectiveAxisWorld(axis: 'x' | 'y' | 'z'): Vec3 {
        const mode = this.ctx.state.gizmoMode;
        if (mode === 'rotate' || this.ctx.state.gizmoSpace === 'local') {
            return this.getLocalAxisWorld(axis);
        }
        if (axis === 'x') return new Vec3(1, 0, 0);
        if (axis === 'y') return new Vec3(0, 1, 0);
        return new Vec3(0, 0, 1);
    }

    /** Project a 3D axis direction to a 2D screen-space direction. */
    private getAxisScreenDir(axis: Axis, origin: { x: number; y: number }): { dx: number; dy: number } {
        if (!axis) return { dx: 0, dy: 0 };

        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0) return { dx: 0, dy: 0 };

        const worldPos = selected[0].getWorldPosition();
        const axisDir = this.getEffectiveAxisWorld(axis as 'x' | 'y' | 'z');

        const camPos = this.camera.getPosition();
        const dist = worldPos.sub(camPos).length();
        const offset = Math.max(dist * 0.1, 0.01);

        const tipWorld = worldPos.add(axisDir.scale(offset));
        const tipScreen = this.worldToScreen(tipWorld);
        if (!tipScreen) return { dx: 0, dy: 0 };

        let dx = tipScreen.x - origin.x;
        let dy = tipScreen.y - origin.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001) return { dx: 0, dy: 0 };
        dx /= len;
        dy /= len;
        return { dx, dy };
    }

    private drawArrow(g: CanvasRenderingContext2D, origin: { x: number; y: number }, axis: 'x' | 'y' | 'z', length: number): void {
        const dir = this.getAxisScreenDir(axis, origin);
        const endX = origin.x + dir.dx * length;
        const endY = origin.y + dir.dy * length;

        const isHovered = this.hoveredAxis === axis || this.draggingAxis === axis;
        const color = isHovered ? this.axisHighlightColors[axis] : this.axisColors[axis];

        g.beginPath();
        g.moveTo(origin.x, origin.y);
        g.lineTo(endX, endY);
        g.strokeStyle = color;
        g.lineWidth = isHovered ? 3 : 2;
        g.stroke();

        const headSize = 8;
        const angle = Math.atan2(dir.dy, dir.dx);
        g.beginPath();
        g.moveTo(endX, endY);
        g.lineTo(endX - headSize * Math.cos(angle - 0.4), endY - headSize * Math.sin(angle - 0.4));
        g.lineTo(endX - headSize * Math.cos(angle + 0.4), endY - headSize * Math.sin(angle + 0.4));
        g.closePath();
        g.fillStyle = color;
        g.fill();
    }

    private drawRing(g: CanvasRenderingContext2D, origin: { x: number; y: number }, axis: 'x' | 'y' | 'z', radius: number): void {
        const isHovered = this.hoveredAxis === axis || this.draggingAxis === axis;
        const color = isHovered ? this.axisHighlightColors[axis] : this.axisColors[axis];

        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0) return;
        const worldPos = selected[0].getWorldPosition();

        const camPos = this.camera.getPosition();
        const camDist = worldPos.sub(camPos).length();
        const worldRadius = camDist * 0.15;

        let d1: Vec3, d2: Vec3;
        if (axis === 'x') { d1 = this.getLocalAxisWorld('y'); d2 = this.getLocalAxisWorld('z'); }
        else if (axis === 'y') { d1 = this.getLocalAxisWorld('x'); d2 = this.getLocalAxisWorld('z'); }
        else { d1 = this.getLocalAxisWorld('x'); d2 = this.getLocalAxisWorld('y'); }

        const segments = 48;
        g.beginPath();
        let started = false;
        for (let i = 0; i <= segments; i++) {
            const t = (i / segments) * Math.PI * 2;
            const cosT = Math.cos(t);
            const sinT = Math.sin(t);
            const wp = worldPos.add(d1.scale(cosT * worldRadius)).add(d2.scale(sinT * worldRadius));
            const sp = this.worldToScreen(wp);
            if (!sp) { started = false; continue; }
            if (!started) { g.moveTo(sp.x, sp.y); started = true; }
            else g.lineTo(sp.x, sp.y);
        }
        g.strokeStyle = color;
        g.lineWidth = isHovered ? 3 : 2;
        g.stroke();
    }

    private drawScaleAxis(g: CanvasRenderingContext2D, origin: { x: number; y: number }, axis: 'x' | 'y' | 'z', length: number): void {
        const dir = this.getAxisScreenDir(axis, origin);
        const endX = origin.x + dir.dx * length;
        const endY = origin.y + dir.dy * length;

        const isHovered = this.hoveredAxis === axis || this.draggingAxis === axis;
        const color = isHovered ? this.axisHighlightColors[axis] : this.axisColors[axis];

        g.beginPath();
        g.moveTo(origin.x, origin.y);
        g.lineTo(endX, endY);
        g.strokeStyle = color;
        g.lineWidth = isHovered ? 3 : 2;
        g.stroke();

        const cubeSize = 5;
        g.fillStyle = color;
        g.fillRect(endX - cubeSize, endY - cubeSize, cubeSize * 2, cubeSize * 2);
    }

    private drawCameraFrustums(g: CanvasRenderingContext2D, width: number, height: number): void {
        const scene = this.ctx.getActiveScene();
        if (!scene) return;

        for (const entity of scene.entities.values()) {
            const cam = entity.getComponent('CameraComponent') as CameraComponent | null;
            if (!cam) continue;

            const worldPos = entity.getWorldPosition();
            const worldMatrix = entity.getWorldMatrix();

            const right = new Vec3(worldMatrix.data[0], worldMatrix.data[1], worldMatrix.data[2]).normalize();
            const up = new Vec3(worldMatrix.data[4], worldMatrix.data[5], worldMatrix.data[6]).normalize();
            const forward = new Vec3(-worldMatrix.data[8], -worldMatrix.data[9], -worldMatrix.data[10]).normalize();

            const fovRad = cam.fov * (Math.PI / 180);
            const aspect = width / Math.max(height, 1);
            const nearDist = cam.nearClip;
            const farDist = Math.min(cam.farClip, 1.5);

            const nearH = Math.tan(fovRad / 2) * nearDist;
            const nearW = nearH * aspect;
            const farH = Math.tan(fovRad / 2) * farDist;
            const farW = farH * aspect;

            const nc = worldPos.add(forward.scale(nearDist));
            const fc = worldPos.add(forward.scale(farDist));

            const ntl = nc.add(up.scale(nearH)).sub(right.scale(nearW));
            const ntr = nc.add(up.scale(nearH)).add(right.scale(nearW));
            const nbl = nc.sub(up.scale(nearH)).sub(right.scale(nearW));
            const nbr = nc.sub(up.scale(nearH)).add(right.scale(nearW));

            const ftl = fc.add(up.scale(farH)).sub(right.scale(farW));
            const ftr = fc.add(up.scale(farH)).add(right.scale(farW));
            const fbl = fc.sub(up.scale(farH)).sub(right.scale(farW));
            const fbr = fc.sub(up.scale(farH)).add(right.scale(farW));

            const corners = [ntl, ntr, nbl, nbr, ftl, ftr, fbl, fbr].map(c => this.worldToScreen(c));
            if (corners.some(c => c === null)) continue;
            const [sntl, sntr, snbl, snbr, sftl, sftr, sfbl, sfbr] = corners as { x: number; y: number }[];

            g.strokeStyle = 'rgba(200, 200, 200, 0.6)';
            g.lineWidth = 1;

            g.beginPath();
            g.moveTo(sntl.x, sntl.y);
            g.lineTo(sntr.x, sntr.y);
            g.lineTo(snbr.x, snbr.y);
            g.lineTo(snbl.x, snbl.y);
            g.closePath();
            g.stroke();

            g.beginPath();
            g.moveTo(sftl.x, sftl.y);
            g.lineTo(sftr.x, sftr.y);
            g.lineTo(sfbr.x, sfbr.y);
            g.lineTo(sfbl.x, sfbl.y);
            g.closePath();
            g.stroke();

            g.beginPath();
            g.moveTo(sntl.x, sntl.y); g.lineTo(sftl.x, sftl.y);
            g.moveTo(sntr.x, sntr.y); g.lineTo(sftr.x, sftr.y);
            g.moveTo(snbl.x, snbl.y); g.lineTo(sfbl.x, sfbl.y);
            g.moveTo(snbr.x, snbr.y); g.lineTo(sfbr.x, sfbr.y);
            g.stroke();
        }
    }

    private drawSpotLightCones(g: CanvasRenderingContext2D): void {
        const scene = this.ctx.getActiveScene();
        if (!scene) return;

        const SEGMENTS = 16;
        const CONE_LENGTH = 3;

        for (const entity of scene.entities.values()) {
            const light = entity.getComponent('LightComponent') as LightComponent | null;
            if (!light || light.lightType !== LightType.SPOT) continue;

            const worldPos = entity.getWorldPosition();
            const worldMatrix = entity.getWorldMatrix();

            const right = new Vec3(worldMatrix.data[0], worldMatrix.data[1], worldMatrix.data[2]).normalize();
            const up = new Vec3(worldMatrix.data[4], worldMatrix.data[5], worldMatrix.data[6]).normalize();
            const forward = new Vec3(-worldMatrix.data[8], -worldMatrix.data[9], -worldMatrix.data[10]).normalize();

            const tipEnd = worldPos.add(forward.scale(CONE_LENGTH));
            const outerRadius = Math.tan(light.outerConeAngle) * CONE_LENGTH;
            const innerRadius = Math.tan(light.innerConeAngle) * CONE_LENGTH;

            const outerPts: Vec3[] = [];
            const innerPts: Vec3[] = [];
            for (let i = 0; i < SEGMENTS; i++) {
                const angle = (i / SEGMENTS) * Math.PI * 2;
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);
                const offset = right.scale(cos).add(up.scale(sin));
                outerPts.push(tipEnd.add(offset.scale(outerRadius)));
                innerPts.push(tipEnd.add(offset.scale(innerRadius)));
            }

            const sTip = this.worldToScreen(worldPos);
            const sOuter = outerPts.map(p => this.worldToScreen(p));
            const sInner = innerPts.map(p => this.worldToScreen(p));
            if (!sTip || sOuter.some(p => p === null) || sInner.some(p => p === null)) continue;
            const so = sOuter as { x: number; y: number }[];
            const si = sInner as { x: number; y: number }[];

            // Outer cone circle
            g.strokeStyle = 'rgba(255, 220, 80, 0.6)';
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(so[0].x, so[0].y);
            for (let i = 1; i < SEGMENTS; i++) g.lineTo(so[i].x, so[i].y);
            g.closePath();
            g.stroke();

            // Inner cone circle (dashed)
            g.setLineDash([4, 4]);
            g.strokeStyle = 'rgba(255, 220, 80, 0.4)';
            g.beginPath();
            g.moveTo(si[0].x, si[0].y);
            for (let i = 1; i < SEGMENTS; i++) g.lineTo(si[i].x, si[i].y);
            g.closePath();
            g.stroke();
            g.setLineDash([]);

            // Cone edge lines from tip to outer circle
            g.strokeStyle = 'rgba(255, 220, 80, 0.6)';
            g.beginPath();
            for (let i = 0; i < 4; i++) {
                const idx = Math.floor(i * SEGMENTS / 4);
                g.moveTo(sTip.x, sTip.y);
                g.lineTo(so[idx].x, so[idx].y);
            }
            g.stroke();
        }
    }

    // ── Collider Visualization ────────────────────────────────────────────

    private drawColliderOverlays(g: CanvasRenderingContext2D): void {
        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0 || this.ctx.state.isPlaying) return;

        for (const entity of selected) {
            const collider = entity.getComponent('ColliderComponent') as ColliderComponent | null;
            if (!collider) continue;

            if (collider.shapeType === ShapeType.MESH) {
                this.drawMeshCollider(g, entity, collider);
            } else if (collider.shapeType === ShapeType.BOX) {
                this.drawBoxCollider(g, entity, collider);
            } else if (collider.shapeType === ShapeType.SPHERE) {
                this.drawSphereCollider(g, entity, collider);
            } else if (collider.shapeType === ShapeType.CAPSULE) {
                this.drawCapsuleCollider(g, entity, collider);
            }
        }
    }

    private drawBoxCollider(g: CanvasRenderingContext2D, entity: any, collider: ColliderComponent): void {
        const worldMatrix = entity.getWorldMatrix();
        const c = collider.center;
        const h = collider.halfExtents;

        const localCorners: Vec3[] = [];
        for (let i = 0; i < 8; i++) {
            localCorners.push(new Vec3(
                c.x + ((i & 1) ? h.x : -h.x),
                c.y + ((i & 2) ? h.y : -h.y),
                c.z + ((i & 4) ? h.z : -h.z),
            ));
        }

        const screenCorners = localCorners.map(lc => this.worldToScreen(worldMatrix.transformPoint(lc)));
        if (screenCorners.some(sc => sc === null)) return;
        const sc = screenCorners as { x: number; y: number }[];

        const edges = [
            [0, 1], [2, 3], [4, 5], [6, 7],
            [0, 2], [1, 3], [4, 6], [5, 7],
            [0, 4], [1, 5], [2, 6], [3, 7],
        ];

        g.strokeStyle = 'rgba(0, 255, 128, 0.7)';
        g.lineWidth = 1.5;
        g.setLineDash([5, 3]);
        for (const [a, b] of edges) {
            g.beginPath();
            g.moveTo(sc[a].x, sc[a].y);
            g.lineTo(sc[b].x, sc[b].y);
            g.stroke();
        }
        g.setLineDash([]);

        // Face center handles for resizing
        const handles: { id: ColliderHandle; local: Vec3 }[] = [
            { id: '+x', local: new Vec3(c.x + h.x, c.y, c.z) },
            { id: '-x', local: new Vec3(c.x - h.x, c.y, c.z) },
            { id: '+y', local: new Vec3(c.x, c.y + h.y, c.z) },
            { id: '-y', local: new Vec3(c.x, c.y - h.y, c.z) },
            { id: '+z', local: new Vec3(c.x, c.y, c.z + h.z) },
            { id: '-z', local: new Vec3(c.x, c.y, c.z - h.z) },
        ];

        const handleSize = 5;
        for (const handle of handles) {
            const wp = worldMatrix.transformPoint(handle.local);
            const sp = this.worldToScreen(wp);
            if (!sp) continue;

            const isHovered = this.hoveredColliderHandle === handle.id;
            const isDragging = this.draggingColliderHandle === handle.id;
            const axis = handle.id![1] as 'x' | 'y' | 'z';
            const color = isDragging || isHovered
                ? this.axisHighlightColors[axis]
                : this.axisColors[axis];

            g.fillStyle = color;
            g.beginPath();
            g.moveTo(sp.x, sp.y - handleSize);
            g.lineTo(sp.x + handleSize, sp.y);
            g.lineTo(sp.x, sp.y + handleSize);
            g.lineTo(sp.x - handleSize, sp.y);
            g.closePath();
            g.fill();

            if (isHovered || isDragging) {
                g.strokeStyle = '#fff';
                g.lineWidth = 1;
                g.stroke();
            }
        }
    }

    private drawSphereCollider(g: CanvasRenderingContext2D, entity: any, collider: ColliderComponent): void {
        const worldMatrix = entity.getWorldMatrix();
        const c = collider.center;
        const r = collider.radius;

        const circleDefs = [
            { d1: new Vec3(1, 0, 0), d2: new Vec3(0, 1, 0) },
            { d1: new Vec3(1, 0, 0), d2: new Vec3(0, 0, 1) },
            { d1: new Vec3(0, 1, 0), d2: new Vec3(0, 0, 1) },
        ];
        const segments = 48;

        g.strokeStyle = 'rgba(0, 255, 128, 0.7)';
        g.lineWidth = 1.5;
        g.setLineDash([5, 3]);

        for (const { d1, d2 } of circleDefs) {
            g.beginPath();
            let started = false;
            for (let i = 0; i <= segments; i++) {
                const t = (i / segments) * Math.PI * 2;
                const lp = new Vec3(
                    c.x + d1.x * Math.cos(t) * r + d2.x * Math.sin(t) * r,
                    c.y + d1.y * Math.cos(t) * r + d2.y * Math.sin(t) * r,
                    c.z + d1.z * Math.cos(t) * r + d2.z * Math.sin(t) * r,
                );
                const wp = worldMatrix.transformPoint(lp);
                const sp = this.worldToScreen(wp);
                if (!sp) { started = false; continue; }
                if (!started) { g.moveTo(sp.x, sp.y); started = true; }
                else g.lineTo(sp.x, sp.y);
            }
            g.stroke();
        }
        g.setLineDash([]);
    }

    private drawCapsuleCollider(g: CanvasRenderingContext2D, entity: any, collider: ColliderComponent): void {
        const worldMatrix = entity.getWorldMatrix();
        const c = collider.center;
        const r = collider.radius;
        const halfH = collider.height / 2;
        const segments = 48;

        g.strokeStyle = 'rgba(0, 255, 128, 0.7)';
        g.lineWidth = 1.5;
        g.setLineDash([5, 3]);

        // Top and bottom circles
        this.drawLocalCircle(g, worldMatrix, c, r, new Vec3(1, 0, 0), new Vec3(0, 0, 1), halfH, segments);
        this.drawLocalCircle(g, worldMatrix, c, r, new Vec3(1, 0, 0), new Vec3(0, 0, 1), -halfH, segments);

        // Hemisphere arcs
        this.drawHalfCircle(g, worldMatrix, c, r, new Vec3(1, 0, 0), new Vec3(0, 1, 0), halfH, segments, true);
        this.drawHalfCircle(g, worldMatrix, c, r, new Vec3(0, 0, 1), new Vec3(0, 1, 0), halfH, segments, true);
        this.drawHalfCircle(g, worldMatrix, c, r, new Vec3(1, 0, 0), new Vec3(0, 1, 0), -halfH, segments, false);
        this.drawHalfCircle(g, worldMatrix, c, r, new Vec3(0, 0, 1), new Vec3(0, 1, 0), -halfH, segments, false);

        // Vertical connecting lines
        const vertOffsets = [
            new Vec3(r, 0, 0), new Vec3(-r, 0, 0),
            new Vec3(0, 0, r), new Vec3(0, 0, -r),
        ];
        for (const off of vertOffsets) {
            const topLocal = new Vec3(c.x + off.x, c.y + halfH + off.y, c.z + off.z);
            const botLocal = new Vec3(c.x + off.x, c.y - halfH + off.y, c.z + off.z);
            const topScreen = this.worldToScreen(worldMatrix.transformPoint(topLocal));
            const botScreen = this.worldToScreen(worldMatrix.transformPoint(botLocal));
            if (!topScreen || !botScreen) continue;
            g.beginPath();
            g.moveTo(topScreen.x, topScreen.y);
            g.lineTo(botScreen.x, botScreen.y);
            g.stroke();
        }

        g.setLineDash([]);

        // Capsule edit handles
        const capsuleHandles: { id: ColliderHandle; local: Vec3; axis: 'x' | 'y' | 'z' }[] = [
            { id: 'cap+y', local: new Vec3(c.x, c.y + halfH + r, c.z), axis: 'y' },
            { id: 'cap-y', local: new Vec3(c.x, c.y - halfH - r, c.z), axis: 'y' },
            { id: 'cap+x', local: new Vec3(c.x + r, c.y, c.z), axis: 'x' },
            { id: 'cap-x', local: new Vec3(c.x - r, c.y, c.z), axis: 'x' },
            { id: 'cap+z', local: new Vec3(c.x, c.y, c.z + r), axis: 'z' },
            { id: 'cap-z', local: new Vec3(c.x, c.y, c.z - r), axis: 'z' },
        ];

        for (const handle of capsuleHandles) {
            const wp = worldMatrix.transformPoint(handle.local);
            const sp = this.worldToScreen(wp);
            if (!sp) continue;

            const isHovered = this.hoveredColliderHandle === handle.id;
            const isDragging = this.draggingColliderHandle === handle.id;
            const color = isDragging || isHovered
                ? this.axisHighlightColors[handle.axis]
                : this.axisColors[handle.axis];

            g.fillStyle = color;
            g.beginPath();
            g.arc(sp.x, sp.y, 5, 0, Math.PI * 2);
            g.fill();

            if (isHovered || isDragging) {
                g.strokeStyle = '#fff';
                g.lineWidth = 1.5;
                g.setLineDash([]);
                g.beginPath();
                g.arc(sp.x, sp.y, 7, 0, Math.PI * 2);
                g.stroke();
            }
        }
    }

    private meshColliderCache = new Map<string, { positions: Float32Array; indices: Uint32Array } | null>();
    private meshColliderPending = new Set<string>();

    private drawMeshCollider(g: CanvasRenderingContext2D, entity: any, collider: ColliderComponent): void {
        const worldMatrix = entity.getWorldMatrix();

        let positions = (collider as any).collisionPositions as Float32Array | null;
        let indices = (collider as any).collisionIndices as Uint32Array | null;

        if (!positions || !indices) {
            const mr = entity.getComponent('MeshRendererComponent') as any;
            const meshAsset = mr?.meshAsset as string | undefined;
            if (!meshAsset) {
                this.drawBoxCollider(g, entity, collider);
                return;
            }

            const binUrl = meshAsset.replace(/\.glb$/i, '.collision.bin');
            const cached = this.meshColliderCache.get(binUrl);
            if (cached) {
                positions = cached.positions;
                indices = cached.indices;
            } else if (cached === null) {
                this.drawBoxCollider(g, entity, collider);
                return;
            } else if (!this.meshColliderPending.has(binUrl)) {
                this.meshColliderPending.add(binUrl);
                fetch(binUrl).then(r => r.ok ? r.arrayBuffer() : null).then(buf => {
                    this.meshColliderPending.delete(binUrl);
                    if (!buf || buf.byteLength < 16) {
                        this.meshColliderCache.set(binUrl, null);
                        return;
                    }
                    const view = new DataView(buf);
                    const magic = view.getUint32(0, true);
                    if (magic !== 0x434F4C4C) { this.meshColliderCache.set(binUrl, null); return; }
                    const posCount = view.getUint32(8, true);
                    const idxCount = view.getUint32(12, true);
                    if (buf.byteLength < 16 + posCount * 4 + idxCount * 4) { this.meshColliderCache.set(binUrl, null); return; }
                    this.meshColliderCache.set(binUrl, {
                        positions: new Float32Array(buf, 16, posCount),
                        indices: new Uint32Array(buf, 16 + posCount * 4, idxCount),
                    });
                }).catch(() => {
                    this.meshColliderPending.delete(binUrl);
                    this.meshColliderCache.set(binUrl, null);
                });
                this.drawBoxCollider(g, entity, collider);
                return;
            } else {
                this.drawBoxCollider(g, entity, collider);
                return;
            }
        }

        // Apply mesh model rotation to the world matrix for visualization
        let drawMatrix = worldMatrix;
        const mrComp = entity.getComponent('MeshRendererComponent') as any;
        if (mrComp && (mrComp.modelRotationX || mrComp.modelRotationY || mrComp.modelRotationZ)) {
            const deg2rad = Math.PI / 180;
            const meshRot = Quat.fromEuler(
                (mrComp.modelRotationX || 0) * deg2rad,
                (mrComp.modelRotationY || 0) * deg2rad,
                (mrComp.modelRotationZ || 0) * deg2rad,
            );
            const meshTransform = Mat4.compose(new Vec3(0, 0, 0), meshRot, new Vec3(1, 1, 1));
            drawMatrix = worldMatrix.multiply(meshTransform);
        }

        g.strokeStyle = 'rgba(0, 255, 128, 0.5)';
        g.lineWidth = 1;
        g.setLineDash([]);

        const triCount = indices.length / 3;
        const maxTris = Math.min(triCount, 5000);
        const step = triCount > maxTris ? Math.ceil(triCount / maxTris) : 1;

        for (let f = 0; f < triCount; f += step) {
            const i0 = indices[f * 3], i1 = indices[f * 3 + 1], i2 = indices[f * 3 + 2];
            const p0 = new Vec3(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
            const p1 = new Vec3(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
            const p2 = new Vec3(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);

            const s0 = this.worldToScreen(drawMatrix.transformPoint(p0));
            const s1 = this.worldToScreen(drawMatrix.transformPoint(p1));
            const s2 = this.worldToScreen(drawMatrix.transformPoint(p2));
            if (!s0 || !s1 || !s2) continue;

            g.beginPath();
            g.moveTo(s0.x, s0.y);
            g.lineTo(s1.x, s1.y);
            g.lineTo(s2.x, s2.y);
            g.closePath();
            g.stroke();
        }
    }

    private drawLocalCircle(
        g: CanvasRenderingContext2D, worldMatrix: any, c: Vec3,
        r: number, d1: Vec3, d2: Vec3, yOff: number, segments: number,
    ): void {
        g.beginPath();
        let started = false;
        for (let i = 0; i <= segments; i++) {
            const t = (i / segments) * Math.PI * 2;
            const lp = new Vec3(
                c.x + d1.x * Math.cos(t) * r + d2.x * Math.sin(t) * r,
                c.y + yOff,
                c.z + d1.z * Math.cos(t) * r + d2.z * Math.sin(t) * r,
            );
            const wp = worldMatrix.transformPoint(lp);
            const sp = this.worldToScreen(wp);
            if (!sp) { started = false; continue; }
            if (!started) { g.moveTo(sp.x, sp.y); started = true; }
            else g.lineTo(sp.x, sp.y);
        }
        g.stroke();
    }

    private drawHalfCircle(
        g: CanvasRenderingContext2D, worldMatrix: any, c: Vec3,
        r: number, d1: Vec3, d2: Vec3, yOff: number, segments: number, upper: boolean,
    ): void {
        g.beginPath();
        let started = false;
        const startAngle = upper ? 0 : Math.PI;
        const endAngle = upper ? Math.PI : Math.PI * 2;
        for (let i = 0; i <= segments / 2; i++) {
            const t = startAngle + (i / (segments / 2)) * (endAngle - startAngle);
            const lp = new Vec3(
                c.x + d1.x * Math.cos(t) * r,
                c.y + yOff + d2.y * Math.sin(t) * r,
                c.z + d1.z * Math.cos(t) * r,
            );
            const wp = worldMatrix.transformPoint(lp);
            const sp = this.worldToScreen(wp);
            if (!sp) { started = false; continue; }
            if (!started) { g.moveTo(sp.x, sp.y); started = true; }
            else g.lineTo(sp.x, sp.y);
        }
        g.stroke();
    }

    // ── Vehicle Wheel Gizmos ──────────────────────────────────────────

    private drawVehicleOverlays(g: CanvasRenderingContext2D): void {
        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0 || this.ctx.state.isPlaying) return;

        for (const entity of selected) {
            const vehicle = entity.getComponent('VehicleComponent') as VehicleComponent | null;
            if (!vehicle || vehicle.wheels.length === 0) continue;

            const worldMatrix = entity.getWorldMatrix();
            const wheelRadius = vehicle.wheelRadius;
            const suspLen = vehicle.suspensionRestLength;
            const segments = 24;

            for (let wi = 0; wi < vehicle.wheels.length; wi++) {
                const wheel = vehicle.wheels[wi];
                const lp = wheel.localPosition;

                const wheelCenter = worldMatrix.transformPoint(new Vec3(lp.x, lp.y, lp.z));
                const wheelBottom = worldMatrix.transformPoint(new Vec3(lp.x, lp.y - suspLen, lp.z));

                const localRight = worldMatrix.transformDirection(new Vec3(1, 0, 0)).normalize();
                const localUp = worldMatrix.transformDirection(new Vec3(0, 1, 0)).normalize();
                const localForward = worldMatrix.transformDirection(new Vec3(0, 0, -1)).normalize();

                // Wheel color by function: steered=cyan, driven=orange, both=yellow
                let wheelR = 0.5, wheelG = 0.5, wheelB = 0.5;
                if (wheel.isSteered && wheel.isDriven) { wheelR = 1; wheelG = 1; wheelB = 0; }
                else if (wheel.isSteered) { wheelR = 0; wheelG = 0.9; wheelB = 1; }
                else if (wheel.isDriven) { wheelR = 1; wheelG = 0.6; wheelB = 0; }

                // Wheel circle
                g.strokeStyle = `rgba(${Math.round(wheelR * 255)}, ${Math.round(wheelG * 255)}, ${Math.round(wheelB * 255)}, 0.8)`;
                g.lineWidth = 2;
                g.setLineDash([]);
                g.beginPath();
                let started = false;
                for (let i = 0; i <= segments; i++) {
                    const t = (i / segments) * Math.PI * 2;
                    const wp = new Vec3(
                        wheelBottom.x + localForward.x * Math.cos(t) * wheelRadius + localUp.x * Math.sin(t) * wheelRadius,
                        wheelBottom.y + localForward.y * Math.cos(t) * wheelRadius + localUp.y * Math.sin(t) * wheelRadius,
                        wheelBottom.z + localForward.z * Math.cos(t) * wheelRadius + localUp.z * Math.sin(t) * wheelRadius,
                    );
                    const sp = this.worldToScreen(wp);
                    if (!sp) { started = false; continue; }
                    if (!started) { g.moveTo(sp.x, sp.y); started = true; }
                    else g.lineTo(sp.x, sp.y);
                }
                g.stroke();

                // Spoke lines
                const spokeCount = 4;
                for (let s = 0; s < spokeCount; s++) {
                    const t = (s / spokeCount) * Math.PI;
                    const p0 = new Vec3(
                        wheelBottom.x + localForward.x * Math.cos(t) * wheelRadius + localUp.x * Math.sin(t) * wheelRadius,
                        wheelBottom.y + localForward.y * Math.cos(t) * wheelRadius + localUp.y * Math.sin(t) * wheelRadius,
                        wheelBottom.z + localForward.z * Math.cos(t) * wheelRadius + localUp.z * Math.sin(t) * wheelRadius,
                    );
                    const p1 = new Vec3(
                        wheelBottom.x - localForward.x * Math.cos(t) * wheelRadius - localUp.x * Math.sin(t) * wheelRadius,
                        wheelBottom.y - localForward.y * Math.cos(t) * wheelRadius - localUp.y * Math.sin(t) * wheelRadius,
                        wheelBottom.z - localForward.z * Math.cos(t) * wheelRadius - localUp.z * Math.sin(t) * wheelRadius,
                    );
                    const sp0 = this.worldToScreen(p0);
                    const sp1 = this.worldToScreen(p1);
                    if (sp0 && sp1) {
                        g.beginPath();
                        g.moveTo(sp0.x, sp0.y);
                        g.lineTo(sp1.x, sp1.y);
                        g.stroke();
                    }
                }

                // Suspension line
                const spTop = this.worldToScreen(wheelCenter);
                const spBot = this.worldToScreen(wheelBottom);
                if (spTop && spBot) {
                    g.strokeStyle = 'rgba(255, 255, 0, 0.6)';
                    g.lineWidth = 1.5;
                    g.setLineDash([4, 3]);
                    g.beginPath();
                    g.moveTo(spTop.x, spTop.y);
                    g.lineTo(spBot.x, spBot.y);
                    g.stroke();
                    g.setLineDash([]);

                    g.fillStyle = 'rgba(255, 255, 0, 0.8)';
                    g.beginPath();
                    g.moveTo(spTop.x, spTop.y - 4);
                    g.lineTo(spTop.x + 4, spTop.y);
                    g.lineTo(spTop.x, spTop.y + 4);
                    g.lineTo(spTop.x - 4, spTop.y);
                    g.closePath();
                    g.fill();
                }

                // Wheel label
                const labelSp = this.worldToScreen(wheelBottom);
                if (labelSp) {
                    let label = '';
                    if (wheel.isSteered && wheel.isDriven) label = 'S+D';
                    else if (wheel.isSteered) label = 'S';
                    else if (wheel.isDriven) label = 'D';

                    if (label) {
                        g.font = '10px monospace';
                        g.fillStyle = `rgba(${Math.round(wheelR * 255)}, ${Math.round(wheelG * 255)}, ${Math.round(wheelB * 255)}, 0.9)`;
                        g.textAlign = 'center';
                        g.fillText(label, labelSp.x, labelSp.y + wheelRadius * 20 + 12);
                        g.textAlign = 'start';
                    }
                }
            }
        }
    }

    // ── Hit Testing ──────────────────────────────────────────────────────

    private hitTestColliderHandle(mx: number, my: number): ColliderHandle {
        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0) return null;

        const entity = selected[0];
        const collider = entity.getComponent('ColliderComponent') as ColliderComponent | null;
        if (!collider) return null;

        const worldMatrix = entity.getWorldMatrix();
        const c = collider.center;
        const threshold = 8;

        let handles: { id: ColliderHandle; local: Vec3 }[] = [];

        if (collider.shapeType === ShapeType.BOX) {
            const h = collider.halfExtents;
            handles = [
                { id: '+x', local: new Vec3(c.x + h.x, c.y, c.z) },
                { id: '-x', local: new Vec3(c.x - h.x, c.y, c.z) },
                { id: '+y', local: new Vec3(c.x, c.y + h.y, c.z) },
                { id: '-y', local: new Vec3(c.x, c.y - h.y, c.z) },
                { id: '+z', local: new Vec3(c.x, c.y, c.z + h.z) },
                { id: '-z', local: new Vec3(c.x, c.y, c.z - h.z) },
            ];
        } else if (collider.shapeType === ShapeType.CAPSULE) {
            const r = collider.radius;
            const halfH = collider.height / 2;
            handles = [
                { id: 'cap+y', local: new Vec3(c.x, c.y + halfH + r, c.z) },
                { id: 'cap-y', local: new Vec3(c.x, c.y - halfH - r, c.z) },
                { id: 'cap+x', local: new Vec3(c.x + r, c.y, c.z) },
                { id: 'cap-x', local: new Vec3(c.x - r, c.y, c.z) },
                { id: 'cap+z', local: new Vec3(c.x, c.y, c.z + r) },
                { id: 'cap-z', local: new Vec3(c.x, c.y, c.z - r) },
            ];
        } else {
            return null;
        }

        let bestHandle: ColliderHandle = null;
        let bestDist = threshold;

        for (const handle of handles) {
            const wp = worldMatrix.transformPoint(handle.local);
            const sp = this.worldToScreen(wp);
            if (!sp) continue;
            const dist = Math.sqrt((mx - sp.x) ** 2 + (my - sp.y) ** 2);
            if (dist < bestDist) {
                bestDist = dist;
                bestHandle = handle.id;
            }
        }

        return bestHandle;
    }

    /** Get the screen-space direction for a collider handle's axis. */
    private getColliderAxisScreenDir(handle: ColliderHandle, entity: any): { dx: number; dy: number } {
        if (!handle) return { dx: 0, dy: 0 };
        const worldMatrix = entity.getWorldMatrix();
        const collider = entity.getComponent('ColliderComponent') as ColliderComponent | null;
        if (!collider) return { dx: 0, dy: 0 };

        const c = collider.center;
        const centerWorld = worldMatrix.transformPoint(new Vec3(c.x, c.y, c.z));
        const centerScreen = this.worldToScreen(centerWorld);
        if (!centerScreen) return { dx: 0, dy: 0 };

        const isCapsule = handle.startsWith('cap');
        const signChar = isCapsule ? handle[3] : handle[0];
        const axisChar = isCapsule ? handle[4] : handle[1];
        const axis = axisChar as 'x' | 'y' | 'z';
        const sign = signChar === '+' ? 1 : -1;

        let localDir: Vec3;
        if (axis === 'x') localDir = new Vec3(sign, 0, 0);
        else if (axis === 'y') localDir = new Vec3(0, sign, 0);
        else localDir = new Vec3(0, 0, sign);

        const tipLocal = new Vec3(c.x + localDir.x, c.y + localDir.y, c.z + localDir.z);
        const tipWorld = worldMatrix.transformPoint(tipLocal);
        const tipScreen = this.worldToScreen(tipWorld);
        if (!tipScreen) return { dx: 0, dy: 0 };

        let dx = tipScreen.x - centerScreen.x;
        let dy = tipScreen.y - centerScreen.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.001) return { dx: 0, dy: 0 };
        return { dx: dx / len, dy: dy / len };
    }

    private worldToScreen(worldPos: Vec3): { x: number; y: number } | null {
        if (!this.overlayCanvas) return null;

        const vp = this.camera.getViewProjectionMatrix();
        const clip = vp.transformPoint(worldPos);

        const w = vp.data[3] * worldPos.x + vp.data[7] * worldPos.y + vp.data[11] * worldPos.z + vp.data[15];
        if (w <= 0) return null;

        return {
            x: (clip.x + 1) * 0.5 * this.overlayCanvas.width,
            y: (1 - clip.y) * 0.5 * this.overlayCanvas.height,
        };
    }

    // ── Interaction ─────────────────────────────────────────────────────

    private hitTestAxis(mx: number, my: number): Axis {
        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0) return null;

        const mode = this.ctx.state.gizmoMode;
        if (mode === 'rotate') {
            return this.hitTestRing(mx, my);
        }

        const worldPos = selected[0].getWorldPosition();
        const screenPos = this.worldToScreen(worldPos);
        if (!screenPos) return null;

        const length = 80;
        const threshold = isMobile() ? 24 : 10;

        if (mode === 'scale') {
            const centerSize = 7;
            if (Math.abs(mx - screenPos.x) <= centerSize && Math.abs(my - screenPos.y) <= centerSize) {
                return 'all';
            }
        }

        for (const axis of ['x', 'y', 'z'] as const) {
            const dir = this.getAxisScreenDir(axis, screenPos);
            const endX = screenPos.x + dir.dx * length;
            const endY = screenPos.y + dir.dy * length;

            const dx = endX - screenPos.x;
            const dy = endY - screenPos.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < 1) continue;

            const t = Math.max(0, Math.min(1,
                ((mx - screenPos.x) * dx + (my - screenPos.y) * dy) / (len * len)
            ));

            const closestX = screenPos.x + t * dx;
            const closestY = screenPos.y + t * dy;
            const dist = Math.sqrt(
                (mx - closestX) * (mx - closestX) + (my - closestY) * (my - closestY)
            );

            if (dist < threshold) return axis;
        }

        return null;
    }

    private hitTestRing(mx: number, my: number): Axis {
        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0) return null;

        const worldPos = selected[0].getWorldPosition();
        const camPos = this.camera.getPosition();
        const camDist = worldPos.sub(camPos).length();
        const worldRadius = camDist * 0.15;

        const threshold = isMobile() ? 24 : 10;
        let bestAxis: Axis = null;
        let bestDist = threshold;

        for (const axis of ['x', 'y', 'z'] as const) {
            let d1: Vec3, d2: Vec3;
            if (axis === 'x') { d1 = this.getLocalAxisWorld('y'); d2 = this.getLocalAxisWorld('z'); }
            else if (axis === 'y') { d1 = this.getLocalAxisWorld('x'); d2 = this.getLocalAxisWorld('z'); }
            else { d1 = this.getLocalAxisWorld('x'); d2 = this.getLocalAxisWorld('y'); }

            const segments = 48;
            for (let i = 0; i <= segments; i++) {
                const t = (i / segments) * Math.PI * 2;
                const wp = worldPos.add(d1.scale(Math.cos(t) * worldRadius)).add(d2.scale(Math.sin(t) * worldRadius));
                const sp = this.worldToScreen(wp);
                if (!sp) continue;
                const dist = Math.sqrt((mx - sp.x) * (mx - sp.x) + (my - sp.y) * (my - sp.y));
                if (dist < bestDist) {
                    bestDist = dist;
                    bestAxis = axis;
                }
            }
        }

        return bestAxis;
    }

    private onMouseMove = (e: MouseEvent): void => {
        if (this.ctx.state.terrainSculptActive) {
            if (this.sculpting || !this.interacting) {
                this.handleSculptMouseMove(e);
            }
            if (this.sculpting) return;
        }

        if (this.interacting) return;
        if (!this.overlayCanvas) return;

        const rect = this.overlayCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        this.hoveredAxis = this.hitTestAxis(mx, my);
        this.hoveredColliderHandle = this.hoveredAxis ? null : this.hitTestColliderHandle(mx, my);
        this.overlayCanvas.style.cursor = (this.hoveredAxis || this.hoveredColliderHandle) ? 'pointer' : '';
    };

    private onMouseDown = (e: MouseEvent): void => {
        if (e.button !== 0) return;
        if (!this.overlayCanvas) return;

        if (this.ctx.state.terrainSculptActive && this.handleSculptMouseDown(e)) {
            return;
        }

        const rect = this.overlayCanvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Check transform gizmo
        const axis = this.hitTestAxis(mx, my);
        if (axis) {
            e.preventDefault();
            e.stopPropagation();

            this.draggingAxis = axis;
            this.interacting = true;
            this.ctx.state.gizmoInteracting = true;
            this.dragStartScreenPos = { x: e.clientX, y: e.clientY };

            const selected = this.ctx.getSelectedEntities();
            this.multiDragStarts.clear();
            if (selected.length > 0) {
                const transform = selected[0].getComponent('TransformComponent');
                if (transform) {
                    const mode = this.ctx.state.gizmoMode;
                    if (mode === 'translate') {
                        const pos = (transform as any).position;
                        this.dragStartValue = new Vec3(pos.x, pos.y, pos.z);
                    } else if (mode === 'scale') {
                        const scl = (transform as any).scale;
                        this.dragStartValue = new Vec3(scl.x, scl.y, scl.z);
                    } else if (mode === 'rotate') {
                        const rot = (transform as any).rotation;
                        this.dragStartQuat = { x: rot.x, y: rot.y, z: rot.z, w: rot.w };
                        this.dragStartValue = new Vec3(0, 0, 0);
                        const worldPos = selected[0].getWorldPosition();
                        const screenPos = this.worldToScreen(worldPos);
                        if (screenPos) {
                            this.dragStartAngle = Math.atan2(my - screenPos.y, mx - screenPos.x);
                        }
                    }
                }
                for (const ent of selected) {
                    const tc = ent.getComponent('TransformComponent');
                    if (!tc) continue;
                    const p = (tc as any).position;
                    const s = (tc as any).scale;
                    const r = (tc as any).rotation;
                    this.multiDragStarts.set(ent.id, {
                        pos: new Vec3(p.x, p.y, p.z),
                        scale: new Vec3(s.x, s.y, s.z),
                        quat: { x: r.x, y: r.y, z: r.z, w: r.w },
                    });
                }
            }
            return;
        }

        // Check collider handles
        const handle = this.hitTestColliderHandle(mx, my);
        if (handle) {
            e.preventDefault();
            e.stopPropagation();

            this.draggingColliderHandle = handle;
            this.interacting = true;
            this.colliderDragStartScreenPos = { x: e.clientX, y: e.clientY };

            const selected = this.ctx.getSelectedEntities();
            if (selected.length > 0) {
                const collider = selected[0].getComponent('ColliderComponent') as ColliderComponent | null;
                if (collider) {
                    this.colliderDragStartHalfExtents = new Vec3(collider.halfExtents.x, collider.halfExtents.y, collider.halfExtents.z);
                    this.colliderDragStartCenter = new Vec3(collider.center.x, collider.center.y, collider.center.z);
                    this.capsuleDragStartRadius = collider.radius;
                    this.capsuleDragStartHeight = collider.height;
                }
            }
        }
    };

    private onDragMove = (e: MouseEvent): void => {
        if (!this.interacting) return;

        if (this.sculpting) {
            this.handleSculptMouseMove(e);
            return;
        }

        if (this.draggingColliderHandle) {
            this.onColliderDragMove(e);
            return;
        }

        if (!this.draggingAxis) return;

        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0) return;

        const entity = selected[0];
        const transform = entity.getComponent('TransformComponent');
        if (!transform) return;

        const worldPos = entity.getWorldPosition();
        const screenPos = this.worldToScreen(worldPos);
        if (!screenPos) return;

        const mode = this.ctx.state.gizmoMode;

        if (mode === 'translate') {
            const dx = e.clientX - this.dragStartScreenPos.x;
            const dy = e.clientY - this.dragStartScreenPos.y;
            const axisScreenDir = this.getAxisScreenDir(this.draggingAxis, screenPos);
            const camPos = this.camera.getPosition();
            const dist = camPos.sub(worldPos).length();
            const canvasH = this.overlayCanvas?.height ?? 800;
            const pixelToWorld = 2 * dist * Math.tan(this.camera.fov / 2) / canvasH;
            const axisMagnitude = (dx * axisScreenDir.dx + dy * axisScreenDir.dy) * pixelToWorld;
            const axisWorld = this.getEffectiveAxisWorld(this.draggingAxis! as 'x' | 'y' | 'z');
            const delta = new Vec3(
                axisWorld.x * axisMagnitude,
                axisWorld.y * axisMagnitude,
                axisWorld.z * axisMagnitude,
            );
            for (const ent of selected) {
                const tc = ent.getComponent('TransformComponent');
                const start = this.multiDragStarts.get(ent.id);
                if (!tc || !start) continue;
                (tc as any).setPosition(new Vec3(
                    start.pos.x + delta.x,
                    start.pos.y + delta.y,
                    start.pos.z + delta.z,
                ));
            }
        } else if (mode === 'scale') {
            const dx = e.clientX - this.dragStartScreenPos.x;
            const dy = e.clientY - this.dragStartScreenPos.y;
            let scaleDelta = new Vec3(0, 0, 0);
            if (this.draggingAxis === 'all') {
                const uniformMagnitude = (dx - dy) * 0.01;
                scaleDelta = new Vec3(uniformMagnitude, uniformMagnitude, uniformMagnitude);
            } else {
                const axisDir = this.getAxisScreenDir(this.draggingAxis, screenPos);
                const axisMagnitude = (dx * axisDir.dx + dy * axisDir.dy) * 0.01;
                if (this.draggingAxis === 'x') scaleDelta.x = axisMagnitude;
                if (this.draggingAxis === 'y') scaleDelta.y = axisMagnitude;
                if (this.draggingAxis === 'z') scaleDelta.z = axisMagnitude;
            }
            for (const ent of selected) {
                const tc = ent.getComponent('TransformComponent');
                const start = this.multiDragStarts.get(ent.id);
                if (!tc || !start) continue;
                (tc as any).setScale(new Vec3(
                    start.scale.x + scaleDelta.x,
                    start.scale.y + scaleDelta.y,
                    start.scale.z + scaleDelta.z,
                ));
            }
        } else if (mode === 'rotate') {
            const rect = this.overlayCanvas!.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const currentAngle = Math.atan2(my - screenPos.y, mx - screenPos.x);
            let deltaAngle = currentAngle - this.dragStartAngle;
            if (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2;
            if (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2;

            const camPos = this.camera.getPosition();
            const viewDir = worldPos.sub(camPos);
            const axisWorld = this.getLocalAxisWorld(this.draggingAxis! as 'x' | 'y' | 'z');
            const sign = viewDir.dot(axisWorld) > 0 ? -1 : 1;

            const angleDeg = -deltaAngle * (180 / Math.PI) * sign;
            const angleRad = angleDeg * (Math.PI / 180);
            const halfAngle = angleRad / 2;
            const s = Math.sin(halfAngle);
            const c = Math.cos(halfAngle);

            let bx = 0, by = 0, bz = 0, bw = c;
            if (this.draggingAxis === 'x') bx = s;
            else if (this.draggingAxis === 'y') by = s;
            else bz = s;

            for (const ent of selected) {
                const tc = ent.getComponent('TransformComponent');
                const start = this.multiDragStarts.get(ent.id);
                if (!tc || !start) continue;
                const q = start.quat;
                const rot = (tc as any).rotation;
                if (rot && typeof rot.set === 'function') {
                    rot.set(
                        q.w * bx + q.x * bw + q.y * bz - q.z * by,
                        q.w * by - q.x * bz + q.y * bw + q.z * bx,
                        q.w * bz + q.x * by - q.y * bx + q.z * bw,
                        q.w * bw - q.x * bx - q.y * by - q.z * bz,
                    );
                    (tc as any).setRotation(rot);
                }
            }
        }

        for (const ent of selected) {
            this.ctx.emit('propertyChanged', { entityId: ent.id, componentType: 'TransformComponent', field: mode === 'translate' ? 'position' : mode === 'scale' ? 'scale' : 'rotation' });
        }
    };

    private onMouseUp = (): void => {
        if (!this.interacting) return;

        if (this.sculpting) {
            this.handleSculptMouseUp();
            return;
        }

        if (this.draggingColliderHandle) {
            this.onColliderDragEnd();
            this.draggingColliderHandle = null;
            this.interacting = false;
            return;
        }

        const selected = this.ctx.getSelectedEntities();
        if (selected.length > 0) {
            const mode = this.ctx.state.gizmoMode;
            const fieldName = mode === 'translate' ? 'position' : mode === 'scale' ? 'scale' : 'rotation';

            const commands: ChangePropertyCommand[] = [];
            for (const ent of selected) {
                const tc = ent.getComponent('TransformComponent');
                const start = this.multiDragStarts.get(ent.id);
                if (!tc || !start) continue;

                let oldValue: any;
                let newValue: any;

                if (mode === 'translate') {
                    const pos = (tc as any).position;
                    oldValue = { x: start.pos.x, y: start.pos.y, z: start.pos.z };
                    newValue = { x: pos.x, y: pos.y, z: pos.z };
                } else if (mode === 'scale') {
                    const scl = (tc as any).scale;
                    oldValue = { x: start.scale.x, y: start.scale.y, z: start.scale.z };
                    newValue = { x: scl.x, y: scl.y, z: scl.z };
                } else {
                    const rot = (tc as any).rotation;
                    oldValue = { x: start.quat.x, y: start.quat.y, z: start.quat.z, w: start.quat.w };
                    newValue = { x: rot.x, y: rot.y, z: rot.z, w: rot.w };
                }

                const changed = fieldName === 'rotation'
                    ? (oldValue.x !== newValue.x || oldValue.y !== newValue.y || oldValue.z !== newValue.z || oldValue.w !== newValue.w)
                    : (oldValue.x !== newValue.x || oldValue.y !== newValue.y || oldValue.z !== newValue.z);

                if (changed) {
                    commands.push(new ChangePropertyCommand(ent.id, 'TransformComponent', fieldName, oldValue, newValue));

                    // Auto-adjust terrain resolution when scale changes
                    if (fieldName === 'scale') {
                        const terrain = ent.getComponent('TerrainComponent') as any;
                        if (terrain) {
                            const oldMaxXZ = Math.max(Math.abs(oldValue.x), Math.abs(oldValue.z));
                            const newMaxXZ = Math.max(Math.abs(newValue.x), Math.abs(newValue.z));
                            if (oldMaxXZ > 0.01) {
                                const ratio = newMaxXZ / oldMaxXZ;
                                if (Math.abs(ratio - 1) > 0.01) {
                                    const newRes = Math.round(terrain.resolution * ratio);
                                    terrain.resolution = Math.max(2, Math.min(256, newRes));
                                    terrain.meshDirty = true;
                                    terrain.generateMesh();
                                    terrain.markDirty();
                                    this.ctx.ensurePrimitiveMeshes();
                                }
                            }
                        }
                    }
                }
            }

            if (commands.length > 0) {
                if (commands.length === 1) {
                    this.ctx.undoManager.push(commands[0]);
                } else {
                    const batch = new BatchCommand('Transform Entities', commands);
                    this.ctx.undoManager.push(batch);
                }
                this.ctx.markDirty();
                this.ctx.emit('historyChanged');
            }

            for (const ent of selected) {
                this.ctx.emit('propertyChanged', { entityId: ent.id, componentType: 'TransformComponent', field: fieldName });
            }
        }

        this.draggingAxis = null;
        this.interacting = false;
        this.ctx.state.gizmoInteracting = false;
    };

    // ── Touch Gizmo Interaction ─────────────────────────────────────────

    private gizmoTouchId: number = -1;

    private onGizmoTouchStart = (e: TouchEvent): void => {
        if (e.touches.length !== 1) return;
        if (this.ctx.state.isPlaying) return;
        if (!this.overlayCanvas) return;

        const touch = e.touches[0];
        const rect = this.overlayCanvas.getBoundingClientRect();
        const mx = touch.clientX - rect.left;
        const my = touch.clientY - rect.top;

        const axis = this.hitTestAxis(mx, my);
        if (!axis) return;

        e.preventDefault();
        e.stopPropagation();

        this.gizmoTouchId = touch.identifier;
        this.draggingAxis = axis;
        this.interacting = true;
        this.ctx.state.gizmoInteracting = true;
        this.dragStartScreenPos = { x: touch.clientX, y: touch.clientY };

        const selected = this.ctx.getSelectedEntities();
        this.multiDragStarts.clear();
        if (selected.length > 0) {
            const transform = selected[0].getComponent('TransformComponent');
            if (transform) {
                const mode = this.ctx.state.gizmoMode;
                if (mode === 'translate') {
                    const pos = (transform as any).position;
                    this.dragStartValue = new Vec3(pos.x, pos.y, pos.z);
                } else if (mode === 'scale') {
                    const scl = (transform as any).scale;
                    this.dragStartValue = new Vec3(scl.x, scl.y, scl.z);
                } else if (mode === 'rotate') {
                    const rot = (transform as any).rotation;
                    this.dragStartQuat = { x: rot.x, y: rot.y, z: rot.z, w: rot.w };
                    this.dragStartValue = new Vec3(0, 0, 0);
                    const worldPos = selected[0].getWorldPosition();
                    const screenPos = this.worldToScreen(worldPos);
                    if (screenPos) {
                        this.dragStartAngle = Math.atan2(my - screenPos.y, mx - screenPos.x);
                    }
                }
            }
            for (const ent of selected) {
                const tc = ent.getComponent('TransformComponent');
                if (!tc) continue;
                const p = (tc as any).position;
                const s = (tc as any).scale;
                const r = (tc as any).rotation;
                this.multiDragStarts.set(ent.id, {
                    pos: new Vec3(p.x, p.y, p.z),
                    scale: new Vec3(s.x, s.y, s.z),
                    quat: { x: r.x, y: r.y, z: r.z, w: r.w },
                });
            }
        }
    };

    private onGizmoTouchMove = (e: TouchEvent): void => {
        if (!this.interacting || this.gizmoTouchId < 0) return;

        let touch: Touch | null = null;
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === this.gizmoTouchId) {
                touch = e.changedTouches[i];
                break;
            }
        }
        if (!touch) return;

        e.preventDefault();
        e.stopPropagation();

        // Reuse the mouse drag logic by faking a MouseEvent-like object
        this.onDragMove({ clientX: touch.clientX, clientY: touch.clientY } as MouseEvent);
    };

    private onGizmoTouchEnd = (e: TouchEvent): void => {
        if (this.gizmoTouchId < 0) return;
        for (let i = 0; i < e.changedTouches.length; i++) {
            if (e.changedTouches[i].identifier === this.gizmoTouchId) {
                this.gizmoTouchId = -1;
                this.onMouseUp();
                return;
            }
        }
    };

    // ── Collider Handle Drag ────────────────────────────────────────────

    private onColliderDragMove(e: MouseEvent): void {
        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0 || !this.draggingColliderHandle) return;

        const entity = selected[0];
        const collider = entity.getComponent('ColliderComponent') as ColliderComponent | null;
        if (!collider) return;

        const dx = e.clientX - this.colliderDragStartScreenPos.x;
        const dy = e.clientY - this.colliderDragStartScreenPos.y;
        const axisScreenDir = this.getColliderAxisScreenDir(this.draggingColliderHandle, entity);
        const axisMagnitude = (dx * axisScreenDir.dx + dy * axisScreenDir.dy) * 0.02;

        const isCapsule = this.draggingColliderHandle.startsWith('cap');

        if (isCapsule) {
            const signChar = this.draggingColliderHandle[3];
            const axisChar = this.draggingColliderHandle[4] as 'x' | 'y' | 'z';
            const sign = signChar === '+' ? 1 : -1;

            if (axisChar === 'y') {
                const newHeight = Math.max(0.02, this.capsuleDragStartHeight + axisMagnitude);
                const heightDelta = newHeight - this.capsuleDragStartHeight;
                collider.height = newHeight;
                collider.center.set(
                    this.colliderDragStartCenter.x,
                    this.colliderDragStartCenter.y + heightDelta / 2 * sign,
                    this.colliderDragStartCenter.z,
                );
            } else {
                collider.radius = Math.max(0.01, this.capsuleDragStartRadius + axisMagnitude);
            }
            collider.markDirty();

            this.ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'ColliderComponent', field: 'radius' });
            this.ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'ColliderComponent', field: 'height' });
            this.ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'ColliderComponent', field: 'center' });
        } else {
            const axis = this.draggingColliderHandle[1] as 'x' | 'y' | 'z';
            const sign = this.draggingColliderHandle[0] === '+' ? 1 : -1;

            const newHalf = new Vec3(
                this.colliderDragStartHalfExtents.x,
                this.colliderDragStartHalfExtents.y,
                this.colliderDragStartHalfExtents.z,
            );
            const newCenter = new Vec3(
                this.colliderDragStartCenter.x,
                this.colliderDragStartCenter.y,
                this.colliderDragStartCenter.z,
            );

            if (axis === 'x') {
                newHalf.x = Math.max(0.01, this.colliderDragStartHalfExtents.x + axisMagnitude / 2);
                newCenter.x = this.colliderDragStartCenter.x + axisMagnitude / 2 * sign;
            } else if (axis === 'y') {
                newHalf.y = Math.max(0.01, this.colliderDragStartHalfExtents.y + axisMagnitude / 2);
                newCenter.y = this.colliderDragStartCenter.y + axisMagnitude / 2 * sign;
            } else {
                newHalf.z = Math.max(0.01, this.colliderDragStartHalfExtents.z + axisMagnitude / 2);
                newCenter.z = this.colliderDragStartCenter.z + axisMagnitude / 2 * sign;
            }

            collider.halfExtents.set(newHalf.x, newHalf.y, newHalf.z);
            collider.center.set(newCenter.x, newCenter.y, newCenter.z);
            collider.markDirty();

            this.ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'ColliderComponent', field: 'size' });
            this.ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'ColliderComponent', field: 'center' });
        }
    }

    private onColliderDragEnd(): void {
        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0) return;

        const entity = selected[0];
        const collider = entity.getComponent('ColliderComponent') as ColliderComponent | null;
        if (!collider) return;

        let changed = false;

        if (this.draggingColliderHandle?.startsWith('cap')) {
            const radiusChanged = this.capsuleDragStartRadius !== collider.radius;
            const heightChanged = this.capsuleDragStartHeight !== collider.height;
            const centerChanged = this.colliderDragStartCenter.x !== collider.center.x
                || this.colliderDragStartCenter.y !== collider.center.y
                || this.colliderDragStartCenter.z !== collider.center.z;

            if (radiusChanged) {
                this.ctx.undoManager.push(new ChangePropertyCommand(
                    entity.id, 'ColliderComponent', 'radius', this.capsuleDragStartRadius, collider.radius));
                changed = true;
            }
            if (heightChanged) {
                this.ctx.undoManager.push(new ChangePropertyCommand(
                    entity.id, 'ColliderComponent', 'height', this.capsuleDragStartHeight, collider.height));
                changed = true;
            }
            if (centerChanged) {
                this.ctx.undoManager.push(new ChangePropertyCommand(
                    entity.id, 'ColliderComponent', 'center',
                    { x: this.colliderDragStartCenter.x, y: this.colliderDragStartCenter.y, z: this.colliderDragStartCenter.z },
                    { x: collider.center.x, y: collider.center.y, z: collider.center.z }));
                changed = true;
            }

            this.ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'ColliderComponent', field: 'radius' });
            this.ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'ColliderComponent', field: 'height' });
            this.ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'ColliderComponent', field: 'center' });
        } else {
            const oldHalf = {
                x: this.colliderDragStartHalfExtents.x,
                y: this.colliderDragStartHalfExtents.y,
                z: this.colliderDragStartHalfExtents.z,
            };
            const newHalf = {
                x: collider.halfExtents.x,
                y: collider.halfExtents.y,
                z: collider.halfExtents.z,
            };
            const oldCenter = {
                x: this.colliderDragStartCenter.x,
                y: this.colliderDragStartCenter.y,
                z: this.colliderDragStartCenter.z,
            };
            const newCenter = {
                x: collider.center.x,
                y: collider.center.y,
                z: collider.center.z,
            };

            const sizeChanged = oldHalf.x !== newHalf.x || oldHalf.y !== newHalf.y || oldHalf.z !== newHalf.z;
            const centerChanged = oldCenter.x !== newCenter.x || oldCenter.y !== newCenter.y || oldCenter.z !== newCenter.z;

            if (sizeChanged) {
                this.ctx.undoManager.push(new ChangePropertyCommand(entity.id, 'ColliderComponent', 'halfExtents', oldHalf, newHalf));
                changed = true;
            }
            if (centerChanged) {
                this.ctx.undoManager.push(new ChangePropertyCommand(entity.id, 'ColliderComponent', 'center', oldCenter, newCenter));
                changed = true;
            }

            this.ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'ColliderComponent', field: 'size' });
            this.ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'ColliderComponent', field: 'center' });
        }

        if (changed) {
            this.ctx.markDirty();
            this.ctx.emit('historyChanged');
        }
    }

    // ── Terrain Sculpt ────────────────────────────────────────────────

    private getSelectedTerrain(): { entity: any; terrain: TerrainComponent } | null {
        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0) return null;
        const entity = selected[0];
        const terrain = entity.getComponent('TerrainComponent') as TerrainComponent | null;
        if (!terrain) return null;
        return { entity, terrain };
    }

    /** Raycast from screen coordinates to a terrain mesh using iterative height sampling. */
    private raycastTerrain(clientX: number, clientY: number): Vec3 | null {
        if (!this.overlayCanvas) return null;
        const t = this.getSelectedTerrain();
        if (!t) return null;

        const rect = this.overlayCanvas.getBoundingClientRect();
        const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);

        const invViewProj = this.camera.getViewProjectionMatrix().inverse();
        if (!invViewProj) return null;

        const nearPoint = invViewProj.transformPoint(new Vec3(ndcX, ndcY, 0));
        const farPoint = invViewProj.transformPoint(new Vec3(ndcX, ndcY, 1));
        const rayDir = farPoint.sub(nearPoint);

        const worldPos = t.entity.getWorldPosition();
        const worldScale = t.entity.getWorldScale();
        const sx = worldScale.x || 1;
        const sy = worldScale.y || 1;
        const sz = worldScale.z || 1;
        const halfW = t.terrain.width / 2;
        const halfD = t.terrain.depth / 2;

        const steps = 200;
        const maxDist = 2000;
        let prevAbove = true;
        for (let i = 0; i <= steps; i++) {
            const frac = i / steps;
            const dist = frac * maxDist;
            const px = nearPoint.x + rayDir.x * (dist / maxDist);
            const py = nearPoint.y + rayDir.y * (dist / maxDist);
            const pz = nearPoint.z + rayDir.z * (dist / maxDist);

            const localX = (px - worldPos.x) / sx;
            const localZ = (pz - worldPos.z) / sz;

            if (localX < -halfW || localX > halfW || localZ < -halfD || localZ > halfD) {
                prevAbove = py > worldPos.y;
                continue;
            }

            const terrainH = t.terrain.getHeightAt(localX, localZ) * sy + worldPos.y;
            const isAbove = py >= terrainH;

            if (!isAbove && prevAbove) {
                // Refine with binary search
                const tPrev = (i - 1) / steps;
                const tCur = i / steps;
                let lo = tPrev, hi = tCur;
                for (let r = 0; r < 10; r++) {
                    const mid = (lo + hi) / 2;
                    const md = mid * maxDist;
                    const mx = nearPoint.x + rayDir.x * (md / maxDist);
                    const my = nearPoint.y + rayDir.y * (md / maxDist);
                    const mz = nearPoint.z + rayDir.z * (md / maxDist);
                    const mh = t.terrain.getHeightAt((mx - worldPos.x) / sx, (mz - worldPos.z) / sz) * sy + worldPos.y;
                    if (my >= mh) lo = mid; else hi = mid;
                }
                const finalD = ((lo + hi) / 2) * maxDist;
                return new Vec3(
                    nearPoint.x + rayDir.x * (finalD / maxDist),
                    nearPoint.y + rayDir.y * (finalD / maxDist),
                    nearPoint.z + rayDir.z * (finalD / maxDist),
                );
            }
            prevAbove = isAbove;
        }

        // Fallback: intersect with y = worldPos.y plane
        if (Math.abs(rayDir.y) > 1e-6) {
            const tPlane = (worldPos.y - nearPoint.y) / rayDir.y;
            if (tPlane > 0) {
                const px = nearPoint.x + rayDir.x * tPlane;
                const pz = nearPoint.z + rayDir.z * tPlane;
                const localX = (px - worldPos.x) / sx;
                const localZ = (pz - worldPos.z) / sz;
                if (localX >= -halfW && localX <= halfW && localZ >= -halfD && localZ <= halfD) {
                    return new Vec3(px, worldPos.y, pz);
                }
            }
        }

        return null;
    }

    private drawTerrainBrushPreview(g: CanvasRenderingContext2D): void {
        const pos = this.sculptBrushWorldPos;
        if (!pos) return;

        const radius = this.ctx.state.terrainSculptBrush.radius;
        const segments = 32;
        const t = this.getSelectedTerrain();

        const brushColor = {
            raise: '#2ecc71',
            lower: '#e74c3c',
            smooth: '#3498db',
            flatten: '#f39c12',
        }[this.ctx.state.terrainSculptBrush.mode];

        g.strokeStyle = brushColor;
        g.lineWidth = 2;
        g.beginPath();

        let started = false;
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const wx = pos.x + Math.cos(angle) * radius;
            const wz = pos.z + Math.sin(angle) * radius;
            let wy = pos.y;
            if (t) {
                const worldPos = t.entity.getWorldPosition();
                wy = t.terrain.getHeightAt(wx - worldPos.x, wz - worldPos.z) + worldPos.y;
            }
            const sp = this.worldToScreen(new Vec3(wx, wy, wz));
            if (!sp) continue;
            if (!started) {
                g.moveTo(sp.x, sp.y);
                started = true;
            } else {
                g.lineTo(sp.x, sp.y);
            }
        }
        g.closePath();
        g.stroke();

        const centerSp = this.worldToScreen(pos);
        if (centerSp) {
            g.fillStyle = brushColor;
            g.beginPath();
            g.arc(centerSp.x, centerSp.y, 3, 0, Math.PI * 2);
            g.fill();
        }
    }

    private applySculptBrush(): void {
        const t = this.getSelectedTerrain();
        if (!t || !this.sculptBrushWorldPos) return;

        const brush = this.ctx.state.terrainSculptBrush;
        const worldPos = t.entity.getWorldPosition();
        const worldScale = t.entity.getWorldScale();
        const localX = (this.sculptBrushWorldPos.x - worldPos.x) / (worldScale.x || 1);
        const localZ = (this.sculptBrushWorldPos.z - worldPos.z) / (worldScale.z || 1);

        t.terrain.applyBrush(localX, localZ, brush.radius / (worldScale.x || 1), brush.strength, brush.mode);
        t.terrain.generateMesh();
        t.terrain.markDirty();
        this.ctx.ensurePrimitiveMeshes();
    }

    handleSculptMouseMove(e: MouseEvent): boolean {
        if (!this.ctx.state.terrainSculptActive) return false;

        const hit = this.raycastTerrain(e.clientX, e.clientY);
        this.sculptBrushWorldPos = hit;

        if (this.overlayCanvas) {
            this.overlayCanvas.style.cursor = hit ? 'crosshair' : '';
        }

        if (this.sculpting && hit) {
            this.applySculptBrush();
        }

        return !!hit;
    }

    handleSculptMouseDown(e: MouseEvent): boolean {
        if (!this.ctx.state.terrainSculptActive) return false;
        if (e.button !== 0) return false;
        if (e.ctrlKey || e.metaKey || e.shiftKey) return false;

        const hit = this.raycastTerrain(e.clientX, e.clientY);
        if (!hit) return false;

        this.sculptBrushWorldPos = hit;
        this.sculpting = true;
        this.interacting = true;

        const t = this.getSelectedTerrain();
        if (t) {
            this.sculptHeightSnapshot = new Float32Array(t.terrain.heightData);
            this.sculptTerrainEntityId = t.entity.id;
        }

        this.applySculptBrush();

        e.preventDefault();
        e.stopPropagation();
        return true;
    }

    handleSculptMouseUp(): boolean {
        if (!this.sculpting) return false;
        this.sculpting = false;
        this.interacting = false;

        const t = this.getSelectedTerrain();
        if (t && this.sculptHeightSnapshot && this.sculptTerrainEntityId === t.entity.id) {
            const oldData = this.sculptHeightSnapshot;
            const newData = new Float32Array(t.terrain.heightData);

            let changed = false;
            for (let i = 0; i < oldData.length; i++) {
                if (oldData[i] !== newData[i]) { changed = true; break; }
            }

            if (changed) {
                const entityId = t.entity.id;
                const cmd = {
                    label: 'Sculpt Terrain',
                    execute() {
                        const ctx = EditorContext.instance;
                        const scene = ctx.getActiveScene();
                        if (!scene) return;
                        const ent = scene.getEntity(entityId);
                        if (!ent) return;
                        const tc = ent.getComponent('TerrainComponent') as TerrainComponent | null;
                        if (!tc) return;
                        tc.heightData = new Float32Array(newData);
                        tc.meshDirty = true;
                        tc.generateMesh();
                        tc.markDirty();
                        ctx.ensurePrimitiveMeshes();
                    },
                    undo() {
                        const ctx = EditorContext.instance;
                        const scene = ctx.getActiveScene();
                        if (!scene) return;
                        const ent = scene.getEntity(entityId);
                        if (!ent) return;
                        const tc = ent.getComponent('TerrainComponent') as TerrainComponent | null;
                        if (!tc) return;
                        tc.heightData = new Float32Array(oldData);
                        tc.meshDirty = true;
                        tc.generateMesh();
                        tc.markDirty();
                        ctx.ensurePrimitiveMeshes();
                    },
                };
                this.ctx.undoManager.push(cmd);
                this.ctx.markDirty();
                this.ctx.emit('historyChanged');
            }
        }

        this.sculptHeightSnapshot = null;
        return true;
    }
}
