#!/usr/bin/env python3
"""Names the Contingency Contract Battleplan stages and imports their renders.

Three things were wrong or missing for the 16 CCB stages:

  series   The pipeline labels the seasons CC#1..CC#4 from the game's own
           crisisV2SeasonCode ("#1"), but "CC#1" is the community's name for the
           FIRST series (CC#1-12, gamedata's crisis v1). This is crisis v2 --
           Battleplan -- which the community writes CCB. Relabelled CCB#1..CCB#4.

  code     A CCB stage has no stage record at all: its id is a level path
           ("obt/crisis/v2/level_crisis_v2_01-02"), so it came through with no
           code and no name and rendered as a blank row. The code is built from
           the season and map numbers the level path carries.

  name     The gamedata does not name CCB maps. The only name anywhere in the
           dumps is in medal text -- "During Battleplan Arclight, reach a score of
           300 in Main Test Site" -- which names each season's -01 map and no
           other. That name is taken from there; the rest keep none rather than
           being given an invented one. (The client does show names for the other
           maps, but they are UI strings in main_text.json under hashed keys with
           nothing tying them to a level.)

Renders come from the local ArknightsGameResource checkout, whose map/ directory
keys them the same way the level path does (map/crisis_v2_01-02.png). That is why
they were missed: every other preview is named after a stage id, and these stages
have none. The checkout is the refresh's upstream-cn-art stage, which is not an
invariant: on a day it fails there is no map/ at all, and this still names and
labels every stage and keeps every render the image repository publishes.

NOTHING HERE PUBLISHES. Art reaches readers only through arkpedia-image-assets
(stages-images/<key>.webp), and a file in this repository's public/ is refused by
check:assets, which the daily release runs, so a new season's render written there
would have blocked the release. The render is staged in .cache/cc-stages/ instead
(staged_art.py), as the mirror serves it; the release's staged-art stage publishes it and
runs this again, which gives the stage its render. Until then the stage has none and is
reported under 'cc-stages' with the path it must be published at, as is a stage with no
render at all.

Run:  python3 scripts/imports/import_cc_stages.py
"""
from published_assets import published_assets
from quarantine import report
from staged_art import Staging
import io
import json
import os
import re
import sys

from PIL import Image

RES = os.environ.get('ARKPEDIA_CN', '.cache/upstream/cn-resource')
MIRROR = 'yuanyan3060/ArknightsGameResource'
# The commit this run pinned for the mirror (scripts/content/pin-upstream.mjs, handed to every
# stage by the runner): the checkout above is at it, so it names where each staged render is from.
PIN = os.environ.get('ARKPEDIA_PIN_YUANYAN3060_ARKNIGHTSGAMERESOURCE') or ''
PINNED = bool(re.fullmatch(r'[0-9a-f]{40}', PIN))
EN = os.environ.get('ARKPEDIA_EN', '.cache/upstream/en-gamedata/en') + '/gamedata/excel'

root = os.getcwd()
stages_dir = os.path.join(root, 'data', 'stages')


def map_names():
    """level id -> the map's name, for the maps the medal text names."""
    medals = json.load(open(os.path.join(EN, 'medal_table.json'))).get('medalList') or {}
    rows = medals.values() if isinstance(medals, dict) else medals
    out = {}
    for medal in rows:
        unlock = medal.get('unlockParam') or []
        if len(unlock) < 2 or not str(unlock[1]).startswith('level_crisis_v2'):
            continue
        found = re.search(r' in ([^.]+)\.', medal.get('getMethod') or '')
        if found:
            out.setdefault(str(unlock[1]), found.group(1).strip())
    return out


