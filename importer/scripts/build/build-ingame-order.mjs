#!/usr/bin/env node
/**
 * Writes data/item-sort-ids.json: the game's own depot ordering, as a number per
 * material.
 *
 * item_table gives every item a sortId, and that sortId IS the depot screen's order --
 * LMD 10201, Pure Gold 10202, the certificates 10203/4/5, and so on down. It was
 * checked against a transcription of a real depot before this script existed: 96 of
 * the 96 materials that have a sortId came out in exactly the same order. The two the
 * transcription could not show, because the player did not happen to hold them, are
 * placed by it correctly -- Originium Shard at 10003, above LMD, and Recruitment Permit
 * at 40012, between the certificates and the battle records.
 *
 * Only materials the site has art for, which is the same set the depot can hold. That
 * keeps this to a hundred-odd numbers rather than the four thousand items in the table.
 *
 * A material the EN client does not have yet (a CN line ahead of Global) is placed by the CN
 * table, and so is everything else the CN table has: CN is the superset, its order on the
 * materials both clients share is exactly the EN one, and it renumbers to fit a new line in, so
 * mixing the two tables' numbers would interleave them wrongly (scripts/lib/material-items.mjs).
 * The English names of those CN-only items are data/material-names.json.
 *
 * Re-run after an upstream refresh:  node scripts/build/build-ingame-order.mjs
 */
import { assetFileNames } from '../lib/public-assets.mjs';
import { materialItems, readMaterialNames } from '../lib/material-items.mjs';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const upstream = process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata';
const tablePath = path.join(upstream, 'en', 'gamedata', 'excel', 'item_table.json');
if (!fs.existsSync(tablePath)) {
  console.error(
    `Missing ${tablePath}.\nRun scripts/sync/refresh-stage-data.sh to populate .cache/upstream, ` +
    'or point ARKPEDIA_EN at a checkout of ArknightsAssets/ArknightsGamedata.',
  );
  process.exit(1);
}

const items = JSON.parse(fs.readFileSync(tablePath, 'utf-8')).items;
const cnTable = path.join(process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource', 'gamedata', 'excel', 'item_table.json');
const cnItems = fs.existsSync(cnTable) ? JSON.parse(fs.readFileSync(cnTable, 'utf-8')).items : {};
if (!Object.keys(cnItems).length) console.warn(`No CN item table at ${cnTable}: numbering from the EN table alone, and materials Global has not shipped get no place.`);
/* The site's name for an item and back, including the one plural the site spells singular
   (Information Fragment, filed under the singular) and the CN-only lines' English names. The
   first id of a name wins: event reprints reuse a few names, and the original has the lower id
   and the real place in the depot. */
const resolve = materialItems({
  enItems: items, cnItems,
  names: readMaterialNames(JSON.parse(fs.readFileSync(path.join(root, 'data', 'material-names.json'), 'utf-8'))),
});

const stems = assetFileNames('material-icons', root).map((f) => path.parse(f).name);

const out = {};
const unmatched = [];
for (const stem of stems.sort()) {
  const itemId = resolve.idOf(stem);
  const id = itemId ? resolve.sortId(itemId) : null;
  if (id === null) unmatched.push(stem);
  else out[stem] = id;
}

if (!Object.keys(out).length) {
  console.error('Refusing to write an empty map: no material icon matched an item in item_table.');
  process.exit(1);
}

const dest = path.join(root, 'data', 'item-sort-ids.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${Object.keys(out).length} sort ids -> ${path.relative(root, dest)}`);
/* Reported, not fatal. public/material-icons/ holds furniture and event tokens that
   were never planner materials; a name in there with no item_table entry is expected.
   What matters is that nothing in data/material-catalogue.json is missing, which the
   planner's table loader asserts (checkItemSortIds). */
if (unmatched.length) {
  console.log(`  ${unmatched.length} icon(s) with no item_table entry, which is normal for furniture and event tokens:`);
  for (const n of unmatched) console.log(`    ${n}`);
}
