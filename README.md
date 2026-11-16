# WildScope (SAIIL)

A **static, GitHub Pages** web portal that maps **wildlife habitat**, **biodiversity potential** and **hunting conditions** from free satellite and map data, on a **3D globe**. Pilot region: Freiburg & western Black Forest, Germany.

**Three modes:** *Habitat* (roe deer, wild boar), *Biodiversity* (habitat variety, natural cover, spectral diversity) and *Hunting* (habitat score + live wind, light, moon and a private hunting-ground boundary).

**v1.1 scores (real data, Nov 2026).** Fifteen indicators per 200 m square from Copernicus Sentinel-2 (24 Jul 2026), ESA WorldCover 2021 and OpenStreetMap, combined live in the browser with weights the user can change. The roe deer score is fitted to 186 GBIF sightings with observer-bias correction and tested with spatial cross-validation (AUC 0.74 on unseen 9 km blocks). If the browser has no WebGL, the site opens a simple 2D map (Leaflet) with the same scores. How it is made: **[scripts/README_scores.md](scripts/README_scores.md)**. Outputs: `data/scores/` (website) and `data/scores/qgis/` (GeoTIFFs).

**v1.3: a global product (Nov 2026).** Zoom to any place in the world and press **◎ Analyse this area**, or pick one from **🌍 Try a place**. The browser (`assets/js/analyse.js`) picks the clearest growing-season Sentinel-2 scene for that latitude (Microsoft Planetary Computer), reads ESA WorldCover, OpenStreetMap roads and water and GBIF sightings, and computes the same fifteen indicators for every **50 m** square of a 4–12 km box. No server, no keys.

- **Fast:** the scores appear as soon as the satellite data is in (about 10–20 s); roads and rivers from the slower public OpenStreetMap servers are added when they arrive. Results are cached in the browser for 14 days.
- **Shareable:** the address bar becomes `?area=lat,lng,km&mode=…`; **⊕ Copy link** copies it.
- **Self-checking anywhere:** deer (family Cervidae) and wild boar sightings are tested against other-mammal sightings (observer effort) for every analysed area. The pilot weights reached AUC 0.63 around Bath, UK (112 deer records) and 0.59 in Shenandoah, USA (243 white-tailed deer records), without any local fitting.
- **Indicators one by one:** "Test each indicator on its own" shows every indicator's AUC alone. With 40+ sightings and 100+ background records the weights can be tuned locally; the tuned weights are kept only if they beat the pilot weights on held-out quarters of the area.

**v1.4: demo polish (Nov 2026).** A large action dock at the bottom of the map (**Try a place · Analyse this area · Pilot region**) with a live hint of what will be scored; the analysed box is outlined and real sightings are drawn as dots; detail adapts to the area (up to 12 km at 50 m, 13–24 km at 100 m); progress shows in a small pill instead of covering the map; the opacity slider no longer overflows its box. Measured on the public site on 16 Nov 2026: first scores for a new 10 × 10 km area (New Forest, UK) in 2.7 s; the pilot weights scored AUC 0.62 there against 866 deer sightings.

**v1.5: night-sky globe, nature-first biodiversity, net-gain baseline (Nov 2026).**
- **Look:** dark glass interface; a richer night sky (Milky Way band, coloured and twinkling stars); a Sentinel-2 satellite circling the globe on a to-scale orbit (786 km up, near-polar) while the whole Earth is in view (`assets/js/orbit.js`).
- **Biodiversity is now nature-only:** habitat distinctiveness 25, habitat variety 25, natural cover 20, plant variety 15, water 10, woodland 5. Distance from towns and roads is optional, not default.
- **Habitat distinctiveness** is a new indicator: each land-cover type gets the band used in England's statutory biodiversity metric (trees 4, grass/shrub/wetland 3, cropland 2, built-up 0), derived in the browser from the stored land-cover shares.
- **Habitat baseline card (Biodiversity Net Gain style):** indicative habitat units for the area on screen (hectares × distinctiveness × condition, condition assumed moderate) and what a 10% gain would be. A screening figure, not the statutory metric.
- **Biodiversity evidence check:** for analysed areas the site samples GBIF records of all species, estimates species variety per 1–2 km block by rarefaction (expected species in 15 records) and reports the rank correlation with the score. The pilot region has not been run through it yet.
- **Sturdier:** only the satellite data blocks the first map; roads, sightings and species records each refresh the area when they arrive, and every GBIF request has a 20 s timeout.

