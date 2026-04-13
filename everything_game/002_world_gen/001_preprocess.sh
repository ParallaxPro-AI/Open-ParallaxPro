#!/bin/bash
# Preprocess raw data into formats optimized for the chunk generator
#
# 1. Re-export GeoJSON layers as newline-delimited JSON (one feature per line)
#    so TypeScript can stream them without loading 1GB into memory
# 2. Convert elevation GeoTIFF to raw float32 binary for direct memory access

set -e

MAP_DATA="$(dirname "$0")/../001_map_gen/data"
OUT="$(dirname "$0")/preprocessed"
mkdir -p "$OUT"

echo "=== Preprocessing for world generation ==="

# --- Convert GeoJSON to newline-delimited GeoJSON (ndjson) ---
LAYERS=("roads" "buildings" "water" "parks" "railways" "bridges" "landuse" "amenities" "traffic_controls")

for layer in "${LAYERS[@]}"; do
  PBF="$MAP_DATA/layers/${layer}.osm.pbf"
  NDJSON="$OUT/${layer}.ndjson"

  if [ ! -f "$PBF" ]; then
    echo "Warning: $PBF not found, skipping $layer"
    continue
  fi

  if [ -f "$NDJSON" ]; then
    echo "[$layer] Already preprocessed, skipping."
    continue
  fi

  echo "[$layer] Exporting to ndjson..."
  # geojsonseq = one GeoJSON Feature per line (RS-delimited)
  # We strip the RS character (0x1e) to get plain ndjson
  osmium export "$PBF" -f geojsonseq 2>/dev/null | tr -d '\036' > "$NDJSON"
  COUNT=$(wc -l < "$NDJSON" | tr -d ' ')
  SIZE=$(ls -lh "$NDJSON" | awk '{print $5}')
  echo "  $COUNT features, $SIZE"
done

# --- Convert elevation GeoTIFF to raw float32 binary ---
ELEV_TIF="$MAP_DATA/elevation/bay_area_elevation.tif"
ELEV_RAW="$OUT/elevation.raw"
ELEV_META="$OUT/elevation_meta.json"

if [ ! -f "$ELEV_TIF" ]; then
  echo "Error: Elevation GeoTIFF not found at $ELEV_TIF"
  exit 1
fi

if [ -f "$ELEV_RAW" ]; then
  echo "[elevation] Already preprocessed, skipping."
else
  echo "[elevation] Converting GeoTIFF to raw float32..."
  gdal_translate -of ENVI -ot Float32 "$ELEV_TIF" "$ELEV_RAW" -q
  ls -lh "$ELEV_RAW"

  # Write metadata for the TypeScript script
  WIDTH=$(gdalinfo "$ELEV_TIF" | grep "Size is" | sed 's/Size is //' | cut -d',' -f1 | tr -d ' ')
  HEIGHT=$(gdalinfo "$ELEV_TIF" | grep "Size is" | sed 's/Size is //' | cut -d',' -f2 | tr -d ' ')
  echo "{\"width\":$WIDTH,\"height\":$HEIGHT,\"dtype\":\"float32\"}" > "$ELEV_META"
  echo "  ${WIDTH}x${HEIGHT} float32 heightmap"
fi

# --- Convert extended elevation GeoTIFF (terrain clipmap horizon scenery) ---
# This heightmap covers the OSM area plus a ~22 km margin on every side so the
# terrain clipmap can render real Bay Area terrain past the OSM boundary. The
# OSM offset (in degrees and meters) is stored in the meta so runtime can
# place the extended heightmap such that the OSM sub-region lands at its
# existing world coords.
EXT_TIF="$MAP_DATA/elevation/bay_area_elevation_extended.tif"
EXT_RAW="$OUT/elevation_extended.raw"
EXT_META="$OUT/elevation_extended_meta.json"

if [ ! -f "$EXT_TIF" ]; then
  echo "[elevation extended] Source not found, skipping."
  echo "  Re-run 001_map_gen/003_download_elevation.sh to produce it."
elif [ -f "$EXT_RAW" ]; then
  echo "[elevation extended] Already preprocessed, skipping."
