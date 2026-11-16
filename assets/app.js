/* app.js — WildScope (SAIIL) bootstrap.
   Wires together: manifest (data/layers.json) → LayerManager → MapLibre globe → UI panels,
   plus the v1 score grid (data/scores/) combined live in the browser (scores.js).
   Three modes: Habitat, Biodiversity, Hunting. Static site: no backend, no tracking, no API keys. */
import { ensureMapLibre, baseStyle, setBasemap, drawStarfield, applyProjection, createSpinner, flyToBounds, GLOBE_VIEW, globeZoomFor, BASEMAPS } from './js/globe.js?v=20261117c';
import { loadManifest, allDates } from './js/manifest.js?v=20261117c';
import { LayerManager } from './js/layers.js?v=20261117c';
import { $, setText, el, formatDate, buildLayerPanel, refreshLayerPanel, renderFeature, clearFeature, rampColor, areaHa } from './js/ui.js?v=20261117c';
import { ScoreGrid, histogramBars, rampGradient, scoreCSS } from './js/scores.js?v=20261117c';
import { writeGeoTiff } from './js/geotiff.js?v=20261117c';
import { hasWebGL, ensureLeaflet, LiteMap, LitePopup, LiteMarker } from './js/litemap.js?v=20261117c';
import { initSearch, copernicusUrl } from './js/search.js?v=20261117c';
import { fetchConditions, renderConditions, compass, arrow } from './js/conditions.js?v=20261117c';

const params = new URLSearchParams(location.search);
const state = { map: null, mgr: null, manifest: null, spinner: null, projection: 'globe', basemap: 'satellite', popup: null, selected: null,
  mode: 'habitat', preset: 'roe_deer', grid: null, weights: {}, minScore: 0, scoreOn: true, scoreOpacity: 0.75 };

/* ---------- messages & loading ---------- */
let alertTimer;
function warn(message, sticky = false) {
  const n = $('map-alert'); n.textContent = message; n.hidden = false; console.warn(message);
  clearTimeout(alertTimer); if (!sticky) alertTimer = setTimeout(() => { n.hidden = true; }, 9000);
}
function loading(on, text) { const n = $('map-loading'); if (!n) return; n.hidden = !on; if (text) setText('map-loading-text', text); }

/* ---------- map ---------- */
async function initialiseMap() {
  drawStarfield($('starfield'));
  await ensureMapLibre();
  const map = new maplibregl.Map({
    container: 'map', style: baseStyle(state.basemap), center: GLOBE_VIEW.center, zoom: globeZoomFor($('map')),
    minZoom: 0.5, maxZoom: 18, attributionControl: false, canvasContextAttributes: { antialias: true },
  });
  state.map = map;
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.on('style.load', () => { state.projection = applyProjection(map, params.has('flat') ? 'mercator' : 'globe'); updateProjectionButtons(); });
  map.on('error', (e) => console.warn('Map tile/overlay error:', e?.error?.message || e));
  map.on('mousemove', (e) => {
    setText('coordinates', `${e.lngLat.lat.toFixed(5)}° N  ·  ${e.lngLat.lng.toFixed(5)}° E`);
    const ids = state.mgr?.queryLayerIds() || [];
    map.getCanvas().style.cursor = ids.length && map.queryRenderedFeatures(e.point, { layers: ids }).length ? 'pointer' : '';
  });
  map.on('click', onMapClick);
  map.on('moveend', () => { scheduleConditions(); updateCopernicusLink(); });
  // Wait for the style only (not every basemap tile) so panels and layers appear fast on slow links.
  await new Promise((resolve) => (map.isStyleLoaded() ? resolve() : map.once('style.load', () => setTimeout(resolve, 0))));
  state.spinner = createSpinner(map);
  return map;
}

/** No WebGL (graphics acceleration off, some work laptops and virtual machines): a 2D Leaflet map
    that keeps the scores, click-to-explain, search, labels and the hunting-ground boundary. */
async function initialiseLiteMap(reason) {
  await ensureLeaflet();
  try { state.map?.remove?.(); } catch { /* the failed MapLibre map */ }
  const host = $('map'); host.replaceChildren(); host.className = '';
  window.maplibregl = { Popup: LitePopup, Marker: LiteMarker };   // the two classes app.js creates directly
  const map = new LiteMap(host, { basemaps: BASEMAPS, active: state.basemap, center: [7.97, 48.05], zoom: isPhone() ? 9 : 10 });
  state.map = map; state.lite = true; state.projection = 'mercator';
  $('app').classList.add('lite');
  map.on('mousemove', (e) => setText('coordinates', `${e.lngLat.lat.toFixed(5)}° N  ·  ${e.lngLat.lng.toFixed(5)}° E`));
  map.on('click', onMapClick);
  map.on('moveend', () => scheduleConditions());
  $('fly-btn').hidden = true; $('globe-btn').hidden = true;
  warn(`Simple 2D map: this browser has WebGL (graphics acceleration) switched off${reason ? ` (${reason})` : ''}. Scores work fully; the 3D globe and the satellite data layers need WebGL. In Chrome: Settings → System → "Use graphics acceleration when available", then restart Chrome.`, true);
  return map;
}

