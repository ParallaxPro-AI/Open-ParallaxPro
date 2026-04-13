/**
 * 002_generate_chunks.ts
 *
 * Reads preprocessed OSM ndjson + elevation data and outputs chunked world data.
 * Each chunk is a CHUNK_SIZE×CHUNK_SIZE (500m) tile containing feature placements
 * (roads, buildings, etc.). Chunk size must match the runtime shader/atlas constants.
 *
 * Usage: npx tsx 002_generate_chunks.ts
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import {
  BBOX,
  METERS_PER_DEG_LAT,
  METERS_PER_DEG_LNG,
  CHUNK_SIZE,
  CHUNKS_X,
  CHUNKS_Z,
  WORLD_WIDTH,
  WORLD_DEPTH,
  ROAD_WIDTHS,
  SIDEWALK_WIDTHS,
} from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREPROCESSED = path.join(__dirname, "preprocessed");
const OUTPUT = path.join(__dirname, "chunks");

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

interface Placement {
  type: string; // "building" | "road" | "water" | "park" | "railway" | "bridge" | "amenity"
  subtype?: string; // OSM tag value (e.g. "commercial", "motorway", "park")
  name?: string;
  position: [number, number, number]; // [x, y, z] in game coords
  size?: [number, number, number]; // [width, height, depth] for buildings
  rotation?: number;
  points?: [number, number, number][]; // for roads/rails — polyline in game coords
  width?: number; // for roads
  polygon?: [number, number][]; // for areas (water, parks) — [x,z] outline
  properties?: Record<string, string>; // extra OSM tags
}

interface Chunk {
  cx: number;
  cz: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  placements: Placement[];
}

// -------------------------------------------------------------------
// Coordinate conversion
// -------------------------------------------------------------------

/** Convert lng/lat to game-world x/z. North = low Z so it renders at visual top. */
function geoToGame(lng: number, lat: number): [number, number] {
  const x = (lng - BBOX.west) * METERS_PER_DEG_LNG;
  const z = (BBOX.north - lat) * METERS_PER_DEG_LAT;
  return [x, z];
}

/** Get chunk indices for a game-world position */
function posToChunk(x: number, z: number): [number, number] {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  return [
    Math.max(0, Math.min(CHUNKS_X - 1, cx)),
    Math.max(0, Math.min(CHUNKS_Z - 1, cz)),
  ];
}

// -------------------------------------------------------------------
// Heightmap
// -------------------------------------------------------------------

let heightmapBuf: Buffer;
let hmWidth: number;
let hmHeight: number;

function loadHeightmap() {
  const metaPath = path.join(PREPROCESSED, "elevation_meta.json");
  const rawPath = path.join(PREPROCESSED, "elevation.raw");

  if (!fs.existsSync(rawPath)) {
    console.error("Error: elevation.raw not found. Run 001_preprocess.sh first.");
    process.exit(1);
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  hmWidth = meta.width;
  hmHeight = meta.height;
  heightmapBuf = fs.readFileSync(rawPath);
  console.log(`[Heightmap] Loaded ${hmWidth}x${hmHeight} (${(heightmapBuf.length / 1e6).toFixed(0)}MB)`);
}

/** Sample elevation at a game-world x/z position. Returns meters above sea level. */
function sampleElevation(x: number, z: number): number {
  // Convert game coords back to pixel coords in the heightmap
  // Heightmap origin is top-left (northwest corner)
  const px = (x / WORLD_WIDTH) * hmWidth;
  const py = (z / WORLD_DEPTH) * hmHeight; // z=0 is north, matching heightmap row 0 = north

  const ix = Math.max(0, Math.min(hmWidth - 1, Math.floor(px)));
  const iy = Math.max(0, Math.min(hmHeight - 1, Math.floor(py)));

  const offset = (iy * hmWidth + ix) * 4; // float32 = 4 bytes
  if (offset + 4 > heightmapBuf.length) return 0;

  const elev = heightmapBuf.readFloatLE(offset);
  // Clamp: water/nodata is often negative or very low
  return Math.max(0, elev);
}

// -------------------------------------------------------------------
// Overture Maps height lookup
// -------------------------------------------------------------------

// Compact lookup: one height (meters) per ~11m grid cell
const overtureHeights = new Map<string, number>();
let overtureLoaded = false;

function overtureGridKey(lng: number, lat: number): string {
  // ~11m cells at Bay Area latitude (0.0001 deg ≈ 11m lat, 9m lng)
  return `${Math.round(lng * 10000)}_${Math.round(lat * 10000)}`;
}

async function loadOvertureHeights() {
  const filePath = path.join(PREPROCESSED, "overture_heights.ndjson");
  if (!fs.existsSync(filePath)) {
    console.log("[Overture Heights] Not found — using default building heights.");
    console.log("  Run 001_map_gen/004_download_overture_heights.sh + 001_preprocess.sh to enable.");
    return;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let count = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      const h = entry.h != null ? entry.h : (entry.nf != null ? entry.nf * 3.5 : null);
      if (h == null || h <= 0) continue;
      const key = overtureGridKey(entry.lng, entry.lat);
      if (!overtureHeights.has(key)) {
        overtureHeights.set(key, h);
      }
      count++;
    } catch {}
  }

  overtureLoaded = true;
  console.log(`[Overture Heights] Loaded ${count.toLocaleString()} entries (${overtureHeights.size.toLocaleString()} grid cells)`);
}

