/**
 * lod_generator.ts
 *
 * Generates LOD (Level of Detail) sidecar files for GLB assets at startup.
 * Reuses the GLB parser and decimation algorithm from collision_mesh_generator.
 *
 * LOD levels:
 *   LOD1: ~25% triangles (medium distance 30-80m)
 *   LOD2: ~5% triangles (far distance >80m)
 *
 * Binary format (.lod1.bin, .lod2.bin):
 *   [4 bytes] magic: 0x4C4F4431 ("LOD1") or 0x4C4F4432 ("LOD2")
 *   [4 bytes] version: 1
 *   [4 bytes] posFloatCount (positions.length)
 *   [4 bytes] idxCount (indices.length)
 *   [4 bytes] nrmFloatCount (normals.length)
 *   [4 bytes] uvFloatCount (uvs.length)
 *   [posFloatCount * 4] Float32 positions
 *   [idxCount * 4] Uint32 indices
 *   [nrmFloatCount * 4] Float32 normals
 *   [uvFloatCount * 4] Float32 uvs
 */

import fs from 'fs';
import path from 'path';

const VERSION = 1;
const LOD1_MAGIC = 0x4C4F4431; // "LOD1"
const LOD2_MAGIC = 0x4C4F4432; // "LOD2"
const MIN_TRIS_FOR_LOD = 500; // Don't generate LODs for very simple meshes

// ── GLB Parser (reused from collision_mesh_generator) ────────────────────

function parseGLBMesh(buffer: Buffer): {
    positions: Float32Array; indices: Uint32Array;
    normals: Float32Array; uvs: Float32Array;
} | null {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== 0x46546C67) return null;

    const jsonChunkLength = view.getUint32(12, true);
    const jsonChunkType = view.getUint32(16, true);
    if (jsonChunkType !== 0x4E4F534A) return null;
    const jsonBytes = buffer.subarray(20, 20 + jsonChunkLength);
    const gltf = JSON.parse(jsonBytes.toString('utf-8'));

    const binOffset = 20 + jsonChunkLength;
    let binData: Buffer;
    if (binOffset < buffer.length) {
        const binChunkLength = view.getUint32(binOffset, true);
        binData = buffer.subarray(binOffset + 8, binOffset + 8 + binChunkLength);
    } else {
        binData = Buffer.alloc(0);
    }

    if (!gltf.meshes?.length) return null;

    const worldMatrices = computeNodeWorldMatrices(gltf);
    const processedNodes = new Set<number>();
    const nodesToProcess: number[] = [];
    if (gltf.scenes?.length) {
        const sceneIdx = gltf.scene ?? 0;
        const scene = gltf.scenes[sceneIdx];
        if (scene?.nodes) {
            const collect = (idx: number) => {
                if (processedNodes.has(idx)) return;
                processedNodes.add(idx);
                nodesToProcess.push(idx);
                const node = gltf.nodes[idx];
                if (node.children) for (const c of node.children) collect(c);
            };
            for (const r of scene.nodes) collect(r);
        }
    } else if (gltf.nodes) {
        for (let i = 0; i < gltf.nodes.length; i++) nodesToProcess.push(i);
    }

    const allPositions: Float32Array[] = [];
    const allNormals: Float32Array[] = [];
    const allUvs: Float32Array[] = [];
    const allIndices: number[] = [];
    let vertexOffset = 0;

    for (const nodeIdx of nodesToProcess) {
        const node = gltf.nodes[nodeIdx];
        if (node.mesh === undefined) continue;
        const meshDef = gltf.meshes[node.mesh];
        if (!meshDef?.primitives) continue;
        const m = worldMatrices[nodeIdx];

        for (const prim of meshDef.primitives) {
            const posIdx = prim.attributes?.POSITION;
            if (posIdx === undefined) continue;

            const rawPos = getAccessorData(gltf, binData, posIdx) as Float32Array;
            const vertCount = rawPos.length / 3;

            // Transform positions and normals
            const positions = new Float32Array(vertCount * 3);
            const normals = new Float32Array(vertCount * 3);
            const rawNormals = prim.attributes.NORMAL !== undefined
                ? getAccessorData(gltf, binData, prim.attributes.NORMAL) as Float32Array
                : new Float32Array(vertCount * 3);

            for (let i = 0; i < vertCount; i++) {
                const px = rawPos[i*3], py = rawPos[i*3+1], pz = rawPos[i*3+2];
                positions[i*3]   = m[0]*px + m[4]*py + m[8]*pz + m[12];
                positions[i*3+1] = m[1]*px + m[5]*py + m[9]*pz + m[13];
                positions[i*3+2] = m[2]*px + m[6]*py + m[10]*pz + m[14];

                const nx = rawNormals[i*3], ny = rawNormals[i*3+1], nz = rawNormals[i*3+2];
                let tnx = m[0]*nx + m[4]*ny + m[8]*nz;
                let tny = m[1]*nx + m[5]*ny + m[9]*nz;
                let tnz = m[2]*nx + m[6]*ny + m[10]*nz;
                const len = Math.sqrt(tnx*tnx + tny*tny + tnz*tnz);
                if (len > 1e-6) { tnx/=len; tny/=len; tnz/=len; }
                normals[i*3] = tnx; normals[i*3+1] = tny; normals[i*3+2] = tnz;
            }

            let uvs: Float32Array;
            if (prim.attributes.TEXCOORD_0 !== undefined) {
                uvs = getAccessorData(gltf, binData, prim.attributes.TEXCOORD_0) as Float32Array;
            } else {
                uvs = new Float32Array(vertCount * 2);
            }

            allPositions.push(positions);
            allNormals.push(normals);
            allUvs.push(uvs);

            if (prim.indices !== undefined) {
                const idx = getAccessorData(gltf, binData, prim.indices);
                for (let i = 0; i < idx.length; i++) allIndices.push(idx[i] + vertexOffset);
            } else {
                for (let i = 0; i < vertCount; i++) allIndices.push(i + vertexOffset);
            }
            vertexOffset += vertCount;
        }
    }

    if (allPositions.length === 0) return null;

    // Merge arrays
    const mergeF32 = (arrs: Float32Array[]) => {
        let len = 0; for (const a of arrs) len += a.length;
        const r = new Float32Array(len); let off = 0;
        for (const a of arrs) { r.set(a, off); off += a.length; }
        return r;
    };

    const positions = mergeF32(allPositions);
    const normals = mergeF32(allNormals);
    const uvs = mergeF32(allUvs);

    // Auto-center (same as glb_loader.ts)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i+1], z = positions[i+2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (isFinite(minX)) {
        const offX = (minX+maxX)/2, offY = minY, offZ = (minZ+maxZ)/2;
        if (Math.abs(offX) > 0.001 || Math.abs(offY) > 0.001 || Math.abs(offZ) > 0.001) {
            for (let i = 0; i < positions.length; i += 3) {
                positions[i] -= offX; positions[i+1] -= offY; positions[i+2] -= offZ;
            }
        }
    }

    return { positions, indices: new Uint32Array(allIndices), normals, uvs };
}

