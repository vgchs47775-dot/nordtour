/* Tankstellen und Trinkwasser aus OpenStreetMap (Overpass-API).
   Pro Etappe einmal abgefragt – in kleinen Rechtecken entlang der berechneten Route – und dauerhaft
   gespeichert (auch offline verfügbar). Neu abgefragt wird nur, wenn sich die Route ändert.
   - Tankstellen: höchstens 1 km neben der Strecke; daraus die längste Strecke ohne Tankstelle.
   - Trinkwasser: höchstens 2 km neben der Strecke und bis 5 km um die Übernachtung.
   Wird nach stops.js geladen. */
"use strict";

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const OSTORE = "nordtour.osm.v1";
const FUEL_GAP_WARN = 100;          // km ohne Tankstelle, ab denen gewarnt wird
let osmData = {}, osmStatus = {}, osmBusy = false;
try { osmData = JSON.parse(localStorage.getItem(OSTORE)) || {}; } catch { osmData = {}; }
function saveOsm() {
  const used = new Set(sortedDays().map((d, i, l) => routeKey(dayPoints(d, i, l))));
  for (const k of Object.keys(osmData)) if (!used.has(k)) delete osmData[k];
  try { localStorage.setItem(OSTORE, JSON.stringify(osmData)); } catch { /* Speicher voll – dann eben neu laden */ }
}

/* ---------- Geometrie ---------- */
// Alle Autostrecken-Punkte einer Route mit fortlaufender Kilometerangabe
function routeTrack(r) {
  const pts = [];
  for (const p of r.parts) if (!p.ferry) for (const x of decodePolyline(p.enc)) pts.push(x);
  const km = [0];
  for (let i = 1; i < pts.length; i++) km.push(km[i - 1] + hav({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] }));
  return { pts, km };
}
// Rechtecke von ca. 40 km Streckenlänge, etwas größer als die Strecke
function trackBoxes(t, padLat = .025) {
  const boxes = []; let cur = null, start = 0;
  t.pts.forEach((p, i) => {
    if (!cur) { cur = [p[0], p[1], p[0], p[1]]; start = t.km[i]; }
    cur[0] = Math.min(cur[0], p[0]); cur[1] = Math.min(cur[1], p[1]); cur[2] = Math.max(cur[2], p[0]); cur[3] = Math.max(cur[3], p[1]);
    if (t.km[i] - start > 40 || i === t.pts.length - 1) {
      const padLon = padLat / Math.cos(cur[0] * Math.PI / 180);
      boxes.push([cur[0] - padLat, cur[1] - padLon, cur[2] + padLat, cur[3] + padLon].map(v => v.toFixed(4)).join(","));
      cur = null;
    }
  });
  return boxes;
}
// Nächster Streckenpunkt → Abstand zur Strecke und Kilometer auf der Strecke
function nearestOnTrack(t, lat, lon) {
  let best = 0, bd = Infinity;
  const c = Math.cos(lat * Math.PI / 180);
  for (let i = 0; i < t.pts.length; i += 3) {
    const dy = t.pts[i][0] - lat, dx = (t.pts[i][1] - lon) * c, dd = dx * dx + dy * dy;
    if (dd < bd) { bd = dd; best = i; }
  }
  return { km: t.km[best], dist: hav({ lat, lon }, { lat: t.pts[best][0], lon: t.pts[best][1] }) };
}

