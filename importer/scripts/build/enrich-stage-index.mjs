#!/usr/bin/env node
/**
 * Adds `variantOf` to every row of public/stages-index.json: the slug of the
 * stage this one is a Challenge Mode / Adverse Environment / Story / 6-star
 * form OF, or null.
 *
 * The link lives in each stage record as variant.of_stage_id, which names the
 * base stage's gamedata id -- not its slug and not its code -- so resolving it
 * needs the whole set of stage records read once. The index is what the stage
 * list reads, and the list needs the link to show one row per stage rather than
 * one per form: 968 of the 4,130 rows are variants.
 *
 * Grouping by (contentId, code) instead was tried and is wrong: 169 of those
 * groups hold more than one base stage, and the ones where code is null hold up
 * to 145 unrelated stages.
 *
 * Also fills in the names the source leaves blank on the 140 Integrated
 * Strategies replacer levels, from data/is-nodes.json -- the rail fetches this
 * file directly, so a name resolved only server-side would come back blank the
 * moment the full index arrived.
 *
 * And it drops the stages of the limited-time game modes listed in
 * data/excluded-contents.json -- this file is the one place both the build and
 * the rail read the roster from, so removing a row here removes the stage from
 * the list, from the filter's counts and from the pages that get built.
 *
 * Run after scripts/build/build-mode-exclusions.mjs and scripts/imports/import_is_nodes.py, and
 * after regenerating the dataset:
 *   node scripts/build/enrich-stage-index.mjs
 */
import fs from 'fs';
import path from 'path';
import { INDEX_EXCLUDED_TYPES as EXCLUDED_TYPES } from '../stage-pipeline/lib/coverage.mjs';

const root = process.cwd();
const indexPath = path.join(root, 'public', 'stages-index.json');
const stagesDir = path.join(root, 'data', 'stages');

const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
const nodesPath = path.join(root, 'data', 'is-nodes.json');
const isNodes = fs.existsSync(nodesPath) ? JSON.parse(fs.readFileSync(nodesPath, 'utf-8')) : {};
const excludedPath = path.join(root, 'data', 'excluded-contents.json');
const excluded = fs.existsSync(excludedPath) ? JSON.parse(fs.readFileSync(excludedPath, 'utf-8')) : {};
const ccPath = path.join(root, 'data', 'cc-stages.json');
const ccStages = fs.existsSync(ccPath) ? JSON.parse(fs.readFileSync(ccPath, 'utf-8')) : {};
const contents = JSON.parse(fs.readFileSync(path.join(root, 'data', 'stages-content.json'), 'utf-8'));
const slugOfId = new Map();
const ofIdBySlug = new Map();
// Per-content facts gathered while every record is open anyway -- see the write-out.
const mapped = new Set();
const seenContent = new Set();
const ministory = new Set();

for (const file of fs.readdirSync(stagesDir)) {
  if (!file.endsWith('.json')) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(stagesDir, file), 'utf-8'));
  if (rec.id) slugOfId.set(rec.id, rec.slug);
  if (rec.variant && rec.variant.of_stage_id) ofIdBySlug.set(rec.slug, rec.variant.of_stage_id);
  const contentId = rec.content && rec.content.id;
  if (contentId) {
    seenContent.add(contentId);
    if (rec.geometry || rec.preview) mapped.add(contentId);
    if (rec.event && rec.event.type === 'ministory') ministory.add(contentId);
  }
}

/**
 * data/content-traits.json: two facts per content that only the whole record set can
 * answer. Contents with neither are left out, so the file lists 35 of the 166.
 *
 * `mapless` -- NOT ONE of its stages has a map. The Global client keeps a stage's level
 * file only while there is some way to play it there, so fifteen contents (eleven events
 * from 2020-2024 and Trials for Navigator #1-#4) had none until the stage build learned
 * to read the CN client's copy (scripts/stage-pipeline/lib/gamedata.mjs). Rehearsed on
 * the 2026-09-25 pins that leaves one, Operational Intelligence, which neither mirror
 * carries: no interactive map, no render and no enemy list -- what survives is the
 * code, the name, the sanity and the drops. A card for one is a link to a page with no
 * map on it, which is what a reader clicking a stage card is after, so those cards say
 * so instead of leading somewhere disappointing.
 *
 * `ministory` -- the game's own word for it (activity_table files these under
 * MINISTORY, and their posters carry "[Story Collection]"). Twenty contents: the small
 * events that brought no new enemies and no new mechanic, and that never come back.
 * Nothing about the record set says that outright, which is the point of reading the
 * game's own classification instead of guessing from a stage count.
 *
 * Both are written here because this is the one step that already reads every record,
 * and because both are questions about the SET rather than about any one file: a
 * content is only mapless once all of its stages have been seen.
 */
