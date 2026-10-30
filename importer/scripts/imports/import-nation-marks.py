#!/usr/bin/env python3
"""Imports the nation crests the Annihilation cards wear, from arknights.wiki.gg.

Annihilation is the one mode whose operations ARE places: the fifteen of them are
Chernobog and Lungmen and the Scorching Workshop, and the game marks each with the
crest of the country it is in. The site had been showing one of each operation's own
stage maps instead -- grey grids, all alike, telling a reader nothing about which
country they were about to be sent to.

The crests are not in the gamedata dumps this project syncs (they are UI art, and no
mirror it can reach carries ui/), but the wiki has all fourteen as File:<Nation>.png
at 510x510, white on transparent. So they come from there, like the Reclamation
Algorithm maps in import_ra_maps.py, and the webp published to arkpedia-image-assets as
nation-marks/<slug>.webp is the artifact of record.

    python3 scripts/imports/import-nation-marks.py

WHICH NATIONS. Read off the contents themselves rather than typed out here: every
Annihilation content is NAMED for its nation ("Ursus", "Kazdel", "Bolívar"), so the
list is data/stages-content.json's and cannot drift from it. One is compound --
"Yan-Lungmen", the city inside the country -- and takes the country's crest, which is
what the game does too.

The output is a mask, not a picture: these are already one flat colour on alpha, so
the colour is dropped and the site paints them from the theme, as it does the mode
emblems. Filenames are folded to ASCII (Bolívar -> bolivar, Ægir -> aegir) because
/_next/image answers 400 for a raw non-ASCII letter in a path and 200 for the same
letter encoded -- and it does that in production only, so the blank card never shows
up in dev.

NOTHING HERE PUBLISHES. Art reaches readers only through arkpedia-image-assets, and a
file in this repository's public/ is refused by check:assets, which the daily release
runs: writing the crest there turned every SUCCESSFUL download into a blocked release.
A downloaded crest's mask is staged in .cache/nation-marks/ instead, as a lossless PNG
(staged_art.py); the release's staged-art stage publishes it and runs this again, which
maps it. Until then it stays out of data/nation-marks.json -- the card keeps its
fallback -- and is reported under 'nation-marks' with its source and the path it must
be published at.

The wiki is only asked about crests that are not published yet -- none today -- and it
never fails the refresh: a crest it cannot serve leaves that card on its fallback and
goes on the quarantine list under 'nation-marks' until a later run imports it. The
reason says which step failed (asking the wiki, the download, decoding the image) and
never the day's error text, which goes to the log: data/quarantine.json is a release
input, and an outage that answers 502 one day and refuses the connection the next must
not publish a release each day.
"""
from published_assets import published_assets
from quarantine import WIKI_API, report
from staged_art import Staging
import json
import os
import re
import ssl
import sys
import unicodedata
import urllib.parse
import urllib.request
from io import BytesIO

import certifi
from PIL import Image

API = WIKI_API
# The wiki rejects a request with no User-Agent outright (403), as its API policy says
# it will. Naming the project is also just the polite thing to do.
UA = 'Arkpedia-import/1.0 (+https://arkpedia.net) python-urllib'

SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())

root = os.getcwd()
index_file = os.path.join(root, 'data', 'nation-marks.json')

# Æ is a letter, not an accent, so NFKD leaves it alone; the rest fold on their own.
FOLD = {'æ': 'ae', 'ø': 'o', 'ß': 'ss'}


def slug(name: str) -> str:
    lowered = ''.join(FOLD.get(c, c) for c in name.lower())
    stripped = ''.join(c for c in unicodedata.normalize('NFKD', lowered)
                       if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]+', '-', stripped).strip('-')


def api(params):
    url = f'{API}?{urllib.parse.urlencode(params)}'
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, context=SSL_CONTEXT, timeout=60) as r:
        return json.loads(r.read())


def nations():
    """content id -> the nation on its card, for every Annihilation content."""
    with open(os.path.join(root, 'data', 'stages-content.json'), encoding='utf-8') as f:
        contents = json.load(f)
    out = {}
    for cid, c in contents.items():
        if c.get('kind') != 'annihilation':
            continue
        name = (c.get('name') or '').strip()
        # "Yan-Lungmen" is a city in a country; the crest belongs to the country.
        out[cid] = name.split('-')[0].strip() if name else None
    return {k: v for k, v in out.items() if v}


