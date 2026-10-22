import { basisFromHPR, basisFromDevice, rotateYaw, hprFromBasis, focalPx, project, hfovFrom35mm } from './camera.js';
import { readExif } from './exif.js';
import { SlippyMap } from './map.js';
import { distAz, drop } from './terrain.js';

const $ = (id) => document.getElementById(id);
const APP_VERSION = 'v12';
const DECLINATION = 3.5; // Missweisung in den Alpen (Ost), Grad
const DATA_BASE = new URL('../data', import.meta.url).href;

// ---------------------------------------------------------------- Zustand

const store = {
  get(k, d) { try { const v = localStorage.getItem('bergblick.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bergblick.' + k, JSON.stringify(v)); } catch { /* privat */ } },
};

const state = {
  mode: 'pano', // pano | photo | live
  loc: store.get('loc', { lat: 46.5853, lon: 7.9614, agl: 2, name: "Kleine Scheidegg" }), // Standard: Kleine Scheidegg
  pano: null,
  view: { heading: 180, pitch: 2, roll: 0, hfov: 60 },
  img: null,
  imgName: '',
  // Live-Kamera: lenses = Zoomstufen des Geräts, dz = angezeigter Zoom (läuft beim Wechsel weich mit),
  // cur = Quelle des laufenden Videos (Kamera und deren optischer Zoom), frozen = fixierte Aufnahme
  live: { basis: null, raw: null, stream: null, lenses: [{ z: 1, base: 1 }, { z: 2, base: 1 }], zoom: 1, dz: 1, cur: { deviceId: null, base: 1 }, frozen: null, last: null, adjust: false },
  settings: Object.assign({ maxDist: 200000, ridges: true, fill: true, camFov: 66, offset: 0, camPitch: 0, camRoll: 0, camFovK: 1 }, store.get('settings', {})),
  selected: null,
  labels: [],
  zoom: { s: 1, x: 0, y: 0 }, // Bildzoom im Foto-Modus (Foto und Overlay gemeinsam)
  adjust: false, // true: Ziehen/Zoomen verändert die Ausrichtung statt der Ansicht
};

// ---------------------------------------------------------------- Worker

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let reqId = 0;
const pending = new Map();
function call(type, data = {}, transfer) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type, id, ...data }, transfer || []);
  });
}
const progressHandlers = new Set();
let readyResolve;
const ready = new Promise((r) => (readyResolve = r));
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') { $('progress').style.width = (m.value * 100).toFixed(0) + '%'; return; }
  if (m.type === 'ready') { readyResolve(m); return; }
  if (m.type === 'detail') { showHint(`${m.what === 'sat' ? 'Lade Satellitenbilder' : 'Lade Detailgelände'}… ${Math.round(m.done / m.total * 100)} %`); return; }
  if (m.type === 'bundle-progress') { bundleState = m; checkOffline(); return; }
  if (m.type === 'locsearch-progress') { progressHandlers.forEach((f) => f(m)); return; }
  if (m.type === 'prefetch-progress') { $('pickInfo').textContent = `Speichere Gebiet… ${m.done}/${m.total} Kacheln`; return; }
  const p = pending.get(m.id);
  if (!p) { if (m.type === 'error') console.error(m.message); return; }
  pending.delete(m.id);
  if (m.type === 'error') p.reject(new Error(m.message)); else p.resolve(m);
};
worker.postMessage({ type: 'init', base: DATA_BASE });

// ---------------------------------------------------------------- Canvas

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resize() {
  if (typeof clampZoom === 'function' && state.img) requestAnimationFrame(clampZoom);
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  W = innerWidth; H = innerHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  requestDraw();
}
addEventListener('resize', resize);

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

// Kamera für die aktuelle Ansicht (in CSS-Pixeln)
function currentCamera() {
  if (state.mode === 'photo' && state.img) {
    const iw = state.img.width, ih = state.img.height;
    const s = Math.min(W / iw, H / ih) * state.zoom.s;
    const rx = (W - iw * s) / 2 + state.zoom.x, ry = (H - ih * s) / 2 + state.zoom.y;
    return { ...basisFromHPR(state.view.heading, state.view.pitch, state.view.roll), F: focalPx(iw, state.view.hfov) * s, cx: rx + iw * s / 2, cy: ry + ih * s / 2, rect: [rx, ry, iw * s, ih * s] };
  }
  if (state.mode === 'live') {
    const L = state.live, k = Number(state.settings.camFovK) || 1;
    // fixiert: Aufnahme füllt den Bildschirm; Brennweite in Pixeln der Aufnahme
    if (L.frozen) return { ...camCorrect(L.frozen.basis), F: L.frozen.F * W / L.frozen.w / k, cx: W / 2, cy: H / 2 };
    const v = $('video');
    const vw = v.videoWidth || W, vh = v.videoHeight || H;
    // Bildwinkel = Basis-Bildwinkel (1×) ÷ Zoom × Anpassen-Faktor
    const F = focalPx(Math.max(vw, vh), state.settings.camFov) * Math.max(W / vw, H / vh) * L.dz / k;
    return { ...camCorrect(L.basis || basisFromHPR(state.view.heading, state.view.pitch, 0)), F, cx: W / 2, cy: H / 2 };
  }
  const fovW = W > H ? state.view.hfov : state.view.hfov * W / H;
  return { ...basisFromHPR(state.view.heading, state.view.pitch, 0), F: focalPx(W, fovW), cx: W / 2, cy: H / 2 };
}

// Korrektur aus „Overlay anpassen“ (Kompass, Neigung, Drehung), je Gerät gespeichert
function camCorrect(B) {
  const c = state.settings, hpr = hprFromBasis(B);
  return basisFromHPR(hpr.heading + (Number(c.offset) || 0), hpr.pitch + (Number(c.camPitch) || 0), hpr.roll + (Number(c.camRoll) || 0));
}

function draw() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cam = currentCamera();
  if (state.mode === 'pano') drawPanoBackground(cam);
  else if (state.mode === 'photo' && state.img) {
    ctx.fillStyle = '#e8eae6'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(state.img, ...cam.rect);
  } else if (state.mode === 'live' && state.live.frozen) ctx.drawImage(state.live.frozen.img, 0, 0, W, H);
  if (state.pano) drawOverlay(ctx, cam, 1, state.mode === 'pano' ? 'pano' : 'photo');
  if (state.mode === 'photo') drawAnchors(cam);
  else if (state.pano) { drawSun(ctx, cam); drawTarget(ctx, cam); }
  updateInfo(cam);
  if (state.mode === 'photo' && state.photoId) histTouch();
}

// ---------------------------------------------------------------- Gerendertes Gelände (Panorama-Modus)

const fill = { canvas: document.createElement('canvas'), key: '' };

function drawPanoBackground(cam) {
  const P = state.pano;
  if (!P || !state.settings.fill) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#5e90bf'); g.addColorStop(1, '#e4ecf1');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    return;
  }
  const scale = Math.min(1, 1100 / Math.max(W, H)) * Math.min(DPR, 1.5);
  const w = Math.ceil(W * scale), h = Math.ceil(H * scale);
  const key = [cam.f, cam.u, cam.F, w, h, P.ms, P.lat, P.lon].join();
  if (key !== fill.key) {
    fill.key = key;
    renderTerrain(cam, w, h, scale);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(fill.canvas, 0, 0, W, H);
}

// Schlichte Darstellung wie eine gezeichnete Panoramatafel: Farbe nach Entfernung (Luftperspektive),
// Schnee weich nach Höhe, Hangschattierung nur angedeutet.
const NEAR = [56, 70, 58], MID = [78, 96, 112], FAR = [184, 198, 214], SNOW = [236, 240, 246];
function terrainColor(d, e, s, S = null) {
  const tD = Math.max(0, Math.min(1, (Math.log10(Math.max(300, d)) - 2.7) / 2.4)); // 500 m … 125 km
  const a = tD < 0.45 ? NEAR : MID, b = tD < 0.45 ? MID : FAR, f = tD < 0.45 ? tD / 0.45 : (tD - 0.45) / 0.55;
  let r = a[0] + (b[0] - a[0]) * f, g = a[1] + (b[1] - a[1]) * f, bl = a[2] + (b[2] - a[2]) * f;
  const sn = Math.max(0, Math.min(1, (e - 2400) / 600)) * (1 - 0.55 * tD);
  r += (SNOW[0] - r) * sn; g += (SNOW[1] - g) * sn; bl += (SNOW[2] - bl) * sn;
  // mit Sonne: s ist schon die Helligkeit (Licht, Schatten, Dämmerung); in der Ferne gleicht der Dunst aus
  const k = S ? s * (1 - 0.6 * tD) + 0.6 * tD * S.dayK : 1 + (0.86 + 0.26 * Math.max(0, Math.min(1, (s - 0.35) / 0.75)) - 1) * (1 - 0.75 * tD);
  return [r * k, g * k, bl * k];
}

function renderTerrain(cam, w, h, scale) {
  const P = state.pano, { runs, runOff, cols } = P, runCol = P.runCol;
  const c = fill.canvas; c.width = w; c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h), px = img.data;
  const F = cam.F * scale, cx = cam.cx * scale, cy = cam.cy * scale;
  const f = cam.f, r = cam.r, u = cam.u;
  const k2c = cols / (2 * Math.PI);
  const S = P.sun;
  for (let y = 0; y < h; y++) {
    const dy = -(y + 0.5 - cy);
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx;
      const vx = f[0] * F + r[0] * dx + u[0] * dy, vy = f[1] * F + r[1] * dx + u[1] * dy, vz = f[2] * F + r[2] * dx + u[2] * dy;
      const hz = Math.hypot(vx, vy);
      const t = vz / hz;
      const cf = Math.atan2(vx, vy) * k2c;
      let col = Math.round(cf) % cols; if (col < 0) col += cols;
      let lo = runOff[col], hi = runOff[col + 1] - 1;
      const o = (y * w + x) * 4;
      if (hi < lo || t > runs[hi * 4]) {
        // Himmel
        const el = Math.max(0, Math.min(1, t * 2.2));
        let sr = 206 - 112 * el, sg = 224 - 80 * el, sb = 238 - 42 * el;
        if (S) {
          // Abend- und Morgenrot am Horizont, nachts dunkel
          const wm = S.warm * (1 - el) * (S.alt > -7 ? 0.7 : 0);
          sr += (252 - sr) * wm; sg += (168 - sg) * wm; sb += (118 - sb) * wm;
          sr *= S.dayK; sg *= S.dayK; sb *= Math.min(1, S.dayK * 1.3);
        }
        px[o] = sr; px[o + 1] = sg; px[o + 2] = sb; px[o + 3] = 255;
        continue;
      }
      while (lo < hi) { const m = (lo + hi) >> 1; if (runs[m * 4] >= t) hi = m; else lo = m + 1; }
      if (runCol) {
        // Farbe zwischen den beiden Nachbarrichtungen mischen, sonst entstehen beim Hineinzoomen senkrechte Streifen
        let r0 = runCol[lo * 3], g0 = runCol[lo * 3 + 1], b0 = runCol[lo * 3 + 2];
        const fr = cf - Math.floor(cf), c2 = (((Math.round(cf) + (fr < 0.5 ? -1 : 1)) % cols) + cols) % cols, wgt = fr < 0.5 ? 0.5 - fr : fr - 0.5;
        let l2 = runOff[c2], h2 = runOff[c2 + 1] - 1;
        if (wgt > 0.02 && h2 >= l2 && t <= runs[h2 * 4]) {
          while (l2 < h2) { const m = (l2 + h2) >> 1; if (runs[m * 4] >= t) h2 = m; else l2 = m + 1; }
          r0 += (runCol[l2 * 3] - r0) * wgt; g0 += (runCol[l2 * 3 + 1] - g0) * wgt; b0 += (runCol[l2 * 3 + 2] - b0) * wgt;
        }
        px[o] = r0; px[o + 1] = g0; px[o + 2] = b0; px[o + 3] = 255;
        continue;
      }
      const q = lo * 4, d = runs[q + 1], s = runs[q + 2], e = runs[q + 3];
      const c = terrainColor(d, e, s, S);
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
    }
  }
  // leicht waagrecht glätten (Streifen zwischen benachbarten Richtungen)
  const row = new Uint8ClampedArray(w * 4);
  for (let y = 0; y < h; y++) {
    const o = y * w * 4;
    row.set(px.subarray(o, o + w * 4));
    for (let x = 2; x < w - 2; x++) for (let ch = 0; ch < 3; ch++) {
      const i = x * 4 + ch;
      px[o + i] = (row[i - 8] + 2 * row[i - 4] + 3 * row[i] + 2 * row[i + 4] + row[i + 8]) / 9;
    }
  }
  g.putImageData(img, 0, 0);
}

