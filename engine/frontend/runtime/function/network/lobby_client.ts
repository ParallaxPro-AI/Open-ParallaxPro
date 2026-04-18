/**
 * Thin WebSocket client for the backend /ws/multiplayer signaling service.
 * Wraps the JSON protocol in typed helpers and emits events for higher
 * layers (MultiplayerSession, lobby UI) to consume.
 *
 * The signaling server is NOT a game server — it only brokers lobby lists,
 * WebRTC SDP/ICE, and meta events (kick, ready, start). No gameplay data
 * flows through here.
 */

export type PeerId = string;

/**
 * Wire protocol version this client speaks. Must match the server
 * mounted at /ws/multiplayer/v{LOBBY_PROTOCOL_VERSION}. Server replies
 * with its own version on hello_ack — connect() rejects on mismatch so
 * an outdated client doesn't silently bind into an incompatible session.
 */
export const LOBBY_PROTOCOL_VERSION = 1;

export interface LobbyListEntry {
    id: string;
    name: string;
    hostUsername: string;
    playerCount: number;
    maxPlayers: number;
    minPlayers: number;
    hasPassword: boolean;
    state: 'waiting' | 'playing';
    createdAt: number;
    pingMs?: number;
}

export interface RosterPeer {
    peerId: PeerId;
    username: string;
    isReady: boolean;
    isHost: boolean;
}

export interface LobbyRoster {
    lobbyId: string;
    name: string;
    gameTemplateId: string;
    hostPeerId: PeerId;
    maxPlayers: number;
    minPlayers: number;
    state: 'waiting' | 'playing';
    peers: RosterPeer[];
}

export interface LobbyClientEvents {
    onHelloAck?: (info: { peerId: PeerId; username: string; iceServers?: RTCIceServer[] | null; protocolVersion?: number }) => void;
    onListResult?: (gameTemplateId: string, lobbies: LobbyListEntry[]) => void;
    onCreated?: (roster: LobbyRoster) => void;
    onJoined?: (roster: LobbyRoster) => void;
    onPeerJoined?: (peer: RosterPeer) => void;
    onPeerLeft?: (peerId: PeerId) => void;
    onPeerReady?: (peerId: PeerId, isReady: boolean) => void;
    onClosed?: (lobbyId: string, reason: string) => void;
    onStarted?: (lobbyId: string) => void;
    onMatchEnded?: (lobbyId: string) => void;
    onKicked?: (reason: string) => void;
    onSignal?: (fromPeerId: PeerId, payload: any) => void;
    onPingRequest?: (fromPeerId: PeerId, clientTs: number) => void;
    onPingResult?: (hostPeerId: PeerId, clientTs: number) => void;
    onHostChanged?: (newHostPeerId: PeerId, newHostUsername: string) => void;
    onError?: (message: string, code?: string) => void;
    onDisconnect?: () => void;
}

export class LobbyClient {
    private ws: WebSocket | null = null;
    private events: LobbyClientEvents = {};
    peerId: PeerId = '';
    username: string = '';
    connected: boolean = false;

    setEvents(events: LobbyClientEvents): void { this.events = events; }

    async connect(url: string): Promise<void> {
        // Retrofit auth for games published before the cross-origin move:
        // their baked-in mp_bridge only reads localStorage, which is empty
        // on the games.parallaxpro.ai origin the iframe now lives on. If
        // the wrapper page posted us a bootstrap with an mpTicket, splice
        // it into the URL here so the lobby server sees the authed
        // identity instead of dropping us to guest-XXXX.
        try {
            const bootstrap = (window as any).__ppPlayBootstrap?.();
            const ticket: string | undefined = bootstrap?.mpTicket;
            if (ticket && !/[?&]ticket=/.test(url)) {
                // Strip any empty `token=` query the old mp_bridge may
                // have appended, then add the ticket. Server prefers
                // ticket over token when both are present, but cleaning
                // the empty one up keeps the URL readable in logs.
                url = url.replace(/([?&])token=(?=&|$)/g, '$1').replace(/[?&]$/, '');
                url += (url.includes('?') ? '&' : '?') + 'ticket=' + encodeURIComponent(ticket);
            }
        } catch { /* no window / no bootstrap — fall through */ }
        return new Promise<void>((resolve, reject) => {
            let resolved = false;
            try {
                this.ws = new WebSocket(url);
            } catch (e) {
                reject(e);
                return;
            }

            const ws = this.ws;
            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    try { ws.close(); } catch { /* ignored */ }
                    reject(new Error('Lobby server connect timeout'));
                }
            }, 10_000);

