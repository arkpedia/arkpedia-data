import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

// What the reconciliation itself makes of a Global pool is held by arkpedia-app's own
// scripts/tests/test-global-client-banners.mjs, which runs the same scripts/sync/global-client-banners.mjs.

test('the stage refresh reads announcements before reconciling banners and applying windows', () => {
  const script = fs.readFileSync(new URL('../sync/refresh-stage-data.sh', import.meta.url), 'utf8');
  const news = script.indexOf('stage official-news --'), banners = script.indexOf('stage recurring-banners --'), windows = script.indexOf('stage event-windows --');
  assert.ok(news >= 0 && news < banners && banners < windows);
  assert.equal(script.match(/stage official-news --/g).length, 1);
});
