#!/usr/bin/env node
/**
 * Writes data/material-catalogue.json: every material the planner can hold, in the order it
 * resolves and lists them, grouped the way its depot shows them.
 *
 * This was a hand-typed list (lib/farming/materialSortOrder.ts). It missed four materials that
 * operators already cost -- Liquified Ether Absorber, Concentrated Power Unit, Electrode Unit
 * and Liquified High-Energy Gas, which Closure, Crackborne and Kal'tsit - Esperanta need on
 * Global from 2026-10-14 -- and a new material needed a code change and a redeploy. It is
 * derived now, as a release table (lib/content/tables.mjs), so it lands with the data.
 *
 * WHAT IS HOLDABLE. Whatever a plan can ask for, and nothing it cannot: a depot tile for an
 * item no plan ever subtracts from is a box asking for a number for nothing.
 *   - every material an operator's promotions, skill ranks, masteries and modules cost (not
 *     potential tokens, which the planner does not plan);
 *   - the battle records, which is how the planner pays EXP (data/battle-records.json);
 *   - every ingredient of a Workshop or Factory recipe (data/base-formulas.json) for something
 *     already holdable, so a craft the plan suggests never needs something nobody can enter;
 *   - SPENT_CURRENCIES below.
 * EXP leads the list as a number, not an item.
 *
 * WHAT IS KNOWN ABOUT EACH comes from the game's item tables (EN, then CN for what Global has not
 * shipped yet, with data/material-names.json for those items' English names;
 * scripts/lib/material-items.mjs). It must have a published material icon, or its tile could
 * not draw, and a place in the depot's in-game order (data/item-sort-ids.json, which /planner's
 * table loader otherwise refuses at export). One that fails any of these is left out and named
 * here; check-completeness then holds back the operators that cost it (published-partial), and
 * /planner leaves them out of its picker until it resolves.
 *
 * ORDER AND GROUPS follow from the item: its tier is its rarity, its kind its id. Highest tier
 * first, which the crafting resolver relies on (lib/planner/craft.ts: a Tier 3 and a Tier 4
 * target can want the same Tier 2 ingredient, and the higher tier has to win); within a tier,
 * the game's own depot order.
 *
 * Inputs: the EN and CN item tables (ARKPEDIA_EN, ARKPEDIA_CN, as for the other importers), the
 * operator records, data/base-formulas.json, data/battle-records.json, data/item-sort-ids.json,
 * data/material-names.json and the published asset index. Run after the refresh (prepare-content's material-catalogue
 * stage), or by hand:  node scripts/build/build-material-catalogue.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetFileNames } from '../lib/public-assets.mjs';
import { iconStem, itemTier, materialItems, readMaterialNames } from '../lib/material-items.mjs';
import { checkMaterialCatalogue, plannerCostNames } from '../../lib/farming/materialCatalogue.mjs';

/**
 * Held although no bill names them. Each needs a reason a plan can ask for it.
 * Purchase Certificate buys the Chip Catalyst (CERTIFICATE_STORE in lib/planner/sources.ts),
 * the one Dualchip ingredient nothing drops and no bench makes. A certificate is SPENT, which is
 * why it sits with LMD rather than with the chips.
 */
export const SPENT_CURRENCIES = ['Purchase Certificate'];

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The kind of material an item is, from its id and type. */
function kindOf(id, item) {
  if (item?.itemType === 'GOLD') return 'lmd';
  if (item?.itemType === 'CARD_EXP') return 'record';
  if (/^32\d{2,3}$/.test(id)) return 'chip';
  if (/^330\d$/.test(id)) return 'summary';
  if (/^mod_/.test(id)) return 'module';
  if (/^3[01]\d{3}$/.test(id)) return 'tiered';
  return 'other';
}

/**
 * The catalogue, and what was left out of it and why. Pure: every input is handed in.
 *   enItems, cnItems   item_table.items of each client
 *   names              data/material-names.json
 *   operators          every operator record
 *   formulas           data/base-formulas.json
 *   battleRecords      data/battle-records.json, largest first
 *   sortIds            data/item-sort-ids.json: each material's place in the game's depot
 *   icons              material-icons/ file names that are published
 */
