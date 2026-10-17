// Höhenmodell (DEM) und Geo-Hilfsfunktionen. Läuft im Worker.

export const R_EARTH = 6371008.8;
export const REFRACTION = 0.13; // Standard-Refraktionskoeffizient
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export class Dem {
  constructor(meta, data) {
    this.meta = meta;
    this.z = meta.z;
    this.ts = meta.tile;
    this.w = (meta.x1 - meta.x0 + 1) * this.ts;
    this.h = (meta.y1 - meta.y0 + 1) * this.ts;
    this.N = this.ts * 2 ** this.z; // Weltbreite in Pixeln
    this.ox = meta.x0 * this.ts + 0.5; // Pixelmitte-Konvention
    this.oy = meta.y0 * this.ts + 0.5;
    this.data = data;
  }

  static async load(base, onProgress) {
    const meta = await (await fetch(`${base}/meta.json`)).json();
    const ts = meta.tile;
    const w = (meta.x1 - meta.x0 + 1) * ts;
    const h = (meta.y1 - meta.y0 + 1) * ts;
    const data = new Int16Array(w * h);
    const jobs = [];
    for (let x = meta.x0; x <= meta.x1; x++)
      for (let y = meta.y0; y <= meta.y1; y++) jobs.push([x, y]);
    let done = 0;
    const worker = async () => {
      while (jobs.length) {
        const [x, y] = jobs.shift();
        try {
          const res = await fetch(`${base}/${meta.z}/${x}_${y}.bin`);
          if (res.ok) {
            const tile = new Int16Array(await gunzip(await res.arrayBuffer()));
            const bx = (x - meta.x0) * ts, by = (y - meta.y0) * ts;
            for (let r = 0; r < ts; r++) {
              let acc = 0, o = (by + r) * w + bx, i = r * ts;
              for (let c = 0; c < ts; c++) { acc += tile[i + c]; data[o + c] = acc; }
            }
          }
        } catch (e) { /* fehlende Kachel = 0 m */ }
        done++;
        onProgress && onProgress(done / (meta.x1 - meta.x0 + 1) / (meta.y1 - meta.y0 + 1));
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return new Dem(meta, data);
  }

  // Mosaik-Pixelkoordinaten für Grad
  px(lon) { return (lon + 180) / 360 * this.N - this.ox; }
  py(lat) {
    const s = Math.sin(lat * D2R);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * this.N - this.oy;
  }

  // Bilineare Interpolation in Mosaik-Pixeln
  at(gx, gy) {
    const w = this.w;
    if (gx < 0 || gy < 0 || gx >= w - 1 || gy >= this.h - 1) return 0;
    const x = gx | 0, y = gy | 0, fx = gx - x, fy = gy - y, i = y * w + x, d = this.data;
    const a = d[i] + (d[i + 1] - d[i]) * fx;
    const b = d[i + w] + (d[i + w + 1] - d[i + w]) * fx;
    return a + (b - a) * fy;
  }

  elev(lat, lon) { return this.at(this.px(lon), this.py(lat)); }

  // Abfrage in normierten Mercator-Koordinaten (u, v in 0..1)
  atUV(u, v) { return this.at(u * this.N - this.ox, v * this.N - this.oy); }

  covers(lat, lon) {
    const x = this.px(lon), y = this.py(lat);
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
}

export async function gunzip(buf) {
  const b = new Uint8Array(buf);
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf; // Server hat bereits entpackt
  const ds = new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')));
  return ds.arrayBuffer();
}

// Großkreis: Distanz (m) und Azimut (Grad, 0 = Nord, im Uhrzeigersinn)
export function distAz(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const d = 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return [d, (Math.atan2(y, x) * R2D + 360) % 360];
}

// Scheinbarer Höhenunterschied inkl. Erdkrümmung und Refraktion
export function drop(d) { return d * d / (2 * R_EARTH) * (1 - REFRACTION); }

// Einheitsvektor im lokalen Ost-Nord-Oben-System
export function enu(azDeg, elDeg) {
  const a = azDeg * D2R, e = elDeg * D2R, c = Math.cos(e);
  return [c * Math.sin(a), c * Math.cos(a), Math.sin(e)];
}

// ---------------------------------------------------------------- Detailkacheln

export const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
export const NODATA = -32768;

export const lonToU = (lon) => (lon + 180) / 360;
export const latToV = (lat) => { const s = Math.sin(lat * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };

// Lädt eine Terrarium-PNG-Kachel und dekodiert sie zu Metern (Int16)
export async function loadTerrarium(z, x, y) {
  // langsames Netz soll das Panorama nicht aufhalten: nach 8 s gilt die Kachel als fehlend (gröbere Stufe springt ein)
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
  let blob;
  try {
    const res = await fetch(`${TILE_URL}/${z}/${x}/${y}.png`, { signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    blob = await res.blob();
  } finally { clearTimeout(timer); }
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = new OffscreenCanvas(256, 256);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, 256, 256).data;
  const out = new Int16Array(256 * 256);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const e = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
    out[i] = e < 0 ? 0 : Math.round(e);
  }
  return out;
}

// Mitgelieferte Detailkachel (Format "p2z": Vorhersage links+oben−obenlinks, Zickzack, Byte-Ebenen, gzip)
export async function loadBundled(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const b = new Uint8Array(await gunzip(await res.arrayBuffer()));
  const n = 256 * 256, out = new Int16Array(n);
  for (let y = 0, i = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++, i++) {
      const z = b[i] | (b[i + n] << 8);
      const r = (z >>> 1) ^ -(z & 1);
      const L = x ? out[i - 1] : 0, U = y ? out[i - 256] : 0, UL = x && y ? out[i - 257] : 0;
      out[i] = L + U - UL + r;
    }
  }
  return out;
}

// Detailkacheln einer Zoomstufe rund um einen Punkt (kreisförmig, nur die nötigen Kacheln).
// Fehlende Kacheln liefern NaN; dann greift die gröbere Stufe.
export class Window {
  constructor(z, tx0, ty0, nt) {
    this.z = z; this.tx0 = tx0; this.ty0 = ty0; this.nt = nt;
    this.w = this.h = nt * 256;
    this.N = 256 * 2 ** z;
    this.ox = tx0 * 256 + 0.5; this.oy = ty0 * 256 + 0.5;
    this.grid = new Array(nt * nt).fill(null);
    this.loaded = 0;
  }
  static around(z, lat, lon, radiusM) {
    const tileM = 40075016 * Math.cos(lat * D2R) / 2 ** z;
    const n = Math.ceil((2 * radiusM) / tileM) + 1;
    const cx = lonToU(lon) * 2 ** z, cy = latToV(lat) * 2 ** z;
    const w = new Window(z, Math.floor(cx - n / 2), Math.floor(cy - n / 2), n);
    w.cx = cx; w.cy = cy; w.tileM = tileM; w.radius = radiusM;
    return w;
  }
  // Kacheln mit Abstand (m) ihres nächsten Punkts zum Mittelpunkt, nahe zuerst
  tiles() {
    const t = [];
    for (let y = 0; y < this.nt; y++) for (let x = 0; x < this.nt; x++) {
      const X = this.tx0 + x, Y = this.ty0 + y;
      const dx = Math.max(X - this.cx, 0, this.cx - X - 1), dy = Math.max(Y - this.cy, 0, this.cy - Y - 1);
      const d = Math.hypot(dx, dy) * this.tileM;
      if (d <= this.radius) t.push([X, Y, d]);
    }
    return t.sort((a, b) => a[2] - b[2]);
  }
  put(x, y, tile) { this.grid[(y - this.ty0) * this.nt + (x - this.tx0)] = tile; this.loaded++; }
  // Rohwert an ganzzahliger Fensterposition
  raw(ix, iy) {
    const t = this.grid[(iy >> 8) * this.nt + (ix >> 8)];
    return t ? t[((iy & 255) << 8) | (ix & 255)] : NODATA;
  }
  // NaN, wenn außerhalb oder ohne Daten
  atUV(u, v) {
    const gx = u * this.N - this.ox, gy = v * this.N - this.oy;
    if (gx < 0 || gy < 0 || gx >= this.w - 1 || gy >= this.h - 1) return NaN;
    const x = gx | 0, y = gy | 0, fx = gx - x, fy = gy - y;
    let a, b, c, e;
    const lx = x & 255, ly = y & 255;
    if (lx !== 255 && ly !== 255) {
      const t = this.grid[(y >> 8) * this.nt + (x >> 8)];
      if (!t) return NaN;
      const i = (ly << 8) | lx;
      a = t[i]; b = t[i + 1]; c = t[i + 256]; e = t[i + 257];
    } else {
      a = this.raw(x, y); b = this.raw(x + 1, y); c = this.raw(x, y + 1); e = this.raw(x + 1, y + 1);
    }
    if (a === NODATA || b === NODATA || c === NODATA || e === NODATA) return NaN;
    const top = a + (b - a) * fx, bot = c + (e - c) * fx;
    return top + (bot - top) * fy;
  }
  // Gipfelhöhen in die nächste Zelle eintragen
  burn(lat, lon, ele, maxLift) {
    const x = Math.round(lonToU(lon) * this.N - this.ox), y = Math.round(latToV(lat) * this.N - this.oy);
    if (x < 1 || y < 1 || x >= this.w - 1 || y >= this.h - 1) return;
    const t = this.grid[(y >> 8) * this.nt + (x >> 8)];
    if (!t) return;
    const k = ((y & 255) << 8) | (x & 255);
    if (t[k] === NODATA) return;
    let around = -1e9;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const v = this.raw(x + ox, y + oy);
      if (v !== NODATA) around = Math.max(around, v);
    }
    if (ele > t[k] && ele - around < maxLift) t[k] = ele;
  }
}
