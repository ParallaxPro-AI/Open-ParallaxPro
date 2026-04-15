import { Vec3 } from '../../core/math/vec3.js';

/**
 * Named audio groups for submixing.
 */
export type AudioGroup = 'master' | 'music' | 'sfx' | 'voice' | 'ambient';

/**
 * Handle to an active audio source.
 */
export interface AudioSourceHandle {
    id: number;
    bufferNode: AudioBufferSourceNode | null;
    gainNode: GainNode;
    pannerNode: PannerNode | null;
    isPlaying: boolean;
    loop: boolean;
}

interface ReverbPreset {
    convolver: ConvolverNode;
    buffer: AudioBuffer;
}

/**
 * Web Audio API wrapper that manages audio playback, spatial audio,
 * submix groups, and reverb effects.
 */
export class AudioSystem {
    private audioContext: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private sources: Map<number, AudioSourceHandle> = new Map();
    private nextSourceId: number = 1;
    private audioBuffers: Map<string, AudioBuffer> = new Map();
    private listenerPosition: Vec3 = new Vec3();
    private listenerForward: Vec3 = new Vec3(0, 0, -1);
    private listenerUp: Vec3 = new Vec3(0, 1, 0);

    private groups: Map<string, GainNode> = new Map();
    private reverbPresets: Map<string, ReverbPreset> = new Map();
    private groupReverbRouting: Map<string, { wet: GainNode; dry: GainNode; convolver: ConvolverNode }> = new Map();

    /** Cache of decoded AudioBuffers keyed by URL. */
    private urlBufferCache: Map<string, AudioBuffer> = new Map();
    /** URLs currently being fetched (to avoid duplicate requests). */
    private fetchingUrls: Set<string> = new Set();
    /** Currently playing music source. */
    private currentMusicSource: AudioBufferSourceNode | null = null;
    private currentMusicGain: GainNode | null = null;

    initialize(): void {
        // Deliberately empty. Constructing an AudioContext before a user
        // gesture triggers Chrome's "AudioContext was not allowed to start"
        // warning. Defer creation to the first call to ensureContext(),
        // which the engine wires up via resume() on canvas click/keydown
        // so it runs inside a gesture handler.
    }

    /**
     * Create a named submix group routed to the master gain.
     */
    createGroup(name: string): void {
        if (!this.audioContext || !this.masterGain) return;
        if (this.groups.has(name)) return;
        const gain = this.audioContext.createGain();
        gain.connect(this.masterGain);
        this.groups.set(name, gain);
    }

    setGroupVolume(group: AudioGroup | string, volume: number): void {
        const node = this.groups.get(group);
        if (node) node.gain.value = Math.max(0, Math.min(1, volume));
    }

    getGroupVolume(group: AudioGroup | string): number {
        return this.groups.get(group)?.gain.value ?? 1;
    }

    private getGroupNode(group?: string): GainNode {
        if (group) {
            const node = this.groups.get(group);
            if (node) return node;
        }
        return this.masterGain!;
    }

