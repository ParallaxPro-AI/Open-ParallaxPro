/**
 * MultiplayerSession — top-level orchestrator for peer-to-peer multiplayer.
 *
 * Responsibilities:
 *   - Own the LobbyClient (signaling) and WebRTCManager (data channels).
 *   - Track session state: disconnected | browsing | in-lobby | in-game.
 *   - Host: run the authoritative 30Hz simulation tick, build snapshots,
 *     broadcast them, receive inputs from clients, echo lastProcessedInputSeq
 *     per client.
 *   - Client: send inputs up at 30Hz, buffer incoming snapshots for the
 *     StateInterpolator, trigger client-side-prediction reconciliation on
 *     the local player entity when the server-authoritative position
 *     diverges.
 *   - Relay chat + voice events to UI panels.
 *
 * Design notes:
 *   * Star topology (one host, all clients connect only to host). Simpler
 *     authority, lower bandwidth than full mesh, ping is a single number.
 *   * Everything transmitted is explicitly whitelisted: entities with a
 *     NetworkIdentityComponent (transform + networkedVars), inputs, chat,
 *     explicit net.* events emitted by flow/scripts.
 *   * Prediction + reconciliation only on the local-player entity. Remote
 *     entities use the existing StateInterpolator with 100ms delay.
 */

import { LobbyClient, type LobbyListEntry, type LobbyRoster, type PeerId } from './lobby_client.js';
export type { PeerId } from './lobby_client.js';
import { WebRTCManager, type RTCMessage } from './webrtc_manager.js';
import { Vec3 } from '../../core/math/vec3.js';
import { Quat } from '../../core/math/quat.js';
import { StateInterpolator, type StateSnapshot } from './state_interpolator.js';

export type SessionPhase =
    | 'disconnected'
    | 'connecting'
    | 'browsing'
    | 'in_lobby'
    | 'in_game'
    | 'game_over';

export interface ChatMessage {
    fromPeerId: PeerId;
    fromUsername: string;
    body: string;
    tsMs: number;
}

export interface SnapshotEntity {
    id: number;                            // networkId
    owner: PeerId | '';                    // '' = host-owned
    flags: number;                         // 1=transform, 2=vars, 4=localPlayer-hint
    pos?: [number, number, number];
    rot?: [number, number, number, number];
    vel?: [number, number, number];
    vars?: Record<string, any>;
    prefab?: string;                       // set on spawn
}

export interface Snapshot {
    tick: number;
    ts: number;
    entities: SnapshotEntity[];
    procInputs?: Record<PeerId, number>;   // lastProcessedInputSeq per client
}

export interface LocalInputFrame {
    seq: number;
    tick: number;
    tsMs: number;
    keys: Record<string, boolean>;
    axis?: { x: number; y: number; z: number };
    mouseDelta?: [number, number];
}

export interface NetworkedEntityAdapter {
    // Drive these from the scene/engine layer via MultiplayerSession.setAdapter()
    listLocallyOwnedEntities(): Array<{ networkId: number; getSnapshot(): Omit<SnapshotEntity, 'id' | 'owner' | 'flags'> }>;
    listHostOwnedEntities(): Array<{ networkId: number; getSnapshot(): Omit<SnapshotEntity, 'id' | 'owner' | 'flags'> }>;
    onRemoteSnapshotEntity(entity: SnapshotEntity, ts: number): void;
    onSpawnEntity(info: { networkId: number; prefab: string; owner: PeerId | '';
        pos: [number, number, number]; rot: [number, number, number, number] }): void;
    onDespawnEntity(networkId: number): void;
    /** Fired when a peer disconnects so the adapter can drop their entities. */
    onPeerLeft?(peerId: PeerId): void;
    applyLocalInputPrediction(frame: LocalInputFrame): void;
    reconcileLocalPlayer(authoritative: SnapshotEntity, lastProcessedSeq: number, replayInputs: LocalInputFrame[]): void;
    onRemoteInput(fromPeerId: PeerId, frame: LocalInputFrame): void;   // host-side
    onNetworkedEvent(fromPeerId: PeerId, event: string, data: any): void;
    sampleLocalInput(tick: number, seq: number): Omit<LocalInputFrame, 'seq' | 'tick' | 'tsMs'>;
}

const TICK_RATE_DEFAULT = 30;
const INPUT_BUFFER_SIZE = 120;
const PING_INTERVAL_MS = 1000;
const CHAT_HISTORY_LIMIT = 50;

export class MultiplayerSession {
    readonly lobby: LobbyClient = new LobbyClient();
    readonly webrtc: WebRTCManager = new WebRTCManager();
    readonly interpolator: StateInterpolator = new StateInterpolator(0.1);

    private _phase: SessionPhase = 'disconnected';
    private _isHost: boolean = false;
    private _hostPeerId: PeerId = '';
    private _gameTemplateId: string = '';
    private _currentRoster: LobbyRoster | null = null;
    private _tickRate: number = TICK_RATE_DEFAULT;
    private _predictionEnabled: boolean = true;

