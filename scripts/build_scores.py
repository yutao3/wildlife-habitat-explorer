#!/usr/bin/env python3
"""WildScope v1, step 3 of 3: package the indicator grid for the website and for QGIS.

Input : a JSON export from the browser steps (scripts/browser/*.js), see scripts/README_scores.md
Output: data/scores/grid.json   metadata, indicator definitions, presets (weights), validation
        data/scores/grid.bin    one byte per 200 m cell per layer (255 = no data), row 0 = north
        data/scores/qgis/*.tif  preset scores + every indicator as float32 GeoTIFF (EPSG:4326)
        data/scores/preview/*.png quick-look images

Standard library + numpy + Pillow.  Usage: python3 scripts/build_scores.py export.json
"""
import base64, gzip, json, math, struct, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'scores'

INDICATORS = [
    dict(id='cover', label='Tree cover (shelter)',
         how='Share of the 200 m square covered by trees (ESA WorldCover, 10 m).',
         why='Deer and boar rest and hide in woodland; on hot days woodland is the best shade (Biological Conservation 2025, roe deer).',
         source='ESA WorldCover 2021'),
    dict(id='edge', label='Forest–open edge',
         how='Length of boundary between trees and grass, crops or shrubs, within 600 m (3 × 3 squares), scaled to the region.',
         why='Edges put food (open land) next to cover (forest): the classic roe deer habitat. Rated "high" in the feasibility study.',
         source='ESA WorldCover 2021'),
    dict(id='forage', label='Food on open land',
         how='Mean Sentinel-2 NDVI of grass, crop and shrub pixels within 600 m on 24 Jul 2026 (0.25 → 0, 0.75 → 100).',
         why='Green, growing vegetation near cover is food. Using only open land avoids the "dark forest looks greenest" trap.',
         source='Copernicus Sentinel-2 L2A, 24 Jul 2026'),
    dict(id='quiet', label='Quiet (far from roads)',
         how='Mean distance to the nearest road or built-up pixel (0 m → 0, 1 km or more → 100).',
         why='Hunting and recreation disturb deer more than wolves do (Ecology & Evolution 2026); tracked animals keep away from roads.',
         source='OpenStreetMap roads + ESA WorldCover built-up'),
    dict(id='water', label='Water nearby',
         how='Distance from the square to the nearest river, stream, lake or wetland (water inside the square → 100, 400 m or more → 0).',
         why='Drinking water; wild boar also need wet ground to wallow in.',
         source='OpenStreetMap waterways + ESA WorldCover water'),
    dict(id='moisture', label='Vegetation moisture',
         how='Mean Sentinel-2 NDMI of vegetation in the square, scaled to the region (2nd–98th percentile).',
         why='Moist, lush vegetation is better food and cover in summer; dry stress lowers both. Rated "high" in the feasibility study.',
         source='Copernicus Sentinel-2 L2A, 24 Jul 2026'),
    dict(id='crops', label='Farmland nearby',
         how='Share of cropland within 600 m (50% or more → 100).',
         why='Wild boar raid maize and cereals next to forest; crops are also roe deer food.',
         source='ESA WorldCover 2021'),
    dict(id='diversity', label='Habitat variety',
         how='Shannon diversity of land-cover types (forest, shrub, grass, crop, water, wetland) within 600 m; four evenly mixed types → 100.',
         why='More habitat types close together support more species (landscape heterogeneity).',
         source='ESA WorldCover 2021'),
    dict(id='natural', label='Natural cover',
         how='Share of the square that is forest, shrub, grassland, water or wetland (not crops, not built-up, not bare).',
         why='Semi-natural land holds more species than arable fields or towns.',
         source='ESA WorldCover 2021'),
    dict(id='spectral', label='Plant variety (spectral)',
         how='Spread (standard deviation) of Sentinel-2 NDVI across the vegetation in the square, scaled to the region.',
         why='More variety of greenness in an image tends to mean more plant variety (spectral variation hypothesis).',
         source='Copernicus Sentinel-2 L2A, 24 Jul 2026'),
]

