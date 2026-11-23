"""outputs.py — what a run writes: 32-bit GeoTIFFs for QGIS, a quick-look picture, a report, and a website-ready grid."""
import json, math
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
import rasterio
from rasterio.transform import Affine
from rasterio.warp import reproject, Resampling

from .indicators import LAYER_ORDER, INDICATORS

HABITAT_RAMP = [(0, (44, 79, 179)), (25, (90, 160, 216)), (45, (201, 230, 239)), (55, (255, 242, 176)), (75, (245, 154, 82)), (100, (200, 21, 27))]
NATURE_RAMP = [(0, (140, 81, 10)), (25, (216, 179, 101)), (48, (246, 232, 195)), (60, (199, 234, 229)), (80, (53, 151, 143)), (100, (1, 70, 63))]


def write_tif(path, arr, g, cell_m, description):
    """Float32 GeoTIFF, NaN = no data, in the tile's UTM projection."""
    path.parent.mkdir(parents=True, exist_ok=True)
    x0, y0, x1, y1 = g.bounds
    tr = Affine(cell_m, 0, x0, 0, -cell_m, y1)
    a = arr.astype(np.float32)
    prof = dict(driver='GTiff', height=a.shape[0], width=a.shape[1], count=1, dtype='float32', crs=g.crs, transform=tr, nodata=np.nan,
                compress='deflate', predictor=3, tiled=True, blockxsize=256, blockysize=256)
    with rasterio.open(path, 'w', **prof) as ds:
        ds.write(a, 1); ds.set_band_description(1, description)
        ds.update_tags(software='WildScope pipeline 2.0 (SAIIL)')


def layer_float(L, k):
    return np.where(L[k] == 255, np.nan, L[k].astype(np.float32))


def rank_rgba(s, ramp):
    ok = ~np.isnan(s); r = np.full(s.shape, np.nan)
    v = s[ok]; r[ok] = 100 * np.argsort(np.argsort(v)) / max(1, len(v) - 1)
    xs = [p for p, _ in ramp]; out = np.zeros(s.shape + (4,), np.uint8)
    for c in range(3):
        out[..., c] = np.interp(np.nan_to_num(r), xs, [col[c] for _, col in ramp])
    out[..., 3] = np.where(ok, 255, 0)
    return out


def quicklook(path, scores, title):
    from PIL import Image, ImageDraw
    panels = [('Roe deer habitat', scores['roe_deer'], HABITAT_RAMP), ('Biodiversity potential', scores['biodiversity'], NATURE_RAMP)]
    h, w = scores['roe_deer'].shape; k = max(1, int(math.ceil(max(h, w) / 700)))
    tiles = []
    for name, s, ramp in panels:
        im = Image.fromarray(rank_rgba(s[::k, ::k], ramp), 'RGBA')
        bg = Image.new('RGB', im.size, (20, 28, 40)); bg.paste(im, mask=im.split()[3]); tiles.append((name, bg))
    W = sum(t.width for _, t in tiles) + 30; H = tiles[0][1].height + 60
    canvas = Image.new('RGB', (W, H), (255, 255, 255)); d = ImageDraw.Draw(canvas)
    d.text((10, 8), title, fill=(15, 61, 46))
    x = 10
    for name, t in tiles:
        canvas.paste(t, (x, 40)); d.text((x, 26), name + ' (colour = rank in this area)', fill=(51, 71, 61)); x += t.width + 10
    canvas.save(path)


