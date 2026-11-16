/* litemap.js — a 2D "lite" map for browsers without WebGL (hardware acceleration off,
   locked-down work laptops, some virtual machines). It wraps Leaflet in the small part of the
   MapLibre API that app.js uses, so the scores, click-to-explain, search, labels and the
   hunting-ground boundary keep working. The 3D globe and the satellite data layers need WebGL. */

const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist';

export function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
    return !!gl;
  } catch { return false; }
}

export async function ensureLeaflet() {
  if (window.L?.map) return window.L;
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = `${LEAFLET}/leaflet.css`; document.head.append(css);
  await new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = `${LEAFLET}/leaflet.js`; s.onload = resolve;
    s.onerror = () => reject(new Error('Leaflet could not be loaded')); document.head.append(s);
  });
  return window.L;
}

const ll = (c) => Array.isArray(c) ? [c[1], c[0]] : [c.lat, c.lng];
const evt = (e, lm) => ({ lngLat: { lng: e.latlng.lng, lat: e.latlng.lat }, point: lm.latLngToContainerPoint(e.latlng), originalEvent: e.originalEvent });

export class LiteMap {
  constructor(container, { basemaps, active = 'satellite', center = [8.0, 48.05], zoom = 10 } = {}) {
    const L = window.L;
    this.lm = L.map(container, { zoomControl: false, attributionControl: true, preferCanvas: false, worldCopyJump: true }).setView(ll(center), zoom);
    L.control.zoom({ position: 'topright' }).addTo(this.lm);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(this.lm);
    this.base = {};
    for (const [key, b] of Object.entries(basemaps)) this.base[key] = L.tileLayer(b.tiles[0], { maxZoom: 19, maxNativeZoom: b.maxzoom, attribution: b.attribution });
    this.base[active]?.addTo(this.lm);
    this.sources = {}; this.layers = {};
    this.lm.createPane('scores'); this.lm.getPane('scores').style.zIndex = 380;
    this.lm.createPane('labels'); this.lm.getPane('labels').style.zIndex = 390; this.lm.getPane('labels').style.pointerEvents = 'none';
    this.lite = true;
  }
  setBasemap(which) { for (const [k, t] of Object.entries(this.base)) { if (k === which) t.addTo(this.lm).bringToBack(); else this.lm.removeLayer(t); } }

  /* events */
  on(type, fn) {
    if (type === 'click' || type === 'mousemove') this.lm.on(type, (e) => fn(evt(e, this.lm)));
    else if (type === 'moveend') this.lm.on('moveend', () => fn({}));
    return this;
  }
  once(type, fn) { if (type === 'moveend') this.lm.once('moveend', () => fn({})); else setTimeout(() => fn({}), 0); return this; }

  /* camera */
  getCenter() { const c = this.lm.getCenter(); return { lng: c.lng, lat: c.lat }; }
  getZoom() { return this.lm.getZoom(); }
  getBounds() { return this.lm.getBounds(); }
  getCanvas() { return this.lm.getContainer(); }
  getCanvasContainer() { return this.lm.getContainer(); }
  project(lnglat) { return this.lm.latLngToContainerPoint(ll(lnglat)); }
  unproject(p) { const c = this.lm.containerPointToLatLng([p.x, p.y]); return { lng: c.lng, lat: c.lat }; }
  isStyleLoaded() { return true; }
  stop() { this.lm.stop(); }
  addControl() { /* MapLibre-only controls */ }
  jumpTo({ center, zoom }) { this.lm.setView(center ? ll(center) : this.lm.getCenter(), zoom ?? this.lm.getZoom(), { animate: false }); }
  flyTo({ center, zoom, duration }) { this.lm.flyTo(center ? ll(center) : this.lm.getCenter(), Math.round(zoom ?? this.lm.getZoom()), { duration: Math.min(3, (duration || 1500) / 1000) }); }
  easeTo(o) { this.flyTo(o); }
  pad(padding) { const p = typeof padding === 'number' ? { top: padding, bottom: padding, left: padding, right: padding } : (padding || {}); return { paddingTopLeft: [p.left || 0, p.top || 0], paddingBottomRight: [p.right || 0, p.bottom || 0] }; }
  fitBounds([[w, s], [e, n]], opts = {}) { this.lm.flyToBounds([[s, w], [n, e]], { ...this.pad(opts.padding), maxZoom: opts.maxZoom ?? 15, duration: 1.5 }); }
  cameraForBounds([[w, s], [e, n]], opts = {}) {
    const b = window.L.latLngBounds([[s, w], [n, e]]); const p = this.pad(opts.padding);
    const z = this.lm.getBoundsZoom(b, false, window.L.point(p.paddingTopLeft[0] + p.paddingBottomRight[0], p.paddingTopLeft[1] + p.paddingBottomRight[1]));
    const c = b.getCenter(); return { center: [c.lng, c.lat], zoom: Math.min(z, opts.maxZoom ?? 18) };
  }

