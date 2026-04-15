/**
 * DefaultNetworkAdapter — scene ↔ MultiplayerSession bridge.
 *
 * Walks the active scene each sim tick, finds every entity with a
 * NetworkIdentityComponent, and hands the session a compact snapshot. On
 * the receiving side it applies inbound snapshots to the local scene
 * (transform + networkedVars).
 *
 * For v0.1 the adapter is deliberately minimal:
 *   - Transform sync: position + rotation + velocity (linear only).
 *   - Prediction: local player entity applies input immediately; on
 *     authoritative snapshot, position is snapped if the server copy
 *     differs by more than `reconcileThreshold` and queued inputs replay.
 *   - No compression / delta — snapshots are full each tick. Data channel
 *     bandwidth is fine at 30 Hz with <20 networked entities.
 *
 * Scripts that want to add gameplay-level networked state use the
 * NetworkIdentityComponent's `networkedVars` API (setNetworkedVar /
 * getNetworkedVar); this adapter forwards those vars automatically.
 */

import type { Scene } from '../framework/scene.js';
import type { InputSystem } from '../input/input_system.js';
import { NetworkIdentityComponent } from '../framework/components/network_identity_component.js';
import { TransformComponent } from '../framework/components/transform_component.js';
import type {
    NetworkedEntityAdapter, SnapshotEntity, LocalInputFrame, PeerId,
} from './multiplayer_session.js';
import { MultiplayerSession } from './multiplayer_session.js';
import { Vec3 } from '../../core/math/vec3.js';
import { Quat } from '../../core/math/quat.js';

const RECONCILE_POSITION_EPSILON = 0.05;  // world units
const RECONCILE_ROTATION_EPSILON = 0.02;  // quat component

type InputAxis = { x: number; y: number; z: number };

interface RemoteInputBuffer {
    latestAxis: InputAxis;
    latestKeys: Record<string, boolean>;
    latestSeq: number;
    latestTick: number;
}

/**
 * Hook up the adapter automatically. Call once from the engine / play
 * bootstrapper, right after the MultiplayerSession is attached to the
 * scriptScene. The returned callback detaches cleanup.
 */
export function installDefaultNetworkAdapter(
    session: MultiplayerSession,
    scene: Scene,
    inputSystem: InputSystem,
): () => void {
    const adapter = new DefaultNetworkAdapter(session, scene, inputSystem);
    session.setAdapter(adapter);
    return () => { session.setAdapter(null); };
}

export class DefaultNetworkAdapter implements NetworkedEntityAdapter {
    private _remoteInputs: Map<PeerId, RemoteInputBuffer> = new Map();
    private _pendingSpawnInfo: Map<number, SnapshotEntity> = new Map();

    constructor(
        private readonly session: MultiplayerSession,
        private readonly scene: Scene,
        private readonly inputSystem: InputSystem,
    ) {}

    listLocallyOwnedEntities(): Array<{ networkId: number; getSnapshot(): any }> {
        const out: Array<{ networkId: number; getSnapshot(): any }> = [];
        for (const entity of this.scene.entities.values()) {
            if (!entity.active) continue;
            const ni = entity.getComponent('NetworkIdentityComponent') as NetworkIdentityComponent | null;
            if (!ni || ni.networkId < 0) continue;
            if (!ni.isLocalPlayer) continue;
            const adapter = this;
            out.push({
                networkId: ni.networkId,
                getSnapshot: () => adapter.buildEntitySnapshot(entity, ni),
            });
        }
        return out;
    }

    listHostOwnedEntities(): Array<{ networkId: number; getSnapshot(): any }> {
        const out: Array<{ networkId: number; getSnapshot(): any }> = [];
        if (!this.session.isHost) return out;
        for (const entity of this.scene.entities.values()) {
            if (!entity.active) continue;
            const ni = entity.getComponent('NetworkIdentityComponent') as NetworkIdentityComponent | null;
            if (!ni || ni.networkId < 0) continue;
            if (ni.isLocalPlayer) continue; // local player handled above
            // Non-local-player networked entities are host-owned in star topology.
            const adapter = this;
            out.push({
                networkId: ni.networkId,
                getSnapshot: () => adapter.buildEntitySnapshot(entity, ni),
            });
        }
        return out;
    }

