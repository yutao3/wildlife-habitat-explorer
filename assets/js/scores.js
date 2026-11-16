/* scores.js — WildScope v1 scores.
   Real-data indicators (0–100) on a 200 m grid are pre-calculated by scripts/build_scores.py
   and stored in data/scores/grid.bin (one byte per cell per layer, 255 = no data).
   The browser combines the ticked indicators with their weights, live:
       score = Σ (weight × indicator) / Σ weight            (ticked indicators only)
   and draws the result as an image overlay (blue = low, red = high). */

import { el } from './ui.js?v=20261123a';

const RAMPS = {
  habitat: [[0, '#2c4fb3'], [25, '#5aa0d8'], [45, '#c9e6ef'], [55, '#fff2b0'], [75, '#f59a52'], [100, '#c8151b']],   // blue → red
  nature: [[0, '#8c510a'], [25, '#d8b365'], [48, '#f6e8c3'], [60, '#c7eae5'], [80, '#35978f'], [100, '#01463f']],    // bare brown → lush teal-green
};
const hex = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
export let SCORE_RAMP = RAMPS.habitat;
let RAMP_RGB = SCORE_RAMP.map(([v, c]) => [v, hex(c)]);
/** Habitat and hunting use blue → red; biodiversity uses brown → green, so the two maps cannot be confused. */
export function useRamp(name) { SCORE_RAMP = RAMPS[name] || RAMPS.habitat; RAMP_RGB = SCORE_RAMP.map(([v, c]) => [v, hex(c)]); }
export function scoreRGB(v) {
  if (v <= RAMP_RGB[0][0]) return RAMP_RGB[0][1];
  for (let i = 1; i < RAMP_RGB.length; i++) {
    const [v1, c1] = RAMP_RGB[i], [v0, c0] = RAMP_RGB[i - 1];
    if (v <= v1) { const t = (v - v0) / (v1 - v0); return c0.map((x, k) => Math.round(x + (c1[k] - x) * t)); }
  }
  return RAMP_RGB[RAMP_RGB.length - 1][1];
}
export const scoreCSS = (v) => `rgb(${scoreRGB(v).join(',')})`;
export const rampGradient = () => `linear-gradient(90deg,${SCORE_RAMP.map(([v, c]) => `${c} ${v}%`).join(',')})`;

