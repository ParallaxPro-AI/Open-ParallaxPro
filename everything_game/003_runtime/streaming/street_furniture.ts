/**
 * street_furniture.ts — Procedural mesh generators for street-level props.
 *
 * Each function generates geometry at a given world position and rotation.
 * Meshes are grouped by material category:
 *   - metal:       lamp posts, fire hydrants, mailboxes, traffic lights, trash cans, guardrails
 *   - wood:        benches, fences
 *   - signs:       stop signs, construction cones
 *   - signs_green: street name signs
 */

interface FurnitureMeshData {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
}

// ── Cylinder primitive ───────────────────────────────────────────────

function generateCylinder(
    cx: number, baseY: number, cz: number,
    radiusBottom: number, radiusTop: number, height: number,
    segments: number, rotation: number,
): FurnitureMeshData {
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const vertCount = (segments + 1) * 2 + 2;
    const positions = new Float32Array(vertCount * 3);
    const normals   = new Float32Array(vertCount * 3);
    const uvs       = new Float32Array(vertCount * 2);
    const triCount  = segments * 2 + segments * 2;
    const indices   = new Uint32Array(triCount * 3);

    let vi = 0, ii = 0;

    for (let ring = 0; ring <= 1; ring++) {
        const r = ring === 0 ? radiusBottom : radiusTop;
        const y = baseY + ring * height;
        for (let s = 0; s <= segments; s++) {
            const theta = (s / segments) * Math.PI * 2;
            const lx = Math.cos(theta) * r;
            const lz = Math.sin(theta) * r;
            positions[vi * 3]     = lx * cosR - lz * sinR + cx;
            positions[vi * 3 + 1] = y;
            positions[vi * 3 + 2] = lx * sinR + lz * cosR + cz;
            normals[vi * 3]       = Math.cos(theta) * cosR - Math.sin(theta) * sinR;
            normals[vi * 3 + 1]   = 0;
            normals[vi * 3 + 2]   = Math.cos(theta) * sinR + Math.sin(theta) * cosR;
            uvs[vi * 2]     = s / segments;
            uvs[vi * 2 + 1] = ring;
            vi++;
        }
    }

    const ringVerts = segments + 1;
    for (let s = 0; s < segments; s++) {
        const bl = s, br = s + 1, tl = s + ringVerts, tr = s + 1 + ringVerts;
        indices[ii++] = bl; indices[ii++] = tl; indices[ii++] = br;
        indices[ii++] = br; indices[ii++] = tl; indices[ii++] = tr;
    }

    const topCenter = vi;
    positions[vi * 3] = cx; positions[vi * 3 + 1] = baseY + height; positions[vi * 3 + 2] = cz;
    normals[vi * 3] = 0; normals[vi * 3 + 1] = 1; normals[vi * 3 + 2] = 0;
    uvs[vi * 2] = 0.5; uvs[vi * 2 + 1] = 0.5;
    vi++;

    const botCenter = vi;
    positions[vi * 3] = cx; positions[vi * 3 + 1] = baseY; positions[vi * 3 + 2] = cz;
    normals[vi * 3] = 0; normals[vi * 3 + 1] = -1; normals[vi * 3 + 2] = 0;
    uvs[vi * 2] = 0.5; uvs[vi * 2 + 1] = 0.5;
    vi++;

    for (let s = 0; s < segments; s++) {
        indices[ii++] = topCenter; indices[ii++] = ringVerts + s; indices[ii++] = ringVerts + s + 1;
    }
    for (let s = 0; s < segments; s++) {
        indices[ii++] = botCenter; indices[ii++] = s + 1; indices[ii++] = s;
    }

    return {
        positions: positions.slice(0, vi * 3),
        normals:   normals.slice(0, vi * 3),
        uvs:       uvs.slice(0, vi * 2),
        indices:   indices.slice(0, ii),
    };
}

