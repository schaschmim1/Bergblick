// Rechen-Worker: Höhenmodell (grob für die ganzen Alpen, fein rund um den Standort),
// Panorama, sichtbare Gipfel, Karte, Suche und Foto-Ausrichtung.
import { Dem, Window, loadTerrarium, loadBundled, TILE_URL, lonToU, latToV, R_EARTH, D2R, R2D, distAz, drop, enu } from './terrain.js';
import { basisFromHPR, focalPx } from './camera.js';

let dem = null;
let peaks = null; // {lat, lon, ele, iso, name}
let pano = null;  // letztes Panorama (für die Ausrichtung)
const panos = new Map(); // die letzten Panoramen nach Anfrage-Nr.: Ausrichten nutzt genau das Panorama, das die App zeigt

// Detailstufen: je näher, desto feiner (Rasterweite in den Alpen ca. 13 / 26 / 52 m).
// Mitgeliefert: Zoom 11 für die ganzen Alpen (dort bis 120 km) und Zoom 12 für die deutschen und
// österreichischen Alpen (dort bis 50 km). Sonst und für Zoom 13 lädt die App bei Bedarf aus dem Netz.
const LEVELS = [{ z: 13, r: 8000 }, { z: 12, r: 25000, rBundled: 50000 }, { z: 11, r: 50000, rBundled: 120000 }];
let detail = { lat: 1e9, lon: 1e9, wins: [] };
const tileMem = new Map(); // "z/x/y" -> Int16Array, zuletzt benutzte zuletzt
let BASE = 'data';
let bundles = {}; // mitgelieferte Kacheln je Zoomstufe: {x0, y0, x1, y1, rows: ["0110…", …]}
const inBundle = (z, x, y) => { const b = bundles[z]; return !!b && x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && b.rows[y - b.y0][x - b.x0] === '1'; };
const bundleCovers = (z, lat, lon) => inBundle(z, Math.floor(lonToU(lon) * 2 ** z), Math.floor(latToV(lat) * 2 ** z));

// Nachladen für einen älteren Standort abbrechen, sobald ein neuer angefragt wird
let fullJob = 0;
const near = (o, lat, lon) => distAz(lat, lon, o.lat, o.lon)[0] < 300;
const post = (type, data, transfer) => self.postMessage({ type, ...data }, transfer || []);

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m.base);
    else if (m.type === 'panorama') {
      // quick: sofort mit dem, was schon im Speicher ist (grobes Modell, Übersichtsbild); sonst erst nachladen
      const wantDetail = m.detail !== false, wantSat = m.satellite !== false;
      const t0 = performance.now();
      // sector: nur dieser Blickbereich (Foto), dort Gelände laden und Spalten rechnen; ohne Satellitenfarben
      const sector = m.sector && m.sector[1] < 175 ? m.sector : null;
      fullJob = m.id; // jede neue Anfrage beendet das Nachladen für den vorigen Standort
      if (wantDetail && !m.quick) await ensureDetail(m.lat, m.lon, m.id, sector);
      const t1 = performance.now();
      if (!m.noSat) await ensureOverview();
      if (wantSat && !m.quick && !m.noSat) await ensureSat(m.lat, m.lon, m.id);
      const t2 = performance.now();
      if (fullJob !== m.id && !m.quick) throw new Error('abgebrochen');
      const haveDetail = wantDetail && near(detail, m.lat, m.lon) && (detail.full || (sector && covered(sector))), haveSat = wantSat && near(sat, m.lat, m.lon);
      const r = panorama({ ...m, sector, wins: near(detail, m.lat, m.lon) ? detail.wins : [], satWins: m.noSat ? [] : [...(haveSat ? sat.wins : []), ...(overview ? [overview] : [])] });
      r.complete = (!wantDetail || haveDetail) && (m.noSat || !wantSat || haveSat || typeof OffscreenCanvas === 'undefined');
      r.quick = !!m.quick; r.sector = sector; r.pid = m.id;
      r.times = { detail: Math.round(t1 - t0), sat: Math.round(t2 - t1), compute: r.ms };
      panos.set(m.id, pano);
      while (panos.size > 4) panos.delete(panos.keys().next().value);
      post('panorama', { id: m.id, ...r }, [r.seg.buffer, r.segD.buffer, r.segKind.buffer, r.runs.buffer, r.runOff.buffer, ...(r.runCol ? [r.runCol.buffer] : [])]);
    }
    else if (m.type === 'map') { const r = renderMap(m); post('map', { id: m.id, ...r }, [r.pixels]); }
    else if (m.type === 'reliefTile') { const r = await reliefTile(m); post('reliefTile', { id: m.id, ...r }, [r.pixels]); }
    else if (m.type === 'peaksIn') post('peaksIn', { id: m.id, peaks: peaksIn(m) });
    else if (m.type === 'align') {
      const keep = pano;
      if (m.panoId && panos.has(m.panoId)) pano = panos.get(m.panoId);
      try { post('align', { id: m.id, ...align(m) }); } finally { pano = keep; }
    }
    else if (m.type === 'search') post('search', { id: m.id, results: search(m.q, m.lat, m.lon) });
    else if (m.type === 'elev') post('elev', { id: m.id, elev: dem.elev(m.lat, m.lon), covered: dem.covers(m.lat, m.lon) });
    else if (m.type === 'prefetch') post('prefetch', { id: m.id, ...(await prefetch(m)) });
    else if (m.type === 'highest') post('highest', { id: m.id, ...highest(m) });
    else if (m.type === 'bundleInfo') post('bundleInfo', { id: m.id, levels: Object.values(bundles).map((b) => ({ z: b.z, count: b.count * 2 })) });
    else if (m.type === 'cacheBundle') post('cacheBundle', { id: m.id, ...(await cacheBundle(m)) });
  } catch (err) {
    post('error', { id: m.id, message: String(err && err.message || err) });
  }
};

async function init(base) {
  BASE = base;
  try { for (const l of (await (await fetch(`${base}/dem/bundles.json`)).json()).levels) bundles[l.z] = l; } catch { bundles = {}; }
  let pDem = 0, pPeaks = 0;
  const progress = () => post('progress', { value: pDem * 0.85 + pPeaks * 0.15 });
  const peaksP = fetch(`${base}/peaks.json`).then((r) => r.json()).then((j) => {
    const n = j.peaks.length;
    peaks = { lat: new Float64Array(n), lon: new Float64Array(n), ele: new Float32Array(n), iso: new Float32Array(n), name: new Array(n), n };
    j.peaks.forEach((p, i) => {
      peaks.lat[i] = p[0]; peaks.lon[i] = p[1]; peaks.ele[i] = p[2]; peaks.iso[i] = p[3]; peaks.name[i] = p[4];
    });
    pPeaks = 1; progress();
  });
  dem = await Dem.load(`${base}/dem`, (v) => { pDem = v; progress(); });
  await peaksP;
  for (let i = 0; i < peaks.n; i++) if (peaks.ele[i] < 0) peaks.ele[i] = Math.round(dem.elev(peaks.lat[i], peaks.lon[i]));
  burnPeaks();
  post('ready', { peakCount: peaks.n });
}

// Das grobe Modell (~210 m) rundet Gipfel ab: bekannte Gipfelhöhen in die nächste Zelle eintragen.
function burnPeaks() {
  const d = dem.data, w = dem.w;
  for (let i = 0; i < peaks.n; i++) {
    const x = Math.round(dem.px(peaks.lon[i])), y = Math.round(dem.py(peaks.lat[i]));
    if (x < 1 || y < 1 || x >= w - 1 || y >= dem.h - 1) continue;
    const k = y * w + x;
    let around = -1e9;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) around = Math.max(around, d[k + oy * w + ox]);
    const e = peaks.ele[i];
    if (e > d[k] && e - around < 350) d[k] = e; // unplausible Angaben (Tippfehler) ignorieren
  }
}

// ---------------------------------------------------------------- Detailkacheln

async function getTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let t = tileMem.get(key);
  if (t) { tileMem.delete(key); tileMem.set(key, t); return t; }
  t = inBundle(z, x, y) ? await loadBundled(`${BASE}/dem/${z}/${x}_${y}.bin`) : await loadTerrarium(z, x, y);
  tileMem.set(key, t);
  while (tileMem.size > 800) tileMem.delete(tileMem.keys().next().value);
  return t;
}

// Fenster und Kachelliste je Stufe: mitgelieferte Kacheln bis rBundled, Netzkacheln bis r
function plan(lat, lon) {
  return LEVELS.map((L) => {
    const r = L.rBundled && bundleCovers(L.z, lat, lon) ? L.rBundled : L.r;
    const w = Object.assign(Window.around(L.z, lat, lon, r), { r });
    const list = w.tiles().filter(([x, y, d]) => d <= L.r || inBundle(L.z, x, y));
    return { w, list };
  });
}

// Kachel liegt (teilweise) im Blickbereich sector = [Mitte, halbe Breite] in Grad? Ganz nahe Kacheln immer.
function tileInSector(w, X, Y, d, sector) {
  if (!sector || d < 1500) return true;
  let lo = 1e9, hi = -1e9;
  for (const [cx, cy] of [[X, Y], [X + 1, Y], [X, Y + 1], [X + 1, Y + 1]]) {
    const a = Math.atan2(cx - w.cx, w.cy - cy) * R2D; // Norden oben, im Uhrzeigersinn
    const da = ((a - sector[0] + 540) % 360) - 180;
    lo = Math.min(lo, da); hi = Math.max(hi, da);
  }
  if (hi - lo > 180) return true; // (kommt bei d ≥ 1,5 km nicht vor)
  return hi >= -sector[1] && lo <= sector[1];
}
// Ist dieser Blickbereich am aktuellen Standort schon geladen?
const covered = (sector) => (detail.sectors || []).some((s) => Math.abs(((s[0] - sector[0] + 540) % 360) - 180) + sector[1] <= s[1] + 0.01);

