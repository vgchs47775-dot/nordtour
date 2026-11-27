/* Orte, Ziele aus „Erleben“ und Panoramastraßen bearbeiten und löschen.
   Ziele und Straßen kommen aus extras.json (für alle gleich). Eigene Änderungen stehen deshalb daneben in
   state.settings.extrasCfg = { sights: { <ID>: { name, … , gone } }, pano: { <ID>: { … , geom, way, gone } } };
   PANO() und SIGHTS() (extras.js) legen sie darüber. gone = gelöscht, lässt sich wiederherstellen.
   Übernachtungen und Stopps sind keine eigene Liste, sondern stecken in den Tagen: Ändern gilt in allen Routen
   (gleicher Ort), Löschen nur in der gewählten. state.settings.ort_weg = { <Schlüssel>: Name } blendet Orte aus,
   die nur noch in anderen Routen vorkommen. Jede Änderung hier lässt sich mit „Rückgängig“ zurücknehmen.
   Wird nach panowege.js geladen. */
"use strict";

/* ---------- Rückgängig: Tage und alles, was hier sonst geändert wird ---------- */
const UNDO_KEYS = ["extrasCfg", "ort_prio", "ort_weg", "panorama_geplant", "sights_geplant"];
function undoPoint() {
  const days = JSON.stringify(state.days), rest = JSON.stringify({ s: Object.fromEntries(UNDO_KEYS.map(k => [k, state.settings[k]])), places: state.places, routeList: state.routeList });
  const costs = state.costs.map(c => [c.id, c.dayId]);
  return () => {                                       // nach der Änderung scharf schalten
    undoSnap = days;
    undoAfter = { snap: days, run() {
      const o = JSON.parse(rest);
      for (const k of UNDO_KEYS) { if (o.s[k] === undefined) delete state.settings[k]; else state.settings[k] = o.s[k]; }
      if (o.places) state.places = o.places; else delete state.places;
      state.routeList = o.routeList;
      for (const [id, dayId] of costs) { const c = state.costs.find(x => x.id === id); if (c) c.dayId = dayId; }
    } };
  };
}
const allDays = () => [...state.days, ...otherRouteDays()];
function patchExtra(kind, id, patch) {
  const cfg = { ...(state.settings.extrasCfg || {}) }, list = { ...(cfg[kind] || {}) };
  if (patch) list[id] = JSON.parse(JSON.stringify({ ...list[id], ...patch })); else delete list[id];
  if (list[id] && !Object.keys(list[id]).length) delete list[id];
  cfg[kind] = list; state.settings.extrasCfg = cfg;    // neues Objekt, damit PANO()/SIGHTS() neu aufbauen
}
const rawExtra = (kind, id) => EXTRAS?.[kind === "pano" ? "pano" : "sights"]?.find(x => x.id === id) || (state.settings.extrasCfg?.[kind]?.[id]?.own ? state.settings.extrasCfg[kind][id] : null);
const hasPatch = (kind, id) => Object.keys(state.settings.extrasCfg?.[kind]?.[id] || {}).length > 0;

/* ---------- Namen und Lage in den Tagen mitändern ---------- */
// Titel „A → B“ und „Ruhetag in A“ an einen neuen Ortsnamen anpassen
function retitle(d, old, name) {
  if (!d.title) return;
  if (d.title === `Ruhetag in ${old}`) d.title = `Ruhetag in ${name}`;
  else if (d.title.includes(" → ")) d.title = d.title.split(" → ").map(x => nightBase(x) === old ? name : x).join(" → ");
}
// test(Punkt, Name, ist Nacht?) wählt die Punkte aus; next = { name, lat, lon, stay }
function changePoints(test, old, next) {
  const moved = next.lat != null && (next.lat !== old.lat || next.lon !== old.lon);
  const pos = p => { if (moved && hasPos(p) && hav(p, old) < 5) { p.lat = next.lat; p.lon = next.lon; } };
  const groups = [state.days, ...(state.routeList || []).filter(r => r.data).map(r => r.data.days)];
  for (const days of groups) {
    let renamed = false;
    for (const d of days) {
      for (const v of d.via || []) if (test(v, v.name, false)) {
        if (nightBase(v.name) === old.name) v.name = next.name;
        pos(v);
        if (next.stay !== undefined && days === state.days) { if (next.stay > 0) v.stay = next.stay; else delete v.stay; }
      }
      if (d.night && test(d, d.night, true)) {
        if (nightBase(d.night) === old.name) { d.night = next.name + d.night.slice(nightBase(d.night).length); renamed = true; }
        pos(d);
      }
    }
    if (renamed && old.name !== next.name) for (const d of days) retitle(d, old.name, next.name);
  }
}
const isNamed = key => (p, name) => !!name && !p.wp && !p.key?.startsWith("s:") && !p.key?.startsWith("p:") && "o:" + ortSlug(name) === key;
const isKeyed = key => p => p.key === key;

