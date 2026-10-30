import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * 227 of the CN mirror's level files write the game's enums as numbers (heightType 0,
 * actionType 0, checkpoint type 1 ...), and all of them are stages Global dropped, so the
 * CN fallback is the only way they are read. The build compared against the names, so the
 * 2026-09-26 rehearsed release published 223 maps from them with every tile untyped (height
 * null, not walkable, not deployable), no enemies and no paths, under a note saying the
 * layout, waves and enemies came from the CN client. TN-1 "Burn and Destroy" was one.
 *
 * The fixture is the start of that kind of file, as the mirror has it: FA-1's level
 * (act13d0_01, Rewinding Breeze), trimmed to its map, three routes and three fragments.
 * gamedata.mjs reads ARKPEDIA_EN and ARKPEDIA_CN on first import, so the trees are set up
 * before any import of it.
 */
const FIXTURE = path.join(__dirname, 'fixtures/cn-level-numeric-enums.json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-numeric-levels-'));
const en = path.join(root, 'en', 'gamedata');
const cn = path.join(root, 'cn');
const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
write(path.join(en, 'excel', 'enemy_handbook_table.json'), { enemyData: {} });
write(path.join(cn, 'gamedata', 'levels', 'activities', 'act13d0', 'level_act13d0_01.json'), fs.readFileSync(FIXTURE, 'utf8'));
const broken = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
broken.mapData.tiles[0].heightType = 9;
write(path.join(cn, 'gamedata', 'levels', 'activities', 'act13d0', 'level_act13d0_99.json'), broken);
process.env.ARKPEDIA_EN = en;
process.env.ARKPEDIA_CN = cn;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

// @ts-expect-error The stage pipeline is plain JavaScript.
const gamedata = () => import('../stage-pipeline/lib/gamedata.mjs');
// @ts-expect-error The stage pipeline is plain JavaScript.
const geometry = () => import('../stage-pipeline/lib/geometry.mjs');
// @ts-expect-error The stage pipeline is plain JavaScript.
const levelLib = () => import('../stage-pipeline/lib/level.mjs');

type Tile = { key: string; walkable: boolean; flyable: boolean; height: string | null; deployable: string | null };

test('a CN level that numbers its enums reads as the named ones would: typed tiles, enemies and paths', async () => {
  const { readLevelFile } = await gamedata();
  const { buildTiles, buildRoute } = await geometry();
  const { countSpawns } = await levelLib();
  const read = readLevelFile('activities/act13d0/level_act13d0_01');
  assert.equal(read?.source, 'cn');
  const level = read!.level;

  // Every tile type comes out as the named files have that tile: the attributes each key
  // carries across the CN mirror's 3,671 named files.
  const tiles: Tile[] = buildTiles(level.mapData).flat();
  const byKey = new Map(tiles.map((tile) => [tile.key, tile]));
  assert.deepEqual(byKey.get('tile_road'), { key: 'tile_road', walkable: true, flyable: true, height: 'low', deployable: 'melee' });
  assert.deepEqual(byKey.get('tile_wall'), { key: 'tile_wall', walkable: false, flyable: true, height: 'high', deployable: 'ranged' });
  assert.deepEqual(byKey.get('tile_forbidden'), { key: 'tile_forbidden', walkable: false, flyable: true, height: 'high', deployable: 'none' });
  assert.deepEqual(byKey.get('tile_start'), { key: 'tile_start', walkable: true, flyable: true, height: 'low', deployable: 'none' });
  assert.equal(tiles.filter((tile) => tile.height === null || tile.deployable === null).length, 0, 'no untyped tile');

  // The enemies it sends, from actionType 0 (SPAWN): the fixture's three fragments hold 3 + 6 + 1.
  const { plain } = countSpawns(level, null);
  assert.deepEqual([...plain.entries()].sort(), [['enemy_1002_nsabr', 3], ['enemy_1007_slime', 6], ['enemy_1029_shdsbr', 1]]);

  // A path: motionMode 0 is walking, checkpoint 0 a move, 1 a wait.
  const route = buildRoute(level.routes[0], level.mapData.map.length, level.mapData.map[0].length);
  assert.equal(route.motion, 'walk');
  assert.ok(route.checkpoints.length > 0 && route.checkpoints.every((c: { type: string }) => c.type === 'move'), 'the moves are path nodes');
  assert.ok(route.waits.length > 0, 'the waits are scripted pauses');
});

