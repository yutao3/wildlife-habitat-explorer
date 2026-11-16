/* analyse.js — WildScope "analyse any area": the same pipeline as the pilot region, run in the browser.
   1. fetchInputs(bbox): ESA WorldCover 2021 + one clear summer Sentinel-2 L2A scene (Microsoft Planetary
      Computer), OpenStreetMap roads and water (Overpass), at 10 m pixels.
   2. computeGrid(inputs, {cellM}): 15 indicators (0–100) + raw measurements per square (default 50 m).
   3. fetchSightings(bbox): GBIF roe deer + other-mammal records for a live evidence check.
   All services are free, keyless and CORS-enabled. computeGrid is also used to build the pilot grid. */

const PC = 'https://planetarycomputer.microsoft.com/api';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
export const LAYER_ORDER = ['valid', 'woodland', 'cover', 'open', 'forage', 'crops', 'moisture', 'mosaic', 'edge', 'edge_near', 'towns_far', 'roads_far', 'water', 'diversity', 'natural', 'spectral',
  'raw_tree', 'raw_open', 'raw_crop', 'raw_built', 'raw_ndvi', 'raw_ndmi', 'raw_dedge', 'raw_droad_only', 'raw_dtown', 'raw_dwater'];

const metresPerDeg = (lat) => ({ x: 111320 * Math.cos(lat * Math.PI / 180), y: 110540 });

/** Snap a bbox so that it holds a whole number of squares of cellM metres. */
export function gridFor(center, sizeKm, cellM, pxM) {
  const m = metresPerDeg(center.lat);
  const cells = Math.round(sizeKm * 1000 / cellM);
  const dx = cellM / m.x, dy = cellM / m.y;
  const w = center.lng - cells * dx / 2, n = center.lat + cells * dy / 2;
  const bbox = [w, n - cells * dy, w + cells * dx, n].map(v => +v.toFixed(6));
  return { bbox, cols: cells, rows: cells, S: Math.round(cellM / pxM), W: cells * Math.round(cellM / pxM), H: cells * Math.round(cellM / pxM) };
}

async function img(url, w, h) {
  let r;
  for (let attempt = 0; ; attempt++) {   // one retry: the free image service sometimes drops a tile
    try { r = await fetch(url, { signal: AbortSignal.timeout(25000) }); if (r.ok) break; throw new Error(`image service HTTP ${r.status}`); }
    catch (e) { if (attempt) throw new Error(e.name === 'TimeoutError' ? 'the satellite image service timed out' : e.message); }
  }
  const bm = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = new OffscreenCanvas(w, h); const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bm, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}
