"""Same synthetic landscape through the website (node) and the Harwell pipeline (Python): the indicators must agree.
Run from the pipeline folder:  python tests/test_parity.py"""
import json, subprocess, sys, tempfile
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wildscope.indicators import compute, LAYER_ORDER

from tests.synthetic import landscape

wc, ndvi, ndmi, scl = landscape()
H, W = wc.shape
with tempfile.TemporaryDirectory() as td:
    td = Path(td)
    nan2none = lambda a: [None if np.isnan(v) else float(v) for v in a.ravel()]
    (td / 'in.json').write_text(json.dumps(dict(W=W, H=H, S=5, cellM=50, pxM=10, wc=wc.ravel().tolist(), ndvi=nan2none(ndvi), ndmi=nan2none(ndmi), scl=scl.ravel().tolist())))
    subprocess.run(['node', str(Path(__file__).with_name('parity.mjs')), str(td / 'in.json'), str(td / 'out.json')], check=True)
    js = json.loads((td / 'out.json').read_text())
L, norm, stats = compute(wc, ndvi, ndmi, scl, None, np.zeros_like(wc, bool), log=lambda *a: None)
DIST = {'edge_near', 'towns_far', 'water', 'raw_dedge', 'raw_dtown', 'raw_dwater'}   # exact (Python) vs approximate (browser) distance
FLOAT32 = {'edge', 'spectral'}   # browser stores these in 32-bit floats: at most 1 point of rounding
bad = 0
for k in LAYER_ORDER:
    a = np.array(js['layers'][k], np.int32).reshape(js['rows'], js['cols']); b = L[k].astype(np.int32)
    d = np.abs(a - b); both = (a != 255) & (b != 255)
    same_nodata = bool(((a == 255) == (b == 255)).all())
    tol = 10 if k in DIST else 1 if k in FLOAT32 else 0
    worst = int(d[both].max()) if both.any() else 0
    ok = same_nodata and worst <= tol
    bad += not ok
    print(f"{'OK ' if ok else 'BAD'} {k:16s} max diff {worst:3d}  mean {float(d[both].mean()) if both.any() else 0:.3f}  nodata match {same_nodata}")
print('norm js', {k: round(v, 4) for k, v in js['norm'].items()}); print('norm py', {k: round(v, 4) for k, v in norm.items()})
print('PASS' if not bad else f'FAIL ({bad} layers)'); sys.exit(1 if bad else 0)
