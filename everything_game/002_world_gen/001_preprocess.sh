#!/bin/bash
# Preprocess elevation data into the runtime-consumable heightmap.
#
# Consumes: everything_game/001_map_gen/data/elevation/bay_area_elevation_extended.tif
#   (produced by 001_map_gen/003_download_elevation.sh — USGS 3DEP at
#    ~10m resolution, covering the OSM gameplay bbox + ~22 km margin on
#    all sides so the runtime terrain extends past the OSM area).
#
# Emits the runtime heightmap bundle under:
#   reusable_assets/official/everything_game/terrain/
#     heightmap.bin          # raw float32 grid of elevations in meters
#     heightmap_meta.json    # geometry description — consumed by
#                              everything_game/003_runtime/streaming/
#                              heightmap_terrain.ts
#
# The emitted meta is deliberately generic:
#   {
#     "width": int,                # heightmap grid W
#     "height": int,               # heightmap grid H
#     "worldWidth": float,         # extent along X in meters
#     "worldDepth": float,         # extent along Z in meters
#     "heightmapFile": "heightmap.bin",
#     "origin": { "x": float, "z": float }  # NW corner in world coords
#   }
# This script is the only place that knows the bbox convention (OSM
# gameplay region pinned at world origin); HeightmapTerrain just reads
# `origin` as a world-space position and places the mesh accordingly.

set -e

MAP_DATA="$(dirname "$0")/../001_map_gen/data"
OUT="$(dirname "$0")/preprocessed"
mkdir -p "$OUT"

echo "=== Preprocessing extended elevation for world terrain ==="

EXT_TIF="$MAP_DATA/elevation/bay_area_elevation_extended.tif"
EXT_RAW="$OUT/elevation_extended.raw"

# Downsampled runtime grid size. The client resamples to min(W, H, 1024)²
# for its LOD mesh anyway, so shipping the native ~17280×13500 float32
# source is ~900 MB wasted transfer. 3200×2500 is ~3× the LOD cap (plenty
# of bilinear headroom), preserves the source aspect ratio, and lands the
# raw float32 at ~32 MB — compresses further over the wire.
RUNTIME_W=3200
RUNTIME_H=2500

if [ ! -f "$EXT_TIF" ]; then
  echo "Error: Extended elevation GeoTIFF not found at $EXT_TIF"
  echo "       Run 001_map_gen/003_download_elevation.sh first."
  exit 1
fi

# Always regenerate the raw: an older run may have left a full-size
# float32 (~900 MB) at this path from before the downsample step existed,
# and we don't want to ship that.
echo "[elevation] Converting GeoTIFF to downsampled (${RUNTIME_W}x${RUNTIME_H}) raw float32..."
rm -f "$EXT_RAW"
gdal_translate -of ENVI -ot Float32 \
  -outsize "$RUNTIME_W" "$RUNTIME_H" \
  -r bilinear \
  "$EXT_TIF" "$EXT_RAW" -q
ls -lh "$EXT_RAW"

# Extract geotransform so we can compute world extents + origin.
# gdalinfo emits two paren groups per corner — decimal first, then DMS:
#   "Upper Left  (-122.9000000,  38.1500000) (122d54' 0.00\"W, 38d 9' 0.00\"N)"
# We take the first group only. (Note: we query the original TIF here;
# the geographic extents and corner coords are invariant under raster
# resizing, so they stay correct for the downsampled raw.)
EXT_WIDTH="$RUNTIME_W"
EXT_HEIGHT="$RUNTIME_H"
EXT_UL=$(gdalinfo "$EXT_TIF" | grep "Upper Left"  | grep -oE '\([^)]*\)' | head -1 | tr -d '() ')
EXT_LR=$(gdalinfo "$EXT_TIF" | grep "Lower Right" | grep -oE '\([^)]*\)' | head -1 | tr -d '() ')
EXT_WEST=$(echo "$EXT_UL"  | cut -d',' -f1 | tr -d ' ')
EXT_NORTH=$(echo "$EXT_UL" | cut -d',' -f2 | tr -d ' ')
EXT_EAST=$(echo "$EXT_LR"  | cut -d',' -f1 | tr -d ' ')
EXT_SOUTH=$(echo "$EXT_LR" | cut -d',' -f2 | tr -d ' ')

# OSM gameplay bbox (must match 001_map_gen/config.ts). The runtime pins
# the OSM region at world origin, so the heightmap's origin in world
# coords is the negative of its own NW-corner-to-OSM-NW-corner offset.
OSM_WEST=-122.7
OSM_EAST=-121.5
OSM_NORTH=37.95
OSM_SOUTH=37.1

# Meters per degree at bbox center latitude
CENTER_LAT="$(python3 -c "print(($OSM_SOUTH+$OSM_NORTH)/2)")"
M_PER_DEG_LAT=111000
M_PER_DEG_LNG="$(python3 -c "import math; print(111000*math.cos(math.radians($CENTER_LAT)))")"

