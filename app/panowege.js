/* Eingeplante Panoramastraßen wirklich fahren.
   Jede Straße hat in extras.json geprüfte Wegpunkte („way“), mit denen der Router sie in beiden Richtungen (fast) ganz
   fährt – mit weniger Punkten nimmt er Abkürzungen (z. B. Tunnel). planer.js nimmt sie beim Erstellen einer Route.
   Hier: wie viel einer Straße die aktuelle Route fährt (panoShare), Hinweis über der Tagesliste (#panoGap) und
   Einbauen bzw. Entfernen der Wegpunkte in bestehenden Routen (completePano, removePano; Kennzeichen v.pano).
   Wird nach etappen.js geladen. */
"use strict";

const PANO_MIN = 0.7;          // so viel einer eingeplanten Straße soll mindestens gefahren werden
const PANO_TOL = 0.6;          // Linien sind vereinfacht: Abstand in km, der noch als „auf der Straße“ gilt
const panoWp = p => `${p.name} (Wegpunkt)`;
const panoWay = p => p.way?.length > 1 ? p.way : [p.geom[0], p.geom[p.geom.length - 1]];

/* ---------- Wie viel wird gefahren? ---------- */
// Linie → Zellen von etwa 1 km mit Punkten alle 0,2 km; nur in der Nähe der Panoramastraßen
let panoBox = null;
function lineCells(lines) {
  panoBox = panoBox || PANO().map(p => [Math.min(...p.geom.map(q => q[0])) - .02, Math.max(...p.geom.map(q => q[0])) + .02, Math.min(...p.geom.map(q => q[1])) - .04, Math.max(...p.geom.map(q => q[1])) + .04]);
  const inBox = (la, lo) => panoBox.some(b => la > b[0] && la < b[1] && lo > b[2] && lo < b[3]), cells = new Map();
  for (const l of lines) for (let i = 1; i < l.length; i++) {
    const a = l[i - 1], b = l[i];
    if (!inBox(a[0], a[1]) && !inBox(b[0], b[1])) continue;
    const n = Math.max(1, Math.ceil(hav({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) / 0.2));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const la = a[0] + (b[0] - a[0]) * k / n, lo = a[1] + (b[1] - a[1]) * k / n, key = Math.floor(la * 100) + "," + Math.floor(lo * 50);
      const c = cells.get(key); if (c) c.push([la, lo]); else cells.set(key, [[la, lo]]);
    }
  }
  return cells;
}
// Anteil der Straße (0…1), der auf mindestens einer der Linien liegt
function coverOf(p, cellMaps) {
  let hit = 0, all = 0;
  for (let i = 1; i < p.geom.length; i++) {
    const a = p.geom[i - 1], b = p.geom[i], km = hav({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }), n = Math.max(1, Math.ceil(km / 0.5));
    for (let k = 0; k < n; k++) {
      const la = a[0] + (b[0] - a[0]) * (k + .5) / n, lo = a[1] + (b[1] - a[1]) * (k + .5) / n, x = Math.floor(la * 100), y = Math.floor(lo * 50);
      let ok = false;
      for (const m of cellMaps) { for (let dx = -1; dx <= 1 && !ok; dx++) for (let dy = -1; dy <= 1 && !ok; dy++)
        ok = !!m.get((x + dx) + "," + (y + dy))?.some(q => hav({ lat: la, lon: lo }, { lat: q[0], lon: q[1] }) <= PANO_TOL);
        if (ok) break; }
      all += km / n; if (ok) hit += km / n;
    }
  }
  return all ? hit / all : 0;
}
const dayCells = new Map(), shareMemo = new Map();
// Anteil in der aktuellen Route; null, solange noch Etappen berechnet werden
function panoShare(p) {
  const list = sortedDays(), keys = [];
  for (let i = 0; i < list.length; i++) {
    const pts = dayPoints(list[i], i, list); if (pts.length < 2) continue;
    const k = routeKey(pts); if (!routes[k]) return null;
    keys.push(k);
  }
  const sig = keys.join("|"), old = shareMemo.get(p.id); if (old?.sig === sig) return old.v;
  for (const k of [...dayCells.keys()]) if (!keys.includes(k)) dayCells.delete(k);
  const maps = keys.map(k => {
    if (!dayCells.has(k)) dayCells.set(k, lineCells(routes[k].parts.filter(x => !x.ferry).map(x => decodePolyline(x.enc))));
    return dayCells.get(k);
  }).filter(m => m.size);
  const v = coverOf(p, maps); shareMemo.set(p.id, { sig, v }); return v;
}
const panoGaps = () => EXTRAS && state?.days?.length ? PANO().filter(p => isPlanned("pano", p.id)).map(p => ({ p, v: panoShare(p) })).filter(x => x.v != null && x.v < PANO_MIN) : [];
const pct = v => Math.round(v * 100) + " %";
function renderPanoGap() {
  const el = document.getElementById("panoGap"); if (!el || !state) return;
  const gaps = panoGaps(); el.hidden = !gaps.length; if (!gaps.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<summary>🏞 ${gaps.length === 1 ? "1 eingeplante Panoramastraße wird" : `${gaps.length} eingeplante Panoramastraßen werden`} nur zum Teil gefahren</summary>
    <ul>${gaps.map(({ p, v }) => `<li><span class="nm">${esc(p.name)}<span class="nt">${v < .02 ? "liegt nicht auf der Route" : `nur ${pct(v)} der Strecke`} · ca. ${num(p.km)} km lang</span></span>
      <span class="acts"><button type="button" class="btn mini" data-panofull="${esc(p.id)}">Ganz fahren</button><button type="button" class="btn ghost mini" data-showmap="pano:${esc(p.id)}">Auf der Karte</button></span></li>`).join("")}</ul>`;
}

/* ---------- Wegpunkte einbauen und entfernen ---------- */
const distGeom = (p, q) => p.geom.reduce((m, g) => Math.min(m, hav(q, { lat: g[0], lon: g[1] })), 1e9);
const isPanoPoint = (p, v) => !!v.wp && !v.anchor && !v.ferry && (v.pano === p.id || (!v.pano && (v.name === panoWp(p) || (v.pv && v.name === "Wegpunkt" && distGeom(p, v) < 0.3))));
// Zwischenziele eines Tages, wie sie gefahren werden, ohne die Punkte dieser Straße
function panoBare(d, p) {
  const all = fixedVias(d), vias = all.filter(v => !isPanoPoint(p, v));
  return { vias, baked: all.some(v => v.pv), changed: vias.length !== all.length };
}
// Zwei Punktfolgen so mischen, dass beide ihre Reihenfolge behalten und der Weg am kürzesten ist
function mergePoints(S, W, far) {
  const n = S.length, m = W.length, INF = 1e12, id = (i, j, t) => (i * (n + 1) + j) * 2 + t;
  const cost = new Float64Array((m + 1) * (n + 1) * 2).fill(INF), from = new Int32Array(cost.length).fill(-1);
  cost[id(0, 1, 0)] = 0;                               // t = 0: zuletzt S[j-1], t = 1: zuletzt W[i-1]
  for (let j = 1; j <= n; j++) for (let i = 0; i <= m; i++) for (const t of [0, 1]) {
    const c = cost[id(i, j, t)]; if (c >= INF) continue;
    const last = t ? W[i - 1] : S[j - 1], put = (k, v) => { if (v < cost[k]) { cost[k] = v; from[k] = id(i, j, t); } };
    if (i < m && j < n && !S[j - 1].ferry) put(id(i + 1, j, 1), c + hav(last, W[i]));
    if (j < n) put(id(i, j + 1, 0), c + hav(last, S[j]) + (i > 0 && i < m && far[j] ? 200 : 0));
  }
  // rückwärts auslesen: vor welchem S-Punkt steht jeder Wegpunkt?
  let k = id(m, n, 0); const at = [];
  if (cost[k] >= INF) return null;
  const total = cost[k];
  while (k >= 0) { const t = k % 2, r = (k - t) / 2, i = Math.floor(r / (n + 1)), j = r % (n + 1); if (t) at[i - 1] = j; k = from[k]; }
  return { total, at };
}
// Baut die Straße ganz in die aktuelle Route ein; liefert den Umweg (Luftlinie) oder null
function completePano(id, undoable = true) {
  const p = PANO().find(x => x.id === id), list = sortedDays(); if (!p || !list.length) return null;
  const S = [{ ...dayPoints(list[0], 0, list)[0], i: 0 }], bare = list.map(d => panoBare(d, p));
  list.forEach((d, i) => {
    const rest = isRestDay(d, i, list);
    bare[i].vias.forEach((v, k) => S.push({ lat: v.lat, lon: v.lon, ferry: v.ferry, wp: v.wp, i, k }));
    if (hasPos(d)) S.push({ lat: d.lat, lon: d.lon, i, night: true, rest });
  });
  let base = 0; for (let j = 1; j < S.length; j++) base += hav(S[j - 1], S[j]);
  const far = S.map(q => q.wp || distGeom(p, q) > 8), way = panoWay(p).map(q => ({ lat: q[0], lon: q[1] }));
  const a = mergePoints(S, way, far), b = mergePoints(S, [...way].reverse(), far), best = !b || (a && a.total <= b.total) ? a : b;
  if (!best) return null;
  const pts = best === a ? way : [...way].reverse(), extra = best.total - base;
  if (extra > p.km * 2 + 150 && !confirm(`„${p.name}“ liegt weit neben dieser Route (Umweg mindestens ${num(extra)} km). Trotzdem einbauen?`)) return null;
  if (undoable) undoSnap = JSON.stringify(state.days);
  list.forEach((d, i) => {
    const mine = pts.map((q, k) => ({ q, s: S[best.at[k]] })).filter(x => x.s?.i === i);      // S[at] = der Punkt danach
    if (!mine.length && !bare[i].changed) return;
    const out = [], put = test => { for (const x of mine) if (test(x.s)) out.push({ name: panoWp(p), lat: x.q.lat, lon: x.q.lon, wp: true, pano: p.id }); };
    bare[i].vias.forEach((v, k) => { put(s => !s.night && s.k === k); out.push(v); });
    put(s => s.night);
    const ids = new Set(dayPanoIds(d)); mine.length ? ids.add(p.id) : ids.delete(p.id);
    addLeft({ via: (d.via || []).filter(v => !isPanoPoint(p, v)) }, [...out], [out]);          // eigene Stopps nie verlieren
    if (panoVia(d)) d.split = true;
    d.via = out;
    if (ids.size) d.panos = [...ids]; else delete d.panos;
    delete d.ferryNames;
  });
  save(); refresh();
  return Math.max(0, extra);
}
// Straße wieder herausnehmen (nur eigens eingebaute Wegpunkte)
function removePano(id) {
  const p = PANO().find(x => x.id === id); if (!p) return false;
  let hit = false;
  for (const d of state.days) {
    const via = (d.via || []).filter(v => !isPanoPoint(p, v));
    if (via.length === (d.via || []).length && !d.panos?.includes(id)) continue;
    hit = true; d.via = via; delete d.ferryNames;
    if (d.panos) { d.panos = d.panos.filter(x => x !== id); if (!d.panos.length) delete d.panos; }
  }
  return hit;
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-panofull]"); if (!b) return;
  const p = PANO().find(x => x.id === b.dataset.panofull), km = completePano(b.dataset.panofull);
  if (km != null) notice(`🏞 ${esc(p.name)} ist jetzt ganz in der Route. Die Etappen werden neu berechnet, einzelne Tage können länger werden.`, true);
});
window.addEventListener("DOMContentLoaded", () => appReady.then(renderPanoGap));
