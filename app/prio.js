/* Prioritäten für Panoramastraßen und Orte, mit Farben auf der Karte.
   Gespeichert wird in state.settings.pano_prio = { <Straßen-ID>: Stufe } und
   state.settings.ort_prio = { <Schlüssel>: Stufe }; eigene Orte stehen in state.places.
   Schlüssel eines Ortes: "o:<Name>" (Übernachtung oder Stopp – gleicher Name = gleicher Ort),
   "s:<ID>" (Ziel aus „Erleben“), "p:<ID>" (eigener Ort).
   Die Stufen selbst (Name, Farbe, Regel) stehen in einstellungen.js; gespeichert wird ihre ID.
   Nochmaliges Antippen einer Stufe nimmt sie wieder weg. Wird nach lists.js geladen.
   Zwei Personen: Person 1 wie oben, Person 2 in pano_prio2 / ort_prio2 / places[].prio2. Wer auf diesem Gerät
   priorisiert, steht in localStorage „nordtour.who“. Namen in settings.persons, Zusammenführung in settings.prioMix:
   max = die wichtigere Stufe zählt (Vorgabe), min = die weniger wichtige, mid = die Mitte. Hat nur eine Person etwas
   gesetzt, zählt ihre Stufe. panoPrio()/ortPrio() liefern immer das Ergebnis für beide. */
"use strict";

// Farben für Karte (Leaflet) und Seite (CSS-Variablen --p-<ID>, --pi-<ID> = Schrift darauf)
const prioColor = p => { const l = prioLevel(p); return l ? themeColor(l.color) : null; };
function applyPrioVars() {
  const st = document.documentElement.style;
  for (const l of prioLevels()) { const c = themeColor(l.color); st.setProperty("--p-" + l.id, c); st.setProperty("--pi-" + l.id, inkOn(c)); }
}
applyPrioVars();
// Texte und Auswahlfelder, in denen die Stufen aufgezählt werden
function renderPrioTexts() {
  const leg = kind => prioLevels(kind).map(l => `<span class="plg"><i class="pdot" style="background:var(--p-${l.id})"></i>${esc(l.name)}</span>`).join(" ");
  $("#prioLegend").innerHTML = prioLevels().map(l => `<span class="pp" style="--pc:var(--p-${l.id})">${esc(l.name)}</span>`).join("");
  $("#panoLegend").innerHTML = leg("pano"); $("#ortLegend").innerHTML = leg("ort");
  const s = $("#oPrio"), sig = JSON.stringify(prioLevels("ort").map(l => [l.id, l.name])), cur = s.value;
  renderWho();
  if (s._sig !== sig) { s._sig = sig; s.innerHTML = `<option value="">ohne</option>` + prioLevels("ort").map(l => `<option value="${l.id}"${l.id === cur ? " selected" : ""}>${esc(l.name)}</option>`).join(""); }
}

// Wer priorisiert gerade? (Umschalter in den Reitern Orte und Panoramastraßen) und Einstellungen dazu
function renderWho() {
  const n = persons(), h = `<span class="lbl">Priorisieren als</span><span class="seg">${n.map((x, i) => `<button type="button" data-who="${i}" aria-pressed="${prioWho === i}">${esc(x)}</button>`).join("")}</span>`;
  for (const id of ["whoPano", "whoOrt"]) { const el = document.getElementById(id); if (el) el.innerHTML = h; }
  const box = document.getElementById("cfgPersons"); if (!box || box.contains(document.activeElement)) return;
  const mix = state?.settings?.prioMix || "max";
  box.innerHTML = `<h3>Zwei Personen</h3><p class="hint">Jede Person setzt ihre eigenen Prioritäten für Orte und Panoramastraßen (Umschalter „Priorisieren als“ in den Reitern). Karte, Filter und „Route aus Prioritäten“ benutzen das gemeinsame Ergebnis.</p>
    <div class="two"><label class="lbl">Person 1<input type="text" maxlength="30" data-person="0" value="${esc(n[0])}"></label><label class="lbl">Person 2<input type="text" maxlength="30" data-person="1" value="${esc(n[1])}"></label></div>
    <label class="lbl">Wenn ihr verschieden priorisiert<select data-priomix>${[["max", "zählt die wichtigere Stufe"], ["min", "zählt die weniger wichtige Stufe"], ["mid", "zählt die Mitte (bei Gleichstand die wichtigere)"]].map(([v, l]) => `<option value="${v}"${v === mix ? " selected" : ""}>${l}</option>`).join("")}</select></label>
    <p class="hint">Hat nur eine Person etwas gesetzt, zählt ihre Stufe.</p>`;
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-who]"); if (!b) return;
  prioWho = +b.dataset.who; try { localStorage.setItem("nordtour.who", String(prioWho)); } catch { /* egal */ }
  renderWho(); redrawPrio();
});
document.addEventListener("change", e => {
  const p = e.target.closest("[data-person]"), m = e.target.closest("[data-priomix]");
  if (p) { const n = [...persons()]; n[+p.dataset.person] = p.value.trim() || `Person ${+p.dataset.person + 1}`; state.settings.persons = n; save(); p.blur(); renderWho(); redrawPrio(); }
  if (m) { state.settings.prioMix = m.value; save(); m.blur(); redrawPrio(); }
});

