/* Nordtour 2027 – Grundversion: Karte, Tage bearbeiten, Live-Routing.
   Speicher: vorerst localStorage (nur dieser Browser). Supabase folgt. */
"use strict";

// Persönliches (Startpunkt, Reisedaten) steht NICHT im Code, sondern in den Daten (settings.home, days),
// weil der Code öffentlich auf GitHub liegt.
const DEFAULT_HOME = { name: "Hamburg", lat: 53.5511, lon: 9.9937 };
const home = () => state?.settings?.home || DEFAULT_HOME;
const tripStart = () => sortedDays()[0]?.date || new Date().toISOString().slice(0, 10);
const LONG_DAY = 6;                 // Stunden, ab denen ein Fahrtag als lang gilt
const FERRY_KMH = 28;               // Schätzung für eingetragene Fährstrecken (Luftlinie)
const STORE = "nordtour.v1";
const RSTORE = "nordtour.routes.v4";   // Version erhöhen, wenn sich das Routenformat ändert
try { localStorage.removeItem("nordtour.routes.v1"); localStorage.removeItem("nordtour.routes.v2"); localStorage.removeItem("nordtour.routes.v3"); } catch { /* egal */ }
const ROUTER = "https://valhalla1.openstreetmap.de/route?json=";
const NOMI = "https://nominatim.openstreetmap.org/";
const DAY_NAMES = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

