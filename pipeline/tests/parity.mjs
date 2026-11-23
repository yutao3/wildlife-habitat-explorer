// Runs the website's computeGrid on synthetic inputs and writes the layers as JSON for test_parity.py.
import { readFileSync, writeFileSync } from 'node:fs';
globalThis.OffscreenCanvas = class { constructor(w, h) { this.w = w; this.h = h; }
  getContext() { const w = this.w, h = this.h; return { beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {}, getImageData: () => ({ data: new Uint8ClampedArray(w * h * 4) }) }; } };
const { computeGrid } = await import(new URL('../../assets/js/analyse.js', import.meta.url));
const inp = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const N = inp.W * inp.H;
const inputs = { W: inp.W, H: inp.H, B: [0, 0, 1, 1], wc: Uint8Array.from(inp.wc), ndvi: Float32Array.from(inp.ndvi.map(v => v === null ? NaN : v)),
  ndmi: Float32Array.from(inp.ndmi.map(v => v === null ? NaN : v)), scl: Uint8Array.from(inp.scl), roads: null, water: [] };
const out = computeGrid(inputs, { S: inp.S, cellM: inp.cellM, pxM: inp.pxM, nbRadiusM: 300 });
writeFileSync(process.argv[3], JSON.stringify({ cols: out.cols, rows: out.rows, norm: out.norm, layers: Object.fromEntries(Object.entries(out.layers).map(([k, v]) => [k, Array.from(v)])) }));