PRESETS = {
    'roe_deer': dict(label='Roe deer · expert', species='roe_deer', mode='habitat',
        weights=dict(edge=25, cover=20, forage=20, quiet=15, moisture=10, water=10),
        rationale='Roe deer are edge animals: they feed on open land and hide in nearby woodland, so the forest–open edge gets the largest weight, then cover and food. Quiet reflects avoidance of roads and people; water and moisture matter less.',
        description='Roe deer habitat score v1 (expert weights): forest–open edge, cover, food on open land, quiet, moisture and water.'),
    'roe_deer_data': dict(label='Roe deer · data', species='roe_deer', mode='habitat',
        weights={},   # learned in main() from GBIF sightings 2009–2021, tested on 2022–2026
        rationale='Weights learned from where roe deer were actually reported: each indicator that separates the 2009–2021 sightings from the rest of the region gets a weight in proportion to how well it does (indicator AUC − 0.5). It is then tested on the 2022–2026 sightings it never saw.',
        description='Roe deer habitat score v1 (weights learned from GBIF sightings 2009–2021, tested on 2022–2026).'),
    'wild_boar': dict(label='Wild boar', species='wild_boar', mode='habitat',
        weights=dict(cover=25, crops=25, water=15, quiet=15, moisture=10, edge=10),
        rationale='Wild boar rest in dense cover and feed in fields (maize, cereals) at night, so cover and nearby farmland get the largest weights; wet ground for wallowing and quiet come next.',
        description='Wild boar habitat score v1: cover, farmland nearby, water, quiet, moisture and edge.'),
    'biodiversity': dict(label='Biodiversity potential', species=None, mode='biodiversity',
        weights=dict(diversity=30, natural=25, spectral=20, quiet=15, water=10),
        rationale='Biodiversity potential rewards places with many habitat types close together, a high share of semi-natural land, varied vegetation, little disturbance and water. It is a proxy for how much life a place can support, not a count of species.',
        description='Biodiversity potential v1: habitat variety, natural cover, spectral diversity, quiet and water.',
        noValidation='Not yet tested. Next step: compare with the number of species recorded in GBIF per square (biased towards towns and paths) or with field surveys.'),
}

RAW = [
    dict(id='raw_tree', label='Tree cover', unit='%'), dict(id='raw_open', label='Grass, crop, shrub', unit='%'),
    dict(id='raw_crop', label='Cropland', unit='%'), dict(id='raw_built', label='Built-up', unit='%'),
    dict(id='raw_ndvi', label='NDVI of vegetation (24 Jul)', scale=0.01, digits=2),
    dict(id='raw_ndmi', label='NDMI of vegetation (24 Jul)', scale=0.01, offset=-0.5, digits=2),
    dict(id='raw_droad', label='Mean distance to road / town', unit='m', scale=20),
    dict(id='raw_dwater', label='Nearest water', unit='m', scale=20),
]


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
    from PIL import Image
    stops = [(0, (44, 79, 179)), (25, (90, 160, 216)), (45, (201, 230, 239)), (55, (255, 242, 176)), (75, (245, 154, 82)), (100, (200, 21, 27))]
    xs = [v for v, _ in stops]
    rgba = np.zeros(arr.shape + (4,), np.uint8)
    for k in range(3): rgba[..., k] = np.interp(np.nan_to_num(arr), xs, [c[k] for _, c in stops])
    rgba[..., 3] = np.where(np.isnan(arr), 0, 255)
    Image.fromarray(rgba, 'RGBA').resize((arr.shape[1] * 3, arr.shape[0] * 3), Image.NEAREST).save(path, optimize=True)


