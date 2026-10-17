import math, os, sys, io, gzip, urllib.request, concurrent.futures as cf
import numpy as np
from PIL import Image
Z=int(sys.argv[1]); W,E,S,N=4.3,17.2,43.2,48.9
def tx(lon): return (lon+180)/360*2**Z
def ty(lat): r=math.radians(lat); return (1-math.log(math.tan(r)+1/math.cos(r))/math.pi)/2*2**Z
xs=range(int(tx(W)),int(tx(E))+1); ys=range(int(ty(N)),int(ty(S))+1)
os.makedirs(f"data/raw{Z}",exist_ok=True)
def get(x,y):
    p=f"data/raw{Z}/{x}_{y}.png"
    if not os.path.exists(p):
        urllib.request.urlretrieve(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png",p)
    a=np.asarray(Image.open(p).convert("RGB")).astype(np.float64)
    return (x,y,a[...,0]*256+a[...,1]+a[...,2]/256-32768)
with cf.ThreadPoolExecutor(16) as ex: res=list(ex.map(lambda t:get(*t),[(x,y) for x in xs for y in ys]))
print(Z, len(xs), len(ys), xs, ys)
out=f"data/dem{Z}"; os.makedirs(out,exist_ok=True); tot=0
for x,y,h in res:
    h=np.clip(np.round(h),-500,9000).astype(np.int16)
    h[h<0]=0
    d=np.diff(h,axis=1,prepend=0).astype(np.int16)
    b=gzip.compress(d.tobytes(),9)
    open(f"{out}/{x}_{y}.bin","wb").write(b); tot+=len(b)
print("total MB",tot/1e6)
