/* Maut in Norwegen grob schätzen.
   Für jede berechnete Etappe fragt die App Valhalla (trace_attributes), welche Knotenpunkte
   auf der Strecke liegen – darunter Mautstationen (toll_gantry / toll_booth). Gezählt werden nur
   Stationen in Norwegen (grober Umriss unten) und nicht die Kassenhäuschen an Fähranlegern
   (Fähren stehen separat bei den Kosten). Kosten = Anzahl × Preis je Station (Einstellung, Standard
   30 NOK). Das Ergebnis hängt an der Route (routes[key].tolls) und wird mit ihr geteilt (cache.js).
   Sehr grob: Preise schwanken je Station (ca. 10–80 NOK), manche zählen nur in einer Richtung,
   in Städten oft nur einmal pro Stunde. Wird nach osm.js geladen. */
"use strict";

const TRACE = "https://valhalla1.openstreetmap.de/trace_attributes";
const EUR_PER_NOK = 0.085;           // grober Kurs (1 € ≈ 11,8 NOK)
const TOLL_DEFAULT_NOK = 30;
let tollBusy = false;

// Grober Umriss Norwegens (lat, lon) – auf ±20 km genau, reicht für Mautstellen auf dieser Route
const NORWAY = [[59.05, 11.0], [59.1, 11.45], [59.5, 11.8], [59.9, 12.3], [60.6, 12.6], [61.0, 12.75], [61.6, 12.35],
  [62.2, 12.25], [62.9, 12.1], [63.6, 12.15], [64.3, 13.6], [64.7, 14.2], [65.3, 14.4], [66.1, 14.6], [66.7, 15.45],
  [67.2, 16.2], [67.8, 16.9], [68.15, 17.9], [68.45, 18.15], [68.5, 18.9], [68.7, 20.1], [69.06, 20.55], [69.25, 21.2],
  [68.9, 22.3], [68.75, 23.2], [68.65, 24.4], [69.05, 25.7], [69.6, 25.95], [69.95, 27.2], [70.05, 28.2], [69.85, 29.1],
  [69.65, 29.6], [69.7, 30.5], [70.2, 31.4], [71.4, 31.0], [71.4, 3.5], [57.6, 3.5], [57.6, 8.0], [58.9, 10.8]];
function inNorway(lat, lon) {
  let inside = false;
  for (let i = 0, j = NORWAY.length - 1; i < NORWAY.length; j = i++) {
    const [yi, xi] = NORWAY[i], [yj, xj] = NORWAY[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function traceTolls(r) {
  const nearFerry = (lat, lon) => (r.ferries || []).some(f => f.from && [f.from, f.to].some(q => hav({ lat, lon }, { lat: q[0], lon: q[1] }) < 0.6));
  const out = [];
  for (const p of r.parts.filter(p => !p.ferry)) {
    const body = { encoded_polyline: p.enc, costing: "auto", shape_match: "edge_walk",
      filters: { attributes: ["node.type", "edge.end_shape_index", "edge.names"], action: "include" } };
    let res = await fetch(TRACE, { method: "POST", body: JSON.stringify(body) });
    if (res.status === 400) {                                        // kein exakter Abgleich → Kartenabgleich
      body.shape_match = "walk_or_snap"; res = await fetch(TRACE, { method: "POST", body: JSON.stringify(body) });
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || "Valhalla antwortet mit " + res.status);
    const shape = decodePolyline(p.enc);
    for (const e of j.edges || []) {
      const t = e.end_node?.type; if (t !== "toll_gantry" && t !== "toll_booth") continue;
      const [lat, lon] = shape[Math.min(e.end_shape_index ?? 0, shape.length - 1)];
      if (nearFerry(lat, lon)) continue;
      out.push({ lat: +lat.toFixed(4), lon: +lon.toFixed(4), type: t, road: (e.names || [])[0] || "", no: inNorway(lat, lon) });
    }
    await sleep(400);
  }
  return { pts: out, at: Date.now() };
}
async function ensureTolls() {
  if (tollBusy || !navigator.onLine) return;
  tollBusy = true;
  try {
    if (typeof waitCloudCache === "function") await waitCloudCache();
    const list = sortedDays();
    for (let i = 0; i < list.length; i++) {
      const d = list[i], pts = dayPoints(d, i, list); if (pts.length < 2) continue;
      const key = routeKey(pts), r = routes[key];
      if (!r || !r.km || r.tolls || (r.tollRetry || 0) > Date.now()) continue;
      try {
        r.tolls = await traceTolls(r); saveRoutes();
        if (typeof cacheUp === "function") cacheUp("route", key, r);     // mit anderen Geräten teilen
      } catch (e) { r.tollRetry = Date.now() + 10 * 60e3; console.warn("Maut", d.id, e); }
      renderDay(d.id);
    }
    if (typeof renderCostTop === "function" && state.costs) { renderCosts(); updateStats(); }
  } finally { tollBusy = false; }
}
window.addEventListener("online", ensureTolls);

/* ---------- Auswertung ---------- */
const tollNok = () => Number(state?.settings?.main?.tollNok) || TOLL_DEFAULT_NOK;
function dayTolls(r) { return (r?.tolls?.pts || []).filter(t => t.no); }
function tollTotals() {
  const list = sortedDays(); let n = 0, known = 0, open = 0;
  list.forEach((d, i) => {
    const pts = dayPoints(d, i, list); if (pts.length < 2) return;
    const r = routes[routeKey(pts)];
    if (r?.tolls) { known++; n += dayTolls(r).length; } else if (r?.km) open++;
  });
  return { n, known, open, eur: n * tollNok() * EUR_PER_NOK };
}
function tollDayHtml(d, r) {
  const t = dayTolls(r); if (!r?.tolls || !t.length) return "";
  const eur = t.length * tollNok() * EUR_PER_NOK;
  return `<span class="osm">🛣 ${t.length} Mautstelle${t.length > 1 ? "n" : ""} in Norwegen · grob ${euro(eur)}</span>`;
}
