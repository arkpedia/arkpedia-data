// Reading a level file: the fight itself. Shared by the enemy tallies on a stage
// record and by the timeline in data/stage-geometry, so the two are the same
// reading of the same file and cannot drift apart.
import fs from 'node:fs';
import path from 'node:path';
import { excel, levelsDir, levelKey, levelFile, forGlobal } from './gamedata.mjs';
import { text } from './text.mjs';
import { SlugSet, slug } from './names.mjs';

// A FOURTH markup regex, narrower again than the other three.
const MARKUP = /<\/?[@$][^>]*>|<\/>|<\/?i>/g;

/** A display string with the game's rich-text taken out; null so absent stays absent. */
export function plain(s) {
  if (!s) return null;
  const out = String(s).replace(MARKUP, '').replace(/\s+/g, ' ').trim();
  return out || null;
}

/** Upstream serialises an empty list as {} in some dumps. */
export const asList = (value) => (Array.isArray(value) ? value : []);

/** Read a {m_defined, m_value} attribute node. */
export function defined(node, fallback = null) {
  if (node == null || typeof node !== 'object' || Array.isArray(node)) return fallback;
  if (!node.m_defined) return fallback;
  return node.m_value ?? fallback;
}

/**
 * Round a float so the same input always serialises to the same bytes. Times are
 * accumulated by addition, which is how 12.299999999999999 gets into a data
 * file; game timings are tenths of a second, so 3 decimals is lossless. The + 0
 * kills -0.
 */
export function num(value) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value !== 'number') return value;
  if (Number.isInteger(value)) return value;
  return Math.round(value * 1000) / 1000 + 0;
}

/** How long an action occupies its fragment: its delay plus emitting `count`. */
export function actionSpan(action) {
  const count = action.count || 1;
  const interval = action.interval || 0;
  return (action.preDelay || 0) + interval * (Math.max(count, 1) - 1);
}

/**
 * Whether a spawn may never happen on a given run. hiddenGroup fires only when a
 * trigger activates it; randomSpawnGroupKey picks one member of a group by
 * weight. Leaving these in the plain timeline promises enemies that do not come.
 */
export function isConditional(action) {
  return Boolean(action.hiddenGroup || action.randomSpawnGroupKey || action.randomSpawnGroupPackKey);
}

/**
 * Walk a wave's fragments (or a branch's phases) in order.
 *
 * Fragments run SEQUENTIALLY. A fragment's preDelay is measured from the END of
 * the previous fragment, not from the start of the wave, and a fragment ends when
 * its longest action has finished emitting. Treating every fragment as starting
 * at the wave's own t=0 collapses each later wave toward the beginning of the
 * fight, which is the easiest way to get this wrong.
 */
export function runFragments(fragments, start, onSpawn) {
  let clock = start;
  fragments.forEach((fragment, index) => {
    if (fragment == null || typeof fragment !== 'object') return;
    const actions = asList(fragment.actions);
    const fragmentStart = clock + (fragment.preDelay || 0);
    let span = 0;
    for (const action of actions) {
      if (action == null || typeof action !== 'object') continue;
      span = Math.max(span, actionSpan(action));   // every action holds it open
      if (action.actionType !== 'SPAWN') continue;
      onSpawn(action, fragmentStart + (action.preDelay || 0), index);
    }
    clock = fragmentStart + span;
  });
  return clock;
}

/**
 * Hidden groups this stage's own difficulty switches ON. A hiddenGroup is
 * normally conditional, but 370 level files carry a level_hidden_group_enable
 * rune gated by a difficultyMask, and where the mask covers this stage the group
 * is simply on. Counting it as conditional understates the stage.
 */
export function enabledHiddenGroups(level, difficulty) {
  const on = new Set();
  for (const rune of asList(level.runes)) {
    if (rune == null || typeof rune !== 'object') continue;
    const key = String(rune.key || '');
    if (!key.includes('hidden_group')) continue;
    const mask = String(rune.difficultyMask || 'ALL');
    if (mask !== 'ALL' && mask !== 'NONE' && difficulty && mask !== difficulty) continue;
    for (const entry of asList(rune.blackboard)) {
      const name = entry && typeof entry === 'object' ? entry.valueStr : null;
      if (!name) continue;
      if (key.endsWith('enable')) on.add(name); else on.delete(name);
    }
  }
  return on;
}

