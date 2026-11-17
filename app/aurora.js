/* Polarlicht-Karte live (NOAA OVATION-Modell, Kurzfrist-Vorhersage für die nächste ~Stunde).
   - Bild: aktuelle Vorhersagekarte der Nordhalbkugel (NOAA, gemeinfrei)
   - Daten: Wahrscheinlichkeit sichtbaren Polarlichts je Längen-/Breitengrad (ca. 0,9 MB) –
     nur geladen, wenn der Reiter „Nachthimmel“ offen ist, höchstens alle 30 Minuten.
   Während der Reise: Wert für den heutigen Übernachtungsort. Vorher: zur Orientierung für die
   nördlichsten Übernachtungen. Wird nach sky.js geladen (braucht sunAlt). */
"use strict";

const OVATION_JSON = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";
const OVATION_IMG = "https://services.swpc.noaa.gov/images/animations/ovation/north/latest.jpg";
let ovation = { grid: null, at: 0, forecast: null, loading: false, err: "" };

async function loadOvation(force = false) {
  if (ovation.loading || (!force && ovation.grid && Date.now() - ovation.at < 30 * 60e3)) { renderAurora(); return; }
  if (!navigator.onLine) { ovation.err = "Offline – die Polarlicht-Karte braucht Internet."; renderAurora(); return; }
  ovation.loading = true; renderAurora();
  try {
    const j = await (await fetch(OVATION_JSON, { cache: "no-store" })).json();
    const grid = new Uint8Array(360 * 181);                 // [lon 0..359][lat -90..90]
    for (const [lon, lat, v] of j.coordinates) grid[lon * 181 + (lat + 90)] = v;
    ovation = { grid, at: Date.now(), forecast: j["Forecast Time"], loading: false, err: "" };
  } catch (e) { ovation.loading = false; ovation.err = "Die NOAA-Daten sind gerade nicht abrufbar."; }
  renderAurora();
}
function auroraAt(lat, lon) {
  if (!ovation.grid) return null;
  const lo = ((Math.round(lon) % 360) + 360) % 360, la = Math.max(-90, Math.min(90, Math.round(lat)));
  return ovation.grid[lo * 181 + (la + 90)];
}
function auroraClass(v) { return v >= 30 ? "good" : v >= 10 ? "mid" : v >= 3 ? "low" : "none"; }

function renderAurora() {
  const el = document.getElementById("auroraNow"); if (!el || !state) return;
  const today = new Date().toISOString().slice(0, 10);
  const nights = sortedDays().filter(d => hasPos(d) && !/zu hause/i.test(d.night || ""));
  const tonight = nights.find(d => d.date === today);
  // vor/nach der Reise: die nördlichsten Übernachtungen (ab 66° N) zur Orientierung
  const shown = tonight ? [tonight] : [...new Map(nights.filter(d => d.lat >= 66).map(d => [nightBase(d.night), d])).values()].slice(0, 6);
  const fc = ovation.forecast ? new Date(ovation.forecast).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "";
  const rows = shown.map(d => {
    const v = auroraAt(d.lat, d.lon), dark = sunAlt(Date.now(), d.lat, d.lon) <= -8;
    return `<li><b>${esc(nightBase(d.night))}</b>${v == null ? `<span class="hint">–</span>` : `<span class="chance ${auroraClass(v)}">${v} %</span>`}
      <span class="hint">${dark ? "dort ist es gerade dunkel genug" : "dort ist es gerade zu hell"}</span></li>`;
  }).join("");
  el.innerHTML = `<div class="panel aurora">
    <div class="aurora-img"><a href="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast" target="_blank" rel="noopener">
      <img src="${OVATION_IMG}?t=${Math.floor(Date.now() / 6e5)}" alt="Polarlicht-Vorhersagekarte der NOAA für die Nordhalbkugel" loading="lazy"></a>
      <span class="hint">Karte: NOAA SWPC (OVATION), grün bis rot = steigende Wahrscheinlichkeit</span></div>
    <div class="aurora-txt">
      <h3>Polarlicht jetzt</h3>
      <p class="hint">${tonight ? `Für deine heutige Übernachtung` : `Gerade jetzt an deinen nördlichen Übernachtungsorten – nur zur Orientierung, die Karte gilt immer für die nächste Stunde`}${fc ? ` · Vorhersage für ${fc} Uhr` : ""}</p>
      ${ovation.loading && !ovation.grid ? `<p class="hint">Lade NOAA-Daten …</p>` : ovation.err && !ovation.grid ? `<p class="hint">${esc(ovation.err)}</p>` : `<ul class="alist">${rows}</ul>`}
      <p class="hint">Prozent = Wahrscheinlichkeit für sichtbares Polarlicht direkt über dem Ort laut Modell. Ab etwa 10 % lohnt sich ein Blick nach Norden, ab 30 % gute Chancen – wenn es dunkel und wolkenfrei ist.</p>
      <button type="button" class="btn ghost mini" id="auroraReload">Neu laden</button>
    </div></div>`;
}
window.addEventListener("hashchange", () => { if (location.hash === "#himmel") loadOvation(); });
document.addEventListener("click", e => { if (e.target.id === "auroraReload") loadOvation(true); });
setInterval(() => { if (location.hash === "#himmel" && document.visibilityState === "visible") loadOvation(); }, 10 * 60e3);
window.addEventListener("DOMContentLoaded", () => appReady.then(() => { renderAurora(); if (location.hash === "#himmel") loadOvation(); }));
