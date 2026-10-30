// The map: its grid, the routes enemies walk, the spawn timeline, and the stat
// configuration each level file owns.
//
// COORDINATE SYSTEM: row 0 is the BOTTOM row of the map as drawn in game and row
// increases upward; col 0 is leftmost. Upstream stores the tile grid top row
// first and route positions bottom row first, so the grid is flipped here to make
// the two agree. Getting this wrong mirrors every map vertically.
import { excel } from './gamedata.mjs';
import { asList, defined, num, plain, isConditional, runFragments } from './level.mjs';

const HEIGHT = { HIGHLAND: 'high', LOWLAND: 'low' };
const DEPLOYABLE = { NONE: 'none', MELEE: 'melee', RANGED: 'ranged', ALL: 'any' };
const MOTION = { WALK: 'walk', FLY: 'fly' };
/** The passableMask values a tile may carry (walkable and flyable are read from them). */
const PASSABLE = { NONE: true, WALK_ONLY: true, FLY_ONLY: true, ALL: true };
const PHASE = { PHASE_0: 0, PHASE_1: 1, PHASE_2: 2, PHASE_3: 3 };

// Gamedata attribute names as canonical enemy stats write them. Anything without
// a canonical field keeps its upstream name rather than being dropped.
const ATTRIBUTE_NAME = {
  maxHp: 'hp', atk: 'atk', def: 'def', magicResistance: 'res', moveSpeed: 'move_speed',
  baseAttackTime: 'attack_interval', attackSpeed: 'attack_speed', massLevel: 'weight',
  rangeRadius: 'range', lifePointReduce: 'life_cost', tauntLevel: 'taunt',
  epResistance: 'elemental_res', epDamageResistance: 'elemental_damage_res',
};

// Only these checkpoint types carry a position that means anything. WAIT_* and
// DISAPPEAR are filler: their position is {0,0} or worse, and emitting it would
// put route points on walls.
const POSITIONAL_CHECKPOINTS = new Set(['MOVE', 'APPEAR_AT_POS', 'PATROL_MOVE', 'MAP_OFFSET_MOVE']);
const WAIT_CHECKPOINTS = new Set(['WAIT_FOR_SECONDS', 'WAIT_CURRENT_FRAGMENT_TIME',
  'WAIT_CURRENT_WAVE_TIME', 'WAIT_BOSSRUSH_WAVE']);

/**
 * mapData.map as rows of tile indices, row 0 == BOTTOM. Two serialisations exist
 * upstream -- a list of rows, and a flattened {row_size, column_size,
 * matrix_data} -- and both store the top row first.
 */
export function readGrid(mapData) {
  const raw = mapData.map;
  let rows;
  if (Array.isArray(raw) && raw.length && Array.isArray(raw[0])) {
    rows = raw;
  } else if (raw != null && typeof raw === 'object' && 'matrix_data' in raw) {
    const height = raw.row_size || 0;
    const width = raw.column_size || 0;
    const flat = raw.matrix_data || [];
    if (!height || !width || flat.length < height * width) return null;
    rows = Array.from({ length: height }, (_, i) => flat.slice(i * width, (i + 1) * width));
  } else {
    return null;
  }
  if (!rows.length || !rows.every((r) => Array.isArray(r) && r.length === rows[0].length)) return null;
  return [...rows].reverse();   // top-row-first upstream -> row 0 == bottom here
}

/**
 * Tile blackboards as a flat {key: value}. These ARE the stage mechanics --
 * tile_infection carries its damage and its ATK/ASPD buff here -- and they are
 * routinely dropped by extractors that only look at tileKey. valueStr wins where
 * it is set, because that is where string parameters live.
 */
