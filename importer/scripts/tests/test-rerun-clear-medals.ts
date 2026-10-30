import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
// @ts-expect-error the build script is plain JavaScript without a declaration file
import { buildRerunClearMedals, ALL_STAGES_THREE_STARS } from '../build/build-rerun-clear-medals.mjs';
import medals from '../../data/rerun-clear-medals.json';

/* The Pull Planner reads this record to tick a rerun an account has already cleared; the
   application holds that side (arkpedia-app scripts/tests/test-rerun-clear-medals.ts). */

test("data/rerun-clear-medals.json is the published medal catalogue's all-stages medals (the rerun-clear-medals stage)", () => {
  const catalogue = JSON.parse(fs.readFileSync('public/medal-catalogue.json', 'utf8'));
  assert.deepEqual(medals, buildRerunClearMedals(catalogue));
  assert.ok(Object.keys(medals).length >= 39, 'every recent event set has one');
  assert.equal(medals['42side'], 'medal_activity_42side_04', "The Masses' Travels: 'Lateran Newborn'");
  assert.ok(ALL_STAGES_THREE_STARS.test('Complete all stages in [A Glance at the Shrine] with 3-star ratings (excluding tutorials)'));
  assert.ok(!ALL_STAGES_THREE_STARS.test('Complete all stages in [Rest in Peace] on Challenge Mode'));
});