    private _simTick: number = 0;
    private _simAccumulator: number = 0;
    private _inputSeq: number = 0;
    private _inputBuffer: LocalInputFrame[] = [];
    private _lastHostSnapshotTick: number = 0;
    private _hostPingMs: number = 0;
    private _pingAccumulator: number = 0;
    private _inflightPings: Map<number, number> = new Map();
    private _nextPingId: number = 1;

    private _adapter: NetworkedEntityAdapter | null = null;
    private _chatHistory: ChatMessage[] = [];
    private _voiceAudioElems: Map<PeerId, HTMLAudioElement> = new Map();
    private _voiceAnalysers: Map<PeerId, { analyser: AnalyserNode; buf: Uint8Array }> = new Map();
    private _voiceGainNodes: Map<PeerId, GainNode> = new Map();
    private _voiceLevels: Map<PeerId, number> = new Map();
    private _voiceAudioCtx: AudioContext | null = null;
    private _voiceCtxGestureHandler: (() => void) | null = null;
    private _localVoiceAnalyser: { analyser: AnalyserNode; buf: Uint8Array; src: MediaStreamAudioSourceNode } | null = null;

    private _lobbyListListeners = new Set<(lobbies: LobbyListEntry[]) => void>();
    private _rosterListeners = new Set<(roster: LobbyRoster | null) => void>();
    private _phaseListeners = new Set<(phase: SessionPhase) => void>();
    private _errorListeners = new Set<(message: string) => void>();
    private _chatListeners = new Set<(msg: ChatMessage) => void>();
    private _eventListeners = new Set<(fromPeerId: PeerId, event: string, data: any) => void>();
    private _voiceListeners = new Set<(peerId: PeerId, stream: MediaStream | null) => void>();

    setAdapter(adapter: NetworkedEntityAdapter | null): void { this._adapter = adapter; }
    setTickRate(tickRate: number): void {
        this._tickRate = Math.max(5, Math.min(120, Math.floor(tickRate) || TICK_RATE_DEFAULT));
    }
    setPredictionEnabled(enabled: boolean): void { this._predictionEnabled = enabled; }

    get phase(): SessionPhase { return this._phase; }
    get isHost(): boolean { return this._isHost; }
    get hostPeerId(): PeerId { return this._hostPeerId; }
    get roster(): LobbyRoster | null { return this._currentRoster; }
    get hostPingMs(): number { return this._hostPingMs; }
    get localPeerId(): PeerId { return this.lobby.peerId; }
    get localUsername(): string { return this.lobby.username; }
    get chatHistory(): ReadonlyArray<ChatMessage> { return this._chatHistory; }

    onLobbyList(cb: (lobbies: LobbyListEntry[]) => void): () => void {
        this._lobbyListListeners.add(cb); return () => this._lobbyListListeners.delete(cb);
    }
    onRoster(cb: (roster: LobbyRoster | null) => void): () => void {
        this._rosterListeners.add(cb); return () => this._rosterListeners.delete(cb);
    }
    onPhase(cb: (phase: SessionPhase) => void): () => void {
        this._phaseListeners.add(cb); return () => this._phaseListeners.delete(cb);
    }
    onError(cb: (message: string) => void): () => void {
        this._errorListeners.add(cb); return () => this._errorListeners.delete(cb);
    }
    onChat(cb: (msg: ChatMessage) => void): () => void {
        this._chatListeners.add(cb); return () => this._chatListeners.delete(cb);
    }
    onNetworkedEvent(cb: (fromPeerId: PeerId, event: string, data: any) => void): () => void {
        this._eventListeners.add(cb); return () => this._eventListeners.delete(cb);
    }
    onVoiceStream(cb: (peerId: PeerId, stream: MediaStream | null) => void): () => void {
        this._voiceListeners.add(cb); return () => this._voiceListeners.delete(cb);
    }

    // -- Connection lifecycle ----------------------------------------------

