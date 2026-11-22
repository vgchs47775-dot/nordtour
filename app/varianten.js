/* Mehrere Routen speichern und auswählen.
   Die gewählte Route liegt wie immer in state.days (plus settings.panorama_geplant / sights_geplant).
   state.routeList = [{ id, name, base?, data?, keys?, track?, info? }], state.routeId = gewählte Route.
   Nur NICHT gewählte Routen haben „data“ (ihre Tage und Auswahl). Beim Wechsel wird der aktuelle Stand
   in den Eintrag der bisherigen Route zurückgeschrieben. Die Grundroute (base) dient planer.js als
   Reihenfolge-Vorlage und kann nicht gelöscht werden. Wird nach prio.js geladen. */
"use strict";

const clone = x => JSON.parse(JSON.stringify(x));
const routeEntry = id => state.routeList?.find(r => r.id === id);
// Aus normalizeState(): beim ersten Mal die vorhandene Route als Grundroute eintragen
function normalizeRouteList(s) {
  if (Array.isArray(s.routeList) && s.routeList.length && s.routeId) return false;
  s.routeList = [{ id: "base", name: "Bisherige Route", base: true }]; s.routeId = "base";
  return true;
}
function currentRouteKeys() { return sortedDays().map((d, i, l) => routeKey(dayPoints(d, i, l))); }
// Aktuellen Stand in den Eintrag der gewählten Route schreiben
function snapshotRoute() {
  const e = routeEntry(state.routeId), t = routeTotals(); if (!e) return;
  e.data = { days: clone(state.days), panorama_geplant: [...plannedList("pano")], sights_geplant: [...plannedList("sights")], ferryIgnore: [...(state.settings?.ferryIgnore || [])] };
  e.keys = currentRouteKeys();
  e.info = { n: t.n, km: Math.round(t.km), h: Math.round(t.h) };
  // Reihenfolge-Vorlage für planer.js – nur aus fertig berechneten Etappen, sonst die bisherige behalten
  if (e.base && (t.live === t.n || !e.track)) e.track = buildTrack();
}
function loadRouteData(data) {
  state.days = clone(data.days);
  state.settings.panorama_geplant = [...(data.panorama_geplant || [])];
  state.settings.sights_geplant = [...(data.sights_geplant || [])];
  state.settings.ferryIgnore = [...(data.ferryIgnore || [])];
}
async function afterRouteChange(msg) {
  undoSnap = null; selDay = null; editingDay = null; allExpanded = false; expandedDays.clear();
  osmDayOn.fuel.clear(); osmDayOn.water.clear(); routeStatus = {};
  map.closePopup(); save();
  // Was andere Geräte für diese Route schon berechnet haben, holen – statt neu zu rechnen
  if (typeof sb !== "undefined" && sb && syncUser && navigator.onLine) { cacheLoadedFor = null; await Promise.race([loadCloudCache(), sleep(6000)]).catch(() => {}); }
  refresh(); fitAll(); notice(msg);
}
async function switchRoute(id) {
  const e = routeEntry(id); if (!e || id === state.routeId || !e.data) { renderRouteBar(); return; }
  if (editingDay && !confirm("Ein Tag wird gerade bearbeitet. Ohne Speichern zur anderen Route wechseln?")) { renderRouteBar(); return; }
  snapshotRoute();
  loadRouteData(e.data); delete e.data; state.routeId = id;
  await afterRouteChange(`Route „${esc(e.name)}“ geladen.`);
}
// Neue Route anlegen und auswählen (data = Tage und Auswahl); die bisherige bleibt gespeichert
async function addRoute(name, data, extra = {}) {
  snapshotRoute();
  const e = { id: nid("r"), name, at: new Date().toISOString(), ...extra };
  state.routeList.push(e); state.routeId = e.id; loadRouteData(data);
  await afterRouteChange(`Route „${esc(name)}“ gespeichert und ausgewählt. Die vorherige findest du in der Auswahl.`);
}
async function deleteRoute() {
  const e = routeEntry(state.routeId), base = state.routeList.find(r => r.base);
  if (!e || e.base) return;
  if (!confirm(`Route „${e.name}“ löschen? Danach wird „${base.name}“ geladen. Kosten und Tagebuch bleiben erhalten.`)) return;
  state.routeList = state.routeList.filter(r => r.id !== e.id);
  loadRouteData(base.data); delete base.data; state.routeId = base.id;
  await afterRouteChange(`Route „${esc(e.name)}“ gelöscht, „${esc(base.name)}“ geladen.`);
}

/* ---------- Was gehört zu welcher Route? ---------- */
function otherRouteDays() { return (state.routeList || []).filter(r => r.data).flatMap(r => r.data.days); }
// Kostenposten, die an Tagen einer anderen Route hängen, zählen für diese Route nicht
function activeCosts() {
  const here = new Set(state.days.map(d => d.id)), there = new Set(otherRouteDays().map(d => d.id));
  return state.costs.filter(c => !c.dayId || here.has(c.dayId) || !there.has(c.dayId));
}

/* ---------- Anzeige ---------- */
function renderRouteBar() {
  const sel = document.getElementById("routeSel"); if (!sel || !state?.routeList) return;
  const t = routeTotals();
  sel.innerHTML = state.routeList.map(r => {
    const i = r.id === state.routeId ? { n: t.n, km: Math.round(t.km) } : r.info;
    return `<option value="${esc(r.id)}"${r.id === state.routeId ? " selected" : ""}>${esc(r.name)}${i ? ` (${i.n} Tage, ${num(i.km)} km)` : ""}</option>`;
  }).join("");
  document.getElementById("btnRouteDel").hidden = !!routeEntry(state.routeId)?.base;
}
let routeDlgMode = null;
function openRouteDlg(mode) {
  routeDlgMode = mode;
  const e = routeEntry(state.routeId);
  $("#routeDlgTitle").textContent = mode === "copy" ? "Route speichern unter" : "Route umbenennen";
  $("#routeDlgHint").textContent = mode === "copy" ? "Speichert den jetzigen Stand als eigene Route und arbeitet darin weiter. Die bisherige Route bleibt unverändert." : "";
  $("#routeDlgName").value = mode === "copy" ? `${e.name} – Kopie` : e.name;
  $("#routeDlg").showModal(); $("#routeDlgName").select();
}
window.addEventListener("DOMContentLoaded", () => {
  $("#routeSel").addEventListener("change", e => switchRoute(e.target.value));
  $("#btnRouteCopy").addEventListener("click", () => openRouteDlg("copy"));
  $("#btnRouteRename").addEventListener("click", () => openRouteDlg("rename"));
  $("#btnRouteDel").addEventListener("click", deleteRoute);
  $("#routeDlgCancel").addEventListener("click", () => $("#routeDlg").close());
  $("#routeDlgForm").addEventListener("submit", async e => {
    e.preventDefault();
    const name = $("#routeDlgName").value.trim(); if (!name) return;
    $("#routeDlg").close();
    if (routeDlgMode === "rename") { routeEntry(state.routeId).name = name; save(); renderRouteBar(); return; }
    await addRoute(name, { days: state.days, panorama_geplant: plannedList("pano"), sights_geplant: plannedList("sights"), ferryIgnore: state.settings?.ferryIgnore });
  });
});