// ── Decimation with normals + UVs ────────────────────────────────────────

function decimateMeshFull(
    positions: Float32Array, indices: Uint32Array,
    normals: Float32Array, uvs: Float32Array,
    targetTriangles: number,
): { positions: Float32Array; indices: Uint32Array; normals: Float32Array; uvs: Float32Array } {
    const vertCount = positions.length / 3;
    const triCount = indices.length / 3;
    if (triCount <= targetTriangles) {
        return { positions: new Float32Array(positions), indices: new Uint32Array(indices),
                 normals: new Float32Array(normals), uvs: new Float32Array(uvs) };
    }

    // Compute area-weighted vertex normals for clustering
    const vnormals = new Float32Array(vertCount * 3);
    for (let f = 0; f < triCount; f++) {
        const i0=indices[f*3], i1=indices[f*3+1], i2=indices[f*3+2];
        const ax=positions[i1*3]-positions[i0*3], ay=positions[i1*3+1]-positions[i0*3+1], az=positions[i1*3+2]-positions[i0*3+2];
        const bx=positions[i2*3]-positions[i0*3], by=positions[i2*3+1]-positions[i0*3+1], bz=positions[i2*3+2]-positions[i0*3+2];
        const nx=ay*bz-az*by, ny=az*bx-ax*bz, nz=ax*by-ay*bx;
        vnormals[i0*3]+=nx; vnormals[i0*3+1]+=ny; vnormals[i0*3+2]+=nz;
        vnormals[i1*3]+=nx; vnormals[i1*3+1]+=ny; vnormals[i1*3+2]+=nz;
        vnormals[i2*3]+=nx; vnormals[i2*3+1]+=ny; vnormals[i2*3+2]+=nz;
    }
    for (let i = 0; i < vertCount; i++) {
        const o = i*3;
        const len = Math.sqrt(vnormals[o]*vnormals[o]+vnormals[o+1]*vnormals[o+1]+vnormals[o+2]*vnormals[o+2]);
        if (len > 1e-8) { vnormals[o]/=len; vnormals[o+1]/=len; vnormals[o+2]/=len; }
    }

    // Bounding box
    let minX=Infinity, minY=Infinity, minZ=Infinity, maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x=positions[i], y=positions[i+1], z=positions[i+2];
        if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;if(z<minZ)minZ=z;if(z>maxZ)maxZ=z;
    }

    const NRES=2, NSIDE=5, NBUCKETS=125;
    const vertexRemap = new Int32Array(vertCount);

    const computeCluster = (gridRes: number): number => {
        const cellX=(maxX-minX)/gridRes||1, cellY=(maxY-minY)/gridRes||1, cellZ=(maxZ-minZ)/gridRes||1;
        const gr1=gridRes+1;
        const clusterIds = new Map<number, number>(); let nextId=0;
        for (let i = 0; i < vertCount; i++) {
            const gx=Math.min(Math.floor((positions[i*3]-minX)/cellX),gridRes-1);
            const gy=Math.min(Math.floor((positions[i*3+1]-minY)/cellY),gridRes-1);
            const gz=Math.min(Math.floor((positions[i*3+2]-minZ)/cellZ),gridRes-1);
            const qnx=Math.round(vnormals[i*3]*NRES)+NRES;
            const qny=Math.round(vnormals[i*3+1]*NRES)+NRES;
            const qnz=Math.round(vnormals[i*3+2]*NRES)+NRES;
            const key=((gx*gr1+gy)*gr1+gz)*NBUCKETS+(qnx*NSIDE+qny)*NSIDE+qnz;
            let id=clusterIds.get(key);
            if(id===undefined){id=nextId++;clusterIds.set(key,id);}
            vertexRemap[i]=id;
        }
        let count=0;
        for(let f=0;f<triCount;f++){
            const a=vertexRemap[indices[f*3]],b=vertexRemap[indices[f*3+1]],c=vertexRemap[indices[f*3+2]];
            if(a!==b&&b!==c&&a!==c)count++;
        }
        return count;
    };

    // Binary search for grid resolution
    let low=4, high=500, bestGridRes=low, bestDiff=Infinity;
    for(let iter=0;iter<20&&low<=high;iter++){
        const gridRes=Math.floor((low+high)/2);
        const resultTris=computeCluster(gridRes);
        const diff=Math.abs(resultTris-targetTriangles);
        if(diff<bestDiff){bestDiff=diff;bestGridRes=gridRes;}
        if(resultTris<targetTriangles*0.9)low=gridRes+1;
        else if(resultTris>targetTriangles*1.1)high=gridRes-1;
        else{bestGridRes=gridRes;break;}
    }

    // Final pass with normals + UVs
    const cellX=(maxX-minX)/bestGridRes||1, cellY=(maxY-minY)/bestGridRes||1, cellZ=(maxZ-minZ)/bestGridRes||1;
    const gr1=bestGridRes+1;
    const cellMap = new Map<number, {
        sumX:number;sumY:number;sumZ:number;
        sumNX:number;sumNY:number;sumNZ:number;
        sumU:number;sumV:number;
        count:number;newIdx:number
    }>();
    let newVertCount=0;

    for (let i = 0; i < vertCount; i++) {
        const x=positions[i*3],y=positions[i*3+1],z=positions[i*3+2];
        const gx=Math.min(Math.floor((x-minX)/cellX),bestGridRes-1);
        const gy=Math.min(Math.floor((y-minY)/cellY),bestGridRes-1);
        const gz=Math.min(Math.floor((z-minZ)/cellZ),bestGridRes-1);
        const qnx=Math.round(vnormals[i*3]*NRES)+NRES;
        const qny=Math.round(vnormals[i*3+1]*NRES)+NRES;
        const qnz=Math.round(vnormals[i*3+2]*NRES)+NRES;
        const key=((gx*gr1+gy)*gr1+gz)*NBUCKETS+(qnx*NSIDE+qny)*NSIDE+qnz;
        let cell=cellMap.get(key);
        if(!cell){cell={sumX:0,sumY:0,sumZ:0,sumNX:0,sumNY:0,sumNZ:0,sumU:0,sumV:0,count:0,newIdx:newVertCount++};cellMap.set(key,cell);}
        cell.sumX+=x; cell.sumY+=y; cell.sumZ+=z;
        cell.sumNX+=normals[i*3]; cell.sumNY+=normals[i*3+1]; cell.sumNZ+=normals[i*3+2];
        cell.sumU+=uvs[i*2]; cell.sumV+=uvs[i*2+1];
        cell.count++;
        vertexRemap[i]=cell.newIdx;
    }

    const newPositions = new Float32Array(newVertCount*3);
    const newNormals = new Float32Array(newVertCount*3);
    const newUvs = new Float32Array(newVertCount*2);
    for (const cell of cellMap.values()) {
        const idx3=cell.newIdx*3, idx2=cell.newIdx*2;
        newPositions[idx3]=cell.sumX/cell.count;
        newPositions[idx3+1]=cell.sumY/cell.count;
        newPositions[idx3+2]=cell.sumZ/cell.count;
        // Re-normalize averaged normal
        let nx=cell.sumNX, ny=cell.sumNY, nz=cell.sumNZ;
        const nlen=Math.sqrt(nx*nx+ny*ny+nz*nz);
        if(nlen>1e-8){nx/=nlen;ny/=nlen;nz/=nlen;}
        newNormals[idx3]=nx; newNormals[idx3+1]=ny; newNormals[idx3+2]=nz;
        newUvs[idx2]=cell.sumU/cell.count; newUvs[idx2+1]=cell.sumV/cell.count;
    }

    const newIndicesArr: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a=vertexRemap[indices[i]], b=vertexRemap[indices[i+1]], c=vertexRemap[indices[i+2]];
        if(a!==b&&b!==c&&a!==c) newIndicesArr.push(a,b,c);
    }

    return { positions: newPositions, indices: new Uint32Array(newIndicesArr), normals: newNormals, uvs: newUvs };
}

