/**
 * Runtime WebRTC manager for peer-to-peer multiplayer games.
 *
 * Topology assumed by MultiplayerSession is a star: one host, N clients.
 * This manager is intentionally topology-agnostic — it just tracks a set of
 * peers keyed by peerId and exposes send/broadcast primitives. The session
 * decides who connects to whom.
 *
 * Data channel is unreliable/unordered (maxRetransmits: 0, ordered: false)
 * so lost snapshots cause a single frame of interpolation rather than a
 * retransmit storm. JSON message framing keeps v0.1 simple; binary packing
 * can replace the JSON.stringify calls without touching the rest of the
 * runtime.
 *
 * Voice is attached as a separate optional RTCRtpTransceiver on the same
 * PeerConnection so we don't pay a second STUN dance for audio. The host's
 * mic goes to everyone, each client's mic goes to the host, and the host
 * forwards mixed audio downstream via a separate 'voice' data channel tag
 * when needed (simplified: each peer sends its own stream to the host;
 * host fans it out as outgoing tracks on every other peer connection).
 */

const RTC_CONFIG: RTCConfiguration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Free public TURN (OpenRelay / metered.ca). Required so peers
        // behind symmetric NATs or strict corporate firewalls — where
        // STUN alone fails — can still relay through. UDP first, then
        // TCP fallbacks (443 specifically slips through almost
        // everything since it looks like HTTPS to firewalls).
        // Long-term replace with a self-hosted coturn for reliability.
        { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
};

const DATA_CHANNEL_LABEL = 'gamedata';
const CONNECT_TIMEOUT_MS = 15_000;

export type PeerId = string;

export type RTCMessage =
    | { t: 'snap'; [k: string]: any }
    | { t: 'in';   [k: string]: any }
    | { t: 'ev';   [k: string]: any }
    | { t: 'spawn' | 'despawn' | 'full'; [k: string]: any }
    | { t: 'ping'; id: number; tsMs: number }
    | { t: 'pong'; id: number; tsMs: number }
    | { t: 'chat'; from: string; body: string; tsMs: number }
    | { t: string; [k: string]: any };

interface PeerInfo {
    peerId: PeerId;
    connection: RTCPeerConnection;
    channel: RTCDataChannel | null;
    ready: boolean;
    isInitiator: boolean;
    pendingIce: RTCIceCandidateInit[];
    remoteDescSet: boolean;
    connectionTimeout: ReturnType<typeof setTimeout> | null;
    // Voice bits
    remoteAudioStream: MediaStream | null;
    outgoingAudioSender: RTCRtpSender | null;
    /**
     * Pre-created sendrecv audio transceiver. Reserving it at connect time
     * means we can enable/disable the mic later via sender.replaceTrack()
     * without triggering an SDP renegotiation round-trip.
     */
    audioTransceiver: RTCRtpTransceiver | null;
}

export interface WebRTCEvents {
    onReady?: (peerId: PeerId) => void;
    onClose?: (peerId: PeerId) => void;
    onMessage?: (peerId: PeerId, msg: RTCMessage) => void;
    onRemoteAudio?: (peerId: PeerId, stream: MediaStream) => void;
}

export class WebRTCManager {
    private peers: Map<PeerId, PeerInfo> = new Map();
    private localPeerId: PeerId = '';
    private sendSignal: (toPeerId: PeerId, payload: { kind: string; [k: string]: any }) => void = () => {};
    private events: WebRTCEvents = {};
    private localAudioTrack: MediaStreamTrack | null = null;
    private dynamicIceServers: RTCIceServer[] | null = null;

    /**
     * Replace the default STUN+OpenRelay TURN list with server-issued
     * ICE servers (typically Cloudflare ephemeral TURN). Affects only
     * peer connections opened AFTER this call. Existing connections
     * keep their current ICE config — they're already negotiated.
     */
    setIceServers(servers: RTCIceServer[] | null): void {
        this.dynamicIceServers = (servers && servers.length > 0) ? servers : null;
    }

    initialize(
        localPeerId: PeerId,
        sendSignal: (toPeerId: PeerId, payload: { kind: string; [k: string]: any }) => void,
        events: WebRTCEvents,
    ): void {
        this.localPeerId = localPeerId;
        this.sendSignal = sendSignal;
        this.events = events;
    }

