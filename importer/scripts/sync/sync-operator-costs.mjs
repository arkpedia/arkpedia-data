#!/usr/bin/env node
/**
 * The refresh's operator-costs stage: every material an operator's upgrades cost, from the
 * game's own tables, on every run.
 *
 *   node scripts/sync/sync-operator-costs.mjs           write the costs, then check them
 *   node scripts/sync/sync-operator-costs.mjs --check   write nothing: list every cost that
 *                                                       disagrees with the tables, and why
 *
 * What it writes, over whatever the record had: each promotion's cost (Elite 1 and 2, LMD
 * first, as the records list it), each skill level's (2 to 7), each skill's masteries (M1 to
 * M3) and each module stage's. From the Global client's tables for an operator Global has
 * (characterOf, the English refresh's own match: id and name), else from the CN client's, by
 * id; materials by their site name (scripts/lib/material-items.mjs): the EN client's, else
 * data/material-names.json's. Nothing else in a record is touched, and a cost that is already
 * the game's (the same materials, in any order) is left as it is.
 *
 * Why it overwrites: most records began as a wiki import, and on 2026-10-08 118 costs on 41
 * records were still the import's, wrong or missing: Closure's S3M3 cost Crystalline Circuit
 * for the game's Crystalline Electronic Unit, Ceobe's Elite 1 five Devices for three, Skybox's
 * Elite 2 Chiral Refractor and RMA70-12 for Coagulative Nodule and RMA70-24, Crackborne's every
 * skill level and mastery too many Skill Summaries; eight CN-only operators had no skill level
 * costs at all, and four CN-only modules nothing but their Module Data Blocks. The English
 * refresh (sync-operator-english.mjs) rewrites a Global operator's skill costs but never its
 * promotion; the catalogue builds a CN-only operator once, when it is new; and the stage this
 * one replaced (sync-skill-masteries.mjs) only filled a mastery the record lacked, so a wrong
 * one stayed wrong.
 *
 * What it leaves as the record has it, reported in data/quarantine.json (stage operator-costs)
 * until a later run can write it:
 *   - a cost in a material with no English name yet: in neither the EN item table nor
 *     data/material-names.json. Never written in Chinese, which no planner catalogue holds;
 *   - a skill's masteries where the place cannot say which skill it is: the Global table names
 *     the skill there otherwise than the record (a reordered list must not take another
 *     skill's costs), or the CN table, which names skills in Chinese, lists another number of
 *     skills than the record;
 *   - a promotion or module stage the record numbers otherwise than its place.
 * An operator neither table has keeps the record's costs (the wiki import's), unreported. A
 * cost the game lists as nothing is written as an empty list: Raidian's every one.
 *
 * The guard: once written, every record is read back and each cost compared with the tables
 * again (costDisagreements). One that still disagrees and is not a reported gap is a bug here:
 * the stage fails, which puts every record back as it was (scripts/content/run-stage.mjs), and
 * the daily issue names it. So a cost cannot drift from the game without a word.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beginStage, defaultNow } from '../lib/quarantine.mjs';
import { materialItems, readMaterialNames } from '../lib/material-items.mjs';
import { characterOf } from './sync-operator-english.mjs';

export const STAGE = 'operator-costs';
/** The stage this one replaced on 2026-10-08. Nothing runs it any more, so this stage clears
 *  its entries (a stage's entries stay until that stage runs again: quarantine.mjs). */
export const RETIRED_STAGE = 'skill-masteries';
const MASTERIES = ['m1', 'm2', 'm3'];
const MODULE_SUFFIX = { A: 'α', B: 'β', D: 'Δ' };
const rows = value => (Array.isArray(value) ? value : []);
const hasChinese = text => /\p{Script=Han}/u.test(String(text ?? ''));
// Letters and digits only: Bubble's record writes its skill "Beaten Up" in quotes, the table not.
const plainName = text => String(text ?? '').replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
// A module code as a key: "TAC-X", "ISW-α" and the table's "ISW" + "A" alike.
const codeKey = value => String(value ?? '').replace(/α/gi, 'A').replace(/β/gi, 'B').replace(/δ/gi, 'D').replace(/[^a-z0-9]/gi, '').toLowerCase();
/** A rarity as 1-6: Kengxxiao's and the EN mirror's "TIER_6", or yuanyan3060's 5. */
const tierOf = rarity => (Number.isInteger(rarity) ? rarity + 1 : Number(/^TIER_(\d)$/.exec(String(rarity ?? ''))?.[1]) || null);