**v1.6 (Nov 2026).** Light side panels restored (the dark filter in v1.5 cost too much graphics power and could stall or reload the page on some machines). Biodiversity mode has its own brown-to-green colour ramp and shows the Biodiversity Net Gain baseline card at the top of the insights. Choosing a new place now supersedes an analysis that is still downloading. The globe shows the five free satellite missions behind the site on to-scale orbits: Sentinel-2 (786 km, scores), Sentinel-1 (693 km, crop and forest maps), Terra MODIS (705 km, greenness), Suomi NPP VIIRS (824 km, daily view) and the ISS with the GEDI laser (420 km, forest height).

**v1.7 (Nov 2026).** **▭ Draw area:** drag a box on the map and it is scored (works on the 3D and the simple 2D map, mouse and touch). Area sizes now go up to **48 × 48 km**: up to 12 km at 50 m squares, 13–24 km at 100 m, 25–48 km at 200 m; the browser always handles about 1.4 million pixels per layer, so the load on the user's machine stays the same (measured for 48 km on the public data services: 2.4 s download, 1.2 s calculation). Large boxes ask OpenStreetMap for main roads only. A loaded hunting-ground boundary has a **Score it** button. One analysis fills all three modes; **Export** names the GeoTIFF after the area and detail. Whole countries are out of reach for a browser and are the job of the weekly server pipeline.

**Real data first.** By default the site shows only real, open data, and the live conditions update in real time:

