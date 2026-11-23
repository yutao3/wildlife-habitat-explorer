"""indicators.py — the 16 WildScope indicators per square, from 10 m pixels.

This is a line-by-line port of computeGrid() in assets/js/analyse.js (website v2.0), so the Harwell results and the
browser results mean the same thing. tests/test_parity.py checks that both give the same numbers on the same input.
Differences on purpose: distances use an exact Euclidean distance transform (the browser uses a fast approximation),
and everything is in metres in the tile's own UTM projection instead of degrees.

Inputs are 2-D arrays on one 10 m grid whose size is a whole number of squares:
  wc    ESA WorldCover class per pixel (uint8, 0 = no data)
  ndvi  NDVI per pixel (float32, NaN = no data)
  ndmi  NDMI per pixel (float32, NaN = no data)
  scl   Sentinel-2 Scene Classification per pixel (uint8)
  roads / water  boolean masks of OpenStreetMap roads and water drawn 30 m wide (roads may be None)
"""
import numpy as np
from scipy.ndimage import distance_transform_edt

LAYER_ORDER = ['valid', 'woodland', 'cover', 'open', 'forage', 'crops', 'moisture', 'mosaic', 'edge', 'edge_near', 'towns_far',
               'roads_far', 'water', 'diversity', 'natural', 'spectral', 'raw_tree', 'raw_open', 'raw_crop', 'raw_built', 'raw_ndvi',
               'raw_ndmi', 'raw_dedge', 'raw_droad_only', 'raw_dtown', 'raw_dwater']
INDICATORS = ['woodland', 'cover', 'open', 'forage', 'crops', 'moisture', 'mosaic', 'edge', 'edge_near', 'towns_far', 'roads_far',
              'water', 'distinct', 'diversity', 'natural', 'spectral']
OPEN = (20, 30, 40, 90)          # grass, shrub, crop, wetland
VEG = (10, 20, 30, 40, 90)       # vegetated classes for NDVI statistics
NATURAL = (10, 20, 30, 80, 90)   # semi-natural classes
CLASSES = (10, 20, 30, 40, 50, 60, 80, 90)
CLEAR_SCL = (4, 5, 6)            # vegetation, bare soil, water


def _isin(a, values):
    return np.isin(a, np.array(values, dtype=a.dtype))