function onMapClick(e) {
  const { map, mgr } = state; if (!map) return;
  condPinned = e.lngLat; updateConditions(e.lngLat, 'Clicked spot');
  setTimeout(() => { condPinned = null; }, 30000);   // map centre takes over again after 30 s of panning
  const ids = mgr ? mgr.queryLayerIds() : [];
  const hit = ids.length ? map.queryRenderedFeatures(e.point, { layers: ids })[0] : null;
  if (!hit) {
    const i = state.grid && state.scoreOn ? state.grid.cellAt(e.lngLat.lng, e.lngLat.lat) : -1;
    if (i >= 0 && !Number.isNaN(state.grid.scores[i])) { selectCell(i, e.lngLat); return; }
    state.popup?.remove(); mgr?.highlight(null); highlightCell(-1); clearFeature(); return;
  }
  highlightCell(-1);
  const layerId = hit.layer.id.replace(/^lyr-/, '').replace(/-(fill|circle|pin)$/, '');
  const layer = mgr.get(layerId); const st = mgr.status(layerId);
  const original = st.data?.features?.find(f => hit.properties.id !== undefined && f.properties?.id === hit.properties.id);
  const feature = original || { type: 'Feature', geometry: hit.geometry, properties: hit.properties };
  const props = feature.properties || {};
  state.selected = { feature, layer, version: st.version };
  mgr.highlight(feature);
  renderFeature({ props, geometry: feature.geometry, layer, version: st.version, lngLat: e.lngLat, synthetic: false });
  const content = el('div', { class: 'popup' }, el('b', {}, props.name || props.NAME || props.id || layer.title), el('div', { class: 'popup-meta' }, layer.title));
  state.popup?.remove();
  state.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '240px', offset: 6 }).setLngLat(e.lngLat).setDOMContent(content).addTo(map);
}

/* ---------- live conditions (real-time weather / wind / light) ---------- */
let condTimer, condSeq = 0, condPinned = null;
async function updateConditions(lngLat, label) {
  const seq = ++condSeq;
  const { lat, lng } = lngLat;
  setText('cond-where', `${label} · ${lat.toFixed(3)}° N, ${lng.toFixed(3)}° E`);
  try {
    const data = await fetchConditions(lat, lng);
    if (seq !== condSeq) return;
    const w = renderConditions($('conditions'), data, { label });
    setText('metric-patches', `${Math.round(w.speed)} km/h ${w.from}`);
    setText('metric-patches-sub', `Live · ${label.toLowerCase()}`);
    const chip = $('wind-chip'); chip.hidden = false;
    chip.replaceChildren(arrow(w.dir, 14), ` Wind ${Math.round(w.speed)} km/h from ${w.from} · ${Math.round(data.current.temperature_2m)}°C`);
  } catch (e) {
    if (seq !== condSeq) return;
    $('conditions').replaceChildren(el('p', { class: 'control-note' }, `Live weather unavailable (${e.message}). Retrying when you move the map.`));
  }
}
function scheduleConditions(immediate) {
  clearTimeout(condTimer);
  condTimer = setTimeout(() => {
    if (!state.map || condPinned) return;
    const z = state.map.getZoom();
    const c = z < 4 ? { lat: 48.05, lng: 7.97 } : state.map.getCenter();
    updateConditions(c, z < 4 ? 'Pilot region (Freiburg & Black Forest)' : 'Map centre');
  }, immediate === true ? 0 : 900);
}

/* ---------- place names, search, Copernicus link ---------- */
const LABEL_SOURCES = {
  'ref-places': 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  'ref-roads': 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
};
state.labels = true;
/** Place names + roads drawn ON TOP of every data layer (added after the layer manager's own layers). */
function addLabelLayers() {
  const { map } = state;
  for (const [id, url] of Object.entries(LABEL_SOURCES)) {
    if (!map.getSource(id)) map.addSource(id, { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 19, attribution: 'Labels and roads © Esri, HERE, Garmin, OpenStreetMap contributors' });
    if (!map.getLayer(id)) map.addLayer({ id, type: 'raster', source: id, minzoom: id === 'ref-roads' ? 11 : 0, paint: { 'raster-fade-duration': 300, 'raster-opacity': id === 'ref-roads' ? 0.75 : 1 } });
  }
  syncLabels();
}
function syncLabels() {
  const { map } = state; if (!map) return;
  // The "Map" base map already has its own names, so the overlay is only used on satellite.
  const on = state.labels && state.basemap === 'satellite';
  for (const id of Object.keys(LABEL_SOURCES)) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const b = $('labels-btn'); b.classList.toggle('active', state.labels); b.setAttribute('aria-pressed', String(state.labels));
}
let searchMarker = null;
function goToPlace(p) {
  const { map } = state; if (!map) return;
  state.spinner?.stop();
  searchMarker?.remove();
  searchMarker = new maplibregl.Marker({ color: '#ff7a00' }).setLngLat([p.lng, p.lat]).setPopup(new maplibregl.Popup({ offset: 24 }).setText(p.name)).addTo(map);
  const b = p.bbox;
  if (b && b[2] - b[0] > 0.002 && b[2] - b[0] < 3) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: panelPadding(), maxZoom: 14, duration: 2200 });
  else map.flyTo({ center: [p.lng, p.lat], zoom: 13, duration: 2200, essential: true });
  $('fly-btn').hidden = true; $('globe-btn').hidden = false;
  condPinned = { lat: p.lat, lng: p.lng }; updateConditions(condPinned, /^-?\d/.test(p.name) ? 'Searched point' : p.name);
  setTimeout(() => { condPinned = null; }, 30000);
}
function updateCopernicusLink() {
  const { map } = state; if (!map) return;
  const link = $('copernicus-link'); if (!link) return; const c = map.getCenter(); link.href = copernicusUrl(c.lat, c.lng, map.getZoom());
}

