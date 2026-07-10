// Packs OSM buildings, roads (+names), metro/tram lines, Tejo water polygon,
// the two bridges and a two-level terrain heightmap
// into src/template.html -> public/index.html
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const DATA = path.join(__dirname, '..', 'data');
const LAT0 = 38.740, LON0 = -9.160;
const KY = 111132;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const Q = 2;                 // packed units per meter
// heightmap grids (must match fetch-dem.js): outer then inner in heightmap.bin
const HS1 = 17000, HN1 = 800, HS2 = 8000, HN2 = 1200;
const HS = HS1, HN = HN1;    // ground extent aliases

function projM(lat, lon) { return [(lon - LON0) * KX, (lat - LAT0) * KY]; } // meters east/north
function proj(lat, lon) { const [x, n] = projM(lat, lon); return [Math.round(x * Q), Math.round(n * Q)]; }
const inRange = v => v >= -32000 && v <= 32000;

/* ================= terrain (two-level, inner blended over outer) ================= */
const hmAll = new Uint8Array(fs.readFileSync(path.join(DATA, 'heightmap.bin')));
const hmOut = hmAll.subarray(0, HN1 * HN1);
const hmIn = hmAll.subarray(HN1 * HN1, HN1 * HN1 + HN2 * HN2);
function sampleGrid(hm, N, S, xE, nN) {
  let q = (xE + S) / (2 * S) * (N - 1), r = (S - nN) / (2 * S) * (N - 1);
  q = Math.max(0, Math.min(N - 1.001, q)); r = Math.max(0, Math.min(N - 1.001, r));
  const q0 = q | 0, r0 = r | 0, fq = q - q0, fr = r - r0;
  const a = hm[r0 * N + q0], b = hm[r0 * N + q0 + 1], c = hm[(r0 + 1) * N + q0], d = hm[(r0 + 1) * N + q0 + 1];
  return a + (b - a) * fq + ((c + (d - c) * fq) - (a + (b - a) * fq)) * fr;
}
function terra(xE, nN) {
  const d = Math.max(Math.abs(xE), Math.abs(nN));
  if (d >= HS2 - 100) return sampleGrid(hmOut, HN1, HS1, xE, nN);
  const inner = sampleGrid(hmIn, HN2, HS2, xE, nN);
  if (d < HS2 - 700) return inner;
  const t = (d - (HS2 - 700)) / 600;
  return inner + (sampleGrid(hmOut, HN1, HS1, xE, nN) - inner) * t;
}

