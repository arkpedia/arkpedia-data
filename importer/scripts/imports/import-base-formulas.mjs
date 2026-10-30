#!/usr/bin/env node
/**
 * Writes data/base-formulas.json: what your BASE can make, in the names the planner
 * already speaks.
 *
 * Two rooms, not one. The Workshop upgrades materials up their tier ladder and trades
 * chips between classes; the Factory makes Dualchips out of Chip Packs, and battle
 * records and Pure Gold out of nothing but time. Both matter to a plan, and telling a
 * reader to visit the Workshop for a Dualchip would send them to the wrong bench.
 *
 * The planner's costs are keyed by ENGLISH MATERIAL NAME, because that is what an
 * operator record carries and what public/material-icons/ is filed under. The
 * gamedata is keyed by item id. So this joins building_data's workshopFormulas to
 * item_table by id and emits names, which is the whole job -- neither side is
 * derivable from the other, and hardcoding the pairing is how a rename becomes a
 * silent miss.
 *
 * It refuses to write a partial file. Every item a formula names must resolve to a
 * name in item_table AND to an icon on disk, or the run fails and says which:
 * getMaterialIconPath builds a path from a name without checking it exists, so a
 * missing icon is a 404 that renders as a blank square and reports nothing. As of
 * writing that is 55 formulas over 75 distinct items, all of them present.
 *
 * It also refuses to write a CYCLE in the families a resolver may walk. This is not
 * hypothetical: F_ASC, the chip line, is entirely cyclic -- "Caster Chip <- 3x Sniper
 * Chip" and "Sniper Chip <- 3x Caster Chip" are both real, because those are the
 * game's class TRADES rather than a tier ladder. Walking them to satisfy a shortfall
 * would either not terminate or would advise burning three of one class's chips to
 * make one of another's, which is not crafting and is not advice. Each entry carries
 * its `type` so a consumer can tell the two apart, and the check below covers the
 * families that are meant to be walked.
 *
 * AHEAD OF GLOBAL, the CN client's recipes fill in what the EN one lacks. A material line CN
 * has added and Global has not (Liquified Ether Absorber and Concentrated Power Unit, made from
 * Liquified High-Energy Gas and Electrode Unit, which Closure and Crackborne cost from
 * 2026-10-14) is otherwise a Tier 4 the planner can never craft. Those recipes come from CN
 * building_data under the same formula keys (the two clients number them alike), named through
 * scripts/lib/material-items.mjs: the EN client's name, else data/material-names.json, else the
 * CN one. A CN recipe that does not fully resolve to published icons is left out and named,
 * rather than failing the whole table, because it describes something Global does not have yet.
 *
 * Re-run after an upstream refresh:  node scripts/imports/import-base-formulas.mjs
 */
import { assetFileNames } from '../lib/public-assets.mjs';
import { materialItems, readMaterialNames } from '../lib/material-items.mjs';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const upstream = process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata';
const excel = path.join(upstream, 'en', 'gamedata', 'excel');

