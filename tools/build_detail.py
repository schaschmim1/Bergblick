# Mitgelieferte Detailkacheln (AWS Terrain Tiles) im Format "p2z" bauen:
# Vorhersage links+oben−obenlinks, Zickzack, Byte-Ebenen, gzip. Kacheln ohne Berge (Maximum unter
# MIN_ELE) werden ausgelassen. Schreibt data/dem/<z>/<x>_<y>.bin und trägt die Stufe in
# data/dem/bundles.json ein (Rechteck plus Zeilen-Bitmaske der vorhandenen Kacheln).
#   python tools/build_detail.py 11 4.6 17.2 43.6 48.4 400   (ganze Alpen, ~52 m)
#   python tools/build_detail.py 12 9.5 16.3 46.3 48.0 500   (deutsche und österreichische Alpen, ~26 m)
import math, os, io, gzip, json, sys, urllib.request, concurrent.futures as cf
import numpy as np
from PIL import Image
Z = int(sys.argv[1]); W, E, S, N = map(float, sys.argv[2:6]); MIN_ELE = float(sys.argv[6])
def tx(lon): return (lon + 180) / 360 * 2 ** Z
def ty(lat): r = math.radians(lat); return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** Z
xs = range(int(tx(W)), int(tx(E)) + 1); ys = range(int(ty(N)), int(ty(S)) + 1)
out = f"data/dem/{Z}"; os.makedirs(out, exist_ok=True)
def one(t):
    x, y = t
    p = f"{out}/{x}_{y}.bin"
    if os.path.exists(p): return (x, y, os.path.getsize(p))
    for k in range(4):
        try:
            b = urllib.request.urlopen(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png", timeout=60).read(); break
        except Exception:
            if k == 3: raise
    a = np.asarray(Image.open(io.BytesIO(b)).convert("RGB")).astype(np.float64)
    h = np.clip(np.round(a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768), 0, 9000).astype(np.int32)
    if h.max() < MIN_ELE: return (x, y, 0)
    L = np.zeros_like(h); L[:, 1:] = h[:, :-1]
    U = np.zeros_like(h); U[1:] = h[:-1]
    UL = np.zeros_like(h); UL[1:, 1:] = h[:-1, :-1]
    r = h - (L + U - UL)
    z = ((r << 1) ^ (r >> 31)).astype(np.uint16)
    data = gzip.compress((z & 255).astype(np.uint8).tobytes() + (z >> 8).astype(np.uint8).tobytes(), 9)
    open(p, "wb").write(data)
    return (x, y, len(data))
with cf.ThreadPoolExecutor(24) as ex: res = list(ex.map(one, [(x, y) for x in xs for y in ys]))
have = {(x, y) for x, y, n in res if n}
rows = ["".join("1" if (x, y) in have else "0" for x in xs) for y in ys]
meta_p = "data/dem/bundles.json"
meta = json.load(open(meta_p)) if os.path.exists(meta_p) else {"tile": 256, "enc": "p2z", "levels": []}
meta["levels"] = [l for l in meta["levels"] if l["z"] != Z] + [{"z": Z, "x0": xs.start, "y0": ys.start, "x1": xs.stop - 1, "y1": ys.stop - 1, "count": len(have), "rows": rows}]
meta["levels"].sort(key=lambda l: l["z"])
json.dump(meta, open(meta_p, "w"))
print(Z, len(have), "Kacheln,", round(sum(n for *_, n in res) / 1e6, 1), "MB")