def main():
    names = map_names()
    plan = {}
    missing = []
    alerts = []
    staging = Staging('cc-stages', root)
    for file in sorted(os.listdir(stages_dir)):
        if not file.endswith('.json'):
            continue
        rec = json.load(open(os.path.join(stages_dir, file)))
        if rec.get('stage_type') != 'contingency_contract':
            continue
        level = (rec.get('id') or '').split('/')[-1]          # level_crisis_v2_01-02
        key = re.sub(r'^level_', '', level)                    # crisis_v2_01-02
        season_map = re.search(r'_(\d+)-(\d+)$', key)
        if not season_map:
            missing.append(f'{rec["slug"]}: cannot read a season and map from {key}')
            continue
        entry = {'code': f'CCB#{int(season_map.group(1))}-{int(season_map.group(2))}'}
        if names.get(level):
            entry['name'] = names[level]
        src = os.path.join(RES, 'map', f'{key}.png')
        if f'stages-images/{key}.webp' in published_assets():
            entry['render'] = f'{key}.webp'
        elif os.path.exists(src):
            # As the mirror serves it: the publisher encodes it, as stages-images/ takes it.
            try:
                data = open(src, 'rb').read()
                Image.open(io.BytesIO(data)).load()
                staging.stage(f'stages-images/{key}.webp', data,
                              source=f'https://raw.githubusercontent.com/{MIRROR}/{PIN if PINNED else "main"}/map/{key}.png',
                              mirror={'repository': MIRROR, 'path': f'map/{key}.png', 'commit': PIN} if PINNED else None)
                why = (f'its render is staged as .cache/cc-stages/{key}.png from map/{key}.png, but no run has published it to '
                       f'arkpedia-image-assets as stages-images/{key}.webp yet; it is published without one until one does')
            except Exception as exc:  # noqa: BLE001 -- one bad file holds back one stage
                # The error names the checkout's path and the day's wording: the log gets it,
                # the reason (a release input) only the kind.
                print(f'  UNREADABLE {src}: {exc}', file=sys.stderr)
                why = f'map/{key}.png does not decode, so it is published without a render'
            alerts.append({'key': f'cc-render:{rec["slug"]}', 'action': 'published-partial', 'sourceRef': f'map/{key}.png',
                           'reason': f'{entry["code"]} ({rec["slug"]}): {why}.'})
        elif not os.path.isdir(os.path.join(RES, 'map')):
            missing.append(f'{rec["slug"]}: no CN art this run')
            alerts.append({'key': f'cc-render:{rec["slug"]}', 'action': 'published-partial',
                           'reason': f'{entry["code"]} ({rec["slug"]}): the CN art (map/) could not be synced this run, so its render cannot be staged; '
                                     f'it is published without one until stages-images/{key}.webp is added to arkpedia-image-assets.'})
        else:
            missing.append(f'{rec["slug"]}: no render at map/{key}.png')
            alerts.append({'key': f'cc-render:{rec["slug"]}', 'action': 'published-partial',
                           'reason': f'{entry["code"]} ({rec["slug"]}): the resource checkout has no map/{key}.png, so it is published without a render.'})
        plan[rec['slug']] = entry

    staging.commit()
    with open(os.path.join(root, 'data', 'cc-stages.json'), 'w') as fh:
        json.dump(plan, fh, separators=(',', ':'), sort_keys=True)

    # The series label, on the content records the index copies it from.
    contents_path = os.path.join(root, 'data', 'stages-content.json')
    contents = json.load(open(contents_path))
    relabelled = 0
    for content in contents.values():
        if content.get('kind') != 'contingency_contract':
            continue
        label = content.get('label') or ''
        if label.startswith('CC#'):
            content['label'] = 'CCB#' + label[len('CC#'):]
            relabelled += 1
    with open(contents_path, 'w') as fh:
        json.dump(contents, fh, separators=(',', ':'), ensure_ascii=False)

    print(f'{len(plan)} CCB stages: {sum(1 for e in plan.values() if e.get("render"))} with a render, '
          f'{sum(1 for e in plan.values() if e.get("name"))} with a name from medal text')
    print(f'{relabelled} seasons relabelled CCB#N')
    if missing:
        print(f'{len(missing)} gaps: ' + '; '.join(missing[:4]))
    report('cc-stages', alerts)


if __name__ == '__main__':
    sys.exit(main())