// Detailgelände um den Standort laden. Mit sector nur die Kacheln in diesem Blickbereich; was am selben
// Standort schon geladen ist, bleibt erhalten (später Rundum-Panorama lädt nur den Rest).
async function ensureDetail(lat, lon, id, sector = null) {
  if (!dem.covers(lat, lon)) { detail = { lat, lon, wins: [], full: true, loaded: new Set() }; return; }
  if (!near(detail, lat, lon)) {
    const levels = plan(lat, lon);
    detail = { lat, lon, wins: levels.map((l) => l.w), lists: levels.map((l) => l.list), loaded: new Set(), failed: 0, total: 0, full: false, sectors: [] };
  }
  const D = detail;
  if (D.full || (sector && covered(sector))) return;
  const jobs = [];
  D.wins.forEach((w, i) => { for (const [x, y, d] of D.lists[i]) if (!D.loaded.has(`${w.z}/${x}/${y}`) && tileInSector(w, x, y, d, sector)) jobs.push([w, x, y]); });
  let done = 0, failed = 0, aborted = false;
  const total = jobs.length;
  const fresh = [];
  const run = async () => {
    while (jobs.length) {
      if (fullJob !== id) { aborted = true; jobs.length = 0; break; }
      const [w, x, y] = jobs.shift();
      try { w.put(x, y, await getTile(w.z, x, y)); D.loaded.add(`${w.z}/${x}/${y}`); fresh.push([w, x, y]); } catch { failed++; }
      done++;
      if (done % 4 === 0 || done === total) post('detail', { id, done, total, failed });
    }
  };
  await Promise.all(Array.from({ length: 8 }, run));
  // Gipfelhöhen in die neuen Kacheln eintragen (nur die grobe Stufe: im feinen Raster erzeugt ein
  // einzelner angehobener Punkt eine Nadel)
  const coarse = fresh.filter(([w]) => w.z <= 11);
  if (coarse.length) {
    const r = D.wins[D.wins.length - 1].r * 1.1;
    for (let i = 0; i < peaks.n; i++) {
      if (Math.abs(peaks.lat[i] - lat) > r / 111000 || Math.abs(peaks.lon[i] - lon) > r / 75000) continue;
      const u = lonToU(peaks.lon[i]), v = latToV(peaks.lat[i]);
      for (const [w, x, y] of coarse) if (Math.floor(u * 2 ** w.z) === x && Math.floor(v * 2 ** w.z) === y) w.burn(peaks.lat[i], peaks.lon[i], peaks.ele[i], 100);
    }
  }
  if (aborted) throw new Error('abgebrochen');
  D.failed = failed; D.total = total;
  if (sector) D.sectors.push(sector); else D.full = true;
}

// Gebiet für den Offline-Betrieb vorladen (landet über den Service Worker im Speicher)
async function prefetch({ id, lat, lon, levels }) {
  const jobs = [];
  for (const { w, list } of plan(lat, lon)) for (const [x, y] of list) if (!inBundle(w.z, x, y)) jobs.push([w.z, x, y]);
  let done = 0, failed = 0, bytes = 0;
  const total = jobs.length;
  const run = async () => {
    while (jobs.length) {
      const [z, x, y] = jobs.shift();
      try { const r = await fetch(`${TILE_URL}/${z}/${x}/${y}.png`); if (!r.ok) throw 0; bytes += (await r.arrayBuffer()).byteLength; } catch { failed++; }
      done++;
      if (done % 5 === 0 || done === total) post('prefetch-progress', { id, done, total, failed });
    }
  };
  await Promise.all(Array.from({ length: 8 }, run));
  return { total, failed, bytes };
}

// Höchster Punkt im Umkreis r (m), z. B. um einen Gipfelstandort aufs Höhenmodell zu setzen
function highest({ lat, lon, r = 100 }) {
  const elev = makeSampler(), mPerUnit = 2 * Math.PI * R_EARTH * Math.cos(lat * D2R);
  const u0 = lonToU(lon), v0 = latToV(lat);
  let best = { lat, lon, ele: elev(u0, v0, 0) };
  for (let dy = -r; dy <= r; dy += 5) for (let dx = -r; dx <= r; dx += 5) {
    if (dx * dx + dy * dy > r * r) continue;
    const u = u0 + dx / mPerUnit, v = v0 + dy / mPerUnit, e = elev(u, v, Math.hypot(dx, dy));
    if (e > best.ele) best = { lat: lat - dy / 111320, lon: lon + dx / (111320 * Math.cos(lat * D2R)), ele: e };
  }
  return best;
}

// Alle mitgelieferten Detailkacheln einmal abrufen, damit der Service Worker sie offline vorhält
async function cacheBundle({ id }) {
  const jobs = [];
  for (const b of Object.values(bundles)) for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (inBundle(b.z, x, y)) jobs.push(`${BASE}/dem/${b.z}/${x}_${y}.bin`, `${BASE}/sat/${b.z}/${x}_${y}.jpg`);
  jobs.push(`${BASE}/sat/overview.json`, `${BASE}/sat/overview.jpg`);
  let done = 0, failed = 0;
  const total = jobs.length;
  const run = async () => {
    while (jobs.length) {
      const u = jobs.shift();
      try { const r = await fetch(u); if (!r.ok) throw 0; await r.arrayBuffer(); } catch { failed++; }
      done++;
      if (done % 16 === 0 || done === total) post('bundle-progress', { id, done, total, failed });
    }
  };
  await Promise.all(Array.from({ length: 4 }, run));
  return { total, failed };
}

// Höhe an (u, v) mit der feinsten vorhandenen Stufe für die Entfernung d; weiche Übergänge
function makeSampler(wins = detail.wins) {
  return (u, v, d) => {
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i];
      if (d > w.r) continue;
      const e = w.atUV(u, v);
      if (e !== e) continue;
      const fade = (d - 0.75 * w.r) / (0.25 * w.r);
      if (fade <= 0) return e;
      // im Randbereich mit der nächst gröberen Stufe mischen
      let c = NaN;
      for (let j = i + 1; j < wins.length && c !== c; j++) c = wins[j].atUV(u, v);
      if (c !== c) c = dem.atUV(u, v);
      return e + (c - e) * fade;
    }
    return dem.atUV(u, v);
  };
}

// ---------------------------------------------------------------- Satellitenfarben fürs Panorama