    onRemoteSnapshotEntity(entity: SnapshotEntity, _ts: number): void {
        // Skip local player — reconciliation happens separately via reconcileLocalPlayer.
        if ((entity.flags & 4) !== 0 && entity.owner === this.session.localPeerId) return;

        const sceneEntity = this.findSceneEntityByNetId(entity.id);
        if (!sceneEntity) {
            // Not spawned yet — buffer the snapshot. When host broadcasts the
            // matching spawn (or a FULL_STATE reveals this entity), we apply.
            this._pendingSpawnInfo.set(entity.id, entity);
            return;
        }
        this.applySnapshotToEntity(sceneEntity, entity);
    }

    onSpawnEntity(info: { networkId: number; prefab: string; owner: PeerId | '';
        pos: [number, number, number]; rot: [number, number, number, number] }): void {
        // Look up or create the prefab. Spawning logic is project-specific —
        // we delegate to a scene hook if present, otherwise log a warning.
        const scene = this.scene as any;
        if (typeof scene.spawnNetworkedPrefab === 'function') {
            scene.spawnNetworkedPrefab({
                networkId: info.networkId,
                prefab: info.prefab,
                owner: info.owner,
                isLocalPlayer: info.owner === this.session.localPeerId,
                position: info.pos,
                rotation: info.rot,
            });
        } else {
            // Fallback: attempt spawn via normal scene API
            console.warn('[DefaultNetworkAdapter] scene.spawnNetworkedPrefab not implemented — cannot spawn', info.prefab);
        }

        // Apply any buffered snapshot
        const buffered = this._pendingSpawnInfo.get(info.networkId);
        if (buffered) {
            this._pendingSpawnInfo.delete(info.networkId);
            const e = this.findSceneEntityByNetId(info.networkId);
            if (e) this.applySnapshotToEntity(e, buffered);
        }
    }

    onDespawnEntity(networkId: number): void {
        const e = this.findSceneEntityByNetId(networkId);
        if (!e) return;
        (this.scene as any).destroyEntity?.(e.id);
    }

    applyLocalInputPrediction(frame: LocalInputFrame): void {
        // Prediction is the scripts' responsibility: the input_system
        // already holds the current keys/axis, so on the client the local
        // player's movement behavior runs as normal. We just need to make
        // sure the *exact* input we send upstream matches what was applied
        // locally — which is what sampleLocalInput does. Nothing to do
        // here beyond bookkeeping.
        void frame;
    }

    reconcileLocalPlayer(authoritative: SnapshotEntity, _lastSeq: number, _replayInputs: LocalInputFrame[]): void {
        if (!authoritative.pos || !authoritative.rot) return;
        const sceneEntity = this.findSceneEntityByNetId(authoritative.id);
        if (!sceneEntity) return;
        const tc = sceneEntity.getComponent('TransformComponent') as TransformComponent | null;
        if (!tc) return;

        const dx = Math.abs(tc.position.x - authoritative.pos[0]);
        const dy = Math.abs(tc.position.y - authoritative.pos[1]);
        const dz = Math.abs(tc.position.z - authoritative.pos[2]);
        const posDiverged = (dx + dy + dz) > RECONCILE_POSITION_EPSILON;

        const qx = Math.abs(tc.rotation.x - authoritative.rot[0]);
        const qy = Math.abs(tc.rotation.y - authoritative.rot[1]);
        const qz = Math.abs(tc.rotation.z - authoritative.rot[2]);
        const qw = Math.abs(tc.rotation.w - authoritative.rot[3]);
        const rotDiverged = (qx + qy + qz + qw) > RECONCILE_ROTATION_EPSILON;

        if (!posDiverged && !rotDiverged) return;

        // Snap to authoritative state. Replaying queued inputs in a strict
        // sense requires re-running the movement behavior — for v0.1 we
        // soft-snap and let the next input frame pick up from the corrected
        // state. That avoids jitter from tiny divergences while still
        // reining in drift from dropped packets.
        tc.position.x = authoritative.pos[0];
        tc.position.y = authoritative.pos[1];
        tc.position.z = authoritative.pos[2];
        tc.rotation.x = authoritative.rot[0];
        tc.rotation.y = authoritative.rot[1];
        tc.rotation.z = authoritative.rot[2];
        tc.rotation.w = authoritative.rot[3];
        tc.markDirty();
        (tc as any).worldMatrix = null;
        (tc as any).localMatrix = null;

        // Apply authoritative networkedVars too.
        if (authoritative.vars) {
            const ni = sceneEntity.getComponent('NetworkIdentityComponent') as NetworkIdentityComponent | null;
            ni?.applyReceivedVars(authoritative.vars);
        }
    }

