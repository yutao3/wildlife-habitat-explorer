# WildScope pipeline (Harwell)

The website's habitat and biodiversity method, run on a real Sentinel-2 tile on our own machine. One command finds a
scene, reads only the part of the tile we need, masks clouds, computes the 16 indicators for every 50 m square,
scores them, tests the deer score against GBIF sightings, and writes 32-bit GeoTIFFs for QGIS, a quick-look picture,
a report and a grid the website can open.

## What happens in a run

| Step | What it does | Data |
|---|---|---|
| 1 Find scene | Finds the Sentinel-2 tile for a point and the scene to use. `baseline`: clearest growing-season scene that covers the whole window (below 15% cloud, else 40%). `weekly`: newest scene of the last 7 days (14 if none) | Planetary Computer STAC catalogue |
| 2 Read Sentinel-2 | Reads only the window from cloud-optimised GeoTIFFs: B04 and B08 (10 m), B11 and SCL (20 m, repeated to 10 m). Removes the +1000 offset ESA adds since processing baseline 04.00. Computes NDVI and NDMI | Sentinel-2 L2A |
| 3 Read land cover | ESA WorldCover 2021 reprojected onto the tile's 10 m grid | Planetary Computer |
| 4 Roads and water | OpenStreetMap roads, rivers and lakes in ~15 km pieces, cached on disk for 30 days, drawn 30 m wide | Overpass API |
| 5 Indicators | The 16 indicators per square, exactly as the website computes them (see `tests/test_parity.py`). Cloud mask: keep SCL 4, 5, 6. **No gap-filling**: cloudy pixels stay empty | — |
| 6 Scores | Weighted averages, weights read from `../data/scores/grid.json` (same as the website) | — |
| 7 Evidence | AUC (area under the ROC curve) of deer and wild boar sightings since 2017 against other-mammal sightings | GBIF API |
| 8 Outputs | `indicators/*.tif`, `scores/*.tif` (float32, NaN = no data, tile UTM projection), `quicklook.png`, `report.md`, `report.json`, and `web/` with `--web` | — |

The window is in the tile's own UTM projection, so squares are true 50 m squares.

## Set up on the Harwell machine (once)

```bash
git clone -b dev_v0 https://github.com/yutao3/wildlife-habitat-explorer.git
cd wildlife-habitat-explorer/pipeline
python3 -m venv ~/wildscope-env
source ~/wildscope-env/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
python run.py check
```

## Run

```bash
source ~/wildscope-env/bin/activate
cd ~/wildlife-habitat-explorer/pipeline
python run.py run --lat 48.0 --lon 7.85 --extent quarter          # first test: 27 km around Freiburg
python run.py run --lat 48.0 --lon 7.85 --extent half --web       # half tile, 55 km
python run.py run --tile 32UMU --extent full --mode weekly --web  # full tile, newest scene
```

Outputs go to `pipeline/runs/<tile>_<date>_<mode>_<extent>_<cell>m/`. Open the `.tif` files in QGIS directly.

Memory and time (measured on synthetic data, 1 core): a half tile needs about 3 GB of RAM and 16 s for the indicators;
a full tile about 10–12 GB. Reading the images and GBIF usually takes longer than the calculation.

## Weekly runs

`weekly.sh` runs the listed tiles in `weekly` mode. Add it to cron with `crontab -e` (the line is at the top of the file).

## Tests

```bash
python tests/test_parity.py    # Python indicators = website indicators (needs node)
python tests/test_offline.py   # whole pipeline on a synthetic tile, no internet
```