let state = null;          // { days, costs, todos, items_kaufen, items_packen, settings }
let routes = {};           // Cache: Schlüssel = Wegpunkte, Wert = { km, h, ferryKm, ferryH, parts:[{ferry, enc|pts}] }
let routeStatus = {};      // dayId -> "busy" | "offline" | "wait" (Störung, neuer Versuch folgt) | "err" (bleibt, siehe routeErr)
const routeErr = {};       // Schlüssel wie routes -> { msg, pt } – Strecken, die sich so nicht berechnen lassen
let selDay = null, editingDay = null, undoSnap = null, undoAfter = null;   // undoAfter: { snap, run } – was zusätzlich zurückgenommen wird (etappen.js)

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = n => Math.round(n).toLocaleString("de-DE");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fmtH(h) { const m = Math.round(h * 60); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; }
function fmtDate(s) { const d = new Date(s + "T12:00:00"); return isNaN(d) ? (s || "–") : d.toLocaleDateString("de-DE", { day: "numeric", month: "short" }); }
function dayNo(s) { return Math.round((new Date(s + "T12:00:00") - new Date(tripStart() + "T12:00:00")) / 864e5) + 1; }
function uid() { return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
function hav(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLa = r(b.lat - a.lat), dLo = r(b.lon - a.lon);
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/* ================= Speicher ================= */
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { notice("Speichern im Browser fehlgeschlagen: " + e.message); }
  if (typeof onLocalSave === "function") onLocalSave();   // Cloud-Abgleich (sync.js)
}
function loadLocal() { try { const s = localStorage.getItem(STORE); return s ? JSON.parse(s) : null; } catch { return null; } }
function loadRoutes() { try { routes = JSON.parse(localStorage.getItem(RSTORE)) || {}; } catch { routes = {}; } }
function saveRoutes() {
  // nur aktuell gebrauchte Routen auf die Platte; im Arbeitsspeicher bleiben auch andere (schneller Routenwechsel)
  const used = new Set(sortedDays().map((d, i, l) => routeKey(dayPoints(d, i, l))));
  if (typeof extraRouteKeys === "function") extraRouteKeys().forEach(k => used.add(k));   // Vergleichsrouten
  try { localStorage.setItem(RSTORE, JSON.stringify(Object.fromEntries(Object.entries(routes).filter(([k]) => used.has(k))))); } catch { /* Cache ist optional */ }
}
async function loadDefault() {
  const r = await fetch("daten.json", { cache: "no-cache" });
  if (!r.ok) throw new Error("daten.json nicht gefunden");
  const j = await r.json(); delete j._info; return j;
}

/* ================= Tage & Wegpunkte ================= */
function sortedDays() { return [...state.days].sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.order ?? 0) - (b.order ?? 0)); }
function hasPos(p) { return p && typeof p.lat === "number" && typeof p.lon === "number"; }
// viaOverride: andere Zwischenziele (z. B. zum Vergleich ohne Panoramastraße); sonst gelten
// eingeplante Panoramastraßen (extras.js), sonst die Zwischenziele des Tages.
function dayPoints(d, idx, list, viaOverride) {
  const prev = idx > 0 ? list[idx - 1] : null;
  const start = prev && hasPos(prev) ? { name: prev.night, lat: prev.lat, lon: prev.lon } : home();
  const end = hasPos(d) ? { name: d.night, lat: d.lat, lon: d.lon } : null;
  let via;
  if (viaOverride !== undefined) via = viaOverride;
  else {
    const pv = typeof panoVia === "function" && panoVia(d);
    // Panoramastraße eingeplant: eigene Stopps bleiben erhalten und werden passend eingefügt
    via = pv ? mergeStops(start, pv, d.via || [], end) : (d.via || []);
  }
  const pts = [start, ...via.filter(hasPos)];
  if (end) pts.push(end);
  return pts;
}
// Fügt Punkte dort in eine Wegpunktliste ein, wo sie den kleinsten Umweg machen
// (nicht in Fährabschnitte). Punkte, die schon (fast) enthalten sind (< 2 km), werden übersprungen.
// lo/hi: erlaubter Bereich der Einfügeposition (z. B. „vor Ålesund“)
function cheapestIndex(start, list, p, end, lo = 0, hi = list.length) {
  const all = [start, ...list, ...(end ? [end] : [])];
  let best = hi, bestCost = Infinity;
  for (let i = lo; i <= Math.min(hi, all.length - 2); i++) {
    if (all[i].ferry) continue;
    const c = hav(all[i], p) + hav(p, all[i + 1]) - hav(all[i], all[i + 1]);
    if (c < bestCost) { bestCost = c; best = i; }
  }
  return best;            // Einfügeposition innerhalb von list
}
// Eigene Stopps in die Wegpunkte einer Panoramastraße einfügen. Die Reihenfolge der eigenen
// Stopps untereinander bleibt erhalten: Steht z. B. „Eidsdal“ vor „Ålesund“, kommt Eidsdal
// auch in der Route vor Ålesund – innerhalb dieser Grenzen dort, wo der Umweg am kleinsten ist.
function mergeStops(start, base, stops, end) {
  const out = [...base], st = stops.filter(hasPos);
  const at = s => out.findIndex(w => hav(w, s) < 2);
  let cursor = 0;
  st.forEach((s, i) => {
    const k = at(s);
    if (k >= 0) { cursor = k + 1; return; }
    let hi = out.length;
    for (const n of st.slice(i + 1)) { const kn = at(n); if (kn >= 0) { hi = kn; break; } }
    const pos = cheapestIndex(start, out, s, end, Math.min(cursor, hi), hi);
    out.splice(pos, 0, s); cursor = pos + 1;
  });
  return out;
}
function routeKey(pts) { return pts.map(p => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}${p.ferry ? "F" : ""}`).join(";"); }

/* ================= Routing (Valhalla) ================= */
function decodePolyline(str, prec = 6) {
  const f = 10 ** prec, out = []; let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, res = 0, b;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const v = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += v; else lon += v;
    }
    out.push([lat / f, lon / f]);
  }
  return out;
}
// Anfrage an den Routing-Server. Bei einer Störung (Netz, überlastet) bis zu zweimal wiederholen;
// e.perm = die Strecke selbst ist das Problem, ein neuer Versuch hilft nicht.
async function askRouter(q, { tries = 3, stop } = {}) {
  for (let n = 1; ; n++) {
    let e;
    try {
      const r = await fetch(ROUTER + encodeURIComponent(JSON.stringify(q)), AbortSignal.timeout ? { signal: AbortSignal.timeout(30000) } : {});
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.trip) return j;
      e = new Error(j.error || "Routing-Server antwortet mit " + r.status);
      e.code = j.error_code; e.perm = !!j.error_code && r.status >= 400 && r.status < 500 && r.status !== 429;
    } catch (x) { e = new Error("Routing-Server nicht erreichbar"); e.cause = x; }
    if (e.perm || n >= tries || !navigator.onLine || stop?.()) throw e;
    await sleep(n * 2500);
    if (stop?.()) throw e;
  }
}
// Autoroute über den Valhalla-Server der FOSSGIS (OpenStreetMap-Daten, kein Schlüssel nötig).
// Fähren im OSM-Netz (z. B. Puttgarden–Rødby, Fjordfähren) sind enthalten.
async function routeCar(pts, opt) {
  // exclude_ferry: Wegpunkte nie mitten auf einer Fährstrecke einrasten lassen (z. B. Punkt im Fjord)
  const q = { locations: pts.map(p => ({ lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), search_filter: { exclude_ferry: true } })),
    costing: "auto", units: "kilometers", directions_type: "maneuvers", language: "de-DE" };
  const j = await askRouter(q, opt).catch(e => { e.pts = pts; throw e; });
  // Fähren erkennen: Manöver-Typ 28 = „auf die Fähre fahren“; der Name steht oft im Straßennamen („Halhjem - Sandvikvåg“)
  const ferries = [];
  for (const l of j.trip.legs) {
    let shape = null;
    for (const m of l.maneuvers || []) if (m.type === 28) {
      const names = m.street_names || [];
      const nm = names.find(n => / - |–/.test(n)) || (names.length ? `Fähre auf der ${names[0]}` : "Fähre");
      shape = shape || decodePolyline(l.shape);
      const at = i => shape[Math.min(i, shape.length - 1)].map(v => +v.toFixed(4));
      // Anfang und Ende der Überfahrt – für die Abfahrtszeiten (ferries.js)
      ferries.push({ name: nm.replace(/\s+-\s+/g, "–"), min: Math.round(m.time / 60), from: at(m.begin_shape_index), to: at(m.end_shape_index) });
    }
  }
  return { km: j.trip.summary.length, h: j.trip.summary.time / 3600, encs: j.trip.legs.map(l => l.shape), ferries };
}
// Teilt die Wegpunkte in Autostrecken (OSRM) und eingetragene Fährabschnitte (Luftlinie).
async function computeRoute(pts, opt) {
  const res = { km: 0, h: 0, ferryKm: 0, ferryH: 0, parts: [], ferries: [] };
  // gleiche Punkte hintereinander (z. B. Ruhetag am selben Ort) nicht routen
  pts = pts.filter((p, i) => i === 0 || hav(pts[i - 1], p) > 0.05 || pts[i - 1].ferry);
  if (pts.length < 2) return res;
  let run = [pts[0]];
  const flush = async () => {
    if (run.length < 2) return;
    for (let k = 0; k < run.length - 1; k += 9) {     // der Server nimmt höchstens 10 Punkte je Anfrage
      const r = await routeCar(run.slice(k, k + 10), opt); res.km += r.km; res.h += r.h; res.ferries.push(...r.ferries);
      for (const enc of r.encs) res.parts.push({ ferry: false, enc });
      await sleep(350);
    }
  };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.ferry) {
      await flush();
      const km = hav(a, b);
      res.ferryKm += km; res.ferryH += km / FERRY_KMH;
      res.parts.push({ ferry: true, pts: [[a.lat, a.lon], [b.lat, b.lon]] });
      res.ferries.push({ name: `${a.name || "Fähre"} – ${b.name || ""}`.replace(/ – $/, ""), min: Math.round(km / FERRY_KMH * 60), manual: true,
        from: [+a.lat.toFixed(4), +a.lon.toFixed(4)], to: [+b.lat.toFixed(4), +b.lon.toFixed(4)] });
      run = [b];
    } else run.push(b);
  }
  await flush();
  return res;
}
// Welcher Punkt ist schuld? Liefert { msg, pt }
async function findRouteError(e) {
  const pts = e.pts || [], nm = p => `„${nightBase(p.name || "Wegpunkt")}“`;
  if (e.code === 171) try {
    const r = await fetch(ROUTER.replace("/route?", "/locate?") + encodeURIComponent(JSON.stringify({ costing: "auto",
      locations: pts.map(p => ({ lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), search_filter: { exclude_ferry: true } })) })));
    const j = await r.json(), bad = pts.filter((p, i) => !j[i]?.edges?.length && !j[i]?.nodes?.length);
    if (bad.length) return { msg: `${bad.map(nm).join(" und ")} ${bad.length > 1 ? "liegen" : "liegt"} zu weit von einer Straße entfernt.`, pt: bad[0] };
  } catch { /* dann paarweise suchen */ }
  if (pts.length === 2) return { msg: `Zwischen ${nm(pts[0])} und ${nm(pts[1])} wurde keine Autostrecke gefunden.`, pt: pts[1] };
  for (let i = 1; i < pts.length; i++) {
    await sleep(1100);
    try { await routeCar([pts[i - 1], pts[i]]); }
    catch (x) { if (x.perm) return { msg: `Zwischen ${nm(pts[i - 1])} und ${nm(pts[i])} wurde keine Autostrecke gefunden.`, pt: pts[i] }; break; }
  }
  return { msg: `Der Routing-Server meldet: ${e.message}.` };
}
// Nach einer Störung von selbst weiterprobieren, mit wachsenden Pausen
const RETRY_S = [30, 60, 120, 300, 600];
let retryTimer = null, retryNo = 0;
function planRetry() {
  clearTimeout(retryTimer); retryTimer = null;
  if (!Object.values(routeStatus).includes("wait")) { retryNo = 0; return; }
  retryTimer = setTimeout(() => { retryTimer = null; if (document.visibilityState === "visible") ensureRoutes(); }, RETRY_S[Math.min(retryNo++, RETRY_S.length - 1)] * 1000);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !retryTimer && Object.values(routeStatus).includes("wait")) ensureRoutes();
});
let routeGen = 0;
let ferryNews = [];
async function ensureRoutes() {
  const gen = ++routeGen;
  if (typeof waitCloudCache === "function") await waitCloudCache();   // erst schauen, ob ein anderes Gerät schon gerechnet hat
  if (gen !== routeGen) return;
  const list = sortedDays();
  ferryNews = [];
  let down = 0;                                       // Störungen hintereinander: dann nicht weiter anfragen
  for (let i = 0; i < list.length; i++) {
    if (gen !== routeGen) return;                     // neuere Berechnung läuft
    const d = list[i], pts = dayPoints(d, i, list);
    if (pts.length < 2) continue;
    const key = routeKey(pts);
    if (routes[key]) { applyRoute(d, routes[key]); if (routeStatus[d.id]) { delete routeStatus[d.id]; renderDay(d.id); } continue; }   // alte Meldung nicht stehen lassen
    if (routeErr[key]) { if (routeStatus[d.id] !== "err") { routeStatus[d.id] = "err"; renderDay(d.id); } continue; }
    if (!navigator.onLine) { if (routeStatus[d.id] !== "offline") { routeStatus[d.id] = "offline"; renderDay(d.id); } continue; }
    if (down >= 2) { if (routeStatus[d.id] !== "wait") { routeStatus[d.id] = "wait"; renderDay(d.id); } continue; }
    routeStatus[d.id] = "busy"; renderDay(d.id); updateStats();
    try {
      const r = await computeRoute(pts, { tries: down ? 1 : 3, stop: () => gen !== routeGen });
      down = 0;
      routes[key] = r; delete routeStatus[d.id];
      if (typeof cacheUp === "function") cacheUp("route", key, r);     // mit anderen Geräten teilen
      applyRoute(d, r); saveRoutes(); save();
    } catch (e) {
      console.warn("Routing", d.id, e);
      if (gen !== routeGen) return;
      if (e.perm) { routeErr[key] = await findRouteError(e); down = 0; } else if (navigator.onLine) down++;
      routeStatus[d.id] = e.perm ? "err" : navigator.onLine ? "wait" : "offline";
    }
    if (gen !== routeGen) return;
    renderDay(d.id); drawRoutes(); updateStats();
  }
  drawRoutes(); updateStats(); planRetry();
  if (typeof renderPanoGap === "function") { renderPanoGap(); renderPano(); }   // wie viel der Panoramastraßen gefahren wird
  if (typeof renderCostTop === "function" && state.costs) renderCostTop();   // Spritkosten hängen an den km
  if (ferryNews.length) { notice("⛴ " + ferryNews.join(" · ")); ferryNews = []; }
  if (typeof ensureOsm === "function") ensureOsm();                          // Tankstellen & Trinkwasser
  if (typeof ensureTolls === "function") ensureTolls();                      // Maut Norwegen (toll.js)
}
function applyRoute(d, r) {
  d.km = Math.round(r.km);
  d.hours = Math.round((r.h + r.ferryH) * 20) / 20;
  if (!r.ferries) return;
  // Fähren zählt jetzt die Routenberechnung; neue Fähren nach einer Änderung melden
  const names = r.ferries.map(f => f.name), old = d.ferryNames;
  if (Array.isArray(old)) {
    const added = names.filter(n => !old.includes(n)), gone = old.filter(n => !names.includes(n));
    if (added.length) ferryNews.push(`${fmtDate(d.date)}, ${d.title}: neue Fähre ${added.join(", ")}`);
    if (gone.length) ferryNews.push(`${fmtDate(d.date)}, ${d.title}: keine Fähre mehr ${gone.join(", ")}`);
  }
  d.ferryNames = names; d.ferries = names.length;
}
function routeFor(d) {
  const list = sortedDays(), i = list.findIndex(x => x.id === d.id);
  const pts = dayPoints(d, i, list);
  return pts.length < 2 ? null : routes[routeKey(pts)] || null;
}

/* ================= Ortssuche (Nominatim, max. 1 Anfrage/Sekunde) ================= */
let lastNomi = 0;
async function nomi(path) {
  if (!navigator.onLine) throw new Error("Keine Internetverbindung – die Ortssuche braucht Internet.");
  const wait = lastNomi + 1100 - Date.now(); if (wait > 0) await sleep(wait);
  lastNomi = Date.now();
  const r = await fetch(NOMI + path + "&format=jsonv2&accept-language=de");
  if (!r.ok) throw new Error("Ortssuche nicht erreichbar (" + r.status + ")");
  return r.json();
}
async function geocode(q) {
  const j = await nomi("search?limit=1&q=" + encodeURIComponent(q));
  if (!j.length) throw new Error(`„${q}“ wurde nicht gefunden.`);
  return { lat: Math.round(+j[0].lat * 1e4) / 1e4, lon: Math.round(+j[0].lon * 1e4) / 1e4, label: j[0].name || q };
}
async function reverseName(lat, lon) {
  const j = await nomi(`reverse?zoom=10&lat=${lat}&lon=${lon}`);
  const a = j.address || {};
  return a.city || a.town || a.village || a.municipality || a.county || j.name || null;
}

/* ================= Karte ================= */
const map = L.map("map", { zoomSnap: 0.5 }).setView([63.5, 15], 4);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  // crossOrigin: Kacheln als CORS-Antwort laden, damit der Service Worker sie platzsparend cachen kann
  maxZoom: 18, crossOrigin: "", attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);
let markers = {};
let pendingFit = false;      // ganze Route zeigen, sobald die Karte sichtbar ist
// Im Dunkelmodus wird die Karte per CSS abgedunkelt (style.css) – dann helle Linienfarben.
const COL = {
  get route() { return isDark() ? "#8ecae6" : "#1f4e63"; }, sel: "#f0913f", ferry: "#f0913f",
  get todo() { return isDark() ? "#91a5b0" : "#5a6d78"; }
};
window.addEventListener("themechange", () => { if (state) drawRoutes(); });
// Leaflet misst die Kartengröße nur beim Start; bei jeder Größenänderung neu messen,
// sonst werden Linien außerhalb des alten Ausschnitts abgeschnitten.
new ResizeObserver(() => { map.invalidateSize(); if (pendingFit) fitAll(); }).observe(document.getElementById("map"));

function drawRoutes() {
  routeLayer.clearLayers();
  if (!SHOW.route) return;                       // Route auf der Karte ausgeschaltet
  const list = sortedDays();
  list.forEach((d, i) => {
    const pts = dayPoints(d, i, list);
    if (pts.length < 2) return;
    const r = routes[routeKey(pts)], sel = d.id === selDay;
    const style = { color: sel ? COL.sel : COL.route, weight: sel ? 6 : 4, opacity: sel ? 1 : .85 };
    let lines = [];
    if (r) {
      for (const p of r.parts) {
        lines.push(p.ferry
          ? L.polyline(p.pts, { color: COL.ferry, weight: sel ? 4 : 3, dashArray: "6 6", bubblingMouseEvents: false })
          : L.polyline(decodePolyline(p.enc), { ...style, bubblingMouseEvents: false }));
      }
    } else {
      lines.push(L.polyline(pts.map(p => [p.lat, p.lon]), { color: COL.todo, weight: 2, dashArray: "2 6", bubblingMouseEvents: false }));
    }
    for (const l of lines) {
      l.on("click", () => selectDay(d.id, false));
      l.bindTooltip(`${fmtDate(d.date)}: ${esc(d.title)}`, { sticky: true });
      l.addTo(routeLayer);
      if (sel) l.bringToFront();
    }
  });
}
function icon(txt, cls, style = "") { return L.divIcon({ className: "", html: `<div class="nmk ${cls}"${style ? ` style="${style}"` : ""}>${esc(txt)}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }); }
function drawMarkers() {
  markerLayer.clearLayers(); markers = {};
  const h = home();
  if (SHOW.route) L.marker([h.lat, h.lon], { icon: icon("H", "home"), keyboard: false })
    .bindTooltip(`${esc(h.name)} – Start`, { className: "mtip" }).addTo(markerLayer);
  sortedDays().forEach((d, i) => {
    if (!SHOW.route || !hasPos(d) || d.night === "zu Hause") return;
    // Farbe nach Priorität des Ortes (prio.js)
    const pc = typeof nightMapColor === "function" ? nightMapColor(d) : null;
    const m = L.marker([d.lat, d.lon], { icon: icon(i + 1, (d.id === selDay ? "sel" : "") + (pc ? " prio" : ""), pc ? `--pc:${pc};--pi:${prioInk("o:" + ortSlug(d.night))}` : ""), draggable: !!window.mapEdit, title: d.night, riseOnHover: true });
    m.bindTooltip(`${i + 1}. ${esc(d.night)}${pc ? " · " + esc(prioName(ortPrio("o:" + ortSlug(d.night)))) : ""}`, { className: "mtip", direction: "top", offset: [0, -12] });
    m.on("click", () => selectDay(d.id, false));
    m.on("dragend", e => moveNight(d.id, e.target.getLatLng()));
    m.addTo(markerLayer); markers[d.id] = m;
  });
  if (typeof drawStops === "function") drawStops();          // Stopps des gewählten Tages (stops.js)
  if (typeof drawOsm === "function") drawOsm();              // Tankstellen & Wasser des gewählten Tages (osm.js)
}
function fitAll() {
  // Karte ausgeblendet (anderer Reiter, iPad-Liste)? Dann erst einpassen, wenn sie sichtbar wird
  map.invalidateSize();
  if (!map.getSize().x || !map.getSize().y) { pendingFit = true; return; }
  pendingFit = false;
  const b = L.latLngBounds([[home().lat, home().lon]]);
  state.days.filter(hasPos).forEach(d => b.extend([d.lat, d.lon]));
  map.fitBounds(b, { padding: [20, 20] });
}
function zoomToDay(id, tries = 0) {
  // Karte gerade erst eingeblendet (iPad: Liste → Karte)? Erst neu messen, sonst rechnet Leaflet mit Größe 0
  map.invalidateSize();
  if (!map.getSize().x) { if (tries < 20) setTimeout(() => zoomToDay(id, tries + 1), 50); return; }
  const list = sortedDays(), i = list.findIndex(x => x.id === id); if (i < 0) return;
  const pts = dayPoints(list[i], i, list); if (!pts.length) return;
  pendingFit = false;
  const r = routes[routeKey(pts)];
  const b = L.latLngBounds(pts.map(p => [p.lat, p.lon]));
  if (r) r.parts.forEach(p => (p.ferry ? p.pts : decodePolyline(p.enc)).forEach(x => b.extend(x)));
  map.flyToBounds(b, { padding: [40, 40], maxZoom: 11, duration: .6 });
}

