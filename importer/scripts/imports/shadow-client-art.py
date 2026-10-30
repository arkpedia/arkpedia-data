#!/usr/bin/env python3
"""Operator icons and skill icons from the CN client itself, compared with the mirror we publish from.

Shadow mode (OFFICIAL-ART-PLAN-2026-10-18.md, step C): this publishes nothing. Arkpedia's
avatars and skill icons come from yuanyan3060/ArknightsGameResource (avatar/<id>.png,
skill/skill_icon_<id>.png); the same pictures are sprites in the CN client's
spritepack/ui_char_avatar_<n> and spritepack/skill_icons_<n> bundles, under the same names.
For every file arkpedia-image-assets publishes from those two folders (its asset-source-map.json,
at the pinned revision), this extracts the client's sprite (client_bundles.py) and compares its
pixels with the mirror's file at the run's pinned commit. When they agree patch after patch,
the client can become the source and the mirror the fallback.

It also reports what the client already has that the site does not: an operator whose roster
icon is not published while the client ships that operator's avatar (published-partial,
overdue after three days -- usually a mirror that has not caught up with a patch).

Kept in data/client-art-shadow.json, so a night with no patch downloads nothing: each bundle's
md5, the operator avatars the client ships, and each compared file's verdict with the pixel hash
of both sides (`same`, `differs`, `no-official` when no bundle of its kind holds that sprite, or
`pending` when the mirror's file could not be read and is asked for again the next run).
A bundle is downloaded again only when its md5 changes, or when a file appears that no
downloaded bundle has accounted for; a file is compared again only when its sprite or its
mirror file changes.

Reported to the quarantine as stage client-art: one entry per kind when any file differs (the
site keeps the mirror's), one per operator icon the client has and the site lacks.

Run: python3 scripts/imports/shadow-client-art.py
"""
import concurrent.futures
import glob
import importlib.util
import io
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def _module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


client_bundles = _module('client_bundles', 'client_bundles.py')
quarantine = _module('quarantine', 'quarantine.py')

STATE = ROOT / 'data' / 'client-art-shadow.json'
REVISIONS = ROOT / 'data' / 'assets' / 'revisions.json'
PUBLIC_INDEX = ROOT / 'data' / 'assets' / 'public-asset-index.json'
REGION = 'cn'
MIRROR = 'yuanyan3060/ArknightsGameResource'
# pin-upstream.mjs pinVariable(): the commit this run reads the mirror at, else its branch.
MIRROR_REF = os.environ.get('ARKPEDIA_PIN_YUANYAN3060_ARKNIGHTSGAMERESOURCE') or 'main'
KINDS = {
    'avatar': re.compile(r'^spritepack/ui_char_avatar_\d+\.ab$'),
    'skill': re.compile(r'^spritepack/skill_icons_\d+\.ab$'),
}
RARITY_WORD = ['', 'one', 'two', 'three', 'four', 'five', 'six']
ICON_GRACE_DAYS = 3


def safe_name(name: str) -> str:
    """scripts/sync/catalogue-model.mjs safeName: the file name of a record's art."""
    return re.sub(r'[\\/*?:"<>|]', '', name).strip()


def targets(source_map: dict) -> dict:
    """{sourcePath: sourceBlob} for the published files of each kind: avatar/x.png, skill/x.png."""
    out = {}
    for row in source_map.get('files', {}).values():
        path = row.get('sourcePath', '') if isinstance(row, dict) else ''
        kind = path.split('/')[0]
        if kind in KINDS and path.endswith('.png'):
            out[path] = row.get('sourceBlob', '')
    return out


def sprite_of(path: str) -> str:
    return path.split('/', 1)[1][:-len('.png')]


def mirror_hash(path: str):
    from PIL import Image
    # Outfit avatars carry a '#' (char_405_absin_epoque#28), which unencoded starts a fragment.
    url = f'https://raw.githubusercontent.com/{MIRROR}/{MIRROR_REF}/{urllib.parse.quote(path)}'
    try:
        return client_bundles.pixel_hash(Image.open(io.BytesIO(client_bundles.get(url, timeout=60))))
    except Exception as error:  # a file the mirror no longer has, or a failed read: compared next run
        print(f'  mirror {path}: {error}', file=sys.stderr)
        return None


def operator_icons_missing(avatars: set, published: set) -> list:
    """Operators whose avatar the client ships while their roster icon is not published."""
    missing = []
    for file in sorted(glob.glob(str(ROOT / 'data' / 'operators-*star' / '*.json'))):
        record = json.loads(Path(file).read_text())
        op_id, name, rarity = record.get('internalName'), record.get('name'), record.get('rarity')
        if not op_id or not name or not isinstance(rarity, int) or op_id not in avatars:
            continue
        icon = f'{RARITY_WORD[rarity]}-star-icons/{safe_name(name)} - Base.webp'
        if icon not in published:
            missing.append((op_id, name, icon))
    return missing


