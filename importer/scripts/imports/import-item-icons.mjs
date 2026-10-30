#!/usr/bin/env node
/**
 * Maps the item icons the stage drops reference, writing data/item-icons.json from the
 * gamedata item id to the file name under item-icons/ in arkpedia-image-assets.
 *
 * TWO NAMING SCHEMES, and this step must not choose between them. The CN repo's
 * item/ tree names EVENT TOKEN icons after the gamedata item id
 * ("act43side_token_phantom.png"), which is the id a drop record carries. It does
 * NOT hold the core material icons: there is no 2001.png anywhere in it. Those
 * arrived slug-named ("drill_battle_record.png") from a source this repo no longer
 * pulls, and they are published as item-icons/<slug>.png.
 *
 * So this is ADDITIVE. It keeps every mapping whose file is still published and adds
 * whatever it can newly map. Rebuilding the map from scratch is what it used to do,
 * and that silently dropped 129 material icons the moment the old source went away
 * -- a refresh should not be able to delete data it cannot reproduce.
 *
 * NOTHING HERE PUBLISHES. Art reaches readers only through arkpedia-image-assets, and a
 * file in this repository's public/ is refused by check:assets, which the daily release
 * runs: copying a new event token's icon there turned every new token into a blocked
 * release. An icon the CN repo has but the image repository does not is staged in
 * .cache/item-icons/ instead (scripts/lib/staged-art.mjs), the game's 183px circled art as
 * the mirror serves it; the release's staged-art stage publishes it as item-icons/<id>.png
 * and runs this again, which maps it. Until a run does, it stays out of
 * data/item-icons.json -- its drops render the blank frame -- and is reported under
 * 'item-icons' with the path it must be published at.
 *
 * Operator drops are not here: those are first-clear operator rewards and use
 * the operator's own portrait, resolved through lib/operators/operatorIcon.ts.
 *
 * Re-run after regenerating the dataset:  node scripts/imports/import-item-icons.mjs
 */
import fs from 'fs';
import path from 'path';
import { beginStage } from '../lib/quarantine.mjs';
import { beginStaging } from '../lib/staged-art.mjs';
import { pinnedRef } from '../content/pin-upstream.mjs';

const root = process.cwd();
const upstream = process.env.ARKPEDIA_CN || '.cache/upstream/cn-resource';
const MIRROR = 'yuanyan3060/ArknightsGameResource';
// The checkout above is at this commit (scripts/lib/upstream.sh); it names each icon's source.
const COMMIT = pinnedRef(MIRROR);
const SOURCE = `https://raw.githubusercontent.com/${MIRROR}/${COMMIT}/item`;
// No manifest needed: the resource repo names item icons by the gamedata item id,
// which is the id a drop record already carries. Never public/: see the header.
const staging = beginStaging('item-icons', root);
const stagesDir = path.join(root, 'data', 'stages');

const wanted = new Map(); // item id -> display name
for (const file of fs.readdirSync(stagesDir)) {
  if (!file.endsWith('.json')) continue;
  const rec = JSON.parse(fs.readFileSync(path.join(stagesDir, file), 'utf-8'));
  for (const drop of rec.drops || []) {
    const item = drop.item;
    if (item && !item.is_operator) wanted.set(item.id, item.name);
  }
}

// What the image repository publishes, and only that: a mapping to anything else is a
// blank square on the page.
const index = JSON.parse(fs.readFileSync(path.join(root, 'data', 'assets', 'external-asset-index.json'), 'utf-8'));
const published = new Set(index.files.filter((file) => /^item-icons\/[^/]+$/.test(file)).map((file) => file.slice('item-icons/'.length)));

// Start from what is already mapped, keeping only entries whose file is published.
const mapFile = path.join(root, 'data', 'item-icons.json');
const existing = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf-8')) : {};
const map = {};
let kept = 0;
for (const [id, file] of Object.entries(existing)) {
  if (published.has(file)) { map[id] = file; kept++; }
}
const added = [];
const staged = [];
const missing = [];
for (const [id, name] of wanted) {
  if (map[id]) continue;                       // already have one; leave it alone
  const base = `${id}.png`;
  // Published since the last run (by hand or by the image sync): map it.
  if (published.has(base)) { map[id] = base; added.push(id); continue; }
  const src = path.join(upstream, 'item', base);
  if (!fs.existsSync(src)) {
    missing.push(`${id} (${name})`);
    continue;
  }
  staging.stage(`item-icons/${base}`, fs.readFileSync(src), {
    source: `${SOURCE}/${base}`,
    mirror: /^[0-9a-f]{40}$/.test(COMMIT) ? { repository: MIRROR, path: `item/${base}`, commit: COMMIT } : undefined,
  });
  staged.push([id, name]);
}
staging.commit();

// Sorted, so the file does not churn on iteration order.
const ordered = Object.fromEntries(Object.keys(map).sort().map((id) => [id, map[id]]));
fs.writeFileSync(mapFile, JSON.stringify(ordered, null, 0));
console.log(`${Object.keys(ordered).length} item icons (${kept} already mapped, ${added.length} newly mapped, ${staged.length} staged in .cache/item-icons/ for arkpedia-image-assets)`);
console.log(`${missing.length} drop items have no icon in either source (furniture and event coins, mostly)`);
if (missing.length) console.log('  e.g. ' + missing.slice(0, 5).join(', '));
// Reported every run, even with nothing staged: that is what clears an icon once it is published.
const alerts = beginStage(root, 'item-icons');
for (const [id, name] of staged) {
  alerts.add({ key: `item-icon:${id}`, action: 'published-partial', sourceRef: `${SOURCE}/${id}.png`,
    reason: `The drop ${name} (${id}) has an icon in the CN resource repo, staged as .cache/item-icons/${id}.png, but no run has published it `
      + `to arkpedia-image-assets as item-icons/${id}.png yet; its drops render without one until one does.` });
}
for (const entry of alerts.commit()) console.warn(`  ! ${entry.key} (${entry.action}): ${entry.reason}`);