    /**
     * Resume (and lazily construct) the AudioContext. Called from the
     * engine's canvas click/keydown handler so we're inside a user gesture
     * when the context is created — sidestepping Chrome's autoplay policy.
     */
    async resume(): Promise<void> {
        this.ensureContext();
        if (this.audioContext && this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
    }

    /**
     * Decode and cache an audio buffer from raw data.
     */
    async loadBuffer(name: string, arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
        if (!this.audioContext) throw new Error('AudioSystem not initialized');
        const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
        this.audioBuffers.set(name, audioBuffer);
        return audioBuffer;
    }

    getBuffer(name: string): AudioBuffer | undefined {
        return this.audioBuffers.get(name);
    }

    /**
     * Play a non-spatial (2D) sound.
     */
    play2D(bufferName: string, options?: {
        volume?: number;
        loop?: boolean;
        playbackRate?: number;
        group?: AudioGroup | string;
    }): AudioSourceHandle | null {
        const buffer = this.audioBuffers.get(bufferName);
        if (!buffer || !this.audioContext || !this.masterGain) return null;

        const targetNode = this.getGroupNode(options?.group ?? 'sfx');
        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = options?.volume ?? 1;
        gainNode.connect(targetNode);

        const sourceNode = this.audioContext.createBufferSource();
        sourceNode.buffer = buffer;
        sourceNode.loop = options?.loop ?? false;
        sourceNode.playbackRate.value = options?.playbackRate ?? 1;
        sourceNode.connect(gainNode);

        const handle: AudioSourceHandle = {
            id: this.nextSourceId++,
            bufferNode: sourceNode,
            gainNode,
            pannerNode: null,
            isPlaying: true,
            loop: options?.loop ?? false,
        };

        sourceNode.onended = () => {
            handle.isPlaying = false;
            if (!handle.loop) {
                this.sources.delete(handle.id);
            }
        };

        sourceNode.start(0);
        this.sources.set(handle.id, handle);
        return handle;
    }

    /**
     * Play a spatial (3D) sound at a world position.
     */
    play3D(bufferName: string, position: Vec3, options?: {
        volume?: number;
        loop?: boolean;
        playbackRate?: number;
        refDistance?: number;
        maxDistance?: number;
        rolloffFactor?: number;
        group?: AudioGroup | string;
    }): AudioSourceHandle | null {
        const buffer = this.audioBuffers.get(bufferName);
        if (!buffer || !this.audioContext || !this.masterGain) return null;

        const targetNode = this.getGroupNode(options?.group ?? 'sfx');

        const pannerNode = this.audioContext.createPanner();
        pannerNode.panningModel = 'HRTF';
        pannerNode.distanceModel = 'inverse';
        pannerNode.refDistance = options?.refDistance ?? 1;
        pannerNode.maxDistance = options?.maxDistance ?? 100;
        pannerNode.rolloffFactor = options?.rolloffFactor ?? 1;
        pannerNode.coneInnerAngle = 360;
        pannerNode.coneOuterAngle = 360;
        pannerNode.positionX.value = position.x;
        pannerNode.positionY.value = position.y;
        pannerNode.positionZ.value = position.z;

        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = options?.volume ?? 1;
        pannerNode.connect(gainNode);
        gainNode.connect(targetNode);

        const sourceNode = this.audioContext.createBufferSource();
        sourceNode.buffer = buffer;
        sourceNode.loop = options?.loop ?? false;
        sourceNode.playbackRate.value = options?.playbackRate ?? 1;
        sourceNode.connect(pannerNode);

        const handle: AudioSourceHandle = {
            id: this.nextSourceId++,
            bufferNode: sourceNode,
            gainNode,
            pannerNode,
            isPlaying: true,
            loop: options?.loop ?? false,
        };

        sourceNode.onended = () => {
            handle.isPlaying = false;
            if (!handle.loop) {
                this.sources.delete(handle.id);
            }
        };

        sourceNode.start(0);
        this.sources.set(handle.id, handle);
        return handle;
    }

    stopSource(handle: AudioSourceHandle): void {
        if (handle.bufferNode && handle.isPlaying) {
            try {
                handle.bufferNode.stop();
            } catch {
                // Already stopped
            }
            handle.isPlaying = false;
        }
        this.sources.delete(handle.id);
    }

    setSourcePosition(handle: AudioSourceHandle, position: Vec3): void {
        if (handle.pannerNode) {
            handle.pannerNode.positionX.value = position.x;
            handle.pannerNode.positionY.value = position.y;
            handle.pannerNode.positionZ.value = position.z;
        }
    }

    setSourceVolume(handle: AudioSourceHandle, volume: number): void {
        handle.gainNode.gain.value = volume;
    }

    /**
     * Update the listener position and orientation for spatial audio.
     */
    setListenerTransform(position: Vec3, forward: Vec3, up: Vec3): void {
        if (!this.audioContext) return;
        this.listenerPosition.copy(position);
        this.listenerForward.copy(forward);
        this.listenerUp.copy(up);

        const listener = this.audioContext.listener;
        if (listener.positionX) {
            listener.positionX.value = position.x;
            listener.positionY.value = position.y;
            listener.positionZ.value = position.z;
            listener.forwardX.value = forward.x;
            listener.forwardY.value = forward.y;
            listener.forwardZ.value = forward.z;
            listener.upX.value = up.x;
            listener.upY.value = up.y;
            listener.upZ.value = up.z;
        }
    }

    setMasterVolume(volume: number): void {
        if (this.masterGain) {
            this.masterGain.gain.value = Math.max(0, Math.min(1, volume));
        }
    }

    getMasterVolume(): number {
        return this.masterGain?.gain.value ?? 1;
    }

    /**
     * Clean up finished non-looping sources.
     */
    tick(_deltaTime: number): void {
        for (const [id, handle] of this.sources) {
            if (!handle.isPlaying && !handle.loop) {
                this.sources.delete(id);
            }
        }
    }

    stopAll(): void {
        for (const handle of this.sources.values()) {
            if (handle.bufferNode && handle.isPlaying) {
                try { handle.bufferNode.stop(); } catch { /* already stopped */ }
                handle.isPlaying = false;
            }
        }
        this.sources.clear();
    }

    /**
     * Load a reverb impulse response from raw audio data and store as a named preset.
     */
    async loadReverbImpulse(name: string, arrayBuffer: ArrayBuffer): Promise<void> {
        if (!this.audioContext) return;
        const buffer = await this.audioContext.decodeAudioData(arrayBuffer);
        const convolver = this.audioContext.createConvolver();
        convolver.buffer = buffer;
        this.reverbPresets.set(name, { convolver, buffer });
    }

    /**
     * Generate a reverb impulse response programmatically.
     *
     * @param name     Preset name.
     * @param duration Reverb tail length in seconds.
     * @param decay    Decay rate (higher = faster decay).
     * @param reverse  If true, generate a reverse reverb effect.
     */
    generateReverbPreset(
        name: string,
        duration: number = 2.0,
        decay: number = 3.0,
        reverse: boolean = false,
    ): void {
        if (!this.audioContext) return;
        const sampleRate = this.audioContext.sampleRate;
        const length = Math.floor(sampleRate * duration);
        const buffer = this.audioContext.createBuffer(2, length, sampleRate);

        for (let channel = 0; channel < 2; channel++) {
            const data = buffer.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                const t = i / length;
                const envelope = Math.exp(-decay * t);
                const noise = (Math.random() * 2 - 1) * envelope;
                if (reverse) {
                    data[length - 1 - i] = noise;
                } else {
                    data[i] = noise;
                }
            }
        }

        const convolver = this.audioContext.createConvolver();
        convolver.buffer = buffer;
        this.reverbPresets.set(name, { convolver, buffer });
    }