/**
 * (plain, conditional) tallies of enemy id -> how many the stage sends.
 *
 * Conditional spawns are counted SEPARATELY and never folded in, because they may
 * never fire. Adding them overstates a stage by everything it merely could send.
 */
export function countSpawns(level, difficulty = null) {
  const plainCount = new Map();
  const conditional = new Map();
  const switchedOn = enabledHiddenGroups(level, difficulty);
  const bump = (map, key, by) => map.set(key, (map.get(key) || 0) + by);

  const onSpawn = (action) => {
    const group = action.hiddenGroup;
    const certain = group && switchedOn.has(group) && !action.randomSpawnGroupKey;
    const target = certain || !isConditional(action) ? plainCount : conditional;
    const key = action.key;
    if (!key) return;          // the "nothing spawns" member of a weighted group
    bump(target, key, action.count || 1);
  };

  for (const wave of asList(level.waves)) {
    if (wave == null || typeof wave !== 'object') continue;
    runFragments(asList(wave.fragments), 0, onSpawn);
  }

  const branches = level.branches;
  if (branches != null && typeof branches === 'object' && !Array.isArray(branches)) {
    for (const key of Object.keys(branches).sort()) {
      const branch = branches[key];
      if (branch != null && typeof branch === 'object') {
        runFragments(asList(branch.phases), 0, (action) => bump(conditional, action.key, action.count || 1));
      }
    }
  }
  return { plain: plainCount, conditional };
}

/**
 * Display names a level file declares for enemies of its own: an event's
 * re-skinned Ink Spirit, declared inline as a useDb:false enemyDbRefs entry.
 * 109 such ids spawn across these stages, and without this they could be named
 * only by internal id.
 */
export function localNames(level) {
  const out = new Map();
  for (const ref of asList(level.enemyDbRefs)) {
    if (ref == null || typeof ref !== 'object' || !ref.id) continue;
    const name = plain(defined((ref.overwrittenData || {}).name));
    if (name) out.set(ref.id, name);
  }
  return out;
}

/** Display name per enemy id: the handbook, then enemy_database for stage-only variants. */
export function loadEnemyNames() {
  const out = new Map();
  for (const [id, entry] of Object.entries(excel('enemy_handbook_table').enemyData || {})) {
    const name = plain(entry.name);
    if (name) out.set(id, name);
  }
  const database = path.join(levelsDir, 'enemydata', 'enemy_database.json');
  if (fs.existsSync(database)) {
    // Entries are a LIST of level variants and only the level 0 entry is
    // complete; the name is an {m_defined, m_value} node to be respected.
    for (const [id, variants] of Object.entries(JSON.parse(fs.readFileSync(database, 'utf8')))) {
      if (out.has(id) || !Array.isArray(variants) || !variants.length) continue;
      const name = plain(defined(((variants[0] || {}).enemyData || {}).name));
      if (name) out.set(id, name);
    }
  }
  return out;
}

const ENEMY_RANK = { NORMAL: 'Normal', ELITE: 'Elite', BOSS: 'Boss' };
const RANKS = ['Normal', 'Elite', 'Boss'];

/**
 * enemy id -> filename stem. Ranked by hideInHandbook so the row the game shows
 * takes the bare slug -- duck_lord, not duck_lord_enemy_2001_duckmi, which only
 * exists to dodge a row players never see.
 */
export function enemySlugs(handbook) {
  const slugger = new SlugSet(slug);
  for (const [id, entry] of Object.entries(handbook)) {
    slugger.add(id, (entry || {}).name, (entry || {}).hideInHandbook ? 1 : 0);
  }
  return slugger.resolve();
}

