/* Reisetagebuch: pro Reisetag Text und Fotos.
   - Text steht in state.journal[dayId].text und läuft über den normalen Sync mit (auch offline schreibbar).
   - Fotos werden im Browser auf max. 1600 px verkleinert (JPEG) und in eine Warteschlange (IndexedDB)
     gelegt. Sobald Internet + Anmeldung da sind, gehen sie in den privaten Supabase-Storage-Bucket
     „tagebuch“ (Pfad <Benutzer-ID>/<Tag>/<Foto-ID>.jpg); in state.journal stehen nur die Pfade.
   - Angesehene Fotos hält der Service Worker offline vor (sw.js). */
"use strict";

const BUCKET = "tagebuch", MAX_EDGE = 1600, QUALITY = 0.8;
const signed = {};                 // Pfad -> { url, exp }
let queue = [];                    // Fotos, die noch hochgeladen werden müssen (Spiegel der IndexedDB)
let qErr = "", qBusy = false, jSaveTimer = null, lightbox = null;

const jEntry = id => { state.journal = state.journal || {}; return (state.journal[id] = state.journal[id] || { text: "", photos: [] }); };
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* ---------- IndexedDB-Warteschlange ---------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("nordtour", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("uploads", { keyPath: "id" });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function qAll() { const db = await idb(); return new Promise(res => { const r = db.transaction("uploads").objectStore("uploads").getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); }); }
async function qPut(item) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction("uploads", "readwrite"); t.objectStore("uploads").put(item); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
async function qDel(id) { const db = await idb(); return new Promise(res => { const t = db.transaction("uploads", "readwrite"); t.objectStore("uploads").delete(id); t.oncomplete = res; t.onerror = res; }); }
async function reloadQueue() {
  queue.forEach(q => q.url && URL.revokeObjectURL(q.url));
  queue = (await qAll().catch(() => [])).map(q => ({ ...q, url: URL.createObjectURL(q.blob) }));
}

/* ---------- Foto verkleinern ---------- */
async function shrink(file) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Bild nicht lesbar")); i.src = URL.createObjectURL(file); });
  }
  const w = src.width, h = src.height, s = Math.min(1, MAX_EDGE / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", QUALITY));
  if (!blob) throw new Error("Bild konnte nicht umgewandelt werden");
  return { blob, w: c.width, h: c.height };
}
async function addPhotos(dayId, files) {
  let n = 0;
  for (const f of files) {
    try {
      const { blob, w, h } = await shrink(f);
      await qPut({ id: newId(), dayId, blob, w, h, created: new Date().toISOString() }); n++;
    } catch (e) { qErr = `„${f.name}“: ${e.message}`; }
  }
  await reloadQueue(); renderJournal();
  processQueue();
  return n;
}

/* ---------- Hochladen ---------- */
async function processQueue() {
  if (qBusy || !queue.length || typeof sb === "undefined" || !sb || !syncUser || !navigator.onLine) return;
  qBusy = true; qErr = "";
  try {
    for (const q of [...queue]) {
      const path = `${syncUser.id}/${q.dayId}/${q.id}.jpg`;
      const { error } = await sb.storage.from(BUCKET).upload(path, q.blob, { contentType: "image/jpeg", upsert: true });
      if (error) { qErr = /bucket/i.test(error.message) ? "Der Foto-Speicher ist noch nicht eingerichtet (supabase/tagebuch.sql ausführen)." : error.message; break; }
      jEntry(q.dayId).photos.push({ id: q.id, path, w: q.w, h: q.h, caption: "", added: q.created });
      await qDel(q.id);
      save();
    }
  } catch (e) { qErr = e.message || String(e); }
  qBusy = false;
  await reloadQueue(); renderJournal();
}

