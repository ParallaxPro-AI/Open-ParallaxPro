#!/bin/bash
# Step 1: Download NorCal OSM extract and clip to Bay Area bounding box
#
# Prerequisites:
#   brew install osmium-tool
#
# This downloads the full NorCal PBF (~700MB), then clips it to the
# Bay Area bounding box, producing a much smaller file (~150-200MB).

set -e
cd "$(dirname "$0")/data"

EXTRACT_URL="https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf"
RAW_FILE="norcal-latest.osm.pbf"
CLIPPED_FILE="bay_area.osm.pbf"

# Bay Area bounding box: west,south,east,north
BBOX="-122.7,37.1,-121.5,37.95"

# Download if not already present
if [ ! -f "$RAW_FILE" ]; then
  echo "Downloading NorCal OSM extract (~700MB)..."
  curl -L -o "$RAW_FILE" "$EXTRACT_URL"
  echo "Download complete."
else
  echo "NorCal extract already downloaded, skipping."
fi

# Clip to Bay Area
echo "Clipping to Bay Area bounding box ($BBOX)..."
osmium extract --bbox "$BBOX" --strategy complete_ways \
  "$RAW_FILE" -o "$CLIPPED_FILE" --overwrite
echo "Clipped to $CLIPPED_FILE"

# Show stats
echo ""
echo "File sizes:"
ls -lh "$RAW_FILE" "$CLIPPED_FILE"
echo ""
echo "Feature counts:"
osmium fileinfo -e "$CLIPPED_FILE" | grep -E "Number of|Nodes|Ways|Relations"
