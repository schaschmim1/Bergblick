# Bergblick

Installierbare Web-App (PWA), die Gipfelnamen und Bergumrisse der Alpen auf Fotos und ins Live-Kamerabild legt, ähnlich wie PeakFinder. Läuft nach dem ersten Öffnen komplett offline.

## Funktionen

- **Panorama**: berechnet aus dem Höhenmodell den Horizont, alle Grate und ein Geländebild in **Satellitenfarben** (Wald, Wiesen, Fels, Schnee und Seen so, wie sie aus der Luft aussehen, mit Licht und Schatten nach Hangneigung und Dunst nach Entfernung) für jeden Standort in den Alpen (360° in 0,05°-Schritten, bis 250 km Sichtweite, mit Erdkrümmung und Refraktion). Ziehen dreht die Ansicht, Mausrad bzw. zwei Finger zoomen.
- **Höhenmodell in Stufen**: alpenweit ~210 m als Grundlage. Mitgeliefert: ganze Alpen (4,6–17,2° O, 43,6–48,4° N) mit ~52 m, genutzt bis 120 km Sichtweite, und deutsche und österreichische Alpen samt Rändern (9,5–16,3° O, 46,3–48,0° N) mit ~26 m bis 50 km. Rund um den Standort zusätzlich ~13 m bis 8 km (und ~26 m bis 25 km außerhalb von DE/AT), bei Bedarf aus dem Netz geladen und gespeichert; unter „Standort“ lässt sich ein Gebiet vorab für offline speichern.
- **Satellitenfarben**: mitgeliefert für die ganzen Alpen (~76 m) und die deutschen und österreichischen Alpen (~38 m), aus dem Sentinel-2-Wolkenfrei-Mosaik der ESA. Bis 5 km um den Standort werden online zusätzlich schärfere Luftbilder (Esri, bis ~5 m) geladen und gespeichert. Für alles jenseits von 50 km genügt ein einziges Übersichtsbild der Alpen (`data/sat/overview.jpg`, ~420 m je Pixel), das mit dem Start geladen wird.
- **Schnell zuerst (Panorama und Kamera)**: Bei einem neuen Standort steht das Panorama nach wenigen Sekunden aus dem groben Gelände und dem Übersichtsbild. Detailgelände und scharfe Satellitenbilder werden danach nachgeladen und das Bild verfeinert. Unter Einstellungen lässt sich „Details im Panorama“ ausschalten; dann wird weder Detailgelände noch werden scharfe Satellitenbilder geladen. Fotos betrifft der Schalter nicht.
- **Fotos in einem Schritt**: Für ein Foto lädt die App Detailgelände nur im möglichen Blickbereich (Kompass aus dem Foto ±25° plus Bildwinkel, dazu alles im Umkreis von 1,5 km) und rechnet auch nur diesen Teil des Panoramas, ohne Satellitenfarben. Die Linien sind damit von Anfang an genau, und das Foto ist am PC nach 2–5 s ausgerichtet. Wechselst du danach in Panorama oder Kamera, wird das Rundum-Panorama nachgerechnet; schon geladene Kacheln bleiben erhalten. Detailkacheln aus dem Netz, die nach 8 s nicht da sind, ersetzt die nächst gröbere Stufe.
- **GPS-Genauigkeit**: iPhones speichern, wie genau die Position war. Liegt sie über 150 m daneben (z. B. in Höhlen, Schluchten oder kurz nach dem Einschalten), sagt die App das an; dann den Standort unter „Standort“ setzen.
- Standorthöhe: GPS-Höhe aus dem Foto, wenn plausibel (auf Gipfeln liegt die GPS-Position oft 50–100 m neben dem höchsten Punkt, dort ist das Gelände tiefer); sonst der höchste Geländepunkt im Umkreis von 20 m.
- **Foto**: Bild laden (oder per Drag & Drop). Standort, Blickrichtung und Brennweite kommen aus den EXIF-Daten, wenn vorhanden. Danach richtet **Ausrichten** das Panorama am Foto aus: Die App trennt Himmel und Gelände im Bild, misst Farbkontraste an Horizont und Graten und sucht Richtung, Neigung, Drehung und Bildwinkel (mit Kompassangabe im Foto ±25°, sonst volle 360°; ohne Brennweite im Foto alle Bildwinkel von 25° bis 120°). Sie berücksichtigt auch Dunst: Sind ferne Berge im Foto unsichtbar, vergleicht sie mit dem Horizont bei 40 oder 80 km Sicht. Zusätzlich prüft sie die Umrisse näherer Bergketten (15 bis 90 km), die sich im Dunst fast immer abheben. Gegen Wolken und Dunst hilft ein zweites, flächiges Maß (Transinformation): Es vergleicht Helligkeit und Blaustich im Foto mit der Entfernung des Geländes im Panorama (Himmel, nah, mittel, fern) und findet so Richtung und Neigung auch dann, wenn Wolkenkanten den Horizont vortäuschen; die Kanten liefern danach die Feinheit. Den Himmel erkennt sie an Farbe und Glätte, nicht an der Lage im Bild; was oben ins Bild ragt (Höhlendecke, Äste, Dachkante), wird ausgeblendet. Ferne Berge im Dunst haben oft fast die Himmelsfarbe, sind aber nicht so glatt wie der Himmel. Für das Ausrichten wird das Foto in jedem Browser gleich verkleinert (eigene 4 × 4-Mittelung), damit das Ergebnis nicht vom Gerät abhängt. Der Bildwinkel bleibt nahe der Brennweite aus dem Foto (±5 %; beim iPhone-Tele „120 mm“ ist er um 2,8 % korrigiert, an echten Fotos gemessen). „Ausrichten“ sucht immer im ursprünglichen Bereich aus den Fotodaten und prüft die aktuelle und die letzte Ausrichtung mit; ein versehentlich verschobenes Overlay kommt so zurück. Klappt das nicht, unter **Anpassen** „Gipfel zuordnen“: einen Gipfel wählen, im Foto antippen, dann einen zweiten; damit sitzt die Ausrichtung genau.
- **Zoomen im Foto**: Mausrad bzw. zwei Finger zoomen ins Bild, Ziehen verschiebt den Ausschnitt; das Overlay bleibt dabei auf dem Foto liegen. Doppelklick oder „Ganzes Bild“ zeigt wieder das ganze Bild. Zum Korrigieren der Ausrichtung „Anpassen“ öffnen und „Verschieben“ einschalten: dann verschiebt Ziehen das Overlay und Zoomen ändert den Bildwinkel; Bildwinkel/Drehung auch über Regler. **Speichern** exportiert das Foto mit Overlay als JPEG (oder teilt es am Handy).
- **Kamera** (Design v9): Live-Kamerabild mit Overlay über GPS und Kompass/Lagesensoren. Zoomleiste nur mit den Stufen, die das Gerät hat (iPhone über die Kameranamen, Tele-Faktor nach Modell, sonst 3×; Android über den Hardware-Zoom; unbekannt: 1× und 2×); Bild und Overlay zoomen gemeinsam. Der Auslöser fixiert die Aufnahme mit eingebrannten Linien: Neu aufnehmen, Anpassen, Speichern (Bild mit Overlay; am Handy über das Teilen-Menü „Bild sichern“) und Teilen. „Overlay anpassen“: Bild ziehen verschiebt die Linien (Kompass/Neigung), Regler für Drehung (±5°) und Bildwinkel (85–115 %), „Gipfel zuordnen“ (Gipfel wählen, dann im Bild antippen) und „Zurücksetzen“; die Korrektur bleibt auf dem Gerät gespeichert.
- **Standort**: Satellitenkarte mit Beschriftung (Esri World Imagery), stufenlos zoombar (Mausrad, zwei Finger, Doppeltipp, +/−), Tippen setzt den Standort. Gipfel aus dem eigenen Bestand sind eingezeichnet. Offline oder per Knopf „Relief“: Schummerung aus dem eigenen Höhenmodell. Suche nach Gipfeln (offline) und Orten (online über Photon/OpenStreetMap), GPS, Koordinaten und Höhe über Grund.
- Gipfel antippen zeigt Höhe, Entfernung und Richtung.
- **Oberfläche**: hell und ruhig, Hauptleiste mit vier gleich breiten Bereichen unten (Kamera, Foto, Panorama, Standort), Gipfelnamen schräg in einer gemeinsamen Zeile über dem höchsten Gipfel, im Foto nur drei Hauptknöpfe (Ausrichten, Anpassen, Speichern); Feineinstellungen klappen bei Bedarf auf.