/* ================= Übernachtung verschieben ================= */
async function moveNight(id, ll) {
  const d = state.days.find(x => x.id === id); if (!d) return;
  undoSnap = JSON.stringify(state.days);
  const oldName = d.night;
  d.lat = Math.round(ll.lat * 1e4) / 1e4; d.lon = Math.round(ll.lng * 1e4) / 1e4;
  save(); refresh();
  let msg = `Übernachtung ${esc(oldName)} verschoben – Route wird neu berechnet.`;
  try {
    const name = await reverseName(d.lat, d.lon);
    if (name && name !== oldName) {
      renameNight(d, oldName, name);
      msg = `Übernachtung von ${esc(oldName)} nach <b>${esc(name)}</b> verschoben – Route wird neu berechnet.`;
      save(); renderDays(); drawMarkers();
    }
  } catch (e) { console.warn(e); }
  notice(msg, true);
}
// Name ändern, auch im eigenen Titel und im Titel des Folgetags („A → B“)
function renameNight(d, oldName, name) {
  const base = s => (s || "").replace(/\s*\(.*\)\s*$/, "");
  const ob = base(oldName);
  d.night = name;
  if (ob && d.title?.includes(ob)) d.title = d.title.replace(ob, name);
  const list = sortedDays(), i = list.findIndex(x => x.id === d.id), next = list[i + 1];
  if (next && ob && next.title?.startsWith(ob)) next.title = name + next.title.slice(ob.length);
}

