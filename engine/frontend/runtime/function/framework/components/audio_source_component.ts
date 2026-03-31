import { Component } from '../component.js';

/**
 * AudioSourceComponent plays audio clips, optionally spatialized in 3D.
 *
 * Uses the Web Audio API: AudioBufferSourceNode for playback, GainNode
 * for volume, and PannerNode for 3D spatialization.
 */
export class AudioSourceComponent extends Component {
    audioAssetUUID: string = '';
    volume: number = 1.0;
    pitch: number = 1.0;
    loop: boolean = false;
    playOnStart: boolean = false;
    spatialize: boolean = false;
    minDistance: number = 1.0;
    maxDistance: number = 50.0;
    rolloffFactor: number = 1.0;

    private sourceNode: AudioBufferSourceNode | null = null;
    private gainNode: GainNode | null = null;
    private pannerNode: PannerNode | null = null;
    private playing: boolean = false;
    private audioBuffer: AudioBuffer | null = null;
    private audioContext: AudioContext | null = null;

    // -- Playback API ---------------------------------------------------------

    play(): void {
        if (!this.audioBuffer || !this.audioContext) return;

        this.stopSourceNode();

        const source = this.audioContext.createBufferSource();
        source.buffer = this.audioBuffer;
        source.loop = this.loop;
        source.playbackRate.value = this.pitch;

        // Wire: source -> [panner] -> gain -> destination
        let lastNode: AudioNode = source;

        if (this.spatialize && this.pannerNode) {
            lastNode.connect(this.pannerNode);
            lastNode = this.pannerNode;
        }

        if (this.gainNode) {
            lastNode.connect(this.gainNode);
            lastNode = this.gainNode;
        }

        lastNode.connect(this.audioContext.destination);

        source.onended = () => {
            if (this.sourceNode === source) {
                this.playing = false;
                this.sourceNode = null;
            }
        };

        this.sourceNode = source;
        source.start(0);
        this.playing = true;
    }

    pause(): void {
        this.stopSourceNode();
        this.playing = false;
    }

    stop(): void {
        this.stopSourceNode();
        this.playing = false;
    }

    isPlaying(): boolean {
        return this.playing;
    }

    /**
     * Set the audio buffer (called by AudioSystem after loading).
     */
    setAudioBuffer(buffer: AudioBuffer): void {
        this.audioBuffer = buffer;
        if (this.playOnStart && !this.playing) {
            this.play();
        }
    }

    // -- Lifecycle ------------------------------------------------------------

    initialize(data: Record<string, any>): void {
        this.audioAssetUUID = data.audioAssetUUID ?? data.clip ?? '';
        this.volume = data.volume ?? 1.0;
        this.pitch = data.pitch ?? 1.0;
        this.loop = data.loop ?? false;
        this.playOnStart = data.playOnStart ?? data.playOnAwake ?? false;
        this.spatialize = data.spatialize ?? false;
        this.minDistance = data.minDistance ?? 1.0;
        this.maxDistance = data.maxDistance ?? 50.0;
        this.rolloffFactor = data.rolloffFactor ?? 1.0;

        if (typeof AudioContext !== 'undefined') {
            this.audioContext = new AudioContext();
            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.value = this.volume;

            if (this.spatialize) {
                this.pannerNode = this.audioContext.createPanner();
                this.pannerNode.distanceModel = 'inverse';
                this.pannerNode.refDistance = this.minDistance;
                this.pannerNode.maxDistance = this.maxDistance;
                this.pannerNode.rolloffFactor = this.rolloffFactor;
                this.pannerNode.panningModel = 'HRTF';
            }
        }
    }

    start(): void {
        if (this.playOnStart && this.audioBuffer) {
            this.play();
        }
    }

    tick(deltaTime: number): void {
        if (this.gainNode) {
            this.gainNode.gain.value = this.volume;
        }

        if (this.spatialize && this.pannerNode && this.playing) {
            const worldPos = this.entity.getWorldPosition();
            this.pannerNode.positionX.value = worldPos.x;
            this.pannerNode.positionY.value = worldPos.y;
            this.pannerNode.positionZ.value = worldPos.z;
        }

        if (this.sourceNode) {
            this.sourceNode.playbackRate.value = this.pitch;
        }
    }

    onDestroy(): void {
        this.stopSourceNode();
        if (this.audioContext) {
            this.audioContext.close().catch(() => {});
            this.audioContext = null;
        }
        this.gainNode = null;
        this.pannerNode = null;
        this.audioBuffer = null;
    }

    toJSON(): Record<string, any> {
        return {
            audioAssetUUID: this.audioAssetUUID,
            volume: this.volume,
            pitch: this.pitch,
            loop: this.loop,
            playOnStart: this.playOnStart,
            spatialize: this.spatialize,
            minDistance: this.minDistance,
            maxDistance: this.maxDistance,
            rolloffFactor: this.rolloffFactor,
        };
    }

    private stopSourceNode(): void {
        if (this.sourceNode) {
            try { this.sourceNode.stop(); } catch (_e) { /* already stopped */ }
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }
    }
}