    async connect(url: string, gameTemplateId: string): Promise<void> {
        this._gameTemplateId = gameTemplateId;
        this.setPhase('connecting');
        this.lobby.setEvents({
            onHelloAck: (info) => {
                // Server may ship server-issued (Cloudflare) TURN credentials —
                // hand them to the WebRTC manager so future RTCPeerConnection
                // configs use them. Falls back to bundled STUN+OpenRelay
                // when not present.
                if (info?.iceServers && info.iceServers.length > 0) {
                    this.webrtc.setIceServers(info.iceServers);
                }
            },
            onListResult: (_tid, lobbies) => {
                for (const cb of this._lobbyListListeners) cb(lobbies);
            },
            onCreated: (roster) => this.handleJoinedRoster(roster, /* asHost */ true),
            onJoined: (roster) => this.handleJoinedRoster(roster, /* asHost */ false),
            onPeerJoined: (peer) => this.handlePeerJoined(peer.peerId, peer.username),
            onPeerLeft: (peerId) => this.handlePeerLeft(peerId),
            onPeerReady: (peerId, isReady) => this.updateRosterReady(peerId, isReady),
            onClosed: (_lobbyId, reason) => this.handleLobbyClosed(reason),
            onStarted: () => {
                if (this._currentRoster) this._currentRoster.state = 'playing';
                this.setPhase('in_game');
            },
            onKicked: (reason) => this.handleKicked(reason),
            onSignal: (fromPeerId, payload) => this.webrtc.handleSignal(fromPeerId, payload),
            onPingRequest: (fromPeerId, clientTs) => this.lobby.respondPing(fromPeerId, clientTs),
            onPingResult: (_hostPeerId, clientTs) => {
                const entry = this._lobbyPingPending.get(clientTs);
                if (entry) {
                    clearTimeout(entry.timeout);
                    this._lobbyPingPending.delete(clientTs);
                    entry.resolve(performance.now() - clientTs);
                }
            },
            onHostChanged: (newHostPeerId, _uname) => this.handleHostChanged(newHostPeerId),
            onError: (message) => this.fireError(message),
            onDisconnect: () => this.handleDisconnect(),
        });
        try {
            await this.lobby.connect(url);
        } catch (e: any) {
            this.setPhase('disconnected');
            throw e;
        }
        this.webrtc.initialize(
            this.lobby.peerId,
            (toPeerId, payload) => this.lobby.signal(toPeerId, payload),
            {
                onReady: (peerId) => this.handlePeerChannelReady(peerId),
                onClose: (peerId) => this.handlePeerChannelClosed(peerId),
                onMessage: (peerId, msg) => this.handleDataChannelMessage(peerId, msg),
                onRemoteAudio: (peerId, stream) => {
                    this.attachRemoteVoice(peerId, stream);
                    for (const cb of this._voiceListeners) cb(peerId, stream);
                },
            },
        );
        this.setPhase('browsing');
    }

    disconnect(): void {
        this.webrtc.disconnectAll();
        this.lobby.disconnect();
        this._currentRoster = null;
        this._isHost = false;
        this._hostPeerId = '';
        this._inputBuffer = [];
        this._inflightPings.clear();
        this._chatHistory = [];
        this.interpolator.clear();
        if (this._voiceCtxGestureHandler && typeof document !== 'undefined') {
            document.removeEventListener('pointerdown', this._voiceCtxGestureHandler, true);
            document.removeEventListener('keydown', this._voiceCtxGestureHandler, true);
            document.removeEventListener('touchstart', this._voiceCtxGestureHandler, true);
            this._voiceCtxGestureHandler = null;
        }
        this.setPhase('disconnected');
    }

    // -- Lobby actions ------------------------------------------------------

    requestLobbyList(): void { this.lobby.list(this._gameTemplateId); }

    hostLobby(opts: { name: string; maxPlayers: number; minPlayers: number; password?: string | null }): void {
        this.lobby.create({
            gameTemplateId: this._gameTemplateId,
            name: opts.name,
            maxPlayers: opts.maxPlayers,
            minPlayers: opts.minPlayers,
            password: opts.password ?? null,
        });
    }

    joinLobby(opts: { lobbyId: string; password?: string | null }): void {
        this.lobby.join({ lobbyId: opts.lobbyId, password: opts.password ?? null });
    }

    leaveLobby(): void {
        this.lobby.leave();
        this.webrtc.disconnectAll();
        this._currentRoster = null;
        this._isHost = false;
        this._hostPeerId = '';
        this.interpolator.clear();
        for (const cb of this._rosterListeners) cb(null);
        this.setPhase('browsing');
    }

    setReady(ready: boolean): void { this.lobby.setReady(ready); }

    startGame(): void {
        if (!this._isHost) return;
        this.lobby.start();
    }

    kickPlayer(peerId: PeerId, reason?: string): void {
        if (!this._isHost) return;
        this.lobby.kick(peerId, reason);
    }

    private _lobbyPingPending: Map<number, {
        resolve: (ms: number) => void;
        timeout: ReturnType<typeof setTimeout>;
    }> = new Map();

    /**
     * Fire a host-ping through the signaling server and resolve with the
     * round-trip time in milliseconds (or -1 on timeout). Safe to call
     * concurrently — each pending ping is keyed by its own clientTs.
     */
    async measureLobbyPing(lobbyId: string): Promise<number> {
        return new Promise<number>((resolve) => {
            const clientTs = performance.now();
            const timeout = setTimeout(() => {
                const entry = this._lobbyPingPending.get(clientTs);
                if (entry) {
                    this._lobbyPingPending.delete(clientTs);
                    entry.resolve(-1);
                }
            }, 3000);
            this._lobbyPingPending.set(clientTs, { resolve, timeout });
            this.lobby.pingHost(lobbyId, clientTs);
        });
    }

    // -- Chat + events ------------------------------------------------------

    sendChat(body: string): void {
        if (!body || !this._currentRoster) return;
        const trimmed = body.slice(0, 400);
        const msg: ChatMessage = {
            fromPeerId: this.lobby.peerId,
            fromUsername: this.lobby.username,
            body: trimmed,
            tsMs: Date.now(),
        };
        this.pushChat(msg);
        this.webrtc.broadcast({ t: 'chat', from: msg.fromUsername, body: trimmed, tsMs: msg.tsMs });
    }