/* ---------- views ---------- */
const regionBounds = () => state.grid?.bbox || state.manifest?.region.bounds || [7.67, 47.85, 8.27, 48.25];
const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
/** Space taken by the floating side panels, so the map centres the region in the visible gap. */
function panelPadding() {
  if (isPhone()) return { top: 90, bottom: 90, left: 20, right: 20 };
  const app = $('app');
  const l = app.classList.contains('left-collapsed') ? 0 : $('panel-layers').offsetWidth + 12;
  const r = app.classList.contains('right-collapsed') ? 0 : $('panel-insights').offsetWidth + 12;
  return { top: 70, bottom: 70, left: 30 + l, right: 30 + r };
}
function flyToPilot(duration) {
  if (!state.map) return;
  state.spinner?.stop(); flyToBounds(state.map, regionBounds(), { ...(duration ? { duration } : {}), padding: panelPadding() });
  $('fly-btn').hidden = true; $('globe-btn').hidden = false;
}
function backToGlobe() {
  if (!state.map) return;
  if (state.projection !== 'globe') setProjection('globe');
  state.popup?.remove();
  state.map.flyTo({ ...GLOBE_VIEW, zoom: globeZoomFor($('map')), duration: 3500, essential: true });
  state.map.once('moveend', () => state.spinner?.start());
  $('fly-btn').hidden = false; $('globe-btn').hidden = true;
}
function setProjection(type) { if (!state.map) return; state.projection = applyProjection(state.map, type); updateProjectionButtons(); }
function updateProjectionButtons() {
  document.querySelectorAll('[data-projection]').forEach(b => { const a = b.dataset.projection === state.projection; b.classList.toggle('active', a); b.setAttribute('aria-pressed', String(a)); });
}
function updateBasemap(which, fromUser) {
  state.basemap = which; if (state.map) { if (state.lite) state.map.setBasemap(which); else setBasemap(state.map, which); }
  syncLabels();
  const covering = state.mgr?.layersForSpecies().filter(l => state.mgr.isActive(l) && l.style?.covers) || [];
  if (fromUser && covering.length) warn(`"${covering[0].title}" is switched on and covers the base map. Switch it off in Layers to see the ${which === 'streets' ? 'Map' : 'Satellite'} base map.`);
  document.querySelectorAll('[data-basemap]').forEach(b => { const a = b.dataset.basemap === which; b.classList.toggle('active', a); b.setAttribute('aria-pressed', String(a)); });
}

/* ---------- manifest-driven data layers ---------- */
function renderDates() {
  const { mgr } = state; const dates = allDates(mgr.layersForSpecies());
  const sel = $('snapshot-select');
  sel.replaceChildren(...dates.map((d, i) => new Option(`${formatDate(d)}${i === 0 ? ' · latest' : ' · archive'}`, d)));
  if (!dates.includes(mgr.date)) mgr.date = dates[0] || null;
  sel.value = mgr.date || '';
  setText('archive-tag', `${dates.length} date${dates.length === 1 ? '' : 's'} archived`);
}
function buildPanel() {
  buildLayerPanel($('layer-panel'), state.mgr, {
    onToggle: (id, on) => { state.mgr.setVisible(id, on); if (!on && state.selected?.layer?.id === id) clearSelection(); },
    onOpacity: (id, o) => state.mgr.setOpacity(id, o),
    onPin: (id, date) => { state.mgr.setPinned(id, date); },
  });
}
function clearSelection() { state.popup?.remove(); state.mgr?.highlight(null); highlightCell(-1); state.selected = null; clearFeature(); }

function updateAnalytics() {
  const { mgr } = state; if (!mgr) return;
  const allD = allDates(mgr.layersForSpecies());
  refreshLayerPanel($('layer-panel'), mgr, mgr.date === allD[0] ? null : mgr.date);
  const layers = mgr.layersForSpecies();
  const loadingAny = layers.some(l => mgr.status(l.id).loading);
  const on = layers.filter(l => mgr.isActive(l)).length;
  setText('map-status', loadingAny ? 'Loading layers…' : `${state.grid ? 'Score grid on · ' : ''}${on} data layer${on === 1 ? '' : 's'} on`);
  setText('dataset-description', mgr.date === allD[0] ? 'Newest data shown. Pick an older date for archived layers (e.g. Sentinel-2 mosaics from earlier years).' : `Archive view: each layer shows its newest output on or before ${formatDate(mgr.date)}.`);
}

/* ---------- modes: Habitat · Biodiversity · Hunting ---------- */
const MODES = {
  habitat: { lead: 'Where can a species live? A 0–100 habitat score for every 200 m square.', title: 'Habitat score', presets: ['roe_deer', 'wild_boar'], right: 'Score insights' },
  biodiversity: { lead: 'How varied and natural is the landscape? A biodiversity potential score for every 200 m square.', title: 'Biodiversity potential', presets: ['biodiversity'], right: 'Score insights' },
  hunting: { lead: 'Good habitat plus the right moment: habitat score, live wind and light, and your own hunting ground.', title: 'Habitat score for hunting', presets: ['roe_deer', 'wild_boar'], right: 'Conditions & insights' },
};
function setMode(mode) {
  const m = MODES[mode] || MODES.habitat; state.mode = mode;
  $('app').dataset.mode = mode;
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  setText('mode-lead', m.lead); setText('score-title', m.title); setText('right-title', m.right);
  if (!m.presets.includes(state.preset)) state.preset = mode === 'biodiversity' ? 'biodiversity' : (state.lastSpecies || 'roe_deer');
  if (mode === 'hunting') scheduleConditions(true);
  try { const u = new URL(location.href); u.searchParams.set('mode', mode); history.replaceState(null, '', u); } catch { /* ignore */ }
  renderPresets(); renderIndicators(); recompute();
}
function preset() { return state.grid?.meta.presets[state.preset]; }
function weightsFor(id) {
  if (!state.weights[id]) state.weights[id] = { ...state.grid.meta.presets[id].weights };
  return state.weights[id];
}
function activeWeights() { const w = weightsFor(state.preset); return Object.fromEntries(Object.entries(w).filter(([, v]) => v > 0)); }