// Stufen nach Entfernung: nah hochauflösend online (Esri World Imagery), weiter weg die mitgelieferten
// Sentinel-2-Kacheln (Zoom 12 für DE/AT, 11 für die Alpen; außerhalb ebenfalls online). Ganz fern auf
// 64×64 gemittelt, damit nichts flimmert und der Speicher klein bleibt.
const ESRI = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const SAT_LEVELS = [
  { z: 15, r: 1500, online: true },
  { z: 13, r: 5000, online: true },
  { z: 12, r: 15000 },
  { z: 11, r: 50000 },
];
// Dahinter ein einziges Übersichtsbild der ganzen Alpen (~420 m je Pixel), wird einmal geladen
let overview = null, overviewP = null;
function ensureOverview() {
  if (typeof OffscreenCanvas === 'undefined') return null;
  return overviewP || (overviewP = (async () => {
    try {
      const meta = await (await fetch(`${BASE}/sat/overview.json`)).json();
      const bmp = await createImageBitmap(await (await fetch(`${BASE}/sat/overview.jpg`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      overview = new OverviewWin(meta, g.getImageData(0, 0, bmp.width, bmp.height).data, bmp.width, bmp.height);
      if (bmp.close) bmp.close();
    } catch { overviewP = null; }
  })());
}
let sat = { lat: 1e9, lon: 1e9, wins: [] };
const satMem = new Map(); // Schlüssel -> RGBA-Pixel, zuletzt benutzte zuletzt
let esriOk = true;        // ohne Freigabe (CORS) oder Netz: nur mitgelieferte Kacheln

async function decodeImage(url, size) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const bmp = await createImageBitmap(await r.blob());
  const c = new OffscreenCanvas(size, size), g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, size, size);
  if (bmp.close) bmp.close();
  return g.getImageData(0, 0, size, size).data;
}

async function satTile(L, x, y) {
  const size = L.size || 256, key = `${L.z}/${x}/${y}/${size}${L.online ? 'e' : ''}`;
  let t = satMem.get(key);
  if (t) { satMem.delete(key); satMem.set(key, t); return t; }
  if (!L.online && inBundle(L.z, x, y)) {
    try { t = await decodeImage(`${BASE}/sat/${L.z}/${x}_${y}.jpg`, size); } catch { t = null; }
  }
  if (!t) {
    if (!esriOk) throw new Error('offline');
    try { t = await decodeImage(ESRI(L.z, x, y), size); } catch (e) { if (e instanceof TypeError) esriOk = false; throw e; }
  }
  satMem.set(key, t);
  while (satMem.size > 220) satMem.delete(satMem.keys().next().value);
  return t;
}

class SatWin {
  constructor(L, lat, lon) {
    this.L = L; this.r = L.r; this.size = L.size || 256;
    this.base = Window.around(L.z, lat, lon, L.r);
    this.N = 2 ** L.z; this.grid = new Map();
  }
  put(x, y, t) { this.grid.set(x * 65536 + y, t); }
  // Farbe an (u, v) nach out schreiben; false ohne Daten
  color(u, v, out) {
    const gx = u * this.N, gy = v * this.N, tx = Math.floor(gx), ty = Math.floor(gy);
    const t = this.grid.get(tx * 65536 + ty);
    if (!t) return false;
    // bilinear innerhalb der Kachel (am Rand angeklemmt), sonst wirken nahe Hänge blockig
    const S = this.size, fx = Math.min(S - 1.001, Math.max(0, (gx - tx) * S - 0.5)), fy = Math.min(S - 1.001, Math.max(0, (gy - ty) * S - 0.5));
    const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
    const i = (y0 * S + x0) * 4, j = i + S * 4;
    for (let k = 0; k < 3; k++) {
      const top = t[i + k] + (t[i + 4 + k] - t[i + k]) * ax, bot = t[j + k] + (t[j + 4 + k] - t[j + k]) * ax;
      out[k] = top + (bot - top) * ay;
    }
    return true;
  }
}

async function ensureSat(lat, lon, id) {
  if (typeof OffscreenCanvas === 'undefined') return;
  if (near(sat, lat, lon)) return;
  const wins = SAT_LEVELS.filter((L) => !L.online || esriOk).map((L) => new SatWin(L, lat, lon));
  const jobs = [];
  for (const w of wins) for (const [x, y] of w.base.tiles()) jobs.push([w, x, y]);
  let done = 0, aborted = false;
  const total = jobs.length;
  const run = async () => {
    while (jobs.length) {
      if (fullJob !== id) { aborted = true; jobs.length = 0; break; }
      const [w, x, y] = jobs.shift();
      if (w.L.online && !esriOk) continue;
      try { w.put(x, y, await satTile(w.L, x, y)); } catch { /* gröbere Stufe springt ein */ }
      if (++done % 8 === 0) post('detail', { id, done, total, failed: 0, what: 'sat' });
    }
  };
  await Promise.all(Array.from({ length: 8 }, run));
  if (aborted) throw new Error('abgebrochen');
  sat = { lat, lon, wins: wins.filter((w) => w.grid.size) };
}

class OverviewWin {
  constructor(m, px, w, h) { this.r = Infinity; this.m = m; this.px = px; this.w = w; this.h = h; this.N = 2 ** m.z * m.tile; }
  color(u, v, out) {
    const fx = u * this.N - this.m.x0 * this.m.tile - 0.5, fy = v * this.N - this.m.y0 * this.m.tile - 0.5;
    if (fx < 0 || fy < 0 || fx >= this.w - 1 || fy >= this.h - 1) return false;
    const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0, t = this.px;
    const i = (y0 * this.w + x0) * 4, j = i + this.w * 4;
    // Schwarz = keine Daten (außerhalb der Alpen)
    if (t[i] + t[i + 1] < 3 || t[i + 4] + t[i + 5] < 3 || t[j] + t[j + 1] < 3 || t[j + 4] + t[j + 5] < 3) return false;
    for (let k = 0; k < 3; k++) {
      const top = t[i + k] + (t[i + 4 + k] - t[i + k]) * ax, bot = t[j + k] + (t[j + 4 + k] - t[j + k]) * ax;
      out[k] = top + (bot - top) * ay;
    }
    return true;
  }
}

// Satellitenfarbe für einen Geländepunkt in Entfernung d; im Randbereich einer Stufe weich zur nächsten
const satA = [0, 0, 0], satB = [0, 0, 0];
function satColor(wins, u, v, d, out) {
  for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    if (d > w.r || !w.color(u, v, out)) continue;
    const fade = (d - 0.7 * w.r) / (0.3 * w.r);
    if (fade > 0) {
      for (let j = i + 1; j < wins.length; j++) {
        if (wins[j].color(u, v, satB)) { for (let k = 0; k < 3; k++) out[k] += (satB[k] - out[k]) * fade; break; }
      }
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- Panorama

const SUN = (() => { const az = 215 * D2R, alt = 38 * D2R; return [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)]; })();

function panorama({ lat, lon, agl = 2, alt = null, maxDist = 200000, cols = 7200, wins = detail.wins, satWins = [], sector = null }) {
  // mit sector [Mitte, halbe Breite] nur diese Spalten rechnen (Foto); die übrigen bleiben leer
  const inSector = (a) => !sector || Math.abs(((a - sector[0] + 540) % 360) - 180) <= sector[1];
  const t0 = performance.now();
  const elev = makeSampler(wins);
  const u0 = lonToU(lon), v0 = latToV(lat);
  // Standorthöhe: höchster Geländepunkt im Umkreis von 20 m. GPS liegt oft ein paar Meter neben dem
  // Gipfel oder Grat; eine zu tiefe Augenhöhe würde die Sicht hinter dem eigenen Gipfel verstecken.
  let ground = elev(u0, v0, 0);
  const mPerUnit = 2 * Math.PI * R_EARTH * Math.cos(lat * D2R);
  for (const r of [8, 14, 20]) for (let a = 0; a < 12; a++) {
    const du = r * Math.sin(a * Math.PI / 6) / mPerUnit, dv = -r * Math.cos(a * Math.PI / 6) / mPerUnit;
    const e = elev(u0 + du, v0 + dv, r);
    if (e > ground) ground = e;
  }
  // GPS-Höhe aus dem Foto: auf Gipfeln liegt die GPS-Position oft 50–100 m neben dem höchsten Punkt,
  // das Gelände dort ist tiefer. Eine plausible GPS-Höhe über dem Gelände hat dann Vorrang.
  const h0 = alt != null && alt > ground + agl && alt < ground + 250 ? alt : ground + agl;

  // Gemeinsame Abtastdistanzen: dicht im Nahbereich, wachsend mit der Entfernung
  const Dl = [];
  for (let d = 15; d < maxDist; d += Math.max(8, d * (d < 50000 ? 0.0035 : 0.005))) Dl.push(d);
  const n = Dl.length;
  const D = Float64Array.from(Dl);
  const sinD = D.map((d) => Math.sin(d / R_EARTH)), cosD = D.map((d) => Math.cos(d / R_EARTH));
  const dropD = D.map(drop);

  const phi = lat * D2R, lam = lon * D2R, sp = Math.sin(phi), cp = Math.cos(phi);
  const mPerU = 2 * Math.PI * R_EARTH * cp; // Meter je Einheit u (lokal)
  const edges = [];          // pro Spalte [tan, d, sky]
  const runs = [];           // sichtbare Abschnitte: [tanOben, dStart, Schattierung, Höhe]
  const runEnd = [];         // Entfernung der letzten Probe je Abschnitt
  const useSat = satWins.length > 0;
  const runCol = [];         // Satellitenfarbe je Abschnitt (mit Luftperspektive), falls vorhanden
  const C = [0, 0, 0];
  let rC0 = 0, rC1 = 0, rC2 = 0;
  const runOff = new Uint32Array(cols + 1);
  const sky = new Float32Array(cols), skyD = new Float32Array(cols);
  // Horizont bei begrenzter Sicht (Dunst): oberste Kante, wenn nur Gelände bis VIS[i] sichtbar ist
  const VIS = [15000, 25000, 40000, 60000, 90000, 130000].filter((v) => v < maxDist * 0.9);
  const nV = VIS.length, skyV = new Float32Array(cols * nV);
  // je Spalte die markantesten Grate bis 40 km (für die Grobsuche beim Ausrichten)
  const RN = 8, ridgeT = new Float32Array(cols * RN).fill(NaN);

  for (let c = 0; c < cols; c++) {
    const th = (c / cols) * 2 * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    let best = -1e9, cand = -1, candT = 0, prevVisible = false;
    const list = [], gaps = [];
    runOff[c] = runs.length / 4;
    if (!inSector((c / cols) * 360)) {
      sky[c] = -90; skyD[c] = maxDist; skyV.fill(-90, c * nV, (c + 1) * nV); edges.push(list);
      continue;
    }
    let rD = 0, rS = -9, rE = 0; // letzter Abschnitt
    let vi = 0;
    for (let k = 0; k < n; k++) {
      while (vi < nV && D[k] > VIS[vi]) skyV[c * nV + vi++] = Math.atan(best) * R2D;
      const sLat = sp * cosD[k] + cp * sinD[k] * ct;
      const lon2 = lam + Math.atan2(st * sinD[k] * cp, cosD[k] - sp * sLat);
      const u = lon2 / (2 * Math.PI) + 0.5;
      const v = 0.5 - Math.log((1 + sLat) / (1 - sLat)) / (4 * Math.PI);
      const d = D[k];
      const h = elev(u, v, d);
      const t = (h - dropD[k] - h0) / d;
      if (t > best) {
        if (!prevVisible && cand >= 0) {
          const dc = D[cand];
          // Kante nur, wenn dahinter ein nennenswertes Stück verdeckt war
          if (d - dc > Math.max(120, dc * 0.06) && dc > 60) { list.push(candT, dc, 0); gaps.push(d - dc); }
          cand = -1;
        }
        // Schattierung des sichtbaren Geländes (Hangneigung gegen die Sonne)
        const step = Math.max(10, d * 0.002) / mPerU;
        const hx = elev(u + step, v, d), hy = elev(u, v - step, d);
        const gx = (hx - h) / (step * mPerU), gy = (hy - h) / (step * mPerU);
        const nl = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        let s = (-gx * SUN[0] - gy * SUN[1] + SUN[2]) * nl;
        s = 0.35 + 0.75 * Math.max(0, s);
        const snow = h > 2900 ? 1 : 0;
        let same;
        if (useSat) {
          if (!satColor(satWins, u, v, d, C)) { C[0] = 128; C[1] = 132; C[2] = 120; }
          else { const m = (C[0] + C[1] + C[2]) / 3; for (let q = 0; q < 3; q++) C[q] = m + (C[q] - m) * 1.18; } // etwas kräftiger
          // Hang zur Sonne leicht aufhellen (das Satellitenbild ist von oben), dann Dunst nach Entfernung
          const k = 1 + (0.62 + 0.5 * (s - 0.35) / 0.75 - 1) * 0.55;
          const hf = Math.min(0.86, 1 - Math.exp(-d / 42000));
          C[0] = C[0] * k * (1 - hf) + 188 * hf; C[1] = C[1] * k * (1 - hf) + 203 * hf; C[2] = C[2] * k * (1 - hf) + 222 * hf;
          same = Math.abs(C[0] - rC0) + Math.abs(C[1] - rC1) + Math.abs(C[2] - rC2) < 18;
        } else same = Math.abs(s - rS) < 0.08 && (rE > 2900) === !!snow;
        if (runs.length / 4 > runOff[c] && Math.abs(Math.log(d / rD)) < 0.05 && same) {
          runs[runs.length - 4] = t; // Abschnitt verlängern
          runEnd[runEnd.length - 1] = d;
        } else {
          runs.push(t, d, s, h); runEnd.push(d); rD = d; rS = s; rE = h;
          if (useSat) { runCol.push(C[0], C[1], C[2]); rC0 = C[0]; rC1 = C[1]; rC2 = C[2]; }
        }
        best = t; prevVisible = true;
      } else if (prevVisible) {
        cand = k - 1; candT = best; prevVisible = false;
      }
    }
    while (vi < nV) skyV[c * nV + vi++] = Math.atan(best) * R2D;
    if (cand >= 0) list.push(candT, D[cand], 1);
    else list.push(best, D[n - 1], 1);
    edges.push(list);
    const rk = [];
    for (let i = 0; i < gaps.length; i++) if (list[i * 3 + 1] < 40000) rk.push(i);
    rk.sort((a, b) => gaps[b] / list[b * 3 + 1] - gaps[a] / list[a * 3 + 1]);
    for (let q = 0; q < Math.min(RN, rk.length); q++) ridgeT[c * RN + q] = list[rk[q] * 3];
    sky[c] = Math.atan(list[list.length - 3]) * R2D; skyD[c] = list[list.length - 2];
  }
  runOff[cols] = runs.length / 4;

  // Kanten benachbarter Spalten zu Linien verbinden
  const seg = [], segD = [], segKind = [];
  const az = (c) => (c / cols) * 360;
  for (let c = 0; c < cols; c++) {
    const A = edges[c], B = edges[(c + 1) % cols];
    for (let i = 0; i < A.length; i += 3) {
      const ta = A[i], da = A[i + 1], isSky = A[i + 2];
      let bj = -1, bc = 1e9;
      for (let j = 0; j < B.length; j += 3) {
        if (isSky && B[j + 2]) { bj = j; bc = 0; break; }
        const dA = Math.abs(Math.atan(B[j]) - Math.atan(ta)) * R2D;
        const dr = Math.abs(Math.log(B[j + 1] / da));
        if (dA < 0.8 && dr < 0.12) {
          const cost = dA / 0.2 + dr / 0.04;
          if (cost < bc) { bc = cost; bj = j; }
        }
      }
      if (bj < 0) continue;
      const v1 = enu(az(c), Math.atan(ta) * R2D), v2 = enu(az(c + 1), Math.atan(B[bj]) * R2D);
      seg.push(v1[0], v1[1], v1[2], v2[0], v2[1], v2[2]);
      segD.push(Math.min(da, B[bj + 1]));
      segKind.push(isSky);
    }
  }

  const R = Float32Array.from(runs);

  // Sichtbare Gipfel: Horizont vor dem Gipfel aus den sichtbaren Abschnitten der Spalte
  const horizonBefore = (c, dist) => {
    let lo = runOff[c], hi = runOff[c + 1] - 1, best = -1e9;
    if (hi < lo) return best;
    // letzter Abschnitt, der vor dist beginnt
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (R[mid * 4 + 1] < dist) lo = mid; else hi = mid - 1; }
    if (R[lo * 4 + 1] < dist) {
      // Endet der Abschnitt vor dem Gipfel, verdeckt er ihn mit seiner Oberkante; reicht er bis zum Gipfel,
      // gehört er zum Gipfelhang und es zählt der Abschnitt davor.
      if (runEnd[lo] < dist) best = R[lo * 4];
      else best = lo > runOff[c] ? R[(lo - 1) * 4] : -1e9;
    }
    return best;
  };
  const vis = [];
  for (let i = 0; i < peaks.n; i++) {
    if (Math.abs(peaks.lat[i] - lat) > maxDist / 111000) continue;
    const [d, a] = distAz(lat, lon, peaks.lat[i], peaks.lon[i]);
    if (d > maxDist || d < 100 || !inSector(a)) continue;
    const pu = lonToU(peaks.lon[i]), pv = latToV(peaks.lat[i]);
    const ph = Math.max(peaks.ele[i], elev(pu, pv, d));
    const tp = (ph - drop(d) - h0) / d;
    const cc = Math.round(a / 360 * cols) % cols;
    const lim = d - Math.max(60, d * 0.02);
    let hz = Infinity;
    for (let o = -1; o <= 1; o++) hz = Math.min(hz, horizonBefore((cc + o + cols) % cols, lim));
    const tol = Math.max(0.0004, 20 / d);
    if (tp + tol >= hz) {
      const el = Math.atan(tp) * R2D;
      vis.push({ i, name: peaks.name[i], ele: peaks.ele[i], iso: peaks.iso[i], dist: d, az: a, el, v: enu(a, el) });
    }
  }

  pano = { lat, lon, h0, cols, sky, skyD, VIS, skyV, ridgeT, RN, seg: Float32Array.from(seg), segD: Float32Array.from(segD), segKind: Uint8Array.from(segKind), runs: R.slice(), runOff: runOff.slice() };
  return {
    lat, lon, h0, ground, cols, samples: n,
    detail: wins === detail.wins && wins.length ? { total: detail.total || 0, failed: detail.failed || 0 } : { total: 0, failed: 0 },
    seg: Float32Array.from(seg), segD: Float32Array.from(segD), segKind: Uint8Array.from(segKind),
    runs: R, runOff, runCol: useSat ? Uint8ClampedArray.from(runCol) : null,
    sky, skyD, peaks: vis, ms: Math.round(performance.now() - t0),
  };
}

// ---------------------------------------------------------------- Karte (Schummerung)

// Gipfel in einem Kartenausschnitt, die bedeutendsten zuerst
function peaksIn({ north, south, west, east, limit = 250 }) {
  const list = [];
  for (let i = 0; i < peaks.n; i++) {
    const la = peaks.lat[i], lo = peaks.lon[i];
    if (la > north || la < south || lo < west || lo > east) continue;
    list.push({ lat: la, lon: lo, name: peaks.name[i], ele: peaks.ele[i], s: peaks.iso[i] * 10 + peaks.ele[i] / 1000 });
  }
  list.sort((a, b) => b.s - a.s);
  return list.slice(0, limit);
}

// Reliefkachel für die Karte: aus den mitgelieferten Detailkacheln (Zoom 11/12), sonst aus dem groben Modell
async function reliefTile({ z, x, y }) {
  for (const zs of [12, 11]) {
    if (zs > z) continue;
    const f = 2 ** (z - zs), sx = Math.floor(x / f), sy = Math.floor(y / f);
    if (!inBundle(zs, sx, sy)) continue;
    let t;
    try { t = await getTile(zs, sx, sy); } catch { continue; }
    const pixels = new Uint8ClampedArray(256 * 256 * 4);
    const lat = 90 - 360 / Math.PI * Math.atan(Math.exp(((sy + 0.5) / 2 ** zs * 2 - 1) * Math.PI));
    const mpp = 40075016 * Math.cos(lat * D2R) / (256 * 2 ** zs); // Meter je Quellpixel
    const at = (u, v) => { u = Math.max(0, Math.min(255, u)); v = Math.max(0, Math.min(255, v)); const i = Math.floor(u), j = Math.floor(v), a = Math.min(255, i + 1), b = Math.min(255, j + 1), fu = u - i, fv = v - j; return (t[j * 256 + i] * (1 - fu) + t[j * 256 + a] * fu) * (1 - fv) + (t[b * 256 + i] * (1 - fu) + t[b * 256 + a] * fu) * fv; };
    const ox = (x - sx * f) * 256 / f, oy = (y - sy * f) * 256 / f, st = 1 / f;
    const lx = -0.6, ly = -0.6, lz = 0.53;
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
      const u = ox + (i + 0.5) * st - 0.5, v = oy + (j + 0.5) * st - 0.5;
      const e = at(u, v);
      const ua = Math.max(0, u - 1), ub = Math.min(255, u + 1), va = Math.max(0, v - 1), vb = Math.min(255, v + 1);
      const dx = (at(ub, v) - at(ua, v)) / ((ub - ua) * mpp), dy = (at(u, vb) - at(u, va)) / ((vb - va) * mpp);
      const nz = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const sh = Math.max(0.25, Math.min(1.25, (-dx * lx * nz + dy * ly * nz + lz * nz) / 0.85));
      const [r, g, b] = tint(e), o = (j * 256 + i) * 4;
      pixels[o] = r * sh; pixels[o + 1] = g * sh; pixels[o + 2] = b * sh; pixels[o + 3] = 255;
    }
    return { pixels: pixels.buffer };
  }
  const lon = (x + 0.5) / 2 ** z * 360 - 180, lat = 90 - 360 / Math.PI * Math.atan(Math.exp(((y + 0.5) / 2 ** z * 2 - 1) * Math.PI));
  return { pixels: renderMap({ lat, lon, zoom: z, w: 256, h: 256, noPeaks: true }).pixels };
}

