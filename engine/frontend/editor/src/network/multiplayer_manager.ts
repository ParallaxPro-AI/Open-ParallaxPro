import { WebRTCManager } from './webrtc_manager.js';

const STALE_PLAYER_TIMEOUT = 5000;
const PING_INTERVAL = 2000;
const INTERP_DELAY = 100;
const MAX_SNAPSHOTS = 20;

interface NetSnapshot {
    time: number;
    px: number; py: number; pz: number;
    rx: number; ry: number; rz: number; rw: number;
}

export interface RemotePlayer {
    networkId: number;
    username: string;
    entityId: number | null;
    lastPosition: { x: number; y: number; z: number };
    lastRotation: { x: number; y: number; z: number; w: number };
    targetPosition: { x: number; y: number; z: number };
    targetRotation: { x: number; y: number; z: number; w: number };
    lastUpdateTime: number;
    isReady: boolean;
    latency: number;
    customState: Record<string, any>;
    snapshots: NetSnapshot[];
}

export type MultiplayerEventHandler = (data?: any) => void;

export class MultiplayerManager {
    private ws: WebSocket | null = null;
    private roomId: string = '';
    private networkId: number = 0;
    private isHost: boolean = false;
    connected: boolean = false;
    private remotePlayers: Map<number, RemotePlayer> = new Map();
    private listeners: Map<string, MultiplayerEventHandler[]> = new Map();
    private sendInterval: number = 0;
    private pingInterval: number = 0;
    private lastPingSentAt: number = 0;
    private lastServerRelaySendTime: number = 0;

    readonly webrtc: WebRTCManager = new WebRTCManager();

    private _isReady: boolean = false;
    private _lobbyState: 'disconnected' | 'lobby' | 'playing' | 'finished' = 'disconnected';
    private _hostNetworkId: number = 0;
    private _latency: number = 0;
    private _gameName: string = '';
    private _gameSettings: Record<string, any> = {};
    private _maxPlayers: number = 100;
    private _minPlayers: number = 1;

