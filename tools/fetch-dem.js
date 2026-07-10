// Downloads terrarium elevation tiles and bakes a two-level heightmap:
//   outer: 800x800 uint8 over +-17 km (z12 tiles, ~42 m cells)
//   inner: 1200x1200 uint8 over +-8 km (z13 tiles, ~13 m cells)
// Output: data/heightmap.bin = outer bytes followed by inner bytes.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const LAT0 = 38.740, LON0 = -9.160;
const KY = 111132;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const GRIDS = [
  { S: 17000, N: 800, Z: 12 },
  { S: 8000, N: 1200, Z: 13 },
];
const DATA = path.join(__dirname, '..', 'data');

async function bakeGrid({ S, N, Z }) {
  const NT = 2 ** Z;
  const lat2py = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * NT * 256;
  const lon2px = lon => (lon + 180) / 360 * NT * 256;
  const latMin = LAT0 - S / KY, latMax = LAT0 + S / KY;
  const lonMin = LON0 - S / KX, lonMax = LON0 + S / KX;
  const tx0 = Math.floor(lon2px(lonMin) / 256), tx1 = Math.floor(lon2px(lonMax) / 256);
  const ty0 = Math.floor(lat2py(latMax) / 256), ty1 = Math.floor(lat2py(latMin) / 256);
  console.log(`z${Z}: tiles x ${tx0}..${tx1}, y ${ty0}..${ty1} (${(tx1 - tx0 + 1) * (ty1 - ty0 + 1)})`);
  const tiles = new Map();
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`);
    if (!res.ok) throw new Error(`tile ${Z}/${tx}/${ty} -> ${res.status}`);
    tiles.set(`${tx},${ty}`, PNG.sync.read(Buffer.from(await res.arrayBuffer())));
    process.stdout.write('.');
  }
  console.log(' ok');
  function elevAt(lat, lon) {
    const px = lon2px(lon), py = lat2py(lat);
    const x0 = Math.floor(px - 0.5), y0 = Math.floor(py - 0.5);
    const fx = px - 0.5 - x0, fy = py - 0.5 - y0;
    const get = (gx, gy) => {
      const t = tiles.get(`${Math.floor(gx / 256)},${Math.floor(gy / 256)}`);
      if (!t) return 0;
      const i = ((gy & 255) * 256 + (gx & 255)) * 4;
      return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
    };
    const a = get(x0, y0), b = get(x0 + 1, y0), c = get(x0, y0 + 1), d = get(x0 + 1, y0 + 1);
    return a + (b - a) * fx + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  }
  const hm = new Uint8Array(N * N);
  for (let r = 0; r < N; r++) {
    const lat = LAT0 + (S - 2 * S * r / (N - 1)) / KY;
    for (let q = 0; q < N; q++) {
      const lon = LON0 + (-S + 2 * S * q / (N - 1)) / KX;
      hm[r * N + q] = Math.max(0, Math.min(255, Math.round(elevAt(lat, lon))));
    }
  }
  return hm;
}

(async () => {
  const parts = [];
  for (const g of GRIDS) parts.push(await bakeGrid(g));
  fs.writeFileSync(path.join(DATA, 'heightmap.bin'), Buffer.concat(parts.map(Buffer.from)));
  console.log(`heightmap.bin: ${parts.reduce((s, p) => s + p.length, 0)} bytes (outer ${parts[0].length} + inner ${parts[1].length})`);
})().catch(e => { console.error(e); process.exit(1); });
