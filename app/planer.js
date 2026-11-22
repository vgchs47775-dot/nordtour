/* Route aus Prioritäten erstellen.
   Reihenfolge: Alle Punkte werden dort einsortiert, wo sie an der Grundroute liegen (varianten.js, „base“) –
   so bleibt die Rundreise eine Rundreise und nichts springt quer durchs Land.
   Was hineinkommt, bestimmt die Regel der Stufe (einstellungen.js): immer/kurz = immer, umweg = wenn der (über
   Valhalla gemessene) Umweg klein genug ist und die Tage reichen, nie = nie. Danach Aufteilung in Tage nach Fahrzeit; liegt am Tagesende kein Ort,
   wird ein Schlafplatz unterwegs gesetzt (d.auto). Wegpunkte von Panoramastraßen und der An-/Abreise: v.wp.
   Wird nach varianten.js geladen. */
"use strict";

const GEN_DEFAULT = { drive: 6, days: null, access: true, unprio: false };
const GEN_MAX_DAY = 11;             // Fahrt + Aufenthalte je Tag, höchstens (h)
const GEN_SPAN = 1200;              // Luftlinie je Valhalla-Anfrage (Server erlaubt 1500 km)
let genCancel = false, genBusy = false, genOut = null;
const legCache = new Map();

/* ---------- Grundroute als Reihenfolge-Vorlage ---------- */
// Streckenpunkte etwa alle 12 km: [lat, lon, Tagesindex]
function buildTrack() {
  const out = [];
  sortedDays().forEach((d, i, l) => {
    const pts = dayPoints(d, i, l), r = routes[routeKey(pts)];
    const line = r?.parts?.length ? r.parts.flatMap(p => p.ferry ? p.pts : decodePolyline(p.enc)) : pts.map(p => [p.lat, p.lon]);
    let last = null;
    line.forEach((q, k) => {
      if (last && k < line.length - 1 && hav({ lat: last[0], lon: last[1] }, { lat: q[0], lon: q[1] }) < 12) return;
      out.push([+q[0].toFixed(3), +q[1].toFixed(3), i]); last = q;
    });
  });
  return out;
}
function baseInfo() {
  const e = state.routeList.find(r => r.base);
  if (e.id === state.routeId) return { days: sortedDays(), track: buildTrack() };
  const days = [...e.data.days].sort((a, b) => a.date.localeCompare(b.date));
  return { days, track: e.track?.length ? e.track : days.filter(hasPos).map((d, i) => [d.lat, d.lon, i]) };
}
// Position an der Grundroute (Index im Track), auf Wunsch nur zwischen zwei Tagen gesucht
function trackPos(track, p, from = -1, to = 1e9) {
  let best = -1, bd = Infinity;
  track.forEach((q, i) => {
    if (q[2] < from || q[2] > to) return;
    const km = hav(p, { lat: q[0], lon: q[1] }); if (km < bd) { bd = km; best = i; }
  });
  return best < 0 ? (from > -1 ? trackPos(track, p) : { pos: 0, km: 0 }) : { pos: best, km: bd };
}

/* ---------- Panoramastraße → Wegpunkte ---------- */
function panoNodes(p, base) {
  const ds = p.days.map(id => base.days.findIndex(d => d.id === id)).filter(i => i >= 0);
  const lo = ds.length ? Math.min(...ds) : -1, hi = ds.length ? Math.max(...ds) : 1e9;
  let pts;
  if (p.geom.length < 20) pts = p.days.flatMap(id => EXTRAS.variants?.[id]?.[p.id] || []).map(v => [v.lat, v.lon]);   // zu grobe Linie → geprüfte Wegpunkte
  if (!pts?.length) {
    const g = p.geom, n = Math.max(0, Math.min(4, Math.round(p.km / 45) - 1));
    pts = Array.from({ length: n + 2 }, (_, i) => g[Math.round(i * (g.length - 1) / (n + 1))]);
  }
  const nodes = pts.map(q => ({ name: `${p.name} (Wegpunkt)`, lat: q[0], lon: q[1], wp: true, pano: p.id }));
  const a = trackPos(base.track, nodes[0], lo, hi), b = trackPos(base.track, nodes[nodes.length - 1], lo, hi);
  if (b.pos < a.pos) nodes.reverse();
  return { nodes, pos: Math.min(a.pos, b.pos), end: Math.max(a.pos, b.pos) };
}
// Abstand eines Orts zur Panoramalinie und Stelle darauf
function onPano(p, o) {
  let bd = Infinity, at = 0;
  p.geom.forEach((q, i) => { const km = hav(o, { lat: q[0], lon: q[1] }); if (km < bd) { bd = km; at = i; } });
  return { km: bd, at: at / Math.max(1, p.geom.length - 1) };
}

