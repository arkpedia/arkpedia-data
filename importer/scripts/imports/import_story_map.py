#!/usr/bin/env python3
"""Imports the Arknights Story Map, a community whiteboard of which stories lead into which,
into data/story-map.json, for the Story page (pages/story.tsx) to draw with every story a link
into Timo's Arknights Story Reader.

    python3 scripts/imports/import_story_map.py

THE BOARD is a public Canva whiteboard (BOARD). Its view page carries the whole board as data,
in the JSON it boots from (`window['bootstrap'] = JSON.parse('...')`): every picture, text, line
and shape with its position. Canva's keys are short codes ("A?": "I" is a picture, "K" a text,
"U" a line, "J" a shape, "i" a group), undocumented and free to change, so they are read in one
place (element()) into this file's own shape, and the page never sees them. A board the parser
cannot read fails the stage, which puts data/story-map.json back as it was: readers keep the
last good map, and the run's report says the stage failed.

THE PICTURES are the game's own story covers, which the board's author uploaded with no names.
Each is staged in .cache/story-map/ (staged_art.py) for the release's staged-art stage to
publish as story-map/<media id>.webp, and a picture names its image only once it is published.

THE LINKS. A picture's `link` is the story it stands for: {title, url}, the url a deep link into
the reader (story.html#<category>&<story group>&0 opens the group's first chapter), another
site, or null for a picture with nowhere to go (a manga the reader does not carry). Once a
picture has a link it is kept as it is, whoever set it: edit data/story-map.json in
arkpedia-data to correct one. A new picture is matched against the reader's own covers
(covers.json, the art it shows each group with): a clear best match (MATCH_SCORE, ahead of the
next by MATCH_MARGIN) links it; anything less leaves it unlinked and reported under 'story-map',
so the daily issue names it until a person links it. On the board of 2026-02-15 the rule
linked every cover the reader has art for correctly, and no wrong match came within 0.06 of
either threshold.

THE MANGA. The board carries one manga; the official comics (COMICS, the Global site's own list)
are kept as `manga`, for the Manga page (pages/manga.tsx) and the map, each with the board section
it belongs to (a frame's name, "Sui", "Columbia") or none. A comic the list gains is added with none, which the page lists under
"Not yet categorized" until a person places it in arkpedia-data; a comic already listed is kept as
it is, placed or not, and one the site drops is kept too. What the site says of each (its blurb,
its latest chapter, when it was last updated) is refreshed every run; the title, link and place
are a person's to change. `onBoard` names the board picture a comic
already is (the Rhine Lab volume), which the page then does not draw twice. Each cover is staged
like the board's pictures, as story-map/<id>.webp.
"""
from published_assets import published_assets
from quarantine import report
from staged_art import Staging
import io
import json
import math
import os
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request

import certifi
from PIL import Image

BOARD = 'https://www.canva.com/design/DAHBABXJpds/tgUQ72n0pCw8HHq56-OBOA/view'
READER = 'https://arknights.timo.beer/'
# Canva answers "Unsupported client" to anything it does not take for a browser, so this reads
# as one, and still names the project at the end.
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Arkpedia-import/1.0 (+https://arkpedia.net)'
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
MATCH_SCORE, MATCH_MARGIN = 0.55, 0.12
FOLDER = 'story-map'

root = os.getcwd()
OUT = os.path.join(root, 'data', 'story-map.json')


def fetch(url, timeout=60):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), context=SSL_CONTEXT, timeout=timeout) as response:
        return response.read()


def js_string(text):
    """The value of a single-quoted JavaScript string literal's body."""
    def escape(match):
        code = match.group(1)
        if code[0] == 'u':
            return chr(int(code[1:], 16))
        if code[0] == 'x':
            return chr(int(code[1:], 16))
        return {'n': '\n', 't': '\t', 'r': '\r', 'b': '\b', 'f': '\f', 'v': '\v', '0': '\0'}.get(code, code)
    value = re.sub(r'\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)', escape, text, flags=re.S)
    # 😀 arrives as two halves; join them into the one character they are.
    return value.encode('utf-16', 'surrogatepass').decode('utf-16')