def web_grid(out_dir, L, g, cell_m, web_cell_m, pilot_meta, run_meta, sightings_cells):
    """Reproject the uint8 layers to a lat/lon grid in the website's format (grid.json + grid.bin).
    Open it with  https://wildscope.saiil.co.uk/?grid=<folder>  once the folder is published with the site."""
    from .scoring import presets
    w, s, e, n = g.lonlat_bounds(); lat = (s + n) / 2
    dy = web_cell_m / 110540.0; dx = web_cell_m / (111320.0 * math.cos(math.radians(lat)))
    cols, rows = int(math.ceil((e - w) / dx)), int(math.ceil((n - s) / dy))
    dst_tr = Affine(dx, 0, w, 0, -dy, n)
    x0, y0, x1, y1 = g.bounds; src_tr = Affine(cell_m, 0, x0, 0, -cell_m, y1)
    stack = []
    for k in LAYER_ORDER:
        dst = np.full((rows, cols), 0 if k == 'valid' else 255, np.uint8)
        reproject(L[k], dst, src_transform=src_tr, src_crs=g.crs, dst_transform=dst_tr, dst_crs='EPSG:4326', resampling=Resampling.nearest,
                  src_nodata=None if k == 'valid' else 255, dst_nodata=None if k == 'valid' else 255)
        stack.append(dst)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'grid.bin').write_bytes(b''.join(a.tobytes() for a in stack))
    meta = json.loads(json.dumps(pilot_meta)) if pilot_meta else {}
    bbox = [round(w, 6), round(n - rows * dy, 6), round(w + cols * dx, 6), round(n, 6)]
    def cells(points):
        out = []
        for p in points:
            c = int((p[0] - bbox[0]) / dx); r = int((bbox[3] - p[1]) / dy)
            if 0 <= c < cols and 0 <= r < rows:
                out.append(r * cols + c)
        return out
    yrs = lambda pts: (lambda y: f'{min(y)}–{max(y)}' if y else 'n/a')([p[2] for p in pts if p[2]])
    validation = {}
    if sightings_cells:
        for pid, sp, what in (('roe_deer', 'deer', 'deer'), ('wild_boar', 'boar', 'wild boar')):
            validation[pid] = dict(cells=cells(sightings_cells.get(sp, [])), points=[[p[0], p[1]] for p in sightings_cells.get(sp, [])],
                                   background_cells=cells(sightings_cells.get('others', [])), years=yrs(sightings_cells.get(sp, [])),
                                   what=what, independent=True)
    meta.update(version=f"WildScope pipeline 2.0 · {run_meta['machine']}", region=run_meta['label'], region_short=run_meta['short'],
                bbox=bbox, cols=cols, rows=rows, cell_m=web_cell_m, bin='grid.bin', layers=LAYER_ORDER, validation=validation, evidence={},
                dates={**(meta.get('dates') or {}), 'sentinel2': run_meta['scene_date'], 'sentinel2_scene': run_meta['scene'], 'osm': run_meta['run_date'][:10]},
                normalisation=run_meta['norm'])
    for pid, p in (meta.get('presets') or {}).items():
        if pid in ('roe_deer', 'wild_boar'):
            n_s = len(validation.get(pid, {}).get('cells', []))
            p['status'] = ('Pilot weights' if pid == 'roe_deer' else 'Literature weights') + (' · tested here' if n_s >= 30 else ' · untested here')
    (out_dir / 'grid.json').write_text(json.dumps(meta, ensure_ascii=False))
    return dict(cols=cols, rows=rows, mb=round(sum(a.nbytes for a in stack) / 1e6, 1))


def report_md(rep):
    ev = rep.get('evidence', {})
    lines = [f"# WildScope pipeline run: {rep['label']}", '',
             f"- Scene: {rep['scene']['id']} ({rep['scene']['date']}, {rep['scene']['cloud']:.1f}% cloud, processing baseline {rep['scene']['processing_baseline']})",
             f"- Area: {rep['area_km']} km × {rep['area_km']} km, {rep['cell_m']} m squares ({rep['stats']['squares']:,} squares), CRS {rep['crs']}",
             f"- Clear vegetation pixels (cloud mask SCL 4/5/6): {100 * rep['stats']['clear_pixel_share']:.1f}%. No gap-filling: cloudy pixels stay empty.",
             f"- OpenStreetMap: {rep['osm']['roads']:,} roads, {rep['osm']['water']:,} water features",
             f"- GBIF since 2017: {rep['gbif']['deer']} deer, {rep['gbif']['boar']} wild boar, {rep['gbif']['others']} other mammals", '',
             '## Evidence (AUC = area under the ROC curve; 0.5 = chance, 1 = perfect)', '']
    for pid, r in ev.items():
        if 'auc_vs_other_mammals' in r:
            lines.append(f"- {pid}: AUC {r['auc_vs_other_mammals']:.2f} against other mammals ({r['sightings']} sightings, {r['background']} background); {r['auc_vs_all_squares']:.2f} against all squares")
        else:
            lines.append(f"- {pid}: {r['note']} ({r['sightings']} sightings)")
    lines += ['', '## Time per step', ''] + [f"- {k}: {v:.0f} s" for k, v in rep['timings'].items()]
    lines += ['', f"Total: {sum(rep['timings'].values()):.0f} s · outputs in {rep['out_dir']}"]
    return '\n'.join(lines) + '\n'
