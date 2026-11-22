/* Reiter Kosten, To-dos, Packliste, Kaufen. Kategorien und Prioritäten kommen aus einstellungen.js.
   Alle Daten liegen in "state" (costs, todos, pack, buy, settings.main) und werden über save()
   im Browser und – wenn angemeldet – in der Cloud gespeichert. */
"use strict";

const DEFAULT_MAIN = { persons: 2, consumption: 8, fuelPrice: 2.4, autoFuel: true, autoToll: true, tollNok: 30 };

const closedGroups = new Set(), closedCostGroups = new Set();   // zugeklappte Gruppen
let editingBuy = null, editingRow = null, rowDraft = {}, todoFilter = "";

const euro = n => (Math.round((n || 0) * 100) / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: n % 1 ? 2 : 0 });
const nid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const main = () => Object.assign({}, DEFAULT_MAIN, state.settings?.main);
function safeUrl(u) { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } }
function host(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }

/* ================= Daten vereinheitlichen =================
   Die alte Claude-Seite hat Pack- und Kaufliste anders gespeichert (items_packen, items_kaufen).
   Das wird einmalig in "pack" und "buy" umgewandelt. Gibt true zurück, wenn etwas geändert wurde. */
function normalizeState(s) {
  if (!s) return false;
  let changed = false;
  for (const k of ["costs", "todos"]) if (!Array.isArray(s[k])) { s[k] = []; changed = true; }
  if (!Array.isArray(s.pack)) {
    s.pack = [];
    let n = 0;
    for (const [cat, list] of Object.entries(s.items_packen || {})) {
      for (const raw of list) s.pack.push({ id: "p" + String(++n).padStart(3, "0"), cat, ...parsePackText(raw), done: false });
    }
    delete s.items_packen; changed = true;
  }
  if (!Array.isArray(s.buy)) {
    s.buy = (s.items_kaufen || []).map(i => ({ id: i.id, cat: i.cat, name: i.name, prio: i.prio || "Sollte",
      price: i.price ?? null, link: i.link || null, note: i.note && i.note !== "Vorschlag" ? i.note : null, done: !!i.done }));
    delete s.items_kaufen; changed = true;
  }
  s.settings = s.settings || {};
  if (typeof normalizeRouteList === "function" && normalizeRouteList(s)) changed = true;   // gespeicherte Routen (varianten.js)
  if (!s.settings.main) { s.settings.main = { ...DEFAULT_MAIN }; changed = true; }
  return changed;
}
// "Schlafsäcke (1 p. P.) – Nächte im Norden um 5–10 °C" → Name, Menge, Notiz
function parsePackText(raw) {
  let [name, ...rest] = String(raw).split(" – ");
  const note = rest.join(" – ").trim() || null;
  let qty = "1";
  const m = name.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (m) { name = m[1]; qty = m[2]; }
  return { name: name.trim(), qty, note };
}

/* ================= Gemeinsame Bausteine ================= */
const CHECK_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const chk = (kind, id, done, label) =>
  `<button type="button" class="chk" role="checkbox" aria-checked="${done ? "true" : "false"}" aria-label="${esc(label)}" data-chk="${kind}:${esc(id)}">${CHECK_SVG}</button>`;
const rmBtn = (kind, id, label) =>
  `<button type="button" class="del" data-rm="${kind}:${esc(id)}" aria-label="${esc(label)} löschen">Löschen</button>`;
const coll = kind => ({ costs: state.costs, todos: state.todos, pack: state.pack, buy: state.buy, places: state.places }[kind]);
const findItem = (kind, id) => coll(kind)?.find(x => x.id === id);
function commit() { save(); renderLists(); }