## Starten

Die App braucht einen Webserver (kein `file://`), weil Service Worker und Module-Worker sonst nicht laufen:

```bash
cd berg-app
python3 -m http.server 8000
# http://localhost:8000 öffnen
```

Für Kamera, Kompass und GPS am Handy muss die Seite über **HTTPS** laufen (z. B. GitHub Pages, Netlify, Cloudflare Pages). Dann im Browser „Zum Home-Bildschirm hinzufügen“. Beim ersten Öffnen werden rund 17 MB (Höhenmodell + Gipfel) in den Offline-Speicher gelegt. Detailgelände und Satellitenfarben werden für die benutzten Gebiete automatisch gespeichert; unter Einstellungen lässt sich alles auf einmal speichern (ca. 200 MB), dort steht auch der Status.

## Aufbau

| Datei | Inhalt |
|---|---|
| `index.html`, `style.css` | Oberfläche |
| `js/app.js` | Modi, Zeichnen des Overlays, Gesten, Karte, Export |
| `js/worker.js` | Rechen-Worker: Panorama (Raymarching über 3600 Richtungen), Sichtbarkeit der Gipfel, Karte, Auto-Ausrichtung, Suche |
| `js/terrain.js` | Höhenmodell laden/abfragen, Geo-Formeln |
| `js/camera.js` | Kameramodell (Blickrichtung/Neigung/Drehung, Geräteausrichtung, Projektion) |
| `js/exif.js` | EXIF-Leser (GPS samt Höhe, Blickrichtung, Brennweite) |
| `js/map.js` | Kachelkarte für die Standortwahl (Satellit/Relief, Gesten) |
| `sw.js` | Service Worker, speichert App und Daten offline |
| `data/dem/9/` | Höhenmodell Alpen, 228 Kacheln Zoom 9 (~210 m Raster), Int16 zeilen-delta + gzip |
| `data/dem/11/` | Detailgelände ganze Alpen, 2159 Kacheln Zoom 11 (~52 m), Format „p2z“ (siehe `tools/build_detail.py`), 62 MB |
| `data/dem/12/` | Detailgelände deutsche und österreichische Alpen, 2185 Kacheln Zoom 12 (~26 m), 56 MB |
| `data/dem/bundles.json` | welche Detailkacheln mitgeliefert sind (Rechteck + Bitmaske je Zoomstufe) |
| `data/sat/11/`, `data/sat/12/` | Satellitenfarben zu denselben Kacheln wie `data/dem/11` und `12` (256², JPEG), 50 + 51 MB |
| `data/sat/overview.jpg`, `.json` | Übersichtsbild der Satellitenfarben aus den Zoom-11-Kacheln (`tools/build_overview.py`), 0,7 MB |
| `data/peaks.json` | 86 223 benannte Gipfel (Lage, Höhe, Dominanz in km, Name) |
| `tools/` | Skripte, mit denen die Daten erzeugt wurden |