def resolve(names):
    """nation -> the url of its crest, for every one the wiki has."""
    titles = {f'File:{n}.png': n for n in sorted(set(names))}
    urls = {}
    # The API takes up to 50 titles at a time; fourteen is one request.
    data = api({
        'action': 'query', 'format': 'json', 'prop': 'imageinfo',
        'iiprop': 'url', 'titles': '|'.join(titles),
    })
    for page in (data.get('query') or {}).get('pages', {}).values():
        info = (page.get('imageinfo') or [{}])[0]
        nation = titles.get(page.get('title'))
        if nation and info.get('url'):
            urls[nation] = info['url']
    return urls


def mask(blob: bytes) -> Image.Image:
    """The crest's shape, in white, trimmed to itself."""
    im = Image.open(BytesIO(blob)).convert('RGBA')
    out = Image.new('RGBA', im.size, (255, 255, 255, 0))
    out.putalpha(im.getchannel('A'))
    return out.crop(out.getbbox() or (0, 0, *im.size))


def main() -> int:
    wanted = nations()
    if not wanted:
        print('no annihilation contents in data/stages-content.json', file=sys.stderr)
        return 1
    # Published crests need no request at all; only the rest are looked up.
    unpublished = sorted({n for n in wanted.values() if f'nation-marks/{slug(n)}.webp' not in published_assets()})
    urls, unreachable, alerts = {}, None, []
    if unpublished:
        try:
            urls = resolve(unpublished)
        except Exception as exc:  # noqa: BLE001 -- the wiki is enrichment, never a gate
            unreachable = exc
            print(f'  the wiki could not be asked: {exc}', file=sys.stderr)
    missing = [] if unreachable else sorted(set(unpublished) - set(urls))

    index = {}
    fetched = 0
    handled = set()
    staging = Staging('nation-marks', root)
    for cid, nation in sorted(wanted.items()):
        file = f'{slug(nation)}.webp'
        if nation not in unpublished:
            index[cid] = file
            continue
        # One crest serves every content of its nation; it is reported once.
        if nation in handled:
            continue
        handled.add(nation)
        url = urls.get(nation)
        if not url:
            reason = (f'The wiki could not be reached to ask for the {nation} crest' if unreachable
                      else f'The wiki has no File:{nation}.png')
            alerts.append({'key': f'nation-mark:{slug(nation)}', 'action': 'published-partial', 'sourceRef': API,
                           'reason': f'{reason}; its Annihilation cards are published without a crest.'})
            continue
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        try:
            with urllib.request.urlopen(req, context=SSL_CONTEXT, timeout=90) as r:
                blob = r.read()
        except Exception as exc:  # noqa: BLE001
            print(f'  FAILED {nation}: {exc}', file=sys.stderr)
            alerts.append({'key': f'nation-mark:{slug(nation)}', 'action': 'published-partial', 'sourceRef': url,
                           'reason': f'Downloading the {nation} crest failed; its Annihilation cards are published without it.'})
            continue
        try:
            crest = mask(blob)
        except Exception as exc:  # noqa: BLE001 -- e.g. an HTML page answered 200
            print(f'  UNREADABLE {nation}: {exc}', file=sys.stderr)
            alerts.append({'key': f'nation-mark:{slug(nation)}', 'action': 'published-partial', 'sourceRef': url,
                           'reason': f'The {nation} crest the wiki serves is not an image that decodes; its Annihilation cards '
                                     'are published without it.'})
            continue
        staged = staging.image(f'nation-marks/{file}', crest, source=url)
        fetched += 1
        print(f'  {file:18} {crest.size[0]}x{crest.size[1]:<4} {round(staged.stat().st_size / 1024):3}KB  <- {nation}')
        # Left out of the index: the card would point at a file readers cannot load yet.
        alerts.append({'key': f'nation-mark:{slug(nation)}', 'action': 'published-partial', 'sourceRef': url,
                       'reason': f'The {nation} crest is staged as .cache/nation-marks/{staged.name}, but no run has published it '
                                 f'to arkpedia-image-assets as nation-marks/{file} yet; its Annihilation cards are published '
                                 'without it until one does.'})

    staging.commit()
    with open(index_file, 'w', encoding='utf-8') as f:
        json.dump(index, f)
    print(f'{fetched} new crest(s) staged in .cache/nation-marks/ for arkpedia-image-assets, '
          f'{len(index)} contents mapped to published crests -> data/nation-marks.json')
    if missing:
        print(f'  the wiki has no crest for: {", ".join(missing)}')
    report('nation-marks', alerts)
    return 0


if __name__ == '__main__':
    sys.exit(main())