/* ================= buildings ================= */
const bjson = JSON.parse(fs.readFileSync(path.join(DATA, 'buildings.json'), 'utf8'));
let rings = [];
let heightTagged = 0, levelTagged = 0;
for (const el of bjson.elements) {
  if (el.type !== 'way' || !el.geometry) continue;
  const t = el.tags || {};
  if (!t.building || t.building === 'no') continue;
  let g = el.geometry;
  if (g.length > 1) {
    const a = g[0], b = g[g.length - 1];
    if (a.lat === b.lat && a.lon === b.lon) g = g.slice(0, -1);
  }
  if (g.length < 3 || g.length > 4000) continue;
  const pts = [];
  let ok = true;
  for (const p of g) {
    const [x, y] = proj(p.lat, p.lon);
    if (!inRange(x) || !inRange(y)) { ok = false; break; }
    const last = pts[pts.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    pts.push([x, y]);
  }
  if (!ok || pts.length < 3) continue;
  let h = NaN;
  if (t.height) h = parseFloat(String(t.height).replace(',', '.'));
  if (isFinite(h) && h > 0) { heightTagged++; }
  else {
    const lv = parseFloat(t['building:levels']);
    if (isFinite(lv) && lv > 0) { h = lv * 3.2 + 1.5; levelTagged++; }
    else h = 4.5 + (el.id % 17) * 0.55;
  }
  h = Math.min(Math.max(h, 2.5), 300);
  rings.push({ pts, h });
}
let totalPts = 0;
for (const r of rings) totalPts += r.pts.length;
const bbuf = Buffer.alloc(rings.length * 4 + totalPts * 4);
let o = 0;
for (const r of rings) {
  bbuf.writeUInt16LE(r.pts.length, o); o += 2;
  bbuf.writeUInt16LE(Math.round(r.h * 4), o); o += 2;
  for (const [x, y] of r.pts) { bbuf.writeInt16LE(x, o); o += 2; bbuf.writeInt16LE(y, o); o += 2; }
}
console.log(`buildings: ${rings.length} (height tag ${heightTagged}, levels ${levelTagged})`);

/* ================= roads (simplify, subdivide, names) ================= */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let dmax = -1, imax = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d > dmax) { dmax = d; imax = i; }
    }
    if (dmax > tol * tol) { keep[imax] = 1; stack.push([a, imax], [imax, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function subdivide(pts, maxLen) { // pts in packed units; maxLen in units
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const d = Math.hypot(bx - ax, by - ay);
    const n = Math.ceil(d / maxLen);
    for (let k = 1; k <= n; k++) out.push([Math.round(ax + (bx - ax) * k / n), Math.round(ay + (by - ay) * k / n)]);
  }
  return out;
}

const rjson = JSON.parse(fs.readFileSync(path.join(DATA, 'roads.json'), 'utf8'));
const CLS = { motorway: 0, motorway_link: 0, trunk: 0, trunk_link: 0, primary: 1, primary_link: 1, secondary: 2, secondary_link: 2, tertiary: 3, tertiary_link: 3 };
const nameIdx = new Map([['', 0]]);
const names = [''];
let roads = [];
for (const el of rjson.elements) {
  if (el.type !== 'way' || !el.geometry) continue;
  const cls = CLS[el.tags?.highway] ?? 4;
  let pts = [];
  for (const p of el.geometry) {
    const [x, y] = proj(p.lat, p.lon);
    if (!inRange(x) || !inRange(y)) { pts = null; break; }
    const last = pts[pts.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    pts.push([x, y]);
  }
  if (!pts || pts.length < 2) continue;
  pts = subdivide(simplify(pts, 2), 25 * Q); // <=25 m segments so streets hug the hills
  if (pts.length < 2 || pts.length > 65000) continue;
  const nm = (el.tags?.name || '').trim();
  if (!nameIdx.has(nm)) { nameIdx.set(nm, names.length); names.push(nm); }
  roads.push({ pts, cls, ni: nameIdx.get(nm) });
}
/* airport: taxiways (cls 6) + runway centerlines (cls 5) join the roads buffer */
let runways = []; // kept in meters for the ribbon meshes later
const airportPath = path.join(DATA, 'airport.json');
if (fs.existsSync(airportPath)) {
  const ajson = JSON.parse(fs.readFileSync(airportPath, 'utf8'));
  let nTaxi = 0;
  for (const el of ajson.elements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const t = el.tags || {};
    if (t.disused || t.abandoned || t['disused:aeroway']) continue;
    let pts = [];
    for (const pnt of el.geometry) {
      const [x, y] = proj(pnt.lat, pnt.lon);
      if (!inRange(x) || !inRange(y)) { pts = null; break; }
      const last = pts[pts.length - 1];
      if (last && last[0] === x && last[1] === y) continue;
      pts.push([x, y]);
    }
    if (!pts || pts.length < 2) continue;
    pts = subdivide(simplify(pts, 2), 25 * Q);
    if (t.aeroway === 'runway') {
      const nm = `Pista ${t.ref || ''} — Aeroporto Humberto Delgado`.replace('  ', ' ');
      if (!nameIdx.has(nm)) { nameIdx.set(nm, names.length); names.push(nm); }
      roads.push({ pts, cls: 5, ni: nameIdx.get(nm) });
      runways.push({
        pts: el.geometry.map(pnt => projM(pnt.lat, pnt.lon)),
        width: parseFloat(t.width) || 55,
      });
    } else {
      const nm = 'Aeroporto Humberto Delgado' + (t.ref ? ` — caminho ${t.ref}` : '');
      if (!nameIdx.has(nm)) { nameIdx.set(nm, names.length); names.push(nm); }
      roads.push({ pts, cls: 6, ni: nameIdx.get(nm) });
      nTaxi++;
    }
  }
  console.log(`airport: ${runways.length} runways, ${nTaxi} taxiways`);
} else {
  console.log('airport: data/airport.json missing, skipping');
}

let rPts = 0;
for (const r of roads) rPts += r.pts.length;
const rbuf = Buffer.alloc(roads.length * 5 + rPts * 4);
o = 0;
for (const r of roads) {
  rbuf.writeUInt16LE(r.pts.length, o); o += 2;
  rbuf.writeUInt8(r.cls, o); o += 1;
  rbuf.writeUInt16LE(r.ni, o); o += 2;
  for (const [x, y] of r.pts) { rbuf.writeInt16LE(x, o); o += 2; rbuf.writeInt16LE(y, o); o += 2; }
}
console.log(`roads: ${roads.length} ways, ${rPts} pts, ${names.length} unique names`);

/* ================= water: stitch coastline into the Tejo polygon ================= */
const cjson = JSON.parse(fs.readFileSync(path.join(DATA, 'coastline.json'), 'utf8'));
const key = p => p.lat.toFixed(7) + ',' + p.lon.toFixed(7);
let segs = [];
for (const el of cjson.elements) {
  if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
  segs.push(el.geometry.map(p => ({ lat: p.lat, lon: p.lon })));
}
const byStart = new Map();
for (const s of segs) {
  const k = key(s[0]);
  if (!byStart.has(k)) byStart.set(k, []);
  byStart.get(k).push(s);
}
const used = new Set();
let chains = [];
for (const s of segs) {
  if (used.has(s)) continue;
  used.add(s);
  let chain = s.slice();
  for (;;) { // extend forward
    const cands = (byStart.get(key(chain[chain.length - 1])) || []).filter(w => !used.has(w));
    if (!cands.length) break;
    used.add(cands[0]);
    chain = chain.concat(cands[0].slice(1));
  }
  chains.push(chain);
}
// merge chains whose start continues another chain's end (partial ordering above may split)
let merged = true;
while (merged) {
  merged = false;
  outer: for (let i = 0; i < chains.length; i++) for (let j = 0; j < chains.length; j++) {
    if (i === j) continue;
    if (key(chains[i][chains[i].length - 1]) === key(chains[j][0])) {
      chains[i] = chains[i].concat(chains[j].slice(1));
      chains.splice(j, 1); merged = true; break outer;
    }
  }
}
const chainLen = c => { let L = 0; for (let i = 1; i < c.length; i++) { const [ax, an] = projM(c[i - 1].lat, c[i - 1].lon), [bx, bn] = projM(c[i].lat, c[i].lon); L += Math.hypot(bx - ax, bn - an); } return L; };
chains = chains
  .filter(c => key(c[0]) !== key(c[c.length - 1])) // drop closed rings (islets)
  .map(c => ({ c, L: chainLen(c) }))
  .sort((a, b) => b.L - a.L);
console.log('coastline chains (km):', chains.slice(0, 6).map(x => (x.L / 1000).toFixed(1)).join(', '));
const two = chains.slice(0, 2).map(x => x.c.map(p => projM(p.lat, p.lon)));
const meanN = c => c.reduce((s, p) => s + p[1], 0) / c.length;
let north = two[0], south = two[1];
if (meanN(south) > meanN(north)) [north, south] = [south, north];
// coastline has water on the right: north bank runs west->east, south bank east->west
if (north[0][0] > north[north.length - 1][0]) { console.log('WARN: reversing north chain'); north.reverse(); }
if (south[0][0] < south[south.length - 1][0]) { console.log('WARN: reversing south chain'); south.reverse(); }
let waterPoly = simplify(north.concat(south).map(p => [p[0], p[1]]), 4);
console.log(`water polygon: ${waterPoly.length} pts`);

// node-side ear clip (same as client)
function triangulatePoly(pts) {
  const n = pts.length, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += xs[j] * ys[i] - xs[i] * ys[j];
  const order = Array.from({ length: n }, (_, i) => i);
  if (area < 0) order.reverse();
  const V = order, out = [];
  const cross = (a, b, c) => (xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a]);
  let guard = n * n + 10;
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
      if (ear) { out.push(a, b, c); V.splice(i, 1); clipped = true; break; }
    }
    if (!clipped) { const i = bestI; out.push(V[(i + V.length - 1) % V.length], V[i], V[(i + 1) % V.length]); V.splice(i, 1); }
  }
  if (V.length === 3) out.push(V[0], V[1], V[2]);
  return out;
}
const waterIdx = triangulatePoly(waterPoly);

