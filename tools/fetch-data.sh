#!/bin/bash
# Downloads all raw OSM data for the build into data/.
# Overpass is rate-limited: queries run sequentially on purpose.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
OP='https://overpass-api.de/api/interpreter'

fetch() {
  echo "-> $2"
  curl -sf "$OP" --data-urlencode "data=$1" -o "data/$2"
}

fetch '[out:json][timeout:300];area["name"="Lisboa"]["admin_level"="7"]->.a;way["building"](area.a);out geom;' buildings.json
fetch '[out:json][timeout:300];area["name"="Lisboa"]["admin_level"="7"]->.a;way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian)$"](area.a);out geom;' roads.json
fetch '[out:json][timeout:120];way["natural"="coastline"](38.58,-9.38,38.88,-8.85);out geom;' coastline.json
fetch '[out:json][timeout:120];way["bridge"~"^(yes|viaduct)$"]["highway"~"^(motorway|trunk)$"](38.60,-9.30,38.82,-8.85);out geom;' bridges.json
fetch '[out:json][timeout:120];area["name"="Lisboa"]["admin_level"="7"]->.a;(relation["route"="subway"](area.a);relation["route"="tram"](area.a););out geom;' transit.json
fetch '[out:json][timeout:60];way["aeroway"~"^(runway|taxiway)$"](38.74,-9.17,38.81,-9.09);out geom;' airport.json
fetch '[out:json][timeout:90];area["name"="Lisboa"]["admin_level"="7"]->.a;relation["boundary"="administrative"]["admin_level"="8"](area.a);out geom;' freguesias.json
node tools/fetch-dem.js
echo "done."
