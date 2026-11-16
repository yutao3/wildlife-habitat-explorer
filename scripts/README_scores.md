# WildScope v1.1 scores: how they are made

The v1 habitat and biodiversity scores cover the pilot region **Freiburg & western Black Forest (Germany)**:
7.67–8.27° E, 47.85–48.25° N, about 45 × 45 km, cut into 222 × 222 squares of 200 m.

## Pipeline (three steps)

| Step | File | What it does | Runs in |
| --- | --- | --- | --- |
| 1 | `browser/fetch_inputs.js` | Downloads ESA WorldCover 2021, one clear Sentinel-2 L2A scene (24 Jul 2026: NDVI, NDMI, SCL), OpenStreetMap roads and waterways, and GBIF sightings | Browser console |
| 2 | `browser/compute_indicators.js` | Rasterises roads and water, computes distances, aggregates the 20 m pixels into 200 m squares, scales ten indicators to 0–100 | Browser console |
| 2b | `browser/compute_extra_v11.js` | Adds woodland, open land, edge distance, distance to roads and to towns, the protected-area mask, and the GBIF "target group" (all other mammal records) | Browser console |
| 2c | `browser/export_grid.js` | Saves everything as `wildscope_export.json` (include `window.__grid2` layers and `window.__tg`) | Browser console |
| 3 | `build_scores.py` | Fits the roe deer weights (bias-corrected, spatially cross-validated), writes `data/scores/grid.json` + `grid.bin` for the website, GeoTIFFs for QGIS and preview PNGs | Python 3 + numpy + Pillow |

Steps 1–2 run in a browser because every data service used is reachable from a normal web page
(all are CORS-enabled and need no key). The next version will move steps 1–2 into Python on the
Harwell processing machine and run weekly.

```
# after steps 1, 2, 2b and 2c in a browser console:
python3 scripts/build_scores.py ~/Downloads/wildscope_export.json
```

## How the roe deer score is fitted and tested (v1.1)

- **Presence:** squares with a GBIF roe deer record (186, location within 250 m).
- **Background:** squares with a GBIF record of any *other* mammal (1,898). These come from the same
  kind of observers on the same paths, so "where people walk" largely cancels out (target-group background).
- **Fit:** weights in steps of 5 that maximise the AUC of presence against background, with guardrails:
  woodland nearby, the field–forest mosaic and green food always count, and no indicator takes more than 30%.
- **Test:** 5-fold spatial cross-validation on 9 km blocks. Result: AUC 0.74 on unseen blocks against the
  target group (0.54 against all squares). The first expert guess scored 0.51 and 0.41.
- Wild boar (7 records) and biodiversity potential cannot be tested yet and keep literature weights.

## The formula

Each indicator is scaled to 0 (poor) – 100 (good). A score is the weighted mean of the ticked indicators:

    score = Σ (weight × indicator) / Σ weight

The website recomputes this live when you tick, untick or re-weight an indicator.
Starting weights for roe deer, wild boar and biodiversity potential are in `build_scores.py` (PRESETS).

## Open the results in QGIS

`data/scores/qgis/` holds one GeoTIFF per preset score and per indicator (float32, EPSG:4326, no-data = −9999).
Drag a file into QGIS, then Properties → Symbology → Singleband pseudocolor → RdYlBu (inverted) so that
blue = low and red = high. The website's "GeoTIFF for QGIS" button exports whatever score you built.

## Known limits of v1.1

- One Sentinel-2 date; no seasonal baseline yet.
- WorldCover (2021) does not separate maize from cereals or broadleaf from conifer forest; DLR maps can replace it in Germany.
- Roads are clipped to the region, and footpaths and forest tracks are not counted yet.
- Wild boar has only 7 usable GBIF sightings here, so it cannot be tested yet.