/* bake water into heightmap (elev 0 under water) + debug png */
function fillMask(poly, N, S) {
  const mask = new Uint8Array(N * N);
  const xsP = poly.map(p => (p[0] + S) / (2 * S) * (N - 1));
  const ysP = poly.map(p => (S - p[1]) / (2 * S) * (N - 1));
  for (let r = 0; r < N; r++) {
    const xsAt = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const y0 = ysP[j], y1 = ysP[i];
      if ((y0 <= r) !== (y1 <= r)) xsAt.push(xsP[j] + (r - y0) / (y1 - y0) * (xsP[i] - xsP[j]));
    }
    xsAt.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xsAt.length; k += 2) {
      const q0 = Math.max(0, Math.ceil(xsAt[k])), q1 = Math.min(N - 1, Math.floor(xsAt[k + 1]));
      for (let q = q0; q <= q1; q++) mask[r * N + q] = 1;
    }
  }
  return mask;
}
const maskOut = fillMask(waterPoly, HN1, HS1);
const maskIn = fillMask(waterPoly, HN2, HS2);
let waterCells = 0;
for (let i = 0; i < HN1 * HN1; i++) if (maskOut[i]) { hmOut[i] = 0; waterCells++; }
for (let i = 0; i < HN2 * HN2; i++) if (maskIn[i]) hmIn[i] = 0;
console.log(`water mask: ${(100 * waterCells / (HN1 * HN1)).toFixed(1)}% of outer map`);
{
  const png = new PNG({ width: HN1, height: HN1 });
  for (let i = 0; i < HN1 * HN1; i++) {
    png.data[i * 4] = hmOut[i]; png.data[i * 4 + 1] = hmOut[i]; png.data[i * 4 + 2] = maskOut[i] ? 160 : hmOut[i]; png.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(path.join(DATA, 'water-debug.png'), PNG.sync.write(png));
}

/* ================= bridges (procedural from OSM centerlines) ================= */
const brjson = JSON.parse(fs.readFileSync(path.join(DATA, 'bridges.json'), 'utf8'));
function bridgeChain(name) {
  const ways = brjson.elements.filter(e => e.type === 'way' && e.geometry && e.tags?.name === name)
    .map(e => e.geometry.map(p => { const [x, n] = projM(p.lat, p.lon); return [x, n]; }));
  // greedy endpoint merge (endpoints within 40 m connect; carriageways stay separate chains)
  const chs = [];
  const usedW = new Set();
  // 5 m: only true continuations merge, parallel carriageways stay separate
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 5;
  for (const w of ways) {
    if (usedW.has(w)) continue;
    usedW.add(w);
    let ch = w.slice();
    let grew = true;
    while (grew) {
      grew = false;
      for (const v of ways) {
        if (usedW.has(v)) continue;
        if (near(ch[ch.length - 1], v[0])) { ch = ch.concat(v.slice(1)); usedW.add(v); grew = true; }
        else if (near(ch[ch.length - 1], v[v.length - 1])) { ch = ch.concat(v.slice().reverse().slice(1)); usedW.add(v); grew = true; }
        else if (near(ch[0], v[v.length - 1])) { ch = v.slice(0, -1).concat(ch); usedW.add(v); grew = true; }
        else if (near(ch[0], v[0])) { ch = v.slice().reverse().slice(0, -1).concat(ch); usedW.add(v); grew = true; }
      }
    }
    chs.push(ch);
  }
  let L = 0, best = chs[0];
  for (const c of chs) {
    let l = 0;
    for (let i = 1; i < c.length; i++) l += Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]);
    if (l > L) { L = l; best = c; }
  }
  if (best[0][1] < best[best.length - 1][1]) best.reverse(); // start at the north end
  return { pts: best, L };
}
function resample(pts, step) {
  const out = [[pts[0][0], pts[0][1], 0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let [ax, an] = pts[i - 1], [bx, bn] = pts[i];
    const d = Math.hypot(bx - ax, bn - an);
    const n = Math.max(1, Math.round(d / step));
    for (let k = 1; k <= n; k++) out.push([ax + (bx - ax) * k / n, an + (bn - an) * k / n, acc + d * k / n]);
    acc += d;
  }
  return out; // [x, north, chainage]
}
const smooth01 = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

const mesh = { pos: [], col: [], idx: [] };
const blines = { pos: [], col: [] };
const LIGHT2 = [0.552, 0.834];
const R1 = v => Math.round(v * 10) / 10;
function meshQuad(p, cols) { // p: 4x [x, north, y]; cols: 4x [r,g,b]
  const b = mesh.pos.length / 3;
  for (let i = 0; i < 4; i++) {
    mesh.pos.push(R1(p[i][0]), R1(p[i][2]), R1(-p[i][1]));
    mesh.col.push(cols[i][0] | 0, cols[i][1] | 0, cols[i][2] | 0);
  }
  mesh.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
}
function shadeWall(col, nx, nn) {
  const s = 0.42 + 0.58 * Math.max(0, nx * LIGHT2[0] + nn * LIGHT2[1]);
  return [col[0] * s, col[1] * s, col[2] * s];
}
function addBox(cx, cn, ax, an, halfA, halfP, y0, y1, col) {
  const px = -an, pn = ax; // perp
  const c4 = [
    [cx + ax * halfA + px * halfP, cn + an * halfA + pn * halfP],
    [cx + ax * halfA - px * halfP, cn + an * halfA - pn * halfP],
    [cx - ax * halfA - px * halfP, cn - an * halfA - pn * halfP],
    [cx - ax * halfA + px * halfP, cn - an * halfA + pn * halfP],
  ];
  for (let i = 0; i < 4; i++) {
    const a = c4[i], b = c4[(i + 1) % 4];
    const ex = b[0] - a[0], en = b[1] - a[1], el = Math.hypot(ex, en) || 1;
    const w = shadeWall(col, en / el, -ex / el);
    meshQuad([[a[0], a[1], y0], [b[0], b[1], y0], [b[0], b[1], y1], [a[0], a[1], y1]], [w, w, w, w]);
  }
  const t = [Math.min(255, col[0] * 1.15), Math.min(255, col[1] * 1.15), Math.min(255, col[2] * 1.15)];
  meshQuad([[c4[0][0], c4[0][1], y1], [c4[1][0], c4[1][1], y1], [c4[2][0], c4[2][1], y1], [c4[3][0], c4[3][1], y1]], [t, t, t, t]);
}
function seg(p0, p1, col) {
  blines.pos.push(R1(p0[0]), R1(p0[2]), R1(-p0[1]), R1(p1[0]), R1(p1[2]), R1(-p1[1]));
  blines.col.push(col[0], col[1], col[2], col[0], col[1], col[2]);
}
const DECK_TOP = [34, 42, 84], DECK_SIDE = [66, 82, 148], TOWER = [242, 172, 92];
const GLOW_EDGE = [255, 200, 96], CABLE = [255, 196, 110], HANGER = [168, 122, 74];

function addDeck(line, width, thick) { // line: [x, north, yDeck]
  const half = width / 2;
  const L = [], R = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    let dx = b[0] - a[0], dn = b[1] - a[1];
    const l = Math.hypot(dx, dn) || 1; dx /= l; dn /= l;
    L.push([line[i][0] - dn * half, line[i][1] + dx * half, line[i][2]]);
    R.push([line[i][0] + dn * half, line[i][1] - dx * half, line[i][2]]);
  }
  for (let i = 1; i < line.length; i++) {
    meshQuad([L[i - 1], R[i - 1], R[i], L[i]], [DECK_TOP, DECK_TOP, DECK_TOP, DECK_TOP]);
    const lo = t => [t[0], t[1], t[2] - thick];
    meshQuad([L[i - 1], L[i], lo(L[i]), lo(L[i - 1])], [DECK_SIDE, DECK_SIDE, DECK_SIDE, DECK_SIDE]);
    meshQuad([R[i - 1], R[i], lo(R[i]), lo(R[i - 1])], [DECK_SIDE, DECK_SIDE, DECK_SIDE, DECK_SIDE]);
    seg([L[i - 1][0], L[i - 1][1], L[i - 1][2] + 0.6], [L[i][0], L[i][1], L[i][2] + 0.6], GLOW_EDGE);
    seg([R[i - 1][0], R[i - 1][1], R[i - 1][2] + 0.6], [R[i][0], R[i][1], R[i][2] + 0.6], GLOW_EDGE);
  }
}
const at = (line, s) => { // interp line point+dir at chainage s
  let i = 1;
  while (i < line.length - 1 && line[i][2] < s) i++;
  const a = line[i - 1], b = line[i];
  const t = Math.max(0, Math.min(1, (s - a[2]) / ((b[2] - a[2]) || 1)));
  const dx = b[0] - a[0], dn = b[1] - a[1], l = Math.hypot(dx, dn) || 1;
  return { x: a[0] + dx * t, n: a[1] + dn * t, ax: dx / l, an: dn / l };
};