// Stufen, die es nicht (mehr) gibt oder die dort nicht gelten, zählen wie „ohne“
const validPrio = (kind, p) => p && prioLevel(p)?.[kind] ? p : null;
const PRIO_F = { pano: ["pano_prio", "pano_prio2"], ort: ["ort_prio", "ort_prio2"] };
const persons = () => { const n = state?.settings?.persons || []; return [n[0] || "Person 1", n[1] || "Person 2"]; };
let prioWho = (() => { try { return localStorage.getItem("nordtour.who") === "1" ? 1 : 0; } catch { return 0; } })();
// Stufe einer Person (0/1) – ohne Zusammenführung
function prioOf(kind, key, who) {
  if (kind === "ort" && key.startsWith("p:")) return validPrio("ort", state?.places?.find(p => "p:" + p.id === key)?.[who ? "prio2" : "prio"]);
  return validPrio(kind, state?.settings?.[PRIO_F[kind][who]]?.[key]);
}
function mixPrio(kind, a, b) {
  if (!a || !b || a === b) return a || b;
  const L = prioLevels(kind), i = L.findIndex(l => l.id === a), j = L.findIndex(l => l.id === b), mode = state?.settings?.prioMix || "max";
  return L[mode === "min" ? Math.max(i, j) : mode === "mid" ? Math.floor((i + j) / 2) : Math.min(i, j)].id;
}
const panoPrio = id => mixPrio("pano", prioOf("pano", id, 0), prioOf("pano", id, 1));
const ortSlug = name => nightBase(name).trim().toLowerCase();
const ortPrio = key => mixPrio("ort", prioOf("ort", key, 0), prioOf("ort", key, 1));
function setPrio(kind, key, val) {
  const old = prioOf(kind, key, prioWho), next = old === val ? null : val;
  state.settings = state.settings || {};
  if (kind === "ort" && key.startsWith("p:")) {
    const p = state.places?.find(p => "p:" + p.id === key), k = prioWho ? "prio2" : "prio"; if (!p) return;
    if (next) p[k] = next; else delete p[k];
  } else {
    const f = PRIO_F[kind][prioWho], m = { ...(state.settings[f] || {}) };
    if (next) m[key] = next; else delete m[key];
    state.settings[f] = m;
  }
  save(); redrawPrio();
}
// Nur neu zeichnen, was von Prioritäten abhängt (Routen bleiben unberührt); ein offenes Popup bleibt offen
function redrawPrio() {
  const pop = document.querySelector(".leaflet-popup-content [data-pop]")?.dataset.pop, ll = map._popup?.getLatLng?.();
  renderPano(); renderSights(); renderOrte(); if (typeof renderNightGap === "function") renderNightGap(); drawMarkers(); drawExtras(); drawOrte();
  if (!pop) return;
  const [k, id] = [pop.slice(0, pop.indexOf("|")), pop.slice(pop.indexOf("|") + 1)];
  if (k === "pano" && ll) panoLines[id]?.openPopup(ll);
  else if (k === "sight") sightMarkers[id]?.openPopup();
  else if (k === "ort") ortMarkers[id]?.openPopup();
}
function prioButtons(kind, key, name) {
  const cur = prioOf(kind, key, prioWho), other = prioOf(kind, key, 1 - prioWho), names = persons();
  return `<span class="prioseg" role="group" aria-label="Priorität von ${esc(names[prioWho])} für ${esc(name)}">` + prioLevels(kind).map(({ id: p, name: label }) =>
    `<button type="button" class="pb" style="--pbc:var(--p-${p});--pbi:var(--pi-${p})" data-prioset="${kind}|${esc(key)}|${p}" aria-pressed="${cur === p}">${esc(label)}</button>`).join("") +
    `<span class="prioother" title="Priorität der anderen Person">${esc(names[1 - prioWho])}: ${other ? `<i class="pdot" style="background:var(--p-${other})"></i>${esc(prioName(other))}` : "–"}</span></span>`;
}
// Filterleiste mit Anzahl (zugleich Farblegende)
const prioFilter = { pano: "alle", ort: "alle" };
function prioChips(kind, counts) {
  const defs = [["alle", "Alle"], ...prioLevels(kind).map(l => [l.id, l.name]), ["ohne", "ohne Priorität"]];
  return defs.map(([v, l]) => `<button type="button" class="fchip" data-priofilter="${kind}|${v}" aria-pressed="${prioFilter[kind] === v}">${prioLevel(v) ? `<i class="pdot" style="background:var(--p-${v})"></i>` : ""}${esc(l)} <b>${counts[v] || 0}</b></button>`).join("");
}
function prioCounts(list) {
  const c = { alle: list.length, ohne: 0 };
  for (const p of list) { const k = p || "ohne"; c[k] = (c[k] || 0) + 1; }
  return c;
}
const prioMatch = (kind, p) => prioFilter[kind] === "alle" || (prioFilter[kind] === "ohne" ? !p : p === prioFilter[kind]);

