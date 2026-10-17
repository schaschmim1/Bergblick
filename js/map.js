// Kachelkarte für die Standortwahl: Satellitenbild mit Beschriftung (online) oder Relief aus dem
// eigenen Höhenmodell (offline). Verschieben, Zoomen (Mausrad, zwei Finger, Doppeltipp, Knöpfe),
// Tippen wählt den Standort.

export const LAYERS = {
  sat: {
    name: 'Satellit',
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    labels: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`,
    maxZ: 18,
    attribution: 'Bild: Esri, Maxar, Earthstar Geographics · Beschriftung: Esri',
  },
  relief: { name: 'Relief', maxZ: 18, attribution: 'Relief: AWS Terrain Tiles · Gipfel: © OpenStreetMap' },
};

const T = 256;
const wx = (lon, z) => (lon + 180) / 360 * T * 2 ** z;
const wy = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * T * 2 ** z; };
const ilon = (x, z) => x / (T * 2 ** z) * 360 - 180;
const ilat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / (T * 2 ** z); return Math.atan(Math.sinh(n)) * 180 / Math.PI; };

export class SlippyMap {
  // reliefTile(z, x, y) → Promise<ImageBitmap>; peaksIn(bbox) → Promise<[{lat, lon, name, ele}]>
  constructor(canvas, { reliefTile, peaksIn, onPick, minZ = 5, maxZ = 18 }) {
    Object.assign(this, { canvas, reliefTile, peaksIn, onPick, minZ, maxZ });
    this.lat = 47.3; this.lon = 11.4; this.zoom = 10;
    this.layer = 'sat';
    this.tiles = new Map(); // key -> {img, ok, failed, t}
    this.peaks = []; this.peakKey = '';
    this.pick = null;
    this.satFailed = 0;
    this.raf = 0;
    this.bindEvents();
  }

  setView(lat, lon, zoom = this.zoom) { this.lat = lat; this.lon = lon; this.zoom = Math.max(this.minZ, Math.min(this.maxZ, zoom)); this.draw(); }
  setLayer(l) { this.layer = l; this.draw(); }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr); this.canvas.height = Math.round(r.height * this.dpr);
    this.draw();
  }

  draw() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); }); }

  // Bildschirmpunkt (CSS-Pixel) ↔ Koordinaten
  toLatLon(px, py) {
    const z = this.zoom;
    return { lat: ilat(wy(this.lat, z) + py - this.h / 2, z), lon: ilon(wx(this.lon, z) + px - this.w / 2, z) };
  }
  toScreen(lat, lon) {
    const z = this.zoom;
    return [wx(lon, z) - wx(this.lon, z) + this.w / 2, wy(lat, z) - wy(this.lat, z) + this.h / 2];
  }

  tile(kind, z, x, y) {
    const key = `${kind}/${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (t) { t.t = performance.now(); return t; }
    t = { ok: false, failed: false, t: performance.now() };
    this.tiles.set(key, t);
    const n = 2 ** z, xx = ((x % n) + n) % n;
    if (kind === 'relief') {
      this.reliefTile(z, xx, y).then((img) => { t.img = img; t.ok = true; this.draw(); }, () => { t.failed = true; });
    } else {
      const img = new Image();
      img.onload = () => { t.img = img; t.ok = true; if (kind === 'sat') this.satFailed = 0; this.draw(); };
      img.onerror = () => { t.failed = true; if (kind === 'sat') this.satFailed++; this.draw(); };
      img.src = LAYERS.sat[kind === 'sat' ? 'url' : 'labels'](z, xx, y);
    }
    if (this.tiles.size > 600) {
      const old = [...this.tiles.entries()].sort((a, b) => a[1].t - b[1].t).slice(0, 150);
      for (const [k] of old) this.tiles.delete(k);
    }
    return t;
  }

  // Kachel zeichnen; solange sie fehlt, einen Ausschnitt einer gröberen Kachel strecken
  drawTile(g, kind, z, x, y, dx, dy, size) {
    const t = this.tile(kind, z, x, y);
    if (t.ok) { g.drawImage(t.img, dx, dy, size, size); return true; }
    for (let up = 1; up <= 5 && z - up >= 0; up++) {
      const f = 2 ** up, p = this.tiles.get(`${kind}/${z - up}/${Math.floor(x / f)}/${Math.floor(y / f)}`);
      if (p && p.ok) {
        const s = T / f, sx = (x - Math.floor(x / f) * f) * s, sy = (y - Math.floor(y / f) * f) * s;
        g.drawImage(p.img, sx, sy, s, s, dx, dy, size, size);
        return t.failed;
      }
    }
    return t.failed;
  }

  render() {
    const g = this.canvas.getContext('2d'), dpr = this.dpr || 1;
    if (!this.w) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0e151d'; g.fillRect(0, 0, this.w, this.h);
    // ohne Netz (oder wenn die Bilder nicht kommen) Relief zeigen
    const sat = this.layer === 'sat' && navigator.onLine !== false && this.satFailed < 6;
    const L = sat ? LAYERS.sat : LAYERS.relief;
    const zi = Math.max(0, Math.min(L.maxZ, Math.round(this.zoom)));
    const scale = 2 ** (this.zoom - zi), size = T * scale;
    const cx = wx(this.lon, zi), cy = wy(this.lat, zi);
    const x0 = Math.floor((cx - this.w / 2 / scale) / T), x1 = Math.floor((cx + this.w / 2 / scale) / T);
    const y0 = Math.max(0, Math.floor((cy - this.h / 2 / scale) / T)), y1 = Math.min(2 ** zi - 1, Math.floor((cy + this.h / 2 / scale) / T));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = (x * T - cx) * scale + this.w / 2, dy = (y * T - cy) * scale + this.h / 2;
      if (sat) {
        const failed = this.drawTile(g, 'sat', zi, x, y, dx, dy, size + 0.5);
        if (failed) this.drawTile(g, 'relief', zi, x, y, dx, dy, size + 0.5);
      } else this.drawTile(g, 'relief', zi, x, y, dx, dy, size + 0.5);
    }
    if (sat) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = this.tile('labels', zi, x, y);
      if (t.ok) g.drawImage(t.img, (x * T - cx) * scale + this.w / 2, (y * T - cy) * scale + this.h / 2, size + 0.5, size + 0.5);
    }
    this.drawPeaks(g, sat);
    if (this.pick) {
      const [x, y] = this.toScreen(this.pick.lat, this.pick.lon);
      g.fillStyle = '#ff5a36'; g.strokeStyle = '#fff'; g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(x, y); g.arc(x, y - 18, 8, Math.PI * 0.8, Math.PI * 2.2); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y - 18, 3, 0, Math.PI * 2); g.fill();
    }
    g.font = '10px system-ui, sans-serif';
    const att = L.attribution, aw = g.measureText(att).width + 8;
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(this.w - aw, this.h - 15, aw, 15);
    g.fillStyle = '#ddd'; g.fillText(att, this.w - aw + 4, this.h - 4);
    this.loadPeaks();
  }

  drawPeaks(g, sat) {
    if (this.zoom < 9) return;
    g.font = '600 11px system-ui, sans-serif';
    const taken = [];
    for (const p of this.peaks) {
      const [x, y] = this.toScreen(p.lat, p.lon);
      if (x < -50 || y < -20 || x > this.w + 50 || y > this.h + 20) continue;
      const label = `${p.name} ${Math.round(p.ele)}`;
      const box = [x - 5, y - 15, x + g.measureText(label).width + 10, y + 5];
      const free = taken.length < 40 && !taken.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
      if (!free && this.zoom < 12) continue;
      g.fillStyle = sat ? '#ffd27a' : '#2a1a05'; g.strokeStyle = sat ? 'rgba(0,0,0,.8)' : 'rgba(255,255,255,.8)'; g.lineWidth = 1.5;
      const r = free ? 4.5 : 3;
      g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y + r * 0.75); g.lineTo(x - r, y + r * 0.75); g.closePath(); g.fill(); g.stroke();
      if (!free) continue;
      taken.push(box);
      g.lineWidth = 3; g.strokeStyle = sat ? 'rgba(0,0,0,.75)' : 'rgba(255,255,255,.85)'; g.strokeText(label, x + 7, y - 2);
      g.fillStyle = sat ? '#fff' : '#1b1b1b'; g.fillText(label, x + 7, y - 2);
    }
  }

  loadPeaks() {
    if (this.zoom < 9 || !this.peaksIn) return;
    const a = this.toLatLon(-40, -20), b = this.toLatLon(this.w + 40, this.h + 20);
    const key = [a.lat, a.lon, b.lat, b.lon].map((v) => v.toFixed(3)).join(',');
    if (key === this.peakKey) return;
    this.peakKey = key;
    clearTimeout(this.peakTimer);
    this.peakTimer = setTimeout(async () => {
      const list = await this.peaksIn({ north: a.lat, west: a.lon, south: b.lat, east: b.lon });
      if (this.peakKey === key) { this.peaks = list; this.draw(); }
    }, 120);
  }

  zoomAt(z, px, py) {
    z = Math.max(this.minZ, Math.min(this.maxZ, z));
    const p = this.toLatLon(px, py);
    this.zoom = z;
    // Punkt unter dem Finger bleibt stehen
    const [sx, sy] = this.toScreen(p.lat, p.lon);
    this.pan(sx - px, sy - py);
  }

  pan(dx, dy) {
    const z = this.zoom;
    this.lon = ilon(wx(this.lon, z) + dx, z);
    this.lat = Math.max(-85, Math.min(85, ilat(wy(this.lat, z) + dy, z)));
    this.draw();
  }

  // weich zoomen (Knöpfe, Doppeltipp)
  animateZoom(target, px = this.w / 2, py = this.h / 2) {
    const z0 = this.zoom, t0 = performance.now();
    target = Math.max(this.minZ, Math.min(this.maxZ, target));
    const step = (t) => {
      const f = Math.min(1, (t - t0) / 220), e = 1 - (1 - f) ** 3;
      this.zoomAt(z0 + (target - z0) * e, px, py);
      if (f < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  bindEvents() {
    const c = this.canvas, pts = new Map();
    let g = null, lastTap = 0;
    const local = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const start = () => {
      const p = [...pts.values()];
      g = { moved: g ? g.moved : false, t: g ? g.t : performance.now(), n: p.length, p0: p.map((q) => [...q]), zoom: this.zoom, last: p.length === 1 ? [...p[0]] : null };
      if (p.length === 2) { g.d0 = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]); g.m0 = [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2]; }
    };
    c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); pts.set(e.pointerId, local(e)); if (pts.size === 1) g = null; start(); });
    c.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId) || !g) return;
      pts.set(e.pointerId, local(e));
      const p = [...pts.values()];
      if (p.length === 1 && g.last) {
        const dx = p[0][0] - g.last[0], dy = p[0][1] - g.last[1];
        if (Math.hypot(p[0][0] - g.p0[0][0], p[0][1] - g.p0[0][1]) > 6) g.moved = true;
        if (g.moved) { this.pan(-dx, -dy); g.last = [...p[0]]; }
      } else if (p.length === 2 && g.d0) {
        g.moved = true;
        const d = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]), m = [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2];
        this.pan(g.m0[0] - m[0], g.m0[1] - m[1]); g.m0 = m;
        this.zoomAt(g.zoom + Math.log2(d / g.d0), m[0], m[1]);
      }
    });
    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      const pos = local(e);
      pts.delete(e.pointerId);
      if (pts.size) { start(); return; }
      if (g && !g.moved && g.n === 1 && performance.now() - g.t < 600) {
        const now = performance.now();
        if (now - lastTap < 300) { this.animateZoom(Math.round(this.zoom) + 1, pos[0], pos[1]); lastTap = 0; }
        else {
          lastTap = now;
          this.pick = this.toLatLon(pos[0], pos[1]);
          this.draw();
          if (this.onPick) this.onPick(this.pick);
        }
      }
      g = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      const d = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      this.zoomAt(this.zoom - d * 0.004, x, y);
    }, { passive: false });
    addEventListener('online', () => { this.satFailed = 0; this.draw(); });
    addEventListener('offline', () => this.draw());
  }
}