// ── Write LOD binary ─────────────────────────────────────────────────────

function writeLODBin(filePath: string, magic: number, positions: Float32Array, indices: Uint32Array, normals: Float32Array, uvs: Float32Array): void {
    const headerSize = 24; // 6 × 4 bytes
    const posBytes = positions.length * 4;
    const idxBytes = indices.length * 4;
    const nrmBytes = normals.length * 4;
    const uvBytes = uvs.length * 4;
    const buf = Buffer.alloc(headerSize + posBytes + idxBytes + nrmBytes + uvBytes);

    buf.writeUInt32LE(magic, 0);
    buf.writeUInt32LE(VERSION, 4);
    buf.writeUInt32LE(positions.length, 8);
    buf.writeUInt32LE(indices.length, 12);
    buf.writeUInt32LE(normals.length, 16);
    buf.writeUInt32LE(uvs.length, 20);

    let off = headerSize;
    Buffer.from(positions.buffer, positions.byteOffset, posBytes).copy(buf, off); off += posBytes;
    Buffer.from(indices.buffer, indices.byteOffset, idxBytes).copy(buf, off); off += idxBytes;
    Buffer.from(normals.buffer, normals.byteOffset, nrmBytes).copy(buf, off); off += nrmBytes;
    Buffer.from(uvs.buffer, uvs.byteOffset, uvBytes).copy(buf, off);

    fs.writeFileSync(filePath, buf);
}