function renderMap({ lat, lon, zoom, w, h, noPeaks = false }) {
  const scale = 2 ** (zoom - dem.z); // Bildschirmpixel pro DEM-Pixel
  const cx = dem.px(lon), cy = dem.py(lat);
  const pixels = new Uint8ClampedArray(w * h * 4);
  const mpp = (40075016 * Math.cos(lat * D2R)) / (256 * 2 ** zoom); // Meter pro Bildschirmpixel
  const step = 1 / scale;
  const lx = -0.6, ly = -0.6, lz = 0.53; // Licht von Nordwest
  for (let j = 0; j < h; j++) {
    const gy = cy + (j - h / 2) / scale;
    for (let i = 0; i < w; i++) {
      const gx = cx + (i - w / 2) / scale;
      const e = dem.at(gx, gy);
      const dx = (dem.at(gx + step, gy) - dem.at(gx - step, gy)) / (2 * mpp);
      const dy = (dem.at(gx, gy + step) - dem.at(gx, gy - step)) / (2 * mpp);
      const nz = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      let s = (-dx * lx * nz + dy * ly * nz + lz * nz) / 0.85; // dy wächst nach Süden
      s = Math.max(0.25, Math.min(1.25, s));
      const [r, g, b] = tint(e);
      const o = (j * w + i) * 4;
      pixels[o] = r * s; pixels[o + 1] = g * s; pixels[o + 2] = b * s; pixels[o + 3] = 255;
    }
  }
  if (noPeaks) return { pixels: pixels.buffer, w, h, peaks: [] };
  // Gipfel im Ausschnitt, nach Bedeutung
  const list = [];
  const x0 = cx - w / 2 / scale, x1 = cx + w / 2 / scale, y0 = cy - h / 2 / scale, y1 = cy + h / 2 / scale;
  for (let i = 0; i < peaks.n; i++) {
    const px = dem.px(peaks.lon[i]); if (px < x0 || px > x1) continue;
    const py = dem.py(peaks.lat[i]); if (py < y0 || py > y1) continue;
    list.push({ i, x: (px - cx) * scale + w / 2, y: (py - cy) * scale + h / 2, name: peaks.name[i], ele: peaks.ele[i], s: peaks.iso[i] * 10 + peaks.ele[i] / 1000 });
  }
  list.sort((a, b) => b.s - a.s);
  return { pixels: pixels.buffer, w, h, peaks: list.slice(0, 400) };
}

function tint(e) {
  if (e <= 1) return [170, 200, 225];
  const stops = [[0, 120, 160, 100], [600, 160, 185, 115], [1200, 200, 190, 140], [1800, 185, 160, 125], [2500, 170, 155, 145], [3000, 225, 225, 225], [4800, 255, 255, 255]];
  for (let k = 1; k < stops.length; k++) {
    if (e < stops[k][0]) {
      const a = stops[k - 1], b = stops[k], f = (e - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  return [255, 255, 255];
}

// ---------------------------------------------------------------- Suche

function search(q, lat, lon) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const nq = norm(q);
  const res = [];
  for (let i = 0; i < peaks.n; i++) {
    const nm = norm(peaks.name[i]);
    const k = nm.indexOf(nq);
    if (k < 0) continue;
    let s = peaks.iso[i] + peaks.ele[i] / 500 + (k === 0 ? 20 : 0);
    if (lat != null) s -= distAz(lat, lon, peaks.lat[i], peaks.lon[i])[0] / 20000;
    res.push({ i, name: peaks.name[i], lat: peaks.lat[i], lon: peaks.lon[i], ele: peaks.ele[i], s });
  }
  res.sort((a, b) => b.s - a.s);
  return res.slice(0, 25);
}

// ---------------------------------------------------------------- Foto-Ausrichtung

// Bildmerkmale: Helligkeit, Kanten (hell oben / dunkel unten), Textur
function features(px, w, h) {
  const L = new Float32Array(w * h), R = new Float32Array(w * h), G = new Float32Array(w * h), B = new Float32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    R[i] = px[j]; G[i] = px[j + 1]; B[i] = px[j + 2];
    L[i] = 0.3 * px[j] + 0.55 * px[j + 1] + 0.15 * px[j + 2];
  }
  const E = new Float32Array(w * h), T = new Float32Array(w * h);
  for (let y = 2; y < h - 2; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const up = L[i - w] + L[i - 2 * w], dn = L[i + w] + L[i + 2 * w];
    E[i] = Math.max(0, up - dn) / 2;
    T[i] = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + w] - L[i - w]);
  }
  normalize(E, 0.985); normalize(T, 0.95);
  return { L, R, G, B, E, T };
}

function normalize(A, q) {
  const s = [];
  for (let i = 0; i < A.length; i += 5) if (A[i] > 0) s.push(A[i]);
  s.sort((a, b) => a - b);
  const p = s[Math.floor(s.length * q)] || 1;
  for (let i = 0; i < A.length; i++) A[i] = Math.min(1, A[i] / p);
}

