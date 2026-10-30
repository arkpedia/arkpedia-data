// One record per stage_table row: which stage it is, where it sits, what it
// costs. The fight itself (battle/enemies), the drops, the map and the content
// block are added by their own modules -- this one owns identity.
import { text, list } from './text.mjs';
import { stageSlugs, variantKind, VARIANT_LABEL } from './names.mjs';
import { eventOf } from './story.mjs';

const WEEKDAY = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };

/**
 * Trials for Navigator: which tier a stage is, and which stage it is a tier OF.
 *
 * A trial runs at three or four difficulties -- Basic, Orientation, Spectacular, and
 * on the last trial of a season Ultimate -- and stage_table gives them away in
 * NOTHING. All four rows carry the same code (TN-1), the same name, difficulty
 * NORMAL, diffGroup NONE, apCost 0, dangerLevel "-", no hardStagedId, and a
 * mainStageId that points at the season's FIRST stage rather than at the parent of
 * this one (act6bossrush_fin04 claims act6bossrush_01, which is TN-1, while it is
 * itself a tier of TN-4). Read as stages, that is 13 cards per season for 4 fights.
 *
 * activity_table has the answer outright, so none of it has to be inferred from the
 * ids: BOSS_RUSH[act].stageGroupMap holds one group per trial, and each group's
 * stageIdMap names its tiers by key --
 *
 *   act6bossrush_group01  { NORMAL: _01, TEAM: _tm01, EX: _ex01 }
 *   act6bossrush_group04  { NORMAL: _04, TEAM: _tm04, EX: _ex04, SP: _fin04 }
 *
 * NORMAL is the base and the other three are its forms. TEAM is Orientation (the
 * game hands you a fixed squad), EX is Spectacular, SP is Ultimate.
 */
const TRIAL_KIND = { TEAM: 'orientation_trial', EX: 'spectacular_trial', SP: 'ultimate_trial' };

export function bossRushTrials(bossRush = {}) {
  const tiers = new Map();
  const parents = new Map();
  for (const act of Object.values(bossRush || {})) {
    for (const group of Object.values(act.stageGroupMap || {})) {
      const ids = group.stageIdMap || {};
      const base = ids.NORMAL;
      for (const [key, sid] of Object.entries(ids)) {
        if (!sid || key === 'NORMAL') continue;
        const kind = TRIAL_KIND[key];
        // An unknown key would otherwise become a silent extra stage, which is the
        // bug this whole function is fixing.
        if (!kind) continue;
        tiers.set(sid, kind);
        if (base) parents.set(sid, base);
      }
    }
  }
  return { tiers, parents };
}

/** child stage id -> parent stage id, across every variant kind. */
export function variantParents(stages, diffGroup, towers = {}, trials = new Map()) {
  const parent = new Map();
  // easy_/tough_ rows reach their normal sibling only through diffGroupTable.
  for (const [normalId, row] of Object.entries(diffGroup || {})) {
    for (const field of ['toughId', 'easyId']) {
      if (row[field]) parent.set(row[field], normalId);
    }
  }
  for (const [sid, s] of Object.entries(stages)) {
    if (s.hardStagedId) parent.set(s.hardStagedId, sid);
    if (s.sixStarStageId) parent.set(s.sixStarStageId, sid);
  }
  // SSS. A tower lists its stages and their hard-mode counterparts as two arrays in
  // the same order -- levels[i] and hardLevels[i] are the same layer -- and that is
  // the ONLY tie between them: stage_table marks both NORMAL/NONE with no
  // hardStagedId. Without this, every _ex stage came through as a stage in its own
  // right, so a six-stage SSS season listed twelve cards with each code and name
  // appearing twice, and the six _ex ones had no render because the render belongs to
  // the layer.
  for (const tower of Object.values(towers || {})) {
    const normal = tower.levels || [];
    const hard = tower.hardLevels || [];
    for (let i = 0; i < Math.min(normal.length, hard.length); i += 1) {
      if (hard[i] && normal[i]) parent.set(hard[i], normal[i]);
    }
  }
  // Trials for Navigator, from activity_table -- see bossRushTrials.
  for (const [child, base] of trials) parent.set(child, base);
  return parent;
}

