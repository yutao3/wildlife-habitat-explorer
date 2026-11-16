#!/usr/bin/env python3
"""WildScope v1.1, step 3 of 3: fit, test and package the scores for the website and for QGIS.

Input : a JSON export from the browser steps (scripts/browser/*.js), see scripts/README_scores.md
Output: data/scores/grid.json     metadata, indicators, the three scores (weights), evidence
        data/scores/grid.bin      one byte per 200 m square per layer (255 = no data), row 0 = north
        data/scores/qgis/*.tif    each score + every indicator as float32 GeoTIFF (EPSG:4326)
        data/scores/preview/*.png quick-look images

How the roe deer weights are found (v1.1):
  presence   = squares with a GBIF roe deer record (citizen science, location ≤ 250 m)
  background = squares with a GBIF record of any OTHER mammal ("target group"): the same people,
               paths and villages, so observer bias largely cancels out (Phillips et al. 2009)
  weights    = whole numbers in steps of 5, no indicator above 30% of the total, and three
               ecological indicators always kept (woodland nearby, open/woodland mosaic, food),
               chosen by coordinate ascent to maximise the AUC of presence vs background
  test       = 5-fold spatial cross-validation on 9 km blocks: weights are fitted without a
               block's sightings and tested on them, so nearby sightings cannot leak into the test

Standard library + numpy + Pillow.  Usage: python3 scripts/build_scores.py export.json
"""
import base64, gzip, json, struct, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'scores'

G_SHELTER, G_FOOD, G_STRUCT, G_DIST, G_WATER, G_BIO = 'Shelter', 'Food', 'Landscape structure', 'Disturbance', 'Water', 'Biodiversity'
INDICATORS = [
    dict(id='woodland', group=G_SHELTER, label='Woodland nearby',
         how='Share of trees within 600 m (the square and its 8 neighbours).',
         why='Deer and boar need cover within reach to rest, hide and escape; on hot days woodland is the best shade (Biological Conservation 2025).',
         source='ESA WorldCover 2021'),
    dict(id='cover', group=G_SHELTER, label='Tree cover in the square',
         how='Share of the 200 m square covered by trees.',
         why='Dense cover inside the square itself: important for wild boar resting places.',
         source='ESA WorldCover 2021'),
    dict(id='open', group=G_FOOD, label='Open feeding land',
         how='Share of grassland, cropland, shrub and wetland within 600 m (60% or more → 100).',
         why='Roe deer feed on meadows and fields; most sightings are on open land next to woodland.',
         source='ESA WorldCover 2021'),
    dict(id='forage', group=G_FOOD, label='Green food',
         how='Mean Sentinel-2 NDVI of the open land within 600 m on 24 Jul 2026 (0.25 → 0, 0.75 → 100).',
         why='Green, growing plants are food. Only open land is used, to avoid the "dark forest looks greenest" trap.',
         source='Copernicus Sentinel-2 L2A, 24 Jul 2026'),
    dict(id='crops', group=G_FOOD, label='Farmland nearby',
         how='Share of cropland within 600 m (50% or more → 100).',
         why='Wild boar raid maize and cereals; crops are also roe deer food.',
         source='ESA WorldCover 2021'),
    dict(id='moisture', group=G_FOOD, label='Vegetation moisture',
         how='Mean Sentinel-2 NDMI of the vegetation in the square, scaled to the region (2nd–98th percentile).',
         why='Lush, unstressed vegetation is better food in summer. Rated "high" in the feasibility study.',
         source='Copernicus Sentinel-2 L2A, 24 Jul 2026'),
    dict(id='mosaic', group=G_STRUCT, label='Field–forest mosaic',
         how='Open land and woodland both present within 600 m: 4 × open share × woodland share (a 50/50 mix → 100).',
         why='Roe deer are animals of the mosaic: food and cover close together.',
         source='ESA WorldCover 2021'),
    dict(id='edge', group=G_STRUCT, label='Forest edge length',
         how='Length of tree-to-open boundary within 600 m, scaled to the region.',
         why='Edges are where food meets cover. Rated "high" in the feasibility study.',
         source='ESA WorldCover 2021'),
    dict(id='edge_near', group=G_STRUCT, label='Close to a forest edge',
         how='Distance from the square to the nearest forest edge (on the edge → 100, 400 m or more → 0).',
         why='Animals that feed in the open stay close to the safety of the forest edge.',
         source='ESA WorldCover 2021'),
    dict(id='towns_far', group=G_DIST, label='Away from towns',
         how='Mean distance to built-up land (0 m → 0, 1 km or more → 100).',
         why='People, dogs and traffic around villages disturb wildlife; deer keep their distance.',
         source='ESA WorldCover 2021 (built-up)'),
    dict(id='roads_far', group=G_DIST, label='Away from roads',
         how='Mean distance to the nearest public road (0 m → 0, 800 m or more → 100).',
         why='Hunting and recreation disturb deer more than wolves do (Ecology & Evolution 2026); traffic kills and scares game.',
         source='OpenStreetMap roads'),
    dict(id='water', group=G_WATER, label='Water nearby',
         how='Distance to the nearest river, stream, lake or wetland (water in the square → 100, 400 m or more → 0).',
         why='Drinking; wild boar also need wet ground to wallow in.',
         source='OpenStreetMap waterways + ESA WorldCover'),
    dict(id='diversity', group=G_BIO, label='Habitat variety',
         how='Shannon diversity of land-cover types within 600 m (four evenly mixed types → 100).',
         why='More habitat types close together support more species (landscape heterogeneity).',
         source='ESA WorldCover 2021'),
    dict(id='natural', group=G_BIO, label='Natural cover',
         how='Share of the square that is forest, shrub, grassland, water or wetland.',
         why='Semi-natural land holds more species than arable fields or towns.',
         source='ESA WorldCover 2021'),
    dict(id='spectral', group=G_BIO, label='Plant variety (spectral)',
         how='Spread (standard deviation) of Sentinel-2 NDVI across the vegetation in the square, scaled to the region.',
         why='More variety of greenness tends to mean more plant variety (spectral variation hypothesis).',
         source='Copernicus Sentinel-2 L2A, 24 Jul 2026'),
]
IDS = [d['id'] for d in INDICATORS]

