import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * CN-only stages never become records, with one declared exception: the operations of a
 * Contingency Contract Battleplan season CN has run and Global has not (CCB #5, whose
 * three new maps appeared in the CN mirror on 2026-11-01 while its contracts were already
 * published from CN snapshots). The exception must stay exactly that narrow.
 *
 * gamedata.mjs reads ARKPEDIA_EN and ARKPEDIA_CN on first import, so the trees are set up
 * before any import of it.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-battleplan-levels-'));
const en = path.join(root, 'en', 'gamedata');
const cn = path.join(root, 'cn');
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const season = (number: number) => ({ [`crisis_v2_season_${number}_1`]: { seasonId: `crisis_v2_season_${number}_1`, name: 'x', crisisV2SeasonCode: `#${number}`, startTs: number } });
write(path.join(en, 'excel', 'crisis_v2_table.json'), { seasonInfoDataMap: { ...season(3), ...season(4) } });
write(path.join(cn, 'gamedata', 'excel', 'crisis_v2_table.json'), { seasonInfoDataMap: { ...season(3), ...season(4), ...season(5) } });
// The CN mirror spells a folder its own way; the lookup must not depend on case.
const cnCrisis = path.join(cn, 'gamedata', 'levels', 'Obt', 'crisis', 'v2');
for (const name of ['level_crisis_v2_04-01', 'level_crisis_v2_05-01', 'level_crisis_v2_05-03', 'level_crisis_v2_06-01']) write(path.join(cnCrisis, `${name}.json`), {});
write(path.join(cn, 'gamedata', 'levels', 'activities', 'act99side', 'level_act99side_01.json'), {});
process.env.ARKPEDIA_EN = en;
process.env.ARKPEDIA_CN = cn;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

// @ts-expect-error The stage pipeline is plain JavaScript.
const levelfiles = () => import('../stage-pipeline/lib/levelfiles.mjs');

test('only the operations of a Battleplan season CN has and Global has not are admitted', async () => {
  const { cnSeasonLevels } = await levelfiles();
  const enLevels = new Set(['obt/crisis/v2/level_crisis_v2_04-01']);
  // Season 4 is Global's, season 6 has no CN season row, and the event level is not a Battleplan operation.
  assert.deepEqual(cnSeasonLevels(enLevels), ['obt/crisis/v2/level_crisis_v2_05-01', 'obt/crisis/v2/level_crisis_v2_05-03']);
});

test('a level the EN mirror already carries is left to the EN mirror', async () => {
  const { cnSeasonLevels } = await levelfiles();
  const enLevels = new Set(['obt/crisis/v2/level_crisis_v2_05-01']);
  assert.deepEqual(cnSeasonLevels(enLevels), ['obt/crisis/v2/level_crisis_v2_05-03']);
});

test('once Global has the season, or without CN tables, nothing CN-only is admitted', async () => {
  const { cnSeasonLevels } = await levelfiles();
  const all = { ...season(3), ...season(4), ...season(5) };
  assert.deepEqual(cnSeasonLevels(new Set(), { enSeasons: all, cnSeasons: all }), []);
  assert.deepEqual(cnSeasonLevels(new Set(), { cnSeasons: null }), []);
  assert.deepEqual(cnSeasonLevels(new Set(), { dir: path.join(root, 'nowhere') }), []);
});