/* ================= Anzeige ================= */
// Reine Infos verschwinden nach 8 s, mit „Rückgängig“ nach 20 s; Hinweise mit Auswahl bleiben stehen.
// Solange die Maus darüber ist bzw. der Finger darauf tippt, bleibt der Hinweis.
let noticeTimer = null;
function notice(html, withUndo = false, extraHtml = "") {
  const n = $("#notice");
  n.innerHTML = `<span>${html}</span>${withUndo && undoSnap ? `<button class="btn ghost mini" type="button" id="btnUndo">Rückgängig</button>` : ""}${extraHtml}<button class="btn ghost mini" type="button" id="btnHide">Ausblenden</button>`;
  n.hidden = false;
  n.classList.remove("low"); if (n.getBoundingClientRect().bottom < 60) n.classList.add("low");   // nach unten gescrollt: unten einblenden
  clearTimeout(noticeTimer);
  n.dataset.ms = extraHtml ? 0 : withUndo && undoSnap ? 20000 : 8000;
  if (+n.dataset.ms) noticeTimer = setTimeout(() => { n.hidden = true; }, +n.dataset.ms);
}
$("#notice").addEventListener("pointerenter", () => clearTimeout(noticeTimer));
$("#notice").addEventListener("pointerleave", () => {
  const n = $("#notice"); if (!n.hidden && +n.dataset.ms) noticeTimer = setTimeout(() => { n.hidden = true; }, 4000);
});
$("#notice").addEventListener("click", e => {
  if (e.target.id === "btnHide") $("#notice").hidden = true;
  if (e.target.id === "btnUndo" && undoSnap) {
    state.days = JSON.parse(undoSnap); if (undoAfter?.snap === undoSnap) undoAfter.run();
    undoSnap = null; undoAfter = null; save(); $("#notice").hidden = true; refresh();
  }
});

