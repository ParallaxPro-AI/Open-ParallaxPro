import { EditorContext } from '../editor_context.js';
import { EditorCamera } from './editor_camera.js';
import { GizmoSystem } from '../gizmos/gizmo_system.js';
import { Vec3 } from '../../../runtime/core/math/vec3.js';

/** Ray-AABB intersection using the slab method. Returns t or null. */
function rayAABBIntersect(origin: Vec3, dir: Vec3, aabbMin: Vec3, aabbMax: Vec3): number | null {
    let tmin = -Infinity;
    let tmax = Infinity;
    for (let i = 0; i < 3; i++) {
        const o = i === 0 ? origin.x : i === 1 ? origin.y : origin.z;
        const d = i === 0 ? dir.x : i === 1 ? dir.y : dir.z;
        const bmin = i === 0 ? aabbMin.x : i === 1 ? aabbMin.y : aabbMin.z;
        const bmax = i === 0 ? aabbMax.x : i === 1 ? aabbMax.y : aabbMax.z;
        if (Math.abs(d) < 1e-12) {
            if (o < bmin || o > bmax) return null;
        } else {
            let t1 = (bmin - o) / d;
            let t2 = (bmax - o) / d;
            if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
            if (t1 > tmin) tmin = t1;
            if (t2 < tmax) tmax = t2;
            if (tmin > tmax) return null;
        }
    }
    return tmin;
}

/** Ray-triangle intersection (Moller-Trumbore). Returns t or null. */
function rayTriangleIntersect(
    origin: Vec3, dir: Vec3,
    v0x: number, v0y: number, v0z: number,
    v1x: number, v1y: number, v1z: number,
    v2x: number, v2y: number, v2z: number,
): number | null {
    const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
    const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
    const px = dir.y * e2z - dir.z * e2y;
    const py = dir.z * e2x - dir.x * e2z;
    const pz = dir.x * e2y - dir.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-10) return null;
    const invDet = 1 / det;
    const tx = origin.x - v0x, ty = origin.y - v0y, tz = origin.z - v0z;
    const u = (tx * px + ty * py + tz * pz) * invDet;
    if (u < 0 || u > 1) return null;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dir.x * qx + dir.y * qy + dir.z * qz) * invDet;
    if (v < 0 || u + v > 1) return null;
    const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
    return t > 0 ? t : null;
}

/** Collision mesh cache for entity picking. */
const collisionMeshCache = new Map<string, { positions: Float32Array; indices: Uint32Array } | null>();
const collisionMeshPending = new Set<string>();

/**
 * Handles mouse and keyboard input in the viewport.
 * Routes events to the camera, gizmo system, or entity selection
 * depending on context.
 */
export class ViewportInputHandler {
    private ctx: EditorContext;
    private camera: EditorCamera;
    private gizmo: GizmoSystem;
    private canvas: HTMLCanvasElement;

    private mouseDownX: number = 0;
    private mouseDownY: number = 0;
    private mouseDownHadCtrl: boolean = false;
    private mouseDownHadShift: boolean = false;

    private boxSelectActive: boolean = false;
    private boxSelectEl: HTMLElement | null = null;
    private gizmoWasInteracting: boolean = false;

    private touchStartX: number = 0;
    private touchStartY: number = 0;
    private touchStartTime: number = 0;

    constructor(canvas: HTMLCanvasElement, camera: EditorCamera, gizmo: GizmoSystem) {
        this.ctx = EditorContext.instance;
        this.camera = camera;
        this.gizmo = gizmo;
        this.canvas = canvas;

        canvas.addEventListener('mousedown', this.onMouseDown);
        canvas.addEventListener('dblclick', this.onDoubleClick);
        canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
        canvas.addEventListener('touchend', this.onTouchEnd, { passive: false });
    }