PRESETS = {
    'roe_deer': dict(label='Roe deer', species='roe_deer', mode='habitat', status='Fitted to sightings and tested',
        weights={},   # fitted in main()
        description='Roe deer habitat score v1.1: weights fitted to GBIF sightings with observer-bias correction, tested with spatial cross-validation.'),
    'wild_boar': dict(label='Wild boar', species='wild_boar', mode='habitat', status='Literature weights, not yet testable',
        weights=dict(woodland=20, cover=15, crops=25, water=15, towns_far=15, moisture=10),
        rationale='Wild boar rest in dense cover and feed in fields at night, so woodland, dense cover and nearby farmland lead; wet ground for wallowing and distance from villages follow. Only 7 usable GBIF records exist in the region, so these literature weights cannot be tested yet.',
        description='Wild boar habitat score v1.1 (literature weights; 7 sightings, too few to test).',
        noValidation='Only 7 usable wild boar records in GBIF here: too few to test. Hunting-bag records per hunting ground would fix this.'),
    'biodiversity': dict(label='Biodiversity potential', species=None, mode='biodiversity', status='Literature weights, not yet testable',
        weights=dict(diversity=30, natural=25, spectral=20, towns_far=10, roads_far=5, water=10),
        rationale='Many habitat types close together, a high share of semi-natural land, varied vegetation, little disturbance and water. A proxy for how much life a place can support, not a species count.',
        description='Biodiversity potential v1.1: habitat variety, natural cover, spectral diversity, distance from towns and roads, water.',
        noValidation='Not yet tested. Protected areas cover 37% of the region (including nature parks) and score no higher than elsewhere (AUC 0.49), so they are no useful test. Next: field surveys or effort-corrected species counts.'),
}

