import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileBaseSkills } from '../imports/import-base-skills.mjs';
const building = { chars: { test: { buffChar: [{ buffData: [{ buffId: 'early', cond: { phase: 'PHASE_0', level: 30 } }, { buffId: 'late', cond: { phase: 'PHASE_2', level: 1 } }] }] } }, buffs: {
  early: { roomType: 'CONTROL', buffName: 'Early', description: 'Morale <@cc.vup>+0.05</>' },
  late: { roomType: 'TRADING', buffName: 'Late', description: 'Efficiency <@cc.vup>+10%</>' },
} };
test('base import retains a cross-facility upgrade as one immutable slot chain', () => {
  const skills = reconcileBaseSkills({ name: 'Test', internalName: 'test', baseSkills: [] }, building, 'Global', {}, {});
  assert.deepEqual(skills.map(s => [s.buffId, s.slot, s.phase, s.level, s.facility, s.eliteLevel]), [
    ['early', 0, 0, 30, 'Control Center', 'Level 30'], ['late', 0, 2, 1, 'Trading Post', 'Elite 2'],
  ]);
  assert.equal(skills[1].description, 'Efficiency +10%');
});
test('CN additions require explicit translations, and never publish empty skills', () => {
  const op = { name: 'Test', internalName: 'test', baseSkills: [] };
  assert.throws(() => reconcileBaseSkills(op, building, 'CN', {}, {}), /untranslated early/);
  const translations = { early: { name: 'Early translated', description: 'Translated morale' }, late: { name: 'Late translated', description: 'Translated efficiency' } };
  const actual = reconcileBaseSkills(op, building, 'CN', translations, {});
  assert.equal(actual.length, 2); assert.equal(actual[1].description, 'Translated efficiency');
  assert.deepEqual(op.baseSkills, []);
});
test('stable buff ID joins preserve icon names even when translations change', () => {
  const old = [{ name: 'Old spelling', description: 'Old text', icon: '/custom.webp', buffId: 'early', slot: 0, phase: 0, facility: 'Control Center' }];
  const partial = { ...building, chars: { test: { buffChar: [{ buffData: building.chars.test.buffChar[0].buffData.slice(0, 1) }] } } };
  const actual = reconcileBaseSkills({ name: 'Test', internalName: 'test', baseSkills: old }, partial, 'Global', {}, {});
  assert.equal(actual[0].name, 'Old spelling'); assert.equal(actual[0].icon, '/custom.webp'); assert.equal(actual[0].description, 'Morale +0.05');
});
test('unmatched existing skills abort reconciliation rather than silently deleting them', () => {
  assert.throws(() => reconcileBaseSkills({ name: 'Test', internalName: 'test', baseSkills: [{ name: 'Unexpected', facility: 'Factory' }] }, building, 'Global', {}, {}), /existing base skills have no source match/);
});

test('a CN Recycling Station skill imports, its reviewed translation replaces the Chinese text, and an unnamed facility fails by name', () => {
  // Homebound (char_4232_hbound, CN 2026-10): two RECYCLE skills the catalogue first stored in
  // Chinese under the raw roomType, and a Workshop one (issue #59, 2026-10-13).
  const recycle = {
    chars: { char_4232_hbound: { buffChar: [
      { buffData: [{ buffId: 'recycle_spd&cost[000]', cond: { phase: 'PHASE_0', level: 1 } }, { buffId: 'recycle_spd&cost[010]', cond: { phase: 'PHASE_2', level: 1 } }] },
      { buffData: [{ buffId: 'workshop_formula_device[080]', cond: { phase: 'PHASE_2', level: 1 } }] },
    ] } },
    buffs: {
      'recycle_spd&cost[000]': { roomType: 'RECYCLE', buffName: '拾荒者', description: '进驻回收站时，材料转化效率<@cc.vup>+20%</>' },
      'recycle_spd&cost[010]': { roomType: 'RECYCLE', buffName: '捡海人', description: '进驻回收站时，材料转化效率<@cc.vup>+30%</>' },
      'workshop_formula_device[080]': { roomType: 'WORKSHOP', buffName: '指尖的光', description: '进驻加工站加工手性屈光体或重相位对映体时，副产物的产出概率提升90%' },
    },
  };
  const stored = [
    { name: '拾荒者', facility: 'RECYCLE', eliteLevel: 'Base', description: '进驻回收站时，材料转化效率+20%', slot: 0, phase: 0, level: 1 },
    { name: '捡海人', facility: 'RECYCLE', eliteLevel: 'Elite 2', description: '进驻回收站时，材料转化效率+30%', slot: 0, phase: 2, level: 1 },
    { name: '指尖的光', facility: 'Workshop', eliteLevel: 'Elite 2', description: '进驻加工站加工手性屈光体或重相位对映体时，副产物的产出概率提升90%', slot: 1, phase: 2, level: 1 },
  ];
  const translations = {
    'recycle_spd&cost[000]': { name: 'Scavenger', description: 'When assigned to the Recycling Station, material conversion efficiency +20%.' },
    'recycle_spd&cost[010]': { name: 'Beachcomber', description: 'When assigned to the Recycling Station, material conversion efficiency +30%.' },
    'workshop_formula_device[080]': { name: 'Light at the Fingertips', description: 'When assigned to the Workshop to process Chiral Refractor or Rephasic Enantiomer, the production rate of byproduct increases by 90%.' },
  };
  const op = { name: 'Homebound', internalName: 'char_4232_hbound', baseSkills: stored };
  const skills = reconcileBaseSkills(op, recycle, 'CN', translations, {});
  assert.deepEqual(skills.map(s => [s.name, s.facility, s.eliteLevel, s.buffId]), [
    ['Scavenger', 'Recycling Station', 'Base', 'recycle_spd&cost[000]'],
    ['Beachcomber', 'Recycling Station', 'Elite 2', 'recycle_spd&cost[010]'],
    ['Light at the Fingertips', 'Workshop', 'Elite 2', 'workshop_formula_device[080]'],
  ]);
  assert.equal(skills[0].description, translations['recycle_spd&cost[000]'].description);
  // Once stored in English with buff IDs, the next run joins by ID and changes nothing.
  assert.deepEqual(reconcileBaseSkills({ ...op, baseSkills: skills }, recycle, 'CN', translations, {}), skills);
  // Without a translation a CN skill still refuses to publish.
  assert.throws(() => reconcileBaseSkills({ ...op, baseSkills: [] }, recycle, 'CN', {}, {}), /untranslated recycle_spd&cost\[000\]/);
  // A facility no one has named fails by its roomType, not as an "unknown buff".
  const unnamed = structuredClone(recycle);
  unnamed.buffs['recycle_spd&cost[000]'].roomType = 'GREENHOUSE';
  assert.throws(() => reconcileBaseSkills(op, unnamed, 'CN', translations, {}), /recycle_spd&cost\[000\] is in facility GREENHOUSE, which scripts\/lib\/base-rooms\.mjs does not name/);
});

