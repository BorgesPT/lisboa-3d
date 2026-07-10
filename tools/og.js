// Renders the Open Graph share card (public/og.png, 1200x630) and the PWA
// icon (public/icon-512.png) straight from the map data: the road network,
// the metro lines and the airport in the site's night palette.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const DATA = path.join(__dirname, '..', 'data');
const PUB = path.join(__dirname, '..', 'public');
const LAT0 = 38.740, LON0 = -9.160;
const KY = 111132;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const projM = (lat, lon) => [(lon - LON0) * KX, (lat - LAT0) * KY];

const ROAD_CC = [
  [255, 200, 96], [255, 168, 84], [214, 116, 108], [156, 88, 148], [74, 52, 116],
].map((c, i) => c.map(v => v * [1.6, 1.4, 1.1, 0.9, 0.55][i]));
const RWY = [216, 226, 255], TAXI = [42, 190, 118];
const METRO = { Azul: [82, 131, 197], Amarela: [253, 185, 19], Verde: [0, 170, 166], Vermelha: [238, 43, 116] };
const CLS = { motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0, primary: 1, primary_link: 1, secondary: 2, secondary_link: 2, tertiary: 3, tertiary_link: 3 };
const BG = [5, 6, 15];

function makeCanvas(W, H) {
  return { W, H, acc: new Float64Array(W * H * 3) };
}
function drawLine(cv, x0, y0, x1, y1, col, w) {
  // supersampled stroke: step along the segment, splat a small kernel
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len));
  for (let i = 0; i <= steps; i++) {
    const x = x0 + dx * i / steps, y = y0 + dy * i / steps;
    for (let oy = -w; oy <= w; oy++) for (let ox = -w; ox <= w; ox++) {
      const px = Math.round(x + ox * 0.5), py = Math.round(y + oy * 0.5);
      if (px < 0 || py < 0 || px >= cv.W || py >= cv.H) continue;
      const fall = 1 / (1 + ox * ox + oy * oy);
      const k = (py * cv.W + px) * 3;
      cv.acc[k] += col[0] * fall; cv.acc[k + 1] += col[1] * fall; cv.acc[k + 2] += col[2] * fall;
    }
  }
}
function tonemap(cv, gain) {
  const png = new PNG({ width: cv.W, height: cv.H });
  for (let i = 0; i < cv.W * cv.H; i++) {
    for (let c = 0; c < 3; c++) {
      const v = 1 - Math.exp(-cv.acc[i * 3 + c] * gain / 255);
      png.data[i * 4 + c] = Math.min(255, BG[c] + v * 255);
    }
    png.data[i * 4 + 3] = 255;
  }
  return png;
}

function render(W, H, cx, cy, spanX, outFile, gain) {
  const cv = makeCanvas(W, H);
  const spanY = spanX * H / W;
  const sx = x => (x - cx + spanX / 2) / spanX * W;
  const sy = n => (cy + spanY / 2 - n) / spanY * H;

  const rjson = JSON.parse(fs.readFileSync(path.join(DATA, 'roads.json'), 'utf8'));
  for (const el of rjson.elements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const col = ROAD_CC[CLS[el.tags?.highway] ?? 4];
    for (let i = 1; i < el.geometry.length; i++) {
      const [ax, an] = projM(el.geometry[i - 1].lat, el.geometry[i - 1].lon);
      const [bx, bn] = projM(el.geometry[i].lat, el.geometry[i].lon);
      drawLine(cv, sx(ax), sy(an), sx(bx), sy(bn), col, 1);
    }
  }
  const apath = path.join(DATA, 'airport.json');
  if (fs.existsSync(apath)) {
    const ajson = JSON.parse(fs.readFileSync(apath, 'utf8'));
    for (const el of ajson.elements) {
      if (el.type !== 'way' || !el.geometry) continue;
      const col = el.tags?.aeroway === 'runway' ? RWY : TAXI;
      for (let i = 1; i < el.geometry.length; i++) {
        const [ax, an] = projM(el.geometry[i - 1].lat, el.geometry[i - 1].lon);
        const [bx, bn] = projM(el.geometry[i].lat, el.geometry[i].lon);
        drawLine(cv, sx(ax), sy(an), sx(bx), sy(bn), col, el.tags?.aeroway === 'runway' ? 2 : 1);
      }
    }
  }
  const tjson = JSON.parse(fs.readFileSync(path.join(DATA, 'transit.json'), 'utf8'));
  const seen = new Set();
  for (const rel of tjson.elements) {
    if (rel.type !== 'relation' || rel.tags?.route !== 'subway') continue;
    const col = METRO[rel.tags.ref];
    if (!col) continue;
    for (const m of rel.members || []) {
      if (m.type !== 'way' || !m.geometry || seen.has(m.ref)) continue;
      seen.add(m.ref);
      for (let i = 1; i < m.geometry.length; i++) {
        const [ax, an] = projM(m.geometry[i - 1].lat, m.geometry[i - 1].lon);
        const [bx, bn] = projM(m.geometry[i].lat, m.geometry[i].lon);
        drawLine(cv, sx(ax), sy(an), sx(bx), sy(bn), col.map(c => c * 2), 2);
      }
    }
  }
  fs.writeFileSync(path.join(PUB, outFile), PNG.sync.write(tonemap(cv, gain)));
  console.log(`${outFile}: ${W}x${H}`);
}

// share card: full city incl. airport and both river banks
render(1200, 630, 300, 300, 17500, 'og.png', 0.9);
// app icon: tight crop on the center
render(512, 512, 0, -300, 7000, 'icon-512.png', 0.65);
