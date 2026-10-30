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
