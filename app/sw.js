/* Service Worker: macht die App offline nutzbar.
   - App-Dateien, Fotos und Bibliotheken liegen in einem Cache pro Version. VERSION ersetzt der
     GitHub-Workflow beim Veröffentlichen durch die Commit-Kennung → neue Version wird erkannt,
     die Seite zeigt „Neue Version verfügbar“.
   - Karten-Kacheln: nur die angesehenen, höchstens MAX_TILES (älteste fliegen raus) –
     ganze Gebiete vorab zu laden erlaubt die OpenStreetMap-Kachelrichtlinie nicht.
   - Tagebuch-Fotos (Supabase Storage) werden nach dem ersten Ansehen offline vorgehalten.
   - Alles andere (Routing, Ortssuche, Supabase-Daten, NOAA) geht direkt ins Netz. */
const VERSION = "__BUILD__";
const DEV = VERSION === "__" + "BUILD__";          // lokal: immer frisch aus dem Netz
const APP = "nordtour-app-" + VERSION, TILES = "nordtour-tiles", PHOTOS = "nordtour-photos", FONTS = "nordtour-fonts";
const MAX_TILES = 3000, MAX_PHOTOS = 800;

const CORE = ["./", "index.html", "style.css", "theme.js", "config.js", "extras.js", "app.js", "stops.js", "osm.js", "toll.js", "ferrycost.js", "ferries.js", "einstellungen.js", "lists.js", "prio.js", "varianten.js", "planer.js", "etappen.js", "panowege.js", "bearbeiten.js", "panosuche.js", "sky.js", "aurora.js",
  "journal.js", "sync.js", "cache.js", "backup.js", "pwa.js", "extras.json", "strassen.json", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png"];
const CDN = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  "https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.6/Sortable.min.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js"
];

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(APP);
    // cache: "reload" = am Browser-Zwischenspeicher vorbei direkt vom Server holen. Sonst können
    // (GitHub Pages: bis 10 Minuten) alte Dateien unter der neuen Versionsnummer landen.
    await c.addAll(CORE.map(u => new Request(u, { cache: "reload" })));
    for (const u of CDN) { try { const r = await fetch(u, { mode: "cors" }); if (r.ok) await c.put(u, r); } catch { /* später */ } }
    // Fotos der Panoramastraßen und Sehenswürdigkeiten
    try {
      const x = await (await c.match("extras.json")).json();
      const imgs = [...x.pano, ...x.sights].flatMap(p => (p.imgs || []).map(i => i.src));
      await Promise.allSettled(imgs.map(src => c.add(new Request(src, { cache: "reload" }))));
    } catch { /* egal */ }
  })());
});
self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("nordtour-app-") && k !== APP) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener("message", e => {
  if (e.data === "skipWaiting") self.skipWaiting();
  if (e.data === "version") e.source?.postMessage({ version: VERSION });
});

async function trim(name, max) {
  const c = await caches.open(name), keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}
async function cacheFirst(req, name, key = req, max = 0) {
  const hit = await caches.match(key, { ignoreSearch: key === req && new URL(req.url).origin === location.origin });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") {
    const c = await caches.open(name);
    await c.put(key, res.clone());
    if (max) trim(name, max);
  }
  return res;
}
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(APP)).put(req, res.clone());
    return res;
  } catch {
    return (await caches.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? caches.match("index.html") : Response.error());
  }
}

self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    if (u.pathname.endsWith("/daten.json") || u.pathname.endsWith("/sw.js")) return;   // nie aus dem Cache
    if (DEV) { e.respondWith(networkFirst(req)); return; }
    if (req.mode === "navigate") { e.respondWith(caches.match("index.html").then(r => r || fetch(req))); return; }
    e.respondWith(cacheFirst(req, APP));
    return;
  }
  if (u.hostname === "tile.openstreetmap.org") { e.respondWith(cacheFirst(req, TILES, req, MAX_TILES)); return; }
  if (["unpkg.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net"].includes(u.hostname)) { e.respondWith(cacheFirst(req, APP)); return; }
  if (u.hostname === "fonts.googleapis.com" || u.hostname === "fonts.gstatic.com") {
    // erst aus dem Cache, im Hintergrund auffrischen
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  // Fotos eigener Panoramastraßen (Wikimedia Commons) nach dem ersten Ansehen offline vorhalten
  if (u.hostname === "upload.wikimedia.org" || u.hostname === "thumb.wikimedia.org") { e.respondWith(cacheFirst(req, PHOTOS, req, MAX_PHOTOS)); return; }
  // Tagebuch-Fotos: signierte Adresse ändert sich, gespeichert wird ohne den Token
  if (u.hostname.endsWith(".supabase.co") && u.pathname.includes("/storage/v1/object/sign/")) {
    e.respondWith(cacheFirst(req, PHOTOS, u.origin + u.pathname, MAX_PHOTOS));
  }
});