/* ---- Ponte 25 de Abril: suspension ---- */
{
  const { pts, L } = bridgeChain('Ponte 25 de Abril');
  const line = resample(pts, 22);
  let sN = 0, sS = L;
  for (const p of line) { if (terra(p[0], p[1]) < 2) { sN = p[2]; break; } }
  for (let i = line.length - 1; i >= 0; i--) { if (terra(line[i][0], line[i][1]) < 2) { sS = line[i][2]; break; } }
  const hN = terra(line[0][0], line[0][1]) + 8, hS = terra(line[line.length - 1][0], line[line.length - 1][1]) + 8;
  const deckY = s => {
    let y = 71;
    y = y + (hN - y) * smooth01(1 - s / 500) + (hS - y) * smooth01(1 - (L - s) / 400);
    return y;
  };
  const deck = line.map(p => [p[0], p[1], deckY(p[2])]);
  addDeck(deck, 24, 5);
  const sT1 = sN + 483, sT2 = Math.min(sT1 + 1013, sS - 300);
  console.log(`25 Abril: L ${(L / 1000).toFixed(2)} km, water ${(sN / 1000).toFixed(2)}..${(sS / 1000).toFixed(2)} km, towers @ ${(sT1 / 1000).toFixed(2)}/${(sT2 / 1000).toFixed(2)}`);
  const TOP = 185;
  for (const sT of [sT1, sT2]) {
    const p = at(line, sT);
    for (const side of [-1, 1]) addBox(p.x - p.an * side * 13.5, p.n + p.ax * side * 13.5, p.ax, p.an, 4.5, 4.5, 0, TOP, TOWER);
    addBox(p.x, p.n, p.ax, p.an, 3.5, 13.5, 78, 90, TOWER);
    addBox(p.x, p.n, p.ax, p.an, 3.5, 13.5, 172, 184, TOWER);
  }
  // main cables: parabola through tower tops with mid sag, straight side spans
  const cableY = s => {
    if (s < sT1) { const t = (s - sN) / (sT1 - sN); return 74 + (TOP - 74) * t * t * 0.6 + (TOP - 74) * 0.4 * t; }
    if (s > sT2) { const t = (sS - s) / (sS - sT2); return 74 + (TOP - 74) * t * t * 0.6 + (TOP - 74) * 0.4 * t; }
    const m = (sT1 + sT2) / 2, half = (sT2 - sT1) / 2, u = (s - m) / half;
    return 76 + (TOP - 76) * u * u;
  };
  for (const side of [-1, 1]) {
    let prev = null;
    for (let s = sN; s <= sS + 1; s += 24) {
      const p = at(line, Math.min(s, sS));
      const pt = [p.x - p.an * side * 11.5, p.n + p.ax * side * 11.5, cableY(Math.min(s, sS))];
      if (prev) seg(prev, pt, CABLE);
      prev = pt;
    }
    for (let s = sN + 40; s < sS - 20; s += 32) {
      const p = at(line, s);
      const hx = p.x - p.an * side * 11.5, hn = p.n + p.ax * side * 11.5;
      seg([hx, hn, cableY(s)], [hx, hn, deckY(s) + 1], HANGER);
    }
  }
  // approach piers
  for (let s = 90; s < sN - 40; s += 90) {
    const p = at(line, s);
    addBox(p.x, p.n, p.ax, p.an, 3, 9, terra(p.x, p.n) - 1, deckY(s) - 5, DECK_SIDE);
  }
  for (let s = sS + 60; s < L - 60; s += 90) {
    const p = at(line, s);
    addBox(p.x, p.n, p.ax, p.an, 3, 9, terra(p.x, p.n) - 1, deckY(s) - 5, DECK_SIDE);
  }
}

