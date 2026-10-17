import pyarrow.parquet as pq, numpy as np, json, math, sys
rows=pq.read_table(sys.argv[1]).to_pylist()
P=[]
for r in rows:
    if r['class'] not in ('peak','volcano'): continue
    n=(r['names'] or {}).get('primary')
    if not n: continue
    lat=(r['bbox']['ymin']+r['bbox']['ymax'])/2; lon=(r['bbox']['xmin']+r['bbox']['xmax'])/2
    P.append([lat,lon,r['elevation'],n.strip()])
print("named",len(P))
lat=np.array([p[0] for p in P]); lon=np.array([p[1] for p in P])
ele=np.array([p[2] if p[2] is not None else -1 for p in P],float)
# isolation: distance (km) to nearest higher peak in the list, capped at 100
kx=111.32*math.cos(math.radians(46)); ky=110.57
X=lon*kx; Y=lat*ky
order=np.argsort(-ele); iso=np.full(len(P),100.0)
cell=5.0; grid={}
for i in order:
    if ele[i]<0: iso[i]=0; continue
    cx,cy=int(X[i]//cell),int(Y[i]//cell); best=100.0
    for r in range(0,21):
        if r*cell-cell>best: break
        for gx in range(cx-r,cx+r+1):
            for gy in range(cy-r,cy+r+1):
                if max(abs(gx-cx),abs(gy-cy))!=r: continue
                for j in grid.get((gx,gy),()):
                    if ele[j]>ele[i]:
                        d=math.hypot(X[i]-X[j],Y[i]-Y[j]); best=min(best,d)
    iso[i]=best; grid.setdefault((cx,cy),[]).append(i)
out=[[round(P[i][0],5),round(P[i][1],5),int(ele[i]),round(float(iso[i]),1),P[i][3]] for i in order]
json.dump({"fields":["lat","lon","ele","iso_km","name"],"source":"OpenStreetMap contributors via Overture Maps (ODbL)","peaks":out},open(sys.argv[2],"w"),ensure_ascii=False,separators=(',',':'))
print(out[:15])