test('a base skill keeps the keywords the game explains, each with the game\'s own definition', async () => {
  const { baseSkillKeywords } = await import('../imports/import-base-skills.mjs');
  // Closure's Trading Post skill (EN building_data), and the two terms from gamedata_const.
  const terms = {
    'cc.tra.closure': { termId: 'cc.tra.closure', termName: "Closure's Special Order", description: 'Special Precious Metal orders offered by Closure that have fixed earnings, and require 2 Pure Gold to trade' },
    'cc.bd_b1': { termId: 'cc.bd_b1', termName: 'Worldly Plight', description: "Affects <$cc.bd_C><@cc.rem>Witchcraft Crystal</></> skills\nProvided by the following Operators' skills\nDusk, Ling" },
  };
  const special = { chars: { closure: { buffChar: [{ buffData: [{ buffId: 'trade_ord_closure', cond: { phase: 'PHASE_0', level: 1 } }] }] } }, buffs: {
    trade_ord_closure: { roomType: 'TRADING', buffName: 'Special Order', description: "Order acquisition efficiency <@cc.vup>+10%</>, <$cc.tra.closure><@cc.kw>Closure's Special Order</></> will be obtained at a fixed rate" },
  } };
  const [skill] = reconcileBaseSkills({ name: 'Closure', internalName: 'closure', baseSkills: [] }, special, 'Global', {}, terms);
  assert.equal(skill.description, "Order acquisition efficiency +10%, Closure's Special Order will be obtained at a fixed rate");
  assert.deepEqual(skill.keywords, [{ text: "Closure's Special Order", term: 'cc.tra.closure', name: "Closure's Special Order",
    definition: 'Special Precious Metal orders offered by Closure that have fixed earnings, and require 2 Pure Gold to trade' }]);
  // A nested term in a definition reads as plain words; a CN skill's term counts by its English name.
  const [plight] = baseSkillKeywords('自身心情低于12时，<$cc.bd_b1><@cc.rem>人间烟火</></>+15', 'when self Morale is below 12, Worldly Plight +15', terms);
  assert.deepEqual([plight.text, plight.definition], ['Worldly Plight', "Affects Witchcraft Crystal skills\nProvided by the following Operators' skills\nDusk, Ling"]);
  assert.deepEqual(baseSkillKeywords('<$cc.bd_b1>人间烟火</>', 'no English name here', terms), [], 'a term whose words are not in the text is left out');
  const factions = { ...terms, 'cc.g.rh': { termName: 'Rhine Lab', description: 'Includes the following Operators:\nSaria, Silence' }, 'cc.m.pas': { termName: 'Passion', description: 'x' } };
  assert.deepEqual(baseSkillKeywords('Each <@cc.kw>Rhine Lab</> Operator adds Passion', 'Each Rhine Lab Operator adds Passion', factions).map(k => k.term), ['cc.g.rh'],
    'a Base term named without its tag still counts, when it is more than one word');
  assert.throws(() => reconcileBaseSkills({ name: 'Closure', internalName: 'closure', baseSkills: [] }, special, 'Global', {}, undefined), /no glossary/);
});