function readTable(name) {
  const file = path.join(excel, name);
  if (!fs.existsSync(file)) {
    console.error(
      `Missing ${file}.\nRun scripts/sync/refresh-stage-data.sh to populate .cache/upstream, ` +
      'or point ARKPEDIA_EN at a checkout of ArknightsAssets/ArknightsGamedata.',
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const building = readTable('building_data.json');
const itemTable = readTable('item_table.json');
const cnExcel = path.join(process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource', 'gamedata', 'excel');
const readCn = (name) => {
  const file = path.join(cnExcel, name);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  console.warn(`No CN ${name} at ${file}: recipes Global has not shipped are left out this run.`);
  return null;
};
const cnBuilding = readCn('building_data.json');
const cnItems = readCn('item_table.json')?.items ?? {};
const names = readMaterialNames(JSON.parse(fs.readFileSync(path.join(root, 'data', 'material-names.json'), 'utf-8')));
const items = materialItems({ enItems: itemTable.items, cnItems, names });
const iconsOnDisk = new Set(assetFileNames('material-icons', root).map((f) => path.parse(f).name));
/** The same fold getMaterialIconPath applies before building a path. */
const iconStem = (n) => n.replace(/[\\/*?:"<>|]/g, '').trim();

/**
 * Which formulas are the planner's business.
 *
 * The table holds four kinds. F_EVOLVE is the material tier ladder (Orirock ->
 * Orirock Cube -> Orirock Cluster), F_ASC is the chip line, F_SKILL the skill
 * summaries -- between them, everything an operator's build can consume.
 *
 * F_BUILDING is the base's own furniture economy: six recipes that all turn one
 * carbon or building material into a Furniture Part. It is excluded because nothing
 * a planner target needs is made of Furniture Parts, and because it is the one place
 * a product has more than one recipe -- which the shape below cannot express and
 * should not silently pick a winner for.
 */
const PLANNER_FORMULA_TYPES = new Set(['F_EVOLVE', 'F_ASC', 'F_SKILL']);
/* The two families a crafting resolver may descend into. Stated here as well as in
   lib/planner/craft.ts on purpose: this file's job is to guarantee they stay safe to
   walk, and it cannot do that without knowing which they are. */
const WALKABLE_TYPES = new Set(['F_EVOLVE', 'F_SKILL']);

const plannerFormulas = (table) => ({
  ...Object.fromEntries(
    Object.entries(table.workshopFormulas || {})
      .filter(([, f]) => PLANNER_FORMULA_TYPES.has(f.formulaType))
      .map(([k, f]) => [`W${k}`, { ...f, room: 'WORKSHOP' }]),
  ),
  /* The Factory's whole table. It is 14 recipes and every one of them is something a
     plan can ask for: eight Dualchips, three battle records, Pure Gold. The four that
     cost nothing are made from LMD and time rather than materials, which is worth
     knowing and not worth hiding. Keys are prefixed because the two tables number
     their formulas from 1 independently. */
  ...Object.fromEntries(
    Object.entries(table.manufactFormulas || {})
      .map(([k, f]) => [`M${k}`, { ...f, room: 'FACTORY', formulaType: 'MANUFACTURE' }]),
  ),
});
const enFormulas = plannerFormulas(building);
const enProducts = new Set(Object.values(enFormulas).map((f) => f.itemId));
/* CN's recipes for products the EN client has no recipe for, under keys it does not use. */
const cnFormulas = Object.fromEntries(Object.entries(cnBuilding ? plannerFormulas(cnBuilding) : {})
  .filter(([k, f]) => !enFormulas[k] && !enProducts.has(f.itemId)));
const formulas = { ...enFormulas, ...cnFormulas };
const problems = [];
const seen = new Map();
/* A CN-only recipe's unresolved names: the recipe is skipped and named, never fatal. */
const aheadOfGlobal = new Map();

function nameOf(id, where, key) {
  const n = items.nameOf(id);
  const fail = (why) => {
    if (key && cnFormulas[key]) aheadOfGlobal.set(key, [...(aheadOfGlobal.get(key) ?? []), why]);
    else problems.push(`${where}: ${why}`);
  };
  if (!n) { fail(`item id ${id} has no name in item_table`); return null; }
  if (!iconsOnDisk.has(iconStem(n))) { fail(`"${n}" has no icon in public/material-icons/`); return null; }
  return n;
}

/* Resolve every CN-only recipe's names first, so one that cannot be named is dropped whole. */
for (const [key, f] of Object.entries(cnFormulas)) {
  for (const id of [f.itemId, ...(Array.isArray(f.costs) ? f.costs : []).map((c) => c.id)]) nameOf(id, `formula ${key}`, key);
}
for (const key of aheadOfGlobal.keys()) delete formulas[key];

const out = {};
for (const [key, f] of Object.entries(formulas)) {
  const where = `formula ${key}`;
  const product = nameOf(f.itemId, where, key);
  if (!product) continue;
  /* One entry per PRODUCT, because that is how the planner asks the question -- "can
     I make an Orirock Cluster". A product CAN have more than one recipe: the Factory
     will trade you an Originium Shard for either 2 Orirock Cube or 1 Device. Those
     fold into `alternatives` rather than overwriting each other or being dropped.
     For a family the resolver actually walks, though, a second recipe means it would
     silently pick one, and that is an error rather than a footnote. */
  if (seen.has(product)) {
    if (WALKABLE_TYPES.has(f.formulaType)) {
      problems.push(`${product}: two ${f.formulaType} recipes (${seen.get(product)} and ${key}); the resolver would pick one in silence`);
    } else {
      out[product].alternatives.push({
        lmd: f.goldCost ?? 0,
        costs: (Array.isArray(f.costs) ? f.costs : [])
          .map((c) => ({ name: nameOf(c.id, `${where} cost`, key), count: c.count }))
          .filter((c) => c.name),
      });
    }
    continue;
  }
  seen.set(product, key);

  out[product] = {
    /* F_EVOLVE is the material tier ladder, F_SKILL the skill summaries -- both
       acyclic, both a real answer to "can I make this from what I have". F_ASC is the
       chip TRADE and MANUFACTURE is the Factory: both kept because they are true and
       worth showing, neither one something a resolver should descend into. */
    type: f.formulaType,
    /* Which bench to stand at. */
    room: f.room,
    /* How many one run yields. Every current formula yields 1, but the field is
       there and a run that yields 2 would halve the cost per unit. */
    count: f.count ?? 1,
    lmd: f.goldCost ?? 0,
    /* The Factory writes `{}` where the Workshop writes `[]` for "no ingredients", so
       neither field can be trusted to be a list without asking. */
    costs: (Array.isArray(f.costs) ? f.costs : [])
      .map((c) => ({ name: nameOf(c.id, `${where} cost`, key), count: c.count }))
      .filter((c) => c.name),
    /* The bonus roll. Not counted toward anything the planner promises -- it is a
       rate, not a yield -- but worth carrying so a UI can say "and sometimes". A
       CN-only recipe's byproduct that cannot be named yet is dropped, not fatal. */
    byproducts: (Array.isArray(f.extraOutcomeGroup) ? f.extraOutcomeGroup : [])
      .map((e) => ({ name: cnFormulas[key] && !(items.nameOf(e.itemId) && iconsOnDisk.has(iconStem(items.nameOf(e.itemId)))) ? null : nameOf(e.itemId, `${where} byproduct`, key), count: e.itemCount, weight: e.weight }))
      .filter((e) => e.name),
    byproductRate: f.extraOutcomeRate ?? 0,
    /* Other ways to make the same thing. Empty for all but the Factory's two
       Originium Shard trades. */
    alternatives: [],
  };
}

/**
 * A crafting resolver walks these depth-first, so a cycle in them is a hang or a
 * stack overflow at request time. Better here, where it can name the loop.
 */
const WALKABLE = WALKABLE_TYPES;
{
  const colour = new Map();
  const walk = (item, stack) => {
    colour.set(item, 'open');
    stack.push(item);
    const rec = out[item];
    if (rec && WALKABLE.has(rec.type)) {
      for (const c of rec.costs) {
        if (colour.get(c.name) === 'open') {
          problems.push(`cycle among walkable formulas: ${stack.slice(stack.indexOf(c.name)).concat(c.name).join(' -> ')}`);
        } else if (!colour.has(c.name)) {
          walk(c.name, stack);
        }
      }
    }
    stack.pop();
    colour.set(item, 'done');
  };
  for (const item of Object.keys(out)) if (!colour.has(item)) walk(item, []);
}

if (problems.length) {
  console.error(`Refusing to write: ${problems.length} unresolved reference(s).`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

/**
 * Battle records, out of the same table, for the same reason.
 *
 * EXP is not a thing you hold -- records are, and the planner turns one into the
 * other. item_table.expItems states each record's value, so it is written here rather
 * than copied into the resolver as four numbers that would then have no way of being
 * wrong out loud.
 */
const records = Object.entries(itemTable.expItems || {})
  .map(([id, e]) => ({ name: nameOf(id, 'expItems'), exp: e.gainExp }))
  .filter((r) => r.name && r.exp > 0)
  /* Largest first: that is the order the greedy conversion spends them in, and
     baking it in here means the consumer cannot get it wrong by iterating an object. */
  .sort((a, b) => b.exp - a.exp);
if (!records.length) problems.push('item_table.expItems is empty -- no battle records to write');

const dest = path.join(root, 'data', 'base-formulas.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
const recordDest = path.join(root, 'data', 'battle-records.json');
fs.writeFileSync(recordDest, JSON.stringify(records, null, 2) + '\n');
const distinct = new Set();
for (const [k, v] of Object.entries(out)) {
  distinct.add(k);
  v.costs.forEach((c) => distinct.add(c.name));
  v.byproducts.forEach((b) => distinct.add(b.name));
}
const byType = {};
for (const v of Object.values(out)) byType[v.type] = (byType[v.type] || 0) + 1;
console.log(
  `Wrote ${Object.keys(out).length} formulas over ${distinct.size} distinct items ` +
  `(${Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(', ')}) -> ${path.relative(root, dest)}`,
);
const fromCn = Object.keys(cnFormulas).filter((k) => formulas[k]);
if (fromCn.length) console.log(`  ${fromCn.length} of them from the CN client, ahead of Global: ${fromCn.map((k) => items.nameOf(formulas[k].itemId)).join(', ')}`);
for (const [key, why] of aheadOfGlobal) console.warn(`  CN recipe ${key} left out until it can be named: ${[...new Set(why)].join('; ')}`);
console.log(`Wrote ${records.length} battle records (${records.map((r) => r.exp).join('/')} EXP) -> ${path.relative(root, recordDest)}`);
