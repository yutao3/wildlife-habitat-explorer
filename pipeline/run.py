#!/usr/bin/env python3
"""WildScope pipeline — run the website's habitat and biodiversity method on a Sentinel-2 tile.

  python run.py check                                  # test libraries, internet access and the machine
  python run.py run --lat 48.0 --lon 7.85              # half tile around Freiburg, clearest summer scene
  python run.py run --tile 32UMU --extent full --mode weekly --web

See README.md in this folder for what each step does.
"""
import argparse, json, os, platform, shutil, sys, time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def check(args):
    ok = True
    print(f'Python {platform.python_version()} on {platform.platform()}')
    try:
        import os as _os
        print(f'CPU cores: {_os.cpu_count()}')
        with open('/proc/meminfo') as f:
            print('RAM:', f.readline().split(':')[1].strip())
    except Exception:
        pass
    du = shutil.disk_usage(HERE); print(f'Free disk here: {du.free / 1e9:.0f} GB')
    for mod in ('numpy', 'scipy', 'rasterio', 'pystac_client', 'planetary_computer', 'pyproj', 'requests', 'PIL'):
        try:
            m = __import__(mod); print(f'  {mod:20s} {getattr(m, "__version__", "ok")}')
        except Exception as e:
            ok = False; print(f'  {mod:20s} MISSING ({e})')
    if not ok:
        print('\nInstall the missing libraries:  pip install -r requirements.txt'); return 1
    import requests
    from wildscope import sources
    tests = [('Planetary Computer catalogue', 'https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-2-l2a'),
             ('Planetary Computer token', 'https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-2-l2a'),
             ('GBIF', 'https://api.gbif.org/v1/occurrence/search?limit=1')]
    for name, url in tests:
        try:
            t = time.time(); r = requests.get(url, timeout=20, headers=sources.HEADERS); print(f'  {name:30s} HTTP {r.status_code} in {time.time() - t:.1f} s')
            ok &= r.ok
        except Exception as e:
            ok = False; print(f'  {name:30s} FAILED ({e})')
    ok_osm = False
    for url in sources.OVERPASS:                  # the run tries every mirror, so one working mirror is enough
        try:
            t = time.time(); r = requests.post(url, data={'data': '[out:json][timeout:20];node(48.0,7.85,48.001,7.851);out ids;'},
                                               timeout=30, headers=sources.HEADERS)
            print(f'  {"OpenStreetMap " + url.split("/")[2]:30s} HTTP {r.status_code} in {time.time() - t:.1f} s')
            ok_osm |= r.ok
        except Exception as e:
            print(f'  {"OpenStreetMap " + url.split("/")[2]:30s} FAILED ({type(e).__name__})')
    if not ok_osm:
        print('  No OpenStreetMap server answered: runs will go on without roads (try again later)')
    try:
        import rasterio
        from rasterio.windows import Window
        cat = sources.catalog()
        it = next(cat.search(collections=['sentinel-2-l2a'], intersects=dict(type='Point', coordinates=[7.85, 48.0]), max_items=1).items())
        t = time.time()
        with rasterio.Env(**sources.GDAL_ENV), rasterio.open(it.assets['B04'].href) as ds:
            a = ds.read(1, window=Window(5000, 5000, 512, 512))
        print(f'  Read a 512 x 512 piece of {it.id} in {time.time() - t:.1f} s (mean value {a.mean():.0f})')
    except Exception as e:
        ok = False; print(f'  Reading Sentinel-2 FAILED ({e})')
    print('\nAll checks passed.' if ok else '\nSome checks failed: see above.')
    return 0 if ok else 1


