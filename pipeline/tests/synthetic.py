"""A synthetic 10 m landscape used by the tests (forest, grass, crops, wetland, a town, a lake strip and a cloud)."""
import numpy as np


def landscape(H=400, W=400, seed=3):
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:H, 0:W]
    v = np.sin(x / 37) + np.cos(y / 53) + np.sin((x + y) / 91) + rng.normal(0, 0.25, (H, W))
    wc = np.select([v > 1.0, v > 0.2, v > -0.4, v > -1.1, v > -1.6], [10, 30, 40, 20, 90], 50).astype(np.uint8)
    wc[180:230, 180:230] = 50; wc[300:320, :] = 80
    ndvi = (0.35 + 0.4 * np.abs(np.sin(x * y / 9000)) + rng.normal(0, 0.03, (H, W))).astype(np.float32)
    ndvi[wc == 50] = 0.1
    ndmi = (ndvi - 0.3).astype(np.float32)
    scl = np.full((H, W), 4, np.uint8); scl[50:90, 250:330] = 9   # a cloud
    ndvi[60:70, 10:20] = np.nan
    return wc, ndvi, ndmi, scl