/** Look up Overture height for a building by its geo centroid. Returns meters or null. */
function lookupOvertureHeight(centroidLng: number, centroidLat: number): number | null {
  if (!overtureLoaded) return null;

  const baseLng = Math.round(centroidLng * 10000);
  const baseLat = Math.round(centroidLat * 10000);

  // Check center cell first (most common hit)
  let h = overtureHeights.get(`${baseLng}_${baseLat}`);
  if (h !== undefined) return h;

  // Check 8 neighbors (~11m radius)
  for (let dlng = -1; dlng <= 1; dlng++) {
    for (let dlat = -1; dlat <= 1; dlat++) {
      if (dlng === 0 && dlat === 0) continue;
      h = overtureHeights.get(`${baseLng + dlng}_${baseLat + dlat}`);
      if (h !== undefined) return h;
    }
  }

  return null;
}

// -------------------------------------------------------------------
// OSM traffic control lookup (real traffic signals, stop signs, crossings)
// -------------------------------------------------------------------

// Maps game-coord grid key → traffic control type
const trafficControls = new Map<string, string>();

function trafficGridKey(x: number, z: number): string {
  // ~5m grid cells for matching traffic controls to intersections
  return `${Math.round(x / 5)}_${Math.round(z / 5)}`;
}

async function loadTrafficControls() {
  const filePath = path.join(PREPROCESSED, "traffic_controls.ndjson");
  if (!fs.existsSync(filePath)) {
    console.log("[Traffic Controls] Not found — using procedural placement.");
    return;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let count = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const feature = JSON.parse(trimmed);
      const geom = feature.geometry;
      if (!geom || geom.type !== "Point") continue;
      const props = feature.properties || {};
      const controlType = props.highway; // traffic_signals, stop, crossing, give_way
      if (!controlType) continue;
      const [lng, lat] = geom.coordinates;
      const [x, z] = geoToGame(lng, lat);
      const key = trafficGridKey(x, z);
      // Don't overwrite traffic_signals with lesser types
      const existing = trafficControls.get(key);
      if (!existing || controlType === "traffic_signals") {
        trafficControls.set(key, controlType);
      }
      count++;
    } catch {}
  }

  console.log(`[Traffic Controls] Loaded ${count.toLocaleString()} real positions (${trafficControls.size.toLocaleString()} grid cells)`);
}

/** Look up real traffic control type near a game-world position. */
function lookupTrafficControl(x: number, z: number): string | null {
  if (trafficControls.size === 0) return null;

  const bx = Math.round(x / 5);
  const bz = Math.round(z / 5);

  // Check 5x5 neighborhood (~25m radius)
  // Traffic signal nodes may be offset from detected intersection centers
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const key = `${bx + dx}_${bz + dz}`;
      const ctrl = trafficControls.get(key);
      if (ctrl) return ctrl;
    }
  }
  return null;
}

// -------------------------------------------------------------------
// Chunk grid
// -------------------------------------------------------------------

const chunkGrid = new Map<string, Chunk>();

function chunkKey(cx: number, cz: number): string {
  return `${cx}_${cz}`;
}

