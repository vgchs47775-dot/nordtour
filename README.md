# Nordtour – Roadtrip-Planer

Kleine Web-App zum Planen eines Roadtrips: Karte mit OpenStreetMap (Leaflet), Etappen bearbeiten,
Routen werden live über Valhalla (FOSSGIS) berechnet, Übernachtungsorte lassen sich auf der Karte verschieben.

Die App enthält keine Reisedaten. Eigene Daten werden über „Laden“ als JSON eingespielt
und im Browser gespeichert.

Lokal starten:

```bash
python -m http.server 8642 --directory app
```

Kartendaten © OpenStreetMap-Mitwirkende.