// ── Node world matrices (same as collision_mesh_generator) ───────────────

function computeNodeWorldMatrices(gltf: any): Float64Array[] {
    const nodes: any[] = gltf.nodes ?? [];
    const matrices: Float64Array[] = new Array(nodes.length);
    const parentOf = new Int32Array(nodes.length).fill(-1);
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].children) for (const c of nodes[i].children) parentOf[c] = i;
    }
    function localMatrix(node: any): Float64Array {
        const m = new Float64Array(16);
        if (node.matrix) { for (let i = 0; i < 16; i++) m[i] = node.matrix[i]; return m; }
        const t=node.translation??[0,0,0], r=node.rotation??[0,0,0,1], s=node.scale??[1,1,1];
        const x=r[0],y=r[1],z=r[2],w=r[3];
        const x2=x+x,y2=y+y,z2=z+z;
        const xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;
        m[0]=(1-(yy+zz))*s[0];m[1]=(xy+wz)*s[0];m[2]=(xz-wy)*s[0];m[3]=0;
        m[4]=(xy-wz)*s[1];m[5]=(1-(xx+zz))*s[1];m[6]=(yz+wx)*s[1];m[7]=0;
        m[8]=(xz+wy)*s[2];m[9]=(yz-wx)*s[2];m[10]=(1-(xx+yy))*s[2];m[11]=0;
        m[12]=t[0];m[13]=t[1];m[14]=t[2];m[15]=1;
        return m;
    }
    function mul(a: Float64Array, b: Float64Array): Float64Array {
        const r = new Float64Array(16);
        for(let col=0;col<4;col++)for(let row=0;row<4;row++)
            r[col*4+row]=a[0*4+row]*b[col*4+0]+a[1*4+row]*b[col*4+1]+a[2*4+row]*b[col*4+2]+a[3*4+row]*b[col*4+3];
        return r;
    }
    function getWorldMatrix(idx: number): Float64Array {
        if(matrices[idx])return matrices[idx];
        const local=localMatrix(nodes[idx]);
        matrices[idx]=parentOf[idx]<0?local:mul(getWorldMatrix(parentOf[idx]),local);
        return matrices[idx];
    }
    for(let i=0;i<nodes.length;i++)getWorldMatrix(i);
    return matrices;
}