# OSM offset from the extended NW corner, in meters (positive X = east,
# positive Z = south in game coords).
OSM_OFFSET_X_M="$(python3 -c "print(($OSM_WEST - ($EXT_WEST)) * $M_PER_DEG_LNG)")"
OSM_OFFSET_Z_M="$(python3 -c "print(($EXT_NORTH - $OSM_NORTH) * $M_PER_DEG_LAT)")"

# Extended heightmap extent in meters
EXT_WORLD_W_M="$(python3 -c "print(($EXT_EAST - ($EXT_WEST)) * $M_PER_DEG_LNG)")"
EXT_WORLD_D_M="$(python3 -c "print(($EXT_NORTH - $EXT_SOUTH) * $M_PER_DEG_LAT)")"

# OSM content extent in meters — the runtime uses these to mask the road
# atlas / OSM-only decals to the gameplay region (roads don't tile into the
# wilderness padding).
OSM_WORLD_W_M="$(python3 -c "print(($OSM_EAST - ($OSM_WEST)) * $M_PER_DEG_LNG)")"
OSM_WORLD_D_M="$(python3 -c "print(($OSM_NORTH - $OSM_SOUTH) * $M_PER_DEG_LAT)")"

# Install into the runtime asset directory:
#   heightmap.bin        — symlinked to the raw float32 (not copied to
#                          avoid duplicating ~400 MB of data)
#   heightmap_meta.json  — generic geometry description consumed by
#                          HeightmapTerrain
ASSET_TERRAIN_DIR="$(dirname "$0")/../../reusable_assets/official/everything_game/terrain"
mkdir -p "$ASSET_TERRAIN_DIR"
rm -f "$ASSET_TERRAIN_DIR/heightmap.bin"
ln -s "$(cd "$OUT" && pwd)/elevation_extended.raw" "$ASSET_TERRAIN_DIR/heightmap.bin"

# `origin` places the heightmap's NW corner in world coords. Since the
# OSM region sits at world (0,0)→(osmW, osmD) by convention, the
# extended heightmap NW corner is at (-osmOffsetX, -osmOffsetZ).
ORIGIN_X="$(python3 -c "print(-($OSM_OFFSET_X_M))")"
ORIGIN_Z="$(python3 -c "print(-($OSM_OFFSET_Z_M))")"

cat > "$ASSET_TERRAIN_DIR/heightmap_meta.json" <<EOF
{
  "width": $EXT_WIDTH,
  "height": $EXT_HEIGHT,
  "worldWidth": $EXT_WORLD_W_M,
  "worldDepth": $EXT_WORLD_D_M,
  "contentWidth": $OSM_WORLD_W_M,
  "contentDepth": $OSM_WORLD_D_M,
  "heightmapFile": "heightmap.bin",
  "origin": { "x": $ORIGIN_X, "z": $ORIGIN_Z }
}
EOF

# --- NAIP imagery → raw RGB for the ground-type classifier -----------------
#
# Consumes the extended-bbox PNG produced by 001_map_gen/005_download_naip.sh
# (NAIP imagery aligned 1:1 with the extended elevation bbox above) and
# emits a raw RGB byte stream + meta that 010_generate_ground_type_map.ts
# can read without pulling a PNG decoder into Node.

NAIP_PNG="$MAP_DATA/naip/bay_area_naip.png"
NAIP_RAW="$OUT/naip_rgb.raw"
NAIP_META="$OUT/naip_meta.json"

if [ ! -f "$NAIP_PNG" ]; then
  echo ""
  echo "[naip] $NAIP_PNG not found — skipping NAIP preprocess."
  echo "       Run 001_map_gen/005_download_naip.sh to enable the ground-type splatmap."
else
  echo ""
  echo "[naip] Converting NAIP PNG to raw RGB (BIP)..."
  rm -f "$NAIP_RAW" "$NAIP_RAW.aux.xml" "${NAIP_RAW%.raw}.hdr"
  # ENVI BIP = byte-interleaved-by-pixel: R,G,B,R,G,B,... matches what the
  # classifier expects. We force 3 bands; some NAIP exports include alpha.
  gdal_translate -of ENVI -ot Byte -b 1 -b 2 -b 3 -co INTERLEAVE=PIXEL \
    "$NAIP_PNG" "$NAIP_RAW" -q

  NAIP_W=$(gdalinfo "$NAIP_PNG" | grep "Size is" | sed -E 's/.*Size is ([0-9]+), ([0-9]+).*/\1/')
  NAIP_H=$(gdalinfo "$NAIP_PNG" | grep "Size is" | sed -E 's/.*Size is ([0-9]+), ([0-9]+).*/\2/')
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
echo "  Heightmap: ${EXT_WIDTH}x${EXT_HEIGHT} float32"
echo "  World:     ${EXT_WORLD_W_M} x ${EXT_WORLD_D_M} m"
echo "  Origin:    (${ORIGIN_X}, ${ORIGIN_Z}) m"
echo "  Installed: $ASSET_TERRAIN_DIR"