## Daten neu erzeugen

```bash
python3 tools/build_dem.py 9        # lädt AWS Terrain Tiles, schreibt data/dem9/ → nach data/dem/9/ kopieren
python3 tools/build_detail.py 11 4.6 17.2 43.6 48.4 400   # Detailgelände Alpen → data/dem/11/, bundles.json
python3 tools/build_detail.py 12 9.5 16.3 46.3 48.0 500   # Detailgelände DE/AT → data/dem/12/
python3 tools/build_sat.py 11       # Satellitenfarben (ESA WorldCover Sentinel-2, S3) → data/sat/11/
python3 tools/build_sat.py 12       # → data/sat/12/
python3 tools/build_overview.py     # Übersichtsbild aus data/sat/11/
python3 tools/fetch_peaks.py        # Gipfel (OSM über Overture Maps, S3) → data/peaks_raw.parquet
python3 tools/build_peaks.py data/peaks_raw.parquet data/peaks.json
```

Abdeckung: 4,3–17,2° O, 43,2–48,9° N. Mehr Gebiet = Grenzen in den Skripten und `data/dem/meta.json` anpassen.

## Grenzen und nächste Schritte

- Offline ohne vorher gespeichertes Gebiet gibt es nur das grobe Modell (~210 m); die App sagt das an.
- Auto-Ausrichten mit echten Fotos (iPhone 15 Pro Max, 24 mm und 120 mm, auch mit Wolken): alle fünf Testfotos mit gutem GPS richtig, auf wenige Pixel genau. Ein Foto mit 3 km GPS-Fehler kann nicht passen; die App warnt dort.
- Auto-Ausrichten: Testsatz mit 16 künstlichen Bildern (Wolken, Rauschen, Dunst, 18 m GPS-Fehler, 10 davon Weitwinkel 85–100° mit fernen Bergen). Mit Brennweite im Foto, ohne Kompass: 12 von 16 richtig in ~3 s (Version 3: 11, Version 2: 6). Echtes Testfoto (Brünnstein, 120-mm-Tele, verschneite Tauern in 60 km): richtig, auf ~0,2° genau. Schwierig bleiben flache, sehr ferne Horizonte (Alpenvorland) und Bilder, in denen ein naher Hang dominiert. Dann „Gipfel zuordnen“ nutzen.
- Im Foto erkannter Horizont lässt sich zur Kontrolle einblenden (Einstellungen).
- Die nahen, scharfen Luftbilder (Esri) gibt es nur online; offline reicht die Schärfe der Satellitenfarben für Hänge ab ein paar Kilometern, ganz nahe wirkt das Bild weich.
- Kompass am Handy ist oft ein paar Grad daneben (Missweisung 3,5° ist eingerechnet). „Overlay anpassen“ im Kamera-Modus speichert eine Korrektur.

## Lizenzen der Daten

- Karte: Esri World Imagery und World Boundaries and Places (Quellen: Esri, Maxar, Earthstar Geographics und die GIS-Community), nur online
- Satellitenfarben im Panorama: ESA WorldCover Sentinel-2 RGBNIR-Mosaik 2021, © ESA WorldCover project / enthält modifizierte Copernicus-Sentinel-Daten (2021), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); nah und online Esri World Imagery
- Ortssuche: [Photon](https://photon.komoot.io) von komoot, Daten © OpenStreetMap-Mitwirkende

- Höhen: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (SRTM, EU-DEM u. a., siehe dortige Quellenangaben)
- Gipfel: © OpenStreetMap-Mitwirkende, ODbL, über [Overture Maps](https://overturemaps.org) (Release 2026-09-23.1)