/* ---- Ponte Vasco da Gama: cable-stayed + viaduct ---- */
{
  const { pts, L } = bridgeChain('Ponte Vasco da Gama');
  const line = resample(pts, 30);
  let sN = 0;
  for (const p of line) { if (terra(p[0], p[1]) < 2) { sN = p[2]; break; } }
  const sMain = sN + 1300, TOP = 148;
  const hN = terra(line[0][0], line[0][1]) + 8, hS = terra(line[line.length - 1][0], line[line.length - 1][1]) + 8;
  const deckY = s => {
    let y = 16 + 31 * Math.exp(-(((s - sMain) / 620) ** 2));
    y = y + (hN - y) * smooth01(1 - s / 400) + (hS - y) * smooth01(1 - (L - s) / 400);
    return y;
  };
  console.log(`Vasco da Gama: L ${(L / 1000).toFixed(2)} km, water from ${(sN / 1000).toFixed(2)} km, main span @ ${(sMain / 1000).toFixed(2)} km`);
  const deck = line.map(p => [p[0], p[1], deckY(p[2])]);
  addDeck(deck, 20, 4);
  for (const sP of [sMain - 210, sMain + 210]) {
    const p = at(line, sP);
    for (const side of [-1, 1]) addBox(p.x - p.an * side * 12, p.n + p.ax * side * 12, p.ax, p.an, 3.2, 3.2, 0, TOP, TOWER);
    addBox(p.x, p.n, p.ax, p.an, 2.5, 12, 52, 60, TOWER);
    // stay cables: fan from upper pylon to deck, both directions
    for (const dir of [-1, 1]) for (let i = 0; i < 11; i++) {
      const sA = sP + dir * (38 + i * 17);
      const a = at(line, sA);
      for (const side of [-1, 1]) {
        seg([p.x - p.an * side * 11, p.n + p.ax * side * 11, TOP - 6 - i * 5.5],
            [a.x - a.an * side * 9, a.n + a.ax * side * 9, deckY(sA) + 1], CABLE);
      }
    }
  }
  for (let s = 70; s < L - 60; s += 130) {
    if (Math.abs(s - sMain) < 430) continue;
    const p = at(line, s);
    addBox(p.x, p.n, p.ax, p.an, 2.6, 8, Math.min(terra(p.x, p.n), 1) - 1, deckY(s) - 3, DECK_SIDE);
  }
}
/* ---- runway ribbons: dark strip + white edge lights ---- */
const RWY_TOP = [26, 33, 60], RWY_EDGE = [212, 222, 255];
for (const rw of runways) {
  const line = resample(rw.pts, 30).map(p => [p[0], p[1], terra(p[0], p[1]) + 0.9]);
  const half = rw.width / 2;
  const L = [], R = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    let dx = b[0] - a[0], dn = b[1] - a[1];
    const l = Math.hypot(dx, dn) || 1; dx /= l; dn /= l;
    L.push([line[i][0] - dn * half, line[i][1] + dx * half, line[i][2]]);
    R.push([line[i][0] + dn * half, line[i][1] - dx * half, line[i][2]]);
  }
  for (let i = 1; i < line.length; i++) {
    meshQuad([L[i - 1], R[i - 1], R[i], L[i]], [RWY_TOP, RWY_TOP, RWY_TOP, RWY_TOP]);
    seg([L[i - 1][0], L[i - 1][1], L[i - 1][2] + 0.5], [L[i][0], L[i][1], L[i][2] + 0.5], RWY_EDGE);
    seg([R[i - 1][0], R[i - 1][1], R[i - 1][2] + 0.5], [R[i][0], R[i][1], R[i][2] + 0.5], RWY_EDGE);
  }
}