/* ================= Zeilen bearbeiten (Kosten, To-dos, Packliste) ================= */
const rowBusy = () => editingRow && document.activeElement?.closest("form[data-rowsave]") && document.activeElement.matches("input, select");
const pills = t => (t.prio || t.cat) ? `<span class="pills">${t.prio ? `<span class="pill"${pcStyle(t.prio)}>${esc(t.prio)}</span>` : ""}${t.cat ? `<span class="pill"><i class="pdot" style="background:${todoCats().find(c => c.name === t.cat)?.color || "var(--muted)"}"></i> ${esc(t.cat)}</span>` : ""}</span>` : "";
function rowActs(kind, it, label) {
  const key = `${kind}:${it.id}`;
  let h = `<span class="rowacts"><button type="button" class="del" data-rowedit="${esc(key)}" aria-label="${esc(label)} bearbeiten">✎</button>${rmBtn(kind, it.id, label)}</span>`;
  if (editingRow !== key) return h;
  const v = { ...it, ...rowDraft }, txt = (n, l, max) => `<label class="lbl">${l}<input type="text" name="${n}" maxlength="${max}" value="${esc(v[n] ?? "")}"></label>`;
  const sel = (n, l, list, none) => `<label class="lbl">${l}<select name="${n}">${nameOpts(list, v[n], none)}</select></label>`;
  const f = kind === "costs" ? txt("title", "Name", 80) + sel("cat", "Kategorie", costCats())
      + `<label class="lbl">Tag<select name="dayId"><option value="">– kein Tag –</option>${sortedDays().map(d => `<option value="${esc(d.id)}"${d.id === v.dayId ? " selected" : ""}>${fmtDate(d.date)} · ${esc(d.night || d.title)}</option>`).join("")}</select></label>` + txt("note", "Notiz", 200)
    : kind === "todos" ? txt("title", "Aufgabe", 120) + `<label class="lbl">Bis wann?<input type="date" name="due" value="${esc(v.due || "")}"></label>` + sel("prio", "Priorität", listPrios(), "– ohne –") + (todoCats().length ? sel("cat", "Kategorie", todoCats(), "– ohne –") : "") + txt("note", "Notiz", 200)
    : txt("name", "Gegenstand", 80) + txt("qty", "Menge", 12) + sel("cat", "Kategorie", packCats()) + txt("note", "Notiz", 200);
  return h + `<form class="edit rowedit" data-rowsave="${esc(key)}" autocomplete="off"><div class="two">${f}</div><p class="formerr" data-err></p>
    <div class="acts"><button class="btn mini" type="submit">Speichern</button><button class="btn ghost mini" type="button" data-rowcancel>Abbrechen</button></div></form>`;
}
function renderRows() { renderCosts(); renderTodos(); renderPack(); }
document.addEventListener("input", e => { const f = e.target.closest("form[data-rowsave]"); if (f && e.target.name) rowDraft[e.target.name] = e.target.value; });
document.addEventListener("click", e => {
  const b = e.target.closest("[data-rowedit]");
  if (b) {
    document.activeElement?.blur(); editingRow = editingRow === b.dataset.rowedit ? null : b.dataset.rowedit; rowDraft = {}; renderRows();
    document.querySelector("form[data-rowsave]")?.scrollIntoView({ block: "nearest" }); return;
  }
  if (e.target.closest("[data-rowcancel]")) { editingRow = null; rowDraft = {}; renderRows(); }
});
document.addEventListener("submit", e => {
  const f = e.target.closest("form[data-rowsave]"); if (!f) return;
  e.preventDefault();
  const [kind, id] = f.dataset.rowsave.split(":"), it = findItem(kind, id); if (!it) return;
  const o = Object.fromEntries([...f.elements].filter(x => x.name).map(x => [x.name, x.value.trim()])), req = kind === "pack" ? "name" : "title";
  if (!o[req]) { f.querySelector("[data-err]").textContent = "Der Name fehlt."; return; }
  for (const [k, v] of Object.entries(o)) {
    if (kind === "pack" && k === "qty") it.qty = v || "1";
    else if (v) it[k] = v;
    else if (k === "prio" || (k === "cat" && kind === "todos")) delete it[k];
    else if (it[k] != null && k !== "cat") it[k] = null;
  }
  editingRow = null; rowDraft = {}; document.activeElement?.blur();
  if (kind === "costs") closedCostGroups.delete(it.cat);
  if (kind === "pack") closedGroups.delete(it.cat);
  commit(); updateStats();
});

/* ================= Reiter ================= */
const VIEWS = ["route", "panorama", "erleben", "orte", "himmel", "tagebuch", "kosten", "todos", "packen", "kaufen", "kategorien", "prioritaeten"];
// Gruppen: Planen / Unterwegs / Organisieren / Einstellungen. Pro Gruppe wird der zuletzt benutzte Reiter gemerkt.
const lastInGroup = (() => { try { return JSON.parse(localStorage.getItem("nordtour.tabs")) || {}; } catch { return {}; } })();
function showView() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "route";
  for (const x of VIEWS) $("#v-" + x).hidden = x !== v;
  document.querySelectorAll("nav.tabs a").forEach(a => a.setAttribute("aria-current", a.dataset.view === v ? "page" : "false"));
  const grp = document.querySelector(`nav.tabs a[data-view="${v}"]`)?.closest(".tgroup")?.dataset.group;
  document.querySelectorAll(".tgroup").forEach(g => g.classList.toggle("cur", g.dataset.group === grp));
  document.querySelectorAll("[data-gbar]").forEach(b => b.setAttribute("aria-current", b.dataset.gbar === grp ? "page" : "false"));
  if (grp) { lastInGroup[grp] = v; try { localStorage.setItem("nordtour.tabs", JSON.stringify(lastInGroup)); } catch { /* egal */ } }
  document.querySelector(`nav.tabs a[data-view="${v}"]`)?.scrollIntoView({ inline: "center", block: "nearest" });   // aktiven Reiter sichtbar machen
  if (v === "route") setTimeout(() => map.invalidateSize(), 0);
}
window.addEventListener("hashchange", showView);
document.addEventListener("click", e => {
  const b = e.target.closest("[data-gbar]"); if (!b) return;
  const g = b.dataset.gbar, first = document.querySelector(`.tgroup[data-group="${g}"] a`)?.dataset.view;
  location.hash = "#" + (lastInGroup[g] || first);
  window.scrollTo({ top: 0 });
});