// Horizont im Foto: Himmel/Gelände-Segmentierung je Spalte mit Farbmodellen, die aus dem Bild
// selbst gelernt werden (oben Himmel, unten Gelände), plus Kantenbonus; über Spalten per
// dynamischer Programmierung zusammenhängend. Zweiter Durchgang mit verfeinerten Modellen.
function kmeans(pts, k, iters = 8) {
  const n = pts.length / 3;
  if (n < k) return [];
  const C = [];
  for (let j = 0; j < k; j++) { const i = Math.floor((j + 0.5) / k * n) * 3; C.push([pts[i], pts[i + 1], pts[i + 2], 0]); }
  for (let it = 0; it < iters; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i += 3) {
      let bj = 0, bd = 1e18;
      for (let j = 0; j < k; j++) { const d = (pts[i] - C[j][0]) ** 2 + (pts[i + 1] - C[j][1]) ** 2 + (pts[i + 2] - C[j][2]) ** 2; if (d < bd) { bd = d; bj = j; } }
      acc[bj][0] += pts[i]; acc[bj][1] += pts[i + 1]; acc[bj][2] += pts[i + 2]; acc[bj][3]++;
    }
    for (let j = 0; j < k; j++) if (acc[j][3]) C[j] = [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3], acc[j][3]];
  }
  return C.filter((c) => c[3] > n * 0.03);
}

function skyProb(F, w, h, skyC, gndC) {
  const { R, G, B, T } = F;
  const S = new Float32Array(w * h);
  const md = (C, r, g, b) => { let m = 1e18; for (const c of C) m = Math.min(m, (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2); return Math.sqrt(m); };
  // Weiß (Schnee oder Wolke) ist farblich nicht vom Himmel zu trennen: neutral werten
  let skyMax = 0;
  for (const c of skyC) skyMax = Math.max(skyMax, 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2]);
  for (let i = 0; i < w * h; i++) {
    const r = R[i], g = G[i], b = B[i];
    const ds = md(skyC, r, g, b), dg = md(gndC, r, g, b);
    let p = dg / (ds + dg + 1e-3);
    const l = 0.3 * r + 0.55 * g + 0.15 * b, sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (l > skyMax + 20 && sat < 60) p = 0.5 + (p - 0.5) * 0.2;
    // weit weg von beiden Modellen: unsicher
    const near = Math.min(ds, dg);
    if (near > 60) p = 0.5 + (p - 0.5) * Math.max(0.3, 60 / near);
    p *= 1 - 0.6 * T[i]; // Textur spricht gegen Himmel
    S[i] = p;
  }
  return S;
}

// Kosten je Spalte und Zeile, wenn der Horizont dort läge:
// Nicht-Himmel oberhalb + Himmel unterhalb (in Pixeln), minus Kantenbonus.
// Oben im Bild darf etwas den Himmel verdecken (Höhlendecke, Äste, Dach): ein solcher Bereich ab der
// Oberkante kostet nur seine Himmelspixel plus einen festen Betrag. occ[i] = Unterkante dieses Bereichs.
function unary(S, E, w, h) {
  const U = new Float32Array(w * h), occ = new Int16Array(w * h);
  const cOcc = 0.05 * h;
  for (let x = 0; x < w; x++) {
    let below = 0;
    for (let y = 0; y < h; y++) below += S[y * w + x];
    let above = 0, ps = 0, best = 0, bo = 0; // best = min über o ≤ y von (Himmel in [0,o) − Nicht-Himmel in [0,o) + cOcc)
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      const v = ps - (y - ps) + cOcc;
      if (y > 0 && v < best) { best = v; bo = y; }
      U[i] = above + best + below - 3 * E[i];
      occ[i] = bo;
      above += 1 - S[i]; below -= S[i]; ps += S[i];
    }
  }
  return { U, occ };
}

function segmentDP(U, w, h) {
  const lam = 0.35;
  const prev = new Float32Array(h), tmp = new Float32Array(h), arg = new Int32Array(h);
  const back = new Int32Array(w * h);
  for (let y = 0; y < h; y++) prev[y] = U[y * w];
  for (let x = 1; x < w; x++) {
    for (let y = 0; y < h; y++) { tmp[y] = prev[y]; arg[y] = y; }
    for (let y = 1; y < h; y++) if (tmp[y - 1] + lam < tmp[y]) { tmp[y] = tmp[y - 1] + lam; arg[y] = arg[y - 1]; }
    for (let y = h - 2; y >= 0; y--) if (tmp[y + 1] + lam < tmp[y]) { tmp[y] = tmp[y + 1] + lam; arg[y] = arg[y + 1]; }
    for (let y = 0; y < h; y++) { prev[y] = U[y * w + x] + tmp[y]; back[y * w + x] = arg[y]; }
  }
  let by = 0;
  for (let y = 1; y < h; y++) if (prev[y] < prev[by]) by = y;
  const ys = new Float32Array(w);
  for (let x = w - 1; x >= 0; x--) { ys[x] = by; if (x > 0) by = back[by * w + x]; }
  return ys;
}

function boxBlur(A, w, h, r) {
  const t = new Float32Array(A.length), o = new Float32Array(A.length);
  for (let y = 0; y < h; y++) { let m = 0; for (let x = -r; x < w + r; x++) { if (x + r < w) m += A[y * w + Math.min(w - 1, x + r)]; else m += A[y * w + w - 1]; if (x - r - 1 >= 0) m -= A[y * w + x - r - 1]; else m -= A[y * w]; if (x >= 0 && x < w) t[y * w + x] = m / (2 * r + 1); } }
  for (let x = 0; x < w; x++) { let m = 0; for (let y = -r; y < h + r; y++) { m += t[Math.min(h - 1, Math.max(0, y + r)) * w + x]; m -= t[Math.min(h - 1, Math.max(0, y - r - 1)) * w + x]; if (y >= 0 && y < h) o[y * w + x] = m / (2 * r + 1); } }
  return o;
}

function photoSkyline(F, w, h, hint = {}) {
  const { R, G, B, T, E } = F;
  const sample = (pred) => {
    const pts = [];
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (pred(x, y)) { const i = y * w + x; pts.push(R[i], G[i], B[i]); }
    return pts;
  };
  // Startmodelle: Himmel = glatte, blaue Pixel in den oberen 60 % (wo auch immer, z. B. unter einer
  // Höhlendecke); gibt es kaum Blau (bedeckt), glatte Pixel im oberen Zehntel. Unteres Drittel = Gelände.
  const blue = (i) => B[i] > R[i] + 18 && B[i] >= G[i] && B[i] > 110;
  // je Spalte nur das oberste blaue Stück (darunter können bläuliche ferne Berge im Dunst liegen)
  const blueSky = [];
  for (let x = 0; x < w; x += 2) {
    let y0 = -1;
    for (let y = 0; y < h * 0.6; y += 2) { const i = y * w + x; if (T[i] < 0.3 && blue(i)) { y0 = y; break; } }
    if (y0 < 0) continue;
    for (let y = y0; y < Math.min(h * 0.6, y0 + h * 0.08); y += 2) { const i = y * w + x; if (!(T[i] < 0.3 && blue(i))) break; blueSky.push(R[i], G[i], B[i]); }
  }
  const topSky = sample((x, y) => y < h * 0.12 && T[y * w + x] < 0.35);
  let skyC = kmeans(blueSky.length > topSky.length * 0.5 ? blueSky : topSky, 3);
  let gndC = kmeans(sample((x, y) => y > h * 0.7), 4);
  if (!skyC.length) skyC = [[200, 210, 225, 1]];
  if (!gndC.length) gndC = [[80, 80, 70, 1]];
  const S = skyProb(F, w, h, skyC, gndC);
  // Glätte im Vergleich zum sicheren Himmel: ferne Berge im Dunst haben fast die Himmelsfarbe, sind aber
  // nicht so glatt. Bezug ist die Textur des Himmels in diesem Bild (Wolken, Rauschen).
  if (hint.texSky !== false) {
    const Tb = boxBlur(T, w, h, 2), ref = [];
    for (let i = 0; i < w * h * 0.6; i += 7) if (S[i] > 0.85) ref.push(Tb[i]);
    if (ref.length > 200) {
      ref.sort((a, b) => a - b);
      const ts = Math.max(0.004, ref[Math.floor(ref.length / 2)]);
      // nur bläuliche Pixel (Dunstberge); weiße und graue Wolken bleiben unberührt
      for (let i = 0; i < w * h; i++) if (B[i] > R[i] + 18) S[i] *= Math.min(1, Math.max(0.15, 1 - (Tb[i] - 2.5 * ts) / (6 * ts)));
    }
  }
  const { U, occ } = unary(S, E, w, h);
  const ys = segmentDP(U, w, h);
  // Unterkante der Verdeckung je Spalte (0 = keine)
  const ob = new Int16Array(w);
  for (let x = 0; x < w; x++) ob[x] = occ[Math.round(ys[x]) * w + x];
  // je Spalte bestmögliche Kosten (Bezug für den Abgleich)
  const Umin = new Float32Array(w).fill(1e9);
  for (let i = 0; i < w * h; i++) { const x = i % w; if (U[i] < Umin[x]) Umin[x] = U[i]; }
  return { ys, U, Umin, S, ob };
}

function blur(A, w, h, rx, ry) {
  const t = new Float32Array(A.length), o = new Float32Array(A.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0; for (let k = -rx; k <= rx; k++) { const xx = x + k; if (xx >= 0 && xx < w) m = Math.max(m, A[y * w + xx]); }
    t[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0; for (let k = -ry; k <= ry; k++) { const yy = y + k; if (yy >= 0 && yy < h) m = Math.max(m, t[yy * w + x] * (1 - Math.abs(k) / (ry + 1))); }
    o[y * w + x] = m;
  }
  return o;
}

// Farbkontrast oben/unten je Pixel (Fenster k): stark an Horizont und Graten, egal ob Schnee oder Fels
function contrastMap(F, w, h, k = 4) {
  const { R, G, B, L } = F;
  const E = new Float32Array(w * h);
  const pr = new Float32Array(h + 1), pg = new Float32Array(h + 1), pb = new Float32Array(h + 1), pl = new Float32Array(h + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      pr[y + 1] = pr[y] + R[i]; pg[y + 1] = pg[y] + G[i]; pb[y + 1] = pb[y] + B[i]; pl[y + 1] = pl[y] + L[i];
    }
    for (let y = k; y < h - k; y++) {
      const dr = (pr[y] - pr[y - k]) - (pr[y + k + 1] - pr[y + 1]);
      const dg = (pg[y] - pg[y - k]) - (pg[y + k + 1] - pg[y + 1]);
      const db = (pb[y] - pb[y - k]) - (pb[y + k + 1] - pb[y + 1]);
      const dl = (pl[y] - pl[y - k]) - (pl[y + k + 1] - pl[y + 1]);
      E[y * w + x] = (0.7 * Math.sqrt(dr * dr + dg * dg + db * db) + 0.6 * Math.max(0, dl) + 0.4 * Math.max(0, -dl)) / k; // Schnee vor Himmel: unten heller
    }
  }
  normalize(E, 0.98);
  return E;
}