RAW = [
    dict(id='raw_tree', label='Tree cover', unit='%'), dict(id='raw_open', label='Grass, crop, shrub', unit='%'),
    dict(id='raw_crop', label='Cropland', unit='%'), dict(id='raw_built', label='Built-up', unit='%'),
    dict(id='raw_ndvi', label='NDVI of vegetation (24 Jul)', scale=0.01, digits=2),
    dict(id='raw_ndmi', label='NDMI of vegetation (24 Jul)', scale=0.01, offset=-0.5, digits=2),
    dict(id='raw_dedge', label='Nearest forest edge', unit='m', scale=20),
    dict(id='raw_droad_only', label='Mean distance to a road', unit='m', scale=20),
    dict(id='raw_dtown', label='Mean distance to built-up land', unit='m', scale=40),
    dict(id='raw_dwater', label='Nearest water', unit='m', scale=20),
]
REQUIRED = ('woodland', 'mosaic', 'forage')   # ecological guardrails for the fitted roe deer score
CAP = 30                                         # no indicator above 30% of the total weight


def write_geotiff(path, arr, bbox, nodata=-9999.0):
    """Single-band float32 GeoTIFF, EPSG:4326, no compression (no GDAL needed)."""
    rows, cols = arr.shape
    w, s, e, n = bbox
    data = np.where(np.isnan(arr), nodata, arr).astype('<f4').tobytes()
    geokeys = [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]
    nod = f'{nodata:g}\0'.encode()
    tags = [(256, 4, [cols]), (257, 4, [rows]), (258, 3, [32]), (259, 3, [1]), (262, 3, [1]), (273, 4, [0]),
            (277, 3, [1]), (278, 4, [rows]), (279, 4, [len(data)]), (284, 3, [1]), (339, 3, [3]),
            (33550, 12, [(e - w) / cols, (n - s) / rows, 0.0]), (33922, 12, [0, 0, 0, w, n, 0]),
            (34735, 3, geokeys), (42113, 2, nod)]
    size = {2: 1, 3: 2, 4: 4, 12: 8}
    fmt = {3: 'H', 4: 'I', 12: 'd'}
    ifd_start = 8; ifd_len = 2 + 12 * len(tags) + 4
    extra = bytearray(); offsets = {}
    for tag, typ, vals in tags:
        nbytes = size[typ] * len(vals)
        if nbytes > 4:
            offsets[tag] = ifd_start + ifd_len + len(extra)
            extra += vals if typ == 2 else struct.pack('<' + fmt[typ] * len(vals), *vals)
            if len(extra) % 2: extra += b'\0'
    data_start = ifd_start + ifd_len + len(extra)
    ifd = struct.pack('<H', len(tags))
    for tag, typ, vals in tags:
        if tag == 273: vals = [data_start]
        cnt = len(vals)
        if tag in offsets: val = struct.pack('<I', offsets[tag])
        elif typ == 2: val = vals.ljust(4, b'\0')
        else: val = struct.pack('<' + fmt[typ] * cnt, *vals).ljust(4, b'\0')
        ifd += struct.pack('<HHI', tag, typ, cnt) + val
    ifd += struct.pack('<I', 0)
    Path(path).write_bytes(b'II' + struct.pack('<HI', 42, ifd_start) + ifd + bytes(extra) + data)


def auc(scores, cells):
    bg = np.sort(scores[~np.isnan(scores)])
    p = scores[cells]; p = p[~np.isnan(p)]
    lo = np.searchsorted(bg, p, 'left'); hi = np.searchsorted(bg, p, 'right')
    return float(np.mean((lo + (hi - lo) / 2) / len(bg))), int(len(p)), float(np.mean(p >= bg[int(len(bg) * 0.7)]))


