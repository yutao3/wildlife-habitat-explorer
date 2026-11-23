"""sources.py — where every input comes from. All free services, no API key.

  Sentinel-2 L2A  bands B04, B08 (10 m), B11, SCL (20 m)   Microsoft Planetary Computer STAC + cloud-optimised GeoTIFFs
  ESA WorldCover 2021 (10 m land cover)                    Microsoft Planetary Computer
  Roads, rivers, lakes                                     OpenStreetMap via the Overpass API (cached on disk for 30 days)
  Sightings (deer, wild boar, other mammals)               GBIF occurrence API, records from 2017 on

Only the needed window is read from each image: cloud-optimised GeoTIFFs let us read part of a file over HTTP.
"""
import gzip, json, math, time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests
import rasterio
from rasterio.windows import Window, from_bounds
from rasterio.warp import reproject, transform_bounds, Resampling
from rasterio.features import rasterize
from pyproj import Transformer
from scipy.ndimage import binary_dilation

STAC_URL = 'https://planetarycomputer.microsoft.com/api/stac/v1'
OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
            'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']
GBIF = 'https://api.gbif.org/v1/occurrence/search'
GBIF_KEYS = dict(deer=5298, boar=7705930, mammals=359)
SINCE_YEAR = 2017
GDAL_ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_MAX_RETRY='4', GDAL_HTTP_RETRY_DELAY='2',
                CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif,.TIF,.tiff', VSI_CACHE='TRUE', GDAL_HTTP_MULTIRANGE='YES')
HEADERS = {'User-Agent': 'WildScope-pipeline/2.0 (SAIIL, Surrey AI Imaging)'}


def catalog():
    import planetary_computer, pystac_client
    return pystac_client.Client.open(STAC_URL, modifier=planetary_computer.sign_inplace)


# ---------------------------------------------------------------- Sentinel-2 scene choice
def season_windows(lat, today=None):
    """Growing-season date ranges to try for a 'baseline' map, newest first."""
    today = today or date.today(); y, m = today.year, today.month
    if abs(lat) < 23.5:
        return [(today - timedelta(days=365), today), (today - timedelta(days=730), today - timedelta(days=365))]
    if lat >= 0:
        years = [y, y - 1] if m >= 9 else [y - 1, y - 2]
        return [(date(yr, 6, 1), date(yr, 9, 15)) for yr in years]
    years = [y, y - 1] if m >= 4 else [y - 1, y - 2]
    return [(date(yr - 1, 12, 1), date(yr, 3, 15)) for yr in years]


def find_tile(cat, lat, lon):
    """MGRS tile whose centre is closest to the point (tiles overlap by about 10 km)."""
    items = list(cat.search(collections=['sentinel-2-l2a'], intersects=dict(type='Point', coordinates=[lon, lat]),
                            datetime=f'{date.today() - timedelta(days=60)}/{date.today()}', max_items=40).items())
    if not items:
        raise RuntimeError('no Sentinel-2 scene found at this point in the last 60 days')
    best = min(items, key=lambda it: math.hypot((it.bbox[0] + it.bbox[2]) / 2 - lon, (it.bbox[1] + it.bbox[3]) / 2 - lat))
    return best.properties['s2:mgrs_tile']


def any_item(cat, tile):
    """Any recent scene of the tile: all scenes of one tile share the same 10 m grid."""
    for days in (60, 400):
        it = next(cat.search(collections=['sentinel-2-l2a'], datetime=f'{date.today() - timedelta(days=days)}/{date.today()}',
                             query={'s2:mgrs_tile': {'eq': tile}}, max_items=1).items(), None)
        if it:
            return it
    raise RuntimeError(f'tile {tile} not found')


def _covers(it, lb):
    b = it.bbox
    return b[0] <= lb[0] and b[1] <= lb[1] and b[2] >= lb[2] and b[3] >= lb[3]


