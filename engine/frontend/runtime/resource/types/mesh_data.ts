export interface SubMesh {
    indexStart: number;
    indexCount: number;
    materialSlot: number;
}

export class MeshData {
    positions: Float32Array = new Float32Array(0);
    normals: Float32Array = new Float32Array(0);
    uvs: Float32Array = new Float32Array(0);
    tangents: Float32Array = new Float32Array(0);
    indices: Uint32Array = new Uint32Array(0);
    subMeshes: SubMesh[] = [];
    boundingBox: { min: [number, number, number]; max: [number, number, number] } = {
        min: [0, 0, 0], max: [0, 0, 0],
    };

    toJSON(): any {
        return {
            positions: Array.from(this.positions),
            normals: Array.from(this.normals),
            uvs: Array.from(this.uvs),
            tangents: Array.from(this.tangents),
            indices: Array.from(this.indices),
            subMeshes: this.subMeshes.map((sm) => ({
                indexStart: sm.indexStart,
                indexCount: sm.indexCount,
                materialSlot: sm.materialSlot,
            })),
            boundingBox: {
                min: [...this.boundingBox.min] as [number, number, number],
                max: [...this.boundingBox.max] as [number, number, number],
            },
        };
    }

    static fromJSON(data: any): MeshData {
        const mesh = new MeshData();
        if (!data) return mesh;
        mesh.positions = data.positions ? new Float32Array(data.positions) : new Float32Array(0);
        mesh.normals = data.normals ? new Float32Array(data.normals) : new Float32Array(0);
        mesh.uvs = data.uvs ? new Float32Array(data.uvs) : new Float32Array(0);
        mesh.tangents = data.tangents ? new Float32Array(data.tangents) : new Float32Array(0);
        mesh.indices = data.indices ? new Uint32Array(data.indices) : new Uint32Array(0);
        mesh.subMeshes = Array.isArray(data.subMeshes)
            ? data.subMeshes.map((sm: any) => ({
                  indexStart: sm.indexStart ?? 0,
                  indexCount: sm.indexCount ?? 0,
                  materialSlot: sm.materialSlot ?? 0,
              }))
            : [];
        if (data.boundingBox) {
            mesh.boundingBox = {
                min: data.boundingBox.min
                    ? [data.boundingBox.min[0], data.boundingBox.min[1], data.boundingBox.min[2]]
                    : [0, 0, 0],
                max: data.boundingBox.max
                    ? [data.boundingBox.max[0], data.boundingBox.max[1], data.boundingBox.max[2]]
                    : [0, 0, 0],
            };
        }
        return mesh;
    }

    private static finalize(
        mesh: MeshData,
        positions: ArrayLike<number>,
        normals: ArrayLike<number>,
        uvs: ArrayLike<number>,
        indices: ArrayLike<number>,
    ): MeshData {
        mesh.positions = positions instanceof Float32Array ? positions : new Float32Array(positions);
        mesh.normals = normals instanceof Float32Array ? normals : new Float32Array(normals);
        mesh.uvs = uvs instanceof Float32Array ? uvs : new Float32Array(uvs);
        mesh.indices = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
        mesh.tangents = MeshData.computeTangents(mesh.positions, mesh.normals, mesh.uvs, mesh.indices);
        mesh.boundingBox = MeshData.computeBoundingBox(mesh.positions);
        mesh.subMeshes = [{ indexStart: 0, indexCount: mesh.indices.length, materialSlot: 0 }];
        return mesh;
    }

    private static computeBoundingBox(positions: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
        if (positions.length === 0) {
            return { min: [0, 0, 0], max: [0, 0, 0] };
        }
        const min: [number, number, number] = [positions[0], positions[1], positions[2]];
        const max: [number, number, number] = [positions[0], positions[1], positions[2]];
        for (let i = 3; i < positions.length; i += 3) {
            if (positions[i] < min[0]) min[0] = positions[i];
            if (positions[i + 1] < min[1]) min[1] = positions[i + 1];
            if (positions[i + 2] < min[2]) min[2] = positions[i + 2];
            if (positions[i] > max[0]) max[0] = positions[i];
            if (positions[i + 1] > max[1]) max[1] = positions[i + 1];
            if (positions[i + 2] > max[2]) max[2] = positions[i + 2];
        }
        return { min, max };
    }