/* ---------- Abfrage ---------- */
async function overpass(q) {
  let lastErr;
  for (const url of OVERPASS) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 100e3);   // höchstens 100 s warten
    try {
      const r = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), signal: ctl.signal });
      if (r.ok) return await r.json();
      lastErr = new Error("Overpass antwortet mit " + r.status);
    } catch (e) { lastErr = e; }
    finally { clearTimeout(timer); }
  }
  throw lastErr;
}
async function loadOsmFor(d, pts, r) {
  const t = routeTrack(r); if (t.pts.length < 2) return { fuel: [], water: [], total: 0 };
  const fuelBoxes = trackBoxes(t, .012), waterBoxes = trackBoxes(t, .02);   // ~1,3 km bzw. ~2,2 km Rand
  const end = pts[pts.length - 1];
  const nb = [end.lat - .05, end.lon - .1, end.lat + .05, end.lon + .1].map(v => v.toFixed(4)).join(",");
  // schlank: Wasser nur als Punkte, Tankstellen als Punkte oder Flächen
  const parts = fuelBoxes.map(b => `node["amenity"="fuel"](${b});way["amenity"="fuel"](${b});`).join("") +
    [...waterBoxes, nb].map(b => `node["amenity"~"^(drinking_water|water_point)$"](${b});node["man_made"="water_tap"](${b});`).join("");
  const j = await overpass(`[out:json][timeout:80];(${parts});out center tags qt;`);
  const seen = new Set(), fuel = [], water = [];
  for (const e of j.elements || []) {
    const id = e.type + e.id; if (seen.has(id)) continue; seen.add(id);
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon, tg = e.tags || {};
    if (lat == null) continue;
    const pos = nearestOnTrack(t, lat, lon);
    if (tg.amenity === "fuel") {
      if (tg.boat === "yes" || tg.motorcar === "no" || tg.access === "private" || /båt|boat/i.test(tg.name || "")) continue;
      if (pos.dist > 1) continue;
      fuel.push({ lat: +lat.toFixed(5), lon: +lon.toFixed(5), km: Math.round(pos.km), name: tg.name || tg.brand || "Tankstelle", brand: tg.brand || "",
        oh: tg.opening_hours || "", auto: tg.self_service === "only" || /automat|ubetjent/i.test((tg.name || "") + " " + (tg.description || "")) });
    } else {
      if (tg.drinking_water === "no" || tg.access === "private") continue;
      const toNight = hav({ lat, lon }, end);
      if (pos.dist > 2 && toNight > 5) continue;
      water.push({ lat: +lat.toFixed(5), lon: +lon.toFixed(5), km: Math.round(pos.km), name: tg.name || "", night: Math.round(toNight * 10) / 10,
        seasonal: tg.seasonal || "", note: tg.description || tg.note || "" });
    }
  }
  fuel.sort((a, b) => a.km - b.km); water.sort((a, b) => a.km - b.km);
  return { fuel, water, total: Math.round(t.km[t.km.length - 1]), at: Date.now() };
}
async function ensureOsm() {
  if (osmBusy || !navigator.onLine) return;
  osmBusy = true;
  try {
    const list = sortedDays();
    for (let i = 0; i < list.length; i++) {
      const d = list[i], pts = dayPoints(d, i, list); if (pts.length < 2) continue;
      const key = routeKey(pts), r = routes[key];
      if (!r || osmData[key] || !r.km) continue;
      if (osmStatus[key]?.retry > Date.now()) continue;              // nach einem Fehler erst später wieder
      osmStatus[key] = "busy"; renderDay(d.id);
      try { osmData[key] = await loadOsmFor(d, pts, r); delete osmStatus[key]; saveOsm(); }
      catch (e) {
        // Server überlastet o. Ä.: diese Runde beenden und später alles Fehlende erneut versuchen
        osmStatus[key] = { retry: Date.now() + 10 * 60e3 }; console.warn("Overpass", d.id, e);
        renderDay(d.id); break;
      }
      renderDay(d.id); if (d.id === selDay) drawOsm();
      await sleep(1500);                                  // den freiwilligen Overpass-Server schonen
    }
  } finally { osmBusy = false; }
}
window.addEventListener("online", () => { for (const k of Object.keys(osmStatus)) delete osmStatus[k]; ensureOsm(); });
setInterval(() => { if (document.visibilityState === "visible") ensureOsm(); }, 5 * 60e3);   // fehlgeschlagene später nachholen

