import pyarrow.dataset as ds, pyarrow.fs as pfs, pyarrow.compute as pc, json, time
fs = pfs.S3FileSystem(anonymous=True, region="us-west-2")
d = ds.dataset("overturemaps-us-west-2/release/2026-09-23.1/theme=base/type=land/", filesystem=fs, format="parquet")
print(d.schema.names)
b = pc.field("bbox")
flt = (pc.field("bbox","xmin") > 4.3) & (pc.field("bbox","xmax") < 17.2) & (pc.field("bbox","ymin") > 43.2) & (pc.field("bbox","ymax") < 48.9) & pc.field("class").isin(["peak","volcano","saddle"])
t0=time.time()
t = d.to_table(columns=["id","names","class","subtype","elevation","bbox","source_tags"], filter=flt)
print(t.num_rows, time.time()-t0)
import pyarrow.parquet as pq
pq.write_table(t, "data/peaks_raw.parquet")
