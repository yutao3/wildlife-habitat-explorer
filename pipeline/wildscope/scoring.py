"""scoring.py — weighted average of the indicators, and the evidence check against GBIF sightings.

Weights come from the website's data/scores/grid.json, so the website and the pipeline always use the same recipe.
"""
import json
from pathlib import Path
import numpy as np

GRID_JSON = Path(__file__).resolve().parents[2] / 'data' / 'scores' / 'grid.json'
FALLBACK = {   # v2.0 weights, used only if grid.json is not found
    'roe_deer': {'woodland': 5, 'open': 10, 'forage': 5, 'crops': 20, 'moisture': 5, 'mosaic': 5, 'towns_far': 25, 'roads_far': 25},
    'wild_boar': {'woodland': 20, 'cover': 15, 'crops': 25, 'water': 15, 'towns_far': 15, 'moisture': 10},
    'biodiversity': {'distinct': 25, 'diversity': 25, 'natural': 20, 'spectral': 15, 'water': 10, 'woodland': 5},
}


def presets():
    try:
        m = json.loads(GRID_JSON.read_text())
        return {k: dict(label=p['label'], weights=p['weights']) for k, p in m['presets'].items()}, m
    except Exception:
        return {k: dict(label=k.replace('_', ' ').title(), weights=w) for k, w in FALLBACK.items()}, None


def score(L, weights):
    """score = Σ(weight × indicator) / Σ weight over indicators with data; NaN where the square is not valid."""
    num = np.zeros(L['valid'].shape); den = np.zeros(L['valid'].shape)
    for k, w in weights.items():
        if w <= 0 or k not in L:
            continue
        a = L[k].astype(np.float64); ok = L[k] != 255
        num += np.where(ok, w * a, 0); den += np.where(ok, w, 0)
    with np.errstate(divide='ignore', invalid='ignore'):
        s = np.where(den > 0, num / den, np.nan)
    s[L['valid'] != 1] = np.nan
    return s.astype(np.float32)


def auc(pos, neg):
    """Area under the ROC curve: chance a sighting square beats a comparison square (ties count half)."""
    pos = np.asarray(pos, float); neg = np.sort(np.asarray(neg, float))
    pos = pos[~np.isnan(pos)]; neg = neg[~np.isnan(neg)]
    if not len(pos) or not len(neg):
        return float('nan')
    lo = np.searchsorted(neg, pos, 'left'); hi = np.searchsorted(neg, pos, 'right')
    return float(np.mean((lo + (hi - lo) / 2) / len(neg)))


def to_cells(points, g, cell_m):
    """GBIF (lon, lat, ...) records → square indices on the processed grid."""
    from pyproj import Transformer
    if not points:
        return np.array([], int)
    tf = Transformer.from_crs('EPSG:4326', g.crs, always_xy=True)
    xs, ys = tf.transform([p[0] for p in points], [p[1] for p in points])
    x0, y0, x1, y1 = g.bounds
    cols = ((np.array(xs) - x0) // cell_m).astype(int); rows = ((y1 - np.array(ys)) // cell_m).astype(int)
    CW = int(round((x1 - x0) / cell_m)); CH = int(round((y1 - y0) / cell_m))
    ok = (cols >= 0) & (cols < CW) & (rows >= 0) & (rows < CH)
    return rows[ok] * CW + cols[ok]


def evidence(L, scores, sightings, g, cell_m, min_pos=30, min_bg=50):
    """For each species score: AUC of sighting squares against other-mammal squares (target-group background)."""
    bg = to_cells(sightings.get('others', []), g, cell_m)
    out = {}
    for pid, sp in (('roe_deer', 'deer'), ('wild_boar', 'boar')):
        pos = to_cells(sightings.get(sp, []), g, cell_m)
        s = scores[pid].ravel()
        res = dict(sightings=int(len(pos)), background=int(len(bg)))
        if len(pos) >= min_pos and len(bg) >= min_bg:
            res['auc_vs_other_mammals'] = round(auc(s[pos], s[bg]), 3)
            res['auc_vs_all_squares'] = round(auc(s[pos], s[~np.isnan(s)]), 3)
            res['single_indicator_auc'] = {k: round(auc(np.where(L[k].ravel()[pos] == 255, np.nan, L[k].ravel()[pos]),
                                                         np.where(L[k].ravel()[bg] == 255, np.nan, L[k].ravel()[bg])), 3)
                                           for k in ('woodland', 'cover', 'open', 'forage', 'crops', 'moisture', 'mosaic', 'edge',
                                                     'edge_near', 'towns_far', 'roads_far', 'water')}
        else:
            res['note'] = f'too few records to test (need {min_pos} sightings and {min_bg} background records)'
        out[pid] = res
    return out
