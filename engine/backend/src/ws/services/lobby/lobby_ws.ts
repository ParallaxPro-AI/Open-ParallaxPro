/**
 * WebSocket server for lobby discovery and WebRTC signaling.
 *
 * Message types (client ⇄ server):
 *   lobby.hello          — first message; client may provide ticket or
 *                          anonymous username. Server replies with hello_ack
 *                          that carries the peer id.
 *   lobby.list           — request lobbies for a given gameTemplateId.
 *   lobby.list_result    — server response to list.
 *   lobby.create         — host a new lobby.
 *   lobby.created        — sent to creator on success.
 *   lobby.join           — join an existing lobby by id, with optional password.
 *   lobby.joined         — sent to the joiner. Carries the full roster so the
 *                          joiner can immediately open a PeerConnection to the
 *                          host (and host can receive offers for all peers).
 *   lobby.peer_joined    — broadcast to existing lobby members when a new peer joins.
 *   lobby.peer_left      — broadcast when someone leaves.
 *   lobby.closed         — broadcast when host leaves or disconnects.
 *   lobby.leave          — client asks to leave current lobby.
 *   lobby.signal         — routed SDP/ICE blob between peers (see signaling.ts).
 *   lobby.ready          — toggle ready flag in lobby.
 *   lobby.start          — host-only: transition lobby into 'playing' state.
 *   lobby.started        — broadcast when game starts.
 *   lobby.kick           — host-only: kick a peer.
 *   lobby.kicked         — sent to the kicked peer before the server closes its lobby membership.
 *   lobby.ping_host      — client measures RTT to a lobby host via the signaling server.
 *   lobby.ping_result    — response with RTT.
 *   lobby.error          — any error.
 */

import type { WebSocket, WebSocketServer } from 'ws';
import { URL } from 'url';
import { verifyToken } from '../../../middleware/auth.js';
import { consumeWsTicket } from '../../ws_tickets.js';
import { relaySignal, type SignalPayload } from './signaling.js';
import {
    registerPeer,
    unregisterPeer,
    getPeer,
    getLobby,
    createLobby,
    joinLobby,
    leaveLobby,
    listLobbies,
    markLobbyPlaying,
    checkSignalRate,
    sanitizeName,
    type Lobby,
    type Peer,
    type PeerId,
} from './lobby_service.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

function send(ws: WebSocket, type: string, data: any): void {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify({ type, data })); } catch { /* socket died */ }
}

function sendError(ws: WebSocket, message: string, code?: string): void {
    send(ws, 'lobby.error', { message, code });
}

function broadcast(lobby: Lobby, type: string, data: any, exceptPeerId?: PeerId): void {
    for (const peer of lobby.peers.values()) {
        if (exceptPeerId && peer.peerId === exceptPeerId) continue;
        send(peer.ws, type, data);
    }
}

function rosterPayload(lobby: Lobby) {
    const peers = [];
    for (const peer of lobby.peers.values()) {
        peers.push({
            peerId: peer.peerId,
            username: peer.username,
            isReady: peer.isReady,
            isHost: peer.peerId === lobby.hostPeerId,
        });
    }
    return {
        lobbyId: lobby.id,
        name: lobby.name,
        gameTemplateId: lobby.gameTemplateId,
        hostPeerId: lobby.hostPeerId,
        maxPlayers: lobby.maxPlayers,
        minPlayers: lobby.minPlayers,
        state: lobby.state,
        peers,
    };
}