test('a number the build has no name for fails the read, naming the file, instead of an untyped map', async () => {
  const { readLevelFile } = await gamedata();
  assert.throws(() => readLevelFile('activities/act13d0/level_act13d0_99'), /level_act13d0_99\.json: heightType 9 is not a value the stage build knows/);
});

test('a tile the reader did not name is refused by the map builder too', async () => {
  // The guard that would have caught the 223: an enum still numbered when the map is drawn.
  const { buildTiles } = await geometry();
  const level = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.throws(() => buildTiles(level.mapData), /heightType 1 is not a value the stage build knows/);
});

/*
 * The two places the build reads a level file: writeGeometry in build.mjs (the map) and
 * Levels.of in level.mjs (battle and enemies). Each used to read the file inside a
 * try/catch that turned ANY failure into "no level file", so an enum the build cannot name
 * would have been counted as a missing file and the stage published with no map and no
 * enemies. readLevelFile's own test above cannot see either call site.
 */
test('the build\'s level reader fails on a number it has no name for, rather than counting the file as missing', async () => {
  const { Levels } = await levelLib();
  const levels = new Levels(new Map());
  assert.equal(levels.of('activities/act13d0/level_act13d0_01')?.enemies.total, 10, 'the numbered file reads, with its 3 + 6 + 1 enemies');
  assert.throws(() => levels.of('activities/act13d0/level_act13d0_99'), /level_act13d0_99\.json: heightType 9 is not a value the stage build knows/);
  assert.equal(levels.missing.size, 0, 'neither counts as a missing file');
});

test('the stage build stops at the map of a level it cannot read, naming the file', () => {
  // The smallest set of EN tables build.mjs reads before it draws its first map, with one
  // stage whose level only the CN mirror has, numbered with a value no table lists. It
  // must stop in writeGeometry: reverted, writeGeometry counts the file as missing and
  // the error only comes later from Levels.of (or, with both reverted, never).
  const excelDir = path.join(en, 'excel');
  const tables: Record<string, unknown> = {
    stage_table: { stages: { act13d0_99: { stageId: 'act13d0_99', levelId: 'Activities/act13d0/level_act13d0_99', code: 'FA-9', zoneId: 'act13d0_zone1', name: 'Broken', difficulty: 'NORMAL' } }, tileInfo: {} },
    zone_table: { zones: {}, weeklyAdditionInfo: {}, mainlineAdditionInfo: {} },
    activity_table: { basicInfo: {}, zoneToActivity: {} },
    climb_tower_table: { towers: {} },
    item_table: { items: {} },
    building_data: { customData: { furnitures: {} } },
    charm_table: { charmList: [] },
  };
  for (const name of ['campaign_table', 'chapter_table', 'character_table', 'crisis_v2_table', 'gamedata_const', 'medal_table', 'retro_table',
    'roguelike_topic_table', 'sandbox_perm_table', 'sandbox_table', 'story_review_table']) tables[name] ??= {};
  for (const [name, table] of Object.entries(tables)) write(path.join(excelDir, `${name}.json`), table);
  fs.mkdirSync(path.join(en, 'levels'), { recursive: true });
  const out = path.join(root, 'out');
  write(path.join(out, 'data', 'assets', 'external-asset-index.json'), { version: 1, files: [] });

  const run = spawnSync(process.execPath, [path.join(__dirname, '../stage-pipeline/build.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, ARKPEDIA_EN: en, ARKPEDIA_CN: cn, ARKPEDIA_ROOT: out },
  });
  assert.notEqual(run.status, 0, 'the build fails');
  assert.match(run.stderr, /level_act13d0_99\.json: heightType 9 is not a value the stage build knows/, 'naming the file and the value');
  assert.match(run.stderr, /at writeGeometry \(.*build\.mjs/, 'when it draws the map, not later');
  assert.ok(!fs.existsSync(path.join(out, 'data', 'stages')), 'and writes no stage data');
});