/* ================= Kosten ================= */
// Leere Übernachtungs-Platzhalter aus der alten Planung (Unterkunft ohne Betrag, Notiz, Häkchen):
// Die meisten Nächte wird wild gecampt – solche Posten werden zusammengefasst statt einzeln gezeigt.
const isNightPlaceholder = c => c.cat === costSys("Unterkunft") && c.amount == null && !c.note && !c.done;
// „Maut Norwegen“ ohne Betrag ersetzt die automatische Schätzung
const isTollPlaceholder = c => c.cat === costSys("Maut") && c.amount == null && /^maut norwegen$/i.test(c.title || "") && main().autoToll;
let showNightPh = false;
function fuelCost() { const m = main(); return routeTotals().km * (Number(m.consumption) || 0) / 100 * (Number(m.fuelPrice) || 0); }
function costSummary() {
  const m = main(), persons = Math.max(1, parseInt(m.persons, 10) || 1);
  const byCat = Object.fromEntries(costCats().map(c => [c.name, 0])), rest = costSys("Sonstiges");
  let total = 0, open = 0, missing = 0;
  for (const c of activeCosts()) {
    const a = Number(c.amount) || 0;
    byCat[c.cat in byCat ? c.cat : rest] += a; total += a; if (!c.done) open += a;
    if (c.amount == null && !isNightPlaceholder(c) && !isTollPlaceholder(c)) missing++;
  }
  if (m.autoFuel) { const f = fuelCost(); byCat[costSys("Sprit")] += f; total += f; open += f; }
  if (m.autoToll && typeof tollTotals === "function") { const t = tollTotals().eur; byCat[costSys("Maut")] += t; total += t; open += t; }
  return { total, open, byCat, persons, missing };
}
function renderCostTop() {
  const s = costSummary(), m = main(), t = routeTotals();
  $("#cTotal").textContent = euro(s.total);
  $("#cPP").textContent = euro(s.total / s.persons);
  $("#cPPl").textContent = `Pro Person (${s.persons})`;
  $("#cOpen").textContent = euro(s.open);
  $("#cMissing").textContent = s.missing ? `${s.missing} Posten noch ohne Betrag` : "";
  const max = Math.max(1, ...Object.values(s.byCat));
  $("#cBars").innerHTML = costCats().map(({ name: c, color: col }) => `<div class="cbar"><span>${esc(c)}</span><span class="tr"><i style="width:${(s.byCat[c] / max * 100).toFixed(1)}%;background:${col}"></i></span><span class="am">${euro(s.byCat[c])}</span></div>`).join("");
  const liters = t.km * (Number(m.consumption) || 0) / 100;
  $("#fuelRes").textContent = t.km ? `${num(t.km)} km × ${String(m.consumption).replace(".", ",")} l/100 km = ${num(liters)} l ≈ ${euro(fuelCost())}` : "Noch keine Strecke berechnet.";
  if (!document.activeElement?.closest("#fuelForm")) {
    $("#sPersons").value = m.persons; $("#sCons").value = m.consumption; $("#sPrice").value = m.fuelPrice; $("#sAuto").checked = !!m.autoFuel;
    $("#sToll").value = m.tollNok; $("#sAutoToll").checked = !!m.autoToll;
  }
  document.querySelectorAll("[data-ccat]").forEach(g => { const c = g.querySelector(".cnt"); if (c) c.textContent = euro(s.byCat[g.dataset.ccat]); });
}
function renderCosts() {
  renderCostTop();
  if (document.activeElement?.matches("[data-amount]") || rowBusy()) return;   // nicht unter dem Cursor neu zeichnen
  const s = costSummary(), m = main();
  const dayById = Object.fromEntries(state.days.map(d => [d.id, d]));
  let html = "";
  const rest = costSys("Sonstiges"), known = new Set(costCats().map(c => c.name));
  for (const { name: cat, color: col, sys } of costCats()) {
    const all = activeCosts().filter(c => (known.has(c.cat) ? c.cat : rest) === cat);
    const ph = all.filter(isNightPlaceholder);
    const rows = all.filter(c => (showNightPh || !isNightPlaceholder(c)))
      .sort((a, b) => String(dayById[a.dayId]?.date || "9").localeCompare(String(dayById[b.dayId]?.date || "9")));
    const autoToll = sys === "Maut" && m.autoToll && typeof tollTotals === "function";
    const auto = (sys === "Sprit" && m.autoFuel) || autoToll;
    if (!rows.length && !auto && !ph.length) continue;
    html += `<details class="group" data-ccat="${esc(cat)}"${closedCostGroups.has(cat) ? "" : " open"}>
      <summary><span class="dot" style="background:${col}"></span>${esc(cat)}<span class="cnt">${euro(s.byCat[cat])}</span></summary><div class="rows">`;
    if (autoToll) {
      const t = tollTotals();
      html += `<div class="crow auto"><span></span><span class="nm">Maut Norwegen (grobe Schätzung)<span class="nt">${t.n} Mautstellen an der Strecke × ${num(m.tollNok)} NOK${t.open ? ` · ${t.open} Etappen noch nicht ausgewertet` : ""} · ersetzt den Posten „Maut Norwegen“, solange dort kein Betrag steht · <a href="https://www.autopass.no/" target="_blank" rel="noopener">AutoPASS</a></span></span><span class="amtv">${euro(t.eur)}</span><span></span></div>`;
    }
    if (auto && sys === "Sprit") html += `<div class="crow auto"><span></span><span class="nm">Sprit für die ganze Strecke<span class="nt">automatisch aus ${num(routeTotals().km)} km berechnet</span></span><span class="amtv">${euro(fuelCost())}</span><span></span></div>`;
    html += rows.map(c => {
      const d = dayById[c.dayId];
      const sub = [d ? `${fmtDate(d.date)} · ${d.title || ""}` : "", c.note || ""].filter(Boolean).join(" – ");
      return `<div class="crow${c.done ? " done" : ""}">
        ${chk("costs", c.id, c.done, c.title + " bezahlt")}
        <span class="nm">${esc(c.title)}${sub ? `<span class="nt">${esc(sub)}</span>` : ""}</span>
        <input type="number" class="amt" min="0" step="0.01" inputmode="decimal" aria-label="Betrag für ${esc(c.title)} in Euro" placeholder="€" data-amount="${esc(c.id)}" value="${c.amount ?? ""}">
        ${rowActs("costs", c, c.title)}
      </div>`;
    }).join("");
    if (ph.length) html += `<div class="crow ph"><span></span><span class="nm">${ph.length} Nächte ohne Unterkunft – Wildcampen<span class="nt">leere Platzhalter aus der alten Planung, zählen nicht als „ohne Betrag“</span></span>
      <span class="acts"><button type="button" class="btn ghost mini" data-phtoggle>${showNightPh ? "ausblenden" : "einzeln zeigen"}</button><button type="button" class="btn ghost mini" data-phdel>alle entfernen</button></span><span></span></div>`;
    html += `</div></details>`;
  }
  const away = state.costs.length - activeCosts().length;
  if (away) html += `<p class="hint">${away} Posten gehören zu Tagen anderer gespeicherter Routen und zählen hier nicht mit.</p>`;
  $("#costGroups").innerHTML = html || `<p class="empty">Noch keine Kosten eingetragen.</p>`;
  if (typeof renderFerryCheck === "function") renderFerryCheck();
}
document.addEventListener("change", e => {
  const t = e.target.closest("[data-amount]");
  if (t) {
    const c = findItem("costs", t.dataset.amount); if (!c) return;
    const v = t.value === "" ? null : Math.max(0, Math.round(parseFloat(t.value.replace(",", ".")) * 100) / 100);
    if ((c.amount ?? null) === v || Number.isNaN(v)) return;
    c.amount = v; save(); renderCostTop(); updateStats();
    return;
  }
  const p = e.target.closest("[data-prio]");
  if (p) { const i = findItem("buy", p.dataset.prio); if (i) { i.prio = p.value; commit(); } }
});
$("#fuelForm").addEventListener("submit", e => {
  e.preventDefault();
  const persons = parseInt($("#sPersons").value, 10), consumption = parseFloat($("#sCons").value), fuelPrice = parseFloat($("#sPrice").value);
  const tollNok = parseFloat($("#sToll").value);
  if (!(persons >= 1) || !(consumption > 0) || !(fuelPrice > 0) || !(tollNok >= 0)) { $("#fErr").textContent = "Bitte alle Werte ausfüllen."; return; }
  $("#fErr").textContent = "";
  state.settings.main = { ...main(), persons, consumption, fuelPrice, autoFuel: $("#sAuto").checked, tollNok, autoToll: $("#sAutoToll").checked };
  document.activeElement?.blur(); commit(); updateStats();
});
$("#sAuto").addEventListener("change", () => $("#fuelForm").requestSubmit());
$("#sAutoToll").addEventListener("change", () => $("#fuelForm").requestSubmit());

