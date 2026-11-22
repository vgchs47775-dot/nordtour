/* Panoramastraßen und Sehenswürdigkeiten („Erleben“).
   Daten: extras.json (erzeugt von werkzeuge/build_extras.py).
   Eingeplantes steht in state.settings.panorama_geplant und state.settings.sights_geplant.
   Eine eingeplante Panoramastraße ändert die Wegpunkte ihres Reisetags (panoVia) – die Route
   wird dann live darüber berechnet. Diese Datei wird VOR app.js geladen; alles, was app.js
   braucht (map, state, $ …), wird erst beim Aufruf bzw. nach DOMContentLoaded benutzt. */
"use strict";

let EXTRAS = null;
let panoGen = 0, panoBusy = false;
const SHOW = { route: true, pano: true, sights: true, orte: true, fuel: false, water: false };   // Ebenen der Karte

async function loadExtras() {
  try {
    const r = await fetch("extras.json", { cache: "no-cache" });
    EXTRAS = r.ok ? await r.json() : null;
  } catch { EXTRAS = null; }
}
const PANO = () => EXTRAS?.pano || [];
const SIGHTS = () => EXTRAS?.sights || [];
const plannedList = kind => state?.settings?.[kind === "pano" ? "panorama_geplant" : "sights_geplant"] || [];
const isPlanned = (kind, id) => plannedList(kind).includes(id);
function togglePlanned(kind, id) {
  const key = kind === "pano" ? "panorama_geplant" : "sights_geplant";
  state.settings = state.settings || {};
  const set = new Set(state.settings[key] || []);
  set.has(id) ? set.delete(id) : set.add(id);
  state.settings[key] = [...set];
  save(); refresh();
  const p = kind === "pano" && PANO().find(x => x.id === id);
  if (p && !state.days.some(d => p.days.includes(d.id)))
    notice("Diese Route wurde aus Prioritäten erstellt: Einplanen ändert hier die Strecke nicht. Setze eine Priorität und erstelle die Route neu.");
}

