/* Nachthimmel & Polarlicht.
   Berechnet für jede Übernachtung: Sonnenuntergang/-aufgang, wie lange es dunkel genug ist
   (Sonne tiefer als 8° unter dem Horizont), Mondhelligkeit und den nötigen Kp-Index.
   Dazu live von der NOAA (Space Weather Prediction Center):
   - 3-Tage-Prognose des Kp-Index (3-Stunden-Werte)
   - 27-Tage-Ausblick (größter Kp je Tag) – reicht etwa 4 Wochen in die Zukunft. */
"use strict";

const RAD = Math.PI / 180;
// Sonnenhöhe (vereinfachte NOAA-/Almanach-Formel)
function sunAlt(ms, lat, lon) {
  const d = ms / 864e5 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const H = (gmst * 15 + lon) * RAD - ra;
  return Math.asin(Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(H)) / RAD;
}
// Mond: beleuchteter Anteil aus dem Alter seit Neumond (6.1.2000)
function moonIllum(ms) {
  const age = (((ms / 864e5 - 10962.7597) % 29.530588853) + 29.530588853) % 29.530588853;
  return { frac: (1 - Math.cos(2 * Math.PI * age / 29.530588853)) / 2, waxing: age < 14.765 };
}
// Geomagnetische Breite (Dipol, Pol bei 80,8° N / 72,6° W)
function geomagLat(lat, lon) {
  const pl = 80.8 * RAD, pL = -72.6 * RAD, a = lat * RAD, b = lon * RAD;
  return Math.asin(Math.sin(a) * Math.sin(pl) + Math.cos(a) * Math.cos(pl) * Math.cos(b - pL)) / RAD;
}
// Südgrenze (geomagnetische Breite), ab der Polarlicht am Nordhorizont sichtbar wird – Kp 0 bis 9
const KP_EDGE = [66.5, 64.5, 62.4, 60.4, 58.3, 56.3, 54.2, 52.2, 50.1, 48.1];
const TZ = 2;      // Sommerzeit (MESZ) – gilt für alle Übernachtungen dieser Reise
const DARK = -8;   // ab hier ist die Dämmerung schwach genug für Polarlicht
const hhmm = ms => { const d = new Date(ms + TZ * 36e5); return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); };
const skyCache = new Map();

function nightSky(d) {
  if (!hasPos(d) || !d.date) return null;
  const key = d.date + "|" + d.lat + "|" + d.lon;
  if (skyCache.has(key)) return skyCache.get(key);
  const [Y, M, D] = d.date.split("-").map(Number);
  const t0 = Date.UTC(Y, M - 1, D, 16);          // 18 Uhr Ortszeit
  const step = 5 * 60e3, n = 18 * 12;            // bis 12 Uhr am nächsten Tag
  let prev = sunAlt(t0, d.lat, d.lon), sunset = null, sunrise = null, darkStart = null, darkEnd = null, darkMin = 0, minAlt = prev, minAt = t0;
  for (let i = 1; i <= n; i++) {
    const t = t0 + i * step, a = sunAlt(t, d.lat, d.lon);
    if (prev > -0.833 && a <= -0.833 && sunset == null) sunset = t;
    if (prev <= -0.833 && a > -0.833 && sunset != null && sunrise == null) sunrise = t;
    if (prev > DARK && a <= DARK && darkStart == null) darkStart = t;
    if (prev <= DARK && a > DARK && darkStart != null && darkEnd == null) darkEnd = t;
    if (a <= DARK) darkMin += 5;
    if (a < minAlt) { minAlt = a; minAt = t; }
    prev = a;
  }
  const gm = geomagLat(d.lat, d.lon);
  let kp = KP_EDGE.findIndex(e => gm >= e); if (kp < 0) kp = 10;
  const moon = moonIllum(minAt), darkH = darkMin / 60;
  let chance, cls;
  if (darkH < 0.5) { chance = "zu hell"; cls = "none"; }
  else if (kp <= 1) { chance = darkH >= 2 ? "gut" : "möglich"; cls = darkH >= 2 ? "good" : "mid"; }
  else if (kp <= 3) { chance = "möglich"; cls = "mid"; }
  else if (kp <= 5) { chance = "selten"; cls = "low"; }
  else { chance = "sehr selten"; cls = "none"; }
  if (moon.frac > 0.75 && cls === "good") { chance = "möglich (heller Mond)"; cls = "mid"; }
  else if (moon.frac > 0.75 && cls === "mid") { chance = "selten (heller Mond)"; cls = "low"; }
  const res = { sunset, sunrise, darkStart, darkEnd, darkH, minAlt, minAt, gm, kp, moon, chance, cls };
  skyCache.set(key, res);
  return res;
}

/* ================= NOAA-Prognose ================= */
const SWPC = "https://services.swpc.noaa.gov/";
let space = { loaded: false, loading: false, err: null, kp3: [], outlook: {}, issued: null };