/** enemy id -> {name, index, rank, slug}, for every enemy that can be named. */
export function enemyCatalogue() {
  const nameOf = loadEnemyNames();
  const handbook = excel('enemy_handbook_table').enemyData || {};
  const slugOf = enemySlugs(handbook);
  const catalogue = new Map();
  for (const [id, entry] of Object.entries(handbook)) {
    const index = text(entry.enemyIndex);
    catalogue.set(id, {
      name: nameOf.get(id) || text(entry.name),
      index: index === '-' ? null : index,     // '-' is 'no handbook code'
      rank: ENEMY_RANK[entry.enemyLevel] ?? null,
      slug: slugOf.get(id) ?? null,
    });
  }
  for (const [id, name] of nameOf) {
    // In enemy_database but not the handbook: nothing to rank it by and no
    // record to link to, but it has a display name, which is what a listing needs.
    if (!catalogue.has(id)) catalogue.set(id, { name, index: null, rank: null, slug: null });
  }
  return catalogue;
}

/**
 * A spawn tally as {total, by_rank, [unranked]}, names rather than ids. `total`
 * is every spawn including unrankable ones, so it is never smaller than the three
 * groups added up.
 */
export function groupByRank(counts, catalogue, inline) {
  const groups = { Normal: [], Elite: [], Boss: [] };
  const unranked = [];
  for (const enemyId of [...counts.keys()].sort()) {
    const known = catalogue.get(enemyId) || {};
    const entry = {
      // inline is the level file's own name for an enemy of its own, and is the
      // last resort: the handbook name is what the rest of the data files it under.
      slug: known.slug ?? null,
      name: known.name || inline.get(enemyId) || null,
      index: known.index ?? null,
      count: counts.get(enemyId),
    };
    if (RANKS.includes(known.rank)) groups[known.rank].push(entry); else unranked.push(entry);
  }
  // Most numerous first: what a stage mostly throws at you is what a reader
  // wants. Ties fall back to name then slug, so the order is a property of the
  // data rather than of iteration.
  // Code-point order, not localeCompare: the upstream tie-break is Python string
  // comparison, where 'Zealot' sorts before 'archer'. A locale collation would
  // reorder every mixed-case tie.
  const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const cmp = (a, b) => (b.count - a.count)
    || byText(a.name || '', b.name || '')
    || byText(a.slug || '', b.slug || '');
  for (const list of Object.values(groups)) list.sort(cmp);
  unranked.sort(cmp);

  let total = 0;
  for (const n of counts.values()) total += n;
  const out = { total, by_rank: groups };
  // Only ever present when the stage fields an enemy the handbook does not list;
  // an ordinary stage carries no such group rather than an empty one.
  if (unranked.length) out.unranked = unranked;
  return out;
}

/**
 * The stage-wide runes that change the DP the NORMAL run gets.
 *
 * A rune's difficultyMask says which mode it applies in, and most of the DP ones are
 * the game's assist modes: global_initial_cost_add is +20 DP on EASY (Story mode) for
 * 89 levels, cbuff_cost_recovery is a faster clock on FOUR_STAR for 6. Those must NOT
 * be folded in -- the reading is for the fight as normally played. Only ALL and NORMAL
 * count, which leaves two that matter:
 *
 *   cbuff_max_cost            a LOWER ceiling than the level's own maxCost -- 15 to 50
 *                             rather than 99, on 57 levels: 18 mainline, 17 Challenge
 *                             Mode, 8 Integrated Strategies, and the Operator Records.
 *   global_cost_recovery_mul  a faster clock, on 4.
 *
 * An unrecognised mask is skipped rather than guessed at: there is exactly one, a
 * numeric 7 whose bit layout nothing in the dump states.
 */
const RUNE_APPLIES = new Set(['ALL', 'NORMAL']);

function dpRunes(level) {
  const out = { cap: null, recoveryScale: null };
  for (const rune of Array.isArray(level.runes) ? level.runes : []) {
    if (rune == null || typeof rune !== 'object') continue;
    if (rune.key !== 'cbuff_max_cost' && rune.key !== 'global_cost_recovery_mul') continue;
    if (!RUNE_APPLIES.has(String(rune.difficultyMask))) continue;
    const board = new Map(
      (Array.isArray(rune.blackboard) ? rune.blackboard : [])
        .filter((b) => b != null && typeof b === 'object')
        .map((b) => [b.key, b.value])
    );
    if (rune.key === 'cbuff_max_cost') {
      const cap = board.get('max_cost');
      if (typeof cap === 'number' && cap > 0) out.cap = out.cap == null ? cap : Math.min(out.cap, cap);
    } else {
      const scale = board.get('scale');
      if (typeof scale === 'number' && scale > 0) out.recoveryScale = (out.recoveryScale ?? 1) * scale;
    }
  }
  return out;
}