/* ================= Panoramastraßen → Wegpunkte ================= */
// Liefert die Zwischenziele eines Tages mit den eingeplanten Panoramastraßen – oder null.
function panoVia(d) {
  const vs = EXTRAS?.variants?.[d.id]; if (!vs) return null;
  const ids = [...new Set(Object.keys(vs).flatMap(k => k.split("+")))].filter(id => isPlanned("pano", id)).sort();
  return ids.length ? vs[ids.join("+")] || null : null;
}
// Punkte zum Vergleich: Tag ohne Panoramastraße und Tag nur mit dieser einen Straße
function panoCompare(p) {
  const list = sortedDays(), out = [];
  for (const dayId of p.days) {
    const i = list.findIndex(x => x.id === dayId), v = EXTRAS.variants?.[dayId]?.[p.id];
    if (i < 0 || !v) continue;
    const d = list[i];
    out.push({ d, base: dayPoints(d, i, list, d.via || []), with: dayPoints(d, i, list, v) });
  }
  return out;
}
function panoDelta(p) {
  const cmp = panoCompare(p); if (!cmp.length) return null;
  let km = 0, h = 0;
  for (const c of cmp) {
    const a = routes[routeKey(c.base)], b = routes[routeKey(c.with)];
    if (!a || !b) return null;
    km += b.km - a.km; h += (b.h + b.ferryH) - (a.h + a.ferryH);
  }
  return { km, h, n: cmp.length };
}
const fmtShort = h => { const m = Math.round(h * 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; };
const fmtDelta = (km, h) => `${km >= 0 ? "+" : "−"}${num(Math.abs(km))} km · ${h >= 0 ? "+" : "−"}${fmtShort(Math.abs(h))}`;
function panoExtraText(p) {
  if (!p.days.some(id => EXTRAS.variants?.[id]?.[p.id])) return p.days.length ? "liegt auf der Route" : p.fallbackExtra;
  const dl = panoDelta(p);
  if (!dl) return panoBusy ? "Umweg wird berechnet …" : p.fallbackExtra;
  return fmtDelta(dl.km, dl.h) + (dl.n > 1 ? " über beide Tage" : " gegenüber der normalen Etappe");
}
function extraRouteKeys() {
  if (!EXTRAS || !state) return [];
  return PANO().flatMap(p => panoCompare(p).flatMap(c => [routeKey(c.base), routeKey(c.with)]));
}
// Vergleichsrouten nacheinander berechnen (nur fehlende; danach im Zwischenspeicher)
async function ensurePanoRoutes() {
  if (!EXTRAS || panoBusy) return;
  const gen = ++panoGen; panoBusy = true;
  try {
    if (typeof waitCloudCache === "function") await waitCloudCache();
    for (const p of PANO()) for (const c of panoCompare(p)) for (const pts of [c.base, c.with]) {
      if (gen !== panoGen) return;
      const k = routeKey(pts);
      if (routes[k]) continue;
      try { routes[k] = await computeRoute(pts); saveRoutes(); if (typeof cacheUp === "function") cacheUp("route", k, routes[k]); } catch (e) { console.warn("Panorama-Vergleich", p.id, e); }
      renderPano();
    }
  } finally { panoBusy = false; renderPano(); }
}

/* ================= Tag in der Routenliste ================= */
// Reisetag eines Ziels: der vorgesehene Tag – in anderen Routen der Tag, der am nächsten vorbeikommt (bis 80 km)
function sightDayId(x) {
  if (state.days.some(d => d.id === x.day)) return x.day;
  let best = null, bd = 80;
  for (const d of state.days) for (const p of [d, ...(d.via || [])]) if (hasPos(p)) { const km = hav(p, x); if (km < bd) { bd = km; best = d.id; } }
  return best;
}
function dayProgram(d) {
  // als Stopp in der Route enthaltene Ziele nicht doppelt zählen (v.key, siehe planer.js)
  const list = SIGHTS().filter(x => sightDayId(x) === d.id && isPlanned("sights", x.id) && !(d.via || []).some(v => v.key === "s:" + x.id));
  return { list, visit: list.reduce((a, x) => a + x.visit, 0), detour: list.reduce((a, x) => a + x.detour, 0) };
}
function dayExtrasHtml(d, r) {
  const sky = (typeof osmDayHtml === "function" ? osmDayHtml(d, r) : "") + (typeof tollDayHtml === "function" ? tollDayHtml(d, r) : "") +
    (typeof skyLine === "function" ? skyLine(d) : "");
  if (!EXTRAS) return sky;
  let h = "";
  for (const p of PANO().filter(p => isPlanned("pano", p.id) && (p.days.includes(d.id) || d.panos?.includes(p.id)))) {
    const part = p.days.length > 1 && p.days.includes(d.id) ? ` (Teil ${p.days.indexOf(d.id) + 1} von ${p.days.length})` : "";
    h += `<span class="pano">Über ${esc(p.name)}${part}</span>`;
  }
  // Tagesprogramm: eingeplante Sehenswürdigkeiten + Aufenthalte an eigenen Stopps
  const pr = dayProgram(d);
  const stops = (d.via || []).filter(v => v.stay > 0);
  const stopH = stops.reduce((a, v) => a + v.stay / 60, 0);
  if (pr.list.length) h += `<span class="prog">Programm: ${pr.list.map(x => esc(x.name)).join(", ")} · ${fmtShort(pr.visit)}${pr.detour ? ` + ${fmtShort(pr.detour)} Umweg` : ""}</span>`;
  if (stops.length) h += `<span class="stops">Stopps: ${stops.map(v => `${esc(v.name)} ${fmtShort(v.stay / 60)}`).join(", ")}</span>`;
  if (pr.list.length || stops.length) {
    const drive = r ? r.h + r.ferryH : (d.hours || 0), tot = drive + pr.visit + pr.detour + stopH;
    h += `<span class="total${tot > 10 ? " long" : ""}">Fahrt ${fmtShort(drive)} + Programm ${fmtShort(tot - drive)} = Tag gesamt ca. ${fmtShort(tot)}${tot > 10 ? " – sehr voll" : ""}</span>`;
  }
  return h + sky;
}

/* ================= Fotos ================= */
const galImgs = key => { const [k, id] = key.split(":"); return (k === "pano" ? PANO() : SIGHTS()).find(x => x.id === id)?.imgs || []; };
const cut = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;
const capHtml = i => `Foto: <a href="${esc(i.page)}" target="_blank" rel="noopener noreferrer">${esc(cut(i.artist, 50))}</a>, ${esc(i.license)}`;
function gallery(key) {
  const imgs = galImgs(key); if (!imgs.length) return "";
  return `<figure class="gal" data-gal="${esc(key)}" data-i="0"><img src="${esc(imgs[0].src)}" alt="" loading="lazy">` +
    (imgs.length > 1 ? `<button type="button" class="gal-nav prev" data-galnav="-1" aria-label="Vorheriges Foto">‹</button><button type="button" class="gal-nav next" data-galnav="1" aria-label="Nächstes Foto">›</button><span class="gal-count">1/${imgs.length}</span>` : "") +
    `<figcaption>${capHtml(imgs[0])}</figcaption></figure>`;
}
function galStep(fig, step) {
  const imgs = galImgs(fig.dataset.gal), n = imgs.length; if (n < 2) return;
  const i = ((+fig.dataset.i + step) % n + n) % n;
  fig.dataset.i = i; fig.querySelector("img").src = imgs[i].src;
  fig.querySelector("figcaption").innerHTML = capHtml(imgs[i]);
  fig.querySelector(".gal-count").textContent = `${i + 1}/${n}`;
}

/* ================= Reiter Panoramastraßen ================= */
function panoDays(p) { return state.days.filter(d => p.days.includes(d.id) || d.panos?.includes(p.id)).sort((a, b) => a.date.localeCompare(b.date)); }
function panoWhen(p) {
  const ds = panoDays(p); if (!ds.length) return "kein passender Reisetag";
  const a = ds[0], b = ds[ds.length - 1];
  return ds.length > 1 ? `${fmtDate(a.date)}–${fmtDate(b.date)} (Tag ${dayNo(a.date)}–${dayNo(b.date)})` : `${fmtDate(a.date)} (Tag ${dayNo(a.date)})`;
}
function panoMapsUrl(p) {
  const g = p.geom, n = Math.min(g.length, 10);
  const pts = Array.from({ length: n }, (_, i) => g[Math.round(i * (g.length - 1) / (n - 1))]).map(x => ({ lat: x[0], lon: x[1] }));
  return mapsUrl(pts);
}
function renderPano() {
  const el = document.getElementById("panoCards"); if (!el || !EXTRAS) return;
  const first = p => panoDays(p)[0]?.date || "9999";
  $("#panoChips").innerHTML = prioChips("pano", prioCounts(PANO().map(p => panoPrio(p.id))));
  el.innerHTML = [...PANO()].filter(p => prioMatch("pano", panoPrio(p.id))).sort((a, b) => first(a).localeCompare(first(b))).map(p => {
    const on = isPlanned("pano", p.id), pr = panoPrio(p.id);
    return `<article class="card pano-card${on ? " on" : ""}${pr ? " hasprio" : ""}"${pr ? ` style="--pc:var(--p-${pr})"` : ""}>
      ${gallery("pano:" + p.id)}
      <h3>${esc(p.name)}</h3>
      <span class="meta">${esc(p.land)} · ca. ${num(p.km)} km · ${esc(panoWhen(p))}</span>
      <span class="meta delta">${esc(panoExtraText(p))}</span>
      <p>${esc(p.desc)}</p>
      <span class="fit">${esc(p.fit)}</span>
      ${prioButtons("pano", p.id, p.name)}
      <div class="acts">
        <button type="button" class="btn ${on ? "moss" : "ghost"} mini" data-plan="pano:${esc(p.id)}">${on ? "✓ Eingeplant" : "Einplanen"}</button>
        <button type="button" class="btn ghost mini" data-showmap="pano:${esc(p.id)}">Auf der Karte</button>
        <a class="btn go mini" href="${esc(panoMapsUrl(p))}" target="_blank" rel="noopener noreferrer">Google Maps ↗</a>
      </div>
    </article>`;
  }).join("") || `<p class="empty wide">Keine Panoramastraße mit dieser Priorität.</p>`;
  const n = plannedList("pano").length;
  $("#panoSum").textContent = panoBusy ? "Umwege werden live berechnet …" : n ? `${n} eingeplant` : "";
}

/* ================= Reiter Erleben ================= */
function renderSights() {
  const el = document.getElementById("sightList"); if (!el || !EXTRAS) return;
  const only = $("#sightOnly").checked, list = sortedDays();
  const groups = list.map((d, i) => ({ d, i, xs: SIGHTS().filter(x => sightDayId(x) === d.id && (!only || isPlanned("sights", x.id))) }));
  const orphan = SIGHTS().filter(x => !list.some(d => d.id === sightDayId(x)) && (!only || isPlanned("sights", x.id)));
  el.innerHTML = groups.filter(g => g.xs.length).map(g => `<div class="sday">
      <h3>${fmtDate(g.d.date)} · Tag ${dayNo(g.d.date)} · ${esc(g.d.title || "")}</h3>
      <div class="cards">${g.xs.map(sightCard).join("")}</div></div>`).join("") +
    (orphan.length ? `<div class="sday"><h3>Ohne passenden Reisetag</h3><div class="cards">${orphan.map(sightCard).join("")}</div></div>` : "") ||
    `<p class="empty">${only ? "Noch nichts eingeplant." : "Keine Ziele vorhanden."}</p>`;
  const pl = SIGHTS().filter(x => isPlanned("sights", x.id));
  $("#sightSum").textContent = pl.length ? `${pl.length} eingeplant · ${fmtH(pl.reduce((a, x) => a + x.visit + x.detour, 0))} insgesamt` : "";
}
function sightCard(x) {
  const on = isPlanned("sights", x.id);
  return `<article class="card sight-card${on ? " on" : ""}">
    ${gallery("sight:" + x.id)}
    <h4>${esc(x.name)}${ortPrio("s:" + x.id) ? ` <span class="ppill" style="--pc:var(--p-${ortPrio("s:" + x.id)});--pi:var(--pi-${ortPrio("s:" + x.id)})">${esc(prioName(ortPrio("s:" + x.id)))}</span>` : ""}</h4>
    <span class="meta">${esc(x.type)} · ca. ${fmtShort(x.visit)} vor Ort${x.detour ? ` · ${fmtShort(x.detour)} Umweg` : " · direkt an der Strecke"}</span>
    <p>${esc(x.desc)}</p>
    <div class="acts">
      <button type="button" class="btn ${on ? "sight" : "ghost"} mini" data-plan="sights:${esc(x.id)}">${on ? "✓ Eingeplant" : "Einplanen"}</button>
      <button type="button" class="btn ghost mini" data-showmap="sight:${esc(x.id)}">Auf der Karte</button>
      <a class="btn go mini" href="https://www.google.com/maps/search/?api=1&query=${x.lat},${x.lon}" target="_blank" rel="noopener noreferrer">Google Maps ↗</a>
    </div>
  </article>`;
}

/* ================= Karte ================= */
let panoLayer = null, sightLayer = null;
const panoLines = {}, sightMarkers = {};
function popupPano(p) {
  const on = isPlanned("pano", p.id);
  return `<div class="pop" data-pop="pano|${esc(p.id)}">${gallery("pano:" + p.id)}<b>${esc(p.name)}</b><span>${esc(panoWhen(p))} · ${esc(panoExtraText(p))}</span>
    ${prioButtons("pano", p.id, p.name)}
    <div class="acts"><button type="button" class="btn ${on ? "moss" : "ghost"} mini" data-plan="pano:${esc(p.id)}">${on ? "✓ Eingeplant" : "Einplanen"}</button>
    <a class="btn ghost mini" href="#panorama">Details</a></div></div>`;
}
function popupSight(x) {
  const on = isPlanned("sights", x.id);
  return `<div class="pop" data-pop="sight|${esc(x.id)}">${gallery("sight:" + x.id)}<b>${esc(x.name)}</b><span>${esc(x.type)} · ${fmtShort(x.visit)}${x.detour ? ` + ${fmtShort(x.detour)} Umweg` : ""}</span>
    <span class="tipdesc">${esc(x.desc)}</span>
    ${prioButtons("ort", "s:" + x.id, x.name)}
    <div class="acts"><button type="button" class="btn ${on ? "sight" : "ghost"} mini" data-plan="sights:${esc(x.id)}">${on ? "✓ Eingeplant" : "Einplanen"}</button></div></div>`;
}
function drawExtras() {
  if (!EXTRAS || !panoLayer) return;
  panoLayer.clearLayers(); sightLayer.clearLayers();
  if (SHOW.pano) for (const p of PANO()) {
    // Farbe nach Priorität (rot/gelb/braun), ohne Priorität grün; eingeplant = breit, sonst gestrichelt
    const on = isPlanned("pano", p.id), pr = panoPrio(p.id), color = pr ? prioColor(pr) : "#3d7a3a";
    if (pr) L.polyline(p.geom, { pane: "panoPane", interactive: false, color: isDark() ? "#0e171d" : "#3a2a1a", weight: on ? 16 : 6.5, opacity: .4 }).addTo(panoLayer);   // dunkler Rand, damit Gelb lesbar bleibt
    const line = L.polyline(p.geom, { pane: "panoPane", interactive: false, color, ...(on ? { weight: pr ? 13 : 8, opacity: pr ? 1 : .55 } : { weight: pr ? 4.5 : 3.5, opacity: pr ? 1 : .75, dashArray: "4 7" }) });
    const hit = L.polyline(p.geom, { pane: "panoPane", color: "#000", opacity: 0, weight: 16, bubblingMouseEvents: false });
    hit.bindPopup(() => popupPano(p), { maxWidth: 300, minWidth: 240 });
    hit.bindTooltip(esc(p.name) + (pr ? " · " + esc(prioName(pr)) : ""), { sticky: true });
    line.addTo(panoLayer); hit.addTo(panoLayer); panoLines[p.id] = hit;
  }
  if (SHOW.sights) for (const x of SIGHTS()) {
    const on = isPlanned("sights", x.id);
    const c = ortMapColor("s:" + x.id), pr = ortPrio("s:" + x.id);
    const m = L.marker([x.lat, x.lon], { icon: L.divIcon({ className: "", html: `<div class="smk${on ? " on" : ""}${c ? " prio" : ""}"${c ? ` style="--pc:${c}"` : ""}></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }), riseOnHover: true });
    m.bindPopup(() => popupSight(x), { maxWidth: 300, minWidth: 240 });
    m.bindTooltip(esc(x.name) + (c ? " · " + esc(prioName(pr)) : ""), { direction: "top", offset: [0, -8] });
    m.addTo(sightLayer); sightMarkers[x.id] = m;
  }
}
function showOnMap(key) {
  const [k, id] = key.split(":");
  location.hash = "#route";
  setTimeout(() => {
    if (matchMedia("(max-width: 860px)").matches) setMapList("map");      // iPad hochkant: von der Liste zur Karte
    map.invalidateSize(); pendingFit = false;
    if (k === "pano") {
      const p = PANO().find(x => x.id === id); if (!p) return;
      if (!SHOW.pano) { SHOW.pano = true; syncMapButtons(); drawExtras(); }
      // ohne Animation: Popup kann sofort öffnen (Animationen hängen z. B. in Hintergrund-Tabs)
      map.fitBounds(L.latLngBounds(p.geom), { padding: [40, 40], maxZoom: 10, animate: false });
      const g = p.geom[Math.floor(p.geom.length / 2)];
      panoLines[id]?.openPopup(L.latLng(g[0], g[1]));
    } else {
      const x = SIGHTS().find(s => s.id === id); if (!x) return;
      if (!SHOW.sights) { SHOW.sights = true; syncMapButtons(); drawExtras(); }
      map.setView([x.lat, x.lon], 10, { animate: false });
      sightMarkers[id]?.openPopup();
    }
    $(".mapbox").scrollIntoView({ behavior: "smooth", block: "start" });
  }, 50);
}
// Nach dem Umschalten einer Ebene alles neu zeichnen
function redrawMap() { map.closePopup(); drawRoutes(); drawMarkers(); drawExtras(); drawOrte(); }
function syncMapButtons() {
  document.querySelectorAll("[data-maplayer]").forEach(b => b.setAttribute("aria-pressed", SHOW[b.dataset.maplayer] ? "true" : "false"));
}

/* ================= Alles zeichnen & Ereignisse ================= */
function renderExtras() {
  if (!EXTRAS) return;
  renderPano(); renderSights(); drawExtras();
  renderOrte(); drawOrte();
  $("#nPano").textContent = plannedList("pano").length;
  $("#nSights").textContent = plannedList("sights").length;
}
window.addEventListener("DOMContentLoaded", () => {
  // Panoramastraßen unter die Route legen (eigene Ebene)
  map.createPane("panoPane").style.zIndex = 390;
  panoLayer = L.layerGroup().addTo(map);
  sightLayer = L.layerGroup().addTo(map);
  const Ctl = L.Control.extend({
    onAdd() {
      const div = L.DomUtil.create("div", "leaflet-bar map-layers");
      div.innerHTML = `<button type="button" data-maplayer="route" aria-pressed="true" title="Route ein-/ausblenden">R</button>` +
        `<button type="button" data-maplayer="pano" aria-pressed="true" title="Panoramastraßen ein-/ausblenden">P</button>` +
        `<button type="button" data-maplayer="sights" aria-pressed="true" title="Sehenswürdigkeiten ein-/ausblenden">S</button>` +
        `<button type="button" data-maplayer="orte" aria-pressed="true" title="Prioritäten der Orte ein-/ausblenden">O</button>` +
        `<button type="button" data-maplayer="fuel" aria-pressed="false" title="Tankstellen an der Route ein-/ausblenden">⛽</button>` +
        `<button type="button" data-maplayer="water" aria-pressed="false" title="Trinkwasser an der Route ein-/ausblenden">💧</button>`;
      L.DomEvent.disableClickPropagation(div);
      return div;
    }
  });
  new Ctl({ position: "topright" }).addTo(map);

  document.addEventListener("click", e => {
    const pl = e.target.closest("[data-plan]");
    if (pl) { const [k, id] = pl.dataset.plan.split(":"); map.closePopup(); togglePlanned(k, id); return; }
    const sm = e.target.closest("[data-showmap]");
    if (sm) { showOnMap(sm.dataset.showmap); return; }
    const gn = e.target.closest("[data-galnav]");
    if (gn) { galStep(gn.closest(".gal"), +gn.dataset.galnav); return; }
    const ml = e.target.closest("[data-maplayer]");
    if (ml) { SHOW[ml.dataset.maplayer] = !SHOW[ml.dataset.maplayer]; syncMapButtons(); redrawMap(); osmZoomHint(ml.dataset.maplayer); }
  });
  $("#sightOnly").addEventListener("change", renderSights);
  window.addEventListener("hashchange", () => { if (location.hash === "#panorama") ensurePanoRoutes(); });
  appReady.then(() => { renderExtras(); if (location.hash === "#panorama") ensurePanoRoutes(); });
});