            ws.onopen = () => {
                this.connected = true;
            };

            ws.onmessage = (event) => {
                let msg: { type: string; data: any };
                try { msg = JSON.parse(String(event.data)); } catch { return; }
                if (msg.type === 'lobby.hello_ack' && !resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    const serverV = Number(msg.data.protocolVersion || 0);
                    if (serverV && serverV !== LOBBY_PROTOCOL_VERSION) {
                        try { ws.close(); } catch { /* ignored */ }
                        reject(new Error(
                            `Lobby protocol mismatch: client v${LOBBY_PROTOCOL_VERSION}, server v${serverV}. ` +
                            `This game is built against an older engine — re-publish to upgrade.`
                        ));
                        return;
                    }
                    this.peerId = msg.data.peerId;
                    this.username = msg.data.username;
                    this.events.onHelloAck?.(msg.data);
                    resolve();
                    return;
                }
                this.dispatch(msg.type, msg.data);
            };

            ws.onclose = () => {
                this.connected = false;
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    reject(new Error('Lobby server connection closed before hello'));
                }
                this.events.onDisconnect?.();
            };

            ws.onerror = () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    reject(new Error('Lobby server connection error'));
                }
            };
        });
    }

    disconnect(): void {
        if (this.ws) {
            try { this.ws.close(); } catch { /* ignored */ }
            this.ws = null;
        }
        this.connected = false;
    }

    private send(type: string, data: any): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type, data }));
        }
    }

    list(gameTemplateId: string): void { this.send('lobby.list', { gameTemplateId }); }

    create(opts: {
        gameTemplateId: string;
        name: string;
        maxPlayers: number;
        minPlayers: number;
        password?: string | null;
        allowJoinInProgress?: boolean;
    }): void { this.send('lobby.create', opts); }

    join(opts: { lobbyId: string; password?: string | null }): void {
        this.send('lobby.join', opts);
    }

    leave(): void { this.send('lobby.leave', {}); }

    setReady(ready: boolean): void { this.send('lobby.ready', { ready }); }

    start(): void { this.send('lobby.start', {}); }
    endMatch(): void { this.send('lobby.end_match', {}); }

    kick(peerId: PeerId, reason?: string): void { this.send('lobby.kick', { peerId, reason }); }

    signal(toPeerId: PeerId, payload: { kind: string; [k: string]: any }): void {
        this.send('lobby.signal', { toPeerId, payload });
    }

    pingHost(lobbyId: string, clientTs: number): void {
        this.send('lobby.ping_host', { lobbyId, clientTs });
    }

    respondPing(toPeerId: PeerId, clientTs: number): void {
        this.send('lobby.ping_response', { toPeerId, clientTs });
    }

    private dispatch(type: string, data: any): void {
        switch (type) {
            case 'lobby.list_result':
                this.events.onListResult?.(data.gameTemplateId, data.lobbies);
                return;
            case 'lobby.created':
                this.events.onCreated?.(data);
                return;
            case 'lobby.joined':
                this.events.onJoined?.(data);
                return;
            case 'lobby.peer_joined':
                this.events.onPeerJoined?.(data);
                return;
            case 'lobby.peer_left':
                this.events.onPeerLeft?.(data.peerId);
                return;
            case 'lobby.peer_ready':
                this.events.onPeerReady?.(data.peerId, !!data.isReady);
                return;
            case 'lobby.closed':
                this.events.onClosed?.(data.lobbyId, data.reason || '');
                return;
            case 'lobby.started':
                this.events.onStarted?.(data.lobbyId);
                return;
            case 'lobby.match_ended':
                this.events.onMatchEnded?.(data.lobbyId);
                return;
            case 'lobby.kicked':
                this.events.onKicked?.(data.reason || 'Kicked by host');
                return;
            case 'lobby.signal':
                this.events.onSignal?.(data.fromPeerId, data.payload);
                return;
            case 'lobby.ping_request':
                this.events.onPingRequest?.(data.fromPeerId, data.clientTs);
                return;
            case 'lobby.ping_result':
                this.events.onPingResult?.(data.hostPeerId, data.clientTs);
                return;
            case 'lobby.host_changed':
                this.events.onHostChanged?.(data.newHostPeerId, data.newHostUsername || '');
                return;
            case 'lobby.error':
                this.events.onError?.(data.message || 'Unknown error', data.code);
                return;
            case 'lobby.left':
                return;
        }
    }
}