export function buildOptions(level) {
  const options = (level.options != null && typeof level.options === 'object') ? level.options : {};
  const runes = dpRunes(level);
  // A rune only ever tightens the ceiling, so the lower of the two is the real one.
  const cap = runes.cap == null ? (options.maxCost ?? null)
    : Math.min(runes.cap, options.maxCost ?? runes.cap);
  // Faster recovery is a SHORTER interval, so the scale divides.
  const rawInterval = options.costIncreaseTime;
  const interval = typeof rawInterval === 'number' && runes.recoveryScale
    ? rawInterval / runes.recoveryScale
    : rawInterval;
  const maxPlay = options.maxPlayTime;
  return {
    squad_size: options.characterLimit ?? null,
    max_life: options.maxLifePoint ?? null,
    initial_dp: options.initialCost ?? null,
    max_dp: cap,
    // Seconds per DP. Sentinels like 999999 mean DP never recovers and are left
    // alone: 'never' is real information and 1/999999 states it faithfully.
    dp_recovery_interval_seconds: num(interval ?? null),
    dp_per_second: typeof interval === 'number' && interval > 0 ? Number((1 / interval).toFixed(6)) : null,
    max_play_time_seconds: typeof maxPlay === 'number' && maxPlay > 0 ? num(maxPlay) : null,
  };
}

/**
 * Battle parameters and enemy counts, one read per (level file, difficulty).
 *
 * Keyed on difficulty as well as the file because a stage and its Challenge Mode
 * share ONE level file and do not field the same enemies: a hidden-group rune
 * gated to FOUR_STAR switches a group on for the Challenge Mode row only.
 */
export class Levels {
  constructor(catalogue) {
    this._catalogue = catalogue;
    this._cache = new Map();
    this.missing = new Set();
    this.unreadable = new Set();
  }

  /** {battle, enemies} for a stage's level file, or null if it is not in the dump. */
  of(levelId, difficulty = null) {
    const key = levelKey(levelId);
    if (!key) return null;
    const cacheKey = `${key} ${difficulty}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    // EN first, the CN mirror's copy when Global no longer carries it (gamedata.mjs).
    const found = levelFile(key);
    let level = null;
    if (found) {
      try { level = JSON.parse(fs.readFileSync(found.file, 'utf8')); } catch { level = null; }
      // Outside the try, as in build.mjs: an unreadable enum fails, it is not a missing file.
      if (level) level = forGlobal(level, found.source, found.file);
    } else {
      this.missing.add(key);
    }
    if (level == null || typeof level !== 'object' || Array.isArray(level)) {
      if (found) this.unreadable.add(cacheKey);
      this._cache.set(cacheKey, null);
      return null;
    }

    const options = buildOptions(level);
    const { plain: plainCount, conditional } = countSpawns(level, difficulty);
    const inline = localNames(level);
    const record = {
      battle: {
        max_life: options.max_life,
        unit_limit: options.squad_size,
        initial_dp: options.initial_dp,
        // The ceiling the counter stops at. Carried because it is NOT a constant --
        // 99 on 3,092 levels, 999 on 57 and 500 on one -- so the map's DP reading
        // cannot assume the usual 99 and be right everywhere.
        max_dp: options.max_dp,
        dp_per_second: options.dp_per_second,
        // The raw interval as well as the rate: 1/interval rounds, and the
        // interval is what the game actually stores.
        dp_recovery_interval_seconds: options.dp_recovery_interval_seconds,
      },
      enemies: {
        ...groupByRank(plainCount, this._catalogue, inline),
        // Kept apart from the totals above and always present once the file has
        // been read: a stage with nothing conditional really does have none,
        // which is a fact rather than an absence.
        conditional: groupByRank(conditional, this._catalogue, inline),
      },
    };
    this._cache.set(cacheKey, record);
    return record;
  }
}
