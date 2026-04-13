/**
 * lane_markings.ts — OSM-style road-marking decal generation.
 *
 * Produces yellow center lines, white edge lines, dashed lane dividers,
 * and zebra-stripe crosswalks for road placements. Also exports the
 * intersection-set helpers (posKey / buildIntersectionSet /
 * nearIntersection) because both the decal generator and the curb
 * builder need "is this point near a road intersection?" lookups.
 */

import { DecalInstance } from '../../../engine/frontend/runtime/function/render/render_scene.js';
import { Mat4 } from '../../../engine/frontend/runtime/core/math/mat4.js';

/** Line width in meters for road markings */
const CENTER_LINE_WIDTH = 0.12;
const CENTER_LINE_GAP = 0.10;   // gap between the two yellow center lines
const EDGE_LINE_WIDTH = 0.12;
const DASH_LENGTH = 3.0;        // meters per dash segment
const DASH_GAP = 3.0;           // meters gap between dashes
const DECAL_HEIGHT = 6.0;       // vertical extent of the decal box (tolerance for terrain slope)

/** Minimum road width to receive any lane markings (skip residential/alleys) */
const MIN_MARKING_WIDTH = 7.0;
/** Minimum road width for dashed lane dividers */
const MIN_LANE_DIVIDER_WIDTH = 12.0;
/** Radius around intersection nodes where markings are suppressed */
const INTERSECTION_SUPPRESS_RADIUS = 12.0;

/** Yellow double center line color (retroreflective brightness) */
const YELLOW: [number, number, number, number] = [0.90, 0.78, 0.15, 0.92];
/** White edge/lane line color */
const WHITE: [number, number, number, number] = [0.95, 0.95, 0.95, 0.90];

/** Quantize a position to a 1m grid cell key for fast intersection detection */
export function posKey(x: number, z: number): string {
    return `${Math.round(x)}_${Math.round(z)}`;
}

/** Build a set of intersection points where 2+ roads meet */
export function buildIntersectionSet(placements: any[]): Set<string> {
    const nodeCounts = new Map<string, number>();

    for (const p of placements) {
        if (p.type !== 'road') continue;
        const pts = p.points;
        if (!pts || pts.length < 2) continue;

        const visited = new Set<string>();

        for (let i = 0; i < pts.length; i++) {
            const key = posKey(pts[i][0], pts[i][2]);
            if (!visited.has(key)) {
                visited.add(key);
                nodeCounts.set(key, (nodeCounts.get(key) || 0) + 1);
            }
        }

        // Sample along segments at ~1m intervals to detect T-intersections
        // where another road's endpoint meets this road mid-segment
        for (let i = 0; i < pts.length - 1; i++) {
            const x0 = pts[i][0], z0 = pts[i][2];
            const x1 = pts[i + 1][0], z1 = pts[i + 1][2];
            const sdx = x1 - x0, sdz = z1 - z0;
            const segLen = Math.sqrt(sdx * sdx + sdz * sdz);
            if (segLen < 1.0) continue;

            const steps = Math.ceil(segLen);
            for (let s = 1; s < steps; s++) {
                const t = s / steps;
                const key = posKey(x0 + sdx * t, z0 + sdz * t);
                if (!visited.has(key)) {
                    visited.add(key);
                    nodeCounts.set(key, (nodeCounts.get(key) || 0) + 1);
                }
            }
        }
    }

    const intersections = new Set<string>();
    for (const [key, count] of nodeCounts) {
        if (count >= 2) intersections.add(key);
    }
    return intersections;
}

/** Check if a point is within radius of any intersection node */
export function nearIntersection(
    x: number, z: number, radius: number, intersections: Set<string>,
): boolean {
    const r = Math.ceil(radius);
    const cx = Math.round(x), cz = Math.round(z);
    for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
            if (intersections.has(`${cx + dx}_${cz + dz}`)) {
                const ix = cx + dx, iz = cz + dz;
                if ((x - ix) ** 2 + (z - iz) ** 2 <= radius * radius) return true;
            }
        }
    }
    return false;
}

/**
 * Generate per-chunk road marking decals.
 *
 * @param placements    Road placements for this chunk.
 * @param getTerrainHeight  Optional terrain height sampler; falls back to
 *                          interpolated road vertex Y when null.
 * @param neighborPlacements  Adjacent chunk placements used to build the
 *                            intersection set so boundary roads are handled
 *                            correctly.
 */
