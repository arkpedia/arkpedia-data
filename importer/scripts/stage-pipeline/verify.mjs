#!/usr/bin/env node
// Checks what this pipeline produces against data/stages/, field by field.
//
// The committed records are the oracle: they were built by the private pipeline
// this one replaces, so agreeing with them field for field is the whole proof.
// Run with field names to narrow it: `node scripts/stage-pipeline/verify.mjs slug zone`.
import fs from 'node:fs';
import path from 'node:path';
import { excel } from './lib/gamedata.mjs';
import { identityFields, stageSlugs, tableOrder, variantParents, hardModeLevels, bossRushTrials, threeStarBonus } from './lib/records.mjs';
import { readActs } from './lib/story.mjs';
import { collect, contentBlocks, contentForStage, levelOwner } from './lib/contents.mjs';
import { releaseDates } from './lib/dates.mjs';
import { levelIds } from './lib/levelfiles.mjs';
import { Rewards, buildDrops } from './lib/drops.mjs';
import { Levels, enemyCatalogue } from './lib/level.mjs';

const ROOT = process.env.ARKPEDIA_ROOT || process.cwd();
const want = process.argv.slice(2);

const stageTable = excel('stage_table');
const stages = stageTable.stages;
// The tiers of a Trials for Navigator trial, which stage_table does not
// distinguish at all -- needed by the slugs as well as by the records.
const trials = bossRushTrials((excel('activity_table').activity || {}).BOSS_RUSH);

const ctx = {
  stages,
  slugs: stageSlugs(stages, trials.tiers),
  order: tableOrder(stages),
  parents: variantParents(stages, stageTable.diffGroupTable || {}, excel('climb_tower_table').towers,
    trials.parents),
  hardModeLevels: hardModeLevels(excel('climb_tower_table').towers),
  trialTiers: trials.tiers,
  zones: excel('zone_table').zones,
  towers: excel('climb_tower_table').towers,
  weekly: excel('zone_table').weeklyAdditionInfo,
  bonus: threeStarBonus(excel('gamedata_const')),
  acts: readActs(excel('chapter_table'), excel('zone_table').mainlineAdditionInfo).acts,
  zoneToActivity: excel('activity_table').zoneToActivity,
  activityInfo: excel('activity_table').basicInfo,
};

const notes = [];
const rewards = new Rewards();
const levels = new Levels(enemyCatalogue());
for (const n of notes) console.log(`  note: ${n}`);

const registry = collect(levelIds());
const blocks = contentBlocks(registry, releaseDates(registry.all()));
const owner = levelOwner(registry);
const known = new Set([...registry.all().map((e) => `${e.kind} ${e.id}`), 'guide guide_1']);

const dir = path.join(ROOT, 'data/stages');
const oracle = new Map();
for (const f of fs.readdirSync(dir)) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!('source' in r)) oracle.set(r.id, r);
}

const sig = (v) => JSON.stringify(v === undefined ? null : v);
const mismatch = new Map();
const produced = new Set();
let compared = 0;

for (const [sid, s] of Object.entries(stages)) {
  const expected = oracle.get(sid);
  if (!expected) { (mismatch.get('__missing_from_oracle__') ?? mismatch.set('__missing_from_oracle__', []).get('__missing_from_oracle__')).push([sid]); continue; }
  const mine = identityFields(sid, s, ctx);
  const key = contentForStage(mine, s, owner, known);
  mine.content = key ? blocks.get(key.id) : null;
  const fromLevel = levels.of(s.levelId, s.difficulty);
  mine.battle = fromLevel?.battle ?? null;
  mine.enemies = fromLevel?.enemies ?? null;
  mine.drops = buildDrops(sid, s, rewards);
  compared++;
  for (const [field, value] of Object.entries(mine)) {
    produced.add(field);
    if (want.length && !want.includes(field)) continue;
    if (sig(value) !== sig(expected[field])) {
      if (!mismatch.has(field)) mismatch.set(field, []);
      mismatch.get(field).push([sid, sig(expected[field]), sig(value)]);
    }
  }
}

const fields = [...produced].filter((f) => !want.length || want.includes(f));
console.log(`compared ${compared} table-backed records against the oracle\n`);
let failed = 0;
for (const f of fields) {
  const bad = mismatch.get(f) || [];
  failed += bad.length;
  const flag = bad.length ? `\x1b[31m${String(bad.length).padStart(5)} differ\x1b[0m` : '\x1b[32m    ok\x1b[0m';
  console.log(`  ${f.padEnd(22)} ${flag}`);
  for (const [sid, exp, got] of bad.slice(0, 3)) {
    console.log(`      ${sid}\n        oracle: ${exp.slice(0, 150)}\n        mine  : ${got.slice(0, 150)}`);
  }
}
console.log(failed ? `\n${failed} field mismatches` : '\nevery compared field matches the oracle');
process.exit(failed ? 1 : 0);