  /* sources and layers (the subset app.js uses) */
  addSource(id, def) {
    const L = window.L; const self = this;
    if (def.type === 'image') {
      const [[w, n], , [e, s]] = def.coordinates;
      const ov = L.imageOverlay(def.url, [[s, w], [n, e]], { pane: 'scores', className: 'lite-pixelated', interactive: false });
      this.sources[id] = { def, ov, updateImage({ url }) { ov.setUrl(url); } };
    } else if (def.type === 'geojson') {
      this.sources[id] = { def, data: def.data, layers: [], setData(data) { this.data = data; for (const g of this.layers) { g.clearLayers(); g.addData(data); } } };
    } else if (def.type === 'raster') {
      this.sources[id] = { def, tile: L.tileLayer(def.tiles[0], { maxZoom: 19, maxNativeZoom: def.maxzoom ?? 19, attribution: def.attribution, pane: id.startsWith('ref-') ? 'labels' : 'tilePane' }) };
    }
    return self;
  }
  getSource(id) { return this.sources[id]; }
  getLayer(id) { return this.layers[id]; }
  addLayer(def) {
    const L = window.L; const src = this.sources[def.source]; if (!src) return;
    let layer;
    if (def.type === 'raster' && src.ov) { layer = src.ov; if (def.paint?.['raster-opacity'] !== undefined) layer.setOpacity(def.paint['raster-opacity']); }
    else if (def.type === 'raster' && src.tile) { layer = src.tile; if (def.paint?.['raster-opacity'] !== undefined) layer.setOpacity(def.paint['raster-opacity']); }
    else if (def.type === 'line' || def.type === 'fill') {
      const p = def.paint || {};
      const style = def.type === 'line'
        ? { color: p['line-color'] || '#fff', weight: p['line-width'] || 2, fill: false, dashArray: p['line-dasharray'] ? p['line-dasharray'].map(v => v * 4).join(' ') : null }
        : { stroke: false, fillColor: p['fill-color'] || '#ff7a00', fillOpacity: p['fill-opacity'] ?? 0.2 };
      layer = L.geoJSON(src.data, { style: () => style, interactive: false, pane: 'scores' });
      src.layers.push(layer);
    }
    if (!layer) return;
    this.layers[def.id] = { def, layer, visible: true };
    layer.addTo(this.lm);
  }
  setLayoutProperty(id, prop, value) {
    const l = this.layers[id]; if (!l || prop !== 'visibility') return;
    const on = value !== 'none'; if (on === l.visible) return;
    l.visible = on; if (on) l.layer.addTo(this.lm); else this.lm.removeLayer(l.layer);
  }
  setPaintProperty(id, prop, value) { const l = this.layers[id]; if (l && /opacity/.test(prop) && l.layer.setOpacity) l.layer.setOpacity(value); }
  removeLayer(id) { const l = this.layers[id]; if (l) { this.lm.removeLayer(l.layer); delete this.layers[id]; } }
  removeSource(id) { delete this.sources[id]; }
  queryRenderedFeatures() { return []; }
}

/* Popup and Marker with the MapLibre call shapes app.js uses. */
export class LitePopup {
  constructor(opts = {}) { this.p = window.L.popup({ maxWidth: parseInt(opts.maxWidth, 10) || 260, closeButton: opts.closeButton !== false, offset: [0, -(opts.offset || 0)] }); }
  setLngLat(c) { this.p.setLatLng(ll(c)); return this; }
  setDOMContent(node) { this.p.setContent(node); return this; }
  setText(t) { this.p.setContent(String(t)); return this; }
  addTo(map) { this.map = map; this.p.openOn(map.lm); return this; }
  remove() { this.map?.lm.closePopup(this.p); return this; }
}
export class LiteMarker {
  constructor(opts = {}) { this.m = window.L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 2, fillColor: opts.color || '#ff7a00', fillOpacity: 1 }); }
  setLngLat(c) { this.m.setLatLng(ll(c)); return this; }
  setPopup(p) { this.m.bindPopup(p.p); return this; }
  addTo(map) { this.m.addTo(map.lm); return this; }
  remove() { this.m.remove(); return this; }
}