const enuV = (az, el) => {
  const a = az * Math.PI / 180, e = el * Math.PI / 180, c = Math.cos(e);
  return [c * Math.sin(a), c * Math.cos(a), Math.sin(e)];
};

// Zeichnet Umrisse und Gipfel. k = Skalierung für Linienbreiten/Schrift (Export).
// style 'pano': dunkle Linien auf gerendertem Gelände, 'photo': helle Linien auf dem Bild.
function drawOverlay(g, cam, k, style = 'photo') {
  const P = state.pano;
  const { seg, segD, segKind } = P;
  const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()];
  const maxLen = 120 * k;
  const p1 = [0, 0], p2 = [0, 0];
  const pj = (o, out) => {
    const Z = seg[o] * cam.f[0] + seg[o + 1] * cam.f[1] + seg[o + 2] * cam.f[2];
    if (Z < 0.05) return false;
    out[0] = cam.cx + cam.F * (seg[o] * cam.r[0] + seg[o + 1] * cam.r[1] + seg[o + 2] * cam.r[2]) / Z;
    out[1] = cam.cy - cam.F * (seg[o] * cam.u[0] + seg[o + 1] * cam.u[1] + seg[o + 2] * cam.u[2]) / Z;
    return true;
  };
  const xmin = cam.rect ? cam.rect[0] : 0, xmax = cam.rect ? cam.rect[0] + cam.rect[2] : g.canvas.width / (k === 1 ? DPR : 1);
  for (let i = 0, o = 0; i < segD.length; i++, o += 6) {
    const sky = segKind[i];
    if (!sky && !state.settings.ridges) continue;
    if (!pj(o, p1) || !pj(o + 3, p2)) continue;
    if ((p1[0] < xmin && p2[0] < xmin) || (p1[0] > xmax && p2[0] > xmax)) continue;
    if (Math.abs(p1[0] - p2[0]) > maxLen) continue;
    const d = segD[i];
    const b = sky ? 0 : d < 5000 ? 1 : d < 15000 ? 2 : d < 40000 ? 3 : 4;
    paths[b].moveTo(p1[0], p1[1]); paths[b].lineTo(p2[0], p2[1]);
  }
  g.save();
  if (cam.rect) { g.beginPath(); g.rect(...cam.rect); g.clip(); }
  g.lineJoin = 'round'; g.lineCap = 'round';
  // [Breite, Deckkraft] für Horizont, <5 km, <15 km, <40 km, weiter
  const styles = [[2.2, 0.95], [2.0, 0.95], [1.6, 0.85], [1.2, 0.7], [0.9, 0.5]];
  for (let b = 4; b >= 0; b--) {
    const [lw, a] = styles[b];
    if (style === 'pano') {
      g.lineWidth = lw * 0.8 * k; g.strokeStyle = `rgba(25,30,38,${a * 0.75})`; g.stroke(paths[b]);
    } else {
      // Horizont gelb 1,7 px, Grate weiß 1,1 px; ganz leichter Schatten für helle Bildstellen
      const w2 = b === 0 ? 1.7 : 1.1, a2 = [1, 0.8, 0.75, 0.7, 0.55][b];
      g.lineWidth = (w2 + 1.4) * k; g.strokeStyle = `rgba(20,30,40,${a2 * 0.22})`; g.stroke(paths[b]);
      g.lineWidth = w2 * k; g.strokeStyle = b === 0 ? '#f6da74' : `rgba(255,255,255,${a2})`; g.stroke(paths[b]);
    }
  }
  if (state.debugSky && state.mode === 'photo') drawPhotoSky(g, cam);
  drawPeaks(g, cam, k);
  g.restore();
}

