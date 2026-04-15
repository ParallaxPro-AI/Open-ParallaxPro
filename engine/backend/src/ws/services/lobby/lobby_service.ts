/**
 * In-memory lobby registry for peer-to-peer multiplayer games.
 *
 * The backend is a signaling-only server: it never sees gameplay traffic.
 * Its jobs are (a) listing lobbies per game template, (b) routing SDP/ICE
 * between peers so WebRTC PeerConnections can establish, and (c) tracking
 * who the host is so clients know whose data-channel to connect to.
 *
 * Everything here is ephemeral. A server restart drops all lobbies.
 */

import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';
import { estimatePingMs } from './geoip.js';

export type PeerId = string;
export type LobbyId = string;

export interface Peer {
    peerId: PeerId;
    username: string;
    userId: number | null;
    ws: WebSocket;
    lobbyId: LobbyId | null;
    joinedAt: number;
    isReady: boolean;
    lastSignalAt: number;
    signalCount: number;
    ip: string;
}

export interface Lobby {
    id: LobbyId;
    gameTemplateId: string;
    name: string;
    hostPeerId: PeerId;
    maxPlayers: number;
    minPlayers: number;
    password: string | null;
    peers: Map<PeerId, Peer>;
    createdAt: number;
    state: 'waiting' | 'playing';
    /**
     * When true, new peers can join this lobby after the host has
     * marked it `playing`. Competitive games keep this off (default)
     * so players can't drop in mid-match; open-world / social games
     * set it on so peers come and go freely. Stored on the lobby so
     * the server can reject illegal joins without trusting the client.
     */
    allowJoinInProgress: boolean;
}

export interface LobbyListEntry {
    id: LobbyId;
    name: string;
    hostUsername: string;
    playerCount: number;
    maxPlayers: number;
    minPlayers: number;
    hasPassword: boolean;
    state: 'waiting' | 'playing';
    /** Surface for the browser so "Join" can stay enabled on a playing
     *  lobby when the game allows late joiners. */
    allowJoinInProgress: boolean;
    createdAt: number;
    /** Estimated P2P RTT in ms (GeoIP great-circle distance + baseline).
     *  -1 when one side has no known geolocation. */
    estimatedPingMs?: number;
}

const MAX_LOBBIES_PER_TEMPLATE = 200;
const MAX_ROOMS_CREATED_PER_IP_PER_MIN = 3;
const MAX_SIGNAL_MSGS_PER_SEC = 50;
const MAX_NAME_LENGTH = 64;
const MAX_USERNAME_LENGTH = 32;
const LOBBY_CAP = 16;
const LOBBY_MIN = 1;

const lobbies = new Map<LobbyId, Lobby>();
const peersById = new Map<PeerId, Peer>();
const roomCreationHits = new Map<string, { count: number; resetAt: number }>();