def run(client=None, source_map=None, published=None, mirror=mirror_hash, workers=8):
    previous = json.loads(STATE.read_text()) if STATE.exists() else {}
    if previous.get('region') not in (None, REGION):
        previous = {}
    bundles = dict(previous.get('bundles', {}))
    checked = dict(previous.get('checked', {}))
    avatars = set(previous.get('operatorAvatars', []))

    if source_map is None:
        pin = json.loads(REVISIONS.read_text())['arkpedia-image-assets']
        source_map = json.loads(client_bundles.get(f'https://raw.githubusercontent.com/arkpedia/arkpedia-image-assets/{pin}/asset-source-map.json'))
    wanted = targets(source_map)
    client = client or client_bundles.Client(REGION)
    files = client.files()

    official = {}       # sprite -> pixel hash, for the sprites extracted this run
    full = set()        # the kinds whose every bundle was read this run
    downloaded = 0
    for kind, pattern in KINDS.items():
        packs = {name: md5 for name, md5 in files.items() if pattern.match(name)}
        if not packs:
            raise ValueError(f'the {REGION} client lists no {kind} bundles: their names have probably changed')
        known = {sprite_of(path) for path, entry in checked.items() if path.startswith(f'{kind}/')}
        unresolved = any(path.startswith(f'{kind}/') and sprite_of(path) not in known for path in wanted)
        changed = [name for name, md5 in packs.items() if bundles.get(name) != md5]
        fetch = sorted(packs) if unresolved else sorted(changed)
        if unresolved:
            full.add(kind)
        for name in fetch:
            for sprite, image in client_bundles.sprites(client.bundle(name)):
                official[sprite] = client_bundles.pixel_hash(image)
                if kind == 'avatar' and sprite.startswith('char_') and '#' not in sprite:
                    avatars.add(sprite)
            bundles[name] = packs[name]
            downloaded += 1
        for name in list(bundles):
            if pattern.match(name) and name not in packs:
                del bundles[name]

    # A file is compared again when its sprite was extracted with other pixels, or the mirror's
    # file changed (its blob). Everything else keeps its verdict.
    todo = []
    for path, blob in wanted.items():
        verdict, before_blob, before_official = (checked.get(path, '').split(' ') + ['', '', ''])[:3]
        sprite, kind = sprite_of(path), path.split('/')[0]
        if sprite in official:
            now_official = official[sprite]
        elif kind in full:
            now_official = ''  # every bundle of its kind was read, and none holds it
        else:
            now_official = before_official
        if verdict and verdict != 'pending' and before_blob == blob[:12] and before_official == now_official:
            continue
        todo.append((path, blob, now_official))

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(lambda item: (item, mirror(item[0]) if item[2] else None), todo))
    for (path, blob, now_official), mirror_pixels in results:
        if not now_official:
            checked[path] = f'no-official {blob[:12]} '
        elif mirror_pixels is None:
            # The mirror could not be read (raw GitHub answers false 404s now and then): compared
            # again next run. Kept, with its sprite's hash, so no bundle is read again for it.
            checked[path] = f'pending {blob[:12]} {now_official}'
        else:
            checked[path] = f"{'same' if mirror_pixels == now_official else 'differs'} {blob[:12]} {now_official}"
    for path in list(checked):
        if path not in wanted:
            del checked[path]

    state = {'version': 1, 'region': REGION, 'resVersion': client.version,
             'bundles': dict(sorted(bundles.items())), 'operatorAvatars': sorted(avatars),
             'checked': dict(sorted(checked.items()))}
    text = json.dumps(state, indent=1, ensure_ascii=False) + '\n'
    if not STATE.exists() or STATE.read_text() != text:
        STATE.write_text(text)

    if published is None:
        published = set(json.loads(PUBLIC_INDEX.read_text())['files']) if PUBLIC_INDEX.exists() else set()
    entries = []
    for kind in KINDS:
        rows = {path: value.split(' ')[0] for path, value in checked.items() if path.startswith(f'{kind}/')}
        differs = sorted(path for path, verdict in rows.items() if verdict == 'differs')
        if differs:
            sample = ', '.join(sprite_of(path) for path in differs[:5])
            entries.append({'key': f'client-art:{kind}', 'action': 'kept-previous',
                            'reason': f'{len(differs)} of {len(rows)} {kind} files differ between the {REGION} client and {MIRROR} (for example {sample}); the site keeps the mirror\'s.'})
    if published:
        for op_id, name, icon in operator_icons_missing(avatars, published):
            entries.append({'key': f'client-art:icon:{op_id}', 'action': 'published-partial', 'overdueAfterDays': ICON_GRACE_DAYS,
                            'reason': f'The {REGION} client ships {name}\'s avatar ({op_id}), but {icon} is not published yet.'})
    summary = {kind: {verdict: sum(1 for path, value in checked.items() if path.startswith(f'{kind}/') and value.startswith(verdict + ' '))
                      for verdict in ('same', 'differs', 'no-official', 'pending')} for kind in KINDS}
    return entries, summary, downloaded, len(todo)


def main() -> int:
    try:
        entries, summary, downloaded, compared = run()
    except Exception as error:
        print(f'shadow-client-art: {error}', file=sys.stderr)
        quarantine.report('client-art', [{'key': 'client-art', 'action': 'kept-previous',
                                          'reason': f'The {REGION} client\'s icon bundles could not be read; the last comparison stands.'}])
        return 1
    quarantine.report('client-art', entries)
    print(f'Client art ({REGION}, shadow): {downloaded} bundle(s) read, {compared} file(s) compared. '
          + '; '.join(f'{kind}: ' + ', '.join(f'{n} {v}' for v, n in counts.items()) for kind, counts in summary.items()))
    return 0


if __name__ == '__main__':
    sys.exit(main())