/* ================= Orte sammeln ================= */
const ORT_TYPES = { night: "Übernachtung", stop: "Stopp", sight: "Ziel", own: "Eigener Ort" };
let ortType = "alle";
function allOrte() {
  const days = sortedDays(), byKey = new Map(), out = [];
  const add = (name, type, lat, lon, i) => {
    const key = "o:" + ortSlug(name), o = byKey.get(key);
    if (o) { if (!o.days.includes(i)) o.days.push(i); if (type === "night") o.type = "night"; return; }
    const n = { key, name: nightBase(name), type, lat, lon, days: [i], idx: i };
    byKey.set(key, n); out.push(n);
  };
  days.forEach((d, i) => {
    // Fähranleger sind nur Wegpunkte, keine Orte zum Priorisieren
    for (const v of d.via || []) if (hasPos(v) && v.name && !v.wp && !v.key?.startsWith("s:") && !v.key?.startsWith("p:") && !/ferjekai|fähranleger|hurtigrutenkai/i.test(v.name)) add(v.name, "stop", v.lat, v.lon, i);
    if (hasPos(d) && d.night && !d.auto && !d.key?.startsWith("s:") && !d.key?.startsWith("p:") && !/zu hause/i.test(d.night)) add(d.night, "night", d.lat, d.lon, i);
  });
  // Orte, die nur in anderen gespeicherten Routen vorkommen
  for (const d of otherRouteDays()) {
    const away = (name, type, lat, lon) => {
      const key = "o:" + ortSlug(name); if (byKey.has(key) || state.settings?.ort_weg?.[key]) return;   // gelöscht (bearbeiten.js)
      const n = { key, name: nightBase(name), type, lat, lon, days: [], idx: 999, away: true }; byKey.set(key, n); out.push(n);
    };
    for (const v of d.via || []) if (hasPos(v) && v.name && !v.wp && !v.key && !/ferjekai|fähranleger|hurtigrutenkai/i.test(v.name)) away(v.name, "stop", v.lat, v.lon);
    if (hasPos(d) && d.night && !d.auto && !d.key && !/zu hause/i.test(d.night)) away(d.night, "night", d.lat, d.lon);
  }
  for (const s of SIGHTS()) {
    const i = days.findIndex(d => d.id === sightDayId(s));
    out.push({ key: "s:" + s.id, id: s.id, name: s.name, type: "sight", lat: s.lat, lon: s.lon, days: i < 0 ? [] : [i], idx: i < 0 ? 998 : i, sub: s.type });
  }
  const nights = days.map((d, i) => ({ d, i })).filter(x => hasPos(x.d));
  for (const p of state.places || []) {
    // eigener Ort: beim nächstgelegenen Reisetag einsortieren
    const near = nights.reduce((a, x) => { const km = hav(p, x.d); return !a || km < a.km ? { km, i: x.i, d: x.d } : a; }, null);
    out.push({ key: "p:" + p.id, id: p.id, name: p.name, type: "own", lat: p.lat, lon: p.lon, days: [], idx: near ? near.i : 999, near });
  }
  for (const o of out) if (o.away) {
    o.near = nights.reduce((a, x) => { const km = hav(o, x.d); return !a || km < a.km ? { km, i: x.i, d: x.d } : a; }, null);
    if (o.near) o.idx = o.near.i;
  }
  return out.sort((a, b) => a.idx - b.idx || a.name.localeCompare(b.name, "de"));
}
function ortWhen(o) {
  const days = sortedDays();
  if (o.away) return `nicht in dieser Route${o.near ? ` · ${num(o.near.km)} km von ${nightBase(o.near.d.night)}` : ""}`;
  if (o.type === "own") return o.near ? `${num(o.near.km)} km von ${nightBase(o.near.d.night)} (Tag ${dayNo(o.near.d.date)})` : "";
  return o.days.length ? o.days.map(i => `${fmtDate(days[i].date)} (Tag ${dayNo(days[i].date)})`).join(", ") : "kein passender Reisetag";
}

