/* Tage umsortieren, Nächte verlängern und Stopps (Zwischenziele) auf der Karte.
   - Reihenfolge der Tage = Reihenfolge der Daten: nach jedem Verschieben werden die Daten
     fortlaufend ab dem ersten Reisetag neu vergeben.
   - Stopps sind die via-Punkte eines Tages; neu ist die Aufenthaltsdauer v.stay (Minuten).
   Wird nach app.js geladen. */
"use strict";

const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const nightBase = s => (s || "").replace(/\s*\(.*\)\s*$/, "");

// Daten fortlaufend vergeben und „A → B“-Titel an den neuen Vortag anpassen
function renumberDays(ids) {
  const list = ids ? ids.map(id => state.days.find(d => d.id === id)).filter(Boolean) : sortedDays();
  if (!list.length) return;
  const start = sortedDays()[0].date;
  list.forEach((d, i) => {
    d.date = addDays(start, i); d.order = i;
    if (i > 0 && d.title?.includes(" → ")) d.title = nightBase(list[i - 1].night) + " → " + d.title.split(" → ").slice(1).join(" → ");
  });
}
function moveDay(id, dir) {
  const ids = sortedDays().map(d => d.id), i = ids.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  undoSnap = JSON.stringify(state.days);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  renumberDays(ids); save(); refresh();
  notice("Reihenfolge geändert – die Daten wurden angepasst, die Routen werden neu berechnet.", true);
}
function extendNight(id) {
  const list = sortedDays(), i = list.findIndex(d => d.id === id), d = list[i]; if (!d) return;
  undoSnap = JSON.stringify(state.days);
  const rest = { id: uid(), order: i + 0.5, date: addDays(d.date, 1), title: `Ruhetag in ${nightBase(d.night)}`, night: d.night,
    lat: d.lat, lon: d.lon, ferries: 0, via: [] };
  state.days.push(rest);
  const ids = list.map(x => x.id); ids.splice(i + 1, 0, rest.id);
  renumberDays(ids); save(); refresh();
  notice(`Zusätzliche Nacht in ${esc(nightBase(d.night))} eingefügt – alle folgenden Tage sind einen Tag nach hinten gerückt.`, true);
}

/* ---------- Drag & Drop in der Etappenliste (SortableJS, funktioniert auch per Touch) ---------- */
// Verschieben ist nur im Modus „Reihenfolge ändern“ möglich – so kann nichts aus Versehen verrutschen.
let sorter = null, reorderMode = false;
function setReorder(on) {
  reorderMode = on;
  $("#days").classList.toggle("reorder", on);
  sorter?.option("disabled", !on);
  const b = $("#btnReorder");
  b.textContent = on ? "✓ Fertig" : "Reihenfolge ändern";
  b.classList.toggle("go", on); b.setAttribute("aria-pressed", on ? "true" : "false");
  if (on) notice("Reihenfolge ändern: Tage am Griff ⠿ ziehen oder mit ↑/↓ verschieben. Danach auf „Fertig“ klicken.");
  else if (!$("#notice").hidden && /^Reihenfolge ändern/.test($("#notice").textContent)) $("#notice").hidden = true;
}
function initSortable() {
  if (window.Sortable) sorter = Sortable.create($("#days"), {
    handle: ".grip", animation: 150, ghostClass: "drag-ghost", disabled: true,
    onEnd(e) {
      if (e.oldIndex === e.newIndex) return;
      undoSnap = JSON.stringify(state.days);
      const ids = [...$("#days").querySelectorAll("[data-day]")].map(li => li.dataset.day);
      renumberDays(ids); save(); refresh();
      notice("Tag verschoben – die Daten wurden angepasst, die Routen werden neu berechnet.", true);
    }
  });
  $("#btnReorder").addEventListener("click", () => setReorder(!reorderMode));
}

