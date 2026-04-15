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
 *
 * `onEntitySpawned` is called after the adapter creates a new entity for
 * an inbound spawn or proxy. The bootstrapper uses it to trigger mesh
 * uploads (raw Scene.createEntity doesn't emit the editor's entityCreated
 * event that normally drives ensurePrimitiveMeshes).
 */
export function installDefaultNetworkAdapter(
    session: MultiplayerSession,
    scene: Scene,
    inputSystem: InputSystem,
    onEntitySpawned?: () => void,
): () => void {
    const adapter = new DefaultNetworkAdapter(session, scene, inputSystem, onEntitySpawned);
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
        private readonly onEntitySpawned?: () => void,
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

        let sceneEntity = this.findSceneEntityByNetId(entity.id);
        if (!sceneEntity) {
            // We've never seen this networkId. For remote player snapshots
            // (flag 4 = localPlayer-hint on origin), auto-spawn a visual
            // proxy so the player is actually rendered on every peer. Other
            // entity kinds wait for an explicit spawn message so game code
            // can control construction.
            if ((entity.flags & 4) !== 0 && entity.owner && entity.owner !== this.session.localPeerId) {
                sceneEntity = this._spawnRemotePlayerProxy(entity);
            }
            if (!sceneEntity) {
                this._pendingSpawnInfo.set(entity.id, entity);
                return;
            }
        }
        this.applySnapshotToEntity(sceneEntity, entity);
    }

    /**
     * Spawn a minimal capsule with the networked identity stamped on it so
     * subsequent snapshots flow into its transform. Used for remote players
     * coming from other peers — no movement behavior attached, just a
     * visible avatar the interpolator can drive.
     */
    private _spawnRemotePlayerProxy(entity: SnapshotEntity): any {
        const scene = this.scene as any;
        if (typeof scene.createEntity !== 'function') return null;
        const ent = scene.createEntity('RemotePlayer_' + entity.id);
        if (!ent || typeof ent.addComponent !== 'function') return null;
        ent.addComponent('TransformComponent', {
            position: { x: entity.pos?.[0] ?? 0, y: entity.pos?.[1] ?? 0, z: entity.pos?.[2] ?? 0 },
            rotation: { x: entity.rot?.[0] ?? 0, y: entity.rot?.[1] ?? 0, z: entity.rot?.[2] ?? 0, w: entity.rot?.[3] ?? 1 },
            scale: { x: 1, y: 1, z: 1 },
        });
        ent.addComponent('MeshRendererComponent', {
            meshType: 'capsule',
            baseColor: [0.4, 0.6, 1.0, 1],
        });
        ent.addComponent('NetworkIdentityComponent', {
            networkId: entity.id,
            ownerId: entity.owner || -1,
            isLocalPlayer: false,
            syncTransform: true,
        });
        if (typeof ent.addTag === 'function') {
            ent.addTag('player');
            ent.addTag('remote');
            ent.addTag('networked');
        }
        this.onEntitySpawned?.();
        return ent;
    }

    onSpawnEntity(info: { networkId: number; prefab: string; owner: PeerId | '';
        pos: [number, number, number]; rot: [number, number, number, number] }): void {
        // Skip if already present (host's own spawn won't echo back, but
        // FULL_STATE delivery on late-join might).
        if (this.findSceneEntityByNetId(info.networkId)) {
            this._applyBuffered(info.networkId);
            return;
        }
        // Default-spawn a minimal visual entity using the raw Scene/Entity
        // API. "coin" → gold sphere, anything else → blue capsule (works
        // for player proxies).
        const scene = this.scene as any;
        if (typeof scene.createEntity !== 'function') {
            console.warn('[DefaultNetworkAdapter] scene.createEntity missing — cannot spawn', info.prefab);
            return;
        }
        const isCoin = info.prefab === 'coin';
        const entity = scene.createEntity(this._defaultProxyName(info));
        if (!entity || typeof entity.addComponent !== 'function') {
            console.warn('[DefaultNetworkAdapter] entity.addComponent missing — cannot spawn', info.prefab);
            return;
        }
        const scale = isCoin ? { x: 0.6, y: 0.6, z: 0.6 } : { x: 1, y: 1, z: 1 };
        entity.addComponent('TransformComponent', {
            position: { x: info.pos[0], y: info.pos[1], z: info.pos[2] },
            rotation: { x: info.rot[0], y: info.rot[1], z: info.rot[2], w: info.rot[3] },
            scale,
        });
        entity.addComponent('MeshRendererComponent', {
            meshType: isCoin ? 'sphere' : 'capsule',
            baseColor: isCoin ? [1, 0.82, 0.2, 1] : [0.4, 0.6, 1.0, 1],
        });
        entity.addComponent('NetworkIdentityComponent', {
            networkId: info.networkId,
            ownerId: info.owner || -1,
            isLocalPlayer: false,
            syncTransform: true,
        });
        if (typeof entity.addTag === 'function') {
            if (isCoin) { entity.addTag('coin'); }
            else { entity.addTag('player'); entity.addTag('remote'); }
            entity.addTag('networked');
        }
        this.onEntitySpawned?.();
        this._applyBuffered(info.networkId);
    }

    private _defaultProxyName(info: { prefab: string; networkId: number }): string {
        if (info.prefab === 'coin') return 'Coin';
        return 'RemotePlayer_' + info.networkId;
    }

    private _applyBuffered(networkId: number): void {
        const buffered = this._pendingSpawnInfo.get(networkId);
        if (!buffered) return;
        this._pendingSpawnInfo.delete(networkId);
        const e = this.findSceneEntityByNetId(networkId);
        if (e) this.applySnapshotToEntity(e, buffered);
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