/* Every raw string here is a real Global building_data description, trimmed to the part that
   misbehaves. Yostar writes the mistake; stripRichText was only removing the tag that stood in
   for the missing space (scripts/lib/gametext.mjs normaliseBaseSkillText). */
test("Yostar's own missing spaces in a base skill are repaired, and the keywords survive", async () => {
  const { normaliseBaseSkillText, stripRichText } = await import('../lib/gametext.mjs');
  const strip = raw => stripRichText(normaliseBaseSkillText(raw));

  // A word running straight into the tag after it: Mr. Nothing, Dusk, Blitz, Frost, Irene.
  assert.equal(strip('Dormitory grants<$cc.bd_b1><@cc.rem>Worldly Plight</></> <@cc.vup>+1</>'), 'Dormitory grants Worldly Plight +1');
  assert.equal(strip('consumption by<@cc.vdown>+0.5</>'), 'consumption by +0.5');
  assert.equal(strip('training speed<@cc.vup>+30%</>'), 'training speed +30%');
  // A tag closing straight into the word after it: Mr. Nothing's "1point".
  assert.equal(strip('for every <@cc.vup>1</>point'), 'for every 1 point');
  // A term closing straight into its own value, nothing between the two: Dusk, Ch'en the Dawnstreak.
  assert.equal(strip('<$cc.bd_a1><@cc.rem>Perception Information</></><@cc.vup>+10</>'), 'Perception Information +10');
  // A stray '<' before a tag: Mulberry, which printed "<Worldly Plight".
  assert.equal(strip('do not count), <<$cc.bd_b1><@cc.rem>Worldly Plight</></> <@cc.vup>+10</>'), 'do not count), Worldly Plight +10');
  // A comma running into the tag after it: Ling, Harold.
  assert.equal(strip('above <@cc.kw>12</>,<$cc.bd_b1><@cc.rem>Worldly Plight</></> <@cc.vup>+15</>'), 'above 12, Worldly Plight +15');

  // The neighbours the table means to keep tight: a parenthesis, a second value, a hyphenated name.
  assert.equal(strip('Plight</></> (<$cc.c.sui2_1><@cc.rem>Special Comparison Rules</></> apply'), 'Plight (Special Comparison Rules apply');
  assert.equal(strip('efficiency <@cc.vup>+25%</>, +<@cc.vup>5%</> per Reception Room level'), 'efficiency +25%, +5% per Reception Room level');
  assert.equal(strip('a non-<@cc.kw>Rhine Lab</> clue is collected'), 'a non-Rhine Lab clue is collected');
  assert.equal(strip('if <@cc.kw>Lancet-2</> is assigned'), 'if Lancet-2 is assigned');
  // Nothing to repair, and repairing twice is repairing once.
  assert.equal(normaliseBaseSkillText('speed <@cc.vup>+20%</>'), 'speed <@cc.vup>+20%</>');
  const once = normaliseBaseSkillText('grants<$cc.bd_b1><@cc.rem>Worldly Plight</></><@cc.vup>+1</>');
  assert.equal(normaliseBaseSkillText(once), once);
  assert.equal(normaliseBaseSkillText(undefined), '');

  // End to end: the repaired text is what the record carries, and "Worldly Plight" is still the
  // underlined keyword -- the page finds it by looking for the term's words in the finished text.
  const terms = { 'cc.bd_b1': { termId: 'cc.bd_b1', termName: 'Worldly Plight', description: 'Affects Witchcraft Crystal skills' } };
  const nothing = { chars: { nothin: { buffChar: [{ buffData: [{ buffId: 'trade_ord_spd_bd_n2[000]', cond: { phase: 'PHASE_1', level: 1 } }] }] } }, buffs: {
    'trade_ord_spd_bd_n2[000]': { roomType: 'TRADING', buffName: "'Obvious Deception'",
      description: 'When this Operator is assigned to a Trading Post, <@cc.kw>each</> Operator in the Dormitory grants<$cc.bd_b1><@cc.rem>Worldly Plight</></><@cc.vup>+1</>, and for every <@cc.vup>1</>point<$cc.bd_b1><@cc.rem>Worldly Plight</></>, grant <@cc.vup>+1%</> order acquisition efficiency' },
  } };
  const [skill] = reconcileBaseSkills({ name: 'Mr. Nothing', internalName: 'nothin', baseSkills: [] }, nothing, 'Global', {}, terms);
  assert.equal(skill.description, 'When this Operator is assigned to a Trading Post, each Operator in the Dormitory grants Worldly Plight +1, and for every 1 point Worldly Plight, grant +1% order acquisition efficiency');
  assert.deepEqual(skill.keywords.map(k => k.text), ['Worldly Plight']);
});