/* ---------- Fahrzeiten (Valhalla) ---------- */
const legKey = (a, b) => `${a.lat.toFixed(4)},${a.lon.toFixed(4)}>${b.lat.toFixed(4)},${b.lon.toFixed(4)}`;
async function fetchLegs(nodes) {
  const q = { locations: nodes.map(p => ({ lat: p.lat, lon: p.lon, search_filter: { exclude_ferry: true } })), costing: "auto", units: "kilometers", directions_type: "maneuvers" };
  const r = await fetch(ROUTER + encodeURIComponent(JSON.stringify(q)));
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.trip) throw new Error(j.error || "Routing-Server antwortet mit " + r.status);
  j.trip.legs.forEach((l, i) => legCache.set(legKey(nodes[i], nodes[i + 1]), { h: l.summary.time / 3600, km: l.summary.length, shape: l.shape,
    ferries: (l.maneuvers || []).filter(m => m.type === 28).map(m => [m.begin_shape_index, m.end_shape_index]) }));
  await sleep(350);                                    // den freiwilligen Server schonen
}
// Alle Teilstücke einer Folge besorgen (gebündelt, nur fehlende)
async function ensureLegs(seq) {
  let i = 0;
  while (i < seq.length - 1) {
    if (genCancel) throw new Error("abgebrochen");
    if (legCache.has(legKey(seq[i], seq[i + 1]))) { i++; continue; }
    const run = [seq[i]]; let span = 0, k = i;
    while (k < seq.length - 1 && run.length < 9) {
      const d = hav(seq[k], seq[k + 1]);
      if (run.length > 1 && (span + d > GEN_SPAN || legCache.has(legKey(seq[k], seq[k + 1])))) break;
      span += d; run.push(seq[++k]);
    }
    try { await fetchLegs(run); }
    catch (e) {
      if (run.length === 2) throw new Error(`Zwischen „${run[0].name}“ und „${run[1].name}“ wurde keine Strecke gefunden (${e.message}).`);
      await fetchLegs(run.slice(0, 2)).catch(x => { throw new Error(`Zwischen „${run[0].name}“ und „${run[1].name}“ wurde keine Strecke gefunden (${x.message}).`); });
      k = i + 1;
    }
    i = k;
  }
}
const leg = (a, b) => legCache.get(legKey(a, b));
// Sehr lange Sprünge mit Punkten der Grundroute überbrücken (Server-Grenze, sinnvoller Verlauf)
function bridgeGaps(seq, track) {
  const out = [seq[0]];
  for (let i = 1; i < seq.length; i++) {
    const a = out[out.length - 1], b = seq[i];
    if (hav(a, b) > 800 && a.pos != null && b.pos != null && b.pos - a.pos > 3) {
      const n = Math.ceil(hav(a, b) / 600);
      for (let k = 1; k < n; k++) { const t = track[Math.round(a.pos + (b.pos - a.pos) * k / n)]; out.push({ name: "Wegpunkt", lat: t[0], lon: t[1], wp: true, pos: 0 }); }
    }
    out.push(b);
  }
  return out;
}

