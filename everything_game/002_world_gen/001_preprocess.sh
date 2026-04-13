#!/bin/bash
# Preprocess raw 001_map_gen downloads into formats the world generator
# (002_generate_chunks.ts) and the ground-type classifier
# (010_generate_ground_type_map.ts) can stream directly, and install the
# runtime heightmap bundle under
# reusable_assets/official/everything_game/terrain/.
#
# Stages:
#   1. OSM GeoJSON layers → newline-delimited JSON (ndjson).
#   2. Bay Area elevation TIF → raw float32 (used by the chunk generator
#      for per-placement sampleElevation).
#   3. Extended elevation TIF → downsampled raw float32 + installed into
#      the runtime asset dir as heightmap.bin + heightmap_meta.json.
#   4. Overture building heights → compact ndjson lookup.
#   5. NAIP RGB PNG → raw BIP bytes + meta aligned to the extended
#      heightmap (consumed by 010_generate_ground_type_map.ts).

set -e

MAP_DATA="$(dirname "$0")/../001_map_gen/data"
OUT="$(dirname "$0")/preprocessed"
mkdir -p "$OUT"

echo "=== Preprocessing for world generation ==="

# --- 1. Convert GeoJSON layers to ndjson ----------------------------------
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
  # geojsonseq = one GeoJSON Feature per line (RS-delimited). Strip the
  # RS (0x1e) to get plain ndjson the TS stream reader can split on \n.
  osmium export "$PBF" -f geojsonseq 2>/dev/null | tr -d '\036' > "$NDJSON"
  COUNT=$(wc -l < "$NDJSON" | tr -d ' ')
  SIZE=$(ls -lh "$NDJSON" | awk '{print $5}')
  echo "  $COUNT features, $SIZE"
done

# --- 2. Bay Area elevation → raw float32 ----------------------------------
# Used by 002_generate_chunks.ts for per-placement height sampling. Kept at
# native resolution — the generator only samples a handful of points per
# feature so the full grid loads once and stays in memory.
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

  WIDTH=$(gdalinfo "$ELEV_TIF" | grep "Size is" | sed 's/Size is //' | cut -d',' -f1 | tr -d ' ')
  HEIGHT=$(gdalinfo "$ELEV_TIF" | grep "Size is" | sed 's/Size is //' | cut -d',' -f2 | tr -d ' ')
  echo "{\"width\":$WIDTH,\"height\":$HEIGHT,\"dtype\":\"float32\"}" > "$ELEV_META"
  echo "  ${WIDTH}x${HEIGHT} float32 heightmap"
fi

# --- 3. Extended elevation → runtime heightmap bundle ---------------------
# The runtime terrain (heightmap_terrain.ts) consumes a downsampled
# float32 grid covering the OSM bbox + ~22 km margin, plus a generic meta
# describing the grid geometry and world-space origin.
#
# Emits the runtime bundle:
#   reusable_assets/official/everything_game/terrain/
#     heightmap.bin          # symlinked to elevation_extended.raw
#     heightmap_meta.json    # geometry description
#
# meta format (generic — HeightmapTerrain just reads `origin` as a
# world-space position and places the mesh there):
#   {
#     "width": int, "height": int,
#     "worldWidth": float, "worldDepth": float,
#     "contentWidth": float, "contentDepth": float,   # OSM sub-region
#     "heightmapFile": "heightmap.bin",
#     "origin": { "x": float, "z": float }            # NW corner in world coords
#   }
# This script is the only place that knows the bbox convention (OSM
# region pinned at world origin).

EXT_TIF="$MAP_DATA/elevation/bay_area_elevation_extended.tif"
EXT_RAW="$OUT/elevation_extended.raw"
EXT_META="$OUT/elevation_extended_meta.json"

# Downsampled runtime grid size. The client resamples to min(W, H, 1024)²
# for its LOD mesh anyway, so shipping the native ~17280×13500 float32
# source is ~900 MB wasted transfer. 3200×2500 lands at ~32 MB and has
# plenty of bilinear headroom for the LOD cap.
RUNTIME_W=3200
RUNTIME_H=2500