// ── Box primitive ────────────────────────────────────────────────────

function generateBox(
    cx: number, baseY: number, cz: number,
    w: number, h: number, d: number,
    rotation: number,
): FurnitureMeshData {
    const hw = w / 2, hd = d / 2;
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);

    const corners: [number, number][] = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
    const rc = corners.map(([lx, lz]) => [lx * cosR - lz * sinR + cx, lx * sinR + lz * cosR + cz]);

    const y0 = baseY, y1 = baseY + h;
    const [p0, p1, p2, p3] = rc;

    const positions = new Float32Array([
        p3[0],y0,p3[1], p2[0],y0,p2[1], p2[0],y1,p2[1], p3[0],y1,p3[1],
        p1[0],y0,p1[1], p0[0],y0,p0[1], p0[0],y1,p0[1], p1[0],y1,p1[1],
        p2[0],y0,p2[1], p1[0],y0,p1[1], p1[0],y1,p1[1], p2[0],y1,p2[1],
        p0[0],y0,p0[1], p3[0],y0,p3[1], p3[0],y1,p3[1], p0[0],y1,p0[1],
        p3[0],y1,p3[1], p2[0],y1,p2[1], p1[0],y1,p1[1], p0[0],y1,p0[1],
        p0[0],y0,p0[1], p1[0],y0,p1[1], p2[0],y0,p2[1], p3[0],y0,p3[1],
    ]);

    const nFwd   = [ sinR, 0,  cosR];
    const nBack  = [-sinR, 0, -cosR];
    const nRight = [ cosR, 0, -sinR];
    const nLeft  = [-cosR, 0,  sinR];
    const normals = new Float32Array([
        ...nFwd,  ...nFwd,  ...nFwd,  ...nFwd,
        ...nBack, ...nBack, ...nBack, ...nBack,
        ...nRight,...nRight,...nRight,...nRight,
        ...nLeft, ...nLeft, ...nLeft, ...nLeft,
        0,1,0, 0,1,0, 0,1,0, 0,1,0,
        0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0,
    ]);

    const uvs = new Float32Array([
        0,0, w,0, w,h, 0,h,  0,0, w,0, w,h, 0,h,
        0,0, d,0, d,h, 0,h,  0,0, d,0, d,h, 0,h,
        0,0, w,0, w,d, 0,d,  0,0, w,0, w,d, 0,d,
    ]);

    const indices = new Uint32Array([
         0, 1, 2,  0, 2, 3,   4, 5, 6,  4, 6, 7,
         8, 9,10,  8,10,11,  12,13,14, 12,14,15,
        16,17,18, 16,18,19,  20,21,22, 20,22,23,
    ]);

    return { positions, normals, uvs, indices };
}

// ── Octagon plate (stop sign face) ──────────────────────────────────

function generateOctagonPlate(
    cx: number, cy: number, cz: number,
    radius: number, thickness: number,
    rotation: number,
): FurnitureMeshData {
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const halfT   = thickness / 2;
    const frontNx = sinR, frontNz = cosR;

    const octPts: [number, number][] = [];
    for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
        octPts.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }

    const positions: number[] = [];
    const normalsArr: number[] = [];
    const uvsArr: number[] = [];
    const indicesArr: number[] = [];

    const frontCenter = positions.length / 3;
    positions.push(cx + frontNx * halfT, cy, cz + frontNz * halfT);
    normalsArr.push(frontNx, 0, frontNz);
    uvsArr.push(0.5, 0.5);
    for (const [ox, oy] of octPts) {
        positions.push(cx + frontNx * halfT + ox * cosR, cy + oy, cz + frontNz * halfT - ox * sinR);
        normalsArr.push(frontNx, 0, frontNz);
        uvsArr.push(0.5 + ox / radius * 0.5, 0.5 + oy / radius * 0.5);
    }
    for (let i = 0; i < 8; i++) {
        indicesArr.push(frontCenter, frontCenter + 1 + i, frontCenter + 1 + ((i + 1) % 8));
    }

    const backCenter = positions.length / 3;
    positions.push(cx - frontNx * halfT, cy, cz - frontNz * halfT);
    normalsArr.push(-frontNx, 0, -frontNz);
    uvsArr.push(0.5, 0.5);
    for (const [ox, oy] of octPts) {
        positions.push(cx - frontNx * halfT + ox * cosR, cy + oy, cz - frontNz * halfT - ox * sinR);
        normalsArr.push(-frontNx, 0, -frontNz);
        uvsArr.push(0.5 + ox / radius * 0.5, 0.5 + oy / radius * 0.5);
    }
    for (let i = 0; i < 8; i++) {
        indicesArr.push(backCenter, backCenter + 1 + ((i + 1) % 8), backCenter + 1 + i);
    }

    return {
        positions: new Float32Array(positions),
        normals:   new Float32Array(normalsArr),
        uvs:       new Float32Array(uvsArr),
        indices:   new Uint32Array(indicesArr),
    };
}