def bootstrap(html):
    match = re.search(r"window\['bootstrap'\]\s*=\s*JSON\.parse\('((?:[^'\\]|\\.)*)'\)", html, re.S)
    if not match:
        raise ValueError('the board page no longer boots from window.bootstrap')
    return json.loads(js_string(match.group(1)))


def number(value):
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f'expected a number, got {value!r}')
    return round(float(value), 1)


def size(value):
    """A font size: "80px" -> 80.0."""
    match = re.fullmatch(r'([\d.]+)px', str(value or ''))
    return round(float(match.group(1)), 1) if match else None


def text_of(content):
    """{text, size, color, align, bold, italic, underline} of a Canva text block, styled as its
    first run is (the board's texts are one style each)."""
    runs = content.get('A') or []
    styles = content.get('C') or [{}]
    style = {}
    for part in styles[:2]:
        style.update(part or {})
    return {
        'text': ''.join(runs).rstrip('\n'),
        'size': size(style.get('G')) or 16.0,
        'color': style.get('M') or '#000000',
        'align': {'center': 'center', 'right': 'right'}.get(style.get('c'), 'left'),
        'bold': style.get('I') == 'bold',
        'italic': style.get('K') == 'italic',
        'underline': style.get('O') == 'underline',
    }


def box(element):
    """An element's place: Canva's "A" is its top and "B" its left (read the other way round, the
    landscape board came out standing on its side), "D" its width and "C" its height."""
    return {'x': number(element['B']), 'y': number(element['A']), 'width': number(element['D']), 'height': number(element['C'])}


# A line end's decoration, Canva's one-letter code in the end's "A" ("b" the start, "c" the end;
# absent, a plain end) -> the page's name for it (lib/story/storyMap.ts LINE_HEADS). "C" is the
# filled triangle every arrow on the board ends in; the page sizes it from the line's width, as
# Canva does. A code not listed here fails the stage: drawn as a plain end it would turn an arrow
# back into a bare line, the very thing this map once did, and nobody would be told.
LINE_HEADS = {'C': 'triangle'}


def line_head(raw, end):
    code = raw[end].get('A')
    if code is None:
        return None
    if code not in LINE_HEADS:
        raise ValueError(f'line {raw.get("_")} has a {"start" if end == "b" else "end"} decoration {code!r} the importer does not know; '
                         'add it to LINE_HEADS (and to the page\'s LINE_HEADS) to draw it')
    return LINE_HEADS[code]


def line_end(end, siblings):
    """Where Canva draws a line's end, as (x, y). An end attached to a picture ("B": {"A": the
    picture's "Z", "B": a fraction of its height, "C" of its width, "D": "A"}) is drawn at that
    point of the picture, wherever the end's stored point ("C") says: the board keeps the stored
    point only as of the line's last edit, and on ten of its connectors it is 4 to 17 units off
    the cover they are drawn to. A rotated picture, an attachment of another kind or one naming
    nothing beside the line falls back to the stored point."""
    stored = end['C']
    attached = end.get('B')
    if isinstance(attached, dict) and attached.get('D') == 'A':
        target = siblings.get(attached.get('A'))
        if target and abs(target.get('E') or 0) < 1e-6 and all(isinstance(target.get(k), (int, float)) for k in 'ABCD'):
            return (target['B'] + (attached.get('C') or 0) * target['D'], target['A'] + (attached.get('B') or 0) * target['C'])
    return (stored['B'], stored['A'])


def element(raw, media, siblings=None):
    """One board element in this file's shape, or None for a kind the page does not draw.
    `siblings`: the elements beside it by their "Z", which a line's ends may be attached to."""
    siblings = siblings or {}
    kind = raw.get('A?')
    if kind == 'I':
        image = raw['a']['B']['A']
        if image.get('A?') != 'd' or not re.fullmatch(r'[A-Za-z0-9_-]+', image.get('A') or ''):
            raise ValueError(f'a picture names no media: {json.dumps(image)[:120]}')
        if image['A'] not in media:
            raise ValueError(f'picture {image["A"]} is not among the board\'s media')
        return {'type': 'picture', 'id': image['A'], **box(raw)}
    if kind == 'K':
        return {'type': 'text', **box(raw), **text_of(raw['a']['C'])}
    if kind == 'U':
        (x1, y1), (x2, y2) = line_end(raw['b'], siblings), line_end(raw['c'], siblings)
        return {'type': 'line', 'x1': number(x1), 'y1': number(y1), 'x2': number(x2), 'y2': number(y2),
                'color': raw.get('d') or '#000000', 'width': number(raw.get('a') or 1), 'dash': raw.get('e') or None,
                'start': line_head(raw, 'b'), 'end': line_head(raw, 'c')}
    if kind == 'J':
        paint = raw['b'][0]
        # The outline's width and the corner radius are in board units, as the box is.
        shape = {'type': 'shape', **box(raw), 'path': paint['A'],
                 'fill': (paint.get('B') or {}).get('C'), 'stroke': (paint.get('C') or {}).get('B'),
                 'strokeWidth': number((paint.get('C') or {}).get('A') or 0), 'radius': number(paint.get('D') or 0)}
        label = text_of(raw['f'][0]['A']['C']) if raw.get('f') else None
        if label and label['text'].strip():
            shape['label'] = label
        return shape
    return None


