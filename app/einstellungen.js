/* Reiter „Kategorien“ und „Prioritäten“ (Gruppe Einstellungen).
   Gespeichert wird erst bei einer Änderung in state.settings.cfg = { cats, costCats, todoCats, listPrios, levels };
   solange eine Liste dort fehlt, gelten die Vorgaben unten.
   - cats (Packliste + Kaufen), costCats (Kosten), todoCats (To-dos), listPrios (Kaufen + To-dos): [{ id, name, color, sys? }]
     Einträge der Listen merken sich den NAMEN – beim Umbenennen werden sie deshalb mitgeändert.
     sys = von der App gebraucht (z. B. automatische Spritkosten): umbenennen ja, löschen nein.
   - levels (Panoramastraßen + Orte): [{ id, name, color, rule, stay, detour, ort, pano }], zugeordnet wird die ID.
     night = Orte dieser Stufe brauchen eine Übernachtung in der Nähe (fehlt das Feld, gilt es für „muss“), lesen über lvNight()
     rule: immer | kurz (immer, aber nur kurzer Stopp) | umweg (wenn der Umweg klein genug ist) | nie
   Reihenfolge = Wichtigkeit. Wird VOR lists.js geladen (nur Funktionen, gezeichnet wird über renderLists()). */
"use strict";

const CFG_DEFAULT = {
  cats: [["Dokumente & Geld", "#c9a227"], ["Auto", "#7b8a93"], ["Camping & Schlafen", "#3f8f5a"], ["Küche", "#e2731b"],
    ["Kleidung", "#3b74b8"], ["Hygiene & Gesundheit", "#c2453d"], ["Technik", "#7d55b5"], ["Sonstiges", "#2f9a9a", "Sonstiges"]],
  costCats: [["Sprit", "#7b8a93", "Sprit"], ["Fähren", "#e2731b", "Fähren"], ["Unterkunft", "#3b74b8", "Unterkunft"], ["Maut", "#c9a227", "Maut"],
    ["Essen", "#3f8f5a"], ["Aktivitäten", "#7d55b5"], ["Sonstiges", "#2f9a9a", "Sonstiges"]],
  todoCats: [],
  listPrios: [["Muss", "#c4402f"], ["Sollte", "#e2731b"], ["Nice-to-have", "#7b8a93"]]
};
const CFG_COLORS = ["#c2453d", "#e2731b", "#c9a227", "#3f8f5a", "#2f9a9a", "#3b74b8", "#7d55b5", "#b0488f", "#7b8a93", "#8d5a2b"];
const RULES = { immer: "immer einplanen", kurz: "immer, aber nur kurzer Stopp", umweg: "nur bei kleinem Umweg", nie: "nie einplanen" };

/* ---------- Lesen ---------- */
function defaultLevels() {
  const g = state?.settings?.gen || {};                // früher eingestellte Zeiten aus „Route aus Prioritäten“ übernehmen
  return [
    { id: "muss", name: "Muss", color: "#d32f2f", rule: "immer", stay: g.muss ?? 2, detour: 1.5, ort: true, pano: true, night: true },
    { id: "stop", name: "Kleiner Stop reicht", color: "#f57c00", rule: "kurz", stay: g.stop ?? 0.5, detour: 1.5, ort: true, pano: false },
    { id: "nice", name: "nice-to-have", color: "#f2c200", rule: "umweg", stay: g.stayNice ?? 1, detour: g.nice ?? 1.5, ort: true, pano: true },
    { id: "egal", name: "nicht unbedingt", color: "#8d5a2b", rule: "nie", stay: 1, detour: 1.5, ort: true, pano: true }
  ];
}
function cfgList(k) {
  const v = state?.settings?.cfg?.[k];
  let list = Array.isArray(v) && (v.length || k === "todoCats") ? v
    : k === "levels" ? defaultLevels()
    : CFG_DEFAULT[k].map(([name, color, sys], i) => ({ id: k + i, name, color, ...(sys ? { sys } : {}) }));
  if (k === "cats" && state?.pack) {                   // Kategorien, die nur an Einträgen stehen (alte Daten), nicht verlieren
    const known = new Set(list.map(c => c.name));
    const more = [...new Set([...state.pack, ...(state.buy || [])].map(i => i.cat))].filter(c => c && !known.has(c));
    if (more.length) list = [...list, ...more.map(name => ({ id: "x" + ortId(name), name, color: "#7b8a93" }))];
  }
  return list;
}
const ortId = s => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
const packCats = () => cfgList("cats"), costCats = () => cfgList("costCats"), todoCats = () => cfgList("todoCats"), listPrios = () => cfgList("listPrios");
const catColor = name => packCats().find(c => c.name === name)?.color;
const sysCat = (k, key) => (cfgList(k).find(c => c.sys === key) || { name: key }).name;   // heutiger Name einer festen Kategorie
const costSys = key => sysCat("costCats", key);
const listPrioRank = name => { const i = listPrios().findIndex(p => p.name === name); return i < 0 ? 999 : i; };
const prioLevels = kind => { const l = cfgList("levels"); return kind ? l.filter(x => x[kind]) : l; };
const prioLevel = id => cfgList("levels").find(l => l.id === id);
const lvNight = l => !!l && l.rule !== "nie" && (l.night ?? l.id === "muss");   // Übernachtung in der Nähe nötig?
const prioName = id => prioLevel(id)?.name || "";