/* ---------- Löschen ---------- */
// Stopps mit diesem Schlüssel aus der gewählten Route nehmen; Nächte dort behalten, aber vom Ziel lösen
function dropKey(key) {
  let n = 0;
  for (const d of state.days) {
    const via = (d.via || []).filter(v => v.key !== key);
    n += (d.via || []).length - via.length; d.via = via;
  }
  for (const d of allDays()) { if (d.key === key) delete d.key; for (const v of d.via || []) if (v.key === key) delete v.key; }
  return n;
}
function dropPlanned(kind, id) {
  const k = kind === "pano" ? "panorama_geplant" : "sights_geplant";
  if (state.settings[k]) state.settings[k] = state.settings[k].filter(x => x !== id);
}
function deleteSight(id) {
  const x = SIGHTS().find(s => s.id === id); if (!x) return;
  const inRoute = state.days.some(d => (d.via || []).some(v => v.key === "s:" + id));
  if (!confirm(`„${x.name}“ löschen?${inRoute ? " Der Stopp in dieser Route wird auch entfernt." : ""} Du kannst das Ziel unten im Reiter „Erleben“ wiederherstellen.`)) return;
  const undo = undoPoint();
  dropKey("s:" + id); dropPlanned("sights", id); patchExtra("sights", id, { gone: true });
  finish(undo, `„${esc(x.name)}“ gelöscht.`);
}
function deletePano(id) {
  const p = PANO().find(s => s.id === id); if (!p) return;
  const on = isPlanned("pano", id);
  if (!confirm(`Panoramastraße „${p.name}“ löschen?${on ? " Sie wird auch aus dieser Route genommen." : ""} Du kannst sie unten im Reiter „Panoramastraßen“ wiederherstellen.`)) return;
  const undo = undoPoint();
  removePano(id); dropPlanned("pano", id); patchExtra("pano", id, { gone: true });
  finish(undo, `„${esc(p.name)}“ gelöscht.`);
}
function deleteOrt(key) {
  const o = allOrte().find(x => x.key === key); if (!o) return;
  if (o.type === "sight") { deleteSight(o.id); return; }
  if (o.type === "own") {
    const inRoute = state.days.some(d => (d.via || []).some(v => v.key === key));
    if (!confirm(`„${o.name}“ löschen?${inRoute ? " Der Stopp in dieser Route wird auch entfernt." : ""}`)) return;
    const undo = undoPoint();
    dropKey(key); state.places = state.places.filter(p => p.id !== o.id);
    finish(undo, `„${esc(o.name)}“ gelöscht.`); return;
  }
  const hide = () => { state.settings.ort_weg = { ...(state.settings.ort_weg || {}), [key]: o.name }; };
  if (o.away) {
    if (!confirm(`„${o.name}“ aus der Liste nehmen? Der Ort bleibt in deinen anderen gespeicherten Routen. Du kannst ihn unten wiederherstellen.`)) return;
    const undo = undoPoint(); hide(); finish(undo, `„${esc(o.name)}“ aus der Liste genommen.`); return;
  }
  const test = isNamed(key), list = sortedDays(), nights = list.filter(d => hasPos(d) && d.night && !d.auto && test(d, d.night, true));
  if (nights.includes(list[list.length - 1])) { notice(`„${esc(o.name)}“ ist das Ziel deiner Reise. Ändere oder lösche den letzten Tag im Reiter „Route“ unter „Bearbeiten“.`); return; }
  const busy = nights.find(d => journalUsed(d.id));
  if (busy) { notice(`Der Tag ${esc(fmtDate(busy.date))} in ${esc(o.name)} hat Tagebuch-Einträge. Lösche oder verschiebe sie zuerst, sonst wären sie nicht mehr zu sehen.`); return; }
  const n = nights.length;
  if (!confirm(`„${o.name}“ aus dieser Route löschen?${n ? ` ${n === 1 ? "Die Übernachtung entfällt" : `${n} Übernachtungen entfallen`}, die Etappen werden zusammengelegt und die folgenden Tage rücken ${n === 1 ? "einen Tag" : `${n} Tage`} nach vorne.` : " Der Stopp entfällt."}`)) return;
  const undo = undoPoint();
  for (const d of state.days) d.via = (d.via || []).filter(v => !test(v, v.name, false));
  for (const d of nights) mergeNight(d.id, { quiet: true });
  hide();
  finish(undo, `„${esc(o.name)}“ aus der Route gelöscht.${n ? " Die folgenden Tage sind nach vorne gerückt." : ""}`);
}
function finish(undo, msg) { save(); refresh(); undo(); notice(msg, true); }
function restoreGone(kind, id) {
  const undo = undoPoint();
  if (kind === "ort") { const m = { ...state.settings.ort_weg }; delete m[id]; state.settings.ort_weg = m; }
  else patchExtra(kind, id, { gone: undefined });
  finish(undo, "Wiederhergestellt.");
}
// „Gelöscht“-Listen unter den drei Reitern
function renderGone() {
  if (!state || !EXTRAS) return;
  const cfg = state.settings?.extrasCfg || {}, gone = kind => Object.keys(cfg[kind] || {}).filter(id => cfg[kind][id].gone && rawExtra(kind, id)).map(id => [kind, id, cfg[kind][id].name || rawExtra(kind, id).name]);
  const shown = new Set(allOrte().map(o => o.key)), others = new Set();
  for (const d of otherRouteDays()) { for (const v of d.via || []) if (v.name && !v.wp && !v.key) others.add("o:" + ortSlug(v.name)); if (d.night && !d.auto && !d.key) others.add("o:" + ortSlug(d.night)); }
  const orte = Object.entries(state.settings?.ort_weg || {}).filter(([k]) => !shown.has(k) && others.has(k)).map(([k, n]) => ["ort", k, n]);
  const fill = (sel, list) => {
    const el = document.querySelector(sel); if (!el) return;
    el.hidden = !list.length;
    el.innerHTML = list.length ? `<summary>Gelöscht (${list.length})</summary><ul>${list.map(([k, id, n]) => `<li><span>${esc(n)}</span><button type="button" class="btn ghost mini" data-restore="${esc(k + "|" + id)}">Wiederherstellen</button></li>`).join("")}</ul>` : "";
  };
  fill("#gonePano", gone("pano")); fill("#goneSights", gone("sights")); fill("#goneOrte", [...orte, ...gone("sights")]);
}