function getOrCreateChunk(cx: number, cz: number): Chunk {
  const key = chunkKey(cx, cz);
  let chunk = chunkGrid.get(key);
  if (!chunk) {
    chunk = {
      cx,
      cz,
      bounds: {
        minX: cx * CHUNK_SIZE,
        maxX: (cx + 1) * CHUNK_SIZE,
        minZ: cz * CHUNK_SIZE,
        maxZ: (cz + 1) * CHUNK_SIZE,
      },
      placements: [],
    };
    chunkGrid.set(key, chunk);
  }
  return chunk;
}

// -------------------------------------------------------------------
// Feature processing
// -------------------------------------------------------------------

function processBuilding(feature: any) {
  const geom = feature.geometry;
  if (!geom) return;

  const props = feature.properties || {};
  // Bridge support structures (Golden Gate / Bay Bridge pylons etc.) come
  // through as `building:part=yes` + `man_made=tower` + `tower:type=bridge`
  // + `bridge:support=*`. Force them to a subtype that is NOT in the
  // runtime's HAS_WINDOWS_SUBTYPES whitelist so the shader renders them
  // as plain tinted walls instead of painting fake windows on the towers.
  const isBridgeTower =
    props["tower:type"] === "bridge" ||
    props["bridge:support"] != null ||
    (props["man_made"] === "tower" && props["building:part"] != null);
  const buildingType = isBridgeTower
    ? "bridge_tower"
    : (props.building || "yes");

  // Get polygon coordinates
  let coords: number[][];
  if (geom.type === "Polygon") {
    coords = geom.coordinates[0]; // outer ring
  } else if (geom.type === "MultiPolygon") {
    coords = geom.coordinates[0][0]; // first polygon outer ring
  } else if (geom.type === "Point") {
    const [x, z] = geoToGame(geom.coordinates[0], geom.coordinates[1]);
    const y = sampleElevation(x, z);
    const [cx, cz] = posToChunk(x, z);
    getOrCreateChunk(cx, cz).placements.push({
      type: "building",
      subtype: buildingType,
      name: props.name,
      position: [round(x), round(y), round(z)],
      size: [10, 8, 10], // default size for point buildings
    });
    return;
  } else {
    return;
  }

  // Compute centroid and bounding box of polygon
  let minLng = Infinity, maxLng = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;
  let sumLng = 0, sumLat = 0;

  for (const [lng, lat] of coords) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    sumLng += lng;
    sumLat += lat;
  }

  // Convert polygon to game coords
  const gamePolygon: [number, number][] = coords.map(([lng, lat]: [number, number]) => {
    const [x, z] = geoToGame(lng, lat);
    return [round(x), round(z)] as [number, number];
  });

  // Centroid in game coords
  let sumX = 0, sumZ = 0;
  for (const [x, z] of gamePolygon) { sumX += x; sumZ += z; }
  const cx_game = sumX / gamePolygon.length;
  const cz_game = sumZ / gamePolygon.length;

  // Estimate height: OSM tags → Overture Maps data → type-based default
  let height = 8; // default
  if (props["building:levels"]) {
    height = parseInt(props["building:levels"]) * 3.5;
  } else if (props.height) {
    height = parseFloat(props.height);
  } else {
    // Try Overture Maps real height data
    const centroidLng = sumLng / coords.length;
    const centroidLat = sumLat / coords.length;
    const overtureHeight = lookupOvertureHeight(centroidLng, centroidLat);
    if (overtureHeight != null) {
      height = overtureHeight;
    } else if (buildingType === "commercial" || buildingType === "office") {
      height = 15 + Math.random() * 20;
    } else if (buildingType === "industrial" || buildingType === "warehouse") {
      height = 8 + Math.random() * 6;
    } else if (buildingType === "apartments") {
      height = 12 + Math.random() * 15;
    } else if (buildingType === "residential" || buildingType === "house") {
      height = 6 + Math.random() * 4;
    } else if (buildingType === "church" || buildingType === "cathedral") {
      height = 15 + Math.random() * 10;
    }
  }

  const y = sampleElevation(cx_game, cz_game);
  const [chunkX, chunkZ] = posToChunk(cx_game, cz_game);

  getOrCreateChunk(chunkX, chunkZ).placements.push({
    type: "building",
    subtype: buildingType,
    name: props.name,
    position: [round(cx_game), round(y), round(cz_game)],
    height: round(Math.max(3, height)),
    polygon: gamePolygon,
  });
}