// ── Merge helper ─────────────────────────────────────────────────────

function mergeFurnitureParts(parts: FurnitureMeshData[]): FurnitureMeshData {
    if (parts.length === 1) return parts[0];
    let totalVerts = 0, totalIdx = 0;
    for (const p of parts) { totalVerts += p.positions.length / 3; totalIdx += p.indices.length; }

    const positions = new Float32Array(totalVerts * 3);
    const normals   = new Float32Array(totalVerts * 3);
    const uvs       = new Float32Array(totalVerts * 2);
    const indices   = new Uint32Array(totalIdx);
    let vOff = 0, iOff = 0, vBase = 0;

    for (const p of parts) {
        const nv = p.positions.length / 3;
        positions.set(p.positions, vOff * 3);
        normals.set(p.normals, vOff * 3);
        uvs.set(p.uvs, vOff * 2);
        for (let i = 0; i < p.indices.length; i++) indices[iOff + i] = p.indices[i] + vBase;
        vOff += nv; iOff += p.indices.length; vBase += nv;
    }

    return { positions, normals, uvs, indices };
}

// ── Public furniture generators ──────────────────────────────────────

const CYL_SEGMENTS = 8;

/** Lamp post: tapered pole + box light housing. Category: metal */
export function generateLampPost(x: number, baseY: number, z: number, rotation: number): FurnitureMeshData {
    const pole  = generateCylinder(x, baseY, z, 0.08, 0.05, 5.0, CYL_SEGMENTS, rotation);
    const light = generateBox(x, baseY + 4.8, z, 0.4, 0.15, 0.2, rotation);
    return mergeFurnitureParts([pole, light]);
}

/** Fire hydrant: body cylinder + dome cap + side nozzles. Category: metal */
export function generateFireHydrant(x: number, baseY: number, z: number, rotation: number): FurnitureMeshData {
    const body   = generateCylinder(x, baseY, z, 0.15, 0.15, 0.50, CYL_SEGMENTS, rotation);
    const cap    = generateCylinder(x, baseY + 0.5, z, 0.15, 0.10, 0.12, CYL_SEGMENTS, rotation);
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const nozzleL = generateCylinder(
        x + cosR * 0.15, baseY + 0.25, z - sinR * 0.15,
        0.04, 0.04, 0.10, 6, rotation + Math.PI / 2,
    );
    const nozzleR = generateCylinder(
        x - cosR * 0.15, baseY + 0.25, z + sinR * 0.15,
        0.04, 0.04, 0.10, 6, rotation + Math.PI / 2,
    );
    return mergeFurnitureParts([body, cap, nozzleL, nozzleR]);
}