    /**
     * Route a submix group through a reverb convolver with a wet/dry mix.
     * wetMix ranges from 0 (fully dry) to 1 (fully wet).
     */
    setReverbForGroup(group: AudioGroup | string, reverbName: string, wetMix: number): void {
        if (!this.audioContext || !this.masterGain) return;
        const groupNode = this.groups.get(group);
        if (!groupNode) return;
        const preset = this.reverbPresets.get(reverbName);
        if (!preset) return;

        // Remove existing reverb routing for this group
        const existing = this.groupReverbRouting.get(group);
        if (existing) {
            try { existing.wet.disconnect(); } catch { /* ignore */ }
            try { existing.dry.disconnect(); } catch { /* ignore */ }
            try { existing.convolver.disconnect(); } catch { /* ignore */ }
            this.groupReverbRouting.delete(group);
        }

        try { groupNode.disconnect(); } catch { /* ignore */ }

        const clampedWet = Math.max(0, Math.min(1, wetMix));

        // Dry path: group -> dryGain -> master
        const dryGain = this.audioContext.createGain();
        dryGain.gain.value = 1 - clampedWet;
        groupNode.connect(dryGain);
        dryGain.connect(this.masterGain);

        // Wet path: group -> convolver -> wetGain -> master
        const convolver = this.audioContext.createConvolver();
        convolver.buffer = preset.buffer;
        const wetGain = this.audioContext.createGain();
        wetGain.gain.value = clampedWet;
        groupNode.connect(convolver);
        convolver.connect(wetGain);
        wetGain.connect(this.masterGain);

        this.groupReverbRouting.set(group, { wet: wetGain, dry: dryGain, convolver });
    }

    // -- URL-based convenience methods --

    /**
     * Play a sound by URL. Fetches, decodes, and caches automatically.
     * Routes through the 'sfx' group.
     */
    playSound(url: string, volume: number = 1): void {
        const cached = this.urlBufferCache.get(url);
        if (cached) {
            this.playUrlBuffer(cached, volume, 'sfx');
            return;
        }
        if (this.fetchingUrls.has(url)) return;
        this.fetchingUrls.add(url);
        this.ensureContext();
        fetch(url)
            .then(res => res.arrayBuffer())
            .then(data => this.audioContext!.decodeAudioData(data))
            .then(buffer => {
                this.urlBufferCache.set(url, buffer);
                this.fetchingUrls.delete(url);
                this.playUrlBuffer(buffer, volume, 'sfx');
            })
            .catch(err => {
                this.fetchingUrls.delete(url);
                console.warn('AudioSystem: failed to load', url, err);
            });
    }

