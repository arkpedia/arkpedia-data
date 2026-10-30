// Reads the EN gamedata tables the stage build needs, out of the upstream cache
// scripts/lib/upstream.sh maintains. Everything is a plain JSON read; the only
// reason this is a module is that the tables are big and several steps want the
// same one, so they are held after the first read.
//
// Level files are the one input with a second source. The EN mirror drops a level
// file once Global has no way to play the stage (300 of them in 2026-09: Trials for
// Navigator #1-#4, Children of Ursus, Vigilo and nine more whole events), while the
// CN mirror still carries it. The CN tables of a run all come from the one mirror and
// commit scripts/content/cn-tables.mjs settled on, composed under
// .cache/upstream/cn-resource/gamedata, so that is where the fallback reads. EN wins
// wherever both have the file. Only a stage the EN tables already name ever reads a
// CN level: levelIds() (levelfiles.mjs) lists the EN folder alone, because a level
// only CN has is a stage Global has not got, and CN stages never arrive by design.
import fs from 'node:fs';
import path from 'node:path';

// The upstream cache belongs to the REPO, not to wherever output is being
// written: ARKPEDIA_ROOT redirects the output for a verification run, and the
// inputs must not follow it. Resolved from this file so cwd does not matter.
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const EN = process.env.ARKPEDIA_EN || path.join(REPO, '.cache/upstream/en-gamedata/en/gamedata');

const cache = new Map();

export function excel(name) {
  if (!cache.has(name)) {
    const file = path.join(EN, 'excel', `${name}.json`);
    if (!fs.existsSync(file)) {
      throw new Error(`missing ${file}\n  run scripts/sync/refresh-stage-data.sh, which syncs the upstream cache first`);
    }
    cache.set(name, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return cache.get(name);
}

export const levelsDir = path.join(EN, 'levels');

/** The CN level files: the tables upstream-cn settled on (ARKPEDIA_CN points elsewhere). */
export const cnLevelsDir = path.join(process.env.ARKPEDIA_CN || path.join(REPO, '.cache/upstream/cn-resource'), 'gamedata', 'levels');

// Level ids are cited in a dozen tables with inconsistent case and separators.
// Two normalisations exist upstream and they are NOT interchangeable: this is
// the strict one (appears_in.level_key), used for every cross-table join.
export function levelKey(id) {
  return (id || '').trim().replace(/\\/g, '/').toLowerCase();
}

let cnIndex = null;
/**
 * level key -> absolute path of every CN level file, walked once and keyed in lower case:
 * the mirrors do not agree on case (the audit probed act4d0 at one casing and found
 * nothing), so the lookup is case-insensitive rather than a guessed spelling. Empty,
 * with one warning, when the CN tables are not on disk: the build then proceeds on EN
 * alone, as it did before the fallback existed.
 */
function cnLevels() {
  if (cnIndex) return cnIndex;
  cnIndex = new Map();
  if (!fs.existsSync(cnLevelsDir)) {
    console.warn(`warning: no CN level files under ${cnLevelsDir}; a stage Global no longer carries a level file for gets no map`);
    return cnIndex;
  }
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(abs, entry.name), next);
      else if (entry.name.endsWith('.json')) cnIndex.set(levelKey(next.slice(0, -5)), path.join(abs, entry.name));
    }
  };
  walk(cnLevelsDir, '');
  return cnIndex;
}

/** Only for a test that points ARKPEDIA_CN at another tree inside one process. */
export function forgetCnLevels() { cnIndex = null; }

/**
 * Where a stage's level file is: {file, source: 'en' | 'cn'}, EN first, or null when
 * neither mirror has it.
 */
export function levelFile(levelId) {
  const key = levelKey(levelId);
  if (!key) return null;
  const en = path.join(levelsDir, `${key}.json`);
  if (fs.existsSync(en)) return { file: en, source: 'en' };
  const cn = cnLevels().get(key);
  return cn ? { file: cn, source: 'cn' } : null;
}