    /** Send a gameplay event (flow emit:net.* or script-initiated). */
    sendNetworkedEvent(event: string, data: any): void {
        this.webrtc.broadcast({ t: 'ev', ev: event, d: data });
    }

    async enableVoice(): Promise<boolean> {
        const ok = await this.webrtc.enableLocalMic();
        if (ok) this.attachLocalVoiceMeter();
        return ok;
    }
    disableVoice(): void {
        this.detachLocalVoiceMeter();
        this.webrtc.disableLocalMic();
    }
    setMuted(muted: boolean): void { this.webrtc.setLocalMuted(muted); }
    hasVoice(): boolean { return this.webrtc.hasLocalMic(); }
    getRemoteAudioStream(peerId: PeerId): MediaStream | null { return this.webrtc.getRemoteAudioStream(peerId); }

    /**
     * Returns current voice levels per peer (RMS, 0-1). Engine polls this
     * once per frame to forward to the voice_chat HUD iframe, since
     * MediaStream objects can't cross postMessage. Metering runs on the
     * parent side; the iframe just renders the numbers.
     */
    getVoiceLevels(): Map<PeerId, number> {
        for (const [peerId, entry] of this._voiceAnalysers) {
            (entry.analyser as any).getByteTimeDomainData(entry.buf);
            let sum = 0;
            for (let i = 0; i < entry.buf.length; i++) {
                const v = (entry.buf[i] - 128) / 128;
                sum += v * v;
            }
            this._voiceLevels.set(peerId, Math.sqrt(sum / entry.buf.length));
        }
        if (this._localVoiceAnalyser) {
            const a = this._localVoiceAnalyser;
            (a.analyser as any).getByteTimeDomainData(a.buf);
            let sum = 0;
            for (let i = 0; i < a.buf.length; i++) {
                const v = (a.buf[i] - 128) / 128;
                sum += v * v;
            }
            this._voiceLevels.set(this.localPeerId, Math.sqrt(sum / a.buf.length));
        } else {
            this._voiceLevels.delete(this.localPeerId);
        }
        return this._voiceLevels;
    }

    private attachLocalVoiceMeter(): void {
        if (this._localVoiceAnalyser) return;
        const track = this.webrtc.getLocalAudioTrack();
        if (!track) return;
        try {
            const ctx = this.ensureVoiceAudioCtx();
            if (!ctx) return;
            const stream = new MediaStream([track]);
            const src = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            // Analyser only — never connect to destination or you'd hear
            // yourself through the speakers with a delay.
            src.connect(analyser);
            this._localVoiceAnalyser = { analyser, buf: new Uint8Array(analyser.fftSize), src };
        } catch { /* AudioContext unavailable — meter silently off. */ }
    }

    private detachLocalVoiceMeter(): void {
        if (!this._localVoiceAnalyser) return;
        try { this._localVoiceAnalyser.src.disconnect(); } catch { /* ignored */ }
        try { this._localVoiceAnalyser.analyser.disconnect(); } catch { /* ignored */ }
        this._localVoiceAnalyser = null;
        this._voiceLevels.delete(this.localPeerId);
    }

    private ensureVoiceAudioCtx(): AudioContext | null {
        if (!this._voiceAudioCtx) {
            const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
            if (Ctx) this._voiceAudioCtx = new Ctx();
        }
        const ctx = this._voiceAudioCtx;
        if (!ctx) return null;
        // A context created outside a user gesture starts suspended and
        // produces no sound until resumed. Without this, a peer who never
        // clicks their own mic button still sees the inbound stream but
        // hears nothing. Arm a one-shot gesture listener that resumes the
        // context on the first click/key/touch.
        if (ctx.state === 'suspended' && typeof document !== 'undefined' && !this._voiceCtxGestureHandler) {
            const handler = () => {
                if (this._voiceAudioCtx && this._voiceAudioCtx.state === 'suspended') {
                    this._voiceAudioCtx.resume().catch(() => { /* ignored */ });
                }
                document.removeEventListener('pointerdown', handler, true);
                document.removeEventListener('keydown', handler, true);
                document.removeEventListener('touchstart', handler, true);
                this._voiceCtxGestureHandler = null;
            };
            this._voiceCtxGestureHandler = handler;
            document.addEventListener('pointerdown', handler, true);
            document.addEventListener('keydown', handler, true);
            document.addEventListener('touchstart', handler, true);
        }
        // Opportunistic resume: if we happen to be inside a gesture right
        // now (e.g. attach triggered off a click-initiated getUserMedia),
        // this succeeds immediately.
        if (ctx.state === 'suspended') ctx.resume().catch(() => { /* ignored */ });
        return ctx;
    }

