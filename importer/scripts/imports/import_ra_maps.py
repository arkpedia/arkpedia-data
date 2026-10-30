#!/usr/bin/env python3
"""Imports the Reclamation Algorithm stage maps from arknights.wiki.gg.

All 106 RA stages came through with preview: null, and it was not a resolution bug --
the renders are genuinely not in cn-resource. That repo publishes map/, avatar/,
enemy/, skill/, portrait/, skin/, item/ and building_skill/, and not one of its 3,055
map/ renders is sandbox-named; the only sandbox images in the whole repo are two item
icons. RA stage ids are level paths ("obt/sandbox/sandbox_1/level_sandbox1_65") rather
than the render ids map/ is keyed by, so there was nothing to match either.

The wiki does have them, one per stage, named after the stage rather than its id.
Three naming forms, in the order tried here:

  "<name> map.png"                              83 of 102 names
  "<name> (Tales Within the Sand) map.png"      15 more -- the wiki disambiguates a
                                                name an event stage also uses
  apostrophes dropped                           the last 4: the wiki writes
                                                'Treasury' as Treasury and
                                                The Lost 'Zhayedan' as
                                                The Lost Zhayedan (Tales Within the
                                                Sand)

102 distinct names cover all 106 stages -- four names are shared by two stages each,
which take the same map.

A map is published as stages-images/<slug>.webp in arkpedia-image-assets, the same
folder and the same webp the rest of the preview set uses, keyed by stage slug so
getStagePreviewFile finds it without a lookup table; a published map is written back
into its stage record's `preview`, so the field means the same thing for RA as for
everything else.

NOTHING HERE PUBLISHES. Art reaches readers only through arkpedia-image-assets, and a
file in this repository's public/ is refused by check:assets, which the daily release
runs: writing the map there turned every SUCCESSFUL download into a blocked release. A
downloaded map is staged in .cache/ra-maps/<slug>.png instead, as the wiki serves it
(staged_art.py); the release's staged-art stage publishes it and runs this again, which
sets the preview. Until then its stage keeps preview: null and is reported under
'ra-maps' with its source and the path it must be published at.

The wiki is only asked about stages whose map is not published yet -- none, once the
season is imported -- and it can never fail the refresh: a stage it cannot serve (down,
no upload yet, a failed download, an image that does not decode) keeps preview: null
and goes on the quarantine list under 'ra-maps' until a later run imports its map.
The reason names which of those it was and never the day's error text, which goes to
the log: data/quarantine.json is a release input, and an outage that answers 502 one day
and refuses the connection the next must not publish a release each day.

Run:  python3 scripts/imports/import_ra_maps.py
"""
from published_assets import published_assets
from quarantine import WIKI_API, report
from staged_art import Staging
import json
import os
import ssl
import sys
import urllib.parse
import urllib.request
from io import BytesIO

import certifi
from PIL import Image

API = WIKI_API
# The wiki rejects a request with no User-Agent outright (403), as its API policy says
# it will. Naming the project is also just the polite thing to do.
UA = 'Arkpedia-import/1.0 (+https://arkpedia.net) python-urllib'

root = os.getcwd()
stages_dir = os.path.join(root, 'data', 'stages')

SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())


def api(params):
    url = f'{API}?{urllib.parse.urlencode(params)}'
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, context=SSL_CONTEXT, timeout=60) as r:
        return json.loads(r.read())


def candidates(name):
    """The forms the wiki files a stage's map under, best first."""
    bare = name.replace("'", '').replace('’', '')
    seen = []
    for stem in (name, f'{name} (Tales Within the Sand)', bare, f'{bare} (Tales Within the Sand)'):
        title = f'File:{stem} map.png'
        if title not in seen:
            seen.append(title)
    return seen


def resolve(names):
    """name -> the url of its map, for every name the wiki has one for."""
    wanted = {}
    for n in names:
        for title in candidates(n):
            wanted.setdefault(title, n)

    titles = list(wanted)
    urls = {}
    for i in range(0, len(titles), 40):
        batch = titles[i:i + 40]
        data = api({
            'action': 'query', 'format': 'json', 'prop': 'imageinfo',
            'iiprop': 'url', 'titles': '|'.join(batch),
        })
        for page in data.get('query', {}).get('pages', {}).values():
            if 'missing' in page:
                continue
            info = (page.get('imageinfo') or [{}])[0]
            url = info.get('url')
            name = wanted.get(page['title'])
            # First candidate form wins, so a plain name is never overwritten by the
            # disambiguated file of a different stage.
            if url and name and name not in urls:
                urls[name] = (page['title'], url)
    return urls