document.addEventListener("click", e => {
  if (e.target.closest("[data-phtoggle]")) { showNightPh = !showNightPh; renderCosts(); return; }
  if (e.target.closest("[data-phdel]")) {
    const mine = new Set(activeCosts().filter(isNightPlaceholder).map(c => c.id)), n = mine.size;
    if (!confirm(`${n} leere Übernachtungs-Posten entfernen? Nächte mit Betrag oder Notiz bleiben erhalten.`)) return;
    state.costs = state.costs.filter(c => !mine.has(c.id)); showNightPh = false; commit(); updateStats();
    notice(`${n} leere Übernachtungs-Posten entfernt. Eine Unterkunft trägst du bei Bedarf unten unter „Neuer Kostenposten“ mit Kategorie Unterkunft und dem Tag ein.`);
  }
});

/* ================= To-dos ================= */
function renderTodos() {
  if (rowBusy()) return;
  const cats = todoCats();
  if (todoFilter && !cats.some(c => c.name === todoFilter)) todoFilter = "";
  $("#todoChips").innerHTML = cats.length ? [{ name: "", label: "Alle" }, ...cats].map(c => `<button type="button" class="fchip" data-todofilter="${esc(c.name)}" aria-pressed="${todoFilter === c.name}">${c.color ? `<i class="pdot" style="background:${c.color}"></i>` : ""}${esc(c.label || c.name)} <b>${state.todos.filter(t => !t.done && (!c.name || t.cat === c.name)).length}</b></button>`).join("") : "";
  $("#tCatLbl").hidden = !cats.length;
  const onlyOpen = $("#todoOpen").checked;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const list = [...state.todos].sort((a, b) => (a.done - b.done) || String(a.due || "9999").localeCompare(String(b.due || "9999")) || listPrioRank(a.prio) - listPrioRank(b.prio))
    .filter(t => (!onlyOpen || !t.done) && (!todoFilter || t.cat === todoFilter));
  $("#todoRows").innerHTML = list.length ? list.map(t => {
    let cls = "", label = "";
    if (t.due) {
      const d = new Date(t.due + "T12:00:00"), diff = Math.floor((d - today) / 864e5);
      label = d.toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "numeric" });
      if (!t.done && diff < 0) { cls = "late"; label = "überfällig · " + label; }
      else if (!t.done && diff <= 30) cls = "soon";
    }
    return `<div class="todo-row${t.done ? " done" : ""}">
      ${chk("todos", t.id, t.done, t.title + " erledigt")}
      <span class="nm">${esc(t.title)}${t.note ? `<span class="nt">${esc(t.note)}</span>` : ""}${pills(t)}</span>
      <span class="due ${cls}">${esc(label)}</span>
      ${rowActs("todos", t, t.title)}
    </div>`;
  }).join("") : `<p class="empty flat">${state.todos.length ? (todoFilter ? "Nichts in dieser Kategorie." : "Alles erledigt!") : "Noch keine Aufgaben."}</p>`;
}
$("#todoOpen").addEventListener("change", renderTodos);
document.addEventListener("click", e => { const b = e.target.closest("[data-todofilter]"); if (b) { todoFilter = b.dataset.todofilter; renderTodos(); } });