function drawPeaks(g, cam, k) {
  const P = state.pano;
  const xmin = cam.rect ? cam.rect[0] : 0, xmax = cam.rect ? cam.rect[0] + cam.rect[2] : W;
  const ytop = cam.rect ? cam.rect[1] : 0;
  const ybot = cam.rect ? cam.rect[1] + cam.rect[3] : H;
  const items = [];
  for (const p of P.peaks) {
    const s = project(p.v, cam);
    if (!s || s[0] < xmin + 4 * k || s[0] > xmax - 4 * k || s[1] < ytop || s[1] > ybot) continue;
    // Bedeutung: Dominanz und Höhe, nahe Gipfel bevorzugt (sie prägen das Bild)
    const km = p.dist / 1000;
    const score = Math.log2(1 + p.iso) * 2.5 + p.ele / 1500 + 4 / (1 + km / 4) - km / 60 + (state.selected === p.i ? 100 : 0);
    items.push({ p, x: s[0], y: s[1], score });
  }
  items.sort((a, b) => b.score - a.score);
  const fs = 13 * k;
  g.font = `600 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  // Belegte Flächen als gedrehte Rechtecke (Beschriftungen) und kleine Quadrate (Gipfelpunkte).
  // Schräge Namen liegen parallel und dürfen eng nebeneinander stehen; früher wurde ihre ganze
  // waagrechte Breite gesperrt, dann passten auf schmale Handybildschirme nur 3–4 Namen.
  const boxes = [];
  const placed = [];
  // Weit herausgezoomt nur die wichtigsten Gipfel, beim Hineinzoomen immer mehr:
  // ab 60° Bildwinkel ein Name je 90 px Breite, bei 6° und enger einer je 24 px
  const fovW = 2 * Math.atan((xmax - xmin) / 2 / cam.F) * 180 / Math.PI;
  const pxPer = 24 + 66 * Math.max(0, Math.min(1, (fovW - 6) / 54));
  const maxLabels = Math.max(3, Math.floor((xmax - xmin) / k / pxPer));
  const A60 = -60 * Math.PI / 180;
  for (const it of items) {
    if (placed.length >= maxLabels) break;
    const text = `${it.p.name}  ${Math.round(it.p.ele)} m`;
    const tw = g.measureText(text).width;
    // Platz nach oben? Sonst Beschriftung unterhalb des Gipfels schräg nach unten
    const room = it.y - 12 * k - ytop >= tw * Math.sin(-A60) + 4 * k;
    let ly2, ang = A60;
    if (room) {
      const ly = Math.max(ytop + tw * Math.sin(-A60) + 8 * k, it.y - 28 * k);
      ly2 = Math.min(ly, it.y - 10 * k);
    } else { ly2 = it.y + 14 * k; ang = -A60; }
    const ox = it.x, oy = ly2 + (room ? -2 : 6) * k;
    const label = rotRect(ox, oy, ang, -2 * k, tw + 3 * k, -fs * 0.85 - 1.5 * k, fs * 0.3 + 1.5 * k);
    const dot = rotRect(it.x, it.y, 0, -4 * k, 4 * k, -4 * k, 4 * k);
    if (boxes.some((q) => polysOverlap(q, label) || polysOverlap(q, dot))) continue;
    boxes.push(label, dot);
    placed.push({ ...it, text, tw, ang, room, ly2, ox, oy });
  }
  state.labels = k === 1 ? placed : state.labels;
  for (const it of placed) {
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1 * k;
    g.beginPath(); g.moveTo(it.x, it.y + (it.room ? -3 : 3) * k); g.lineTo(it.x, it.ly2); g.stroke();
    g.fillStyle = state.selected === it.p.i ? '#ffb547' : '#fff';
    g.beginPath(); g.arc(it.x, it.y, 2.6 * k, 0, Math.PI * 2); g.fill();
    g.save(); g.translate(it.ox, it.oy); g.rotate(it.ang);
    g.lineWidth = 3 * k; g.strokeStyle = 'rgba(0,0,0,0.65)'; g.strokeText(it.text, 0, 0);
    g.fillText(it.text, 0, 0);
    g.restore();
    it.lx = it.x; it.ly = it.ly2;
  }
}

// Rechteck im um (ox, oy) um ang gedrehten Koordinatensystem: u entlang der Schrift, v quer dazu
function rotRect(ox, oy, ang, u0, u1, v0, v1) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const pt = (u, v) => [ox + u * c - v * s, oy + u * s + v * c];
  return [pt(u0, v0), pt(u1, v0), pt(u1, v1), pt(u0, v1)];
}
// Trennende Achse: zwei konvexe Vierecke überlappen, wenn keine Kantennormale sie trennt
function polysOverlap(a, b) {
  for (const P of [a, b]) for (let i = 0; i < 4; i++) {
    const p = P[i], q = P[(i + 1) % 4], nx = q[1] - p[1], ny = p[0] - q[0];
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const r of a) { const d = r[0] * nx + r[1] * ny; amin = Math.min(amin, d); amax = Math.max(amax, d); }
    for (const r of b) { const d = r[0] * nx + r[1] * ny; bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
    if (amax <= bmin || bmax <= amin) return false;
  }
  return true;
}

// Erkannter Horizont im Foto (Testanzeige)
function drawPhotoSky(g, cam) {
  const ys = state.photoSky; if (!ys || !state.img) return;
  const sx = cam.rect[2] / ys.length, sy = cam.rect[3] / (ys.length * state.img.height / state.img.width);
  g.strokeStyle = 'rgba(255,60,200,0.9)'; g.lineWidth = 1.5;
  g.beginPath();
  ys.forEach((y, x) => { const X = cam.rect[0] + (x + 0.5) * sx, Y = cam.rect[1] + y * sy; x ? g.lineTo(X, Y) : g.moveTo(X, Y); });
  g.stroke();
}

const DIR16 = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
// „+1,5“, „−0,8“, „±0,0“
const signed = (v) => { v = Number(v) || 0; return (v > 0.05 ? '+' : v < -0.05 ? '−' : '±') + Math.abs(v).toFixed(1).replace('.', ','); };

function updateInfo(cam) {
  const P = state.pano;
  if (!P) return;
  const hpr = hprFromBasis(cam);
  const dir = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'][Math.round(hpr.heading / 45) % 8];
  const coarse = P.detail && P.detail.total && P.detail.failed === P.detail.total ? ' · nur grobes Gelände' : '';
  if (state.mode === 'live') {
    const L = state.live;
    const place = state.loc.name && state.loc.name !== 'GPS' ? state.loc.name : `${P.lat.toFixed(3)}, ${P.lon.toFixed(3)}`;
    const look = `${Math.round(hpr.heading)}° ${DIR16[Math.round(hpr.heading / 22.5) % 16]}`;
    $('info').textContent = L.adjust ? `Kompass ${signed(state.settings.offset)}° · Drehung ${signed(state.settings.camRoll)}°`
      : L.frozen ? `Aufnahme · ${place} · ${look}` : `${place} · ${Math.round(P.h0)} m · ${look}`;
    return;
  }
  $('info').textContent = `${state.loc.name ? state.loc.name + ' · ' : ''}${P.lat.toFixed(4)}, ${P.lon.toFixed(4)} · ${Math.round(P.h0)} m · Blick ${Math.round(hpr.heading)}° ${dir}${coarse}`;
}

// ---------------------------------------------------------------- Panorama

// Panorama-/Kamera-Reiter: zuerst sofort ein Panorama aus dem, was schon im Speicher ist (grobes Gelände,
// Übersichtsfarben), dann Detailgelände und Satellitenbilder nachladen und das Bild verfeinern. Ohne
// Detail-Einstellung bleibt es beim schnellen Panorama und es wird nichts nachgeladen.
// Foto: in einem Schritt mit Detailgelände, aber nur im möglichen Blickbereich und ohne Satellitenbilder;
// so ist es schnell und die Linien sind von Anfang an genau.
let panoJob = 0;
const photoMode = () => state.mode === 'photo' && !!state.img;
// Blickbereich, in dem das Ausrichten sucht: [Mitte, halbe Breite] in Grad (null = rundum)
function photoSector() {
  const a = state.alignHint;
  if (!a || a.headingRange >= 120) return null;
  const fMax = Array.isArray(a.fovRange) ? a.fovRange[1] : a.hfov * (1 + a.fovRange);
  return [((a.heading % 360) + 360) % 360, Math.min(180, a.headingRange + fMax * 0.6 + 6)];
}
// Passt das aktuelle Panorama zum Foto (Detailgelände, Blickbereich abgedeckt)?
function photoPanoOk(P = state.pano) {
  if (!P || !P.photo || P.lat !== state.loc.lat || P.lon !== state.loc.lon) return false;
  const want = photoSector();
  if (!P.sector) return true;
  if (!want) return false;
  return Math.abs(((want[0] - P.sector[0] + 540) % 360) - 180) + want[1] <= P.sector[1] + 0.01;
}
async function computePanorama() {
  const job = ++panoJob;
  const { lat, lon, agl } = state.loc;
  const el = await call('elev', { lat, lon });
  if (!el.covered) { showHint('Dieser Standort liegt außerhalb der Alpen-Daten.', 4000); }
  const base = { lat, lon, agl: Number(agl) || 2, alt: state.loc.alt ?? null, maxDist: state.settings.maxDist, sun: photoMode() ? null : sunParam() };
  if (photoMode()) {
    showHint('Lade Gelände in Blickrichtung…');
    const res = await call('panorama', { ...base, detail: true, satellite: false, noSat: true, sector: photoSector() });
    if (job !== panoJob) return state.pano;
    res.photo = true; res.lat = lat; res.lon = lon;
    applyPanorama(res);
    if (res.detail.failed) showHint(navigator.onLine ? `${res.detail.failed} Detailkacheln nicht geladen, dort gröberes Gelände.` : 'Offline: Nahbereich etwas gröber (feinste Stufe nicht gespeichert).', 4000);
    return res;
  }
  const on = state.settings.detail !== false;
  const opts = { ...base, detail: on, satellite: on };
  const quick = await call('panorama', { ...opts, quick: true });
  if (job !== panoJob) return state.pano;
  quick.lat = lat; quick.lon = lon;
  applyPanorama(quick);
  if (quick.complete) { hideHint(); return quick; }
  showHint('Panorama steht. Lade Details…');
  call('panorama', opts).then((res) => {
    if (job !== panoJob) return;
    res.lat = lat; res.lon = lon;
    applyPanorama(res);
    if (res.detail.total && res.detail.failed === res.detail.total) showHint('Offline: Nahbereich nur grob. Speichere Gebiete vorab unter „Standort“.', 6000);
    else if (res.detail.failed) showHint(navigator.onLine ? `${res.detail.failed} Detailkacheln nicht geladen, dort gröberes Gelände.` : 'Offline: Nahbereich etwas gröber (feinste Stufe nicht gespeichert).', 4000);
    else hideHint();
    refineAlign();
  }).catch(() => { /* von einem neueren Standort abgelöst */ });
  return quick;
}

function applyPanorama(res) {
  state.pano = res;
  fill.key = '';
  updateSunInfo();
  console.log(`Panorama${res.quick ? ' (schnell)' : ''}: ${res.ms} ms, Laden ${res.times.detail + res.times.sat} ms, ${res.segD.length} Segmente, ${res.peaks.length} sichtbare Gipfel`);
  requestDraw();
}

// Foto wurde am schnellen Panorama ausgerichtet: mit dem Detailpanorama nochmals ausrichten,
// solange niemand von Hand nachgebessert hat
let alignBusy = false, realignPending = false;
function refineAlign() {
  const A = state.lastAlign;
  if (state.mode !== 'photo' || !state.img || !A || !A.pano || !A.pano.quick || A.pano === state.pano || state.anchors.length) return;
  const v = state.view;
  if (Math.abs(v.heading - A.heading) > 0.01 || Math.abs(v.pitch - A.pitch) > 0.01 || Math.abs(v.hfov - A.hfov) > 0.01 || Math.abs(v.roll - A.roll) > 0.01) return;
  if (alignBusy) { realignPending = true; return; }
  autoAlign();
}

function setLocation(loc, recompute = true) {
  state.target = null;
  state.loc = { agl: state.loc.agl ?? 2, ...loc };
  store.set('loc', state.loc);
  if (recompute) return computePanorama();
}

// ---------------------------------------------------------------- Hinweise

let hintTimer = 0;
function showHint(text, ms) {
  const h = $('hint'); h.textContent = text; h.hidden = false;
  clearTimeout(hintTimer);
  if (ms) hintTimer = setTimeout(hideHint, ms);
}
function hideHint() { $('hint').hidden = true; }

// ---------------------------------------------------------------- Modi

function setMode(mode) {
  if (state.mode === 'live' && mode !== 'live') stopLive();
  // Ansicht des Fotos merken, Panorama und Kamera benutzen state.view anders
  if (state.mode === 'photo' && mode !== 'photo') state.photoView = { ...state.view };
  if (mode === 'photo' && state.mode !== 'photo' && state.photoView) { state.view = { ...state.photoView }; state.photoView = null; }
  state.mode = mode;
  // Panorama fürs Foto (nur Blickbereich, ohne Satellitenfarben) taugt nicht für Panorama und Kamera
  if (mode !== 'photo' && state.pano && state.pano.photo && (mode === 'pano' || state.pano.sector)) computePanorama();
  $('photobar').hidden = mode !== 'photo';
  if (mode !== 'pano') $('sunBar').hidden = true;
  $('btnSun').hidden = mode === 'photo';
  syncLiveUi();
  if (mode === 'photo') syncSliders();
  requestDraw();
}

// ---------------------------------------------------------------- Live-Kamera

const live = state.live;
let orientHandler = null;

async function startLive() {
  if (state.mode === 'live') { if (live.frozen) retake(); return; }
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') throw new Error('Zugriff auf Lagesensoren verweigert');
    }
    await openStream(null);
  } catch (e) {
    showHint('Kamera nicht verfügbar: ' + e.message, 5000);
    return;
  }
  const track = live.stream.getVideoTracks()[0];
  live.cur = { deviceId: track && track.getSettings ? track.getSettings().deviceId || null : null, base: 1 };
  live.basis = null; live.frozen = null; live.adjust = false;
  live.zoom = live.dz = 1; applyVideoScale();
  // Zoomstufen: zuerst die gespeicherten dieses Geräts, dann neu erkennen
  const cached = store.get('lenses', null);
  live.lenses = cached && cached.key === deviceKey() ? cached.lenses : [{ z: 1, base: 1, deviceId: live.cur.deviceId }, { z: 2, base: 1, deviceId: live.cur.deviceId }];
  renderZoomBar();
  detectLenses().then((l) => { live.lenses = l; store.set('lenses', { key: deviceKey(), lenses: l }); renderZoomBar(); }).catch((e) => console.warn('Objektive:', e));
  const useAbs = 'ondeviceorientationabsolute' in window;
  orientHandler = (ev) => {
    if (live.frozen) return; // fixierte Aufnahme: Sensoren pausieren
    let alpha = ev.alpha;
    if (ev.webkitCompassHeading != null) alpha = 360 - ev.webkitCompassHeading;
    else if (!useAbs && !ev.absolute) return;
    if (alpha == null || ev.beta == null) return;
    const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    const B = rotateYaw(basisFromDevice(alpha, ev.beta, ev.gamma, angle), DECLINATION);
    live.raw = B;
    live.basis = smooth(live.basis, B, 0.25);
    requestDraw();
  };
  addEventListener(useAbs ? 'deviceorientationabsolute' : 'deviceorientation', orientHandler);
  setMode('live');
  showHint('Halte das Handy auf die Berge. Passt es nicht: „Overlay anpassen“.', 4000);
  if (navigator.geolocation) useGps(false);
}

function stopLive() {
  if (orientHandler) { removeEventListener('deviceorientationabsolute', orientHandler); removeEventListener('deviceorientation', orientHandler); orientHandler = null; }
  if (live.stream) live.stream.getTracks().forEach((t) => t.stop());
  live.stream = null; $('video').srcObject = null;
  live.frozen = null; live.adjust = false;
}

// Rückkamera öffnen (deviceId: bestimmtes Objektiv, sonst die Standard-Rückkamera)
async function openStream(deviceId) {
  const v = $('video');
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  const constraints = { video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: 'environment', ...size }, audio: false };
  // iOS gibt nur eine Kamera gleichzeitig frei: alte zuerst schließen
  if (live.stream) { live.stream.getTracks().forEach((t) => t.stop()); live.stream = null; }
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  live.stream = stream;
  v.srcObject = stream;
  await v.play().catch(() => {});
  if (!v.videoWidth) await new Promise((r) => { v.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 1500); });
}

function smooth(prev, next, a) {
  if (!prev) return next;
  const mix = (p, n) => { const v = [p[0] + (n[0] - p[0]) * a, p[1] + (n[1] - p[1]) * a, p[2] + (n[2] - p[2]) * a]; const l = Math.hypot(...v); return v.map((x) => x / l); };
  const f = mix(prev.f, next.f), u0 = mix(prev.u, next.u);
  const r = norm(cross(f, u0)), u = cross(r, f);
  return { f, u, r };
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };

// Sichtbarkeit der Kamera-Bedienelemente
function syncLiveUi() {
  const on = state.mode === 'live', fr = on && !!live.frozen, adj = on && live.adjust;
  $('video').hidden = !on || fr;
  $('zoombar').hidden = !on || fr || adj || live.lenses.length < 2;
  $('liveRow').hidden = !on || fr || adj;
  $('frozenBar').hidden = !fr || adj;
  $('adjSheet').hidden = !adj;
  $('btnPano').classList.toggle('active', state.mode === 'pano');
  $('btnCamera').classList.toggle('active', on);
  $('btnPhoto').classList.toggle('active', state.mode === 'photo');
}

// ---- Zoomstufen und Objektive

const fmtZoom = (z) => String(z).replace('.', ',');
function renderZoomBar() {
  const bar = $('zoombar'); bar.innerHTML = '';
  for (const l of live.lenses) {
    const b = document.createElement('button');
    const sel = l.z === live.zoom;
    b.textContent = fmtZoom(l.z) + (sel ? '×' : '');
    b.setAttribute('aria-pressed', sel);
    b.setAttribute('aria-label', fmtZoom(l.z) + '-fach Zoom');
    b.onclick = () => setZoom(l.z);
    bar.append(b);
  }
  syncLiveUi();
}

const deviceKey = () => `${navigator.userAgent}|${Math.min(screen.width, screen.height)}x${Math.max(screen.width, screen.height)}`;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Tele-Faktor kennt der Browser auf dem iPhone nicht: nach Bildschirmgröße (Punkte), sonst 3×
const IPHONE_TELE = { '430x932': 5, '440x956': 5, '402x874': 5, '393x852': 3, '428x926': 3, '390x844': 3 };
// Android-Modelle mit bekannten Stufen (aus dem User-Agent)
const ANDROID_LENSES = [
  { re: /Pixel (8|9|10) Pro/i, z: [0.5, 1, 2, 5] },
  { re: /SM-S92[38]|SM-S91[18]|SM-S93[18]/i, z: [0.6, 1, 3, 5] }, // Galaxy S23/S24/S25 Ultra
];

// Ermittelt die Zoomstufen, die das Gerät wirklich hat. Jede Stufe: z = angezeigter Zoom,
// base = optischer Zoom der Quelle (Objektiv bzw. Hardware-Zoom), deviceId = Kamera, hw = Zoom per applyConstraints.
async function detectLenses() {
  const track = live.stream && live.stream.getVideoTracks()[0];
  const curId = live.cur.deviceId;
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { /* egal */ }
  const back = devs.filter((d) => /back|rück|rear|hinten|environment/i.test(d.label) && !/front|vorder/i.test(d.label));
  if (isIOS()) {
    // einzelne Objektive; virtuelle Kameras (Dual, Triple) schalten selbst um und taugen nicht
    const single = back.filter((d) => !/dual|triple|zwei|drei/i.test(d.label));
    const ultra = single.find((d) => /ultra/i.test(d.label));
    const tele = single.find((d) => /tele/i.test(d.label));
    const main = single.find((d) => d !== ultra && d !== tele);
    const mainId = (main && main.deviceId) || curId;
    const out = [];
    if (ultra) out.push({ z: 0.5, base: 0.5, deviceId: ultra.deviceId });
    out.push({ z: 1, base: 1, deviceId: mainId }, { z: 2, base: 1, deviceId: mainId });
    if (tele) {
      const f = IPHONE_TELE[`${Math.min(screen.width, screen.height)}x${Math.max(screen.width, screen.height)}`] || 3;
      if (f > 2) out.push({ z: f, base: f, deviceId: tele.deviceId });
    }
    return out;
  }
  // Android/Chrome: Hardware-Zoom der Hauptkamera (umfasst oft Ultraweit und Tele)
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  const zr = caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null;
  const model = ANDROID_LENSES.find((m) => m.re.test(navigator.userAgent));
  let steps = model ? model.z : [1, 2];
  if (!model && zr && zr.min < 0.95) steps = [Math.round(zr.min * 10) / 10, 1, 2];
  return steps.map((z) => {
    // über dem Hardware-Bereich: Ausschnitt aus der größten Hardware-Stufe
    if (zr) return z >= zr.min - 1e-3 ? { z, base: Math.min(z, zr.max), deviceId: curId, hw: true } : null;
    return z >= 1 ? { z, base: 1, deviceId: curId } : null;
  }).filter(Boolean);
}

// Zoom wechseln: Bild und Overlay skalieren gemeinsam (0,45 s). Beim Hineinzoomen erst digital
// vergrößern, dann aufs Tele-Objektiv wechseln; beim Herauszoomen erst wechseln, dann zurückskalieren.
let zoomBusy = false;
async function setZoom(z) {
  const lens = live.lenses.find((l) => l.z === z);
  if (!lens || zoomBusy || live.frozen) return;
  zoomBusy = true; live.zoom = z; renderZoomBar();
  try {
    const sw = (lens.deviceId && lens.deviceId !== live.cur.deviceId) || lens.base !== live.cur.base;
    if (sw && lens.base < live.cur.base) await switchSource(lens);
    await animateZoom(z);
    if (sw && lens.base >= live.cur.base) await switchSource(lens);
  } catch (e) {
    console.warn('Zoom:', e);
    // Stufe als Ausschnitt der laufenden Kamera weiterführen, oder (Weitwinkel) streichen und auf 1× gehen
    const i = live.lenses.indexOf(lens);
    let back = null;
    if (z >= live.cur.base) {
      live.lenses[i] = { z, base: live.cur.base, deviceId: live.cur.deviceId, hw: !!lens.hw && live.cur.base !== 1 };
      showHint('Dieses Objektiv lässt sich nicht öffnen, zeige einen Ausschnitt.', 3000);
    } else {
      live.lenses.splice(i, 1);
      back = live.lenses.reduce((a, l) => (Math.abs(l.z - 1) < Math.abs(a.z - 1) ? l : a)).z;
      showHint('Das Weitwinkel-Objektiv lässt sich nicht öffnen.', 3000);
    }
    store.set('lenses', { key: deviceKey(), lenses: live.lenses });
    renderZoomBar(); applyVideoScale(); requestDraw();
    if (back != null) setTimeout(() => setZoom(back));
  } finally { zoomBusy = false; }
}

async function switchSource(lens) {
  const v = $('video');
  v.style.opacity = 0;
  await sleep(140);
  try {
    if (lens.hw) {
      await live.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: lens.base }] });
      await sleep(120); // bis die ersten Bilder mit neuem Zoom ankommen
    } else if (lens.deviceId && lens.deviceId !== live.cur.deviceId) {
      const prev = live.cur.deviceId;
      try { await openStream(lens.deviceId); } catch (e) { await openStream(prev).catch(() => {}); throw e; }
    }
    live.cur = { deviceId: lens.deviceId || live.cur.deviceId, base: lens.base };
  } finally {
    applyVideoScale(); requestDraw();
    v.style.opacity = 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// cubic-bezier(.2,.8,.2,1)
function easeOut(t) {
  const bez = (a, b, u) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (bez(0.2, 0.2, m) < t) lo = m; else hi = m; }
  return bez(0.8, 1, (lo + hi) / 2);
}
function animateZoom(to) {
  const from = live.dz, t0 = performance.now();
  if (Math.abs(from - to) < 1e-3) return Promise.resolve();
  return new Promise((done) => {
    const step = (t) => {
      const u = Math.min(1, (t - t0) / 450);
      // geometrisch, damit 1 → 5 gleichmäßig wirkt
      live.dz = from * (to / from) ** easeOut(u);
      applyVideoScale(); draw();
      if (u < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  });
}
function applyVideoScale() { $('video').style.transform = `scale(${live.dz / live.cur.base})`; }

// ---- Auslöser und fixierte Aufnahme

function shoot() {
  const v = $('video');
  if (!v.videoWidth || live.frozen) return;
  const vw = v.videoWidth, vh = v.videoHeight;
  // sichtbaren Ausschnitt in voller Auflösung übernehmen, wie auf dem Bildschirm
  const s = Math.max(W / vw, H / vh) * live.dz / live.cur.base;
  const sw = W / s, sh = H / s;
  const c = document.createElement('canvas'); c.width = Math.round(sw); c.height = Math.round(sh);
  c.getContext('2d').drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, c.width, c.height);
  const cam = currentCamera();
  live.frozen = {
    img: c, w: c.width, h: c.height,
    basis: live.basis || basisFromHPR(state.view.heading, state.view.pitch, 0),
    // Brennweite in Pixeln der Aufnahme, ohne Anpassen-Faktor (der bleibt nachträglich änderbar)
    F: cam.F * (Number(state.settings.camFovK) || 1) * c.width / W,
    time: new Date(),
  };
  live.last = live.frozen;
  const fl = $('flash'); fl.classList.add('on');
  setTimeout(() => fl.classList.remove('on'), 70);
  v.pause();
  setThumb(c);
  syncLiveUi(); requestDraw();
  showHint('Aufnahme fixiert – Linien sind eingebrannt');
}

function setThumb(src) {
  const t = document.createElement('canvas'); t.width = t.height = 96;
  const m = Math.min(src.width, src.height);
  t.getContext('2d').drawImage(src, (src.width - m) / 2, (src.height - m) / 2, m, m, 0, 0, 96, 96);
  $('btnThumb').style.backgroundImage = `url(${t.toDataURL('image/jpeg', 0.8)})`;
}

function retake() {
  live.frozen = null; live.adjust = false;
  $('video').play().catch(() => {});
  hideHint(); syncLiveUi(); requestDraw();
}

function openLast() {
  if (!live.last || live.frozen) return;
  live.frozen = live.last;
  $('video').pause();
  syncLiveUi(); requestDraw();
  showHint('Aufnahme fixiert – Linien sind eingebrannt');
}

// Aufnahme mit eingebranntem Overlay (mind. 1080 px breit, damit die Schrift scharf ist)
async function frozenBlob() {
  const fr = live.frozen;
  const S = Math.max(1, 1080 / fr.w), w = Math.round(fr.w * S), h = Math.round(fr.h * S);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(fr.img, 0, 0, w, h);
  const k = w / W;
  const cam = { ...camCorrect(fr.basis), F: fr.F * S / (Number(state.settings.camFovK) || 1), cx: w / 2, cy: h / 2, rect: [0, 0, w, h] };
  if (state.pano) drawOverlay(g, cam, k);
  g.font = `${11 * k}px system-ui, sans-serif`; g.fillStyle = 'rgba(255,255,255,.8)';
  g.fillText('Bergblick · © OpenStreetMap', 10 * k, h - 10 * k);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
}

async function deliverFrozen(share) {
  if (!live.frozen) return;
  const blob = await frozenBlob();
  const t = live.frozen.time;
  const name = `bergblick-${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}.jpg`;
  const file = new File([blob], name, { type: 'image/jpeg' });
  // Auf dem Handy führt „Speichern“ über das Teilen-Menü („Bild sichern“), am Rechner wird geladen
  const mobile = matchMedia('(pointer: coarse)').matches;
  if ((share || mobile) && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Bergblick' });
      showHint(share ? 'Teilen – Bild mit Overlay' : 'In Fotos gespeichert – mit Overlay', 2200);
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  showHint(share ? 'Teilen nicht möglich – Bild mit Overlay geladen' : 'Gespeichert – mit Overlay', 2200);
}

// ---- Overlay anpassen

function openCamAdjust(on) {
  live.adjust = on;
  if (on) { hideHint(); syncAdjust(); }
  else { saveSettings(); if (live.frozen) showHint('Aufnahme fixiert – Linien sind eingebrannt'); }
  syncLiveUi(); requestDraw();
}
function syncAdjust() {
  const c = state.settings;
  $('adjRot').value = Math.round((Number(c.camRoll) || 0) * 10);
  $('adjRotVal').textContent = signed(c.camRoll) + '°';
  $('adjFov').value = Math.round((Number(c.camFovK) || 1) * 100);
  $('adjFovVal').textContent = Math.round((Number(c.camFovK) || 1) * 100) + ' %';
}
function resetCamAdjust() {
  Object.assign(state.settings, { offset: 0, camPitch: 0, camRoll: 0, camFovK: 1 });
  saveSettings(); syncAdjust(); requestDraw();
}

// Gipfel im Kamerabild antippen: Kompass und Neigung so korrigieren, dass er dort liegt
function cameraAnchor(x, y) {
  const p = state.anchorPick; state.anchorPick = null;
  for (let i = 0; i < 4; i++) {
    const cam = currentCamera(), q = project(p.v, cam);
    if (!q) break;
    const dpp = Math.atan(1 / cam.F) * 180 / Math.PI;
    state.settings.offset = (Number(state.settings.offset) || 0) - (x - q[0]) * dpp;
    state.settings.camPitch = (Number(state.settings.camPitch) || 0) + (y - q[1]) * dpp;
  }
  saveSettings(); requestDraw();
  showHint(`${p.name} zugeordnet.`, 3000);
}

// ---------------------------------------------------------------- Foto laden

async function loadPhoto(file, saved = null) {
  if (saved) return openSaved(file, saved);
  const buf = await file.arrayBuffer();
  let exif = null;
  try { exif = readExif(buf); } catch { exif = null; }
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(async () => {
    const im = new Image(); im.src = URL.createObjectURL(file); await im.decode(); return im;
  });
  state.img = img; state.imgName = file.name.replace(/\.[^.]+$/, '') + '-bergblick'; state.photoView = null; state.photoId = null;
  state.anchors = []; state.photoSky = null; state.lastAlign = null; state.alignHint = null;
  resetZoom(); setAdjust(false);
  const iw = img.width, ih = img.height;
  let hfov = 60, headingKnown = false, heading = state.view.heading;
  if (exif && exif.FocalLength35) hfov = hfovFrom35mm(exif.FocalLength35, iw, ih);
  // iPhone-Tele „120 mm“ (15/16 Pro Max) zeigt real ~2,8 % weniger Bildwinkel (an echten Fotos gemessen)
  if (exif && exif.FocalLength35 === 120 && /apple/i.test(exif.Make || '')) hfov *= 0.972;
  if (exif && typeof exif.heading === 'number') { heading = exif.heading + (exif.headingRef === 'M' ? DECLINATION : 0); headingKnown = true; }
  state.view = { heading, pitch: 0, roll: 0, hfov };
  // ohne Brennweite im Foto: alles vom Tele bis zum Ultraweitwinkel absuchen
  // Suchbereich aus den Fotodaten merken: „Auto-Ausrichten“ startet später wieder von hier
  state.alignHint = { heading, hfov, headingRange: headingKnown ? 25 : 180, fovRange: exif && exif.FocalLength35 ? 0.05 : [25, 120] };
  stopLive();
  setMode('photo');
  const hasGps = exif && exif.lat != null;
  if (hasGps) await setLocation({ lat: exif.lat, lon: exif.lon, alt: typeof exif.alt === 'number' && exif.alt > -500 ? exif.alt : null, name: '' }, false);
  showHint((hasGps ? 'Standort aus Foto übernommen' : 'Foto ohne GPS-Daten: Standort prüfen') + ' · richte aus…');
  await autoAlign();
  // Das Handy speichert, wie genau die Position war; liegt sie weit daneben, passen die Linien nicht
  const err = hasGps && exif.gpsError;
  state.gpsError = err || null;
  if (state.img === img) await histAdd(file, img);
  if (!hasGps) showHint('Kein GPS im Foto. Tippe auf „Standort“, falls die Linien nicht passen.', 6000);
  else if (err > 150 && state.img === img) {
    // ungenaue Position: in der Umgebung den Ort suchen, an dem die Bergumrisse passen
    await searchLocation(Math.min(3000, Math.max(500, err * 2)), `Die GPS-Position im Foto ist ungenau (±${fmtDist(err)}).`);
  }
}
const fmtDist = (m) => m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m) + ' m';

// Sucht immer im ursprünglichen Bereich aus den Fotodaten (Kompass, Brennweite). Die aktuelle Ansicht
// und die letzte Ausrichtung werden zusätzlich als Startwerte geprüft; so stört ein versehentlich
// verschobenes Overlay nicht, und ein gutes Ergebnis geht nicht verloren.
async function autoAlign() {
  if (!state.img) return;
  if (alignBusy) { realignPending = true; return; }
  alignBusy = true; realignPending = false;
  const btn0 = $('btnAlign'); btn0.disabled = true; btn0.querySelector('span').textContent = 'Richte aus…';
  try { if (!photoPanoOk()) { await computePanorama(); showHint('Richte aus…'); } } catch (e) { /* unten: ohne Panorama kein Ausrichten */ }
  if (!state.pano) { alignBusy = false; btn0.disabled = false; btn0.querySelector('span').textContent = 'Ausrichten'; return; }
  const P = state.pano;
  const base = state.alignHint || { heading: state.view.heading, hfov: state.view.hfov, headingRange: 180, fovRange: [25, 120] };
  const seeds = [{ ...state.view }];
  if (state.lastAlign && state.lastAlign.pano === state.pano) seeds.push({ heading: state.lastAlign.heading, pitch: state.lastAlign.pitch, roll: state.lastAlign.roll, hfov: state.lastAlign.hfov });
  const btn = $('btnAlign'); btn.disabled = true; btn.querySelector('span').textContent = 'Richte aus…';
  try {
    const { px, w, h } = photoPixels(640);
    const r = await call('align', { pixels: px.buffer, w, h, panoId: P.pid, hint: { ...base, seeds, truth: state.testTruth } }, [px.buffer]);
    r.pano = P;
    state.lastAlign = r;
    state.view = { heading: r.heading, pitch: r.pitch, roll: r.roll, hfov: r.hfov };
    state.photoSky = r.photoSky;
    state.anchors = [];
    console.log(`Ausrichtung: ${r.ms} ms, Übereinstimmung ${(r.match * 100).toFixed(0)} %`, r);
    syncSliders();
    if (!P.quick || P.complete) showHint(r.match > 0.6 ? 'Ausgerichtet. Zum Zoomen Mausrad oder zwei Finger. Liegt es daneben: „Anpassen“.' : 'Unsicher. Unter „Anpassen“ kannst du Gipfel zuordnen oder das Overlay verschieben.', 7000);
    else showHint('Grob ausgerichtet. Lade Details für die Feinausrichtung…');
    requestDraw();
  } catch (e) { showHint('Ausrichten fehlgeschlagen: ' + e.message, 4000); }
  finally {
    btn.disabled = false; btn.querySelector('span').textContent = 'Ausrichten';
    alignBusy = false;
    // Detailpanorama kam während des Ausrichtens an
    if (realignPending || (state.pano !== P && P.quick)) { realignPending = false; refineAlign(); }
  }
}

// Foto auf Rechengröße verkleinern: zuerst vom Browser auf das 4-Fache (in Halbierungsschritten), dann
// selbst über je 4 × 4 Pixel mitteln. So bekommt das Ausrichten in jedem Browser fast dieselben Pixel;
// ein einziger großer Sprung (4000 → 640 px) ließe feine Grate flimmern und Kanten wandern.
function photoPixels(w) {
  let src = state.img, sw = src.width, sh = src.height;
  const h = Math.round(w * sh / sw);
  const k = Math.max(1, Math.min(4, Math.floor(sw / w)));
  const step = (cw, ch) => {
    const c = new OffscreenCanvas(cw, ch), g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, cw, ch);
    src = c; sw = cw; sh = ch;
    return g;
  };
  while (sw / 2 >= w * k) step(Math.round(sw / 2), Math.round(sh / 2));
  const big = step(w * k, h * k).getImageData(0, 0, w * k, h * k).data;
  const px = new Uint8ClampedArray(w * h * 4), W2 = w * k, n = k * k;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let yy = y * k; yy < y * k + k; yy++) for (let xx = x * k; xx < x * k + k; xx++) { const j = (yy * W2 + xx) * 4; r += big[j]; g += big[j + 1]; b += big[j + 2]; }
    const o = (y * w + x) * 4; px[o] = r / n; px[o + 1] = g / n; px[o + 2] = b / n; px[o + 3] = 255;
  }
  return { px, w, h };
}

function syncSliders() {
  $('fov').value = state.view.hfov; $('fovVal').textContent = Math.round(state.view.hfov) + '°';
  $('roll').value = state.view.roll;
}

async function saveImage() {
  const img = state.img; if (!img) return;
  const scale = Math.min(1, 4096 / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  const cam = { ...basisFromHPR(state.view.heading, state.view.pitch, state.view.roll), F: focalPx(w, state.view.hfov), cx: w / 2, cy: h / 2, rect: [0, 0, w, h] };
  const k = Math.max(1, w / 1400);
  const saved = state.labels;
  drawOverlay(g, cam, k);
  state.labels = saved;
  g.font = `${12 * k}px system-ui, sans-serif`; g.fillStyle = 'rgba(255,255,255,.8)';
  g.fillText('Bergblick · © OpenStreetMap', 10 * k, h - 10 * k);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  const file = new File([blob], state.imgName + '.jpg', { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Bergblick' }); return; } catch { /* abgebrochen */ }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------- Gesten auf der Bühne

const pointers = new Map();
let gesture = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  gesture = newGesture(false);
});
function newGesture(moved) {
  return { start: [...pointers.values()].map((p) => [...p]), view: { ...state.view }, zoom: { ...state.zoom }, offset: Number(state.settings.offset || 0), pitch: Number(state.settings.camPitch || 0), moved, t: performance.now() };
}
// Im Foto-Modus bewegen Ziehen und Zoomen nur die Ansicht; Foto und Overlay bleiben aufeinander.
const viewGestures = () => state.mode === 'photo' && state.img && !state.adjust;
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId) || !gesture) return;
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  const pts = [...pointers.values()];
  const cam = currentCamera();
  const degPerPx = Math.atan(1 / cam.F) * 180 / Math.PI;
  if (pts.length === 1 && gesture.start.length === 1) {
    const dx = pts[0][0] - gesture.start[0][0], dy = pts[0][1] - gesture.start[0][1];
    if (Math.hypot(dx, dy) > 4) gesture.moved = true;
    if (!gesture.moved) return;
    if (viewGestures()) {
      state.zoom.x = gesture.zoom.x + dx; state.zoom.y = gesture.zoom.y + dy;
      clampZoom();
    } else if (state.mode === 'live' && live.adjust) {
      // Anpassen: waagrecht = Kompass-Korrektur, senkrecht = Neigung
      state.settings.offset = gesture.offset - dx * degPerPx;
      state.settings.camPitch = Math.max(-15, Math.min(15, gesture.pitch + dy * degPerPx));
    } else if (state.mode === 'live' && (live.basis || live.frozen)) {
      return; // Blickrichtung kommt vom Kompass
    } else {
      state.view.heading = (gesture.view.heading - dx * degPerPx + 360) % 360;
      state.view.pitch = Math.max(-60, Math.min(60, gesture.view.pitch + dy * degPerPx));
    }
    requestDraw();
  } else if (pts.length === 2 && gesture.start.length === 2 && state.mode !== 'live') {
    gesture.moved = true;
    const d0 = Math.hypot(gesture.start[0][0] - gesture.start[1][0], gesture.start[0][1] - gesture.start[1][1]);
    const d1 = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
    if (viewGestures()) {
      // Zoom um den Mittelpunkt der beiden Finger, Verschieben mit
      const m0 = [(gesture.start[0][0] + gesture.start[1][0]) / 2, (gesture.start[0][1] + gesture.start[1][1]) / 2];
      const m1 = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
      state.zoom = { ...gesture.zoom };
      zoomAt(d1 / d0, m0[0], m0[1]);
      state.zoom.x += m1[0] - m0[0]; state.zoom.y += m1[1] - m0[1];
      clampZoom(); requestDraw();
    } else setFov(gesture.view.hfov * d0 / d1);
  }
});
const endPointer = (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (gesture && !gesture.moved && pointers.size === 0) tap(e.clientX, e.clientY);
  if (gesture && state.mode === 'live' && live.adjust && gesture.moved) saveSettings();
  if (pointers.size === 0) gesture = null;
  else gesture = newGesture(true);
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (viewGestures()) { zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); clampZoom(); requestDraw(); }
  else if (state.mode !== 'live') setFov(state.view.hfov * Math.exp(e.deltaY * 0.001));
}, { passive: false });
canvas.addEventListener('dblclick', () => { if (viewGestures()) resetZoom(); });

// Bildzoom: Punkt (px, py) bleibt beim Zoomen an seiner Stelle
function zoomAt(f, px, py) {
  if (!state.img) return;
  const iw = state.img.width, ih = state.img.height, fit = Math.min(W / iw, H / ih);
  const z = state.zoom, s0 = fit * z.s;
  const ns = Math.max(1, Math.min(40, z.s * f)), s1 = fit * ns;
  const rx0 = (W - iw * s0) / 2 + z.x, ry0 = (H - ih * s0) / 2 + z.y;
  const u = (px - rx0) / s0, v = (py - ry0) / s0;
  z.s = ns;
  z.x = px - u * s1 - (W - iw * s1) / 2;
  z.y = py - v * s1 - (H - ih * s1) / 2;
}
function clampZoom() {
  $('btnZoomReset').hidden = state.zoom.s <= 1.001;
  if (!state.img) return;
  const iw = state.img.width, ih = state.img.height, s = Math.min(W / iw, H / ih) * state.zoom.s;
  const mx = Math.max(0, (iw * s - W) / 2), my = Math.max(0, (ih * s - H) / 2);
  state.zoom.x = Math.max(-mx, Math.min(mx, state.zoom.x));
  state.zoom.y = Math.max(-my, Math.min(my, state.zoom.y));
}
function resetZoom() { state.zoom = { s: 1, x: 0, y: 0 }; clampZoom(); requestDraw(); }
function setAdjust(on) {
  state.adjust = on;
  $('btnAdjust').classList.toggle('on', on);
  if (on) showHint('Ziehen verschiebt jetzt das Overlay, Zoomen ändert den Bildwinkel. Nochmal tippen zum Beenden.', 5000);
}

function setFov(f) {
  state.view.hfov = Math.max(state.mode === 'photo' ? 5 : 3, Math.min(state.mode === 'photo' ? 120 : 150, f));
  if (state.mode === 'photo') syncSliders();
  requestDraw();
}

function tap(x, y) {
  if (state.anchorPick && state.mode === 'photo' && state.img) { setAnchor(x, y); return; }
  if (state.anchorPick && state.mode === 'live') { cameraAnchor(x, y); return; }
  // Treffer auf Gipfelpunkt oder entlang der Beschriftungslinie
  let best = null, bd = 28;
  for (const l of state.labels) {
    const onStem = y <= l.y + 6 && y >= l.ly - 120 ? Math.abs(l.x - x) : Infinity;
    const d = Math.min(Math.hypot(l.x - x, l.y - y), onStem);
    if (d < bd) { bd = d; best = l; }
  }
  const card = $('peakCard');
  if (!best) { card.hidden = true; state.selected = null; state.target = null; requestDraw(); return; }
  const p = best.p;
  state.selected = p.i;
  const dir = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(p.az / 22.5) % 16];
  card.innerHTML = `<b></b>${Math.round(p.ele)} m · ${(p.dist / 1000).toFixed(1)} km · ${Math.round(p.az)}° ${dir}`;
  card.querySelector('b').textContent = p.name;
  if (state.mode === 'photo') {
    const b = document.createElement('button');
    b.className = 'chip primary'; b.textContent = 'Im Foto setzen';
    b.onclick = () => {
      state.anchorPick = p; card.hidden = true;
      showHint(`Tippe im Foto genau auf ${p.name}.`);
    };
    card.append(document.createElement('br'), b);
  }
  card.hidden = false;
  requestDraw();
}

// ---------------------------------------------------------------- Ausrichten über Gipfel (von Hand)

function setAnchor(x, y) {
  const cam = currentCamera(), iw = state.img.width, ih = state.img.height;
  const p = state.anchorPick;
  state.anchorPick = null;
  const ax = (x - cam.rect[0]) / cam.rect[2] * iw, ay = (y - cam.rect[1]) / cam.rect[3] * ih;
  state.anchors = (state.anchors || []).filter((a) => a.i !== p.i).slice(-1);
  state.anchors.push({ i: p.i, v: p.v, x: ax, y: ay, name: p.name, az: p.az, el: p.el });
  solveAnchors();
  showHint(state.anchors.length < 2 ? 'Gut. Für Bildwinkel und Drehung noch einen zweiten, weit entfernten Gipfel setzen.' : 'Mit zwei Gipfeln ausgerichtet.', 5000);
}

function solveAnchors() {
  const A = state.anchors; if (!A || !A.length) return;
  const iw = state.img.width, ih = state.img.height;
  const err = (v) => {
    const cam = { ...basisFromHPR(v.heading, v.pitch, v.roll), F: focalPx(iw, v.hfov), cx: iw / 2, cy: ih / 2 };
    let e = 0;
    for (const a of A) { const q = project(a.v, cam); if (!q) return 1e15; e += (q[0] - a.x) ** 2 + (q[1] - a.y) ** 2; }
    return e;
  };
  // Startwert: erster Gipfel genau auf den getippten Punkt (ohne Drehung)
  let v = { ...state.view };
  const F = focalPx(iw, v.hfov), a0 = A[A.length - 1];
  v.heading = (a0.az - Math.atan((a0.x - iw / 2) / F) * 180 / Math.PI + 360) % 360;
  v.pitch = a0.el - Math.atan((ih / 2 - a0.y) / F) * 180 / Math.PI;
  const keys = A.length >= 2 ? ['heading', 'pitch', 'roll', 'hfov'] : ['heading', 'pitch'];
  let e = err(v);
  for (const st of [4, 2, 1, 0.5, 0.2, 0.05, 0.01, 0.002]) {
    let improved = true, it = 0;
    while (improved && it++ < 300) {
      improved = false;
      for (const k of keys) for (const sgn of [1, -1]) {
        const q = { ...v, [k]: v[k] + sgn * (k === 'hfov' ? st * v.hfov / 40 : st) };
        if (q.hfov < 3 || q.hfov > 130 || Math.abs(q.roll) > 25) continue;
        const eq = err(q);
        if (eq < e) { e = eq; v = q; improved = true; }
      }
    }
  }
  v.heading = (v.heading + 360) % 360;
  state.view = v; syncSliders(); requestDraw();
}

function drawAnchors(cam) {
  if (!state.anchors || !state.img) return;
  const iw = state.img.width;
  for (const a of state.anchors) {
    const x = cam.rect[0] + a.x / iw * cam.rect[2], y = cam.rect[1] + a.y / state.img.height * cam.rect[3];
    ctx.strokeStyle = '#ffb547'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y); ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14); ctx.stroke();
  }
}

// ---------------------------------------------------------------- Standort-Blatt mit Karte

// Reliefkacheln aus dem eigenen Höhenmodell (offline), als Ersatz für das Satellitenbild
async function reliefTile(z, x, y) {
  const r = await call('reliefTile', { z, x, y });
  return createImageBitmap(new ImageData(new Uint8ClampedArray(r.pixels), 256, 256));
}
const map = new SlippyMap($('map'), {
  reliefTile,
  peaksIn: async (b) => (await call('peaksIn', b)).peaks,
  onPick: (p) => choosePlace(p.lat, p.lon, '', false),
});
map.pickName = '';

function openLocation() {
  $('locSheet').hidden = false; $('setSheet').hidden = true;
  map.pick = { lat: state.loc.lat, lon: state.loc.lon }; map.pickName = state.loc.name || '';
  $('inLat').value = state.loc.lat.toFixed(5); $('inLon').value = state.loc.lon.toFixed(5); $('inAgl').value = state.loc.agl ?? 2;
  $('pickInfo').textContent = 'Tippe auf die Karte, um deinen Standort zu setzen. Ziehen verschiebt, zwei Finger oder Mausrad zoomen.';
  map.resize();
  map.setView(state.loc.lat, state.loc.lon, Math.max(map.zoom, 11));
}
addEventListener('resize', () => { if (!$('locSheet').hidden) map.resize(); });

// Ort übernehmen (Karte, Suche, GPS); move: Karte dorthin schieben
function choosePlace(lat, lon, name, move, zoom) {
  map.pick = { lat, lon }; map.pickName = name || '';
  $('inLat').value = lat.toFixed(5); $('inLon').value = lon.toFixed(5);
  if (move) map.setView(lat, lon, zoom ?? Math.max(map.zoom, 13)); else map.draw();
  $('pickInfo').textContent = name ? `Gewählt: ${name}` : 'Gewählt…';
  call('elev', { lat, lon }).then((r) => {
    if (map.pick.lat !== lat || map.pick.lon !== lon) return;
    $('pickInfo').textContent = r.covered ? `Gewählt: ${name ? name + ' · ' : ''}${lat.toFixed(4)}, ${lon.toFixed(4)} · ${Math.round(r.elev)} m` : 'Außerhalb der Alpen-Daten';
  });
}

$('mapLayer').onclick = () => {
  map.setLayer(map.layer === 'sat' ? 'relief' : 'sat');
  $('mapLayer').textContent = map.layer === 'sat' ? 'Relief' : 'Satellit';
};
function zoomMap(d) { map.animateZoom(Math.round(map.zoom) + d); }

// Suche: Gipfel offline, Orte zusätzlich online (Photon, OpenStreetMap-Daten)
let searchTimer = 0, searchSeq = 0;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('search').value.trim(), seq = ++searchSeq;
    const ul = $('results');
    if (!q) { ul.innerHTML = ''; return; }
    const r = await call('search', { q, lat: state.loc.lat, lon: state.loc.lon });
    const items = r.results.slice(0, 8).map((p) => ({ name: p.name, sub: `Gipfel · ${Math.round(p.ele)} m`, lat: p.lat, lon: p.lon, zoom: 14 }));
    const show = () => {
      if (seq !== searchSeq) return;
      ul.innerHTML = '';
      for (const p of items) {
        const li = document.createElement('li');
        li.textContent = p.name;
        const sp = document.createElement('span'); sp.textContent = p.sub; li.append(sp);
        li.onclick = () => { choosePlace(p.lat, p.lon, p.name, true, p.zoom); ul.innerHTML = ''; $('search').blur(); };
        ul.append(li);
      }
    };
    show();
    if (q.length < 3 || navigator.onLine === false) return;
    try {
      const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=de&lat=${state.loc.lat}&lon=${state.loc.lon}`);
      const j = await res.json();
      const kinds = { city: 'Stadt', town: 'Stadt', village: 'Ort', hamlet: 'Weiler', suburb: 'Ortsteil', peak: 'Gipfel', alpine_hut: 'Hütte', wilderness_hut: 'Hütte', mountain_pass: 'Pass', saddle: 'Sattel', viewpoint: 'Aussichtspunkt', lake: 'See', station: 'Bahnhof' };
      for (const f of j.features || []) {
        const pr = f.properties || {}, [lon, lat] = f.geometry.coordinates;
        if (!pr.name || items.some((it) => it.name === pr.name && Math.abs(it.lat - lat) < 0.01)) continue;
        const where = [pr.state, pr.country].filter(Boolean).join(', ');
        const big = ['city', 'town'].includes(pr.osm_value);
        items.push({ name: pr.name, sub: [kinds[pr.osm_value] || 'Ort', where].filter(Boolean).join(' · '), lat, lon, zoom: big ? 12 : 14 });
      }
      show();
    } catch { /* offline oder gesperrt: nur Gipfel */ }
  }, 200);
});

