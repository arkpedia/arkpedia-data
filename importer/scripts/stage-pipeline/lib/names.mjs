// Stage naming. Every builder that writes a file per stage has to agree on the
// stem, so the map is derived once, from the WHOLE table: deriving it from a
// subset changes which codes collide and therefore which get disambiguated.

/** A display name as a lowercase, underscore-separated identifier. */
export function slug(s, fallback = 'unknown') {
  let out = String(s ?? '').replace(/<[^>]*>/g, '');
  out = out.replace(/[’']/g, '');                 // Rhodes' -> rhodes
  out = out.replace(/[^0-9A-Za-z]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return out || fallback;
}

/** Stage codes are already human -- 1-7, S3-2, TR-1 -- so the hyphen stays. */
export function stageSlug(code) {
  let out = String(code ?? '').replace(/<[^>]*>/g, '');
  out = out.replace(/[^0-9A-Za-z-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '').toLowerCase();
  out = out.replace(/_+/g, '_');
  return out || 'unknown_stage';
}

// Hand-written, because these strings are not in the tables. six_star is null on
// purpose: the EN client has no word for that mode yet, so the site supplies its
// own ('Adverse Combat') rather than the pipeline inventing one.
export const VARIANT_LABEL = {
  challenge_mode: 'Challenge Mode',
  adverse_environment: 'Adverse Environment',
  story_environment: 'Story Environment',
  six_star: null,
  // SSS's own vocabulary: climb_tower_table calls the set hardLevels and describes
  // it under hardModeDesc, with its own hardModeMedalId.
  hard_mode: 'Hard Mode',
  // Trials for Navigator. The game's own words, from its unlock text: "Complete
  // Orientation Trial: TN-1 to unlock", "and Spectacular Trial: TN-1/TN-2/TN-3" --
  // and the reward medals are Spectacular Trial Medals. Only the fourth tier, which
  // exists on TN-4 alone, is named nowhere in the dump: activity_table types it SP
  // and prints nothing, so 'Ultimate Trial' is the name the EN client shows.
  orientation_trial: 'Orientation Trial',
  spectacular_trial: 'Spectacular Trial',
  ultimate_trial: 'Ultimate Trial',
};

/**
 * First match wins. difficulty and diffGroup are independent fields.
 *
 * `hardMode` is passed in rather than read off the stage, because SSS is the one mode
 * that does not say so on the stage: stage_table marks lt_05_01 and lt_05_01_ex both
 * NORMAL/NONE, with no hardStagedId between them and nothing but an `_ex` id to tell
 * them apart. The pairing is in climb_tower_table instead -- see variantParents.
 *
 * `trialTier` arrives the same way and for the same reason, one table further out:
 * Trials for Navigator marks all four tiers of a trial NORMAL/NONE with the same code
 * and the same name, and the tiers are only in activity_table -- see bossRushTrials.
 */
export function variantKind(stage, hardMode = false, trialTier = null) {
  if (trialTier) return trialTier;
  if (stage.difficulty === 'FOUR_STAR') return 'challenge_mode';
  if (stage.difficulty === 'SIX_STAR') return 'six_star';
  if (stage.diffGroup === 'TOUGH') return 'adverse_environment';
  if (stage.diffGroup === 'EASY') return 'story_environment';
  if (hardMode) return 'hard_mode';
  return null;
}

// When two stages share a code, the story one is what a reader means; tower and
// roguelike modes reuse codes freely and yield the plain name to them.
export const STAGE_RANK = {
  MAIN: 0, SUB: 1, ACTIVITY: 2, DAILY: 3, GUIDE: 4, SPECIAL_STORY: 5, CLIMB_TOWER: 6,
};

/**
 * Assigns unique slugs, breaking collisions with the game id. Deliberately not
 * first-come-wins, which would make a slug depend on iteration order and shift
 * between builds.
 */
export class SlugSet {
  constructor(fn = slug) {
    this._fn = fn;
    this._bySlug = new Map();
  }

  /** Lower rank wins a collision outright; a tie means nobody has a claim. */
  add(key, textValue, rank = 0) {
    const s = this._fn(textValue);
    if (!this._bySlug.has(s)) this._bySlug.set(s, []);
    this._bySlug.get(s).push([rank, key]);
  }

  resolve() {
    const out = new Map();
    for (const [s, entries] of this._bySlug) {
      if (entries.length === 1) {
        out.set(entries[0][1], s);
        continue;
      }
      const best = Math.min(...entries.map(([r]) => r));
      const winners = entries.filter(([r]) => r === best).map(([, k]) => k);
      for (const [, k] of entries) {
        // Only an unambiguous winner takes the bare slug. The suffix is spelled
        // by the same function as the base, or a raw game id smuggles uppercase
        // and hyphens into a name the contract promises is lowercase.
        out.set(k, winners.length === 1 && k === winners[0] ? s : `${s}_${this._fn(k)}`);
      }
    }
    return out;
  }
}

/** stage id -> filename stem, for EVERY stage in the table. */
export function stageSlugs(stages, trialTiers = new Map()) {
  const slugger = new SlugSet(stageSlug);
  const keys = new Map();
  for (const [sid, s] of Object.entries(stages)) {
    keys.set(sid, slug(sid));
    const code = (s.code || '').trim();
    // The tiers have to be here as well as in the record: without them the four
    // forms of TN-1 are four stages with the identical code, so all four lost the
    // bare slug and took a game id apiece (tn-1_act6bossrush_tm01).
    const kind = variantKind(s, false, trialTiers.get(sid) || null);
    const label = VARIANT_LABEL[kind] || (kind ? kind.replace(/_/g, ' ') : null);
    slugger.add(keys.get(sid), code && label ? `${code} ${label}` : code,
      STAGE_RANK[s.stageType] ?? 9);
  }
  const resolved = slugger.resolve();
  const out = new Map();
  for (const [sid, key] of keys) out.set(sid, resolved.get(key));
  return out;
}