/** Mailbox: post + box body. Category: metal */
export function generateMailbox(x: number, baseY: number, z: number, rotation: number): FurnitureMeshData {
    const post = generateCylinder(x, baseY, z, 0.04, 0.04, 0.70, 6, rotation);
    const box  = generateBox(x, baseY + 0.7, z, 0.4, 0.45, 0.35, rotation);
    return mergeFurnitureParts([post, box]);
}

/** Bench: seat slab + backrest + 4 legs. Category: wood */
export function generateBench(x: number, baseY: number, z: number, rotation: number): FurnitureMeshData {
    const seat   = generateBox(x, baseY + 0.42, z, 1.5, 0.06, 0.45, rotation);
    const cosR   = Math.cos(rotation), sinR = Math.sin(rotation);
    const back   = generateBox(x - sinR * 0.2, baseY + 0.48, z - cosR * 0.2, 1.5, 0.4, 0.04, rotation);
    const legs: FurnitureMeshData[] = [];
    for (const [lx, lz] of [[-0.6, 0.18], [0.6, 0.18], [-0.6, -0.18], [0.6, -0.18]] as [number, number][]) {
        legs.push(generateCylinder(
            x + lx * cosR - lz * sinR, baseY,
            z + lx * sinR + lz * cosR,
            0.03, 0.03, 0.42, 6, rotation,
        ));
    }
    return mergeFurnitureParts([seat, back, ...legs]);
}

/** Stop sign: post + octagonal plate. Category: signs */
export function generateStopSign(x: number, baseY: number, z: number, rotation: number): FurnitureMeshData {
    const post  = generateCylinder(x, baseY, z, 0.04, 0.04, 2.2, 6, rotation);
    const plate = generateOctagonPlate(x, baseY + 2.5, z, 0.38, 0.02, rotation);
    return mergeFurnitureParts([post, plate]);
}

/** Street name sign: post + two perpendicular plates. Category: signs_green */
export function generateStreetNameSign(x: number, baseY: number, z: number, rotation: number): FurnitureMeshData {
    const post   = generateCylinder(x, baseY, z, 0.04, 0.04, 2.4, 6, rotation);
    const plate1 = generateBox(x, baseY + 2.4, z, 0.8, 0.18, 0.02, rotation);
    const plate2 = generateBox(x, baseY + 2.2, z, 0.02, 0.18, 0.8, rotation);
    return mergeFurnitureParts([post, plate1, plate2]);
}

/** Traffic light: vertical pole + horizontal arm + signal housing + 3 lights. Category: metal */
export function generateTrafficLight(x: number, baseY: number, z: number, rotation: number): FurnitureMeshData {
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const pole    = generateCylinder(x, baseY, z, 0.08, 0.06, 5.5, CYL_SEGMENTS, rotation);
    const arm     = generateBox(x + sinR * 1.0, baseY + 5.3, z + cosR * 1.0, 0.08, 0.08, 2.0, rotation);
    const sigX    = x + sinR * 2.0, sigZ = z + cosR * 2.0;
    const housing = generateBox(sigX, baseY + 4.7, sigZ, 0.35, 0.9, 0.2, rotation);
    const lights: FurnitureMeshData[] = [];
    for (let li = 0; li < 3; li++) {
        lights.push(generateCylinder(
            sigX + sinR * 0.11, baseY + 5.3 - li * 0.25, sigZ + cosR * 0.11,
            0.08, 0.08, 0.03, 6, rotation,
        ));
    }
    return mergeFurnitureParts([pole, arm, housing, ...lights]);
}

/** Trash can: cylinder body + rim ring. Category: metal */
export function generateTrashCan(x: number, baseY: number, z: number, rotation: number): FurnitureMeshData {
    const body = generateCylinder(x, baseY, z, 0.25, 0.25, 0.85, CYL_SEGMENTS, rotation);
    const rim  = generateCylinder(x, baseY + 0.85, z, 0.27, 0.27, 0.05, CYL_SEGMENTS, rotation);
    return mergeFurnitureParts([body, rim]);
}