const traits = {};
for (const id of [...seenContent].sort()) {
  const trait = {};
  if (!mapped.has(id)) trait.mapless = true;
  if (ministory.has(id)) trait.ministory = true;
  if (Object.keys(trait).length) traits[id] = trait;
}
fs.writeFileSync(path.join(root, 'data', 'content-traits.json'), JSON.stringify(traits));

let linked = 0;
let alone = 0;
let named = 0;
for (const row of index) {
  const ofId = ofIdBySlug.get(row.slug);
  const base = ofId ? slugOfId.get(ofId) : null;
  row.variantOf = base && base !== row.slug ? base : null;
  if (row.variant) {
    if (row.variantOf) linked += 1;
    else alone += 1;
  }
  if (!String(row.name || '').trim() && isNodes[row.slug] && isNodes[row.slug].name) {
    row.name = isNodes[row.slug].name;
    named += 1;
  }
  // A CCB stage has no stage record to carry a code or a name; both are built in
  // scripts/import_cc_stages.py.
  const cc = ccStages[row.slug];
  if (cc) {
    if (!String(row.code || '').trim() && cc.code) row.code = cc.code;
    if (!String(row.name || '').trim() && cc.name) {
      row.name = cc.name;
      named += 1;
    }
  }
  // The label mirrors data/stages-content.json, so a correction there (CC#1 ->
  // CCB#1) reaches the list without the index having to be regenerated.
  const content = contents[row.contentId];
  if (content && (content.label || '') !== (row.contentLabel || '')) row.contentLabel = content.label || null;
}

/** Stage types dropped whole. The 10 Vignette stages (special_story) are pure
 *  story nodes: no geometry, no enemy roster, no drops and no sanity cost, so
 *  every section of a stage page is empty for them. They also share their
 *  chapters with real stages, which is why they cannot be excluded by content the
 *  way the game modes are. */

/** The fields anything actually reads -- the rail, the sort, the groups and the
 *  sibling lookup. The other ten (chapter, zoneId, zoneGroup, zoneType, sanity,
 *  recommended, tier, enemyTotal, hasGeometry, preview) are read by nothing, and
 *  every visitor fetches this file: dropping them takes it from 1.81MB to 1.01MB.
 *  A stage's own record still carries all of them for its page. */
const INDEX_FIELDS = [
  'slug', 'code', 'name', 'stageType', 'variant', 'variantOf',
  'contentId', 'contentLabel', 'contentName', 'order', 'hasBoss', 'zoneName',
];

const kept = index
  .filter((row) => !excluded[row.contentId] && !EXCLUDED_TYPES.has(row.stageType))
  .map((row) => {
    const slim = {};
    for (const field of INDEX_FIELDS) if (row[field] !== undefined) slim[field] = row[field];
    return slim;
  });
fs.writeFileSync(indexPath, JSON.stringify(kept));
console.log(`${Object.keys(traits).length} contents carry a trait: `
  + `${[...seenContent].filter((id) => !mapped.has(id)).length} with no map in any stage, `
  + `${ministory.size} filed by the game as MINISTORY`);
console.log(
  `${kept.length} rows written, holding to ${Object.keys(excluded).length} excluded contents ` +
    `and ${EXCLUDED_TYPES.size} excluded type(s); ` +
    `${linked} variants linked to a base, ` +
    `${alone} left standing alone (no of_stage_id in the source); ` +
    `${named} unnamed stages took their node's name`
);
