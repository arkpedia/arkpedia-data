import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * The stage build reads a stage's level file from the CN mirror when the EN mirror has
 * dropped it (scripts/stage-pipeline/lib/gamedata.mjs). Before this, levels came from the
 * EN mirror alone, and 15 contents -- 86 stages, Trials for Navigator #1-#4, Children of
 * Ursus, Vigilo and nine more -- showed "no map data" while the CN mirror the release
 * already pins carried every one of their files. Rehearsed on the 2026-09-25 pins: 186 more
 * maps, and one mapless content left (Operational Intelligence, which no mirror carries).
 *
 * gamedata.mjs reads ARKPEDIA_EN and ARKPEDIA_CN when it is first imported, so the fixture
 * trees are set up before any import of it; node --test runs each file in its own process.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-cn-levels-'));
const en = path.join(root, 'en', 'gamedata');
const cn = path.join(root, 'cn');
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const level = (maxLifePoint: number, refs: unknown[] = []) => ({
  options: { characterLimit: 8, maxLifePoint, initialCost: 10, maxCost: 99, costIncreaseTime: 1 },
  enemyDbRefs: refs,
  waves: [{ fragments: [{ actions: [{ actionType: 'SPAWN', key: 'enemy_1303_mhshep_2_c', count: 2 }] }] }],
});
write(path.join(en, 'excel', 'enemy_handbook_table.json'), { enemyData: {
  enemy_1303_mhshep_2: { name: 'Hornbeast Alpha', enemyIndex: 'MH02', enemyLevel: 'ELITE' },
} });
// Only EN: an ordinary stage.
write(path.join(en, 'levels', 'obt', 'main', 'level_main_01-07.json'), level(3));
// Both: EN wins.
write(path.join(en, 'levels', 'activities', 'act9d0', 'level_act9d0_01.json'), level(10));
write(path.join(cn, 'gamedata', 'levels', 'activities', 'act9d0', 'level_act9d0_01.json'), level(99));
// Only CN, at another case than the stage table cites: a Trials for Navigator #1 stage.
write(path.join(cn, 'gamedata', 'levels', 'Activities', 'ACT1BossRush', 'level_bossrush1_01.json'), level(1, [
  { id: 'enemy_1303_mhshep_2_c', useDb: false, overwrittenData: { name: { m_defined: true, m_value: '角兽' } } },
  { id: 'enemy_9999_nobody', useDb: false, overwrittenData: { name: { m_defined: true, m_value: '无名' } } },
]));
// A level only CN has and no stage names: never a stage of its own.
write(path.join(cn, 'gamedata', 'levels', 'activities', 'act99side', 'level_act99side_01.json'), level(3));
process.env.ARKPEDIA_EN = en;
process.env.ARKPEDIA_CN = cn;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

// @ts-expect-error The stage pipeline is plain JavaScript.
const gamedata = () => import('../stage-pipeline/lib/gamedata.mjs');

test('a stage reads its level from the EN mirror, and from the CN mirror only when EN has dropped it', async () => {
  const { levelFile, readLevelFile } = await gamedata();
  assert.equal(levelFile('Obt/Main/level_main_01-07')?.source, 'en');
  assert.equal(levelFile('activities/act9d0/level_act9d0_01')?.source, 'en', 'EN wins where both mirrors have the file');
  assert.equal(readLevelFile('activities/act9d0/level_act9d0_01')?.level.options.maxLifePoint, 10);
  // The stage table cites it in lower case; the CN mirror spells the folders otherwise.
  const cnOnly = levelFile('activities/act1bossrush/level_bossrush1_01');
  assert.equal(cnOnly?.source, 'cn');
  assert.equal(readLevelFile('ACTIVITIES/act1bossrush/LEVEL_BOSSRUSH1_01')?.source, 'cn');
  assert.equal(levelFile('activities/act0/level_nowhere'), null);
});

test('a CN level never brings a Chinese enemy name: it takes the EN name of the enemy it varies, or none', async () => {
  const { readLevelFile } = await gamedata();
  const { level: cnLevel } = readLevelFile('activities/act1bossrush/level_bossrush1_01')!;
  const names = Object.fromEntries(cnLevel.enemyDbRefs.map((ref: { id: string; overwrittenData: { name?: { m_value: string } } }) => [ref.id, ref.overwrittenData.name?.m_value ?? null]));
  assert.deepEqual(names, { enemy_1303_mhshep_2_c: 'Hornbeast Alpha', enemy_9999_nobody: null });
  // The same inline name in an EN file is the game's English and stays.
  const { forGlobal } = await gamedata();
  const english = { enemyDbRefs: [{ id: 'enemy_9999_nobody', overwrittenData: { name: { m_defined: true, m_value: 'Nobody' } } }] };
  assert.equal(forGlobal(english, 'en').enemyDbRefs[0].overwrittenData.name.m_value, 'Nobody');
});

test('the battle parameters and enemy tallies of a CN-only stage come from its CN level', async () => {
  // @ts-expect-error The stage pipeline is plain JavaScript.
  const { Levels } = await import('../stage-pipeline/lib/level.mjs');
  const levels = new Levels(new Map());
  const record = levels.of('activities/act1bossrush/level_bossrush1_01', 'NORMAL');
  assert.equal(record?.battle.max_life, 1);
  assert.equal(record?.enemies.total, 2);
  assert.equal(record?.enemies.unranked?.[0].name, 'Hornbeast Alpha');
  assert.equal(levels.of('activities/act0/level_nowhere', 'NORMAL'), null);
});

test('only a map from the CN client says where it came from, so every EN map keeps its bytes', async () => {
  // @ts-expect-error The stage pipeline is plain JavaScript.
  const { encodeGeometry } = await import('../stage-pipeline/lib/encode.mjs');
  const built = { rows: 1, cols: 1, tiles: [[{ tileKey: 'tile_road' }]], routes: [], waves: [] };
  assert.equal(encodeGeometry('tn-1', structuredClone(built), 'cn').geometry.source, 'cn');
  assert.ok(!('source' in encodeGeometry('1-7', structuredClone(built), 'en').geometry));
});

test('only the EN folder lists level files, so a level only CN has mints no stage', async () => {
  // @ts-expect-error The stage pipeline is plain JavaScript.
  const { levelIds } = await import('../stage-pipeline/lib/levelfiles.mjs');
  const ids = levelIds();
  assert.ok(ids.has('obt/main/level_main_01-07'));
  assert.ok(!ids.has('activities/act99side/level_act99side_01'));
  assert.ok(!ids.has('activities/act1bossrush/level_bossrush1_01'));
});

test('no stage-pipeline module reads a level file by joining the EN folder with a level key', () => {
  // The EN-only read this replaced: path.join(levelsDir, `${key}.json`). Any new read of a
  // level goes through levelFile() / readLevelFile(), which fall back to the CN mirror.
  const files = ['scripts/stage-pipeline/build.mjs', ...fs.readdirSync('scripts/stage-pipeline/lib').map(file => `scripts/stage-pipeline/lib/${file}`)]
    .filter(file => file !== 'scripts/stage-pipeline/lib/gamedata.mjs');
  const offenders = files.filter(file => /path\.join\(\s*levelsDir\s*,\s*`\$\{/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});