async function loadSpaceWeather() {
  if (space.loading || (space.loaded && Date.now() - space.at < 30 * 60e3)) return;
  space.loading = true; renderSky();
  try {
    const [fc, o27] = await Promise.all([
      fetch(SWPC + "products/noaa-planetary-k-index-forecast.json").then(r => r.ok ? r.json() : Promise.reject(r.status)),
      fetch(SWPC + "text/27-day-outlook.txt").then(r => r.ok ? r.text() : Promise.reject(r.status))
    ]);
    // 3-Tage-Werte: Zeitstempel in UTC, Status observed / estimated / predicted
    space.kp3 = (Array.isArray(fc) ? fc : []).map(x => Array.isArray(x)
      ? { t: Date.parse(x[0].replace(" ", "T") + "Z"), kp: +x[1], kind: x[2] }       // älteres Tabellenformat
      : { t: Date.parse(x.time_tag + "Z"), kp: +x.kp, kind: x.observed }).filter(x => isFinite(x.t) && isFinite(x.kp));
    // 27-Tage-Ausblick: „2026 Nov 16     150          8          3“
    const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    space.outlook = {};
    for (const m of o27.matchAll(/^(\d{4}) (\w{3}) (\d{2})\s+(\d+)\s+(\d+)\s+(\d+)\s*$/gm)) {
      space.outlook[`${m[1]}-${String(MON[m[2]]).padStart(2, "0")}-${m[3]}`] = +m[6];
    }
    space.issued = (o27.match(/:Issued: (.+)/) || [])[1] || null;
    space.loaded = true; space.err = null; space.at = Date.now();
  } catch (e) {
    space.err = "NOAA-Daten nicht erreichbar"; console.warn("NOAA", e);
  }
  space.loading = false;
  renderSky();
  if (typeof renderDays === "function" && !editingDay) renderDays();   // offenes Bearbeiten-Formular nicht zurücksetzen
}
// Prognose für eine Nacht: höchster Kp im dunklen Fenster (3-Tage-Prognose), sonst 27-Tage-Ausblick
function nightForecast(d, k) {
  if (!space.loaded || !k) return null;
  const from = k.darkStart || k.minAt - 2 * 36e5, to = k.darkEnd || k.minAt + 2 * 36e5;
  const blocks = space.kp3.filter(x => x.t + 3 * 36e5 > from && x.t < to);
  if (blocks.length) return { kp: Math.max(...blocks.map(x => x.kp)), src: "3-Tage-Prognose" };
  const o = space.outlook[d.date];
  return o != null ? { kp: o, src: "27-Tage-Ausblick" } : null;
}
const kpTxt = kp => kp > 9 ? "9+" : String(kp);
const kpFmt = kp => (Math.round(kp * 10) / 10).toLocaleString("de-DE");

