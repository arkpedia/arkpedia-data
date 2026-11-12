/**
 * Turning gamedata strings into the English the site prints.
 *
 * Two jobs, both of which were being done slightly differently in three build scripts
 * before this file existed, and one of them wrongly.
 *
 * RICH TEXT. The game marks up its own strings: `<@ba.vup>+20%</>` for a buff colour,
 * `<$ba.stun>` for a keyword link. The tables also use Unity's formatting tags: every
 * outfit blurb is wrapped in `<color name=#ffffff>…</color>`, and archives carry `<i>`.
 * All of those come out. Angle brackets are ALSO literal game text -- `<In battle>`,
 * `<When obtained>`, `<Sargon>`, even lowercase `<break>` and `<to be filled>` are words
 * the game prints on screen -- so a blanket `<[^>]*>` eats real words. A Unity tag is
 * only stripped when its name is one of Unity's and it has a tag's shape: bare
 * (`<i>`, `</color>`) or carrying a value (`<size=20>`, `<color name=#fff>`).
 * scripts/stage-pipeline/lib/names.mjs still uses the blanket version on stage codes,
 * where there is no prose to lose.
 *
 * BLACKBOARD. A description carries placeholders that the game fills from a per-level
 * `blackboard` array: `ATK <@ba.vup>+{atk:0%}</>` with `atk: 0.2` prints as `ATK +20%`.
 * The format suffix after the colon decides how the number reads, a leading `-` negates
 * it, and keys match case-insensitively because the tables are inconsistent about it.
 */

const UNITY_TAG = /<\/?(?:b|i|u|s|sub|sup|color|size|material|font|mark|style|link)(?:=[^<>]*|\s+[a-z-]+=[^<>]*)?\/?>/g;

/** Strips the game's own markup and leaves literal angle brackets alone. */
export function stripRichText(s) {
  return String(s ?? '')
    .replace(/<@[^>]*>|<\$[^>]*>|<\/>/g, '')
    .replace(UNITY_TAG, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Yostar's own spacing mistakes in building_data, repaired before the markup comes out.
 *
 * A few English buff descriptions run a word straight into the tag after it -- Mr. Nothing's
 * `grants<$cc.bd_b1>…Worldly Plight…</>`, Dusk's `by<@cc.vdown>+0.5</>` -- one closes a tag
 * straight into the next word (`<@cc.vup>1</>point`), and one closes a term straight into its
 * value (`Worldly Plight</></><@cc.vup>+1</>`). The tag is what kept those apart on the game's
 * own screen, so stripping it faithfully is what printed "grantsWorldly Plight+1". A stray `<`
 * before a tag belongs to the same family (Mulberry's printed "<Worldly Plight").
 *
 * The space goes in only where the neighbour is a letter, digit, `%` or comma. The other
 * characters that touch a tag in the table are all deliberate and must stay tight: `(` opens a
 * parenthesis ("(Special Comparison Rules apply"), `+` leads a second value (", +5% per level"),
 * `-` hyphenates ("non-Rhine Lab clue"). As of the 2026-10-30 Global table this repairs 12 of 640
 * buffs and changes no other description. Running it twice is the same as running it once.
 *
 * This is NOT part of stripRichText, which serves every other kind of game text: these
 * neighbours have only been shown to be mistakes in building_data. The two places that build a
 * base skill's English call it -- scripts/imports/import-base-skills.mjs (reconcileBaseSkills,
 * the catalogue's) and scripts/sync/sync-operator-english.mjs (officialBaseSkills).
 *
 * Keyword underlining is unaffected: baseSkillKeywords reads the tags from the raw description
 * and only asks whether the finished text still contains the term, which stays whole here.
 */
export function normaliseBaseSkillText(description) {
  return String(description ?? '')
    /* A stray `<` immediately before a real tag. A lone `<` elsewhere is literal game text
       ("<In battle>"), so only the doubled-up form goes. */
    .replace(/<(?=<[@$])/g, '')
    .replace(/([A-Za-z0-9%,])(?=<[@$])/g, '$1 ')
    /* No description tags a word and then continues it, so a close touching a letter is a missing
       space. If a future one ever does -- `<@cc.kw>Guard</>s` reading "Guard s" -- this is the
       line that did it, and that word wants an exception rather than the rule dropped. */
    .replace(/<\/>(?=[A-Za-z0-9])/g, '</> ')
    /* A term closing straight into the value tag that follows it, with nothing between the two to
       separate them. The table writes this with a space 660 times and without one 6 times, so the
       bare ones are mistakes rather than a house style. Anchored on the tag boundary, which is
       what keeps it off a hyphenated name the game means ("Lancet-2" carries no tag). */
    .replace(/([A-Za-z0-9])((?:<\/>)+)(?=<[@$][^<>]*>[+\-\d])/g, '$1$2 ');
}

/* `{key}`, `{key:0%}`, `{key:0.0}`, `{-key}`. The name may hold dots and dashes, so the
   optional format is split off at the LAST colon rather than the first. */
const PLACEHOLDER = /\{([^{}]+)\}/g;

function formatValue(value, format) {
  if (value == null) return '';
  const f = (format || '').trim();
  if (f.endsWith('%')) {
    /* A percentage is stored as a fraction. The digits before the point in the format say
       how many decimals to keep: `0%` is whole percent, `0.0%` is one decimal. */
    const dot = f.indexOf('.');
    const places = dot === -1 ? 0 : f.length - dot - 2;
    return `${(value * 100).toFixed(Math.max(0, places))}%`;
  }
  if (f.includes('.')) {
    const places = f.length - f.indexOf('.') - 1;
    return value.toFixed(Math.max(0, places));
  }
  if (f) return String(Math.round(value));
  /* No format given: print it the way a person would, so 2 stays 2 and 2.5 stays 2.5
     rather than becoming 2.000000. */
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

/**
 * Fills a description's placeholders from its blackboard.
 *
 * Returns { text, missing } rather than throwing: a caller building a data file should
 * fail its own build on `missing`, and one rendering a single string may prefer to keep
 * going. Leaving a `{key}` visible on the page is the failure worth catching, so no
 * caller should ignore it.
 */
export function interpolateBlackboard(description, blackboard) {
  const byKey = new Map();
  for (const entry of Array.isArray(blackboard) ? blackboard : []) {
    if (entry?.key == null) continue;
    byKey.set(String(entry.key).toLowerCase(), entry);
  }

  const missing = [];
  const text = String(description ?? '').replace(PLACEHOLDER, (whole, body) => {
    const colon = body.lastIndexOf(':');
    let name = (colon === -1 ? body : body.slice(0, colon)).trim();
    const format = colon === -1 ? '' : body.slice(colon + 1);

    let negate = false;
    if (name.startsWith('-')) { negate = true; name = name.slice(1); }

    const entry = byKey.get(name.toLowerCase());
    if (!entry) { missing.push(name); return whole; }

    /* valueStr wins when present: a few skills carry text where a number would go. */
    if (entry.valueStr != null && entry.valueStr !== '') return String(entry.valueStr);

    const value = negate ? -Number(entry.value) : Number(entry.value);
    return formatValue(value, format);
  });

  return { text: stripRichText(text), missing };
}