def pick_scene(cat, tile, mode, lat, max_cloud=None, log=print, cover=None):
    """weekly: the newest scene of this tile in the last 7 days (14 if none), any cloud below 80%.
       baseline: the clearest growing-season scene (below 15% cloud, else 40%)."""
    q = {'s2:mgrs_tile': {'eq': tile}}
    if mode == 'weekly':
        for days in (7, 14):
            end = datetime.now(timezone.utc); start = end - timedelta(days=days)
            items = list(cat.search(collections=['sentinel-2-l2a'], datetime=f'{start:%Y-%m-%d}/{end:%Y-%m-%d}',
                                    query={**q, 'eo:cloud_cover': {'lt': max_cloud or 80}}).items())
            full = [i for i in items if cover is None or _covers(i, cover)]
            if full or items:
                it = max(full or items, key=lambda i: i.datetime)
                log(f'  newest scene in the last {days} days: {it.id} ({it.properties["eo:cloud_cover"]:.1f}% cloud)')
                return it
        raise RuntimeError(f'no Sentinel-2 scene of tile {tile} with less than {max_cloud or 80}% cloud in the last 14 days')
    partial = None
    for cloud in ([max_cloud] if max_cloud else [15, 40]):
        for a, b in season_windows(lat):
            items = list(cat.search(collections=['sentinel-2-l2a'], datetime=f'{a}/{b}', query={**q, 'eo:cloud_cover': {'lt': cloud}}).items())
            full = [i for i in items if cover is None or _covers(i, cover)]   # a satellite pass may cover only part of a tile
            if full:
                it = min(full, key=lambda i: i.properties['eo:cloud_cover'])
                log(f'  clearest scene {a}..{b}: {it.id} ({it.properties["eo:cloud_cover"]:.2f}% cloud)')
                return it
            day = _best_day(items, cover)
            if day:                                # two passes on one date cover the window together
                it = min(day, key=lambda i: i.properties['eo:cloud_cover'])
                log(f'  clearest date {a}..{b}: {it.datetime.date()} (no single pass covers the window)')
                return it
            if items and partial is None:
                partial = min(items, key=lambda i: i.properties['eo:cloud_cover'])
    if partial is not None:
        log(f'  no clear scene covers the whole window; using {partial.id}, part of the window will be empty')
        return partial
    raise RuntimeError(f'no growing-season scene of tile {tile} below {max_cloud or 40}% cloud')


def same_day(cat, tile, item, cover, log=print):
    """A tile is often split between two satellite orbits. If the chosen scene does not cover the window, add the
    other scenes of the SAME tile taken the SAME day (minutes apart): still one date, so this is not gap-filling."""
    if cover is None or _covers(item, cover):
        return [item]
    day = item.datetime.date()
    sib = [i for i in cat.search(collections=['sentinel-2-l2a'], datetime=f'{day}/{day}',
                                 query={'s2:mgrs_tile': {'eq': tile}}).items() if i.id != item.id]
    if sib:
        log(f'  combining {1 + len(sib)} scenes of {day} (two satellite passes over the tile, same date): '
            + ', '.join(i.id for i in [item] + sib))
    return [item] + sib


def _best_day(items, cover):
    """Among partial scenes, the date whose scenes together cover the window, lowest cloud first."""
    by = {}
    for i in items:
        by.setdefault(i.datetime.date(), []).append(i)
    ok = []
    for d, its in by.items():
        b = (min(i.bbox[0] for i in its), min(i.bbox[1] for i in its), max(i.bbox[2] for i in its), max(i.bbox[3] for i in its))
        if cover is None or (b[0] <= cover[0] and b[1] <= cover[1] and b[2] >= cover[2] and b[3] >= cover[3]):
            ok.append((max(i.properties['eo:cloud_cover'] for i in its), d, its))
    if not ok:
        return None
    return min(ok, key=lambda t: (t[0], -t[1].toordinal()))[2]


