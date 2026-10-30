import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGameAccountMap } from '../build/build-game-account-map';

// What the site reads out of the map it writes -- a save turned into a roster and a depot --
// is held by arkpedia-app's own scripts/tests/test-game-account.ts.

// Two records and the client's view of them, as small as the rules need.
const records = [
  { name: 'Fiammetta', rarity: 6, internalName: 'char_300_phenxi',
    modules: [{ type: 'Original', name: 'Badge' }, { type: 'Upgrade', name: 'ART-X: A Long Journey' }, { type: 'Upgrade', name: 'ART-Y: "Out-Law" Surplus' }],
    skills: { skillList: [{ name: '"Provocate"' }, { name: 'Embers' }] } },
  { name: 'Raidian', internalName: 'char_4145_radian',
    modules: [{ type: 'Original', name: 'Badge' }, { type: 'Upgrade', name: 'SO-α: First' }, { type: 'Upgrade', name: 'SO-β: Second' }],
    skills: { skillList: [{ name: 'One' }] } },
];
const tables = {
  uniequip: {
    // The client lists modules in release order: Fiammetta's Y first.
    charEquip: { char_300_phenxi: ['uniequip_001_phenxi', 'uniequip_002_phenxi', 'uniequip_003_phenxi'], char_4145_radian: ['uniequip_001_radian', 'uniequip_002_radian', 'uniequip_003_radian'] },
    equipDict: {
      uniequip_001_phenxi: { type: 'INITIAL', typeName1: 'ORIGINAL', typeName2: null },
      uniequip_002_phenxi: { type: 'ADVANCED', typeName1: 'ART', typeName2: 'Y' },
      uniequip_003_phenxi: { type: 'ADVANCED', typeName1: 'ART', typeName2: 'X' },
      uniequip_001_radian: { type: 'INITIAL', typeName1: 'ORIGINAL', typeName2: null },
      uniequip_002_radian: { type: 'ADVANCED', typeName1: 'SO', typeName2: 'A' },
      uniequip_003_radian: { type: 'ADVANCED', typeName1: 'SO', typeName2: 'B' },
    },
  },
  characters: { char_300_phenxi: { skills: [{ skillId: 'p1' }, { skillId: 'p2' }], nationId: 'yan' }, char_4145_radian: { skills: [{ skillId: 'r1' }], nationId: 'lgd' } },
  skills: { p1: { levels: [{ name: "'Provocate'" }] }, p2: { levels: [{ name: 'Embers' }] }, r1: { levels: [{ name: 'One' }] } },
};

test('the map places a module by its type code, whatever order the client lists it in', () => {
  const map = buildGameAccountMap(records, tables);
  // global: the client has the operator, which the account page counts.
  assert.deepEqual(map.chars.char_300_phenxi, { name: 'Fiammetta', rarity: 6, modules: { uniequip_002_phenxi: 1, uniequip_003_phenxi: 0 }, global: true });
  // The profile card's names, from the display and medal tables.
  const named = buildGameAccountMap(records, { ...tables, displayMeta: { nameCardV2Data: { skinData: { nc_moon_1: { name: 'An Invitation to Moons', themeEnName: 'An invitation to moons' }, nc_rhodes_default: { name: 'Rhodes Island', themeEnName: '', isSpTheme: false }, nc_avemujica_1: { name: 'The Eternal Show', themeEnName: 'The Eternal Show', isSpTheme: true, skinTmplCnt: 5 } } } },
    medalTable: { medalList: [{ medalId: 'medal_a', medalName: 'A Medal' }, { medalId: 'medal_b' }] },
    teams: { none: { powerLevel: 0, powerName: 'No team', orderNum: 0 }, yan: { powerLevel: 0, powerName: 'Yan', orderNum: 2 }, rhodes: { powerLevel: 0, powerName: 'Rhodes Island', orderNum: 1 }, lgd: { powerLevel: 1, powerName: 'Lungmen Guard Department', orderNum: 3 } } });
  assert.deepEqual([named.nameCards, named.nameCardThemes, named.medals], [{ nc_avemujica_1: 'The Eternal Show', nc_moon_1: 'An Invitation to Moons', nc_rhodes_default: 'Rhodes Island' }, { nc_avemujica_1: 'The Eternal Show', nc_moon_1: 'An invitation to moons' }, { medal_a: 'A Medal' }]);
  // A style's variants, and the styles with no theme (the assistant shows instead).
  assert.deepEqual([named.nameCardVariants, named.nameCardPlain], [{ nc_avemujica_1: 5 }, ['nc_rhodes_default']]);
  // Each theme's colours, as the importer read them; a malformed one is left out.
  const coloured = buildGameAccountMap(records, { ...tables, styles: {
    nc_avemujica_1: { md5: 'x', theme: '#c41c55', themeText: '#ffffff', panel: '#191919d9', panelText: '#ffffffb2', panelIcon: '#ffffff4c' },
    nc_broken: { theme: 'red', themeText: '#ffffff', panel: '#000000', panelText: '#ffffff', panelIcon: '#ffffff' },
  } });
  assert.deepEqual(coloured.nameCardStyles, { nc_avemujica_1: { theme: '#c41c55', themeText: '#ffffff', panel: '#191919d9', panelText: '#ffffffb2', panelIcon: '#ffffff4c' } });
  // The card's nation emblems: the nations only (not their groups, not "No team"), in the game's order.
  assert.deepEqual(named.nations, ['Rhodes Island', 'Yan']);
  // Each operator's nation, by that name, for the emblem it counts toward; a group is not a nation.
  assert.deepEqual([named.chars.char_300_phenxi.nation, named.chars.char_4145_radian.nation], ['Yan', undefined]);
  // Another form of one character (Amiya's Guard and Medic) names its default form's id, so
  // the account page counts the character once, as the game does.
  const formed = buildGameAccountMap(records, { ...tables, forms: { Raidian: { default: 'Fiammetta', forms: [{ name: 'Fiammetta', internalName: 'char_300_phenxi' }, { name: 'Raidian', internalName: 'char_4145_radian' }] } } });
  assert.equal(formed.chars.char_4145_radian.formOf, 'char_300_phenxi');
  assert.equal(formed.chars.char_300_phenxi.formOf, undefined);
  // The client spells the Greek letters A and B.
  assert.deepEqual(map.chars.char_4145_radian.modules, { uniequip_002_radian: 0, uniequip_003_radian: 1 });
  // This mirror writes an empty list as {}: no skills, as a record without any has.
  const skillless = records.map((record) => (record.name === 'Raidian' ? { ...record, skills: { skillList: [] } } : record));
  assert.doesNotThrow(() => buildGameAccountMap(skillless, { ...tables, characters: { ...tables.characters, char_4145_radian: { skills: {} as never } } }));
});