function useGps(fromSheet) {
  if (!navigator.geolocation) { showHint('GPS nicht verfügbar', 3000); return; }
  showHint('Suche GPS-Position…');
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    hideHint();
    if (fromSheet) choosePlace(lat, lon, 'GPS', true, 14);
    else setLocation({ lat, lon, name: 'GPS' });
  }, (err) => showHint('GPS-Fehler: ' + err.message, 4000), { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
}

$('btnGps').onclick = () => useGps(true);
$('btnPrefetch').onclick = async () => {
  const p = map.pick || state.loc;
  const btn = $('btnPrefetch'); btn.disabled = true;
  try {
    const r = await call('prefetch', { lat: p.lat, lon: p.lon });
    $('pickInfo').textContent = r.failed ? `${r.total - r.failed} von ${r.total} Kacheln gespeichert (keine Verbindung?)` : `Gebiet gespeichert: ${r.total} Kacheln, ${(r.bytes / 1e6).toFixed(0)} MB. Funktioniert jetzt offline.`;
  } catch (e) { $('pickInfo').textContent = 'Speichern fehlgeschlagen: ' + e.message; }
  btn.disabled = false;
};
$('zoomIn').onclick = () => zoomMap(1);
$('zoomOut').onclick = () => zoomMap(-1);
$('btnSetLoc').onclick = () => {
  const lat = parseFloat($('inLat').value.replace(',', '.')), lon = parseFloat($('inLon').value.replace(',', '.'));
  const agl = parseFloat($('inAgl').value.replace(',', '.')) || 2;
  if (!isFinite(lat) || !isFinite(lon)) { showHint('Ungültige Koordinaten', 3000); return; }
  state.loc.agl = agl;
  $('locSheet').hidden = true;
  setLocation({ lat, lon, agl, name: map.pickName || '' }).then(() => { if (state.mode === 'photo') autoAlign(); });
};

