/* Aktivitäten rund um einen Stopp oder eine Übernachtung suchen (Knopf „🔎 Aktivitäten“).
   Quellen: Wikipedia (Artikel in der Nähe, deutsch und englisch, mit Kurzbeschreibung) und OpenStreetMap über Overpass
   (Aussichtspunkte, Gipfel, Wasserfälle, Wanderwege, Museen, Burgen …). Overpass ist oft überlastet – dann bleiben die
   Wikipedia-Treffer. „Übernehmen“ öffnet das Fenster „Neues Erlebnis“ (bearbeiten.js) mit allem vorausgefüllt.
   Wird nach bearbeiten.js geladen. */
"use strict";

const ACT_TYPES = ["Wanderung", "Aussicht", "Natur", "Kultur", "Stadt & Freizeit"];
const ACT_VISIT = { Wanderung: 3, Aussicht: 0.5, Natur: 1, Kultur: 1.5, "Stadt & Freizeit": 1.5 };
let act = null;

// Art aus der Wikipedia-Kurzbeschreibung erraten
function wikiType(t) {
  const s = t.toLowerCase();
  if (/aussicht|utsikt|viewpoint|lookout|plattform/.test(s)) return "Aussicht";
  if (/kirche|kyrkje|kirke|kyrka|kapelle|church|chapel|museum|burg|schloss|festung|fortress|castle|denkmal|monument|ruine|ruin|galerie|gallery|theater|kloster|abbey|gräberfeld|archäolog|stabkirche|bauernhof|bergbauernhof|\bfarm|historisch|historic|bauwerk|brücke|bridge|leuchtturm|lighthouse/.test(s)) return "Kultur";
  if (/wanderweg|wanderung|trail|hiking|\bberg\b|berggipfel|gipfel|\bfjell|tind|mountain|peak|pass\b|hochebene/.test(s)) return "Wanderung";
  if (/wasserfall|\bfoss|gletscher|\bbre\b|glacier|waterfall|see\b|\bvatn|lake|fjord|\bstrand\b|beach|\binsel\b|island|nationalpark|national park|naturreservat|nature reserve|höhle|cave|schlucht|canyon|\bmoor\b|\btal\b|valley/.test(s)) return "Natur";
  return "Stadt & Freizeit";
}
// Siedlungen, Verwaltung usw. sind keine Aktivität
const NOT_ACT = /^(ehemalige[rs]? )?(ort|dorf|weiler|gemeinde|kommune|kommun|stadt|stadtteil|siedlung|ortschaft|village|municipality|town|city|hamlet|parish|suburb|district|fylke|provinz|landkreis|landschaft|bahnhof|haltepunkt|flughafen|hafen|schule|unternehmen|firma|fußball|sportverein|wahlkreis|person|straße in|road in|tunnel|wohnplatz|bezirk|census|insel in der gemeinde|(tages|wochen)?zeitung|newspaper|verlag|radio|fernseh|sender|partei|band|musikgruppe|organisation|verein|hochschule|universität|university|krankenhaus|hospital|gericht|behörde|botschaft|konsulat|bank|hotel|einkaufszentrum|shopping|bürogebäude|wohnhaus|company)\b/i;
async function wikiNear(lang, p, r) {
  const u = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=geosearch&ggscoord=${p.lat.toFixed(4)}|${p.lon.toFixed(4)}&ggsradius=${Math.min(10000, r * 1000)}&ggslimit=40` +
    "&prop=description|extracts|pageimages|coordinates&exintro=1&explaintext=1&exsentences=2&exlimit=20&colimit=50&piprop=name";
  const j = await (await fetch(u)).json(), out = [];
  for (const pg of Object.values(j.query?.pages || {})) {
    const c = pg.coordinates?.[0], d = pg.description || ""; if (!c || NOT_ACT.test(d)) continue;
    out.push({ name: pg.title.replace(/\s*\([^)]*\)$/, ""), type: wikiType(pg.title + " " + d), lat: c.lat, lon: c.lon, desc: pg.extract || d, sub: d,
      src: "Wikipedia", link: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(pg.title.replace(/ /g, "_"))}`, file: pg.pageimage, lang });
  }
  return out;
}
function osmType(t) {
  if (t.route === "hiking" || /^(peak|volcano)$/.test(t.natural || "")) return "Wanderung";
  if (t.tourism === "viewpoint") return "Aussicht";
  if (t.natural) return "Natur";
  if (t.historic || /^(museum|gallery)$/.test(t.tourism || "")) return "Kultur";
  return "Stadt & Freizeit";
}
const OSM_LABEL = { viewpoint: "Aussichtspunkt", museum: "Museum", gallery: "Galerie", zoo: "Zoo", aquarium: "Aquarium", theme_park: "Freizeitpark", attraction: "Sehenswürdigkeit",
  peak: "Gipfel", volcano: "Vulkan", waterfall: "Wasserfall", glacier: "Gletscher", cave_entrance: "Höhle", arch: "Felsbogen", castle: "Burg/Schloss", ruins: "Ruine",
  archaeological_site: "Fundstätte", fort: "Festung", manor: "Gutshof", church: "historische Kirche", monastery: "Kloster", memorial: "Gedenkstätte" };
