// Bay Area bounding box — must match 001_map_gen
export const BBOX = {
  south: 37.1,
  north: 37.95,
  west: -122.7,
  east: -121.5,
};

// Coordinate conversion constants
// At latitude 37.55 (center of bbox):
//   1 degree lat ≈ 111,000 m
//   1 degree lng ≈ 111,000 * cos(37.55°) ≈ 88,000 m
const CENTER_LAT = (BBOX.south + BBOX.north) / 2;
export const METERS_PER_DEG_LAT = 111_000;
export const METERS_PER_DEG_LNG = 111_000 * Math.cos((CENTER_LAT * Math.PI) / 180);

// World dimensions in meters
export const WORLD_WIDTH = (BBOX.east - BBOX.west) * METERS_PER_DEG_LNG;   // ~70,400m
export const WORLD_DEPTH = (BBOX.north - BBOX.south) * METERS_PER_DEG_LAT; // ~66,600m

// Chunk configuration. Must match the chunkSize assumption baked into
// the runtime shader (terrain_shaders.ts) and the road atlas grid
// constants (road_atlas.ts).
export const CHUNK_SIZE = 500; // meters per chunk side
export const CHUNKS_X = Math.ceil(WORLD_WIDTH / CHUNK_SIZE);
export const CHUNKS_Z = Math.ceil(WORLD_DEPTH / CHUNK_SIZE);

// Heightmap info (from 003_download_elevation.sh output)
export const HEIGHTMAP = {
  width: 12960,
  height: 9180,
  pixelSizeDeg: 0.000092592592593, // degrees per pixel
};

// Road widths in meters by OSM highway type
export const ROAD_WIDTHS: Record<string, number> = {
  motorway: 16,
  motorway_link: 8,
  trunk: 14,
  trunk_link: 7,
  primary: 12,
  primary_link: 6,
  secondary: 10,
  secondary_link: 5,
  tertiary: 8,
  tertiary_link: 4,
  residential: 6,
  service: 4,
  unclassified: 6,
  living_street: 5,
  pedestrian: 4,
  cycleway: 2,
  footway: 2,
  path: 1.5,
  track: 3,
};

// Sidewalk widths in meters by OSM highway type (per side)
export const SIDEWALK_WIDTHS: Record<string, number> = {
  motorway: 0,
  motorway_link: 0,
  trunk: 0,
  trunk_link: 0,
  primary: 3.0,
  primary_link: 2.0,
  secondary: 2.5,
  secondary_link: 1.5,
  tertiary: 2.0,
  tertiary_link: 1.5,
  residential: 1.5,
  service: 1.0,
  unclassified: 1.5,
  living_street: 2.0,
  pedestrian: 0,
  cycleway: 0,
  footway: 0,
  path: 0,
  track: 0,
};

// Paths
export const MAP_GEN_DATA = "../001_map_gen/data";
export const OUTPUT_DIR = "./chunks";