// ---------------------------------------------------------------- Einstellungen

function openSettings() {
  $('appVersion').textContent = 'Version ' + APP_VERSION;
  $('setSheet').hidden = false; $('locSheet').hidden = true;
  $('setDist').value = state.settings.maxDist; $('setRidges').checked = state.settings.ridges; $('setFill').checked = state.settings.fill; $('setDetail').checked = state.settings.detail !== false;
  $('setCamFov').value = state.settings.camFov; $('setOffset').value = Number(state.settings.offset || 0).toFixed(1);
  checkOffline();
}
function saveSettings() { store.set('settings', state.settings); }
$('setDist').onchange = () => { state.settings.maxDist = +$('setDist').value; saveSettings(); computePanorama(); };
$('setRidges').onchange = () => { state.settings.ridges = $('setRidges').checked; saveSettings(); requestDraw(); };
$('setDebug').onchange = () => { state.debugSky = $('setDebug').checked; requestDraw(); };
$('setFill').onchange = () => { state.settings.fill = $('setFill').checked; saveSettings(); requestDraw(); };
// ein Schalter für beides; Fotos nutzen immer Detailgelände und nie Satellitenbilder
$('setDetail').onchange = () => { state.settings.detail = state.settings.satellite = $('setDetail').checked; saveSettings(); if (!photoMode()) computePanorama(); };
$('setCamFov').onchange = () => { state.settings.camFov = parseFloat($('setCamFov').value) || 66; saveSettings(); requestDraw(); };
$('setOffset').onchange = () => { state.settings.offset = parseFloat($('setOffset').value) || 0; saveSettings(); requestDraw(); };