    private attachRemoteVoice(peerId: PeerId, stream: MediaStream): void {
        if (typeof document === 'undefined') return;
        // The audio element exists so Chrome treats the stream as "playing"
        // (a quirk: MediaStreamSource only pulls data when the stream has a
        // sink). Muted because WebAudio below actually drives the speakers.
        let audio = this._voiceAudioElems.get(peerId);
        if (!audio) {
            audio = document.createElement('audio');
            audio.autoplay = true;
            (audio as any).playsInline = true;
            audio.style.display = 'none';
            document.body.appendChild(audio);
            this._voiceAudioElems.set(peerId, audio);
        }
        audio.srcObject = stream;
        audio.muted = true;
        audio.play().catch(() => { /* blocked until user gesture */ });

        try {
            const ctx = this.ensureVoiceAudioCtx();
            if (!ctx) return;

            // Audio chain per peer:
            //   MediaStreamSource → Compressor → Gain → destination
            //                    ↘ Analyser (metering only)
            // Compressor lifts quiet voices without clipping loud ones;
            // gain of 2.5 is a gentle final boost that works well with
            // typical laptop mic levels.
            const src = ctx.createMediaStreamSource(stream);

            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            src.connect(analyser);

            const compressor = ctx.createDynamicsCompressor();
            compressor.threshold.value = -40;
            compressor.knee.value = 20;
            compressor.ratio.value = 6;
            compressor.attack.value = 0.005;
            compressor.release.value = 0.2;

            const gain = ctx.createGain();
            gain.gain.value = 2.5;

            src.connect(compressor);
            compressor.connect(gain);
            gain.connect(ctx.destination);

            const existing = this._voiceAnalysers.get(peerId);
            if (existing) { try { existing.analyser.disconnect(); } catch { /* ignored */ } }
            const prevGain = this._voiceGainNodes.get(peerId);
            if (prevGain) { try { prevGain.disconnect(); } catch { /* ignored */ } }

            this._voiceAnalysers.set(peerId, { analyser, buf: new Uint8Array(analyser.fftSize) });
            this._voiceGainNodes.set(peerId, gain);
        } catch { /* AudioContext unavailable — fall back to muted element (silent). */ }
    }

    /** Set per-peer playback gain. 0 = mute, 1 = unity, values up to 8 allowed. */
    setPeerVoiceGain(peerId: PeerId, gain: number): void {
        const node = this._voiceGainNodes.get(peerId);
        if (node) node.gain.value = Math.max(0, Math.min(8, gain));
    }

    private detachRemoteVoice(peerId: PeerId): void {
        const audio = this._voiceAudioElems.get(peerId);
        if (audio) {
            audio.srcObject = null;
            audio.remove();
            this._voiceAudioElems.delete(peerId);
        }
        const a = this._voiceAnalysers.get(peerId);
        if (a) { try { a.analyser.disconnect(); } catch { /* ignored */ } }
        const g = this._voiceGainNodes.get(peerId);
        if (g) { try { g.disconnect(); } catch { /* ignored */ } }
        this._voiceAnalysers.delete(peerId);
        this._voiceGainNodes.delete(peerId);
        this._voiceLevels.delete(peerId);
    }

    // -- Fixed-step tick (called from engine main loop) --------------------

    tick(deltaTime: number, _renderTime: number): void {
        // Ping measurement runs in lobby AND in-game so the lobby room can
        // show the host ping before the match starts. Sim broadcasts and
        // entity interpolation are gated on in_game below.
        if (this._phase !== 'in_lobby' && this._phase !== 'in_game') return;

        this._pingAccumulator += deltaTime * 1000;
        if (this._pingAccumulator >= PING_INTERVAL_MS && !this._isHost && this._hostPeerId) {
            this._pingAccumulator = 0;
            const id = this._nextPingId++;
            this._inflightPings.set(id, performance.now());
            this.webrtc.send(this._hostPeerId, { t: 'ping', id, tsMs: performance.now() });
        }

        if (this._phase !== 'in_game') return;

        // Per-frame smoothing for remote entity transforms, independent of
        // the 30Hz sim tick. The adapter exposes its own tickInterpolation
        // (the built-in StateInterpolator can't be used because peer
        // timestamps are in unrelated clocks).
        const adapterAny = this._adapter as any;
        if (adapterAny && typeof adapterAny.tickInterpolation === 'function') {
            adapterAny.tickInterpolation(deltaTime);
        }

        this._simAccumulator += deltaTime;
        const step = 1 / this._tickRate;
        let maxSteps = 4;
        while (this._simAccumulator >= step && maxSteps > 0) {
            this._simAccumulator -= step;
            maxSteps--;
            this._simTick++;
            this.runSimTick();
        }
    }

    private runSimTick(): void {
        const adapter = this._adapter;
        if (!adapter) return;

        if (this._isHost) {
            this.buildAndBroadcastSnapshot();
        } else {
            // Client-authoritative local player: each peer broadcasts its
            // own owned entities' transforms. Star topology means the
            // packet reaches the host only; host forwards to other peers.
            this.buildAndBroadcastClientSnapshot();
            this.sampleAndSendLocalInput();
        }
    }

