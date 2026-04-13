// Bay Area bounding box — full detail
// South: San Jose, North: Novato/Vallejo, West: Pacific coast, East: Fremont/Livermore
export const BBOX = {
  south: 37.1,
  north: 37.95,
  west: -122.7,
  east: -121.5,
};

// Data output directory
export const DATA_DIR = new URL("./data/", import.meta.url).pathname;