/* ---------- Dialog ---------- */
let ed = null, edMap = null, edLayer = null, edTimer = null, edRun = 0;
const edField = (id, label, value, extra = "") => `<label class="lbl" for="${id}">${label}<input id="${id}" value="${esc(value ?? "")}" ${extra}></label>`;
const edArea = (id, label, value) => `<label class="lbl" for="${id}">${label}<textarea id="${id}" rows="3" maxlength="900">${esc(value ?? "")}</textarea></label>`;
function openEdit(kind, id) {
  let x, f, hint = "", title;
  if (kind === "ort") {
    x = allOrte().find(o => o.key === id); if (!x) return;
    if (x.type === "sight") { openEdit("sights", x.id); return; }
    const own = x.type === "own", stops = own ? [] : state.days.flatMap(d => (d.via || []).filter(v => isNamed(id)(v, v.name)));
    title = `${ORT_TYPES[x.type]} bearbeiten`;
    hint = own ? "" : "Name und Lage ändern sich überall, wo dieser Ort vorkommt, auch in deinen anderen gespeicherten Routen. Die Etappen werden neu berechnet.";
    f = edField("edName", "Name", x.name, 'type="text" maxlength="60" required') +
      (stops.length ? edField("edStay", "Aufenthalt beim Stopp (Minuten)", stops[0].stay || "", 'type="number" min="0" max="1440" step="5" inputmode="numeric" placeholder="0"') : "");
    ed = { kind, id, x, stops: stops.length, pos: { lat: x.lat, lon: x.lon } };
  } else if (kind === "sights") {
    x = SIGHTS().find(s => s.id === id); if (!x) return;
    title = "Ziel bearbeiten";
    f = `<div class="two">${edField("edName", "Name", x.name, 'type="text" maxlength="80" required')}${edField("edType", "Art", x.type, 'type="text" maxlength="30" list="edTypes"')}</div>
      <datalist id="edTypes">${[...new Set(SIGHTS().map(s => s.type))].map(t => `<option value="${esc(t)}">`).join("")}</datalist>
      ${edArea("edDesc", "Beschreibung", x.desc)}
      <div class="three">${edField("edVisit", "Zeit vor Ort (Min.)", Math.round(x.visit * 60), 'type="number" min="0" max="1440" step="5" inputmode="numeric"')}
      ${edField("edDetour", "Umweg (Min.)", Math.round(x.detour * 60), 'type="number" min="0" max="1440" step="5" inputmode="numeric"')}
      <label class="lbl" for="edDay">Reisetag<select id="edDay"><option value="">automatisch (nächster Tag)</option>${sortedDays().map(d => `<option value="${esc(d.id)}"${d.id === x.day ? " selected" : ""}>${fmtDate(d.date)}: ${esc(d.title || "")}</option>`).join("")}</select></label></div>`;
    ed = { kind, id, x, pos: { lat: x.lat, lon: x.lon } };
  } else {
    x = id ? PANO().find(p => p.id === id) : { id: null, name: "", land: "", desc: "", fit: "", imgs: [], geom: null, way: [] };
    if (!x) return;
    title = id ? "Panoramastraße bearbeiten" : "Neue Panoramastraße";
    hint = id ? "Verlauf: Punkte ziehen. Auf die Karte tippen = Punkt einfügen, Punkt antippen = entfernen. Die Straße folgt den Punkten von 1 bis zum letzten."
      : "Tippe auf der Karte zuerst den Anfang und dann das Ende der Straße an (oder suche die Orte unten). Weitere Punkte legen den Weg dazwischen fest.";
    f = `<div class="two">${edField("edName", "Name", x.name, 'type="text" maxlength="80" required')}${edField("edLand", "Land", x.land, 'type="text" maxlength="40"')}</div>
      ${edArea("edDesc", "Beschreibung", x.desc)}${edField("edFit", "Hinweis (grün)", x.fit, 'type="text" maxlength="200"')}
      <div class="edphotos"><div class="edline"><span class="lbl">Fotos <span class="hint">(antippen = auswählen, höchstens 6)</span></span><button type="button" class="btn ghost mini" id="edPhotoFind">Fotos an der Strecke suchen</button></div>
      <div class="photogrid" id="edPhotos"></div></div>`;
    ed = { kind, id, x, pts: x.geom ? panoWay(x).map(q => ({ lat: q[0], lon: q[1] })) : [], line: x.geom, km: x.km, changed: !id,
      imgs: [...(x.imgs || [])], cands: [], picked: new Set((x.imgs || []).map(i => i.src)) };
  }
  $("#edTitle").textContent = title; $("#edHint").textContent = hint; $("#edHint").hidden = !hint;
  $("#edFields").innerHTML = f; $("#edErr").textContent = ""; $("#edInfo").textContent = ""; $("#edQuery").value = "";
  $("#edSearchLbl").textContent = kind === "pano" ? "Punkt über die Ortssuche einfügen" : "Lage über die Ortssuche setzen";
  $("#edReset").hidden = !(kind !== "ort" && id && hasPatch(kind, id) && !x.own);
  $("#edDel").hidden = !id;
  if (ed.imgs) drawPhotos();
  $("#edPtUndo").hidden = kind !== "pano"; $("#edPtUndo").disabled = true; $("#edSave").disabled = false;
  $("#editDlg").showModal(); $("#editDlg").scrollTop = 0;
  initEdMap(); edMap.invalidateSize();
  if (ed.pts && ed.line) edMap.fitBounds(L.latLngBounds(ed.line), { padding: [24, 24], animate: false });
  else if (ed.pts) { const ps = sortedDays().filter(hasPos).map(d => [d.lat, d.lon]); ps.length ? edMap.fitBounds(L.latLngBounds(ps), { padding: [24, 24], animate: false }) : edMap.setView([63, 12], 5, { animate: false }); }
  else edMap.setView([ed.pos.lat, ed.pos.lon], 11, { animate: false });
  drawEd();
}
function initEdMap() {
  if (edMap) return;
  edMap = L.map("edMap", { zoomSnap: 0.5 }).setView([63, 15], 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, crossOrigin: "", attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(edMap);
  edLayer = L.layerGroup().addTo(edMap);
  edMap.on("click", e => { if (ed) edSet({ lat: e.latlng.lat, lon: e.latlng.lng }); });
  new ResizeObserver(() => edMap.invalidateSize()).observe(document.getElementById("edMap"));
}
const round4 = p => ({ lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4) });
function edSet(p) {                                    // Karte angetippt oder Ort gefunden
  if (!ed.pts) { ed.pos = round4(p); drawEd(); return; }
  if (ed.pts.length >= 20) { $("#edErr").textContent = "Höchstens 20 Punkte."; return; }
  edPush();
  if (ed.pts.length < 2) { ed.pts.push(round4(p)); edChanged(); return; }   // neue Straße: Anfang, dann Ende
  // dort einfügen, wo der Punkt am wenigsten Umweg macht – auch vor dem ersten oder nach dem letzten
  const P = ed.pts, q = round4(p); let best = 0, bd = hav(q, P[0]);
  for (let i = 1; i < P.length; i++) { const c = hav(P[i - 1], q) + hav(q, P[i]) - hav(P[i - 1], P[i]); if (c < bd) { bd = c; best = i; } }
  if (hav(P[P.length - 1], q) < bd) best = P.length;
  P.splice(best, 0, q); edChanged();
}
function edPush() { (ed.hist = ed.hist || []).push(ed.pts.map(p => ({ ...p }))); $("#edPtUndo").disabled = false; }
function edChanged() { ed.changed = true; ed.line = null; drawEd(); clearTimeout(edTimer); edTimer = setTimeout(edRoute, 900); }
// Verlauf der Panoramastraße über die Punkte berechnen
async function edRoute() {
  if (!ed?.pts) return;
  const run = ++edRun, me = ed; $("#edErr").textContent = "";
  if (me.pts.length < 2) { $("#edInfo").textContent = me.pts.length ? "Jetzt das Ende der Straße antippen." : ""; return; }
  if (!navigator.onLine) { $("#edErr").textContent = "Für einen neuen Verlauf brauchst du Internet."; return; }
  $("#edInfo").textContent = "Verlauf wird berechnet …"; $("#edSave").disabled = true;
  try {
    const r = await computeRoute(me.pts, { stop: () => run !== edRun || ed !== me });
    if (run !== edRun || ed !== me) return;
    const all = r.parts.flatMap(p => p.ferry ? p.pts : decodePolyline(p.enc)), step = Math.max(0.3, r.km / 350), line = [all[0]];
    for (const q of all) if (hav({ lat: line.at(-1)[0], lon: line.at(-1)[1] }, { lat: q[0], lon: q[1] }) >= step) line.push(q);
    line.push(all.at(-1));
    me.line = line.map(q => [+q[0].toFixed(4), +q[1].toFixed(4)]); me.km = Math.round(r.km);
    $("#edInfo").textContent = `Neuer Verlauf: ca. ${num(r.km)} km · ${fmtShort(r.h)}`;
    if (!me.id && !me.cands.length && !me.imgs.length) findPhotos();       // neue Straße: gleich Fotos vorschlagen
    if (!me.id && !$("#edLand").value.trim()) reverseCountry(me.pts[0]).then(c => { if (ed === me && c && !$("#edLand").value.trim()) $("#edLand").value = c; });
  } catch (e) {
    if (run !== edRun || ed !== me) return;
    $("#edInfo").textContent = ""; $("#edErr").textContent = e.perm ? (await findRouteError(e)).msg : "Der Routing-Server ist gerade gestört. Versuche es gleich noch einmal.";
  }
  if (run === edRun && ed === me) { $("#edSave").disabled = false; drawEd(); }
}
function drawEd() {
  edLayer.clearLayers(); if (!ed) return;
  if (!ed.pts) {
    const m = L.marker([ed.pos.lat, ed.pos.lon], { draggable: true, icon: icon("●", "sel") }).addTo(edLayer);
    m.on("dragend", () => { const q = m.getLatLng(); ed.pos = round4({ lat: q.lat, lon: q.lng }); drawEd(); });
    $("#edInfo").textContent = `Lage: ${ed.pos.lat}, ${ed.pos.lon} – Punkt ziehen oder auf die Karte tippen`;
    return;
  }
  L.polyline(ed.line || ed.pts.map(p => [p.lat, p.lon]), { color: COL.sel, weight: 5, opacity: .9, interactive: false, ...(ed.line ? {} : { dashArray: "6 8" }) }).addTo(edLayer);
  ed.pts.forEach((p, i) => {
    const m = L.marker([p.lat, p.lon], { draggable: true, icon: icon(String(i + 1), "sel"), zIndexOffset: 300 }).addTo(edLayer);
    m.on("dragstart", edPush);
    m.on("dragend", () => { const q = m.getLatLng(); ed.pts[i] = round4({ lat: q.lat, lon: q.lng }); edChanged(); });
    m.bindPopup(`<div class="pop"><b>Punkt ${i + 1}</b><div class="acts"><button type="button" class="btn danger mini" data-edrm="${i}">Punkt entfernen</button></div></div>`);
  });
}
function saveEdit() {
  const val = id => document.getElementById(id)?.value.trim() ?? "", err = t => { $("#edErr").textContent = t; };
  const name = val("edName"), { kind, id, x } = ed;
  if (!name) return err("Der Name fehlt.");
  const mins = f => { const v = parseFloat(val(f).replace(",", ".")); return v >= 0 && v <= 1440 ? v : 0; };
  const undo = undoPoint();
  if (kind === "ort") {
    const next = { name, ...ed.pos, ...(ed.stops ? { stay: Math.round(mins("edStay")) } : {}) };
    if (x.type === "own") {
      const p = state.places.find(q => q.id === x.id); if (!p) return closeEdit();
      changePoints(isKeyed(id), { name: p.name, lat: p.lat, lon: p.lon }, next);
      Object.assign(p, { name, ...ed.pos });
    } else {
      const key = "o:" + ortSlug(name);
      if (/zu hause/i.test(name)) return err("Dieser Name ist für die Heimreise reserviert.");
      if (key !== id && allOrte().some(o => o.key === key)) return err(`„${name}“ gibt es schon.`);
      changePoints(isNamed(id), { name: x.name, lat: x.lat, lon: x.lon }, next);
      if (key !== id) for (const f of ["ort_prio", "ort_weg"]) if (state.settings[f]?.[id] !== undefined) {
        const m = { ...state.settings[f], [key]: state.settings[f][id] }; delete m[id]; state.settings[f] = m;
      }
    }
  } else if (kind === "sights") {
    changePoints(isKeyed("s:" + id), { name: x.name, lat: x.lat, lon: x.lon }, { name, ...ed.pos });
    const keepDay = !sortedDays().some(d => d.id === x.day) && !val("edDay");      // Tag gehört zu einer anderen Route
    patchExtra("sights", id, { name, type: val("edType") || x.type, desc: val("edDesc"), visit: mins("edVisit") / 60, detour: mins("edDetour") / 60, ...ed.pos, day: keepDay ? x.day : val("edDay") });
  } else {
    if (ed.changed && !ed.line) return err(ed.pts.length < 2 ? "Lege mit zwei Punkten auf der Karte Anfang und Ende fest." : "Warte, bis der neue Verlauf berechnet ist.");
    const imgs = [...ed.imgs, ...ed.cands].filter((i, k, a) => ed.picked.has(i.src) && a.findIndex(j => j.src === i.src) === k).slice(0, 6);
    if (!id) {
      const nid_ = nid("own");
      patchExtra("pano", nid_, { own: true, name, land: val("edLand"), desc: val("edDesc"), fit: val("edFit"), geom: ed.line, way: ed.pts.map(p => [p.lat, p.lon]), km: ed.km, imgs });
      closeEdit(); finish(undo, `„${esc(name)}“ angelegt. Setze eine Priorität oder tippe auf „Einplanen“, damit sie in die Route kommt.`);
      return;
    }
    if (name !== x.name) for (const d of allDays()) for (const v of d.via || []) if (v.pano === id || v.name === panoWp(x)) v.name = `${name} (Wegpunkt)`;
    const on = isPlanned("pano", id);
    const patch = { name, land: val("edLand"), desc: val("edDesc"), fit: val("edFit"), ...(JSON.stringify(imgs) !== JSON.stringify(x.imgs || []) ? { imgs } : {}) };
    if (!ed.changed) patchExtra("pano", id, patch);
    else {
      removePano(id);
      patchExtra("pano", id, { ...patch, geom: ed.line, way: ed.pts.map(p => [p.lat, p.lon]), km: ed.km });
      if (on) completePano(id, false);                 // eingeplant: neuen Verlauf gleich fahren
    }
  }
  closeEdit(); finish(undo, `„${esc(name)}“ gespeichert.`);
}
/* ---------- Fotos von Wikimedia Commons (frei lizenziert, mit Urheber) ---------- */
// nur den Text: DOMParser führt nichts aus (anders als innerHTML, wo z. B. onerror von Bildern liefe)
const stripTags = s => (new DOMParser().parseFromString(s || "", "text/html").body.textContent || "").replace(/\s+/g, " ").trim();
async function reverseCountry(p) {
  try { return (await nomi(`reverse?zoom=3&lat=${p.lat}&lon=${p.lon}`)).address?.country || ""; } catch { return ""; }
}
async function findPhotos() {
  const me = ed; if (!me?.line?.length) { $("#edErr").textContent = "Lege zuerst den Verlauf fest."; return; }
  if (!navigator.onLine) { $("#edErr").textContent = "Für die Fotosuche brauchst du Internet."; return; }
  const btn = $("#edPhotoFind"); btn.disabled = true; $("#edPhotos").dataset.busy = "Fotos werden gesucht …"; drawPhotos();
  const L2 = me.line, n = Math.min(4, Math.max(2, Math.round((me.km || 50) / 40))), found = new Map();
  try {
    for (let k = 0; k < n; k++) {
      const q = L2[Math.round(k * (L2.length - 1) / Math.max(1, n - 1))];
      const u = "https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=geosearch&ggsnamespace=6&ggslimit=25&ggsradius=8000" +
        `&ggscoord=${q[0].toFixed(4)}|${q[1].toFixed(4)}&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=800&iiextmetadatafilter=Artist|LicenseShortName`;
      const j = await (await fetch(u)).json();
      for (const pg of Object.values(j.query?.pages || {})) {
        const i = pg.imageinfo?.[0], m = i?.extmetadata || {}, r = i ? i.width / i.height : 0;
        if (!i?.thumburl || i.mime !== "image/jpeg" || r < 1.2 || r > 2 || i.width < 1200 || /map|karte|kart\b|logo|banner|sign|skilt|diagram/i.test(pg.title)) continue;
        found.set(i.thumburl, { src: i.thumburl, page: i.descriptionurl, artist: stripTags(m.Artist?.value) || "unbekannt", license: stripTags(m.LicenseShortName?.value) || "siehe Wikimedia Commons" });
      }
      if (ed !== me) return;
      await sleep(300);
    }
    me.cands = [...found.values()].filter(c => !me.imgs.some(i => i.src === c.src)).slice(0, 18);
    if (!me.imgs.length && !me.picked.size) me.cands.slice(0, 3).forEach(c => me.picked.add(c.src));
    $("#edPhotos").dataset.busy = me.cands.length ? "" : "Keine passenden Fotos gefunden.";
  } catch { $("#edPhotos").dataset.busy = "Wikimedia Commons ist gerade nicht erreichbar."; }
  if (ed === me) { btn.disabled = false; drawPhotos(); }
}
function drawPhotos() {
  const el = $("#edPhotos"); if (!el || !ed?.imgs) return;
  const all = [...ed.imgs, ...ed.cands];
  el.innerHTML = all.map(i => `<button type="button" class="photo" data-edphoto="${esc(i.src)}" aria-pressed="${ed.picked.has(i.src)}" title="${esc(`Foto: ${i.artist}, ${i.license}`)}"><img src="${esc(i.src)}" alt="" loading="lazy"><span aria-hidden="true">✓</span></button>`).join("") +
    (el.dataset.busy ? `<p class="hint">${esc(el.dataset.busy)}</p>` : all.length ? "" : `<p class="hint">Noch keine Fotos.</p>`);
}
function closeEdit() { clearTimeout(edTimer); edRun++; ed = null; $("#editDlg").close(); }
window.addEventListener("DOMContentLoaded", () => {
  const dlg = $("#editDlg");
  $("#edClose").addEventListener("click", closeEdit);
  dlg.addEventListener("cancel", () => { clearTimeout(edTimer); edRun++; ed = null; });
  $("#edForm").addEventListener("submit", e => { e.preventDefault(); if (ed) saveEdit(); });
  $("#edDel").addEventListener("click", () => {
    const { kind, id } = ed;
    closeEdit(); kind === "ort" ? deleteOrt(id) : kind === "pano" ? deletePano(id) : deleteSight(id);
  });
  $("#edReset").addEventListener("click", () => {
    const { kind, id, x } = ed; if (!confirm(`Alle eigenen Änderungen an „${x.name}“ verwerfen?`)) return;
    closeEdit(); const undo = undoPoint(), raw = rawExtra(kind, id);
    if (kind === "pano") {
      const geo = !!x.custom, on = isPlanned("pano", id);
      for (const d of allDays()) for (const v of d.via || []) if (v.pano === id || v.name === panoWp(x)) v.name = panoWp(raw);
      patchExtra(kind, id, null);
      if (geo) { removePano(id); if (on && !panoHasVariant(id)) completePano(id, false); }
    } else {
      changePoints(isKeyed("s:" + id), { name: x.name, lat: x.lat, lon: x.lon }, { name: raw.name, lat: raw.lat, lon: raw.lon });
      patchExtra(kind, id, null);
    }
    finish(undo, `„${esc(raw.name)}“ ist wieder im Original.`);
  });
  $("#edPtUndo").addEventListener("click", () => { if (!ed?.hist?.length) return; ed.pts = ed.hist.pop(); $("#edPtUndo").disabled = !ed.hist.length; edMap.closePopup(); edChanged(); });
  $("#edFields").addEventListener("click", e => {
    if (e.target.closest("#edPhotoFind")) { findPhotos(); return; }
    const b = e.target.closest("[data-edphoto]"); if (!b || !ed?.picked) return;
    const s = b.dataset.edphoto;
    if (ed.picked.has(s)) ed.picked.delete(s); else if (ed.picked.size < 6) ed.picked.add(s); else { $("#edErr").textContent = "Höchstens 6 Fotos."; return; }
    $("#edErr").textContent = ""; drawPhotos();
  });
  $("#panoNew").addEventListener("click", () => openEdit("pano", null));
  $("#edMap").addEventListener("click", e => {
    const b = e.target.closest("[data-edrm]"); if (!b || !ed?.pts) return;
    edMap.closePopup();
    if (ed.pts.length <= 2) { $("#edErr").textContent = "Mindestens zwei Punkte."; return; }
    edPush(); ed.pts.splice(+b.dataset.edrm, 1); edChanged();
  });
  const search = async () => {
    const q = $("#edQuery").value.trim(), me = ed; if (!q || !me) return;
    $("#edErr").textContent = ""; $("#edSearch").disabled = true;
    try {
      const g = await geocode(q); if (ed !== me) return;
      edSet(g); edMap.setView([g.lat, g.lon], Math.max(edMap.getZoom(), 9), { animate: false });
    } catch (x) { $("#edErr").textContent = x.message; }
    finally { $("#edSearch").disabled = false; }
  };
  $("#edSearch").addEventListener("click", search);
  $("#edQuery").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); search(); } });
  appReady.then(renderGone);
});
document.addEventListener("click", e => {
  const b = e.target.closest("[data-edit-x]");
  if (b) { const v = b.dataset.editX, i = v.indexOf("|"); map.closePopup(); openEdit(v.slice(0, i), v.slice(i + 1)); return; }
  const d = e.target.closest("[data-del-x]");
  if (d) { const v = d.dataset.delX, i = v.indexOf("|"), k = v.slice(0, i), id = v.slice(i + 1); map.closePopup(); k === "ort" ? deleteOrt(id) : k === "pano" ? deletePano(id) : deleteSight(id); return; }
  const r = e.target.closest("[data-restore]");
  if (r) { const v = r.dataset.restore, i = v.indexOf("|"); restoreGone(v.slice(0, i), v.slice(i + 1)); }
});
