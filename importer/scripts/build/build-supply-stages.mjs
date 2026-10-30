#!/usr/bin/env node
/**
 * Writes data/supply-stages.json: which permanent supply stage drops which material.
 *
 * The farming guide next door is a curated list of BUILD materials with the efficient
 * stage for each, and it deliberately stops there. It has no entry for a Purchase
 * Certificate, a Skill Summary or a battle record -- none of those is a material an
 * operator costs, and two of them are currencies -- so the planner had nothing to say
 * about where they come from beyond "no listed source".
 *
 * They all come from the permanent supply stages, and the stage dataset records exactly
 * which (data/stages/<slug>.json, built from the game's own stage_table by
 * scripts/stage-pipeline/build.mjs). So this derives the map rather than restating it: no
 * hand-typed stage code to transpose, and it narrows per material instead of per family,
 * which matters. CA-1 through CA-5 all drop a Skill Summary, but only CA-4 and CA-5 drop
 * a volume 3 -- a hand-written "CA-1 to CA-5" against Skill Summary - 3 would have sent a
 * reader to a stage that cannot give them one.
 *
 * It used to read data/stages.json, a scrape of arknights.wiki.gg that nothing had
 * rewritten since it was committed, so the planner's supply table could never follow
 * the game. The records carry the same facts from gamedata, and the output is identical
 * (scripts/tests/test-supply-stages.ts holds it to the committed table).
 *
 * Only GUARANTEED, repeatable drops count. A supply stage's whole point is that it always
 * pays, and a rare side drop or a first-clear reward is not a reason to run one.
 *
 * Re-run after the stage dataset changes:  node scripts/build/build-supply-stages.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The permanent supply families, and nothing else.
 *
 * Not every stage that drops a thing -- that would be the whole game, and a list of
 * ninety places to find an Orirock is not advice. These five are the stages that exist
 * precisely to hand out one resource: LS for EXP, CE for LMD, AP for certificates, CA
 * for skill summaries, SK for building materials.
 */
export const FAMILIES = /^(LS|CE|AP|CA|SK)-([A-Z0-9]+)$/;

/* Best first. Within a family the later stage is the efficient one -- CA-5 gives more
   summaries per run than CA-1 -- so the codes go in descending order and a UI showing
   only the first two or three shows the two or three worth running. */
const rank = (code) => {
  const [, , suffix] = FAMILIES.exec(code);
  const n = Number(suffix);
  return Number.isFinite(n) ? n : suffix.charCodeAt(0);
};

/**
 * {material name: [stage code, best first]} from stage records: the supply content's
 * stages whose code is one of the five families, counting each farmable drop the record
 * marks Guaranteed.
 */
export function supplyStages(records) {
  const byMaterial = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object' || record.content?.kind !== 'supply') continue;
    const code = record.code;
    if (typeof code !== 'string' || !FAMILIES.test(code)) continue;
    for (const drop of Array.isArray(record.drops) ? record.drops : []) {
      if (!drop || drop.kind !== 'farmable' || drop.rarity !== 'Guaranteed') continue;
      const name = drop.item?.name;
      if (typeof name !== 'string' || !name) continue;
      const list = byMaterial.get(name);
      if (!list) byMaterial.set(name, [code]);
      else if (!list.includes(code)) list.push(code);
    }
  }
  const out = {};
  for (const name of [...byMaterial.keys()].sort()) {
    out[name] = byMaterial.get(name).sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
  }
  return out;
}

/** Every stage record under `<root>/data/stages`. */
export function readStageRecords(root) {
  const dir = path.join(root, 'data', 'stages');
  return fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const out = supplyStages(readStageRecords(root));
  if (!Object.keys(out).length) {
    console.error('Refusing to write an empty map: no supply stage in data/stages/ had a guaranteed drop.');
    process.exit(1);
  }
  const dest = path.join(root, 'data', 'supply-stages.json');
  fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(out).length} materials from the supply stages -> ${path.relative(root, dest)}`);
  for (const [name, codes] of Object.entries(out)) console.log(`  ${name.padEnd(26)} ${codes.join(', ')}`);
}
