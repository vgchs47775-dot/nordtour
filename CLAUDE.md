# Nordtour – Hinweise für Claude

Statische Web-App zum Planen eines Skandinavien-Roadtrips. Kein Build, kein Framework, kein Node in der App:
klassische Skripte in `app/`, die sich den globalen Gültigkeitsbereich teilen.

**Dieses Repository ist öffentlich. Auch diese Datei.**

## Zusammenarbeit
- Antworten, Oberfläche, Kommentare und Commit-Texte auf **Deutsch**.
- Die Person ist kein Entwickler: einfach erklären, Einrichtungsschritte nummerieren, Änderungen selbst testen.
- Genutzt wird die App am PC und am iPad (Safari, als App auf dem Home-Bildschirm). Alles muss per Touch gehen,
  im Hell- und im Dunkelmodus, im Hochformat (schmaler als 860 px) und im Querformat.
- Offen sagen, was getestet ist und was nicht. Login, Foto-Upload und alles mit den echten Daten kann nur
  die Person selbst testen.

## Datenschutz (hat Vorrang)
- Nie einchecken: echte Reisedaten, Reisedatum, Heimatkoordinaten, E-Mail-Adressen, Fotos der Person,
  `daten.json`, `nordtour-*.json`. `.gitignore` ist eine Whitelist. Das auch in Commit-Texten und Pull Requests beachten.
- Zum Testen nur erfundene Beispieldaten (Muster: `tests/smoke.mjs`).
- Im Code darf nur der Supabase **Publishable Key** stehen (`app/config.js`). Niemals Secret Key,
  `service_role`, Datenbank-Passwort. Schutz der Daten: Login und Row Level Security.
- Passwörter nie erfragen oder eingeben.

## Aufbau
Ladereihenfolge (siehe Ende von `app/index.html`):
`config → extras → app → stops → osm → toll → ferrycost → ferries → einstellungen → lists → prio → varianten → planer → etappen → sky → aurora → journal → sync → cache → backup → pwa`

| Datei | Aufgabe |
|---|---|
| `app.js` | Zustand `state`, `save()`, `refresh()`, `appReady`, Karte (Leaflet), Tage, Routing, Ortssuche |
| `extras.js`, `extras.json`, `img/` | Panoramastraßen, Sehenswürdigkeiten |
| `stops.js` | Tage sortieren, Ruhetag, Stopps, Bearbeiten-Modus der Karte, Umschalter Karte/Liste |
| `osm.js` | Tankstellen und Trinkwasser (Overpass) |
| `toll.js`, `ferrycost.js`, `ferries.js` | Maut-Schätzung, Fährkosten-Abgleich, Abfahrten (Entur, nur Norwegen) |
| `lists.js` | Reiter, Kosten, To-dos, Packliste, Kaufen, `normalizeState()` für Datenumstellungen |
| `einstellungen.js` | Reiter Kategorien und Prioritäten; Vorgaben in `CFG_DEFAULT`/`defaultLevels()`, eigene in `state.settings.cfg` |
| `theme.js` (im `<head>`) | Hell/Dunkel/Auto; CSS nur über `:root[data-theme="dark"]`, in JS `isDark()` und Ereignis `themechange` |
| `prio.js` | Prioritäten für Panoramastraßen und Orte, Kartenfarben |
| `varianten.js` | mehrere Routen (`state.routeList`, `state.routeId`); gewählte Route liegt in `state.days`, nur andere haben `data` |
| `planer.js` | Route aus Prioritäten; Kennzeichen an Punkten: `wp` (Wegpunkt), `anchor` (An-/Abreise), `key` (Ziel/eigener Ort), an Tagen `auto` (Schlafplatz unterwegs), `panos`; Orte einer Stufe mit `lvNight()` (Vorgabe: Muss) bekommen immer eine Nacht höchstens `settings.gen.near` km entfernt |
| `etappen.js` | Etappe teilen (Zwischenübernachtung) und Nacht auflösen; Felder `src`, `sights`, `stop`, `split` an Tagen, `pv` an Punkten (Erklärung im Dateikopf); Hinweis `#nightGap` auf Orte ohne Übernachtung in der Nähe |
| `sky.js`, `aurora.js` | Nachthimmel, Kp-Prognose, Polarlicht-Karte (NOAA) |
| `journal.js` | Tagebuch; Fotos im privaten Supabase-Bucket `tagebuch`, Warteschlange in IndexedDB |
| `sync.js`, `cache.js`, `backup.js` | Cloud-Abgleich (`trips`), geteilter Zwischenspeicher (`route_cache`), Sicherungen (`trip_backups`) |
| `sw.js`, `pwa.js` | Offline-Betrieb und Updates |

