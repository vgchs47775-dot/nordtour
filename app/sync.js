/* Cloud-Speicher über Supabase.
   Eine Zeile pro Reise in der Tabelle "trips"; lesen/schreiben darf nur der angemeldete Besitzer (RLS).
   Ablauf: jede Änderung landet sofort im Browser (localStorage) und wird kurz danach hochgeladen.
   Beim Öffnen und beim Zurückkehren zur Seite wird der Cloud-Stand geholt.
   Konflikte (zwei Geräte ändern gleichzeitig) werden über die Spalte "version" erkannt. */
"use strict";

const CFG = window.NORDTOUR_CONFIG || {};
const TRIP_ID = "nordtour-2027";
const SSTORE = "nordtour.sync.v1";        // { version, dirty, user }
const sb = CFG.supabaseUrl && CFG.supabaseKey && window.supabase
  ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey) : null;

let syncUser = null, syncInfo = loadSyncInfo(), syncStatus = "off", syncMsg = "";
let pushTimer = null, pushing = false, pushAgain = false, conflictMine = null;

function loadSyncInfo() { try { return JSON.parse(localStorage.getItem(SSTORE)) || { version: 0, dirty: false }; } catch { return { version: 0, dirty: false }; } }
function storeSyncInfo(patch) { Object.assign(syncInfo, patch); try { localStorage.setItem(SSTORE, JSON.stringify(syncInfo)); } catch { /* egal */ } }
function lastSyncedKey() { return "nordtour.synced." + (syncUser?.id || ""); }
function sameAsSynced() { try { return localStorage.getItem(lastSyncedKey()) === JSON.stringify(state); } catch { return false; } }
function rememberSynced() { try { localStorage.setItem(lastSyncedKey(), JSON.stringify(state)); } catch { /* egal */ } }

/* ---------- Anzeige ---------- */
function setSync(s, msg = "") { syncStatus = s; syncMsg = msg; renderSync(); }
function renderSync() {
  const el = $("#sync"); if (!el) return;
  if (!sb) { el.innerHTML = `<span class="chip off">Nur in diesem Browser gespeichert</span>`; return; }
  if (!syncUser) {
    el.innerHTML = `<span class="chip off">Nicht angemeldet – nur in diesem Browser</span><button class="btn mini" type="button" id="btnLogin">Anmelden</button>`;
    return;
  }
  const label = { ok: "✓ In der Cloud gespeichert", busy: "Speichert …", load: "Lädt …", err: "⚠ Nicht gespeichert" }[syncStatus] || "";
  el.innerHTML = `<span class="chip ${syncStatus}"${syncMsg ? ` title="${esc(syncMsg)}"` : ""}>${label}</span>` +
    (syncStatus === "err" ? `<button class="btn ghost mini" type="button" id="btnRetry">Erneut versuchen</button>` : "") +
    `<span class="who">${esc(syncUser.email || "")}</span><button class="btn ghost mini" type="button" id="btnLogout">Abmelden</button>`;
}

/* ---------- Laden aus der Cloud ---------- */
async function pull({ first = false } = {}) {
  if (!sb || !syncUser || pushing || pushTimer) return;
  setSync("load");
  const { data, error } = await sb.from("trips").select("data, version").eq("id", TRIP_ID).maybeSingle();
  if (error) return setSync("err", error.message);

  if (!data) {                                   // Cloud ist noch leer
    storeSyncInfo({ version: 0 });
    if (state?.days?.length) {
      await push();
      if (syncStatus === "ok") notice("Deine Reisedaten sind jetzt in der Cloud. Ab sofort sind sie auf allen Geräten gleich, auf denen du angemeldet bist.");
    } else setSync("ok");
    return;
  }
  if (data.version === syncInfo.version) {       // nichts Neues in der Cloud
    if (syncInfo.dirty && !sameAsSynced()) return push();
    return setSync("ok");
  }
  // In der Cloud gibt es einen neueren Stand.
  const hadLocal = state?.days?.length > 0;
  if (syncInfo.dirty && hadLocal && !sameAsSynced()) conflictMine = JSON.parse(JSON.stringify(state));
  applyRemote(data);
  if (conflictMine) {
    notice("Auf einem anderen Gerät wurde inzwischen etwas geändert. Dieser neuere Stand wurde geladen.", false,
      `<button class="btn ghost mini" type="button" id="btnKeepMine">Stattdessen meine Version aus diesem Browser behalten</button>`);
  } else if (first && !hadLocal) {
    notice(`${state.days?.length || 0} Tage aus der Cloud geladen.`);
  }
  if (first) fitAll();
}
function applyRemote(row) {
  state = row.data;
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* egal */ }
  storeSyncInfo({ version: row.version, dirty: false });
  rememberSynced();
  selDay = editingDay = null;
  refresh();
  setSync("ok");
}

