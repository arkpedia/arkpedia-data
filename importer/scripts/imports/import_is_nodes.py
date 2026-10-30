#!/usr/bin/env python3
"""Builds data/is-nodes.json: what the site needs about an Integrated Strategies
node beyond its level file, and imports the renders that go with it.

Three things the level file does not carry:

  render         The game's in-game view. A render is named after the stage's
                 gamedata id, and an IS stage has no stage id -- its id is a level
                 path ("obt/roguelike/ro1/level_rogue1_1-1") -- while the renders
                 are named after the ROGUELIKE stage id ("ro1_n_1_1.png"). Only
                 roguelike_topic_table.json ties the two together, which is why
                 all 525 IS stages came through with preview: null and were never
                 even attempted.

  emergency      Every node has a normal form and, for 206 of them, an Emergency
                 Ops form: the same level with its enemies buffed and often
                 further Elite enemies added ("Condition: Enemies have increased
                 ATK, DEF, and HP; new Elite enemies will appear"). It is a form
                 of the node, not a level of its own, so it has no stage record --
                 but it has its own render and its own condition text, which is
                 what the stage page toggles between. "Emergency Ops" is the
                 game's own wording (main_text.json).

  name           141 stages are replacer levels (levelreplacers/..._r1,
                 ro5/dlc1/..._dlc1) that the source leaves unnamed, so they read
                 as a bare "ISW-NO". They are alternate layouts for a node whose
                 base level IS named, and that is the name the game shows.

Membership comes from the CN dump (the freshest on disk) and the condition text
from the EN one. The renders come from fexli/ArknightsResource, the same source
the rest of the preview set was built from; the commit is pinned so a re-run
fetches the same files, and bumping it picks up new seasons.

NOTHING HERE PUBLISHES. Art reaches readers only through arkpedia-image-assets
(stages-images/<render>.webp), and a file in this repository's public/ is refused by
check:assets, which the daily release runs. A render fetched here is staged in
.cache/is-nodes/ instead, as the source serves it (staged_art.py); the release's
staged-art stage publishes it and runs this again, which puts its form in is-nodes.json.
Until then the form is left out and reported under 'is-nodes' with the path it must be
published at.

Run:  python3 scripts/imports/import_is_nodes.py
"""
from published_assets import published_assets
from quarantine import report
from staged_art import Staging
import json
import os
import ssl
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

import certifi
from PIL import Image

REPO_COMMIT = '6d02b532c2380abd11c467daf706bf4761fae919'
RAW = f'https://raw.githubusercontent.com/fexli/ArknightsResource/{REPO_COMMIT}/mapreview'
CN = os.environ.get('ARKPEDIA_CN', '.cache/upstream/cn-resource')
EN = os.environ.get('ARKPEDIA_EN', '.cache/upstream/en-gamedata/en')
CN_TABLE = f'{CN}/gamedata/excel/roguelike_topic_table.json'
EN_TABLE = f'{EN}/gamedata/excel/roguelike_topic_table.json'

root = os.getcwd()
stages_dir = os.path.join(root, 'data', 'stages')

# This interpreter has no system CA bundle of its own, so the trust store is
# named explicitly rather than fetching over an unverified connection.
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())


def nodes_by_level():
    """levelId (lowercased) -> {'level', 'normal', 'emergency'}.

    A level carries up to two roguelike stage ids: the normal form and, for 243
    of the 453, an Emergency Ops one over the same level file. Replacer levels
    are named in some node's levelReplaceIds and resolve to that node, so they
    inherit both forms and the node's own level -- which is where their name
    comes from.
    """
    table = json.load(open(CN_TABLE))
    stages = [
        stage
        for topic in (table.get('details') or {}).values()
        for stage in (topic.get('stages') or {}).values()
    ]
    out = {}
    for stage in stages:
        level = (stage.get('levelId') or '').lower()
        if not level:
            continue
        node = out.setdefault(level, {'level': level, 'normal': None, 'emergency': None})
        node['emergency' if stage.get('isElite') else 'normal'] = stage.get('id')
    for stage in stages:
        node = out.get((stage.get('levelId') or '').lower())
        if not node:
            continue
        for replacer in stage.get('levelReplaceIds') or []:
            out.setdefault(str(replacer).lower(), node)
    return out