console.log(`bridge+runway mesh: ${mesh.pos.length / 3} verts, lines: ${blines.pos.length / 6} segs`);

/* ================= metro lines ================= */
const tjson = JSON.parse(fs.readFileSync(path.join(DATA, 'transit.json'), 'utf8'));
// official Metro de Lisboa palette (Wikidata P465 per line)
const METRO_COL = {
  Azul: [82, 131, 197],      // #5283C5
  Amarela: [253, 185, 19],   // #FDB913
  Verde: [0, 170, 166],      // #00AAA6
  Vermelha: [238, 43, 116],  // #EE2B74
};
const METRO_ORDER = { Azul: 0, Amarela: 1, Verde: 2, Vermelha: 3 };
const lineDefs = new Map(); // ref -> {name, col, ways:Map(wayId->pts)}
for (const rel of tjson.elements) {
  if (rel.type !== 'relation' || !rel.members) continue;
  const t = rel.tags || {};
  if (t.route !== 'subway' || !METRO_COL[t.ref]) continue;
  if (!lineDefs.has(t.ref)) {
    lineDefs.set(t.ref, {
      name: `Linha ${t.ref}`,
      metro: true,
      col: METRO_COL[t.ref],
      ways: new Map(),
      order: METRO_ORDER[t.ref],
    });
  }
  const def = lineDefs.get(t.ref);
  for (const m of rel.members) {
    if (m.type !== 'way' || !m.geometry || m.geometry.length < 2) continue;
    if (m.role && /platform|stop/.test(m.role)) continue;
    if (def.ways.has(m.ref)) continue;
    let pts = [];
    for (const p of m.geometry) {
      const [x, y] = proj(p.lat, p.lon);
      if (!inRange(x) || !inRange(y)) { pts = null; break; }
      const last = pts[pts.length - 1];
      if (last && last[0] === x && last[1] === y) continue;
      pts.push([x, y]);
    }
    if (pts && pts.length >= 2) def.ways.set(m.ref, pts);
  }
}
const lines = [...lineDefs.values()].sort((a, b) => a.order - b.order);
const transitLines = lines.map(l => ({ n: l.name, c: l.col, m: l.metro ? 1 : 0 }));
let tways = [];
lines.forEach((l, li) => {
  for (let pts of l.ways.values()) {
    pts = subdivide(simplify(pts, 2), 25 * Q);
    if (pts.length >= 2 && pts.length < 65000) tways.push({ pts, li });
  }
});
let tPts = 0;
for (const w of tways) tPts += w.pts.length;
const tbuf = Buffer.alloc(tways.length * 3 + tPts * 4);
o = 0;
for (const w of tways) {
  tbuf.writeUInt16LE(w.pts.length, o); o += 2;
  tbuf.writeUInt8(w.li, o); o += 1;
  for (const [x, y] of w.pts) { tbuf.writeInt16LE(x, o); o += 2; tbuf.writeInt16LE(y, o); o += 2; }
}
console.log(`transit: ${lines.length} lines (${lines.map(l => l.name).join(', ')}), ${tways.length} ways, ${tPts} pts`);

