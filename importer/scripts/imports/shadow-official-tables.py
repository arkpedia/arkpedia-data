#!/usr/bin/env python3
"""The game tables decoded from the official servers ourselves, compared with the mirrors' copies.

Shadow mode: this publishes nothing and no stage reads its output. Every table the site uses
comes from a mirror today -- Kengxxiao (or yuanyan3060) for CN, ArknightsAssets for Global, JP
and KR -- which decodes the client's encrypted tables each patch. This decodes the same tables from the
official servers with arkprts (https://github.com/thesadru/ArkPRTS, pinned in
scripts/content/requirements.txt; GPL-3.0, run as a tool, not shipped), which reads them through
the table schemas of https://github.com/MooncellWiki/OpenArknightsFBS and
https://github.com/ArknightsAssets/ArknightsFlatbuffers with flatc
(https://github.com/google/flatbuffers, pinned in prepare-content.yml), and compares each with the copy
this run read, by content (table_canon.py). The owner decided this on 2026-10-19: decoding the
tables is against the publisher's terms on paper, as it is for every mirror and most fan sites,
and if Yostar or Hypergryph ever object, the site goes back to the mirrors alone.

What a clean shadow buys: when a mirror stalls or disappears, the site can switch to its own
decode (a later change, not this one) knowing the two have agreed patch after patch.

A region is compared only when the mirror carries the live client version
(data/client-versions.json, written by the client-versions stage). On a patch day the mirror
is hours behind, and the difference would be the patch, not the decode.

Kept in data/official-tables-shadow.json, with no times in it so a quiet night writes the same
bytes: per region, the version compared, the mirror and how many tables matched, and for each
table that did not, the first place it parts. Reported to the quarantine as stage
official-tables: a region whose decode failed, or whose tables differ (the site keeps the
mirror's either way).

Run: python3 scripts/imports/shadow-official-tables.py
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def _module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


table_canon = _module('table_canon', 'table_canon.py')
quarantine = _module('quarantine', 'quarantine.py')

STATE = ROOT / 'data' / 'official-tables-shadow.json'
CLIENT_VERSIONS = ROOT / 'data' / 'client-versions.json'
CACHE = ROOT / '.cache' / 'official-tables'
REGIONS = ('cn', 'en', 'jp', 'kr')
# The tables this run read, where its stages checked them out (cn-tables.mjs, upstream.sh). No
# stage reads the JP and KR tables from a checkout, so this one checks them out itself, from the
# same repository and pinned commit as the EN tables (fetch_regional_mirror).
REGIONAL = ROOT / '.cache' / 'upstream' / 'regional-gamedata'
MIRROR_TABLES = {
    'cn': ROOT / '.cache' / 'upstream' / 'cn-resource' / 'gamedata' / 'excel',
    'en': ROOT / '.cache' / 'upstream' / 'en-gamedata' / 'en' / 'gamedata' / 'excel',
    'jp': REGIONAL / 'jp' / 'gamedata' / 'excel',
    'kr': REGIONAL / 'kr' / 'gamedata' / 'excel',
}
# Per region; the stage allows 30 minutes for all four. Measured 2026-10-19: about a minute each.
DECODE_TIMEOUT_S = 6 * 60
FETCH_TIMEOUT_S = 5 * 60


def mirror_name(region):
    lock = ROOT / 'data' / 'upstream.lock.json'
    if region == 'cn':
        try:
            return json.loads(lock.read_text()).get('cnTables', {}).get('repository') or 'the CN tables mirror'
        except Exception:
            return 'the CN tables mirror'
    return 'ArknightsAssets/ArknightsGamedata'


def live_and_mirror(region):
    """(live resVersion, whether the mirror carries it), from the client-versions stage."""
    try:
        entry = json.loads(CLIENT_VERSIONS.read_text())['regions'][region]
    except Exception:
        return None, None
    mirror = (entry.get('mirror') or {}).get('resVersion')
    return entry.get('resVersion'), (mirror == entry.get('resVersion') if mirror else None)


def fetch_regional_mirror(regions):
    """Check out the JP and KR tables of the regions to compare, at the commit this run pinned
    (scripts/lib/upstream.sh reads it from ARKPEDIA_PIN_). If that fails the checkout is removed,
    so an older one is never compared with tonight's decode: the regions are reported as having
    no mirror tables instead."""
    paths = [f'{region}/gamedata/excel' for region in regions if region in ('jp', 'kr') and live_and_mirror(region)[1] is not False]
    if not paths:
        return
    try:
        subprocess.run(['bash', 'scripts/lib/upstream.sh', REGIONAL.name, 'https://github.com/ArknightsAssets/ArknightsGamedata.git',
                        'default', *paths], check=True, cwd=str(ROOT), timeout=FETCH_TIMEOUT_S)
    except Exception as error:
        print(f'the JP/KR mirror tables could not be checked out: {error}', file=sys.stderr)
        shutil.rmtree(REGIONAL, ignore_errors=True)


def decode(region, out_dir):
    """Decode the region's tables from the official servers into out_dir/<region>/gamedata/excel."""
    if not shutil.which('flatc'):
        raise RuntimeError('no flatc on PATH')
    env = {**os.environ, 'XDG_DATA_HOME': str(CACHE / 'arkprts-data')}
    # CRITICAL: arkprts logs a traceback for every non-table bundle it cannot decrypt (dozens a
    # region, harmless). A table that fails to decode still shows, as missing from the decode.
    subprocess.run([sys.executable, '-m', 'arkprts.assets', str(out_dir), '--server', region, '--log-level', 'CRITICAL'],
                   check=True, env=env, timeout=DECODE_TIMEOUT_S, cwd=str(CACHE))
    excel = out_dir / region / 'gamedata' / 'excel'
    if not excel.is_dir() or not any(excel.glob('*.json')):
        raise RuntimeError('the decode wrote no tables')
    return excel


