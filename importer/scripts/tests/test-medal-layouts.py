import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('medal_layouts', Path(__file__).resolve().parents[1] / 'imports/import-medal-layouts.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class MedalLayoutTests(unittest.TestCase):
    def test_prefab_positions_keep_the_client_canvas_and_bottom_left_origin(self):
        rows = [
            {'id': 1, 'type': 'MonoBehaviour', 'data': {'_groupId': 'set', '_medalPosList': [{'medalId': 'medal_a', 'pos': {'x': 914.3, 'y': 223.3}}], 'm_GameObject': {'m_PathID': 2}}},
            {'id': 2, 'type': 'GameObject', 'data': {'m_Component': [{'component': {'m_PathID': 3}}]}},
            {'id': 3, 'type': 'RectTransform', 'data': {'m_SizeDelta': {'x': 1374, 'y': 459.092987}}},
        ]
        self.assertEqual(importer.extract_layouts(rows), {'set': {'width': 1374, 'height': 459.093, 'positions': [{'id': 'medal_a', 'x': 914.3, 'y': 223.3}]}})
        rows[0]['data']['_medalPosList'][0]['pos']['x'] = float('nan')
        with self.assertRaisesRegex(ValueError, 'Invalid medal layout'):
            importer.extract_layouts(rows)
        with self.assertRaisesRegex(ValueError, 'No medal set layouts'):
            importer.extract_layouts([])

    def test_native_crop_size_and_pivot_offset_are_preserved(self):
        rows = [{'id': 1, 'type': 'Sprite', 'data': {'m_Name': 'medal_a', 'm_Rect': {'width': 256, 'height': 256}, 'm_Pivot': {'x': .5, 'y': .5},
            'm_RD': {'textureRect': {'width': 216.848, 'height': 248.947}, 'textureRectOffset': {'x': 19.076, 'y': 4.0265}}}}]
        self.assertEqual(importer.extract_sizes(rows), {'medal_a': {'width': 216.848, 'height': 248.947, 'x': -.5, 'y': .5}})
        with self.assertRaisesRegex(ValueError, 'No medal sprites'):
            importer.extract_sizes([])


if __name__ == '__main__':
    unittest.main()