def main():
    records = {}
    for entry in sorted(os.listdir(stages_dir)):
        if not entry.endswith('.json'):
            continue
        path = os.path.join(stages_dir, entry)
        with open(path) as fh:
            stage = json.load(fh)
        if (stage.get('content') or {}).get('kind') != 'reclamation':
            continue
        records[stage['slug']] = (path, stage)

    alerts = []
    if not records:
        print('no reclamation stages found -- nothing to do')
        report('ra-maps', alerts)
        return 0

    # Published: the record's preview is all that needs restoring, which is the normal
    # case after a pipeline run rewrites these records from the level files. Asking the
    # wiki about 106 stages, or re-fetching their images, to arrive at the same bytes is
    # rude to it and slow for us, and it would make every refresh depend on the wiki.
    # ARKPEDIA_REFETCH=1 forces the download.
    refetch = os.environ.get('ARKPEDIA_REFETCH')
    unmapped = {slug for slug in records if refetch or f'stages-images/{slug}.webp' not in published_assets()}
    names = sorted({records[slug][1].get('name') for slug in unmapped if records[slug][1].get('name')})
    print(f'{len(records)} RA stages, {len(unmapped)} without a map, {len(names)} distinct names to ask the wiki for')
    urls, unreachable = {}, None
    if names:
        try:
            urls = resolve(names)
            print(f'  the wiki has a map for {len(urls)} of them')
        except Exception as exc:  # noqa: BLE001 -- the wiki is enrichment, never a gate
            unreachable = exc
            print(f'  the wiki could not be asked: {exc}', file=sys.stderr)

    fetched = {}
    written = staged = 0
    staging = Staging('ra-maps', root)
    for slug, (path, stage) in sorted(records.items()):
        name = stage.get('name')
        if slug not in unmapped:
            stage['preview'] = f'images/stages/{slug}.png'
            with open(path, 'w') as fh:
                json.dump(stage, fh, ensure_ascii=False, separators=(',', ':'))
            written += 1
            continue
        # From here on a stage the wiki cannot serve keeps preview: null, is reported,
        # and is tried again by the next run.
        if unreachable:
            alerts.append({'key': f'ra-map:{slug}', 'action': 'published-partial', 'sourceRef': API,
                           'reason': f'The wiki could not be reached to ask for the map of {name}; the stage is published without one.'})
            continue
        hit = urls.get(name)
        if not hit:
            print(f'  no map: {slug} ({name})')
            alerts.append({'key': f'ra-map:{slug}', 'action': 'published-partial',
                           'reason': f'The wiki has no map file for {name} yet ({", ".join(candidates(name))}); the stage is published without one.'})
            continue
        title, url = hit
        # Keyed by slug, so two stages sharing a name each get their own file rather
        # than one of them pointing at the other's.
        previous = staging.previous(f'stages-images/{slug}.webp')
        data = fetched.get(url)
        if data is None and not refetch and previous:
            # Staged by an earlier run on this machine: listed again, not downloaded again.
            data = previous.read_bytes()
        if data is None:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            try:
                with urllib.request.urlopen(req, context=SSL_CONTEXT, timeout=90) as r:
                    data = r.read()
            except Exception as exc:  # noqa: BLE001
                print(f'  FAILED {title}: {exc}', file=sys.stderr)
                alerts.append({'key': f'ra-map:{slug}', 'action': 'published-partial', 'sourceRef': url,
                               'reason': f'Downloading {title} failed; the stage is published without a map.'})
                continue
            fetched[url] = data
        try:
            Image.open(BytesIO(data)).load()
        except Exception as exc:  # noqa: BLE001 -- e.g. an HTML page answered 200
            print(f'  UNREADABLE {title}: {exc}', file=sys.stderr)
            alerts.append({'key': f'ra-map:{slug}', 'action': 'published-partial', 'sourceRef': url,
                           'reason': f'{title} is not an image that decodes; the stage is published without a map.'})
            continue
        # As the wiki serves it: the publisher encodes it, as stages-images/ takes it.
        staged_file = staging.stage(f'stages-images/{slug}.webp', data, source=url)
        # preview stays null: it would name a file readers cannot load yet.
        staged += 1
        alerts.append({'key': f'ra-map:{slug}', 'action': 'published-partial', 'sourceRef': url,
                       'reason': f'The map of {name} is staged as .cache/ra-maps/{staged_file.name} from {title}, but no run has '
                                 f'published it to arkpedia-image-assets as stages-images/{slug}.webp yet; the stage is '
                                 'published without one until one does.'})

    staging.commit()
    print(f'{written} published maps set as their records\' preview; {staged} new map(s) staged in .cache/ra-maps/ '
          'for arkpedia-image-assets')
    report('ra-maps', alerts)
    return 0


if __name__ == '__main__':
    sys.exit(main())