def ramp_png(arr, path):
    """Quick-look PNG coloured by rank in the region (as the website does)."""
    ok = ~np.isnan(arr); r = np.full(arr.shape, np.nan); v = arr[ok]; r[ok] = 100 * np.argsort(np.argsort(v)) / max(1, len(v) - 1); arr = r
    from PIL import Image
    stops = [(0, (44, 79, 179)), (25, (90, 160, 216)), (45, (201, 230, 239)), (55, (255, 242, 176)), (75, (245, 154, 82)), (100, (200, 21, 27))]
    xs = [v for v, _ in stops]
    rgba = np.zeros(arr.shape + (4,), np.uint8)
    for k in range(3): rgba[..., k] = np.interp(np.nan_to_num(arr), xs, [c[k] for _, c in stops])
    rgba[..., 3] = np.where(np.isnan(arr), 0, 255)
    Image.fromarray(rgba, 'RGBA').resize((arr.shape[1] * 3, arr.shape[0] * 3), Image.NEAREST).save(path, optimize=True)



def auc_vals(p, b):
    """Probability that a presence value beats a background value (ties count half)."""
    p = p[~np.isnan(p)]; b = np.sort(b[~np.isnan(b)])
    if not len(p) or not len(b): return float('nan')
    lo = np.searchsorted(b, p, 'left'); hi = np.searchsorted(b, p, 'right')
    return float(np.mean((lo + (hi - lo) / 2) / len(b)))