    private buildAndBroadcastClientSnapshot(): void {
        const adapter = this._adapter!;
        const entities: SnapshotEntity[] = [];
        for (const e of adapter.listLocallyOwnedEntities()) {
            const s = e.getSnapshot();
            entities.push({
                id: e.networkId,
                owner: this.lobby.peerId,
                flags: (s.pos ? 1 : 0) | (s.vars ? 2 : 0) | 4,
                ...s,
            });
        }
        if (entities.length === 0 || !this._hostPeerId) return;
        const snap: Snapshot = {
            tick: this._simTick,
            ts: performance.now() / 1000,
            entities,
        };
        this.webrtc.send(this._hostPeerId, { t: 'snap', ...snap });
    }

    // -- Host: snapshot broadcast ------------------------------------------

    private buildAndBroadcastSnapshot(): void {
        const adapter = this._adapter!;
        const entities: SnapshotEntity[] = [];
        for (const e of adapter.listHostOwnedEntities()) {
            const s = e.getSnapshot();
            entities.push({
                id: e.networkId,
                owner: '',
                flags: (s.pos ? 1 : 0) | (s.vars ? 2 : 0),
                ...s,
            });
        }
        for (const e of adapter.listLocallyOwnedEntities()) {
            const s = e.getSnapshot();
            entities.push({
                id: e.networkId,
                owner: this.lobby.peerId,
                flags: (s.pos ? 1 : 0) | (s.vars ? 2 : 0) | 4,
                ...s,
            });
        }

        const snap: Snapshot = {
            tick: this._simTick,
            ts: performance.now() / 1000,
            entities,
            procInputs: this._lastProcessedInputSeqByPeer,
        };
        this.webrtc.broadcast({ t: 'snap', ...snap });
    }

    // -- Client: input sampling + prediction -------------------------------

    private sampleAndSendLocalInput(): void {
        const adapter = this._adapter!;
        const seq = ++this._inputSeq;
        const tick = this._simTick;
        const sample = adapter.sampleLocalInput(tick, seq);
        const frame: LocalInputFrame = { seq, tick, tsMs: performance.now(), ...sample };
        this._inputBuffer.push(frame);
        if (this._inputBuffer.length > INPUT_BUFFER_SIZE) this._inputBuffer.shift();

        if (this._predictionEnabled) {
            adapter.applyLocalInputPrediction(frame);
        }

        if (this._hostPeerId) {
            this.webrtc.send(this._hostPeerId, { t: 'in', ...frame });
        }
    }

    // -- Data channel handlers ---------------------------------------------

    private _lastProcessedInputSeqByPeer: Record<PeerId, number> = {};

    private handleDataChannelMessage(fromPeerId: PeerId, msg: RTCMessage): void {
        const adapter = this._adapter;
        switch (msg.t) {
            case 'snap': {
                const snap = msg as unknown as Snapshot;
                // Every peer applies received snapshots locally so other
                // players show up in its scene.
                this.applyRemoteSnapshot(snap);
                // Host is the hub of the star topology — relay client
                // snapshots to every other connected client so they can
                // see each other without a direct P2P mesh.
                if (this._isHost) {
                    for (const otherId of this.webrtc.getPeerIds()) {
                        if (otherId !== fromPeerId) this.webrtc.send(otherId, msg);
                    }
                }
                return;
            }
            case 'in': {
                if (!this._isHost) return;  // only host consumes inputs
                if (!adapter) return;
                const frame: LocalInputFrame = msg as any;
                this._lastProcessedInputSeqByPeer[fromPeerId] = frame.seq;
                adapter.onRemoteInput(fromPeerId, frame);
                return;
            }
            case 'ev': {
                if (adapter) adapter.onNetworkedEvent(fromPeerId, msg.ev, msg.d);
                for (const cb of this._eventListeners) cb(fromPeerId, msg.ev, msg.d);
                return;
            }
            case 'spawn': {
                if (this._isHost || !adapter) return;
                adapter.onSpawnEntity({
                    networkId: msg.id,
                    prefab: msg.prefab ?? '',
                    owner: msg.owner ?? '',
                    pos: msg.pos ?? [0, 0, 0],
                    rot: msg.rot ?? [0, 0, 0, 1],
                });
                return;
            }
            case 'despawn': {
                if (this._isHost || !adapter) return;
                adapter.onDespawnEntity(msg.id);
                this.interpolator.removeEntity(msg.id);
                return;
            }
            case 'full': {
                if (this._isHost || !adapter) return;
                const ents: SnapshotEntity[] = msg.entities ?? [];
                for (const e of ents) {
                    if (e.prefab) {
                        adapter.onSpawnEntity({
                            networkId: e.id, prefab: e.prefab, owner: e.owner,
                            pos: e.pos ?? [0, 0, 0], rot: e.rot ?? [0, 0, 0, 1],
                        });
                    }
                    adapter.onRemoteSnapshotEntity(e, performance.now() / 1000);
                }
                return;
            }
            case 'chat': {
                const cm: ChatMessage = {
                    fromPeerId,
                    fromUsername: String(msg.from ?? 'peer'),
                    body: String(msg.body ?? '').slice(0, 400),
                    tsMs: typeof msg.tsMs === 'number' ? msg.tsMs : Date.now(),
                };
                this.pushChat(cm);
                return;
            }
            case 'ping': {
                this.webrtc.send(fromPeerId, { t: 'pong', id: msg.id, tsMs: msg.tsMs });
                return;
            }
            case 'pong': {
                const sent = this._inflightPings.get(msg.id);
                if (sent !== undefined) {
                    this._inflightPings.delete(msg.id);
                    this._hostPingMs = Math.max(0, performance.now() - sent);
                }
                return;
            }
        }
    }