let offlineSeq = 0, bundleTotal = 0, bundleState = null;
async function checkOffline() {
  const el = $('offlineState'), seq = ++offlineSeq;
  if (!('serviceWorker' in navigator)) { el.textContent = 'Dieser Browser unterstützt keinen Offline-Betrieb.'; return; }
  try {
    if (!bundleTotal) bundleTotal = (await call('bundleInfo')).levels.reduce((a, l) => a + l.count, 0);
    const keys = await caches.keys();
    let n = 0; for (const k of keys) n += (await (await caches.open(k)).keys()).length;
    const dem = keys.includes('bergblick-dem11-p2z') ? (await (await caches.open('bergblick-dem11-p2z')).keys()).length : 0;
    if (seq !== offlineSeq) return; // neuere Abfrage läuft schon
    const busy = bundleState && bundleState.done < bundleState.total;
    el.textContent = (n - dem > 230 ? 'Offline bereit: Höhenmodell und Gipfel der Alpen gespeichert.' : `Offline-Daten werden gespeichert… (${n - dem} Dateien)`)
      + ` Detailgelände: ${busy ? `wird gespeichert, ${bundleState.done} von ${bundleState.total}` : dem >= bundleTotal ? 'komplett offline' : `${dem} von ${bundleTotal} Kacheln offline (benutzte Gebiete werden automatisch gespeichert)`}.`;
    $('btnBundle').hidden = !busy && dem >= bundleTotal;
  } catch { el.textContent = 'Offline-Status unbekannt.'; }
}
$('btnBundle').onclick = async () => {
  const btn = $('btnBundle'); btn.disabled = true;
  try {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) throw new Error('Offline-Speicher ist erst nach einem Neuladen der Seite aktiv.');
    const r = await call('cacheBundle');
    if (r.failed) showHint(`${r.failed} Kacheln nicht gespeichert (Verbindung?). Einfach nochmal tippen.`, 5000);
  } catch (e) { showHint(e.message, 5000); }
  btn.disabled = false; bundleState = null; checkOffline();
};

// ---------------------------------------------------------------- Bedienelemente

