#!/bin/bash
# Step 5: Download NAIP aerial imagery for terrain ground-type classification
#
# Downloads Bay Area NAIP imagery from the USGS National Map ImageServer
# in tiles (server has per-request size limits), then merges with GDAL.
#
# Final output: 4096x4096 RGB PNG (~17m/pixel), sufficient for ground-type splatmap.
#
# NAIP imagery is public domain (US Government work), free for commercial use.
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

# Bay Area bounding box
WEST=-122.7; SOUTH=37.1; EAST=-121.5; NORTH=37.95
MID_LNG=$(echo "$WEST $EAST" | awk '{printf "%.4f", ($1+$2)/2}')
MID_LAT=$(echo "$SOUTH $NORTH" | awk '{printf "%.4f", ($1+$2)/2}')

TILE_SIZE=2048
URL="https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"

echo "=== Downloading NAIP Aerial Imagery ==="
echo "Source: USGS National Map ImageServer"
echo "Bounding box: $WEST,$SOUTH,$EAST,$NORTH"
echo "Downloading 4 tiles of ${TILE_SIZE}x${TILE_SIZE}, merging to 4096x4096..."
echo ""

download_tile() {
  local name=$1 w=$2 s=$3 e=$4 n=$5
  local out="naip/tile_${name}.png"
  if [ -f "$out" ]; then
    echo "  [$name] Already downloaded."
    return
  fi
  echo "  [$name] bbox: $w,$s,$e,$n"
  curl -sL --retry 3 --retry-delay 5 -o "$out" \
    "${URL}?bbox=${w},${s},${e},${n}&bboxSR=4326&imageSR=4326&size=${TILE_SIZE},${TILE_SIZE}&format=png&f=image"
  local fsize
  fsize=$(wc -c < "$out" | tr -d ' ')
  if [ "$fsize" -lt 10000 ]; then
    echo "  [$name] Error: too small ($fsize bytes)"
    cat "$out"
    rm "$out"
    exit 1
  fi
  echo "  [$name] OK ($(ls -lh "$out" | awk '{print $5}'))"
}

# Download 4 quadrants: SW, SE, NW, NE
download_tile "sw" "$WEST"    "$SOUTH"   "$MID_LNG" "$MID_LAT"
download_tile "se" "$MID_LNG" "$SOUTH"   "$EAST"    "$MID_LAT"
download_tile "nw" "$WEST"    "$MID_LAT" "$MID_LNG" "$NORTH"
download_tile "ne" "$MID_LNG" "$MID_LAT" "$EAST"    "$NORTH"

echo ""
echo "Merging tiles..."

# Assign geo-coordinates to each tile so gdal_merge can place them correctly
for tile in sw se nw ne; do
  PNG="naip/tile_${tile}.png"
  TIF="naip/tile_${tile}.tif"
  case $tile in
    sw) gdal_translate -q -a_srs EPSG:4326 -a_ullr $WEST    $MID_LAT $MID_LNG $SOUTH   "$PNG" "$TIF" ;;
    se) gdal_translate -q -a_srs EPSG:4326 -a_ullr $MID_LNG $MID_LAT $EAST    $SOUTH   "$PNG" "$TIF" ;;
    nw) gdal_translate -q -a_srs EPSG:4326 -a_ullr $WEST    $NORTH   $MID_LNG $MID_LAT "$PNG" "$TIF" ;;
    ne) gdal_translate -q -a_srs EPSG:4326 -a_ullr $MID_LNG $NORTH   $EAST    $MID_LAT "$PNG" "$TIF" ;;
  esac
done

# Build virtual raster and export as PNG at exact 4096x4096
gdalbuildvrt -q naip/bay_area_merged.vrt \
  naip/tile_nw.tif naip/tile_ne.tif naip/tile_sw.tif naip/tile_se.tif

gdal_translate -q -of PNG -outsize 4096 4096 naip/bay_area_merged.vrt "$OUTPUT"

# Cleanup intermediate files
rm -f naip/tile_*.png naip/tile_*.tif naip/bay_area_merged.vrt

echo ""
SIZE_H=$(ls -lh "$OUTPUT" | awk '{print $5}')
echo "=== Done ==="
echo "Downloaded NAIP imagery ($SIZE_H)"
echo "Output: $OUTPUT"