/** A cost list as a key: the same materials in the same quantities, in any order, are one cost. */
const costKey = cost => rows(cost).map(entry => `${entry?.name}×${entry?.quantity}`).sort().join(', ');
/** Whether `recorded` is a cost list with exactly the materials of `game`. */
export const sameCost = (recorded, game) => Array.isArray(recorded) && costKey(recorded) === costKey(game);
const shown = cost => (Array.isArray(cost) ? `{${costKey(cost)}}` : 'nothing');

/** A table cost ([{ id, count }], or null where a mirror writes an empty list so) by site names,
 *  or the ids no English name is known for. */
function priced(entries, nameOf) {
  const cost = [], unnamed = [];
  for (const entry of rows(entries)) {
    const name = nameOf(entry?.id);
    if (!name || hasChinese(name)) unnamed.push(entry?.id);
    else cost.push({ name, quantity: entry.count });
  }
  return { cost, unnamed };
}
const slotOf = (label, at, entries, nameOf, first = []) => {
  const { cost, unnamed } = priced(entries, nameOf);
  return unnamed.length ? { label, at, gap: `costs a material with no English name yet (item ${unnamed.join(', ')})` }
    : { label, at, want: [...first, ...cost] };
};

/**
 * Which game character a record is, and whose tables say so: the Global one where the English
 * refresh finds it (characterOf: by id, in character_table or char_patch_table, with its name),
 * else the CN one by id. An id Global has under another operator's name is neither: the CN
 * entry would be that other operator too.
 */
export function gameCharacter(operator, { en, cn }) {
  const global = en ? characterOf(operator, en) : null;
  if (global) return { region: 'Global', character: global, tables: en };
  const id = operator?.internalName;
  if (en?.characters?.[id] || en?.patch?.patchChars?.[id]) return { region: null, character: null, conflict: true };
  const character = cn?.characters?.[id] ?? cn?.patch?.patchChars?.[id] ?? null;
  return character ? { region: 'CN', character, tables: cn } : { region: null, character: null };
}

/**
 * Every cost the game lists for an operator, as slots, each where the record keeps it (`at`, a
 * path into the record) and under a label the log and data/quarantine.json read:
 *   { label, at, want }   the game's cost, by site names, in the game's order;
 *   { label, at, gap }    the game's cost, which cannot be written: why, after the label.
 *
 *   tables: { en, cn, nameOf }, each client's { characters, skills (EN), modules (uniequip_table),
 *           constants (gamedata_const), patch (char_patch_table) }; nameOf: item id -> site name.
 */
