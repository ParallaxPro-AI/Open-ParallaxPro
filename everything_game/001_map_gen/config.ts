// Bay Area bounding box — full detail
// South: San Jose, North: Novato/Vallejo, West: Pacific coast, East: Fremont/Livermore
export const BBOX = {
  south: 37.1,
  north: 37.95,
  west: -122.7,
  east: -121.5,
};

// Geofabrik extract — Northern California PBF
// This is ~700MB and covers our area. We clip to BBOX after download.
export const OSM_EXTRACT_URL =
  "https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf";

// Data output directory
export const DATA_DIR = new URL("./data/", import.meta.url).pathname;

// All road types — full detail
export const ROAD_TYPES = [
  "motorway", "motorway_link",
  "trunk", "trunk_link",
  "primary", "primary_link",
  "secondary", "secondary_link",
  "tertiary", "tertiary_link",
  "residential",
  "service",
  "unclassified",
  "living_street",
  "pedestrian",
  "cycleway",
  "footway",
  "path",
  "track",
];

// All layers to extract
export const LAYERS = [
  "roads",
  "buildings",
  "water",
  "parks",
  "railways",
  "bridges",
  "landuse",
  "coastline",
] as const;
