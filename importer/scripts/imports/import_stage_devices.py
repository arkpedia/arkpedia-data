#!/usr/bin/env python3
"""Writes data/stage-devices.json: the units a stage starts with on the field.

The map diagrams were missing them -- Twilight of Wolumonde's Gramophone towers,
the stun pillars you activate, freezing towers, the crates and barricades of
Reclamation Algorithm. None of it is in the geometry this site was built from,
because the pipeline reads a level's DEPLOYABLE cards (suppliedUnits) and not its
`predefines`, which is where the already-placed ones live:

    "tokenInsts": [{ "position": {"row": 5, "col": 2},
                     "inst": {"characterKey": "trap_014_tower"} }, ...]

Two kinds are collected: tokenInsts (devices) and characterInsts (operators the
stage supplies, placed for you). Names and descriptions come from
character_table.json, where a trap is a character with profession TRAP --
"trap_014_tower" is L-44 'Gramophone', "Attacks the enemy with the highest Max HP
first". English names come from the EN dump, so a device the CN dump has and EN
does not is skipped rather than printed in Chinese.

Keyed by geometry key, not by stage: a level file is one map, and every stage
sharing that map shares its predefines.

Resolving a stage to its level file needs stage_table's `levelId` -- a stage id is
not a path, and 419 of the 3,796 stages name a level file neither dump carries.
Those simply get no devices.

Run:  python3 scripts/imports/import_stage_devices.py
"""
import glob
import json
import os
import re
import sys
from collections import Counter

CN = os.environ.get('ARKPEDIA_CN', '.cache/upstream/cn-resource') + '/gamedata'
EN = os.environ.get('ARKPEDIA_EN', '.cache/upstream/en-gamedata/en') + '/gamedata'

root = os.getcwd()


def level_paths():
    """levelId (lowercased, no extension) -> file path, CN first then EN."""
    out = {}
    for base in (f'{CN}/levels', f'{EN}/levels'):
        if not os.path.isdir(base):
            continue
        for path in glob.glob(f'{base}/**/*.json', recursive=True):
            key = path[len(base) + 1:-5].lower()
            out.setdefault(key, path)
            # A stage id often names only the file, not the folders above it.
            out.setdefault(os.path.basename(path)[:-5].lower(), path)
    return out


def level_of_stage():
    """stage id -> levelId, from either stage_table."""
    out = {}
    for table in (f'{CN}/excel/stage_table.json', f'{EN}/excel/stage_table.json'):
        if not os.path.exists(table):
            continue
        for stage_id, stage in json.load(open(table))['stages'].items():
            if stage.get('levelId'):
                out.setdefault(stage_id, stage['levelId'])
    return out


# The game's own rich-text tags, and only those: a device description reads
# "<@ba.kw>Cannot</> be healed by allies", and the page prints whatever is here
# verbatim. A blanket <[^>]*> strip is wrong for this game -- names like
# <Roadblock> are literal display text -- so this matches the tag families the
# client uses, the same way the stage pipeline's own strippers do.
_MARKUP = re.compile(r'</?[@$][^<>]*>|</>|</?i>')


def plain(value):
    """A display string with the game's markup taken out, or None."""
    if not value:
        return None
    out = re.sub(r'\s+', ' ', _MARKUP.sub('', value)).strip()
    return out or None


def unit_names():
    """characterKey -> {name, description}, in English."""
    table = json.load(open(f'{EN}/excel/character_table.json'))
    out = {}
    for key, char in table.items():
        name = (char.get('name') or '').strip()
        if not name:
            continue
        out[key] = {
            'name': name,
            'description': plain(char.get('description')),
            'trap': char.get('profession') == 'TRAP',
        }
    return out


def main():
    paths = level_paths()
    levels = level_of_stage()
    names = unit_names()
    index = json.load(open(os.path.join(root, 'public', 'stages-index.json')))

    devices = {}
    stats = Counter()
    unnamed = Counter()
    for row in index:
        record = json.load(open(os.path.join(root, 'data', 'stages', f"{row['slug']}.json")))
        key = record.get('geometryKey')
        if not key or key in devices:
            continue
        stage_id = record.get('id') or ''
        level_id = (levels.get(stage_id) or stage_id).lower()
        path = paths.get(level_id) or paths.get(os.path.basename(level_id))
        if not path:
            stats['no level file'] += 1
            continue
        try:
            level = json.load(open(path))
        except Exception:
            stats['level file unreadable'] += 1
            continue
        predefines = level.get('predefines') or {}
        found = []
        for kind, field in (('device', 'tokenInsts'), ('operator', 'characterInsts')):
            for inst in predefines.get(field) or []:
                position = inst.get('position') or {}
                unit_key = (inst.get('inst') or {}).get('characterKey')
                named = names.get(unit_key)
                if not named:
                    unnamed[unit_key] += 1
                    continue
                if position.get('row') is None or position.get('col') is None:
                    stats['no position'] += 1
                    continue
                found.append({
                    'kind': kind,
                    'key': unit_key,
                    'name': named['name'],
                    'description': named['description'],
                    'row': position['row'],
                    'col': position['col'],
                    'hidden': bool(inst.get('hidden')),
                })
        if found:
            devices[key] = found
            stats['maps with units'] += 1
        else:
            stats['maps with none'] += 1

    with open(os.path.join(root, 'data', 'stage-devices.json'), 'w') as fh:
        json.dump(devices, fh, separators=(',', ':'), ensure_ascii=False, sort_keys=True)

    total = sum(len(v) for v in devices.values())
    print(f'{len(devices)} maps carry {total} pre-placed units')
    for label, n in stats.most_common():
        print(f'  {label:24} {n}')
    if unnamed:
        print(f'  {sum(unnamed.values())} instances of {len(unnamed)} keys the EN dump does not name, skipped '
              f'(e.g. {", ".join(k for k, _ in unnamed.most_common(3) if k)})')


if __name__ == '__main__':
    sys.exit(main())