export function gameCosts(operator, tables) {
  const { region, character, tables: own, conflict } = gameCharacter(operator, tables);
  if (conflict) return { region, slots: [{ label: 'every cost', at: null, gap: 'is under an id the Global table gives another operator, so no table can say what it costs' }] };
  if (!character) return { region, slots: [] };
  const { nameOf } = tables;
  const slots = [];

  // Promotions: the materials, and the LMD gamedata_const charges for the rarity and Elite: LMD
  // alone where there are none (a 3-star's Elite 1). An operator the game lists no material for
  // anywhere -- promotions, skill levels, masteries -- costs no LMD either: Raidian, an
  // Integrated Strategies operator both clients list with nothing (2026-10-08), whose record
  // has always had nothing.
  const rarity = tierOf(character.rarity) ?? operator.rarity;
  const free = ![...rows(character.phases).map(phase => phase?.evolveCost), ...rows(character.allSkillLvlup).map(step => step?.lvlUpCost),
    ...rows(character.skills).flatMap(skill => rows(skill?.levelUpCostCond).map(step => step?.levelUpCost))].some(cost => rows(cost).length);
  rows(character.phases).slice(1).forEach((phase, index) => {
    const label = `Elite ${index + 1}`;
    const at = ['promotion', index, 'cost'];
    const tier = rows(operator.promotion)[index]?.tier;
    if (/^Elite \d$/.test(tier ?? '') && tier !== label) return slots.push({ label, at, gap: `is the record's ${tier} at this place` });
    if (free) return slots.push({ label, at, want: [] });
    const lmd = own.constants?.evolveGoldCost?.[rarity - 1]?.[index];
    if (!(lmd > 0)) return slots.push({ label, at, gap: 'has no LMD cost in gamedata_const' });
    slots.push(slotOf(label, at, phase.evolveCost, nameOf, [{ name: 'LMD', quantity: lmd }]));
  });

  // Skill levels 2 to 7, one list for every skill.
  rows(character.allSkillLvlup).forEach((step, index) => {
    const level = String(index + 2);
    slots.push(slotOf(`skill level ${level}`, ['skills', 'skillCost', level], step?.lvlUpCost, nameOf));
  });

  // Masteries, each skill's from the table's skill at its place, when that place is the record's
  // skill: the Global table names it as the record does; the CN table names skills in Chinese, so
  // there the lists have to be the same length for a place to say which skill it is.
  const recorded = rows(operator.skills?.skillList);
  const game = rows(character.skills);
  game.forEach((entry, index) => {
    const steps = rows(entry?.levelUpCostCond).slice(0, MASTERIES.length);
    if (!steps.length) return;
    const skill = recorded[index];
    let why = null;
    if (!skill) why = 'is a skill the record does not list';
    else if (region === 'Global') {
      const name = tables.en.skills?.[entry.skillId]?.levels?.[0]?.name;
      if (plainName(name) !== plainName(skill.name)) why = `is "${name ?? entry.skillId}" in the Global table and "${skill.name}" on the record`;
    } else if (recorded.length !== game.length) {
      why = `is one of ${game.length} skills in the CN table and the record lists ${recorded.length}, so its place cannot say which it is`;
    }
    steps.forEach((step, k) => {
      const label = `skill ${index + 1} ${MASTERIES[k].toUpperCase()}`;
      const at = ['skills', 'skillList', index, 'cost', MASTERIES[k]];
      slots.push(why ? { label, at, gap: why } : slotOf(label, at, step?.levelUpCost, nameOf));
    });
  });

  // Module stages: a module by its id, else (a record from before modules carried one) by its
  // code among the operator's own modules; Global's entry first where both clients have it.
  const id = operator.internalName;
  const ownModules = client => rows(client?.modules?.charEquip?.[id]).map(equipId => client.modules.equipDict?.[equipId])
    .filter(equip => equip && equip.type !== 'INITIAL');
  const candidates = [...(region === 'Global' ? ownModules(tables.en) : []), ...ownModules(tables.cn)]
    .filter((equip, index, all) => all.findIndex(other => other.uniEquipId === equip.uniEquipId) === index);
  rows(operator.modules).forEach((module, index) => {
    if (module?.type === 'Original') return;
    const stages = rows(module?.stages);
    const matches = module.moduleId ? candidates.filter(equip => equip.uniEquipId === module.moduleId)
      : candidates.filter(equip => codeKey(`${equip.typeName1}-${equip.typeName2}`) === codeKey(String(module.name ?? '').split(':')[0]));
    // A module neither table has is the record's own, costs and all.
    if (!matches.length) return;
    const equip = matches[0];
    const code = `${equip.typeName1}-${MODULE_SUFFIX[equip.typeName2] ?? equip.typeName2}`;
    // Stages are the English refresh's to build (module-stages.mjs): without them a cost has
    // nowhere to go, and the planner would count the module free.
    if (!stages.length) {
      if (Object.values(equip.itemCost ?? {}).some(cost => rows(cost).length)) slots.push({ label: `${code} module`, at: null, gap: 'has no stages on the record for its costs to go in' });
      return;
    }
    stages.forEach((stage, j) => {
      const label = `${code} module stage ${j + 1}`;
      const at = ['modules', index, 'stages', j, 'cost'];
      if (matches.length > 1) return slots.push({ label, at, gap: `is the code of ${matches.length} of the operator's modules` });
      if (stage?.stage && stage.stage !== `Stage ${j + 1}`) return slots.push({ label, at, gap: `is the record's ${stage.stage} at this place` });
      const entries = equip.itemCost?.[String(j + 1)];
      if (entries === undefined) return;
      slots.push(slotOf(label, at, entries, nameOf));
    });
  });
  return { region, slots };
}