document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => ($(b.dataset.close).hidden = true)));
$('btnLocation').onclick = openLocation;
$('btnSettings').onclick = openSettings;
$('btnCamera').onclick = startLive;
$('btnShutter').onclick = shoot;
$('btnThumb').onclick = openLast;
$('btnRetake').onclick = retake;
$('btnLiveAdjust').onclick = $('btnFrozenAdjust').onclick = () => openCamAdjust(true);
$('btnAdjDone').onclick = () => openCamAdjust(false);
$('btnAdjReset').onclick = resetCamAdjust;
$('btnAdjPin').onclick = () => $('btnPin').onclick();
$('btnFrozenSave').onclick = () => deliverFrozen(false);
$('btnShare').onclick = () => deliverFrozen(true);
$('adjRot').oninput = () => { state.settings.camRoll = +$('adjRot').value / 10; syncAdjust(); requestDraw(); };
$('adjFov').oninput = () => { state.settings.camFovK = +$('adjFov').value / 100; syncAdjust(); requestDraw(); };
$('adjRot').onchange = $('adjFov').onchange = saveSettings;
$('btnPano').onclick = () => {
  $('peakCard').hidden = true;
  let pv = null;
  if (state.mode === 'photo' && state.img) {
    // Panorama zeigt denselben Ausschnitt wie das Foto auf dem Bildschirm (Mitte und Zoom)
    const cam = currentCamera(), [rx, ry, rw, rh] = cam.rect;
    const x = Math.max(rx, Math.min(rx + rw, W / 2)), y = Math.max(ry, Math.min(ry + rh, H / 2));
    const dx = x - cam.cx, dy = cam.cy - y;
    const d = [0, 1, 2].map((i) => cam.f[i] * cam.F + cam.r[i] * dx + cam.u[i] * dy);
    const fovW = 2 * Math.atan(W / 2 / cam.F) * 180 / Math.PI;
    pv = {
      heading: (Math.atan2(d[0], d[1]) * 180 / Math.PI + 360) % 360,
      pitch: Math.asin(d[2] / Math.hypot(...d)) * 180 / Math.PI,
      roll: 0,
      hfov: Math.max(3, Math.min(150, W > H ? fovW : fovW * H / W)),
    };
  }
  setMode('pano');
  if (pv) Object.assign(state.view, pv);
  else { state.view.roll = 0; if (state.view.hfov < 30) state.view.hfov = 60; }
  requestDraw();
};
// Foto-Reiter: ist schon ein Foto geladen, zurück dazu; erst im Foto-Reiter öffnet ein Tipp die Auswahl
$('btnPhoto').addEventListener('click', (e) => {
  if (e.target.id === 'file') return;
  if (state.img && state.mode !== 'photo') { e.preventDefault(); $('peakCard').hidden = true; setMode('photo'); showHint('Für ein anderes Foto nochmal auf „Foto“ tippen.', 3000); return; }
  // Gibt es schon Fotos im Verlauf: Auswahl aus Verlauf oder neues Foto
  if (hist.count > 0) { e.preventDefault(); openHist(); }
});
$('file').onchange = (e) => { const f = e.target.files[0]; $('histSheet').hidden = true; if (f) loadPhoto(f); e.target.value = ''; };
$('btnAlign').onclick = () => autoAlign();
$('btnPin').onclick = () => { $('pinSheet').hidden = false; $('pinSearch').value = ''; showPinList(''); $('pinSearch').focus(); };
$('pinSearch').addEventListener('input', () => showPinList($('pinSearch').value));

// Liste: ohne Suchbegriff die sichtbaren Gipfel nach Bedeutung, sonst Suche im ganzen Bestand
async function showPinList(q) {
  const P = state.pano; if (!P) return;
  let list;
  if (!q.trim()) {
    list = [...P.peaks].sort((a, b) => (Math.log2(1 + b.iso) - b.dist / 30000) - (Math.log2(1 + a.iso) - a.dist / 30000)).slice(0, 30);
  } else {
    const r = await call('search', { q, lat: P.lat, lon: P.lon });
    list = r.results.map((x) => P.peaks.find((p) => p.i === x.i) || peakFromSearch(x));
  }
  const ul = $('pinResults'); ul.innerHTML = '';
  for (const p of list) {
    const li = document.createElement('li');
    li.textContent = p.name;
    const sp = document.createElement('span'); sp.textContent = `${Math.round(p.ele)} m · ${(p.dist / 1000).toFixed(1)} km`; li.append(sp);
    li.onclick = () => { $('pinSheet').hidden = true; state.anchorPick = p; showHint(`Tippe im ${state.mode === 'live' ? 'Bild' : 'Foto'} genau auf ${p.name}.`); };
    ul.append(li);
  }
}

function peakFromSearch(x) {
  const P = state.pano;
  const [d, az] = distAz(P.lat, P.lon, x.lat, x.lon);
  const el = Math.atan((x.ele - drop(d) - P.h0) / d) * 180 / Math.PI;
  return { i: x.i, name: x.name, ele: x.ele, iso: 0, dist: d, az, el, v: enuV(az, el) };
}
$('btnAdjust').onclick = () => setAdjust(!state.adjust);
$('btnTune').onclick = () => { const t = $('tunebar'); t.hidden = !t.hidden; $('btnTune').classList.toggle('on', !t.hidden); if (t.hidden) setAdjust(false); };
$('btnZoomReset').onclick = resetZoom;
$('btnClose').onclick = () => { state.img = null; setMode('pano'); };
$('btnSave').onclick = saveImage;
$('fov').oninput = () => setFov(+$('fov').value);
$('roll').oninput = () => { state.view.roll = +$('roll').value; requestDraw(); };

// Bild per Drag & Drop (Desktop)
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) loadPhoto(f); });

// ---------------------------------------------------------------- Sonne

// Sonnenstand (Azimut ab Nord, scheinbare Höhe mit Refraktion), genau auf etwa 0,01°
function sunPos(date, lat, lon) {
  const r = Math.PI / 180, d = date.getTime() / 86400000 - 10957.5; // Tage seit J2000
  const g = (357.529 + 0.98560028 * d) * r, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * r, e = (23.439 - 0.00000036 * d) * r;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const H = (gmst * 15 + lon) * r - ra, phi = lat * r;
  let alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) / r;
  const az = (Math.atan2(-Math.cos(dec) * Math.sin(H), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.cos(H) * Math.sin(phi)) / r + 360) % 360;
  if (alt > -1.5) alt += 1.02 / Math.tan((alt + 10.3 / (alt + 5.11)) * r) / 60;
  return { az, alt };
}
const sun = { date: null, min: 0 };
function sunNow() { const n = new Date(); sun.date = new Date(n.getFullYear(), n.getMonth(), n.getDate()); sun.min = n.getHours() * 60 + n.getMinutes(); }
sunNow();
const sunAt = (min) => new Date(sun.date.getFullYear(), sun.date.getMonth(), sun.date.getDate(), 0, min);
const sunHere = (min) => { const P = state.pano || state.loc; return sunPos(sunAt(min), P.lat, P.lon); };
function sunParam() { if (!state.settings.sun) return null; const p = sunHere(sun.min); return { az: p.az, alt: p.alt }; }
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
// Geländehorizont in Richtung az (Grad), aus dem Panorama
function horizonAt(az) { const P = state.pano; if (!P) return 0; const v = P.sky[Math.round(az / 360 * P.cols) % P.cols]; return v > -89 ? v : 0; }

function drawSun(g, cam) {
  if (!state.settings.sun || state.mode === 'photo') return;
  g.save();
  // Tagesbahn mit Stundenpunkten
  g.setLineDash([5, 5]); g.lineWidth = 1.6; g.strokeStyle = 'rgba(255,196,80,0.9)';
  g.beginPath();
  let pen = false;
  const ticks = [];
  for (let m = 0; m <= 1440; m += 4) {
    const p = sunHere(m), s = p.alt > -2 ? project(enuV(p.az, p.alt), cam) : null;
    if (!s || Math.abs(s[0] - W / 2) > W * 3) { pen = false; continue; }
    if (pen) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]);
    pen = true;
    if (m % 60 === 0) ticks.push([s[0], s[1], m / 60]);
  }
  g.stroke(); g.setLineDash([]);
  g.font = '600 11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif'; g.textAlign = 'center';
  for (const [x, y, hr] of ticks) {
    g.fillStyle = 'rgba(255,196,80,0.95)'; g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.45)'; g.strokeText(hr + ' Uhr', x, y - 8); g.fillStyle = '#fff'; g.fillText(hr + ' Uhr', x, y - 8);
  }
  // Sonne zur gewählten Uhrzeit; hinter einem Berg nur als Umriss
  const p = sunHere(sun.min), s = p.alt > -2 ? project(enuV(p.az, p.alt), cam) : null;
  if (s) {
    const hidden = p.alt < horizonAt(p.az);
    if (!hidden) {
      const gr = g.createRadialGradient(s[0], s[1], 4, s[0], s[1], 34);
      gr.addColorStop(0, 'rgba(255,236,170,0.9)'); gr.addColorStop(1, 'rgba(255,200,90,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(s[0], s[1], 34, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffd25a'; g.beginPath(); g.arc(s[0], s[1], 9, 0, Math.PI * 2); g.fill();
      g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
    } else {
      g.setLineDash([3, 3]); g.lineWidth = 2; g.strokeStyle = '#ffd25a';
      g.beginPath(); g.arc(s[0], s[1], 9, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    }
  }
  g.restore();
}

// Auf- und Untergang über dem echten Gelände und über dem flachen Horizont
function updateSunInfo() {
  $('sunTimeVal').textContent = hhmm(sun.min) + ' Uhr';
  $('sunBar').classList.toggle('off', !state.settings.sun);
  if (!state.pano || $('sunBar').hidden) return;
  let up = null, down = null, upF = null, downF = null, prev = null, prevF = null;
  for (let m = 0; m <= 1440; m += 1) {
    const p = sunHere(m), vis = p.alt > horizonAt(p.az), visF = p.alt > -0.27;
    if (prev === false && vis && up == null) up = m;
    if (prev && !vis) down = m;
    if (prevF === false && visF && upF == null) upF = m;
    if (prevF && !visF) downF = m;
    prev = vis; prevF = visF;
  }
  const p = sunHere(sun.min), hz = horizonAt(p.az);
  const now = p.alt < -0.27 ? (p.alt < -6 ? 'Nacht' : 'Dämmerung') : p.alt < hz ? `Sonne hinter den Bergen (${Math.round(p.alt)}° hoch)` : `Sonne ${Math.round(p.alt)}° hoch, Richtung ${Math.round(p.az)}° ${DIR16[Math.round(p.az / 22.5) % 16]}`;
  const terr = up != null || down != null ? `Über den Bergen: ${up != null ? hhmm(up) : '–'} bis ${down != null ? hhmm(down) : '–'} Uhr` : 'Die Sonne kommt an diesem Tag nicht über die Berge';
  $('sunInfo').innerHTML = '';
  if (!state.settings.sun) { $('sunInfo').textContent = 'Aus: gleichmäßiges Licht, ohne Schatten und ohne Sonne im Bild.'; return; }
  for (const t of [now, terr, `Aufgang ${upF != null ? hhmm(upF) : '–'} · Untergang ${downF != null ? hhmm(downF) : '–'} Uhr (flacher Horizont)`]) { const d = document.createElement('div'); d.textContent = t; $('sunInfo').append(d); }
}

function syncSunUi() {
  $('sunOn').checked = !!state.settings.sun;
  $('btnSun').classList.toggle('on', !!state.settings.sun);
  const d = sun.date;
  $('sunDate').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  $('sunTime').value = sun.min;
  updateSunInfo();
}
// Licht neu berechnen: beim Ziehen schnell und gröber, danach in voller Auflösung
let relightTimer = 0;
async function relight(fine) {
  if (state.mode === 'photo' || !state.pano) return;
  if (!state.pano.complete) { computePanorama(); return; }
  const job = ++panoJob;
  const { lat, lon, agl } = state.loc, on = state.settings.detail !== false;
  if (fine) showHint(state.settings.sun ? 'Berechne Licht und Schatten…' : 'Berechne Panorama…');
  try {
    const res = await call('panorama', { lat, lon, agl: Number(agl) || 2, alt: state.loc.alt ?? null, maxDist: state.settings.maxDist, detail: on, satellite: on, quick: true, cols: fine ? 7200 : 2400, sun: sunParam() });
    if (job !== panoJob) return;
    res.lat = lat; res.lon = lon; res.complete = res.complete && fine;
    applyPanorama(res);
    if (fine) hideHint();
  } catch { /* von neuerer Anfrage abgelöst */ }
}
function sunChanged(fine) {
  updateSunInfo(); requestDraw();
  if (!state.settings.sun) return;
  clearTimeout(relightTimer);
  relightTimer = setTimeout(() => relight(fine), fine ? 30 : 120);
}
$('btnSun').onclick = () => {
  const b = $('sunBar');
  b.hidden = !b.hidden;
  if (!b.hidden) {
    if (state.mode !== 'pano') $('btnPano').onclick();
    // nur beim allerersten Öffnen einschalten; danach gilt, was der Schalter zuletzt war
    if (state.settings.sun === undefined) { state.settings.sun = true; saveSettings(); relight(true); }
    syncSunUi();
  }
};
$('btnSunClose').onclick = () => { $('sunBar').hidden = true; };
$('sunOn').onchange = () => { state.settings.sun = $('sunOn').checked; saveSettings(); syncSunUi(); relight(true); requestDraw(); };
$('sunTime').oninput = () => { sun.min = +$('sunTime').value; sunChanged(false); };
$('sunTime').onchange = () => { sun.min = +$('sunTime').value; sunChanged(true); };
$('sunDate').onchange = () => { const v = $('sunDate').value.split('-').map(Number); if (v.length === 3 && v[0]) { sun.date = new Date(v[0], v[1] - 1, v[2]); sunChanged(true); } };
$('btnSunNow').onclick = () => { sunNow(); syncSunUi(); sunChanged(true); };

// ---------------------------------------------------------------- Gipfelsuche

function openFind() {
  for (const id of ['locSheet', 'setSheet', 'pinSheet', 'histSheet']) $(id).hidden = true;
  $('findSheet').hidden = false; $('findInput').value = ''; showFindList(''); $('findInput').focus();
}
let findSeq = 0;
async function showFindList(q) {
  const P = state.pano; if (!P) return;
  const seq = ++findSeq;
  let list;
  if (!q.trim()) list = [...P.peaks].sort((a, b) => (Math.log2(1 + b.iso) - b.dist / 30000) - (Math.log2(1 + a.iso) - a.dist / 30000)).slice(0, 25);
  else {
    const r = await call('search', { q, lat: P.lat, lon: P.lon });
    if (seq !== findSeq) return;
    list = r.results.map((x) => P.peaks.find((p) => p.i === x.i) || peakFromSearch(x));
  }
  const ul = $('findResults'); ul.innerHTML = '';
  if (!list.length) { const li = document.createElement('li'); li.textContent = 'Kein Gipfel gefunden'; ul.append(li); return; }
  for (const p of list) {
    const li = document.createElement('li');
    li.textContent = p.name;
    const vis = P.peaks.some((x) => x.i === p.i);
    const sp = document.createElement('span');
    sp.innerHTML = `${Math.round(p.ele)} m · ${fmtDist(p.dist)} · <b class="tag${vis ? '' : ' off'}">${vis ? 'sichtbar' : p.dist > state.settings.maxDist ? 'zu weit' : 'verdeckt'}</b>`;
    li.append(sp);
    li.onclick = () => goToPeak(p);
    ul.append(li);
  }
}
$('btnFind').onclick = openFind;
$('findInput').addEventListener('input', () => showFindList($('findInput').value));

// Panorama zum Gipfel drehen (weich) und ihn markieren
function goToPeak(p) {
  $('findSheet').hidden = true; $('peakCard').hidden = true;
  if (state.mode !== 'pano') $('btnPano').onclick();
  state.target = p; state.selected = p.i;
  const v0 = { ...state.view };
  const dH = ((p.az - v0.heading + 540) % 360) - 180;
  const toP = Math.max(-25, Math.min(35, p.el + 1)), toF = Math.max(12, Math.min(v0.hfov, p.dist > 40000 ? 20 : 30));
  const t0 = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / 700), e = 1 - (1 - t) ** 3;
    state.view.heading = (v0.heading + dH * e + 360) % 360; state.view.pitch = v0.pitch + (toP - v0.pitch) * e; state.view.hfov = v0.hfov + (toF - v0.hfov) * e;
    requestDraw();
    if (t < 1 && state.target === p) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  const vis = state.pano.peaks.some((x) => x.i === p.i);
  showHint(vis ? `${p.name} · ${Math.round(p.ele)} m · ${fmtDist(p.dist)}` : p.dist > state.settings.maxDist ? `${p.name} liegt ${fmtDist(p.dist)} entfernt, weiter als die Sichtweite.` : `${p.name} ist von hier verdeckt (${fmtDist(p.dist)}).`, 6000);
}

