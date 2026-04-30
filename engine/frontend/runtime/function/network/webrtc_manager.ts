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
const VOICE_RECONCILE_MS = 2000;
/**
 * Grace period before we tear down a peer whose connection went
 * 'disconnected'. That state is almost always transient on the public
 * internet — brief packet loss or a Wi-Fi handoff flips ICE into
 * disconnected and the browser's keepalive will usually pull it back
 * to 'connected' within a few seconds. Tearing down immediately (as
 * we did before) killed any cross-country / cross-continent match
 * the moment a single burst of packet loss hit, which the user saw
 * as "game goes back to main menu" mid-play.
 *
 * Only 'failed' or 'closed' are truly terminal; give 'disconnected'
 * this long to recover on its own before giving up.
 */
const DISCONNECTED_GRACE_MS = 10_000;

/**
 * Application-layer keepalive. WebRTC's `connectionState` can stay
 * on 'connected' even when the data channel has silently stalled
 * (SCTP buffer stuck, OS socket wedged, browser tab throttled in a
 * deep background), which the user experiences as "stuck, can't
 * move" — their inputs fire locally but the host never receives
 * them and never sends snapshots back.
 *
 * We don't need a new wire message for this: during lobby + in-game
 * the session's existing 1 Hz ping/pong plus the 30 Hz snap/input
 * traffic means every live peer sends *something* at least once a
 * second. Treat any peer we haven't heard from in KEEPALIVE_TIMEOUT_MS
 * as zombie and tear them down, which routes through the normal
 * onClose flow (session notices, peer leaves the roster cleanly).
 */