const valueAt = (record, at) => at.reduce((node, key) => (node == null ? undefined : node[key]), record);

/** Writes one slot's cost into `record` (a clone), making what holds it where the record lacks it. */
function put(record, { label, at, want }) {
  const cost = structuredClone(want);
  if (at[0] === 'promotion') {
    if (!Array.isArray(record.promotion)) record.promotion = [];
    const index = at[1];
    // A promotion the record does not list yet, in the shape the catalogue gives a new operator's.
    record.promotion[index] ??= { tier: label, upgrades: [], prerequisite: null };
    record.promotion[index].cost = cost;
  } else if (at[1] === 'skillCost') {
    record.skills ??= {};
    record.skills.skillCost = { ...(record.skills.skillCost ?? {}), [at[2]]: cost };
  } else if (at[1] === 'skillList') {
    const skill = record.skills.skillList[at[2]];
    const costs = { ...(skill.cost ?? {}), [at[4]]: cost };
    // m1, m2, m3 in order, as every other record writes them.
    skill.cost = Object.fromEntries([...MASTERIES.filter(key => key in costs).map(key => [key, costs[key]]),
      ...Object.entries(costs).filter(([key]) => !MASTERIES.includes(key))]);
  } else if (at[0] === 'modules') {
    record.modules[at[1]].stages[at[3]].cost = cost;
  } else {
    throw new Error(`No place to write ${label} (${at.join('.')})`);
  }
}

/**
 * One operator's costs, as the tables give them. Returns the record (a new object only when a
 * cost changed), the labels of what was written, and the gaps left as the record has them.
 */
export function syncOperatorCosts(operator, tables) {
  let next = operator;
  const written = [], gaps = [];
  for (const slot of gameCosts(operator, tables).slots) {
    if (slot.gap) { gaps.push({ label: slot.label, why: slot.gap }); continue; }
    if (sameCost(valueAt(next, slot.at), slot.want)) continue;
    if (next === operator) next = structuredClone(operator);
    put(next, slot);
    written.push(slot.label);
  }
  return { operator: next, written, gaps };
}

/** Every cost on the record the tables say otherwise and can be written (the gaps aside), as
 *  { label, record, game }: what the stage would write. Empty once it has run. */
export function costDisagreements(operator, tables) {
  return gameCosts(operator, tables).slots.filter(slot => !slot.gap && !sameCost(valueAt(operator, slot.at), slot.want))
    .map(slot => ({ label: slot.label, record: valueAt(operator, slot.at) ?? null, game: slot.want }));
}

/** One quarantine reason for an operator's gaps, worded the same every run while they last. */
export function gapReason(name, gaps) {
  const byWhy = new Map();
  for (const gap of gaps) byWhy.set(gap.why, [...(byWhy.get(gap.why) ?? []), gap.label]);
  const parts = [...byWhy].map(([why, labels]) => `${labels.join(', ')} ${why}`);
  const many = gaps.length > 1;
  return `${name}'s ${parts.join('; ')}, so ${many ? 'those costs keep' : 'that cost keeps'} what the record had (none, where it had none) until a later run can write the game's.`;
}

const recordFiles = root => fs.readdirSync(path.join(root, 'data')).filter(name => /^operators-\dstar$/.test(name)).sort()
  .flatMap(directory => fs.readdirSync(path.join(root, 'data', directory)).filter(name => name.endsWith('.json')).sort()
    .map(file => path.join(root, 'data', directory, file)));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The disagreements left on the records under root, read from disk: the stage's guard. */
export function verifyOperatorCosts(root, tables) {
  return recordFiles(root).flatMap(file => {
    const record = readJson(file);
    return costDisagreements(record, tables).map(disagreement => ({ operator: record.name, ...disagreement }));
  });
}