/* ================= Anzeige ================= */
function skyLine(d) {
  if (/zu hause/i.test(d.night || "")) return "";
  const k = nightSky(d); if (!k) return "";
  if (k.chance === "zu hell") return `<span class="sky1">Nachthimmel: zu hell für Polarlicht (Sonne nur ${Math.abs(k.minAlt).toFixed(0)}° unter dem Horizont)</span>`;
  const f = nightForecast(d, k);
  const fc = f ? ` · Prognose Kp ${kpFmt(f.kp)}${f.kp >= k.kp ? ` <span class="chance good">reicht!</span>` : ""}` : "";
  return `<span class="sky1">Polarlicht: <span class="chance ${k.cls}">${esc(k.chance)}</span> · dunkel ${hhmm(k.darkStart)}–${k.darkEnd ? hhmm(k.darkEnd) : "–"} · ab Kp ${kpTxt(k.kp)}${fc}</span>`;
}
function renderSky() {
  const tbl = document.getElementById("skyTable"); if (!tbl || !state) return;
  const list = sortedDays().filter(d => hasPos(d) && !/zu hause/i.test(d.night || ""));
  const W0 = 18, W1 = 32;   // Balken: 18:00–08:00
  const pos = ms => { const d = new Date(ms + TZ * 36e5); let h = d.getUTCHours() + d.getUTCMinutes() / 60; if (h < 12) h += 24; return Math.max(0, Math.min(100, (h - W0) / (W1 - W0) * 100)); };
  tbl.innerHTML = `<thead><tr><th>Nacht</th><th>Ort</th><th>Sonne unter / auf</th><th>Dunkel genug</th><th>18–08 Uhr</th><th>Mond</th><th>Kp nötig</th><th>Chance</th><th>Prognose</th></tr></thead><tbody>` +
    list.map(d => {
      const k = nightSky(d), f = nightForecast(d, k);
      const bar = k.darkStart && k.darkEnd ? `<i style="left:${pos(k.darkStart).toFixed(1)}%;width:${(pos(k.darkEnd) - pos(k.darkStart)).toFixed(1)}%"></i>` : "";
      return `<tr><td>${fmtDate(d.date)}</td><td>${esc(d.night || d.title || "")}</td>
        <td>${k.sunset ? hhmm(k.sunset) : "–"} / ${k.sunrise ? hhmm(k.sunrise) : "–"}</td>
        <td>${k.darkH >= 0.5 ? `${hhmm(k.darkStart)}–${k.darkEnd ? hhmm(k.darkEnd) : "–"} (${fmtH(k.darkH)})` : `nein (Sonne min. ${k.minAlt.toFixed(0)}°)`}</td>
        <td><span class="darkbar" aria-hidden="true">${bar}</span></td>
        <td>${Math.round(k.moon.frac * 100)} %${k.moon.frac > 0.6 ? " · hell" : ""}</td>
        <td>${kpTxt(k.kp)}</td>
        <td><span class="chance ${k.cls}">${esc(k.chance)}</span></td>
        <td>${f ? `<span class="chance ${f.kp >= k.kp && k.darkH >= 0.5 ? "good" : "low"}" title="${esc(f.src)}">Kp ${kpFmt(f.kp)}</span>` : `<span class="hint">–</span>`}</td></tr>`;
    }).join("") + `</tbody>`;

  const rank = { good: 3, mid: 2, low: 1, none: 0 };
  const best = list.map(d => ({ d, k: nightSky(d) })).filter(x => rank[x.k.cls] >= 2)
    .sort((a, b) => rank[b.k.cls] - rank[a.k.cls] || (b.k.darkH * (1 - b.k.moon.frac / 2)) - (a.k.darkH * (1 - a.k.moon.frac / 2))).slice(0, 3);
  $("#skyBest").innerHTML = best.map(({ d, k }) => `<div class="panel"><span class="hint">Beste Chance</span><b>${esc(d.night || "")}</b>
    <span>${fmtDate(d.date)} · dunkel ${hhmm(k.darkStart)}–${k.darkEnd ? hhmm(k.darkEnd) : "–"}</span><span>ab Kp ${kpTxt(k.kp)} · Mond ${Math.round(k.moon.frac * 100)} %</span></div>`).join("");
  renderSpaceNow(list);
}
function renderSpaceNow(list) {
  const el = document.getElementById("skyNow"); if (!el) return;
  if (space.loading && !space.loaded) { el.innerHTML = `<span class="hint">Lade aktuelle Daten der NOAA …</span>`; return; }
  if (!space.loaded) { el.innerHTML = `<span class="hint">${esc(space.err || "")}</span> <button class="btn ghost mini" type="button" id="skyRetry">Erneut laden</button>`; return; }
  const now = Date.now();
  const obs = space.kp3.filter(x => x.t <= now).pop();
  const next = space.kp3.filter(x => x.t > now && x.kind === "predicted");
  const peak = next.reduce((a, x) => x.kp > (a?.kp ?? -1) ? x : a, null);
  const days = Object.keys(space.outlook).sort(), first = days[0], last = days[days.length - 1];
  const tripStartD = list[0]?.date, inRange = tripStartD && last && tripStartD <= last;
  const fromDate = tripStartD ? new Date(new Date(tripStartD + "T12:00:00") - 27 * 864e5) : null;
  el.innerHTML = `<div class="panel"><span class="hint">Kp gerade</span><b>${obs ? kpFmt(obs.kp) : "–"}</b><span>${obs ? new Date(obs.t).toLocaleString("de-DE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " Uhr" : ""}</span></div>
    <div class="panel"><span class="hint">Höchster Kp, nächste 3 Tage</span><b>${peak ? kpFmt(peak.kp) : "–"}</b><span>${peak ? new Date(peak.t).toLocaleString("de-DE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " Uhr" : ""}</span></div>
    <div class="panel"><span class="hint">27-Tage-Ausblick</span><b>${first ? `${fmtDate(first)} – ${fmtDate(last)}` : "–"}</b>
      <span>${inRange ? "Deckt schon Nächte deiner Reise ab – siehe Spalte „Prognose“." : fromDate ? `Für deine Reise ab etwa ${fromDate.toLocaleDateString("de-DE", { day: "numeric", month: "long", year: "numeric" })}.` : ""}</span></div>`;
}

window.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("click", e => { if (e.target.id === "skyRetry") { space.at = 0; loadSpaceWeather(); } });
  appReady.then(() => { renderSky(); loadSpaceWeather(); });
  // bei längerer Nutzung (unterwegs) alle 30 Minuten auffrischen, wenn die Seite sichtbar ist
  setInterval(() => { if (document.visibilityState === "visible") loadSpaceWeather(); }, 30 * 60e3);
});