def run(args):
    import numpy as np
    from wildscope import sources, indicators, scoring, outputs
    T = {}; t0 = time.time()
    def step(name):
        nonlocal t0
        now = time.time(); T[name] = now - t0; t0 = now
    log = lambda *a: print(*a, flush=True)
    log('1. Finding the Sentinel-2 tile and scene')
    cat = sources.catalog()
    tile = args.tile or sources.find_tile(cat, args.lat, args.lon)
    center = (args.lat, args.lon) if args.lat is not None and args.lon is not None else None
    g = sources.make_grid(sources.any_item(cat, tile), args.extent, center, args.cell)
    item = sources.pick_scene(cat, tile, args.mode, g.lonlat_bounds()[1], args.max_cloud, log, cover=g.lonlat_bounds())
    items = sources.same_day(cat, tile, item, g.lonlat_bounds(), log)
    lb = g.lonlat_bounds(); km = round(g.w * g.tile_transform.a / 1000, 1)
    log(f'  tile {tile}, window {g.w} x {g.h} px = {km} x {km} km, lon {lb[0]:.3f}..{lb[2]:.3f}, lat {lb[1]:.3f}..{lb[3]:.3f}')
    step('1 find scene')
    log('2. Reading Sentinel-2 bands (only this window)')
    ndvi, ndmi, scl, s2info = sources.read_s2(items, g, log); step('2 read Sentinel-2')
    log('3. Reading ESA WorldCover 2021')
    wc, wc_ids = sources.read_worldcover(cat, g, log); step('3 read WorldCover')
    log('4. Roads and water from OpenStreetMap')
    osm_gap = None
    if args.osm_minutes <= 0:
        log('  skipped (--osm-minutes 0): no roads; water from WorldCover only')
        osm = dict(roads=[], water=[], skipped=True); roads, water = None, np.zeros(wc.shape, bool)
    else:
        try:
            osm = sources.read_osm(g, HERE / 'cache', log=log, max_minutes=args.osm_minutes)
            roads, water = sources.rasterize_osm(osm, g)
            osm_gap = sources.osm_missing_mask(osm, g)
            if osm_gap is not None:
                log(f"  {len(osm['missing'])} of {osm['pieces']} pieces missing ({osm_gap.mean() * 100:.0f}% of the window): "
                    'road and water scores left empty there')
        except Exception as e:
            log(f'  OpenStreetMap failed ({e}); continuing without roads and rivers')
            osm = dict(roads=[], water=[], failed=str(e)); roads, water = None, np.zeros(wc.shape, bool)
    step('4 OpenStreetMap')
    log(f'5. Indicators for every {args.cell} m square (cloud mask: SCL 4, 5, 6; no gap-filling)')
    L, norm, stats = indicators.compute(wc, ndvi, ndmi, scl, roads, water, cell_m=args.cell, px_m=10, log=log)
    del ndvi, ndmi, scl
    if osm_gap is not None:                       # no OpenStreetMap there: do not pretend there are no roads or rivers
        S_ = args.cell // 10
        gap = osm_gap.reshape(osm_gap.shape[0] // S_, S_, osm_gap.shape[1] // S_, S_).any(axis=(1, 3))
        for k in ('roads_far', 'raw_droad_only', 'water', 'raw_dwater'):
            L[k][gap] = 255
        stats['osm_missing_share'] = round(float(gap.mean()), 3)
    step('5 indicators')
    log('6. Scores')
    P, pilot_meta = scoring.presets()
    S = {pid: scoring.score(L, p['weights']) for pid, p in P.items()}
    for pid, s in S.items():
        log(f'  {pid}: mean {np.nanmean(s):.1f}, squares with a score {int(np.isfinite(s).sum()):,}')
    step('6 scores')
    log('7. Evidence from GBIF sightings (since 2017)')
    sight = {}
    try:
        sight = sources.read_sightings(g, log=log)
        ev = scoring.evidence(L, S, sight, g, args.cell)
        for pid, r in ev.items():
            log(f'  {pid}: ' + (f"AUC {r['auc_vs_other_mammals']:.2f} ({r['sightings']} sightings)" if 'auc_vs_other_mammals' in r else r['note']))
    except Exception as e:
        ev = {'error': str(e)}; log(f'  GBIF failed ({e})')
    step('7 evidence')
    log('8. Writing outputs')
    date = item.datetime.strftime('%Y-%m-%d')
    name = f"{tile}_{date}_{args.mode}_{args.extent}_{args.cell}m"
    out = Path(args.out).resolve() / name
    for k in indicators.INDICATORS:
        outputs.write_tif(out / 'indicators' / f'{k}.tif', outputs.layer_float(L, k), g, args.cell, k)
    for pid, s in S.items():
        outputs.write_tif(out / 'scores' / f'{pid}.tif', s, g, args.cell, f'{pid} score 0-100')
    label = f'Sentinel-2 tile {tile}, {km} × {km} km, {date}'
    outputs.quicklook(out / 'quicklook.png', S, f'WildScope · {label}')
    rep = dict(label=label, tile=tile, mode=args.mode, extent=args.extent, area_km=km, cell_m=args.cell, crs=str(g.crs), lonlat_bounds=[round(v, 5) for v in lb],
               scene=dict(id=' + '.join(i.id for i in items), date=date, cloud=float(max(i.properties['eo:cloud_cover'] for i in items)), **s2info),
               worldcover=wc_ids,
               osm=dict(roads=len(osm['roads']), water=len(osm['water']), pieces=osm.get('pieces'), missing=len(osm.get('missing', [])),
                        note='skipped' if osm.get('skipped') else osm.get('failed')),
               gbif={k: len(sight.get(k, [])) for k in ('deer', 'boar', 'others')}, evidence=ev, stats=stats, normalisation=norm,
               weights={pid: p['weights'] for pid, p in P.items()}, run_at=datetime.now(timezone.utc).isoformat(), machine=platform.node(),
               out_dir=str(out))
    if args.web:
        info = outputs.web_grid(out / 'web', L, g, args.cell, args.web_cell, pilot_meta,
                                dict(machine=platform.node(), label=label, short=f'Tile {tile} · {date}', scene_date=date, scene=' + '.join(i.id for i in items),
                                     run_date=rep['run_at'], norm=norm), sight)
        rep['web'] = info; log(f"  website grid: {info['cols']} x {info['rows']} squares of {args.web_cell} m, {info['mb']} MB")
    step('8 outputs')
    rep['timings'] = {k: round(v, 1) for k, v in T.items()}
    (out / 'report.json').write_text(json.dumps(rep, indent=1, default=str))
    md = outputs.report_md(rep); (out / 'report.md').write_text(md)
    log('\n' + md)
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('check', help='test libraries, internet access and the machine')
    r = sub.add_parser('run', help='process one tile')
    r.add_argument('--tile', help='Sentinel-2 MGRS tile, for example 32UMU')
    r.add_argument('--lat', type=float); r.add_argument('--lon', type=float)
    r.add_argument('--extent', default='half', help='full (110 km), half (55 km, default), quarter (27 km) or a size in km')
    r.add_argument('--mode', default='baseline', choices=['baseline', 'weekly'], help='baseline: clearest growing-season scene; weekly: newest scene, no gap-filling')
    r.add_argument('--cell', type=int, default=50, choices=[50, 100, 200], help='square size in metres (default 50)')
    r.add_argument('--max-cloud', type=float, dest='max_cloud')
    r.add_argument('--out', default=str(HERE / 'runs'))
    r.add_argument('--web', action='store_true', help='also write a grid the website can open')
    r.add_argument('--web-cell', type=int, default=100, dest='web_cell')
    r.add_argument('--osm-minutes', type=float, default=20, dest='osm_minutes',
                   help='time limit for fetching OpenStreetMap (default 20); pieces not fetched are retried on the next run; 0 skips roads')
    a = ap.parse_args()
    if a.cmd == 'run' and not a.tile and (a.lat is None or a.lon is None):
        ap.error('give --tile, or --lat and --lon')
    sys.exit(check(a) if a.cmd == 'check' else run(a))


if __name__ == '__main__':
    main()