// Dichter Abgleich: Wie gut erklärt die Entfernung des sichtbaren Geländes (aus dem Panorama) Helligkeit
// und Farbe im Foto? Ferne Hänge liegen im Dunst heller und blauer, der Himmel ist am hellsten. Das Maß
// (Transinformation) braucht keine Kanten und keine Himmelserkennung und ist daher robust gegen Wolken,
// Dunst und schwache Horizonte; es legt Neigung und groben Ausschnitt fest, die Kanten dann die Feinheiten.
const DCLS = [1500, 4000, 10000, 25000, 60000]; // Entfernungsklassen; dazu Himmel
function makeMI(px, w, h, GW, ob = null) {
  const GH = Math.max(8, Math.round(GW * h / w)), n = GW * GH;
  const fL = new Float32Array(n), fB = new Float32Array(n), masked = new Uint8Array(n);
  const sx = w / GW, sy = h / GH;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    let l = 0, b = 0, c = 0, hid = 0;
    for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy++) for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx++) {
      const j = (yy * w + xx) * 4; l += 0.3 * px[j] + 0.55 * px[j + 1] + 0.15 * px[j + 2]; b += px[j + 2] - px[j]; c++;
      if (ob && yy < ob[xx] + 3) hid++;
    }
    fL[y * GW + x] = l / c; fB[y * GW + x] = b / c; masked[y * GW + x] = hid > c * 0.3 ? 1 : 0;
  }
  // verdeckte Zellen (Höhlendecke usw.) zählen nicht mit
  let nAct = 0;
  for (let i = 0; i < n; i++) if (!masked[i]) nAct++;
  const rank = (A, k) => { const s = Float32Array.from(A.filter((_, i) => !masked[i])).sort(); const th = []; for (let q = 1; q < k; q++) th.push(s[Math.floor(q * s.length / k)]); return Uint8Array.from(A, (v) => { let lo = 0; for (let q = 0; q < k - 1; q++) if (v >= th[q]) lo = q + 1; return lo; }); };
  const qL = rank(fL, 8), qB = rank(fB, 3), NF = 24;
  const feat = Uint8Array.from(qL, (v, i) => v * 3 + qB[i]);
  const ND = DCLS.length + 2, H = new Float32Array(ND * NF), hd = new Float32Array(ND), hf = new Float32Array(NF);
  for (let i = 0; i < n; i++) if (!masked[i]) hf[feat[i]]++;
  const { runs, runOff, cols } = pano;
  // Entfernungsklasse in Panoramaspalte cc bei Höhenwinkel-Tangens t (ND - 1 = Himmel)
  const cls = (cc, t) => {
    let lo = runOff[cc], hi = runOff[cc + 1] - 1, f = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (runs[m * 4] >= t) { f = m; hi = m - 1; } else lo = m + 1; }
    if (f < 0) return ND - 1;
    const d = runs[f * 4 + 1]; let k = 0;
    while (k < DCLS.length && d >= DCLS[k]) k++;
    return k;
  };
  const value = (dc, off) => { // off: Zeilenversatz in dc (Höhe GH + 2 M) oder 0
    H.fill(0); hd.fill(0);
    let m = 0;
    for (let i = 0; i < n; i++) { const c = dc[i + off]; if (c === 255 || masked[i]) continue; H[c * NF + feat[i]]++; hd[c]++; m++; }
    if (m < nAct * 0.6) return 0;
    let s = 0;
    for (let a = 0; a < ND; a++) { if (!hd[a]) continue; for (let b = 0; b < NF; b++) { const p = H[a * NF + b]; if (p) s += p * Math.log(p * nAct / (hd[a] * hf[b])); } }
    return s / m;
  };
  const dc = new Uint8Array(n);
  // genau, mit Drehung
  const exact = (hd0, pt, ro, fov) => {
    const B = basisFromHPR(hd0, pt, ro), F = focalPx(GW, fov);
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const dx = x + 0.5 - GW / 2, dy = y + 0.5 - GH / 2;
      const e = B.f[0] * F + B.r[0] * dx - B.u[0] * dy, nn = B.f[1] * F + B.r[1] * dx - B.u[1] * dy, u = B.f[2] * F + B.r[2] * dx - B.u[2] * dy;
      const cc = ((Math.round(Math.atan2(e, nn) * R2D / 360 * cols) % cols) + cols) % cols;
      dc[y * GW + x] = runOff[cc + 1] > runOff[cc] || pano.sky[cc] === pano.sky[cc] ? cls(cc, u / Math.hypot(e, nn)) : 255;
    }
    return value(dc, 0);
  };
  // Suche über die Neigung für eine Richtung: Neigung als senkrechte Verschiebung genähert (wie die Grobsuche)
  let tall = null;
  const scan = (hd0, fov, maxPitch, step) => {
    const F = focalPx(GW, fov), M = Math.ceil(F * Math.tan(maxPitch * D2R)), TH = GH + 2 * M;
    if (!tall || tall.length < GW * TH) tall = new Uint8Array(GW * TH);
    // tall ist zeilenweise so angelegt, dass Versatz o einem Startindex o * GW entspricht
    for (let x = 0; x < GW; x++) {
      const a = Math.atan((x + 0.5 - GW / 2) / F), ca = Math.cos(a);
      const cc = ((Math.round((hd0 + a * R2D) / 360 * cols) % cols) + cols) % cols;
      const ok = runOff[cc + 1] > runOff[cc] || pano.sky[cc] === pano.sky[cc];
      for (let k = 0; k < TH; k++) tall[k * GW + x] = ok ? cls(cc, (GH / 2 + M - k - 0.5) * ca / F) : 255;
    }
    let best = -1, bo = 0;
    for (let o = 0; o <= 2 * M; o += step) { const v = value(tall, o * GW); if (v > best) { best = v; bo = o; } }
    if (step > 1) { const b0 = bo; for (let o = Math.max(0, b0 - step + 1); o <= Math.min(2 * M, b0 + step - 1); o++) if (o !== b0) { const v = value(tall, o * GW); if (v > best) { best = v; bo = o; } } }
    // o = M entspricht Neigung 0; größeres o = Bild zeigt höher liegende Zeilen = Kamera nach oben geneigt
    return [best, Math.atan((M - bo) / F) * R2D];
  };
  return { exact, scan, GW, GH };
}

