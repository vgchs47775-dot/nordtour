/* Darstellung: Hell, Dunkel oder Automatisch (wie das Gerät). Gilt pro Gerät.
   Wird im <head> geladen, damit die Seite nicht erst in der falschen Darstellung aufblitzt.
   style.css richtet sich nur nach <html data-theme="light|dark">. Andere Skripte fragen isDark()
   und hören auf das Ereignis „themechange“. */
"use strict";

(function () {
  const KEY = "nordtour.theme", mq = matchMedia("(prefers-color-scheme: dark)");
  let pref = "auto";
  try { const p = localStorage.getItem(KEY); if (p === "light" || p === "dark") pref = p; } catch { /* egal */ }

  window.isDark = () => pref === "dark" || (pref === "auto" && mq.matches);
  function apply() {
    document.documentElement.dataset.theme = window.isDark() ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", window.isDark() ? "#0e171d" : "#1f4e63");
    document.querySelectorAll("[data-themeset]").forEach(b => b.setAttribute("aria-pressed", b.dataset.themeset === pref ? "true" : "false"));
    window.dispatchEvent(new Event("themechange"));
  }
  apply();
  mq.addEventListener?.("change", () => { if (pref === "auto") apply(); });
  document.addEventListener("click", e => {
    const b = e.target.closest?.("[data-themeset]"); if (!b) return;
    pref = b.dataset.themeset;
    try { pref === "auto" ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, pref); } catch { /* egal */ }
    apply();
  });
  document.addEventListener("DOMContentLoaded", apply);      // Knöpfe markieren
})();
