import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/*
 * build-mode-exclusions.mjs used to keep its excluded activity types in a Set, so a new mode
 * (a MULTIPLAY_V4) was listed as an ordinary event, with no alert. They are data/game-modes.json
 * now, and a type nobody has classified is held rather than quietly shipped. What the site then
 * reads out of that record is held by arkpedia-app's own scripts/tests/test-game-modes.ts.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('build-mode-exclusions excludes by the record and holds an unclassified mode and a mislabelled challenge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-modes-'));
  try {
    const write = (file: string, value: unknown) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), JSON.stringify(value));
    };
    write('en/gamedata/excel/activity_table.json', { basicInfo: {
      act99side: { type: 'TYPE_ACT99SIDE' },
      act9multi: { type: 'MULTIPLAY_V4' },
      act7bossrush: { type: 'BOSS_RUSH' },
      act8bossrush: { type: 'BOSS_RUSH' },
      act1lock: { type: 'INTERLOCK' },
      act3mainss: { type: 'TYPE_MAINSS' },
    } });
    write('data/stages-content.json', {
      act99side: { kind: 'event', name: 'A Side Story', label: 'SS' },
      act9multi: { kind: 'event', name: 'A New Mode', label: '' },
      act7bossrush: { kind: 'event', name: 'Trials #7', label: 'TX' },
      act8bossrush: { kind: 'event', name: 'Trials #8', label: 'TN' },
      act1lock: { kind: 'event', name: 'Hymnoi Wisdom', label: '' },
      // Main-story kind: not listed as an event, so an unclassified type is not held.
      act3mainss_zone1: { kind: 'story', name: 'A Main Story Side', label: '' },
      guide_1: { kind: 'guide', name: '???', label: '' },
    });
    write('data/stages/level_act1lock_a-01.json', { content: { id: 'act1lock' } });
    write('data/stages/level_act1lock_a-02.json', { content: { id: 'act1lock' } });
    fs.copyFileSync(path.join(REPO, 'data/game-modes.json'), path.join(root, 'data/game-modes.json'));
    const run = spawnSync(process.execPath, [path.join(REPO, 'scripts/build/build-mode-exclusions.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ARKPEDIA_EN: path.join(root, 'en'), ARKPEDIA_NOW: '2026-09-26T00:00:00Z' },
    });
    assert.equal(run.status, 0, run.stderr);
    const excluded = JSON.parse(fs.readFileSync(path.join(root, 'data/excluded-contents.json'), 'utf8'));
    assert.deepEqual(excluded, {
      act1lock: { name: 'Hymnoi Wisdom', type: 'INTERLOCK', stages: 2 },
      guide_1: { name: '???', type: 'guide', stages: 0 },
    });
    const held = JSON.parse(fs.readFileSync(path.join(root, 'data/quarantine.json'), 'utf8')).entries;
    assert.deepEqual(held.map((e: { key: string; stage: string; action: string }) => [e.stage, e.key, e.action]), [
      ['mode-exclusions', 'activity-type:act9multi', 'published-partial'],
      ['mode-exclusions', 'challenge-label:act7bossrush', 'published-partial'],
    ]);
    // The reason names the type, so the daily issue says what to classify.
    assert.match(held[0].reason, /MULTIPLAY_V4/);
    assert.match(run.stderr, /activity-type:act9multi/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