/** One layer from the Planetary Computer, fetched in tiles of at most 1024 px (the API caps one image at 2048). */
async function pcLayer(bbox, W, H, query) {
  const out = new Uint8ClampedArray(W * H * 4); const T = 1024; const dx = (bbox[2] - bbox[0]) / W, dy = (bbox[3] - bbox[1]) / H;
  const jobs = [];
  for (let y0 = 0; y0 < H; y0 += T) for (let x0 = 0; x0 < W; x0 += T) {
    const w = Math.min(T, W - x0), h = Math.min(T, H - y0);
    const bb = [bbox[0] + x0 * dx, bbox[3] - (y0 + h) * dy, bbox[0] + (x0 + w) * dx, bbox[3] - y0 * dy].map(v => v.toFixed(7)).join(',');
    jobs.push(img(`${PC}/data/v1/item/bbox/${bb}/${w}x${h}.png?${query}`, w, h).then(d => { for (let y = 0; y < h; y++) out.set(d.subarray(y * w * 4, (y + 1) * w * 4), ((y0 + y) * W + x0) * 4); }));
  }
  await Promise.all(jobs);
  return out;
}
async function stac(body) {
  const r = await fetch(`${PC}/stac/v1/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`catalogue HTTP ${r.status}`); return (await r.json()).features || [];
}
const covers = (ib, b) => ib[0] <= b[0] && ib[1] <= b[1] && ib[2] >= b[2] && ib[3] >= b[3];

/** Growing-season windows for a latitude: northern summer, southern summer, or the last 12 months in the tropics. */
function seasonWindows(lat) {
  const now = new Date(); const y = now.getUTCFullYear(), m = now.getUTCMonth(); const iso = (d) => d.toISOString().slice(0, 10);
  if (Math.abs(lat) < 23.5) { const day = 864e5; return [[iso(new Date(now - 365 * day)), iso(now)], [iso(new Date(now - 730 * day)), iso(new Date(now - 365 * day))]]; }
  if (lat >= 0) return (m >= 8 ? [y, y - 1] : [y - 1, y - 2]).map(yr => [`${yr}-06-01`, `${yr}-09-15`]);
  return (m >= 3 ? [y, y - 1] : [y - 1, y - 2]).map(yr => [`${yr - 1}-12-01`, `${yr}-03-15`]);
}
/** Clearest growing-season scene that covers the whole box (falls back to the clearest partial one). */
async function pickScene(bbox) {
  const lat = (bbox[1] + bbox[3]) / 2; const byCloud = (a, b) => a.properties['eo:cloud_cover'] - b.properties['eo:cloud_cover'];
  let partial = null;
  for (const cloud of [15, 40]) for (const [from, to] of seasonWindows(lat)) {
    const items = await stac({ collections: ['sentinel-2-l2a'], bbox, datetime: `${from}T00:00:00Z/${to}T23:59:59Z`, query: { 'eo:cloud_cover': { lt: cloud } }, limit: 100 });
    const ok = items.filter(f => covers(f.bbox, bbox)).sort(byCloud);
    if (ok.length) return ok[0];
    if (!partial && items.length) partial = items.sort(byCloud)[0];
  }
  if (partial) return partial;
  throw new Error('no clear Sentinel-2 scene found here');
}

/** Ask all Overpass mirrors at once and take the first answer: public servers are often busy, one is usually free. */
async function overpass(q, timeoutMs = 75000) {   // patient: the map is already on screen while this runs
  const ask = async (e) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(e, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).elements.filter(x => x.geometry).map(x => x.geometry.map(p => [p.lon, p.lat]));
    } finally { clearTimeout(t); }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await Promise.any(OVERPASS.map(ask)); } catch { /* all mirrors failed: one more round */ }
  }
  throw new Error('OpenStreetMap servers busy');
}

export async function fetchInputs(g, onStep = () => {}) {
  const { bbox, W, H } = g; const N = W * H;
  onStep('Finding a clear Sentinel-2 scene from the growing season…');
  const [scene, wcItems] = await Promise.all([pickScene(bbox), stac({ collections: ['esa-worldcover'], bbox, limit: 10 })]);
  const wcIds = wcItems.filter(f => /2021/.test(f.id)).map(f => f.id);
  const off = parseFloat(scene.properties['s2:processing_baseline'] || '0') >= 4 ? 2000 : 0;   // since 2022: values stored + 1000
  const s2 = `collection=sentinel-2-l2a&item=${scene.id}`;
  onStep(`Downloading land cover and Sentinel-2 (${scene.properties.datetime.slice(0, 10)})…`);
  const big = (bbox[3] - bbox[1]) * 110.54 > 24;   // large boxes: main roads only, or the volunteer servers time out
  const roadTypes = big ? 'motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link' : 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
  const roadsQ = `[out:json][timeout:60];way["highway"~"^(${roadTypes})$"](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});out skel geom;`;
  const waterQ = `[out:json][timeout:60];(way["waterway"~"^(river|stream|canal)$"](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]});way["natural"="water"](${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}););out skel geom;`;
  const osmP = Promise.all([overpass(roadsQ).catch(e => ({ error: e.message })), overpass(waterQ).catch(e => ({ error: e.message }))]);
  const [wcLayers, nd, nm, sc] = await Promise.all([
    Promise.all(wcIds.map(id => pcLayer(bbox, W, H, `collection=esa-worldcover&item=${id}&assets=map`))),
    pcLayer(bbox, W, H, `${s2}&expression=(B08-B04)/(B08%2BB04-${off})&asset_as_band=true&rescale=-1,1`),
    pcLayer(bbox, W, H, `${s2}&expression=(B08-B11)/(B08%2BB11-${off})&asset_as_band=true&rescale=-1,1`),
    pcLayer(bbox, W, H, `${s2}&assets=SCL`)]);
  const wc = new Uint8Array(N), ndvi = new Float32Array(N), ndmi = new Float32Array(N), scl = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const j = i * 4;
    for (const L of wcLayers) if (L[j + 3] && L[j]) { wc[i] = L[j]; break; }
    ndvi[i] = nd[j + 3] ? nd[j] / 255 * 2 - 1 : NaN; ndmi[i] = nm[j + 3] ? nm[j] / 255 * 2 - 1 : NaN; scl[i] = sc[j + 3] ? sc[j] : 0;
  }
  // Roads and water come from public OpenStreetMap servers that are often slow, so they do not hold up the first map:
  // the caller paints the scores without them and refreshes when "osm" resolves.
  const osm = osmP.then(([roads, water]) => ({ roads: Array.isArray(roads) ? roads : null, water: Array.isArray(water) ? water : [], osmError: roads.error || water.error || null }));
  return { W, H, B: bbox, wc, ndvi, ndmi, scl, roads: null, water: [], osm,
    scene: { id: scene.id, date: scene.properties.datetime.slice(0, 10), cloud: scene.properties['eo:cloud_cover'], partial: !covers(scene.bbox, bbox) } };
}

/** Indicators per square. inputs = {W, H, B, wc, ndvi, ndmi, scl, roads, water}; S = pixels per square side. */
export function computeGrid(inputs, { S, cellM, pxM, nbRadiusM = 300 }) {
  const { W, H, B, wc, ndvi, ndmi, scl } = inputs; const N = W * H;
  const CW = W / S, CH = H / S, NC = CW * CH;
  const X = (lon) => (lon - B[0]) / (B[2] - B[0]) * W, Y = (lat) => (B[3] - lat) / (B[3] - B[1]) * H;
  const lineW = Math.max(1, 30 / pxM);
  function raster(lines, fillClosed) {
    const c = new OffscreenCanvas(W, H); const g = c.getContext('2d', { willReadFrequently: true });
    g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = lineW; g.lineCap = 'round'; g.lineJoin = 'round';
    for (const l of lines || []) {
      if (l.length < 2) continue; g.beginPath(); g.moveTo(X(l[0][0]), Y(l[0][1]));
      for (let k = 1; k < l.length; k++) g.lineTo(X(l[k][0]), Y(l[k][1]));
      if (fillClosed && l.length > 3 && l[0][0] === l[l.length - 1][0] && l[0][1] === l[l.length - 1][1]) { g.closePath(); g.fill(); }
      g.stroke();
    }
    const d = g.getImageData(0, 0, W, H).data; const m = new Uint8Array(N); for (let i = 0; i < N; i++) m[i] = d[i * 4 + 3] > 64 ? 1 : 0; return m;
  }
  function distance(mask) {
    const d = new Float32Array(N); const INF = 1e9, a = 1, b = Math.SQRT2; let any = false;
    for (let i = 0; i < N; i++) { d[i] = mask[i] ? 0 : INF; if (mask[i]) any = true; }
    if (!any) return d.fill(5000);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; let v = d[i]; if (v === 0) continue; if (x > 0) v = Math.min(v, d[i - 1] + a); if (y > 0) { v = Math.min(v, d[i - W] + a); if (x > 0) v = Math.min(v, d[i - W - 1] + b); if (x < W - 1) v = Math.min(v, d[i - W + 1] + b); } d[i] = v; }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) { const i = y * W + x; let v = d[i]; if (v === 0) continue; if (x < W - 1) v = Math.min(v, d[i + 1] + a); if (y < H - 1) { v = Math.min(v, d[i + W] + a); if (x < W - 1) v = Math.min(v, d[i + W + 1] + b); if (x > 0) v = Math.min(v, d[i + W - 1] + b); } d[i] = v; }
    for (let i = 0; i < N; i++) d[i] *= pxM; return d;
  }
  const OPEN = new Set([20, 30, 40, 90]), VEG = new Set([10, 20, 30, 40, 90]), NATURAL = new Set([10, 20, 30, 80, 90]);
  const roadM = inputs.roads ? raster(inputs.roads, false) : null, waterL = raster(inputs.water, true);
  const built = new Uint8Array(N), wet = new Uint8Array(N), edgeM = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, k = wc[i]; built[i] = k === 50 ? 1 : 0; wet[i] = waterL[i] || k === 80 || k === 90 ? 1 : 0;
    if (k === 10 && ((x < W - 1 && OPEN.has(wc[i + 1])) || (x > 0 && OPEN.has(wc[i - 1])) || (y < H - 1 && OPEN.has(wc[i + W])) || (y > 0 && OPEN.has(wc[i - W])))) edgeM[i] = 1;
  }
  const dRoad = roadM ? distance(roadM) : null, dBuilt = distance(built), dWater = distance(wet), dEdge = distance(edgeM);

  const CL = [10, 20, 30, 40, 50, 60, 80, 90]; const cnt = Object.fromEntries(CL.map(k => [k, new Float32Array(NC)]));
  const nPix = new Float32Array(NC), edgeP = new Float32Array(NC), vegN = new Float32Array(NC), vegS = new Float32Array(NC), vegSS = new Float32Array(NC);
  const openN = new Float32Array(NC), openS = new Float32Array(NC), mN = new Float32Array(NC), mS = new Float32Array(NC);
  const sRoad = new Float32Array(NC), sBuilt = new Float32Array(NC), mWater = new Float32Array(NC).fill(1e9), mEdge = new Float32Array(NC).fill(1e9);
  const clear = (i) => scl[i] === 4 || scl[i] === 5 || scl[i] === 6;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, c = Math.floor(y / S) * CW + Math.floor(x / S), k = wc[i]; if (!k) continue;
    nPix[c]++; if (cnt[k]) cnt[k][c]++;
    if (dRoad) sRoad[c] += dRoad[i]; sBuilt[c] += dBuilt[i]; if (dWater[i] < mWater[c]) mWater[c] = dWater[i]; if (dEdge[i] < mEdge[c]) mEdge[c] = dEdge[i];
    if (x % S < S - 1) { const k2 = wc[i + 1]; if ((k === 10 && OPEN.has(k2)) || (k2 === 10 && OPEN.has(k))) edgeP[c]++; }
    if (y % S < S - 1) { const k2 = wc[i + W]; if ((k === 10 && OPEN.has(k2)) || (k2 === 10 && OPEN.has(k))) edgeP[c]++; }
    if (VEG.has(k) && clear(i) && !Number.isNaN(ndvi[i])) {
      vegN[c]++; vegS[c] += ndvi[i]; vegSS[c] += ndvi[i] * ndvi[i];
      if (!Number.isNaN(ndmi[i])) { mN[c]++; mS[c] += ndmi[i]; }
      if (OPEN.has(k)) { openN[c]++; openS[c] += ndvi[i]; }
    }
  }
  // neighbourhood sums within ±nbRadiusM (a square window), via an integral image
  const r = Math.max(1, Math.round(nbRadiusM / cellM));
  function nb(a) {
    const I = new Float64Array((CW + 1) * (CH + 1));
    for (let y = 0; y < CH; y++) { let row = 0; for (let x = 0; x < CW; x++) { row += a[y * CW + x]; I[(y + 1) * (CW + 1) + x + 1] = I[y * (CW + 1) + x + 1] + row; } }
    const out = new Float32Array(NC);
    for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(CW, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(CH, y + r + 1);
      out[y * CW + x] = I[y1 * (CW + 1) + x1] - I[y0 * (CW + 1) + x1] - I[y1 * (CW + 1) + x0] + I[y0 * (CW + 1) + x0];
    }
    return out;
  }
  const nbP = nb(nPix), nbE = nb(edgeP), nbON = nb(openN), nbOS = nb(openS);
  const nbC = Object.fromEntries(CL.map(k => [k, nb(cnt[k])]));
  const pct = (arr, p) => { const v = Array.from(arr).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) * p)] : 0; };
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
  const edgeD = new Float32Array(NC), spec = new Float32Array(NC).fill(NaN), ndmiM = new Float32Array(NC).fill(NaN), shan = new Float32Array(NC);
  const minPix = 0.5 * S * S;
  for (let c = 0; c < NC; c++) {
    edgeD[c] = nbP[c] ? nbE[c] / nbP[c] : 0;
    if (vegN[c] >= minPix) { const m = vegS[c] / vegN[c]; spec[c] = Math.sqrt(Math.max(0, vegSS[c] / vegN[c] - m * m)); }
    if (mN[c] >= minPix) ndmiM[c] = mS[c] / mN[c];
    let tot = 0; const ks = [10, 20, 30, 40, 80, 90]; for (const k of ks) tot += nbC[k][c];
    let h = 0; if (tot) for (const k of ks) { const p = nbC[k][c] / tot; if (p > 0) h -= p * Math.log(p); }
    shan[c] = h / Math.log(4);
  }
  const E98 = pct(edgeD, 0.98) || 1, S02 = pct(spec, 0.02), S98 = pct(spec, 0.98), M02 = pct(ndmiM, 0.02), M98 = pct(ndmiM, 0.98);
  const L = Object.fromEntries(LAYER_ORDER.map(k => [k, new Uint8Array(NC).fill(255)]));
  L.valid.fill(0);
  for (let c = 0; c < NC; c++) {
    if (nPix[c] < minPix) continue;
    const sh = (k) => cnt[k][c] / nPix[c], nsh = (k) => nbC[k][c] / nbP[c];
    L.valid[c] = sh(50) + sh(80) + sh(90) > 0.6 ? 0 : 1;
    const tree = sh(10), open = sh(20) + sh(30) + sh(40) + sh(90);
    const wood = nsh(10), openNb = nsh(20) + nsh(30) + nsh(40) + nsh(90);
    L.woodland[c] = clamp(100 * wood); L.cover[c] = clamp(100 * tree);
    L.open[c] = clamp(100 * openNb / 0.6);
    L.forage[c] = nbON[c] >= minPix ? clamp(100 * ((nbOS[c] / nbON[c]) - 0.25) / 0.5) : 15;
    L.crops[c] = clamp(100 * nsh(40) / 0.5);
    L.moisture[c] = Number.isNaN(ndmiM[c]) ? 255 : clamp(100 * (ndmiM[c] - M02) / ((M98 - M02) || 1));
    L.mosaic[c] = clamp(400 * Math.min(openNb, 0.6) * wood);
    L.edge[c] = clamp(100 * edgeD[c] / E98);
    const de = mEdge[c]; L.edge_near[c] = clamp(100 * (400 - de) / 400);
    const dt = sBuilt[c] / nPix[c]; L.towns_far[c] = clamp(100 * Math.min(dt, 1000) / 1000);
    if (dRoad) { const dr = sRoad[c] / nPix[c]; L.roads_far[c] = clamp(100 * Math.min(dr, 800) / 800); L.raw_droad_only[c] = Math.min(254, Math.round(dr / 20)); }
    const dw = mWater[c]; L.water[c] = clamp(100 * (400 - dw) / 400);
    L.diversity[c] = clamp(100 * shan[c]);
    let nat = 0; for (const k of NATURAL) nat += cnt[k][c]; L.natural[c] = clamp(100 * nat / nPix[c]);
    L.spectral[c] = Number.isNaN(spec[c]) ? 255 : clamp(100 * (spec[c] - S02) / ((S98 - S02) || 1));
    L.raw_tree[c] = clamp(100 * tree); L.raw_open[c] = clamp(100 * open); L.raw_crop[c] = clamp(100 * sh(40)); L.raw_built[c] = clamp(100 * sh(50));
    L.raw_ndvi[c] = vegN[c] ? clamp(100 * Math.max(0, vegS[c] / vegN[c])) : 255;
    L.raw_ndmi[c] = Number.isNaN(ndmiM[c]) ? 255 : clamp(100 * (ndmiM[c] + 0.5));
    L.raw_dedge[c] = Math.min(254, Math.round(de / 20)); L.raw_dtown[c] = Math.min(254, Math.round(dt / 40)); L.raw_dwater[c] = Math.min(254, Math.round(dw / 20));
  }
  return { cols: CW, rows: CH, bbox: B, layers: L, norm: { E98, S02, S98, M02, M98 } };
}

/** GBIF records for a live evidence check: deer (family Cervidae), wild boar / feral pig, and all other
    mammals as the "where do observers go" background. Locations within 250 m only. */
export const GBIF_KEYS = { deer: 5298, boar: 7705930, mammals: 359 };
const GBIF = 'https://api.gbif.org/v1/occurrence/search';
const gbifBox = (bbox) => `${GBIF}?decimalLatitude=${bbox[1]},${bbox[3]}&decimalLongitude=${bbox[0]},${bbox[2]}&hasCoordinate=true&hasGeospatialIssue=false&coordinateUncertaintyInMeters=0,250&basisOfRecord=HUMAN_OBSERVATION&limit=300`;
/** One GBIF page, with a timeout so a slow day at GBIF never freezes the app. */
async function gbifPage(url) { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`GBIF HTTP ${r.status}`); return r.json(); }
export async function fetchSightings(bbox, maxPages = 4) {
  const base = gbifBox(bbox);
  const get = async (q) => { const out = []; for (let p = 0; p < maxPages; p++) { const j = await gbifPage(`${base}${q}&offset=${p * 300}`); out.push(...j.results.map(r => ({ lon: r.decimalLongitude, lat: r.decimalLatitude, year: r.year, sp: r.speciesKey, fam: r.familyKey, name: r.species }))); if (j.endOfRecords) break; } return out; };
  const [deer, boar, mammals] = await Promise.all([get(`&taxonKey=${GBIF_KEYS.deer}`), get(`&taxonKey=${GBIF_KEYS.boar}`), get(`&classKey=${GBIF_KEYS.mammals}`)]);
  const names = {}; for (const r of deer) if (r.name) names[r.name] = (names[r.name] || 0) + 1;
  const deerNames = Object.entries(names).sort((a, b) => b[1] - a[1]).map(([n, c]) => ({ name: n, n: c }));
  return { deer, boar, deerNames, others: mammals.filter(r => r.fam !== GBIF_KEYS.deer && r.sp !== GBIF_KEYS.boar) };
}

/** A sample of records of ALL species (plants, birds, insects…) for the biodiversity check: up to pages × 300 records,
    spread evenly through GBIF's result list so one prolific observer or survey does not fill the sample. */
export async function fetchRichness(bbox, pages = 6) {
  const base = gbifBox(bbox); const rows = (j) => j.results.filter(r => r.speciesKey).map(r => [+r.decimalLongitude.toFixed(5), +r.decimalLatitude.toFixed(5), r.speciesKey]);
  const first = await gbifPage(`${base}&offset=0`); const total = Math.min(first.count || 0, 99000); const records = rows(first);
  const offs = [...new Set(Array.from({ length: pages - 1 }, (_, i) => Math.floor(total * (i + 1) / pages / 300) * 300))].filter(o => o > 0);
  for (let i = 0; i < offs.length; i += 2) { const js = await Promise.all(offs.slice(i, i + 2).map(o => gbifPage(`${base}&offset=${o}`).catch(() => null))); for (const j of js) if (j) records.push(...rows(j)); }
  return { total: first.count || 0, records };
}

export function packLayers(L, n) {
  const all = new Uint8Array(LAYER_ORDER.length * n);
  LAYER_ORDER.forEach((k, i) => all.set(L[k], i * n));
  return all;
}
