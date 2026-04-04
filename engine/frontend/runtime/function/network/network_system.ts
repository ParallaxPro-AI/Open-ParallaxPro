import { Vec3 } from '../../core/math/vec3.js';
import { Quat } from '../../core/math/quat.js';
import { WebSocketClient } from '../../platform/network/websocket_client.js';
import { MessageType, EntityStateMessage, EntitySpawnMessage, EntityDespawnMessage } from './network_messages.js';
import { StateInterpolator, StateSnapshot } from './state_interpolator.js';

export type SpawnCallback = (msg: EntitySpawnMessage) => void;
export type DespawnCallback = (entityId: number) => void;

export class NetworkSystem {
    private wsClient: WebSocketClient = new WebSocketClient();
    private interpolator: StateInterpolator = new StateInterpolator();
    private connected: boolean = false;
    private localPlayerId: number = -1;
    private serverTime: number = 0;
    private localTimeOffset: number = 0;
    private lastPingTime: number = 0;
    private latency: number = 0;
    private spawnCallbacks: SpawnCallback[] = [];
    private despawnCallbacks: DespawnCallback[] = [];

    initialize(interpolationDelay?: number, tickRate?: number): void {
        if (interpolationDelay !== undefined) {
            this.interpolator.setInterpolationDelay(interpolationDelay);
        }
    }

    async connect(url: string): Promise<void> {
        this.wsClient.clearMessageHandlers();
        this.wsClient.clearLifecycleCallbacks();
        await this.wsClient.connect(url);
        this.connected = true;

        this.wsClient.onMessage(MessageType.ENTITY_STATE, (data: EntityStateMessage) => {
            this.handleEntityState(data);
        });

        this.wsClient.onMessage(MessageType.ENTITY_STATE_BATCH, (data: EntityStateMessage[]) => {
            for (const state of data) {
                this.handleEntityState(state);
            }
        });

        this.wsClient.onMessage(MessageType.ENTITY_SPAWN, (data: EntitySpawnMessage) => {
            for (const cb of this.spawnCallbacks) cb(data);
        });

        this.wsClient.onMessage(MessageType.ENTITY_DESPAWN, (data: EntityDespawnMessage) => {
            this.interpolator.removeEntity(data.entityId);
            for (const cb of this.despawnCallbacks) cb(data.entityId);
        });

        this.wsClient.onMessage(MessageType.PONG, (data: { clientTime: number; serverTime: number }) => {
            const now = performance.now() / 1000;
            this.latency = (now - data.clientTime) / 2;
            this.serverTime = data.serverTime + this.latency;
            this.localTimeOffset = this.serverTime - now;
        });

        this.wsClient.onMessage(MessageType.HANDSHAKE_ACK, (data: { playerId: number; serverTime: number }) => {
            this.localPlayerId = data.playerId;
            this.serverTime = data.serverTime;
            this.localTimeOffset = data.serverTime - (performance.now() / 1000);
        });

        this.wsClient.onDisconnect(() => {
            this.connected = false;
        });

        this.wsClient.send(MessageType.HANDSHAKE, {});
    }

    disconnect(): void {
        this.wsClient.disconnect();
        this.wsClient.clearMessageHandlers();
        this.wsClient.clearLifecycleCallbacks();
        this.connected = false;
        this.interpolator.clear();
    }

    tick(deltaTime: number): void {
        if (!this.connected) return;

        this.serverTime += deltaTime;

        this.lastPingTime += deltaTime;
        if (this.lastPingTime >= 1.0) {
            this.lastPingTime = 0;
            this.wsClient.send(MessageType.PING, {
                clientTime: performance.now() / 1000,
            });
        }

        this.interpolator.prune(this.serverTime - 2.0);
    }

    sendEntityState(entityId: number, position: Vec3, rotation: Quat, velocity?: Vec3): void {
        if (!this.connected) return;
        const msg: EntityStateMessage = {
            entityId,
            position: position.toArray(),
            rotation: rotation.toArray(),
            velocity: velocity?.toArray(),
            timestamp: this.getServerTime(),
        };
        this.wsClient.send(MessageType.ENTITY_STATE, msg);
    }

    sendInput(sequenceNumber: number, inputs: Record<string, number | boolean>): void {
        if (!this.connected) return;
        this.wsClient.send(MessageType.PLAYER_INPUT, {
            sequenceNumber,
            inputs,
            timestamp: this.getServerTime(),
        });
    }

    getInterpolatedState(entityId: number): { position: Vec3; rotation: Quat } | null {
        return this.interpolator.interpolate(entityId, this.serverTime);
    }

    onSpawn(callback: SpawnCallback): void { this.spawnCallbacks.push(callback); }
    onDespawn(callback: DespawnCallback): void { this.despawnCallbacks.push(callback); }

    getLatency(): number { return this.latency; }
    getServerTime(): number { return this.serverTime; }
    getLocalPlayerId(): number { return this.localPlayerId; }
    isConnected(): boolean { return this.connected; }
    getInterpolator(): StateInterpolator { return this.interpolator; }

    private handleEntityState(data: EntityStateMessage): void {
        const snapshot: StateSnapshot = {
            entityId: data.entityId,
            position: new Vec3(data.position[0], data.position[1], data.position[2]),
            rotation: new Quat(data.rotation[0], data.rotation[1], data.rotation[2], data.rotation[3]),
            velocity: data.velocity
                ? new Vec3(data.velocity[0], data.velocity[1], data.velocity[2])
                : new Vec3(),
            timestamp: data.timestamp,
        };
        this.interpolator.addSnapshot(snapshot);
    }

    shutdown(): void {
        this.disconnect();
        this.spawnCallbacks.length = 0;
        this.despawnCallbacks.length = 0;
        this.interpolator.clear();
    }
}
