// Validates the exact decode + triangulation logic that runs in the browser.
const fs = require('fs');
const html = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
const grab = (name) => {
  const m = html.match(new RegExp(`const ${name} = "([^"]*)"`));
  return m[1];
};
const bytes = Buffer.from(grab('B64_BUILDINGS'), 'base64');
const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);

function triangulate(xs, ys, order, outIdx) {
  const V = order.slice();
  const cross = (a, b, c) => (xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a]);
  let guard = V.length * V.length + 10;
  let fallback = false;
  while (V.length > 3 && guard-- > 0) {
    let clipped = false, bestI = 0, bestCr = -Infinity;
    for (let i = 0; i < V.length; i++) {
      const a = V[(i + V.length - 1) % V.length], b = V[i], c = V[(i + 1) % V.length];
      const cr = cross(a, b, c);
      if (cr > bestCr) { bestCr = cr; bestI = i; }
      if (cr <= 0) continue;
      let ear = true;
      for (let j = 0; j < V.length; j++) {
        const p = V[j];
        if (p === a || p === b || p === c) continue;
        if (cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0) { ear = false; break; }
      }
      if (ear) { outIdx.push(a, b, c); V.splice(i, 1); clipped = true; break; }
    }
    if (!clipped) {
      fallback = true;
      const i = bestI, a = V[(i + V.length - 1) % V.length], b = V[i], c = V[(i + 1) % V.length];
      outIdx.push(a, b, c); V.splice(i, 1);
    }
  }
  if (V.length === 3) outIdx.push(V[0], V[1], V[2]);
  return fallback;
}

let o = 0, nb = 0, totPts = 0;
while (o < bytes.length) {
  const n = dv.getUint16(o, true);
  if (n < 3) throw new Error(`bad npts ${n} at ${o}`);
  o += 4 + n * 4; nb++; totPts += n;
}
if (o !== bytes.length) throw new Error('offset mismatch');
console.log(`parsed ${nb} buildings, ${totPts} pts — stream aligned OK`);

const t0 = Date.now();
o = 0;
const xs = new Float64Array(512), ys = new Float64Array(512);
let fallbacks = 0, io = 0, vo = 0, maxH = 0, minH = 1e9;
for (let k = 0; k < nb; k++) {
  const n = dv.getUint16(o, true); o += 2;
  const h = dv.getUint16(o, true) * 0.25; o += 2;
  maxH = Math.max(maxH, h); minH = Math.min(minH, h);
  for (let i = 0; i < n; i++) {
    xs[i] = dv.getInt16(o, true) * 0.5; o += 2;
    ys[i] = dv.getInt16(o, true) * 0.5; o += 2;
  }
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += (xs[j] * ys[i] - xs[i] * ys[j]);
  if (area < 0) {
    for (let i = 0, j = n - 1; i < j; i++, j--) {
      let t = xs[i]; xs[i] = xs[j]; xs[j] = t;
      t = ys[i]; ys[i] = ys[j]; ys[j] = t;
    }
  }
  const tri = [];
  if (triangulate(xs, ys, Array.from({ length: n }, (_, i) => i), tri)) fallbacks++;
  io += 6 * n + tri.length;
  vo += 5 * n;
  if (tri.length !== (n - 2) * 3) throw new Error(`tri count ${tri.length} vs expected ${(n - 2) * 3} (n=${n}, building ${k})`);
}
console.log(`triangulated all: ${(Date.now() - t0)} ms, ${fallbacks} degenerate fallbacks`);
console.log(`verts ${vo} (cap ${totPts * 5}), idx ${io} (cap ${totPts * 9})`);
console.log(`heights ${minH}–${maxH} m`);
