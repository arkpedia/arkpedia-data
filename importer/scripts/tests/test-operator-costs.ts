import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error Node import scripts are plain JavaScript.
import { costDisagreements, gameCosts, readCostTables, RETIRED_STAGE, runOperatorCosts, STAGE, syncOperatorCosts, verifyOperatorCosts } from '../sync/sync-operator-costs.mjs';
// @ts-expect-error Node import scripts are plain JavaScript.
import { materialItems } from '../lib/material-items.mjs';

/*
 * Every material an operator's upgrades cost comes from the game's tables on every refresh,
 * over whatever the record had (scripts/sync/sync-operator-costs.mjs). On 2026-10-08 118 of the
 * wiki import's costs were still wrong or missing: the stage before this one only filled a
 * cost the record lacked, the English refresh never wrote a promotion, and nothing rewrote a
 * CN-only operator's. The records and tables here are the real ones, trimmed
 * (fixtures/operator-game-costs.json says from which commits), and each record still carries
 * the import's wrong cost: a fill-only stage leaves every one of them as it is.
 */
type Cost = { name: string; quantity: number }[];
const fixture = JSON.parse(fs.readFileSync('scripts/tests/fixtures/operator-game-costs.json', 'utf8'));
const tablesWith = (names = fixture.materialNames) => ({
  en: fixture.tables.en, cn: fixture.tables.cn,
  nameOf: materialItems({ enItems: fixture.tables.en.items, cnItems: fixture.tables.cn.items, names }).nameOf,
});
const tables = tablesWith();
const record = (name: string) => structuredClone(fixture.records[name]);
const fixed = (name: string) => syncOperatorCosts(record(name), tables).operator;
const hasChinese = (value: unknown) => /\p{Script=Han}/u.test(JSON.stringify(value));
// Every cost list on a record (a CN-only module's name may be the CN client's own words).
const costsOf = (operator: any) => [...(operator.promotion ?? []).map((tier: any) => tier.cost), ...Object.values(operator.skills?.skillCost ?? {}),
  ...(operator.skills?.skillList ?? []).flatMap((skill: any) => Object.values(skill.cost ?? {})),
  ...(operator.modules ?? []).flatMap((module: any) => (module.stages ?? []).map((stage: any) => stage.cost))];
// data/material-names.json without one id: a CN-only material no one has named yet.
const namesWithout = (id: string) => {
  const { [id]: _, ...byItemId } = fixture.materialNames.byItemId;
  return { ...fixture.materialNames, byItemId };
};

test('a cost the wiki import got wrong is the game\'s after the stage: Closure S3M3, Ceobe E1, Skybox E2, Crackborne SL2', () => {
  const cases: [string, (operator: any) => Cost, string, Cost, Cost][] = [
    ['Closure', op => op.skills.skillList[2].cost.m3, 'skill 3 M3',
      [{ name: 'Skill Summary - 3', quantity: 15 }, { name: 'Crystalline Circuit', quantity: 6 }, { name: 'Refined Solvent', quantity: 1 }],
      [{ name: 'Skill Summary - 3', quantity: 15 }, { name: 'Crystalline Electronic Unit', quantity: 6 }, { name: 'Refined Solvent', quantity: 1 }]],
    ['Ceobe', op => op.promotion[0].cost, 'Elite 1',
      [{ name: 'LMD', quantity: 30000 }, { name: 'Caster Chip', quantity: 5 }, { name: 'Oriron', quantity: 3 }, { name: 'Device', quantity: 5 }],
      [{ name: 'LMD', quantity: 30000 }, { name: 'Caster Chip', quantity: 5 }, { name: 'Oriron', quantity: 8 }, { name: 'Device', quantity: 3 }]],
    ['Skybox', op => op.promotion[1].cost, 'Elite 2',
      [{ name: 'LMD', quantity: 120000 }, { name: 'Sniper Dualchip', quantity: 3 }, { name: 'Chiral Refractor', quantity: 13 }, { name: 'RMA70-12', quantity: 7 }],
      [{ name: 'LMD', quantity: 120000 }, { name: 'Sniper Dualchip', quantity: 3 }, { name: 'RMA70-24', quantity: 7 }, { name: 'Coagulative Nodule', quantity: 13 }]],
    ['Crackborne', op => op.skills.skillCost['2'], 'skill level 2',
      [{ name: 'Skill Summary - 1', quantity: 5 }],
      [{ name: 'Skill Summary - 1', quantity: 4 }]],
  ];
  for (const [name, cost, label, before, after] of cases) {
    const operator = record(name);
    assert.deepEqual(cost(operator), before, `${name}'s fixture carries the import's ${label}`);
    assert.ok(costDisagreements(operator, tables).some((entry: { label: string }) => entry.label === label), `the guard names ${name}'s ${label}`);
    const result = syncOperatorCosts(operator, tables);
    assert.ok(result.written.includes(label), `${name}'s ${label} is written`);
    assert.deepEqual(cost(result.operator), after, `${name}'s ${label} is the game's`);
    assert.deepEqual(cost(operator), before, 'the record passed in is not changed');
    assert.deepEqual(costDisagreements(result.operator, tables), [], `nothing on ${name} disagrees with the tables afterwards`);
  }
});