def main(export_path):
    ex = json.loads(Path(export_path).read_text())
    cols, rows, bbox = ex['cols'], ex['rows'], ex['bbox']; n = cols * rows
    raw = gzip.decompress(base64.b64decode(ex['layers_b64']))
    L = {k: np.frombuffer(raw[i * n:(i + 1) * n], np.uint8).copy() for i, k in enumerate(ex['layer_order'])}
    valid = L['valid'] == 1
    # derived indicator: field–forest mosaic
    o = np.minimum(L['open'].astype(float) * 0.6 / 100, 1); w = L['woodland'].astype(float) / 100
    L['mosaic'] = np.where((L['open'] == 255) | (L['woodland'] == 255), 255, np.clip(np.round(400 * o * w), 0, 100)).astype(np.uint8)
    X = {k: np.where(L[k] == 255, np.nan, L[k].astype(float)) for k in IDS}

    def score_at(weights, idx):
        num = np.zeros(len(idx)); den = np.zeros(len(idx))
        for k, v in weights.items():
            if v <= 0: continue
            a = X[k][idx]; ok = ~np.isnan(a); num += np.where(ok, v * a, 0); den += np.where(ok, v, 0)
        return np.where(den > 0, num / np.maximum(den, 1e-9), np.nan)

    def score_map(weights):
        s = score_at(weights, np.arange(n)); s[~valid] = np.nan
        return s.reshape(rows, cols)

    def cell(lon, lat):
        c = int((lon - bbox[0]) / (bbox[2] - bbox[0]) * cols); r = int((bbox[3] - lat) / (bbox[3] - bbox[1]) * rows)
        return r * cols + c if 0 <= c < cols and 0 <= r < rows else None

    sightings = {sp: [cell(p['lon'], p['lat']) for p in ex['gbif'] if p['sp'] == sp] for sp in ('roe_deer', 'wild_boar')}
    pres = np.array([c for c in sightings['roe_deer'] if c is not None and valid[c]])
    tg = np.array([c for c in (cell(p[0], p[1]) for p in ex['target_group']['points']) if c is not None and valid[c]])
    allc = np.where(valid)[0]

    def fit(p, b):
        wts = {k: (10 if k in REQUIRED else 0) for k in IDS}
        best = auc_vals(score_at(wts, p), score_at(wts, b))
        for _ in range(8):
            improved = False
            for k in IDS:
                for v in range(0, 55, 5):
                    if v == wts[k] or (k in REQUIRED and v < 5): continue
                    t = dict(wts); t[k] = v; tot = sum(t.values())
                    if not tot or max(t.values()) / tot > CAP / 100 + 1e-9: continue
                    a = auc_vals(score_at(t, p), score_at(t, b))
                    if a > best + 0.002: best, wts, improved = a, t, True
            if not improved: break
        tot = sum(wts.values())
        return {k: int(round(v * 100 / tot / 5) * 5) for k, v in wts.items() if v > 0}

    # 5-fold spatial cross-validation on 5 × 5 blocks of ~9 km
    blk = lambda c: (c // cols) * 5 // rows * 5 + (c % cols) * 5 // cols
    rng = np.random.default_rng(7); order = np.arange(25); rng.shuffle(order); fold = {b: i % 5 for i, b in enumerate(order)}
    fp = np.array([fold[blk(c)] for c in pres]); fb = np.array([fold[blk(c)] for c in tg]); fa = np.array([fold[blk(c)] for c in allc])
    folds = []
    for f in range(5):
        wf = fit(pres[fp != f], tg[fb != f]); pt = pres[fp == f]
        folds.append(dict(fold=f, test_sightings=int(len(pt)), weights=wf,
                          auc_vs_effort=round(auc_vals(score_at(wf, pt), score_at(wf, tg[fb == f])), 3),
                          auc_vs_region=round(auc_vals(score_at(wf, pt), score_at(wf, allc[fa == f])), 3)))
    final = fit(pres, tg)
    PRESETS['roe_deer']['weights'] = final
    cv_e = float(np.average([f['auc_vs_effort'] for f in folds], weights=[f['test_sightings'] for f in folds]))
    cv_r = float(np.average([f['auc_vs_region'] for f in folds], weights=[f['test_sightings'] for f in folds]))
    expert = dict(edge=25, cover=20, forage=20, roads_far=8, towns_far=7, moisture=10, water=10)
    ev = dict(cv_vs_effort=round(cv_e, 3), cv_vs_region=round(cv_r, 3),
              all_vs_effort=round(auc_vals(score_at(final, pres), score_at(final, tg)), 3),
              all_vs_region=round(auc_vals(score_at(final, pres), score_at(final, allc)), 3),
              expert_vs_effort=round(auc_vals(score_at(expert, pres), score_at(expert, tg)), 3),
              expert_vs_region=round(auc_vals(score_at(expert, pres), score_at(expert, allc)), 3),
              single={k: dict(vs_effort=round(auc_vals(X[k][pres], X[k][tg]), 3), vs_region=round(auc_vals(X[k][pres], X[k][allc]), 3)) for k in IDS},
              folds=folds, n_sightings=int(len(pres)), n_background=int(len(tg)))
    PRESETS['roe_deer']['rationale'] = (
        f'Weights fitted to {len(pres)} roe deer sightings against {len(tg)} sightings of other mammals made by the same kind of observers, '
        f'with guardrails: woodland nearby, the field–forest mosaic and green food always count, and no indicator takes more than {CAP}%. '
        f'The data say roe deer here are found on open feeding land in a field–forest mosaic, away from towns and roads.')
    PRESETS['roe_deer']['heldout'] = (
        f'Spatial cross-validation (9 km blocks held out): AUC {cv_e:.2f} against where people report other mammals, '
        f'{cv_r:.2f} against the whole region. The first expert guess scored {ev["expert_vs_effort"]:.2f} and {ev["expert_vs_region"]:.2f}.')

    validation = {}
    for sp in ('roe_deer', 'wild_boar'):
        pts = [p for p in ex['gbif'] if p['sp'] == sp]
        yrs = sorted(p['year'] for p in pts if p.get('year'))
        validation[sp] = dict(cells=[c for c in sightings[sp] if c is not None], n_records=len(pts), years=f'{yrs[0]}–{yrs[-1]}' if yrs else 'n/a',
                              source='GBIF.org occurrence search, human observations, coordinate uncertainty ≤ 250 m')
    validation['roe_deer']['background_cells'] = tg.tolist()
    validation['roe_deer']['background'] = ex['target_group']['description']

    (OUT / 'qgis').mkdir(parents=True, exist_ok=True); (OUT / 'preview').mkdir(parents=True, exist_ok=True)
    stats = {}
    for pid, p in PRESETS.items():
        sc = score_map(p['weights'])
        write_geotiff(OUT / 'qgis' / f'{pid}_score.tif', sc, bbox)
        ramp_png(sc, OUT / 'preview' / f'{pid}_score.png')
        stats[pid] = dict(mean=round(float(np.nanmean(sc)), 1), p10=round(float(np.nanpercentile(sc, 10)), 1), p90=round(float(np.nanpercentile(sc, 90)), 1))
    for d in INDICATORS:
        write_geotiff(OUT / 'qgis' / f'indicator_{d["id"]}.tif', np.where(valid, X[d['id']], np.nan).reshape(rows, cols), bbox)

    keep = ['valid'] + IDS + [r['id'] for r in RAW]
    (OUT / 'grid.bin').write_bytes(b''.join(L[k].tobytes() for k in keep))
    meta = dict(
        version='WildScope v1.1', created=ex['created'], region='Freiburg & western Black Forest (DE)', region_short='Freiburg & Black Forest (DE)',
        bbox=bbox, cols=cols, rows=rows, cell_m=200, bin='grid.bin', layers=keep,
        dates=dict(sentinel2=ex['dates']['sentinel2'], sentinel2_scene=ex['dates']['scene'], worldcover='2021', osm=ex['dates']['osm'], gbif=ex['dates']['gbif']),
        sources_short='Sentinel-2 L2A (Copernicus/ESA via Microsoft Planetary Computer), ESA WorldCover 2021, OpenStreetMap, GBIF',
        indicators=INDICATORS, raw=RAW, presets=PRESETS, validation=validation, evidence=dict(roe_deer=ev), stats=stats, normalisation=ex['norm'],
        method=dict(
            lead='Each 200 m square gets 15 indicators, each scaled from 0 (poor) to 100 (good). A score is the weighted average of the indicators that are ticked. All inputs are free, open data; nothing is invented.',
            validation=(f'The roe deer score is fitted and tested on real sightings: {len(pres)} GBIF records (citizen science, location within 250 m). '
                        f'People report animals where people go, so the comparison is made against {len(tg)} records of other mammals by the same kind of observers ("target-group background"). '
                        f'AUC is the chance that a square with a roe deer record scores higher than a square with another mammal record: 0.5 = no better than chance, 0.7 or more = useful. '
                        f'Tested on 9 km blocks the fit never saw, the score reaches AUC {cv_e:.2f} ({cv_r:.2f} against the whole region). '
                        f'The first, purely expert guess scored {ev["expert_vs_effort"]:.2f}: it put too much weight on dense forest, where people rarely see deer.'),
            limits=['One clear Sentinel-2 date (24 Jul 2026). Weekly updates and each place\'s seasonal normal come next.',
                    'Sightings are citizen science: they show where people see roe deer, not every place deer use. Hunting-bag, camera-trap or GPS-collar data would give a stronger test.',
                    'ESA WorldCover (2021) does not separate maize from cereals, or broadleaf from conifer forest; DLR maps can replace it in Germany.',
                    'Roads and towns outside the region are not counted, so distances near the edge are slightly too large. Footpaths and forest tracks are not counted yet.',
                    'Wild boar (7 records) and biodiversity potential cannot be tested yet; their weights come from the literature.',
                    'Scores are relative to this region; a 70 here is not the same as a 70 in another region.'],
            sources=['Copernicus Sentinel-2 L2A, scene ' + ex['dates']['scene'] + ' (contains modified Copernicus Sentinel data 2026), via Microsoft Planetary Computer',
                     'ESA WorldCover 10 m 2021 v200 (© ESA WorldCover project, CC BY 4.0), via Microsoft Planetary Computer',
                     '© OpenStreetMap contributors (ODbL), roads and waterways, downloaded ' + ex['dates']['osm'],
                     'GBIF.org occurrence data (roe deer, wild boar and all other mammals), downloaded ' + ex['dates']['gbif'] + ' (CC BY / CC BY-NC per dataset)']))
    (OUT / 'grid.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(json.dumps(dict(final=final, evidence={k: v for k, v in ev.items() if k != 'single'}, stats=stats), indent=1))


if __name__ == '__main__':
    main(sys.argv[1])