export function buildMaterialCatalogue({ enItems, cnItems, names, operators, formulas, battleRecords, sortIds, icons }) {
  const items = materialItems({ enItems, cnItems, names });
  const published = new Set([...icons].map(file => file.replace(/\.webp$/, '')));
  const wanted = new Map();
  const want = (name, why) => { if (name && name !== 'EXP' && !wanted.has(name)) wanted.set(name, why); };
  for (const op of operators) for (const name of plannerCostNames(op)) want(name, `${op.name}'s costs`);
  for (const record of battleRecords) want(record.name, 'pays EXP');
  for (const name of SPENT_CURRENCIES) want(name, 'buys the Chip Catalyst');
  // Ingredients of whatever is holdable, until nothing new turns up.
  for (let grew = true; grew;) {
    grew = false;
    for (const [product, recipe] of Object.entries(formulas)) {
      if (!wanted.has(product)) continue;
      for (const cost of [...(recipe.costs ?? []), ...(recipe.alternatives ?? []).flatMap(alt => alt.costs ?? [])]) {
        if (!wanted.has(cost.name) && cost.name !== 'EXP') { want(cost.name, `an ingredient of ${product}`); grew = true; }
      }
    }
  }

  const noItem = [], noIcon = [], noSortId = [], other = [];
  const rows = [];
  for (const [name, why] of wanted) {
    const id = items.idOf(name);
    if (!id) { noItem.push(`${name} (${why})`); continue; }
    if (!published.has(iconStem(name))) { noIcon.push(`${name} (${why})`); continue; }
    if (typeof sortIds[name] !== 'number') { noSortId.push(`${name} (${why})`); continue; }
    const item = items.item(id);
    const kind = kindOf(id, item);
    if (kind === 'other' && !SPENT_CURRENCIES.includes(name)) other.push(name);
    rows.push({ name, id, kind: SPENT_CURRENCIES.includes(name) ? 'certificate' : kind, tier: itemTier(item) ?? 0,
      sortId: sortIds[name], client: enItems?.[id] ? 'EN' : 'CN' });
  }
  const recordRank = new Map(battleRecords.map((record, i) => [record.name, i]));
  const of = kind => rows.filter(row => row.kind === kind);
  const byGame = (a, b) => a.sortId - b.sortId || byCodeUnit(a.name, b.name);
  // The chip ladder, highest first -- Dualchip, Chip Pack, Chip -- each by class, with the
  // Catalyst leading: it is what a Dualchip needs beside two Packs, not a rung of the ladder.
  const chips = of('chip').sort((a, b) => Number(b.id === '32001') - Number(a.id === '32001') || b.tier - a.tier || byCodeUnit(a.name, b.name));
  const records = of('record').sort((a, b) => (recordRank.get(a.name) ?? Infinity) - (recordRank.get(b.name) ?? Infinity) || byGame(a, b));
  const summaries = of('summary').sort((a, b) => b.tier - a.tier || byGame(a, b));
  const modules = of('module').sort((a, b) => byCodeUnit(a.id, b.id));
  const tiers = [5, 4, 3, 2, 1].map(tier => ({ tier, rows: of('tiered').filter(row => row.tier === tier).sort(byGame) }));
  const strays = [...of('other'), ...of('tiered').filter(row => row.tier < 1 || row.tier > 5)].sort(byGame);
  const names_ = list => list.map(row => row.name);
  const currency = [...of('lmd'), ...of('certificate'), ...records, ...chips];
  const catalogue = {
    version: 1,
    order: ['EXP', ...names_(currency), ...names_(summaries), ...names_(modules), ...tiers.flatMap(t => names_(t.rows)), ...names_(strays)],
    groups: [
      { tag: 'Skills & modules', names: names_([...summaries, ...modules]) },
      { tag: 'Currency, records & chips', names: names_(currency) },
      ...tiers.map(t => ({ tag: `Tier ${t.tier}`, names: names_(t.rows) })),
      { tag: 'Other', names: names_(strays) },
    ].filter(group => group.names.length),
    items: Object.fromEntries(rows.sort((a, b) => byCodeUnit(a.name, b.name)).map(row => [row.name, { itemId: row.id, tier: row.tier, client: row.client }])),
  };
  return { catalogue: checkMaterialCatalogue(catalogue), noItem, noIcon, noSortId, other, spent: items.spentNames() };
}

function main() {
  const root = process.cwd();
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const enExcel = path.join(process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata', 'en', 'gamedata', 'excel');
  const cnExcel = path.join(process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource', 'gamedata', 'excel');
  const table = (dir, required) => {
    const file = path.join(dir, 'item_table.json');
    if (!fs.existsSync(file)) {
      if (required) throw new Error(`Missing ${file}. Run scripts/sync/refresh-stage-data.sh first, or point ARKPEDIA_EN at a checkout.`);
      console.warn(`No CN item table at ${file}: materials Global has not shipped keep no place in the catalogue this run.`);
      return {};
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')).items;
  };
  const operators = fs.readdirSync(path.join(root, 'data')).filter(dir => /^operators-\dstar$/.test(dir))
    .flatMap(dir => fs.readdirSync(path.join(root, 'data', dir)).filter(file => file.endsWith('.json')).sort().map(file => read(`data/${dir}/${file}`)));
  const { catalogue, noItem, noIcon, noSortId, other, spent } = buildMaterialCatalogue({
    enItems: table(enExcel, true), cnItems: table(cnExcel, false), names: readMaterialNames(read('data/material-names.json')),
    operators, formulas: read('data/base-formulas.json'), battleRecords: read('data/battle-records.json'),
    sortIds: read('data/item-sort-ids.json'), icons: assetFileNames('material-icons', root),
  });
  // A table a third of its usual size is a source that changed shape, not a game that lost
  // materials: refuse it, and the stage keeps yesterday's (run-stage.mjs).
  if (catalogue.order.length < 80) throw new Error(`Refusing to write a catalogue of ${catalogue.order.length} materials; fewer than 80 means an input changed shape.`);
  fs.writeFileSync(path.join(root, 'data', 'material-catalogue.json'), `${JSON.stringify(catalogue, null, 2)}\n`);
  console.log(`Wrote ${catalogue.order.length - 1} holdable materials in ${catalogue.groups.length} groups -> data/material-catalogue.json`);
  // Reported, not fatal: check-completeness holds back the operators that cost them.
  if (noItem.length) console.warn(`No item id for ${noItem.length} (add the English name to data/material-names.json in arkpedia-data):\n  ${noItem.join('\n  ')}`);
  if (noIcon.length) console.warn(`No published material icon for ${noIcon.length} (the image repository has to add them):\n  ${noIcon.join('\n  ')}`);
  if (noSortId.length) console.warn(`No place in data/item-sort-ids.json for ${noSortId.length} (the ingame-order stage has to run first):\n  ${noSortId.join('\n  ')}`);
  if (other.length) console.warn(`Of no known kind, listed under Other: ${other.join(', ')}`);
  for (const { id, name, en } of spent) {
    console.warn(name === en
      ? `data/material-names.json: ${id} (${name}) is in the EN client now; the entry can go.`
      : `data/material-names.json: ${id} is "${en}" in the EN client, not "${name}". The planner holds what the records spell; once operator-english renames them, the icon has to be published under "${en}" too.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
