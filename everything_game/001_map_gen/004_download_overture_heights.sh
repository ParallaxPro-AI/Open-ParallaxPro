#!/bin/bash
# Step 4: Download Overture Maps building data with height information
#
# Prerequisites:
#   pip install overturemaps
#   OR: pipx install overturemaps
#   OR: brew install uv  (then uvx is used automatically)
#
# Downloads building footprints with ML-derived heights from Overture Maps.
# Overture enriches OSM buildings with height data from Microsoft, Esri,
# Google, and LiDAR sources.
#
# License: ODbL (same as OpenStreetMap — attribution required)

set -e
cd "$(dirname "$0")/data"

mkdir -p layers

# Bay Area bounding box (must match 001_download_osm.sh)
BBOX="-122.7,37.1,-121.5,37.95"
OUTPUT="layers/overture_buildings.geojsonseq"

if [ -f "$OUTPUT" ]; then
  echo "Overture buildings already downloaded, skipping."
  echo "  Delete $OUTPUT to re-download."
  SIZE=$(ls -lh "$OUTPUT" | awk '{print $5}')
  COUNT=$(wc -l < "$OUTPUT" | tr -d ' ')
  echo "  $COUNT buildings ($SIZE)"
  exit 0
fi

echo "=== Downloading Overture Maps building data ==="
echo "Bounding box: $BBOX"
echo "This may take several minutes for the Bay Area..."
echo ""

# Try overturemaps directly, then python3.10 module, then uvx
if command -v overturemaps &> /dev/null; then
  echo "Using overturemaps CLI..."
  overturemaps download --bbox=$BBOX -f geojsonseq --type=building -o "$OUTPUT"
elif /opt/homebrew/bin/python3.10 -c "import overturemaps" 2>/dev/null; then
  echo "Using python3.10 overturemaps module..."
  /opt/homebrew/bin/python3.10 -m overturemaps download --bbox=$BBOX -f geojsonseq --type=building -o "$OUTPUT"
elif command -v uvx &> /dev/null; then
  echo "Using uvx..."
  uvx overturemaps download --bbox=$BBOX -f geojsonseq --type=building -o "$OUTPUT"
else
  echo "Error: overturemaps CLI not found."
  echo ""
  echo "Install with: /opt/homebrew/bin/python3.10 -m pip install overturemaps"
  exit 1
fi

echo ""
COUNT=$(wc -l < "$OUTPUT" | tr -d ' ')
SIZE=$(ls -lh "$OUTPUT" | awk '{print $5}')
echo "=== Done ==="
echo "Downloaded $COUNT buildings ($SIZE)"
echo "Output: $OUTPUT"
