/**
 * data/game-modes.json: how the game's activity types map onto the Terminal. A record kept
 * by hand in arkpedia-data, so a new season or mode is a data edit, not a code deploy.
 *
 *   excludedActivityTypes  activity type -> what it is: the limited-time game modes that
 *                          close for good, whose stages the list never offers
 *                          (scripts/build/build-mode-exclusions.mjs)
 *   seasonalChallenges     the challenge modes the game files as events but shows under
 *                          Seasonal Challenge, each with the display code its contents
 *                          carry, the activity types it runs as, and its emblem in
 *                          public/mode-marks/ (or null)
 *   storyActivityTypes     a pattern for the story episodes: side stories, story
 *                          collections and the like, which list as ordinary events
 *
 * These were a denylist in build-mode-exclusions.mjs and two labels ('VEC', 'TN') in
 * lib/stages/terminal.ts and stageTypes.ts. An activity type none of them names (a new
 * MULTIPLAY_V4, say) was listed as an ordinary event with no alert, and fixing it took an
 * app commit, which deploys. Now build-mode-exclusions holds every such content in
 * data/quarantine.json, naming the type, until this record classifies it.
 */

/** The shape, checked wherever the record is read. Throws on anything else. */
export function checkGameModes(value) {
  const fail = (why) => { throw new Error(`data/game-modes.json ${why}`); };
  if (!value || typeof value !== 'object' || value.version !== 1) fail('is not a version 1 record');
  const excluded = value.excludedActivityTypes;
  if (!excluded || typeof excluded !== 'object' || Array.isArray(excluded)
    || !Object.entries(excluded).every(([type, what]) => /^[A-Z0-9_]+$/.test(type) && typeof what === 'string' && what.trim())) {
    fail('needs excludedActivityTypes: {"<ACTIVITY_TYPE>": "<what it is>"}');
  }
  const challenges = value.seasonalChallenges;
  if (!Array.isArray(challenges) || !challenges.every((c) => c && typeof c === 'object'
    && typeof c.label === 'string' && c.label.trim() && typeof c.name === 'string' && c.name.trim()
    && Array.isArray(c.activityTypes) && c.activityTypes.length && c.activityTypes.every((t) => /^[A-Z0-9_]+$/.test(t))
    && (c.mark === null || (typeof c.mark === 'string' && /^[\w.-]+\.(svg|webp|png)$/.test(c.mark))))) {
    fail('needs seasonalChallenges: [{"label", "name", "activityTypes": [...], "mark": "<file>" | null}]');
  }
  if (new Set(challenges.map((c) => c.label)).size !== challenges.length) fail('names one seasonal challenge label twice');
  if (typeof value.storyActivityTypes !== 'string') fail('needs storyActivityTypes: a pattern');
  try { new RegExp(value.storyActivityTypes); } catch { fail('has a storyActivityTypes that is not a pattern'); }
  const claimed = new Map();
  for (const type of Object.keys(excluded)) claimed.set(type, 'excludedActivityTypes');
  for (const challenge of challenges) {
    for (const type of challenge.activityTypes) {
      if (claimed.has(type)) fail(`files ${type} under both ${claimed.get(type)} and seasonalChallenges`);
      claimed.set(type, 'seasonalChallenges');
    }
  }
  return value;
}

/**
 * What an activity type is: {as: 'excluded' | 'challenge' | 'story' | 'unknown', challenge?}.
 * 'unknown' is a type the record does not classify, which is a new mode until someone says
 * otherwise.
 */
export function classifyActivity(type, modes) {
  if (Object.hasOwn(modes.excludedActivityTypes, type)) return { as: 'excluded' };
  const challenge = modes.seasonalChallenges.find((c) => c.activityTypes.includes(type));
  if (challenge) return { as: 'challenge', challenge };
  if (new RegExp(modes.storyActivityTypes).test(type)) return { as: 'story' };
  return { as: 'unknown' };
}

/** The display codes the Seasonal Challenge scene claims ('VEC', 'TN'). */
export function challengeLabels(modes) {
  return modes.seasonalChallenges.map((c) => c.label);
}