/* ================= freguesia borders + labels ================= */
let fbuf = Buffer.alloc(0), freguesias = [];
const fregPath = path.join(DATA, 'freguesias.json');
if (fs.existsSync(fregPath)) {
  const fjson = JSON.parse(fs.readFileSync(fregPath, 'utf8'));
  const seenWays = new Set();
  let fways = [];
  for (const rel of fjson.elements) {
    if (rel.type !== 'relation' || !rel.members) continue;
    const nm = rel.tags?.name;
    if (!nm) continue;
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const m of rel.members) {
      if (m.type !== 'way' || !m.geometry || m.role !== 'outer') continue;
      let pts = [];
      for (const pnt of m.geometry) {
        const [x, y] = proj(pnt.lat, pnt.lon);
        if (!inRange(x) || !inRange(y)) { pts = null; break; }
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        const last = pts && pts[pts.length - 1];
        if (last && last[0] === x && last[1] === y) continue;
        pts.push([x, y]);
      }
      if (!pts || pts.length < 2 || seenWays.has(m.ref)) continue; // shared borders draw once
      seenWays.add(m.ref);
      pts = subdivide(simplify(pts, 2), 25 * Q);
      if (pts.length >= 2 && pts.length < 65000) fways.push(pts);
    }
    if (minX < 1e9) freguesias.push([nm, Math.round((minX + maxX) / 2), Math.round((minY + maxY) / 2)]);
  }
  let fPts = 0;
  for (const w of fways) fPts += w.length;
  fbuf = Buffer.alloc(fways.length * 2 + fPts * 4);
  o = 0;
  for (const w of fways) {
    fbuf.writeUInt16LE(w.length, o); o += 2;
    for (const [x, y] of w) { fbuf.writeInt16LE(x, o); o += 2; fbuf.writeInt16LE(y, o); o += 2; }
  }
  console.log(`freguesias: ${freguesias.length}, ${fways.length} border ways, ${fPts} pts`);
} else {
  console.log('freguesias: data/freguesias.json missing, skipping');
}

