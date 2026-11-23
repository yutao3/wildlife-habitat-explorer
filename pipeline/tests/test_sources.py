"""Offline checks of the two network-facing pieces that changed in v2.2 (no internet needed):
  1. two scenes of the same date (two satellite passes) are combined pixel by pixel, clear pixels first;
  2. OpenStreetMap pieces: a failed piece is listed as missing, the run goes on, and a re-run fetches only what is missing;
  3. OpenStreetMap from Geofabrik regional files: pieces inside the regions are filled, pieces outside are left for Overpass.
Run from the pipeline folder:  python tests/test_sources.py"""
import sys, tempfile, types
from datetime import datetime, timezone
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rasterio
from rasterio.transform import Affine
from rasterio.crs import CRS
from wildscope import sources

crs = CRS.from_epsg(32632); N = 200
tr10 = Affine(10, 0, 410000, 0, -10, 5320000); tr20 = Affine(20, 0, 410000, 0, -20, 5320000)

def tif(path, a, tr):
    with rasterio.open(path, 'w', driver='GTiff', width=a.shape[1], height=a.shape[0], count=1, dtype=a.dtype, crs=crs, transform=tr) as ds:
        ds.write(a, 1)
    return str(path)

def scene(td, name, cols, scl_value):
    """A scene with data only in the given columns (the rest is outside its satellite pass, value 0)."""
    m10 = np.zeros((N, N), bool); m10[:, cols] = True
    m20 = m10[::2, ::2]
    b4 = np.where(m10, 1000 + 300, 0).astype(np.uint16); b8 = np.where(m10, 1000 + 2700, 0).astype(np.uint16)
    b11 = np.where(m20, 1000 + 1500, 0).astype(np.uint16); scl = np.where(m20, scl_value, 0).astype(np.uint8)
    assets = {k: types.SimpleNamespace(href=tif(Path(td) / f'{name}_{k}.tif', a, tr))
              for k, a, tr in (('B04', b4, tr10), ('B08', b8, tr10), ('B11', b11, tr20), ('SCL', scl, tr20))}
    return types.SimpleNamespace(id=name, assets=assets, properties={'s2:processing_baseline': '05.12', 'eo:cloud_cover': 0.0},
                                 datetime=datetime(2026, 8, 13, tzinfo=timezone.utc))

with tempfile.TemporaryDirectory() as td:
    west = scene(td, 'PASS_R108', slice(0, 120), 4)      # covers columns 0-119
    east = scene(td, 'PASS_R065', slice(100, 200), 4)    # covers columns 100-199 (overlap 100-119)
    g = sources.Grid(crs, tr10, 0, 0, N, N)
    ndvi1, _, scl1, info1 = sources.read_s2(west, g, log=lambda *a: None)
    ndvi2, ndmi2, scl2, info2 = sources.read_s2([west, east], g, log=print)
    print('one scene :', f"{info1['window_with_data'] * 100:.0f}% of the window,", 'NDVI', round(float(np.nanmean(ndvi1)), 3))
    print('two scenes:', f"{info2['window_with_data'] * 100:.0f}% of the window,", 'NDVI', round(float(np.nanmean(ndvi2)), 3))
    assert info1['window_with_data'] == 0.6 and info2['window_with_data'] == 1.0 and info2['scenes'] == 2
    assert abs(float(np.nanmean(ndvi2)) - 0.8) < 1e-6 and np.isfinite(ndvi2).all()          # (2700-300)/(2700+300), offset removed
    # a cloudy pixel in the first pass is replaced by a clear one from the second pass of the same day
    cloudy = scene(td, 'PASS_A_CLOUDY', slice(0, 200), 9); clear = scene(td, 'PASS_B', slice(0, 200), 4)
    _, _, scl3, _ = sources.read_s2([cloudy, clear], g, log=lambda *a: None)
    assert (scl3 == 4).all(); print('cloudy pixels taken from the clear same-day pass: OK')

# ---- OpenStreetMap pieces
calls = []
def fake_piece(pc):
    calls.append(pc)
    if pc[0] == 7.8 and len([c for c in calls if c == pc]) == 1:
        raise RuntimeError('OpenStreetMap servers busy (HTTP 504)')
    return dict(roads={f'r{pc}': [[pc[0], pc[1]], [pc[2], pc[3]]], 'shared': [[0, 0], [1, 1]]}, water={})
