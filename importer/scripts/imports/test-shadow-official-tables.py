"""Offline checks of the official-tables shadow: the canonical comparison's rules, and what
the stage compares, skips and reports, with a fake decoder.

Run with python3 scripts/imports/test-shadow-official-tables.py (bson is only needed for the
BSON case, which skips without it).
"""
import base64
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


canon = load('table_canon', 'table_canon.py')
shadow = load('shadow', 'shadow-official-tables.py')


class CanonTest(unittest.TestCase):
    def same(self, official, mirror):
        self.assertIsNone(canon.compare_tables(official, mirror))

    def test_the_forms_the_two_decoders_write_differently_compare_equal(self):
        self.same({'id': 'a'}, {'id': 'a', 'trait': None})
        self.same({'bb': {'atk': 30.0}}, {'bb': [{'key': 'atk', 'value': 30, 'valueStr': None}]})
        self.same({'exp': [{'values': [1, 2]}]}, {'exp': [[1, 2]]})
        self.same({'rewards': {}}, {'rewards': []})
        self.same({'master_6': {'candidates': [1]}}, {'candidates': [1]})
        self.same({'candidates': [1]}, {'charm': {'candidates': [1]}})

    def test_embedded_bson_is_read_before_it_is_compared(self):
        try:
            import bson
        except ImportError:
            self.skipTest('no bson')
        blob = base64.b64encode(bson.encode({'freeCount': 0, 'limitedCharId': 'char_113_cqbw'})).decode()
        self.same({'limitParam': {'base64': blob}}, {'limitParam': {'freeCount': 0, 'limitedCharId': 'char_113_cqbw'}})

    def test_a_real_difference_is_named_by_its_path(self):
        self.assertEqual(canon.compare_tables({'char_002': {'atk': 30}}, {'char_002': {'atk': 31}}), ".char_002.atk: '30' vs '31'")
        self.assertEqual(canon.compare_tables({'a': [1, 2]}, {'a': [1]}), '.a: 2 items vs 1')
        self.assertEqual(canon.compare_tables({}, {'x': 1}), '.x: only in the mirror')


class StageTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.mirror = {region: root / 'mirror' / region for region in shadow.REGIONS}
        for path in self.mirror.values():
            path.mkdir(parents=True)
        shadow.STATE = root / 'data' / 'official-tables-shadow.json'
        shadow.CLIENT_VERSIONS = root / 'data' / 'client-versions.json'
        shadow.CACHE = root / 'cache'
        shadow.MIRROR_TABLES = self.mirror
        shadow.mirror_name = lambda region: f'mirror-{region}'
        self.versions({region: ('v1', 'v1') for region in shadow.REGIONS})
        self.official = {region: {} for region in shadow.REGIONS}
        self.decoded = []

    def tearDown(self):
        self.dir.cleanup()

    def versions(self, regions):
        shadow.CLIENT_VERSIONS.parent.mkdir(parents=True, exist_ok=True)
        shadow.CLIENT_VERSIONS.write_text(json.dumps({'version': 1, 'regions': {
            region: {'resVersion': live, 'mirror': {'repository': 'm', 'resVersion': mirror}} for region, (live, mirror) in regions.items()}}))

    def table(self, region, name, mirror, official):
        (self.mirror[region] / name).write_text(json.dumps(mirror))
        self.official[region][name] = official

    def decoder(self, region, out_dir):
        self.decoded.append(region)
        excel = out_dir / region
        excel.mkdir(parents=True, exist_ok=True)
        for name, data in self.official[region].items():
            (excel / name).write_text(json.dumps(data))
        return excel

    def test_matching_tables_report_nothing_and_a_quiet_night_writes_the_same_bytes(self):
        self.table('cn', 'skill_table.json', {'s': {'bb': [{'key': 'atk', 'value': 1}]}}, {'s': {'bb': {'atk': 1}}})
        self.table('en', 'skill_table.json', {'s': 1}, {'s': 1})
        state, entries = shadow.run(decoder=self.decoder)
        self.assertEqual(entries, [])
        self.assertEqual(state['regions']['cn'], {'resVersion': 'v1', 'mirror': 'mirror-cn', 'tables': 1, 'identical': 1})
        before = shadow.STATE.read_text()
        shadow.run(decoder=self.decoder)
        self.assertEqual(shadow.STATE.read_text(), before)

    def test_a_table_that_differs_or_is_missing_is_reported_and_the_site_keeps_the_mirror(self):
        self.table('cn', 'character_table.json', {'c': {'atk': 1}}, {'c': {'atk': 2}})
        (self.mirror['cn'] / 'gone_table.json').write_text('{}')
        state, entries = shadow.run(regions=('cn',), decoder=self.decoder)
        self.assertEqual(state['regions']['cn']['differs'], {'character_table.json': ".c.atk: '2' vs '1'", 'gone_table.json': 'missing from the official decode'})
        self.assertEqual([(e['key'], e['action']) for e in entries], [('official-tables:cn:differs', 'kept-previous')])

    def test_a_mirror_behind_the_live_client_is_not_compared(self):
        self.versions({'cn': ('v2', 'v1'), 'en': ('v1', 'v1'), 'jp': ('v1', 'v1'), 'kr': ('v3', 'v2')})
        self.table('cn', 'skill_table.json', {'s': 1}, {'s': 2})
        state, entries = shadow.run(decoder=self.decoder)
        self.assertEqual(self.decoded, ['en', 'jp'], 'nothing is downloaded for a region that would only show the patch')
        self.assertEqual(entries, [])

    def test_a_failed_decode_keeps_the_last_comparison(self):
        self.table('en', 'skill_table.json', {'s': 1}, {'s': 1})
        shadow.run(regions=('en',), decoder=self.decoder)

        def broken(region, out_dir):
            raise RuntimeError('flatc exploded')
        state, entries = shadow.run(regions=('en',), decoder=broken)
        self.assertEqual([(e['key'], e['action']) for e in entries], [('official-tables:en', 'kept-previous')])
        self.assertEqual(state['regions']['en']['identical'], 1)

    def test_all_four_regions_are_compared(self):
        for region in shadow.REGIONS:
            self.table(region, 'skill_table.json', {'s': region}, {'s': region})
        state, entries = shadow.run(decoder=self.decoder)
        self.assertEqual(self.decoded, ['cn', 'en', 'jp', 'kr'])
        self.assertEqual({region: row['identical'] for region, row in state['regions'].items()}, {'cn': 1, 'en': 1, 'jp': 1, 'kr': 1})


class RegionalMirrorTest(unittest.TestCase):
    """The JP and KR mirror tables, which the stage checks out itself."""
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.saved = shadow.REGIONAL, shadow.CLIENT_VERSIONS, shadow.subprocess.run
        shadow.REGIONAL = root / 'regional-gamedata'
        shadow.CLIENT_VERSIONS = root / 'client-versions.json'
        shadow.CLIENT_VERSIONS.write_text(json.dumps({'version': 1, 'regions': {
            'jp': {'resVersion': 'v1', 'mirror': {'resVersion': 'v1'}}, 'kr': {'resVersion': 'v2', 'mirror': {'resVersion': 'v1'}}}}))
        self.calls = []

    def tearDown(self):
        shadow.REGIONAL, shadow.CLIENT_VERSIONS, shadow.subprocess.run = self.saved
        self.dir.cleanup()

    def test_only_the_regions_whose_mirror_is_current_are_checked_out(self):
        shadow.subprocess.run = lambda args, **kw: self.calls.append(args)
        shadow.fetch_regional_mirror(shadow.REGIONS)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][-1:], ['jp/gamedata/excel'], 'kr lags its client, cn and en are checked out by other stages')

    def test_a_failed_checkout_leaves_no_older_tables_to_compare(self):
        (shadow.REGIONAL / 'jp' / 'gamedata' / 'excel').mkdir(parents=True)

        def fail(args, **kw):
            raise shadow.subprocess.CalledProcessError(128, args)
        shadow.subprocess.run = fail
        shadow.fetch_regional_mirror(('jp',))
        self.assertFalse(shadow.REGIONAL.exists())


if __name__ == '__main__':
    unittest.main()