else
  echo "[elevation extended] Converting GeoTIFF to raw float32..."
  gdal_translate -of ENVI -ot Float32 "$EXT_TIF" "$EXT_RAW" -q
  ls -lh "$EXT_RAW"

  EXT_WIDTH=$(gdalinfo "$EXT_TIF" | grep "Size is" | sed 's/Size is //' | cut -d',' -f1 | tr -d ' ')
  EXT_HEIGHT=$(gdalinfo "$EXT_TIF" | grep "Size is" | sed 's/Size is //' | cut -d',' -f2 | tr -d ' ')

  # Parse geotransform so we can compute the OSM sub-region offset in pixels.
  # gdalinfo emits two paren groups per corner — decimal first, then DMS:
  #   "Upper Left  (-122.9000000,  38.1500000) (122d54' 0.00\"W, 38d 9' 0.00\"N)"
  # We take the first group only.
  EXT_UL=$(gdalinfo "$EXT_TIF" | grep "Upper Left"  | grep -oE '\([^)]*\)' | head -1 | tr -d '() ')
  EXT_LR=$(gdalinfo "$EXT_TIF" | grep "Lower Right" | grep -oE '\([^)]*\)' | head -1 | tr -d '() ')
  EXT_WEST=$(echo "$EXT_UL" | cut -d',' -f1 | tr -d ' ')
  EXT_NORTH=$(echo "$EXT_UL" | cut -d',' -f2 | tr -d ' ')
  EXT_EAST=$(echo "$EXT_LR" | cut -d',' -f1 | tr -d ' ')
  EXT_SOUTH=$(echo "$EXT_LR" | cut -d',' -f2 | tr -d ' ')

  OSM_WEST=-122.7
  OSM_EAST=-121.5
  OSM_NORTH=37.95
  OSM_SOUTH=37.1

  # Meters per degree at bbox center latitude (matches 002_world_gen/config.ts)
  CENTER_LAT="$(python3 -c "print(($OSM_SOUTH+$OSM_NORTH)/2)")"
  M_PER_DEG_LAT=111000
  M_PER_DEG_LNG="$(python3 -c "import math; print(111000*math.cos(math.radians($CENTER_LAT)))")"

  # OSM offset from extended NW corner, in meters
  OSM_OFFSET_X_M="$(python3 -c "print(($OSM_WEST - ($EXT_WEST)) * $M_PER_DEG_LNG)")"
  OSM_OFFSET_Z_M="$(python3 -c "print(($EXT_NORTH - $OSM_NORTH) * $M_PER_DEG_LAT)")"

  # Extended world dimensions in meters
  EXT_WORLD_W_M="$(python3 -c "print(($EXT_EAST - ($EXT_WEST)) * $M_PER_DEG_LNG)")"
  EXT_WORLD_D_M="$(python3 -c "print(($EXT_NORTH - $EXT_SOUTH) * $M_PER_DEG_LAT)")"

  # OSM world dimensions in meters (for consumers that need them)
  OSM_WORLD_W_M="$(python3 -c "print(($OSM_EAST - ($OSM_WEST)) * $M_PER_DEG_LNG)")"
  OSM_WORLD_D_M="$(python3 -c "print(($OSM_NORTH - $OSM_SOUTH) * $M_PER_DEG_LAT)")"

  cat > "$EXT_META" <<EOF
{
  "width": $EXT_WIDTH,
  "height": $EXT_HEIGHT,
  "dtype": "float32",
  "bbox": {
    "west": $EXT_WEST,
    "east": $EXT_EAST,
    "south": $EXT_SOUTH,
    "north": $EXT_NORTH
  },
  "osmBbox": {
    "west": $OSM_WEST,
    "east": $OSM_EAST,
    "south": $OSM_SOUTH,
    "north": $OSM_NORTH
  },
  "worldWidth": $EXT_WORLD_W_M,
  "worldDepth": $EXT_WORLD_D_M,
  "osmWorldWidth": $OSM_WORLD_W_M,
  "osmWorldDepth": $OSM_WORLD_D_M,
  "osmOffsetX": $OSM_OFFSET_X_M,
  "osmOffsetZ": $OSM_OFFSET_Z_M
}
EOF
  echo "  ${EXT_WIDTH}x${EXT_HEIGHT} float32 heightmap (extended)"
  echo "  OSM offset: ${OSM_OFFSET_X_M} m east, ${OSM_OFFSET_Z_M} m south from NW corner"
fi

# --- Extract Overture building heights into compact lookup ---
OVERTURE_RAW="$MAP_DATA/layers/overture_buildings.geojsonseq"
OVERTURE_HEIGHTS="$OUT/overture_heights.ndjson"

if [ ! -f "$OVERTURE_RAW" ]; then
  echo "[overture heights] Source not found, skipping."
  echo "  Run 001_map_gen/004_download_overture_heights.sh to enable real building heights."
elif [ -f "$OVERTURE_HEIGHTS" ]; then
  echo "[overture heights] Already preprocessed, skipping."
else
  echo "[overture heights] Extracting buildings with height data..."
  OVERTURE_RAW="$OVERTURE_RAW" OVERTURE_OUT="$OVERTURE_HEIGHTS" node <<'NODESCRIPT'