/* ---------- Stopps auf der Karte ---------- */
const stopLayer = L.layerGroup().addTo(map);
const stopIcon = (n, stay) => L.divIcon({ className: "", html: `<div class="stmk${stay ? " stay" : ""}">${n}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
function drawStops() {
  stopLayer.clearLayers();
  if (typeof renderMapDay === "function") renderMapDay();
  const d = state?.days.find(x => x.id === selDay); if (!d || !SHOW.route) return;
  (d.via || []).forEach((v, i) => {
    if (!hasPos(v) || (v.wp && !window.mapEdit)) return;      // reine Wegpunkte nur beim Bearbeiten zeigen
    const m = L.marker([v.lat, v.lon], { icon: stopIcon(i + 1, v.stay), draggable: !!window.mapEdit, riseOnHover: true, zIndexOffset: 500 });
    m.bindTooltip(`${esc(v.name)}${v.stay ? ` · ${v.stay} min` : ""}`, { direction: "top", offset: [0, -10] });
    m.bindPopup(() => stopPopup(d, i), { minWidth: 220 });
    m.on("dragend", e => moveStop(d.id, i, e.target.getLatLng()));
    m.addTo(stopLayer);
  });
}
function stopPopup(d, i) {
  const v = d.via[i];
  if (!window.mapEdit) return `<div class="pop"><b>Stopp ${i + 1}: ${esc(v.name)}</b>
    <span>${v.stay ? `Aufenthalt ${v.stay} min` : "ohne Aufenthalt"}${v.ferry ? " · ab hier Fähre" : ""}</span>
    <span class="hint">Zum Ändern oben links auf der Karte „✎ Karte bearbeiten“ antippen.</span></div>`;
  return `<form class="pop stopform" data-stop="${esc(d.id)}:${i}">
    <b>Stopp ${i + 1}${v.ferry ? " · ab hier Fähre" : ""}</b>
    <label class="lbl">Name<input type="text" name="name" maxlength="60" value="${esc(v.name)}"></label>
    <label class="lbl">Aufenthalt (Minuten)<input type="number" name="stay" min="0" max="1440" step="5" value="${v.stay || ""}" placeholder="0"></label>
    <div class="acts"><button class="btn mini" type="submit">Speichern</button><button class="btn danger mini" type="button" data-stopdel>Löschen</button></div>
  </form>`;
}
async function moveStop(dayId, i, ll) {
  const d = state.days.find(x => x.id === dayId), v = d?.via?.[i]; if (!v) return;
  undoSnap = JSON.stringify(state.days);
  v.lat = Math.round(ll.lat * 1e4) / 1e4; v.lon = Math.round(ll.lng * 1e4) / 1e4;
  if (v.auto) { try { v.name = (await reverseName(v.lat, v.lon)) || v.name; } catch { /* egal */ } }
  save(); refresh();
}
// Klick (oder Tippen) auf die Karte: Stopp für den gewählten Tag anbieten
const addPopup = L.popup({ minWidth: 200 });
map.on("click", e => {
  if (!window.mapEdit) return;                       // nur im Bearbeiten-Modus
  const d = state?.days.find(x => x.id === selDay);
  if (!d) { addPopup.setLatLng(e.latlng).setContent(`<div class="pop"><span>Wähle zuerst in der Liste oder auf der Karte einen Tag aus, dann kannst du hier einen Stopp einlegen.</span></div>`).openOn(map); return; }
  addPopup.setLatLng(e.latlng).setContent(`<div class="pop"><b>${esc(fmtDate(d.date))}: ${esc(d.title)}</b>
    <span>Hier einen Stopp einlegen? Er wird an der Stelle der Route eingefügt, an der er den kleinsten Umweg macht.</span>
    <div class="acts"><button class="btn mini" type="button" data-addstop="${esc(d.id)}" data-ll="${e.latlng.lat},${e.latlng.lng}">Stopp hinzufügen</button></div></div>`).openOn(map);
});
async function addStop(dayId, lat, lon) {
  const list = sortedDays(), i = list.findIndex(x => x.id === dayId), d = list[i]; if (!d) return;
  undoSnap = JSON.stringify(state.days);
  const p = { name: "Stopp", lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, stay: 30, auto: true };
  const pts = dayPoints(d, i, list, d.via || []);
  const start = pts[0], end = hasPos(d) ? pts[pts.length - 1] : null;
  d.via = d.via || [];
  d.via.splice(cheapestIndex(start, d.via, p, end), 0, p);
  save(); refresh();
  try { const n = await reverseName(p.lat, p.lon); if (n) { p.name = n; save(); renderDays(); drawMarkers(); } } catch { /* egal */ }
  notice(`Stopp „${esc(p.name)}“ eingefügt (30 min Aufenthalt) – zum Ändern auf den Stopp-Punkt auf der Karte tippen.`, true);
}

/* ---------- Ereignisse ---------- */
document.addEventListener("click", e => {
  const mv = e.target.closest("[data-move]");
  if (mv) { const [id, dir] = mv.dataset.move.split(":"); moveDay(id, +dir); return; }
  const ex = e.target.closest("[data-extend]");
  if (ex) { extendNight(ex.dataset.extend); return; }
  const as = e.target.closest("[data-addstop]");
  if (as) { const [lat, lon] = as.dataset.ll.split(",").map(Number); map.closePopup(); addStop(as.dataset.addstop, lat, lon); return; }
  const sd = e.target.closest("[data-stopdel]");
  if (sd) {
    const [id, i] = sd.closest("form").dataset.stop.split(":"), d = state.days.find(x => x.id === id);
    if (!d?.via?.[+i]) return;
    undoSnap = JSON.stringify(state.days);
    const [gone] = d.via.splice(+i, 1); map.closePopup(); save(); refresh();
    notice(`Stopp „${esc(gone.name)}“ gelöscht.`, true);
  }
});
document.addEventListener("submit", e => {
  const f = e.target.closest("form.stopform"); if (!f) return;
  e.preventDefault();
  const [id, i] = f.dataset.stop.split(":"), d = state.days.find(x => x.id === id), v = d?.via?.[+i]; if (!v) return;
  v.name = f.elements.name.value.trim() || v.name; delete v.auto;
  const stay = parseInt(f.elements.stay.value, 10);
  if (stay > 0) v.stay = Math.min(1440, stay); else delete v.stay;
  map.closePopup(); save(); refresh();
});
window.addEventListener("online", () => {
  for (const k of Object.keys(routeStatus)) if (routeStatus[k] === "offline" || routeStatus[k] === "err") delete routeStatus[k];
  ensureRoutes();
});
window.addEventListener("offline", () => renderDays());
window.addEventListener("DOMContentLoaded", initSortable);

/* ---------- Karte bearbeiten: nur dann lassen sich Punkte ziehen und Stopps anlegen ---------- */
window.mapEdit = false;
const EditCtl = L.Control.extend({
  onAdd() {
    const b = L.DomUtil.create("button", "map-edit");
    b.type = "button"; b.id = "btnMapEdit"; b.setAttribute("aria-pressed", "false");
    b.textContent = "✎ Karte bearbeiten";
    L.DomEvent.disableClickPropagation(b);
    b.addEventListener("click", () => setMapEdit(!window.mapEdit));
    return b;
  }
});
new EditCtl({ position: "topleft" }).addTo(map);
function setMapEdit(on) {
  window.mapEdit = on;
  const b = document.getElementById("btnMapEdit");
  b.textContent = on ? "✓ Fertig" : "✎ Karte bearbeiten";
  b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false");
  map.closePopup(); drawMarkers();
  if (on) notice("Karte bearbeiten: Übernachtungen und Stopps lassen sich jetzt ziehen. Tag wählen und auf die Karte tippen = Stopp einlegen. Danach „✓ Fertig“ antippen.");
  else if (!$("#notice").hidden && /^Karte bearbeiten/.test($("#notice").textContent)) $("#notice").hidden = true;
}

/* ---------- iPad hochkant: Karte ODER Liste, mit Umschalter ---------- */
let mlMode = (() => { try { return localStorage.getItem("nordtour.ml") || "list"; } catch { return "list"; } })();
function setMapList(mode) {
  mlMode = mode;
  const sec = document.getElementById("v-route");
  sec.classList.toggle("ml-map", mode === "map"); sec.classList.toggle("ml-list", mode === "list");
  document.querySelectorAll("[data-ml]").forEach(b => b.setAttribute("aria-pressed", b.dataset.ml === mode ? "true" : "false"));
  try { localStorage.setItem("nordtour.ml", mode); } catch { /* egal */ }
  map.invalidateSize();                        // Größe sofort neu messen (Karte war evtl. ausgeblendet)
  if (mode === "map" && pendingFit) fitAll();
  renderMapDay();
}
// Kleine Infokarte unten auf der Karte für den gewählten Tag (nur in der Kartenansicht am iPad)
function renderMapDay() {
  const el = document.getElementById("mapDay"); if (!el) return;
  const d = state?.days.find(x => x.id === selDay);
  if (!d || mlMode !== "map" || !matchMedia("(max-width: 860px)").matches) { el.hidden = true; return; }
  const list = sortedDays(), i = list.indexOf(d), r = routes[routeKey(dayPoints(d, i, list))];
  el.innerHTML = `<b>${fmtDate(d.date)} · ${esc(d.title)}</b><span class="sum">${daySummary(d, r, routeStatus[d.id])}</span>
    <button type="button" class="btn mini" data-mltolist="${esc(d.id)}">Details in der Liste</button>`;
  el.hidden = false;
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-ml]"); if (b) { setMapList(b.dataset.ml); return; }
  const l = e.target.closest("[data-mltolist]");
  if (l) { const id = l.dataset.mltolist; expandedDays.add(id); setMapList("list"); renderDay(id);
    setTimeout(() => document.querySelector(`.day[data-day="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 50); }
  if (e.target.id === "btnExpandAll") {
    allExpanded = !allExpanded; if (!allExpanded) expandedDays.clear();
    e.target.setAttribute("aria-pressed", allExpanded); e.target.textContent = allExpanded ? "Details zuklappen" : "Alle Details";
    renderDays();
  }
});
window.addEventListener("DOMContentLoaded", () => setMapList(mlMode));