function renderPresets() {
  const g = state.grid; const box = $('preset-list'); if (!g) return;
  const ids = MODES[state.mode].presets;
  box.hidden = ids.length < 2;
  box.replaceChildren(...ids.map(id => el('button', { type: 'button', class: `seg${id === state.preset ? ' active' : ''}`, 'aria-pressed': String(id === state.preset),
    onclick: () => { state.preset = id; if (id !== 'biodiversity') state.lastSpecies = id; renderPresets(); renderIndicators(); recompute(); } }, g.meta.presets[id].label)));
}

function renderIndicators() {
  const g = state.grid; if (!g) return;
  const w = weightsFor(state.preset); const memo = (state.memo ||= {});
  const groups = [...new Set(g.meta.indicators.map(d => d.group))];
  const row = (d) => {
    const on = (w[d.id] || 0) > 0; const val = on ? w[d.id] : (memo[`${state.preset}:${d.id}`] || 10);
    const why = el('div', { class: 'ind-why', hidden: true }, el('p', {}, el('b', {}, 'Measures: '), d.how), el('p', {}, el('b', {}, 'Why it matters: '), d.why), el('p', { class: 'ind-src' }, `Data: ${d.source}`));
    const r = el('div', { class: `ind-row${on ? '' : ' off'}`, 'data-ind': d.id },
      el('label', { class: 'ind-check' }, el('input', { type: 'checkbox', checked: on, onchange: (e) => {
        if (e.target.checked) w[d.id] = Number(r.querySelector('input[type=range]').value) || 10;
        else { memo[`${state.preset}:${d.id}`] = w[d.id] || 10; w[d.id] = 0; }
        r.classList.toggle('off', !e.target.checked); markCustom(); recompute();
      } }), el('span', {}, d.label)),
      el('input', { type: 'range', min: 5, max: 50, step: 5, value: val, 'aria-label': `${d.label} weight`, oninput: (e) => {
        const v = Number(e.target.value); r.querySelector('.ind-w').textContent = `${v}`;
        if (r.querySelector('input[type=checkbox]').checked) { w[d.id] = v; markCustom(); recompute(); } else memo[`${state.preset}:${d.id}`] = v;
      } }),
      el('span', { class: 'ind-w', title: 'Weight' }, `${val}`),
      el('button', { type: 'button', class: 'ind-info', 'aria-label': `About ${d.label}`, 'aria-expanded': 'false', onclick: (e) => {
        why.hidden = !why.hidden; e.currentTarget.setAttribute('aria-expanded', String(!why.hidden)); } }, 'i'),
      why);
    return r;
  };
  const used = [], more = [];
  for (const grp of groups) {
    const items = g.meta.indicators.filter(d => d.group === grp);
    const on = items.filter(d => (w[d.id] || 0) > 0), off = items.filter(d => !((w[d.id] || 0) > 0));
    if (on.length) used.push(el('div', { class: 'ind-group' }, grp), ...on.map(row));
    if (off.length) more.push(el('div', { class: 'ind-group' }, grp), ...off.map(row));
  }
  $('indicator-list').replaceChildren(...used,
    more.length ? el('details', { class: 'ind-more' }, el('summary', {}, `More indicators (${g.meta.indicators.length - Object.keys(activeWeights()).length})`), ...more) : null);
  markCustom();
}
function markCustom() {
  const p = preset(); if (!p) return;
  const cur = activeWeights(); const base = p.weights;
  const same = Object.keys(cur).length === Object.keys(base).length && Object.entries(base).every(([k, v]) => cur[k] === v);
  const tag = $('score-status');
  tag.textContent = same ? p.status : 'Custom weights';
  tag.className = `tag ${same && /tested/i.test(p.status) && !/not/i.test(p.status) ? 'tag-real' : 'tag-custom'}`;
  $('preset-reset').hidden = same;
}

