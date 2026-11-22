/* Etappen teilen und zusammenlegen.
   Teilen: auf einer Etappe A → B wird eine Übernachtung N eingefügt. Der neue Tag (A → N) liegt VOR dem
   bisherigen; der bisherige Tag behält seine ID (N → B) und damit Kosten, Tagebuch und Notizen.
   Felder am neuen Tag: src = ID der ursprünglichen Etappe, sights = Ziele aus „Erleben“, die jetzt auf ihm liegen,
   stop = früherer Stopp, der zur Übernachtung wurde, auto = Schlafplatz unterwegs (kein benannter Ort).
   Panoramastraßen: Die Wegpunkte eines Tages hängen an seiner ID (extras.js). Beim Teilen werden sie deshalb fest
   in die Zwischenziele geschrieben (v.wp + v.pv) und der alte Tag bekommt split = true (panoVia gilt dann nicht mehr).
   Zusammenlegen: die Nacht eines Tages entfällt, seine Strecke kommt zum Folgetag.
   Wird nach planer.js geladen. */
"use strict";

/* ---------- Verlauf einer Etappe ---------- */
// Streckenpunkte mit Teilstück-Nummer, Kilometern und Stunden vom Start (Fähren eingerechnet)
function stageLine(d) {
  const list = sortedDays(), i = list.findIndex(x => x.id === d.id), all = dayPoints(d, i, list), r = routes[routeKey(all)];
  const used = all.map((_, k) => k).filter(k => k === 0 || hav(all[k - 1], all[k]) > 0.05 || all[k - 1].ferry);   // wie computeRoute()
  const ok = r?.parts?.length === used.length - 1, P = [];
  for (let k = 0; k < used.length - 1; k++) {
    const a = all[used[k]], b = all[used[k + 1]], part = ok ? r.parts[k] : null;
    let pts = part ? (part.ferry ? part.pts : decodePolyline(part.enc)) : [[a.lat, a.lon], [b.lat, b.lon]];
    if (pts.length < 10) {                             // grobe Linien unterteilen, damit man überall halten kann
      const fine = [];
      pts.forEach((q, j) => { if (j) { const n = Math.max(1, Math.ceil(hav({ lat: pts[j - 1][0], lon: pts[j - 1][1] }, { lat: q[0], lon: q[1] }) / 5));
        for (let m = 1; m <= n; m++) fine.push([pts[j - 1][0] + (q[0] - pts[j - 1][0]) * m / n, pts[j - 1][1] + (q[1] - pts[j - 1][1]) * m / n]); } else fine.push(q); });
      pts = fine;
    }
    for (const q of pts) P.push({ lat: q[0], lon: q[1], leg: k, manual: !!a.ferry });
  }
  P.forEach((p, j) => { p.d = j ? hav(P[j - 1], p) : 0; if (j && P[j - 1].leg === p.leg && p.manual) p.ferry = true; });
  let ferryH = 0;
  for (const f of r?.ferries || []) if (!f.manual && f.from && f.to) {
    const near = q => P.reduce((b, p, j) => { const km = hav(p, { lat: q[0], lon: q[1] }); return km < b.km ? { km, j } : b; }, { km: 1e9, j: 0 }).j;
    const a = near(f.from), b = near(f.to); if (b <= a) continue;
    const len = P.slice(a + 1, b + 1).reduce((s, p) => s + p.d, 0) || 1;
    for (let j = a + 1; j <= b; j++) { P[j].ferry = true; P[j].h = f.min / 60 * P[j].d / len; }
    ferryH += f.min / 60;
  }
  const carKm = P.reduce((s, p) => s + (p.ferry ? 0 : p.d), 0);
  const speed = r && r.h - ferryH > 0.02 ? carKm / (r.h - ferryH) : 65;
  let km = 0, h = 0;
  for (const p of P) { km += p.d; h += p.h ?? (p.ferry ? p.d / FERRY_KMH : p.d / speed); p.km = km; p.t = h; }
  // Anzeige an die echte Streckenlänge anpassen (Linie ist minimal kürzer)
  const f = r && km > 0.1 ? (r.km + r.ferryKm) / km : 1; for (const p of P) p.km *= f;
  return { P, all, used, r, km: km * f, h };
}
// Index ohne Fähre: liegt der Punkt auf einer Überfahrt, gilt der nähere Anleger
function offFerry(P, j) {
  if (!P[j].ferry && !P[j + 1]?.ferry) return j;
  let a = j, b = j;
  while (a > 0 && P[a].ferry) a--;
  while (b < P.length - 1 && (P[b].ferry || P[b + 1]?.ferry)) b++;
  return a > 0 && (j - a <= b - j || b >= P.length - 1) ? a : b;
}
const lineAt = (L, t) => { const j = L.P.findIndex(p => p.t >= t); return offFerry(L.P, j < 0 ? L.P.length - 1 : j); };
function lineNear(L, q) {
  let bj = 0, bd = 1e9; const c = Math.cos(q.lat * Math.PI / 180);
  L.P.forEach((p, j) => { const dd = (p.lat - q.lat) ** 2 + ((p.lon - q.lon) * c) ** 2; if (dd < bd) { bd = dd; bj = j; } });
  const j = offFerry(L.P, bj);
  return { j, km: hav(L.P[bj], q) };
}
function canSplit(d, r) {
  if (!hasPos(d)) return false;
  if (r) return r.km + r.ferryKm >= 5;
  const list = sortedDays(), p = dayPoints(d, list.indexOf(d), list);
  return p.length > 1 && p.slice(1).some((x, k) => hav(p[k], x) > 5);
}

