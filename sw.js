// Service Worker: speichert App, Alpen-Daten und geladene Detailkacheln für den Offline-Betrieb.
const VERSION = 'bergblick-v9e';
const TILES = 'bergblick-tiles'; // Detailkacheln, bleiben über App-Updates erhalten
const DEM11 = 'bergblick-dem11-p2z'; // mitgeliefertes Detailgelände (Zoom 11 und 12), ebenso
const SAT = 'bergblick-sat'; // Satellitenbilder aus dem Netz, ebenso
const TILE_HOST = 's3.amazonaws.com';
const SHELL = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'js/app.js', 'js/worker.js', 'js/terrain.js', 'js/camera.js', 'js/exif.js', 'js/map.js', 'icons/icon-192.png', 'icons/icon-512.png'];
const DATA = ['data/peaks.json', 'data/dem/meta.json', 'data/dem/bundles.json', 'data/sat/overview.json', 'data/sat/overview.jpg'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll([...SHELL, ...DATA].map((u) => new Request(u, { cache: 'reload' })));
    const meta = await (await cache.match('data/dem/meta.json')).json();
    const tiles = [];
    for (let x = meta.x0; x <= meta.x1; x++) for (let y = meta.y0; y <= meta.y1; y++) tiles.push(`data/dem/${meta.z}/${x}_${y}.bin`);
    // Höhenkacheln aus älterer Version übernehmen statt neu zu laden
    for (let i = 0; i < tiles.length; i += 24) {
      await Promise.all(tiles.slice(i, i + 24).map(async (t) => {
        if (await cache.match(t)) return;
        const old = await caches.match(t);
        if (old) { await cache.put(t, old); return; }
        try { const r = await fetch(t); if (r.ok) await cache.put(t, r); } catch { /* später erneut */ }
      }));
    }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== TILES && k !== DEM11 && k !== SAT) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Detailkacheln: Speicher zuerst, sonst laden und ablegen
  if (url.host === TILE_HOST && url.pathname.includes('/terrarium/')) {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(e.request.url);
      if (hit) return hit;
      const res = await fetch(e.request.url, { mode: 'cors' });
      if (res.ok) cache.put(e.request.url, res.clone());
      return res;
    })());
    return;
  }
  // Satellitenbilder fürs Panorama (vom Worker mit CORS geladen): einmal geladen, auch offline da
  if (url.host === 'server.arcgisonline.com' && url.pathname.includes('/World_Imagery/')) {
    e.respondWith((async () => {
      const cache = await caches.open(SAT);
      const hit = await cache.match(e.request.url);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok && res.type === 'cors') cache.put(e.request.url, res.clone());
      return res;
    })());
    return;
  }
  if (url.origin !== location.origin) return;

  if (/\/data\/(dem|sat)\/1[12]\//.test(url.pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(DEM11);
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) await cache.put(e.request, res.clone());
      return res;
    })());
    return;
  }

  // Daten: Speicher zuerst. App-Dateien: Netz zuerst (Updates), offline aus dem Speicher.
  const isData = url.pathname.includes('/data/');
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (isData) {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
    }
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      if (e.request.mode === 'navigate') return cache.match('index.html');
      throw err;
    }
  })());
});
