"""Offline checks of import-namecard-styles.py: the client's LZ4 variant decodes to what plain
LZ4 encoded, and a Unity colour is written as the page reads it.

Run with python3 scripts/imports/test-namecard-styles.py (needs lz4).
"""
import importlib.util
import sys
import unittest
from pathlib import Path

import lz4.block

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('styles', Path(__file__).with_name('import-namecard-styles.py'))
styles = importlib.util.module_from_spec(spec)
spec.loader.exec_module(styles)


def to_lz4ak(block: bytes) -> bytes:
    """Plain LZ4 as the client stores it: token nibbles swapped, match offsets big-endian."""
    out, pos = bytearray(block), 0
    while pos < len(out):
        token = out[pos]
        literal, match = token >> 4, token & 0x0F
        out[pos] = (match << 4) | literal
        pos += 1
        if literal == 0x0F:
            while True:
                extra = out[pos]; pos += 1; literal += extra
                if extra != 0xFF: break
        pos += literal
        if pos >= len(out): break
        out[pos], out[pos + 1] = out[pos + 1], out[pos]
        pos += 2
        if match == 0x0F:
            while True:
                extra = out[pos]; pos += 1
                if extra != 0xFF: break
    return bytes(out)


class NamecardStyleTests(unittest.TestCase):
    def test_the_clients_lz4_decodes_to_the_original(self):
        # Long literal runs and long matches both, so the extended lengths are exercised.
        data = (bytes(range(256)) * 3 + b'skin_style' * 400 + bytes(range(255, -1, -1)) * 2) * 2
        block = lz4.block.compress(data, store_size=False)
        self.assertEqual(styles.decompress_lz4ak(to_lz4ak(block), len(data)), data)

    def test_a_unity_colour_is_hex_with_alpha_only_when_translucent(self):
        self.assertEqual(styles.colour({'r': 0.0, 'g': 0.5960784554481506, 'b': 0.8627451062202454, 'a': 1.0}), '#0098dc')
        self.assertEqual(styles.colour({'r': 0.1, 'g': 0.1, 'b': 0.1, 'a': 0.85}), '#1a1a1ad9')


if __name__ == '__main__':
    unittest.main()