/* ---------- Farben ---------- */
const rgbOf = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const lum = hex => { const [r, g, b] = rgbOf(hex).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
const inkOn = hex => { const l = lum(hex); return 1.05 / (l + .05) >= (l + .05) / .058 ? "#fff" : "#1b1203"; };   // besser lesbare Schrift
const DARK_PAIR = { "#d32f2f": "#ff5a52", "#f57c00": "#ff9838", "#f2c200": "#ffd83d", "#8d5a2b": "#b9824a" };
// Dunkle Farben im Dunkelmodus aufhellen
function themeColor(hex) {
  if (!isDark()) return hex;
  if (DARK_PAIR[hex]) return DARK_PAIR[hex];
  return lum(hex) > .3 ? hex : "#" + rgbOf(hex).map(v => Math.round(v + (255 - v) * .35).toString(16).padStart(2, "0")).join("");
}
const okColor = c => /^#[0-9a-f]{6}$/i.test(c);

/* ---------- Verwendung und Ändern ---------- */
function cfgUsers(k) {   // Einträge, die auf eine Kategorie/Priorität verweisen: [Objekt, Feld]
  if (k === "cats") return [...state.pack, ...state.buy].map(o => [o, "cat"]);
  if (k === "costCats") return state.costs.map(o => [o, "cat"]);
  if (k === "todoCats") return state.todos.map(o => [o, "cat"]);
  if (k === "listPrios") return [...state.buy, ...state.todos].map(o => [o, "prio"]);
  const s = state.settings;
  return [...["pano_prio", "ort_prio"].flatMap(f => Object.keys(s[f] || {}).map(id => [s[f], id])), ...(state.places || []).map(p => [p, "prio"])];
}
const cfgRef = (k, it) => k === "levels" ? it.id : it.name;
const cfgCount = (k, it) => cfgUsers(k).filter(([o, f]) => o[f] === cfgRef(k, it)).length;
function cfgReplace(k, from, to) {
  for (const [o, f] of cfgUsers(k)) if (o[f] === from) { if (to) o[f] = to; else delete o[f]; }
}
function cfgEdit(k) {    // Liste zum Ändern: beim ersten Mal aus den Vorgaben anlegen
  state.settings.cfg = state.settings.cfg || {};
  const list = cfgList(k);
  if (state.settings.cfg[k] !== list) state.settings.cfg[k] = clone(list);
  return state.settings.cfg[k];
}
function cfgDone(k) {
  save();
  renderLists(); updateStats();
  if (k === "levels") { if (!prioLevels().some(l => l.id === prioFilter.pano)) prioFilter.pano = "alle"; if (!prioLevels().some(l => l.id === prioFilter.ort)) prioFilter.ort = "alle"; redrawPrio(); }
}

/* ---------- Anzeige ---------- */
const CFG_PANELS = {
  kategorien: [
    ["costCats", "Kosten", "Sprit, Fähren, Unterkunft, Maut und Sonstiges braucht die App für ihre Schätzungen: umbenennen geht, löschen nicht."],
    ["cats", "Packliste und Kaufen", "Beide Reiter benutzen dieselben Kategorien. „Sonstiges“ bleibt immer."],
    ["todoCats", "To-dos", "Noch keine angelegt? Dann bleiben die To-dos eine einfache Liste. Sobald es hier Kategorien gibt, kannst du sie den Aufgaben geben (✎) und danach filtern."]
  ],
  prioritaeten: [
    ["levels", "Panoramastraßen und Orte", "Die Reihenfolge ist die Wichtigkeit (oben = am wichtigsten). Die Regel bestimmt, was „Route aus Prioritäten“ damit macht."],
    ["listPrios", "Kaufen und To-dos", "Die wichtigsten stehen im Reiter „Kaufen“ oben. To-dos bekommen eine Priorität über ✎."]
  ]
};
let cfgDel = null, cfgPending = false;
const cfgFocused = () => document.activeElement?.closest?.(".cfg") && document.activeElement.matches("input, select") ? document.activeElement : null;
function renderSettings() {
  if (!state || !document.getElementById("v-kategorien")) return;
  if (cfgFocused()) { cfgPending = true; return; }     // nicht unter dem Cursor neu zeichnen
  cfgPending = false;
  const drafts = [...document.querySelectorAll("form[data-cfgadd]")].map(f => [f.dataset.cfgadd, f.elements.name.value, f.elements.color.value]);
  for (const [view, panels] of Object.entries(CFG_PANELS)) {
    document.getElementById("cfg-" + view).innerHTML = panels.map(([k, title, hint]) => {
      const list = cfgList(k);
      return `<section class="panel cfgpanel"><h3>${title}</h3><p class="hint">${hint}</p>
        <div class="cfgrows">${list.map((it, i) => cfgRow(k, it, i, list.length)).join("") || `<p class="empty flat">Noch keine Kategorien.</p>`}</div>
        <p class="formerr" data-cfgerr="${k}"></p>
        <form class="cfgadd" data-cfgadd="${k}" autocomplete="off">
          <input type="color" name="color" aria-label="Farbe" value="${CFG_COLORS.find(c => !list.some(x => x.color.toLowerCase() === c)) || "#3b74b8"}">
          <input type="text" name="name" maxlength="40" aria-label="Neuer Name" placeholder="${k === "levels" || k === "listPrios" ? "Neue Priorität" : "Neue Kategorie"}">
          <button class="btn" type="submit">Hinzufügen</button>
        </form></section>`;
    }).join("");
  }
  for (const [k, name, color] of drafts) if (name) {
    const f = document.querySelector(`form[data-cfgadd="${k}"]`); f.elements.name.value = name; f.elements.color.value = color;
  }
}
function cfgRow(k, it, i, n) {
  const id = esc(`${k}|${it.id}`), cnt = cfgCount(k, it), canDel = !it.sys && !((k === "levels" || k === "listPrios") && n < 2);
  let h = `<div class="cfgrow" data-cfgrow="${id}">
    <input type="color" data-cf="color" value="${esc(it.color)}" aria-label="Farbe von ${esc(it.name)}">
    <input type="text" data-cf="name" maxlength="40" value="${esc(it.name)}" aria-label="Name">
    <span class="cnt">${cnt ? `${cnt} ${cnt === 1 ? "Eintrag" : "Einträge"}` : "unbenutzt"}</span>
    <span class="acts">
      <button type="button" class="btn ghost mini" data-cfgmove="${id}|-1" aria-label="${esc(it.name)} nach oben"${i ? "" : " disabled"}>↑</button>
      <button type="button" class="btn ghost mini" data-cfgmove="${id}|1" aria-label="${esc(it.name)} nach unten"${i < n - 1 ? "" : " disabled"}>↓</button>
      ${canDel ? `<button type="button" class="btn danger mini" data-cfgdel="${id}">Löschen</button>` : `<span class="cfgfix" title="Wird von der App gebraucht">fest</span>`}
    </span>`;
  if (k === "levels") h += `<div class="cfgrule">
      <label class="lbl">Beim Erstellen einer Route<select data-cf="rule">${Object.entries(RULES).map(([v, l]) => `<option value="${v}"${v === it.rule ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      ${it.rule === "nie" ? "" : `<label class="lbl">Zeit je Ort (h)<input type="number" data-cf="stay" min="0" max="12" step="0.25" inputmode="decimal" value="${it.stay}"></label>`}
      ${it.rule === "umweg" ? `<label class="lbl">Umweg höchstens (h)<input type="number" data-cf="detour" min="0" max="10" step="0.25" inputmode="decimal" value="${it.detour}"></label>` : ""}
      <span class="cfgfor"><label class="toggle"><input type="checkbox" data-cf="ort"${it.ort ? " checked" : ""}> Orte</label>
      <label class="toggle"><input type="checkbox" data-cf="pano"${it.pano ? " checked" : ""}> Panoramastraßen</label></span>
      ${it.ort && it.rule !== "nie" ? `<label class="toggle cfgnight"><input type="checkbox" data-cf="night"${lvNight(it) ? " checked" : ""}> 🌙 Orte brauchen eine Übernachtung in der Nähe</label>` : ""}</div>`;
  if (cfgDel === `${k}|${it.id}`) {
    const none = k === "todoCats" || k === "listPrios" || k === "levels";
    const pick = cfgList(k).filter(x => x.id !== it.id), dflt = pick.find(x => x.sys === "Sonstiges");
    h += `<div class="cfgdel">${cnt ? `<label class="lbl">${cnt} ${cnt === 1 ? "Eintrag bekommt" : "Einträge bekommen"} stattdessen<select data-cfgtarget>
        ${none ? `<option value="">– ohne –</option>` : ""}${pick.map(x => `<option value="${esc(cfgRef(k, x))}"${x === dflt ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>` : `<span>„${esc(it.name)}“ wirklich löschen?</span>`}
      <span class="acts"><button type="button" class="btn danger mini" data-cfgdelok="${id}">Ja, löschen</button><button type="button" class="btn ghost mini" data-cfgdelno>Abbrechen</button></span></div>`;
  }
  return h + `</div>`;
}
function cfgErr(k, msg) { const el = document.querySelector(`[data-cfgerr="${k}"]`); if (el) el.textContent = msg; }
const cfgDup = (k, name, id) => cfgList(k).some(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase());
function cfgForce() { document.activeElement?.blur?.(); renderSettings(); }

/* ---------- Ereignisse ---------- */
document.addEventListener("focusout", e => {
  if (e.target.closest?.(".cfg")) setTimeout(() => { if (cfgPending && !cfgFocused()) renderSettings(); }, 0);
});
document.addEventListener("change", e => {
  const f = e.target.closest("[data-cf]"); if (!f) return;
  const [k, id] = f.closest("[data-cfgrow]").dataset.cfgrow.split("|"), field = f.dataset.cf;
  const cur = cfgList(k).find(x => x.id === id); if (!cur) return;
  let v = f.type === "checkbox" ? f.checked : f.value;
  const back = msg => { cfgErr(k, msg); if (f.type === "checkbox") f.checked = cur[field]; else f.value = cur[field]; };
  if (field === "name") {
    v = v.trim();
    if (!v) return back("Der Name darf nicht leer sein.");
    if (cfgDup(k, v, id)) return back(`„${v}“ gibt es schon.`);
  }
  if (field === "color" && !okColor(v)) return back("Ungültige Farbe.");
  if (field === "stay" || field === "detour") {
    v = parseFloat(String(v).replace(",", ".")); if (!(v >= 0 && v <= 12)) return back("Bitte eine Zahl zwischen 0 und 12 eingeben.");
  }
  if ((field === "ort" || field === "pano") && !v && cfgList(k).filter(x => x[field]).length < 2) return back("Mindestens eine Priorität muss bleiben.");
  cfgErr(k, "");
  if (cur[field] === v) return;
  const it = cfgEdit(k).find(x => x.id === id), old = it.name;
  it[field] = v;
  if (field === "name" && k !== "levels") {
    cfgReplace(k, old, v);
    for (const s of [closedGroups, closedCostGroups]) if (s.delete(old)) s.add(v);
    if (todoFilter === old) todoFilter = "";
  }
  cfgDone(k);
  if (field === "rule" || f.type === "checkbox") cfgForce();
});
document.addEventListener("submit", e => {
  const f = e.target.closest("form[data-cfgadd]"); if (!f) return;
  e.preventDefault();
  const k = f.dataset.cfgadd, name = f.elements.name.value.trim(), color = f.elements.color.value;
  if (!name) return cfgErr(k, "Gib einen Namen ein.");
  if (cfgDup(k, name)) return cfgErr(k, `„${name}“ gibt es schon.`);
  const list = cfgEdit(k), it = { id: nid("g"), name, color: okColor(color) ? color : "#3b74b8" };
  if (k === "levels") Object.assign(it, { rule: "umweg", stay: 1, detour: 1.5, ort: true, pano: true });
  const end = list.findIndex(x => x.sys === "Sonstiges");       // „Sonstiges“ bleibt am Ende
  list.splice(end === list.length - 1 && end >= 0 ? end : list.length, 0, it);
  f.elements.name.value = ""; cfgErr(k, "");
  document.activeElement?.blur(); cfgDone(k);
});
document.addEventListener("click", e => {
  const m = e.target.closest("[data-cfgmove]");
  if (m) {
    const [k, id, by] = m.dataset.cfgmove.split("|"), list = cfgEdit(k), i = list.findIndex(x => x.id === id), j = i + +by;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    cfgDone(k); document.querySelector(`[data-cfgmove="${CSS.escape(m.dataset.cfgmove)}"]`)?.focus();
    return;
  }
  const d = e.target.closest("[data-cfgdel]");
  if (d) { cfgDel = d.dataset.cfgdel; cfgForce(); return; }
  if (e.target.closest("[data-cfgdelno]")) { cfgDel = null; cfgForce(); return; }
  const ok = e.target.closest("[data-cfgdelok]");
  if (ok) {
    const [k, id] = ok.dataset.cfgdelok.split("|"), it = cfgList(k).find(x => x.id === id); cfgDel = null;
    if (!it || it.sys) return cfgForce();
    const to = ok.closest(".cfgdel").querySelector("[data-cfgtarget]")?.value || null;
    const list = cfgEdit(k);
    cfgReplace(k, cfgRef(k, it), to);
    state.settings.cfg[k] = list.filter(x => x.id !== id);
    if (todoFilter === it.name) todoFilter = "";
    document.activeElement?.blur(); cfgDone(k);
  }
});