/* ---------- Auswertung & Anzeige im Tageskärtchen ---------- */
function osmFor(d) {
  const list = sortedDays(), i = list.findIndex(x => x.id === d.id); if (i < 0) return {};
  const key = routeKey(dayPoints(d, i, list));
  return { key, o: osmData[key], st: osmStatus[key] };
}
function fuelGaps(o) {
  const ks = [{ km: 0, name: "Start" }, ...o.fuel, { km: o.total, name: "Ziel" }];
  let gap = null;
  for (let i = 1; i < ks.length; i++) { const g = ks[i].km - ks[i - 1].km; if (!gap || g > gap.km) gap = { km: g, a: ks[i - 1], b: ks[i] }; }
  return gap;
}
function osmDayHtml(d, r) {
  if (!r || !r.km || /zu hause/i.test(d.night || "") && r.km < 1) return "";
  const { o, st } = osmFor(d);
  if (!o) return st === "busy" ? `<span class="osm muted">Tankstellen & Trinkwasser werden gesucht …</span>`
    : st?.retry ? `<span class="osm muted">Tankstellen & Trinkwasser: Server gerade überlastet, neuer Versuch später</span>` : "";
  const g = fuelGaps(o);
  const fuelTxt = !o.fuel.length
    ? `<span class="osm warn">⛽ Keine Tankstelle direkt an der Strecke (${num(o.total)} km) – vorher volltanken!</span>`
    : g.km > FUEL_GAP_WARN
      ? `<span class="osm warn">⛽ ${num(g.km)} km ohne Tankstelle: ${esc(g.a.name)} (km ${num(g.a.km)}) bis ${esc(g.b.name)} (km ${num(g.b.km)}) – vorher volltanken</span>`
      : `<span class="osm">⛽ ${o.fuel.length} Tankstellen an der Strecke, längste Lücke ${num(g.km)} km</span>`;
  const nearNight = o.water.filter(w => w.night <= 5).sort((a, b) => a.night - b.night)[0];
  const onRoute = o.water.length;
  const waterTxt = `<span class="osm water">💧 ${onRoute ? `${onRoute} Trinkwasser-Stelle${onRoute > 1 ? "n" : ""} an der Strecke` : "Kein Trinkwasser an der Strecke bekannt"}${nearNight ? ` · nächste zur Übernachtung ${String(nearNight.night).replace(".", ",")} km` : onRoute ? " · keine bekannte Stelle bei der Übernachtung" : ""}</span>`;
  return fuelTxt + waterTxt;
}

/* ---------- Karte: Tankstellen & Wasser des gewählten Tages ---------- */
const osmLayer = L.layerGroup().addTo(map);
const osmIcon = (txt, cls) => L.divIcon({ className: "", html: `<div class="omk ${cls}">${txt}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
function drawOsm() {
  osmLayer.clearLayers();
  const d = state?.days.find(x => x.id === selDay); if (!d) return;
  const { o } = osmFor(d); if (!o) return;
  for (const f of o.fuel) {
    L.marker([f.lat, f.lon], { icon: osmIcon("⛽", "fuel"), keyboard: false })
      .bindPopup(`<div class="pop"><b>${esc(f.name)}</b><span>${f.brand && f.brand !== f.name ? esc(f.brand) + " · " : ""}km ${num(f.km)} der Etappe${f.auto ? " · Automat (Karte)" : ""}</span>${f.oh ? `<span>Öffnungszeiten: ${esc(f.oh)}</span>` : ""}</div>`)
      .addTo(osmLayer);
  }
  for (const w of o.water) {
    L.marker([w.lat, w.lon], { icon: osmIcon("💧", "water"), keyboard: false })
      .bindPopup(`<div class="pop"><b>${esc(w.name || "Trinkwasser")}</b><span>km ${num(w.km)} der Etappe · ${String(w.night).replace(".", ",")} km von der Übernachtung</span>${w.seasonal ? `<span>saisonal: ${esc(w.seasonal)}</span>` : ""}${w.note ? `<span>${esc(w.note)}</span>` : ""}<span class="hint">Daten aus OpenStreetMap – vor Ort prüfen</span></div>`)
      .addTo(osmLayer);
  }
}