export class ScoreGrid {
  static async load(base = new URL('../../data/scores/', import.meta.url)) {
    const meta = await (await fetch(new URL('grid.json', base), { cache: 'no-cache' })).json();
    const res = await fetch(new URL(meta.bin, base));
    if (!res.ok) throw new Error(`grid data HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return new ScoreGrid(meta, bytes, base);
  }

  constructor(meta, bytes, base) {
    this.meta = meta; this.bytes = bytes; this.base = base;
    this.n = meta.cols * meta.rows;
    this.layers = {};
    meta.layers.forEach((id, i) => { this.layers[id] = bytes.subarray(i * this.n, (i + 1) * this.n); });
    if (!this.layers.distinct && this.layers.raw_tree) this.layers.distinct = ScoreGrid.distinctiveness(this.layers, this.n);
    this.ind = Object.fromEntries(meta.indicators.map(d => [d.id, d]));
    this.scores = new Float32Array(this.n);
    this.canvas = document.createElement('canvas');
    this.canvas.width = meta.cols; this.canvas.height = meta.rows;
  }

  /** Habitat distinctiveness per square, 0–100 (4 on the biodiversity-metric scale → 100), from the land-cover shares.
      Bands: trees 4, grass / shrub / wetland 3, cropland 2, built-up 0, water and bare ground 3. Indicative only. */
  static distinctiveness(L, n) {
    const out = new Uint8Array(n).fill(255);
    for (let i = 0; i < n; i++) {
      const t = L.raw_tree[i], o = L.raw_open[i], c = L.raw_crop[i], b = L.raw_built[i];
      if (t === 255 || o === 255 || c === 255 || b === 255) continue;
      const other = Math.max(0, 100 - t - o - b);
      out[i] = Math.round(Math.min(4, (t * 4 + Math.max(0, o - c) * 3 + c * 2 + other * 3) / 100) * 25);
    }
    return out;
  }
  /** Indicative habitat units (biodiversity net gain style): hectares × distinctiveness × condition, condition assumed moderate (2). */
  habitatUnits() {
    const d = this.layers.distinct; if (!d) return null;
    const ha = (this.meta.cell_m / 100) ** 2; let units = 0, area = 0;
    for (let i = 0; i < this.n; i++) if (d[i] !== 255) { units += ha * (d[i] / 25) * 2; area += ha; }
    return area ? { units, area } : null;
  }
  get bbox() { return this.meta.bbox; }
  corners() { const [w, s, e, n] = this.meta.bbox; return [[w, n], [e, n], [e, s], [w, s]]; }

  /** Combine the ticked indicators. weights = {id: number}; returns summary stats. */
  compute(weights) {
    const ids = Object.keys(weights).filter(k => weights[k] > 0 && this.layers[k]);
    const total = ids.reduce((s, k) => s + weights[k], 0);
    const valid = this.layers.valid;
    const hist = new Array(10).fill(0); let sum = 0, cnt = 0;
    for (let i = 0; i < this.n; i++) {
      if (!valid[i] || !total) { this.scores[i] = NaN; continue; }
      let s = 0, wsum = 0;
      for (const k of ids) { const v = this.layers[k][i]; if (v !== 255) { s += weights[k] * v; wsum += weights[k]; } }
      const sc = wsum ? s / wsum : NaN; this.scores[i] = sc;
      if (!Number.isNaN(sc)) { hist[Math.min(9, Math.floor(sc / 10))]++; sum += sc; cnt++; }
    }
    this.last = { ids, total, hist, mean: cnt ? sum / cnt : NaN, cells: cnt };
    return this.last;
  }

  /** Paint the current scores (cells below minScore become transparent) and return a PNG data URL. */
  /** Colours show the square's rank in the region (0 = lowest, 100 = highest), so every score uses the full
      blue-to-red range; the number shown on click stays the real weighted score. */
  rankOf(v) {
    const s = this.sorted; if (!s || Number.isNaN(v)) return NaN;
    let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < v) lo = m + 1; else hi = m; }
    let eq = lo; while (eq < s.length && s[eq] === v) eq++;
    return 100 * (lo + (eq - lo) / 2) / s.length;
  }
  paint(minScore = 0) {
    const { cols, rows } = this.meta; const ctx = this.canvas.getContext('2d');
    const img = ctx.createImageData(cols, rows); const d = img.data; let shown = 0;
    this.sorted = Float32Array.from(Array.from(this.scores).filter(x => !Number.isNaN(x))).sort();
    for (let i = 0; i < this.n; i++) {
      const v = this.scores[i]; const j = i * 4;
      if (Number.isNaN(v) || v < minScore) { d[j + 3] = 0; continue; }
      const [r, g, b] = scoreRGB(this.rankOf(v)); d[j] = r; d[j + 1] = g; d[j + 2] = b; d[j + 3] = 255; shown++;
    }
    ctx.putImageData(img, 0, 0);
    this.shown = shown;
    return this.canvas.toDataURL('image/png');
  }

  cellAt(lng, lat) {
    const [w, s, e, n] = this.meta.bbox; const { cols, rows } = this.meta;
    if (lng < w || lng >= e || lat <= s || lat > n) return -1;
    const c = Math.floor((lng - w) / (e - w) * cols), r = Math.floor((n - lat) / (n - s) * rows);
    return r * cols + c;
  }
  cellBounds(i) {
    const [w, s, e, n] = this.meta.bbox; const { cols, rows } = this.meta;
    const c = i % cols, r = Math.floor(i / cols), dx = (e - w) / cols, dy = (n - s) / rows;
    return [w + c * dx, n - (r + 1) * dy, w + (c + 1) * dx, n - r * dy];
  }

  /** Per-indicator contribution for one cell, largest first. */
  explain(i, weights) {
    const ids = Object.keys(weights).filter(k => weights[k] > 0 && this.layers[k]);
    const total = ids.reduce((s, k) => s + (this.layers[k][i] === 255 ? 0 : weights[k]), 0);
    const parts = ids.filter(k => this.layers[k][i] !== 255).map(k => {
      const v = this.layers[k][i]; const share = weights[k] / total;
      return { id: k, label: this.ind[k].label, value: v, weight: Math.round(100 * share), pts: share * v };
    }).sort((a, b) => b.pts - a.pts);
    return { score: this.scores[i], parts };
  }

  /** Raw measurements behind the indicators, in real units, for the click panel. */
  raw(i) {
    const out = [];
    for (const r of this.meta.raw) {
      const v = this.layers[r.id]?.[i]; if (v === undefined || v === 255) continue;
      const x = v * (r.scale ?? 1) + (r.offset ?? 0);
      out.push([r.label, `${r.digits !== undefined ? x.toFixed(r.digits) : Math.round(x)}${r.unit ? ` ${r.unit}` : ''}`]);
    }
    return out;
  }
}

/* ---------- small DOM helpers used by app.js ---------- */
export function histogramBars(container, hist, minScore) {
  const peak = Math.max(1, ...hist); const total = hist.reduce((a, b) => a + b, 0);
  const above = hist.reduce((a, c, i) => a + (i * 10 + 10 > minScore ? c : 0), 0);
  container.replaceChildren(
    el('div', { class: 'histogram', role: 'img', 'aria-label': 'Distribution of cell scores' },
      ...hist.map((c, i) => el('div', { class: 'hbar', title: `${i * 10}–${i * 10 + 10}: ${c} cells (${(c * 0.04).toFixed(0)} km²)` },
        el('div', { class: 'hstack', style: `height:${(100 * c) / peak}%` },
          el('div', { class: 'hfill', style: `flex:1;background:${scoreCSS(i * 10 + 5)};opacity:${i * 10 + 10 > minScore ? 1 : 0.25}` })))),
      el('div', { class: 'hthreshold', style: `left:${minScore}%`, title: `Minimum score ${minScore}` })),
    el('div', { class: 'haxis' }, ...[0, 20, 40, 60, 80, 100].map(t => el('span', {}, t))));
  return { total, above };
}