function processRoad(feature: any) {
  const geom = feature.geometry;
  if (!geom || (geom.type !== "LineString" && geom.type !== "MultiLineString")) return;

  const props = feature.properties || {};
  const highway = props.highway || "unclassified";
  const width = ROAD_WIDTHS[highway] ?? 6;

  const lineStrings =
    geom.type === "MultiLineString" ? geom.coordinates : [geom.coordinates];

  for (const coords of lineStrings) {
    if (coords.length < 2) continue;

    const gamePoints: [number, number, number][] = coords.map(
      ([lng, lat]: [number, number]) => {
        const [x, z] = geoToGame(lng, lat);
        const y = sampleElevation(x, z);
        return [round(x), round(y), round(z)] as [number, number, number];
      }
    );

    // Assign road to chunks it passes through
    const visitedChunks = new Set<string>();
    for (const [x, , z] of gamePoints) {
      const [cx, cz] = posToChunk(x, z);
      const key = chunkKey(cx, cz);
      if (visitedChunks.has(key)) continue;
      visitedChunks.add(key);

      // Clip points to this chunk (simplified: just include all points)
      getOrCreateChunk(cx, cz).placements.push({
        type: "road",
        subtype: highway,
        name: props.name,
        position: gamePoints[0],
        points: gamePoints,
        width,
      });
    }
  }
}

function processArea(
  feature: any,
  type: "water" | "park" | "landuse",
  subtypeKey: string
) {
  const geom = feature.geometry;
  if (!geom) return;

  const props = feature.properties || {};
  const subtype =
    props[subtypeKey] || props.natural || props.landuse || props.leisure || type;

  let rings: number[][][];
  if (geom.type === "Polygon") {
    rings = [geom.coordinates[0]];
  } else if (geom.type === "MultiPolygon") {
    rings = geom.coordinates.map((p: number[][][]) => p[0]);
  } else {
    return;
  }

  for (const ring of rings) {
    // Compute centroid
    let sumLng = 0, sumLat = 0;
    for (const [lng, lat] of ring) {
      sumLng += lng;
      sumLat += lat;
    }
    const centLng = sumLng / ring.length;
    const centLat = sumLat / ring.length;
    const [cx_game, cz_game] = geoToGame(centLng, centLat);
    const y = sampleElevation(cx_game, cz_game);
    const [chunkX, chunkZ] = posToChunk(cx_game, cz_game);

    // Convert polygon outline to game coords
    const polygon: [number, number][] = ring.map(([lng, lat]: [number, number]) => {
      const [x, z] = geoToGame(lng, lat);
      return [round(x), round(z)] as [number, number];
    });

    getOrCreateChunk(chunkX, chunkZ).placements.push({
      type,
      subtype,
      name: props.name,
      position: [round(cx_game), round(y), round(cz_game)],
      polygon,
    });
  }
}

function processLinear(feature: any, type: "railway" | "bridge") {
  const geom = feature.geometry;
  if (!geom || (geom.type !== "LineString" && geom.type !== "MultiLineString")) return;

  const props = feature.properties || {};
  const subtype = props.railway || props.bridge || type;

  const lineStrings =
    geom.type === "MultiLineString" ? geom.coordinates : [geom.coordinates];

  for (const coords of lineStrings) {
    if (coords.length < 2) continue;

    const gamePoints: [number, number, number][] = coords.map(
      ([lng, lat]: [number, number]) => {
        const [x, z] = geoToGame(lng, lat);
        const y = sampleElevation(x, z);
        return [round(x), round(y), round(z)] as [number, number, number];
      }
    );

    const visitedChunks = new Set<string>();
    for (const [x, , z] of gamePoints) {
      const [cx, cz] = posToChunk(x, z);
      const key = chunkKey(cx, cz);
      if (visitedChunks.has(key)) continue;
      visitedChunks.add(key);

      getOrCreateChunk(cx, cz).placements.push({
        type,
        subtype,
        name: props.name,
        position: gamePoints[0],
        points: gamePoints,
        width: type === "railway" ? 4 : (ROAD_WIDTHS[props.highway] ?? 10),
      });
    }
  }
}