    private applyRemoteSnapshot(snap: Snapshot): void {
        const adapter = this._adapter;
        if (!adapter) return;

        if (snap.tick <= this._lastHostSnapshotTick) return;
        this._lastHostSnapshotTick = snap.tick;

        const nowTs = snap.ts;

        for (const e of snap.entities) {
            // Push remote entities into the interpolator buffer
            if ((e.flags & 1) && e.pos && e.rot) {
                const snapshot: StateSnapshot = {
                    entityId: e.id,
                    position: new Vec3(e.pos[0], e.pos[1], e.pos[2]),
                    rotation: new Quat(e.rot[0], e.rot[1], e.rot[2], e.rot[3]),
                    velocity: new Vec3(e.vel?.[0] ?? 0, e.vel?.[1] ?? 0, e.vel?.[2] ?? 0),
                    timestamp: nowTs,
                };
                this.interpolator.addSnapshot(snapshot);
            }
            adapter.onRemoteSnapshotEntity(e, nowTs);
        }

        // Reconciliation on the local player
        const lastSeq = snap.procInputs?.[this.lobby.peerId];
        if (lastSeq !== undefined && this._predictionEnabled) {
            const authoritative = snap.entities.find(e => e.owner === this.lobby.peerId && (e.flags & 4) !== 0);
            if (authoritative) {
                // Drop inputs up to lastSeq from the buffer, replay the rest
                while (this._inputBuffer.length > 0 && this._inputBuffer[0].seq <= lastSeq) {
                    this._inputBuffer.shift();
                }
                adapter.reconcileLocalPlayer(authoritative, lastSeq, this._inputBuffer.slice());
            }
        }
    }

    // -- Roster state --------------------------------------------------------

    private handleJoinedRoster(roster: LobbyRoster, asHost: boolean): void {
        this._currentRoster = roster;
        this._isHost = asHost;
        this._hostPeerId = roster.hostPeerId;
        this._lastProcessedInputSeqByPeer = {};
        for (const cb of this._rosterListeners) cb(roster);
        this.setPhase('in_lobby');

        if (asHost) {
            // Host waits for clients' offers.
            return;
        }
        // Client: open connection to host (we are initiator if our peerId > host's to avoid glare;
        // but simpler: host is always initiator. Client waits.)
        // To avoid waiting-forever, host initiates connections when peers join (see handlePeerJoined).
        // The server sends the full roster on join, including the host. We prompt host by sending a
        // quick "hello" no-op? No — the host gets a peer_joined event and kicks off the offer.
        this.webrtc.connect(roster.hostPeerId, /* amInitiator */ false).catch(() => {});
    }

    private handlePeerJoined(peerId: PeerId, username: string): void {
        if (!this._currentRoster) return;
        const existing = this._currentRoster.peers.find(p => p.peerId === peerId);
        if (!existing) {
            this._currentRoster.peers.push({ peerId, username, isReady: false, isHost: false });
        }
        for (const cb of this._rosterListeners) cb(this._currentRoster);

        if (this._isHost) {
            // Host initiates the RTC connection to each new peer.
            this.webrtc.connect(peerId, /* amInitiator */ true).catch(() => {});
        }
    }

    private handlePeerLeft(peerId: PeerId): void {
        if (this._currentRoster) {
            this._currentRoster.peers = this._currentRoster.peers.filter(p => p.peerId !== peerId);
            for (const cb of this._rosterListeners) cb(this._currentRoster);
        }
        this.webrtc.disconnect(peerId);
        this.detachRemoteVoice(peerId);
        // Adapter destroys any entities owned by the leaving peer (player
        // proxy capsules, etc.) so the scene doesn't accumulate ghosts.
        if (this._adapter && typeof this._adapter.onPeerLeft === 'function') {
            try { this._adapter.onPeerLeft(peerId); } catch (e) { console.warn('[mp] adapter.onPeerLeft', e); }
        }
        delete this._lastProcessedInputSeqByPeer[peerId];
    }

    private handlePeerChannelReady(peerId: PeerId): void {
        if (this._isHost && this._currentRoster?.state === 'playing' && this._adapter) {
            // Send a full-state snapshot to the new peer so they can spawn
            // every existing networked entity. Assembled from the same
            // lists we use for the per-tick snapshot.
            const entities: SnapshotEntity[] = [];
            for (const e of this._adapter.listHostOwnedEntities()) {
                const s = e.getSnapshot();
                entities.push({ id: e.networkId, owner: '', flags: 1, ...s });
            }
            for (const e of this._adapter.listLocallyOwnedEntities()) {
                const s = e.getSnapshot();
                entities.push({ id: e.networkId, owner: this.lobby.peerId, flags: 1 | 4, ...s });
            }
            this.webrtc.send(peerId, { t: 'full', entities, ts: performance.now() / 1000 });
        }
    }