let paintRaf = 0;
function recompute() {
  const g = state.grid; if (!g) return;
  if (state.selectedCell >= 0) state.popup?.remove();   // the open popup would show the old score
  const weights = activeWeights();
  const st = g.compute(weights);
  cancelAnimationFrame(paintRaf);
  computeQuantiles();
  paintRaf = requestAnimationFrame(() => { drawScore(); updateScoreInsights(st); });
}
function drawScore() {
  const g = state.grid, map = state.map; if (!g || !map) return;
  const url = g.paint(state.minScore);
  const src = map.getSource('score-grid');
  if (src) src.updateImage({ url, coordinates: g.corners() });
  else {
    map.addSource('score-grid', { type: 'image', url, coordinates: g.corners() });
    map.addLayer({ id: 'score-grid', type: 'raster', source: 'score-grid', paint: { 'raster-opacity': state.scoreOpacity, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, map.getLayer('anchor-vectors') ? 'anchor-vectors' : undefined);
    map.addSource('score-cell', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'score-cell', type: 'line', source: 'score-cell', paint: { 'line-color': '#ffffff', 'line-width': 3 } });
  }
  map.setLayoutProperty('score-grid', 'visibility', state.scoreOn ? 'visible' : 'none');
  if (state.selectedCell >= 0 && state.selectedCell !== undefined) selectCell(state.selectedCell, null, true);
}

/** AUC: chance that a random sighting square scores higher than a random square of the region. */
function sightingsAUC(cells, background) {
  const sc = state.grid.scores; const bg = [];
  if (background) { for (const i of background) if (!Number.isNaN(sc[i])) bg.push(sc[i]); }
  else for (let i = 0; i < sc.length; i++) if (!Number.isNaN(sc[i])) bg.push(sc[i]);
  bg.sort((a, b) => a - b);
  const below = (v) => { let lo = 0, hi = bg.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bg[m] < v) lo = m + 1; else hi = m; } let eq = lo; while (eq < bg.length && bg[eq] === v) eq++; return (lo + (eq - lo) / 2) / bg.length; };
  const p = cells.map(i => sc[i]).filter(v => !Number.isNaN(v));
  if (!p.length) return null;
  const top30 = bg[Math.floor(bg.length * 0.7)];
  return { auc: p.reduce((a, v) => a + below(v), 0) / p.length, n: p.length, inTop30: p.filter(v => v >= top30).length / p.length };
}

function updateScoreInsights(st) {
  const g = state.grid; const p = preset();
  const ticked = Object.keys(activeWeights()).length;
  setText('insight-label', `${p.label.toUpperCase()} · MEAN SCORE`);
  setText('insight-count', Number.isNaN(st.mean) ? '—' : Math.round(st.mean));
  setText('insight-sub', `${st.cells.toLocaleString()} squares of 200 m · ${ticked} indicator${ticked === 1 ? '' : 's'} ticked`);
  histogramBars($('distribution-bars'), st.hist, state.minScore);
  setText('dist-note', state.minScore > 0 ? `${Math.round(100 * g.shown / Math.max(1, st.cells))}% of the region (${(g.shown * 0.04).toFixed(0)} km²) scores ${state.minScore} or more.` : 'Blue = low, red = high. Raise "Show squares scoring at least" to keep only the best areas.');
  $('mini-track-fill').style.width = `${Math.round(st.mean || 0)}%`;
  // Evidence: real sightings from GBIF, compared with where people report other mammals (observer effort)
  const v = g.meta.validation?.[p.species || ''];
  const box = $('validation-box'); box.hidden = false;
  if (!v) box.replaceChildren(el('div', { class: 'control-label' }, el('label', {}, 'Evidence check'), el('span', { class: 'tag' }, 'not yet')), el('p', { class: 'control-note' }, p.noValidation || 'No independent data to test this score yet.'));
  else if (v.cells.length < 30) box.replaceChildren(el('div', { class: 'control-label' }, el('label', {}, 'Evidence check'), el('span', { class: 'tag' }, `${v.cells.length} sightings`)), el('p', { class: 'control-note' }, p.noValidation || `Only ${v.cells.length} sightings with exact locations: too few to test.`));
  else {
    const fair = sightingsAUC(v.cells, v.background_cells), region = sightingsAUC(v.cells);
    const verdict = fair.auc >= 0.7 ? 'good' : fair.auc >= 0.6 ? 'fair' : fair.auc > 0.55 ? 'weak' : fair.auc >= 0.45 ? 'no better than chance' : 'worse than chance';
    box.replaceChildren(
      el('div', { class: 'control-label' }, el('label', {}, 'Evidence check: real sightings'), el('span', { class: `tag ${fair.auc >= 0.6 ? 'tag-real' : 'tag-custom'}` }, `AUC ${fair.auc.toFixed(2)} · ${verdict}`)),
      el('div', { class: 'auc-track' }, el('i', { style: `left:${Math.max(0, Math.min(100, (fair.auc - 0.5) * 200))}%` })),
      el('div', { class: 'range-label' }, el('span', {}, '0.5 chance'), el('span', {}, '1.0 perfect')),
      el('p', { class: 'control-note' }, `${fair.n} roe deer sightings (GBIF, ${v.years}) against ${v.background_cells.length.toLocaleString()} sightings of other mammals by the same kind of observers, so the test is not fooled by where people walk. Against all squares of the region: AUC ${region.auc.toFixed(2)}. This live check uses the same sightings the weights were fitted on; the honest figure for new areas is below. Untick or re-weight indicators and watch it change.`),
      p.heldout ? el('p', { class: 'control-note heldout' }, el('b', {}, 'Tested on unseen areas: '), p.heldout) : null);
  }
  setText('score-note', `${g.meta.version} · ${g.meta.region} · Sentinel-2 ${formatDate(g.meta.dates.sentinel2)} · ESA WorldCover ${g.meta.dates.worldcover} · OSM ${formatDate(g.meta.dates.osm)}`);
  setText('meta-layer', `${p.label} (${g.meta.version})`); setText('meta-date', `Sentinel-2 ${formatDate(g.meta.dates.sentinel2)}`);
  setText('meta-status', 'Real open data · relative index, first version'); setText('meta-resolution', `${g.meta.cell_m} m squares · ${g.meta.cols} × ${g.meta.rows}`);
  setText('meta-coverage', g.meta.region); setText('meta-source', g.meta.sources_short);
  setText('meta-description', p.description || '');
  setText('metric-latest', `S-2 ${formatDate(g.meta.dates.sentinel2)}`);
}