test('every cost on a CN-only operator is the CN client\'s: promotions, skill levels, masteries and module stages, filled where the record had none', () => {
  // Crackborne: Elite 1 cost Orirock for the game's Orirock Cube, and every skill level and
  // mastery a few Skill Summaries too many.
  const crackborne = syncOperatorCosts(record('Crackborne'), tables);
  assert.deepEqual(crackborne.written, ['Elite 1', ...[2, 3, 4, 5, 6, 7].map(level => `skill level ${level}`),
    'skill 1 M1', 'skill 1 M2', 'skill 1 M3', 'skill 2 M1', 'skill 2 M2', 'skill 2 M3']);
  assert.deepEqual(crackborne.operator.skills.skillList[1].cost.m1,
    [{ name: 'Skill Summary - 3', quantity: 5 }, { name: 'Polymerized Gel', quantity: 3 }, { name: 'Liquified High-Energy Gas', quantity: 4 }],
    'a material only CN has, by its name in data/material-names.json');
  // Jacinta: no skill level costs at all (skillCost null), and her module's stages a 6-star's.
  const jacinta = record('Jacinta');
  assert.equal(jacinta.skills.skillCost, null);
  const after = syncOperatorCosts(jacinta, tables).operator;
  assert.deepEqual(Object.keys(after.skills.skillCost), ['2', '3', '4', '5', '6', '7']);
  assert.deepEqual(after.skills.skillCost['2'], [{ name: 'Skill Summary - 1', quantity: 4 }]);
  // Her module has no moduleId (the import's): found by its code among her own modules.
  assert.equal(jacinta.modules[1].moduleId, undefined);
  assert.deepEqual(after.modules[1].stages.map((stage: { cost: Cost }) => stage.cost), [
    [{ name: 'Module Data Block', quantity: 2 }, { name: 'Polymerized Gel', quantity: 3 }, { name: 'LMD', quantity: 40000 }],
    [{ name: 'Module Data Block', quantity: 2 }, { name: 'Data Supplement Stick', quantity: 20 }, { name: 'Chiral Refractor', quantity: 4 }, { name: 'LMD', quantity: 50000 }],
    [{ name: 'Module Data Block', quantity: 2 }, { name: 'Data Supplement Instrument', quantity: 8 }, { name: 'Concentrated Power Unit', quantity: 5 }, { name: 'LMD', quantity: 60000 }],
  ]);
  assert.deepEqual(after.promotion[1].cost[0], { name: 'LMD', quantity: 120000 }, 'LMD first, as the records list it');
  assert.ok(!hasChinese(costsOf(after)));
  // A module the record lists without stages has nowhere for its costs to go: reported.
  const bare = record('Jacinta');
  bare.modules[1].stages = [];
  assert.deepEqual(syncOperatorCosts(bare, tables).gaps, [{ label: 'BEA-X module', why: 'has no stages on the record for its costs to go in' }]);
});

test('a CN-only material with no English name yet is reported and left as the record has it, never written in Chinese', () => {
  // 31114 is Concentrated Power Unit, which the EN client did not have on 2026-10-08: without
  // its entry in data/material-names.json, only the CN client's Chinese name is known.
  const unnamed = tablesWith(namesWithout('31114'));
  const closure = record('Closure');
  const result = syncOperatorCosts(closure, unnamed);
  assert.deepEqual(result.gaps, [{ label: 'skill 2 M1', why: 'costs a material with no English name yet (item 31114)' }]);
  assert.ok(!result.written.includes('skill 2 M1'));
  assert.deepEqual(result.operator.skills.skillList[1].cost.m1, closure.skills.skillList[1].cost.m1, 'the record\'s cost stays');
  assert.ok(result.written.includes('skill 3 M3'), 'the costs it can write are still written');
  const jacinta = syncOperatorCosts(record('Jacinta'), unnamed);
  assert.deepEqual(jacinta.gaps.map((gap: { label: string }) => gap.label), ['BEA-X module stage 3']);
  for (const operator of [result.operator, jacinta.operator]) assert.ok(!hasChinese(costsOf(operator)), `${operator.name}'s costs carry no Chinese`);
  // A gap is not a disagreement the guard fails on: the stage reports it instead.
  assert.deepEqual(costDisagreements(result.operator, unnamed), []);
});