def board_elements(boot):
    """The page's elements in paint order, groups flattened, and the board's media by id."""
    media = {}

    def collect(value):
        if isinstance(value, dict):
            if value.get('type') == 'RASTER' and isinstance(value.get('files'), list) and value.get('id'):
                media[value['id']] = value
            for item in value.values():
                collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)
    collect(boot)
    page = boot.get('page')
    if not isinstance(page, dict):
        raise ValueError('the board page carries no page')
    out = []

    def walk(value, siblings):
        if isinstance(value, dict):
            # A bare kind with no place at all is not on the board: the page's interface settings
            # carry one ({"A?": "K"}) when Canva serves the page in another language.
            if value.get('A?') in ('I', 'K', 'U', 'J') and any(key in value for key in 'ABCD'):
                drawn = element(value, media, siblings)
                if drawn:
                    out.append(drawn)
                return
            for item in value.values():
                walk(item, {})
        elif isinstance(value, list):
            beside = {item['Z']: item for item in value if isinstance(item, dict) and isinstance(item.get('Z'), str)}
            for item in value:
                walk(item, beside)
    walk(page, {})
    if sum(1 for e in out if e['type'] == 'picture') < 10:
        raise ValueError(f'the board reads as {len(out)} elements with almost no pictures; its format has changed')
    return out, media


def thumbnail(record, height=384):
    """The URL of the board's own resize of a picture closest to `height` pixels tall."""
    files = [f for f in record['files'] if f.get('url') and f.get('height')]
    if not files:
        raise ValueError(f'picture {record["id"]} lists no file')
    return min(files, key=lambda f: (abs(f['height'] - height), -f['height']))['url']


def features(data):
    """A picture as 24x24x3 numbers, normalised: its dark frame trimmed, so a cover and the
    same cover on the board compare alike whatever margin each was cut with."""
    with Image.open(io.BytesIO(data)) as source:
        image = source.convert('RGB')
    grey = image.convert('L').point(lambda v: 255 if v > 18 else 0)
    bounds = grey.getbbox()
    if bounds:
        image = image.crop(bounds)
    values = list(image.resize((24, 24), Image.Resampling.LANCZOS).tobytes())
    mean = sum(values) / len(values)
    spread = math.sqrt(sum((v - mean) ** 2 for v in values) / len(values)) or 1.0
    return [(v - mean) / spread for v in values]


def similarity(a, b):
    return sum(x * y for x, y in zip(a, b)) / len(a)


