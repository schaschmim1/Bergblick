# Satellitenfarben für Panorama und Karte: ESA WorldCover Sentinel-2-Jahreskomposit 2021 (10 m, wolkenfrei,
# CC BY 4.0), über HTTP-Bereichsabfragen aus den COGs auf AWS gelesen. Schreibt Web-Mercator-Kacheln
# data/sat/<z>/<x>_<y>.jpg für dieselben Kacheln wie das mitgelieferte Detailgelände (data/dem/bundles.json).
#   python tools/build_sat.py 11      (ganze Alpen, ~76 m)
#   python tools/build_sat.py 12      (deutsche und österreichische Alpen, ~38 m)
import math, os, sys, json, io, concurrent.futures as cf
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from rasterio.enums import Resampling
from PIL import Image

Z = int(sys.argv[1]); ONLY = int(sys.argv[2]) if len(sys.argv) > 2 else 0
ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_MULTIRANGE='YES', GDAL_HTTP_MERGE_CONSECUTIVE_RANGES='YES',
           CURL_CA_BUNDLE=os.environ.get('CURL_CA_BUNDLE', '/root/.ccr/ca-bundle.crt'), GDAL_CACHEMAX=512 * 2**20, VSI_CACHE='TRUE', VSI_CACHE_SIZE='100000000')
lvl = next(l for l in json.load(open('data/dem/bundles.json'))['levels'] if l['z'] == Z)
tiles = [(x, y) for y in range(lvl['y0'], lvl['y1'] + 1) for x in range(lvl['x0'], lvl['x1'] + 1) if lvl['rows'][y - lvl['y0']][x - lvl['x0']] == '1']
out = f'data/sat/{Z}'; os.makedirs(out, exist_ok=True)
def lon(x): return x / 2 ** Z * 360 - 180
def lat(y): return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / 2 ** Z))))
def url(la, lo):
    return f'/vsicurl/https://esa-worldcover-s2.s3.eu-central-1.amazonaws.com/rgbnir/2021/N{la:02d}/ESA_WorldCover_10m_2021_v200_N{la:02d}E{lo:03d}_S2RGBNIR.tif'

ds = {}
def src(la, lo):
    k = (la, lo)
    if k not in ds:
        try: ds[k] = rasterio.open(url(la, lo))
        except Exception: ds[k] = None
    return ds[k]

def tone(a):
    # Reflexion (×10000) → Bildfarbe: leichte Gammakurve, Schnee darf weiß werden
    v = np.clip(a.astype(np.float32) / 3200.0, 0, 1) ** (1 / 1.9)
    g = v.mean(axis=0, keepdims=True)
    v = np.clip(g + (v - g) * 1.15, 0, 1)
    return (v * 255 + 0.5).astype(np.uint8)

def one(t):
    x, y = t
    p = f'{out}/{x}_{y}.jpg'
    if os.path.exists(p): return os.path.getsize(p)
    W, E, N, S = lon(x), lon(x + 1), lat(y), lat(y + 1)
    # Zeilen in Mercator gleichmäßig: je Zeile eigene Breite, deshalb zuerst feiner in Breite lesen
    H = 512
    acc = np.zeros((3, H, 256), np.float32); have = np.zeros((H, 256), bool)
    for la in range(math.floor(S), math.floor(N) + 1):
        for lo in range(math.floor(W), math.floor(E) + 1):
            d = src(la, lo)
            if d is None: continue
            w0, e0, s0, n0 = max(W, lo), min(E, lo + 1), max(S, la), min(N, la + 1)
            if e0 <= w0 or n0 <= s0: continue
            c0, c1 = round((w0 - W) / (E - W) * 256), round((e0 - W) / (E - W) * 256)
            r0, r1 = round((N - n0) / (N - S) * H), round((N - s0) / (N - S) * H)
            if c1 <= c0 or r1 <= r0: continue
            a = d.read([1, 2, 3], window=from_bounds(w0, s0, e0, n0, d.transform), out_shape=(3, r1 - r0, c1 - c0), resampling=Resampling.average)
            acc[:, r0:r1, c0:c1] = a; have[r0:r1, c0:c1] = a[0] > 0
    if not have.any(): return 0
    # gleichmäßige Breitenzeilen → Mercator-Zeilen
    mv = np.linspace(y, y + 1, 257)[:-1] + 0.5 / 256
    la_rows = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * mv / 2 ** Z))))
    idx = np.clip(((N - la_rows) / (N - S) * H).astype(int), 0, H - 1)
    img = tone(acc[:, idx, :]).transpose(1, 2, 0)
    Image.fromarray(img).save(p, quality=78, optimize=True)
    return os.path.getsize(p)

def group(ts):
    with rasterio.Env(**ENV):
        return sum(one(t) for t in ts)

if __name__ == '__main__':
    if ONLY: tiles = tiles[:ONLY]
    # nach 1°-Feldern gruppiert (Blöcke werden im Speicher wiederverwendet), Gruppen parallel
    groups = {}
    for t in tiles: groups.setdefault((math.floor(lat(t[1] + 0.5)), math.floor(lon(t[0] + 0.5))), []).append(t)
    import multiprocessing as mp
    tot = 0
    with mp.Pool(12) as pool:
        for i, n in enumerate(pool.imap_unordered(group, groups.values())):
            tot += n; print(i + 1, '/', len(groups), 'Felder', round(tot / 1e6, 1), 'MB', flush=True)
    print(Z, len(tiles), 'Kacheln', round(tot / 1e6, 1), 'MB')