/* ---------- Hochladen ---------- */
function schedulePush() {
  if (!sb || !syncUser) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; push(); }, 1200);
  setSync("busy");
}
async function push() {
  if (!sb || !syncUser) return;
  if (pushing) { pushAgain = true; return; }
  pushing = true; setSync("busy");
  const snap = JSON.parse(JSON.stringify(state));
  try {
    if (!syncInfo.version) {
      const { data, error } = await sb.from("trips").insert({ id: TRIP_ID, data: snap, version: 1 }).select("version").single();
      if (error?.code === "23505") return await onConflict(snap);   // gibt es schon (anderes Gerät war schneller)
      if (error) throw error;
      storeSyncInfo({ version: data.version, dirty: false });
    } else {
      const { data, error } = await sb.from("trips")
        .update({ data: snap, version: syncInfo.version + 1, updated_at: new Date().toISOString() })
        .eq("id", TRIP_ID).eq("version", syncInfo.version).select("version");
      if (error) throw error;
      if (!data.length) return await onConflict(snap);             // Version passt nicht mehr
      storeSyncInfo({ version: data[0].version, dirty: false });
    }
    try { localStorage.setItem(lastSyncedKey(), JSON.stringify(snap)); } catch { /* egal */ }
    setSync("ok");
  } catch (e) {
    setSync("err", e.message || String(e));
  } finally {
    pushing = false;
    if (pushAgain) { pushAgain = false; schedulePush(); }
  }
}
async function onConflict(mine) {
  conflictMine = mine;
  pushing = false;
  const { data, error } = await sb.from("trips").select("data, version").eq("id", TRIP_ID).maybeSingle();
  if (error || !data) return setSync("err", error?.message || "Konflikt");
  applyRemote(data);
  notice("Auf einem anderen Gerät wurde gleichzeitig etwas geändert. Der Stand aus der Cloud wurde geladen, deine letzte Änderung ist darin nicht enthalten.", false,
    `<button class="btn ghost mini" type="button" id="btnKeepMine">Stattdessen meine Version behalten</button>`);
}

// Wird von save() in app.js nach jeder lokalen Änderung aufgerufen.
function onLocalSave() {
  if (!sb || !syncUser) { storeSyncInfo({ dirty: true }); return; }
  if (sameAsSynced()) return;                    // z. B. nur neu geladene Routen mit gleichen Werten
  storeSyncInfo({ dirty: true });
  schedulePush();
}

/* ---------- Anmelden / Abmelden ---------- */
document.addEventListener("click", async e => {
  const id = e.target.id;
  if (id === "btnLogin") { $("#loginErr").textContent = ""; $("#loginDlg").showModal(); }
  if (id === "loginCancel") $("#loginDlg").close();
  if (id === "btnRetry") push();
  if (id === "btnLogout") {
    if (syncInfo.dirty && !confirm("Die letzte Änderung ist noch nicht in der Cloud. Trotzdem abmelden?")) return;
    await sb.auth.signOut();
    notice("Abgemeldet. Die Daten bleiben in diesem Browser, werden aber nicht mehr mit der Cloud abgeglichen.");
  }
  if (id === "btnKeepMine" && conflictMine) {
    undoSnap = JSON.stringify(state.days);
    state = conflictMine; conflictMine = null;
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* egal */ }
    storeSyncInfo({ dirty: true });
    refresh(); $("#notice").hidden = true; push();
  }
});
$("#loginForm")?.addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector("[type=submit]"), err = $("#loginErr");
  btn.disabled = true; err.textContent = "";
  const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
  btn.disabled = false;
  if (error) {
    err.textContent = /invalid login/i.test(error.message) ? "E-Mail oder Passwort stimmt nicht." :
      /not confirmed/i.test(error.message) ? "Die E-Mail-Adresse ist noch nicht bestätigt." : error.message;
    return;
  }
  f.password.value = "";
  $("#loginDlg").close();
});

/* ---------- Start ---------- */
if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    const before = syncUser?.id;
    syncUser = session?.user || null;
    renderSync();
    // Supabase-Aufrufe nicht direkt im Callback ausführen (Empfehlung der Bibliothek)
    if (syncUser && syncUser.id !== before) setTimeout(() => appReady.then(() => pull({ first: true })), 0);
  });
  // Beim Zurückkehren zur Seite (z. B. iPad aus dem Standby) neuen Stand holen
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pull(); });
  window.addEventListener("online", () => { if (syncInfo.dirty) push(); else pull(); });
}
renderSync();