/** Plain-language class, relative to this region: top 10% = very good, next 20% = good, middle 40% = average, bottom 30% = poor. */
function scoreClass(v) {
  const q = state.quantiles; if (!q || Number.isNaN(v)) return '';
  return v >= q[90] ? 'very good' : v >= q[70] ? 'good' : v >= q[30] ? 'average' : 'poor';
}
function computeQuantiles() {
  const v = Array.from(state.grid.scores).filter(x => !Number.isNaN(x)).sort((a, b) => a - b);
  const at = (p) => v[Math.min(v.length - 1, Math.floor(v.length * p / 100))];
  state.quantiles = { 30: at(30), 70: at(70), 80: at(80), 90: at(90) };
}
function setBest(pct) {
  computeQuantiles();
  const t = pct ? Math.floor(state.quantiles[100 - pct]) : 0;
  state.minScore = t; $('score-threshold').value = t; setText('threshold-label', t);
  document.querySelectorAll('[data-best]').forEach(b => b.classList.toggle('active', Number(b.dataset.best) === pct));
  recompute();
}

function highlightCell(i) {
  const src = state.map?.getSource('score-cell'); state.selectedCell = i;
  if (!src) return;
  if (i < 0) { src.setData({ type: 'FeatureCollection', features: [] }); return; }
  const [w, s, e, n] = state.grid.cellBounds(i);
  src.setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
}
function selectCell(i, lngLat, quiet) {
  const g = state.grid; const p = preset();
  const ex = g.explain(i, activeWeights());
  const [w, s, e, n] = g.cellBounds(i); const c = { lat: (s + n) / 2, lng: (w + e) / 2 };
  highlightCell(i); state.mgr?.highlight(null);
  setText('feature-name', `${p.label}: ${Number.isNaN(ex.score) ? '—' : Math.round(ex.score)} / 100 · ${scoreClass(ex.score)}`);
  setText('feature-type', '200 m square');
  $('feature-caption').textContent = `Better than ${Math.round(g.rankOf(ex.score))}% of the region · square centred at ${c.lat.toFixed(4)}° N, ${c.lng.toFixed(4)}° E.`;
  const parts = ex.parts;
  $('feature-attributes').replaceChildren(
    el('div', { class: 'explain' },
      el('div', { class: 'explain-head' }, el('span', {}, 'Why this score'), el('span', {}, 'value · weight → points')),
      ...parts.map(x => el('div', { class: 'explain-row', title: `${x.label}: ${x.value}/100 × ${x.weight}% = ${x.pts.toFixed(1)} points` },
        el('span', { class: 'explain-label' }, x.label),
        el('span', { class: 'explain-bar' }, el('i', { style: `width:${x.value}%;background:${scoreCSS(x.value)}` })),
        el('span', { class: 'explain-num' }, `${x.value} · ${x.weight}% → ${x.pts.toFixed(0)}`))),
      el('div', { class: 'explain-total' }, el('span', {}, 'Total'), el('b', {}, `${Math.round(ex.score)} / 100`))),
    el('div', { class: 'raw-head' }, 'Measured in this square'),
    ...g.raw(i).map(([k, v]) => el('div', { class: 'attribute' }, el('span', {}, k), el('b', {}, v))),
    el('p', { class: 'control-note' }, 'A relative score within the pilot region, not a probability of seeing an animal.'));
  $('feature-card').classList.remove('is-synthetic');
  if (quiet) return;
  if (isPhone()) setTab('insights'); else setCollapsed('right', false);
  state.popup?.remove();
  state.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '230px', offset: 6 }).setLngLat(lngLat || c)
    .setDOMContent(el('div', { class: 'popup' }, el('b', {}, p.label), el('div', { class: 'popup-score' }, el('i', { class: 'chip', style: `background:${scoreCSS(ex.score)}` }), `${Math.round(ex.score)} / 100 · ${scoreClass(ex.score)}`),
      el('div', { class: 'popup-meta' }, parts.length ? `Top reason: ${parts[0].label}` : ''))).addTo(state.map);
}

/* ---------- method dialog (built from grid.json, so it always matches the data) ---------- */
function renderMethod() {
  const g = state.grid; if (!g) return; const m = g.meta;
  const presets = Object.entries(m.presets);
  $('method-body').replaceChildren(
    el('p', { class: 'help-lead' }, m.method.lead),
    el('p', { class: 'formula' }, 'score = Σ (weight × indicator) ÷ Σ weight      (ticked indicators only, each 0–100)'),
    el('h3', {}, 'The indicators'),
    el('div', { class: 'table-wrap' }, el('table', { class: 'method-table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Indicator'), el('th', {}, 'What is measured'), el('th', {}, 'Why it matters'), el('th', {}, 'Data'))),
      el('tbody', {}, ...m.indicators.map(d => el('tr', {}, el('td', {}, el('b', {}, d.label)), el('td', {}, d.how), el('td', {}, d.why), el('td', {}, d.source)))))),
    el('h3', {}, 'Recommended weights'),
    el('div', { class: 'table-wrap' }, el('table', { class: 'method-table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Indicator'), ...presets.map(([, p]) => el('th', {}, p.label)))),
      el('tbody', {}, ...m.indicators.map(d => el('tr', {}, el('td', {}, d.label), ...presets.map(([, p]) => el('td', {}, p.weights[d.id] ? `${p.weights[d.id]}` : '–'))))))),
    ...presets.map(([, p]) => el('p', { class: 'control-note' }, el('b', {}, `${p.label} (${p.status.toLowerCase()}): `), p.rationale, p.heldout ? ` ${p.heldout}` : '')),
    el('h3', {}, 'Evidence check'),
    el('p', {}, m.method.validation),
    el('h3', {}, 'Limits of version 1'),
    el('ul', {}, ...m.method.limits.map(t => el('li', {}, t))),
    el('h3', {}, 'Data sources'),
    el('ul', {}, ...m.method.sources.map(t => el('li', {}, t))));
}