let handbook = null;
/**
 * The EN handbook name of the enemy a stage-local one is a variant of: the longest
 * handbook id that `id` extends at an underscore (enemy_1303_mhshep_2_c is a
 * enemy_1303_mhshep_2, a Hornbeast), or null.
 */
export function baseEnemyName(id) {
  handbook ??= excel('enemy_handbook_table').enemyData || {};
  const parts = String(id || '').split('_');
  for (let end = parts.length; end >= 3; end--) {
    const name = handbook[parts.slice(0, end).join('_')]?.name;
    if (typeof name === 'string' && name.trim()) return name;
  }
  return null;
}

/*
 * The game's enums as numbers, for the level files that write them that way.
 *
 * The CN mirror keeps 227 level files (of 3,901, 2026-09) from before its dumper named
 * the enums: every tile type, action, route and checkpoint is the game's number. They
 * are all stages Global dropped long ago -- Trials for Navigator #1-#2, the old
 * mini-events -- so each is read only through the CN fallback, and the build, which
 * compares against the names, made every tile of those maps untyped (height null, not
 * walkable, not deployable), counted no enemies and drew no paths, while the page said
 * the layout, waves and enemies came from the CN client (223 published maps, found
 * 2026-09-26 on the rehearsed release).
 *
 * Each table is what the files themselves show. Across the 3,671 named CN files and the
 * 227 numbered ones, every tile key carries the same attributes under this mapping
 * (tile_road 0/1/3 = LOWLAND/MELEE/ALL, tile_wall 1/2/2 = HIGHLAND/RANGED/FLY_ONLY,
 * tile_forbidden 1/0/2 ...); action 0 carries the enemy keys SPAWN does; checkpoints 5
 * and 6 pair up the way DISAPPEAR and APPEAR_AT_POS do, 3 and 4 wait with a time and no
 * position like the two WAIT_CURRENT_* types, 8 chains like PATROL_MOVE. A number no
 * table lists is refused (decodeNumericEnums throws, naming the file) rather than
 * guessed: a guessed enum is exactly the silent wrong map this replaced.
 */
const ENUMS = {
  heightType: { 0: 'LOWLAND', 1: 'HIGHLAND' },
  buildableType: { 0: 'NONE', 1: 'MELEE', 2: 'RANGED', 3: 'ALL' },
  passableMask: { 0: 'NONE', 1: 'WALK_ONLY', 2: 'FLY_ONLY', 3: 'ALL' },
  motionMode: { 0: 'WALK', 1: 'FLY', 2: 'E_NUM' },
  // 7 sits between APPEAR_AT_POS and PATROL_MOVE, where the game's ALERT is; it appears
  // only in numbered files, holds no position and ends routes, and the build reads it as
  // neither a move nor a wait, as it would ALERT.
  checkpoint: { 0: 'MOVE', 1: 'WAIT_FOR_SECONDS', 3: 'WAIT_CURRENT_FRAGMENT_TIME', 4: 'WAIT_CURRENT_WAVE_TIME',
    5: 'DISAPPEAR', 6: 'APPEAR_AT_POS', 7: 'ALERT', 8: 'PATROL_MOVE' },
  actionType: { 0: 'SPAWN', 1: 'PREVIEW_CURSOR', 2: 'STORY', 4: 'PLAY_BGM', 5: 'DISPLAY_ENEMY_INFO',
    6: 'ACTIVATE_PREDEFINED', 8: 'TRIGGER_PREDEFINED' },
  // Flags: NORMAL 1, FOUR_STAR 2, and 3 holds both, which is what the build reads ALL as
  // (it tells only those two apart). 7 is passed through as the number: level.mjs already
  // skips the one numeric 7 the EN dump has rather than guess its bits, and these get the same.
  difficultyMask: { 0: 'NONE', 1: 'NORMAL', 2: 'FOUR_STAR', 3: 'ALL', 7: 7 },
  phase: { 0: 'PHASE_0', 1: 'PHASE_1', 2: 'PHASE_2', 3: 'PHASE_3' },
};