export function sanitizeName(raw: unknown, max: number): string {
    if (typeof raw !== 'string') return '';
    return raw
        .replace(/[\r\n\t\0]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

export function canCreateLobby(ip: string): boolean {
    const now = Date.now();
    const entry = roomCreationHits.get(ip);
    if (!entry || now > entry.resetAt) {
        roomCreationHits.set(ip, { count: 1, resetAt: now + 60_000 });
        return true;
    }
    if (entry.count >= MAX_ROOMS_CREATED_PER_IP_PER_MIN) return false;
    entry.count++;
    return true;
}

export function registerPeer(ws: WebSocket, username: string, userId: number | null, ip: string): Peer {
    const peerId = randomUUID();
    const peer: Peer = {
        peerId,
        username: sanitizeName(username, MAX_USERNAME_LENGTH) || `guest-${peerId.slice(0, 6)}`,
        userId,
        ws,
        lobbyId: null,
        joinedAt: Date.now(),
        isReady: false,
        lastSignalAt: 0,
        signalCount: 0,
        ip,
    };
    peersById.set(peerId, peer);
    return peer;
}

export function unregisterPeer(peerId: PeerId): void {
    const peer = peersById.get(peerId);
    if (!peer) return;
    if (peer.lobbyId) leaveLobby(peerId);
    peersById.delete(peerId);
}

export function getPeer(peerId: PeerId): Peer | undefined {
    return peersById.get(peerId);
}

export function getLobby(lobbyId: LobbyId): Lobby | null {
    return lobbies.get(lobbyId) ?? null;
}

export function createLobby(
    hostPeerId: PeerId,
    gameTemplateId: string,
    rawName: string,
    rawMaxPlayers: number,
    rawMinPlayers: number,
    password: string | null,
    allowJoinInProgress: boolean = false,
): { ok: true; lobby: Lobby } | { ok: false; error: string } {
    const host = peersById.get(hostPeerId);
    if (!host) return { ok: false, error: 'Unknown peer' };
    if (host.lobbyId) return { ok: false, error: 'Already in a lobby' };

    if (!canCreateLobby(host.ip)) {
        return { ok: false, error: 'Too many lobbies created recently. Try again in a minute.' };
    }

    const templateId = sanitizeName(gameTemplateId, 128);
    if (!templateId) return { ok: false, error: 'Missing game template id' };

    const countForTemplate = countLobbiesForTemplate(templateId);
    if (countForTemplate >= MAX_LOBBIES_PER_TEMPLATE) {
        return { ok: false, error: 'Too many active lobbies for this game. Try again later.' };
    }

    const name = sanitizeName(rawName, MAX_NAME_LENGTH) || `${host.username}'s game`;

    const maxPlayers = Math.max(LOBBY_MIN, Math.min(LOBBY_CAP, Math.floor(Number(rawMaxPlayers) || 0) || 2));
    const minPlayers = Math.max(LOBBY_MIN, Math.min(maxPlayers, Math.floor(Number(rawMinPlayers) || 0) || 1));
    const pwd = typeof password === 'string' && password.length > 0
        ? password.slice(0, 64)
        : null;

    const lobby: Lobby = {
        id: randomUUID(),
        gameTemplateId: templateId,
        name,
        hostPeerId,
        maxPlayers,
        minPlayers,
        password: pwd,
        peers: new Map([[hostPeerId, host]]),
        createdAt: Date.now(),
        state: 'waiting',
        allowJoinInProgress: !!allowJoinInProgress,
    };

    host.lobbyId = lobby.id;
    host.isReady = false;
    lobbies.set(lobby.id, lobby);
    return { ok: true, lobby };
}

export function joinLobby(
    peerId: PeerId,
    lobbyId: LobbyId,
    password: string | null,
): { ok: true; lobby: Lobby } | { ok: false; error: string } {
    const peer = peersById.get(peerId);
    if (!peer) return { ok: false, error: 'Unknown peer' };
    if (peer.lobbyId) return { ok: false, error: 'Already in a lobby' };

    const lobby = lobbies.get(lobbyId);
    if (!lobby) return { ok: false, error: 'Lobby not found' };

    if (lobby.state === 'playing' && !lobby.allowJoinInProgress) {
        return { ok: false, error: 'Match already in progress' };
    }
    if (lobby.peers.size >= lobby.maxPlayers) return { ok: false, error: 'Lobby is full' };
    if (lobby.password !== null) {
        if (typeof password !== 'string' || !constantTimeEqual(password, lobby.password)) {
            return { ok: false, error: 'Wrong password' };
        }
    }

    lobby.peers.set(peerId, peer);
    peer.lobbyId = lobby.id;
    peer.isReady = false;
    return { ok: true, lobby };
}

export function leaveLobby(peerId: PeerId): {
    closedLobby: Lobby | null;
    affected: Lobby | null;
    newHost: Peer | null;
} {
    const peer = peersById.get(peerId);
    if (!peer || !peer.lobbyId) return { closedLobby: null, affected: null, newHost: null };

    const lobby = lobbies.get(peer.lobbyId);
    peer.lobbyId = null;
    peer.isReady = false;
    if (!lobby) return { closedLobby: null, affected: null, newHost: null };

    lobby.peers.delete(peerId);

    // Empty → close.
    if (lobby.peers.size === 0) {
        lobbies.delete(lobby.id);
        return { closedLobby: lobby, affected: null, newHost: null };
    }

    // Host migration: if the leaver was the host, promote a random remaining
    // peer so the lobby stays open. Selection is uniformly random — no
    // priority order — per product spec.
    let newHost: Peer | null = null;
    if (peerId === lobby.hostPeerId) {
        const remaining = Array.from(lobby.peers.values());
        newHost = remaining[Math.floor(Math.random() * remaining.length)];
        lobby.hostPeerId = newHost.peerId;
    }
    return { closedLobby: null, affected: lobby, newHost };
}

export function listLobbies(gameTemplateId: string, requesterIp?: string): LobbyListEntry[] {
    const id = sanitizeName(gameTemplateId, 128);
    const out: LobbyListEntry[] = [];
    for (const lobby of lobbies.values()) {
        if (lobby.gameTemplateId !== id) continue;
        const host = peersById.get(lobby.hostPeerId);
        out.push({
            id: lobby.id,
            name: lobby.name,
            hostUsername: host?.username ?? 'unknown',
            playerCount: lobby.peers.size,
            maxPlayers: lobby.maxPlayers,
            minPlayers: lobby.minPlayers,
            hasPassword: lobby.password !== null,
            state: lobby.state,
            allowJoinInProgress: lobby.allowJoinInProgress,
            createdAt: lobby.createdAt,
            estimatedPingMs: requesterIp && host?.ip
                ? estimatePingMs(requesterIp, host.ip)
                : -1,
        });
    }
    // Default order: games in progress last, then fuller lobbies first,
    // then newest first. Client re-sorts by measured ping if desired.
    out.sort((a, b) => {
        if (a.state !== b.state) return a.state === 'waiting' ? -1 : 1;
        if (a.playerCount !== b.playerCount) return b.playerCount - a.playerCount;
        return b.createdAt - a.createdAt;
    });
    return out;
}

export function markLobbyPlaying(lobbyId: LobbyId): void {
    const lobby = lobbies.get(lobbyId);
    if (lobby) lobby.state = 'playing';
}

/**
 * Host-only: return the lobby to the 'waiting' state and clear every
 * peer's isReady flag so the next round can be restarted cleanly.
 * Called when a match ends (from deathmatch/coin-grab-style games that
 * have an explicit end condition). Returns false for non-host callers
 * so the WS handler can reject them.
 */
export function endMatch(hostPeerId: PeerId, lobbyId: LobbyId): { ok: true; lobby: Lobby } | { ok: false; error: string } {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return { ok: false, error: 'Lobby not found' };
    if (lobby.hostPeerId !== hostPeerId) return { ok: false, error: 'Only the host can end the match' };
    lobby.state = 'waiting';
    for (const peer of lobby.peers.values()) peer.isReady = false;
    return { ok: true, lobby };
}

export function checkSignalRate(peer: Peer): boolean {
    const now = Date.now();
    if (now - peer.lastSignalAt >= 1000) {
        peer.lastSignalAt = now;
        peer.signalCount = 1;
        return true;
    }
    peer.signalCount++;
    return peer.signalCount <= MAX_SIGNAL_MSGS_PER_SEC;
}

function countLobbiesForTemplate(templateId: string): number {
    let count = 0;
    for (const lobby of lobbies.values()) {
        if (lobby.gameTemplateId === templateId) count++;
    }
    return count;
}

function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of roomCreationHits) {
        if (now > entry.resetAt) roomCreationHits.delete(ip);
    }
}, 60_000);