    /**
     * Play a music track by URL (loops, routes through 'music' group).
     * Stops any previously playing music.
     */
    playMusic(url: string, volume: number = 1): void {
        this.stopMusic();
        const cached = this.urlBufferCache.get(url);
        if (cached) {
            this.startMusicBuffer(cached, volume);
            return;
        }
        if (this.fetchingUrls.has(url)) return;
        this.fetchingUrls.add(url);
        this.ensureContext();
        fetch(url)
            .then(res => res.arrayBuffer())
            .then(data => this.audioContext!.decodeAudioData(data))
            .then(buffer => {
                this.urlBufferCache.set(url, buffer);
                this.fetchingUrls.delete(url);
                this.startMusicBuffer(buffer, volume);
            })
            .catch(err => {
                this.fetchingUrls.delete(url);
                console.warn('AudioSystem: failed to load music', url, err);
            });
    }

    stopMusic(): void {
        if (this.currentMusicSource) {
            try { this.currentMusicSource.stop(); } catch { /* already stopped */ }
            this.currentMusicSource = null;
            this.currentMusicGain = null;
        }
    }

    /**
     * Pre-fetch and cache a sound by URL so the first playSound() is instant.
     */
    preload(url: string): void {
        if (this.urlBufferCache.has(url) || this.fetchingUrls.has(url)) return;
        this.fetchingUrls.add(url);
        this.ensureContext();
        fetch(url)
            .then(res => res.arrayBuffer())
            .then(data => this.audioContext!.decodeAudioData(data))
            .then(buffer => {
                this.urlBufferCache.set(url, buffer);
                this.fetchingUrls.delete(url);
            })
            .catch(err => {
                this.fetchingUrls.delete(url);
                console.warn('AudioSystem: failed to preload', url, err);
            });
    }

    private ensureContext(): void {
        if (!this.audioContext) {
            this.audioContext = new AudioContext();
            this.masterGain = this.audioContext.createGain();
            this.masterGain.connect(this.audioContext.destination);
            const defaultGroups: AudioGroup[] = ['music', 'sfx', 'voice', 'ambient'];
            for (const name of defaultGroups) this.createGroup(name);
            this.groups.set('master', this.masterGain);
        }
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
    }

    private playUrlBuffer(buffer: AudioBuffer, volume: number, group: string): void {
        if (!this.audioContext) return;
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        const gain = this.audioContext.createGain();
        gain.gain.value = Math.max(0, Math.min(1, volume));
        const targetNode = this.getGroupNode(group);
        source.connect(gain);
        gain.connect(targetNode);
        // Once playback finishes, disconnect both nodes so they're not
        // retained by the output graph. Without this, firing a weapon at
        // 10 shots/sec accumulates source+gain nodes on the sfx bus
        // indefinitely — a real leak pattern for rapid-fire games.
        source.onended = () => {
            try { source.disconnect(); } catch { /* already detached */ }
            try { gain.disconnect(); } catch { /* already detached */ }
        };
        source.start(0);
    }

    private startMusicBuffer(buffer: AudioBuffer, volume: number): void {
        if (!this.audioContext) return;
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const gain = this.audioContext.createGain();
        gain.gain.value = Math.max(0, Math.min(1, volume));
        const musicGroup = this.getGroupNode('music');
        source.connect(gain);
        gain.connect(musicGroup);
        source.start(0);
        this.currentMusicSource = source;
        this.currentMusicGain = gain;
    }

    shutdown(): void {
        this.stopAll();
        this.stopMusic();
        for (const routing of this.groupReverbRouting.values()) {
            try { routing.wet.disconnect(); } catch { /* ignore */ }
            try { routing.dry.disconnect(); } catch { /* ignore */ }
            try { routing.convolver.disconnect(); } catch { /* ignore */ }
        }
        this.groupReverbRouting.clear();
        this.reverbPresets.clear();
        this.groups.clear();
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.masterGain = null;
        this.audioBuffers.clear();
        this.urlBufferCache.clear();
        this.fetchingUrls.clear();
    }
}