/**
 * A level file with the game's numbered enums written as the names the build reads
 * (see ENUMS), in place. A file that already names them is left as it is. Throws on a
 * number ENUMS does not list. randomType is decoded only for 0 (ALWAYS), the one value
 * the build compares; its other numbers are passed through.
 */
export function decodeNumericEnums(level, file = 'a level file') {
  const decode = (object, field, table) => {
    if (!object || typeof object !== 'object' || typeof object[field] !== 'number') return;
    const name = table[object[field]];
    if (name === undefined) throw new Error(`${file}: ${field} ${object[field]} is not a value the stage build knows (scripts/stage-pipeline/lib/gamedata.mjs ENUMS)`);
    object[field] = name;
  };
  const list = (value) => (Array.isArray(value) ? value : []);
  for (const tile of list(level.mapData?.tiles)) {
    for (const field of ['heightType', 'buildableType', 'passableMask']) decode(tile, field, ENUMS[field]);
  }
  for (const route of [...list(level.routes), ...list(level.extraRoutes)]) {
    decode(route, 'motionMode', ENUMS.motionMode);
    for (const checkpoint of list(route?.checkpoints)) decode(checkpoint, 'type', ENUMS.checkpoint);
  }
  const branches = level.branches && typeof level.branches === 'object' ? Object.values(level.branches) : [];
  const fragments = [...list(level.waves).flatMap((wave) => list(wave?.fragments)), ...branches.flatMap((branch) => list(branch?.phases))];
  for (const action of fragments.flatMap((fragment) => list(fragment?.actions))) {
    decode(action, 'actionType', ENUMS.actionType);
    if (action && action.randomType === 0) action.randomType = 'ALWAYS';
  }
  for (const rune of list(level.runes)) decode(rune, 'difficultyMask', ENUMS.difficultyMask);
  const predefines = level.predefines && typeof level.predefines === 'object' ? level.predefines : {};
  for (const key of ['tokenCards', 'characterCards', 'tokenInsts', 'characterInsts']) {
    for (const entry of list(predefines[key])) decode(entry?.inst, 'phase', ENUMS.phase);
  }
  return level;
}

/**
 * A level file's content as the Global site may show it. A CN level names its
 * stage-local enemies in Chinese (enemyDbRefs[].overwrittenData.name), and both the
 * enemy tallies and the map's enemy list fall back to that inline name when the EN
 * handbook has none. For a CN file that name is replaced by the EN handbook name of
 * the enemy it is a variant of (baseEnemyName), or dropped, so such an enemy is named
 * in English or not at all, never in Chinese. Its numbered enums, where it has them,
 * are named (decodeNumericEnums). Everything else the build reads from a level is keys,
 * numbers and grids, which the two servers share.
 */
export function forGlobal(level, source, file) {
  if (source !== 'cn' || !level || typeof level !== 'object') return level;
  decodeNumericEnums(level, file);
  const refs = Array.isArray(level.enemyDbRefs) ? level.enemyDbRefs : [];
  for (const ref of refs) {
    const data = ref && typeof ref === 'object' ? ref.overwrittenData : null;
    if (!data || typeof data !== 'object' || !('name' in data)) continue;
    const english = baseEnemyName(ref.id);
    if (english) data.name = { m_defined: true, m_value: english };
    else delete data.name;
  }
  return level;
}

/** {level, source} for a stage's level file, or null if neither mirror has it or it is not JSON. */
export function readLevelFile(levelId) {
  const found = levelFile(levelId);
  if (!found) return null;
  let level;
  try { level = JSON.parse(fs.readFileSync(found.file, 'utf8')); } catch { return null; }
  return { level: forGlobal(level, found.source, found.file), source: found.source };
}

export function readLevel(levelId) {
  return readLevelFile(levelId)?.level ?? null;
}