export function setupLobbyWebSocket(wss: WebSocketServer): void {
    wss.on('connection', (ws, req) => {
        const url = new URL(req.url ?? '', 'http://localhost');
        const ticket = url.searchParams.get('ticket') ?? '';
        const token = url.searchParams.get('token') ?? '';
        const rawName = url.searchParams.get('name') ?? '';

        let username = sanitizeName(rawName, 32);
        let userId: number | null = null;

        if (ticket) {
            const t = consumeWsTicket(ticket);
            if (t) { username = t.user.username || username; userId = t.user.id; }
        } else if (token) {
            const u = verifyToken(token);
            if (u) { username = u.username || username; userId = u.id; }
        }

        if (!username) username = `guest-${Math.random().toString(36).slice(2, 8)}`;

        const ip =
            (req.headers['x-real-ip'] as string) ||
            (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
            req.socket.remoteAddress ||
            'unknown';

        const peer = registerPeer(ws, username, userId, ip);
        send(ws, 'lobby.hello_ack', { peerId: peer.peerId, username: peer.username });

        const heartbeat = setInterval(() => {
            if (ws.readyState === ws.OPEN) ws.ping();
        }, HEARTBEAT_INTERVAL_MS);

        ws.on('message', (raw) => {
            let msg: { type: string; data: any };
            try {
                const str = raw.toString();
                if (str.length > 64 * 1024) { sendError(ws, 'Message too large'); return; }
                msg = JSON.parse(str);
            } catch {
                sendError(ws, 'Invalid JSON');
                return;
            }
            handleMessage(peer, msg.type, msg.data);
        });

        ws.on('close', () => {
            clearInterval(heartbeat);
            const leavingLobby = peer.lobbyId;
            const { closedLobby, affected } = leaveLobby(peer.peerId);
            if (closedLobby) {
                broadcast(closedLobby, 'lobby.closed', { lobbyId: closedLobby.id, reason: 'host_left' });
            } else if (affected) {
                broadcast(affected, 'lobby.peer_left', { peerId: peer.peerId });
            }
            unregisterPeer(peer.peerId);
            void leavingLobby;
        });

        ws.on('error', () => { /* handled by close */ });
    });
}

function handleMessage(peer: Peer, type: string, data: any): void {
    switch (type) {
        case 'lobby.list': {
            const gameTemplateId = typeof data?.gameTemplateId === 'string' ? data.gameTemplateId : '';
            const lobbies = listLobbies(gameTemplateId);
            send(peer.ws, 'lobby.list_result', { gameTemplateId, lobbies });
            return;
        }

        case 'lobby.create': {
            const res = createLobby(
                peer.peerId,
                String(data?.gameTemplateId ?? ''),
                String(data?.name ?? ''),
                Number(data?.maxPlayers ?? 0),
                Number(data?.minPlayers ?? 0),
                typeof data?.password === 'string' ? data.password : null,
            );
            if (!res.ok) { sendError(peer.ws, res.error); return; }
            send(peer.ws, 'lobby.created', rosterPayload(res.lobby));
            return;
        }

        case 'lobby.join': {
            const res = joinLobby(
                peer.peerId,
                String(data?.lobbyId ?? ''),
                typeof data?.password === 'string' ? data.password : null,
            );
            if (!res.ok) { sendError(peer.ws, res.error); return; }
            send(peer.ws, 'lobby.joined', rosterPayload(res.lobby));
            broadcast(res.lobby, 'lobby.peer_joined', {
                peerId: peer.peerId,
                username: peer.username,
                isReady: false,
                isHost: false,
            }, peer.peerId);
            return;
        }

        case 'lobby.leave': {
            const { closedLobby, affected } = leaveLobby(peer.peerId);
            if (closedLobby) {
                broadcast(closedLobby, 'lobby.closed', { lobbyId: closedLobby.id, reason: 'host_left' });
            } else if (affected) {
                broadcast(affected, 'lobby.peer_left', { peerId: peer.peerId });
            }
            send(peer.ws, 'lobby.left', {});
            return;
        }

        case 'lobby.signal': {
            if (!checkSignalRate(peer)) { sendError(peer.ws, 'Signaling rate limit exceeded'); return; }
            const toPeerId: string = typeof data?.toPeerId === 'string' ? data.toPeerId : '';
            const payload: SignalPayload = data?.payload;
            if (!toPeerId || !payload) return;

            const target = getPeer(toPeerId);
            if (!target || !target.lobbyId || target.lobbyId !== peer.lobbyId) {
                sendError(peer.ws, 'Target peer not reachable');
                return;
            }
            relaySignal(peer, target, payload);
            return;
        }

        case 'lobby.ready': {
            if (!peer.lobbyId) return;
            peer.isReady = !!data?.ready;
            // Broadcast to lobby
            const lobby = _lookupLobby(peer);
            if (lobby) broadcast(lobby, 'lobby.peer_ready', { peerId: peer.peerId, isReady: peer.isReady });
            return;
        }

        case 'lobby.start': {
            if (!peer.lobbyId) return;
            const lobby = _lookupLobby(peer);
            if (!lobby || lobby.hostPeerId !== peer.peerId) {
                sendError(peer.ws, 'Only the host can start the game');
                return;
            }
            if (lobby.peers.size < lobby.minPlayers) {
                sendError(peer.ws, `Need at least ${lobby.minPlayers} players to start`);
                return;
            }
            markLobbyPlaying(lobby.id);
            broadcast(lobby, 'lobby.started', { lobbyId: lobby.id });
            return;
        }

        case 'lobby.kick': {
            if (!peer.lobbyId) return;
            const lobby = _lookupLobby(peer);
            if (!lobby || lobby.hostPeerId !== peer.peerId) {
                sendError(peer.ws, 'Only the host can kick players');
                return;
            }
            const targetId: string = typeof data?.peerId === 'string' ? data.peerId : '';
            if (!targetId || targetId === lobby.hostPeerId) return;
            const target = getPeer(targetId);
            if (!target || target.lobbyId !== lobby.id) return;
            send(target.ws, 'lobby.kicked', { reason: data?.reason ?? 'Kicked by host' });
            const { affected } = leaveLobby(target.peerId);
            if (affected) broadcast(affected, 'lobby.peer_left', { peerId: target.peerId });
            return;
        }

        case 'lobby.ping_host': {
            const lobbyId: string = typeof data?.lobbyId === 'string' ? data.lobbyId : '';
            const clientTs: number = typeof data?.clientTs === 'number' ? data.clientTs : 0;
            if (!lobbyId || !clientTs) return;
            const lobby = getLobby(lobbyId);
            if (!lobby) { sendError(peer.ws, 'Lobby not found'); return; }
            const host = getPeer(lobby.hostPeerId);
            if (!host) { sendError(peer.ws, 'Host unreachable'); return; }
            send(host.ws, 'lobby.ping_request', { fromPeerId: peer.peerId, clientTs });
            return;
        }

        case 'lobby.ping_response': {
            const toPeerId: string = typeof data?.toPeerId === 'string' ? data.toPeerId : '';
            const clientTs: number = typeof data?.clientTs === 'number' ? data.clientTs : 0;
            if (!toPeerId || !clientTs) return;
            const target = getPeer(toPeerId);
            if (!target) return;
            send(target.ws, 'lobby.ping_result', {
                hostPeerId: peer.peerId,
                clientTs,
            });
            return;
        }

        default:
            sendError(peer.ws, `Unknown message type: ${type}`);
    }
}

function _lookupLobby(peer: Peer): Lobby | null {
    if (!peer.lobbyId) return null;
    return getLobby(peer.lobbyId);
}