export function readBlackboard(blackboard) {
  if (!blackboard) return null;
  const out = {};
  if (!Array.isArray(blackboard)) {
    for (const [key, value] of Object.entries(blackboard)) out[key] = num(value);
  } else {
    for (const entry of blackboard) {
      if (entry == null || typeof entry !== 'object' || !('key' in entry)) continue;
      out[entry.key] = entry.valueStr != null ? entry.valueStr : num(entry.value);
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Whether a tile key is an enemy entry point or a defence objective. Derived from
 * the key rather than hardcoded per event, or the cooperative and Dossoles
 * variants (tile_start_cooperate, tile_end_dqq, tile_allygoal) would be missed.
 */
export function tileRole(key) {
  if (key.startsWith('tile_start') || key === 'tile_flystart' || key.endsWith('_enemy_born')) return 'spawn';
  if (key.startsWith('tile_end') || key.endsWith('goal')) return 'objective';
  return null;
}

export function buildTiles(mapData) {
  const grid = readGrid(mapData);
  if (grid == null) return null;
  const palette = mapData.tiles;
  if (!Array.isArray(palette) || !palette.length) return null;

  const rows = [];
  for (const row of grid) {
    const outRow = [];
    for (const index of row) {
      if (!Number.isInteger(index) || index < 0 || index >= palette.length) return null;
      const raw = palette[index];
      // passableMask says who may cross: ALL is both, FLY_ONLY is air only, NONE
      // is nothing at all (a hole, a solid wall).
      const passable = raw.passableMask;
      // A value these tables do not name is refused, not drawn as an untyped tile: 223 maps
      // from numbered CN files went out with every tile null that way (lib/gamedata.mjs
      // decodeNumericEnums). An absent field stays null, as it always has.
      for (const [field, known] of [['heightType', HEIGHT], ['buildableType', DEPLOYABLE], ['passableMask', PASSABLE]]) {
        if (raw[field] != null && !Object.hasOwn(known, raw[field])) {
          throw new Error(`tile ${raw.tileKey}: ${field} ${JSON.stringify(raw[field])} is not a value the stage build knows`);
        }
      }
      const tile = {
        key: raw.tileKey ?? null,
        walkable: passable === 'ALL',
        flyable: passable === 'ALL' || passable === 'FLY_ONLY',
        height: HEIGHT[raw.heightType] ?? null,
        deployable: DEPLOYABLE[raw.buildableType] ?? null,
      };
      const blackboard = readBlackboard(raw.blackboard);
      if (blackboard) tile.blackboard = blackboard;
      outRow.push(tile);
    }
    rows.push(outRow);
  }
  return rows;
}

const inBounds = (position, height, width) => (
  position != null && typeof position === 'object'
  && Number.isInteger(position.row) && Number.isInteger(position.col)
  && position.row >= 0 && position.row < height && position.col >= 0 && position.col < width);

const point = (position) => ({ row: position.row, col: position.col });

export function buildRoute(raw, height, width) {
  if (raw == null || typeof raw !== 'object') return null;
  const motion = MOTION[raw.motionMode] ?? null;
  const route = {
    motion,
    start: inBounds(raw.startPosition, height, width) ? point(raw.startPosition) : null,
    end: inBounds(raw.endPosition, height, width) ? point(raw.endPosition) : null,
  };

  // checkpoints holds the path nodes; waits holds the scripted pauses, anchored
  // to the checkpoint they follow. Nothing appears in both.
  const checkpoints = [];
  const waits = [];
  for (const rawCp of asList(raw.checkpoints)) {
    if (rawCp == null || typeof rawCp !== 'object') continue;
    const kind = rawCp.type;
    if (POSITIONAL_CHECKPOINTS.has(kind)) {
      if (inBounds(rawCp.position, height, width)) {
        checkpoints.push({ type: kind.toLowerCase(), position: point(rawCp.position) });
      }
    } else if (WAIT_CHECKPOINTS.has(kind)) {
      waits.push({
        after_checkpoint: checkpoints.length - 1,   // -1 = before the first move
        type: kind.toLowerCase(),
        seconds: num(rawCp.time ?? null),
      });
    }
    // DISAPPEAR and anything new: filler. A DISAPPEAR is always followed by the
    // APPEAR_AT_POS that says where the enemy comes back, so nothing is lost --
    // unlike its position, which is {0,0} and would draw a line to the corner.
  }
  route.checkpoints = checkpoints;
  route.waits = waits;

  // motionMode E_NUM is a placeholder slot: non-spawn actions (STORY,
  // PREVIEW_CURSOR) still need a routeIndex to point at. Every one upstream is
  // start == end == {0,0} with no checkpoints, which is not the bottom-left
  // corner but 'no route at all'. The slot is kept so indices stay aligned with
  // the timeline; its position is not.
  if (route.motion === null && !checkpoints.length
    && route.start?.row === 0 && route.start?.col === 0
    && route.end?.row === 0 && route.end?.col === 0) {
    route.start = null;
    route.end = null;
    route.placeholder = true;
  }
  return route;
}

function conditionOf(action) {
  const condition = {};
  for (const [field, out] of [['hiddenGroup', 'hidden_group'], ['randomSpawnGroupKey', 'random_group'],
    ['randomSpawnGroupPackKey', 'random_group_pack']]) {
    if (action[field]) condition[out] = action[field];
  }
  // weight only means anything as a share of a random group's total.
  if (Object.keys(condition).length && action.weight) condition.weight = action.weight;
  for (const [field, out] of [['randomType', 'random_type'], ['refreshType', 'refresh_type']]) {
    if (action[field] && action[field] !== 'ALWAYS') condition[out] = action[field];
  }
  return condition;
}

function spawnRecord(action, time, enemyName) {
  const record = {
    time: num(time),
    enemy_id: action.key ?? null,
    enemy: enemyName,
    count: action.count || 1,
    route: action.routeIndex ?? null,
  };
  if (record.count > 1) record.interval = num(action.interval ?? null);
  return record;
}

export function buildWaves(level, nameOf) {
  const waves = [];
  const conditional = [];

  asList(level.waves).forEach((rawWave, waveIndex) => {
    if (rawWave == null || typeof rawWave !== 'object') return;
    const spawns = [];
    const onSpawn = (action, time, fragmentIndex) => {
      const record = spawnRecord(action, time, nameOf(action.key) ?? null);
      record.fragment = fragmentIndex;
      if (isConditional(action)) {
        record.source = 'wave';
        record.wave = waveIndex;
        record.condition = conditionOf(action);
        conditional.push(record);
      } else {
        spawns.push(record);
      }
    };
    const duration = runFragments(asList(rawWave.fragments), rawWave.preDelay || 0, onSpawn);
    const maxWait = rawWave.maxTimeWaitingForNextWave;
    waves.push({
      index: waveIndex,
      pre_delay: num(rawWave.preDelay ?? null),
      post_delay: num(rawWave.postDelay ?? null),
      // -1 means 'wait until the field is clear', which is not a time.
      max_wait_for_next_wave: typeof maxWait === 'number' && maxWait >= 0 ? num(maxWait) : null,
      duration: num(duration + (rawWave.postDelay || 0)),
      spawns,
    });
  });

  // Branch spawns fire only if something triggers the branch, so they never
  // belong in the plain timeline. Their clock starts when the branch does.
  const branches = level.branches;
  if (branches != null && typeof branches === 'object' && !Array.isArray(branches)) {
    for (const key of Object.keys(branches).sort()) {
      const branch = branches[key];
      if (branch == null || typeof branch !== 'object') continue;
      runFragments(asList(branch.phases), 0, (action, time, phaseIndex) => {
        const record = spawnRecord(action, time, nameOf(action.key) ?? null);
        record.source = 'branch';
        record.branch = key;
        record.phase = phaseIndex;
        const condition = conditionOf(action);
        if (Object.keys(condition).length) record.condition = condition;
        conditional.push(record);
      });
    }
  }
  return { waves, conditional };
}

/**
 * The enemy stat configuration owned by this one level file; a wave's enemy_id is
 * the reference into it. useDb:false rows are stage-local, so their database level
 * is null and their defined attributes are the whole stat line.
 */
export function enemyConfigurations(level, nameOf, slugOf, databaseLevels, spawnedIds) {
  const out = new Map();
  for (const ref of asList(level.enemyDbRefs)) {
    if (ref == null || typeof ref !== 'object' || !ref.id) continue;
    const enemyId = ref.id;
    // Ids are unique inside every current level file; reject a future duplicate
    // rather than choosing one configuration for an ambiguous spawn key.
    if (out.has(enemyId)) throw new Error(`level file has duplicate enemyDbRefs id ${enemyId}`);
    const overrideData = ref.overwrittenData || {};
    const attributes = overrideData.attributes || {};
    const overrides = {};
    for (const [key, node] of Object.entries(attributes)) {
      if (node != null && typeof node === 'object' && node.m_defined) {
        overrides[ATTRIBUTE_NAME[key] ?? key] = node.m_value;
      }
    }
    const usesDatabase = ref.useDb !== false;
    const row = {
      enemy_id: enemyId,
      slug: slugOf.get(enemyId) ?? null,
      name: nameOf.get(enemyId) || plain(defined(overrideData.name)),
      database_level: usesDatabase ? (ref.level || 0) : null,
    };
    if (Object.keys(overrides).length) row.overrides = overrides;
    if (!usesDatabase) row.source = 'stage-local enemy; useDb false';
    out.set(enemyId, row);
  }

  // A few spawn actions name no enemyDbRef at all; those use database level 0
  // only when that enemy actually exists in enemy_database.
  for (const enemyId of [...spawnedIds].filter((id) => !out.has(id)).sort()) {
    const available = databaseLevels.get(enemyId) || new Set();
    const databaseLevel = available.has(0) ? 0 : (available.size ? Math.min(...available) : null);
    out.set(enemyId, {
      enemy_id: enemyId,
      slug: slugOf.get(enemyId) ?? null,
      name: nameOf.get(enemyId) ?? null,
      database_level: databaseLevel,
      source: 'spawn action; no enemyDbRef',
    });
  }
  return [...out.keys()].sort().map((id) => out.get(id));
}

function buildCard(card, unitNames, withCount) {
  if (card == null || typeof card !== 'object') return null;
  const inst = card.inst || {};
  const unitId = inst.characterKey;
  if (!unitId) return null;
  const entry = {
    unit_id: unitId,
    unit: unitNames.get(unitId) ?? null,
    level: inst.level ?? null,
    elite: PHASE[inst.phase] ?? null,
    potential: inst.potentialRank ?? null,
    skill_index: card.skillIndex ?? null,
    skill_level: card.mainSkillLvl ?? null,
  };
  if (withCount) entry.count = card.initialCnt ?? null;
  if (card.hidden) entry.hidden = true;
  return entry;
}

export function buildSuppliedUnits(level, unitNames) {
  const predefines = (level.predefines != null && typeof level.predefines === 'object') ? level.predefines : {};
  return {
    // Deployable obstacles the stage hands you -- the ten Roadblocks in 4-4.
    deployable_tokens: asList(predefines.tokenCards).map((c) => buildCard(c, unitNames, true)).filter(Boolean),
    // A Fixed Squad: operators the stage brings instead of yours.
    fixed_squad: asList(predefines.characterCards).map((c) => buildCard(c, unitNames, false)).filter(Boolean),
  };
}

/** The spawn and objective tiles, with the routes that use each. */
export function markedTiles(tiles, routes) {
  const starts = new Map();
  const ends = new Map();
  routes.forEach((route, index) => {
    if (!route) return;
    for (const [position, map] of [[route.start, starts], [route.end, ends]]) {
      if (!position) continue;
      const key = `${position.row},${position.col}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(index);
    }
  });

  const spawn = [];
  const objective = [];
  tiles.forEach((row, rowIndex) => {
    row.forEach((tile, colIndex) => {
      const role = tileRole(tile.key || '');
      if (!role) return;
      const used = (role === 'spawn' ? starts : ends).get(`${rowIndex},${colIndex}`);
      (role === 'spawn' ? spawn : objective).push({
        row: rowIndex, col: colIndex, key: tile.key,
        routes: used ? [...used].sort((a, b) => a - b) : [],
      });
    });
  });
  return { spawn, objective };
}

/**
 * Names and descriptions for the tile keys this stage uses, held once per stage:
 * a 40x40 map would otherwise carry the same paragraph 1,600 times.
 */
export function buildLegend(tiles, tileInfo) {
  const legend = {};
  for (const row of tiles) {
    for (const tile of row) {
      const key = tile.key;
      if (!key || key in legend) continue;
      const info = tileInfo[key];
      if (!info) continue;   // no name upstream; the key on the tile is all there is
      legend[key] = { name: plain(info.name), description: plain(info.description) };
    }
  }
  return legend;
}

/**
 * Which stage of a group owns the level file they share. Challenge Mode and the
 * difficulty variants point their levelId at a parent's layout, so a file can be
 * claimed by several stages. The parent is the one whose id every other member
 * extends; failing that the plain-difficulty, shortest id wins.
 */
export function owningStage(stageIds, stages) {
  const rank = (stageId) => [
    stageIds.every((other) => other.startsWith(stageId)) ? 0 : 1,
    stages[stageId].difficulty === 'NORMAL' ? 0 : 1,
    stageId.length,
    stageId,
  ];
  return stageIds.reduce((best, id) => {
    const a = rank(id);
    const b = rank(best);
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return id;
      if (a[i] > b[i]) return best;
    }
    return best;
  });
}

/** Enemy id -> the database levels available as bases for a stage config. */
export function enemyDatabaseLevels(database) {
  const out = new Map();
  for (const [enemyId, rows] of Object.entries(database)) {
    if (!Array.isArray(rows)) continue;
    out.set(enemyId, new Set(rows.map((row, index) => (row != null && typeof row === 'object' ? (row.level ?? index) : null))
      .filter((v) => v != null)));
  }
  return out;
}

/** Display name per operator / token / trap id (trap_001_crate -> Roadblock). */
export function unitNames() {
  const out = new Map();
  for (const [id, row] of Object.entries(excel('character_table'))) {
    const name = plain(row.name);
    if (name) out.set(id, name);
  }
  return out;
}

/** Everything one level file contributes, in the pipeline's own shape. */
export function buildGeometry(level, ctx) {
  const tiles = buildTiles(level.mapData || {});
  if (!tiles) return null;
  const height = tiles.length;
  const width = tiles[0].length;

  const routes = asList(level.routes).map((r) => buildRoute(r, height, width));
  // extraRoutes hold the same geometry for units the stage summons; they are
  // indexed separately and never referenced by routeIndex.
  const extraRoutes = asList(level.extraRoutes).map((r) => buildRoute(r, height, width));
  const { spawn, objective } = markedTiles(tiles, routes);
  const { waves, conditional } = buildWaves(level, (k) => ctx.enemyNames.get(k));

  const spawnedIds = new Set();
  for (const wave of waves) for (const row of wave.spawns) if (row.enemy_id) spawnedIds.add(row.enemy_id);
  for (const row of conditional) if (row.enemy_id) spawnedIds.add(row.enemy_id);

  return {
    tiles,
    rows: height,
    cols: width,
    tile_legend: buildLegend(tiles, ctx.tileInfo),
    spawn_tiles: spawn,
    objective_tiles: objective,
    routes,
    extra_routes: extraRoutes,
    waves,
    conditional_spawns: conditional,
    supplied_units: buildSuppliedUnits(level, ctx.unitNames),
    enemy_configurations: enemyConfigurations(level, ctx.enemyNames, ctx.enemySlugs,
      ctx.databaseLevels, spawnedIds),
  };
}
