/* Panoramastraße über ihren Namen finden.
   1. Liste strassen.json: benannte Straßen-Routen aus OpenStreetMap (erzeugt von werkzeuge/strassen.py) – sofort beim Tippen;
      ihr Verlauf steht vereinfacht in strassen-geo.json (wird erst beim Auswählen geladen).
   2. Sonst Suche im Netz: Ortssuche (Nominatim) nach dem Namen, dann in OpenStreetMap (Overpass) Routen und Straßen
      mit diesem Namen in der Nähe.
   Nach der Auswahl: Verlauf aus OpenStreetMap laden und mit dem Router so viele Wegpunkte setzen, bis die gefahrene
   Strecke die Straße (fast) ganz abdeckt – mit nur Anfang und Ende nähme der Router oft eine Abkürzung.
   Dazu Land, Beschreibung (Wikipedia, falls in OpenStreetMap verknüpft) und Fotos (bearbeiten.js).
   Wird nach bearbeiten.js geladen und benutzt dessen Dialog (ed, edChanged, findPhotos …). */
"use strict";

let ROADS = null;
async function roadList() {
  if (!ROADS) try { ROADS = (await (await fetch("strassen.json")).json()).roads || []; } catch { ROADS = []; }
  return ROADS;
}
const normName = s => String(s || "").toLowerCase().replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/nasjonal(e)? turistveg(en)?|nationale? touristenstrasse|panoramastrasse/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
async function roadMatches(q) {
  const words = normName(q).split(" ").filter(Boolean); if (!words.length) return [];
  return (await roadList()).filter(r => { const n = normName(r.name); return words.every(w => n.includes(w)); })
    .sort((a, b) => normName(a.name).indexOf(words[0]) - normName(b.name).indexOf(words[0]) || a.name.length - b.name.length).slice(0, 8);
}

/* ---------- Vorschläge im Dialog ---------- */
let suggTimer = null, suggRun = 0;
function showSugg(list, note = "") {
  const el = $("#edSugg"); if (!el) return;
  el.innerHTML = list.map((r, i) => `<button type="button" class="fchip" data-roadpick="${i}">🏞 ${esc(r.name)}${r.where ? ` <b>${esc(r.where)}</b>` : ""}</button>`).join("") + (note ? `<span class="hint">${esc(note)}</span>` : "");
  el.hidden = !list.length && !note; el._list = list;
}
async function liveSugg() {
  const q = $("#edName")?.value.trim() || "", run = ++suggRun;
  if (q.length < 3) { showSugg([]); return; }
  const list = await roadMatches(q); if (run !== suggRun) return;
  showSugg(list, list.length ? "" : "Nicht in der Liste – tippe auf „Strecke suchen“, dann sucht die App im Netz.");
}
// Suche im Netz: Ort finden, dann Routen/Straßen mit dem Namen in der Nähe
async function netSearch(q) {
  const hits = await nomi(`search?limit=3&countrycodes=no,se,fi,dk&q=${encodeURIComponent(q)}`);
  if (!hits.length) return [];
  const stem = normName(q).split(" ").sort((a, b) => b.length - a.length)[0] || "";
  const re = (stem.length > 7 ? stem.slice(0, stem.length - 2) : stem).replace(/[^a-z0-9]/g, "");
  if (re.length < 4) return [];
  const pat = [...re].map(c => ({ o: "[oø]", a: "[aåæä]", e: "[eéæ]" }[c] || c)).join("");
  const around = hits.slice(0, 2).map(h => `(around:30000,${(+h.lat).toFixed(4)},${(+h.lon).toFixed(4)})`);
  const j = await overpass(`[out:json][timeout:60];(${around.map(a => `relation["type"="route"]["route"="road"]["name"~"${pat}",i]${a};way["highway"]["name"~"${pat}",i]${a};`).join("")});out tags center 40;`, 40e3);
  const out = [], seen = new Set();
  for (const e of j.elements || []) {
    const name = e.tags?.name; if (!name) continue;
    const key = e.type === "relation" ? "r" + e.id : "w:" + name;
    if (seen.has(key)) continue; seen.add(key);
    out.push(e.type === "relation" ? { id: e.id, name, rel: true } : { wayName: name, near: { lat: e.center.lat, lon: e.center.lon }, pt: { lat: +hits[0].lat, lon: +hits[0].lon }, name, where: "Straße" });
  }
  return out.sort((a, b) => (b.rel ? 1 : 0) - (a.rel ? 1 : 0)).slice(0, 8);
}