/* ---------- Zwischenziele fest übernehmen ---------- */
// Alle Punkte zwischen Start und Ziel; Wegpunkte einer Panoramastraße werden als v.wp/v.pv festgeschrieben
function fixedVias(d) {
  const list = sortedDays(), own = (d.via || []), pts = dayPoints(d, list.findIndex(x => x.id === d.id), list), mid = pts.slice(1, hasPos(d) ? -1 : undefined);
  if (mid.every(v => own.includes(v))) return own.filter(hasPos);
  const out = mid.map(v => own.includes(v) ? v : { name: v.name || "Wegpunkt", lat: v.lat, lon: v.lon, ...(v.ferry ? { ferry: true } : {}), wp: true, pv: true });
  // eigene Stopps, die (fast) auf einem Wegpunkt liegen, hat mergeStops() übersprungen – sie ersetzen ihn hier
  for (const s of own) if (hasPos(s) && !out.includes(s)) {
    const k = out.findIndex(w => w.pv && hav(w, s) < 2);
    if (k >= 0) out[k] = out[k].ferry ? { ...s, ferry: true } : s;
  }
  return out;
}
// Eigene Stopps, die dabei keinen Platz gefunden haben (dicht neben einem anderen Stopp), wieder einreihen
function addLeft(d, vias, lists) {
  for (const s of d.via || []) if (hasPos(s) && !vias.some(v => v === s || hav(v, s) < 0.01)) {
    const l = lists.find(x => x.some(v => hav(v, s) < 2)) || lists[0];
    l.splice(l.findIndex(v => hav(v, s) < 2) + 1, 0, s);
  }
}
const nearLine = (pts, p, km) => p.geom.filter((_, k) => k % 3 === 0).filter(g => pts.some((q, j) => j % 4 === 0 && hav(q, { lat: g[0], lon: g[1] }) < km)).length >= 2;
const dayPanoIds = d => [...new Set([...(d.panos || []), ...PANO().filter(p => !d.split && panoVia(d) && p.days.includes(d.id) && isPlanned("pano", p.id)).map(p => p.id)])];
const journalUsed = id => { const j = state.journal?.[id]; return !!(j?.text || j?.photos?.length); };
// Kosten gehören nicht zu „Rückgängig“ der Tage – deshalb hier mitführen (app.js ruft undoAfter auf)
function moveCosts(list) {
  const old = list.map(([c]) => [c.id, c.dayId]);
  for (const [c, id] of list) c.dayId = id;
  undoAfter = { snap: undoSnap, run() { for (const [id, dayId] of old) { const c = state.costs.find(x => x.id === id); if (c) c.dayId = dayId; } } };
}