    private handlePeerChannelClosed(_peerId: PeerId): void {
        // Nothing for now — lobby peer_left event is the source of truth.
    }

    private updateRosterReady(peerId: PeerId, isReady: boolean): void {
        if (!this._currentRoster) return;
        const p = this._currentRoster.peers.find(x => x.peerId === peerId);
        if (p) p.isReady = isReady;
        for (const cb of this._rosterListeners) cb(this._currentRoster);
    }

    /**
     * Re-point the WebRTC star topology at a new host without tearing down
     * the rest of the session. Everyone drops their connection to the old
     * host (it's gone), then the new host initiates fresh connections to
     * every other peer (responder on the other side). For the old host's
     * replacement that's "me", `_isHost` flips and input sampling vs.
     * snapshot broadcasting swaps over on the next sim tick.
     *
     * For v0.1 we do NOT migrate any authoritative gameplay state — clients
     * keep their predicted local-player state but host-owned entities may
     * reset. Good enough for the reference arena template; mid-match
     * migration in state-heavy games is a future problem.
     */
    private handleHostChanged(newHostPeerId: PeerId): void {
        if (!this._currentRoster) return;
        const oldHostPeerId = this._hostPeerId;
        if (oldHostPeerId === newHostPeerId) return;

        this._hostPeerId = newHostPeerId;
        this._isHost = newHostPeerId === this.lobby.peerId;

        // Reset ping bookkeeping. Hosts don't ping themselves; non-hosts
        // need a clean slate against the new host since RTT to the
        // previous host isn't predictive.
        this._hostPingMs = 0;
        this._inflightPings.clear();
        this._pingAccumulator = 0;

        // Update roster isHost flags for UI display.
        for (const p of this._currentRoster.peers) {
            p.isHost = p.peerId === newHostPeerId;
        }
        this._currentRoster.hostPeerId = newHostPeerId;

        // Disconnect from the old host (it's dead anyway). Non-old-host
        // connections stay up if the new host is reusing them.
        if (oldHostPeerId && oldHostPeerId !== newHostPeerId) {
            this.webrtc.disconnect(oldHostPeerId);
        }

        if (this._isHost) {
            // I'm the new host — initiate connections to every other peer.
            for (const peer of this._currentRoster.peers) {
                if (peer.peerId === this.lobby.peerId) continue;
                this.webrtc.connect(peer.peerId, /* amInitiator */ true).catch(() => {});
            }
        } else {
            // I'm a non-host — ensure there's a connection to the new host.
            this.webrtc.connect(newHostPeerId, /* amInitiator */ false).catch(() => {});
        }

        this._lastProcessedInputSeqByPeer = {};
        for (const cb of this._rosterListeners) cb(this._currentRoster);
    }

    private handleLobbyClosed(reason: string): void {
        this._currentRoster = null;
        this._isHost = false;
        this.webrtc.disconnectAll();
        for (const cb of this._rosterListeners) cb(null);
        this.setPhase('browsing');
        this.fireError(reason ? `Lobby closed: ${reason}` : 'Lobby closed');
    }

    private handleKicked(reason: string): void {
        this._currentRoster = null;
        this._isHost = false;
        this.webrtc.disconnectAll();
        for (const cb of this._rosterListeners) cb(null);
        this.setPhase('browsing');
        this.fireError(reason);
    }

    private handleDisconnect(): void {
        if (this._phase === 'disconnected') return;
        this.webrtc.disconnectAll();
        this._currentRoster = null;
        this._isHost = false;
        this.setPhase('disconnected');
    }

    // -- Host-side: spawn/despawn authoring (called by game scripts) --------

    spawnEntity(info: { networkId: number; prefab: string; owner: PeerId | '';
        pos: [number, number, number]; rot: [number, number, number, number] }): void {
        if (!this._isHost) return;
        this.webrtc.broadcast({ t: 'spawn', ...info });
    }

    despawnEntity(networkId: number): void {
        if (!this._isHost) return;
        this.webrtc.broadcast({ t: 'despawn', id: networkId });
    }

    // -- Helpers -----------------------------------------------------------

    private setPhase(phase: SessionPhase): void {
        if (this._phase === phase) return;
        this._phase = phase;
        if (phase !== 'in_game') {
            this._simAccumulator = 0;
            this._simTick = 0;
            this._inputSeq = 0;
            this._inputBuffer = [];
        }
        for (const cb of this._phaseListeners) cb(phase);
    }

    private fireError(message: string): void {
        for (const cb of this._errorListeners) cb(message);
    }

    private pushChat(msg: ChatMessage): void {
        this._chatHistory.push(msg);
        if (this._chatHistory.length > CHAT_HISTORY_LIMIT) this._chatHistory.shift();
        for (const cb of this._chatListeners) cb(msg);
    }
}
