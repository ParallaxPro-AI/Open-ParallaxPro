import { Component } from '../component.js';
import { Vec3 } from '../../../core/math/vec3.js';

export interface TerrainLayer {
    name: string;
    color: number[];
    roughness: number;
    tilingScale: number;
}

/**
 * TerrainComponent generates a heightmap-based terrain mesh.
 *
 * Supports procedural generation, brush-based sculpting, terrain layers
 * for splatmap texturing, and bilinear height/normal queries.
 */
export class TerrainComponent extends Component {
    width: number = 100;
    depth: number = 100;
    resolution: number = 64;
    heightScale: number = 10;
    heightData: Float32Array = new Float32Array(0);
    layers: TerrainLayer[] = [];
    splatmapData: Float32Array[] = [];

    // Runtime mesh data
    positions: Float32Array = new Float32Array(0);
    normals: Float32Array = new Float32Array(0);
    uvs: Float32Array = new Float32Array(0);
    indices: Uint32Array = new Uint32Array(0);
    meshDirty: boolean = true;

    gpuMesh: any = null;
    baseColor: number[] = [0.3, 0.55, 0.2, 1.0];
    metallic: number = 0.0;
    roughness: number = 0.85;

    initialize(data: Record<string, any>): void {
        this.width = data.width ?? 100;
        this.depth = data.depth ?? 100;
        this.resolution = Math.max(2, Math.min(data.resolution ?? 64, 256));
        this.heightScale = data.heightScale ?? 10;
        this.baseColor = data.baseColor ?? [0.3, 0.55, 0.2, 1.0];
        this.metallic = data.metallic ?? 0.0;
        this.roughness = data.roughness ?? 0.85;

        if (data.heightData && Array.isArray(data.heightData)) {
            this.heightData = new Float32Array(data.heightData);
        } else {
            this.heightData = new Float32Array(this.resolution * this.resolution);
        }

        if (Array.isArray(data.layers)) {
            this.layers = data.layers.map((l: any) => ({
                name: l.name ?? 'Layer',
                color: l.color ?? [0.3, 0.55, 0.2, 1.0],
                roughness: l.roughness ?? 0.85,
                tilingScale: l.tilingScale ?? 1.0,
            }));
        }

        if (Array.isArray(data.splatmapData)) {
            this.splatmapData = data.splatmapData.map((arr: any) =>
                new Float32Array(Array.isArray(arr) ? arr : [])
            );
        }

        this.meshDirty = true;
        this.generateMesh();
        this.markDirty();
    }

    /**
     * Generate terrain mesh from heightmap data.
     */
    generateMesh(): void {
        const res = this.resolution;
        const w = this.width;
        const d = this.depth;
        const vertCount = res * res;
        const triCount = (res - 1) * (res - 1) * 2;

        this.positions = new Float32Array(vertCount * 3);
        this.normals = new Float32Array(vertCount * 3);
        this.uvs = new Float32Array(vertCount * 2);
        this.indices = new Uint32Array(triCount * 3);

        if (this.heightData.length !== vertCount) {
            const newData = new Float32Array(vertCount);
            const copyLen = Math.min(this.heightData.length, vertCount);
            for (let i = 0; i < copyLen; i++) newData[i] = this.heightData[i];
            this.heightData = newData;
        }

        const halfW = w / 2;
        const halfD = d / 2;
        for (let z = 0; z < res; z++) {
            for (let x = 0; x < res; x++) {
                const idx = z * res + x;
                const fx = x / (res - 1);
                const fz = z / (res - 1);

                this.positions[idx * 3] = fx * w - halfW;
                this.positions[idx * 3 + 1] = this.heightData[idx] * this.heightScale;
                this.positions[idx * 3 + 2] = fz * d - halfD;

                this.uvs[idx * 2] = fx;
                this.uvs[idx * 2 + 1] = fz;
            }
        }

        let ii = 0;
        for (let z = 0; z < res - 1; z++) {
            for (let x = 0; x < res - 1; x++) {
                const topLeft = z * res + x;
                const topRight = topLeft + 1;
                const bottomLeft = (z + 1) * res + x;
                const bottomRight = bottomLeft + 1;

                this.indices[ii++] = topLeft;
                this.indices[ii++] = bottomLeft;
                this.indices[ii++] = topRight;

                this.indices[ii++] = topRight;
                this.indices[ii++] = bottomLeft;
                this.indices[ii++] = bottomRight;
            }
        }

        this.computeNormals();
        this.meshDirty = false;
    }