// Startort des ersten Tages, wie er bisher im Titel steht
const firstName = d => d.title?.includes(" → ") ? d.title.split(" → ")[0] : nightBase(home().name);

/* ---------- Teilen ---------- */
// sel: { lat, lon, name, j (Index auf der Linie), viaAt (Index in L.all, wenn ein Stopp zur Nacht wird), auto }
function splitStage(d, L, sel, dropId) {
  const list = sortedDays(), i = list.findIndex(x => x.id === d.id);
  undoSnap = JSON.stringify(state.days);
  const vias = fixedVias(d), cutAt = sel.viaAt != null ? sel.viaAt : L.used[L.P[sel.j].leg + 1];
  // vias entspricht L.all[1 … n-1]
  const before = vias.slice(0, cutAt - 1), after = vias.slice(sel.viaAt != null ? cutAt : cutAt - 1); let stop = sel.viaAt != null ? vias[cutAt - 1] : null;
  addLeft(d, vias, [before, after]);
  for (const l of [before, after]) for (let k = l.length - 1; k >= 0; k--)   // derselbe Ort nicht zusätzlich als Stopp
    if (!l[k].wp && !l[k].ferry && hav(l[k], sel) < 0.3) { const [v] = l.splice(k, 1); stop = stop || v; }
  const baked = vias.some(v => v.pv), from = i > 0 ? nightBase(list[i - 1].night) : firstName(d);
  const panoIds = dayPanoIds(d), mine = SIGHTS().filter(x => sightDayId(x) === d.id && (x.day === d.id || d.sights?.includes(x.id)));
  const first = L.P.slice(0, sel.j + 1), second = L.P.slice(sel.j);
  const n = { id: uid(), order: (d.order ?? i) - 0.5, date: d.date, title: `${from} → ${nightBase(sel.name)}`, night: sel.name,
    lat: +sel.lat.toFixed(4), lon: +sel.lon.toFixed(4), ferries: 0, via: before, src: d.src || d.id };
  if (sel.auto) { n.auto = true; n.sub = "Schlafplatz unterwegs – mit park4night in der Nähe suchen"; }
  if (sel.key) n.key = sel.key;
  if (stop && !stop.pv) n.stop = clone(stop);
  const firstSights = mine.filter(x => lineNear(L, x).j < sel.j).map(x => x.id);
  if (firstSights.length) n.sights = firstSights;
  if (d.sights) d.sights = d.sights.filter(id => !firstSights.includes(id));
  if (panoIds.length) {
    const of = pts => panoIds.filter(id => nearLine(pts, PANO().find(p => p.id === id) || { geom: [] }, 2));
    n.panos = of(first); d.panos = of(second);
    if (!n.panos.length) delete n.panos;
  }
  d.via = after;
  if (baked) d.split = true;
  delete d.ferryNames;
  if (!d.title?.includes(" → ")) d.title = `${nightBase(sel.name)} → ${nightBase(d.night)}`;
  state.days.push(n);
  const ids = list.map(x => x.id); ids.splice(i, 0, n.id);
  // Fährkosten zum neuen Tag, wenn die Fähre jetzt dort liegt
  const early = (L.r?.ferries || []).filter(f => f.from && lineNear0(L, f.from) < sel.j), late = (L.r?.ferries || []).filter(f => !early.includes(f));
  const moves = [];
  for (const c of state.costs || []) if (c.dayId === d.id && c.cat === costSys("Fähren") && early.length) {
    const tk = placeTokens(c.title), hit = f => placeTokens(f.name).some(t => tk.includes(t));
    if (early.some(hit) || (!late.length && !late.some(hit))) moves.push([c, n.id]);
  }
  let dropped = null;
  if (dropId) {                                        // dafür einen Ruhetag streichen
    const k = ids.indexOf(dropId); dropped = state.days.find(x => x.id === dropId);
    if (k > 0 && dropped && !journalUsed(dropId)) {
      for (const c of state.costs || []) if (c.dayId === dropId) moves.push([c, ids[k - 1]]);
      ids.splice(k, 1); state.days = state.days.filter(x => x.id !== dropId);
    } else dropped = null;
  }
  moveCosts(moves);
  renumberDays(ids);
  expandedDays.add(n.id); expandedDays.add(d.id); selDay = n.id;
  save(); refresh();
  notice(`🌙 Übernachtung ${esc(sel.name)} eingefügt. ${dropped ? `Dafür entfällt: ${esc(dropped.title)}.` : "Alle folgenden Tage sind einen Tag nach hinten gerückt."} Die Routen werden neu berechnet.`, true);
  return n;
}
const lineNear0 = (L, q) => L.P.reduce((b, p, j) => { const km = hav(p, { lat: q[0], lon: q[1] }); return km < b.km ? { km, j } : b; }, { km: 1e9, j: 0 }).j;