/**
 * The stage over every record under root/data/operators-*star: writes each operator's costs,
 * reports the gaps, then reads every record back and fails on any cost that still disagrees.
 * With check, writes nothing and returns what it would write. Returns { written, operators, gaps, disagreements }.
 */
export function runOperatorCosts(root, tables, { now = defaultNow(), check = false, log = console.log } = {}) {
  const stage = check ? null : beginStage(root, STAGE, now);
  let operators = 0, written = 0;
  const disagreements = [], gaps = [];
  for (const file of recordFiles(root)) {
    const record = readJson(file);
    const result = syncOperatorCosts(record, tables);
    if (result.gaps.length) {
      gaps.push({ operator: record.name, gaps: result.gaps });
      stage?.add({ key: `costs:${record.internalName || record.name}`, action: 'published-partial', reason: gapReason(record.name, result.gaps) });
    }
    if (!result.written.length) continue;
    operators++;
    written += result.written.length;
    if (check) {
      disagreements.push(...costDisagreements(record, tables).map(disagreement => ({ operator: record.name, ...disagreement })));
      continue;
    }
    fs.writeFileSync(file, `${JSON.stringify(result.operator, null, 2)}\n`);
    log(`  ${record.name}: ${result.written.join(', ')}`);
  }
  if (!check) {
    const left = verifyOperatorCosts(root, tables);
    if (left.length) {
      throw new Error(`${left.length} cost(s) still disagree with the game's tables after the stage wrote them, which is a bug in sync-operator-costs.mjs:\n`
        + left.map(({ operator, label, record, game }) => `  ${operator} ${label}: ${shown(record)}, the game ${shown(game)}`).join('\n'));
    }
    stage.commit();
    beginStage(root, RETIRED_STAGE, now).commit();
  }
  return { written, operators, gaps, disagreements };
}

/** The tables the stage reads, from an EN excel/ folder and a CN one, with data/material-names.json. */
export function readCostTables(enExcel, cnExcel, materialNames) {
  const read = (dir, file) => {
    const at = path.join(dir, file);
    if (!fs.existsSync(at)) throw new Error(`Missing ${at}. Run scripts/sync/refresh-stage-data.sh first, or point ARKPEDIA_EN / ARKPEDIA_CN at a checkout.`);
    return readJson(at);
  };
  const client = (dir, withSkills) => ({
    characters: read(dir, 'character_table.json'),
    // Only the Global table's skill names are compared; the CN one's are Chinese.
    skills: withSkills ? read(dir, 'skill_table.json') : {},
    modules: read(dir, 'uniequip_table.json'),
    constants: read(dir, 'gamedata_const.json'),
    patch: read(dir, 'char_patch_table.json'),
    items: read(dir, 'item_table.json').items,
  });
  const en = client(enExcel, true), cn = client(cnExcel, false);
  const { nameOf } = materialItems({ enItems: en.items, cnItems: cn.items, names: readMaterialNames(materialNames) });
  return { en, cn, nameOf };
}

function main() {
  const root = process.cwd();
  const check = process.argv.includes('--check');
  const tables = readCostTables(
    path.join(process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata', 'en', 'gamedata', 'excel'),
    path.join(process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource', 'gamedata', 'excel'),
    readJson(path.join(root, 'data/material-names.json')));
  const result = runOperatorCosts(root, tables, { check });
  for (const { operator, gaps } of result.gaps) console.log(`  ! ${gapReason(operator, gaps)}`);
  if (check) {
    for (const { operator, label, record, game } of result.disagreements) console.log(`  ${operator} ${label}: ${shown(record)}, the game ${shown(game)}`);
    console.log(`${result.written} cost(s) on ${result.operators} operator record(s) disagree with the game's tables; ${result.gaps.length} operator(s) with a cost that cannot be written yet.`);
    if (result.written) process.exitCode = 1;
    return;
  }
  console.log(`${result.written} cost(s) written from the game's tables on ${result.operators} operator record(s); ${result.gaps.length} operator(s) keep a cost that cannot be written yet.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