# ---------------------------------------------------------------- window on the tile grid
class Grid:
    """The part of the tile we process: a window on the 10 m grid, a whole number of squares, aligned to the 20 m bands."""
    def __init__(self, crs, transform, row0, col0, h, w):
        self.crs, self.row0, self.col0, self.h, self.w = crs, row0, col0, h, w
        self.tile_transform = transform
        self.transform = transform * transform.translation(col0, row0)

    @property
    def bounds(self):   # in the tile's UTM metres
        x0, y1 = self.transform * (0, 0); x1, y0 = self.transform * (self.w, self.h)
        return x0, y0, x1, y1

    def lonlat_bounds(self):
        return transform_bounds(self.crs, 'EPSG:4326', *self.bounds, densify_pts=21)


def make_grid(item, extent, center=None, cell_m=50):
    """extent: full (109.8 km), half (54.9 km), quarter (27.4 km), or a number of km; centred on the tile or on (lat, lon)."""
    with rasterio.Env(**GDAL_ENV), rasterio.open(item.assets['B04'].href) as ds:
        crs, tr, H, W = ds.crs, ds.transform, ds.height, ds.width
    px = tr.a
    size_px = {'full': W, 'half': W // 2, 'quarter': W // 4}.get(extent) or int(float(extent) * 1000 / px)
    unit = int(round(cell_m / px)) * 2          # whole squares, and even so the 20 m bands line up
    size_px = max(unit, min(W, H, size_px) // unit * unit)
    if center:
        x, y = Transformer.from_crs('EPSG:4326', crs, always_xy=True).transform(center[1], center[0])
        col_c, row_c = ~tr * (x, y)
    else:
        col_c, row_c = W / 2, H / 2
    col0 = int(np.clip(round(col_c - size_px / 2), 0, W - size_px)) // 2 * 2
    row0 = int(np.clip(round(row_c - size_px / 2), 0, H - size_px)) // 2 * 2
    return Grid(crs, tr, row0, col0, size_px, size_px)


# ---------------------------------------------------------------- reading Sentinel-2 and WorldCover
def read_s2(items, g, log=print):
    """B04, B08 at 10 m and B11, SCL at 20 m (repeated to 10 m) for the window. Returns NDVI, NDMI, SCL.
    items: one scene, or several scenes of the same date (see same_day); a pixel is taken from the first scene that
    has it clear (SCL 4, 5, 6), otherwise from the first scene that has any data."""
    if not isinstance(items, (list, tuple)):
        items = [items]
    w10 = Window(g.col0, g.row0, g.w, g.h); w20 = Window(g.col0 // 2, g.row0 // 2, g.w // 2, g.h // 2)
    merged = None; bases = []
    with rasterio.Env(**GDAL_ENV):
        for item in items:
            base = float(item.properties.get('s2:processing_baseline', '0') or 0); bases.append(base)
            off = 1000.0 if base >= 4 else 0.0       # since baseline 04.00 (2022) ESA adds 1000 to every stored value
            out = {}
            for band, win, fac in (('B04', w10, 1), ('B08', w10, 1), ('B11', w20, 2), ('SCL', w20, 2)):
                t = time.time()
                with rasterio.open(item.assets[band].href) as ds:
                    a = ds.read(1, window=win)
                if fac > 1:
                    a = a.repeat(fac, axis=0).repeat(fac, axis=1)
                out[band] = a if band == 'SCL' else np.where(a == 0, np.nan, a.astype(np.float32) - off).astype(np.float32)
                log(f'  read {band}{" of " + item.id[:24] if len(items) > 1 else ""}: {a.shape[1]} x {a.shape[0]} px in {time.time() - t:.0f} s')
            if merged is None:
                merged = out
            else:
                clear_old = np.isin(merged['SCL'], (4, 5, 6)); clear_new = np.isin(out['SCL'], (4, 5, 6))
                take = (merged['SCL'] == 0) & (out['SCL'] > 0) | (~clear_old & clear_new)
                for k in merged:
                    merged[k][take] = out[k][take]
                log(f'  took {take.mean() * 100:.1f}% of the window from {item.id}')
            del out
    b4, b8, b11 = merged['B04'], merged['B08'], merged['B11']
    with np.errstate(divide='ignore', invalid='ignore'):
        ndvi = ((b8 - b4) / (b8 + b4)).astype(np.float32)
        ndmi = ((b8 - b11) / (b8 + b11)).astype(np.float32)
    ndvi[~np.isfinite(ndvi)] = np.nan; ndmi[~np.isfinite(ndmi)] = np.nan
    has = (merged['SCL'] > 0).mean()
    return ndvi, ndmi, merged['SCL'].astype(np.uint8), dict(offset=1000.0 if bases[0] >= 4 else 0.0, processing_baseline=bases[0],
                                                            scenes=len(items), window_with_data=round(float(has), 3))


def read_worldcover(cat, g, log=print):
    """ESA WorldCover 2021 reprojected (nearest neighbour) onto the 10 m tile grid."""
    lb = g.lonlat_bounds()
    items = [it for it in cat.search(collections=['esa-worldcover'], bbox=lb).items() if '2021' in it.id]
    if not items:
        raise RuntimeError('no ESA WorldCover 2021 tile found for this area')
    dst = np.zeros((g.h, g.w), np.uint8)
    with rasterio.Env(**GDAL_ENV):
        for it in items:
            with rasterio.open(it.assets['map'].href) as src:
                m = 0.002   # small margin in degrees
                win = from_bounds(lb[0] - m, lb[1] - m, lb[2] + m, lb[3] + m, src.transform).round_offsets().round_lengths()
                win = win.intersection(Window(0, 0, src.width, src.height))
                a = src.read(1, window=win)
                tmp = np.zeros_like(dst)
                reproject(a, tmp, src_transform=src.window_transform(win), src_crs=src.crs, dst_transform=g.transform, dst_crs=g.crs,
                          resampling=Resampling.nearest, src_nodata=0, dst_nodata=0)
                dst = np.where(dst == 0, tmp, dst)
            log(f'  WorldCover {it.id}')
    return dst, [it.id for it in items]


# ---------------------------------------------------------------- OpenStreetMap
OSM_PIECE_DEG = 0.1          # fixed 0.1° pieces: any run over the same place reuses the cached pieces
ROADS_RE = ('^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|'
            'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$')


def _overpass(query, timeout=75, rounds=2):
    """One Overpass request, tried on every mirror; busy servers (429/502/503/504) are retried after a pause."""
    last = None
    for attempt in range(rounds):
        for url in OVERPASS:
            try:
                r = requests.post(url, data={'data': query}, timeout=timeout, headers=HEADERS)
                if r.ok:
                    return r.json()['elements']
                last = f'HTTP {r.status_code} from {url.split("/")[2]}'
            except Exception as e:   # busy or unreachable: try the next mirror
                last = f'{type(e).__name__} from {url.split("/")[2]}'
        if attempt < rounds - 1:
            time.sleep(15 * (attempt + 1))
    raise RuntimeError(f'OpenStreetMap servers busy ({last})')


def osm_pieces(lb, deg=OSM_PIECE_DEG):
    """The fixed lon/lat pieces that cover a box: (west, south, east, north), each deg × deg."""
    i0, i1 = math.floor(lb[0] / deg), math.ceil(lb[2] / deg)
    j0, j1 = math.floor(lb[1] / deg), math.ceil(lb[3] / deg)
    return [(round(i * deg, 4), round(j * deg, 4), round((i + 1) * deg, 4), round((j + 1) * deg, 4))
            for j in range(j0, j1) for i in range(i0, i1)]


def _osm_piece(pc):
    """Roads and water of one piece in ONE request; ids are kept so pieces can be merged without duplicates."""
    bb = f'{pc[1]},{pc[0]},{pc[3]},{pc[2]}'
    q = (f'[out:json][timeout:70];'
         f'way["highway"~"{ROADS_RE}"]({bb})->.r;'
         f'(way["waterway"~"^(river|stream|canal)$"]({bb});way["natural"="water"]({bb}););'
         f'out tags geom qt;.r out tags geom qt;')
    roads, water = {}, {}
    for el in _overpass(q):
        geom = el.get('geometry')
        if not geom:
            continue
        line = [[round(p['lon'], 6), round(p['lat'], 6)] for p in geom]
        (roads if 'highway' in el.get('tags', {}) else water)[str(el['id'])] = line
    return dict(roads=roads, water=water)


def read_osm(g, cache_dir, max_age_days=30, log=print, max_fail_in_row=3, max_minutes=20):
    """Roads and water as lines/rings in lon/lat, fetched in fixed 0.1° pieces, each cached on disk for 30 days.
    A piece that cannot be fetched is listed in 'missing' (its squares get no road or water value) and the run goes on.
    Running the same command again fetches only the missing pieces."""
    lb = g.lonlat_bounds()
    pdir = Path(cache_dir) / 'osm_pieces'; pdir.mkdir(parents=True, exist_ok=True)
    pieces = osm_pieces(lb)
    roads, water, missing = {}, {}, []
    n_cache = fails_in_row = 0; t0 = time.time()
    for k, pc in enumerate(pieces, 1):
        path = pdir / f'osm_{pc[0]:.1f}_{pc[1]:.1f}.json.gz'
        data = None
        if path.exists() and time.time() - path.stat().st_mtime < max_age_days * 86400:
            data = json.loads(gzip.decompress(path.read_bytes())); n_cache += 1
        elif fails_in_row >= max_fail_in_row or time.time() - t0 > max_minutes * 60:
            missing.append(pc); continue          # servers down or time budget used: do not wait on every remaining piece
        else:
            try:
                data = _osm_piece(pc); fails_in_row = 0
                path.write_bytes(gzip.compress(json.dumps(data).encode()))
                time.sleep(1)
            except Exception as e:
                fails_in_row += 1; missing.append(pc)
                log(f'  OpenStreetMap piece {k}/{len(pieces)} failed ({e})')
                if fails_in_row == max_fail_in_row:
                    log(f'  {max_fail_in_row} pieces failed in a row: skipping the rest; run again later to fill them in')
                continue
            if time.time() - t0 > max_minutes * 60 and k < len(pieces):
                log(f'  OpenStreetMap time budget of {max_minutes} min used: skipping the rest; run again later to fill them in')
        roads.update(data['roads']); water.update(data['water'])
        if k % 10 == 0 or k == len(pieces):
            log(f'  OpenStreetMap {k}/{len(pieces)} pieces ({n_cache} from cache, {len(missing)} missing): '
                f'{len(roads)} roads, {len(water)} water, {time.time() - t0:.0f} s')
    if missing and len(missing) == len(pieces):
        raise RuntimeError('no OpenStreetMap piece could be fetched')
    return dict(roads=list(roads.values()), water=list(water.values()), missing=missing, pieces=len(pieces),
                fetched=datetime.now(timezone.utc).isoformat())


def osm_missing_mask(osm, g):
    """True on the 10 m grid where an OpenStreetMap piece is missing."""
    if not osm.get('missing'):
        return None
    tf = Transformer.from_crs('EPSG:4326', g.crs, always_xy=True)
    shapes = []
    for w, s, e, n in osm['missing']:
        lon = [w + (e - w) * t / 8 for t in range(9)] + [e] * 9 + [e - (e - w) * t / 8 for t in range(9)] + [w] * 9
        lat = [s] * 9 + [s + (n - s) * t / 8 for t in range(9)] + [n] * 9 + [n - (n - s) * t / 8 for t in range(9)]
        xs, ys = tf.transform(lon, lat)
        shapes.append((dict(type='Polygon', coordinates=[list(zip(xs, ys)) + [(xs[0], ys[0])]]), 1))
    return rasterize(shapes, out_shape=(g.h, g.w), transform=g.transform, all_touched=True, dtype=np.uint8).astype(bool)


def rasterize_osm(osm, g, px_m=10):
    """Roads and water drawn 30 m wide on the 10 m grid (like the website); lakes filled."""
    tf = Transformer.from_crs('EPSG:4326', g.crs, always_xy=True)
    def lines(ls, closed_fill=False):
        for l in ls:
            if len(l) < 2:
                continue
            xs, ys = tf.transform([p[0] for p in l], [p[1] for p in l])
            coords = list(zip(xs, ys))
            yield dict(type='LineString', coordinates=coords), 1
            if closed_fill and len(l) > 3 and l[0] == l[-1]:
                yield dict(type='Polygon', coordinates=[coords]), 1
    shape = (g.h, g.w)
    out = []
    for ls, fill in ((osm['roads'], False), (osm['water'], True)):
        shapes = list(lines(ls, fill))
        m = rasterize(shapes, out_shape=shape, transform=g.transform, all_touched=True, dtype=np.uint8).astype(bool) if shapes else np.zeros(shape, bool)
        it = int((30 / px_m - 1) // 2)        # 30 m wide: 3 pixels at 10 m
        out.append(binary_dilation(m, iterations=it) if it > 0 else m)
    return out[0], out[1]


# ---------------------------------------------------------------- GBIF sightings
def _gbif_page(params, timeout=40):
    for attempt in range(4):
        try:
            r = requests.get(GBIF, params=params, timeout=timeout, headers=HEADERS)
            if r.ok:
                return r.json()
        except Exception:
            pass
        time.sleep(3 * (attempt + 1))
    return None


def read_sightings(g, max_pages=8, log=print):
    """Deer, wild boar and other mammals from 2017 on, in about 15 km pieces (GBIF is slow on large boxes and deep pages)."""
    lb = g.lonlat_bounds(); n = max(1, math.ceil((g.w * g.tile_transform.a) / 15000))
    out = {k: [] for k in GBIF_KEYS}
    base = dict(hasCoordinate='true', hasGeospatialIssue='false', coordinateUncertaintyInMeters='0,250',
                basisOfRecord='HUMAN_OBSERVATION', limit=300, year=f'{SINCE_YEAR},{date.today().year}')
    for i in range(n):
        for j in range(n):
            box = dict(decimalLongitude=f'{lb[0] + (lb[2] - lb[0]) * i / n},{lb[0] + (lb[2] - lb[0]) * (i + 1) / n}',
                       decimalLatitude=f'{lb[1] + (lb[3] - lb[1]) * j / n},{lb[1] + (lb[3] - lb[1]) * (j + 1) / n}')
            for k, key in GBIF_KEYS.items():
                kp = {'taxonKey': key} if k != 'mammals' else {'classKey': key}
                for p in range(max_pages):
                    js = _gbif_page({**base, **box, **kp, 'offset': p * 300})
                    if not js:
                        break
                    out[k] += [(r['decimalLongitude'], r['decimalLatitude'], r.get('year'), r.get('speciesKey'), r.get('familyKey'), r.get('species'))
                               for r in js.get('results', [])]
                    if js.get('endOfRecords'):
                        break
    out['others'] = [r for r in out['mammals'] if r[4] != GBIF_KEYS['deer'] and r[3] != GBIF_KEYS['boar']]
    log(f'  GBIF since {SINCE_YEAR}: {len(out["deer"])} deer, {len(out["boar"])} wild boar, {len(out["others"])} other mammals')
    return out
