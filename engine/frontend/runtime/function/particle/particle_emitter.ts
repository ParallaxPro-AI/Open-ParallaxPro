import { ParticleRenderData } from '../render/particle_renderer.js';

interface Particle {
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    life: number; maxLife: number;
    startSize: number; endSize: number;
    sr: number; sg: number; sb: number; sa: number;
    er: number; eg: number; eb: number; ea: number;
    rotation: number; rotSpeed: number;
}

export interface ParticlePreset {
    maxParticles: number;
    emissionRate: number;
    lifetime: [number, number];
    speed: [number, number];
    direction: [number, number, number];
    spread: number;
    gravity: number;
    startSize: [number, number];
    endSize: [number, number];
    startColor: [number, number, number, number];
    endColor: [number, number, number, number];
    rotationSpeed: [number, number];
    burst?: number;
    spawnRadius?: number;
}

export const PRESETS: Record<string, ParticlePreset> = {
    fire: {
        maxParticles: 300, emissionRate: 80,
        lifetime: [0.4, 1.0], speed: [2, 5],
        direction: [0, 1, 0], spread: 25, gravity: -2,
        startSize: [0.8, 1.5], endSize: [0.1, 0.3],
        startColor: [1, 0.8, 0.2, 0.9], endColor: [1, 0.1, 0, 0],
        rotationSpeed: [-2, 2],
    },
    smoke: {
        maxParticles: 150, emissionRate: 25,
        lifetime: [1.5, 4], speed: [0.5, 1.5],
        direction: [0, 1, 0], spread: 35, gravity: -0.3,
        startSize: [0.5, 1.0], endSize: [2.5, 5.0],
        startColor: [0.4, 0.4, 0.4, 0.5], endColor: [0.6, 0.6, 0.6, 0],
        rotationSpeed: [-1, 1],
    },
    dust: {
        maxParticles: 100, emissionRate: 20,
        lifetime: [1, 2.5], speed: [0.3, 1.2],
        direction: [0, 1, 0], spread: 60, gravity: 0.1,
        startSize: [0.15, 0.4], endSize: [0.05, 0.15],
        startColor: [0.8, 0.7, 0.5, 0.6], endColor: [0.6, 0.5, 0.4, 0],
        rotationSpeed: [-0.5, 0.5],
    },
    explosion: {
        maxParticles: 400, emissionRate: 0, burst: 250,
        lifetime: [0.4, 1.5], speed: [5, 15],
        direction: [0, 1, 0], spread: 180, gravity: 4,
        startSize: [0.5, 2.0], endSize: [0.1, 0.5],
        startColor: [1, 0.9, 0.3, 1], endColor: [1, 0.2, 0, 0],
        rotationSpeed: [-5, 5],
    },
    magic: {
        maxParticles: 200, emissionRate: 50,
        lifetime: [0.6, 2.0], speed: [0.8, 3],
        direction: [0, 1, 0], spread: 45, gravity: -0.8,
        startSize: [0.3, 0.8], endSize: [0, 0],
        startColor: [0.3, 0.5, 1, 1], endColor: [0.8, 0.3, 1, 0],
        rotationSpeed: [-3, 3],
    },
    sparks: {
        maxParticles: 150, emissionRate: 0, burst: 80,
        lifetime: [0.3, 1.0], speed: [3, 12],
        direction: [0, 1, 0], spread: 120, gravity: 10,
        startSize: [0.08, 0.2], endSize: [0.02, 0.05],
        startColor: [1, 0.9, 0.5, 1], endColor: [1, 0.4, 0.1, 0],
        rotationSpeed: [0, 0],
    },
    rain: {
        maxParticles: 1500, emissionRate: 600,
        lifetime: [0.3, 0.6], speed: [20, 30],
        direction: [0.1, -1, 0.05], spread: 5, gravity: 0,
        startSize: [0.15, 0.3], endSize: [0.1, 0.2],
        startColor: [0.7, 0.8, 1, 0.7], endColor: [0.5, 0.7, 1, 0.3],
        rotationSpeed: [0, 0],
        spawnRadius: 25,
    },
    snow: {
        maxParticles: 800, emissionRate: 200,
        lifetime: [4, 8], speed: [0.5, 2],
        direction: [0.15, -1, 0.1], spread: 40, gravity: 0,
        startSize: [0.1, 0.3], endSize: [0.1, 0.3],
        startColor: [1, 1, 1, 0.9], endColor: [1, 1, 1, 0],
        rotationSpeed: [-1.5, 1.5],
        spawnRadius: 25,
    },
    heal: {
        maxParticles: 80, emissionRate: 40,
        lifetime: [0.8, 2.0], speed: [0.8, 2],
        direction: [0, 1, 0], spread: 20, gravity: -0.5,
        startSize: [0.3, 0.6], endSize: [0, 0],
        startColor: [0.2, 1, 0.3, 0.8], endColor: [0.5, 1, 0.5, 0],
        rotationSpeed: [-2, 2],
    },
};

export class ParticleEmitter {
    preset: ParticlePreset;
    particles: Particle[] = [];
    active: boolean = true;
    worldX = 0;
    worldY = 0;
    worldZ = 0;