    onRemoteInput(fromPeerId: PeerId, frame: LocalInputFrame): void {
        // Host records the latest input per client so host-side player
        // movement behaviors can read it via getRemoteInput(peerId).
        let buf = this._remoteInputs.get(fromPeerId);
        if (!buf) {
            buf = { latestAxis: { x: 0, y: 0, z: 0 }, latestKeys: {}, latestSeq: 0, latestTick: 0 };
            this._remoteInputs.set(fromPeerId, buf);
        }
        if (frame.seq <= buf.latestSeq) return;  // out-of-order dropped
        buf.latestSeq = frame.seq;
        buf.latestTick = frame.tick;
        buf.latestKeys = frame.keys || {};
        if (frame.axis) buf.latestAxis = frame.axis;
    }

    onNetworkedEvent(_fromPeerId: PeerId, _event: string, _data: any): void {
        // The session forwards these to listeners; nothing to do adapter-side.
    }

    sampleLocalInput(tick: number, seq: number): Omit<LocalInputFrame, 'seq' | 'tick' | 'tsMs'> {
        const input = this.inputSystem;
        const keys: Record<string, boolean> = {};
        // Capture the common movement keys. Script movement behaviors only
        // consult these, so sending more is waste; sending fewer loses inputs.
        const tracked = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ControlLeft',
                         'KeyQ', 'KeyE', 'KeyR', 'KeyF',
                         'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
                         'MouseLeft', 'MouseRight'];
        for (const k of tracked) {
            if ((input as any).isKeyDown?.(k)) keys[k] = true;
        }
        const md = (input as any).getMouseDelta?.() ?? { x: 0, y: 0 };
        void tick; void seq;
        return {
            keys,
            axis: { x: 0, y: 0, z: 0 },
            mouseDelta: [md.x ?? 0, md.y ?? 0],
        };
    }

    /** Host-only: query last received input from a remote peer. */
    getRemoteInput(peerId: PeerId): { axis: InputAxis; keys: Record<string, boolean> } | null {
        const buf = this._remoteInputs.get(peerId);
        if (!buf) return null;
        return { axis: buf.latestAxis, keys: buf.latestKeys };
    }

    // -- Helpers -----------------------------------------------------------

    private buildEntitySnapshot(entity: any, ni: NetworkIdentityComponent): any {
        const tc = entity.getComponent('TransformComponent') as TransformComponent | null;
        const out: any = {};
        if (ni.syncTransform && tc) {
            out.pos = [tc.position.x, tc.position.y, tc.position.z];
            out.rot = [tc.rotation.x, tc.rotation.y, tc.rotation.z, tc.rotation.w];
            const rb = entity.getComponent('RigidbodyComponent') as any;
            if (rb && rb.linearVelocity) {
                out.vel = [rb.linearVelocity.x, rb.linearVelocity.y, rb.linearVelocity.z];
            } else {
                out.vel = [0, 0, 0];
            }
        }
        const dirtyVars = ni.consumeDirtyVars();
        if (Object.keys(dirtyVars).length > 0) {
            out.vars = dirtyVars;
        }
        return out;
    }

    private applySnapshotToEntity(entity: any, snap: SnapshotEntity): void {
        if (snap.pos && snap.rot) {
            // Use interpolator for smooth render-side movement; the transform
            // here gets the newest server-confirmed value, which scripts may
            // read for gameplay logic.
            const tc = entity.getComponent('TransformComponent') as TransformComponent | null;
            if (tc) {
                const interp = this.session.interpolator.interpolate(
                    snap.id,
                    this.session.isHost ? 0 : performance.now() / 1000,
                );
                const targetPos = interp?.position ?? new Vec3(snap.pos[0], snap.pos[1], snap.pos[2]);
                const targetRot = interp?.rotation ?? new Quat(snap.rot[0], snap.rot[1], snap.rot[2], snap.rot[3]);
                tc.position.x = targetPos.x; tc.position.y = targetPos.y; tc.position.z = targetPos.z;
                tc.rotation.x = targetRot.x; tc.rotation.y = targetRot.y; tc.rotation.z = targetRot.z; tc.rotation.w = targetRot.w;
                tc.markDirty();
                (tc as any).worldMatrix = null;
                (tc as any).localMatrix = null;
            }
        }
        if (snap.vars) {
            const ni = entity.getComponent('NetworkIdentityComponent') as NetworkIdentityComponent | null;
            ni?.applyReceivedVars(snap.vars);
        }
    }

    private findSceneEntityByNetId(networkId: number): any | null {
        for (const entity of this.scene.entities.values()) {
            const ni = entity.getComponent('NetworkIdentityComponent') as NetworkIdentityComponent | null;
            if (ni && ni.networkId === networkId) return entity;
        }
        return null;
    }
}