    /** Creates a box mesh centered at the origin. */
    static createBox(width: number = 1, height: number = 1, depth: number = 1): MeshData {
        const mesh = new MeshData();
        const hw = width / 2;
        const hh = height / 2;
        const hd = depth / 2;

        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];

        const addFace = (
            p0: number[], p1: number[], p2: number[], p3: number[],
            n: number[],
        ) => {
            const base = positions.length / 3;
            positions.push(...p0, ...p1, ...p2, ...p3);
            normals.push(...n, ...n, ...n, ...n);
            uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };

        addFace([-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd], [0, 0, 1]);
        addFace([hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd], [0, 0, -1]);
        addFace([-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd], [0, 1, 0]);
        addFace([-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd], [0, -1, 0]);
        addFace([hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd], [1, 0, 0]);
        addFace([-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd], [-1, 0, 0]);

        return MeshData.finalize(mesh, positions, normals, uvs, indices);
    }

    /** Creates a UV sphere mesh centered at the origin. */
    static createSphere(radius: number = 0.5, segments: number = 32): MeshData {
        const mesh = new MeshData();
        const rings = Math.max(segments, 4);
        const slices = Math.max(segments, 4);

        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];

        for (let ring = 0; ring <= rings; ring++) {
            const phi = (ring / rings) * Math.PI;
            const sinPhi = Math.sin(phi);
            const cosPhi = Math.cos(phi);

            for (let slice = 0; slice <= slices; slice++) {
                const theta = (slice / slices) * Math.PI * 2;
                const sinTheta = Math.sin(theta);
                const cosTheta = Math.cos(theta);

                const nx = sinPhi * cosTheta;
                const ny = cosPhi;
                const nz = sinPhi * sinTheta;

                positions.push(nx * radius, ny * radius, nz * radius);
                normals.push(nx, ny, nz);
                uvs.push(slice / slices, ring / rings);
            }
        }

        for (let ring = 0; ring < rings; ring++) {
            for (let slice = 0; slice < slices; slice++) {
                const current = ring * (slices + 1) + slice;
                const next = current + slices + 1;
                indices.push(current, current + 1, next);
                indices.push(current + 1, next + 1, next);
            }
        }

        return MeshData.finalize(mesh, positions, normals, uvs, indices);
    }

    /** Creates a flat plane mesh on the XZ plane, centered at the origin, facing +Y. */
    static createPlane(width: number = 1, depth: number = 1): MeshData {
        const mesh = new MeshData();
        const hw = width / 2;
        const hd = depth / 2;

        const positions = new Float32Array([
            -hw, 0, hd,
             hw, 0, hd,
             hw, 0, -hd,
            -hw, 0, -hd,
        ]);
        const normals = new Float32Array([
            0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
        ]);
        const uvs = new Float32Array([
            0, 0,  1, 0,  1, 1,  0, 1,
        ]);
        const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

        return MeshData.finalize(mesh, positions, normals, uvs, indices);
    }

    /** Creates a cylinder mesh centered at the origin with its axis along +Y. */
    static createCylinder(
        radiusTop: number = 0.5,
        radiusBottom: number = 0.5,
        height: number = 1,
        segments: number = 32,
    ): MeshData {
        const mesh = new MeshData();
        const segs = Math.max(segments, 3);
        const halfHeight = height / 2;

        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];

        // Side normal slope
        const slopeLength = Math.sqrt((radiusBottom - radiusTop) ** 2 + height ** 2);
        const slopeNy = (radiusBottom - radiusTop) / slopeLength;
        const slopeNr = height / slopeLength;

        // Side vertices: top and bottom rings
        for (let i = 0; i <= segs; i++) {
            const theta = (i / segs) * Math.PI * 2;
            const cosT = Math.cos(theta);
            const sinT = Math.sin(theta);
            const u = i / segs;
            const nx = slopeNr * cosT;
            const nz = slopeNr * sinT;

            positions.push(radiusTop * cosT, halfHeight, radiusTop * sinT);
            normals.push(nx, slopeNy, nz);
            uvs.push(u, 0);

            positions.push(radiusBottom * cosT, -halfHeight, radiusBottom * sinT);
            normals.push(nx, slopeNy, nz);
            uvs.push(u, 1);
        }

        for (let i = 0; i < segs; i++) {
            const tl = i * 2, bl = i * 2 + 1;
            const tr = (i + 1) * 2, br = (i + 1) * 2 + 1;
            indices.push(tl, tr, bl);
            indices.push(tr, br, bl);
        }

        // Top cap
        if (radiusTop > 0) {
            const centerIdx = positions.length / 3;
            positions.push(0, halfHeight, 0);
            normals.push(0, 1, 0);
            uvs.push(0.5, 0.5);

            for (let i = 0; i <= segs; i++) {
                const theta = (i / segs) * Math.PI * 2;
                const cosT = Math.cos(theta);
                const sinT = Math.sin(theta);
                positions.push(radiusTop * cosT, halfHeight, radiusTop * sinT);
                normals.push(0, 1, 0);
                uvs.push(0.5 + cosT * 0.5, 0.5 + sinT * 0.5);
            }

            for (let i = 0; i < segs; i++) {
                indices.push(centerIdx, centerIdx + 1 + i + 1, centerIdx + 1 + i);
            }
        }

        // Bottom cap
        if (radiusBottom > 0) {
            const centerIdx = positions.length / 3;
            positions.push(0, -halfHeight, 0);
            normals.push(0, -1, 0);
            uvs.push(0.5, 0.5);

            for (let i = 0; i <= segs; i++) {
                const theta = (i / segs) * Math.PI * 2;
                const cosT = Math.cos(theta);
                const sinT = Math.sin(theta);
                positions.push(radiusBottom * cosT, -halfHeight, radiusBottom * sinT);
                normals.push(0, -1, 0);
                uvs.push(0.5 + cosT * 0.5, 0.5 + sinT * 0.5);
            }

            for (let i = 0; i < segs; i++) {
                indices.push(centerIdx, centerIdx + 1 + i, centerIdx + 1 + i + 1);
            }
        }

        return MeshData.finalize(mesh, positions, normals, uvs, indices);
    }

    /** Creates a capsule mesh centered at the origin with its axis along +Y. */
    static createCapsule(radius: number = 0.5, height: number = 2, segments: number = 32): MeshData {
        const mesh = new MeshData();
        const segs = Math.max(segments, 4);
        const halfRings = Math.max(Math.floor(segs / 2), 2);
        const cylinderHeight = Math.max(height - radius * 2, 0);
        const halfCylinder = cylinderHeight / 2;

        const positions: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const indices: number[] = [];

        const totalRings = halfRings * 2 + 1;

        for (let ring = 0; ring <= totalRings; ring++) {
            let phi: number;
            let yOffset: number;

            if (ring <= halfRings) {
                phi = (ring / halfRings) * (Math.PI / 2);
                yOffset = halfCylinder;
            } else if (ring === halfRings + 1) {
                phi = Math.PI / 2;
                yOffset = -halfCylinder;
            } else {
                const localRing = ring - halfRings - 1;
                phi = (Math.PI / 2) + (localRing / halfRings) * (Math.PI / 2);
                yOffset = -halfCylinder;
            }

            const sinPhi = Math.sin(phi);
            const cosPhi = Math.cos(phi);

            for (let slice = 0; slice <= segs; slice++) {
                const theta = (slice / segs) * Math.PI * 2;
                const sinTheta = Math.sin(theta);
                const cosTheta = Math.cos(theta);

                const nx = sinPhi * cosTheta;
                const ny = cosPhi;
                const nz = sinPhi * sinTheta;

                positions.push(nx * radius, ny * radius + yOffset, nz * radius);
                normals.push(nx, ny, nz);
                uvs.push(slice / segs, ring / totalRings);
            }
        }

        for (let ring = 0; ring < totalRings; ring++) {
            for (let slice = 0; slice < segs; slice++) {
                const current = ring * (segs + 1) + slice;
                const next = current + segs + 1;
                indices.push(current, current + 1, next);
                indices.push(current + 1, next + 1, next);
            }
        }

        return MeshData.finalize(mesh, positions, normals, uvs, indices);
    }

    /**
     * Computes tangent vectors using the MikkTSpace-style algorithm.
     * Required for normal mapping.
     */
    private static computeTangents(
        positions: Float32Array,
        normals: Float32Array,
        uvs: Float32Array,
        indices: Uint32Array,
    ): Float32Array {
        const vertexCount = positions.length / 3;
        const tan1 = new Float32Array(vertexCount * 3);
        const tan2 = new Float32Array(vertexCount * 3);

        for (let i = 0; i < indices.length; i += 3) {
            const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];

            const p0x = positions[i0 * 3], p0y = positions[i0 * 3 + 1], p0z = positions[i0 * 3 + 2];
            const p1x = positions[i1 * 3], p1y = positions[i1 * 3 + 1], p1z = positions[i1 * 3 + 2];
            const p2x = positions[i2 * 3], p2y = positions[i2 * 3 + 1], p2z = positions[i2 * 3 + 2];

            const u0 = uvs[i0 * 2], v0 = uvs[i0 * 2 + 1];
            const u1 = uvs[i1 * 2], v1 = uvs[i1 * 2 + 1];
            const u2 = uvs[i2 * 2], v2 = uvs[i2 * 2 + 1];

            const dx1 = p1x - p0x, dy1 = p1y - p0y, dz1 = p1z - p0z;
            const dx2 = p2x - p0x, dy2 = p2y - p0y, dz2 = p2z - p0z;

            const du1 = u1 - u0, dv1 = v1 - v0;
            const du2 = u2 - u0, dv2 = v2 - v0;

            let denom = du1 * dv2 - du2 * dv1;
            if (Math.abs(denom) < 1e-10) denom = 1.0;
            const r = 1.0 / denom;

            const sdirX = (dv2 * dx1 - dv1 * dx2) * r;
            const sdirY = (dv2 * dy1 - dv1 * dy2) * r;
            const sdirZ = (dv2 * dz1 - dv1 * dz2) * r;

            const tdirX = (du1 * dx2 - du2 * dx1) * r;
            const tdirY = (du1 * dy2 - du2 * dy1) * r;
            const tdirZ = (du1 * dz2 - du2 * dz1) * r;

            tan1[i0 * 3] += sdirX; tan1[i0 * 3 + 1] += sdirY; tan1[i0 * 3 + 2] += sdirZ;
            tan1[i1 * 3] += sdirX; tan1[i1 * 3 + 1] += sdirY; tan1[i1 * 3 + 2] += sdirZ;
            tan1[i2 * 3] += sdirX; tan1[i2 * 3 + 1] += sdirY; tan1[i2 * 3 + 2] += sdirZ;

            tan2[i0 * 3] += tdirX; tan2[i0 * 3 + 1] += tdirY; tan2[i0 * 3 + 2] += tdirZ;
            tan2[i1 * 3] += tdirX; tan2[i1 * 3 + 1] += tdirY; tan2[i1 * 3 + 2] += tdirZ;
            tan2[i2 * 3] += tdirX; tan2[i2 * 3 + 1] += tdirY; tan2[i2 * 3 + 2] += tdirZ;
        }

        // Tangents are vec4: xyz = tangent direction, w = handedness
        const tangents = new Float32Array(vertexCount * 4);
        for (let i = 0; i < vertexCount; i++) {
            const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
            const tx = tan1[i * 3], ty = tan1[i * 3 + 1], tz = tan1[i * 3 + 2];

            // Gram-Schmidt orthogonalize
            const dot = nx * tx + ny * ty + nz * tz;
            let ox = tx - nx * dot;
            let oy = ty - ny * dot;
            let oz = tz - nz * dot;

            const len = Math.sqrt(ox * ox + oy * oy + oz * oz);
            if (len > 1e-10) {
                ox /= len; oy /= len; oz /= len;
            } else {
                // Fallback: arbitrary tangent perpendicular to the normal
                if (Math.abs(nx) < 0.9) {
                    ox = 0; oy = -nz; oz = ny;
                } else {
                    ox = nz; oy = 0; oz = -nx;
                }
                const fallbackLen = Math.sqrt(ox * ox + oy * oy + oz * oz);
                if (fallbackLen > 1e-10) {
                    ox /= fallbackLen; oy /= fallbackLen; oz /= fallbackLen;
                }
            }

            // Handedness
            const crossX = ny * tz - nz * ty;
            const crossY = nz * tx - nx * tz;
            const crossZ = nx * ty - ny * tx;
            const t2x = tan2[i * 3], t2y = tan2[i * 3 + 1], t2z = tan2[i * 3 + 2];
            const w = (crossX * t2x + crossY * t2y + crossZ * t2z) < 0 ? -1.0 : 1.0;

            tangents[i * 4] = ox;
            tangents[i * 4 + 1] = oy;
            tangents[i * 4 + 2] = oz;
            tangents[i * 4 + 3] = w;
        }

        return tangents;
    }
}