/* ---------- export: the score you built, as a GeoTIFF for QGIS ---------- */
function downloadScore() {
  const g = state.grid; if (!g) return;
  const name = `wildscope_${state.preset}_score_${g.meta.dates.sentinel2}.tif`;
  const blob = writeGeoTiff(g.scores, g.meta.cols, g.meta.rows, g.meta.bbox, -9999);
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  setText('map-status', `Downloaded ${name} (open it in QGIS; no-data = -9999)`);
}

/* ---------- My Revier: a private hunting-ground boundary (never leaves the browser) ---------- */
const REVIER_KEY = 'saiil-revier';
function revierBounds(gj) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c) => { if (typeof c?.[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else if (Array.isArray(c)) c.forEach(walk); };
  for (const f of gj.features) walk(f.geometry?.coordinates);
  return w <= e ? [w, s, e, n] : null;
}
function showRevier(gj, name, fly = true) {
  const { map } = state; if (!map) return;
  const polys = gj.features.filter(f => /Polygon/.test(f.geometry?.type || ''));
  if (!polys.length) throw new Error('no polygon found');
  const b = revierBounds({ features: polys });
  if (!b || b[0] < -180 || b[2] > 180 || b[1] < -90 || b[3] > 90) throw new Error('coordinates are not longitude/latitude (EPSG:4326)');
  const data = { type: 'FeatureCollection', features: polys };
  if (map.getSource('my-revier')) map.getSource('my-revier').setData(data);
  else {
    map.addSource('my-revier', { type: 'geojson', data });
    map.addLayer({ id: 'my-revier-fill', type: 'fill', source: 'my-revier', paint: { 'fill-color': '#ff7a00', 'fill-opacity': 0.06 } });
    map.addLayer({ id: 'my-revier-line', type: 'line', source: 'my-revier', paint: { 'line-color': '#ff7a00', 'line-width': 3, 'line-dasharray': [2, 1] } });
  }
  const ha = polys.reduce((a, f) => a + (areaHa(f.geometry) || 0), 0);
  state.revier = { bounds: b, name };
  $('revier-info').hidden = false;
  setText('revier-name', name);
  setText('revier-area', ha >= 100 ? `${(ha / 100).toFixed(2)} km²` : `${ha.toFixed(1)} ha`);
  if (fly) { state.spinner?.stop(); map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: panelPadding(), maxZoom: 15, duration: 2500 }); $('fly-btn').hidden = true; $('globe-btn').hidden = false; }
  condPinned = { lat: (b[1] + b[3]) / 2, lng: (b[0] + b[2]) / 2 };
  updateConditions(condPinned, 'My hunting ground');
}
async function loadRevierFile(file) {
  try {
    if (file.size > 5e6) throw new Error('file is larger than 5 MB');
    const gj = JSON.parse(await file.text());
    const fc = gj.type === 'FeatureCollection' ? gj : gj.type === 'Feature' ? { type: 'FeatureCollection', features: [gj] } : { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: gj }] };
    const name = fc.features[0]?.properties?.name || file.name.replace(/\.(geo)?json$/i, '');
    showRevier(fc, name);
    try { localStorage.setItem(REVIER_KEY, JSON.stringify({ name, fc })); } catch { /* storage may be blocked: fine, it just won't be remembered */ }
  } catch (e) { warn(`Could not load the boundary: ${e.message}. Use a GeoJSON polygon in longitude/latitude (EPSG:4326).`); }
  $('revier-file').value = '';
}
function clearRevier() {
  const { map } = state;
  for (const id of ['my-revier-line', 'my-revier-fill']) if (map?.getLayer(id)) map.removeLayer(id);
  if (map?.getSource('my-revier')) map.removeSource('my-revier');
  state.revier = null; condPinned = null; $('revier-info').hidden = true;
  try { localStorage.removeItem(REVIER_KEY); } catch { /* ignore */ }
}
function restoreRevier() {
  try { const saved = JSON.parse(localStorage.getItem(REVIER_KEY) || 'null'); if (saved?.fc) showRevier(saved.fc, saved.name, false); } catch { /* ignore */ }
}