export function generateLaneMarkingDecals(
    placements: any[],
    getTerrainHeight: ((x: number, z: number) => number) | null,
    neighborPlacements?: any[],
): DecalInstance[] {
    const decals: DecalInstance[] = [];

    // Build intersection set from this chunk AND neighbors so roads passing
    // through without a vertex in this chunk are still detected
    const allPlacements = neighborPlacements
        ? placements.concat(neighborPlacements)
        : placements;
    const intersections = buildIntersectionSet(allPlacements);

    for (const p of placements) {
        if (p.type !== 'road') continue;
        const pts = p.points;
        if (!pts || pts.length < 2) continue;
        const roadWidth = p.width || 6;

        if (roadWidth < MIN_MARKING_WIDTH) continue;

        const halfW = roadWidth / 2;

        for (let i = 0; i < pts.length - 1; i++) {
            const x0 = pts[i][0], z0 = pts[i][2];
            const x1 = pts[i + 1][0], z1 = pts[i + 1][2];
            const dx = x1 - x0, dz = z1 - z0;
            const segLen = Math.sqrt(dx * dx + dz * dz);
            if (segLen < 0.5) continue;

            const fwdX = dx / segLen, fwdZ = dz / segLen;
            const perpX = -fwdZ, perpZ = fwdX;
            const angle = Math.atan2(fwdX, fwdZ);

            // Walk along the segment, placing markings in runs between intersections
            const step = 2.0;
            let t = 0;
            while (t < segLen) {
                const runStart = t;
                while (t < segLen) {
                    const px = x0 + fwdX * t;
                    const pz = z0 + fwdZ * t;
                    if (nearIntersection(px, pz, INTERSECTION_SUPPRESS_RADIUS, intersections)) break;
                    t += step;
                }
                const runEnd = Math.min(t, segLen);
                const runLen = runEnd - runStart;

                if (runLen < 1.0) {
                    t += step;
                    continue;
                }

                // Subdivide the run into pieces so each solid-line decal is
                // positioned at an interpolated height rather than the whole-run
                // midpoint. On hilly terrain this prevents the ends from being
                // clipped by the decal box's local-Y bounds.
                const MAX_PIECE = 15.0; // meters per solid-line decal
                const y0seg = pts[i][1], y1seg = pts[i + 1][1];
                const off1 = CENTER_LINE_GAP * 0.5 + CENTER_LINE_WIDTH * 0.5;
                const edgeOff = halfW - EDGE_LINE_WIDTH * 0.5 - 0.05;

                let rt = runStart;
                while (rt < runEnd) {
                    const subEnd = Math.min(rt + MAX_PIECE, runEnd);
                    const subLen = subEnd - rt;
                    const midT = (rt + subEnd) * 0.5;
                    const subX = x0 + fwdX * midT;
                    const subZ = z0 + fwdZ * midT;
                    const subY = getTerrainHeight
                        ? getTerrainHeight(subX, subZ) + 0.02
                        : y0seg + (y1seg - y0seg) * (midT / segLen) + 0.02;

                    // Yellow double center line
                    decals.push(makeLineDecal(subX + perpX * off1, subY, subZ + perpZ * off1, angle, CENTER_LINE_WIDTH, subLen, YELLOW));
                    decals.push(makeLineDecal(subX - perpX * off1, subY, subZ - perpZ * off1, angle, CENTER_LINE_WIDTH, subLen, YELLOW));

                    // White edge lines
                    decals.push(makeLineDecal(subX + perpX * edgeOff, subY, subZ + perpZ * edgeOff, angle, EDGE_LINE_WIDTH, subLen, WHITE));
                    decals.push(makeLineDecal(subX - perpX * edgeOff, subY, subZ - perpZ * edgeOff, angle, EDGE_LINE_WIDTH, subLen, WHITE));

                    // Dashed lane dividers per sub-piece (preserves per-dash height sampling)
                    if (roadWidth >= MIN_LANE_DIVIDER_WIDTH) {
                        const laneWidth = halfW / Math.round(halfW / 3.5);
                        for (let lane = 1; lane * laneWidth < halfW - 0.5; lane++) {
                            const lo = lane * laneWidth;
                            pushDashedDecals(decals,
                                x0 + fwdX * rt + perpX * lo, z0 + fwdZ * rt + perpZ * lo,
                                x0 + fwdX * subEnd + perpX * lo, z0 + fwdZ * subEnd + perpZ * lo,
                                angle, subY, getTerrainHeight,
                            );
                            pushDashedDecals(decals,
                                x0 + fwdX * rt - perpX * lo, z0 + fwdZ * rt - perpZ * lo,
                                x0 + fwdX * subEnd - perpX * lo, z0 + fwdZ * subEnd - perpZ * lo,
                                angle, subY, getTerrainHeight,
                            );
                        }
                    }

                    rt += MAX_PIECE;
                }

                t += step;
            }
        }
    }

    // ── Crosswalk decals at intersections ────────────────────────────────
    const CROSSWALK_STRIPE_W = 0.5;   // stripe thickness
    const CROSSWALK_STRIPE_GAP = 0.5; // gap between stripes
    const CROSSWALK_DEPTH = 3.0;      // stripe length (along road direction)
    const CROSSWALK_OFFSET = 6.0;     // distance back from intersection center

    // Collect approach directions per intersection point
    const intApproaches = new Map<string, { x: number; z: number; dirs: { dx: number; dz: number; width: number }[] }>();

    for (const p of placements) {
        if (p.type !== 'road') continue;
        const pts = p.points;
        if (!pts || pts.length < 2) continue;
        const roadWidth = p.width || 6;
        if (roadWidth < MIN_MARKING_WIDTH) continue;

        for (let i = 0; i < pts.length; i++) {
            const key = posKey(pts[i][0], pts[i][2]);
            if (!intersections.has(key)) continue;

            let dx: number, dz: number;
            if (i === 0 && pts.length >= 2) {
                dx = pts[1][0] - pts[0][0];
                dz = pts[1][2] - pts[0][2];
            } else if (i === pts.length - 1 && pts.length >= 2) {
                dx = pts[i - 1][0] - pts[i][0];
                dz = pts[i - 1][2] - pts[i][2];
            } else {
                continue; // mid-point, skip
            }
            const len = Math.sqrt(dx * dx + dz * dz);
            if (len < 0.1) continue;

            let entry = intApproaches.get(key);
            if (!entry) {
                entry = { x: pts[i][0], z: pts[i][2], dirs: [] };
                intApproaches.set(key, entry);
            }
            entry.dirs.push({ dx: dx / len, dz: dz / len, width: roadWidth });
        }
    }

    for (const inter of intApproaches.values()) {
        for (const dir of inter.dirs) {
            // Crosswalk center sits CROSSWALK_OFFSET back from the intersection.
            // Stripes run ALONG the approach direction and stack ACROSS the
            // road width (rotated 90° from a standard zebra layout).
            const cwX = inter.x + dir.dx * CROSSWALK_OFFSET;
            const cwZ = inter.z + dir.dz * CROSSWALK_OFFSET;
            const cwY = getTerrainHeight ? getTerrainHeight(cwX, cwZ) + 0.02 : 0.02;
            const roadAngle = Math.atan2(dir.dx, dir.dz);
            const perpX = -dir.dz, perpZ = dir.dx; // perpendicular to road

            // Fit as many stripes as the road width allows
            const stripePitch = CROSSWALK_STRIPE_W + CROSSWALK_STRIPE_GAP;
            const usable = Math.max(0, dir.width - CROSSWALK_STRIPE_W);
            const stripeCount = Math.max(1, Math.floor(usable / stripePitch) + 1);
            const totalW = stripeCount * CROSSWALK_STRIPE_W + (stripeCount - 1) * CROSSWALK_STRIPE_GAP;
            const startOff = -totalW / 2 + CROSSWALK_STRIPE_W / 2;

            for (let s = 0; s < stripeCount; s++) {
                const offset = startOff + s * stripePitch;
                const sx = cwX + perpX * offset;
                const sz = cwZ + perpZ * offset;
                decals.push(makeLineDecal(sx, cwY, sz, roadAngle, CROSSWALK_STRIPE_W, CROSSWALK_DEPTH, WHITE));
            }
        }
    }

    return decals;
}