/* ================= Packliste ================= */
function renderPack() {
  if (rowBusy()) return;
  const onlyOpen = $("#onlyOpen").checked;
  let html = "";
  for (const { name: cat, color } of packCats()) {
    const all = state.pack.filter(i => i.cat === cat);
    if (!all.length) continue;
    const done = all.filter(i => i.done).length, show = onlyOpen ? all.filter(i => !i.done) : all;
    html += `<details class="group" data-cat="${esc(cat)}"${closedGroups.has(cat) ? "" : " open"}>
      <summary><span class="dot" style="background:${color}"></span>${esc(cat)}
      <span class="cnt${done === all.length ? " full" : ""}">${done}/${all.length}</span></summary>
      <div class="rows">${show.length ? show.map(i => `<div class="row${i.done ? " done" : ""}">
        ${chk("pack", i.id, i.done, i.name + " eingepackt")}
        <span class="nm">${esc(i.name)}${i.note ? `<span class="nt">${esc(i.note)}</span>` : ""}</span>
        <span class="qty">${esc(i.qty ?? "")}</span>
        ${rowActs("pack", i, i.name)}
      </div>`).join("") : `<div class="row"><span></span><span class="nt">Alles eingepackt.</span></div>`}</div></details>`;
  }
  $("#packGroups").innerHTML = html || `<p class="empty">Die Packliste ist noch leer.</p>`;
  const n = state.pack.length, d = state.pack.filter(i => i.done).length;
  $("#packReset").hidden = !d;
  $("#packSum").textContent = n ? `${d} von ${n} eingepackt` : "";
}
$("#onlyOpen").addEventListener("change", renderPack);
$("#packReset").addEventListener("click", () => {
  if (!confirm("Alle Häkchen in der Packliste entfernen (z. B. für die Rückfahrt)?")) return;
  state.pack.forEach(i => { i.done = false; }); commit();
});
document.addEventListener("toggle", e => {
  const g = e.target.closest?.(".group"); if (!g) return;
  if (g.dataset.cat) g.open ? closedGroups.delete(g.dataset.cat) : closedGroups.add(g.dataset.cat);
  if (g.dataset.ccat) g.open ? closedCostGroups.delete(g.dataset.ccat) : closedCostGroups.add(g.dataset.ccat);
}, true);