def elite_conditions():
    """roguelike stage id -> the Emergency Ops condition, in English."""
    table = json.load(open(EN_TABLE))
    return {
        sid: (stage.get('eliteDesc') or '').strip()
        for topic in (table.get('details') or {}).values()
        for sid, stage in (topic.get('stages') or {}).items()
        if stage.get('isElite') and (stage.get('eliteDesc') or '').strip()
    }


def fetch(rogue_id):
    """The render as the source serves it, checked to decode, or an error string when the
    source has none. The publisher encodes it, as stages-images/ takes it."""
    try:
        with urllib.request.urlopen(f'{RAW}/{rogue_id}.png', timeout=60, context=SSL_CONTEXT) as resp:
            raw = resp.read()
        Image.open(BytesIO(raw)).load()
    except Exception as err:
        return None, f'{rogue_id}: {err}'
    return raw, None


def main():
    by_level = nodes_by_level()
    conditions = elite_conditions()

    # Our own IS stages, so a replacer can borrow the name of the stage whose
    # level its node actually is.
    stages = {}
    for name in sorted(os.listdir(stages_dir)):
        if not name.endswith('.json'):
            continue
        rec = json.load(open(os.path.join(stages_dir, name)))
        if rec.get('stage_type') != 'integrated_strategies':
            continue
        stages[rec['slug']] = {'level': (rec.get('id') or '').lower(), 'name': (rec.get('name') or '').strip()}
    name_of_level = {s['level']: s['name'] for s in stages.values() if s['name']}

    wanted = set()
    plan = {}
    for slug, rec in stages.items():
        node = by_level.get(rec['level'])
        if not node or not node['normal']:
            continue
        entry = {'render': f"{node['normal']}.webp"}
        wanted.add(node['normal'])
        emergency = node['emergency']
        if emergency:
            entry['emergency'] = {'render': f'{emergency}.webp', 'condition': conditions.get(emergency) or ''}
            wanted.add(emergency)
        if not rec['name']:
            borrowed = name_of_level.get(node['level'])
            if borrowed:
                entry['name'] = borrowed
        plan[slug] = entry

    available = {rogue for rogue in wanted if f'stages-images/{rogue}.webp' in published_assets()}
    needed = sorted(wanted - available)
    print(f'{len(plan)} IS stages resolve to {len(needed)} unpublished renders (normal and Emergency Ops); fetching')
    written, problems, staged = set(available), [], []
    staging = Staging('is-nodes', root)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for rogue, (data, err) in zip(needed, pool.map(fetch, needed)):
            if err:
                problems.append(err)
                continue
            staging.stage(f'stages-images/{rogue}.webp', data, source=f'{RAW}/{rogue}.png')
            staged.append(rogue)
    staging.commit()

    # A form whose render is not published is dropped rather than pointing at a file
    # readers cannot load.
    for slug, entry in list(plan.items()):
        if entry['render'][:-5] not in written:
            del plan[slug]
            continue
        emergency = entry.get('emergency')
        if emergency and emergency['render'][:-5] not in written:
            del entry['emergency']

    with open(os.path.join(root, 'data', 'is-nodes.json'), 'w') as fh:
        json.dump(plan, fh, separators=(',', ':'), sort_keys=True)
    print(f'{len(written)} renders published; {len(staged)} new one(s) staged in .cache/is-nodes/ for arkpedia-image-assets')
    print(f'{len(plan)} stages have a render; '
          f'{sum(1 for e in plan.values() if e.get("emergency"))} also have an Emergency Ops form; '
          f'{sum(1 for e in plan.values() if e.get("name"))} borrow their name')
    if problems:
        print(f'{len(problems)} could not be fetched: ' + '; '.join(problems[:4]))
    report('is-nodes', [{'key': f'is-render:{rogue}', 'action': 'published-partial', 'sourceRef': f'{RAW}/{rogue}.png',
                         'reason': f'The Integrated Strategies render {rogue} is staged as .cache/is-nodes/{rogue}.png, but no run has '
                                   f'published it to arkpedia-image-assets as stages-images/{rogue}.webp yet; its stage form is '
                                   'published without it until one does.'} for rogue in staged])


if __name__ == '__main__':
    sys.exit(main())