    /**
     * Get height at a world-space (x, z) position using bilinear interpolation.
     */
    getHeightAt(worldX: number, worldZ: number): number {
        const halfW = this.width / 2;
        const halfD = this.depth / 2;

        const fx = (worldX + halfW) / this.width;
        const fz = (worldZ + halfD) / this.depth;

        if (fx < 0 || fx > 1 || fz < 0 || fz > 1) return 0;

        const res = this.resolution;
        const gx = fx * (res - 1);
        const gz = fz * (res - 1);

        const ix = Math.floor(gx);
        const iz = Math.floor(gz);
        const tx = gx - ix;
        const tz = gz - iz;

        const ix1 = Math.min(ix + 1, res - 1);
        const iz1 = Math.min(iz + 1, res - 1);

        const h00 = this.heightData[iz * res + ix];
        const h10 = this.heightData[iz * res + ix1];
        const h01 = this.heightData[iz1 * res + ix];
        const h11 = this.heightData[iz1 * res + ix1];

        const h = h00 * (1 - tx) * (1 - tz) +
            h10 * tx * (1 - tz) +
            h01 * (1 - tx) * tz +
            h11 * tx * tz;

        return h * this.heightScale;
    }

    /**
     * Get normal at a world-space (x, z) position via central differences.
     */
    getNormalAt(worldX: number, worldZ: number): Vec3 {
        const eps = this.width / (this.resolution - 1) * 0.5;
        const hL = this.getHeightAt(worldX - eps, worldZ);
        const hR = this.getHeightAt(worldX + eps, worldZ);
        const hD = this.getHeightAt(worldX, worldZ - eps);
        const hU = this.getHeightAt(worldX, worldZ + eps);

        const nx = hL - hR;
        const nz = hD - hU;
        const ny = 2 * eps;

        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        return new Vec3(nx / len, ny / len, nz / len);
    }

    setHeightAtGrid(gridX: number, gridZ: number, height: number): void {
        if (gridX < 0 || gridX >= this.resolution || gridZ < 0 || gridZ >= this.resolution) return;
        this.heightData[gridZ * this.resolution + gridX] = height;
        this.meshDirty = true;
    }

    applyBrush(worldX: number, worldZ: number, radius: number, strength: number, mode: 'raise' | 'lower' | 'smooth' | 'flatten'): void {
        const halfW = this.width / 2;
        const res = this.resolution;
        const cellW = this.width / (res - 1);

        const centerGX = ((worldX + halfW) / this.width) * (res - 1);
        const centerGZ = ((worldZ + this.depth / 2) / this.depth) * (res - 1);
        const gridRadius = radius / cellW;

        const minX = Math.max(0, Math.floor(centerGX - gridRadius));
        const maxX = Math.min(res - 1, Math.ceil(centerGX + gridRadius));
        const minZ = Math.max(0, Math.floor(centerGZ - gridRadius));
        const maxZ = Math.min(res - 1, Math.ceil(centerGZ + gridRadius));

        let flattenHeight = 0;
        if (mode === 'flatten') {
            flattenHeight = this.getHeightAt(worldX, worldZ) / this.heightScale;
        }

        for (let gz = minZ; gz <= maxZ; gz++) {
            for (let gx = minX; gx <= maxX; gx++) {
                const dx = gx - centerGX;
                const dz = gz - centerGZ;
                const dist = Math.sqrt(dx * dx + dz * dz);
                if (dist > gridRadius) continue;

                const falloff = 1.0 - (dist / gridRadius);
                const idx = gz * res + gx;

                switch (mode) {
                    case 'raise':
                        this.heightData[idx] += strength * falloff;
                        break;
                    case 'lower':
                        this.heightData[idx] -= strength * falloff;
                        break;
                    case 'smooth': {
                        let sum = 0;
                        let count = 0;
                        for (let nz = -1; nz <= 1; nz++) {
                            for (let nx = -1; nx <= 1; nx++) {
                                const ngx = gx + nx;
                                const ngz = gz + nz;
                                if (ngx >= 0 && ngx < res && ngz >= 0 && ngz < res) {
                                    sum += this.heightData[ngz * res + ngx];
                                    count++;
                                }
                            }
                        }
                        this.heightData[idx] += (sum / count - this.heightData[idx]) * strength * falloff;
                        break;
                    }
                    case 'flatten':
                        this.heightData[idx] += (flattenHeight - this.heightData[idx]) * strength * falloff;
                        break;
                }
            }
        }

        this.meshDirty = true;
    }