if [ ! -f "$EXT_TIF" ]; then
  echo "[elevation extended] $EXT_TIF not found — skipping runtime heightmap install."
else
  # Always regenerate: an older run may have left a native-resolution
  # float32 (~900 MB) at this path from before the downsample step
  # existed, which we don't want to ship.
  echo "[elevation extended] Converting GeoTIFF to downsampled (${RUNTIME_W}x${RUNTIME_H}) raw float32..."
  rm -f "$EXT_RAW"
  gdal_translate -of ENVI -ot Float32 \
    -outsize "$RUNTIME_W" "$RUNTIME_H" \
    -r bilinear \
    "$EXT_TIF" "$EXT_RAW" -q
  ls -lh "$EXT_RAW"

  # gdalinfo emits two paren groups per corner (decimal, then DMS). Take
  # the decimal one. The corners are invariant under raster resize so we
  # can read them from the original TIF.
  EXT_UL=$(gdalinfo "$EXT_TIF" | grep "Upper Left"  | grep -oE '\([^)]*\)' | head -1 | tr -d '() ')
  EXT_LR=$(gdalinfo "$EXT_TIF" | grep "Lower Right" | grep -oE '\([^)]*\)' | head -1 | tr -d '() ')
  EXT_WEST=$(echo "$EXT_UL"  | cut -d',' -f1 | tr -d ' ')
  EXT_NORTH=$(echo "$EXT_UL" | cut -d',' -f2 | tr -d ' ')
  EXT_EAST=$(echo "$EXT_LR"  | cut -d',' -f1 | tr -d ' ')
  EXT_SOUTH=$(echo "$EXT_LR" | cut -d',' -f2 | tr -d ' ')

  # OSM gameplay bbox (must match 001_map_gen/config.ts).
  OSM_WEST=-122.7
  OSM_EAST=-121.5
  OSM_NORTH=37.95
  OSM_SOUTH=37.1

  # Meters per degree at bbox center latitude.
  CENTER_LAT="$(python3 -c "print(($OSM_SOUTH+$OSM_NORTH)/2)")"
  M_PER_DEG_LAT=111000
  M_PER_DEG_LNG="$(python3 -c "import math; print(111000*math.cos(math.radians($CENTER_LAT)))")"

  # OSM offset from the extended NW corner, in meters.
  OSM_OFFSET_X_M="$(python3 -c "print(($OSM_WEST - ($EXT_WEST)) * $M_PER_DEG_LNG)")"
  OSM_OFFSET_Z_M="$(python3 -c "print(($EXT_NORTH - $OSM_NORTH) * $M_PER_DEG_LAT)")"

  EXT_WORLD_W_M="$(python3 -c "print(($EXT_EAST - ($EXT_WEST)) * $M_PER_DEG_LNG)")"
  EXT_WORLD_D_M="$(python3 -c "print(($EXT_NORTH - $EXT_SOUTH) * $M_PER_DEG_LAT)")"
  OSM_WORLD_W_M="$(python3 -c "print(($OSM_EAST - ($OSM_WEST)) * $M_PER_DEG_LNG)")"
  OSM_WORLD_D_M="$(python3 -c "print(($OSM_NORTH - $OSM_SOUTH) * $M_PER_DEG_LAT)")"

  # Extended meta (used by NAIP meta below + kept for debugging).
  cat > "$EXT_META" <<EOF
{
  "width": $RUNTIME_W,
  "height": $RUNTIME_H,
  "worldWidth": $EXT_WORLD_W_M,
  "worldDepth": $EXT_WORLD_D_M,
  "osmWorldWidth": $OSM_WORLD_W_M,
  "osmWorldDepth": $OSM_WORLD_D_M,
  "osmOffsetX": $OSM_OFFSET_X_M,
  "osmOffsetZ": $OSM_OFFSET_Z_M
}
EOF

  # Install into the runtime asset directory. heightmap.bin is symlinked
  # to the raw float32 to avoid duplicating ~32 MB of data.
  ASSET_TERRAIN_DIR="$(dirname "$0")/../../reusable_assets/official/everything_game/terrain"
  mkdir -p "$ASSET_TERRAIN_DIR"
  rm -f "$ASSET_TERRAIN_DIR/heightmap.bin"
  ln -s "$(cd "$OUT" && pwd)/elevation_extended.raw" "$ASSET_TERRAIN_DIR/heightmap.bin"

  # `origin` places the heightmap's NW corner in world coords. The OSM
  # region sits at world (0,0)→(osmW, osmD) by convention, so the
  # extended heightmap NW corner is at (-osmOffsetX, -osmOffsetZ).
  ORIGIN_X="$(python3 -c "print(-($OSM_OFFSET_X_M))")"
  ORIGIN_Z="$(python3 -c "print(-($OSM_OFFSET_Z_M))")"

  cat > "$ASSET_TERRAIN_DIR/heightmap_meta.json" <<EOF
{
  "width": $RUNTIME_W,
  "height": $RUNTIME_H,
  "worldWidth": $EXT_WORLD_W_M,
  "worldDepth": $EXT_WORLD_D_M,
  "contentWidth": $OSM_WORLD_W_M,
  "contentDepth": $OSM_WORLD_D_M,
  "heightmapFile": "heightmap.bin",
  "origin": { "x": $ORIGIN_X, "z": $ORIGIN_Z }
}
EOF
  echo "  ${RUNTIME_W}x${RUNTIME_H} float32 heightmap (extended)"
  echo "  OSM offset: ${OSM_OFFSET_X_M} m east, ${OSM_OFFSET_Z_M} m south from NW corner"
  echo "  Installed → $ASSET_TERRAIN_DIR"