function align({ pixels, w, h, hint }) {
  if (!pano) throw new Error('Kein Panorama berechnet');
  const t0 = performance.now();
  const F = features(new Uint8ClampedArray(pixels), w, h);
  const { ys, U, Umin, S, ob } = photoSkyline(F, w, h, hint);
  const E = contrastMap(F, w, h, 4);
  // verdeckte Bereiche oben (Höhlendecke usw.) samt ihrer Unterkante zählen nicht als Kante
  for (let x = 0; x < w; x++) if (ob[x] > 0) for (let y = 0; y < Math.min(h, ob[x] + 6); y++) E[y * w + x] = 0;
  const MI = makeMI(new Uint8ClampedArray(pixels), w, h, 48, ob);
  const AMI = hint.wMI ?? 1.0;
  // Kompass im Foto: kleine Abweichungen normal, große unwahrscheinlich
  const prior = (hd) => { if ((hint.headingRange ?? 180) > 45) return 0; const d = Math.abs(((hd - hint.heading + 540) % 360) - 180); return 0.15 * (Math.max(0, d - 4) / 15) ** 2; };
  // Brennweite aus dem Foto: Bildwinkel nur wenig abweichend
  const fovPrior = (f) => (Array.isArray(hint.fovRange) ? 0 : 25 * Math.max(0, Math.abs(f / hint.hfov - 1) - 0.02) ** 2);
  const priors = (p) => prior(p.heading) + fovPrior(p.hfov);
  const Ef = blur(E, w, h, 0, 2);
  const tPre = performance.now() - t0;

  const cols = pano.cols;
  // Horizontlinien: volle Sicht und begrenzte Sicht (ferne Berge im Dunst unsichtbar).
  // Nur Stufen, die sich spürbar vom vollen Horizont unterscheiden.
  const toVec = (el) => {
    const SV = new Float32Array(cols * 3), T = new Float32Array(cols);
    for (let c = 0; c < cols; c++) { const e = el(c), v = enu(c / cols * 360, e); SV[c * 3] = v[0]; SV[c * 3 + 1] = v[1]; SV[c * 3 + 2] = v[2]; T[c] = Math.tan(e * D2R); }
    return { SV, T };
  };
  const skies = [{ vis: Infinity, ...toVec((c) => pano.sky[c]) }];
  const nV = pano.VIS.length;
  let prevEl = (c) => pano.sky[c];
  for (let vi = nV - 1; vi >= 0; vi--) {
    const el = (c) => pano.skyV[c * nV + vi];
    let diff = 0;
    for (let c = 0; c < cols; c += 4) if (Math.abs(el(c) - prevEl(c)) > 0.08) diff++;
    if (diff < cols / 4 * 0.03 || pano.VIS[vi] < 25000) continue;
    skies.push({ vis: pano.VIS[vi], ...toVec(el) });
    prevEl = el;
  }
  // höchstens zwei Dunst-Stufen: die nächsten zu 80 und 40 km
  if (skies.length > 3) {
    const pick = (t) => skies.slice(1).reduce((a, b) => (Math.abs(Math.log(b.vis / t)) < Math.abs(Math.log(a.vis / t)) ? b : a));
    const a = pick(80000), b = pick(40000);
    skies.splice(1, skies.length - 1, ...(a === b ? [a] : [a, b]));
  }
  if (hint.fullSkyOnly) skies.length = 1;
  // Grate (nicht Horizont) bis 30 km für die Feinprüfung
  const ridgeAll = [];
  for (let i = 0; i < pano.segD.length; i++) if (!pano.segKind[i] && pano.segD[i] < 30000) ridgeAll.push(i);

  const cap = 0.3 * h;
  let SV = skies[0].SV, ridge = ridgeAll;
  const useSky = (k) => { SV = skies[k].SV; const v = skies[k].vis; ridge = v < 30000 ? ridgeAll.filter((i) => pano.segD[i] < v) : ridgeAll; inner = innerAll.filter((l) => l.vis < v * 0.9); };

  // projiziert den Horizont spaltenweise in ein Bild der Größe w × h (oberster Punkt je Bildspalte)
  const makeProjector = (ypred, w, h) => (hd, pt, ro, fov) => {
    const Bs = basisFromHPR(hd, pt, ro), Fp = focalPx(w, fov);
    ypred.fill(NaN);
    const half = Math.atan(Math.hypot(w, h) / 2 / Fp) * R2D + 1;
    const step = Math.max(1, Math.floor((fov / w) / (360 / cols)));
    const c0 = Math.floor((hd - half) / 360 * cols), c1 = Math.ceil((hd + half) / 360 * cols);
    let px = NaN, py = NaN;
    for (let c = c0; c <= c1; c += step) {
      const k = (((c % cols) + cols) % cols) * 3;
      const vx = SV[k], vy = SV[k + 1], vz = SV[k + 2];
      const Z = vx * Bs.f[0] + vy * Bs.f[1] + vz * Bs.f[2];
      if (Z < 0.1) { px = NaN; continue; }
      const x = w / 2 + Fp * (vx * Bs.r[0] + vy * Bs.r[1] + vz * Bs.r[2]) / Z;
      const y = h / 2 - Fp * (vx * Bs.u[0] + vy * Bs.u[1] + vz * Bs.u[2]) / Z;
      if (px === px && Math.abs(x - px) < w / 3) {
        const xa = Math.max(0, Math.ceil(Math.min(px, x))), xb = Math.min(w - 1, Math.floor(Math.max(px, x)));
        for (let xi = xa; xi <= xb; xi++) {
          const f = x === px ? 0 : (xi - px) / (x - px);
          const yi = py + (y - py) * f;
          if (!(ypred[xi] <= yi)) ypred[xi] = yi;
        }
      }
      px = x; py = y;
    }
    return Fp;
  };
  const ypred = new Float32Array(w);
  const projectSky = makeProjector(ypred, w, h);
  // Innere Silhouetten: Umriss des Geländes bis 15 bzw. 25 km. Nahe Bergrücken heben sich durch
  // den Dunst fast immer vom Hintergrund ab und legen die Ausrichtung zusätzlich fest.
  const innerAll = pano.VIS.map((v, vi) => ({ vis: v, SV: toVec((c) => pano.skyV[c * nV + vi]).SV })).filter((l) => l.vis <= 90000);
  let inner = innerAll;
  const yIn = new Float32Array(w), ySk = new Float32Array(w);
  const projectIn = makeProjector(yIn, w, h);

  // Feinbewertung: Kontrast entlang Horizont + Grate + Himmel/Gelände-Trennung
  const WIN = hint.wInner ?? 0.3;
  let EM = Ef; // Kantenkarte der Feinbewertung (zuerst tolerant, zuletzt scharf)
  const score = (hd, pt, ro, fov) => {
    const Fp = projectSky(hd, pt, ro, fov);
    let sky = 0, seg = 0, n = 0;
    for (let x = 0; x < w; x++) {
      const yp = ypred[x];
      if (yp !== yp) continue;
      n++;
      if (yp >= 0 && yp < h) sky += EM[(yp | 0) * w + x];
      const y = yp < 0 ? 0 : yp >= h ? h - 1 : yp | 0;
      seg += Math.min(U[y * w + x] - Umin[x], cap);
    }
    if (n < w * 0.5) return -1;
    let s = sky / n + 0.4 * (1 - seg / n / cap);
    parts.sky = sky / n; parts.seg = 1 - seg / n / cap; parts.inner = 0; parts.ridge = 0;
    if (inner.length && WIN) {
      ySk.set(ypred);
      const sv = SV;
      let ia = 0, ic = 0;
      for (const L of inner) {
        SV = L.SV; projectIn(hd, pt, ro, fov);
        for (let x = 0; x < w; x++) {
          const yi = yIn[x];
          if (!(yi > ySk[x] + 4) || yi >= h) continue;
          ia += EM[(yi | 0) * w + x]; ic++;
        }
      }
      SV = sv;
      if (ic) { parts.inner = (ia / ic) * Math.min(1, ic / (inner.length * n * 0.3)); s += WIN * parts.inner; }
    }
    if (ridge.length) {
      const Bs = basisFromHPR(hd, pt, ro);
      let rs = 0, rn = 0;
      for (let j = 0; j < ridge.length; j += 2) {
        const o = ridge[j] * 6;
        const Z = pano.seg[o] * Bs.f[0] + pano.seg[o + 1] * Bs.f[1] + pano.seg[o + 2] * Bs.f[2];
        if (Z < 0.1) continue;
        const x = w / 2 + Fp * (pano.seg[o] * Bs.r[0] + pano.seg[o + 1] * Bs.r[1] + pano.seg[o + 2] * Bs.r[2]) / Z;
        const y = h / 2 - Fp * (pano.seg[o] * Bs.u[0] + pano.seg[o + 1] * Bs.u[1] + pano.seg[o + 2] * Bs.u[2]) / Z;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = (y | 0) * w + (x | 0);
        rs += EM[i] - 0.6 * S[i]; rn++; // Grate müssen im Gelände liegen, nicht im Himmel
      }
      if (rn > 20) { parts.ridge = rs / rn; s += 0.25 * (rs / rn); }
    }
    return s;
  };
  const parts = {};
  if (hint.evalPoses) {
    EM = Ef;
    return { evals: hint.evalPoses.map((p) => { const o = {}; for (let k = 0; k < skies.length; k++) { useSky(k); const v = score(p.heading, p.pitch, p.roll, p.hfov); o['vis' + skies[k].vis] = { total: +v.toFixed(3), ...Object.fromEntries(Object.entries(parts).map(([a, b]) => [a, +b.toFixed(3)])) }; } return o; }) };
  }

  // Grobsuche: Richtung × Bildwinkel × Höhenversatz (Neigung als Verschiebung genähert)
  const H0 = hint.heading, hr = hint.headingRange ?? 180;
  const f0 = hint.hfov, fr = hint.fovRange ?? 0.4;
  const [fMin, fMax] = Array.isArray(fr) ? fr : [f0 * (1 - fr), f0 * (1 + fr)];
  const fovs = [], fLo = Math.max(3, fMin * 0.97), fHi = Math.min(130, fMax * 1.03);
  for (let f = fMin; f <= fMax * 1.0001; f *= 1.1) fovs.push(f);
  // Neigung: beim Tele selten mehr als ein paar Grad, beim Weitwinkel bis 20°
  const maxPitch = hint.maxPitch ?? Math.min(20, Math.max(8, f0 * 0.6));
  let top = [];

  // Grobsuche ohne Drehung; dafür wächst die senkrechte Toleranz zum Bildrand hin (Drehung bis ~2°)
  const Er = new Float32Array(w * h);
  {
    const t = blur(E, w, h, 1, 0);
    for (let x = 0; x < w; x++) {
      const rr = 2 + Math.round(Math.abs(x - w / 2) * Math.tan(2 * D2R));
      for (let y = 0; y < h; y++) {
        let m = 0;
        for (let k = -rr; k <= rr; k++) { const yy = y + k; if (yy >= 0 && yy < h) m = Math.max(m, t[yy * w + x] * (1 - 0.5 * Math.abs(k) / (rr + 1))); }
        Er[y * w + x] = m;
      }
    }
  }
  // Kandidaten-Zeilen je Bildspalte: stärkste Kontrastkanten und der Horizont aus der Segmentierung
  const K = 8, XS = 4, KK = K + 1, candY = new Float32Array(w * KK), candW = new Float32Array(w * KK);
  for (let x = 0; x < w; x += XS) {
    const loc = [];
    for (let y = 1; y < h - 1; y++) {
      const e = Ef[y * w + x];
      if (e > 0.25 && e >= Ef[(y - 1) * w + x] && e > Ef[(y + 1) * w + x]) loc.push([e, y]);
    }
    loc.sort((a, b) => b[0] - a[0]);
    // Gewicht: Kantenstärke × wie gut ein Horizont dort zur Himmel/Gelände-Trennung passt (Wolkenränder zählen wenig)
    for (let k = 0; k < K; k++) {
      const y = loc[k] ? loc[k][1] : -1;
      candY[x * KK + k] = y;
      candW[x * KK + k] = y < 0 ? 0 : loc[k][0] * (0.15 + 0.85 * (1 - Math.min(U[y * w + x] - Umin[x], cap) / cap));
    }
    candY[x * KK + K] = ys[x]; candW[x * KK + K] = 1.5;
  }
  const NL = skies.length, RT = pano.ridgeT, RN = pano.RN;
  const xs = new Int32Array(w), angA = new Float32Array(w), invCos = new Float32Array(w), ci = new Int32Array(w);
  const yL = new Float32Array(w * NL);
  const BIN = 2;
  let dbg = null, dbgOff = null;
  const pk = new Int32Array(3), pv = new Float32Array(3);
  const coarse = (m, off) => {
    let s = 0;
    for (let j = 0; j < m; j++) {
      const x = xs[j];
      let bj = 0;
      for (let L = 0; L < NL; L++) {
        const yp = yL[j * NL + L] + off;
        const y = yp < 0 ? 0 : yp >= h ? h - 1 : yp | 0;
        const v = (yp >= 0 && yp < h ? Er[y * w + x] : 0) + 0.4 * (1 - Math.min(U[y * w + x] - Umin[x], cap) / cap) - 0.02 * L;
        if (v > bj) bj = v;
      }
      s += bj;
    }
    return s / m;
  };
  // Bewertung einer Richtung: Linien vorhersagen, Höhenversatz per Abstimmung, beste Versätze prüfen, Grate dazu
  const evalCoarse = (F, Fp, hd) => {
    const { mAll, nb, hist, maxOff } = F;
    for (let j = 0; j < mAll; j++) {
      const c = Math.round((hd + angA[j]) / 360 * cols);
      const cc = ((c % cols) + cols) % cols; ci[j] = cc;
      for (let L = 0; L < NL; L++) yL[j * NL + L] = h / 2 - Fp * skies[L].T[cc] * invCos[j];
    }
    hist.fill(0);
    for (let j = 0; j < mAll; j++) {
      const o = xs[j] * KK;
      for (let L = 0; L < NL; L++) {
        const yp = yL[j * NL + L] - maxOff;
        for (let q = 0; q < KK; q++) {
          const cy = candY[o + q]; if (cy < 0) continue;
          const b = ((cy - yp) / BIN + 0.5) | 0;
          if (b >= 0 && b < nb) hist[b] += candW[o + q];
        }
      }
    }
    // die drei stärksten, deutlich getrennten Gipfel des Histogramms
    pk[0] = pk[1] = pk[2] = -1; pv[0] = pv[1] = pv[2] = -1;
    for (let b = 1; b < nb - 1; b++) {
      const v = hist[b] + (hist[b - 1] + hist[b + 1]) * 0.5;
      if (v <= pv[2]) continue;
      let near = -1;
      for (let t = 0; t < 3; t++) if (pk[t] >= 0 && Math.abs(b - pk[t]) <= 3) { near = t; break; }
      if (near >= 0) { if (v > pv[near]) { pv[near] = v; pk[near] = b; } }
      else { pk[2] = b; pv[2] = v; }
      for (let t = 2; t > 0; t--) if (pv[t] > pv[t - 1]) { const a = pv[t]; pv[t] = pv[t - 1]; pv[t - 1] = a; const c = pk[t]; pk[t] = pk[t - 1]; pk[t - 1] = c; }
    }
    const b1 = pk[0], b2 = pk[1], v1 = pv[0], v2 = pv[1];
    let bs = -1, bo = 0;
    for (let t = 0; t < 3; t++) {
      const bb = pk[t];
      if (bb < 0) continue;
      for (let d = -1; d <= 1; d++) {
        const off = (bb + d) * BIN - maxOff;
        const sc = coarse(mAll, off);
        if (sc > bs) { bs = sc; bo = off; }
      }
    }
    // Grate im Bildinneren (nahe Gelände) müssen auf Kontrastkanten im Gelände liegen
    let rs = 0, rn = 0;
    for (let j = 0; j < mAll; j++) {
      const o = ci[j] * RN, x = xs[j];
      for (let q = 0; q < RN; q++) {
        const tR = RT[o + q]; if (tR !== tR) break;
        const y = (h / 2 - Fp * tR * invCos[j] + bo) | 0;
        if (y < 0 || y >= h) continue;
        rs += Er[y * w + x] - 0.6 * S[y * w + x]; rn++;
      }
    }
    if (rn > 10) bs += 0.25 * rs / rn;
    if (dbg) dbg.push({ hd, b1: b1 * BIN - maxOff, b2: b2 * BIN - maxOff, v1, v2, bo, sky: bs - (rn > 10 ? 0.25 * rs / rn : 0), ridge: rn > 10 ? rs / rn : null, rn, at0: coarse(mAll, 0), atTrue: dbgOff != null ? coarse(mAll, dbgOff) : null });
    return [bs, bo];
  };
  const setupFov = (fov) => {
    const Fp = focalPx(w, fov);
    const maxOff = Fp * Math.tan(maxPitch * D2R), nb = Math.ceil(2 * maxOff / BIN) + 1;
    let mAll = 0;
    for (let x = 0; x < w; x += XS) { const a = Math.atan((x + 0.5 - w / 2) / Fp); xs[mAll] = x; angA[mAll] = a * R2D; invCos[mAll++] = 1 / Math.cos(a); }
    return { Fp, F: { maxOff, nb, mAll, hist: new Float32Array(nb) } };
  };
  for (const fov of fovs) {
    const { Fp, F } = setupFov(fov);
    const hStep = Math.max(0.1, fov / w * 2);
    for (let dh = -hr; dh < hr; dh += hStep) {
      const hd = H0 + dh;
      const [bs, bo] = evalCoarse(F, Fp, hd);
      top.push([bs, { heading: hd, pitch: Math.atan(bo / Fp) * R2D, roll: 0, hfov: fov }]);
    }
  }
  // Grobsuche über den dichten Abgleich (findet die Lage auch bei Wolken oder schwachem Horizont)
  const tEdge = performance.now() - t0;
  const miTop = [];
  for (const fov of fovs) {
    const hStep = Math.max(0.12, fov / MI.GW * 1.5);
    for (let dh = -hr; dh < hr; dh += hStep) {
      const [v, pt] = MI.scan(H0 + dh, fov, maxPitch, 3);
      miTop.push([v, { heading: H0 + dh, pitch: pt, roll: 0, hfov: fov, mi: true }]);
    }
  }
  miTop.sort((a, b) => b[0] - a[0]);
  const coarseAt = (p) => {
    const { Fp, F } = setupFov(p.hfov);
    for (let j = 0; j < F.mAll; j++) {
      const cc = ((Math.round((p.heading + angA[j]) / 360 * cols) % cols) + cols) % cols;
      for (let L = 0; L < NL; L++) yL[j * NL + L] = h / 2 - Fp * skies[L].T[cc] * invCos[j];
    }
    return coarse(F.mAll, Fp * Math.tan(p.pitch * D2R));
  };
  const miPicked = [];
  for (const t of miTop) {
    if (miPicked.some((q) => Math.abs(((q[1].heading - t[1].heading + 540) % 360) - 180) < Math.max(0.6, t[1].hfov / 25) && Math.abs(q[1].pitch - t[1].pitch) < t[1].hfov / 25)) continue;
    miPicked.push([coarseAt(t[1]), t[1]]);
    if (miPicked.length >= 30) break;
  }
  const tMI = performance.now() - t0;
  if (hint.truth) {
    const t = hint.truth, S0 = setupFov(t.hfov);
    dbg = []; dbgOff = -S0.Fp * Math.tan(t.pitch * D2R) * 0 + S0.Fp * Math.tan(t.pitch * D2R);
    hint.truthCoarseExact = evalCoarse(S0.F, S0.Fp, t.heading)[0];
    hint.dbg = dbg; dbg = null;
  }
  top.sort((a, b) => b[0] - a[0]);
  if (hint.truth) {
    const t = hint.truth;
    const rank = top.findIndex((x) => Math.abs(((x[1].heading - t.heading + 540) % 360) - 180) < 1 && Math.abs(x[1].hfov / t.hfov - 1) < 0.08);
    hint.truthRank = rank; hint.topCoarse = top[0][0];
  }
  // unterschiedliche Kandidaten auswählen
  const picked = [];
  for (const t of top) {
    if (picked.some((p) => Math.abs(((p[1].heading - t[1].heading + 540) % 360) - 180) < 1.5 && Math.abs(p[1].hfov / t[1].hfov - 1) < 0.1)) continue;
    picked.push(t);
    if (picked.length >= 800) break;
  }
  picked.push(...miPicked);
  // Startwerte von außen (z. B. die bisherige Ausrichtung) immer mitprüfen
  if (hint.onlySeeds) picked.length = 0;
  for (const sd of hint.seeds || []) picked.unshift([1e9, { heading: sd.heading, pitch: sd.pitch, roll: sd.roll || 0, hfov: sd.hfov, seed: true }]);
  // Vorauswahl mit der feinen Bewertung (ohne Verfeinern, tolerante Kantenkarte), dann die besten verfeinern
  EM = Er;
  for (const t of picked) {
    const p = t[1];
    let bsF = -1e9;
    const r0 = p.roll;
    for (const ro of p.seed ? [r0] : [-1, 0, 1]) {
      const v = score(p.heading, p.pitch, ro, p.hfov);
      if (v > bsF) { bsF = v; p.roll = ro; }
    }
    t[2] = p.seed ? 1e9 : bsF + 0.3 * t[0] + AMI * MI.exact(p.heading, p.pitch, p.roll, p.hfov) - priors(p);
  }
  picked.sort((a, b) => b[2] - a[2]);
  if (hint.truth) {
    const t = hint.truth;
    hint.preRank = picked.findIndex((x) => Math.abs(((x[1].heading - t.heading + 540) % 360) - 180) < 1.5 && Math.abs(x[1].hfov / t.hfov - 1) < 0.1);
    hint.pre = hint.preRank >= 0 ? [picked[hint.preRank][2], picked[hint.preRank][0], picked[hint.preRank][1]] : null; hint.preTop = picked[0][2];
  }
  picked.length = Math.min(picked.length, hint.nRefine ?? 32);
  const tCoarse = performance.now() - t0;
  const nPicked = picked.length;
  // Verfeinern (Koordinatensuche über alle vier Werte, auch gekoppelt), Schritte in Bildpixeln
  const refine = (c, steps) => {
    let p = c.p;
    useSky(p.sky);
    let s = score(p.heading, p.pitch, p.roll, p.hfov) - priors(p);
    for (const px of steps) {
      let improved = true, it = 0;
      while (improved && it++ < 25) {
        improved = false;
        const st = px * p.hfov / w, sr = Math.atan(px / (w / 2)) * R2D, df = st * 2;
        for (const [key, d, k2, d2] of [['heading', st], ['heading', -st], ['pitch', st], ['pitch', -st], ['roll', sr], ['roll', -sr], ['hfov', df], ['hfov', -df],
          ['hfov', df, 'heading', st / 2], ['hfov', df, 'heading', -st / 2], ['hfov', -df, 'heading', st / 2], ['hfov', -df, 'heading', -st / 2],
          ['hfov', df, 'pitch', st / 2], ['hfov', df, 'pitch', -st / 2], ['hfov', -df, 'pitch', st / 2], ['hfov', -df, 'pitch', -st / 2]]) {
          const q = { ...p, [key]: p[key] + d };
          if (k2) q[k2] += d2;
          if (Math.abs(q.roll) > 10 || q.hfov < fLo || q.hfov > fHi) continue;
          const sq = score(q.heading, q.pitch, q.roll, q.hfov) - priors(q);
          if (sq > s) { s = sq; p = q; improved = true; }
        }
      }
    }
    c.mi = MI.exact(p.heading, p.pitch, p.roll, p.hfov);
    c.p = p; c.s = s + priors(p); c.v = s - 0.02 * p.sky + AMI * c.mi;
    return c;
  };
  EM = Ef;
  let cands = picked.map(([, p0]) => {
    // passende Sichtweite für diesen Kandidaten wählen
    const p = { ...p0 }; let s = -1e9;
    for (let k = 0; k < skies.length; k++) { useSky(k); const sk = score(p.heading, p.pitch, p.roll, p.hfov) - 0.02 * k; if (sk > s) { s = sk; p.sky = k; } }
    useSky(p.sky);
    return { p, s: score(p.heading, p.pitch, p.roll, p.hfov) };
  });
  cands = cands.map((c) => refine(c, [8, 3])).sort((a, b) => b.v - a.v).slice(0, 8);
  EM = Ef;
  cands = cands.map((c) => refine(c, [1.2, 0.5, 0.2])).sort((a, b) => b.v - a.v);
  let best = cands.length ? { ...cands[0].p, score: cands[0].s, mi: cands[0].mi } : null;
  if (!best) throw new Error('Kein Horizont gefunden');
  if (hint.truth) {
    const t = hint.truth; best.truthScore = -1;
    for (let k = 0; k < skies.length; k++) { useSky(k); best.truthScore = Math.max(best.truthScore, score(t.heading, t.pitch, t.roll, t.hfov)); }
  }
  if (hint.truth) Object.assign(best, { truthRank: hint.truthRank, truthCoarse: hint.truthCoarseExact, dbg: [hint.preRank, hint.pre, hint.preTop], topCoarse: hint.topCoarse, nTop: top.length });
  best.vis = skies[best.sky].vis; best.tCoarse = Math.round(tCoarse); best.tPre = Math.round(tPre); best.tEdge = Math.round(tEdge); best.tMI = Math.round(tMI); best.nSkies = skies.length; best.nFov = fovs.length; best.skies = skies.map((x) => x.vis);
  best.match = best.score;
  best.heading = (best.heading + 360) % 360;
  best.photoSky = Array.from(ys);
  best.ms = Math.round(performance.now() - t0);
  return best;
}