/* ---------- Zusammenlegen ---------- */
const isRestDay = (d, i, list) => { const p = i > 0 ? list[i - 1] : null; return !!(p && hasPos(p) && hasPos(d) && hav(p, d) < 0.05 && !(d.via || []).length); };
// opt.quiet: ohne Rückfrage, und der Ort bleibt nicht als Stopp (Ort löschen, bearbeiten.js)
function mergeNight(id, opt = {}) {
  const list = sortedDays(), i = list.findIndex(x => x.id === id), d = list[i], n = list[i + 1];
  if (!d || !n) return;
  if (journalUsed(id)) { notice(`Der Tag ${esc(fmtDate(d.date))} hat Tagebuch-Einträge. Lösche oder verschiebe sie zuerst, sonst wären sie nicht mehr zu sehen.`); return; }
  const rest = isRestDay(d, i, list), nextRest = isRestDay(n, i + 1, list);
  const keep = !opt.quiet && hasPos(d) && !d.auto && !rest && !nextRest;
  if (!opt.quiet && !confirm(rest || nextRest ? `Eine Nacht in ${nightBase(d.night)} weniger? Die folgenden Tage rücken einen Tag nach vorne.`
    : `Nicht mehr in ${nightBase(d.night)} übernachten? Die Etappe geht dann direkt weiter bis ${nightBase(n.night)}${keep ? `, ${nightBase(d.night)} bleibt als Stopp` : ""}. Die folgenden Tage rücken einen Tag nach vorne.`)) return;
  undoSnap = JSON.stringify(state.days);
  const same = d.src && (n.id === d.src || n.src === d.src), panos = [...new Set([...dayPanoIds(d), ...dayPanoIds(n)])];
  const viaD = rest ? [] : fixedVias(d), bakeN = viaD.length && panoVia(n), viaN = bakeN ? fixedVias(n) : (n.via || []);
  if (!rest) addLeft(d, [...viaD], [viaD]);
  if (bakeN) addLeft(n, [...viaN], [viaN]);
  const stop = keep ? (d.stop && d.stop.name === d.night ? d.stop : { name: nightBase(d.night), lat: d.lat, lon: d.lon, ...(d.key ? { key: d.key } : {}) }) : null;
  n.via = [...viaD, ...(stop ? [stop] : []), ...viaN];
  if (bakeN) n.split = true;
  if (nextRest && !rest) { n.title = d.title; for (const k of ["sub", "todo", "warn"]) if (d[k] && !n[k]) n[k] = d[k];
    for (const k of ["auto", "key", "src", "stop"]) if (d[k] && !n[k]) n[k] = d[k]; }
  if (d.sights?.length) n.sights = [...new Set([...(n.sights || []), ...d.sights])];
  if (same && n.id === d.src && !list.some(x => x.id !== d.id && x.src === n.id)) {
    // Teilung vollständig rückgängig: Panoramastraßen gelten wieder wie vorher
    delete n.sights;
    if (n.split) { n.via = n.via.filter(v => !v.pv); delete n.split; if (EXTRAS?.variants?.[n.id]) delete n.panos; }
    else if (panos.length && n.panos) n.panos = panos;
  } else if (panos.length && (n.split || n.panos || d.panos)) n.panos = panos;
  n.date = d.date; delete n.ferryNames;
  const moves = (state.costs || []).filter(c => c.dayId === d.id).map(c => [c, n.id]);
  state.days = state.days.filter(x => x.id !== id);
  moveCosts(moves);
  if (i === 0 && n.title?.includes(" → ")) n.title = firstName(d) + " → " + n.title.split(" → ").slice(1).join(" → ");
  renumberDays(list.filter(x => x.id !== id).map(x => x.id));
  expandedDays.add(n.id); selDay = n.id;
  save(); refresh();
  notice(`Nacht in ${esc(nightBase(d.night))} aufgelöst, die folgenden Tage sind einen Tag nach vorne gerückt.${moves.length ? ` ${moves.length} Kostenposten ${moves.length === 1 ? "gehört" : "gehören"} jetzt zum Tag ${esc(nightBase(n.night))}.` : ""}`, true);
}