fi

# --- 4. Overture building heights → compact ndjson ------------------------
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

# --- 5. NAIP PNG → raw RGB + meta -----------------------------------------
NAIP_PNG="$MAP_DATA/naip/bay_area_naip.png"
NAIP_RAW="$OUT/naip_rgb.raw"
NAIP_META="$OUT/naip_meta.json"

if [ ! -f "$NAIP_PNG" ]; then
  echo "[naip] $NAIP_PNG not found — skipping NAIP preprocess."
  echo "       Run 001_map_gen/005_download_naip.sh to enable the ground-type splatmap."
elif [ -f "$NAIP_RAW" ]; then
  echo "[naip] Already preprocessed, skipping."
else
  echo "[naip] Converting NAIP PNG to raw RGB (BIP)..."
  rm -f "$NAIP_RAW" "$NAIP_RAW.aux.xml" "${NAIP_RAW%.raw}.hdr"
  # ENVI BIP = byte-interleaved-by-pixel: R,G,B,R,G,B,... matches what the
  # classifier expects. Force 3 bands — some NAIP exports include alpha.
  gdal_translate -of ENVI -ot Byte -b 1 -b 2 -b 3 -co INTERLEAVE=PIXEL \
    "$NAIP_PNG" "$NAIP_RAW" -q

  NAIP_W=$(gdalinfo "$NAIP_PNG" | grep "Size is" | sed -E 's/.*Size is ([0-9]+), ([0-9]+).*/\1/')
  NAIP_H=$(gdalinfo "$NAIP_PNG" | grep "Size is" | sed -E 's/.*Size is ([0-9]+), ([0-9]+).*/\2/')
  # Reuse the extended-heightmap extent computed above so the splatmap
  # UVs line up 1:1 with the runtime terrain.
  cat > "$NAIP_META" <<EOF
{
  "width": $NAIP_W,
  "height": $NAIP_H,
  "bands": 3,
  "worldWidth": $EXT_WORLD_W_M,
  "worldDepth": $EXT_WORLD_D_M,
  "origin": { "x": $ORIGIN_X, "z": $ORIGIN_Z }
}
EOF
  echo "  ${NAIP_W}x${NAIP_H} RGB → $(ls -lh "$NAIP_RAW" | awk '{print $5}')"
fi

echo ""
echo "=== Preprocessing complete ==="
ls -lh "$OUT"