/* ---------- Verlauf aus OpenStreetMap ---------- */
let ROADGEO = null;
async function roadWays(r) {
  if (r.id) {                                          // Straßen aus der Liste: Verlauf liegt in der App (strassen-geo.json)
    if (!ROADGEO) try { ROADGEO = await (await fetch("strassen-geo.json")).json(); } catch { ROADGEO = null; }
    if (ROADGEO?.[r.id]) return ROADGEO[r.id];
  }
  const q = r.id ? `[out:json][timeout:60];relation(${r.id});way(r)["highway"];out geom;`
    : `[out:json][timeout:60];way["highway"]["name"="${r.wayName.replace(/"/g, '\\"')}"](around:40000,${r.near.lat.toFixed(4)},${r.near.lon.toFixed(4)});out geom;`;
  const j = await overpass(q, 50e3), ways = (j.elements || []).filter(e => e.geometry?.length > 1);
  // Oft trägt nur ein kurzes Stück den Namen (z. B. „Valdresflyvegen“): dann die ganze Straße mit derselben Nummer rund um den Ort
  const ref = ways.find(e => e.tags?.ref)?.tags.ref, len = samplesOf(ways.map(e => e.geometry.map(g => [g.lat, g.lon]))).km;
  if (!r.id && ref && len < 15 && r.pt) {
    const k = await overpass(`[out:json][timeout:60];way["highway"]["ref"="${ref.replace(/"/g, '\\"')}"](around:25000,${r.pt.lat.toFixed(4)},${r.pt.lon.toFixed(4)});out geom;`, 50e3);
    const more = (k.elements || []).filter(e => e.geometry?.length > 1);
    if (more.length) return more.map(e => e.geometry.map(g => [g.lat, g.lon]));
  }
  return ways.map(e => e.geometry.map(g => [g.lat, g.lon]));
}
const llOf = q => ({ lat: q[0], lon: q[1] });
// Punkte entlang der Straße, etwa alle step km
function samplesOf(ways) {
  const km = ways.reduce((s, w) => s + w.slice(1).reduce((t, q, i) => t + hav(llOf(w[i]), llOf(q)), 0), 0), step = Math.max(0.4, km / 1500), out = [];
  for (const w of ways) {
    let rest = 0;
    for (let i = 1; i < w.length; i++) {
      const a = w[i - 1], b = w[i], d = hav(llOf(a), llOf(b));
      for (let t = rest; t < d; t += step) out.push([a[0] + (b[0] - a[0]) * t / d, a[1] + (b[1] - a[1]) * t / d]);
      rest = (rest - d) % step; if (rest < 0) rest += step;
    }
  }
  return { pts: out, km };
}
// Raster der gefahrenen Linie, damit „liegt auf der Strecke?“ schnell geht
function gridOf(line) {
  const g = new Map(), put = q => { const k = Math.floor(q[0] * 100) + "," + Math.floor(q[1] * 50); (g.get(k) || g.set(k, []).get(k)).push(q); };
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], n = Math.max(1, Math.ceil(hav(llOf(a), llOf(b)) / 0.2));
    for (let k = 0; k <= n; k++) put([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return g;
}
const onGrid = (g, q, tol = 0.5) => { const x = Math.floor(q[0] * 100), y = Math.floor(q[1] * 50);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const z of g.get((x + dx) + "," + (y + dy)) || []) if (hav(llOf(q), llOf(z)) <= tol) return true;
  return false; };