/* ================= landmarks ================= */
const LM = [
  ['Baixa', 38.7106, -9.1373, 2200, 0.95],
  ['Alfama & Castelo', 38.7128, -9.1333, 1500, 1.0],
  ['Belém', 38.6970, -9.2033, 3200, 0.9],
  ['Parque das Nações', 38.7686, -9.0964, 3200, 0.85],
  ['Marquês & Avenida', 38.7256, -9.1500, 2400, 0.95],
  ['Amoreiras', 38.7229, -9.1620, 1800, 0.95],
  ['Ponte 25 de Abril', 38.6935, -9.1772, 2400, 0.62],
  ['Ponte Vasco da Gama', 38.7660, -9.0730, 3600, 0.7],
  ['Aeroporto', 38.7742, -9.1342, 3000, 0.85],
].map(([n, lat, lon, d, p]) => { const [x, y] = proj(lat, lon); return [n, x, y, d, p]; });

/* ================= inject ================= */
const waterPos = [];
for (const [x, n] of waterPoly) waterPos.push(Math.round(x), Math.round(-n));
let html = fs.readFileSync(path.join(__dirname, '..', 'src', 'template.html'), 'utf8');
html = html
  .replace('"__B64_BUILDINGS__"', JSON.stringify(bbuf.toString('base64')))
  .replace('"__B64_ROADS__"', JSON.stringify(rbuf.toString('base64')))
  .replace('"__B64_HEIGHT__"', JSON.stringify(Buffer.from(hmAll).toString('base64')))
  .replace('"__B64_TRANSIT__"', JSON.stringify(tbuf.toString('base64')))
  .replace('"__TRANSIT_LINES__"', JSON.stringify(transitLines))
  .replace('"__B64_FREG__"', JSON.stringify(fbuf.toString('base64')))
  .replace('"__FREGUESIAS__"', JSON.stringify(freguesias))
  .replace('"__NAMES__"', JSON.stringify(names))
  .replace('"__WATER__"', JSON.stringify({ pos: waterPos, idx: waterIdx }))
  .replace('"__BRIDGE_MESH__"', JSON.stringify(mesh))
  .replace('"__BRIDGE_LINES__"', JSON.stringify(blines))
  .replace('"__LANDMARKS__"', JSON.stringify(LM))
  .replace('__N_BUILDINGS__', rings.length.toLocaleString('pt-PT'))
  .replace('__N_ROADS__', roads.length.toLocaleString('pt-PT'));
fs.writeFileSync(path.join(__dirname, '..', 'public', 'index.html'), html);
console.log(`public/index.html: ${(html.length / 1048576).toFixed(1)} MB`);