test('a cost the game lists as nothing is nothing, and a 3-star\'s Elite 1 is LMD alone', () => {
  // Raidian, an Integrated Strategies operator: both clients list no material for any upgrade.
  const raidian = record('Raidian');
  const result = syncOperatorCosts(raidian, tables);
  assert.equal(result.operator, raidian, 'nothing to write');
  assert.deepEqual(result.gaps, [], 'and nothing to report: the game has him');
  const slots = gameCosts(raidian, tables).slots;
  assert.ok(slots.length >= 2 + 6 + 9 && slots.every((slot: { want: Cost }) => Array.isArray(slot.want) && slot.want.length === 0));
  // Fang: Elite 1 costs 10,000 LMD and no material; a 3-star has no masteries to write.
  const fang = record('Fang');
  assert.equal(syncOperatorCosts(fang, tables).operator, fang);
  assert.deepEqual(gameCosts(fang, tables).slots.find((slot: { label: string }) => slot.label === 'Elite 1').want, [{ name: 'LMD', quantity: 10000 }]);
  assert.ok(!gameCosts(fang, tables).slots.some((slot: { label: string }) => / M\d$/.test(slot.label)));
});

test('a skill whose place says another skill keeps its masteries, reported: a reordered list cannot take another skill\'s costs', () => {
  // The Global table names its skills: Ceobe's first two swapped on the record are both refused.
  const ceobe = record('Ceobe');
  [ceobe.skills.skillList[0], ceobe.skills.skillList[1]] = [ceobe.skills.skillList[1], ceobe.skills.skillList[0]];
  const swapped = syncOperatorCosts(ceobe, tables);
  assert.deepEqual(swapped.operator.skills.skillList.slice(0, 2), ceobe.skills.skillList.slice(0, 2));
  assert.deepEqual(swapped.gaps.map((gap: { label: string }) => gap.label), ['skill 1 M1', 'skill 1 M2', 'skill 1 M3', 'skill 2 M1', 'skill 2 M2', 'skill 2 M3']);
  assert.match(swapped.gaps[0].why, /in the Global table and ".*" on the record/);
  // Quotes and case are not another name.
  const quoted = record('Ceobe');
  quoted.skills.skillList[0].name = `"${quoted.skills.skillList[0].name.toUpperCase()}"`;
  assert.deepEqual(syncOperatorCosts(quoted, tables).gaps, []);
  // The CN table names skills in Chinese: a list of another length cannot say which is which.
  const closure = record('Closure');
  closure.skills.skillList.pop();
  const short = syncOperatorCosts(closure, tables);
  assert.deepEqual([...new Set(short.gaps.map((gap: { why: string }) => gap.why))], [
    'is one of 3 skills in the CN table and the record lists 2, so its place cannot say which it is',
    'is a skill the record does not list',
  ]);
  assert.equal(short.gaps.length, 9);
  assert.ok(!short.written.some((label: string) => / M\d$/.test(label)));
});

test('only costs change, and a second run changes nothing', () => {
  const withoutCosts = (operator: any) => {
    const copy = structuredClone(operator);
    for (const tier of copy.promotion ?? []) delete tier.cost;
    delete copy.skills.skillCost;
    for (const skill of copy.skills.skillList) delete skill.cost;
    for (const module of copy.modules ?? []) for (const stage of module.stages ?? []) delete stage.cost;
    return copy;
  };
  for (const name of Object.keys(fixture.records)) {
    const operator = fixed(name);
    assert.deepEqual(withoutCosts(operator), withoutCosts(record(name)), `${name}: nothing but costs`);
    const again = syncOperatorCosts(operator, tables);
    assert.equal(again.operator, operator, `${name}: the second run writes nothing`);
    assert.deepEqual(again.written, []);
  }
});

