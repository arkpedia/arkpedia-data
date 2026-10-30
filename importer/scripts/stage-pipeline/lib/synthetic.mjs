// The 815 stages that exist only as a level file.
//
// IS nodes, Reclamation maps, Battleplan operations and the minigame levels have
// no stage_table row at all: the mode's own table names the level and nothing
// else does. They are still stages a reader can look at, so each gets a record
// built from the level file plus whatever display text the mode table carries.
import { excel, levelKey } from './gamedata.mjs';
import { text } from './text.mjs';
import { SlugSet, stageSlug } from './names.mjs';

/** Digits sort numerically and before text, so RA-9 precedes RA-10. */
export function natural(value) {
  return String(value ?? '').match(/\d+|\D+/g)?.map((part) => (
    /^\d+$/.test(part) ? [0, Number(part), ''] : [1, 0, part.toLowerCase()])) || [];
}

function compareNatural(a, b) {
  const x = natural(a); const y = natural(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i]; const q = y[i];
    if (!p) return -1;
    if (!q) return 1;
    for (let j = 0; j < 3; j++) {
      if (p[j] < q[j]) return -1;
      if (p[j] > q[j]) return 1;
    }
  }
  return 0;
}

/** Best-effort display text for mode stages absent from stage_table. */
export function tableLevelMetadata() {
  const out = new Map();
  const clean = (v) => (typeof v === 'string' ? text(v) : null);
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node == null || typeof node !== 'object') return;
    const levelId = levelKey(node.levelId);
    if (levelId) {
      if (!out.has(levelId)) out.set(levelId, {});
      const row = out.get(levelId);
      // First writer per field wins, across every table below.
      for (const [target, fields] of [['code', ['code', 'stageCode']],
        ['name', ['name', 'stageName', 'title']],
        ['description', ['description', 'desc']]]) {
        if (row[target]) continue;
        for (const field of fields) {
          const value = clean(node[field]);
          if (value) { row[target] = value; break; }
        }
      }
    }
    for (const value of Object.values(node)) walk(value);
  };
  for (const table of ['activity_table', 'roguelike_topic_table', 'sandbox_perm_table',
    'sandbox_table', 'crisis_table', 'crisis_v2_table']) {
    walk(excel(table));
  }
  return out;
}

/**
 * Slugs for the mode-only levels.
 *
 * A second, INDEPENDENT SlugSet: every existing record's slug is reserved at rank
 * 0 first, so a mode level can never take a player-facing stage's name, and the
 * levels themselves come in at rank 9. Most of the 630 suffixes are ties among
 * synthetics sharing one placeholder label (400 read 'ISW-NO'), where every tied
 * member is qualified by its level id.
 */
export function syntheticSlugs(records, missingLevels, entries, levelOwner, levelMeta) {
  const slugger = new SlugSet(stageSlug);
  // stage_slug is idempotent on an already-slugged string.
  for (const record of records) slugger.add(`stage:${record.id}`, record.slug, 0);
  for (const levelId of missingLevels) {
    const entry = entries.get(levelOwner.get(levelId));
    const codes = [...(entry?.levels.get(levelId) || [])].sort(compareNatural);
    const meta = levelMeta.get(levelId) || {};
    const label = codes[0] || meta.code || levelId.split('/').pop();
    slugger.add(`level:${levelId}`, label, 9);
  }
  return slugger.resolve();
}

/**
 * The level keys a content entry registered that no stage_table row claims.
 *
 * NATURALLY sorted, because this order becomes the records' `order` -- the loop in
 * build.mjs numbers them as it walks this list, and nothing else gives a level-only
 * stage a position. A plain .sort() is lexicographic, which put level_rogue5_b-10
 * between b-1-b and b-2: on the Integrated Strategies content page that is a grid of
 * boss nodes opening with b-10 and reaching b-4 fourth. Only ten-and-over is affected,
 * which is why it went unnoticed on the floors -- no floor has ten nodes.
 */
export function missingLevels(levelOwner, claimed) {
  return [...levelOwner.keys()].filter((key) => !claimed.has(key)).sort(compareNatural);
}

/**
 * One record for a mode level. Everything stage_table would have supplied is
 * null rather than invented -- no sanity cost, no rewards, no difficulty -- and
 * `source` states why the row exists at all.
 */
export function syntheticRecord(levelId, entry, code, meta, slug, fromLevel, order, content) {
  let chapter = null;
  if (entry.kind === 'story') {
    const match = /(\d+)$/.exec(entry.label || '');
    chapter = match ? Number(match[1]) : null;
  }
  return {
    slug,
    id: levelId,
    code: code ?? null,
    name: meta.name ?? null,
    description: meta.description ?? null,
    stage_type: entry.kind,
    variant: null,
    chapter,
    // The content entry restated as a zone: there is no real gamedata zone.
    zone: { id: entry.id, name: entry.name, group: entry.label, type: entry.kind },
    act: null,
    event: entry.kind === 'event'
      ? { id: entry.id, name: entry.name, type: null, is_rerun: false } : null,
    order,
    available_on: null,
    difficulty: { tier: null, recommended_level: null },
    sanity_cost: null,
    lmd: null,
    exp: null,
    lmd_3star: null,
    exp_3star: null,
    battle: fromLevel?.battle ?? null,
    enemies: fromLevel?.enemies ?? null,
    drops: [],
    preview: null,
    geometry: slug,
    source: 'mode level file; no stage_table row',
    content,
  };
}

export { compareNatural };