/* ---------- Tage bilden ---------- */
// Punkt auf einem Teilstück bei einem Anteil der Strecke – nie auf einer Fähre (dann davor)
function pointOnLeg(l, frac) {
  const pts = decodePolyline(l.shape), cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hav({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] }));
  const total = cum[cum.length - 1]; let i = cum.findIndex(c => c >= total * frac); if (i < 0) i = pts.length - 1;
  for (const [a, b] of l.ferries) if (i >= a && i <= b) i = Math.max(0, a - 1);
  return { lat: +pts[i][0].toFixed(4), lon: +pts[i][1].toFixed(4), frac: total ? cum[i] / total : frac };
}
function splitDays(seq, opt) {
  const days = [], place = n => !n.wp;                 // an reinen Wegpunkten wird nicht übernachtet
  const fresh = () => ({ via: [], drive: 0, stay: 0, km: 0 });
  let cur = fresh();
  const close = night => { days.push({ ...cur, night }); cur = fresh(); };
  const sleepAtLast = () => { const n = cur.via.pop(); cur.stay -= n.stay || 0; close(n); };
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i - 1], b = seq[i], l = leg(a, b);
    let left = l.h, frac = 0;
    while (cur.drive + left > opt.drive * 1.12) {
      const last = cur.via[cur.via.length - 1];
      if (frac === 0 && last && place(last) && cur.drive >= opt.drive * 0.55) { sleepAtLast(); continue; }
      const p = pointOnLeg(l, Math.min(1, frac + Math.max(0.05, opt.drive - cur.drive) / l.h));
      if (p.frac <= frac + 0.01) {                     // Fähre gleich zu Beginn: erst morgen übersetzen
        if (cur.drive < 0.2) break;                    // sonst käme man nie weiter
        if (last && place(last)) { sleepAtLast(); continue; }
        close({ ...p, auto: true }); continue;
      }
      cur.drive += (p.frac - frac) * l.h; cur.km += (p.frac - frac) * l.km; left -= (p.frac - frac) * l.h; frac = p.frac;
      close({ ...p, auto: true });
    }
    cur.drive += left; cur.km += l.km * (1 - frac);
    if (i === seq.length - 1) { close(b); break; }
    cur.via.push(b); cur.stay += b.stay || 0;
    if (place(b) && (cur.drive + cur.stay >= GEN_MAX_DAY || cur.via.length >= 15)) sleepAtLast();
  }
  return days;
}

// Name für einen Schlafplatz: möglichst das nächste Dorf statt der Gemeinde
async function villageName(lat, lon) {
  const a = (await nomi(`reverse?zoom=14&lat=${lat}&lon=${lon}`)).address || {};
  const n = a.village || a.town || a.hamlet || a.city || a.isolated_dwelling || a.suburb || a.municipality || a.county || "unbekannt";
  return n.replace(/s? (kommun|distrikt)$/i, "").replace(/ kommune$/i, "");
}

