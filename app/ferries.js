/* Abfahrtszeiten der Fähren (Norwegen) über Entur – den offenen Fahrplandienst Norwegens.
   Die Routenberechnung speichert für jede Fähre Anfang und Ende der Überfahrt (from/to).
   Auf Knopfdruck werden die Abfahrten des Reisetags abgefragt. Gibt es für dieses Datum noch
   keinen Fahrplan (Fahrpläne erscheinen meist nur einige Monate im Voraus), wird der nächste
   gleiche Wochentag ab heute gezeigt – deutlich als Beispiel gekennzeichnet.
   Dänemark/Schweden sind bei Entur nicht enthalten. Wird nach app.js geladen. */
"use strict";

const ENTUR = "https://api.entur.io/journey-planner/v3/graphql";
const FSTORE = "nordtour.ferrydeps.v1";
let ferryDeps = {};          // Schlüssel → { at, date, sample, deps:[{t, e, from, to, op}] }
try { ferryDeps = JSON.parse(localStorage.getItem(FSTORE)) || {}; } catch { ferryDeps = {}; }
const openFerry = new Set();  // Tage, deren Abfahrten aufgeklappt sind
const busyFerry = new Set();

async function enturDepartures(f, isoDate) {
  const [Y, M, D] = isoDate.split("-").map(Number);
  const when = new Date(Y, M - 1, D, 5, 0).toISOString();
  const q = `{ trip(from:{coordinates:{latitude:${f.from[0]},longitude:${f.from[1]}}}, to:{coordinates:{latitude:${f.to[0]},longitude:${f.to[1]}}},
    dateTime:"${when}", searchWindow:1140, numTripPatterns:70, walkSpeed:1.3,
    modes:{accessMode:foot, egressMode:foot, transportModes:[{transportMode:water}]}) {
    tripPatterns { legs { mode expectedStartTime expectedEndTime fromPlace{name} toPlace{name} line{name authority{name}} } } } }`;
  const r = await fetch(ENTUR, { method: "POST", headers: { "Content-Type": "application/json", "ET-Client-Name": "privat-nordtour-reiseplaner" }, body: JSON.stringify({ query: q }) });
  if (!r.ok) throw new Error("Entur antwortet mit " + r.status);
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0]?.message || "Entur-Fehler");
  const seen = new Set(), deps = [];
  for (const p of j.data?.trip?.tripPatterns || []) for (const l of p.legs) {
    if (l.mode !== "water" || !l.expectedStartTime.startsWith(isoDate)) continue;
    const t = l.expectedStartTime.slice(11, 16); if (seen.has(t)) continue; seen.add(t);
    deps.push({ t, e: l.expectedEndTime.slice(11, 16), from: l.fromPlace.name, to: l.toPlace.name, op: l.line?.authority?.name || "" });
  }
  return deps.sort((a, b) => a.t.localeCompare(b.t));
}
const fKey = (f, date) => `${f.from.join(",")}>${f.to.join(",")}@${date}`;
function nextSameWeekday(iso) {
  const want = new Date(iso + "T12:00:00").getDay(), d = new Date(); d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  while (d.getDay() !== want) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
async function loadFerryDeps(d, r) {
  if (!navigator.onLine) { notice("Für die Abfahrtszeiten brauchst du Internet."); return; }
  busyFerry.add(d.id); renderDay(d.id);
  for (const f of r.ferries.filter(f => f.from && f.to)) {
    const k = fKey(f, d.date);
    if (ferryDeps[k] && Date.now() - ferryDeps[k].at < 864e5) continue;      // höchstens einmal am Tag neu holen
    try {
      let deps = await enturDepartures(f, d.date), date = d.date, sample = false;
      if (!deps.length) { date = nextSameWeekday(d.date); sample = true; deps = await enturDepartures(f, date); }
      ferryDeps[k] = { at: Date.now(), date, sample, deps };
    } catch (e) { ferryDeps[k] = { at: Date.now() - 864e5 + 10 * 60e3, err: e.message, deps: [] }; }   // Fehler: in 10 min erneut
  }
  try { localStorage.setItem(FSTORE, JSON.stringify(ferryDeps)); } catch { /* egal */ }
  busyFerry.delete(d.id); renderDay(d.id);
}

// Wird in app.js unter der Fahrzeile eines Tages eingesetzt
function ferryHtml(d, r) {
  const fl = (r?.ferries || []).filter(f => f.from && f.to); if (!fl.length) return "";
  const open = openFerry.has(d.id), busy = busyFerry.has(d.id);
  let h = `<span class="ferryline"><button type="button" class="btn ghost mini" data-ferrydeps="${esc(d.id)}" aria-expanded="${open}">⛴ Abfahrten ${open ? "▴" : "▾"}</button></span>`;
  if (!open) return h;
  if (busy) return h + `<span class="deps muted">Fahrpläne werden abgefragt …</span>`;
  h += `<span class="deps">` + fl.map(f => {
    const x = ferryDeps[fKey(f, d.date)];
    if (!x) return `<span class="dep"><b>${esc(f.name)}</b> <span class="muted">noch nicht abgefragt</span></span>`;
    if (x.err) return `<span class="dep"><b>${esc(f.name)}</b> <span class="muted">Fahrplan gerade nicht abrufbar (${esc(x.err)})</span></span>`;
    if (!x.deps.length) return `<span class="dep"><b>${esc(f.name)}</b> <span class="muted">kein Fahrplan bei Entur (nur Norwegen) – ca. ${f.min} min Überfahrt</span></span>`;
    const dt = new Date(x.date + "T12:00:00").toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    return `<span class="dep"><b>${esc(x.deps[0].from)} → ${esc(x.deps[0].to)}</b>${x.deps[0].op ? ` <span class="muted">· ${esc(x.deps[0].op)}</span>` : ""}
      <span class="muted">${x.sample ? `Beispiel-Fahrplan vom ${dt} – für den Reisetag gibt es noch keinen` : `Fahrplan ${dt}`} · Überfahrt ca. ${f.min} min</span>
      <span class="times">${x.deps.map(p => `<span>${p.t}</span>`).join("")}</span></span>`;
  }).join("") + `<span class="hint">Abfahrtszeiten: Entur (Norwegen). Sommerfahrpläne können abweichen – vor der Fahrt prüfen.</span></span>`;
  return h;
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-ferrydeps]"); if (!b) return;
  const id = b.dataset.ferrydeps, d = state.days.find(x => x.id === id); if (!d) return;
  if (openFerry.has(id)) { openFerry.delete(id); renderDay(id); return; }
  openFerry.add(id);
  loadFerryDeps(d, routeFor(d));
});
