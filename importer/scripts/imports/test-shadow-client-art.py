"""Offline checks of shadow-client-art.py: what is downloaded, what is compared again, and what
is reported, with a fake client and a fake mirror.

Run with python3 scripts/imports/test-shadow-client-art.py (needs Pillow).
"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('shadow', Path(__file__).with_name('shadow-client-art.py'))
shadow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shadow)


def picture(value):
    return Image.new('RGBA', (4, 4), (value, value, value, 255))


class FakeClient:
    """A client whose bundles are lists of (sprite, image), named in `packs`."""

    def __init__(self, packs, md5s):
        self.version = 'v1'
        self.packs, self.md5s, self.downloads = packs, md5s, []

    def files(self):
        return dict(self.md5s)

    def bundle(self, name):
        self.downloads.append(name)
        return name


def source_map(blobs):
    return {'files': {f'icons/{path}.webp': {'sourcePath': path, 'sourceBlob': blob} for path, blob in blobs.items()}}


class ShadowTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        (root / 'data' / 'operators-6star').mkdir(parents=True)
        shadow.ROOT, shadow.STATE = root, root / 'data' / 'client-art-shadow.json'
        self.packs = {
            'spritepack/ui_char_avatar_0.ab': [('char_002_amiya', picture(10)), ('char_003_kalts', picture(20))],
            'spritepack/skill_icons_0.ab': [('skill_icon_skchr_amiya_1', picture(30))],
        }
        self.md5s = {name: 'a' for name in self.packs}
        self.mirror = {'avatar/char_002_amiya.png': picture(10), 'avatar/char_003_kalts.png': picture(99),
                       'skill/skill_icon_skchr_amiya_1.png': picture(30), 'avatar/char_999_dyn.png': picture(1)}
        self.mirror_reads = []
        self.unreadable = set()
        shadow.client_bundles.sprites = lambda bundle: iter(self.packs[bundle])

    def tearDown(self):
        self.dir.cleanup()

    def run_once(self, blobs=None, published=frozenset({'x'})):
        client = FakeClient(self.packs, self.md5s)

        def mirror(path):
            self.mirror_reads.append(path)
            return None if path in self.unreadable else shadow.client_bundles.pixel_hash(self.mirror[path])
        blobs = blobs or {path: 'b' * 40 for path in self.mirror}
        result = shadow.run(client=client, source_map=source_map(blobs), published=set(published), mirror=mirror, workers=1)
        return result, client

    def test_every_file_is_compared_once_and_a_quiet_night_downloads_nothing(self):
        (entries, summary, downloaded, compared), client = self.run_once()
        self.assertEqual(downloaded, 2)
        self.assertEqual(summary['avatar'], {'same': 1, 'differs': 1, 'no-official': 1, 'pending': 0})
        self.assertEqual(summary['skill'], {'same': 1, 'differs': 0, 'no-official': 0, 'pending': 0})
        self.assertEqual([e['key'] for e in entries], ['client-art:avatar'])
        self.assertIn('char_003_kalts', entries[0]['reason'])
        before = shadow.STATE.read_text()
        self.mirror_reads.clear()
        (entries, summary, downloaded, compared), client = self.run_once()
        self.assertEqual((downloaded, compared, client.downloads, self.mirror_reads), (0, 0, [], []))
        self.assertEqual(shadow.STATE.read_text(), before, 'the same bytes on a quiet night')

    def test_a_changed_bundle_is_read_alone_and_its_changed_sprite_compared_again(self):
        self.run_once()
        self.mirror_reads.clear()
        self.md5s['spritepack/skill_icons_0.ab'] = 'changed'
        self.packs['spritepack/skill_icons_0.ab'] = [('skill_icon_skchr_amiya_1', picture(31))]
        (entries, summary, downloaded, compared), client = self.run_once()
        self.assertEqual(client.downloads, ['spritepack/skill_icons_0.ab'])
        self.assertEqual(self.mirror_reads, ['skill/skill_icon_skchr_amiya_1.png'])
        self.assertEqual(summary['skill']['differs'], 1)

    def test_a_mirror_file_that_changed_is_compared_again_without_a_download(self):
        self.run_once()
        self.mirror_reads.clear()
        self.mirror['avatar/char_003_kalts.png'] = picture(20)
        blobs = {path: 'b' * 40 for path in self.mirror}
        blobs['avatar/char_003_kalts.png'] = 'c' * 40
        (entries, summary, downloaded, compared), client = self.run_once(blobs)
        self.assertEqual((client.downloads, self.mirror_reads), ([], ['avatar/char_003_kalts.png']))
        self.assertEqual(summary['avatar']['differs'], 0)
        self.assertEqual(entries, [])

    def test_a_new_file_reads_every_bundle_of_its_kind_once(self):
        self.run_once()
        self.packs['spritepack/ui_char_avatar_0.ab'].append(('char_004_new', picture(5)))
        self.mirror['avatar/char_004_new.png'] = picture(5)
        (entries, summary, downloaded, compared), client = self.run_once()
        self.assertEqual(client.downloads, ['spritepack/ui_char_avatar_0.ab'])
        self.assertEqual(summary['avatar']['same'], 2)

    def test_an_operator_whose_avatar_the_client_ships_without_a_published_icon_is_reported(self):
        for name, op_id, rarity in [('Amiya', 'char_002_amiya', 5), ("Kal'tsit", 'char_003_kalts', 6)]:
            folder = shadow.ROOT / 'data' / f'operators-{rarity}star'
            folder.mkdir(exist_ok=True)
            (folder / f'{name}.json').write_text(json.dumps({'name': name, 'rarity': rarity, 'internalName': op_id}))
        (entries, *_), _ = self.run_once(published={'five-star-icons/Amiya - Base.webp'})
        icons = [e for e in entries if e['key'].startswith('client-art:icon:')]
        self.assertEqual([(e['key'], e['action'], e['overdueAfterDays']) for e in icons], [('client-art:icon:char_003_kalts', 'published-partial', 3)])
        self.assertIn("six-star-icons/Kal'tsit - Base.webp", icons[0]['reason'])

    def test_a_mirror_file_that_could_not_be_read_is_asked_for_again_without_reading_a_bundle(self):
        self.unreadable = {'skill/skill_icon_skchr_amiya_1.png'}
        (entries, summary, downloaded, compared), client = self.run_once()
        self.assertEqual(summary['skill']['pending'], 1)
        self.unreadable, self.mirror_reads = set(), []
        (entries, summary, downloaded, compared), client = self.run_once()
        self.assertEqual((client.downloads, self.mirror_reads), ([], ['skill/skill_icon_skchr_amiya_1.png']))
        self.assertEqual(summary['skill'], {'same': 1, 'differs': 0, 'no-official': 0, 'pending': 0})

    def test_file_names_follow_the_catalogue(self):
        self.assertEqual(shadow.safe_name('W: "Who?" <1>'), 'W Who 1')
        catalogue = (Path(__file__).resolve().parents[1] / 'sync' / 'catalogue-model.mjs').read_text()
        self.assertIn(r"""export const safeName = name => name.replace(/[\\/*?:"<>|]/g, '').trim();""", catalogue,
                      'safe_name copies catalogue-model.mjs safeName; change both together')


if __name__ == '__main__':
    unittest.main()
