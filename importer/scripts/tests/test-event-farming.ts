import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// @ts-expect-error Node import scripts are plain JavaScript.
import { buildEventFarming } from '../sync/sync-event-farming.mjs';

// What the site shows of these windows is held by arkpedia-app's
// scripts/tests/test-content-completeness.ts, which reads the record this writes.

test('farming importer ignores shop currency, first clears, CN guesses and non-repeatable stages', () => {
  const stage = { stageType: 'ACTIVITY', difficulty: 'NORMAL', canBattleReplay: true, code: 'TEST-8',
    stageDropInfo: { displayRewards: [{ type: 'MATERIAL', id: 'material', dropType: 'NORMAL' },
      { type: 'MATERIAL', id: 'first', dropType: 'COMPLETE' }, { type: 'ACTIVITY_ITEM', id: 'currency', dropType: 'NORMAL' }] } };
  const items = { items: Object.fromEntries(['material', 'first', 'currency'].map(id => [id, { name: id, rarity: 'TIER_3', classifyType: 'MATERIAL' }])) };
  const tables = { stages: { valid: stage, unknown: stage, firstOnly: { ...stage, canBattleReplay: false } },
    stageValidInfo: { valid: { startTs: 100, endTs: 200 }, firstOnly: { startTs: 100, endTs: 200 } } };
  assert.deepEqual(buildEventFarming(tables, items), [{ stageId: 'valid', stage: 'TEST-8', itemId: 'material', material: 'material', startAt: '1970-01-01T00:01:40.000Z', endAt: '1970-01-01T00:03:21.000Z' }]);
});

test('the nightly import runs the farming windows as a stage of its own', () => {
  assert.match(fs.readFileSync('scripts/content/run-imports.sh', 'utf8'), /stage event-farming -- node scripts\/sync\/sync-event-farming\.mjs/);
});