/* ---------- panels, phone tabs, help ---------- */
function setCollapsed(side, collapsed) {
  $('app').classList.toggle(`${side}-collapsed`, collapsed);
  $(side === 'left' ? 'open-left' : 'open-right').hidden = !collapsed;
}
function setTab(tab) {
  $('app').dataset.tab = tab;
  document.querySelectorAll('.mobile-tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}

/* ---------- static controls ---------- */
function attachControls() {
  document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('preset-reset').addEventListener('click', () => { if (!state.grid) return; delete state.weights[state.preset]; renderIndicators(); recompute(); });
  $('score-visible').addEventListener('change', (e) => { state.scoreOn = e.target.checked; if (state.map?.getLayer('score-grid')) state.map.setLayoutProperty('score-grid', 'visibility', state.scoreOn ? 'visible' : 'none'); if (!state.scoreOn) highlightCell(-1); });
  $('score-opacity').addEventListener('input', (e) => { state.scoreOpacity = e.target.value / 100; if (state.map?.getLayer('score-grid')) state.map.setPaintProperty('score-grid', 'raster-opacity', state.scoreOpacity); });
  $('method-btn').addEventListener('click', () => { const d = $('method'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); });
  $('labels-btn').addEventListener('click', () => { state.labels = !state.labels; syncLabels(); });
  initSearch({ form: $('search-form'), input: $('search-input'), list: $('search-results'), status: $('search-status'),
    getNear: () => (state.map && state.map.getZoom() > 5 ? state.map.getCenter() : null), onPick: goToPlace });
  $('revier-file').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) loadRevierFile(f); });
  $('revier-zoom').addEventListener('click', () => { const b = state.revier?.bounds; if (b && state.map) { state.spinner?.stop(); state.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: panelPadding(), maxZoom: 15, duration: 1800 }); } });
  $('revier-clear').addEventListener('click', clearRevier);
  document.querySelectorAll('[data-collapse]').forEach(b => b.addEventListener('click', () => setCollapsed(b.dataset.collapse, true)));
  $('open-left').addEventListener('click', () => setCollapsed('left', false));
  $('open-right').addEventListener('click', () => setCollapsed('right', false));
  document.querySelectorAll('.mobile-tabs [data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('help-btn').addEventListener('click', () => { const d = $('help'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); });
  // Phones and small laptops start with the insights panel tucked away so the map has room.
  if (!isPhone() && window.innerWidth < 1100) setCollapsed('right', true);
  $('fly-btn').addEventListener('click', () => flyToPilot());
  $('globe-btn').addEventListener('click', backToGlobe);
  $('reset-btn').addEventListener('click', () => { flyToPilot(2500); });
  $('export-btn').addEventListener('click', downloadScore);
  document.querySelectorAll('[data-basemap]').forEach(b => b.addEventListener('click', () => updateBasemap(b.dataset.basemap, true)));
  document.querySelectorAll('[data-projection]').forEach(b => b.addEventListener('click', () => setProjection(b.dataset.projection)));
  $('snapshot-select').addEventListener('change', (e) => { clearSelection(); state.mgr?.setDate(e.target.value); });
  $('score-threshold').addEventListener('input', (e) => { setText('threshold-label', e.target.value); state.minScore = Number(e.target.value); document.querySelectorAll('[data-best]').forEach(b => b.classList.remove('active')); recompute(); });
  document.querySelectorAll('[data-best]').forEach(b => b.addEventListener('click', () => setBest(Number(b.dataset.best))));
  $('copy-view').addEventListener('click', async () => {
    if (!state.map) return;
    const c = state.map.getCenter();
    const text = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} (zoom ${state.map.getZoom().toFixed(1)})`;
    try { await navigator.clipboard.writeText(text); setText('map-status', `Copied map centre: ${text}`); } catch { setText('map-status', `Map centre: ${text}`); }
  });
}

/* ---------- start ---------- */
async function start() {
  attachControls();
  updateBasemap(state.basemap);
  const manifestP = loadManifest().catch((e) => { warn(`Cannot load data/layers.json: ${e.message}. Serve the folder over HTTP (not file://).`, true); return null; });
  const gridP = ScoreGrid.load().catch((e) => { warn(`Score grid unavailable: ${e.message}`); return null; });
  let map;
  try {
    if (!hasWebGL() || params.has('lite')) throw new Error('WebGL unavailable');
    map = await initialiseMap();
  } catch (e) {
    console.warn('3D map unavailable, switching to the simple 2D map:', e);
    try { map = await initialiseLiteMap(params.has('lite') ? 'requested with ?lite' : ''); }
    catch (e2) {
      loading(true, 'Map unavailable');
      warn(`The map could not start (${e2.message}). Check your internet connection and reload.`, true);
      return;
    }
  }
  loading(true, 'Loading layers…');
  const manifest = await manifestP;
  if (!manifest) { loading(false); return; }
  state.manifest = manifest;
  if (manifest.defaults.basemap && manifest.defaults.basemap !== state.basemap) updateBasemap(manifest.defaults.basemap);
  if (manifest.warnings.length) warn(`layers.json: ${manifest.warnings.length} entr${manifest.warnings.length === 1 ? 'y' : 'ies'} skipped — see browser console.`);
  if (!state.lite) {
    state.mgr = new LayerManager(map, manifest, { onChange: updateAnalytics, onError: (m) => warn(`Layer failed: ${m}`) });
    renderDates(); buildPanel();
  } else {
    $('layer-panel').replaceChildren(el('p', { class: 'control-note' }, 'The satellite data layers need WebGL (graphics acceleration). Switch it on in your browser settings to use them.'));
    $('snapshot-select').closest('.control-group').hidden = true;
  }
  clearFeature();
  addLabelLayers(); updateCopernicusLink();
  await state.mgr?.apply();
  state.grid = await gridP;
  if (state.grid) {
    $('score-legend-bar').style.background = rampGradient();
    setText('metric-region', state.grid.meta.region_short || state.grid.meta.region);
    renderMethod();
    const m = params.get('mode'); setMode(MODES[m] ? m : 'habitat');
  } else setText('score-note', 'Score grid could not be loaded.');
  const badge = $('data-status'); badge.classList.add('real'); badge.replaceChildren(el('span', {}, '◆'), ` REAL OPEN DATA${state.lite ? ' · SIMPLE 2D MAP' : ''}`);
  loading(false);
  restoreRevier();
  if (!state.revier) scheduleConditions(true);
  if (params.has('autofly')) setTimeout(() => flyToPilot(), 2500);
}
window.__explorer = state;   // handy for debugging in the browser console
start();