/* ================= Reiter Orte ================= */
function renderOrte() {
  const el = document.getElementById("ortList"); if (!el || !state) return;
  const all = allOrte(), byType = all.filter(o => ortType === "alle" || o.type === ortType);
  $("#ortChips").innerHTML = prioChips("ort", prioCounts(byType.map(o => ortPrio(o.key))));
  $("#ortTypes").innerHTML = [["alle", "Alle Arten"], ...Object.entries(ORT_TYPES)].map(([v, l]) =>
    `<button type="button" class="fchip" data-orttype="${v}" aria-pressed="${ortType === v}">${l} <b>${v === "alle" ? all.length : all.filter(o => o.type === v).length}</b></button>`).join("");
  const list = byType.filter(o => prioMatch("ort", ortPrio(o.key)));
  el.innerHTML = list.length ? list.map(o => {
    const p = ortPrio(o.key);
    return `<li class="ortrow"${p ? ` style="--pc:var(--p-${p})"` : ""}>
      <span class="nm">${esc(o.name)}<span class="nt">${ORT_TYPES[o.type]}${o.sub ? ` · ${esc(o.sub)}` : ""}${ortWhen(o) ? ` · ${esc(ortWhen(o))}` : ""}${typeof nightInfo === "function" ? nightInfo(o) : ""}</span></span>
      ${prioButtons("ort", o.key, o.name)}
      <span class="acts"><button type="button" class="btn ghost mini" data-ortmap="${esc(o.key)}">Auf der Karte</button>
        <a class="btn go mini" href="https://www.google.com/maps/search/?api=1&query=${o.lat},${o.lon}" target="_blank" rel="noopener noreferrer">Google Maps ↗</a>
        
        <button type="button" class="btn ghost mini" data-edit-x="ort|${esc(o.key)}">Bearbeiten</button>
        <button type="button" class="btn danger mini" data-del-x="ort|${esc(o.key)}">Löschen</button></span>
    </li>`;
  }).join("") : `<li class="empty">Keine Orte mit dieser Auswahl.</li>`;
  $("#nOrte").textContent = all.filter(o => ortPrio(o.key)).length;
}