test('the account map carries dated beginner programmes without inventing identity for older releases', () => {
  assert.equal(buildGameAccountMap(records, tables).beginnerPrograms, undefined);
  const current = buildGameAccountMap(records, { ...tables, openServer: { schedule: [
    { id: 'later', startTs: 200 }, { id: 'earlier', startTs: 100 }, { id: '../invalid', startTs: 300 },
  ] } });
  assert.deepEqual(current.beginnerPrograms, [{ id: 'earlier', startTs: 100 }, { id: 'later', startTs: 200 }]);
  // open_server_table's shape (2026-10-21): each programme's window and its mission group's ids,
  // which the import reads the save's mission.missionGroups[programme] by. Nothing else is kept.
  const dated = buildGameAccountMap(records, { ...tables, openServer: {
    schedule: [{ id: 'openseverTaskGroup1', versionId: 'OpenServer', startTs: 1533898800, endTs: 1733227199, chainLoginDescription: 'text' } as never, { id: 'openseverTaskGroup2', startTs: 1733227200, endTs: 1881658799 }],
    dataMap: { openseverTaskGroup1: { openServerMissionGroup: { missionIds: ['openserver_1', 'openserver_2', '../bad', 3] } } },
  } });
  assert.deepEqual(dated.beginnerPrograms, [
    { id: 'openseverTaskGroup1', startTs: 1533898800, endTs: 1733227199, missionIds: ['openserver_1', 'openserver_2'] },
    { id: 'openseverTaskGroup2', startTs: 1733227200, endTs: 1881658799 },
  ]);
  // Missions with no group naming them would quietly stop the import's group tick: the run fails.
  assert.throws(() => buildGameAccountMap(records, { ...tables, openServer: { schedule: [{ id: 'p', startTs: 1 }], dataMap: { p: { openServerMissionData: [{ id: 'm' }] } } } }),
    /beginner programme p has missions but no openServerMissionGroup.missionIds/);
});

test('a record that no longer lines up with the client fails the map, naming it', () => {
  const renamed = structuredClone(records);
  renamed[0].modules[1].name = 'A Long Journey';
  assert.throws(() => buildGameAccountMap(renamed, tables), /Fiammetta: the client's uniequip_003_phenxi \(ART-X\) matches 0 of the record's modules/);
  const reordered = structuredClone(records);
  reordered[0].skills.skillList.reverse();
  assert.throws(() => buildGameAccountMap(reordered, tables), /Fiammetta: the client's skills \(provocate, embers\) are not the record's/);
  assert.throws(() => buildGameAccountMap([{ name: 'Nobody' }], tables), /Nobody has no internalName/);
});
