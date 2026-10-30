import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// @ts-expect-error Build scripts are plain JavaScript.
import { supplyStages, readStageRecords } from '../build/build-supply-stages.mjs';

/*
 * The planner's supply-stages table (data/supply-stages.json, released through
 * lib/content/tables.mjs '/planner') used to be derived from data/stages.json, a scrape of
 * arknights.wiki.gg nothing had rewritten since it was committed, so supply drops could
 * never follow the game. It is derived from the stage records the stage pipeline builds
 * from gamedata now, and must say exactly what it said before.
 */
const committed = JSON.parse(fs.readFileSync('data/supply-stages.json', 'utf8'));

test('the supply table derived from the stage records is the table the planner already had', () => {
  assert.deepEqual(supplyStages(readStageRecords(process.cwd())), committed);
  // Best stage first, per material; and a volume 3 summary only where one drops.
  assert.deepEqual(committed['Skill Summary - 3'], ['CA-5', 'CA-4']);
  assert.deepEqual(committed.LMD, ['CE-6', 'CE-5', 'CE-4', 'CE-3', 'CE-2', 'CE-1']);
});

test('only guaranteed, repeatable drops of the five supply families count', () => {
  const drop = (name: string, kind = 'farmable', rarity = 'Guaranteed') => ({ item: { name }, kind, rarity });
  const record = (code: string, kind: string, drops: unknown[]) => ({ code, content: { kind }, drops });
  assert.deepEqual(supplyStages([
    record('CA-2', 'supply', [drop('Skill Summary - 1'), drop('Skill Summary - 2', 'farmable', 'Rare')]),
    record('CA-1', 'supply', [drop('Skill Summary - 1'), drop('Originite Prime', 'one_time')]),
    // A supply family's code on another kind of content is not a supply stage.
    record('CA-9', 'event', [drop('Skill Summary - 1')]),
    // Nor is another code on the supply content (the chip stages have their own page).
    record('PR-A-1', 'supply', [drop('Defender Chip')]),
  ]), { 'Skill Summary - 1': ['CA-2', 'CA-1'] });
});

test('nothing builds the planner table from the wiki scrape any more', () => {
  assert.equal(fs.existsSync('data/stages.json'), false);
  assert.doesNotMatch(fs.readFileSync('scripts/build/build-supply-stages.mjs', 'utf8'), /['"]stages\.json['"]|data\/stages\.json['"`]/);
  // It reads what the stage build writes, so the refresh runs it after that build.
  assert.match(fs.readFileSync('scripts/sync/refresh-stage-data.sh', 'utf8'), /\nstage supply-stages --needs stage-dataset -- node scripts\/build\/build-supply-stages\.mjs\n/);
});