/* ---------- Planen ---------- */
function genCandidates(opt) {
  const base = baseInfo(), items = [], basePos = new Map();
  base.days.forEach((d, i) => {
    for (const v of d.via || []) if (hasPos(v)) { const k = "o:" + ortSlug(v.name || ""); if (!basePos.has(k)) basePos.set(k, trackPos(base.track, v, i, i).pos); }
    if (hasPos(d)) { const k = "o:" + ortSlug(d.night || ""); if (!basePos.has(k)) basePos.set(k, trackPos(base.track, d, i, i).pos); }
  });
  const levels = prioLevels(), any = { stay: 1, detour: 1.5, ...levels.find(l => l.rule === "umweg"), rule: "umweg", id: "_ohne", name: "ohne Priorität" };
  const levelOf = pr => { const l = pr ? levels.find(x => x.id === pr) : opt.unprio ? any : null; return l && l.rule !== "nie" ? l : null; };
  const rank = l => { const i = levels.indexOf(l); return i < 0 ? 999 : i; };
  for (const o of allOrte()) {
    const lv = levelOf(ortPrio(o.key)); if (!lv) continue;
    const s = o.type === "sight" ? SIGHTS().find(x => x.id === o.id) : null, si = s ? base.days.findIndex(d => d.id === s.day) : -1;
    const pos = basePos.get(o.key) ?? (si >= 0 ? trackPos(base.track, o, Math.max(0, si - 1), si + 1).pos : trackPos(base.track, o).pos);
    const stay = lv.rule === "kurz" ? lv.stay : s ? s.visit : lv.stay;
    items.push({ kind: "ort", lv, rank: rank(lv), pos, end: pos, label: o.name, nodes: [{ name: o.name, lat: o.lat, lon: o.lon, key: o.key, stay }] });
  }
  for (const p of PANO()) {
    const lv = levelOf(panoPrio(p.id)); if (!lv) continue;
    const b = panoNodes(p, base);
    items.push({ kind: "pano", lv, rank: rank(lv), pos: b.pos, end: b.end, label: p.name, pano: p, nodes: b.nodes });
  }
  return { base, items };
}
// Feste Punkte der An- und Abreise (Stopps des ersten und der letzten beiden Tage der Grundroute)
function accessItems(base) {
  const n = base.days.length, out = [];
  base.days.forEach((d, i) => {
    if (i > 0 && i < n - 2) return;
    const vias = (d.via || []).filter(hasPos), marked = vias.filter(v => v.anchor);
    for (const v of marked.length ? marked : vias) {
      const pos = trackPos(base.track, v, i, i).pos;
      out.push({ kind: "weg", pos, end: pos, label: v.name, nodes: [{ name: v.name, lat: v.lat, lon: v.lon, wp: true, anchor: true, ...(v.ferry ? { ferry: true } : {}) }] });
    }
  });
  return out;
}
// Aus den gewählten Bausteinen die Reihenfolge der Punkte bilden
function buildSeq(items, start, end, track) {
  const panos = items.filter(x => x.kind === "pano"), inPano = new Map();
  const rest = items.filter(x => {
    if (x.kind !== "ort") return x.kind !== "pano";
    // Orte, die an einer gewählten Panoramastraße liegen, werden dort eingereiht
    for (const p of panos) { const q = onPano(p.pano, x.nodes[0]); if (q.km < 6) { inPano.set(p, [...(inPano.get(p) || []), { at: q.at, node: x.nodes[0] }]); return false; } }
    return true;
  });
  const blocks = rest.map(x => ({ pos: x.pos, nodes: x.nodes }));
  for (const p of panos) {
    const list = (p.flip ? [...p.nodes].reverse() : p.nodes).map(n => ({ at: onPano(p.pano, n).at, node: n })), rev = list.length > 1 && list[0].at > list[list.length - 1].at;
    for (const o of inPano.get(p) || []) {
      const k = list.findIndex(e => rev ? e.at < o.at : e.at > o.at);
      list.splice(k < 0 ? list.length : k, 0, o);
    }
    blocks.push({ pos: p.pos, nodes: list.map(e => e.node), span: p.end });
  }
  blocks.sort((a, b) => a.pos - b.pos);
  // kleine Verbesserung: benachbarte Einzelorte tauschen, wenn das deutlich kürzer ist
  for (let pass = 0; pass < 3; pass++) for (let i = 0; i < blocks.length - 1; i++) {
    const a = blocks[i], b = blocks[i + 1];
    if (a.nodes.length > 1 || b.nodes.length > 1 || a.nodes[0].anchor || b.nodes[0].anchor) continue;
    const pv = i ? blocks[i - 1].nodes.at(-1) : start, nx = blocks[i + 2]?.nodes[0] || end, A = a.nodes[0], B = b.nodes[0];
    if (hav(pv, B) + hav(A, nx) + 15 < hav(pv, A) + hav(B, nx)) [blocks[i], blocks[i + 1]] = [b, a];
  }
  const seq = [{ ...start, pos: 0 }];
  for (const b of blocks) b.nodes.forEach((n, i) => {
    const prev = seq[seq.length - 1];
    if (hav(prev, n) < 0.3) { if (!n.wp && prev.wp) seq[seq.length - 1] = { ...n, pos: b.pos }; return; }
    seq.push({ ...n, pos: i ? (b.span ?? b.pos) : b.pos });
  });
  seq.push({ ...end, pos: track.length - 1 });
  return bridgeGaps(seq, track);
}
// Fahrtrichtung einer Panoramastraße: beide Richtungen mit echten Fahrzeiten vergleichen
async function orient(list, item, make) {
  const other = { ...item, flip: !item.flip }, l2 = list.map(x => x === item ? other : x), a = make(list), b = make(l2);
  await ensureLegs(a);
  try { await ensureLegs(b); } catch (e) { if (genCancel) throw e; return list; }
  return seqHours(b) < seqHours(a) - 0.05 ? l2 : list;
}
const seqHours = seq => seq.slice(1).reduce((s, n, i) => s + leg(seq[i], n).h, 0);

