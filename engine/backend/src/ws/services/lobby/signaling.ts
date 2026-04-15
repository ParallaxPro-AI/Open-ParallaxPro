/**
 * WebRTC signaling relay.
 *
 * Once peers are in the same lobby they need to exchange SDP offers/answers
 * and ICE candidates. The server is a dumb pipe: it only forwards a
 * whitelisted set of payload kinds, rewrites source id, and lets the peers
 * handle crypto + connectivity themselves.
 *
 * We intentionally do NOT inspect the SDP body — future protocol extensions
 * (e.g. adding data-channel options or media lines for voice) shouldn't
 * require a server update.
 */

import type { WebSocket } from 'ws';
import type { Peer } from './lobby_service.js';

export type SignalKind = 'offer' | 'answer' | 'ice';

export interface SignalPayload {
    kind: SignalKind;
    sdp?: any;
    candidate?: any;
}

const MAX_SDP_BYTES = 32 * 1024;

function byteLength(s: string): number {
    // Browsers + Node both use Buffer.byteLength semantics for utf-8
    return Buffer.byteLength(s, 'utf8');
}

export function relaySignal(from: Peer, to: Peer, payload: SignalPayload): void {
    if (!payload || typeof payload.kind !== 'string') return;

    const out: any = { kind: payload.kind };
    if (payload.kind === 'offer' || payload.kind === 'answer') {
        if (!payload.sdp) return;
        const serialized = JSON.stringify(payload.sdp);
        if (byteLength(serialized) > MAX_SDP_BYTES) return;
        out.sdp = payload.sdp;
    } else if (payload.kind === 'ice') {
        if (!payload.candidate) return;
        const serialized = JSON.stringify(payload.candidate);
        if (byteLength(serialized) > 4096) return;
        out.candidate = payload.candidate;
    } else {
        return;
    }

    sendRaw(to.ws, 'lobby.signal', { fromPeerId: from.peerId, payload: out });
}

function sendRaw(ws: WebSocket, type: string, data: any): void {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify({ type, data })); } catch { /* closed */ }
}
