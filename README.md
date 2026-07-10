# Lisboa 3D

Every building in Lisbon — all **52,965** of them — rendered in 3D in your browser, on the city's real hills, with the Tejo, the Ponte 25 de Abril, the Ponte Vasco da Gama, the Metro lines and the elétricos glowing at night.

One self-contained HTML file. No frameworks, no map SDK, no backend — just raw WebGL and open data.

## Features

- **52,965 buildings** extruded at their real heights (OSM `height` / `building:levels` tags), sitting on real terrain
- **13,722 streets** draped over a two-level elevation model (~13 m resolution in the center), so Lisbon's ladeiras actually climb
- **The Tejo** stitched from the real OSM coastline, with both bridges built procedurally on their true centerlines (suspension cables and all)
- **Metro** — the 4 lines in their official colors, toggleable
- **The airport** — runway 02/20 with white edge lights and 128 green-lit taxiways
- **Street search** over 3,692 street names, click-to-identify any street, fly-to landmarks
- Orbit/pan/zoom-to-cursor navigation with inertia, keyboard (WASD/QE), touch and pinch

## Rebuild from scratch

```bash
npm install          # pngjs, used to decode elevation tiles
npm run fetch        # downloads OSM data (Overpass) + elevation tiles (~60 MB into data/)
npm run build        # packs everything into public/index.html (~7 MB)
open public/index.html
```

## How it works

`tools/build.js` quantizes building footprints and street polylines to 0.5 m integers, packs them into little-endian binary encoded as base64, and injects them into `src/template.html` together with a two-level uint8 heightmap (800² over ±17 km + 1200² over ±8 km). The browser decodes the binary, ear-clips every roof polygon, extrudes walls with per-facade lighting baked into vertex colors, and renders ~2M vertices in a handful of draw calls with a single tiny shader. Streets and bridge cables are additive-blended GL lines.

## Data

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, licensed [ODbL](https://opendatacommons.org/licenses/odbl/)
- Elevation from [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/) (Mapzen terrarium), sources include SRTM and EU-DEM

Built with [Claude Code](https://claude.com/claude-code).