async function generateRoute(opt, progress) {
  genCancel = false;
  const { base, items } = genCandidates(opt);
  const forced = items.filter(x => x.lv.rule !== "umweg"), optional = items.filter(x => x.lv.rule === "umweg").sort((a, b) => a.rank - b.rank || a.pos - b.pos);
  if (!items.length) throw new Error("Es gibt noch keine Ziele mit einer Priorität, die eingeplant wird. Setze welche in den Reitern „Orte“ und „Panoramastraßen“.");
  const lastBase = base.days[base.days.length - 1], h = home();
  const start = { name: nightBase(h.name), lat: h.lat, lon: h.lon, wp: true };
  const end = { name: "zu Hause", lat: hasPos(lastBase) && /zu hause/i.test(lastBase.night || "") ? lastBase.lat : h.lat, lon: hasPos(lastBase) && /zu hause/i.test(lastBase.night || "") ? lastBase.lon : h.lon, home: true };
  let chosen = [...forced, ...(opt.access ? accessItems(base) : [])];
  const omitted = [];
  const make = list => buildSeq(list, start, end, base.track);
  progress("Fahrzeiten der festen Punkte werden berechnet …");
  for (const p of chosen.filter(x => x.kind === "pano")) {
    if (genCancel) throw new Error("abgebrochen");
    progress(`Fahrtrichtung: ${p.label} …`);
    chosen = await orient(chosen, p, make);
  }
  let seq = make(chosen); await ensureLegs(seq);
  let hours = seqHours(seq);
  // Ziele mit Regel „umweg“ einzeln prüfen, wichtigste Stufe zuerst: Umweg = Fahrzeit mit minus ohne
  const taken = [];
  for (const [i, c] of optional.entries()) {
    if (genCancel) throw new Error("abgebrochen");
    progress(`Umweg prüfen ${i + 1} von ${optional.length}: ${c.label} …`);
    try {
      let s2 = make([...chosen, c]);
      // grob vorab: unerreichbar weite Umwege gar nicht erst anfragen
      let air = 0; for (let k = 1; k < s2.length; k++) air += hav(s2[k - 1], s2[k]);
      let air0 = 0; for (let k = 1; k < seq.length; k++) air0 += hav(seq[k - 1], seq[k]);
      if ((air - air0) / 90 > c.lv.detour + 1) { omitted.push({ ...c, why: `Umweg zu groß (grob ${fmtShort((air - air0) * 1.3 / 65)})` }); continue; }
      let list = [...chosen, c];
      if (c.kind === "pano") list = await orient(list, c, make);
      s2 = make(list); await ensureLegs(s2);
      const used = list[list.length - 1], extra = seqHours(s2) - hours;
      if (extra > c.lv.detour + 0.01) { omitted.push({ ...c, why: `Umweg ${fmtShort(extra)}` }); continue; }
      chosen = list; seq = s2; hours += extra; taken.push({ c: used, extra });
    } catch (e) { if (genCancel) throw e; omitted.push({ ...c, why: "nicht erreichbar" }); }
  }
  // Zu viele Tage? Dann Umweg-Ziele wieder weglassen: unwichtigste Stufe zuerst, darin die mit dem größten Aufwand
  let days = splitDays(seq, opt);
  while (days.length > opt.days && taken.length) {
    if (genCancel) throw new Error("abgebrochen");
    progress(`Noch ${days.length} Tage – Umwege werden gekürzt …`);
    taken.sort((a, b) => b.c.rank - a.c.rank || (b.extra + (b.c.nodes[0].stay || 0)) - (a.extra + (a.c.nodes[0].stay || 0)));
    const out = taken.shift();
    chosen = chosen.filter(x => x !== out.c); omitted.push({ ...out.c, why: "passt nicht mehr in die Tage" });
    seq = make(chosen); await ensureLegs(seq); days = splitDays(seq, opt);
  }
  // Schlafplätze unterwegs benennen
  const autos = days.filter(d => d.night.auto);
  for (const [i, d] of autos.entries()) {
    if (genCancel) throw new Error("abgebrochen");
    progress(`Schlafplätze unterwegs benennen (${i + 1} von ${autos.length}) …`);
    try { d.night.name = `bei ${await villageName(d.night.lat, d.night.lon)}`; } catch { d.night.name = "Schlafplatz unterwegs"; }
  }
  return { days: toDays(days), raw: days, chosen: chosen.filter(x => x.kind !== "weg"), omitted, opt,
    skipped: [...allOrte().map(o => [o.name, ortPrio(o.key)]), ...PANO().map(p => [p.name, panoPrio(p.id)])].filter(x => prioLevel(x[1])?.rule === "nie").map(x => x[0]) };
}
// Planungsergebnis → Reisetage der App
function toDays(raw) {
  const t0 = tripStart(); let prev = nightBase(home().name);
  return raw.map((r, i) => {
    const n = r.night, last = i === raw.length - 1, name = last ? "zu Hause" : n.name;
    const panos = [...new Set([...r.via, n].map(v => v.pano).filter(Boolean))];
    const d = { id: uid(), order: i, date: addDays(t0, i), title: `${prev} → ${last ? nightBase(home().name) : name}`, night: name, lat: n.lat, lon: n.lon, ferries: 0,
      via: r.via.map(v => ({ name: v.name, lat: v.lat, lon: v.lon, ...(v.stay > 0 && !v.wp ? { stay: Math.round(v.stay * 60) } : {}), ...(v.ferry ? { ferry: true } : {}), ...(v.wp ? { wp: true } : {}), ...(v.anchor ? { anchor: true } : {}), ...(v.key && !v.key.startsWith("o:") ? { key: v.key } : {}) })) };
    if (panos.length) d.panos = panos;
    if (n.auto) { d.auto = true; d.sub = "Schlafplatz unterwegs – mit park4night in der Nähe suchen"; }
    else if (!last && n.stay > 0) d.todo = `${n.name}: ca. ${fmtShort(n.stay)} einplanen`;
    if (n.key && !n.key.startsWith("o:")) d.key = n.key;
    prev = name; return d;
  });
}

