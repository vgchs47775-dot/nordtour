/* Sicherungen ansehen, herunterladen und wiederherstellen.
   Die Sicherungen legt Supabase selbst an (jede Nacht, nur bei Änderungen; siehe supabase/sicherung.sql).
   Wird nach sync.js geladen (braucht sb, syncUser, TRIP_ID, push, syncInfo). */
"use strict";

let backupRows = [];
const fmtWhen = iso => new Date(iso).toLocaleString("de-DE", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
function backupSummary(d) {
  const days = d?.days?.length || 0, photos = Object.values(d?.journal || {}).reduce((a, j) => a + (j.photos?.length || 0), 0);
  const texts = Object.values(d?.journal || {}).filter(j => j.text).length;
  return `${days} Tage · ${d?.costs?.length || 0} Kostenposten · ${d?.pack?.length || Object.values(d?.items_packen || {}).flat().length} Packstücke` +
    (texts || photos ? ` · Tagebuch: ${texts} Einträge, ${photos} Fotos` : "");
}
async function loadBackups() {
  const list = $("#backupList"), msg = $("#backupMsg");
  msg.textContent = "Lade Sicherungen …"; list.innerHTML = "";
  if (!navigator.onLine) { msg.textContent = "Für die Sicherungen brauchst du Internet."; return; }
  const { data, error } = await sb.from("trip_backups").select("id, saved_at, version, data")
    .eq("trip_id", TRIP_ID).order("saved_at", { ascending: false }).limit(40);
  if (error) {
    msg.textContent = /trip_backups|schema cache|does not exist/i.test(error.message)
      ? "Die automatische Sicherung ist noch nicht eingerichtet (supabase/sicherung.sql im Supabase-SQL-Editor ausführen)."
      : "Fehler: " + error.message;
    return;
  }
  backupRows = data || [];
  msg.textContent = backupRows.length
    ? `${backupRows.length} Sicherung${backupRows.length > 1 ? "en" : ""}. Supabase sichert jede Nacht automatisch, wenn sich etwas geändert hat.`
    : "Noch keine Sicherung vorhanden – „Jetzt sichern“ legt die erste an.";
  list.innerHTML = backupRows.map((b, i) => `<li class="brow">
    <span class="nm">${fmtWhen(b.saved_at)}${i === 0 ? ` <span class="pill ok">neueste</span>` : ""}<span class="nt">${esc(backupSummary(b.data))}</span></span>
    <span class="acts"><button class="btn ghost mini" type="button" data-bdl="${b.id}">Herunterladen</button>
    <button class="btn ghost mini" type="button" data-brestore="${b.id}">Wiederherstellen</button></span>
  </li>`).join("");
}
async function backupNow(quiet = false) {
  if (syncInfo.dirty) await push();                       // erst den aktuellen Stand hochladen
  const { data, error } = await sb.rpc("backup_now");
  if (error) { if (!quiet) $("#backupMsg").textContent = "Sichern fehlgeschlagen: " + error.message; return false; }
  if (!quiet) notice(data ? "Aktueller Stand gesichert." : "Der aktuelle Stand war schon gesichert.");
  return true;
}
function downloadBackup(b) {
  const blob = new Blob([JSON.stringify({ _info: "Nordtour-Sicherung vom " + fmtWhen(b.saved_at), ...b.data }, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `nordtour-sicherung-${b.saved_at.slice(0, 10)}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function restoreBackup(b) {
  if (!confirm(`Stand vom ${fmtWhen(b.saved_at)} wiederherstellen?\n\n${backupSummary(b.data)}\n\nDer jetzige Stand wird vorher noch gesichert, du kannst also zurück.`)) return;
  if (!(await backupNow(true))) { alert("Der jetzige Stand konnte nicht gesichert werden – Wiederherstellen abgebrochen."); return; }
  state = JSON.parse(JSON.stringify(b.data)); delete state._info;
  selDay = editingDay = null;
  save(); refresh();
  $("#backupDlg").close();
  notice(`Stand vom ${esc(fmtWhen(b.saved_at))} wiederhergestellt. Der vorherige Stand liegt unter „Sicherungen“.`);
}

document.addEventListener("click", async e => {
  if (e.target.id === "btnBackups") { $("#backupDlg").showModal(); loadBackups(); return; }
  if (e.target.id === "backupClose") { $("#backupDlg").close(); return; }
  if (e.target.id === "backupNow") { e.target.disabled = true; if (await backupNow()) await loadBackups(); e.target.disabled = false; return; }
  const dl = e.target.closest("[data-bdl]"); if (dl) { const b = backupRows.find(x => x.id === +dl.dataset.bdl); if (b) downloadBackup(b); return; }
  const rs = e.target.closest("[data-brestore]"); if (rs) { const b = backupRows.find(x => x.id === +rs.dataset.brestore); if (b) restoreBackup(b); }
});