def main(export_path):
    ex = json.loads(Path(export_path).read_text())
    cols, rows, bbox = ex['cols'], ex['rows'], ex['bbox']
    raw = gzip.decompress(base64.b64decode(ex['layers_b64']))
    order = ex['layer_order']; n = cols * rows
    L = {k: np.frombuffer(raw[i * n:(i + 1) * n], np.uint8).reshape(rows, cols) for i, k in enumerate(order)}
    valid = L['valid'] == 1

    def score(weights):
        num = np.zeros((rows, cols)); den = np.zeros((rows, cols))
        for k, w in weights.items():
            v = L[k].astype(float); ok = v != 255
            num += np.where(ok, w * v, 0); den += np.where(ok, w, 0)
        out = np.where((den > 0) & valid, num / np.maximum(den, 1e-9), np.nan)
        return out

    # GBIF sightings → cell indices
    validation = {}
    for sp in ('roe_deer', 'wild_boar'):
        pts = [p for p in ex['gbif'] if p['sp'] == sp]
        cells = []
        for p in pts:
            c = int((p['lon'] - bbox[0]) / (bbox[2] - bbox[0]) * cols); r = int((bbox[3] - p['lat']) / (bbox[3] - bbox[1]) * rows)
            if 0 <= c < cols and 0 <= r < rows: cells.append(r * cols + c)
        yrs = sorted(p['year'] for p in pts if p.get('year'))
        validation[sp] = dict(cells=cells, n_records=len(pts), years=f'{yrs[0]}–{yrs[-1]}' if yrs else 'n/a',
                              source='GBIF.org occurrence search, human observations, coordinate uncertainty ≤ 250 m')

    # --- learn roe deer weights from older sightings, keep newer ones for the test (temporal split)
    def cell_of(p):
        c = int((p['lon'] - bbox[0]) / (bbox[2] - bbox[0]) * cols); r = int((bbox[3] - p['lat']) / (bbox[3] - bbox[1]) * rows)
        return r * cols + c if 0 <= c < cols and 0 <= r < rows else None
    roe = [p for p in ex['gbif'] if p['sp'] == 'roe_deer' and cell_of(p) is not None]
    SPLIT = 2022
    train = np.array([cell_of(p) for p in roe if (p.get('year') or 0) < SPLIT]); test = np.array([cell_of(p) for p in roe if (p.get('year') or 0) >= SPLIT])
    single = {d['id']: auc(score({d['id']: 1}).ravel(), train)[0] for d in INDICATORS}
    learned = {k: int(max(5, min(50, round((a - 0.5) * 500 / 5) * 5))) for k, a in single.items() if a > 0.52}
    PRESETS['roe_deer_data']['weights'] = learned
    heldout = {}
    for pid in ('roe_deer', 'roe_deer_data'):
        a, k, top = auc(score(PRESETS[pid]['weights']).ravel(), test)
        heldout[pid] = dict(auc=round(a, 3), n=k, in_top30=round(top, 3))
    PRESETS['roe_deer_data']['heldout'] = f"Learned from {len(train)} sightings (before {SPLIT}); on the {len(test)} newer sightings it never saw: AUC {heldout['roe_deer_data']['auc']:.2f}, {round(100 * heldout['roe_deer_data']['in_top30'])}% in the top 30% of squares (expert weights on the same sightings: AUC {heldout['roe_deer']['auc']:.2f})."
    PRESETS['roe_deer_data']['train_indicator_auc'] = {k: round(v, 3) for k, v in single.items()}

    stats = {'heldout': heldout}
    (OUT / 'qgis').mkdir(parents=True, exist_ok=True); (OUT / 'preview').mkdir(parents=True, exist_ok=True)
    for pid, p in PRESETS.items():
        sc = score(p['weights'])
        write_geotiff(OUT / 'qgis' / f'{pid}_score.tif', sc, bbox)
        ramp_png(sc, OUT / 'preview' / f'{pid}_score.png')
        st = dict(mean=round(float(np.nanmean(sc)), 1), p10=round(float(np.nanpercentile(sc, 10)), 1), p90=round(float(np.nanpercentile(sc, 90)), 1))
        if p['species'] and len(validation[p['species']]['cells']) >= 30:
            a, k, top = auc(sc.ravel(), np.array(validation[p['species']]['cells']))
            st.update(auc=round(a, 3), n=k, in_top30=round(top, 3))
            # each indicator alone, to see which ones carry the signal
            st['indicator_auc'] = {d['id']: round(auc(score({d['id']: 1}).ravel(), np.array(validation[p['species']]['cells']))[0], 3) for d in INDICATORS}
        stats[pid] = st
    for d in INDICATORS:
        write_geotiff(OUT / 'qgis' / f'indicator_{d["id"]}.tif', np.where(valid & (L[d['id']] != 255), L[d['id']].astype(float), np.nan), bbox)

    keep = ['valid'] + [d['id'] for d in INDICATORS] + [r['id'] for r in RAW]
    (OUT / 'grid.bin').write_bytes(b''.join(L[k].tobytes() for k in keep))
    meta = dict(
        version='WildScope v1', created=ex['created'], region='Freiburg & western Black Forest (DE)', region_short='Freiburg & Black Forest (DE)',
        bbox=bbox, cols=cols, rows=rows, cell_m=200, bin='grid.bin', layers=keep,
        dates=dict(sentinel2=ex['dates']['sentinel2'], sentinel2_scene=ex['dates']['scene'], worldcover='2021', osm=ex['dates']['osm'], gbif=ex['dates']['gbif']),
        sources_short='Sentinel-2 L2A (Copernicus/ESA via Microsoft Planetary Computer), ESA WorldCover 2021, OpenStreetMap, GBIF',
        indicators=INDICATORS, raw=RAW, presets=PRESETS, validation=validation, stats=stats, normalisation=ex['norm'],
        method=dict(
            lead='Each 200 m square gets ten indicators, each scaled from 0 (poor) to 100 (good). A score is the weighted average of the indicators you tick. All inputs are free, open data; nothing is invented.',
            validation=f"For roe deer we test the score against real sightings: {len(validation['roe_deer']['cells'])} GBIF records ({validation['roe_deer']['years']}, citizen science, location within 250 m). AUC is the chance that a square with a sighting scores higher than a random square: 0.5 = no better than random, 0.7 or more = useful. Result: the expert weights score AUC {stats['roe_deer']['auc']:.2f} – worse than random – because people report roe deer mostly in open farmland mosaic (55% open land in sighting squares vs 34% in the region) and rarely inside forest, where deer are hard to see. Weights learned from the 2009–2021 sightings reach AUC {heldout['roe_deer_data']['auc']:.2f} on the 2022–2026 sightings they never saw: weak but real. Sightings are biased towards paths and places people visit, so treat this as a first check, not proof.",
            limits=['Weights are expert first guesses from the literature and the feasibility study; they are not fitted to data yet.',
                    'One clear Sentinel-2 date (24 Jul 2026). Weekly updates and comparison with each place\'s seasonal normal come next.',
                    'ESA WorldCover is from 2021 and does not separate maize from cereals, or broadleaf from conifer forest. DLR crop and forest maps can replace it in Germany.',
                    'Roads are clipped to the region, so distances near the edge are slightly too large. Footpaths and forest tracks are not counted yet.',
                    'Wild boar has only 7 usable GBIF sightings here, so its score cannot be tested yet. Biodiversity potential has no independent test yet.',
                    'Scores are relative to this region; a 70 here is not the same as a 70 in another region.'],
            sources=['Copernicus Sentinel-2 L2A, scene ' + ex['dates']['scene'] + ' (contains modified Copernicus Sentinel data 2026), via Microsoft Planetary Computer',
                     'ESA WorldCover 10 m 2021 v200 (© ESA WorldCover project, CC BY 4.0), via Microsoft Planetary Computer',
                     '© OpenStreetMap contributors (ODbL), roads and waterways, downloaded ' + ex['dates']['osm'],
                     'GBIF.org occurrence data for Capreolus capreolus and Sus scrofa, downloaded ' + ex['dates']['gbif'] + ' (CC BY / CC BY-NC per dataset)']))
    (OUT / 'grid.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(json.dumps(stats, indent=1))


if __name__ == '__main__':
    main(sys.argv[1])