function processAmenity(feature: any) {
  const geom = feature.geometry;
  if (!geom) return;

  const props = feature.properties || {};
  const subtype = props.amenity || props.tourism || props.shop || props.aeroway || "unknown";

  let lng: number, lat: number;
  if (geom.type === "Point") {
    [lng, lat] = geom.coordinates;
  } else if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
    // Use centroid
    const ring =
      geom.type === "MultiPolygon" ? geom.coordinates[0][0] : geom.coordinates[0];
    let sumLng = 0, sumLat = 0;
    for (const [lo, la] of ring) {
      sumLng += lo;
      sumLat += la;
    }
    lng = sumLng / ring.length;
    lat = sumLat / ring.length;
  } else {
    return;
  }

  const [x, z] = geoToGame(lng, lat);
  const y = sampleElevation(x, z);
  const [cx, cz] = posToChunk(x, z);

  getOrCreateChunk(cx, cz).placements.push({
    type: "amenity",
    subtype,
    name: props.name,
    position: [round(x), round(y), round(z)],
    properties: {
      ...(props.name && { name: props.name }),
      ...(props.amenity && { amenity: props.amenity }),
      ...(props.tourism && { tourism: props.tourism }),
      ...(props.shop && { shop: props.shop }),
    },
  });
}

// -------------------------------------------------------------------
// Stream processing
// -------------------------------------------------------------------

async function processLayer(
  filename: string,
  handler: (feature: any) => void
): Promise<number> {
  const filePath = path.join(PREPROCESSED, filename);
  if (!fs.existsSync(filePath)) {
    console.log(`  Skipping ${filename} (not found)`);
    return 0;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let count = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const feature = JSON.parse(trimmed);
      handler(feature);
      count++;
      if (count % 100_000 === 0) {
        process.stdout.write(`  ${(count / 1000).toFixed(0)}k features...\r`);
      }
    } catch {
      // skip malformed lines
    }
  }

  return count;
}

// -------------------------------------------------------------------
// Street Furniture Placement
// -------------------------------------------------------------------

/** Simple integer hash for deterministic placement jitter */
function hashFurniture(x: number, z: number, salt: number): number {
  let h = ((x * 73856093) ^ (z * 19349669) ^ (salt * 83492791)) | 0;
  h = (((h >>> 16) ^ h) * 0x45d9f3b) | 0;
  h = (((h >>> 16) ^ h) * 0x45d9f3b) | 0;
  return (h >>> 0) & 0xFFFF;
}

interface FurnitureRule {
  subtype: string;
  interval: number;       // meters between placements
  minRoadWidth: number;   // minimum road width to place on
  side: "both" | "right"; // which side(s) of the road
  residentialOnly?: boolean;
}

// Procedural furniture rules removed — only real OSM traffic controls are placed now.

/**
 * Build a set of intersection points where 2+ roads meet (for stop sign placement).
 */