function mapsUrl(pts) {
  const f = p => `${p.lat},${p.lon}`;
  const via = pts.slice(1, -1).slice(0, 9).map(f).join("|");
  return "https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=" + encodeURIComponent(f(pts[0])) +
    "&destination=" + encodeURIComponent(f(pts[pts.length - 1])) + (via ? "&waypoints=" + encodeURIComponent(via) : "");
}
// Kompakte Kärtchen: Kopfzeile mit den wichtigsten Angaben, Details erst beim Antippen
const expandedDays = new Set();
let allExpanded = false;
function daySummary(d, r, st) {
  const chips = [];
  if (st === "busy") chips.push(`<span class="busy">Route wird berechnet …</span>`);
  else if (st === "offline" && !r) chips.push(`<span class="busy">offline</span>`);
  else if (r && r.km < 0.1 && !r.ferryKm) chips.push(`<span class="live">Ruhetag</span>`);
  else if (r) {
    const total = r.h + r.ferryH;
    chips.push(`<span>${num(r.km)} km</span>`, `<span class="${total > LONG_DAY ? "long" : ""}">${fmtShortH(total)}</span>`);
  } else if (d.km) chips.push(`<span>ca. ${num(d.km)} km</span>`);
  if (st === "err") chips.push(`<span class="err">Routing fehlgeschlagen</span>`);
  else if (st === "wait") chips.push(`<span class="busy">Routing-Server gestört – neuer Versuch folgt</span>`);
  const fl = r?.ferries || [];
  if (fl.length) chips.push(`<span class="ferry" title="${esc(fl.map(f => f.name).join(", "))}">⛴ ${fl.length}</span>`);
  if (typeof osmFor === "function" && r) {
    const { o } = osmFor(d);
    if (o) { const g = fuelGaps(o); if (!o.fuel.length || g.km > FUEL_GAP_WARN) chips.push(`<span class="warnchip" title="Lange Strecke ohne Tankstelle">⛽ ${num(g.km)} km</span>`); }
  }
  if (typeof dayTolls === "function" && r?.tolls) { const n = dayTolls(r).length; if (n) chips.push(`<span title="Mautstellen in Norwegen">🛣 ${n}</span>`); }
  const stops = (d.via || []).filter(v => v.stay > 0).length + (typeof dayProgram === "function" ? dayProgram(d).list.length : 0);
  if (stops) chips.push(`<span class="prog" title="Stopps und eingeplante Ziele">📍 ${stops}</span>`);
  if (typeof nightSky === "function" && !/zu hause/i.test(d.night || "")) {
    const k = nightSky(d); if (k && (k.cls === "good" || k.cls === "mid")) chips.push(`<span class="chance ${k.cls}" title="Polarlicht-Chance">🌌</span>`);
  }
  if (d.warn) chips.push(`<span class="warnchip" title="${esc(d.warn)}">⚠</span>`);
  return chips.join("");
}
const fmtShortH = h => { const m = Math.round(h * 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };

// Grund und Abhilfe, wenn sich eine Etappe nicht berechnen lässt
function routeErrHtml(d, idx, list, pts) {
  const x = routeErr[routeKey(pts)]; if (!x) return "";
  const p = x.pt, same = q => p && q && hasPos(q) && hav(p, q) < 0.05;
  const how = !p ? "Prüfe die Punkte dieses Tages unter „Bearbeiten“."
    : (d.via || []).some(same) ? `Ziehe den Punkt mit „✎ Karte bearbeiten“ auf eine Straße, oder suche ihn unter „Bearbeiten“ neu bzw. entferne ihn dort mit ✕.`
    : same(d) ? `Das ist die Übernachtung dieses Tages. Ziehe sie mit „✎ Karte bearbeiten“ auf eine Straße, oder suche unter „Bearbeiten“ einen anderen Ort.`
    : same(list[idx - 1]) ? `Das ist die Übernachtung des Vortags. Ziehe sie mit „✎ Karte bearbeiten“ auf eine Straße, oder suche beim Vortag unter „Bearbeiten“ einen anderen Ort.`
    : idx === 0 && same(pts[0]) ? "Das ist dein Startpunkt."
    : "Der Punkt gehört zu einer eingeplanten Panoramastraße. Nimm sie im Reiter „Panoramastraßen“ heraus.";
  return `<span class="rerr"><b>${esc(x.msg)}</b> ${how}${p ? ` <button type="button" class="btn ghost mini" data-errpt="${esc(d.id)}|${p.lat}|${p.lon}">Punkt zeigen</button>` : ""}</span>`;
}
function dayHtml(d, idx, list) {
  const dt = new Date(d.date + "T12:00:00");
  const pts = dayPoints(d, idx, list);
  const r = pts.length > 1 ? routes[routeKey(pts)] : null;
  const st = routeStatus[d.id];
  const open = allExpanded || expandedDays.has(d.id) || editingDay === d.id;
  let drive = "";
  if (r && r.km >= 0.1) {
    const total = r.h + r.ferryH;
    drive = `<span class="live" title="Live berechnet über OpenStreetMap-Daten">live</span><span>${num(r.km)} km</span>` +
      `<span class="${total > LONG_DAY ? "long" : ""}">${fmtH(r.h)} Fahrt${total > LONG_DAY ? " – langer Tag" : ""}</span>` +
      (r.ferryH ? `<span class="ferry">+ ca. ${fmtH(r.ferryH)} Fähre</span>` : "");
  } else if (!r && d.km) drive = `<span>Planwert: ca. ${num(d.km)} km</span>` + (d.hours ? `<span>${fmtH(d.hours)}</span>` : "");
  const fl = r?.ferries;
  if (fl?.length) drive += `<span class="ferry" title="${esc(fl.map(f => `${f.name} (ca. ${f.min} min)`).join(" · "))}">⛴ ${fl.length} ${fl.length === 1 ? "Fähre" : "Fähren"}: ${esc(fl.map(f => f.name).join(", "))}</span>`;
  let h = `<li class="day${d.id === selDay ? " sel" : ""}${open ? " open" : ""}" data-day="${esc(d.id)}" tabindex="0" aria-expanded="${open}">
    <span class="d"><span class="grip" title="Ziehen zum Verschieben" aria-hidden="true">⠿</span><b>${fmtDate(d.date)}</b><small>${isNaN(dt) ? "" : DAY_NAMES[dt.getDay()] + " · "}Tag ${dayNo(d.date)}</small></span>
    <span class="body">
      <span class="head"><span class="t">${esc(d.title || "Ohne Titel")}</span><span class="chev" aria-hidden="true">${open ? "▴" : "▾"}</span></span>
      <span class="sum">${daySummary(d, r, st)}</span>
      <span class="movebtns"><button type="button" class="btn ghost mini" data-move="${esc(d.id)}:-1" aria-label="Tag nach oben"${idx === 0 ? " disabled" : ""}>↑</button><button type="button" class="btn ghost mini" data-move="${esc(d.id)}:1" aria-label="Tag nach unten"${idx === list.length - 1 ? " disabled" : ""}>↓</button></span>`;
  if (open) h += `
      <span class="details">
      ${st === "err" ? routeErrHtml(d, idx, list, pts) : ""}
      ${d.sub ? `<span class="s">${esc(d.sub)}</span>` : ""}
      ${drive ? `<span class="drive">${drive}</span>` : ""}
      ${typeof ferryHtml === "function" ? ferryHtml(d, r) : ""}
      ${d.night ? `<span class="night">${esc(d.night)}</span>` : ""}
      ${typeof dayExtrasHtml === "function" ? dayExtrasHtml(d, r) : ""}
      ${typeof actsLine === "function" && editingDay !== d.id ? actsLine(d) : ""}
      ${d.todo ? `<span class="todo">${esc(d.todo).replace(/\n/g, "<br>")}</span>` : ""}
      ${d.warn ? `<span class="w">${esc(d.warn)}</span>` : ""}
      ${editingDay !== d.id ? `<span class="acts">
        <button type="button" class="btn ghost mini onlynarrow" data-showday="${esc(d.id)}">🗺 Auf der Karte</button>
        ${pts.length > 1 ? `<a class="btn go mini" href="${esc(mapsUrl(pts))}" target="_blank" rel="noopener noreferrer">Google Maps ↗</a>` : ""}
        ${hasPos(d) && !/zu hause/i.test(d.night || "") ? `<a class="btn ghost mini" href="https://park4night.com/de/search?lat=${d.lat}&lng=${d.lon}&z=12" target="_blank" rel="noopener noreferrer" title="Stellplätze rund um ${esc(d.night)} bei park4night ansehen">park4night ↗</a>` : ""}
        <button type="button" class="btn ghost mini" data-edit="${esc(d.id)}">Bearbeiten</button>
        <button type="button" class="btn ghost mini" data-extend="${esc(d.id)}" title="Eine weitere Nacht am selben Ort – alle folgenden Tage rücken einen Tag nach hinten">+ Nacht</button>
        ${typeof canSplit === "function" && canSplit(d, r) ? `<button type="button" class="btn ghost mini" data-split="${esc(d.id)}" title="Unterwegs übernachten: teilt diese Etappe in zwei kürzere">🌙 Zwischenübernachtung</button>` : ""}
        ${typeof mergeNight === "function" && idx < list.length - 1 ? `<button type="button" class="btn ghost mini" data-mergenight="${esc(d.id)}" title="Hier nicht übernachten: diese und die nächste Etappe werden zusammengelegt">Nacht auflösen</button>` : ""}
        ${st === "err" || st === "wait" ? `<button type="button" class="btn ghost mini" data-retry="${esc(d.id)}">Route neu versuchen</button>` : ""}
      </span>` : ""}
      </span>`;
  h += `</span>`;
  if (editingDay === d.id) h += editForm(d);
  return h + "</li>";
}
// Zwischenziele als Liste: Name (mit Suche), Aufenthalt, „ab hier Fähre“, sortieren, löschen
function viaRow(v = {}) {
  const has = typeof v.lat === "number";
  return `<div class="viarow" data-lat="${has ? v.lat : ""}" data-lon="${has ? v.lon : ""}" data-orig="${esc(v.name || "")}" data-extra="${esc(JSON.stringify({ wp: v.wp, pv: v.pv, pano: v.pano, anchor: v.anchor, key: v.key }))}">
    <span class="vmain"><input type="text" class="vname" maxlength="60" value="${esc(v.name || "")}" placeholder="Ort, z. B. Egersund" aria-label="Name des Zwischenziels">
      <button type="button" class="btn ghost mini" data-vsearch title="Ort suchen">Suchen</button></span>
    <span class="vopts">
      <label class="vstay">Aufenthalt <input type="number" class="vstayin" min="0" max="1440" step="5" value="${v.stay || ""}" placeholder="0" aria-label="Aufenthalt in Minuten"> min</label>
      <label class="vferry"><input type="checkbox" class="vferryin"${v.ferry ? " checked" : ""}> ab hier Fähre</label>
      <span class="vbtns"><button type="button" class="btn ghost mini" data-vup aria-label="nach oben">↑</button><button type="button" class="btn ghost mini" data-vdown aria-label="nach unten">↓</button><button type="button" class="btn danger mini" data-vdel aria-label="Zwischenziel löschen">✕</button></span>
    </span>
    <span class="vpos hint">${has ? `${v.lat}, ${v.lon}` : "wird beim Speichern gesucht"}</span>
  </div>`;
}
function editForm(d) {
  return `<form class="edit" data-save="${esc(d.id)}" autocomplete="off">
    <label class="lbl">Etappe<input type="text" name="title" maxlength="80" value="${esc(d.title)}"></label>
    <div class="two">
      <label class="lbl">Datum<input type="date" name="date" value="${esc(d.date)}"></label>
      <span class="lbl">Fähren<span class="hint">werden automatisch aus der Route erkannt</span></span>
    </div>
    <label class="lbl">Strecke / Beschreibung<input type="text" name="sub" maxlength="140" value="${esc(d.sub)}"></label>
    <div class="inline">
      <label class="lbl">Übernachtung<input type="text" name="night" maxlength="80" value="${esc(d.night)}"></label>
      <button class="btn ghost mini" type="button" data-find>Ort suchen</button>
    </div>
    <label class="lbl">Koordinaten <span class="hint">z. B. aus Google Maps kopiert: 62.47, 6.19</span><input type="text" name="coords" value="${hasPos(d) ? esc(d.lat + ", " + d.lon) : ""}"></label>
    <div class="lbl">Zwischenziele &amp; Stopps <span class="hint">in Fahrtreihenfolge. Nur ein Name genügt – der Ort wird gesucht. „ab hier Fähre“ = von diesem Punkt zum nächsten per Schiff.</span></div>
    <div class="vialist">${(d.via || []).map(viaRow).join("")}</div>
    <button type="button" class="btn ghost mini vadd" data-vadd>+ Zwischenziel</button>
    <label class="lbl">Vorhaben &amp; Notizen<textarea name="todo" maxlength="600">${esc(d.todo)}</textarea></label>
    <label class="lbl">Achtung-Hinweis<input type="text" name="warn" maxlength="140" value="${esc(d.warn)}" placeholder="leer lassen, wenn alles passt"></label>
    <p class="formerr" data-err></p>
    <div class="acts">
      <button class="btn mini" type="submit">Speichern</button>
      <button class="btn ghost mini" type="button" data-cancel>Abbrechen</button>
      <button class="btn danger mini" type="button" data-del="${esc(d.id)}">Tag löschen</button>
    </div>
  </form>`;
}
function renderDays() {
  const list = sortedDays();
  $("#h-route").textContent = list.length ? `${list.length} Tage` : "Route";
  $("#days").innerHTML = list.length ? list.map((d, i) => dayHtml(d, i, list)).join("")
    : `<li class="empty">Noch keine Tage eingetragen.</li>`;
  if (typeof renderNightGap === "function") renderNightGap();
  if (typeof renderPanoGap === "function") renderPanoGap();
  const last = list[list.length - 1];
  if (last && !$("#nDate").value) {
    const n = new Date(last.date + "T12:00:00"); n.setDate(n.getDate() + 1);
    $("#nDate").value = n.toISOString().slice(0, 10);
  }
}
function renderDay(id) {
  if (editingDay === id) return;                      // Formular nicht unter den Fingern wegziehen
  const list = sortedDays(), i = list.findIndex(x => x.id === id);
  const el = document.querySelector(`.day[data-day="${CSS.escape(id)}"]`);
  if (i < 0 || !el) return renderDays();
  el.outerHTML = dayHtml(list[i], i, list);
}
// Gesamtstrecke: live berechnete Etappen, sonst die eingetragenen Planwerte
function routeTotals() {
  const list = sortedDays();
  let km = 0, h = 0, live = 0, busy = 0;
  list.forEach((d, i) => {
    const pts = dayPoints(d, i, list), r = pts.length > 1 ? routes[routeKey(pts)] : null;
    if (r) { km += r.km; h += r.h + r.ferryH; live++; } else { km += d.km || 0; h += d.hours || 0; }
    if (routeStatus[d.id] === "busy") busy++;
  });
  return { km, h, live, busy, n: list.length };
}
function updateStats() {
  const list = sortedDays(), t = routeTotals();
  if (typeof renderRouteBar === "function" && document.activeElement?.id !== "routeSel") renderRouteBar();   // km in der Routenauswahl
  const days = Math.ceil((new Date(tripStart() + "T00:00:00") - new Date()) / 864e5);
  const openTodos = (state.todos || []).filter(x => !x.done).length;
  $("#sCount").innerHTML = days > 0 ? `${num(days)} <small>Tage</small>` : "unterwegs";
  $("#sDates").textContent = (list.length ? `${fmtDate(list[0].date)} – ${fmtDate(list[list.length - 1].date)}` : "") +
    (openTodos ? ` · ${openTodos} To-dos offen` : "");
  $("#sKm").innerHTML = `${num(t.km)} <small>km</small>`;
  const longDays = list.filter(d => (d.hours || 0) > LONG_DAY).length;
  $("#sKmX").textContent = t.busy ? `Route wird berechnet … (${t.live}/${t.n})` :
    `${num(t.h)} h Fahrzeit` + (longDays ? ` · ${longDays} lange Tage` : "") + (t.live < t.n ? ` · ${t.live}/${t.n} live` : "");
  if (typeof costSummary === "function" && state.costs) {
    const s = costSummary();
    $("#sCost").innerHTML = `${euro(s.total)}`;
    $("#sCostX").textContent = `${euro(s.total / s.persons)} pro Person` + (s.missing ? ` · ${s.missing} ohne Betrag` : "");
    const n = state.pack?.length || 0, d = state.pack?.filter(i => i.done).length || 0;
    $("#sPack").innerHTML = n ? `${d}<small>/${n}</small>` : "–";
    $("#sPackBar").style.width = n ? (d / n * 100).toFixed(1) + "%" : "0";
  }
}
function refresh() {
  if (typeof normalizeState === "function" && normalizeState(state)) save();   // alte Listenformate umwandeln
  renderDays(); drawMarkers(); drawRoutes(); updateStats(); ensureRoutes();
  if (typeof renderLists === "function") renderLists();
}

function selectDay(id, zoom = true) {
  selDay = id;
  document.querySelectorAll(".day").forEach(x => x.classList.toggle("sel", x.dataset.day === selDay));
  drawMarkers(); drawRoutes();
  if (zoom) zoomToDay(id);
  else document.querySelector(`.day[data-day="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ================= Formulare ================= */
function parseCoords(s) {
  const m = String(s).match(/(-?\d+(?:[.,]\d+)?)\s*[,; ]\s*(-?\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const lat = +m[1].replace(",", "."), lon = +m[2].replace(",", ".");
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}
async function readVias(f) {
  const out = [];
  for (const row of f.querySelectorAll(".viarow")) {
    const name = row.querySelector(".vname").value.trim(); if (!name) continue;
    let lat = parseFloat(row.dataset.lat), lon = parseFloat(row.dataset.lon);
    if (!isFinite(lat) || !isFinite(lon)) { const g = await geocode(name); lat = g.lat; lon = g.lon; }
    const v = { name, lat, lon, ...(name === row.dataset.orig ? JSON.parse(row.dataset.extra || "{}") : {}) };   // Kennzeichen aus planer.js behalten
    const stay = parseInt(row.querySelector(".vstayin").value, 10); if (stay > 0) v.stay = Math.min(1440, stay);
    if (row.querySelector(".vferryin").checked) v.ferry = true;
    out.push(v);
  }
  if (out.length > 20) throw new Error("Höchstens 20 Zwischenziele.");
  return out;
}

$("#days").addEventListener("click", async e => {
  const t = e.target;
  if (t.closest("[data-edit]")) { editingDay = t.closest("[data-edit]").dataset.edit; renderDays(); return; }
  if (t.closest("[data-cancel]")) { editingDay = null; renderDays(); return; }
  if (t.closest("[data-retry]")) {
    const id = t.closest("[data-retry]").dataset.retry, list = sortedDays(), i = list.findIndex(x => x.id === id);
    delete routeStatus[id]; if (i >= 0) delete routeErr[routeKey(dayPoints(list[i], i, list))];
    ensureRoutes(); return;
  }
  if (t.closest("[data-errpt]")) {
    const [id, lat, lon] = t.closest("[data-errpt]").dataset.errpt.split("|");
    if (!SHOW.route) { SHOW.route = true; syncMapButtons(); redrawMap(); }
    if (typeof setMapList === "function") setMapList("map");
    selectDay(id, false); map.invalidateSize(); pendingFit = false; map.setView([+lat, +lon], 10, { animate: false });
    L.popup().setLatLng([+lat, +lon]).setContent(`<div class="pop"><span>Dieser Punkt lässt sich nicht anfahren. Mit „✎ Karte bearbeiten“ kannst du ihn verschieben.</span></div>`).openOn(map);
    $(".mapbox").scrollIntoView({ block: "start" }); return;
  }
  if (t.closest("[data-del]")) {
    const id = t.closest("[data-del]").dataset.del, d = state.days.find(x => x.id === id);
    if (!confirm(`Tag „${d?.title}“ wirklich löschen? Die folgenden Tage rücken dann einen Tag nach vorne.`)) return;
    undoSnap = JSON.stringify(state.days);
    state.days = state.days.filter(x => x.id !== id); editingDay = null;
    if (typeof renumberDays === "function") renumberDays();
    save(); refresh();
    notice(`Tag „${esc(d?.title)}“ gelöscht, die folgenden Tage sind einen Tag nach vorne gerückt.`, true); return;
  }
  if (t.closest("[data-find]")) {
    const f = t.closest("form"), err = f.querySelector("[data-err]"), btn = t.closest("[data-find]");
    btn.disabled = true; err.textContent = "";
    try { const g = await geocode(f.night.value.replace(/\s*\(.*\)\s*$/, "")); f.coords.value = `${g.lat}, ${g.lon}`; }
    catch (x) { err.textContent = x.message; }
    btn.disabled = false; return;
  }
  const vrow = t.closest(".viarow");
  if (t.closest("[data-vadd]")) { const list = t.closest("form").querySelector(".vialist"); list.insertAdjacentHTML("beforeend", viaRow()); list.lastElementChild.querySelector(".vname").focus(); return; }
  if (vrow && t.closest("[data-vdel]")) { vrow.remove(); return; }
  if (vrow && t.closest("[data-vup]")) { vrow.previousElementSibling?.before(vrow); return; }
  if (vrow && t.closest("[data-vdown]")) { vrow.nextElementSibling?.after(vrow); return; }
  if (vrow && t.closest("[data-vsearch]")) {
    const btn = t.closest("[data-vsearch]"), pos = vrow.querySelector(".vpos"), name = vrow.querySelector(".vname").value.trim();
    if (!name) return;
    btn.disabled = true; pos.textContent = "suche …";
    try { const g = await geocode(name); vrow.dataset.lat = g.lat; vrow.dataset.lon = g.lon; vrow.dataset.orig = name; pos.textContent = `${g.lat}, ${g.lon}`; }
    catch (x) { pos.textContent = x.message; }
    btn.disabled = false; return;
  }
  if (t.closest("[data-showday]")) { const id = t.closest("[data-showday]").dataset.showday; if (!SHOW.route) { SHOW.route = true; syncMapButtons(); redrawMap(); } if (typeof setMapList === "function") setMapList("map"); selectDay(id); return; }
  if (t.closest("button, input, textarea, a, form, label, select")) return;
  const li = t.closest("[data-day]"); if (!li) return;
  // Antippen: Tag auswählen und Details auf- bzw. zuklappen
  const id = li.dataset.day;
  if (expandedDays.has(id) || allExpanded) { expandedDays.delete(id); if (allExpanded) { allExpanded = false; sortedDays().forEach(x => x.id !== id && expandedDays.add(x.id)); } }
  else expandedDays.add(id);
  selDay = id; renderDay(id);
  selectDay(id, !document.querySelector(".route.ml-list"));
});
// Name eines Zwischenziels geändert → beim Speichern neu suchen
$("#days").addEventListener("input", e => {
  const row = e.target.closest(".viarow"); if (!row || !e.target.matches(".vname")) return;
  if (e.target.value.trim() !== row.dataset.orig) { row.dataset.lat = row.dataset.lon = ""; row.querySelector(".vpos").textContent = "wird beim Speichern gesucht"; }
});
$("#days").addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-day]")) { e.preventDefault(); selectDay(e.target.dataset.day); }
});
$("#days").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, id = f.dataset.save, d = state.days.find(x => x.id === id), err = f.querySelector("[data-err]");
  const btn = f.querySelector("[type=submit]"); btn.disabled = true; err.textContent = "";
  try {
    let pos = f.coords.value.trim() ? parseCoords(f.coords.value) : null;
    if (f.coords.value.trim() && !pos) throw new Error("Koordinaten nicht lesbar – Format: 62.47, 6.19");
    if (!pos && f.night.value.trim()) { const g = await geocode(f.night.value.replace(/\s*\(.*\)\s*$/, "")); pos = { lat: g.lat, lon: g.lon }; }
    const via = await readVias(f);
    undoSnap = JSON.stringify(state.days);
    const oldNight = d.night, newNight = f.night.value.trim();
    Object.assign(d, {
      title: f.elements.title.value.trim(), date: f.date.value || d.date, sub: f.sub.value.trim(),
      todo: f.todo.value.trim(), warn: f.warn.value.trim(), via
    });
    if (pos) { d.lat = pos.lat; d.lon = pos.lon; }
    if (newNight && newNight !== oldNight) renameNight(d, oldNight, newNight);
    for (const k of ["sub", "todo", "warn"]) if (!d[k]) delete d[k];
    editingDay = null; save(); refresh();
  } catch (x) { err.textContent = x.message; btn.disabled = false; }
});

$("#addDay").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#nNight").value.trim(), date = $("#nDate").value, err = $("#nErr");
  err.textContent = "";
  if (!name || !date) { err.textContent = "Bitte Ort und Datum angeben."; return; }
  const btn = e.target.querySelector("[type=submit]"); btn.disabled = true;
  try {
    const g = await geocode(name);
    const list = sortedDays(), prev = [...list].reverse().find(x => x.date <= date);
    const d = { id: uid(), order: Math.max(0, ...state.days.map(x => x.order || 0)) + 1, date,
      title: `${prev ? prev.night.replace(/\s*\(.*\)\s*$/, "") : "Hamburg"} → ${name}`, night: name,
      lat: g.lat, lon: g.lon, ferries: 0, via: [] };
    state.days.push(d); save();
    $("#nNight").value = ""; $("#nDate").value = "";
    selDay = d.id; refresh(); zoomToDay(d.id);
  } catch (x) { err.textContent = x.message; }
  btn.disabled = false;
});

/* ================= Sichern / Laden / Zurücksetzen ================= */
$("#btnExport").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ _info: "Nordtour-Sicherung vom " + new Date().toLocaleString("de-DE"), ...state }, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `nordtour-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("#fileImport").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    if (!Array.isArray(j.days)) throw new Error("Die Datei enthält keine Tage.");
    delete j._info; undoSnap = JSON.stringify(state.days);
    state = j; save(); selDay = editingDay = null; refresh(); fitAll();
    notice(`${j.days.length} Tage aus „${esc(file.name)}“ geladen.`);
  } catch (x) { notice("Laden fehlgeschlagen: " + esc(x.message)); }
  e.target.value = "";
});
// „Zurücksetzen“ gibt es nicht mehr: die lokale daten.json ist veraltet, ältere Stände kommen aus „Sicherungen“.

/* ================= Start ================= */
const appReady = (async function init() {
  loadRoutes();
  if (typeof loadExtras === "function") await loadExtras();   // Panoramastraßen & Ziele (extras.js)
  state = loadLocal();
  if (!state) {
    // daten.json gibt es nur lokal (sie wird nicht auf GitHub hochgeladen)
    try { state = await loadDefault(); }
    catch { state = { days: [] }; notice("Noch keine Reisedaten in diesem Browser. Lade deine Sicherung (z. B. <b>daten.json</b> oder eine „nordtour-….json“) mit dem Knopf „Laden“."); }
  }
  save(); fitAll(); refresh();
})();
