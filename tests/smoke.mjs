// Selbsttest vor jeder Veröffentlichung (läuft im GitHub-Workflow „Seite veröffentlichen“).
// Öffnet die App mit ERFUNDENEN Beispieldaten in einem Test-Browser, klickt alle Reiter durch und
// bricht ab, wenn ein JavaScript-Fehler auftritt oder ein Reiter leer bleibt.
// Externe Dienste (Routing, Ortssuche, Overpass, Supabase, NOAA) werden blockiert – die App muss
// damit umgehen können, und die freiwilligen Server werden nicht belastet.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://127.0.0.1:8642/";
const ALLOWED = ["127.0.0.1", "localhost", "unpkg.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

// Erfundene Mini-Reise (keine echten Reisedaten)
const sample = {
  days: [
    { id: "t1", order: 1, date: "2030-07-01", title: "Start → Lillehammer", night: "Lillehammer", lat: 61.115, lon: 10.466, via: [{ name: "Hamar", lat: 60.795, lon: 11.068, stay: 45 }] },
    { id: "t2", order: 2, date: "2030-07-02", title: "Lillehammer → Trondheim", night: "Trondheim", lat: 63.43, lon: 10.395, via: [] },
    { id: "t3", order: 3, date: "2030-07-03", title: "Ruhetag in Trondheim", night: "Trondheim", lat: 63.43, lon: 10.395, via: [] }
  ],
  costs: [{ id: "c1", cat: "Fähren", dayId: "t1", title: "Testfähre", amount: 20 }, { id: "c2", cat: "Unterkunft", dayId: "t2", title: "Testnacht", amount: null }],
  todos: [{ id: "x1", title: "Testaufgabe", due: "2030-06-01", done: false }],
  pack: [{ id: "p1", cat: "Auto", name: "Warnweste", qty: "1", note: null, done: false }],
  buy: [{ id: "b1", cat: "Technik", name: "Testkabel", prio: "Muss", price: 9.99, link: "https://example.com/", note: null, done: false }],
  journal: { t1: { text: "Testeintrag", photos: [] } },
  settings: { home: { name: "Start", lat: 59.91, lon: 10.75 }, main: { persons: 2, consumption: 7, fuelPrice: 2, autoFuel: true }, panorama_geplant: [], sights_geplant: [] }
};

// Reiter → woran man erkennt, dass er etwas anzeigt
const VIEWS = {
  route: "#days .day",
  panorama: ".pano-card",
  erleben: "#sightList",
  orte: "#ortList .ortrow",
  himmel: "#skyTable tbody tr",
  tagebuch: ".jday",
  kosten: "#costGroups .group",
  todos: "#todoRows .todo-row",
  packen: "#packGroups .group",
  kaufen: "#buyOpen .card"
};

const problems = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
page.on("pageerror", e => problems.push("JavaScript-Fehler: " + e.message));
page.on("console", m => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/Failed to load resource|net::ERR|ERR_FAILED|blocked/i.test(t)) return;   // blockierte Dienste sind gewollt
  problems.push("Konsolenfehler: " + t);
});
await page.route("**/*", route => {
  const host = new URL(route.request().url()).hostname;
  return ALLOWED.includes(host) ? route.continue() : route.abort("blockedbyclient");
});
await page.addInitScript(data => {
  if (!localStorage.getItem("nordtour.v1")) localStorage.setItem("nordtour.v1", JSON.stringify(data));
}, sample);

await page.goto(BASE, { waitUntil: "load" });
await page.waitForTimeout(2500);

for (const [view, sel] of Object.entries(VIEWS)) {
  await page.evaluate(v => { location.hash = "#" + v; }, view);
  await page.waitForTimeout(400);
  const visible = await page.isVisible("#v-" + view);
  const count = await page.locator(sel).count();
  console.log(`${visible && count ? "ok  " : "FEHL"} ${view.padEnd(9)} ${count} × ${sel}`);
  if (!visible) problems.push(`Reiter „${view}“ wird nicht angezeigt`);
  else if (!count) problems.push(`Reiter „${view}“ ist leer (${sel})`);
}

// Ein paar Bedienschritte
await page.evaluate(() => { location.hash = "#route"; });
await page.click("#btnReorder"); await page.click("#btnReorder");
await page.click("#btnMapEdit"); await page.click("#btnMapEdit");
await page.click('.day[data-day="t2"] .t');            // kompakte Kärtchen: erst aufklappen
await page.click('[data-extend="t2"]');
await page.waitForTimeout(300);
const n = await page.locator("#days .day").count();
if (n !== 4) problems.push(`„+ Nacht“ hat nicht funktioniert (erwartet 4 Tage, gefunden ${n})`);
const sw = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
if (!sw) problems.push("Service Worker (Offline-Modus) wurde nicht angemeldet");

await browser.close();
if (problems.length) {
  console.error("\nSelbsttest fehlgeschlagen – die Seite wird NICHT veröffentlicht:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("\nSelbsttest bestanden.");