| Layer / panel | Source | Update | Licence / terms |
|---|---|---|---|
| Sentinel-2 true colour, 10 m (2016–2024 annual cloud-free mosaics) | [EOX s2maps.eu](https://s2maps.eu), contains modified Copernicus Sentinel data | yearly | 2016: CC BY 4.0. 2018+: **CC BY-NC-SA 4.0** (non-commercial; get an EOX licence or switch to our own Sentinel-2 tiles before selling) |
| Yesterday's satellite view (VIIRS SNPP true colour, 375 m) | NASA EOSDIS GIBS | daily | NASA open data, attribution requested |
| Vegetation greenness NDVI (MODIS Terra 8-day, 250 m) | NASA EOSDIS GIBS | every 8 days | NASA open data |
| Crop types Germany, 21 classes (2017–2024) | DLR CropTypes (Sentinel-1 + Sentinel-2), WMS | yearly | CC BY 4.0 |
| Forest canopy cover and height Germany (2017–2023) | DLR Forest Structure (GEDI + Sentinel-1/2), WMS | yearly | CC BY 4.0 |
| Forest clearings / canopy loss Germany (2018–2021) | DLR Tree Canopy Cover Loss, WMS | monthly (archive) | CC BY 4.0 |
| Tree cover density Europe (2018) | Copernicus Land Monitoring Service (EEA), WMS | static | Copernicus open data, attribution |
| Protected areas | UNEP-WCMC & IUCN, Protected Planet (WDPA) | monthly | Free for non-commercial use. Commercial use needs a WDPA licence |
| Live hunting conditions (wind, gusts, temp, cloud, pressure, rain, 12 h forecast, sunrise/sunset) | [Open-Meteo](https://open-meteo.com) | live (15 min) | CC BY 4.0. The free API is non-commercial, under 10k calls/day. Paid plan for production |
| Moon phase, daylight window (BJagdG §19) | computed in the browser | live | n/a |

**The old synthetic demo patches were removed** when the real v1 scores arrived (their files stay in `data/layers/` for reference). Scores are relative indices within the pilot region, not animal counts or hunting recommendations.

- Live (branch `dev_v0`): https://wildscope.saiil.co.uk
- Add or replace a layer: **[docs/ADDING_LAYERS.md](docs/ADDING_LAYERS.md)**

## Run locally

```bash
cd wildlife-habitat-explorer
python3 -m http.server 8000      # then open http://localhost:8000
```

Opening `index.html` as `file://` won't work, because browsers block `fetch()` of local JSON. Useful URL options: `?mode=habitat|biodiversity|hunting`, `?flat=1` (start in 2D) and `?autofly=1` (fly to the pilot region automatically after load).

**Layout:** a full-screen map with two floating panels: *Explore* (left: mode, score builder, data layers) and *Insights* (right: score summary, evidence check, clicked square, live conditions in Hunting mode). Either can be hidden with its ◂/▸ button. On phones the panels open as bottom sheets from the tab bar. The **How to use** button in the top bar opens a short in-site guide.

---

## How this works

```
 data/layers/*.geojson, *.png, (later *.pmtiles / tile URLs)     ← the analytics products
          │  listed in
          ▼
 data/layers.json  (manifest: id, type, url/versions, date, bounds, style, group, species…)
          │  fetched + validated by
          ▼
 assets/js/manifest.js   →  normalised list of layers, each with a sorted "versions" archive
          │
          ▼
 assets/js/layers.js  (LayerManager)
   • picks the right version for the selected date & species
   • fetches data lazily (only layers that are switched on)
   • creates MapLibre sources + layers, applies opacity, colour ramp, min-score filter
          │
          ▼
 assets/js/globe.js   →  MapLibre GL JS 5 map: globe projection, starfield, atmosphere,
                          auto-rotate, fly-to, Map/Satellite basemaps, 2D fallback
          │
          ▼
 assets/js/ui.js + assets/app.js  →  UI panels
   • left: species, dataset date (archive), min score, generated layer list (toggle/opacity/legend)
   • right: live histogram, click info panel, provenance (all read from the manifest)
   • KPIs, popup, download visible GeoJSON, copy view, coordinates
```

### What each file does

| File | Role |
|---|---|
| `index.html` | Page layout and static HTML. Loads MapLibre (pinned 5.24.0 from unpkg, with a jsDelivr fallback) and `assets/app.js`. |
| `assets/app.js` | **Orchestrator.** Starts the map, loads the manifest, creates the LayerManager, wires buttons, slider and date select, updates KPIs, histogram and provenance, handles clicks and download. |
| `assets/js/globe.js` | Map engine setup: CDN loading/fallback, basemap style, globe projection + sky/atmosphere, starfield canvas, spin controller, fly-to helpers. |
| `assets/js/manifest.js` | Loads `data/layers.json`, resolves relative URLs, validates entries (bad entries are skipped with a console warning), and holds the date helpers (`versionFor`, `allDates`). |
| `assets/js/layers.js` | **LayerManager.** Maps each manifest entry to MapLibre sources and layers. Supports `geojson`, `raster-image`, `xyz-tiles` and `pmtiles` (the pmtiles library is loaded only if needed). |
| `assets/js/conditions.js` | Live hunting conditions: Open-Meteo weather and wind, scent-drift advice, sunrise/sunset and the legal daylight window, moon phase. |
| `assets/js/ui.js` | DOM helpers: generated layer panel, legends, histogram, click panel, polygon area. |
| `assets/styles.css` | All styling (responsive at 1100 px and 720 px). |
| `data/layers.json` | **The manifest. Edit this to add, replace or remove layers.** |
| `scripts/make_layer_demo.py` | Regenerates the synthetic demo layers and manifest (`numpy`, `Pillow`). |
| `scripts/validate_layers.py` | Checks the manifest and files before you commit (standard library only). |
| `data/catalog.json`, `data/snapshots/`, `scripts/publish_snapshot.py`, `validate_catalog.py` | Legacy v1 catalogue (no longer read by the UI). `publish_snapshot.py` is still handy for GeoTIFF → PNG. |
| `CNAME` | Custom domain for GitHub Pages. **Do not edit or delete.** |

### Five concepts worth knowing

1. **Globe projection.** Web maps usually use *Web Mercator* (EPSG:3857), which flattens the Earth into a square and stretches the poles. MapLibre 5 can instead draw the same tiles on a 3D sphere (`map.setProjection({type:'globe'})`). As you zoom in, it blends smoothly back to Mercator, so close-up maps look normal. Our data stays in lon/lat (EPSG:4326). The projection only changes how it's drawn.
2. **Sources vs layers (MapLibre).** A *source* is where data comes from (a GeoJSON file, an image with corner coordinates, a tile URL). A *layer* is a drawing rule applied to a source (`fill`, `line`, `raster`, `circle`) with paint properties such as colour and opacity. One source can feed several layers. Our polygons use one source and three layers: fill, outline and points. Filters (e.g. `score >= 50`) and colour ramps (`interpolate`) are *expressions* evaluated on the GPU, which is why the slider is instant.
3. **GeoJSON.** A JSON format for vector features. Each `Feature` has a `geometry` (Point/LineString/Polygon, coordinates `[lon, lat]` in WGS84) and free-form `properties` (score, class, NDVI…). It's simple and readable, but the whole file is downloaded, so keep it to a few MB and simplify the geometry.
4. **Raster image overlays with bounds.** A PNG has no location of its own. We tell MapLibre where its four corners go using `bounds: [west, south, east, north]`. Colours are pre-rendered into the PNG, with transparency for no-data. This is ideal for a pilot region, but not for a whole country.
5. **Tile pyramids / PMTiles.** For large areas the data is pre-cut into 256 px tiles at every zoom level (z0 = whole world in 1 tile, each level ×4 tiles). The browser only downloads tiles for the current view and zoom. `xyz-tiles` are URLs like `…/{z}/{x}/{y}.png`. **PMTiles** packs the whole pyramid into a single file that the browser reads with HTTP range requests, so you get tiles without running a tile server. Sentinel-2 at 10 m for Germany or Europe should go this way (or as COG via a tile server).

---

## Basemaps and licences

| Basemap | Source | Terms |
|---|---|---|
| Map | OpenStreetMap standard tiles (`tile.openstreetmap.org`) | © OpenStreetMap contributors (ODbL). The [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) allows light use like this demo but **forbids heavy or commercial traffic**. For production, switch to a hosted provider or self-host (e.g. OpenFreeMap or Protomaps PMTiles). |
| Satellite | Esri World Imagery (`server.arcgisonline.com`) | Attribution required (shown in the map). Esri's terms limit use without an ArcGIS account. Check them before commercial launch. **Sentinel-2 cloudless (EOX, 2016 edition, CC BY 4.0)** is an alternative that suits an EO company. |
| Libraries | MapLibre GL JS 5.24.0 (BSD-3), pmtiles 4.4.1 (BSD-3, loaded only if needed) | Loaded from unpkg, with a jsDelivr fallback for MapLibre. |

Basemap URLs are in `assets/js/globe.js` → `BASEMAPS`.

## Performance and robustness

- Page weight is roughly MapLibre (~250 KB gzipped) plus the visible layers (polygons ~18 KB each). Rasters are fetched only when switched on.
- A loading indicator shows while the globe and layers load. A broken layer shows a warning and is skipped without stopping the page. If the globe projection isn't supported, the map falls back to 2D. If MapLibre can't load from unpkg, it retries from jsDelivr.
- The spinning stops on the first drag, scroll, touch or key press, and is turned off when the system's "reduce motion" setting is on.

## Publishing (GitHub Pages)

**Cache-busting:** GitHub Pages tells browsers to cache files for 10 minutes. When you change any JS/CSS file, bump the `?v=…` version string in `index.html` (app.js, styles.css), in the `import` lines at the top of `assets/app.js`, and in `assets/js/layers.js`. Otherwise returning visitors may get a mix of old and new files. Data files (`layers.json`, GeoJSON) are always re-checked, so you don't need to do this for data.

The `dev_v0` branch is published to `hunting.saiil.co.uk` (Pages settings are managed by the repo admin). There's no build step: commit and push, and the site updates in about 1 minute. Never touch `main` or `CNAME`.

## Limitations

- Synthetic data only. `score` is a relative index, not a sighting probability.
- The download includes the source geometries of visible polygons intersecting the view (not clipped). Rasters aren't included.
- The histogram and click details work on GeoJSON layers (vector PMTiles are drawn and coloured, but not counted).
- GitHub Pages is a public host. Don't publish private hunting boundaries, camera locations or confidential data.

This is original code by SAIIL. It's inspired by the look of [pvfacilitymap.uk](https://pvfacilitymap.uk/) but doesn't copy its code, assets or data.