def _cells(a, S):
    """Sum of a (H, W) pixel array inside each S × S square → (H/S, W/S)."""
    H, W = a.shape
    return a.reshape(H // S, S, W // S, S).sum(axis=(1, 3))


def _cells_min(a, S):
    H, W = a.shape
    return a.reshape(H // S, S, W // S, S).min(axis=(1, 3))


def _nb(a, r):
    """Sum over the square window of ±r squares, clipped at the borders (same as the browser's integral image)."""
    if r == 0:
        return a.astype(np.float64)
    CH, CW = a.shape
    I = np.zeros((CH + 1, CW + 1), np.float64)
    I[1:, 1:] = np.cumsum(np.cumsum(a, axis=0), axis=1)
    y = np.arange(CH); x = np.arange(CW)
    y0 = np.clip(y - r, 0, CH); y1 = np.clip(y + r + 1, 0, CH)
    x0 = np.clip(x - r, 0, CW); x1 = np.clip(x + r + 1, 0, CW)
    return I[y1][:, x1] - I[y0][:, x1] - I[y1][:, x0] + I[y0][:, x0]


def _dist(mask, px_m):
    """Distance in metres from every pixel to the nearest True pixel (5 km everywhere if there is none)."""
    if not mask.any():
        return np.full(mask.shape, 5000.0, np.float32)
    return (distance_transform_edt(~mask) * px_m).astype(np.float32)


def _clamp(v):
    """Round half up and keep 0–100, like the browser's Math.round."""
    return np.clip(np.floor(np.asarray(v, np.float64) + 0.5), 0, 100)


def _pct(a, p):
    v = np.sort(a[np.isfinite(a)].ravel())
    return float(v[int(np.floor((len(v) - 1) * p))]) if len(v) else 0.0


def compute(wc, ndvi, ndmi, scl, roads, water, cell_m=50, px_m=10, nb_radius_m=300, log=print):
    S = int(round(cell_m / px_m))
    H, W = wc.shape
    assert H % S == 0 and W % S == 0, 'grid must be a whole number of squares'
    CH, CW = H // S, W // S
    has = wc > 0
    # --- pixel masks and distances
    built = wc == 50
    wet = water | (wc == 80) | (wc == 90)
    forest = wc == 10
    isopen = _isin(wc, OPEN)
    nbr_open = np.zeros_like(forest)
    nbr_open[:, :-1] |= isopen[:, 1:]; nbr_open[:, 1:] |= isopen[:, :-1]
    nbr_open[:-1, :] |= isopen[1:, :]; nbr_open[1:, :] |= isopen[:-1, :]
    edge_mask = forest & nbr_open
    log('  distances: towns, water, forest edges' + (', roads' if roads is not None else ''))
    d_road = _dist(roads, px_m) if roads is not None else None
    d_built = _dist(built, px_m)
    d_water = _dist(wet, px_m)
    d_edge = _dist(edge_mask, px_m)
    # --- sums per square
    log('  sums per square')
    n_pix = _cells(has.astype(np.int32), S).astype(np.float64)
    cnt = {k: _cells((wc == k).astype(np.int32), S).astype(np.float64) for k in CLASSES}
    s_road = _cells(np.where(has, d_road, 0), S) if d_road is not None else None
    s_built = _cells(np.where(has, d_built, 0), S)
    big = np.float32(1e9)
    m_water = _cells_min(np.where(has, d_water, big), S)
    m_edge = _cells_min(np.where(has, d_edge, big), S)
    # forest–open boundaries counted inside each square
    xs = np.arange(W) % S; ys = np.arange(H) % S
    hp = np.zeros((H, W), bool)
    hp[:, :-1] = ((forest[:, :-1] & isopen[:, 1:]) | (isopen[:, :-1] & forest[:, 1:])) & (xs[:-1] < S - 1)[None, :]
    vp = np.zeros((H, W), bool)
    vp[:-1, :] = ((forest[:-1, :] & isopen[1:, :]) | (isopen[:-1, :] & forest[1:, :])) & (ys[:-1] < S - 1)[:, None]
    edge_p = _cells(hp.astype(np.int32) + vp.astype(np.int32), S).astype(np.float64)
    # vegetation statistics on clear pixels only (cloud mask: SCL 4, 5, 6)
    clear = _isin(scl, CLEAR_SCL)
    vok = _isin(wc, VEG) & clear & ~np.isnan(ndvi)
    nd = np.where(vok, ndvi, 0).astype(np.float64)
    veg_n = _cells(vok.astype(np.int32), S).astype(np.float64)
    veg_s = _cells(nd, S); veg_ss = _cells(nd * nd, S)
    mok = vok & ~np.isnan(ndmi)
    m_n = _cells(mok.astype(np.int32), S).astype(np.float64)
    m_s = _cells(np.where(mok, ndmi, 0).astype(np.float64), S)
    ook = vok & isopen
    open_n = _cells(ook.astype(np.int32), S).astype(np.float64)
    open_s = _cells(np.where(ook, nd, 0), S)
    # --- neighbourhoods
    r = max(1, int(round(nb_radius_m / cell_m)))
    nb_p, nb_e, nb_on, nb_os = _nb(n_pix, r), _nb(edge_p, r), _nb(open_n, r), _nb(open_s, r)
    nb_c = {k: _nb(cnt[k], r) for k in CLASSES}
    rs = 1 if cell_m <= 50 else 0                     # v2.0: land shares in and right around the square
    ns_p = _nb(n_pix, rs); ns_c = {k: _nb(cnt[k], rs) for k in OPEN}
    min_pix = 0.5 * S * S
    with np.errstate(divide='ignore', invalid='ignore'):
        edge_d = np.where(nb_p > 0, nb_e / nb_p, 0.0)
        mean = np.where(veg_n > 0, veg_s / np.maximum(veg_n, 1), 0)
        spec = np.where(veg_n >= min_pix, np.sqrt(np.maximum(0, veg_ss / np.maximum(veg_n, 1) - mean * mean)), np.nan)
        ndmi_m = np.where(m_n >= min_pix, m_s / np.maximum(m_n, 1), np.nan)
        ks = (10, 20, 30, 40, 80, 90)
        tot = sum(nb_c[k] for k in ks)
        h = np.zeros((CH, CW))
        for k in ks:
            p = np.where(tot > 0, nb_c[k] / np.maximum(tot, 1e-12), 0)
            h -= np.where(p > 0, p * np.log(np.where(p > 0, p, 1)), 0)
        shan = h / np.log(4)
    norm = dict(E98=_pct(edge_d, 0.98) or 1.0, S02=_pct(spec, 0.02), S98=_pct(spec, 0.98), M02=_pct(ndmi_m, 0.02), M98=_pct(ndmi_m, 0.98))
    # --- 0–100 layers
    L = {k: np.full((CH, CW), 255, np.uint8) for k in LAYER_ORDER}
    L['valid'][:] = 0
    ok = n_pix >= min_pix
    np_ = np.maximum(n_pix, 1)
    sh = {k: cnt[k] / np_ for k in CLASSES}
    nbp = np.maximum(nb_p, 1)
    nsh = {k: nb_c[k] / nbp for k in CLASSES}
    nsp = np.maximum(ns_p, 1)
    ssh = {k: np.where(ns_p > 0, ns_c[k] / nsp, 0) for k in OPEN}
    open_sq = sum(ssh[k] for k in OPEN)
    wood = nsh[10]
    tree = sh[10]; open_share = sh[20] + sh[30] + sh[40] + sh[90]

    def put(name, values, where=ok):
        L[name][where] = np.asarray(values)[where].astype(np.uint8)

    put('valid', np.where(sh[50] + sh[80] + sh[90] > 0.6, 0, 1))
    put('woodland', _clamp(100 * wood)); put('cover', _clamp(100 * tree))
    put('open', _clamp(100 * open_sq / 0.6))
    with np.errstate(divide='ignore', invalid='ignore'):
        put('forage', np.where(nb_on >= min_pix, _clamp(100 * ((nb_os / np.maximum(nb_on, 1)) - 0.25) / 0.5), 15))
    put('crops', _clamp(100 * ssh[40] / 0.5))
    put('moisture', _clamp(100 * (ndmi_m - norm['M02']) / ((norm['M98'] - norm['M02']) or 1)), ok & ~np.isnan(ndmi_m))
    put('mosaic', _clamp(400 * np.minimum(open_sq, 0.6) * wood))
    put('edge', _clamp(100 * edge_d / norm['E98']))
    put('edge_near', _clamp(100 * (400 - m_edge) / 400))
    dt = s_built / np_
    put('towns_far', _clamp(100 * np.minimum(dt, 1000) / 1000))
    if s_road is not None:
        dr = s_road / np_
        put('roads_far', _clamp(100 * np.minimum(dr, 800) / 800))
        put('raw_droad_only', np.minimum(254, np.floor(dr / 20 + 0.5)))
    put('water', _clamp(100 * (400 - m_water) / 400))
    put('diversity', _clamp(100 * shan))
    put('natural', _clamp(100 * sum(cnt[k] for k in NATURAL) / np_))
    put('spectral', _clamp(100 * (spec - norm['S02']) / ((norm['S98'] - norm['S02']) or 1)), ok & ~np.isnan(spec))
    put('raw_tree', _clamp(100 * tree)); put('raw_open', _clamp(100 * open_share))
    put('raw_crop', _clamp(100 * sh[40])); put('raw_built', _clamp(100 * sh[50]))
    put('raw_ndvi', _clamp(100 * np.maximum(0, mean)), ok & (veg_n > 0))
    put('raw_ndmi', _clamp(100 * (ndmi_m + 0.5)), ok & ~np.isnan(ndmi_m))
    put('raw_dedge', np.minimum(254, np.floor(m_edge / 20 + 0.5)))
    put('raw_dtown', np.minimum(254, np.floor(dt / 40 + 0.5)))
    put('raw_dwater', np.minimum(254, np.floor(m_water / 20 + 0.5)))
    L['distinct'] = distinctiveness(L)
    stats = dict(squares=int(CH * CW), squares_with_data=int(ok.sum()), clear_pixel_share=round(float(vok.sum() / max(1, (_isin(wc, VEG)).sum())), 3))
    return L, norm, stats


def distinctiveness(L):
    """Habitat distinctiveness 0–100 (biodiversity-metric bands: trees 4, grass/shrub/wetland 3, cropland 2, built-up 0, other 3)."""
    t, o, c, b = (L[k].astype(np.float64) for k in ('raw_tree', 'raw_open', 'raw_crop', 'raw_built'))
    miss = (L['raw_tree'] == 255) | (L['raw_open'] == 255) | (L['raw_crop'] == 255) | (L['raw_built'] == 255)
    other = np.maximum(0, 100 - t - o - b)
    d = np.minimum(4, (t * 4 + np.maximum(0, o - c) * 3 + c * 2 + other * 3) / 100)
    out = np.floor(d * 25 + 0.5)
    return np.where(miss, 255, out).astype(np.uint8)