/* ================= Kaufen ================= */
function renderBuy() {
  if (editingBuy && document.activeElement?.closest("form[data-buysave]")) return;
  const sort = (a, b) => listPrioRank(a.prio) - listPrioRank(b.prio);
  const open = state.buy.filter(i => !i.done).sort(sort), done = state.buy.filter(i => i.done).sort(sort);
  $("#buyOpen").innerHTML = open.length ? open.map(buyCard).join("") : `<p class="empty wide">Nichts mehr offen.</p>`;
  $("#buyDone").innerHTML = done.map(buyCard).join("");
  $("#buyDoneHead").hidden = !done.length;
  const tot = state.buy.reduce((a, i) => a + (Number(i.price) || 0), 0), spent = done.reduce((a, i) => a + (Number(i.price) || 0), 0);
  $("#buySum").textContent = tot ? `Geplant ${euro(tot)} · davon gekauft ${euro(spent)}` : "Trag Preise ein, dann wird hier zusammengerechnet.";
}
const nameOpts = (list, sel, none) => (none || !list.some(x => x.name === sel) ? `<option value="">${none || "– ohne –"}</option>` : "") + list.map(x => `<option${x.name === sel ? " selected" : ""}>${esc(x.name)}</option>`).join("");
const prioOpts = sel => nameOpts(listPrios(), sel);
const pcStyle = name => { const c = listPrios().find(p => p.name === name)?.color; return c ? ` style="--pc:${c};--pi:${inkOn(c)}"` : ""; };
function buyCard(i) {
  const url = safeUrl(i.link);
  const price = Number(i.price) ? `<span class="price">${euro(Number(i.price))}</span>` : `<span class="price none">Preis offen</span>`;
  const inPack = state.pack.some(p => p.name.toLowerCase() === String(i.name).toLowerCase());
  let h = `<article class="card bcard${i.done ? " bought" : ""}"${pcStyle(i.prio)}>
    <div class="hd">${chk("buy", i.id, i.done, i.name + " gekauft")}
      <span class="nm">${esc(i.name)}${i.note ? `<span class="nt">${esc(i.note)}</span>` : ""}</span>${price}</div>
    <div class="pills"><label class="prio-sel pill"${pcStyle(i.prio)}><span class="sr">Priorität für ${esc(i.name)}</span><select data-prio="${esc(i.id)}">${prioOpts(i.prio)}</select></label>${i.cat ? `<span class="pill">${catColor(i.cat) ? `<i class="pdot" style="background:${catColor(i.cat)}"></i> ` : ""}${esc(i.cat)}</span>` : ""}${i.done ? `<span class="pill ok">Gekauft</span>` : ""}</div>
    <div class="acts">
      ${url ? `<a class="shop" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Zum Shop ↗ <small>${esc(host(url))}</small></a>` : `<span class="nolink">Noch kein Shop-Link</span>`}
      <button type="button" class="btn ghost mini" data-buyedit="${esc(i.id)}">Bearbeiten</button>
      ${i.done && !inPack ? `<button type="button" class="btn ghost mini" data-topack="${esc(i.id)}">In Packliste</button>` : ""}
      ${rmBtn("buy", i.id, i.name)}
    </div>`;
  if (editingBuy === i.id) {
    h += `<form class="edit" data-buysave="${esc(i.id)}" autocomplete="off">
      <label class="lbl">Name<input type="text" name="name" maxlength="80" value="${esc(i.name)}"></label>
      <div class="two">
        <label class="lbl">Priorität<select name="prio">${prioOpts(i.prio)}</select></label>
        <label class="lbl">Preis (€)<input type="number" name="price" min="0" step="0.01" value="${Number(i.price) || ""}"></label>
      </div>
      <label class="lbl">Kategorie<select name="cat">${nameOpts(packCats(), i.cat)}</select></label>
      <label class="lbl">Shop-Link<input type="url" name="link" value="${esc(i.link || "")}" placeholder="https://…"></label>
      <label class="lbl">Notiz<input type="text" name="note" maxlength="140" value="${esc(i.note || "")}"></label>
      <p class="formerr" data-err></p>
      <div class="acts"><button class="btn mini" type="submit">Speichern</button><button class="btn ghost mini" type="button" data-buycancel>Abbrechen</button></div>
    </form>`;
  }
  return h + `</article>`;
}
$("#v-kaufen").addEventListener("submit", e => {
  const f = e.target.closest("form[data-buysave]"); if (!f) return;
  e.preventDefault();
  const i = findItem("buy", f.dataset.buysave), el = f.elements;
  const name = el.name.value.trim(), link = el.link.value.trim(), price = parseFloat(el.price.value);
  if (!name) { f.querySelector("[data-err]").textContent = "Der Name fehlt."; return; }
  if (link && !safeUrl(link)) { f.querySelector("[data-err]").textContent = "Der Link muss mit https:// beginnen."; return; }
  Object.assign(i, { name, prio: el.prio.value, cat: el.cat.value, price: isFinite(price) ? price : null, link: link || null, note: el.note.value.trim() || null });
  editingBuy = null; document.activeElement?.blur(); commit();
});

