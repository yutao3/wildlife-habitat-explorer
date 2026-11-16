/* export_grid.js — WildScope v1, step 2b: pack window.__grid + GBIF points into one JSON for build_scores.py.
   Layers are concatenated (one byte per cell), gzipped and base64-encoded; the result is saved as a download. */
(async () => {
  const g = window.__grid, ws = window.__ws; const order = Object.keys(g.layers);
  const all = new Uint8Array(order.length * g.CW * g.CH); order.forEach((k, i) => all.set(g.layers[k], i * g.CW * g.CH));
  const gz = new Uint8Array(await new Response(new Blob([all]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let bin = ''; for (let i = 0; i < gz.length; i += 0x8000) bin += String.fromCharCode(...gz.subarray(i, i + 0x8000));
  const today = new Date().toISOString().slice(0, 10);
  const out = { created: today, cols: g.CW, rows: g.CH, bbox: [g.B[0], g.B[1], g.B[2], g.B[3]], layer_order: order, layers_b64: btoa(bin), norm: g.norm,
    gbif: ws.gbif, dates: { sentinel2: '2026-07-24', scene: ws.S2, osm: today, gbif: today } };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' })); a.download = 'wildscope_export.json'; a.click();
})();
