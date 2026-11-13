"""Normalize pinned public CCB snapshots. No account access or network at build time.

Usage: python3 scripts/imports/import-ccb-archive.py --input-dir /tmp
Input files: ccb-raw-{1..4}.json, ccb-seasons.json (optional English map names).
Provenance and the upstream commit are embedded in the resulting archive.
"""
import argparse
import json
import re
from pathlib import Path

COMMIT = '5b879c824b1d2987a3b23def47a2a31945138057'
GROUPS = {'恶敌': 'Hostile Forces', '衰退': 'Deterioration', '缺失': 'Deprivation', '光刃': 'Arclight', '合金': 'Alloy', '钢甲': 'Steel Armor', '重压': 'Pressure', '约束': 'Restrictions', '险地': 'Hazardous Terrain', '应变': 'Adaptation', '枯朽之影': 'Withered Shadow', '沼泽行军': 'Marsh March', '野草': 'Wild Grass', '猖獗': 'Rampage', '要塞': 'Fortress', '溟海之蚀': 'Nethersea Corrosion', '裂礁狂热': 'Reefbreaker', '源石风暴': 'Originium Storm', '魂灵': 'Souls', '招灾': 'Calamity', '尖刀': 'Blade', '金戈寒兵': 'Cold Steel', '过热激光': 'Overheated Laser', '引痕蔓生': 'Spreading Traces'}
NAMES = ['Pyrolysis', 'Underdawn', 'Extinguished Sins', 'Arclight']
# Editorial translations where no English server snapshot is archived. The original
# name remains alongside it; these are not represented as official localizations.
MAPS = {'灰烬泽地': 'Ashen Wetland', '实验基地': 'Experimental Base', '联邦监狱': 'Federal Prison', '滞空焦点': 'Suspended Focus', '熔炉检修口': 'Furnace Maintenance Access', '巫诅骸地': 'Cursed Bonefield'}
AREAS = {'哥伦比亚': 'Columbia', '维多利亚': 'Victoria', '卡兹戴尔': 'Kazdel', '炎': 'Yan', '伊比利亚': 'Iberia', '萨尔贡': 'Sargon', '雷姆必拓': 'Rim Billiton'}

def clean(text):
    return re.sub(r'<@[^>]+>|</>|<color=[^>]+>|</color>', '', text or '').replace('\\n', '\n')

def compact_effect(effect):
    return dict(key=effect['key'], selector={k: v for k, v in effect['selector'].items() if v}, blackboard=[dict(key=row['key'], **({'valueStr': row['valueStr']} if row.get('valueStr') is not None else {'value': row.get('value', 0)})) for row in effect['blackboard']])

def compile_archive(input_dir):
    english = {}
    english_file = input_dir / 'ccb-seasons.json'
    if english_file.exists():
        for season in json.loads(english_file.read_text()):
            for stage in season['value']['stageDict'].values():
                row = stage['excel']; english[row['stageId']] = row
    seasons = []
    for number in range(1, 5):
        raw = json.loads((input_dir / f'ccb-raw-{number}.json').read_text())
        maps = []
        for map_id, stage in raw['mapStageDataMap'].items():
            detail = raw['mapDetailDataMap'][map_id]
            groups = []
            # Rotational maps use an ungrouped node tree, not the main map's packs.
            # Preserve the full tree instead of treating absent packs as no criteria.
            packs = detail['bagDataMap'] or {'__rotation': {'slotPackName': 'Test criteria', 'sortId': 0}}
            for group_id, group in sorted(packs.items(), key=lambda pair: pair[1]['sortId']):
                pos = detail['bagViewData']['bagPosMap'][group_id] if detail['bagViewData'] else {'pos': {'x': 390, 'y': 0}, 'size': {'x': 600}}
                contracts = []
                for node_id, node in detail['nodeDataMap'].items():
                    rune = detail['runeDataMap'].get(node['runeId'])
                    if not rune or node['slotPackId'] != (None if group_id == '__rotation' else group_id): continue
                    point = detail['nodeViewData']['nodePosMap'][node_id]
                    point = point.get('position', point.get('pos', point))
                    adjacent = [other for other in node['adjacentNodeList'] if other in detail['nodeDataMap'] and detail['nodeDataMap'][other]['runeId']]
                    contracts.append(dict(id=node_id, runeId=rune['runeId'], name=clean(rune['runeName']), description=clean(rune['packedRune']['description']), score=rune['score'], group=rune['runeGroupId'], exclusion=node.get('mutualExclusionGroup'), effects=[compact_effect(effect) for effect in rune['packedRune']['runes']], x=point['x'], y=-point['y'], adjacent=adjacent))
                groups.append(dict(id=group_id, name=GROUPS.get(group['slotPackName'], group['slotPackName']), originalName=group['slotPackName'], x=pos['pos']['x'], y=-pos['pos']['y'], width=pos['size']['x'], contracts=contracts))
            en = english.get(stage['stageId'], {})
            maps.append(dict(id=map_id, stage=stage['stageId'], name=en.get('name') or MAPS.get(stage['name'].strip(), stage['name'].strip()), originalName=stage['name'].strip(), area=en.get('code') or AREAS.get(stage['code'], stage['code']), main=stage['stageType'] == 'PERMANENT', groups=groups))
        seasons.append(dict(id=raw['seasonId'], name=f'Battleplan {NAMES[number-1]}', number=number, maps=maps))
    return dict(schema=1, source=f'https://github.com/pfyy/OpenBachelorS/tree/{COMMIT}/data/crisisV2', englishMapSource='https://awedtan.ca/api/ccb', locale='zh_CN', note='Historical CN snapshots; editorial English group/effect labels. Not a current Global schedule.', seasons=seasons)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--input-dir', type=Path, required=True)
    args = parser.parse_args()
    output = Path(__file__).resolve().parents[2] / 'data/ccb/archive.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(compile_archive(args.input_dir), ensure_ascii=False, separators=(',', ':')) + '\n')
    print(output)