    detach(): void {
        this.canvas.removeEventListener('mousedown', this.onMouseDown);
        this.canvas.removeEventListener('dblclick', this.onDoubleClick);
        this.canvas.removeEventListener('touchstart', this.onTouchStart);
        this.canvas.removeEventListener('touchend', this.onTouchEnd);
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);
        this.removeBoxSelectOverlay();
    }

    private onMouseDown = (e: MouseEvent): void => {
        // Blur any focused text input so the viewport captures shortcuts
        const active = document.activeElement as HTMLElement | null;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)) {
            active.blur();
        }

        if (e.button !== 0) return;
        this.mouseDownX = e.clientX;
        this.mouseDownY = e.clientY;
        this.mouseDownHadCtrl = e.ctrlKey || e.metaKey;
        this.mouseDownHadShift = e.shiftKey;
        this.boxSelectActive = false;
        this.gizmoWasInteracting = false;

        window.addEventListener('mouseup', this.onMouseUp);

        // Start listening for mousemove for potential box select (orbit mode only)
        if (!this.mouseDownHadCtrl && !this.mouseDownHadShift && !e.altKey
            && this.ctx.state.cameraMode !== 'fly'
            && !this.ctx.state.isPlaying
            && !this.ctx.state.terrainSculptActive) {
            window.addEventListener('mousemove', this.onMouseMove);
        }
    };

    private onMouseMove = (e: MouseEvent): void => {
        const dx = e.clientX - this.mouseDownX;
        const dy = e.clientY - this.mouseDownY;

        if (this.gizmo.isInteracting()) {
            this.gizmoWasInteracting = true;
            this.removeBoxSelectOverlay();
            window.removeEventListener('mousemove', this.onMouseMove);
            return;
        }

        if (!this.boxSelectActive && dx * dx + dy * dy > 25) {
            this.boxSelectActive = true;
        }

        if (this.boxSelectActive) {
            this.updateBoxSelectOverlay(this.mouseDownX, this.mouseDownY, e.clientX, e.clientY);
        }
    };

    private onMouseUp = (e: MouseEvent): void => {
        if (e.button !== 0) return;

        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);

        if (this.boxSelectActive) {
            this.boxSelectActive = false;
            this.removeBoxSelectOverlay();
            this.performBoxSelect(this.mouseDownX, this.mouseDownY, e.clientX, e.clientY);
            return;
        }

        // Ctrl/Shift+click (no drag) is multi-select
        const isCtrl = e.ctrlKey || e.metaKey || this.mouseDownHadCtrl;
        const isShift = e.shiftKey || this.mouseDownHadShift;
        if (isCtrl || isShift) {
            const dx = e.clientX - this.mouseDownX;
            const dy = e.clientY - this.mouseDownY;
            if (dx * dx + dy * dy > 16) return;
        }

        // In fly mode, left-click is mouse look -- skip selection on drag
        if (this.ctx.state.cameraMode === 'fly') {
            const dx = e.clientX - this.mouseDownX;
            const dy = e.clientY - this.mouseDownY;
            if (dx * dx + dy * dy > 16) return;
        }

        if (this.gizmoWasInteracting || this.gizmo.isInteracting()) return;
        if (this.ctx.state.isPlaying) return;
        if (this.ctx.state.terrainSculptActive) return;

        this.performRaycastSelect(e.clientX, e.clientY, isCtrl, isShift);
    };

    private performRaycastSelect(clientX: number, clientY: number, isCtrl: boolean, isShift: boolean): void {
        const rect = this.canvas.getBoundingClientRect();
        const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);

        const scene = this.ctx.getActiveScene();
        if (!scene) return;

        const invViewProj = this.camera.getViewProjectionMatrix().inverse();
        if (!invViewProj) return;

        const nearPoint = invViewProj.transformPoint(new Vec3(ndcX, ndcY, 0));
        const farPoint = invViewProj.transformPoint(new Vec3(ndcX, ndcY, 1));
        const rayOrigin = nearPoint;
        const rayDir = farPoint.sub(nearPoint).normalize();

        interface HitCandidate { id: number; t: number; isTerrain: boolean; }
        const candidates: HitCandidate[] = [];

        for (const entity of scene.entities.values()) {
            if (!entity.active) continue;
            if (this.ctx.state.lockedEntities.has(entity.id)) continue;
            if (this.ctx.state.hiddenEntities.has(entity.id)) continue;

            const transform = entity.getComponent('TransformComponent');
            if (!transform) continue;

            const mr = entity.getComponent('MeshRendererComponent') as any;
            const terrain = entity.getComponent('TerrainComponent') as any;
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

            // Compute world-space AABB from local AABB corners
            const worldMatrix = entity.getWorldMatrix();
            let wMinX = Infinity, wMinY = Infinity, wMinZ = Infinity;
            let wMaxX = -Infinity, wMaxY = -Infinity, wMaxZ = -Infinity;
            for (let i = 0; i < 8; i++) {
                const cx = (i & 1) ? bMax.x : bMin.x;
                const cy = (i & 2) ? bMax.y : bMin.y;
                const cz = (i & 4) ? bMax.z : bMin.z;
                const wp = worldMatrix.transformPoint(new Vec3(cx, cy, cz));
                if (wp.x < wMinX) wMinX = wp.x; if (wp.x > wMaxX) wMaxX = wp.x;
                if (wp.y < wMinY) wMinY = wp.y; if (wp.y > wMaxY) wMaxY = wp.y;
                if (wp.z < wMinZ) wMinZ = wp.z; if (wp.z > wMaxZ) wMaxZ = wp.z;
            }

            // Broad phase: ray-AABB
            const aabbT = rayAABBIntersect(rayOrigin, rayDir,
                new Vec3(wMinX, wMinY, wMinZ), new Vec3(wMaxX, wMaxY, wMaxZ));
            if (aabbT === null || aabbT <= 0) continue;

            // Narrow phase: transform ray into local space
            const invWorld = worldMatrix.inverse();
            if (!invWorld) continue;

            const localOrigin = invWorld.transformPoint(rayOrigin);
            const localFar = invWorld.transformPoint(rayOrigin.add(rayDir));
            const localDir = localFar.sub(localOrigin).normalize();

            let bestT: number | null = null;

            const collider = entity.getComponent('ColliderComponent') as any;
            if (collider && collider.shapeType === 3 /* MESH */) {
                const meshAsset = mr?.meshAsset;
                if (meshAsset) {
                    const binUrl = meshAsset.replace(/\.glb$/i, '.collision.bin');
                    const cached = collisionMeshCache.get(binUrl);
                    if (cached) {
                        const pos = cached.positions, idx = cached.indices;
                        for (let i = 0; i < idx.length; i += 3) {
                            const i0 = idx[i] * 3, i1 = idx[i + 1] * 3, i2 = idx[i + 2] * 3;
                            const t = rayTriangleIntersect(localOrigin, localDir,
                                pos[i0], pos[i0 + 1], pos[i0 + 2],
                                pos[i1], pos[i1 + 1], pos[i1 + 2],
                                pos[i2], pos[i2 + 1], pos[i2 + 2]);
                            if (t !== null && (bestT === null || t < bestT)) bestT = t;
                        }
                    } else if (cached === undefined && !collisionMeshPending.has(binUrl)) {
                        collisionMeshPending.add(binUrl);
                        fetch(binUrl).then(r => r.ok ? r.arrayBuffer() : null).then(buf => {
                            collisionMeshPending.delete(binUrl);
                            if (!buf || buf.byteLength < 16) { collisionMeshCache.set(binUrl, null); return; }
                            const view = new DataView(buf);
                            if (view.getUint32(0, true) !== 0x434F4C4C) { collisionMeshCache.set(binUrl, null); return; }
                            const posCount = view.getUint32(8, true), idxCount = view.getUint32(12, true);
                            collisionMeshCache.set(binUrl, {
                                positions: new Float32Array(buf, 16, posCount),
                                indices: new Uint32Array(buf, 16 + posCount * 4, idxCount),
                            });
                        }).catch(() => { collisionMeshPending.delete(binUrl); collisionMeshCache.set(binUrl, null); });
                        bestT = aabbT;
                    } else {
                        bestT = aabbT;
                    }
                } else {
                    bestT = aabbT;
                }
            } else {
                // Box / sphere / capsule / terrain / compound / no-collider —
                // all pick against the visible mesh AABB.
                //
                // The previous sphere/capsule narrow-phase read
                // collider.radius / .height / .center directly, but those
                // fields are runtime state rewritten by
                // editor_context.autoFitCollider when the mesh's AABB becomes
                // available. When autoFit hasn't run yet (race during asset
                // streaming, collider added without a loaded mesh, snapshot
                // round-trip ordering quirk) the values are stuck at the
                // ColliderComponent constructor defaults: radius 0.5, height
                // 1.0, center at origin. That's a unit-sphere hitbox at
                // local-space origin — invisibly small on a large entity, so
                // clicks on the visible mesh miss entirely and the entity
                // appears unselectable. AABB picking is what the user is
                // looking at and never goes stale.
                bestT = aabbT;
            }

            if (bestT !== null) {
                candidates.push({ id: entity.id, t: bestT, isTerrain: !!terrain });
            }
        }

        // Pick closest hit, preferring non-terrain entities
        let closestId: number | null = null;
        const nonTerrain = candidates.filter(c => !c.isTerrain);
        const pool = nonTerrain.length > 0 ? nonTerrain : candidates;

        if (pool.length > 0) {
            pool.sort((a, b) => a.t - b.t);
            closestId = pool[0].id;
        }

        if (closestId !== null) {
            if (isCtrl || isShift) {
                this.ctx.toggleSelection(closestId);
            } else if (this.ctx.state.selectedEntityIds.length === 1 && this.ctx.state.selectedEntityIds[0] === closestId) {
                this.ctx.clearSelection();
            } else {
                this.ctx.setSelection([closestId]);
            }
        } else if (!isCtrl && !isShift) {
            this.ctx.clearSelection();
        }
    }

    // ── Box Select ──────────────────────────────────────────────────────

    private updateBoxSelectOverlay(x1: number, y1: number, x2: number, y2: number): void {
        if (!this.boxSelectEl) {
            this.boxSelectEl = document.createElement('div');
            this.boxSelectEl.style.cssText = `
                position: fixed; z-index: 9999; pointer-events: none;
                border: 1px solid rgba(100, 180, 255, 0.9);
                background: rgba(100, 180, 255, 0.12);
            `;
            document.body.appendChild(this.boxSelectEl);
        }
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        this.boxSelectEl.style.left = left + 'px';
        this.boxSelectEl.style.top = top + 'px';
        this.boxSelectEl.style.width = width + 'px';
        this.boxSelectEl.style.height = height + 'px';
    }

    private removeBoxSelectOverlay(): void {
        if (this.boxSelectEl) {
            this.boxSelectEl.remove();
            this.boxSelectEl = null;
        }
    }

    private performBoxSelect(x1: number, y1: number, x2: number, y2: number): void {
        const scene = this.ctx.getActiveScene();
        if (!scene) return;

        const viewProj = this.camera.getViewProjectionMatrix();
        const rect = this.canvas.getBoundingClientRect();

        const boxLeft = Math.min(x1, x2) - rect.left;
        const boxRight = Math.max(x1, x2) - rect.left;
        const boxTop = Math.min(y1, y2) - rect.top;
        const boxBottom = Math.max(y1, y2) - rect.top;

        const selectedIds: number[] = [];

        for (const entity of scene.entities.values()) {
            if (!entity.active) continue;
            if (this.ctx.state.lockedEntities.has(entity.id)) continue;
            if (this.ctx.state.hiddenEntities.has(entity.id)) continue;
            if (entity.getComponent('TerrainComponent')) continue;

            const transform = entity.getComponent('TransformComponent');
            if (!transform) continue;

            const worldPos = entity.getWorldPosition();

            // Check if behind camera
            const d = viewProj.data;
            const w = d[3] * worldPos.x + d[7] * worldPos.y + d[11] * worldPos.z + d[15];
            if (w <= 0.01) continue;

            const ndc = viewProj.transformPoint(worldPos);
            const screenX = (ndc.x * 0.5 + 0.5) * rect.width;
            const screenY = (1 - (ndc.y * 0.5 + 0.5)) * rect.height;

            if (screenX >= boxLeft && screenX <= boxRight &&
                screenY >= boxTop && screenY <= boxBottom) {
                selectedIds.push(entity.id);
            }
        }

        if (selectedIds.length > 0) {
            this.ctx.setSelection(selectedIds);
        } else {
            this.ctx.clearSelection();
        }
    }

    private onDoubleClick = (_e: MouseEvent): void => {
        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 1) {
            const pos = selected[0].getWorldPosition();
            this.camera.focusOn(pos);
        }
    };

    // ── Touch Selection ─────────────────────────────────────────────

    private onTouchStart = (e: TouchEvent): void => {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        this.touchStartX = touch.clientX;
        this.touchStartY = touch.clientY;
        this.touchStartTime = performance.now();
    };

    private onTouchEnd = (e: TouchEvent): void => {
        if (e.changedTouches.length !== 1) return;
        if (this.ctx.state.isPlaying) return;
        if (this.ctx.state.terrainSculptActive) return;
        if (this.gizmo.isInteracting()) return;

        const touch = e.changedTouches[0];
        const dx = touch.clientX - this.touchStartX;
        const dy = touch.clientY - this.touchStartY;
        const dist = dx * dx + dy * dy;
        const elapsed = performance.now() - this.touchStartTime;

        if (dist < 100 && elapsed < 400) {
            if (this.camera.wasTouchDrag()) return;
            this.performRaycastSelect(touch.clientX, touch.clientY, false, false);
        }
    };
}