const fs = require('fs');
const readline = require('readline');
const rl = readline.createInterface({
  input: fs.createReadStream(process.env.OVERTURE_RAW, { encoding: 'utf-8' }),
  crlfDelay: Infinity,
});
const out = fs.createWriteStream(process.env.OVERTURE_OUT);
let total = 0, kept = 0;
rl.on('line', line => {
  total++;
  try {
    // Strip RS character (0x1e) if present (RFC 8142 GeoJSON Sequence)
    const f = JSON.parse(line.replace(/^\x1e/, ''));
    const p = f.properties || {};
    const h = p.height != null ? p.height : null;
    const nf = p.num_floors != null ? p.num_floors : null;
    if (h == null && nf == null) return;
    const g = f.geometry;
    if (!g) return;
    let c;
    if (g.type === 'Polygon') c = g.coordinates[0];
    else if (g.type === 'MultiPolygon') c = g.coordinates[0][0];
    else return;
    let sx = 0, sy = 0;
    for (const [x, y] of c) { sx += x; sy += y; }
    const n = c.length;
    out.write(JSON.stringify({
      lng: +(sx / n).toFixed(6),
      lat: +(sy / n).toFixed(6),
      h: h,
      nf: nf,
    }) + '\n');
    kept++;
  } catch {}
  if (total % 200000 === 0) process.stderr.write('  ' + (total / 1000 | 0) + 'k processed...\r');
});
rl.on('close', () => {
  out.end();
  console.log('  ' + total + ' buildings total, ' + kept + ' with height data');
});
NODESCRIPT
fi

# --- Convert NAIP PNG to raw RGB for TypeScript processing ---
NAIP_PNG="$MAP_DATA/naip/bay_area_naip.png"
NAIP_RAW="$OUT/naip_rgb.raw"
NAIP_META="$OUT/naip_meta.json"

if [ ! -f "$NAIP_PNG" ]; then
  echo "[naip] Source not found, skipping."
  echo "  Run 001_map_gen/005_download_naip.sh to enable NAIP ground-type classification."
elif [ -f "$NAIP_RAW" ]; then
  echo "[naip] Already preprocessed, skipping."
else
  echo "[naip] Converting PNG to raw RGB..."
  gdal_translate -of ENVI -ot Byte "$NAIP_PNG" "$NAIP_RAW" -q
  WIDTH=$(gdalinfo "$NAIP_PNG" | grep "Size is" | sed 's/Size is //' | cut -d',' -f1 | tr -d ' ')
  HEIGHT=$(gdalinfo "$NAIP_PNG" | grep "Size is" | sed 's/Size is //' | cut -d',' -f2 | tr -d ' ')
  BANDS=$(gdalinfo "$NAIP_PNG" | grep "^Band " | wc -l | tr -d ' ')
  echo "{\"width\":$WIDTH,\"height\":$HEIGHT,\"bands\":$BANDS,\"dtype\":\"uint8\"}" > "$NAIP_META"
  echo "  ${WIDTH}x${HEIGHT} x${BANDS} bands"
fi

# --- Install the extended heightmap into the runtime asset directory ---
# The terrain clipmap fetches `terrain/heightmap_L3.bin` + `terrain/heightmap_meta.json`
# from the reusable_assets bundle. Re-point the symlink at the extended raw
# and rewrite the meta so the runtime picks up real horizon terrain.
ASSET_TERRAIN_DIR="$(dirname "$0")/../../reusable_assets/official/everything_game/chunks/terrain"
if [ -f "$EXT_RAW" ] && [ -f "$EXT_META" ]; then
  mkdir -p "$ASSET_TERRAIN_DIR"
  rm -f "$ASSET_TERRAIN_DIR/heightmap_L3.bin"
  ln -s "$(cd "$OUT" && pwd)/elevation_extended.raw" "$ASSET_TERRAIN_DIR/heightmap_L3.bin"

  # Build the terrain-clipmap meta from the extended meta + OSM offsets.
  EXT_W=$(python3 -c "import json; print(json.load(open('$EXT_META'))['width'])")
  EXT_H=$(python3 -c "import json; print(json.load(open('$EXT_META'))['height'])")
  EXT_WW=$(python3 -c "import json; print(json.load(open('$EXT_META'))['worldWidth'])")
  EXT_WD=$(python3 -c "import json; print(json.load(open('$EXT_META'))['worldDepth'])")
  OSM_WW=$(python3 -c "import json; print(json.load(open('$EXT_META'))['osmWorldWidth'])")
  OSM_WD=$(python3 -c "import json; print(json.load(open('$EXT_META'))['osmWorldDepth'])")
  OFF_X=$(python3 -c "import json; print(json.load(open('$EXT_META'))['osmOffsetX'])")
  OFF_Z=$(python3 -c "import json; print(json.load(open('$EXT_META'))['osmOffsetZ'])")

  cat > "$ASSET_TERRAIN_DIR/heightmap_meta.json" <<EOF
{
  "worldWidth": $EXT_WW,
  "worldDepth": $EXT_WD,
  "osmWorldWidth": $OSM_WW,
  "osmWorldDepth": $OSM_WD,
  "osmOffsetX": $OFF_X,
  "osmOffsetZ": $OFF_Z,
  "levels": {
    "L3": {
      "file": "heightmap_L3.bin",
      "width": $EXT_W,
      "height": $EXT_H
    }
  }
}
EOF
  echo "[elevation] Installed extended heightmap → $ASSET_TERRAIN_DIR"
fi

echo ""
echo "=== Preprocessing complete ==="
ls -lh "$OUT"