test('the stage over a data folder: writes every record, reports the gaps, retires skill-masteries\' entries, and its guard reads the records back', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-costs-'));
  try {
    // The tables as the refresh finds them: an EN excel/ folder and a CN one.
    for (const [region, client] of Object.entries(fixture.tables) as [string, any][]) {
      const dir = path.join(root, region);
      fs.mkdirSync(dir);
      const files = { 'character_table.json': client.characters, 'skill_table.json': client.skills, 'uniequip_table.json': client.modules,
        'gamedata_const.json': client.constants, 'char_patch_table.json': client.patch, 'item_table.json': { items: client.items } };
      for (const [file, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
    }
    const read = readCostTables(path.join(root, 'en'), path.join(root, 'cn'), namesWithout('31114'));
    fs.mkdirSync(path.join(root, 'data', 'operators-6star'), { recursive: true });
    const at = (name: string) => path.join(root, 'data', 'operators-6star', `${name}.json`);
    for (const name of Object.keys(fixture.records)) fs.writeFileSync(at(name), `${JSON.stringify(record(name), null, 2)}\n`);
    const old = { key: 'mastery:char_4195_radian:s1', stage: RETIRED_STAGE, reason: 'Raidian\'s skill 1 has no M1 cost.', action: 'published-partial', firstSeen: '2026-09-29' };
    fs.writeFileSync(path.join(root, 'data', 'quarantine.json'), JSON.stringify({ version: 1, entries: [old] }));

    const result = runOperatorCosts(root, read, { now: new Date('2026-10-08T12:00:00Z'), log: () => {} });
    assert.equal(result.operators, 5);
    const closure = JSON.parse(fs.readFileSync(at('Closure'), 'utf8'));
    assert.equal(closure.skills.skillList[2].cost.m3[1].name, 'Crystalline Electronic Unit');
    assert.deepEqual(verifyOperatorCosts(root, read), [], 'the guard finds nothing left');
    const quarantine = JSON.parse(fs.readFileSync(path.join(root, 'data', 'quarantine.json'), 'utf8'));
    assert.deepEqual(quarantine.entries.map((entry: { stage: string; key: string }) => `${entry.stage} ${entry.key}`),
      [`${STAGE} costs:char_4228_closur`, `${STAGE} costs:char_4237_jcinta`], 'the gaps reported, the retired stage\'s entries gone');
    assert.match(quarantine.entries[0].reason, /^Closure's skill 2 M1 costs a material with no English name yet \(item 31114\), so that cost keeps what the record had/);
    // Check mode writes nothing and says what it would write.
    fs.writeFileSync(at('Ceobe'), `${JSON.stringify(record('Ceobe'), null, 2)}\n`);
    const before = fs.readFileSync(at('Ceobe'), 'utf8');
    const check = runOperatorCosts(root, read, { check: true, log: () => {} });
    assert.deepEqual(check.disagreements.map((entry: { operator: string; label: string }) => `${entry.operator} ${entry.label}`), ['Ceobe Elite 1']);
    assert.equal(fs.readFileSync(at('Ceobe'), 'utf8'), before);
    // The guard reads what is on disk: a cost put back wrong after the stage is named.
    assert.deepEqual(verifyOperatorCosts(root, read).map((entry: { operator: string; label: string }) => `${entry.operator} ${entry.label}`), ['Ceobe Elite 1']);
    // A cost that still disagrees once written is a bug, and fails the stage before it reports
    // anything. Simulated: a material whose name changes after the writes, so what was written
    // is not what the guard reads the tables to say.
    fs.writeFileSync(at('Ceobe'), `${JSON.stringify(record('Ceobe'), null, 2)}\n`);
    let written = false;
    const shifting = { ...read, nameOf: (id: string) => (written && read.nameOf(id) === 'Device' ? 'Device Mk II' : read.nameOf(id)) };
    assert.throws(() => runOperatorCosts(root, shifting, { now: new Date('2026-10-09T12:00:00Z'), log: () => { written = true; } }),
      /still disagree with the game's tables after the stage wrote them[\s\S]*Ceobe Elite 1/);
    assert.equal(fs.readFileSync(path.join(root, 'data', 'quarantine.json'), 'utf8'), `${JSON.stringify(quarantine, null, 2)}\n`, 'nothing reported from a failed run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the stage runs in the import after the English refresh and the catalogue, and before the material catalogue reads the costs', () => {
  const imports = fs.readFileSync('scripts/content/run-imports.sh', 'utf8');
  const at = (name: string) => imports.indexOf(`stage ${name} `);
  assert.ok(at('operator-english') > 0 && at('catalogue') > at('operator-english'));
  assert.ok(at(STAGE) > at('catalogue') && at(STAGE) < at('material-catalogue'));
  // The line that runs it, not the comments above that name it.
  assert.ok(imports.indexOf('\nbash scripts/sync/refresh-stage-data.sh') < at(STAGE), 'after the stage refresh checks out the EN tables it reads');
  assert.equal(at(RETIRED_STAGE), -1, 'the fill-only stage it replaced is gone');
});