async function osmNear(p, r) {
  const a = `(around:${r * 1000},${p.lat.toFixed(4)},${p.lon.toFixed(4)})`;
  const j = await overpass(`[out:json][timeout:25];(nwr${a}["tourism"~"^(viewpoint|attraction|museum|gallery|zoo|aquarium|theme_park)$"]["name"];node${a}["natural"~"^(peak|waterfall|glacier|cave_entrance|arch)$"]["name"];nwr${a}["historic"~"^(castle|ruins|archaeological_site|fort|manor|church|monastery)$"]["name"];relation${a}["route"="hiking"]["name"];);out center tags 150;`, 30e3);
  let peaks = 0;
  return (j.elements || []).map(e => ({ e, d: hav(p, e.center || e) })).sort((a, b) => a.d - b.d).map(({ e }) => e).filter(e => {
    // Gipfel gibt es im Gebirge zu Hunderten: nur die bekannten (mit Wikipedia/Wikidata) und die acht nächsten
    if (e.tags?.natural !== "peak" || e.tags.wikidata || e.tags.wikipedia) return true;
    return ++peaks <= 8;
  }).map(e => {
    const t = e.tags || {}, c = e.center || e, kind = t.route === "hiking" ? "Wanderweg" : OSM_LABEL[t.tourism] || OSM_LABEL[t.natural] || OSM_LABEL[t.historic] || "";
    const ele = t.ele ? ` · ${Math.round(parseFloat(t.ele))} m` : "", dist = t.distance ? ` · ${t.distance} km` : "";
    return c.lat == null ? null : { name: t.name, type: osmType(t), lat: c.lat, lon: c.lon, sub: kind + ele + dist, desc: t.description || "", src: "OpenStreetMap",
      link: t.website?.startsWith("https://") ? t.website : `https://www.openstreetmap.org/${e.type}/${e.id}`, wd: t.wikidata };
  }).filter(Boolean);
}
// gleiche Dinge aus beiden Quellen nur einmal (Wikipedia gewinnt, hat die Beschreibung)
function mergeActs(list) {
  const out = [];
  for (const x of list) {
    // gleicher Name in der Nähe, oder derselbe Ort in einer anderen Wikipedia-Sprache (z. B. „Kirche von Geiranger“ / „Geiranger Church“)
    const n = normName(x.name), dup = out.find(y => { const m = normName(y.name), d = hav(x, y);
      return (d < 3 && (m === n || (d < 0.4 && (m.includes(n) || n.includes(m))))) || (d < 0.3 && x.lang && y.lang && x.lang !== y.lang) || (d < 1.5 && x.lang && y.lang && x.lang !== y.lang && x.type === y.type && x.type === "Natur"); });
    if (!dup) out.push(x);
    else if (x.lang === "de" && dup.lang !== "de") Object.assign(dup, x);            // deutscher Artikel geht vor
    else if (!dup.sub && x.sub) dup.sub = x.sub;
  }
  return out;
}
async function openActs(p, label, dayId) {
  act = { p: { lat: +p.lat, lon: +p.lon }, label, dayId, r: act?.r || 10, list: [], filter: "", run: 0 };
  $("#actTitle").textContent = `🔎 Aktivitäten bei ${label}`;
  $("#actDlg").showModal(); $("#actDlg").scrollTop = 0;
  loadActs();
}
async function loadActs() {
  const me = act, run = ++me.run; me.list = []; me.osm = "busy"; me.wiki = "busy"; drawActs();
  if (!navigator.onLine) { me.osm = me.wiki = "offline"; drawActs(); return; }
  const add = l => { if (act !== me || me.run !== run) return; me.list = mergeActs([...me.list, ...l]); drawActs(); };
  const once = l => wikiNear(l, me.p, me.r).catch(() => sleep(1500).then(() => wikiNear(l, me.p, me.r))).catch(() => []);
  const wiki = Promise.all(["de", "en"].map(once)).then(([a, b]) => { me.wiki = "ok"; add([...a, ...b]); }).catch(() => { me.wiki = "err"; drawActs(); });
  const osm = osmNear(me.p, me.r).then(l => { me.osm = "ok"; add(l); }).catch(() => { if (act === me) { me.osm = "err"; drawActs(); } });
  await Promise.all([wiki, osm]);
}
function drawActs() {
  const me = act; if (!me) return;
  const L = me.list.map(x => ({ ...x, km: hav(me.p, x) })).filter(x => x.km <= me.r + 0.5);
  const counts = Object.fromEntries(ACT_TYPES.map(t => [t, L.filter(x => x.type === t).length]));
  $("#actChips").innerHTML = [["", "Alle", L.length], ...ACT_TYPES.map(t => [t, t, counts[t]])].map(([v, l, n]) => `<button type="button" class="fchip" data-actfilter="${esc(v)}" aria-pressed="${me.filter === v}">${esc(l)} <b>${n}</b></button>`).join("");
  $("#actR").value = me.r;
  const show = L.filter(x => !me.filter || x.type === me.filter).sort((a, b) => (a.src === b.src ? 0 : a.src === "Wikipedia" ? -1 : 1) || a.km - b.km).slice(0, 80);
  const have = x => SIGHTS().some(s => hav(s, x) < 0.4 && normName(s.name).includes(normName(x.name).slice(0, 6)));
  const state_ = [me.wiki === "busy" ? "Wikipedia wird durchsucht …" : me.wiki === "err" ? "Wikipedia nicht erreichbar." : "",
    me.osm === "busy" ? "OpenStreetMap wird durchsucht (kann dauern) …" : me.osm === "err" ? "OpenStreetMap ist gerade überlastet – es fehlen z. B. Aussichtspunkte und Wanderwege. Später noch einmal versuchen." : "",
    me.wiki === "offline" ? "Für die Suche brauchst du Internet." : ""].filter(Boolean).join(" ");
  $("#actState").textContent = state_;
  $("#actList").innerHTML = show.length ? show.map((x, i) => `<li class="actrow"><span class="nm">${esc(x.name)}<span class="nt">${esc(x.type)}${x.sub ? ` · ${esc(x.sub)}` : ""} · ${x.km < 1 ? `${Math.round(x.km * 1000)} m` : `${num(x.km)} km`} entfernt</span>${x.desc ? `<span class="ad">${esc(cut(x.desc, 220))}</span>` : ""}</span>
      <span class="acts">${have(x) ? `<span class="pill ok">schon dabei</span>` : `<button type="button" class="btn mini" data-acttake="${me.list.indexOf(me.list.find(y => y.name === x.name && y.lat === x.lat))}">Übernehmen</button>`}
      <a class="btn ghost mini" href="${esc(x.link)}" target="_blank" rel="noopener noreferrer">${x.src === "Wikipedia" ? "Wikipedia" : "Mehr"} ↗</a></span></li>`).join("")
    : `<li class="empty">${me.wiki === "busy" || me.osm === "busy" ? "Suche läuft …" : "Nichts gefunden. Vergrößere den Umkreis."}</li>`;
}
// Foto zum Wikipedia-Artikel (liegt auf Wikimedia Commons) mit Urheber und Lizenz
async function wikiPhoto(file) {
  if (!file) return [];
  try {
    const j = await (await fetch(`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&titles=${encodeURIComponent("File:" + file)}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=800&iiextmetadatafilter=Artist|LicenseShortName`)).json();
    const i = Object.values(j.query?.pages || {})[0]?.imageinfo?.[0], m = i?.extmetadata || {};
    return i?.thumburl ? [{ src: i.thumburl, page: i.descriptionurl, artist: stripTags(m.Artist?.value) || "unbekannt", license: stripTags(m.LicenseShortName?.value) || "siehe Wikimedia Commons" }] : [];
  } catch { return []; }
}
async function takeAct(x) {
  const me = act; if (!me) return;
  const imgs = await wikiPhoto(x.file);
  const detour = Math.round(hav(me.p, x) * 2 / 50 * 12) / 12;                   // grob: hin und zurück mit 50 km/h
  $("#actDlg").close(); act = null;
  openEdit("sights", null, { name: x.name, type: x.type, desc: x.desc || x.sub || "", lat: +x.lat.toFixed(4), lon: +x.lon.toFixed(4), day: me.dayId || "",
    visit: ACT_VISIT[x.type] || 1, detour, imgs, link: x.link });
}
window.addEventListener("DOMContentLoaded", () => {
  $("#actClose").addEventListener("click", () => { $("#actDlg").close(); act = null; });
  $("#actDlg").addEventListener("cancel", () => { act = null; });
  $("#actR").addEventListener("change", e => { if (!act) return; act.r = +e.target.value; loadActs(); });
});
document.addEventListener("click", e => {
  const a = e.target.closest("[data-acts]");
  if (a) { const [lat, lon, dayId, ...name] = a.dataset.acts.split("|"); map.closePopup(); openActs({ lat, lon }, name.join("|"), dayId); return; }
  const f = e.target.closest("[data-actfilter]"); if (f && act) { act.filter = f.dataset.actfilter; drawActs(); return; }
  const t = e.target.closest("[data-acttake]"); if (t && act) { t.disabled = true; takeAct(act.list[+t.dataset.acttake]); }
});
// Knopf-Daten für einen Punkt
const actsBtn = (p, name, dayId, label = "🔎 Aktivitäten") => hasPos(p) ? `<button type="button" class="btn ghost mini" data-acts="${esc(`${p.lat}|${p.lon}|${dayId || ""}|${nightBase(name)}`)}">${label}</button>` : "";
// Zeile im aufgeklappten Tag: Übernachtung und benannte Stopps
function actsLine(d) {
  const pts = [...(d.via || []).filter(v => hasPos(v) && v.name && !v.wp && !v.ferry), ...(hasPos(d) && d.night && !/zu hause/i.test(d.night) ? [{ lat: d.lat, lon: d.lon, name: d.night }] : [])];
  return pts.length ? `<span class="actline"><span class="lbl">🔎 Aktivitäten suchen bei</span>${pts.map(p => actsBtn(p, p.name, d.id, esc(nightBase(p.name)))).join("")}</span>` : "";
}