function getAccessorData(gltf: any, binData: Buffer, accessorIdx: number): Float32Array | Uint16Array | Uint32Array {
    const accessor = gltf.accessors[accessorIdx];
    const bufferView = gltf.bufferViews[accessor.bufferView];
    const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const count = accessor.count;
    const typeCounts: Record<string, number> = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT4:16 };
    const numComponents = typeCounts[accessor.type] ?? 1;
    const totalElements = count * numComponents;
    const slice = binData.subarray(byteOffset, byteOffset + totalElements * 4);
    const ab = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    switch (accessor.componentType) {
        case 5126: return new Float32Array(ab, 0, totalElements);
        case 5123: {
            const s = binData.subarray(byteOffset, byteOffset + totalElements * 2);
            return new Uint16Array(s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength), 0, totalElements);
        }
        case 5125: return new Uint32Array(ab, 0, totalElements);
        case 5121: {
            const bytes = binData.subarray(byteOffset, byteOffset + totalElements);
            const result = new Uint32Array(totalElements);
            for (let i = 0; i < totalElements; i++) result[i] = bytes[i];
            return result;
        }
        default: return new Float32Array(ab, 0, totalElements);
    }
}

// ── File walker ──────────────────────────────────────────────────────────

function walkGLBFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'thumbnails' && entry.name !== 'generated' && entry.name !== 'previews') {
            results.push(...walkGLBFiles(full));
        } else if (entry.name.endsWith('.glb')) {
            results.push(full);
        }
    }
    return results;
}

// ── Main ─────────────────────────────────────────────────────────────────

export async function generateLODs(assetsDir: string): Promise<void> {
    if (!fs.existsSync(assetsDir)) return;

    const glbFiles = walkGLBFiles(assetsDir);
    if (glbFiles.length === 0) return;

    let generated = 0, skipped = 0, tooSimple = 0, failed = 0;

    for (const glbPath of glbFiles) {
        const lod1Path = glbPath.replace(/\.glb$/i, '.lod1.bin');
        const lod2Path = glbPath.replace(/\.glb$/i, '.lod2.bin');

        if (fs.existsSync(lod1Path) && fs.existsSync(lod2Path)) {
            skipped++;
            continue;
        }

        try {
            const buffer = fs.readFileSync(glbPath);
            const mesh = parseGLBMesh(buffer);
            if (!mesh || mesh.positions.length === 0 || mesh.indices.length === 0) { failed++; continue; }

            const triCount = mesh.indices.length / 3;
            if (triCount < MIN_TRIS_FOR_LOD) { tooSimple++; continue; }

            // LOD1: ~25% triangles
            if (!fs.existsSync(lod1Path)) {
                const target1 = Math.max(100, Math.floor(triCount * 0.25));
                const lod1 = decimateMeshFull(mesh.positions, mesh.indices, mesh.normals, mesh.uvs, target1);
                writeLODBin(lod1Path, LOD1_MAGIC, lod1.positions, lod1.indices, lod1.normals, lod1.uvs);
            }

            // LOD2: ~5% triangles
            if (!fs.existsSync(lod2Path)) {
                const target2 = Math.max(50, Math.floor(triCount * 0.05));
                const lod2 = decimateMeshFull(mesh.positions, mesh.indices, mesh.normals, mesh.uvs, target2);
                writeLODBin(lod2Path, LOD2_MAGIC, lod2.positions, lod2.indices, lod2.normals, lod2.uvs);
            }

            generated++;
        } catch { failed++; }
    }

    const total = glbFiles.length;
    console.log(`[LOD] ${total} GLBs: ${generated} generated, ${skipped} cached, ${tooSimple} too simple, ${failed} failed`);
}