sources._osm_piece = fake_piece
sources.time.sleep = lambda s: None
g = sources.Grid(crs, tr10, 0, 0, 1000, 1000)          # 10 km near Freiburg
with tempfile.TemporaryDirectory() as cache:
    o1 = sources.read_osm(g, cache, log=print)
    print('first run :', o1['pieces'], 'pieces,', len(o1['missing']), 'missing,', len(o1['roads']), 'roads')
    assert o1['missing'] and len(o1['missing']) < o1['pieces']
    assert len(o1['roads']) == o1['pieces'] - len(o1['missing']) + 1                  # the shared road counted once
    mask = sources.osm_missing_mask(o1, g); print('missing share of the window', round(float(mask.mean()), 2))
    assert 0 < mask.mean() < 1
    n = len(calls); o2 = sources.read_osm(g, cache, log=print)
    assert len(calls) - n == len(o1['missing']) and not o2['missing']                # only the missing pieces fetched again
    print('second run fetched only the', len(o1['missing']), 'missing pieces: OK')
    # servers down: stop after 3 failures in a row instead of waiting on every piece
    calls.clear(); sources._osm_piece = lambda pc: (calls.append(pc), (_ for _ in ()).throw(RuntimeError('HTTP 504')))[1]
    g2 = sources.Grid(crs, Affine(10, 0, 500000, 0, -10, 5320000), 0, 0, 3000, 3000)
    try:
        sources.read_osm(g2, cache, log=lambda *a: None)
    except RuntimeError as e:
        print('all servers down:', e, '| requests made', len(calls)); assert len(calls) == 3

# ---- Geofabrik regional files (synthetic .osm.pbf written with osmium)
import osmium
def pbf(path, ways):
    w = osmium.SimpleWriter(str(path)); nid = 1; ids = []
    for wid, tags, line in ways:
        refs = []
        for lon, lat in line:
            w.add_node(osmium.osm.mutable.Node(id=nid, location=(lon, lat), tags={})); refs.append(nid); nid += 1
        ids.append((wid, tags, refs))
    for wid, tags, refs in ids:
        w.add_way(osmium.osm.mutable.Way(id=wid, nodes=refs, tags=tags))
    w.close(); return str(path)
sources.time.sleep = lambda s: None
with tempfile.TemporaryDirectory() as cache:
    west = pbf(Path(cache) / 'west.osm.pbf', [(1, {'highway': 'primary'}, [(7.81, 47.95), (7.85, 47.97)]),
                                              (2, {'waterway': 'river'}, [(7.82, 47.92), (7.83, 47.98)]),
                                              (3, {'highway': 'footway'}, [(7.81, 47.95), (7.82, 47.96)]),     # not a road type we use
                                              (4, {'building': 'yes'}, [(7.81, 47.95), (7.82, 47.96)])])
    sq = lambda w, s, e, n: [[[w, s], [e, s], [e, n], [w, n], [w, s]]]
    regions = [dict(id='test/west', name='West', pbf=west, rings=sq(7.65, 47.8, 7.95, 48.2), bbox=(7.65, 47.8, 7.95, 48.2), area=0.08),
               dict(id='big', name='Big', pbf='never-downloaded', rings=sq(0, 40, 20, 60), bbox=(0, 40, 20, 60), area=400)]
    sources._download = lambda url, path, log=print: Path(url)
    g = sources.Grid(crs, tr10, 0, 0, 1000, 1000)          # lon ~7.79-7.93, lat ~47.93-48.03: six 0.1° pieces
    n = sources.osm_from_geofabrik(g, cache, log=print, regions=regions[:1])
    o = sources.read_osm(g, cache, log=print, overpass=False)
    print('Geofabrik:', n, 'pieces filled,', len(o['missing']), 'left for Overpass,', len(o['roads']), 'road,', len(o['water']), 'water')
    assert n == 4 and len(o['missing']) == 2 and len(o['roads']) == 1 and len(o['water']) == 1
    # the smallest region wins: with a huge region also listed, only pieces inside 'West' are taken from 'West'
    pts = sources._in_poly([7.75, 7.99], [48.0, 48.0], regions[0]['rings']); assert pts.tolist() == [True, False]
print('PASS')
