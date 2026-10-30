#!/usr/bin/env python3
"""Read Global medal set arrangements and native sprite sizes from Yostar's client.

The EN medal table contains membership but not layout. ui/medal/[uc]groupframe.ab
holds each set's _medalPosList and canvas size; spritepack/ui_medal_icons_*.ab
holds each icon's native crop size and offset. Reuse the profile theme importer's
CDN decoder, cache each bundle by md5, and retain yesterday's data on failure.
Artwork itself is published by arkpedia-image-assets/scripts/sync_profile_art.py.
"""
import importlib.util
import io
import json
import math
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'data/medal-set-layouts.json'
spec = importlib.util.spec_from_file_location('namecard_styles', Path(__file__).with_name('import-namecard-styles.py'))
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


def read_bundle(raw):
    import UnityPy
    from UnityPy.enums.BundleFile import CompressionFlags
    from UnityPy.helpers import CompressionHelper
    CompressionHelper.DECOMPRESSION_MAP[CompressionFlags.LZHAM] = client.decompress_lz4ak
    archive = zipfile.ZipFile(io.BytesIO(raw))
    env = UnityPy.load(archive.read(archive.namelist()[0]))
    rows = []
    for obj in env.objects:
        if obj.type.name in ('GameObject', 'RectTransform', 'MonoBehaviour', 'Sprite'):
            rows.append({'id': obj.path_id, 'type': obj.type.name, 'data': obj.read_typetree()})
    return rows


def extract_layouts(rows):
    objects = {row['id']: row for row in rows}
    layouts = {}
    for row in rows:
        data = row['data']
        if '_groupId' not in data or '_medalPosList' not in data:
            continue
        game_object = objects[data['m_GameObject']['m_PathID']]['data']
        rect = next(objects[c['component']['m_PathID']]['data'] for c in game_object['m_Component']
                    if objects[c['component']['m_PathID']]['type'] == 'RectTransform')
        width, height = rect['m_SizeDelta']['x'], rect['m_SizeDelta']['y']
        positions = [{'id': item['medalId'], 'x': round(item['pos']['x'], 3), 'y': round(item['pos']['y'], 3)} for item in data['_medalPosList']]
        if not width > 0 or not height > 0 or not positions or len({p['id'] for p in positions}) != len(positions) or any(not math.isfinite(p[k]) or not 0 <= p[k] <= (width if k == 'x' else height) for p in positions for k in ('x', 'y')):
            raise ValueError(f"Invalid medal layout: {data['_groupId']}")
        layouts[data['_groupId']] = {'width': width, 'height': round(height, 3), 'positions': positions}
    if not layouts:
        raise ValueError('No medal set layouts in the client bundle')
    return layouts


def extract_sizes(rows):
    sizes = {}
    for row in rows:
        data = row['data']
        if row['type'] != 'Sprite' or not re.fullmatch(r'medal_[\w-]+', data['m_Name']):
            continue
        crop, offset, rect, pivot = data['m_RD']['textureRect'], data['m_RD']['textureRectOffset'], data['m_Rect'], data['m_Pivot']
        if any(not math.isfinite(value) for fields in (crop, offset, rect, pivot) for value in fields.values()) or not 0 < crop['width'] <= 1000 or not 0 < crop['height'] <= 1000:
            raise ValueError(f"Invalid medal sprite dimensions: {data['m_Name']}")
        sizes[data['m_Name']] = {'width': round(crop['width'], 3), 'height': round(crop['height'], 3),
            'x': round(offset['x'] + crop['width'] / 2 - rect['width'] * pivot['x'], 3),
            'y': round(offset['y'] + crop['height'] / 2 - rect['height'] * pivot['y'], 3)}
    if not sizes:
        raise ValueError('No medal sprites in the client bundle')
    return sizes


def main():
    previous = json.loads(OUTPUT.read_text()) if OUTPUT.exists() else {}
    version = json.loads(client.get(f'{client.CDN}/version'))['resVersion']
    listing = json.loads(client.get(f'{client.CDN}/assets/{version}/hot_update_list.json'))['abInfos']
    bundles = dict(previous.get('bundles', {}))
    wanted = [info for info in listing if info['name'] == 'ui/medal/[uc]groupframe.ab' or re.fullmatch(r'spritepack/ui_medal_icons_\d+\.ab', info['name'])]
    if not wanted or not any(info['name'] == 'ui/medal/[uc]groupframe.ab' for info in wanted):
        raise ValueError('Global client no longer lists the medal set bundle')
    fetched = 0
    for info in wanted:
        if bundles.get(info['name'], {}).get('md5') == info['md5']:
            continue
        url = f'{client.CDN}/assets/{version}/' + info['name'].replace('/', '_').replace('.ab', '.dat').replace('[', '%5B').replace(']', '%5D')
        rows = read_bundle(client.get(url))
        field, values = ('layouts', extract_layouts(rows)) if info['name'].startswith('ui/') else ('sizes', extract_sizes(rows))
        bundles[info['name']] = {'md5': info['md5'], field: values}
        fetched += 1
        print(f"Read {info['name']}: {len(values)} {field}", flush=True)
    # Do not keep a removed pack's stale geometry. Background pins are seeded by the asset
    # publication and kept until the normal published asset index includes them.
    bundles = {info['name']: bundles[info['name']] for info in wanted}
    result = {'resVersion': version, 'bundles': bundles, 'backgrounds': previous.get('backgrounds', {})}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, separators=(',', ':')) + '\n')
    temporary.replace(OUTPUT)
    print(f'Medal geometry: {len(bundles)} bundles, {fetched} changed.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(f'Medal layout import failed; previous data retained: {error}', file=sys.stderr)
        sys.exit(1)
