const RTC_CONFIG: RTCConfiguration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ],
};

const CHANNEL_LABEL = 'gamedata';
const CONNECT_TIMEOUT = 5000;

interface PeerInfo {
    connection: RTCPeerConnection;
    channel: RTCDataChannel | null;
    ready: boolean;
}

export class WebRTCManager {
    private peers: Map<number, PeerInfo> = new Map();
    private localNetworkId: number = 0;

    sendSignal: (type: string, data: any) => void = () => {};
    onStateUpdate: ((senderNetworkId: number, data: any) => void) | null = null;
    onGameEvent: ((senderNetworkId: number, event: string, data: any) => void) | null = null;

    initialize(localNetworkId: number): void {
        this.localNetworkId = localNetworkId;
    }

    async connectToPeer(networkId: number): Promise<void> {
        if (this.peers.has(networkId)) return;

        const isInitiator = this.localNetworkId < networkId;
        const pc = new RTCPeerConnection(RTC_CONFIG);
        const peer: PeerInfo = { connection: pc, channel: null, ready: false };
        this.peers.set(networkId, peer);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.sendSignal('rtc_ice', {
                    targetNetworkId: networkId,
                    candidate: e.candidate.toJSON(),
                });
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                peer.ready = false;
            }
        };

        if (isInitiator) {
            const channel = pc.createDataChannel(CHANNEL_LABEL, {
                ordered: false,
                maxRetransmits: 0,
            });
            this.setupChannel(channel, networkId, peer);

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.sendSignal('rtc_offer', {
                targetNetworkId: networkId,
                sdp: pc.localDescription?.toJSON(),
            });
        } else {
            pc.ondatachannel = (e) => {
                this.setupChannel(e.channel, networkId, peer);
            };
        }

        setTimeout(() => {
            if (!peer.ready) {
                console.warn(`[WebRTC] Peer ${networkId} connection timed out, using server relay`);
            }
        }, CONNECT_TIMEOUT);
    }

    async handleSignal(type: string, data: any): Promise<void> {
        const senderNetworkId = data.senderNetworkId;
        if (!senderNetworkId) return;

        if (type === 'rtc_offer') {
            if (!this.peers.has(senderNetworkId)) {
                await this.connectToPeer(senderNetworkId);
            }
            const peer = this.peers.get(senderNetworkId);
            if (!peer) return;

            await peer.connection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            const answer = await peer.connection.createAnswer();
            await peer.connection.setLocalDescription(answer);
            this.sendSignal('rtc_answer', {
                targetNetworkId: senderNetworkId,
                sdp: peer.connection.localDescription?.toJSON(),
            });
        } else if (type === 'rtc_answer') {
            const peer = this.peers.get(senderNetworkId);
            if (!peer) return;
            await peer.connection.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } else if (type === 'rtc_ice') {
            const peer = this.peers.get(senderNetworkId);
            if (!peer) return;
            try {
                await peer.connection.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch {}
        }
    }

    broadcastState(data: any): boolean {
        const msg = JSON.stringify({ t: 's', d: data });
        let sent = false;
        for (const [, peer] of this.peers) {
            if (peer.ready && peer.channel?.readyState === 'open') {
                try { peer.channel.send(msg); sent = true; } catch {}
            }
        }
        return sent;
    }

    broadcastEvent(event: string, data: any): boolean {
        const msg = JSON.stringify({ t: 'e', event, d: data });
        let sent = false;
        for (const [, peer] of this.peers) {
            if (peer.ready && peer.channel?.readyState === 'open') {
                try { peer.channel.send(msg); sent = true; } catch {}
            }
        }
        return sent;
    }

    get hasActivePeers(): boolean {
        for (const [, peer] of this.peers) {
            if (peer.ready) return true;
        }
        return false;
    }

    disconnectPeer(networkId: number): void {
        const peer = this.peers.get(networkId);
        if (peer) {
            peer.channel?.close();
            peer.connection.close();
            this.peers.delete(networkId);
        }
    }

    disconnectAll(): void {
        for (const [id] of this.peers) {
            this.disconnectPeer(id);
        }
    }

    private setupChannel(channel: RTCDataChannel, networkId: number, peer: PeerInfo): void {
        peer.channel = channel;

        channel.onopen = () => {
            peer.ready = true;
        };

        channel.onclose = () => {
            peer.ready = false;
        };

        channel.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.t === 's' && this.onStateUpdate) {
                    this.onStateUpdate(networkId, msg.d);
                } else if (msg.t === 'e' && this.onGameEvent) {
                    this.onGameEvent(networkId, msg.event, msg.d);
                }
            } catch {}
        };
    }
}
