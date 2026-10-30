#!/usr/bin/env python3
"""Each profile card theme's colours, from the Global client's own asset bundles.

The account page draws the game's profile card (components/account/ProfileCard), whose
tags, marks and complete nations' emblems take the theme's colour, and whose right-hand
panels its panel colours. No game table carries them: each theme's bundle
(arts/ui/namecardskin/[uc]<id>.ab) holds a skin_style object whose fields are the colours,
and the published asset dumps leave such objects out. So this reads the bundles themselves
from Yostar's CDN, as the client downloads them:

  _themeColor       the accent: the Hired and Hiring Progress tags, the marks, the emblems
  _themeTextColor   text on the accent
  _moduleBgColor    the right-hand panels (dark on most themes, light on a few)
  _moduleTextColor  the panels' text
  _moduleIconColor  the panels' icons

and writes data/namecard-styles.json, which build-game-account-map.ts copies into the id
map (a release table, so a new theme's colours need no redeploy).

The client compresses its bundles with its own LZ4 (each token's nibbles swapped, each match
offset big-endian), which UnityPy reads as LZHAM; decompress_lz4ak undoes it. A bundle is
fetched only when its md5 in the CDN's hot_update_list differs from the one recorded, so a
night with no new theme downloads nothing but the list. A theme whose bundle fails to read
keeps its previous colours.

Needs UnityPy and lz4 (prepare-content.yml installs them). Run: python3 scripts/imports/import-namecard-styles.py
"""
import io
import json
import os
import re
import ssl
import sys
import urllib.request
import zipfile
from pathlib import Path

import importlib.util as _importlib_util
_spec = _importlib_util.spec_from_file_location('client_bundles', Path(__file__).with_name('client_bundles.py'))
_client_bundles = _importlib_util.module_from_spec(_spec)
_spec.loader.exec_module(_client_bundles)

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'data' / 'namecard-styles.json'
CDN = os.environ.get('ARKPEDIA_YOSTAR_CDN', 'https://ark-us-static-online.yo-star.com/assetbundle/official/Android')
EXCEL = Path(os.environ.get('ARKPEDIA_EN', ROOT / '.cache/upstream/en-gamedata')) / 'en' / 'gamedata' / 'excel'
UA = {'User-Agent': 'Arkpedia-data/1.0 (+https://arkpedia.net)'}
try:
    import certifi
    SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # the system's certificates, then
    SSL = ssl.create_default_context()
THEME_BUNDLE = re.compile(r'arts/ui/namecardskin/\[uc\](nc_[\w]+)\.ab')
FIELDS = {'theme': '_themeColor', 'themeText': '_themeTextColor', 'panel': '_moduleBgColor', 'panelText': '_moduleTextColor', 'panelIcon': '_moduleIconColor'}


# The client's LZ4, shared by every importer that reads the client's bundles (client_bundles.py).
# Re-exported here for import-medal-layouts.py and the tests, which take it from this module.
decompress_lz4ak = _client_bundles.decompress_lz4ak


def colour(value: dict) -> str:
    """A Unity colour as #rrggbb, with an alpha byte when it is not opaque."""
    rgb = '#' + ''.join(f'{round(value[k] * 255):02x}' for k in 'rgb')
    return rgb if value['a'] >= 0.999 else rgb + f'{round(value["a"] * 255):02x}'


def read_style(bundle: bytes) -> dict:
    """The skin_style object's colours (and its own theme id, which one theme leaves empty)."""
    import UnityPy
    from UnityPy.enums.BundleFile import CompressionFlags
    from UnityPy.helpers import CompressionHelper
    CompressionHelper.DECOMPRESSION_MAP[CompressionFlags.LZHAM] = decompress_lz4ak
    env = UnityPy.load(bundle)
    for obj in env.objects:
        if obj.type.name != 'MonoBehaviour':
            continue
        try:
            tree = obj.read_typetree()
        except Exception:
            continue
        if all(field in tree for field in FIELDS.values()):
            return {'skinId': tree.get('_skinId') or None, **{name: colour(tree[field]) for name, field in FIELDS.items()}}
    raise ValueError('no skin_style object in the bundle')


def get(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120, context=SSL) as response:
        return response.read()


def theme_ids() -> dict:
    """The display table's theme ids by lower case: the bundles are named in lower case."""
    table = EXCEL / 'display_meta_table.json'
    if table.exists():
        ids = json.loads(table.read_text())['nameCardV2Data']['skinData'].keys()
    else:
        ids = json.loads((ROOT / 'data' / 'game-account-map.json').read_text()).get('nameCards', {}).keys()
    return {theme.lower(): theme for theme in ids}


def main() -> int:
    previous = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {'themes': {}}
    version = json.loads(get(f'{CDN}/version'))['resVersion']
    listing = json.loads(get(f'{CDN}/assets/{version}/hot_update_list.json'))['abInfos']
    ids = theme_ids()
    themes, failed, fetched = dict(previous.get('themes', {})), [], 0
    for info in listing:
        match = THEME_BUNDLE.fullmatch(info['name'])
        if not match:
            continue
        name = match.group(1)
        if themes.get(ids.get(name, name), {}).get('md5') == info['md5']:
            continue
        url = f'{CDN}/assets/{version}/' + info['name'].replace('/', '_').replace('.ab', '.dat').replace('[', '%5B').replace(']', '%5D')
        try:
            archive = zipfile.ZipFile(io.BytesIO(get(url)))
            style = read_style(archive.read(archive.namelist()[0]))
        except Exception as error:  # one theme's bundle: it keeps yesterday's colours
            failed.append(f'{info["name"]}: {error}')
            continue
        theme = style.pop('skinId') or ids.get(name, name)
        themes[theme] = {'md5': info['md5'], **style}
        fetched += 1
    if not themes:
        print('import-namecard-styles: no theme could be read.', *failed, sep='\n  ', file=sys.stderr)
        return 1
    OUTPUT.write_text(json.dumps({'resVersion': version, 'themes': dict(sorted(themes.items()))}, indent=2) + '\n')
    print(f'Profile card theme colours at {version}: {len(themes)} themes, {fetched} read from their bundles' + (f', {len(failed)} kept from before:' if failed else '.'))
    for line in failed:
        print(f'  {line}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
