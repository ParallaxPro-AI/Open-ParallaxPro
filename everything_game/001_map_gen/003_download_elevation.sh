#!/bin/bash
# Step 3: Download USGS 3DEP 1/3 arc-second (~10m) elevation data for the Bay Area
#
# Prerequisites:
#   brew install gdal
#
# Source: USGS 3D Elevation Program (3DEP) — public domain
# Product: 1/3 arc-second DEM (~10m resolution)
# Hosted on AWS S3: https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/
#
# OSM bbox (37.1-37.95N, 121.5-122.7W) spans two 1x1 degree tiles:
#   n38w122 (covers 37-38N, 121-122W)
#   n38w123 (covers 37-38N, 122-123W)
#
# We ALSO produce an extended heightmap with ~0.2° (~22km) margin on every
# side so the terrain clipmap can render real scenery past the OSM area.
# Extended bbox (36.9-38.15N, 121.3-122.9W) spans six tiles, adding four more:
#   n37w122, n37w123 (south of OSM)
#   n39w122, n39w123 (north of OSM)

set -e
cd "$(dirname "$0")/data"

ELEV_DIR="elevation"
mkdir -p "$ELEV_DIR"

BASE_URL="https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current"

# Tiles for the OSM-only clip
OSM_TILES=("n38w122" "n38w123")

# Full tile set needed for the extended clip (OSM tiles + 4 neighbours)
EXT_TILES=("n38w122" "n38w123" "n37w122" "n37w123" "n39w122" "n39w123")

# OSM bounding box: west south east north
BBOX="-122.7 37.1 -121.5 37.95"

# Extended bounding box (OSM + ~0.2° margin on every side) — all lat/lng still
# within the 6-tile coverage above. Adjust these if you change the margin.
EXT_BBOX="-122.9 36.9 -121.3 38.15"

# Download every tile needed for either clip.
for tile in "${EXT_TILES[@]}"; do
  DEST="$ELEV_DIR/USGS_13_${tile}.tif"
  if [ -f "$DEST" ]; then
    echo "Tile $tile already downloaded, skipping."
  else
    URL="${BASE_URL}/${tile}/USGS_13_${tile}.tif"
    echo "Downloading $tile (~50-80MB)..."
    curl -L -o "$DEST" "$URL"
    echo "  Done: $(ls -lh "$DEST" | awk '{print $5}')"
  fi
done

# --- OSM clip (unchanged — consumed by chunk generation) ---
echo ""
echo "Merging and clipping to OSM bbox..."
OSM_INPUTS=()
for tile in "${OSM_TILES[@]}"; do
  OSM_INPUTS+=("$ELEV_DIR/USGS_13_${tile}.tif")
done
gdalwarp -te $BBOX -overwrite -q \
  "${OSM_INPUTS[@]}" \
  "$ELEV_DIR/bay_area_elevation.tif"

# --- Extended clip (used by terrain clipmap for horizon scenery) ---
echo ""
echo "Merging and clipping to extended bbox..."
EXT_INPUTS=()
for tile in "${EXT_TILES[@]}"; do
  EXT_INPUTS+=("$ELEV_DIR/USGS_13_${tile}.tif")
done
gdalwarp -te $EXT_BBOX -overwrite -q \
  "${EXT_INPUTS[@]}" \
  "$ELEV_DIR/bay_area_elevation_extended.tif"

# Show info
echo ""
echo "=== Bay Area Elevation Data ==="
echo "-- OSM --"
gdalinfo "$ELEV_DIR/bay_area_elevation.tif" | grep -E "Size is|Pixel Size|Origin|Band 1|STATISTICS_MINIMUM|STATISTICS_MAXIMUM|Type="
ls -lh "$ELEV_DIR/bay_area_elevation.tif"
echo ""
echo "-- Extended --"
gdalinfo "$ELEV_DIR/bay_area_elevation_extended.tif" | grep -E "Size is|Pixel Size|Origin|Band 1|STATISTICS_MINIMUM|STATISTICS_MAXIMUM|Type="
ls -lh "$ELEV_DIR/bay_area_elevation_extended.tif"

# Also export as a simpler format — raw heightmap PNG for quick visualization
echo ""
echo "Generating heightmap preview..."
gdal_translate -of PNG -ot Byte -scale \
  "$ELEV_DIR/bay_area_elevation.tif" \
  "$ELEV_DIR/bay_area_heightmap_preview.png" -q
gdal_translate -of PNG -ot Byte -scale \
  "$ELEV_DIR/bay_area_elevation_extended.tif" \
  "$ELEV_DIR/bay_area_heightmap_extended_preview.png" -q
echo "Previews saved to $ELEV_DIR/"

echo ""
echo "Done."
echo "  OSM heightmap:      data/elevation/bay_area_elevation.tif"
echo "  Extended heightmap: data/elevation/bay_area_elevation_extended.tif"
