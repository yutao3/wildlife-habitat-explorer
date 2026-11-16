/* fetch_inputs.js — WildScope v1, step 1 of 3 (paste into the console of any https page, e.g. the WildScope site).
   Downloads the inputs for the pilot region straight from public APIs (all CORS-enabled, no keys):
   - ESA WorldCover 2021 (10 m land cover) and one clear Sentinel-2 L2A scene (NDVI, NDMI, SCL),
     rendered at 20 m by the Microsoft Planetary Computer data API, in four 1110 × 1110 quadrants
     (the API caps one image at 2048 px). Note the Sentinel-2 offset: since processing baseline 04.00
     the stored values include +1000, so NDVI = (B08 − B04) / (B08 + B04 − 2000).
   - OpenStreetMap roads and waterways (Overpass API, four quadrants, retried across mirrors).
   - GBIF sightings of roe deer and wild boar with a location better than 250 m.
   Results go to window.__ws; then run compute_indicators.js, then export_grid.js. */
(async () => {
  const D = 'https://planetarycomputer.microsoft.com/api/data/v1';
  const W = 2220, H = 2220, B = [7.67, 47.85, 8.2694, 48.2496], Q = 1110, dx = (B[2] - B[0]) / W, dy = (B[3] - B[1]) / H;
  const S2 = 'S2A_MSIL2A_20260724T102701_R108_T32UMU_20260724T171410';   // 24 Jul 2026, 0.1 % cloud
  async function img(url, w, h) {
    const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`);
    const bm = await createImageBitmap(await r.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    if (bm.width !== w || bm.height !== h) throw new Error(`unexpected size ${bm.width}x${bm.height}`);
    const c = new OffscreenCanvas(w, h); const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bm, 0, 0);
    return g.getImageData(0, 0, w, h).data;
  }
  async function layer(q) {
    const out = new Uint8ClampedArray(W * H * 4);
    await Promise.all([[0, 0], [1, 0], [0, 1], [1, 1]].map(async ([qx, qy]) => {
      const x0 = qx * Q, y0 = qy * Q;
      const bb = [B[0] + x0 * dx, B[3] - (y0 + Q) * dy, B[0] + (x0 + Q) * dx, B[3] - y0 * dy].map(v => v.toFixed(7)).join(',');
      const d = await img(`${D}/item/bbox/${bb}/${Q}x${Q}.png?${q}`, Q, Q);
      for (let y = 0; y < Q; y++) out.set(d.subarray(y * Q * 4, (y + 1) * Q * 4), ((y0 + y) * W + x0) * 4);
    }));
    return out;
  }
  const [wa, wb, nd, nm, sc] = await Promise.all([
    layer('collection=esa-worldcover&item=ESA_WorldCover_10m_2021_v200_N48E006&assets=map'),
    layer('collection=esa-worldcover&item=ESA_WorldCover_10m_2021_v200_N45E006&assets=map'),
    layer(`collection=sentinel-2-l2a&item=${S2}&expression=(B08-B04)/(B08%2BB04-2000)&asset_as_band=true&rescale=-1,1`),
    layer(`collection=sentinel-2-l2a&item=${S2}&expression=(B08-B11)/(B08%2BB11-2000)&asset_as_band=true&rescale=-1,1`),
    layer(`collection=sentinel-2-l2a&item=${S2}&assets=SCL`)]);
  const N = W * H, wc = new Uint8Array(N), ndvi = new Float32Array(N), ndmi = new Float32Array(N), scl = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const j = i * 4;
    wc[i] = (wa[j + 3] && wa[j]) ? wa[j] : ((wb[j + 3] && wb[j]) ? wb[j] : 0);
    ndvi[i] = nd[j + 3] ? nd[j] / 255 * 2 - 1 : NaN; ndmi[i] = nm[j + 3] ? nm[j] / 255 * 2 - 1 : NaN; scl[i] = sc[j + 3] ? sc[j] : 0;
  }
  window.__ws = { W, H, B, S2, wc, ndvi, ndmi, scl, roads: [], water: [] };

  const eps = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
  async function ov(q) {
    for (let attempt = 0; attempt < 6; attempt++) for (const e of eps) {
      try { const r = await fetch(e, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); if (r.ok) return r.json(); } catch { /* next mirror */ }
      await new Promise(r => setTimeout(r, 4000 * (attempt + 1)));
    }
    throw new Error('Overpass unavailable');
  }
  const lat = [47.85, 48.05, 48.2496], lon = [7.67, 7.97, 8.2694];
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
    const bb = `${lat[a]},${lon[b]},${lat[a + 1]},${lon[b + 1]}`;
    const r = await ov(`[out:json][timeout:90];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|residential)$"](${bb});out skel geom;`);
    window.__ws.roads.push(...r.elements.filter(e => e.geometry).map(e => e.geometry.map(p => [p.lon, p.lat])));
    const w = await ov(`[out:json][timeout:90];(way["waterway"~"^(river|stream|canal)$"](${bb});way["natural"="water"](${bb}););out skel geom;`);
    window.__ws.water.push(...w.elements.filter(e => e.geometry).map(e => e.geometry.map(p => [p.lon, p.lat])));
  }

  const G = 'https://api.gbif.org/v1'; const pts = [];
  for (const [sp, k] of [['roe_deer', 5220126], ['wild_boar', 7705930]]) {
    for (let off = 0; ; off += 300) {
      const j = await (await fetch(`${G}/occurrence/search?taxonKey=${k}&decimalLatitude=${B[1]},${B[3]}&decimalLongitude=${B[0]},${B[2]}&hasCoordinate=true&hasGeospatialIssue=false&coordinateUncertaintyInMeters=0,250&limit=300&offset=${off}`)).json();
      for (const r of j.results) pts.push({ sp, lon: r.decimalLongitude, lat: r.decimalLatitude, year: r.year, month: r.month, unc: r.coordinateUncertaintyInMeters, basis: r.basisOfRecord, key: r.key });
      if (j.endOfRecords) break;
    }
  }
  window.__ws.gbif = pts;
  console.log('inputs ready', { roads: window.__ws.roads.length, water: window.__ws.water.length, gbif: pts.length });
})();