function makeLineDecal(
    x: number, y: number, z: number,
    angle: number, width: number, length: number,
    color: [number, number, number, number],
): DecalInstance {
    // local X = across marking (width), local Y = up (height), local Z = along road (length)
    const rot = Mat4.fromRotationY(angle);
    const scl = Mat4.fromScaling(width, DECAL_HEIGHT, length);
    const trn = Mat4.fromTranslation(x, y, z);
    const modelMatrix = trn.multiply(rot).multiply(scl);
    const invModelMatrix = modelMatrix.inverse() ?? Mat4.identity();
    return { modelMatrix, invModelMatrix, color };
}

function pushDashedDecals(
    decals: DecalInstance[],
    x0: number, z0: number, x1: number, z1: number,
    angle: number, fallbackY: number,
    getTerrainHeight: ((x: number, z: number) => number) | null,
): void {
    const dx = x1 - x0, dz = z1 - z0;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (segLen < 0.5) return;
    const fwdX = dx / segLen, fwdZ = dz / segLen;
    const dashPitch = DASH_LENGTH + DASH_GAP;

    let t = 0;
    while (t < segLen) {
        const dashEnd = Math.min(t + DASH_LENGTH, segLen);
        const dashLen = dashEnd - t;
        if (dashLen < 0.3) break;

        const midT = (t + dashEnd) * 0.5;
        const mx = x0 + fwdX * midT;
        const mz = z0 + fwdZ * midT;
        const my = getTerrainHeight ? getTerrainHeight(mx, mz) + 0.02 : fallbackY;

        decals.push(makeLineDecal(mx, my, mz, angle, CENTER_LINE_WIDTH, dashLen, WHITE));
        t += dashPitch;
    }
}
