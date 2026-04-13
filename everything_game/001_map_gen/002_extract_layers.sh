#!/bin/bash
# Step 2: Extract individual layers from the clipped Bay Area PBF into GeoJSON
#
# Prerequisites:
#   brew install osmium-tool
#   npm install -g osmtogeojson
#
# Produces one GeoJSON file per layer in data/layers/

set -e
cd "$(dirname "$0")/data"

INPUT="bay_area.osm.pbf"
LAYERS_DIR="layers"
mkdir -p "$LAYERS_DIR"

if [ ! -f "$INPUT" ]; then
  echo "Error: $INPUT not found. Run 001_download_osm.sh first."
  exit 1
fi

echo "=== Extracting layers from $INPUT ==="

# --- Roads ---
echo "[1/8] Roads..."
osmium tags-filter "$INPUT" w/highway \
  -o "$LAYERS_DIR/roads.osm.pbf" --overwrite
osmium export "$LAYERS_DIR/roads.osm.pbf" -o "$LAYERS_DIR/roads.geojson" --overwrite
echo "  $(wc -l < "$LAYERS_DIR/roads.geojson") lines"

# --- Buildings ---
echo "[2/8] Buildings..."
osmium tags-filter "$INPUT" w/building r/building \
  -o "$LAYERS_DIR/buildings.osm.pbf" --overwrite
osmium export "$LAYERS_DIR/buildings.osm.pbf" -o "$LAYERS_DIR/buildings.geojson" --overwrite
echo "  $(wc -l < "$LAYERS_DIR/buildings.geojson") lines"

# --- Water (natural=water, waterway=*, natural=bay, natural=coastline) ---
echo "[3/8] Water..."
osmium tags-filter "$INPUT" w/natural=water w/natural=bay w/natural=coastline \
  w/waterway r/natural=water r/natural=bay \
  -o "$LAYERS_DIR/water.osm.pbf" --overwrite
osmium export "$LAYERS_DIR/water.osm.pbf" -o "$LAYERS_DIR/water.geojson" --overwrite
echo "  $(wc -l < "$LAYERS_DIR/water.geojson") lines"

# --- Parks & Green Spaces ---
echo "[4/8] Parks..."
osmium tags-filter "$INPUT" w/leisure=park w/leisure=garden w/leisure=nature_reserve \
  w/landuse=grass w/landuse=recreation_ground \
  r/leisure=park r/leisure=nature_reserve \
  -o "$LAYERS_DIR/parks.osm.pbf" --overwrite
osmium export "$LAYERS_DIR/parks.osm.pbf" -o "$LAYERS_DIR/parks.geojson" --overwrite
echo "  $(wc -l < "$LAYERS_DIR/parks.geojson") lines"

# --- Railways ---
echo "[5/8] Railways..."
osmium tags-filter "$INPUT" w/railway=rail w/railway=subway w/railway=light_rail \
  w/railway=tram w/railway=station \
  -o "$LAYERS_DIR/railways.osm.pbf" --overwrite
osmium export "$LAYERS_DIR/railways.osm.pbf" -o "$LAYERS_DIR/railways.geojson" --overwrite
echo "  $(wc -l < "$LAYERS_DIR/railways.geojson") lines"

# --- Bridges ---
echo "[6/8] Bridges..."
osmium tags-filter "$INPUT" w/bridge=yes w/man_made=bridge \
  -o "$LAYERS_DIR/bridges.osm.pbf" --overwrite
osmium export "$LAYERS_DIR/bridges.osm.pbf" -o "$LAYERS_DIR/bridges.geojson" --overwrite
echo "  $(wc -l < "$LAYERS_DIR/bridges.geojson") lines"

# --- Land Use (industrial, commercial, residential zones) ---
echo "[7/8] Land use..."
osmium tags-filter "$INPUT" w/landuse=industrial w/landuse=commercial \
  w/landuse=residential w/landuse=retail w/landuse=cemetery \
  w/landuse=farmland w/landuse=forest \
  r/landuse=industrial r/landuse=commercial r/landuse=residential \
  -o "$LAYERS_DIR/landuse.osm.pbf" --overwrite
osmium export "$LAYERS_DIR/landuse.osm.pbf" -o "$LAYERS_DIR/landuse.geojson" --overwrite
echo "  $(wc -l < "$LAYERS_DIR/landuse.geojson") lines"

# --- Amenities & Landmarks (POIs) ---
echo "[8/8] Amenities & landmarks..."
osmium tags-filter "$INPUT" n/amenity n/tourism n/shop n/aeroway=aerodrome \
  w/amenity=hospital w/amenity=school w/amenity=university \
  w/aeroway=aerodrome w/tourism=stadium \
  -o "$LAYERS_DIR/amenities.osm.pbf" --overwrite
osmium export "$LAYERS_DIR/amenities.osm.pbf" -o "$LAYERS_DIR/amenities.geojson" --overwrite
echo "  $(wc -l < "$LAYERS_DIR/amenities.geojson") lines"

# --- Traffic Controls (traffic signals, stop signs, crossings) ---
echo "[9/9] Traffic controls..."
osmium tags-filter "$INPUT" \
  n/highway=traffic_signals n/highway=stop n/highway=crossing n/highway=give_way \
  -o "$LAYERS_DIR/traffic_controls.osm.pbf" --overwrite
osmium export "$LAYERS_DIR/traffic_controls.osm.pbf" -o "$LAYERS_DIR/traffic_controls.geojson" --overwrite
echo "  $(wc -l < "$LAYERS_DIR/traffic_controls.geojson") lines"

echo ""
echo "=== Done. Layer files in data/layers/ ==="
ls -lh "$LAYERS_DIR"/*.geojson
