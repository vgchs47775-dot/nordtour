/* Fährkosten abgleichen: Welche erkannten Fähren haben noch keinen Kostenposten – und welche
   Fähr-Posten passen zu keiner erkannten Fähre mehr (z. B. nach einer Routenänderung)?
   Zuordnung über die Ortsnamen in Titel bzw. Notiz des Postens. Steht eine Fähre in der Notiz
   eines anderen Postens (z. B. „Horn–Andalsvåg derzeit kostenlos“), gilt sie als erledigt.
   Preisschätzung für Norwegen grob nach Länge der Überfahrt (Stufen des staatlichen Fährtarifs,
   an bekannten Preisen dieser Route abgeglichen). Wird nach toll.js geladen. */
"use strict";

const FERRY_ZONES = [[4, 85], [8, 115], [15, 160], [25, 200], [40, 260], [Infinity, 330]];   // km → NOK (Pkw bis 6 m inkl. Fahrer)
const STOP_WORDS = new Set(["fahre", "faehre", "ferje", "ferjekai", "ferjeleie", "hurtigruten", "hurtigrutenkai", "auf", "der", "mit", "auto",
  "nur", "helgeland", "einfache", "fahrt", "passagiere", "gratis", "derzeit", "kostenlos", "und"]);
function norm(s) {
  return String(s || "").toLowerCase().replace(/ø/g, "o").replace(/[åä]/g, "a").replace(/æ/g, "ae").replace(/ö/g, "o").replace(/ü/g, "u");
}
function placeTokens(s) {
  return norm(s).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}
function ferryEstimate(f) {
  if (!f.from || !f.to || typeof inNorway !== "function" || !inNorway(f.from[0], f.from[1])) return null;
  const km = hav({ lat: f.from[0], lon: f.from[1] }, { lat: f.to[0], lon: f.to[1] });
  const nok = FERRY_ZONES.find(z => km <= z[0])[1];
  return { nok, eur: Math.round(nok * EUR_PER_NOK * 2) / 2, km };
}
const ignoredFerries = () => state.settings?.ferryIgnore || [];

function ferryCheck() {
  const list = sortedDays(), missing = [], orphans = [];
  let unknownDays = 0;
  const fc = activeCosts().filter(c => c.cat === costSys("Fähren"));
  list.forEach((d, i) => {
    const pts = dayPoints(d, i, list); if (pts.length < 2) return;
    const r = routes[routeKey(pts)];
    if (!r?.ferries) { unknownDays++; return; }
    const mine = fc.filter(c => c.dayId === d.id), used = new Set();
    const named = r.ferries.filter(f => placeTokens(f.name).length), unnamed = r.ferries.filter(f => !placeTokens(f.name).length);
    for (const f of named) {
      const tk = placeTokens(f.name);
      const byTitle = mine.find(c => !used.has(c.id) && placeTokens(c.title).some(t => tk.includes(t)));
      if (byTitle) { used.add(byTitle.id); continue; }
      // in der Notiz eines Postens dieses Tages erwähnt (z. B. „… derzeit kostenlos“)?
      if (mine.some(c => placeTokens(c.note).some(t => tk.includes(t)))) continue;
      if (ignoredFerries().includes(d.id + "|" + f.name)) continue;
      missing.push({ d, f, est: ferryEstimate(f) });
    }
    for (const f of unnamed) {
      const c = mine.find(c => !used.has(c.id));
      if (c) { used.add(c.id); continue; }
      if (ignoredFerries().includes(d.id + "|" + f.name)) continue;
      missing.push({ d, f, est: ferryEstimate(f) });
    }
    for (const c of mine) if (!used.has(c.id)) {
      // Posten, der zu keiner erkannten Fähre passt (nur melden, wenn er Ortsnamen hat)
      if (placeTokens(c.title).length && !r.ferries.some(f => placeTokens(f.name).some(t => placeTokens(c.title).includes(t)))) orphans.push({ d, c });
    }
  });
  return { missing, orphans, unknownDays };
}

function renderFerryCheck() {
  const el = document.getElementById("ferryCheck"); if (!el || !state) return;
  const { missing, orphans, unknownDays } = ferryCheck();
  if (!missing.length && !orphans.length) {
    el.innerHTML = unknownDays ? "" : `<p class="hint spaced">⛴ Alle erkannten Fähren haben einen Kostenposten.</p>`;
    return;
  }
  el.innerHTML = `<div class="panel fcheck"><h3>⛴ Fähren abgleichen</h3>
    ${missing.length ? `<p class="hint">Diese Fähren liegen auf deiner Route, haben aber noch keinen Kostenposten:</p>
    <ul class="flist">${missing.map((m, i) => `<li><span class="nm">${esc(m.f.name)}<span class="nt">${fmtDate(m.d.date)} · ${esc(m.d.title)} · ca. ${m.f.min} min Überfahrt${m.est ? ` · Schätzung ${num(m.est.nok)} NOK ≈ ${euro(m.est.eur)}` : " · kein Tarif bekannt (außerhalb Norwegens)"}</span></span>
      <span class="acts"><button type="button" class="btn mini" data-fadd="${i}">Posten anlegen${m.est ? ` (${euro(m.est.eur)})` : ""}</button><button type="button" class="btn ghost mini" data-fign="${i}" title="z. B. weil die Fähre kostenlos ist">kostenlos / ignorieren</button></span></li>`).join("")}</ul>` : ""}
    ${orphans.length ? `<p class="hint">Diese Fähr-Posten passen zu keiner Fähre auf der aktuellen Route – vielleicht hat sich die Route geändert:</p>
    <ul class="flist">${orphans.map(o => `<li><span class="nm">${esc(o.c.title)}<span class="nt">${fmtDate(o.d.date)} · ${esc(o.d.title)}${o.c.amount != null ? ` · ${euro(o.c.amount)}` : ""}</span></span></li>`).join("")}</ul>` : ""}
    <p class="hint">Schätzung nach Länge der Überfahrt (norwegischer Fährtarif, Pkw bis 6 m mit Fahrer, Mitfahrer meist gratis) – vor der Reise prüfen.</p></div>`;
  el._missing = missing;
}
document.addEventListener("click", e => {
  const a = e.target.closest("[data-fadd]"), g = e.target.closest("[data-fign]");
  if (!a && !g) return;
  const m = document.getElementById("ferryCheck")._missing?.[+(a || g).dataset[a ? "fadd" : "fign"]]; if (!m) return;
  if (a) {
    state.costs.push({ id: nid("c"), cat: costSys("Fähren"), dayId: m.d.id, title: `Fähre ${m.f.name}`, amount: m.est ? m.est.eur : null,
      note: m.est ? `grob geschätzt: ${num(m.est.nok)} NOK (Fährtarif nach Länge) – bitte prüfen` : "Preis noch offen" });
    closedCostGroups.delete(costSys("Fähren"));
  } else {
    state.settings.ferryIgnore = [...ignoredFerries(), m.d.id + "|" + m.f.name];
  }
  commit(); updateStats();
});