/* ---------- Bildadressen ---------- */
// Online: signierte Adresse (1 Stunde gültig). Offline: dieselbe Adresse ohne Token – der Service Worker
// liefert das Foto dann aus seinem Speicher, falls es schon einmal angesehen wurde.
const plainUrl = path => `${(window.NORDTOUR_CONFIG || {}).supabaseUrl}/storage/v1/object/sign/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
async function signPaths(paths) {
  const need = paths.filter(p => !(signed[p] && signed[p].exp > Date.now() + 60e3));
  if (!need.length || typeof sb === "undefined" || !sb || !syncUser || !navigator.onLine) return;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(need, 3600);
  if (error) return;
  for (const x of data || []) if (x.signedUrl) signed[x.path] = { url: x.signedUrl, exp: Date.now() + 3600e3 };
}
const photoUrl = path => signed[path]?.url || plainUrl(path);
async function fillImages(root) {
  const imgs = [...root.querySelectorAll("img[data-path]")];
  await signPaths(imgs.map(i => i.dataset.path)).catch(() => {});
  for (const i of imgs) if (!i.getAttribute("src")) i.src = photoUrl(i.dataset.path);
}

/* ---------- Anzeige ---------- */
function renderJournal() {
  const el = document.getElementById("journalList"); if (!el || !state) return;
  // Steht der Cursor gerade in einem Textfeld, wird er nach dem Neuzeichnen wiederhergestellt
  const ae = document.activeElement, focus = ae?.matches?.("[data-jtext]")
    ? { id: ae.dataset.jtext, value: ae.value, a: ae.selectionStart, b: ae.selectionEnd, top: ae.scrollTop } : null;
  const only = $("#journalOnly")?.checked;
  const loggedIn = typeof sb !== "undefined" && sb && syncUser;
  $("#journalInfo").innerHTML = !loggedIn
    ? `Texte werden wie alles andere gespeichert. <b>Fotos brauchen eine Anmeldung</b> (oben „Anmelden“) – sie liegen dann privat in deiner Supabase-Cloud.`
    : `Fotos werden verkleinert (max. ${MAX_EDGE} px) und privat in deiner Supabase-Cloud gespeichert. Ohne Internet warten sie, bis wieder Verbindung da ist.`;
  $("#journalQueue").textContent = (queue.length ? `${queue.length} Foto${queue.length > 1 ? "s warten" : " wartet"} auf das Hochladen${!navigator.onLine ? " (offline)" : !loggedIn ? " (bitte anmelden)" : qBusy ? " …" : ""}. ` : "") + (qErr ? "⚠ " + qErr : "");
  const days = sortedDays().filter(d => !only || (state.journal?.[d.id]?.text || state.journal?.[d.id]?.photos?.length || queue.some(q => q.dayId === d.id)));
  el.innerHTML = days.map(d => {
    const j = state.journal?.[d.id] || { text: "", photos: [] }, qs = queue.filter(q => q.dayId === d.id);
    return `<article class="jday" data-jday="${esc(d.id)}">
      <h3>${fmtDate(d.date)} · Tag ${dayNo(d.date)} · ${esc(d.title || "")}</h3>
      <textarea data-jtext="${esc(d.id)}" rows="3" placeholder="Was habt ihr heute erlebt?">${esc(j.text || "")}</textarea>
      <div class="jphotos">
        ${(j.photos || []).map(p => `<button type="button" class="jthumb" data-jphoto="${esc(d.id)}:${esc(p.id)}" aria-label="Foto ansehen${p.caption ? ": " + esc(p.caption) : ""}"><img data-path="${esc(p.path)}" alt="${esc(p.caption || "")}" loading="lazy"></button>`).join("")}
        ${qs.map(q => `<span class="jthumb queued" title="wartet auf das Hochladen"><img src="${q.url}" alt=""><i>⏳</i></span>`).join("")}
        <label class="jadd" title="Fotos hinzufügen">＋ Fotos<input type="file" accept="image/*" multiple data-jfile="${esc(d.id)}" hidden></label>
      </div>
    </article>`;
  }).join("") || `<p class="empty">${only ? "Noch keine Einträge." : "Noch keine Reisetage."}</p>`;
  if (focus) {
    const t = el.querySelector(`[data-jtext="${CSS.escape(focus.id)}"]`);
    if (t) { t.value = focus.value; t.focus({ preventScroll: true }); t.setSelectionRange(focus.a, focus.b); t.scrollTop = focus.top; }
  }
  fillImages(el);
  const n = Object.values(state.journal || {}).reduce((a, j) => a + (j.photos?.length || 0), 0);
  $("#journalSum").textContent = n ? `${n} Foto${n > 1 ? "s" : ""}` : "";
}

/* ---------- Großansicht ---------- */
function openPhoto(dayId, photoId) {
  const list = jEntry(dayId).photos, i = list.findIndex(p => p.id === photoId); if (i < 0) return;
  lightbox = { dayId, i };
  showLightbox();
  $("#photoDlg").showModal();
}
async function showLightbox() {
  const { dayId, i } = lightbox, list = jEntry(dayId).photos, p = list[i];
  const img = $("#photoImg"); img.removeAttribute("src");
  await signPaths([p.path]).catch(() => {});
  img.src = photoUrl(p.path); img.alt = p.caption || "";
  $("#photoCap").value = p.caption || "";
  $("#photoPos").textContent = `${i + 1} / ${list.length}`;
  $("#photoPrev").disabled = i === 0; $("#photoNext").disabled = i === list.length - 1;
}
function saveCaption() {
  if (!lightbox) return;
  const p = jEntry(lightbox.dayId).photos[lightbox.i], v = $("#photoCap").value.trim();
  if (p && (p.caption || "") !== v) { p.caption = v; save(); }
}
async function deletePhoto() {
  const { dayId, i } = lightbox, list = jEntry(dayId).photos, p = list[i];
  if (!confirm("Dieses Foto endgültig löschen?")) return;
  if (!navigator.onLine) { alert("Zum Löschen brauchst du Internet."); return; }
  const { error } = await sb.storage.from(BUCKET).remove([p.path]);
  if (error) { alert("Löschen fehlgeschlagen: " + error.message); return; }
  list.splice(i, 1); save();
  if (!list.length) { $("#photoDlg").close(); } else { lightbox.i = Math.min(i, list.length - 1); showLightbox(); }
  renderJournal();
}

/* ---------- Ereignisse ---------- */
window.addEventListener("DOMContentLoaded", () => {
  const list = $("#journalList");
  list.addEventListener("input", e => {
    const t = e.target.closest("[data-jtext]"); if (!t) return;
    jEntry(t.dataset.jtext).text = t.value;
    clearTimeout(jSaveTimer); jSaveTimer = setTimeout(save, 800);
  });
  list.addEventListener("focusout", e => { if (e.target.matches("[data-jtext]")) { clearTimeout(jSaveTimer); save(); } });
  list.addEventListener("change", async e => {
    const f = e.target.closest("[data-jfile]"); if (!f || !f.files.length) return;
    const files = [...f.files]; f.value = "";
    await addPhotos(f.dataset.jfile, files);
  });
  list.addEventListener("click", e => {
    const b = e.target.closest("[data-jphoto]"); if (!b) return;
    const [d, p] = b.dataset.jphoto.split(":"); openPhoto(d, p);
  });
  $("#journalOnly").addEventListener("change", renderJournal);
  $("#photoPrev").addEventListener("click", () => { saveCaption(); lightbox.i--; showLightbox(); });
  $("#photoNext").addEventListener("click", () => { saveCaption(); lightbox.i++; showLightbox(); });
  $("#photoDel").addEventListener("click", deletePhoto);
  $("#photoClose").addEventListener("click", () => $("#photoDlg").close());
  $("#photoDlg").addEventListener("close", () => { saveCaption(); lightbox = null; renderJournal(); });
  window.addEventListener("online", processQueue);
  setInterval(processQueue, 30e3);                       // z. B. nach dem Anmelden
  appReady.then(async () => { await reloadQueue(); renderJournal(); processQueue(); });
});