    /**
     * Generate procedural terrain using multi-octave noise.
     */
    generateProcedural(roughness: number = 0.5, seed: number = 42): void {
        const size = this.resolution;
        const data = this.heightData;
        data.fill(0);

        const rng = this.seededRandom(seed);
        const octaves = 6;

        for (let o = 0; o < octaves; o++) {
            const freq = Math.pow(2, o) * 2;
            const amp = Math.pow(roughness, o);
            const phaseX = rng() * 1000;
            const phaseZ = rng() * 1000;

            for (let z = 0; z < size; z++) {
                for (let x = 0; x < size; x++) {
                    const fx = x / (size - 1);
                    const fz = z / (size - 1);
                    const val = Math.sin(fx * freq * Math.PI + phaseX) *
                        Math.cos(fz * freq * Math.PI + phaseZ) * amp;
                    data[z * size + x] += val * 0.5 + 0.25 * amp;
                }
            }
        }

        // Normalize to 0..1
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < data.length; i++) {
            if (data[i] < min) min = data[i];
            if (data[i] > max) max = data[i];
        }
        const range = max - min || 1;
        for (let i = 0; i < data.length; i++) {
            data[i] = (data[i] - min) / range;
        }

        this.meshDirty = true;
        this.generateMesh();
        this.markDirty();
    }

    onDestroy(): void {
        this.gpuMesh = null;
        this.heightData = new Float32Array(0);
        this.positions = new Float32Array(0);
        this.normals = new Float32Array(0);
        this.uvs = new Float32Array(0);
        this.indices = new Uint32Array(0);
    }

    toJSON(): Record<string, any> {
        return {
            width: this.width,
            depth: this.depth,
            resolution: this.resolution,
            heightScale: this.heightScale,
            heightData: Array.from(this.heightData),
            baseColor: this.baseColor,
            metallic: this.metallic,
            roughness: this.roughness,
            layers: this.layers,
        };
    }

    // -- Private helpers ------------------------------------------------------

    private computeNormals(): void {
        const normals = this.normals;
        normals.fill(0);

        const positions = this.positions;
        const indices = this.indices;

        for (let i = 0; i < indices.length; i += 3) {
            const i0 = indices[i];
            const i1 = indices[i + 1];
            const i2 = indices[i + 2];

            const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
            const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
            const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];

            const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
            const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

            const nx = e1y * e2z - e1z * e2y;
            const ny = e1z * e2x - e1x * e2z;
            const nz = e1x * e2y - e1y * e2x;

            normals[i0 * 3] += nx; normals[i0 * 3 + 1] += ny; normals[i0 * 3 + 2] += nz;
            normals[i1 * 3] += nx; normals[i1 * 3 + 1] += ny; normals[i1 * 3 + 2] += nz;
            normals[i2 * 3] += nx; normals[i2 * 3 + 1] += ny; normals[i2 * 3 + 2] += nz;
        }

        for (let i = 0; i < normals.length; i += 3) {
            const x = normals[i], y = normals[i + 1], z = normals[i + 2];
            const len = Math.sqrt(x * x + y * y + z * z);
            if (len > 0.0001) {
                normals[i] /= len;
                normals[i + 1] /= len;
                normals[i + 2] /= len;
            } else {
                normals[i] = 0;
                normals[i + 1] = 1;
                normals[i + 2] = 0;
            }
        }
    }

    private seededRandom(seed: number): () => number {
        let s = seed;
        return () => {
            s = (s * 16807) % 2147483647;
            return s / 2147483647;
        };
    }
}
