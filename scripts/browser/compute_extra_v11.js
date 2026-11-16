/* compute_extra_v11.js — WildScope v1.1, step 2c (run after compute_indicators.js, same tab).
   Adds the indicators used by the fitted roe deer score and fetches the "target group" for the fair test:
   - woodland  : share of trees within 600 m
   - open      : share of grass, crop, shrub, wetland within 600 m (60% → 100)
   - edge_near : distance to the nearest forest edge pixel (0 m → 100, 400 m → 0)
   - roads_far : mean distance to a public road (0 → 0, 800 m → 100)
   - towns_far : mean distance to built-up land (0 → 0, 1 km → 100)
   - protected : WDPA protected-area mask, one pixel per square (used only as a check)
   - target group: GBIF human observations of all OTHER mammals (≤ 250 m), the background for the fair test
   ("mosaic" = 4 × open share × woodland share is derived later in build_scores.py.) */
(async () => {
  const ws = window.__ws; const { W, H, B, wc } = ws; const N = W * H;
  const S = 10, CW = W / S, CH = H / S, NC = CW * CH, PX_M = 20;
  const X = (lon) => (lon - B[0]) / (B[2] - B[0]) * W, Y = (lat) => (B[3] - lat) / (B[3] - B[1]) * H;
  function raster(lines, width) { const c = new OffscreenCanvas(W, H); const g = c.getContext('2d', { willReadFrequently: true }); g.strokeStyle = '#fff'; g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round';
    for (const l of lines) { if (l.length < 2) continue; g.beginPath(); g.moveTo(X(l[0][0]), Y(l[0][1])); for (let k = 1; k < l.length; k++) g.lineTo(X(l[k][0]), Y(l[k][1])); g.stroke(); }
    const d = g.getImageData(0, 0, W, H).data; const m = new Uint8Array(N); for (let i = 0; i < N; i++) m[i] = d[i * 4 + 3] > 64 ? 1 : 0; return m; }
  function distance(mask) { const d = new Float32Array(N); const INF = 1e9, a = 1, b = Math.SQRT2; for (let i = 0; i < N; i++) d[i] = mask[i] ? 0 : INF;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; let v = d[i]; if (v === 0) continue; if (x > 0) v = Math.min(v, d[i - 1] + a); if (y > 0) { v = Math.min(v, d[i - W] + a); if (x > 0) v = Math.min(v, d[i - W - 1] + b); if (x < W - 1) v = Math.min(v, d[i - W + 1] + b); } d[i] = v; }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) { const i = y * W + x; let v = d[i]; if (v === 0) continue; if (x < W - 1) v = Math.min(v, d[i + 1] + a); if (y < H - 1) { v = Math.min(v, d[i + W] + a); if (x < W - 1) v = Math.min(v, d[i + W + 1] + b); if (x > 0) v = Math.min(v, d[i + W - 1] + b); } d[i] = v; }
    for (let i = 0; i < N; i++) d[i] *= PX_M; return d; }
  const OPEN = new Set([20, 30, 40, 90]);
  const roadM = raster(ws.roads, 1.5); const builtM = new Uint8Array(N), edgeM = new Uint8Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x, k = wc[i]; builtM[i] = k === 50 ? 1 : 0;
    if (k === 10 && ((x < W - 1 && OPEN.has(wc[i + 1])) || (x > 0 && OPEN.has(wc[i - 1])) || (y < H - 1 && OPEN.has(wc[i + W])) || (y > 0 && OPEN.has(wc[i - W])))) edgeM[i] = 1; }
  const dRoad = distance(roadM), dBuilt = distance(builtM), dEdge = distance(edgeM);
  const nPix = new Uint16Array(NC), tree = new Uint16Array(NC), open = new Uint16Array(NC), sRoad = new Float32Array(NC), sBuilt = new Float32Array(NC), mEdge = new Float32Array(NC).fill(1e9);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x, c = Math.floor(y / S) * CW + Math.floor(x / S), k = wc[i]; if (!k) continue;
    nPix[c]++; if (k === 10) tree[c]++; if (OPEN.has(k)) open[c]++; sRoad[c] += dRoad[i]; sBuilt[c] += dBuilt[i]; if (dEdge[i] < mEdge[c]) mEdge[c] = dEdge[i]; }
  const nb = (arr) => { const out = new Float32Array(NC); for (let r = 0; r < CH; r++) for (let q = 0; q < CW; q++) { let s = 0; for (let dr = -1; dr <= 1; dr++) for (let dq = -1; dq <= 1; dq++) { const rr = r + dr, qq = q + dq; if (rr >= 0 && rr < CH && qq >= 0 && qq < CW) s += arr[rr * CW + qq]; } out[r * CW + q] = s; } return out; };
  const nbP = nb(nPix), nbT = nb(tree), nbO = nb(open);
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
  const L = {}; for (const k of ['woodland', 'open', 'edge_near', 'roads_far', 'towns_far', 'raw_droad_only', 'raw_dtown', 'raw_dedge']) L[k] = new Uint8Array(NC).fill(255);
  for (let c = 0; c < NC; c++) { if (nPix[c] < 50) continue;
    L.woodland[c] = clamp(100 * nbT[c] / nbP[c]); L.open[c] = clamp(100 * (nbO[c] / nbP[c]) / 0.6);
    const de = mEdge[c], r = sRoad[c] / nPix[c], t = sBuilt[c] / nPix[c];
    L.edge_near[c] = clamp(100 * (400 - de) / 400); L.roads_far[c] = clamp(100 * Math.min(r, 800) / 800); L.towns_far[c] = clamp(100 * Math.min(t, 1000) / 1000);
    L.raw_droad_only[c] = Math.min(254, Math.round(r / 20)); L.raw_dtown[c] = Math.min(254, Math.round(t / 40)); L.raw_dedge[c] = Math.min(254, Math.round(de / 20)); }
  // protected areas (check only)
  const u = `https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer/export?bbox=${B.join(',')}&bboxSR=4326&imageSR=4326&size=${CW},${CH}&format=png32&transparent=true&f=image`;
  const bm = await createImageBitmap(await (await fetch(u)).blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); const cv = new OffscreenCanvas(CW, CH); const g2 = cv.getContext('2d'); g2.drawImage(bm, 0, 0);
  const d = g2.getImageData(0, 0, CW, CH).data; L.protected = new Uint8Array(NC); for (let c = 0; c < NC; c++) L.protected[c] = d[c * 4 + 3] > 20 ? 1 : 0;
  // target group: all other mammals reported by the same kind of observers
  const G = 'https://api.gbif.org/v1/occurrence/search'; const base = `${G}?decimalLatitude=${B[1]},${B[3]}&decimalLongitude=${B[0]},${B[2]}&hasCoordinate=true&hasGeospatialIssue=false&coordinateUncertaintyInMeters=0,250&basisOfRecord=HUMAN_OBSERVATION&classKey=359&limit=300`;
  const tg = []; for (let off = 0; ; off += 300) { const j = await (await fetch(`${base}&offset=${off}`)).json(); for (const r of j.results) if (r.speciesKey !== 5220126) tg.push([+r.decimalLongitude.toFixed(5), +r.decimalLatitude.toFixed(5), r.speciesKey || 0]); if (j.endOfRecords) break; }
  window.__grid2 = L; window.__tg = tg;
  console.log('extra indicators ready', { targetGroup: tg.length });
})();