/* ================= Karte ================= */
const ortLayer = L.layerGroup().addTo(map);
const ortMarkers = {};
// Farbe für Übernachtungs-Nummern (app.js) und Ziel-Rauten (extras.js); null = wie bisher
const ortMapColor = key => SHOW.orte ? prioColor(ortPrio(key)) : null;
const nightMapColor = d => ortMapColor("o:" + ortSlug(d.night || ""));
const prioInk = key => { const c = prioColor(ortPrio(key)); return c ? inkOn(c) : "#fff"; };
function ortPin(color) {
  return L.divIcon({ className: "", iconSize: [24, 32], iconAnchor: [12, 31], popupAnchor: [0, -28], tooltipAnchor: [0, -28],
    html: `<svg class="ortpin" viewBox="0 0 24 32" width="24" height="32" aria-hidden="true"><path d="M12 31C12 31 22.5 18.5 22.5 11.5a10.5 10.5 0 1 0-21 0C1.5 18.5 12 31 12 31z" fill="${color}" stroke="#fff" stroke-width="1.6"/><circle cx="12" cy="11.5" r="4" fill="#fff"/></svg>` });
}
// Stecknadeln für priorisierte Stopps und alle eigenen Orte (Übernachtungen und Ziele färben ihre Marker selbst)
function drawOrte() {
  ortLayer.clearLayers(); for (const k of Object.keys(ortMarkers)) delete ortMarkers[k];
  if (!state || !SHOW.orte) return;
  for (const o of allOrte()) {
    const p = ortPrio(o.key);
    // Übernachtungen tragen die Farbe an ihrer Nummer – bei ausgeschalteter Route als Stecknadel
    if (o.type === "sight" || (o.type === "night" && ((SHOW.route && o.days.length) || !p)) || (o.type === "stop" && !p)) continue;
    const m = L.marker([o.lat, o.lon], { icon: ortPin(p ? prioColor(p) : "#78909c"), riseOnHover: true, zIndexOffset: 200, title: o.name });
    m.bindTooltip(`${esc(o.name)}${p ? " · " + esc(prioName(p)) : ""}`, { direction: "top" });
    m.bindPopup(() => ortPopup(o.key), { maxWidth: 300, minWidth: 220 });
    m.addTo(ortLayer); ortMarkers[o.key] = m;
  }
}
function ortPopup(key) {
  const o = allOrte().find(x => x.key === key); if (!o) return "";
  return `<div class="pop" data-pop="ort|${esc(key)}"><b>${esc(o.name)}</b><span>${ORT_TYPES[o.type]}${ortWhen(o) ? " · " + esc(ortWhen(o)) : ""}</span>${prioButtons("ort", key, o.name)}
    <div class="acts"><a class="btn ghost mini" href="#orte">Alle Orte</a><button type="button" class="btn ghost mini" data-edit-x="ort|${esc(key)}">Bearbeiten</button></div></div>`;
}
function showOrtOnMap(key) {
  const o = allOrte().find(x => x.key === key); if (!o) return;
  if (o.type === "sight") { showOnMap("sight:" + o.id); return; }
  location.hash = "#route";
  setTimeout(() => {
    if (matchMedia("(max-width: 860px)").matches) setMapList("map");
    map.invalidateSize(); pendingFit = false;
    if (!SHOW.orte) { SHOW.orte = true; syncMapButtons(); drawMarkers(); drawExtras(); drawOrte(); }
    map.setView([o.lat, o.lon], 10, { animate: false });
    if (o.type === "night" && SHOW.route && o.days.length) { const d = sortedDays()[o.days[0]]; selectDay(d.id, false); markers[d.id]?.openTooltip(); }
    else if (ortMarkers[key]) ortMarkers[key].openPopup();
    else L.popup().setLatLng([o.lat, o.lon]).setContent(ortPopup(key)).openOn(map);
    $(".mapbox").scrollIntoView({ block: "start" });
  }, 60);
}

/* ================= Ereignisse ================= */
document.addEventListener("click", e => {
  const b = e.target.closest("[data-prioset]");
  if (b) { const a = b.dataset.prioset.split("|"); setPrio(a[0], a.slice(1, -1).join("|"), a[a.length - 1]); return; }
  const f = e.target.closest("[data-priofilter]");
  if (f) { const [k, v] = f.dataset.priofilter.split("|"); prioFilter[k] = v; k === "pano" ? renderPano() : renderOrte(); return; }
  const t = e.target.closest("[data-orttype]");
  if (t) { ortType = t.dataset.orttype; renderOrte(); return; }
  const m = e.target.closest("[data-ortmap]");
  if (m) showOrtOnMap(m.dataset.ortmap);
});
$("#addOrt").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#oName").value.trim(), prio = $("#oPrio").value, err = $("#oErr"), btn = e.target.querySelector("[type=submit]");
  err.textContent = "";
  if (!name) { err.textContent = "Gib einen Ort ein."; return; }
  btn.disabled = true;
  try {
    const g = await geocode(name);
    const dup = allOrte().find(o => hav(o, g) < 0.5 && ortSlug(o.name) === ortSlug(name));
    if (dup) throw new Error(`„${dup.name}“ steht schon in der Liste.`);
    state.places = state.places || [];
    const p = { id: nid("o"), name, lat: g.lat, lon: g.lon, ...(prio ? { [prioWho ? "prio2" : "prio"]: prio } : {}) };
    state.places.push(p); prioFilter.ort = "alle"; ortType = "alle";
    $("#oName").value = ""; save(); redrawPrio();
    notice(`„${esc(name)}“ hinzugefügt. Prüfe mit „Auf der Karte“, ob der richtige Ort gefunden wurde.`);
  } catch (x) { err.textContent = x.message; }
  btn.disabled = false;
});
window.addEventListener("themechange", () => { applyPrioVars(); if (state) redrawPrio(); });