    /**
     * Open a connection to a peer. `amInitiator` decides who drives the
     * offer. In a star topology the host is typically the initiator for
     * every client; this keeps the offer/answer flow symmetric and
     * removes the "both sides glare" problem.
     */
    async connect(peerId: PeerId, amInitiator: boolean): Promise<void> {
        if (this.peers.has(peerId)) return;

        // Prefer dynamic (server-issued) ICE servers when present; they
        // override the bundled STUN+OpenRelay defaults. STUN entries from
        // the default list still get merged in for direct-path discovery.
        const config: RTCConfiguration = this.dynamicIceServers
            ? { iceServers: [
                  ...RTC_CONFIG.iceServers!.filter(s => {
                      const u = Array.isArray(s.urls) ? s.urls[0] : s.urls;
                      return typeof u === 'string' && u.startsWith('stun:');
                  }),
                  ...this.dynamicIceServers,
              ] }
            : RTC_CONFIG;
        const pc = new RTCPeerConnection(config);
        const info: PeerInfo = {
            peerId,
            connection: pc,
            channel: null,
            ready: false,
            isInitiator: amInitiator,
            pendingIce: [],
            remoteDescSet: false,
            connectionTimeout: null,
            remoteAudioStream: null,
            outgoingAudioSender: null,
            audioTransceiver: null,
        };
        this.peers.set(peerId, info);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.sendSignal(peerId, { kind: 'ice', candidate: e.candidate.toJSON() });
            }
        };

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                this.teardown(peerId);
            }
        };

        // Renegotiation safety net: fires when the set of transceivers
        // changes in a way that needs a new SDP exchange (e.g. the fallback
        // addTrack path in attachLocalAudio). The initial offer/answer is
        // driven manually below so we gate on `ready`.
        pc.onnegotiationneeded = async () => {
            if (!info.ready) return;
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                this.sendSignal(peerId, { kind: 'offer', sdp: offer });
            } catch (e) {
                console.warn('[WebRTC] renegotiation failed', e);
            }
        };

        pc.ontrack = (e) => {
            if (e.streams.length > 0) {
                info.remoteAudioStream = e.streams[0];
            } else {
                info.remoteAudioStream = new MediaStream([e.track]);
            }
            this.events.onRemoteAudio?.(peerId, info.remoteAudioStream);
        };

        // Always add a transceiver so voice can be toggled later via
        // sender.replaceTrack() without renegotiating the PeerConnection.
        try {
            info.audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
        } catch { /* not supported, voice disabled for this peer */ }

        if (amInitiator) {
            const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, {
                ordered: false,
                maxRetransmits: 0,
            });
            this.attachChannel(info, channel);
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                this.sendSignal(peerId, { kind: 'offer', sdp: offer });
            } catch (e) {
                console.warn('[WebRTC] createOffer failed', e);
                this.teardown(peerId);
                return;
            }
        } else {
            pc.ondatachannel = (e) => this.attachChannel(info, e.channel);
        }

        info.connectionTimeout = setTimeout(() => {
            if (!info.ready) {
                console.warn(`[WebRTC] Peer ${peerId} connect timeout`);
                this.teardown(peerId);
            }
        }, CONNECT_TIMEOUT_MS);

        if (this.localAudioTrack) {
            this.attachLocalAudio(info);
        }
    }

    async handleSignal(fromPeerId: PeerId, payload: { kind: string; sdp?: any; candidate?: any }): Promise<void> {
        let info = this.peers.get(fromPeerId);
        if (!info) {
            // Answering side: we had no idea this peer existed yet.
            if (payload.kind !== 'offer') return;
            await this.connect(fromPeerId, /* amInitiator */ false);
            info = this.peers.get(fromPeerId);
            if (!info) return;
        }

        try {
            if (payload.kind === 'offer' && payload.sdp) {
                await info.connection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
                info.remoteDescSet = true;
                await this.drainPendingIce(info);
                const answer = await info.connection.createAnswer();
                await info.connection.setLocalDescription(answer);
                this.sendSignal(fromPeerId, { kind: 'answer', sdp: answer });
            } else if (payload.kind === 'answer' && payload.sdp) {
                await info.connection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
                info.remoteDescSet = true;
                await this.drainPendingIce(info);
            } else if (payload.kind === 'ice' && payload.candidate) {
                if (info.remoteDescSet) {
                    await info.connection.addIceCandidate(new RTCIceCandidate(payload.candidate));
                } else {
                    info.pendingIce.push(payload.candidate);
                }
            }
        } catch (e) {
            console.warn('[WebRTC] handleSignal error', payload.kind, e);
        }
    }

    send(peerId: PeerId, msg: RTCMessage): boolean {
        const info = this.peers.get(peerId);
        if (!info || !info.ready || !info.channel) return false;
        if (info.channel.readyState !== 'open') return false;
        try { info.channel.send(JSON.stringify(msg)); return true; } catch { return false; }
    }

    broadcast(msg: RTCMessage, exceptPeerId?: PeerId): number {
        const str = JSON.stringify(msg);
        let sent = 0;
        for (const info of this.peers.values()) {
            if (exceptPeerId && info.peerId === exceptPeerId) continue;
            if (!info.ready || !info.channel || info.channel.readyState !== 'open') continue;
            try { info.channel.send(str); sent++; } catch { /* ignored */ }
        }
        return sent;
    }

    getPeerIds(): PeerId[] {
        return Array.from(this.peers.keys());
    }

    isReady(peerId: PeerId): boolean {
        return !!this.peers.get(peerId)?.ready;
    }

    disconnect(peerId: PeerId): void {
        this.teardown(peerId);
    }

    disconnectAll(): void {
        for (const id of Array.from(this.peers.keys())) this.teardown(id);
        this.localAudioTrack = null;
    }

    // -- Voice --------------------------------------------------------------

    async enableLocalMic(): Promise<boolean> {
        if (this.localAudioTrack) return true;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false,
            });
            this.localAudioTrack = stream.getAudioTracks()[0] ?? null;
            if (!this.localAudioTrack) return false;
            for (const info of this.peers.values()) this.attachLocalAudio(info);
            return true;
        } catch (e) {
            console.warn('[WebRTC] mic permission denied or unavailable', e);
            return false;
        }
    }

    disableLocalMic(): void {
        if (!this.localAudioTrack) return;
        this.localAudioTrack.stop();
        this.localAudioTrack = null;
        for (const info of this.peers.values()) {
            if (info.outgoingAudioSender) {
                try { info.outgoingAudioSender.replaceTrack(null); } catch { /* ignored */ }
            }
        }
    }

    setLocalMuted(muted: boolean): void {
        if (!this.localAudioTrack) return;
        this.localAudioTrack.enabled = !muted;
    }

    hasLocalMic(): boolean { return !!this.localAudioTrack; }

    getLocalAudioTrack(): MediaStreamTrack | null { return this.localAudioTrack; }

    getRemoteAudioStream(peerId: PeerId): MediaStream | null {
        return this.peers.get(peerId)?.remoteAudioStream ?? null;
    }

    private attachLocalAudio(info: PeerInfo): void {
        if (!this.localAudioTrack) return;

        // Already bound — just swap the track.
        if (info.outgoingAudioSender) {
            try { info.outgoingAudioSender.replaceTrack(this.localAudioTrack); } catch (e) {
                console.warn('[WebRTC] replaceTrack failed', e);
            }
            return;
        }

        // Preferred: use the sendrecv transceiver reserved at connect time.
        // sender.replaceTrack() on an existing transceiver does NOT require
        // an SDP renegotiation, so enabling mic post-connect just works.
        if (info.audioTransceiver) {
            try {
                info.audioTransceiver.sender.replaceTrack(this.localAudioTrack);
                info.outgoingAudioSender = info.audioTransceiver.sender;
                return;
            } catch (e) {
                console.warn('[WebRTC] transceiver replaceTrack failed, falling back to addTrack', e);
            }
        }

        // Fallback: add a new track. Triggers onnegotiationneeded which we
        // handle below to renegotiate automatically.
        try {
            const sender = info.connection.addTrack(this.localAudioTrack);
            info.outgoingAudioSender = sender;
        } catch (e) {
            console.warn('[WebRTC] addTrack failed', e);
        }
    }

    private async drainPendingIce(info: PeerInfo): Promise<void> {
        while (info.pendingIce.length > 0) {
            const c = info.pendingIce.shift()!;
            try { await info.connection.addIceCandidate(new RTCIceCandidate(c)); } catch { /* stale candidate */ }
        }
    }

    private attachChannel(info: PeerInfo, channel: RTCDataChannel): void {
        info.channel = channel;
        channel.binaryType = 'arraybuffer';

        channel.onopen = () => {
            info.ready = true;
            if (info.connectionTimeout) {
                clearTimeout(info.connectionTimeout);
                info.connectionTimeout = null;
            }
            this.events.onReady?.(info.peerId);
        };

        channel.onclose = () => {
            info.ready = false;
            this.events.onClose?.(info.peerId);
        };

        channel.onmessage = (e) => {
            try {
                const msg: RTCMessage = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
                this.events.onMessage?.(info.peerId, msg);
            } catch { /* ignore malformed */ }
        };
    }

    private teardown(peerId: PeerId): void {
        const info = this.peers.get(peerId);
        if (!info) return;
        if (info.connectionTimeout) { clearTimeout(info.connectionTimeout); info.connectionTimeout = null; }
        try { info.channel?.close(); } catch { /* ignored */ }
        try { info.connection.close(); } catch { /* ignored */ }
        this.peers.delete(peerId);
        if (info.ready) this.events.onClose?.(peerId);
    }
}