// Wegpunkte setzen, bis mindestens 92 % der Straße gefahren werden (höchstens 18 Punkte)
async function fitRoad(ways, progress, stop) {
  const { pts: S, km } = samplesOf(ways);
  if (S.length < 2) throw new Error("In OpenStreetMap ist für diese Straße kein Verlauf eingetragen.");
  const sub = S.filter((_, i) => i % Math.max(1, Math.floor(S.length / 300)) === 0);
  let a = sub[0], b = sub[1], best = -1;                // Anfang und Ende: die am weitesten entfernten Punkte
  for (const p of sub) for (const q of sub) { const d = hav(llOf(p), llOf(q)); if (d > best) { best = d; a = p; b = q; } }
  let way = [a, b], line = null, share = 0, r = null;
  for (let round = 0; round < 12; round++) {
    progress(`Strecke wird berechnet (${way.length} Punkte) …`);
    r = await computeRoute(way.map(llOf), { stop });
    line = r.parts.flatMap(p => p.ferry ? p.pts : decodePolyline(p.enc));
    const g = gridOf(line), miss = S.filter(q => !onGrid(g, q));
    share = 1 - miss.length / S.length;
    if (share >= 0.92 || way.length >= 18 || stop()) break;
    // der fehlende Punkt, der am weitesten von allen Wegpunkten weg liegt, kommt dazu – dort, wo er am wenigsten Umweg macht
    const far = miss.reduce((m, q) => { const d = Math.min(...way.map(w => hav(llOf(w), llOf(q)))); return d > m.d ? { d, q } : m; }, { d: -1 }).q;
    let at = 1, cost = Infinity;
    for (let i = 1; i < way.length; i++) { const c = hav(llOf(way[i - 1]), llOf(far)) + hav(llOf(far), llOf(way[i])) - hav(llOf(way[i - 1]), llOf(way[i])); if (c < cost) { cost = c; at = i; } }
    way.splice(at, 0, far);
  }
  const step = Math.max(0.3, r.km / 350), simple = [line[0]];
  for (const q of line) if (hav(llOf(simple.at(-1)), llOf(q)) >= step) simple.push(q);
  simple.push(line.at(-1));
  return { way: way.map(q => ({ lat: +q[0].toFixed(4), lon: +q[1].toFixed(4) })), line: simple.map(q => [+q[0].toFixed(4), +q[1].toFixed(4)]), km: Math.round(r.km), h: r.h, share, osmKm: km };
}
// Kurzbeschreibung aus Wikipedia (nur wenn OpenStreetMap die Straße mit Wikidata verknüpft)
async function wikiText(wd) {
  if (!wd) return "";
  try {
    const e = (await (await fetch(`https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(wd)}.json`)).json()).entities?.[wd];
    for (const lang of ["de", "en"]) {
      const t = e?.sitelinks?.[lang + "wiki"]?.title; if (!t) continue;
      const s = await (await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, "_"))}`)).json();
      if (s.extract) return s.extract.length > 600 ? s.extract.slice(0, s.extract.lastIndexOf(".", 600) + 1 || 600) : s.extract;
    }
  } catch { /* ohne Beschreibung */ }
  return "";
}
async function pickRoad(r) {
  const me = ed; if (!me?.pts) return;
  if (!navigator.onLine) { $("#edErr").textContent = "Für die Suche brauchst du Internet."; return; }
  const info = t => { if (ed === me) $("#edInfo").textContent = t; }, stop = () => ed !== me;
  $("#edErr").textContent = ""; showSugg([]); $("#edSave").disabled = true; $("#edRoadFind").disabled = true;
  if (!$("#edName").value.trim() || (!me.id && r.id)) $("#edName").value = r.name;   // Namen aus der Liste übernehmen, selbst getippte behalten
  try {
    info("Verlauf wird aus OpenStreetMap geladen …");
    const ways = await roadWays(r); if (stop()) return;
    if (!ways.length) throw new Error("In OpenStreetMap ist für diese Straße kein Verlauf eingetragen.");
    const f = await fitRoad(ways, info, stop); if (stop()) return;
    edRun++; clearTimeout(edTimer);                     // keine ältere Berechnung mehr übernehmen
    (me.hist = me.hist || []).push(me.pts.map(p => ({ ...p }))); $("#edPtUndo").disabled = false;
    me.pts = f.way; me.line = f.line; me.km = f.km; me.changed = true;
    edMap.fitBounds(L.latLngBounds(f.line), { padding: [24, 24], animate: false }); drawEd();
    info(`${r.name}: ca. ${num(f.km)} km · ${fmtShort(f.h)} · ${Math.round(f.share * 100)} % der Straße werden gefahren`);
    if (!$("#edLand").value.trim()) reverseCountry(f.way[0]).then(c => { if (ed === me && c && !$("#edLand").value.trim()) $("#edLand").value = c; });
    if (r.wd && !$("#edDesc").value.trim()) wikiText(r.wd).then(t => { if (ed === me && t && !$("#edDesc").value.trim()) $("#edDesc").value = t; });
    if (!me.imgs.length && !me.cands.length) findPhotos();
  } catch (e) {
    if (stop()) return;
    info(""); $("#edErr").textContent = e.perm ? (await findRouteError(e)).msg : /abort|overpass|fetch|network/i.test(e.message || "") ? "OpenStreetMap ist gerade überlastet. Versuche es in ein paar Minuten noch einmal." : e.message || "Die Suche hat nicht geklappt.";
  }
  if (ed === me) { $("#edSave").disabled = false; $("#edRoadFind").disabled = false; }
}
async function roadFind() {
  const q = $("#edName").value.trim(), me = ed; if (!q || !me) { $("#edErr").textContent = "Gib zuerst einen Namen ein."; return; }
  $("#edErr").textContent = "";
  let list = await roadMatches(q);
  if (!list.length) {
    if (!navigator.onLine) { $("#edErr").textContent = "Für die Suche brauchst du Internet."; return; }
    showSugg([], "Suche in OpenStreetMap …"); $("#edRoadFind").disabled = true;
    try { list = await netSearch(q); } catch { list = null; }
    if (ed !== me) return;
    $("#edRoadFind").disabled = false;
    if (!list) { showSugg([], "OpenStreetMap ist gerade nicht erreichbar. Versuche es gleich noch einmal."); return; }
  }
  if (list.length === 1) { pickRoad(list[0]); return; }
  showSugg(list, list.length ? "Welche ist es?" : "Nichts gefunden. Probiere einen anderen Namen (z. B. ohne „Nasjonal turistveg“) oder tippe Anfang und Ende auf der Karte an.");
}
document.addEventListener("input", e => { if (e.target.id === "edName" && ed?.pts && !ed.id) { clearTimeout(suggTimer); suggTimer = setTimeout(liveSugg, 200); } });
document.addEventListener("keydown", e => { if (e.target.id === "edName" && e.key === "Enter" && ed?.pts) { e.preventDefault(); roadFind(); } });
document.addEventListener("click", e => {
  if (e.target.closest("#edRoadFind")) { roadFind(); return; }
  const b = e.target.closest("[data-roadpick]"); if (b) pickRoad($("#edSugg")._list[+b.dataset.roadpick]);
});