    onSpawnRemotePlayer: ((networkId: number, username: string) => number | null) | null = null;
    onDespawnRemotePlayer: ((entityId: number) => void) | null = null;
    onUpdateRemotePlayer: ((entityId: number, pos: { x: number; y: number; z: number }, rot: { x: number; y: number; z: number; w: number }) => void) | null = null;
    getLocalPlayerState: (() => { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } } | null) | null = null;
    onGameEvent: ((senderNetworkId: number, event: string, data: any) => void) | null = null;

    get isConnected(): boolean { return this.connected; }
    get currentRoomId(): string { return this.roomId; }
    get isRoomHost(): boolean { return this.isHost; }
    get hostNetworkId(): number { return this._hostNetworkId; }
    get localNetworkId(): number { return this.networkId; }
    get remotePlayerCount(): number { return this.remotePlayers.size; }
    get lobbyState(): string { return this._lobbyState; }
    get gameName(): string { return this._gameName; }
    get gameSettings(): Record<string, any> { return this._gameSettings; }
    get isReady(): boolean { return this._isReady; }
    get maxPlayers(): number { return this._maxPlayers; }
    get minPlayers(): number { return this._minPlayers; }

    getLatency(): number { return this._latency; }

    getRemotePlayers(): RemotePlayer[] {
        return Array.from(this.remotePlayers.values());
    }

    on(event: string, handler: MultiplayerEventHandler): void {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event)!.push(handler);
    }

    private emit(event: string, data?: any): void {
        const handlers = this.listeners.get(event);
        if (handlers) for (const h of handlers) h(data);
    }

    async connect(roomId?: string, projectId?: string, gameName?: string, projectData?: any): Promise<string> {
        return this._connectWs(resolve => {
            const version = projectData?.updated_at || projectData?._lastLoadedAt || undefined;
            const mpConfig = projectData?.multiplayerConfig;
            this.send('join_room', {
                roomId: roomId || undefined,
                projectId: projectId || undefined,
                gameName: gameName || undefined,
                projectData: !roomId ? projectData : undefined,
                projectVersion: !roomId && version ? String(version) : undefined,
                maxPlayers: !roomId && mpConfig?.maxPlayers ? mpConfig.maxPlayers : undefined,
                minPlayers: !roomId && mpConfig?.minPlayers ? mpConfig.minPlayers : undefined,
            });
        });
    }

    async connectForBrowse(): Promise<void> {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
        await this._connectWs(() => {
            this.connected = true;
        });
    }

    private _connectWs(onOpen: (resolve: (v: any) => void) => void): Promise<string> {
        return new Promise((resolve, reject) => {
            const token = localStorage.getItem('auth_token') ?? localStorage.getItem('token') ?? '';
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const url = `${protocol}//${window.location.host}/ws/multiplayer?token=${token}`;

            this.ws = new WebSocket(url);
            let resolved = false;

            this.ws.onopen = () => {
                onOpen(resolve);
            };

            this.ws.onmessage = (event) => {
                let msg: { type: string; data: any };
                try {
                    msg = JSON.parse(event.data);
                } catch { return; }

                this.handleMessage(msg, resolved, resolve);
                if (msg.type === 'room_joined' && !resolved) {
                    resolved = true;
                }
                if (msg.type === 'error' && !resolved) {
                    resolved = true;
                    reject(new Error(msg.data.message || 'Multiplayer error'));
                }
            };

            this.ws.onclose = () => {
                this.connected = false;
                this._lobbyState = 'disconnected';
                this.stopSendLoop();
                this.stopPingLoop();
                if (!resolved) {
                    resolved = true;
                    reject(new Error('Connection closed'));
                }
                this.emit('disconnected');
            };

            this.ws.onerror = () => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error('WebSocket error'));
                }
            };

            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error('Connection timeout'));
                }
            }, 10000);
        });
    }

    disconnect(): void {
        this.webrtc.disconnectAll();
        this.stopSendLoop();
        this.stopPingLoop();
        for (const [, player] of this.remotePlayers) {
            if (player.entityId != null && this.onDespawnRemotePlayer) {
                this.onDespawnRemotePlayer(player.entityId);
            }
        }
        this.remotePlayers.clear();
        if (this.ws) {
            this.send('leave_room', {});
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this._lobbyState = 'disconnected';
        this.roomId = '';
        this.networkId = 0;
        this.isHost = false;
        this._isReady = false;
        this._latency = 0;
        this.listeners.clear();
    }

    setReady(ready: boolean): void {
        this._isReady = ready;
        this.send('ready', { ready });
    }

    startGame(): void {
        this.send('start_game', {});
    }

    kickPlayer(networkId: number): void {
        this.send('kick_player', { networkId });
    }

    blockPlayer(networkId: number): void {
        this.send('block_player', { networkId });
    }

    transferHost(networkId: number): void {
        this.send('transfer_host', { networkId });
    }

    setPublic(isPublic: boolean): void {
        this.send('set_public', { isPublic });
    }

    setGameSettings(settings: Record<string, any>): void {
        this._gameSettings = settings;
        this.send('set_game_settings', { settings });
    }

    requestRoomList(projectId?: string, projectVersion?: string): void {
        this.send('list_rooms', { projectId, projectVersion });
    }

    sendGameEvent(event: string, data: any): void {
        if (!this.webrtc.broadcastEvent(event, data)) {
            this.send('game_event', { event, data });
        }
    }

    sendCustomState(channel: string, data: any): void {
        if (!this.connected || !this.getLocalPlayerState) return;
        const state = this.getLocalPlayerState();
        if (!state) return;
        this.send('game_state', {
            entities: {
                player: {
                    position: state.position,
                    rotation: state.rotation,
                },
            },
            custom: { [channel]: data },
        });
    }

    tick(_dt: number): void {
        const now = performance.now();
        const renderTime = now - INTERP_DELAY;
        const staleIds: number[] = [];

        for (const [networkId, player] of this.remotePlayers) {
            if (player.entityId == null) continue;

            if (now - player.lastUpdateTime > STALE_PLAYER_TIMEOUT) {
                staleIds.push(networkId);
                continue;
            }

            const snaps = player.snapshots;

            if (snaps.length >= 2) {
                let s0: NetSnapshot | null = null;
                let s1: NetSnapshot | null = null;

                for (let i = 0; i < snaps.length - 1; i++) {
                    if (snaps[i].time <= renderTime && snaps[i + 1].time >= renderTime) {
                        s0 = snaps[i];
                        s1 = snaps[i + 1];
                        break;
                    }
                }

                if (s0 && s1) {
                    const span = s1.time - s0.time;
                    const t = span > 0 ? (renderTime - s0.time) / span : 0;
                    player.lastPosition.x = s0.px + (s1.px - s0.px) * t;
                    player.lastPosition.y = s0.py + (s1.py - s0.py) * t;
                    player.lastPosition.z = s0.pz + (s1.pz - s0.pz) * t;
                    let rx = s0.rx + (s1.rx - s0.rx) * t;
                    let ry = s0.ry + (s1.ry - s0.ry) * t;
                    let rz = s0.rz + (s1.rz - s0.rz) * t;
                    let rw = s0.rw + (s1.rw - s0.rw) * t;
                    const len = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw) || 1;
                    player.lastRotation.x = rx / len;
                    player.lastRotation.y = ry / len;
                    player.lastRotation.z = rz / len;
                    player.lastRotation.w = rw / len;
                } else if (snaps.length > 0) {
                    const a = snaps[snaps.length - 2];
                    const b = snaps[snaps.length - 1];
                    const span = b.time - a.time;
                    if (span > 0) {
                        const elapsed = Math.min(renderTime - b.time, span);
                        const rate = elapsed / span;
                        player.lastPosition.x = b.px + (b.px - a.px) * rate;
                        player.lastPosition.y = b.py + (b.py - a.py) * rate;
                        player.lastPosition.z = b.pz + (b.pz - a.pz) * rate;
                    }
                    player.lastRotation.x = b.rx;
                    player.lastRotation.y = b.ry;
                    player.lastRotation.z = b.rz;
                    player.lastRotation.w = b.rw;
                }

                while (snaps.length > 2 && snaps[1].time < renderTime) {
                    snaps.shift();
                }
            } else if (snaps.length === 1) {
                const s = snaps[0];
                player.lastPosition.x = s.px;
                player.lastPosition.y = s.py;
                player.lastPosition.z = s.pz;
                player.lastRotation.x = s.rx;
                player.lastRotation.y = s.ry;
                player.lastRotation.z = s.rz;
                player.lastRotation.w = s.rw;
            }

            if (this.onUpdateRemotePlayer) {
                this.onUpdateRemotePlayer(player.entityId, player.lastPosition, player.lastRotation);
            }
        }

        for (const networkId of staleIds) {
            this.handlePeerLeft(networkId);
        }
    }

    getJoinLink(): string {
        return `${window.location.origin}/play/multiplayer?room=${this.roomId}`;
    }

    send(type: string, data: any): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type, data }));
        }
    }

    private handleMessage(msg: { type: string; data: any }, alreadyResolved: boolean, resolve: (v: string) => void): void {
        switch (msg.type) {
            case 'connected':
                break;

            case 'room_joined':
                this.roomId = msg.data.roomId;
                this.networkId = msg.data.networkId;
                this.isHost = msg.data.isHost;
                this._hostNetworkId = msg.data.hostNetworkId ?? (msg.data.isHost ? msg.data.networkId : 0);
                this.connected = true;
                this._lobbyState = 'lobby';
                this._gameName = msg.data.gameName || '';
                this._gameSettings = msg.data.gameSettings || {};
                this._maxPlayers = msg.data.maxPlayers || 100;
                this._minPlayers = msg.data.minPlayers || 1;

                this.webrtc.initialize(this.networkId);
                this.webrtc.sendSignal = (type, data) => this.send(type, data);
                this.webrtc.onStateUpdate = (senderId, data) => this.handleStateUpdate({ senderNetworkId: senderId, ...data });
                this.webrtc.onGameEvent = (senderId, event, data) => this.handleGameEvent({ senderNetworkId: senderId, event, data });

                for (const p of msg.data.players as any[]) {
                    if (p.networkId !== this.networkId) {
                        this.handlePeerJoined(p.networkId, p.username, p.isReady);
                        this.webrtc.connectToPeer(p.networkId).catch(() => {});
                    }
                }

                this.startSendLoop();
                this.startPingLoop();

                if (!alreadyResolved) {
                    resolve(this.roomId);
                }
                this.emit('roomJoined', { roomId: this.roomId, isHost: this.isHost });
                break;

            case 'player_joined':
                this.handlePeerJoined(msg.data.networkId, msg.data.username, false);
                this.webrtc.connectToPeer(msg.data.networkId).catch(() => {});
                break;

            case 'player_left':
                this.handlePeerLeft(msg.data.networkId);
                this.webrtc.disconnectPeer(msg.data.networkId);
                break;

            case 'rtc_offer':
            case 'rtc_answer':
            case 'rtc_ice':
                this.webrtc.handleSignal(msg.type, msg.data).catch(() => {});
                break;

            case 'game_state_update':
                this.handleStateUpdate(msg.data);
                break;

            case 'game_event_broadcast':
                this.handleGameEvent(msg.data);
                break;

            case 'pong':
                this.handlePong();
                break;

            case 'player_ready': {
                const player = this.remotePlayers.get(msg.data.networkId);
                if (player) player.isReady = msg.data.ready;
                this.emit('playerReady', { networkId: msg.data.networkId, ready: msg.data.ready });
                break;
            }

            case 'game_started':
                this._lobbyState = 'playing';
                this.emit('gameStarted', {});
                if ((this as any)._onGameStarted) {
                    (this as any)._onGameStarted();
                }
                break;

            case 'host_changed':
                this._hostNetworkId = msg.data.networkId;
                this.isHost = msg.data.networkId === this.networkId;
                this.emit('hostChanged', { networkId: msg.data.networkId, isHost: this.isHost });
                break;

            case 'player_kicked':
                this.handlePeerLeft(msg.data.networkId);
                this.emit('playerKicked', { networkId: msg.data.networkId });
                break;

            case 'player_kicked_self':
                for (const [, p] of this.remotePlayers) {
                    if (p.entityId != null && this.onDespawnRemotePlayer) {
                        this.onDespawnRemotePlayer(p.entityId);
                    }
                }
                this.remotePlayers.clear();
                this.roomId = '';
                this.isHost = false;
                this._isReady = false;
                this._lobbyState = 'disconnected';
                this.stopSendLoop();
                this.emit('kicked', { reason: msg.data.reason, message: msg.data.message });
                if ((this as any)._onKicked) (this as any)._onKicked({ reason: msg.data.reason, message: msg.data.message });
                break;

            case 'room_renamed':
                this._gameName = msg.data.name || '';
                this.emit('roomRenamed', { name: this._gameName });
                break;

            case 'game_settings_updated':
                this._gameSettings = msg.data.settings || {};
                this.emit('gameSettingsUpdated', { settings: this._gameSettings });
                break;

            case 'room_list':
                this.emit('roomList', { rooms: msg.data.rooms });
                break;

            case 'room_closed':
                this.emit('roomClosed', { reason: msg.data.reason, message: msg.data.message });
                for (const [, p] of this.remotePlayers) {
                    if (p.entityId != null && this.onDespawnRemotePlayer) {
                        this.onDespawnRemotePlayer(p.entityId);
                    }
                }
                this.remotePlayers.clear();
                this.connected = false;
                this._lobbyState = 'disconnected';
                this.stopSendLoop();
                this.stopPingLoop();
                break;

            case 'error':
                console.error('[Multiplayer] Server error:', msg.data?.message || JSON.stringify(msg.data));
                break;
        }
    }

    private handlePeerJoined(networkId: number, username: string, isReady?: boolean): void {
        if (this.remotePlayers.has(networkId)) return;

        const player: RemotePlayer = {
            networkId,
            username,
            entityId: null,
            lastPosition: { x: 0, y: 0, z: 0 },
            lastRotation: { x: 0, y: 0, z: 0, w: 1 },
            targetPosition: { x: 0, y: 0, z: 0 },
            targetRotation: { x: 0, y: 0, z: 0, w: 1 },
            lastUpdateTime: performance.now(),
            isReady: isReady || false,
            latency: 0,
            customState: {},
            snapshots: [],
        };

        if (this._lobbyState === 'playing' && this.onSpawnRemotePlayer) {
            player.entityId = this.onSpawnRemotePlayer(networkId, username);
        }

        this.remotePlayers.set(networkId, player);
        this.emit('playerJoined', { networkId, username });
    }

    private handlePeerLeft(networkId: number): void {
        const player = this.remotePlayers.get(networkId);
        if (!player) return;

        if (player.entityId != null && this.onDespawnRemotePlayer) {
            this.onDespawnRemotePlayer(player.entityId);
        }

        this.remotePlayers.delete(networkId);
        this.emit('playerLeft', { networkId, username: player.username });
    }

    private handleStateUpdate(data: any): void {
        const senderNetworkId = data.senderNetworkId as number;
        const entities = data.entities as any;

        const player = this.remotePlayers.get(senderNetworkId);
        if (!player) return;

        if (entities?.player) {
            const playerState = entities.player;
            const pos = playerState.position;
            const rot = playerState.rotation;
            player.targetPosition = pos;
            player.targetRotation = rot;
            player.lastUpdateTime = performance.now();

            player.snapshots.push({
                time: performance.now(),
                px: pos.x, py: pos.y, pz: pos.z,
                rx: rot.x, ry: rot.y, rz: rot.z, rw: rot.w,
            });
            if (player.snapshots.length > MAX_SNAPSHOTS) {
                player.snapshots.shift();
            }
        }

        if (data.custom) {
            for (const [channel, value] of Object.entries(data.custom)) {
                player.customState[channel] = value;
            }
        }
    }

    private handleGameEvent(data: any): void {
        const { senderNetworkId, event, data: eventData } = data;
        if (this.onGameEvent) {
            this.onGameEvent(senderNetworkId, event, eventData);
        }
        this.emit('gameEvent', { senderNetworkId, event, data: eventData });
    }

    private handlePong(): void {
        if (this.lastPingSentAt > 0) {
            this._latency = Math.round((performance.now() - this.lastPingSentAt) / 2);
        }
    }

    private startSendLoop(): void {
        if (this.sendInterval) return;
        this.sendInterval = window.setInterval(() => {
            if (!this.connected || !this.getLocalPlayerState) return;
            if (this._lobbyState !== 'playing') return;
            const state = this.getLocalPlayerState();
            if (!state) return;
            const statePayload = {
                entities: {
                    player: {
                        position: state.position,
                        rotation: state.rotation,
                    },
                },
            };
            if (!this.webrtc.broadcastState(statePayload)) {
                const now = performance.now();
                if (now - this.lastServerRelaySendTime >= 67) {
                    this.send('game_state', statePayload);
                    this.lastServerRelaySendTime = now;
                }
            }
        }, 16);
    }

    private stopSendLoop(): void {
        if (this.sendInterval) {
            clearInterval(this.sendInterval);
            this.sendInterval = 0;
        }
    }

    private startPingLoop(): void {
        if (this.pingInterval) return;
        this.pingInterval = window.setInterval(() => {
            if (!this.connected) return;
            this.lastPingSentAt = performance.now();
            this.send('ping', {});
        }, PING_INTERVAL);
    }

    private stopPingLoop(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = 0;
        }
    }

    spawnAllRemotePlayers(): void {
        for (const [, player] of this.remotePlayers) {
            if (player.entityId == null && this.onSpawnRemotePlayer) {
                player.entityId = this.onSpawnRemotePlayer(player.networkId, player.username);
            }
        }
    }
}
