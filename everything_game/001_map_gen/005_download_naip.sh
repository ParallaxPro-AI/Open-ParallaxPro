#!/bin/bash
# Step 5: Download NAIP aerial imagery for the EXTENDED terrain area.
#
# The runtime heightmap covers the OSM gameplay bbox plus a ~22 km margin
# on every side so the world doesn't end at a wall. We classify NAIP
# imagery into per-pixel ground-type weights (sand / grass / grass-rock /
# rock-impervious) and feed that to the terrain shader as a splatmap. To
# avoid a visible seam between OSM-derived ground colors and the
# height-fallback wilderness, the splatmap must cover the *entire*
# extended area, not just the OSM bbox.
#
# The extended bbox here MUST match the EXT_BBOX in 003_download_elevation.sh.
#
# Output: data/naip/bay_area_naip.png — a single 4096x4096 RGB PNG aligned
# to the extended bbox. Public domain (USGS National Map / NAIP). Areas
# with no NAIP coverage (Pacific Ocean) come back as near-white and are
# treated as no-data by the classifier.
#
# Prerequisites: curl, gdal (brew install gdal)

set -e
cd "$(dirname "$0")/data"

mkdir -p naip

OUTPUT="naip/bay_area_naip.png"

if [ -f "$OUTPUT" ]; then
  echo "NAIP imagery already downloaded, skipping."
  echo "  Delete $OUTPUT to re-download."
  exit 0
fi

# Extended bounding box — keep in sync with 003_download_elevation.sh.
WEST=-122.9; SOUTH=36.9; EAST=-121.3; NORTH=38.15

OUT_W=4096
OUT_H=4096

# The USGS ImageServer caps each request at ~4096 px per side, and at this
# extent the longest axis (~178 km) makes a single request lossy. Split into
# a 2x2 grid of 2048-px tiles and let gdal stitch them at full resolution.
TILE_PX=2048
MID_LNG=$(python3 -c "print(($WEST + $EAST) / 2)")
MID_LAT=$(python3 -c "print(($SOUTH + $NORTH) / 2)")

URL="https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"

echo "=== Downloading NAIP imagery for extended bbox ==="
echo "Bbox: $WEST,$SOUTH,$EAST,$NORTH  (4 tiles of ${TILE_PX}px → ${OUT_W}x${OUT_H})"
echo ""

download_tile() {
  local name=$1 w=$2 s=$3 e=$4 n=$5
  local out="naip/tile_${name}.png"
  if [ -f "$out" ]; then
    echo "  [$name] already downloaded"
    return
  fi
  echo "  [$name] bbox: $w,$s,$e,$n"
  curl -sL --retry 3 --retry-delay 5 -o "$out" \
    "${URL}?bbox=${w},${s},${e},${n}&bboxSR=4326&imageSR=4326&size=${TILE_PX},${TILE_PX}&format=png&f=image"
  local fsize
  fsize=$(wc -c < "$out" | tr -d ' ')
  if [ "$fsize" -lt 10000 ]; then
    echo "  [$name] error: response too small ($fsize bytes)"
    cat "$out"
    rm "$out"
    exit 1
  fi
  echo "  [$name] ok ($(ls -lh "$out" | awk '{print $5}'))"
}

download_tile "sw" "$WEST"    "$SOUTH"   "$MID_LNG" "$MID_LAT"
download_tile "se" "$MID_LNG" "$SOUTH"   "$EAST"    "$MID_LAT"
download_tile "nw" "$WEST"    "$MID_LAT" "$MID_LNG" "$NORTH"
download_tile "ne" "$MID_LNG" "$MID_LAT" "$EAST"    "$NORTH"

echo ""
echo "Stitching tiles..."

# gdal_translate -a_ullr expects: ulx uly lrx lry  (i.e. west north east south)
gdal_translate -q -a_srs EPSG:4326 -a_ullr "$WEST"    "$MID_LAT" "$MID_LNG" "$SOUTH"   naip/tile_sw.png naip/tile_sw.tif
gdal_translate -q -a_srs EPSG:4326 -a_ullr "$MID_LNG" "$MID_LAT" "$EAST"    "$SOUTH"   naip/tile_se.png naip/tile_se.tif
gdal_translate -q -a_srs EPSG:4326 -a_ullr "$WEST"    "$NORTH"   "$MID_LNG" "$MID_LAT" naip/tile_nw.png naip/tile_nw.tif
gdal_translate -q -a_srs EPSG:4326 -a_ullr "$MID_LNG" "$NORTH"   "$EAST"    "$MID_LAT" naip/tile_ne.png naip/tile_ne.tif

gdalbuildvrt -q naip/bay_area_merged.vrt \
  naip/tile_nw.tif naip/tile_ne.tif naip/tile_sw.tif naip/tile_se.tif

gdal_translate -q -of PNG -outsize "$OUT_W" "$OUT_H" naip/bay_area_merged.vrt "$OUTPUT"

# Drop intermediate tiles; keep the merged VRT for debugging.
rm -f naip/tile_*.png naip/tile_*.tif

echo ""
echo "=== Done ==="
echo "  Output: $OUTPUT ($(ls -lh "$OUTPUT" | awk '{print $5}'))"