/** The hard-mode half of every SSS tower, which is what marks those stages a form. */
export function hardModeLevels(towers = {}) {
  const out = new Set();
  for (const tower of Object.values(towers || {})) {
    for (const id of tower.hardLevels || []) if (id) out.add(id);
  }
  return out;
}

/**
 * stage id -> position within its own zone, from 0.
 *
 * This is TABLE ORDER, a property of the dump rather than a documented field:
 * stage_table ships its stages in the order the game lists them, which is what
 * produces the 0-1, TR-1, 0-2, TR-2 interleaving that no sort of ids or codes
 * reproduces. In 17 places, though, a stage sits ahead of a same-zone stage its
 * own unlockCondition names as a prerequisite, so this is a stable topological
 * sort keyed on table order: where the two agree the answer IS table order.
 */
export function tableOrder(stages) {
  const entries = Object.entries(stages);   // deliberately unsorted: see above
  const table = new Map();
  const seen = new Map();
  for (const [sid, stage] of entries) {
    const z = stage.zoneId;
    const n = seen.get(z) || 0;
    table.set(sid, n);
    seen.set(z, n + 1);
  }

  const byZone = new Map();
  for (const [sid, stage] of entries) {
    if (!byZone.has(stage.zoneId)) byZone.set(stage.zoneId, []);
    byZone.get(stage.zoneId).push(sid);
  }

  const order = new Map();
  for (const members of byZone.values()) {
    const inside = new Set(members);
    // Only same-zone prerequisites: a cross-zone one is a chapter gate, not a
    // position within this list.
    const needs = new Map(members.map((sid) => [sid, new Set(
      list(stages[sid].unlockCondition)
        .map((u) => u.stageId)
        .filter((id) => inside.has(id) && id !== sid),
    )]));

    const byTable = (a, b) => table.get(a) - table.get(b);
    const ready = members.filter((sid) => needs.get(sid).size === 0).sort(byTable);
    const blocking = new Map();
    for (const sid of members) {
      for (const prereq of needs.get(sid)) {
        if (!blocking.has(prereq)) blocking.set(prereq, []);
        blocking.get(prereq).push(sid);
      }
    }
    const remaining = new Map(members.map((sid) => [sid, needs.get(sid).size]));
    const placed = [];
    while (ready.length) {
      const sid = ready.shift();
      placed.push(sid);
      for (const next of blocking.get(sid) || []) {
        remaining.set(next, remaining.get(next) - 1);
        if (remaining.get(next) === 0) {
          ready.push(next);        // keep table order among everything available
          ready.sort(byTable);
        }
      }
    }
    // A cycle would drop stages; fall back to table order for the remainder
    // rather than losing them.
    if (placed.length !== members.length) {
      const done = new Set(placed);
      placed.push(...members.filter((s) => !done.has(s)).sort(byTable));
    }
    placed.forEach((sid, i) => order.set(sid, i));
  }
  return order;
}

/**
 * zoneIndex is the slot within a display block, not the chapter: main_0, main_4
 * and main_9 all report 0. Take the numeric suffix of the zone id instead.
 */
export function chapterOf(stage, zoneId) {
  const m = /^main_(\d+)$/.exec(zoneId || '');
  if (m) return Number(m[1]);
  if (stage.stageType === 'MAIN') {
    // Chapters 15/16 ship inside MAINLINE_ACTIVITY zones with no main_N id;
    // their code prefix carries the chapter.
    const cm = /^(\d+)-/.exec(stage.code || '');
    if (cm) return Number(cm[1]);
  }
  return null;
}

/**
 * Which days a rotating supply stage is open. A stage with no entry is open
 * every day, which is not the same as a schedule we failed to read -- so absent
 * is null, never [].
 */
