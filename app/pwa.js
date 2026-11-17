/* Offline-App: Service Worker anmelden, „Neue Version verfügbar“ anzeigen, Offline-Hinweis. */
"use strict";

(function () {
  const bar = document.getElementById("updbar");
  const t0 = Date.now();
  function showUpdate(reg) {
    // Direkt nach dem Öffnen ist noch nichts bearbeitet → neue Version sofort übernehmen.
    // Kommt sie erst während der Nutzung, entscheidet die Person über den Hinweis.
    if (Date.now() - t0 < 8000 && reg.waiting) { reg.waiting.postMessage("skipWaiting"); return; }
    if (!bar) return;
    bar.hidden = false;
    bar.querySelector("button").onclick = () => {
      if (reg.waiting) reg.waiting.postMessage("skipWaiting"); else location.reload();
    };
  }
  if ("serviceWorker" in navigator) {
    // Versionsnummer unten auf der Seite anzeigen
    navigator.serviceWorker.addEventListener("message", e => {
      const el = document.getElementById("appver");
      if (el && e.data?.version) el.textContent = "Version " + (e.data.version.startsWith("__") ? "lokal" : e.data.version);
    });
    navigator.serviceWorker.ready.then(r => (navigator.serviceWorker.controller || r.active)?.postMessage("version"));
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloading) { reloading = true; location.reload(); } });
    navigator.serviceWorker.register("sw.js").then(reg => {
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          // erst eine Aktualisierung, wenn schon eine Version die Seite steuert (nicht beim allerersten Laden)
          if (w.state === "installed" && navigator.serviceWorker.controller) showUpdate(reg);
        });
      });
      // beim Zurückkehren zur App und stündlich nach einer neuen Version schauen
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && navigator.onLine) reg.update().catch(() => {}); });
      setInterval(() => { if (navigator.onLine) reg.update().catch(() => {}); }, 60 * 60e3);
    }).catch(e => console.warn("Service Worker", e));
  }

  // Offline-Hinweis im Kopf
  const net = document.getElementById("netstate");
  function netUpdate() { if (net) net.hidden = navigator.onLine; }
  window.addEventListener("online", netUpdate);
  window.addEventListener("offline", netUpdate);
  netUpdate();
})();
