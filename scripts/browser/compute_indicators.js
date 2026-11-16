/* compute_indicators.js — WildScope v1, step 2 of 3 (runs in a browser tab; see scripts/README_scores.md).
   Input (window.__ws, filled by fetch_inputs.js): 20 m rasters on a 2220 × 2220 grid
   (ESA WorldCover classes, Sentinel-2 NDVI, NDMI, SCL) + OpenStreetMap roads and water lines.
   Output (window.__grid): 0–100 indicator layers and raw measurements per 200 m cell (222 × 222). */
(() => {
  const ws = window.__ws; const { W, H, B, wc, ndvi, ndmi, scl } = ws; const N = W * H;
  const S = 10, CW = W / S, CH = H / S, NC = CW * CH, PX_M = 20;
  const X = (lon) => (lon - B[0]) / (B[2] - B[0]) * W, Y = (lat) => (B[3] - lat) / (B[3] - B[1]) * H;

  // --- rasterise OpenStreetMap lines (and closed water polygons) onto the 20 m grid
  function raster(lines, width, fillClosed) {
    const c = new OffscreenCanvas(W, H); const g = c.getContext('2d', { willReadFrequently: true });
    g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round';
    for (const l of lines) {
      if (l.length < 2) continue;
      g.beginPath(); g.moveTo(X(l[0][0]), Y(l[0][1]));
      for (let k = 1; k < l.length; k++) g.lineTo(X(l[k][0]), Y(l[k][1]));
      const closed = l.length > 3 && l[0][0] === l[l.length - 1][0] && l[0][1] === l[l.length - 1][1];
      if (fillClosed && closed) { g.closePath(); g.fill(); }
      g.stroke();
    }
    const d = g.getImageData(0, 0, W, H).data; const m = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = d[i * 4 + 3] > 64 ? 1 : 0;
    return m;
  }
  // --- chamfer distance transform, metres
  function distance(mask) {
    const d = new Float32Array(N); const INF = 1e9, a = 1, b = Math.SQRT2;
    for (let i = 0; i < N; i++) d[i] = mask[i] ? 0 : INF;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; let v = d[i]; if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) { v = Math.min(v, d[i - W] + a); if (x > 0) v = Math.min(v, d[i - W - 1] + b); if (x < W - 1) v = Math.min(v, d[i - W + 1] + b); }
      d[i] = v;
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x; let v = d[i]; if (v === 0) continue;
      if (x < W - 1) v = Math.min(v, d[i + 1] + a);
      if (y < H - 1) { v = Math.min(v, d[i + W] + a); if (x < W - 1) v = Math.min(v, d[i + W + 1] + b); if (x > 0) v = Math.min(v, d[i + W - 1] + b); }
      d[i] = v;
    }
    for (let i = 0; i < N; i++) d[i] *= PX_M;
    return d;
  }
  const roadM = raster(ws.roads, 1.5, false);
  const waterM = raster(ws.water, 1.5, true);
  const disturb = new Uint8Array(N), wet = new Uint8Array(N);
  for (let i = 0; i < N; i++) { disturb[i] = roadM[i] || wc[i] === 50 ? 1 : 0; wet[i] = waterM[i] || wc[i] === 80 || wc[i] === 90 ? 1 : 0; }
  const dDist = distance(disturb), dWater = distance(wet);

  // --- per-cell aggregation
  const CLASSES = [10, 20, 30, 40, 50, 60, 80, 90];
  const OPEN = new Set([20, 30, 40, 90]), VEG = new Set([10, 20, 30, 40, 90]), NATURAL = new Set([10, 20, 30, 80, 90]);
  const clear = (i) => scl[i] === 4 || scl[i] === 5 || scl[i] === 6;
  const cnt = {}; for (const c of CLASSES) cnt[c] = new Uint16Array(NC);
  const nPix = new Uint16Array(NC), edge = new Uint16Array(NC);
  const vegN = new Uint16Array(NC), vegS = new Float32Array(NC), vegSS = new Float32Array(NC);
  const openN = new Uint16Array(NC), openS = new Float32Array(NC), mN = new Uint16Array(NC), mS = new Float32Array(NC);
  const dDistS = new Float32Array(NC), dWaterMin = new Float32Array(NC).fill(1e9);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, c = Math.floor(y / S) * CW + Math.floor(x / S), k = wc[i];
    if (!k) continue;
    nPix[c]++; if (cnt[k]) cnt[k][c]++;
    dDistS[c] += dDist[i]; if (dWater[i] < dWaterMin[c]) dWaterMin[c] = dWater[i];
    // forest–open edges inside the cell (right and down neighbours)
    if (x % S < S - 1) { const k2 = wc[i + 1]; if ((k === 10 && OPEN.has(k2)) || (k2 === 10 && OPEN.has(k))) edge[c]++; }
    if (y % S < S - 1) { const k2 = wc[i + W]; if ((k === 10 && OPEN.has(k2)) || (k2 === 10 && OPEN.has(k))) edge[c]++; }
    if (VEG.has(k) && clear(i) && !Number.isNaN(ndvi[i])) {
      vegN[c]++; vegS[c] += ndvi[i]; vegSS[c] += ndvi[i] * ndvi[i];
      if (!Number.isNaN(ndmi[i])) { mN[c]++; mS[c] += ndmi[i]; }
      if (OPEN.has(k)) { openN[c]++; openS[c] += ndvi[i]; }
    }
  }
  const share = (k, c) => nPix[c] ? cnt[k][c] / nPix[c] : 0;
  // 3 × 3 neighbourhood (600 m) sums
  function nb(fn) {
    const out = new Float32Array(NC);
    for (let r = 0; r < CH; r++) for (let q = 0; q < CW; q++) {
      let s = 0; for (let dr = -1; dr <= 1; dr++) for (let dq = -1; dq <= 1; dq++) { const rr = r + dr, qq = q + dq; if (rr >= 0 && rr < CH && qq >= 0 && qq < CW) s += fn(rr * CW + qq); }
      out[r * CW + q] = s;
    }
    return out;
  }
  const nbPix = nb(c => nPix[c]);
  const nbCls = Object.fromEntries(CLASSES.map(k => [k, nb(c => cnt[k][c])]));
  const nbEdge = nb(c => edge[c]), nbOpenN = nb(c => openN[c]), nbOpenS = nb(c => openS[c]);

  const pct = (arr, p) => { const v = Array.from(arr).filter(Number.isFinite).sort((a, b) => a - b); return v[Math.floor((v.length - 1) * p)]; };
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
  const edgeDens = new Float32Array(NC), specStd = new Float32Array(NC).fill(NaN), ndmiMean = new Float32Array(NC).fill(NaN), shannon = new Float32Array(NC);
  for (let c = 0; c < NC; c++) {
    edgeDens[c] = nbPix[c] ? nbEdge[c] / nbPix[c] : 0;
    if (vegN[c] >= 20) { const m = vegS[c] / vegN[c]; specStd[c] = Math.sqrt(Math.max(0, vegSS[c] / vegN[c] - m * m)); }
    if (mN[c] >= 20) ndmiMean[c] = mS[c] / mN[c];
    let tot = 0; const ks = [10, 20, 30, 40, 80, 90]; for (const k of ks) tot += nbCls[k][c];
    let h = 0; if (tot) for (const k of ks) { const p = nbCls[k][c] / tot; if (p > 0) h -= p * Math.log(p); }
    shannon[c] = h / Math.log(4);   // 4 well-mixed habitat types = 1.0
  }
  const E98 = pct(edgeDens, 0.98), S02 = pct(specStd, 0.02), S98 = pct(specStd, 0.98), M02 = pct(ndmiMean, 0.02), M98 = pct(ndmiMean, 0.98);

  const L = {}; const mk = (id) => (L[id] = new Uint8Array(NC).fill(255));
  ['valid', 'cover', 'edge', 'forage', 'quiet', 'water', 'moisture', 'crops', 'diversity', 'natural', 'spectral',
   'raw_tree', 'raw_open', 'raw_crop', 'raw_built', 'raw_ndvi', 'raw_ndmi', 'raw_droad', 'raw_dwater'].forEach(mk);
  for (let c = 0; c < NC; c++) {
    if (nPix[c] < 50) { L.valid[c] = 0; continue; }
    const built = share(50, c), water = share(80, c) + share(90, c);
    L.valid[c] = built + water > 0.6 ? 0 : 1;
    const tree = share(10, c), open = share(20, c) + share(30, c) + share(40, c) + share(90, c);
    const nbT = nbPix[c];
    L.cover[c] = clamp(100 * tree);
    L.edge[c] = clamp(100 * edgeDens[c] / E98);
    L.forage[c] = nbOpenN[c] >= 20 ? clamp(100 * ((nbOpenS[c] / nbOpenN[c]) - 0.25) / 0.5) : 15;
    const dd = dDistS[c] / nPix[c];
    L.quiet[c] = clamp(100 * Math.min(dd, 1000) / 1000);
    const dw = dWaterMin[c];
    L.water[c] = clamp(100 * (400 - dw) / 400);   // OSM streams are dense here: median distance 40 m, so 0 m → 100, 400 m → 0
    L.moisture[c] = Number.isNaN(ndmiMean[c]) ? 255 : clamp(100 * (ndmiMean[c] - M02) / (M98 - M02));
    L.crops[c] = clamp(100 * (nbCls[40][c] / nbT) / 0.5);
    L.diversity[c] = clamp(100 * shannon[c]);
    let nat = 0; for (const k of NATURAL) nat += cnt[k][c]; L.natural[c] = clamp(100 * nat / nPix[c]);
    L.spectral[c] = Number.isNaN(specStd[c]) ? 255 : clamp(100 * (specStd[c] - S02) / (S98 - S02));
    // raw measurements (stored compactly, decoded with scale/offset in grid.json)
    L.raw_tree[c] = clamp(100 * tree); L.raw_open[c] = clamp(100 * open); L.raw_crop[c] = clamp(100 * share(40, c)); L.raw_built[c] = clamp(100 * built);
    L.raw_ndvi[c] = vegN[c] ? clamp(100 * Math.max(0, vegS[c] / vegN[c])) : 255;
    L.raw_ndmi[c] = Number.isNaN(ndmiMean[c]) ? 255 : clamp(100 * (ndmiMean[c] + 0.5));
    L.raw_droad[c] = Math.min(254, Math.round(dd / 20));
    L.raw_dwater[c] = Math.min(254, Math.round(dw / 20));
  }
  window.__grid = { CW, CH, B, layers: L, norm: { E98, S02, S98, M02, M98 } };
  return { cells: NC, valid: L.valid.reduce((a, v) => a + (v === 1), 0), norm: window.__grid.norm };
})();