/* ---------- Orte, die eine Übernachtung in der Nähe brauchen (Stufe mit „night“, einstellungen.js) ---------- */
const nearMax = () => genOptions().near;
const needsNight = o => lvNight(prioLevel(ortPrio(o.key)));
function nearestNight(o) { return sortedDays().filter(hasPos).reduce((a, d) => { const km = hav(o, d); return !a || km < a.km ? { km, d } : a; }, null); }
const nightGaps = () => state?.days?.length ? allOrte().filter(needsNight).map(o => ({ o, n: nearestNight(o) })).filter(x => x.n && x.n.km > nearMax()) : [];
function nightInfo(o) {                                // Zusatz im Reiter „Orte“
  if (!needsNight(o)) return "";
  const n = nearestNight(o); if (!n) return "";
  return n.km > nearMax() ? ` · <b class="nogap">⚠ keine Übernachtung in der Nähe</b>` : ` · 🌙 ${n.km < 1 ? "Übernachtung vor Ort" : `${esc(nightBase(n.d.night))}, ${num(n.km)} km`}`;
}
function renderNightGap() {
  const el = document.getElementById("nightGap"); if (!el || !state) return;
  if (document.activeElement?.id === "ngNear") return;   // nicht unter dem Cursor neu zeichnen
  const gaps = nightGaps(); el.hidden = !gaps.length; if (!gaps.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<summary>🌙 ${gaps.length === 1 ? "1 Ort hat" : `${gaps.length} Orte haben`} noch keine Übernachtung in der Nähe</summary>
    <ul>${gaps.map(({ o, n }) => `<li><span class="nm"><i class="pdot" style="background:var(--p-${ortPrio(o.key)})"></i>${esc(o.name)}<span class="nt">${esc(prioName(ortPrio(o.key)))} · nächste Nacht: ${esc(nightBase(n.d.night))}, ${num(n.km)} km Luftlinie</span></span>
      <span class="acts"><button type="button" class="btn mini" data-nightfor="${esc(o.key)}">Übernachtung einfügen</button><button type="button" class="btn ghost mini" data-ortmap="${esc(o.key)}">Auf der Karte</button></span></li>`).join("")}</ul>
    <p class="hint"><label>Erlaubt sind höchstens <input type="number" id="ngNear" min="1" max="100" step="1" inputmode="numeric" value="${nearMax()}"> km</label> Luftlinie. Für welche Prioritäten das gilt, steht unter <a href="#prioritaeten">Einstellungen → Prioritäten</a>.</p>`;
}
// Passende Etappe suchen und das Fenster „Zwischenübernachtung“ mit diesem Ort öffnen
function openNightFor(key) {
  const o = allOrte().find(x => x.key === key); if (!o) return;
  const list = sortedDays(); let best = null;
  list.forEach((d, i) => {
    if (!hasPos(d) || isRestDay(d, i, list)) return;
    const pts = dayPoints(d, i, list), k = pts.findIndex((v, j) => j > 0 && j < pts.length - 1 && !v.wp && !v.ferry && hav(v, o) < 0.3);
    const Ln = stageLine(d); if (Ln.P.length < 2 || Ln.km < 5) return;
    const km = k > 0 ? -1 : lineNear(Ln, o).km;        // steht der Ort schon als Stopp in der Etappe, gewinnt sie
    if (!best || km < best.km) best = { km, d, k };
  });
  if (!best) { notice("Keine passende Etappe gefunden."); return; }
  if (best.km > 150) { notice(`„${esc(o.name)}“ liegt ${num(best.km)} km neben deiner Route. Plane den Ort zuerst als Stopp ein oder erstelle eine Route aus Prioritäten.`); return; }
  openSplit(best.d.id, { lat: o.lat, lon: o.lon, name: o.name, key: o.key.startsWith("o:") ? undefined : o.key, viaAt: best.k > 0 ? best.k : undefined });
}
document.addEventListener("change", e => {
  if (e.target.id !== "ngNear") return;
  const v = Math.round(parseFloat(e.target.value)); if (!(v >= 1 && v <= 100)) { e.target.value = nearMax(); return; }
  state.settings.gen = { ...(state.settings.gen || {}), near: v };
  save(); e.target.blur(); renderNightGap(); renderOrte();
});

/* ---------- Dialog „Zwischenübernachtung“ ---------- */
let sp = null, spMap = null, spLayer = null, spNameTimer = null;
function openSplit(dayId, preset) {
  const d = state.days.find(x => x.id === dayId); if (!d) return;
  const L = stageLine(d);
  if (L.P.length < 2 || L.km < 5) { notice("Diese Etappe ist zu kurz zum Teilen."); return; }
  sp = { id: dayId, L, sel: null, dirty: false };
  $("#spStage").textContent = `${fmtDate(d.date)}: ${d.title} · ${num(L.km)} km · ${fmtShort(L.h)}${L.r ? "" : " (Route noch nicht berechnet, Werte geschätzt)"}`;
  const sl = $("#spSlider"); sl.max = L.h.toFixed(2); sl.step = 0.02;
  $("#spErr").textContent = ""; $("#spQuery").value = "";
  // Orte zur Auswahl: eigene Stopps, dann Orte und Ziele höchstens 8 km neben der Strecke
  const start = L.all[0], chips = [];
  L.all.slice(1, -1).forEach((v, k) => { if (!v.wp && !v.ferry && v.name && d.via?.includes(v)) chips.push({ name: v.name, lat: v.lat, lon: v.lon, viaAt: k + 1, key: v.key }); });
  for (const o of allOrte()) if (hav(o, start) > 5 && hav(o, d) > 5 && !chips.some(c => hav(c, o) < 2)) {
    const n = lineNear(L, o); if (n.km <= 8) chips.push({ name: o.name, lat: o.lat, lon: o.lon, prio: ortPrio(o.key), key: o.key.startsWith("o:") ? null : o.key, t: L.P[n.j].t });
  }
  for (const c of chips) c.t = c.t ?? L.P[lineNear(L, c).j].t;
  sp.chips = chips.sort((a, b) => a.t - b.t).slice(0, 24);
  $("#spChips").innerHTML = sp.chips.map((c, k) => `<button type="button" class="fchip" data-spchip="${k}" aria-pressed="false">${c.prio ? `<i class="pdot" style="background:var(--p-${c.prio})"></i>` : ""}${esc(c.name)} <b>${fmtShort(c.t)}</b></button>`).join("");
  $("#spChipsBox").hidden = !sp.chips.length;
  // Ruhetage, die dafür entfallen könnten
  const list = sortedDays(), rest = list.filter((x, k) => isRestDay(x, k, list) && !journalUsed(x.id));
  $("#spDates").innerHTML = `<option value="">Alle folgenden Tage einen Tag nach hinten</option>` + rest.map(x => `<option value="${esc(x.id)}">Dafür entfällt: ${esc(x.title)} (${fmtDate(x.date)})</option>`).join("");
  $("#splitDlg").showModal(); $("#splitDlg").scrollTop = 0;
  initSpMap();
  const b = L_bounds(L.P); spMap.invalidateSize(); spMap.fitBounds(b, { padding: [24, 24], animate: false });
  if (preset) spPick(preset); else spTime(L.h / 2);
}
const L_bounds = P => L.latLngBounds(P.map(p => [p.lat, p.lon]));
function initSpMap() {
  if (spMap) return;
  spMap = L.map("spMap", { zoomSnap: 0.5 }).setView([63, 15], 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, crossOrigin: "", attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(spMap);
  spLayer = L.layerGroup().addTo(spMap);
  spMap.on("click", e => spPick({ lat: e.latlng.lat, lon: e.latlng.lng }));
  new ResizeObserver(() => spMap.invalidateSize()).observe(document.getElementById("spMap"));
}
// Auswahl über die Fahrzeit (Schieberegler)
function spTime(t, live = false) {
  const Ln = sp.L, j = Math.min(Math.max(1, lineAt(Ln, t)), Ln.P.length - 2), p = Ln.P[j];
  sp.sel = { lat: p.lat, lon: p.lon, j, auto: true, name: null };
  spShow(live);
}
// Auswahl eines Punktes: Karte, Stopp, Ort oder Suche
function spPick(q) {
  const n = lineNear(sp.L, q);
  sp.sel = { lat: q.lat, lon: q.lon, j: Math.min(Math.max(1, n.j), sp.L.P.length - 2), off: n.km, name: q.name || null, auto: !q.name, viaAt: q.viaAt, key: q.key };
  spShow(false);
}
function spShow(live) {
  const { L: Ln, sel } = sp, p = Ln.P[sel.j], d = state.days.find(x => x.id === sp.id); if (!d) return;
  const sl = $("#spSlider"); if (document.activeElement !== sl || !live) sl.value = p.t;
  $("#spAt").textContent = `nach ca. ${fmtShort(p.t)} · ${num(p.km)} km`;
  document.querySelectorAll("[data-spchip]").forEach(b => { const c = sp.chips[+b.dataset.spchip]; b.setAttribute("aria-pressed", sel.name === c.name && hav(sel, c) < 0.1 ? "true" : "false"); });
  spLayer.clearLayers();
  const line = (a, b, color) => L.polyline(Ln.P.slice(a, b + 1).map(x => [x.lat, x.lon]), { color, weight: 5, opacity: .95, interactive: false }).addTo(spLayer);
  line(0, sel.j, COL.sel); line(sel.j, Ln.P.length - 1, COL.route);
  for (const [q, t] of [[Ln.P[0], "A"], [Ln.P[Ln.P.length - 1], "B"]]) L.marker([q.lat, q.lon], { icon: icon(t, "home"), interactive: false, keyboard: false }).addTo(spLayer);
  L.marker([sel.lat, sel.lon], { icon: icon("🌙", "sel"), interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(spLayer);
  const over = h => h > LONG_DAY ? " long" : "", rest = Ln.h - p.t, nm = sel.name || $("#spName").value.trim() || "…";
  $("#spRes").innerHTML = `<span><b>1. ${esc(nightBase(Ln.all[0].name))} → <i data-spn>${esc(nm)}</i></b> ca. ${num(p.km)} km · <span class="${over(p.t)}">${fmtShort(p.t)}</span></span>
    <span><b>2. <i data-spn>${esc(nm)}</i> → ${esc(nightBase(d.night))}</b> ca. ${num(Ln.km - p.km)} km · <span class="${over(rest)}">${fmtShort(rest)}</span></span>
    ${sel.off > 2 ? `<span class="hint">Liegt ca. ${num(sel.off)} km neben der Strecke, der Umweg kommt noch dazu.</span>` : ""}`;
  if (!live) spName();
}
// Name des Schlafplatzes: gewählter Ort – sonst das nächste Dorf (erst nach kurzer Ruhe abfragen)
function spName() {
  const sel = sp.sel; clearTimeout(spNameTimer);
  const put = t => { if (sp?.sel !== sel) return; $("#spName").value = t; document.querySelectorAll("[data-spn]").forEach(x => { x.textContent = t; }); };
  if (sel.name) { sp.dirty = false; put(sel.name); return; }
  if (sp.dirty) return;
  put("Schlafplatz unterwegs");
  if (!navigator.onLine) return;
  spNameTimer = setTimeout(async () => {
    try { const v = await villageName(sel.lat.toFixed(4), sel.lon.toFixed(4)); if (!sp?.dirty && v !== "unbekannt") put(`bei ${v}`); } catch { /* Name bleibt allgemein */ }
  }, 700);
}
window.addEventListener("DOMContentLoaded", () => {
  appReady.then(() => { renderNightGap(); renderOrte(); });
  const dlg = $("#splitDlg"), shut = () => { clearTimeout(spNameTimer); dlg.close(); };
  $("#spClose").addEventListener("click", shut);
  dlg.addEventListener("close", () => { if (!dlg.open) { clearTimeout(spNameTimer); sp = null; } });
  $("#spSlider").addEventListener("input", e => spTime(parseFloat(e.target.value), true));
  $("#spSlider").addEventListener("change", e => spTime(parseFloat(e.target.value)));
  dlg.addEventListener("click", async e => {
    const st = e.target.closest("[data-spstep]"), ch = e.target.closest("[data-spchip]");
    if (st) {
      const v = st.dataset.spstep, by = parseFloat(v); if (v === "mid") { spTime(sp.L.h / 2); return; }
      const j0 = sp.sel.j; let t = sp.L.P[j0].t;
      do { t += by; } while (t > 0 && t < sp.L.h && lineAt(sp.L, t) === j0);   // über eine Fähre hinweg
      spTime(t); return;
    }
    if (ch) { spPick(sp.chips[+ch.dataset.spchip]); return; }
    if (e.target.id === "spSearch") {
      const q = $("#spQuery").value.trim(), err = $("#spErr"); err.textContent = ""; if (!q) return;
      e.target.disabled = true;
      try {
        const g = await geocode(q); if (!sp) return;
        const n = lineNear(sp.L, g);
        if (n.km > 150) throw new Error(`„${g.label}“ liegt ${num(n.km)} km von dieser Etappe entfernt. Gib den Ort genauer an, z. B. mit Land.`);
        spPick({ ...g, name: g.label || q });
        spMap.fitBounds(L_bounds([...sp.L.P, g]), { padding: [24, 24], animate: false });
      } catch (x) { err.textContent = x.message; }
      finally { e.target.disabled = false; }
    }
  });
  $("#spQuery").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("#spSearch").click(); } });
  $("#spName").addEventListener("input", e => { sp.dirty = true; document.querySelectorAll("[data-spn]").forEach(x => { x.textContent = e.target.value || "…"; }); });
  $("#spForm").addEventListener("submit", e => {
    e.preventDefault();
    const d = state.days.find(x => x.id === sp?.id); if (!d) { shut(); return; }
    const name = $("#spName").value.trim(); if (!name) { $("#spErr").textContent = "Gib der Übernachtung einen Namen."; return; }
    // Hat sich die Etappe inzwischen geändert (z. B. Abgleich mit anderem Gerät), neu öffnen
    const now = stageLine(d);
    if (routeKey(now.all) !== routeKey(sp.L.all)) { $("#spErr").textContent = "Die Etappe hat sich gerade geändert. Schließe das Fenster und öffne es neu."; return; }
    const sel = { ...sp.sel, name }, L0 = sp.L, drop = $("#spDates").value || null;
    shut(); splitStage(d, L0, sel, drop);
  });
});
document.addEventListener("click", e => {
  const s = e.target.closest("[data-split]"); if (s) { openSplit(s.dataset.split); return; }
  const m = e.target.closest("[data-mergenight]"); if (m) { mergeNight(m.dataset.mergenight); return; }
  const nf = e.target.closest("[data-nightfor]"); if (nf) { openNightFor(nf.dataset.nightfor); return; }
  const at = e.target.closest("[data-nightat]");
  if (at) { const [lat, lon] = at.dataset.ll.split(",").map(Number); map.closePopup(); openSplit(at.dataset.nightat, { lat, lon }); return; }
  const sv = e.target.closest("[data-nightstop]");
  if (sv) {
    const [id, i] = sv.dataset.nightstop.split(":"), d = state.days.find(x => x.id === id), v = d?.via?.[+i]; if (!v) return;
    map.closePopup();
    const list = sortedDays(), k = dayPoints(d, list.indexOf(d), list).indexOf(v);
    openSplit(id, { lat: v.lat, lon: v.lon, name: v.name, key: v.key, viaAt: k > 0 && !v.ferry ? k : undefined });
  }
});
