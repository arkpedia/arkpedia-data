#!/usr/bin/env node
/**
 * Writes data/import-aliases.json: the vocabularies OTHER planners use for a
 * material, resolved to the names this one uses.
 *
 * Three foreign formats can be imported, and between them they name a material
 * two different ways:
 *
 *   - a gamedata itemId ("30012", "mod_unlock_token", "4001") -- Krooster's CSV
 *     and its penguin-stats JSON both key on it;
 *   - an arkgraph code ("M-2-1", "G-4-1", "W-5-1") -- ark-nights' export, which
 *     uses arkgraph's own shorthand rather than the game's ids.
 *
 * Neither is derivable from our English names, so both maps are DERIVED here and
 * committed, the same way data/item-sort-ids.json is: the site must not depend on
 * a network fetch to read a file somebody pastes into a box.
 *
 * It has to agree with the planner's catalogue (data/material-catalogue.json,
 * scripts/build/build-material-catalogue.mjs) about what a material is called, so it
 * reads that table rather than restating it, and it names items the way the other
 * material builders do (scripts/lib/material-items.mjs): the EN client, then
 * data/material-names.json for the CN-only lines Global has not shipped.
 *
 * WHERE THE ARKGRAPH CODES COME FROM. Houdou/arkgraph's scripts/mapping.json is
 * itemId -> code, 97 entries. It is a third-party file and not derivable from
 * anything the game ships -- the letter prefixes are that project's own
 * categorisation (M material, G gold, E experience, C chip, W module token,
 * S skill summary, PC purchase certificate, O other) -- so it is fetched and
 * cached rather than reinvented. That it is the vocabulary ark-nights writes was
 * checked against a real export: its 97 stock keys are exactly the 97 values in
 * this file, no more and no fewer.
 *
 * Re-run after an upstream refresh:  npx tsx scripts/build/build-import-aliases.ts
 */
import fs from 'fs';
import path from 'path';
import { checkMaterialCatalogue, depotNames } from '@/lib/farming/materialCatalogue.mjs';
// @ts-expect-error Plain Node helper shared with the .mjs builders.
import { materialItems, readMaterialNames } from '../lib/material-items.mjs';

const root = process.cwd();
const upstream = process.env.ARKPEDIA_EN || '.cache/upstream/en-gamedata';
const tablePath = path.join(upstream, 'en', 'gamedata', 'excel', 'item_table.json');
const mappingPath = path.join(root, '.cache', 'arkgraph-mapping.json');
const ARKGRAPH_MAPPING_URL =
  'https://raw.githubusercontent.com/Houdou/arkgraph/master/scripts/mapping.json';

if (!fs.existsSync(tablePath)) {
  console.error(
    `Missing ${tablePath}.\nRun scripts/sync/refresh-stage-data.sh to populate .cache/upstream, ` +
    'or point ARKPEDIA_EN at a checkout of the EN gamedata mirror the refresh pins.',
  );
  process.exit(1);
}

/**
 * EXP is a number an operator needs, not a thing you hold, so it has no depot
 * tile, no icon and no place in either map (depotNames leaves it out). Krooster's
 * exports carry a row for it ("EXP,Operator EXP,0,588286") and the importer drops
 * that row by name -- see lib/planner/foreignImport.ts, which says so to the reader
 * rather than counting it as an unknown.
 */
const catalogue = checkMaterialCatalogue(JSON.parse(fs.readFileSync(path.join(root, 'data', 'material-catalogue.json'), 'utf-8')));
const holdable = depotNames(catalogue);

