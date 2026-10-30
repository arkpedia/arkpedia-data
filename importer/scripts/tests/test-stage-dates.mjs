import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storyReleaseDate, RELEASED } from '../stage-pipeline/lib/dates.mjs';

test('new Global episodes derive their date without an application allowlist', () => {
  // Global Episode 17's review row in 3aaa25b649fe (2026-10-14).
  assert.equal(storyReleaseDate('EP 17', { main_17: { startShowTime: 1791979200 } }), '2026-10-14');
  assert.equal(storyReleaseDate('EP 28', { main_28: { startShowTime: 1791979200 } }), '2026-10-14');
});

test('legacy corrections survive and an unknown Global date is never invented', () => {
  assert.equal(storyReleaseDate('EP 08', { main_8: { startShowTime: 1604188800 } }), RELEASED.main_8);
  for (const value of [undefined, -1, 0, '1791979200']) {
    assert.equal(storyReleaseDate('EP 17', { main_17: { startShowTime: value } }), null);
  }
  assert.equal(storyReleaseDate('EP 17', {}), null);
  assert.equal(storyReleaseDate('other 17', { main_17: { startShowTime: 1791979200 } }), null);
});