/* ================= Klicks (Häkchen, Löschen, Bearbeiten) ================= */
let armedRm = null, armTimer = null;
document.addEventListener("click", e => {
  const c = e.target.closest("[data-chk]");
  if (c) {
    const [kind, id] = c.dataset.chk.split(":"), it = findItem(kind, id);
    if (it) { it.done = !it.done; commit(); updateStats(); }
    return;
  }
  const r = e.target.closest("[data-rm]");
  if (r) {
    if (armedRm !== r.dataset.rm) {                 // erster Klick: nachfragen
      document.querySelectorAll(".del.arm").forEach(b => { b.classList.remove("arm"); b.textContent = "Löschen"; });
      armedRm = r.dataset.rm; r.classList.add("arm"); r.textContent = "Wirklich?";
      clearTimeout(armTimer); armTimer = setTimeout(() => { armedRm = null; r.classList.remove("arm"); r.textContent = "Löschen"; }, 3000);
      return;
    }
    const [kind, id] = r.dataset.rm.split(":"), arr = coll(kind), ix = arr.findIndex(x => x.id === id);
    armedRm = null;
    if (ix >= 0) { arr.splice(ix, 1); commit(); updateStats(); }
    return;
  }
  const be = e.target.closest("[data-buyedit]");
  if (be) { editingBuy = be.dataset.buyedit; renderBuy(); document.querySelector("form[data-buysave] input")?.focus(); return; }
  if (e.target.closest("[data-buycancel]")) { editingBuy = null; renderBuy(); return; }
  const tp = e.target.closest("[data-topack]");
  if (tp) {
    const i = findItem("buy", tp.dataset.topack);
    if (i) { const cat = catColor(i.cat) ? i.cat : sysCat("cats", "Sonstiges"); state.pack.push({ id: nid("p"), cat, name: i.name, qty: "1", note: null, done: false }); closedGroups.delete(cat); commit(); notice(`„${esc(i.name)}“ steht jetzt in der Packliste unter ${esc(cat)}.`); }
  }
});

