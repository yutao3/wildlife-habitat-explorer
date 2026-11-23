"""End-to-end run with no internet: every data source is replaced by a synthetic landscape.
Checks that indicators, scores, evidence, GeoTIFFs, quick-look, report and website grid are all produced.
Run from the pipeline folder:  python tests/test_offline.py"""
import json, sys, tempfile, types
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from rasterio.transform import Affine
from rasterio.crs import CRS
import run as runner
from wildscope import sources
from tests.synthetic import landscape

H = W = 1000                                   # 10 km at 10 m
wc, ndvi, ndmi, scl = landscape(H, W, seed=5)
crs = CRS.from_epsg(32632); tr = Affine(10, 0, 410000, 0, -10, 5320000)   # near Freiburg
item = types.SimpleNamespace(id='S2X_TEST_T32UMU', datetime=datetime(2026, 7, 24, tzinfo=timezone.utc),
                             properties={'eo:cloud_cover': 3.2, 's2:processing_baseline': '05.11'})
rng = np.random.default_rng(1)
def pts(n):
    x0, y0, x1, y1 = 410000, 5310000, 420000, 5320000
    from pyproj import Transformer
    t = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
    xs = rng.uniform(x0, x1, n); ys = rng.uniform(y0, y1, n); lon, lat = t.transform(xs, ys)
    return [(a, b, 2020 + i % 6, 1, 0, 'Capreolus capreolus') for i, (a, b) in enumerate(zip(lon, lat))]
sources.catalog = lambda: None
sources.find_tile = lambda cat, lat, lon: '32UMU'
sources.pick_scene = lambda *a, **k: item
sources.any_item = lambda cat, tile: item
sources.same_day = lambda cat, tile, it, cover, log=print: [it]
sources.make_grid = lambda it, extent, center, cell: sources.Grid(crs, tr, 0, 0, H, W)
sources.read_s2 = lambda its, g, log=print: (ndvi, ndmi, scl, dict(offset=1000.0, processing_baseline=5.11))
sources.read_worldcover = lambda cat, g, log=print: (wc, ['ESA_WorldCover_10m_2021_v200_TEST'])
sources.read_osm = lambda g, cache, log=print, max_minutes=20: dict(roads=[[[7.85, 48.0], [7.95, 48.05]]], water=[], pieces=4,
                                                                    missing=[(7.8, 47.9, 7.9, 48.0)])
sources.rasterize_osm = lambda osm, g: (np.eye(H, W, dtype=bool) | np.eye(H, W, 1, dtype=bool), np.zeros((H, W), bool))
sources.read_sightings = lambda g, log=print: dict(deer=pts(60), boar=pts(5), others=pts(300), mammals=[])
with tempfile.TemporaryDirectory() as td:
    args = types.SimpleNamespace(tile=None, lat=48.0, lon=7.85, extent='half', mode='baseline', cell=50, max_cloud=None, out=td, web=True, web_cell=100, osm_minutes=20)
    assert runner.run(args) == 0
    out = next(Path(td).iterdir())
    files = sorted(str(p.relative_to(out)) for p in out.rglob('*') if p.is_file())
    print('\n'.join(files))
    rep = json.loads((out / 'report.json').read_text())
    meta = json.loads((out / 'web' / 'grid.json').read_text())
    import rasterio
    with rasterio.open(out / 'scores' / 'roe_deer.tif') as ds:
        a = ds.read(1); print('roe_deer.tif', ds.crs, ds.res, a.dtype, a.shape, round(float(np.nanmean(a)), 1))
    assert len([f for f in files if f.startswith('indicators/')]) == 16 and (out / 'quicklook.png').exists()
    assert meta['cols'] > 0 and (out / 'web' / 'grid.bin').stat().st_size == meta['cols'] * meta['rows'] * 26
    print('evidence', rep['evidence']['roe_deer'].get('auc_vs_other_mammals'), '| web grid', meta['cols'], 'x', meta['rows'], meta['bbox'])
print('PASS')