/* ---------- Dialog ---------- */
function genOptions() { return { ...GEN_DEFAULT, days: state.days.length || 24, ...(state.settings?.gen || {}) }; }
function openGen() {
  const o = genOptions(), c = prioCounts(allOrte().map(x => ortPrio(x.key))), p = prioCounts(PANO().map(x => panoPrio(x.id)));
  $("#gDrive").value = o.drive; $("#gDays").value = o.days;
  $("#gAccess").checked = o.access; $("#gUnprio").checked = o.unprio;
  $("#genCounts").textContent = `${c.ohne || 0} Orte und ${p.ohne || 0} Panoramastraßen haben noch keine Priorität.`;
  $("#genLevels").innerHTML = prioLevels().map(l => `<div class="genlevel" data-genlevel="${esc(l.id)}" style="--pc:var(--p-${l.id});--pi:var(--pi-${l.id})">
    <span class="nm"><span class="ppill">${esc(l.name)}</span><span class="nt">${[l.ort ? `Orte: ${c[l.id] || 0}` : "", l.pano ? `Panoramastraßen: ${p[l.id] || 0}` : ""].filter(Boolean).join(", ")} · ${RULES[l.rule]}</span></span>
    ${l.rule === "nie" ? "" : `<label class="lbl">Zeit je Ort (h)<input type="number" name="stay" min="0" max="12" step="0.25" value="${l.stay}"></label>`}
    ${l.rule === "umweg" ? `<label class="lbl">Umweg max. (h)<input type="number" name="detour" min="0" max="10" step="0.25" value="${l.detour}"></label>` : ""}</div>`).join("");
  $("#genErr").textContent = ""; $("#genProg").textContent = ""; $("#genResult").innerHTML = ""; genOut = null;
  $("#genDlg").showModal();
}
function renderGen(g) {
  const km = g.raw.reduce((a, d) => a + d.km, 0), h = g.raw.reduce((a, d) => a + d.drive, 0), over = g.days.length - g.opt.days;
  const li = x => `<li>${esc(x.label)}${x.why ? ` <span class="hint">– ${esc(x.why)}</span>` : ""}</li>`;
  const grp = (t, list) => list.length ? `<details><summary>${t} (${list.length})</summary><ul>${list.map(li).join("")}</ul></details>` : "";
  let n = 1; while (state.routeList.some(r => r.name === `Prioritäten ${n}`)) n++;
  $("#genResult").innerHTML = `<div class="genres">
    <div class="big"><div><b>${g.days.length}</b><span>Tage</span></div><div><b>${num(km)} km</b><span>Strecke</span></div><div><b>${num(h)} h</b><span>Fahrzeit</span></div></div>
    ${over > 0 ? `<p class="genwarn">Die Route braucht ${over} Tag${over > 1 ? "e" : ""} mehr als erlaubt (${g.opt.days}). Ziele mit der Regel „immer“ lasse ich nicht weg. Erhöhe die Fahrzeit oder die Tage, oder stufe einzelne Ziele herunter.</p>` : over < 0 ? `<p class="hint">${-over} Tag${over < -1 ? "e bleiben" : " bleibt"} frei, z. B. für Ruhetage („+ Nacht“).</p>` : ""}
    ${[...prioLevels(), { id: "_ohne", name: "ohne Priorität" }].map(l => grp(esc(l.name), g.chosen.filter(x => x.lv.id === l.id))).join("")}
    ${grp("Weggelassen", g.omitted.map(x => ({ label: x.label, why: `${x.lv.name}, ${x.why}` })))}${grp("Nie einplanen", g.skipped.map(label => ({ label })))}
    <details open><summary>Tage</summary><ol>${g.days.map((d, i) => `<li>${fmtDate(d.date)}: ${esc(d.title)} <span class="hint">${num(g.raw[i].km)} km · ${fmtShort(g.raw[i].drive)}${d.via.filter(v => v.stay).length ? ` · ${d.via.filter(v => v.stay).map(v => esc(v.name)).join(", ")}` : ""}</span></li>`).join("")}</ol></details>
    <form id="genSave" class="inline"><label class="lbl" for="genName">Name der Route<input type="text" id="genName" maxlength="60" required value="Prioritäten ${n}"></label><button class="btn" type="submit">Speichern und auswählen</button></form>
    <p class="hint">Deine jetzige Route bleibt gespeichert und lässt sich jederzeit wieder auswählen. Fahrzeiten ohne Wartezeit an Fähren.</p></div>`;
}
window.addEventListener("DOMContentLoaded", () => {
  $("#btnGen").addEventListener("click", openGen);
  $("#genClose").addEventListener("click", () => { genCancel = true; $("#genDlg").close(); });
  $("#genDlg").addEventListener("cancel", () => { genCancel = true; });
  $("#genCfg").addEventListener("click", () => { genCancel = true; $("#genDlg").close(); });
  $("#genStop").addEventListener("click", () => { genCancel = true; });
  $("#genForm").addEventListener("submit", async e => {
    e.preventDefault(); if (genBusy) return;
    const v = id => parseFloat($(id).value), err = $("#genErr"); err.textContent = "";
    const opt = { drive: v("#gDrive"), days: v("#gDays"), access: $("#gAccess").checked, unprio: $("#gUnprio").checked };
    const inputs = [...document.querySelectorAll("#genLevels [data-genlevel] input")];
    if (Object.values(opt).some(x => typeof x === "number" && !isFinite(x)) || inputs.some(x => !isFinite(parseFloat(x.value)))) { err.textContent = "Bitte alle Felder ausfüllen."; return; }
    if (!navigator.onLine) { err.textContent = "Für die Berechnung brauchst du Internet."; return; }
    const levels = cfgEdit("levels");                   // Zeiten und Umwege gehören zur Stufe
    for (const x of inputs) { const l = levels.find(l => l.id === x.closest("[data-genlevel]").dataset.genlevel); if (l) l[x.name] = parseFloat(x.value); }
    state.settings.gen = opt; save(); renderSettings();
    genBusy = true; $("#genStart").disabled = true; $("#genStop").hidden = false; $("#genResult").innerHTML = "";
    try { genOut = await generateRoute(opt, t => { $("#genProg").textContent = t; }); $("#genProg").textContent = ""; renderGen(genOut); }
    catch (x) { $("#genProg").textContent = ""; if (x.message === "abgebrochen") err.textContent = "Abgebrochen."; else { err.textContent = x.message; console.warn("Planer", x); } }
    genBusy = false; $("#genStart").disabled = false; $("#genStop").hidden = true;
  });
  $("#genResult").addEventListener("submit", async e => {
    e.preventDefault(); if (!genOut) return;
    const name = $("#genName").value.trim(); if (!name) return;
    const g = genOut; genOut = null; $("#genDlg").close();
    await addRoute(name, { days: g.days, panorama_geplant: g.chosen.filter(x => x.kind === "pano").map(x => x.pano.id), sights_geplant: [] });
  });
});