const KEEPALIVE_CHECK_INTERVAL_MS = 3_000;
const KEEPALIVE_TIMEOUT_MS = 15_000;

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
    /** Active grace-period timer while connectionState is 'disconnected'. */
    disconnectGraceTimer: ReturnType<typeof setTimeout> | null;
    /**
     * Wall-clock (performance.now()) of the most recent inbound data-channel
     * message, seeded to "now" at peer creation. Used by the keepalive
     * sweep to detect zombie connections whose WebRTC state still looks
     * healthy but whose data channel has stopped delivering.
     */
    lastRecvMs: number;
    // Voice bits
    remoteAudioStream: MediaStream | null;
    outgoingAudioSender: RTCRtpSender | null;
    /**
     * Pre-created sendrecv audio transceiver. Reserving it at connect time
     * means later mic toggles can ride out on sender.replaceTrack(), and
     * re-negotiation (required only on the *first* real track attach per
     * connection) uses the existing m-section.
     */
    audioTransceiver: RTCRtpTransceiver | null;
    /**
     * Set while a local offer is being generated + sent so incoming offers
     * can be detected as glare. Part of the perfect-negotiation pattern.
     */
    makingOffer: boolean;
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
    private localMuted: boolean = false;
    private dynamicIceServers: RTCIceServer[] | null = null;
    /**
     * Voice-reconcile state. Each peer periodically broadcasts its own
     * `micOn` over the data channel so everyone knows who's expected to
     * be audible. If our receive side is missing a stream from a peer
     * that claims to have mic on, we send them a `voice_missing` and
     * they re-attach + renegotiate. This loop catches bugs in SDP
     * negotiation that pointer-equality checks would miss.
     */
    private remoteMicState: Map<PeerId, boolean> = new Map();
    private voiceReconcileTimer: ReturnType<typeof setInterval> | null = null;
    private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

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
        if (this.voiceReconcileTimer) clearInterval(this.voiceReconcileTimer);
        this.voiceReconcileTimer = setInterval(() => this._voiceReconcileTick(), VOICE_RECONCILE_MS);
        if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = setInterval(() => this._keepaliveSweep(), KEEPALIVE_CHECK_INTERVAL_MS);
    }

    /**
     * Open a connection to a peer. `amInitiator` decides who drives the
     * offer. In a star topology the host is typically the initiator for
     * every client; this keeps the offer/answer flow symmetric and
     * removes the "both sides glare" problem.
     */
    async connect(peerId: PeerId, amInitiator: boolean): Promise<void> {
        console.log('[mp] webrtc.connect()', JSON.stringify({ peerId, amInitiator, hasDynIce: !!this.dynamicIceServers }));
        if (this.peers.has(peerId)) {
            console.log('[mp] webrtc.connect() — peer already exists, returning');
            return;
        }

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
        let pc: RTCPeerConnection;
        try {
            pc = new RTCPeerConnection(config);
            console.log('[mp] webrtc.connect() — RTCPeerConnection created');
        } catch (e: any) {
            console.error('[mp] webrtc.connect() — RTCPeerConnection ctor threw', e?.message || String(e));
            throw e;
        }
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
            makingOffer: false,
            disconnectGraceTimer: null,
            lastRecvMs: performance.now(),
        };
        this.peers.set(peerId, info);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.sendSignal(peerId, { kind: 'ice', candidate: e.candidate.toJSON() });
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log('[mp] webrtc iceConnectionState', JSON.stringify({ peerId, state: pc.iceConnectionState }));
        };
        pc.onicegatheringstatechange = () => {
            console.log('[mp] webrtc iceGatheringState', JSON.stringify({ peerId, state: pc.iceGatheringState }));
        };
        pc.onsignalingstatechange = () => {
            console.log('[mp] webrtc signalingState', JSON.stringify({ peerId, state: pc.signalingState }));
        };
        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            console.log('[mp] webrtc connectionState', JSON.stringify({ peerId, state }));
            if (state === 'failed' || state === 'closed') {
                if (info.disconnectGraceTimer) {
                    clearTimeout(info.disconnectGraceTimer);
                    info.disconnectGraceTimer = null;
                }
                this.teardown(peerId);
                return;
            }
            if (state === 'disconnected') {
                // Hold off — most 'disconnected' events recover on their own
                // when the next ICE keepalive arrives. Only tear down if the
                // peer is still disconnected after the grace window.
                if (info.disconnectGraceTimer) return;
                info.disconnectGraceTimer = setTimeout(() => {
                    info.disconnectGraceTimer = null;
                    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                        console.warn(`[WebRTC] Peer ${peerId} still disconnected after ${DISCONNECTED_GRACE_MS}ms — tearing down`);
                        this.teardown(peerId);
                    }
                }, DISCONNECTED_GRACE_MS);
                return;
            }
            if (state === 'connected') {
                // Recovered — cancel any pending teardown.
                if (info.disconnectGraceTimer) {
                    clearTimeout(info.disconnectGraceTimer);
                    info.disconnectGraceTimer = null;
                }
            }
        };

        // Renegotiation safety net: fires when the set of transceivers
        // changes in a way that needs a new SDP exchange (e.g. the
        // addTrack fallback in attachLocalAudio). The initial offer/answer
        // is driven manually below, so gate on `ready` to avoid racing it.
        pc.onnegotiationneeded = () => {
            if (!info.ready) return;
            void this.triggerRenegotiation(info);
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
        // sender.replaceTrack(). Even when no mic is enabled at connect
        // time, having the transceiver in the initial SDP reserves an m=
        // section for audio so later negotiations are incremental.
        try {
            info.audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
        } catch { /* not supported, voice disabled for this peer */ }

        // Attach the mic track BEFORE createOffer when we already have one,
        // so the initial SDP advertises a sending SSRC. Without this, the
        // offer goes out with no a=ssrc for the sender; the peer's ontrack
        // fires (if at all) with a stub that never receives RTP, and later
        // replaceTrack() alone does not publish a new SSRC. This is the
        // classic "late track addition" footgun — browsers disagree on
        // whether it should work and Chrome in particular needs the SDP
        // to advertise the track.
        if (this.localAudioTrack) {
            this.attachLocalAudio(info);
        }

        if (amInitiator) {
            console.log('[mp] webrtc — initiator: creating data channel + offer');
            const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, {
                ordered: false,
                maxRetransmits: 0,
            });
            this.attachChannel(info, channel);
            try {
                const offer = await pc.createOffer();
                console.log('[mp] webrtc — createOffer ok');
                await pc.setLocalDescription(offer);
                console.log('[mp] webrtc — setLocalDescription(offer) ok');
                this.sendSignal(peerId, { kind: 'offer', sdp: offer });
                console.log('[mp] webrtc — offer sent to', peerId);
            } catch (e: any) {
                console.error('[mp] webrtc — offer pipeline threw', e?.message || String(e));
                this.teardown(peerId);
                return;
            }
        } else {
            console.log('[mp] webrtc — non-initiator: awaiting datachannel from peer');
            pc.ondatachannel = (e) => {
                console.log('[mp] webrtc — datachannel arrived from', peerId);
                this.attachChannel(info, e.channel);
            };
        }

        info.connectionTimeout = setTimeout(() => {
            if (!info.ready) {
                console.warn(`[WebRTC] Peer ${peerId} connect timeout`);
                this.teardown(peerId);
            }
        }, CONNECT_TIMEOUT_MS);
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
                const pc = info.connection;
                // Perfect-negotiation glare handling: if both peers fire
                // renegotiation around the same time (e.g. each enables
                // mic), the offers cross. The polite side rolls back its
                // own offer and accepts the incoming one; the impolite
                // side ignores the incoming offer. Initiator = impolite.
                const offerCollision =
                    info.makingOffer || pc.signalingState !== 'stable';
                const polite = !info.isInitiator;
                if (offerCollision && !polite) return;
                if (offerCollision && polite) {
                    try { await (pc as any).setLocalDescription({ type: 'rollback' }); } catch { /* ignored */ }
                }
                await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
                info.remoteDescSet = true;
                await this.drainPendingIce(info);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
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
        // Releases the OS mic (stops getUserMedia tracks) and detaches
        // from any live senders before we tear them down. Silently no-ops
        // when mic was never enabled.
        this.disableLocalMic();
        for (const id of Array.from(this.peers.keys())) this.teardown(id);
        if (this.voiceReconcileTimer) {
            clearInterval(this.voiceReconcileTimer);
            this.voiceReconcileTimer = null;
        }
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
        this.remoteMicState.clear();
    }

    // -- Voice --------------------------------------------------------------

    async enableLocalMic(): Promise<boolean> {
        console.log('[mp] enableLocalMic() called', JSON.stringify({ alreadyHasTrack: !!this.localAudioTrack }));
        if (this.localAudioTrack) return true;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false,
            });
            console.log('[mp] enableLocalMic() — getUserMedia ok', JSON.stringify({ tracks: stream.getAudioTracks().length }));
            this.localAudioTrack = stream.getAudioTracks()[0] ?? null;
            if (!this.localAudioTrack) return false;
            for (const info of this.peers.values()) this.attachLocalAudio(info);
            this._broadcastVoiceState();
            return true;
        } catch (e: any) {
            console.error('[mp] enableLocalMic() — getUserMedia threw', e?.name || '?', e?.message || String(e));
            return false;
        }
    }

    disableLocalMic(): void {
        if (!this.localAudioTrack) return;
        this.localAudioTrack.stop();
        this.localAudioTrack = null;
        this.localMuted = false;
        for (const info of this.peers.values()) {
            if (info.outgoingAudioSender) {
                try { info.outgoingAudioSender.replaceTrack(null); } catch { /* ignored */ }
            }
        }
        this._broadcastVoiceState();
    }

    /**
     * Strict mute: detach the mic track from every peer's sender so no
     * RTP at all goes over the wire (not even WebRTC's silence-filler
     * packets). Belt-and-suspenders: also flip `track.enabled=false` so
     * even if a sender managed to hold onto a stale reference, the OS
     * dims the mic indicator and the track produces no samples locally.
     * Unmuting is the inverse — reattach the same track to every sender
     * (codec and SSRC were negotiated at first attach, no renegotiation
     * needed). The voice-state ping/pong re-broadcasts immediately so
     * peers know our outgoing stream went silent and don't trigger a
     * voice_missing repair that would undo the mute.
     */
    setLocalMuted(muted: boolean): void {
        if (!this.localAudioTrack) return;
        if (this.localMuted === muted) return;
        this.localMuted = muted;
        this.localAudioTrack.enabled = !muted;
        const payload = muted ? null : this.localAudioTrack;
        for (const info of this.peers.values()) {
            const sender = info.outgoingAudioSender ?? info.audioTransceiver?.sender ?? null;
            if (!sender) continue;
            try { sender.replaceTrack(payload); } catch { /* ignored */ }
        }
        this._broadcastVoiceState();
    }

    hasLocalMic(): boolean { return !!this.localAudioTrack; }

    getLocalAudioTrack(): MediaStreamTrack | null { return this.localAudioTrack; }

    getRemoteAudioStream(peerId: PeerId): MediaStream | null {
        return this.peers.get(peerId)?.remoteAudioStream ?? null;
    }

    private attachLocalAudio(info: PeerInfo): void {
        if (!this.localAudioTrack) return;

        // Already bound — just swap the track. Codec/SSRC were negotiated
        // the first time this sender went live, so swapping to a new mic
        // track doesn't need another offer/answer round.
        if (info.outgoingAudioSender) {
            try { info.outgoingAudioSender.replaceTrack(this.localAudioTrack); } catch (e) {
                console.warn('[WebRTC] replaceTrack failed', e);
            }
            return;
        }

        // First-time attach. Put the track on the pre-created transceiver's
        // sender so the next SDP round publishes an a=ssrc for us.
        if (info.audioTransceiver) {
            try {
                info.audioTransceiver.sender.replaceTrack(this.localAudioTrack);
                info.outgoingAudioSender = info.audioTransceiver.sender;
            } catch (e) {
                console.warn('[WebRTC] transceiver replaceTrack failed, falling back to addTrack', e);
                try {
                    const sender = info.connection.addTrack(this.localAudioTrack);
                    info.outgoingAudioSender = sender;
                } catch (e2) { console.warn('[WebRTC] addTrack fallback failed', e2); }
            }
        } else {
            try {
                const sender = info.connection.addTrack(this.localAudioTrack);
                info.outgoingAudioSender = sender;
            } catch (e) { console.warn('[WebRTC] addTrack failed', e); }
        }

        // If the peer is already past initial negotiation, publishing the
        // new track requires a fresh offer — replaceTrack alone doesn't
        // announce a new SSRC to the remote side and the peer's ontrack
        // never fires with a real receiver. If we're still pre-initial-
        // offer (connect() in progress before createOffer), skip: the
        // track will ride out in the first offer automatically.
        if (info.ready && info.connection.signalingState === 'stable') {
            void this.triggerRenegotiation(info);
        }
    }

    private async triggerRenegotiation(info: PeerInfo): Promise<void> {
        const pc = info.connection;
        if (pc.signalingState !== 'stable') return;
        info.makingOffer = true;
        try {
            const offer = await pc.createOffer();
            if (pc.signalingState !== 'stable') return;
            await pc.setLocalDescription(offer);
            this.sendSignal(info.peerId, { kind: 'offer', sdp: offer });
        } catch (e) {
            console.warn('[WebRTC] renegotiation failed', e);
        } finally {
            info.makingOffer = false;
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
            // Any inbound data-channel message counts as liveness — the
            // keepalive sweep uses this to notice zombie connections whose
            // WebRTC state still says 'connected' but whose SCTP / browser
            // pipeline has quietly stalled.
            info.lastRecvMs = performance.now();
            try {
                const msg: RTCMessage = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
                // Internal voice-reconcile messages are absorbed here; the
                // session never sees them. Anything else goes up to the
                // session's onMessage handler as before.
                if (msg && (msg as any).t === 'voice_state') {
                    this._handleVoiceState(info.peerId, !!(msg as any).micOn);
                    return;
                }
                if (msg && (msg as any).t === 'voice_missing') {
                    this._handleVoiceMissing(info);
                    return;
                }
                this.events.onMessage?.(info.peerId, msg);
            } catch { /* ignore malformed */ }
        };
    }

    private teardown(peerId: PeerId): void {
        const info = this.peers.get(peerId);
        if (!info) return;
        if (info.connectionTimeout) { clearTimeout(info.connectionTimeout); info.connectionTimeout = null; }
        if (info.disconnectGraceTimer) { clearTimeout(info.disconnectGraceTimer); info.disconnectGraceTimer = null; }
        try { info.channel?.close(); } catch { /* ignored */ }
        try { info.connection.close(); } catch { /* ignored */ }
        this.peers.delete(peerId);
        this.remoteMicState.delete(peerId);
        if (info.ready) this.events.onClose?.(peerId);
    }

    /**
     * Sweep peers and tear down any we haven't received a message from
     * in KEEPALIVE_TIMEOUT_MS. Only applies once the data channel is
     * open (info.ready) — pre-open peers are covered by the stricter
     * CONNECT_TIMEOUT_MS inside connect().
     *
     * Skipped while the disconnect grace period is active so we don't
     * race the pc.onconnectionstatechange handler; that timer already
     * owns this peer's fate.
     */
    private _keepaliveSweep(): void {
        const now = performance.now();
        for (const info of this.peers.values()) {
            if (!info.ready) continue;
            if (info.disconnectGraceTimer) continue;
            if (now - info.lastRecvMs > KEEPALIVE_TIMEOUT_MS) {
                console.warn(`[WebRTC] Peer ${info.peerId} silent for ${Math.round((now - info.lastRecvMs) / 1000)}s — tearing down (connectionState=${info.connection.connectionState})`);
                this.teardown(info.peerId);
            }
        }
    }

    // ── Voice reconcile ─────────────────────────────────────────────────────

    /**
     * Periodic tick: broadcast our current mic state, then for every peer
     * that's claimed to have mic on but we're not actually receiving audio
     * from, send them a voice_missing so they re-attach + renegotiate.
     *
     * Running on both sides makes this a symmetric repair — either direction
     * broken, detected and fixed within ~2-4 seconds without manually
     * chasing Chrome's SDP quirks.
     */
    private _voiceReconcileTick(): void {
        this._broadcastVoiceState();
        for (const info of this.peers.values()) {
            if (!info.ready || !info.channel || info.channel.readyState !== 'open') continue;
            const theyClaimMicOn = this.remoteMicState.get(info.peerId) === true;
            if (!theyClaimMicOn) continue;
            if (this._remoteAudioAppearsAlive(info)) continue;
            try {
                info.channel.send(JSON.stringify({ t: 'voice_missing' }));
            } catch { /* channel half-closed */ }
        }
    }

    private _broadcastVoiceState(): void {
        // "micOn" is the effective state — actively transmitting audio. A
        // muted peer is NOT micOn, so other peers don't trigger a
        // voice_missing repair when they correctly see silence on the wire.
        const active = !!this.localAudioTrack && !this.localMuted;
        const payload = JSON.stringify({ t: 'voice_state', micOn: active });
        for (const info of this.peers.values()) {
            if (!info.ready || !info.channel || info.channel.readyState !== 'open') continue;
            try { info.channel.send(payload); } catch { /* ignored */ }
        }
    }

    /**
     * Heuristic for "I'm actually receiving audio from this peer": we have
     * a MediaStream for them AND at least one of its audio tracks is
     * unmuted. Chrome sets `track.muted = true` when no RTP is flowing,
     * so this reliably catches the "ontrack fired with a ghost track"
     * case where the stream exists but nothing's coming through.
     */
    private _remoteAudioAppearsAlive(info: PeerInfo): boolean {
        const stream = info.remoteAudioStream;
        if (!stream) return false;
        const tracks = stream.getAudioTracks();
        if (!tracks || tracks.length === 0) return false;
        for (const t of tracks) {
            if (!t.muted && t.readyState === 'live') return true;
        }
        return false;
    }

    private _handleVoiceState(peerId: PeerId, micOn: boolean): void {
        this.remoteMicState.set(peerId, micOn);
    }

    /**
     * A peer told us they can't hear us. Force re-attach the current mic
     * track to their sender and kick a fresh renegotiation, bypassing
     * replaceTrack's "codec already negotiated, skip SDP" fast path
     * because that's exactly what got wedged in the first place.
     */
    private _handleVoiceMissing(info: PeerInfo): void {
        // Race case: peer's state was stale, they asked for a repair after
        // we muted. Honor the mute — don't re-attach the track.
        if (!this.localAudioTrack || this.localMuted) return;
        console.warn('[WebRTC] voice_missing from', info.peerId, '- forcing re-attach');
        try {
            if (info.audioTransceiver) {
                info.audioTransceiver.sender.replaceTrack(this.localAudioTrack);
                info.outgoingAudioSender = info.audioTransceiver.sender;
                try { info.audioTransceiver.direction = 'sendrecv'; } catch { /* read-only in some states */ }
            } else {
                const sender = info.connection.addTrack(this.localAudioTrack);
                info.outgoingAudioSender = sender;
            }
        } catch (e) {
            console.warn('[WebRTC] re-attach on voice_missing failed', e);
        }
        if (info.ready && info.connection.signalingState === 'stable') {
            void this.triggerRenegotiation(info);
        }
    }
}