/* ================= Hinzufügen ================= */
function addForm(sel, errSel, build) {
  $(sel).addEventListener("submit", e => {
    e.preventDefault();
    const r = build();
    if (typeof r === "string") { $(errSel).textContent = r; return; }
    $(errSel).textContent = "";
    r.push(); r.reset?.(); commit(); updateStats();
  });
}
addForm("#addCost", "#kErr", () => {
  const title = $("#kTitle").value.trim(), amt = parseFloat($("#kAmt").value);
  if (!title) return "Gib einen Namen für den Posten ein.";
  const cat = $("#kCat").value; closedCostGroups.delete(cat);
  return { push: () => state.costs.push({ id: nid("c"), cat, dayId: $("#kDay").value || null, title, amount: isFinite(amt) ? amt : null }),
    reset: () => { $("#kTitle").value = ""; $("#kAmt").value = ""; } };
});
addForm("#addTodo", "#tErr", () => {
  const title = $("#tTitle").value.trim();
  if (!title) return "Gib eine Aufgabe ein.";
  return { push: () => state.todos.push({ id: nid("t"), title, due: $("#tDue").value || null, done: false, ...($("#tCat").value ? { cat: $("#tCat").value } : {}), ...($("#tPrio").value ? { prio: $("#tPrio").value } : {}) }),
    reset: () => { $("#tTitle").value = ""; $("#tDue").value = ""; } };
});
addForm("#addPack", "#pErr", () => {
  const name = $("#pName").value.trim();
  if (!name) return "Gib einen Gegenstand ein.";
  const cat = $("#pCat").value; closedGroups.delete(cat);
  return { push: () => state.pack.push({ id: nid("p"), cat, name, qty: $("#pQty").value.trim() || "1", note: null, done: false }),
    reset: () => { $("#pName").value = ""; $("#pQty").value = "1"; } };
});
addForm("#addBuy", "#bErr", () => {
  const name = $("#bName").value.trim(), link = $("#bLink").value.trim(), price = parseFloat($("#bPrice").value);
  if (!name) return "Gib ein, was du kaufen willst.";
  if (link && !safeUrl(link)) return "Der Link muss mit https:// beginnen.";
  return { push: () => state.buy.push({ id: nid("b"), name, prio: $("#bPrio").value, price: isFinite(price) ? price : null, link: link || null, cat: $("#bCat").value, note: null, done: false }),
    reset: () => { $("#bName").value = ""; $("#bLink").value = ""; $("#bPrice").value = ""; } };
});
// Auswahlfelder der Formulare; nur neu füllen, wenn sich etwas geändert hat (sonst schließt sich eine offene Auswahl)
function fillSelect(sel, list, none, dflt) {
  const el = $(sel), sig = JSON.stringify([none, list.map(x => x.name)]); if (el._sig === sig) return;
  const cur = el._sig ? el.value : dflt; el._sig = sig;
  el.innerHTML = (none ? `<option value="">${none}</option>` : "") + list.map(x => `<option${x.name === cur ? " selected" : ""}>${esc(x.name)}</option>`).join("");
}
function fillSelects() {
  fillSelect("#pCat", packCats()); fillSelect("#bCat", packCats()); fillSelect("#kCat", costCats());
  fillSelect("#tCat", todoCats(), "– ohne –"); fillSelect("#tPrio", listPrios(), "– ohne –"); fillSelect("#bPrio", listPrios(), null, "Sollte");
}

/* ================= Alles zeichnen ================= */
function renderLists() {
  if (!state) return;
  normalizeState(state);
  applyPrioVars(); fillSelects(); renderPrioTexts();
  // Tag-Auswahl für neue Kostenposten
  const cur = $("#kDay").value;
  $("#kDay").innerHTML = `<option value="">– kein Tag –</option>` + sortedDays().map(d => `<option value="${esc(d.id)}"${d.id === cur ? " selected" : ""}>${fmtDate(d.date)} · ${esc(d.night || d.title)}</option>`).join("");
  renderCosts(); renderTodos(); renderPack(); renderBuy(); renderSettings();
  if (typeof renderExtras === "function") renderExtras();
  if (typeof renderRouteBar === "function") renderRouteBar();
  if (typeof renderSky === "function") renderSky();
  if (typeof renderJournal === "function") renderJournal();
  const openTodos = state.todos.filter(t => !t.done).length;
  $("#nTodo").textContent = openTodos;
  $("#nPack").textContent = state.pack.filter(i => !i.done).length;
  $("#nBuy").textContent = state.buy.filter(i => !i.done).length;
}
showView();
// app.js kann schon fertig sein, bevor diese Datei geladen ist – dann jetzt nachholen.
appReady.then(() => { if (normalizeState(state)) save(); renderLists(); updateStats(); });