class Reader:
    """Timo's reader: its covers (json/covers.json) and story names, fetched once, and only when
    a new picture needs matching."""

    def __init__(self):
        self._covers = None
        self._names = None

    def covers(self):
        if self._covers is None:
            groups = json.loads(fetch(f'{READER}json/covers.json'))['groups']
            self._covers = {}
            for group, meta in groups.items():
                if not meta.get('cover') or not meta.get('category'):
                    continue
                try:
                    self._covers[group] = (meta, features(fetch(f'{READER}covers/{meta["cover"]}', 30)))
                except Exception as exc:  # noqa: BLE001 -- one cover missing only narrows the match
                    print(f'  cover {group}: {exc}', file=sys.stderr)
        return self._covers

    def names(self):
        if self._names is None:
            try:
                review = json.loads(fetch(f'{READER}json/catalog.en.json', 120)).get('review') or {}
                self._names = {group: entry.get('name') for group, entry in review.items() if entry.get('name')}
            except Exception as exc:  # noqa: BLE001 -- the covers' own titles stand in
                print(f'  story names: {exc}', file=sys.stderr)
                self._names = {}
        return self._names

    def match(self, picture):
        """(link, score, margin) for a picture's bytes; link None unless the match is clear."""
        scores = sorted(((similarity(picture, vector), group) for group, (_, vector) in self.covers().items()), reverse=True)
        if not scores:
            return None, 0.0, 0.0
        best, group = scores[0]
        margin = best - (scores[1][0] if len(scores) > 1 else 0.0)
        if best < MATCH_SCORE or margin < MATCH_MARGIN:
            return None, best, margin
        meta = self.covers()[group][0]
        title = self.names().get(group) or meta.get('title') or group
        return {'title': title, 'url': f'{READER}story.html#{meta["category"]}&{group}&0', 'story': group}, best, margin


COMICS = 'https://www.arknights.global/api/resource/comic/list?index=1&size=999'
COMIC_PAGE = 'https://www.arknights.global/comic'


def comic_id(name):
    return 'manga-' + re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')


def comic_url(name):
    """The comic's page on the Global site, at its first chapter (the site's own link shape)."""
    return f'{COMIC_PAGE}?name={urllib.parse.quote(name, safe="")}&chapter=1'


def blurb(html):
    """The site's description as plain text: it is sometimes wrapped in <p> or <div>."""
    text = re.sub(r'<[^>]+>', ' ', html or '')
    for entity, char in (('&nbsp;', ' '), ('&amp;', '&'), ('&quot;', '"'), ('&#39;', "'"), ('&lt;', '<'), ('&gt;', '>')):
        text = text.replace(entity, char)
    return re.sub(r'\s+', ' ', text).strip()


def manga(previous, published, staging, alerts):
    """The map's manga: every one kept as it was, then each comic the official list has that the
    map does not, unplaced. Returns them in order, and how many covers were staged."""
    kept = {item['id']: item for item in previous}
    order = [item['id'] for item in previous]
    try:
        rows = json.loads(fetch(COMICS))['data']['rows']
        if not isinstance(rows, list):
            raise ValueError(f'the comic list answered {type(rows).__name__}, not a list')
    except Exception as exc:  # noqa: BLE001 -- the comic list is enrichment, never a gate
        print(f'  the official comic list could not be read: {exc}', file=sys.stderr)
        alerts.append({'key': 'story-map-manga', 'action': 'published-partial', 'sourceRef': COMICS,
                       'reason': 'The official comic list could not be read; the story map keeps the manga it already had.'})
        rows = []
    for row in rows:
        name = (row.get('name') or '').strip()
        if not name:
            continue
        mid = comic_id(name)
        if mid not in kept:
            kept[mid] = {'id': mid, 'title': name, 'url': comic_url(name), 'section': None}
            order.append(mid)
            print(f'  new manga, not yet categorized: {name}')
        item = kept[mid]
        # The flat cover the site's comic list shows (smallImage); bigImage is a mock-up of a book.
        item['cover'] = row.get('smallImage') or row.get('bigImage') or item.get('cover')
        item['description'] = blurb(row.get('comicDescribe'))
        if isinstance(row.get('latestChapter'), int) and row['latestChapter'] > 0:
            item['chapters'] = row['latestChapter']
            item['latestUrl'] = f'{COMIC_PAGE}?name={urllib.parse.quote(name, safe="")}&chapter={row["latestChapter"]}'
        if isinstance(row.get('updateTime'), (int, float)) and row['updateTime'] > 0:
            item['updated'] = time.strftime('%Y-%m-%d', time.gmtime(row['updateTime'] / 1000))
    staged = 0
    for mid in order:
        item = kept[mid]
        target = f'{FOLDER}/{mid}.webp'
        if target not in published and item.get('cover'):
            try:
                staging.stage(target, fetch(item['cover'], 90), source=item['cover'])
                staged += 1
                alerts.append({'key': f'story-map-art:{mid}', 'action': 'published-partial', 'sourceRef': item['cover'],
                               'reason': f'The cover of {item["title"]} is staged, but no run has published it as {target} yet; '
                                         'the story map shows its title alone until one does.'})
            except Exception as exc:  # noqa: BLE001
                print(f'  cover of {item["title"]}: {exc}', file=sys.stderr)
        item['image'] = target if target in published else None
    return [kept[mid] for mid in order], staged


