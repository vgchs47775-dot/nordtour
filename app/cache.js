/* Berechnete Routen und Tankstellen/Trinkwasser über Supabase mit allen Geräten teilen
   (Tabelle route_cache, siehe supabase/cache.sql).
   - Beim Anmelden bzw. Öffnen: alles aus der Cloud holen, was hier noch fehlt.
   - Neu Berechnetes wird gesammelt hochgeladen.
   - Ist eine Anmeldung gespeichert, warten Routing und Overpass kurz auf die Cloud-Daten,
     damit ein Gerät nicht neu berechnet, was ein anderes schon hat.
   Wird nach sync.js geladen (braucht sb, syncUser). */
"use strict";

const CACHE_WAIT = 8000;            // so lange warten Routing/Overpass höchstens auf die Cloud
let cacheLoadedFor = null, cachePending = new Map(), cacheTimer = null, cacheMissing = false;
const hasStoredLogin = (() => { try { return Object.keys(localStorage).some(k => /^sb-.+-auth-token$/.test(k)); } catch { return false; } })();
let cacheResolve = () => {};
window.cloudCacheReady = (sb && hasStoredLogin) ? new Promise(r => { cacheResolve = r; }) : null;
async function waitCloudCache() { if (window.cloudCacheReady) await Promise.race([window.cloudCacheReady, sleep(CACHE_WAIT)]); }

function usedKeys() {
  const r = new Set(), o = new Set();
  sortedDays().forEach((d, i, l) => { const k = routeKey(dayPoints(d, i, l)); r.add(k); o.add(k); });
  if (typeof extraRouteKeys === "function") extraRouteKeys().forEach(k => r.add(k));
  for (const e of state.routeList || []) for (const k of e.keys || []) { r.add(k); o.add(k); }   // andere gespeicherte Routen nicht wegräumen
  return { r, o };
}
async function loadCloudCache() {
  try {
    if (!sb || !syncUser || !navigator.onLine || cacheLoadedFor === syncUser.id) return;
    const { data, error } = await sb.from("route_cache").select("kind, key, data, updated_at");
    if (error) { cacheMissing = /route_cache|schema cache|does not exist/i.test(error.message); console.warn("Cloud-Cache", error.message); return; }
    cacheLoadedFor = syncUser.id;
    let added = 0;
    for (const row of data) {
      if (row.kind === "route" && !routes[row.key]) { routes[row.key] = row.data; added++; }
      if (row.kind === "osm" && typeof osmData !== "undefined" && !osmData[row.key]) { osmData[row.key] = row.data; added++; }
    }
    if (added) { saveRoutes(); if (typeof saveOsm === "function") saveOsm(); refresh(); }
    // Was hier schon berechnet war, aber in der Cloud fehlt, hochladen; Veraltetes aufräumen
    const have = new Set(data.map(r => r.kind + "|" + r.key)), { r, o } = usedKeys();
    for (const k of r) if (routes[k] && !have.has("route|" + k)) cacheUp("route", k, routes[k]);
    for (const k of o) if (typeof osmData !== "undefined" && osmData[k] && !have.has("osm|" + k)) cacheUp("osm", k, osmData[k]);
    const old = data.filter(x => !(x.kind === "route" ? r : o).has(x.key) && Date.now() - Date.parse(x.updated_at) > 14 * 864e5);
    for (const x of old) await sb.from("route_cache").delete().eq("kind", x.kind).eq("key", x.key);
  } finally { cacheResolve(); }
}
// Neu Berechnetes sammeln und alle paar Sekunden gemeinsam hochladen
function cacheUp(kind, key, data) {
  if (!sb || !syncUser || cacheMissing) return;
  cachePending.set(kind + "|" + key, { owner: syncUser.id, kind, key, data, updated_at: new Date().toISOString() });
  clearTimeout(cacheTimer); cacheTimer = setTimeout(flushCache, 3000);
}
async function flushCache() {
  if (!cachePending.size || !navigator.onLine || !syncUser) return;
  const rows = [...cachePending.values()]; cachePending.clear();
  for (let i = 0; i < rows.length; i += 10) {
    const { error } = await sb.from("route_cache").upsert(rows.slice(i, i + 10), { onConflict: "owner,kind,key" });
    if (error) { console.warn("Cloud-Cache hochladen", error.message); if (/route_cache|schema cache/i.test(error.message)) cacheMissing = true; }
  }
}
window.addEventListener("online", flushCache);

if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    if (session?.user) setTimeout(() => appReady.then(loadCloudCache), 0);
    else cacheResolve();                                    // nicht angemeldet → nicht warten
  });
}