export function openOn(zoneId, weekly) {
  const days = ((weekly || {})[zoneId] || {}).daysOfWeek;
  if (!days || !days.length) return null;
  const named = [...new Set(days)].sort((a, b) => a - b).map((d) => WEEKDAY[d]).filter(Boolean);
  return named.length ? named : null;
}

/**
 * `value` times the 3-star bonus as an integer, or null if it is not one. Every
 * expGain and goldGain in the table is a multiple of 5 and the bonus is 1.2, so
 * this is exact and no rounding policy has to be invented. A future dump that
 * breaks that gets a null, not a silently rounded number.
 */
export function scaled(value, bonus) {
  if (bonus == null || !Number.isInteger(value)) return null;
  const exact = value * bonus;
  const rounded = Math.round(exact);
  if (Math.abs(exact - rounded) > 1e-9) return null;
  return rounded;
}

export function threeStarBonus(gamedataConst) {
  const bonus = (gamedataConst || {}).completeGainBonus;
  return typeof bonus === 'number' && bonus > 0 ? bonus : null;
}

/** The identity half of a record, with the keys in the order the site's files use. */
export function identityFields(sid, s, ctx) {
  const zoneId = s.zoneId;
  const zone = (ctx.zones || {})[zoneId] || {};
  const tower = (ctx.towers || {})[zoneId] || {};

  const kind = variantKind(s, ctx.hardModeLevels ? ctx.hardModeLevels.has(sid) : false,
    ctx.trialTiers ? ctx.trialTiers.get(sid) || null : null);
  let variant = null;
  if (kind !== null) {
    const parentId = ctx.parents.get(sid) || null;
    const parent = (parentId && ctx.stages[parentId]) || {};
    variant = {
      kind,
      label: VARIANT_LABEL[kind] ?? null,
      of_stage_code: text(parent.code) ?? null,
      of_stage_id: parentId,
      // .lower() only here -- no backslash normalisation, unlike levelKey.
      shares_parent_level_file: Boolean(parentId
        && (s.levelId || '').toLowerCase() === (parent.levelId || '').toLowerCase()),
    };
  }

  // Tower (SSS) zones carry no display name in zone_table; theirs live in
  // climb_tower_table, keyed by the very same zone id.
  const zoneName = text(zone.zoneNameSecond) || text(tower.name);
  let zoneGroup = text(zone.zoneNameFirst) || text(tower.subName);
  if (zoneGroup === zoneName) zoneGroup = null;   // some zones repeat themselves

  const ap = s.apCost;
  const level = text(s.dangerLevel);
  const exp = s.expGain ?? null;
  const lmd = s.goldGain ?? null;

  const out = {
    slug: ctx.slugs.get(sid),
    id: sid,
    code: text(s.code),
    name: text(s.name),
    description: text(s.description),
    stage_type: (s.stageType || '').toLowerCase() || null,
    variant,
    chapter: chapterOf(s, zoneId),
    zone: { id: zoneId, name: zoneName ?? null, group: zoneGroup ?? null, type: (zone.type || '').toLowerCase() || null },
    // The Act above the Episode, for a story stage; null everywhere else,
    // because only the mainline is cut into Acts.
    act: ctx.acts.get(zoneId) ?? null,
    event: eventOf(sid, s, ctx.zoneToActivity, ctx.activityInfo),
    order: ctx.order.get(sid),
    available_on: openOn(zoneId, ctx.weekly),
    difficulty: { tier: (s.difficulty || '').toLowerCase() || null, recommended_level: level === '-' ? null : level },
    // apCost -1 means the stage is paid for with an event token, so the cost is
    // unknown rather than free. 0 really is free (training, story environment).
    sanity_cost: ap != null && ap >= 0 ? ap : null,
    lmd,
    exp,
  };
  if (ctx.bonus != null) {
    out.lmd_3star = scaled(lmd, ctx.bonus);
    out.exp_3star = scaled(exp, ctx.bonus);
  }
  return out;
}

export { stageSlugs };