const items = JSON.parse(fs.readFileSync(tablePath, 'utf-8')).items as Record<string, { name: string }>;
const cnTable = path.join(process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource', 'gamedata', 'excel', 'item_table.json');
/* The same resolution as the catalogue's: the EN client's name (first id wins, since
   another planner's export is keyed on the original, lower id), the CN-only lines'
   English names, then the CN client's own. */
const resolve = materialItems({
  enItems: items,
  cnItems: fs.existsSync(cnTable) ? JSON.parse(fs.readFileSync(cnTable, 'utf-8')).items : {},
  names: readMaterialNames(JSON.parse(fs.readFileSync(path.join(root, 'data', 'material-names.json'), 'utf-8'))),
});

const byItemId: Record<string, string> = {};
const noItemId: string[] = [];
for (const name of holdable) {
  const id = resolve.idOf(name);
  if (!id) noItemId.push(name);
  else byItemId[id] = name;
}

/* Fatal, unlike build-ingame-order's equivalent. A material with no itemId is a
   material that silently fails to come across on every import, for everybody,
   with the file looking like it loaded -- exactly the class of wrong answer
   nothing reports. */
if (noItemId.length) {
  console.error(
    `No item_table entry for ${noItemId.length} holdable material(s): ${noItemId.join(', ')}.\n` +
    'Either the game renamed it -- add an alias in scripts/lib/material-items.mjs, as Information ' +
    'Fragment(s) has one -- or a CN-only material needs its English name in data/material-names.json.',
  );
  process.exit(1);
}

async function arkgraphMapping(): Promise<Record<string, string>> {
  if (fs.existsSync(mappingPath)) {
    return JSON.parse(fs.readFileSync(mappingPath, 'utf-8')) as Record<string, string>;
  }
  console.log(`Fetching ${ARKGRAPH_MAPPING_URL}`);
  const res = await fetch(ARKGRAPH_MAPPING_URL, { headers: { 'User-Agent': 'ArkpediaBot/1.0' } });
  if (!res.ok) throw new Error(`arkgraph mapping: HTTP ${res.status}. Cache it at ${mappingPath} by hand.`);
  const text = await res.text();
  JSON.parse(text); // fail here rather than writing a cache of an error page
  fs.mkdirSync(path.dirname(mappingPath), { recursive: true });
  fs.writeFileSync(mappingPath, text);
  return JSON.parse(text) as Record<string, string>;
}

async function main() {
  const mapping = await arkgraphMapping();

  const byArkgraph: Record<string, string> = {};
  /* Codes whose itemId this repo has no material for. Reported, not fatal: arkgraph
     can know a material before any operator here costs it. */
  const unresolvable: string[] = [];
  for (const [id, code] of Object.entries(mapping)) {
    const name = byItemId[id];
    if (name === undefined) unresolvable.push(`${code} (itemId ${id}${resolve.nameOf(id) ? `, "${resolve.nameOf(id)}"` : ', in neither item table'})`);
    else byArkgraph[code] = name;
  }

  /* The shape guard. build-ingame-order refuses to write an empty map; the same
     argument applies to a map that came out a third of its size, which is what a
     third-party file changing shape looks like from here. */
  const FLOOR = 80;
  if (Object.keys(byItemId).length < FLOOR || Object.keys(byArkgraph).length < FLOOR) {
    console.error(
      `Refusing to write: ${Object.keys(byItemId).length} itemIds and ` +
      `${Object.keys(byArkgraph).length} arkgraph codes resolved, and fewer than ${FLOOR} of either ` +
      'means a source changed shape rather than a material being added or removed.',
    );
    process.exit(1);
  }

  const sortKeys = (obj: Record<string, string>) =>
    Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));

  const dest = path.join(root, 'data', 'import-aliases.json');
  fs.writeFileSync(dest, JSON.stringify({
    byItemId: sortKeys(byItemId),
    byArkgraph: sortKeys(byArkgraph),
  }, null, 2) + '\n');

  console.log(
    `Wrote ${Object.keys(byItemId).length} itemIds and ${Object.keys(byArkgraph).length} arkgraph codes ` +
    `for ${holdable.length} holdable materials -> ${path.relative(root, dest)}`,
  );

  const noCode = holdable.filter((name) => !Object.values(byArkgraph).includes(name));
  if (noCode.length) {
    console.log(
      `  ${noCode.length} material(s) with no arkgraph code, so an ark-nights export cannot carry them: ` +
      `${noCode.join(', ')}`,
    );
  }
  if (unresolvable.length) {
    console.log(`  ${unresolvable.length} arkgraph code(s) this repo has no material for, which is normal for CN-only lines:`);
    for (const c of unresolvable) console.log(`    ${c}`);
  }
}

main();