function buildIntersections(chunk: Chunk): Map<string, { x: number; z: number; roadNames: string[] }> {
  const nodeCounts = new Map<string, { x: number; z: number; count: number; names: Set<string> }>();

  for (const p of chunk.placements) {
    if (p.type !== "road") continue;
    const pts = p.points;
    if (!pts || pts.length < 2) continue;

    const visited = new Set<string>();
    for (const pt of pts) {
      const key = `${Math.round(pt[0])}_${Math.round(pt[2])}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const entry = nodeCounts.get(key);
      if (entry) {
        entry.count++;
        if (p.name) entry.names.add(p.name);
      } else {
        const names = new Set<string>();
        if (p.name) names.add(p.name);
        nodeCounts.set(key, { x: pt[0], z: pt[2], count: 1, names });
      }
    }
  }

  const intersections = new Map<string, { x: number; z: number; roadNames: string[] }>();
  for (const [key, entry] of nodeCounts) {
    if (entry.count >= 2) {
      intersections.set(key, { x: entry.x, z: entry.z, roadNames: Array.from(entry.names) });
    }
  }
  return intersections;
}

function processStreetFurniture(chunk: Chunk): void {
  const roads = chunk.placements.filter(p => p.type === "road");
  if (roads.length === 0) return;

  const intersections = buildIntersections(chunk);
  const placed = new Set<string>(); // prevent double-placement at same spot

  // Place stop signs / traffic lights at intersections (from real OSM data)
  for (const inter of intersections.values()) {
    const ix = inter.x, iz = inter.z;
    const iy = sampleElevation(ix, iz) + 0.15;

    // Find the nearest road and compute its direction at the intersection
    let bestRoad: any = null;
    let bestDist = Infinity;
    let bestIdx = 0;
    for (const road of roads) {
      const pts = road.points;
      if (!pts) continue;
      for (let pi = 0; pi < pts.length; pi++) {
        const d = (pts[pi][0] - ix) ** 2 + (pts[pi][2] - iz) ** 2;
        if (d < bestDist) { bestDist = d; bestRoad = road; bestIdx = pi; }
      }
    }
    if (!bestRoad) continue;

    const halfW = (bestRoad.width || 6) / 2;
    const sidewalkW = SIDEWALK_WIDTHS[bestRoad.subtype] ?? 0;
    if (sidewalkW <= 0) continue;

    // Find the max road+sidewalk extent of ALL roads at this intersection
    // so the sign clears every crossing road's visual surface
    let maxExtent = halfW + sidewalkW;
    for (const road of roads) {
      const pts = road.points;
      if (!pts) continue;
      for (const pt of pts) {
        if ((pt[0] - ix) ** 2 + (pt[2] - iz) ** 2 < 25) { // within 5m
          const rHalf = (road.width || 6) / 2;
          const rSW = SIDEWALK_WIDTHS[road.subtype] ?? 0;
          maxExtent = Math.max(maxExtent, rHalf + rSW);
          break;
        }
      }
    }
    const offset = maxExtent + 0.5; // 0.5m past widest road's sidewalk edge

    // Compute road direction at intersection to get perpendicular offset
    const bPts = bestRoad.points;
    let fwdX = 0, fwdZ = 1;
    if (bestIdx < bPts.length - 1) {
      const dx = bPts[bestIdx + 1][0] - bPts[bestIdx][0];
      const dz = bPts[bestIdx + 1][2] - bPts[bestIdx][2];
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.01) { fwdX = dx / len; fwdZ = dz / len; }
    } else if (bestIdx > 0) {
      const dx = bPts[bestIdx][0] - bPts[bestIdx - 1][0];
      const dz = bPts[bestIdx][2] - bPts[bestIdx - 1][2];
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.01) { fwdX = dx / len; fwdZ = dz / len; }
    }
    // Perpendicular to road direction (right side)
    const perpX = -fwdZ, perpZ = fwdX;

    // Use real OSM traffic control data if available, else fall back to road-width heuristic
    const realControl = lookupTrafficControl(ix, iz);
    let signType: string;
    if (realControl === "traffic_signals") {
      signType = "traffic_light";
    } else if (realControl === "stop" || realControl === "give_way") {
      signType = "stop_sign";
    } else if (realControl === "crossing") {
      continue; // crossings don't need a traffic light or stop sign
    } else if (trafficControls.size > 0) {
      continue; // OSM data loaded but no control here — skip (realistic: many intersections have no sign)
    } else {
      // No OSM data at all — fall back to procedural
      const isMajor = (bestRoad.width || 6) >= 10;
      signType = isMajor ? "traffic_light" : "stop_sign";
    }

    // Place on the right side of the road, perpendicular to road direction
    const fx = ix + perpX * offset;
    const fz = iz + perpZ * offset;
    const rot = Math.atan2(fwdX, fwdZ);
    const placeKey = `${signType}_${Math.round(fx)}_${Math.round(fz)}`;
    if (placed.has(placeKey)) continue;
    placed.add(placeKey);

    chunk.placements.push({
      type: "furniture",
      subtype: signType,
      position: [round(fx), round(iy), round(fz)],
      rotation: round(rot),
    });

    // Place street name sign on the opposite side
    if (inter.roadNames.length >= 2) {
      const snx = ix - perpX * offset;
      const snz = iz - perpZ * offset;
      const snKey = `street_name_sign_${Math.round(snx)}_${Math.round(snz)}`;
      if (!placed.has(snKey)) {
        placed.add(snKey);
        chunk.placements.push({
          type: "furniture",
          subtype: "street_name_sign",
          position: [round(snx), round(iy), round(snz)],
          rotation: round(rot + Math.PI),
        });
      }
    }
  }
}

// -------------------------------------------------------------------
// Output
// -------------------------------------------------------------------

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

function writeChunks() {
  fs.mkdirSync(OUTPUT, { recursive: true });

  let totalPlacements = 0;
  let writtenChunks = 0;
  let emptyChunks = 0;

  // Write a world index
  const index: {
    worldWidth: number;
    worldDepth: number;
    chunkSize: number;
    chunksX: number;
    chunksZ: number;
    bbox: typeof BBOX;
    chunks: { cx: number; cz: number; placements: number; file: string }[];
  } = {
    worldWidth: round(WORLD_WIDTH),
    worldDepth: round(WORLD_DEPTH),
    chunkSize: CHUNK_SIZE,
    chunksX: CHUNKS_X,
    chunksZ: CHUNKS_Z,
    bbox: BBOX,
    chunks: [],
  };

  let totalFurniture = 0;
  for (const [, chunk] of chunkGrid) {
    // Generate street furniture before serialization
    const beforeCount = chunk.placements.length;
    processStreetFurniture(chunk);
    totalFurniture += chunk.placements.length - beforeCount;

    if (chunk.placements.length === 0) {
      emptyChunks++;
      continue;
    }

    const filename = `chunk_${chunk.cx}_${chunk.cz}.json`;
    const filePath = path.join(OUTPUT, filename);
    fs.writeFileSync(filePath, JSON.stringify(chunk));

    totalPlacements += chunk.placements.length;
    writtenChunks++;

    index.chunks.push({
      cx: chunk.cx,
      cz: chunk.cz,
      placements: chunk.placements.length,
      file: filename,
    });
  }

  // Write index
  fs.writeFileSync(
    path.join(OUTPUT, "world_index.json"),
    JSON.stringify(index, null, 2)
  );

  console.log("");
  console.log("=== World Generation Complete ===");
  console.log(`World size: ${round(WORLD_WIDTH)}m x ${round(WORLD_DEPTH)}m`);
  console.log(`Chunk grid: ${CHUNKS_X} x ${CHUNKS_Z} (${CHUNK_SIZE}m chunks)`);
  console.log(`Chunks with placements: ${writtenChunks}`);
  console.log(`Empty chunks: ${emptyChunks}`);
  console.log(`Total placements: ${totalPlacements.toLocaleString()}`);
  console.log(`Street furniture: ${totalFurniture.toLocaleString()}`);
  console.log(`Output: ${OUTPUT}/`);
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

async function main() {
  console.log("=== World Chunk Generator ===");
  console.log(`World: ${round(WORLD_WIDTH)}m x ${round(WORLD_DEPTH)}m`);
  console.log(`Chunks: ${CHUNKS_X} x ${CHUNKS_Z} @ ${CHUNK_SIZE}m`);
  console.log("");

  loadHeightmap();
  console.log("");

  await loadOvertureHeights();
  await loadTrafficControls();
  console.log("");

  console.log("[1/7] Processing buildings...");
  const buildings = await processLayer("buildings.ndjson", processBuilding);
  console.log(`  ${buildings.toLocaleString()} buildings processed`);

  // Free Overture height data — only needed for buildings
  overtureHeights.clear();

  console.log("[2/7] Processing roads...");
  const roads = await processLayer("roads.ndjson", processRoad);
  console.log(`  ${roads.toLocaleString()} roads processed`);

  console.log("[3/7] Processing water...");
  const water = await processLayer("water.ndjson", (f) =>
    processArea(f, "water", "natural")
  );
  console.log(`  ${water.toLocaleString()} water features processed`);

  console.log("[4/7] Processing parks...");
  const parks = await processLayer("parks.ndjson", (f) =>
    processArea(f, "park", "leisure")
  );
  console.log(`  ${parks.toLocaleString()} parks processed`);

  console.log("[5/7] Processing railways...");
  const railways = await processLayer("railways.ndjson", (f) =>
    processLinear(f, "railway")
  );
  console.log(`  ${railways.toLocaleString()} railway features processed`);

  console.log("[6/7] Processing bridges...");
  const bridges = await processLayer("bridges.ndjson", (f) =>
    processLinear(f, "bridge")
  );
  console.log(`  ${bridges.toLocaleString()} bridge features processed`);

  console.log("[7/7] Processing amenities...");
  const amenities = await processLayer("amenities.ndjson", processAmenity);
  console.log(`  ${amenities.toLocaleString()} amenities processed`);

  console.log("");
  console.log("Writing chunks...");
  writeChunks();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