/** Construction cone: tapered cylinder on a flat base. Category: signs */
export function generateConstructionCone(x: number, baseY: number, z: number, rotation: number): FurnitureMeshData {
    const base = generateBox(x, baseY, z, 0.35, 0.05, 0.35, rotation);
    const cone = generateCylinder(x, baseY + 0.05, z, 0.15, 0.02, 0.65, CYL_SEGMENTS, rotation);
    return mergeFurnitureParts([base, cone]);
}

/** Fence segment: 2m picket fence (rails + 5 pickets) along local +X. Category: wood */
export function generateFenceSegment(x: number, baseY: number, z: number, rotation: number): FurnitureMeshData {
    const length = 2.0, height = 1.0;
    const parts: FurnitureMeshData[] = [
        generateBox(x, baseY + 0.10, z, length, 0.06, 0.04, rotation),
        generateBox(x, baseY + 0.88, z, length, 0.06, 0.04, rotation),
    ];
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    for (let i = 0; i < 5; i++) {
        const lx = -length / 2 + (i + 0.5) * (length / 5);
        parts.push(generateBox(x + lx * cosR, baseY, z + lx * sinR, 0.08, height, 0.02, rotation));
    }
    return mergeFurnitureParts(parts);
}

/** Guardrail segment: 4m beam on two posts along local +X. Category: metal */
export function generateGuardrailSegment(x: number, baseY: number, z: number, rotation: number): FurnitureMeshData {
    const length = 4.0;
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const beam  = generateBox(x, baseY + 0.70, z, length, 0.20, 0.05, rotation);
    const postL = generateBox(x + (-length / 2 + 0.1) * cosR, baseY, z + (-length / 2 + 0.1) * sinR, 0.12, 0.80, 0.12, rotation);
    const postR = generateBox(x + ( length / 2 - 0.1) * cosR, baseY, z + ( length / 2 - 0.1) * sinR, 0.12, 0.80, 0.12, rotation);
    return mergeFurnitureParts([beam, postL, postR]);
}

// ── Material categories ──────────────────────────────────────────────

export type FurnitureCategory = 'metal' | 'wood' | 'signs' | 'signs_green';

export const FURNITURE_CATEGORY: Record<string, FurnitureCategory> = {
    lamp_post:         'metal',
    fire_hydrant:      'metal',
    mailbox:           'metal',
    trash_can:         'metal',
    traffic_light:     'metal',
    guardrail:         'metal',
    bench:             'wood',
    fence:             'wood',
    stop_sign:         'signs',
    construction_cone: 'signs',
    street_name_sign:  'signs_green',
};

export const FURNITURE_MATERIALS: Record<FurnitureCategory, {
    baseColor: [number, number, number, number];
    metallic: number;
    roughness: number;
}> = {
    metal:       { baseColor: [0.45, 0.45, 0.45, 1], metallic: 0.7, roughness: 0.3 },
    wood:        { baseColor: [0.45, 0.32, 0.18, 1], metallic: 0.0, roughness: 0.8 },
    signs:       { baseColor: [0.80, 0.12, 0.12, 1], metallic: 0.1, roughness: 0.5 },
    signs_green: { baseColor: [0.15, 0.35, 0.15, 1], metallic: 0.1, roughness: 0.5 },
};

export const FURNITURE_GENERATORS: Record<string, (x: number, y: number, z: number, rot: number) => FurnitureMeshData> = {
    lamp_post:         generateLampPost,
    fire_hydrant:      generateFireHydrant,
    mailbox:           generateMailbox,
    trash_can:         generateTrashCan,
    bench:             generateBench,
    traffic_light:     generateTrafficLight,
    stop_sign:         generateStopSign,
    street_name_sign:  generateStreetNameSign,
    fence:             generateFenceSegment,
    guardrail:         generateGuardrailSegment,
    construction_cone: generateConstructionCone,
};