def main():
    previous = {}
    previous_manga = []
    if os.path.exists(OUT):
        with open(OUT, encoding='utf-8') as f:
            saved = json.load(f)
        previous = {e['id']: e for e in saved.get('elements', []) if e.get('type') == 'picture'}
        previous_manga = saved.get('manga', [])
    html = fetch(BOARD).decode('utf-8', 'replace')
    elements, media = board_elements(bootstrap(html))
    title = re.search(r'<meta property="og:title" content="([^"]*)"', html)

    published = published_assets()
    staging = Staging('story-map', root)
    reader = Reader()
    alerts, staged, linked = [], 0, 0
    for item in elements:
        if item['type'] != 'picture':
            continue
        pid = item['id']
        target = f'{FOLDER}/{pid}.webp'
        known = previous.get(pid, {})
        needs_art = target not in published
        needs_link = 'link' not in known
        data = None
        if needs_art or needs_link:
            url = thumbnail(media[pid])
            try:
                data = fetch(url, 90)
            except Exception as exc:  # noqa: BLE001
                print(f'  picture {pid}: {exc}', file=sys.stderr)
        if needs_art and data:
            staging.stage(target, data, source=f'{BOARD}#{pid}')
            staged += 1
            alerts.append({'key': f'story-map-art:{pid}', 'action': 'published-partial', 'sourceRef': BOARD,
                           'reason': f'A picture on the Arknights Story Map is staged as .cache/{FOLDER}/, but no run has published it '
                                     f'to arkpedia-image-assets as {target} yet; the map draws its place empty until one does.'})
        elif needs_art:
            alerts.append({'key': f'story-map-art:{pid}', 'action': 'published-partial', 'sourceRef': BOARD,
                           'reason': 'A picture on the Arknights Story Map could not be downloaded; the map draws its place empty.'})
        item['image'] = target if target in published else None
        if not needs_link:
            item['link'] = known['link']
        elif data:
            try:
                link, score, margin = reader.match(features(data))
            except Exception as exc:  # noqa: BLE001 -- the reader is enrichment, never a gate
                print(f'  matching {pid}: {exc}', file=sys.stderr)
                link, score, margin = None, 0.0, 0.0
            if link:
                item['link'] = link
                linked += 1
                print(f'  {pid} -> {link["story"]} ({score:.2f}, ahead by {margin:.2f})')
        if 'link' not in item:
            alerts.append({'key': f'story-map:{pid}', 'action': 'published-partial', 'sourceRef': BOARD,
                           'reason': f'A picture on the Arknights Story Map ({target}) matches no story in the reader clearly; '
                                     'it is drawn without a link until data/story-map.json in arkpedia-data gives it one.'})

    comics, staged_covers = manga(previous_manga, published, staging, alerts)
    staged += staged_covers

    xs = [v for e in elements for v in ((e['x1'], e['x2']) if e['type'] == 'line' else (e['x'], e['x'] + e['width']))]
    ys = [v for e in elements for v in ((e['y1'], e['y2']) if e['type'] == 'line' else (e['y'], e['y'] + e['height']))]
    margin = 40
    record = {
        'source': BOARD,
        'title': title.group(1) if title else 'Arknights Story Map',
        'reader': READER,
        'bounds': {'x': round(min(xs) - margin, 1), 'y': round(min(ys) - margin, 1),
                   'width': round(max(xs) - min(xs) + 2 * margin, 1), 'height': round(max(ys) - min(ys) + 2 * margin, 1)},
        'elements': elements,
        'manga': comics,
    }
    staging.commit()
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(record, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')
    pictures = [e for e in elements if e['type'] == 'picture']
    print(f'{len(elements)} board elements, {len(pictures)} pictures ({sum(1 for p in pictures if (p.get("link") or {}).get("url"))} linked, '
          f'{linked} newly), {staged} staged in .cache/{FOLDER}/ -> data/story-map.json')
    report('story-map', alerts)
    return 0


if __name__ == '__main__':
    sys.exit(main())