def compare_dirs(official, mirror):
    """{table: first difference or None} for every table the mirror has; a table the official
    decode lacks is a difference of its own."""
    out = {}
    for path in sorted(mirror.glob('*.json')):
        theirs = official / path.name
        if not theirs.exists():
            out[path.name] = 'missing from the official decode'
            continue
        try:
            out[path.name] = table_canon.compare_tables(json.loads(theirs.read_text(encoding='utf-8')),
                                                        json.loads(path.read_text(encoding='utf-8')))
        except Exception as error:  # a table one side cannot parse is that table's difference
            out[path.name] = f'unreadable: {type(error).__name__}'
    return out


def run(regions=REGIONS, decoder=decode):
    previous = json.loads(STATE.read_text()) if STATE.exists() else {}
    state = {'version': 1, 'regions': dict(previous.get('regions', {}))}
    entries = []
    for region in regions:
        live, mirror_current = live_and_mirror(region)
        mirror_dir = MIRROR_TABLES[region]
        name = mirror_name(region)
        if mirror_current is False:
            print(f'{region}: {name} is behind the live client ({live}); compared on a later run.')
            continue
        if not mirror_dir.is_dir():
            entries.append({'key': f'official-tables:{region}', 'action': 'kept-previous',
                            'reason': f'This run has no {region} mirror tables to compare the official decode with; the last comparison stands.'})
            continue
        try:
            official = decoder(region, CACHE / 'decoded')
        except Exception as error:
            print(f'{region}: the official decode failed: {error}', file=sys.stderr)
            entries.append({'key': f'official-tables:{region}', 'action': 'kept-previous',
                            'reason': f'The {region} tables could not be decoded from the official servers; the site reads {name} as always.'})
            continue
        result = compare_dirs(official, mirror_dir)
        differs = {table: why for table, why in result.items() if why}
        state['regions'][region] = {
            'resVersion': live,
            'mirror': name,
            'tables': len(result),
            'identical': len(result) - len(differs),
            **({'differs': dict(sorted(differs.items()))} if differs else {}),
        }
        if differs:
            sample = ', '.join(sorted(differs)[:4])
            entries.append({'key': f'official-tables:{region}:differs', 'action': 'kept-previous',
                            'reason': f'{len(differs)} of {len(result)} {region} tables differ between our decode of the official client and {name} (for example {sample}); the site keeps the mirror\'s.'})
    state['regions'] = dict(sorted(state['regions'].items()))
    text = json.dumps(state, indent=1, ensure_ascii=False) + '\n'
    if not STATE.exists() or STATE.read_text() != text:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(text)
    return state, entries


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    fetch_regional_mirror(REGIONS)
    state, entries = run()
    quarantine.report('official-tables', entries)
    for region, row in state['regions'].items():
        print(f"Official tables ({region}, shadow): {row['identical']} of {row['tables']} match {row['mirror']}.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