function drawTarget(g, cam) {
  const t = state.target; if (!t) return;
  const s = project(t.v, cam); if (!s) return;
  const vis = state.pano.peaks.some((x) => x.i === t.i);
  g.save();
  g.lineWidth = 2.5; g.strokeStyle = '#ffb547';
  if (!vis) g.setLineDash([4, 4]);
  g.beginPath(); g.arc(s[0], s[1], 13, 0, Math.PI * 2); g.stroke();
  g.setLineDash([]);
  if (!vis) {
    g.font = '600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif'; g.textAlign = 'center';
    const txt = `${t.name} (verdeckt)`;
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.strokeText(txt, s[0], s[1] + 32); g.fillStyle = '#ffd9a0'; g.fillText(txt, s[0], s[1] + 32);
  }
  g.restore();
}

// ---------------------------------------------------------------- Fotoverlauf

// Die letzten Fotos samt Standort und Ausrichtung im Gerät (IndexedDB), zum späteren Wiederöffnen
const HIST_MAX = 12;
const hist = { db: null, count: 0, last: '', timer: 0 };
function histDb() {
  return hist.db ||= new Promise((res, rej) => {
    const r = indexedDB.open('bergblick', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function histReq(mode, fn) {
  const db = await histDb();
  return new Promise((res, rej) => {
    const tx = db.transaction('photos', mode), rq = fn(tx.objectStore('photos'));
    tx.oncomplete = () => res(rq && rq.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  });
}
const histRecord = () => ({ loc: { ...state.loc }, view: { ...state.view }, alignHint: state.alignHint, anchors: state.anchors || [] });
async function histAdd(file, img) {
  try {
    const c = document.createElement('canvas'), k = 240 / Math.max(img.width, img.height);
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const rec = { t: Date.now(), name: file.name, blob: file, thumb: c.toDataURL('image/jpeg', 0.75), ...histRecord() };
    state.photoId = await histReq('readwrite', (st) => st.add(rec));
    hist.last = JSON.stringify(histRecord());
    const all = await histReq('readonly', (st) => st.getAllKeys());
    for (const id of all.slice(0, Math.max(0, all.length - HIST_MAX))) await histReq('readwrite', (st) => st.delete(id));
    hist.count = Math.min(all.length, HIST_MAX);
  } catch (e) { console.warn('Fotoverlauf:', e); }
}
// Ausrichtung und Standort des offenen Fotos nachführen (gebündelt)
function histTouch() {
  clearTimeout(hist.timer);
  hist.timer = setTimeout(async () => {
    if (state.mode !== 'photo' || !state.photoId) return;
    const r = histRecord(), j = JSON.stringify(r);
    if (j === hist.last) return;
    hist.last = j;
    const id = state.photoId;
    try {
      const old = await histReq('readonly', (st) => st.get(id));
      if (old) await histReq('readwrite', (st) => st.put({ ...old, ...r }));
    } catch (e) { console.warn('Fotoverlauf:', e); }
  }, 1200);
}
async function openHist() {
  for (const id of ['locSheet', 'setSheet', 'pinSheet', 'findSheet']) $(id).hidden = true;
  $('histSheet').hidden = false;
  const ul = $('histList'); ul.innerHTML = '';
  let all = [];
  try { all = await histReq('readonly', (st) => st.getAll()); } catch { all = []; }
  hist.count = all.length;
  for (const e of all.reverse()) {
    const li = document.createElement('li');
    const im = document.createElement('img'); im.src = e.thumb; im.alt = '';
    const cap = document.createElement('div'); cap.className = 'cap';
    const b = document.createElement('b'); b.textContent = e.loc && e.loc.name ? e.loc.name : e.loc ? `${e.loc.lat.toFixed(3)}, ${e.loc.lon.toFixed(3)}` : e.name;
    const sp = document.createElement('span'); sp.textContent = new Date(e.t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    cap.append(b, sp);
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '✕'; del.setAttribute('aria-label', 'Aus dem Verlauf löschen');
    del.onclick = async (ev) => { ev.stopPropagation(); await histReq('readwrite', (st) => st.delete(e.id)); if (state.photoId === e.id) state.photoId = null; li.remove(); hist.count--; };
    li.onclick = () => { $('histSheet').hidden = true; loadPhoto(e.blob, e); };
    li.append(im, cap, del);
    ul.append(li);
  }
  if (!all.length) { const li = document.createElement('p'); li.className = 'small'; li.textContent = 'Noch keine Fotos.'; ul.append(li); }
}
// Foto aus dem Verlauf: gespeicherte Ausrichtung und Standort, kein neues Ausrichten
async function openSaved(file, saved) {
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(async () => {
    const im = new Image(); im.src = URL.createObjectURL(file); await im.decode(); return im;
  });
  state.img = img; state.imgName = (saved.name || 'foto').replace(/\.[^.]+$/, '') + '-bergblick'; state.photoView = null;
  state.photoSky = null; state.lastAlign = null; state.alignHint = saved.alignHint || null; state.anchors = saved.anchors || [];
  resetZoom(); setAdjust(false); stopLive();
  state.view = { ...saved.view };
  state.photoId = saved.id; hist.last = JSON.stringify({ loc: saved.loc, view: saved.view, alignHint: saved.alignHint, anchors: saved.anchors || [] });
  setMode('photo');
  syncSliders();
  if (saved.loc) await setLocation(saved.loc, false);
  showHint('Foto aus dem Verlauf, lade Gelände…');
  await computePanorama();
  showHint('Foto aus dem Verlauf geöffnet.', 3000);
}
histReq('readonly', (st) => st.count()).then((n) => { hist.count = n || 0; }).catch(() => {});

// ---------------------------------------------------------------- Standort suchen (ungenaues GPS)

let locBusy = false;
async function searchLocation(radius, why = '') {
  if (!state.img || locBusy || !state.pano) return;
  locBusy = true;
  const btn = $('btnLocSearch'); btn.disabled = true;
  const img = state.img, from = { ...state.loc };
  const onProg = (m) => { if (m.type === 'locsearch-progress') showHint(`${why ? why + ' ' : ''}Suche den Standort im Umkreis von ${fmtDist(radius)}… ${m.done}/${m.total}`); };
  progressHandlers.add(onProg);
  showHint(`${why ? why + ' ' : ''}Suche den Standort im Umkreis von ${fmtDist(radius)}…`);
  try {
    const { px, w, h } = photoPixels(640);
    const hint = state.alignHint || { heading: state.view.heading, hfov: state.view.hfov, headingRange: 180, fovRange: [25, 120] };
    const r = await call('locsearch', { pixels: px.buffer, w, h, hint, lat: from.lat, lon: from.lon, alt: from.alt ?? null, agl: Number(from.agl) || 2, radius, maxDist: state.settings.maxDist, sector: photoSector() }, [px.buffer]);
    console.log('Standortsuche', r);
    if (state.img !== img) return;
    // nur umziehen, wenn der neue Ort deutlich besser passt
    if (r.moved > 40 && r.s > r.s0 * 1.2 + 0.05) {
      await setLocation({ lat: r.lat, lon: r.lon, alt: null, name: '' }, false);
      await autoAlign();
      showHint(`Standort nach den Bergumrissen um ${fmtDist(r.moved)} korrigiert. Stimmt er nicht, setze ihn unter „Standort“.`, 9000);
    } else showHint(`Der Standort passt${why ? ' trotzdem' : ''}: in der Umgebung liegen die Bergumrisse nicht besser.`, 6000);
  } catch (e) { showHint('Standortsuche fehlgeschlagen: ' + e.message, 5000); }
  finally { progressHandlers.delete(onProg); locBusy = false; btn.disabled = false; }
}
$('btnLocSearch').onclick = () => searchLocation(Math.min(3000, Math.max(800, (state.gpsError || 0) * 2)));

// ---------------------------------------------------------------- Start

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker:', e));
}

resize();
setMode('pano');
ready.then(async (m) => {
  $('loadText').textContent = `${m.peakCount.toLocaleString('de-DE')} Gipfel geladen`;
  await computePanorama();
  $('loading').hidden = true;
}).catch((e) => { $('loadText').textContent = 'Fehler: ' + e.message; });



// Für Tests und Fehlersuche
window.bergblick = { state, sun, sunPos, relight, goToPeak, searchLocation, openHist, shoot, setZoom, openCamAdjust, photoPixels, call, computePanorama, setLocation, autoAlign, loadPhoto, requestDraw, setMode, renderTerrain, fill, solveAnchors };