    private emitAccum = 0;
    private burstFired = false;
    private renderBuffer: Float32Array;

    constructor(preset: ParticlePreset) {
        this.preset = preset;
        this.renderBuffer = new Float32Array(preset.maxParticles * 12);
    }

    tick(dt: number): void {
        const gravity = this.preset.gravity;

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.life -= dt;
            if (p.life <= 0) { this.particles.splice(i, 1); continue; }
            p.vy -= gravity * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.z += p.vz * dt;
            p.rotation += p.rotSpeed * dt;
        }

        if (!this.active) return;

        if (this.preset.burst && !this.burstFired) {
            this.burstFired = true;
            for (let i = 0; i < this.preset.burst && this.particles.length < this.preset.maxParticles; i++) {
                this.spawn();
            }
            this.active = false;
            return;
        }

        if (this.preset.emissionRate > 0) {
            this.emitAccum += dt * this.preset.emissionRate;
            while (this.emitAccum >= 1 && this.particles.length < this.preset.maxParticles) {
                this.spawn();
                this.emitAccum -= 1;
            }
        }
    }

    getRenderData(): ParticleRenderData | null {
        if (this.particles.length === 0) return null;
        const buf = this.renderBuffer;
        let count = 0;
        for (const p of this.particles) {
            const t = 1 - p.life / p.maxLife;
            const size = p.startSize + (p.endSize - p.startSize) * t;
            const off = count * 12;
            buf[off] = p.x; buf[off + 1] = p.y; buf[off + 2] = p.z;
            buf[off + 3] = size;
            buf[off + 4] = p.sr + (p.er - p.sr) * t;
            buf[off + 5] = p.sg + (p.eg - p.sg) * t;
            buf[off + 6] = p.sb + (p.eb - p.sb) * t;
            buf[off + 7] = p.sa + (p.ea - p.sa) * t;
            buf[off + 8] = p.rotation;
            buf[off + 9] = 0; buf[off + 10] = 0; buf[off + 11] = 0;
            count++;
        }
        return { instanceData: buf, activeCount: count };
    }

    reset(): void {
        this.particles.length = 0;
        this.burstFired = false;
        this.emitAccum = 0;
        this.active = true;
    }

    get isDead(): boolean {
        return !this.active && this.particles.length === 0;
    }

    private spawn(): void {
        const p = this.preset;
        const life = lerp(p.lifetime[0], p.lifetime[1], Math.random());
        const speed = lerp(p.speed[0], p.speed[1], Math.random());
        const dir = randomCone(p.direction[0], p.direction[1], p.direction[2], p.spread);

        let sx = this.worldX, sy = this.worldY, sz = this.worldZ;
        if (p.spawnRadius && p.spawnRadius > 0) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.sqrt(Math.random()) * p.spawnRadius;
            sx += Math.cos(angle) * dist;
            sz += Math.sin(angle) * dist;
        }

        this.particles.push({
            x: sx, y: sy, z: sz,
            vx: dir[0] * speed, vy: dir[1] * speed, vz: dir[2] * speed,
            life, maxLife: life,
            startSize: lerp(p.startSize[0], p.startSize[1], Math.random()),
            endSize: lerp(p.endSize[0], p.endSize[1], Math.random()),
            sr: p.startColor[0], sg: p.startColor[1], sb: p.startColor[2], sa: p.startColor[3],
            er: p.endColor[0], eg: p.endColor[1], eb: p.endColor[2], ea: p.endColor[3],
            rotation: Math.random() * Math.PI * 2,
            rotSpeed: lerp(p.rotationSpeed[0], p.rotationSpeed[1], Math.random()),
        });
    }
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function randomCone(dx: number, dy: number, dz: number, spreadDeg: number): [number, number, number] {
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    if (spreadDeg <= 0) return [dx / len, dy / len, dz / len];

    const rad = spreadDeg * Math.PI / 180;
    const cosS = Math.cos(rad);
    const z = cosS + (1 - cosS) * Math.random();
    const phi = Math.random() * 2 * Math.PI;
    const sinT = Math.sqrt(1 - z * z);
    let rx = sinT * Math.cos(phi), ry = z, rz = sinT * Math.sin(phi);

    // Rotate from +Y to desired direction
    const ndx = dx / len, ndy = dy / len, ndz = dz / len;
    if (Math.abs(ndy - 1) < 0.001) return [rx, ry, rz];
    if (Math.abs(ndy + 1) < 0.001) return [rx, -ry, rz];

    const ax = ndz, az = -ndx;
    const alen = Math.sqrt(ax * ax + az * az);
    const nax = ax / alen, naz = az / alen;
    const angle = Math.acos(ndy);
    const c = Math.cos(angle), s = Math.sin(angle);
    const dot = nax * rx + naz * rz;

    return [
        rx * c + (naz * ry) * s + nax * dot * (1 - c),
        ry * c - (naz * rx - nax * rz) * s,
        rz * c + (-nax * ry) * s + naz * dot * (1 - c),
    ];
}
