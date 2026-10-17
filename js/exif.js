// Minimaler EXIF-Leser für JPEG: GPS (samt Genauigkeit), Blickrichtung, Brennweite.
export function readExif(buf) {
  const v = new DataView(buf);
  if (v.getUint16(0) !== 0xffd8) return null;
  let o = 2;
  while (o + 4 < v.byteLength) {
    const marker = v.getUint16(o), len = v.getUint16(o + 2);
    if (marker === 0xffe1 && v.getUint32(o + 4) === 0x45786966) return parseTiff(v, o + 10);
    if ((marker & 0xff00) !== 0xff00) break;
    o += 2 + len;
  }
  return null;
}

function parseTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (p) => v.getUint16(p, le), u32 = (p) => v.getUint32(p, le);
  const rat = (p) => { const d = u32(p + 4); return d ? u32(p) / d : 0; };
  const srat = (p) => { const d = v.getInt32(p + 4, le); return d ? v.getInt32(p, le) / d : 0; };
  const out = {};
  const ifd = (p, names) => {
    const n = u16(t + p), tags = {};
    for (let i = 0; i < n; i++) {
      const e = t + p + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
      const size = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type] * cnt;
      const vp = size > 4 ? t + u32(e + 8) : e + 8;
      const name = names[tag];
      if (!name) continue;
      let val;
      if (type === 2) { val = ''; for (let k = 0; k < cnt - 1; k++) val += String.fromCharCode(v.getUint8(vp + k)); }
      else if (type === 3) val = u16(vp);
      else if (type === 4) val = u32(vp);
      else if (type === 5) val = cnt === 1 ? rat(vp) : Array.from({ length: cnt }, (_, k) => rat(vp + k * 8));
      else if (type === 10) val = srat(vp);
      else if (type === 1 || type === 7) val = v.getUint8(vp);
      tags[name] = val;
    }
    return tags;
  };
  const ifd0 = ifd(u32(t + 4), { 0x0112: 'Orientation', 0x8769: 'ExifIFD', 0x8825: 'GPSIFD', 0x010f: 'Make', 0x0110: 'Model' });
  Object.assign(out, ifd0);
  if (ifd0.ExifIFD) Object.assign(out, ifd(ifd0.ExifIFD, { 0x920a: 'FocalLength', 0xa405: 'FocalLength35', 0x9003: 'DateTimeOriginal' }));
  if (ifd0.GPSIFD) {
    const g = ifd(ifd0.GPSIFD, { 1: 'LatRef', 2: 'Lat', 3: 'LonRef', 4: 'Lon', 5: 'AltRef', 6: 'Alt', 16: 'DirRef', 17: 'Dir', 31: 'HErr' });
    const dms = (a) => Array.isArray(a) ? a[0] + a[1] / 60 + a[2] / 3600 : null;
    if (g.Lat && g.Lon) {
      out.lat = dms(g.Lat) * (g.LatRef === 'S' ? -1 : 1);
      out.lon = dms(g.Lon) * (g.LonRef === 'W' ? -1 : 1);
      if (!isFinite(out.lat) || !isFinite(out.lon) || (out.lat === 0 && out.lon === 0)) { delete out.lat; delete out.lon; }
    }
    if (typeof g.Alt === 'number') out.alt = g.Alt * (g.AltRef === 1 ? -1 : 1);
    if (typeof g.Dir === 'number') out.heading = g.Dir; // T = geografisch, M = magnetisch
    out.headingRef = g.DirRef;
    if (typeof g.HErr === 'number' && g.HErr > 0) out.gpsError = g.HErr; // horizontale Genauigkeit in m (iPhone)
  }
  return out;
}