- Neuer Reiter: Link und `<section id="v-…">` in `index.html`, Eintrag in `VIEWS` (`lists.js`), Prüfung in `tests/smoke.mjs`.
- Neue Datei: in `index.html` **und** in `CORE` in `sw.js` eintragen, sonst fehlt sie offline.
- Ändert sich das Format berechneter Routen: `RSTORE` hochzählen. Achtung, auch der Cloud-Cache `route_cache`
  liefert dann noch alte Einträge mit gleichem Schlüssel.
- Kategorien und Prioritäten nie fest eintragen: `packCats()`, `costCats()`, `todoCats()`, `listPrios()`, `prioLevels()`; von der App
  gebrauchte Kostenarten über `costSys("Fähren")` (die Person kann sie umbenennen).
- Kosten immer über `activeCosts()` auswerten (Posten anderer Routen zählen nicht). Grundroute (`base`) nie löschen.
- Vorhandene Daten in der Cloud dürfen nie kaputtgehen: neue Felder über `normalizeState()` ergänzen.
- `extras.json` wird auf dem PC der Person von einem Skript erzeugt, das nicht im Repository liegt. Wird die Datei
  hier von Hand geändert, im Pull Request deutlich darauf hinweisen, sonst geht die Änderung beim nächsten Erzeugen verloren.
- SQL liegt in `supabase/`. Claude hat keinen Zugriff auf die Datenbank: neue SQL-Dateien wiederholbar schreiben,
  die Person führt sie im Supabase-SQL-Editor aus.

## Stolperfallen
- Service Worker: `__BUILD__` in `sw.js` ersetzt der Workflow durch die Commit-Kennung. Vorab-Speichern immer mit
  `cache: "reload"`, sonst landen alte Dateien unter neuer Version.
- Läuft der lokale Server nicht, liefert der Service Worker alte Dateien aus dem Speicher. Vor dem Testen prüfen.
- Leaflet misst eine ausgeblendete Karte mit Größe 0: vor `fitBounds`/`flyTo` `map.invalidateSize()` aufrufen.
- Nie neu zeichnen, ohne Cursor und Eingaben in offenen Feldern zu erhalten.
- Ziehen und Verschieben nur in ausdrücklich eingeschalteten Modi („Reihenfolge ändern“, „Karte bearbeiten“).
- Routing: Wegpunkte mit `search_filter.exclude_ferry`, sonst rasten Punkte am Wasser auf Fährlinien ein.
- Freiwillige Dienste schonen (Valhalla, Nominatim höchstens 1 Anfrage/s, Overpass, OSM-Kacheln): Ergebnisse speichern,
  keine Massenabfragen, keine Kartenkacheln vorab laden.
- Externe Skripte nur von cdnjs, jsdelivr oder unpkg mit exakter, mindestens zwei Wochen alter Version.

## Testen
```bash
python3 -m http.server 8642 --bind 127.0.0.1 --directory app &
npm install --no-save --no-package-lock playwright@1.64.1
npx playwright install --with-deps chromium
node tests/smoke.mjs
```
Der Selbsttest blockiert externe Dienste. Ändert sich die Bedienung, den Test mit anpassen.

## Veröffentlichen
- In einer Cloud-Sitzung: eigener Zweig und Pull Request, nicht selbst mergen. Der Selbsttest läuft im Pull Request.
- Nach dem Merge auf `main` laufen Selbsttest und Veröffentlichung über GitHub Pages. Online prüfen:
  `sw.js` auf der Seite muss die neue Commit-Kennung enthalten.
- Am PC vor neuer Arbeit zuerst `git pull`, sonst fehlen Änderungen aus Cloud-Sitzungen.

## Nicht vorschlagen
Abgelehnt, nur auf ausdrücklichen Wunsch umsetzen: Unterkünfte pro Nacht und Campingplatz-Suche, Wetter, Ausgaben
mit Währungsumrechnung, GPX-Export, Fotobuch/PDF, zweiter Login, „Rückgängig“ ausweiten, Frag Claude, „Problem melden“,
Fortschrittsanzeige, Kalender-Export, eigener Standort, „Heute“-Ansicht, lange Tage aufteilen, To-do-Erinnerungen,
Packliste pro Person, Notfall-Infos, Fotos als ZIP, Selbsttest erweitern, Wildcamp-Check, Supermärkte/Sonntag, Duschen.
