"""Übersichtsbild der Satellitenfarben für die ganze Alpen-Abdeckung aus den Zoom-11-Kacheln.

Jede 256²-Kachel wird auf TILE² verkleinert und in ein Mercator-Bild gesetzt; fehlende Kacheln bleiben
schwarz, das heißt für die App „keine Daten“ (echte Farben werden dafür auf mindestens 2 angehoben).
Schreibt data/sat/overview.jpg und data/sat/overview.json.
"""
import json, os, sys
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

TILE = 32
base = os.path.join(os.path.dirname(__file__), '..', 'data')
b = next(l for l in json.load(open(os.path.join(base, 'dem', 'bundles.json')))['levels'] if l['z'] == 11)
nx, ny = b['x1'] - b['x0'] + 1, b['y1'] - b['y0'] + 1
img = Image.new('RGB', (nx * TILE, ny * TILE), (0, 0, 0))

def load(xy):
    x, y = xy
    with Image.open(os.path.join(base, 'sat', '11', f'{x}_{y}.jpg')) as t:
        return x, y, t.convert('RGB').resize((TILE, TILE), Image.LANCZOS)

todo = [(x, y) for y in range(b['y0'], b['y1'] + 1) for x in range(b['x0'], b['x1'] + 1) if b['rows'][y - b['y0']][x - b['x0']] == '1']
with ThreadPoolExecutor(16) as ex:
    for x, y, t in ex.map(load, todo):
        # reines Schwarz ist für "leer" reserviert
        t = t.point(lambda v: max(v, 2))
        img.paste(t, ((x - b['x0']) * TILE, (y - b['y0']) * TILE))
img.save(os.path.join(base, 'sat', 'overview.jpg'), quality=85)
json.dump({'z': 11, 'x0': b['x0'], 'y0': b['y0'], 'tile': TILE, 'w': img.width, 'h': img.height}, open(os.path.join(base, 'sat', 'overview.json'), 'w'))
print(len(todo), img.size, os.path.getsize(os.path.join(base, 'sat', 'overview.jpg')))
