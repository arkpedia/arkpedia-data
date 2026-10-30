/**
 * Guide videos: the pure half of the guide-videos refresh stage (sync-guide-videos.mjs), which
 * adds trusted creators' new YouTube guides to the operator records' `guides`.
 *
 * Two data files, both in arkpedia-data:
 *
 *   data/guide-creators.json      the trusted creators, kept by hand on the editorial branch
 *                                 (checkGuideCreators below; docs/development/data-pipelines.md
 *                                 says how to add one). The stage never writes it.
 *   data/guide-videos-state.json  what the stage remembers, written only by the stage: per
 *                                 channel, the day its whole upload history was read
 *                                 (backfilledAt, once, never again) and the newest upload a run
 *                                 handled (newest); the suggestions waiting for a person
 *                                 (pending), which the 'Guide suggestions' issue lists; and every
 *                                 video ever decided on (decided): added, suggested, or in a
 *                                 record's guides. A decided video is never added or suggested
 *                                 again, so a guide a person took out or moved stays where they
 *                                 left it, and a suggestion that dropped off the list stays off.
 *
 * A title is matched to operator records by their names, former names (aliases) and Chinese
 * names, through the lookup every lineup matcher uses (lineupNameLookup: case, marks and
 * separators aside, so "Kal'tsit Esperanta" is "Kal'tsit - Esperanta"), over every run of one to
 * N words in the title. A match inside a longer one is dropped, so "Blaze the Igniting Spark"
 * is the alter and not Blaze too. "<name> alter" is the alter that record's `alternate` names,
 * through the site's own alter map (lib/operators/operatorAliases.ts), or ambiguous when it
 * names two (Ch'en) or none. The stage therefore runs under tsx, which loads that TypeScript.
 *
 * A video is added to an operator's guides only when its title names exactly one operator and
 * reads as a guide to it: a guide word (GUIDE_WORDS, or one of the creator's own titlePatterns)
 * and none of the words of another kind of video (NOT_A_GUIDE: stage clears, tier lists, modules,
 * events, pulls...), tested with the operator's name taken out of the title. Every other title
 * that names an operator goes to the pending list for a person. A Short or a stream is ignored,
 * and an upload only the feed lists, not the channel's Videos tab (a past stream, which the feed
 * gives as an ordinary video), is never added by itself (sync-guide-videos.mjs marks it).
 * The names of the game's events and modes the release holds ("Maria Nearl", "Mizuki & Caerula
 * Arbor", "Dorothy's Vision") are taken out of a title before it is matched, so they never name
 * the operator inside them, and a title that names one goes to a person. An operator name that
 * is also an ordinary word (May, April, Ray) is a name only when capitalised, and a person decides.
 * Guides are appended after the record's own, never reordered or removed; a video already in
 * any record's guides is never added again, nor suggested.
 */
import { buildAliasMap } from '../../lib/operators/operatorAliases.ts';
import { lineupNameLookup } from './catalogue-model.mjs';

export const REGISTRY_FILE = 'data/guide-creators.json';
export const STATE_FILE = 'data/guide-videos-state.json';
export const VIDEO_ID = /^[\w-]{11}$/;
export const CHANNEL_ID = /^UC[\w-]{22}$/;
/** What stands for the operator's name in the title a pattern is tested against. */
export const PLACEHOLDER = '§';
/** A suggestion nobody acts on is dropped this many days after it was first listed. */
export const REVIEW_DAYS = 45;
/** The newest handled upload moves only once it has sunk this far down the feed, so a day a
 * creator uploads something does not by itself make the state file (and the release) change. */
export const MARKER_SLACK = 5;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The trusted creators, as data/guide-creators.json holds them:
 *   { "version": 1,
 *     "creators": [{ "name": "FrostByte262", "channelId": "UC...", "handle": "@FrostByte262",
 *                    "titlePatterns": ["^\\[Arknights\\] § 90lv"], "aliases": ["frostbyte"] }],
 *     "dismissed": ["<videoId>"] }
 * `name` is written into guides[].creator exactly as given. `aliases` are other spellings the
 * curated guides credit the same channel by ("whaleyyy337" for Whaleyyy), so a record with one
 * of those already has a guide by the creator. `titlePatterns` are extra case-insensitive
 * regular expressions a title of that creator reads as a guide by, tested with the operator's
 * name replaced by § (PLACEHOLDER). `dismissed` are suggestions a person turned down: never
 * suggested again. Throws on anything else, naming the file and the entry.
 */
export function checkGuideCreators(value) {
  const fail = why => { throw new Error(`${REGISTRY_FILE} ${why}`); };
  if (!isObject(value) || value.version !== 1) fail('is not a version 1 record');
  for (const key of Object.keys(value)) if (!['version', 'creators', 'dismissed'].includes(key)) fail(`has an unknown field "${key}"`);
  if (!Array.isArray(value.creators)) fail('has no creators list');
  const names = new Set(), channels = new Set();
  const creators = value.creators.map((creator, index) => {
    const where = `creator ${index + 1}${typeof creator?.name === 'string' ? ` (${creator.name})` : ''}`;
    if (!isObject(creator)) fail(`${where} is not an object`);
    for (const key of Object.keys(creator)) if (!['name', 'channelId', 'handle', 'titlePatterns', 'aliases'].includes(key)) fail(`${where} has an unknown field "${key}"`);
    const { name, channelId, handle, titlePatterns = [], aliases = [] } = creator;
    const isName = value => typeof value === 'string' && Boolean(value.trim()) && value === value.trim() && value.length <= 60;
    if (!isName(name)) fail(`${where} needs a name, as guides[].creator spells it`);
    if (typeof channelId !== 'string' || !CHANNEL_ID.test(channelId)) fail(`${where} needs a channelId (UC and 22 more characters)`);
    if (handle !== undefined && (typeof handle !== 'string' || !/^@[\w.-]{3,30}$/.test(handle))) fail(`${where} has a handle that is not @name`);
    if (!Array.isArray(aliases) || !aliases.every(isName)) fail(`${where} has aliases that are not a list of names`);
    for (const spelling of [name, ...aliases]) {
      if (names.has(spelling.toLowerCase())) fail(`names ${spelling} twice`);
      names.add(spelling.toLowerCase());
    }
    if (channels.has(channelId)) fail(`lists channel ${channelId} twice`);
    channels.add(channelId);
    if (!Array.isArray(titlePatterns)) fail(`${where} has titlePatterns that are not a list`);
    const patterns = titlePatterns.map(pattern => {
      if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 200) fail(`${where} has an empty or overlong title pattern`);
      try {
        return new RegExp(pattern, 'iu');
      } catch (error) {
        return fail(`${where} has a title pattern that is not a regular expression: ${pattern} (${error.message})`);
      }
    });
    return { name, channelId, ...(handle ? { handle } : {}), titlePatterns: patterns, aliases };
  });
  const dismissed = value.dismissed ?? [];
  if (!Array.isArray(dismissed) || dismissed.some(id => typeof id !== 'string' || !VIDEO_ID.test(id))) fail('has a dismissed entry that is not a video id');
  return { creators, dismissed: new Set(dismissed) };
}

/**
 * The stage's own record (see the header); an absent file is an empty one. `decided` is
 * optional: the file as the one-time backfill wrote it has none, and the first run then counts
 * every video in a record's guides or on the pending list as decided.
 */
export function checkGuideState(value) {
  const fail = why => { throw new Error(`${STATE_FILE} ${why}`); };
  if (value === undefined || value === null) return { version: 1, creators: {}, pending: [], decided: [] };
  if (!isObject(value) || value.version !== 1 || !isObject(value.creators) || !Array.isArray(value.pending)) fail('is not {"version":1,"creators":{},"pending":[]}');
  for (const [channel, entry] of Object.entries(value.creators)) {
    if (!CHANNEL_ID.test(channel) || !isObject(entry)) fail(`has a malformed entry for ${channel}`);
    if (entry.backfilledAt !== undefined && !DAY.test(entry.backfilledAt)) fail(`has a backfilledAt for ${channel} that is not a day`);
    if (entry.newest !== undefined && !VIDEO_ID.test(entry.newest)) fail(`has a newest upload for ${channel} that is not a video id`);
  }
  for (const entry of value.pending) {
    if (!isObject(entry) || !VIDEO_ID.test(entry.videoId ?? '') || typeof entry.creator !== 'string' || typeof entry.title !== 'string'
      || !Array.isArray(entry.operators) || typeof entry.reason !== 'string' || !DAY.test(entry.firstSeen ?? '')) fail(`has a malformed pending entry ${JSON.stringify(entry).slice(0, 120)}`);
  }
  const decided = value.decided ?? [];
  if (!Array.isArray(decided) || decided.some(id => typeof id !== 'string' || !VIDEO_ID.test(id))) fail('has a decided entry that is not a video id');
  return { ...value, decided };
}

/* ---- Matching ---- */

// What NFKD leaves composed, written the way titles spell the name without it ("Mlynar").
const TRANSLIT = { ł: 'l', Ł: 'L', ø: 'o', Ø: 'O', æ: 'ae', Æ: 'Ae', œ: 'oe', Œ: 'Oe', ð: 'd', Ð: 'D', þ: 'th', Þ: 'Th', ß: 'ss', đ: 'd', Đ: 'D', ı: 'i' };
const translit = text => text.replace(/[łŁøØæÆœŒðÐþÞßđĐı]/g, ch => TRANSLIT[ch]);
// Scripts without spaces between words: matched by substring (hanMatches), not as words.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const HAN_NAME = /^[\p{Script=Han}·・]{2,}$/u;
// A word: letters and digits, with an apostrophe or full stop inside it ("Kal'tsit", "Mr.").
const WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}]|['’.](?=[\p{L}\p{N}]))*/gu;
const ALTER = /^alt(?:er)?s?$/i;
const folded = text => translit(String(text)).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

function words(title) {
  // "w/" is "with", not W. Spaces keep every offset.
  const text = title.replace(CJK, ch => ' '.repeat(ch.length)).replace(/(^|[^\p{L}\p{N}])[wW]\//gu, (whole, before) => `${before}  `);
  return [...text.matchAll(WORD)].map(m => ({ text: m[0].replace(/['’]s$/i, ''), start: m.index, end: m.index + m[0].length }));
}

/**
 * Operator names that are also ordinary words: "What to Build in May", "you may need this",
 * "Ray tracing". Such a name is a name only as a capitalised word, and a title that names an
 * operator only through one goes to a person, never added by itself. Folded (lower case, no
 * marks); the months are here for the operators named after one.
 */
export const ORDINARY_WORD_NAMES = new Set(['may', 'april', 'ray', 'january', 'february', 'march', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
/** The same for Chinese names, matched as substrings: 医生 is "doctor" (Doc), 四月 is April the month. */
export const ORDINARY_HAN_NAMES = new Set(['医生', '四月', '五月', '一月', '二月', '三月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']);
/**
 * Event and mode names the release does not hold, because the game no longer has them: the
 * first Integrated Strategies, which the stage tables do not list.
 */
export const RETIRED_MODE_NAMES = ["Ceobe's Fungimist"];
/** The words a game-content name is compared by: folded, without "and"/"&" ("Mizuki and Caerula Arbor"). */
const nameWords = name => words(String(name).normalize('NFKC')).map(token => folded(token.text)).filter(part => part && part !== 'and');

/**
 * The names of the game's events, Integrated Strategies themes, Contingency Contract seasons,
 * Stationary Security Service maps, story episodes and Reclamation Algorithm seasons, from the
 * release's own records: data/stages-content.json (`stagesContent`, each entry's kind and
 * name) and the event lists of data/event-rewards.json and data/event-stores.json, whose names
 * carry the wiki's marks ("[Side Story] Maria Nearl", "[Rerun] Dorothy's Vision Rerun",
 * "Dorothy's Vision - Retrospection"), taken off here. A name with a subtitle ("Ideal City:
 * Endless Carnival") is also its title alone, and "Mizuki & Caerula Arbor" also "Caerula Arbor".
 * Not the annihilation maps, which are named after nations ("Victoria" is in "Vina Victoria"),
 * nor the supply stages ("Tough Siege"). Distinct, in no particular order.
 */
export function gameContentNames({ stagesContent = null, eventRewards = null, eventStores = null } = {}) {
  const KINDS = new Set(['event', 'integrated_strategies', 'contingency_contract', 'sss', 'story', 'reclamation']);
  const raw = [
    ...Object.values(isObject(stagesContent) ? stagesContent : {}).filter(entry => isObject(entry) && KINDS.has(entry.kind)).map(entry => entry.name),
    ...Object.keys(isObject(eventRewards?.events) ? eventRewards.events : {}),
    ...Object.keys(isObject(eventStores?.events) ? eventStores.events : {}),
  ].filter(name => typeof name === 'string');
  const names = new Set();
  for (const name of raw) {
    const clean = name.normalize('NFKC').replace(/^\[[^\]]*\]\s*/, '').replace(/\s+Rerun$/i, '').replace(/\s+[-‐–—]\s+Retrospection$/i, '').replace(/\s+(?:19|20)\d\d$/, '').trim();
    if (!clean) continue;
    names.add(clean);
    const title = clean.split(/:\s/)[0];
    if (title !== clean) names.add(title.trim());
    const [, after] = clean.split(/\s+&\s+/);
    if (after) names.add(after.trim());
  }
  return [...names];
}

/**
 * What a title is matched against: every operator record by its name, former names and Chinese
 * names, and each base operator's alters, and the game-content names (gameContentNames, plus
 * RETIRED_MODE_NAMES) that are taken out of a title first. A content name of one word is left
 * out ("Babel", "Crossing": ordinary words), and so is one that is an operator's name, or part of
 * one. Built once per run from the records.
 */
export function guideIndex(records, { modes = [] } = {}) {
  const entries = [];
  const han = new Map();
  let maxWords = 1;
  for (const record of records) {
    const names = [record.name, ...(record.aliases ?? [])].filter(name => typeof name === 'string' && name.trim());
    for (const name of names) {
      entries.push([translit(name), record]);
      maxWords = Math.max(maxWords, words(name).length);
    }
    const chinese = Object.entries(record.otherLanguages ?? {}).filter(([language, name]) => /Chinese/.test(language) && typeof name === 'string').map(([, name]) => name);
    for (const name of [...names, ...chinese].filter(name => HAN_NAME.test(name))) {
      const held = han.get(name) ?? new Set();
      held.add(record);
      han.set(name, held);
    }
  }
  const byName = new Map(records.map(record => [record.name, record]));
  const aliasMap = buildAliasMap(records);
  const lookup = lineupNameLookup(entries);
  const operatorWords = entries.map(([name]) => ` ${nameWords(name).join(' ')} `);
  const modeList = [...new Map([...modes, ...RETIRED_MODE_NAMES].map(name => [nameWords(name).join(' '), name])).entries()]
    .map(([key, name]) => ({ name, words: key.split(' ') }))
    .filter(({ name, words: parts }) => parts.length >= 2 && !lookup(translit(name)) && !operatorWords.some(text => text.includes(` ${parts.join(' ')} `)))
    .sort((a, b) => b.words.length - a.words.length);
  return {
    lookup,
    maxWords,
    // Longest first, so "Mizuki & Caerula Arbor" goes before "Caerula Arbor".
    modes: modeList,
    // Longest first, so 浊心斯卡蒂 is found before 斯卡蒂 inside it.
    han: [...han].sort((a, b) => b[0].length - a[0].length),
    // A base operator's alters (its `alternate`, as the site's alter map resolves it), and
    // whether a record is itself someone's alter.
    alters: record => (record.alternate ? (aliasMap[record.name] ?? []).map(name => byName.get(name)).filter(Boolean) : []),
    isAlter: record => !record.alternate && Boolean(aliasMap[record.name]?.length),
    // The words of an alter's name its base's name does not have, three letters or more and not
    // "the": "kirin" of Kirin R Yato, "igniting" and "spark" of Blaze the Igniting Spark.
    ownWords: (alter, base) => {
      const baseWords = new Set(words(base.name).map(token => folded(token.text)));
      return words(alter.name).map(token => folded(token.text)).filter(part => part.length >= 3 && part !== 'the' && !baseWords.has(part));
    },
  };
}

/**
 * The game-content names in a title, and the title with each blanked out (spaces, so every
 * offset holds): { text, modes: [name] }. Compared word by word, case and marks aside, with
 * "and"/"&" left out, so "Phantom and Crimson Solitaire" is the theme too.
 */
function blankModes(title, index) {
  const tokens = words(title);
  const kept = tokens.map((token, at) => ({ part: folded(token.text), at })).filter(({ part }) => part && part !== 'and');
  const taken = new Set(), modes = [];
  let text = title;
  for (const mode of index.modes ?? []) {
    const n = mode.words.length;
    for (let k = 0; k + n <= kept.length; k++) {
      if (!mode.words.every((part, j) => kept[k + j].part === part)) continue;
      const first = kept[k].at, last = kept[k + n - 1].at;
      if ([...Array(last - first + 1).keys()].some(step => taken.has(first + step))) continue;
      for (let at = first; at <= last; at++) taken.add(at);
      const [start, end] = [tokens[first].start, tokens[last].end];
      text = `${text.slice(0, start)}${' '.repeat(end - start)}${text.slice(end)}`;
      if (!modes.includes(mode.name)) modes.push(mode.name);
    }
  }
  return { text, modes };
}

/**
 * The operators a title names: { operators: [record], ambiguous: [why], spans: [[start, end]],
 * modes: [name], ordinary: [word] }. `operators` is distinct records in title order;
 * `ambiguous` says why the title names an operator it cannot settle on (an alter of a base with
 * two, a Chinese name two records share). `modes` are the game-content names the title has,
 * blanked out before any operator is looked for (so `title`, which the spans index, is the title
 * without them); `ordinary` the ordinary-word names (ORDINARY_WORD_NAMES) an operator was named
 * by and nothing else.
 */
export function matchTitle(rawTitle, index) {
  const { text: title, modes } = blankModes(String(rawTitle ?? '').normalize('NFKC'), index);
  const tokens = words(title);
  const found = [];
  for (let n = Math.min(index.maxWords, tokens.length); n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const run = tokens.slice(i, i + n);
      const said = run.map(token => token.text).join(' ');
      const record = index.lookup(translit(said));
      if (!record) continue;
      const ordinary = ORDINARY_WORD_NAMES.has(folded(said));
      // A one- or two-letter name ("W", "Yu"), or an ordinary word ("May"), only as its own
      // capitalised word.
      if ((ordinary || folded(record.name).length <= 2) && !/^[\p{Lu}\p{N}]/u.test(run[0].text)) continue;
      if (found.some(other => i < other.i + other.n && other.i < i + n)) continue;
      found.push({ i, n, record, ordinary: ordinary ? said : null });
    }
  }
  const ambiguous = [];
  // Only quotes and brackets may stand between a name and "alter": 'Silence "Alters" the Meta',
  // "(Alter Angelina)".
  const adjacent = (from, to) => /^[\s"'“”‘’()]*$/u.test(title.slice(from, to));
  const latin = found.sort((a, b) => a.i - b.i).map(({ i, n, record, ordinary }) => {
    let span = [tokens[i].start, tokens[i + n - 1].end];
    const next = tokens[i + n], before = tokens[i - 1];
    const word = next && ALTER.test(next.text) && adjacent(span[1], next.start) ? next
      : before && ALTER.test(before.text) && adjacent(before.end, span[0]) ? before : null;
    if (!word) {
      // A base name next to a word only its alter's name has ("Kirin X Yato", "Skadi Corrupting
      // Heart") is not the base, and not certainly the alter either.
      const near = new Set(tokens.slice(Math.max(0, i - 2), i).concat(tokens.slice(i + n, i + n + 2)).map(token => folded(token.text)));
      const hinted = index.alters(record).filter(alter => index.ownWords(alter, record).some(part => near.has(part)));
      if (!hinted.length) return { record, span, ordinary };
      ambiguous.push(`"${record.name}" stands next to a word of ${hinted.map(alter => alter.name).join(' and ')}`);
      return { record: null, span, candidates: [record, ...hinted] };
    }
    // An alter's own name next to the word ("Hoshiguma the Breacher (Hoshiguma Alter)") is that alter.
    if (index.isAlter(record)) return { record, span };
    span = [Math.min(span[0], word.start), Math.max(span[1], word.end)];
    const alters = index.alters(record);
    if (alters.length === 1) return { record: alters[0], span };
    ambiguous.push(alters.length ? `"${record.name} alter" could be ${alters.map(alter => alter.name).join(' or ')}` : `"${record.name} alter" names no alter`);
    return { record: null, span, candidates: alters.length ? alters : [record] };
  });
  const taken = latin.map(match => match.span);
  const hanFound = [];
  for (const [name, records] of index.han) {
    for (let at = title.indexOf(name); at !== -1; at = title.indexOf(name, at + 1)) {
      const span = [at, at + name.length];
      if (taken.some(([start, end]) => span[0] < end && start < span[1])) continue;
      taken.push(span);
      if (records.size === 1) hanFound.push({ record: [...records][0], span, ordinary: ORDINARY_HAN_NAMES.has(name) ? name : null });
      else {
        ambiguous.push(`${name} is the Chinese name of ${[...records].map(record => record.name).join(' and ')}`);
        hanFound.push({ record: null, span, candidates: [...records] });
      }
    }
  }
  const matches = [...latin, ...hanFound].sort((a, b) => a.span[0] - b.span[0]);
  const operators = [...new Set(matches.map(match => match.record).filter(Boolean))];
  const candidates = [...new Set(matches.flatMap(match => (match.record ? [match.record] : match.candidates)))];
  // An operator named only by an ordinary word, not also by a name that is not one.
  const ordinary = operators.flatMap(record => {
    const by = matches.filter(match => match.record === record);
    return by.every(match => match.ordinary) ? [by[0].ordinary] : [];
  });
  return { title, operators, candidates, ambiguous, spans: matches.map(match => match.span), modes, ordinary };
}

/** The title with every operator name replaced by § (PLACEHOLDER): what patterns are tested on. */
export function withPlaceholder(title, spans) {
  let out = '', at = 0;
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    out += `${title.slice(at, start)}${PLACEHOLDER}`;
    at = end;
  }
  return out + title.slice(at);
}

/** Words that make a title about one operator read as a guide to that operator. */
export const GUIDE_WORDS = new RegExp([
  String.raw`\bguides?\b`, String.raw`\breview\b`, String.raw`\banaly[sz]is\b`, String.raw`\bshowcase\b`, String.raw`\bspotlight\b`, String.raw`\bbreakdown\b`,
  String.raw`\boverview\b`, String.raw`\bmechanics\b`, String.raw`\btips\b`, String.raw`\boperator (?:hindsight|profile)\b`,
  String.raw`\bhow to (?:\(?\w+\)? )?(?:use|play|build)\b`, String.raw`\bso you want to use\b`,
  // "Should you get and build §?", "Should you pull for her?" -- not a banner's bare "Should you pull?".
  String.raw`\b(?:should|must) (?:you |i )?(?:\w+ (?:&|and) )?(?:get|build|pull|save|buy|whale|use|invest|skip|roll)(?: (?:&|and) \w+)?(?: (?:on|for|in))? (?:§|him|her|them)`,
  String.raw`\byou (?:absolutely |really )?need (?:to (?:get|build|pull|save for|use) )?§`, String.raw`\bworth (?:it|getting|pulling|building|using|investing)\b`,
  String.raw`\beverything (?:you )?(?:need to |didn't |should )?know about §`, String.raw`\ball about §`,
  String.raw`\bdemonstration\b`, String.raw`\bexplanation\b`, String.raw`\bin-depth\b`, String.raw`\bdeep dive\b`,
].join('|'), 'iu');
/** Words of another kind of video: a title with one of them is never added by itself. Any case. */
export const NOT_A_GUIDE = new RegExp([
  'tier ?list', String.raw`\branking\b`, String.raw`\btop \d+\b`,
  String.raw`\bmodules?\b`, String.raw`\bstages?\b`, String.raw`\bclear(?:s|ed|ing)?\b`, String.raw`\bsolos?\b`, String.raw`\bduos?\b`,
  String.raw`\bselectors?\b`, String.raw`\bbanners?\b`, String.raw`\bevents?\b`, String.raw`\bstronghold\b`, String.raw`\bvector breakthrough\b`,
  String.raw`\bcontingency contract\b`, String.raw`\bintegrated strategies\b`, String.raw`\bstationary security\b`, String.raw`\bannihilation\b`,
  String.raw`\blow[- ]?rarity\b`, String.raw`\btrust\b`, String.raw`\bfarm(?:ing)?\b`, String.raw`\blore\b`, String.raw`\bstory\b`, String.raw`\bskins?\b`,
  String.raw`\boutfits?\b`, String.raw`\bteams?\b`, String.raw`\bsquads?\b`, String.raw`\b\d+\s*(?:pulls|rolls|summons)\b`, String.raw`\bpulling\b`,
  String.raw`\bsummon(?:s|ing)?\b`, String.raw`\bgacha\b`, String.raw`\bspark(?:s|ing|ed)?\b`, String.raw`\bvs\.?(?=\s|$)`, String.raw`\bversus\b`,
  String.raw`\bcompar(?:e|ed|ing|ison)\b`, String.raw`\bnerf`, String.raw`\bbuff`, String.raw`\bleaks?\b`, String.raw`\bspeedrun`, String.raw`\bmemes?\b`,
  String.raw`\bcosplay\b`, String.raw`\bmusic\b`, String.raw`\btrailer\b`, String.raw`\bcollab(?:oration)?s?\b`, String.raw`\brate[- ]?ups?\b`,
  String.raw`\bmods?\b`, String.raw`\bparadox simulation\b`, String.raw`\breact(?:s|ion|ing)?\b`, String.raw`\bvoices?\b`,
  // How the creators write an event or an Integrated Strategies theme when not by its full name
  // ("Mizuki Roguelike", "Mizuki Arbor", "Crimson Solitare", "Grani Rerun", "Gavial Returns"):
  // the release's names are blanked out of a title only as written in full (gameContentNames).
  String.raw`\brogue-?likes?\b`, String.raw`\breruns?\b`, String.raw`\barbor\b`, String.raw`\bcaerula\b`, String.raw`\bsolitai?re\b`, String.raw`\bfungimist\b`,
  // Several operators ("Welfare Operators Showcase"), a channel special, one part of a series.
  String.raw`\boperators\b`, String.raw`\bsub(?:scriber)?s? special\b`, String.raw`\b\d+k sub(?:scriber)?s?\b`, String.raw`\bpart (?:\d+|[ivx]+)\b`,
  // The same in Chinese titles, which have no spaces between words: Contingency Contract, Integrated
  // Strategies (and its nickname), Annihilation, Challenge Mode, Stationary Security, event, outfit,
  // module, banner, pulls, collab, low rarity, solo, stage.
  '危机合约', '集成战略', '肉鸽', '剿灭', '突袭', '保全派驻', '活动', '皮肤', '时装', '模组', '卡池', '抽卡', '联动', '低配', '单核', '关卡',
  // Other games, some of whose characters share an operator's name (Arknights: Endfield's Ch'en).
  String.raw`\bendfield\b`, String.raw`\bzenless\b`, String.raw`\bgenshin\b`, String.raw`\bhonkai\b`, String.raw`\bstar ?rail\b`, String.raw`\bwuthering\b`,
  String.raw`\bblue archive\b`, String.raw`\blimbus\b`, String.raw`\breverse: ?1999\b`, String.raw`\bnikke\b`, String.raw`\bgray ?raven\b`, String.raw`\bazur lane\b`,
].join('|'), 'iu');
/**
 * The same in capitals only: mode and stage codes (CC#12, IS5, IS, H12-4, 1-7, H8 4, CW-8,
 * SV-EX-8, MN-EX 8, CW EX 8) and Challenge Mode (CM). Not a skill, elite or module level and a number
 * ("S3 10", "E2 90").
 */
export const NOT_A_GUIDE_CODES = new RegExp([
  // IS alone too ("Mizuki IS Beginner Guide"), but not the word in capitals between capitals
  // ("VIRTUOSA IS AMAZING", "HOW GOOD IS SKALTER", "IS SHE IMMORTAL"). "Returns" as an event's
  // title has it ("Gavial Returns"), not "the healer returns".
  String.raw`\bZZZ\b`, String.raw`\bCC ?#?\d`, String.raw`\bIS ?#?\d\b`, String.raw`(?<![A-Z]{2}[^\p{L}\p{N}\s]*\s+)\bIS\b(?!\s+[A-Z]{2,}\b)`, String.raw`\bReturns\b`, String.raw`\bSSS\b`, String.raw`\bLR\b`, String.raw`\bOST\b`, String.raw`\bPV\b`, String.raw`\bCM\b`,
  String.raw`\b[A-Z]{0,4}\d{1,2}-\d{1,2}\b`, String.raw`\b(?![SEM]\d )[A-Z]{1,4}\d{1,2} \d{1,2}\b`,
  String.raw`\b[A-Z]{2,4}-\s?(?:EX[- ]?)?\d{1,2}\b`, String.raw`\b[A-Z]{2,4} EX[- ]?\d{1,2}\b`,
].join('|'), 'u');
const notAGuide = text => NOT_A_GUIDE.test(text) || NOT_A_GUIDE_CODES.test(text);
/** A Short or a stream, by what the title can say: never a guide, never suggested. */
const NOT_A_VIDEO = /#shorts?\b|\blive ?stream|\bstream(?:s|ing|ed)?\b|\bVOD\b|\blive\b/iu;

/**
 * What to do with one upload of `creator`:
 *   { action: 'add', record, preferred }   its title names exactly one operator and reads as a
 *                                          guide; `preferred` when one of the creator's own
 *                                          titlePatterns says so (their series format)
 *   { action: 'review', records, reason, guideLike }
 *                                          it names an operator but cannot be added by itself;
 *                                          `guideLike` when it still has a guide word
 *   { action: 'ignore', reason }           a Short, a stream, or a title that names no operator
 */
export function classifyUpload(upload, creator, index) {
  if (upload.short) return { action: 'ignore', reason: 'a Short' };
  if (upload.live) return { action: 'ignore', reason: 'a stream' };
  const match = matchTitle(upload.title, index);
  const rest = withPlaceholder(match.title, match.spans);
  if (NOT_A_VIDEO.test(rest)) return { action: 'ignore', reason: 'a Short or a stream, by its title' };
  // "Maria Nearl Guide", "Magic Theorem - Dorothy's Vision Analysis": about the event, which only
  // has an operator's name in it.
  if (!match.candidates.length) return { action: 'ignore', reason: match.modes.length ? `names no operator outside ${match.modes.join(' and ')}` : 'names no operator' };
  const preferred = creator.titlePatterns.some(pattern => pattern.test(rest));
  const guideLike = preferred || GUIDE_WORDS.test(rest);
  const why = match.ambiguous.length ? match.ambiguous.join('; ')
    : match.operators.length > 1 ? 'names several operators'
    : match.modes.length ? `names ${match.modes.join(' and ')}, a game event or mode`
    : notAGuide(rest) ? 'reads as another kind of video'
    : !guideLike ? 'does not read as a guide'
    : match.ordinary.length ? `names ${match.operators[0].name} only as "${match.ordinary[0]}", which is also an ordinary word`
    : null;
  return why ? { action: 'review', records: match.candidates, reason: why, guideLike } : { action: 'add', record: match.operators[0], preferred };
}

const sameCreator = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
/** Existing credits may use the channel's registered handle (Whaleyyy / whaleyyy337).
 * Count that verified spelling too, without requiring an editorial migration first. */
const byCreator = (guide, creator) => [creator.name, ...(creator.aliases ?? []), ...(creator.handle ? [creator.handle.slice(1)] : [])]
  .some(name => sameCreator(guide?.creator, name));

/**
 * `list` (newest first) with each upload marked `old` when it is the newest upload an earlier run
 * handled (`newest`, the marker) or older: the backfill or an earlier night has decided on it.
 * Without the marker in the list, none is.
 */
export function markHandled(list, newest) {
  const at = newest ? list.findIndex(upload => upload.videoId === newest) : -1;
  return list.map((upload, position) => ({ ...upload, old: at !== -1 && position >= at }));
}

/**
 * Applies one creator's uploads (newest first, as a feed lists them) to the records and the
 * pending suggestions. A record gets at most one guide by each creator -- the curated guides never
 * hold two -- so of several of the creator's guides to one operator the one in their own series
 * format (titlePatterns) is added, else the newest, and the others are suggested; a record that
 * has one of theirs already (under its name or an alias) gets none. Guides are appended oldest
 * first, after the record's own.
 *
 *   present    every videoId in some record's guides (grows)
 *   pending    the state's suggestions, newest first (new ones are put in front)
 *   decided    every videoId the stage has added or suggested before, or seen in a record's
 *              guides: never classified again, so a guide a person removed is not added back and
 *              a suggestion that dropped off the list does not return
 *   backfill   a whole channel's history: only titles that read as a guide are suggested, not
 *              every old stage clear or outfit video that names an operator. An upload marked
 *              `old` (markHandled) is treated the same way, and is never added by itself: an
 *              earlier run has decided on it.
 *
 * Returns { added: [{ videoId, operator, title }], suggested: [entries], touched: Set of records }.
 */
export function applyUploads({ creator, uploads, index, present, pending, dismissed = new Set(), decided = new Set(), today, backfill = false }) {
  const listed = new Set(pending.map(entry => entry.videoId));
  const seen = new Set();
  const verdicts = [];
  uploads.forEach((upload, order) => {
    if (!VIDEO_ID.test(upload.videoId ?? '') || seen.has(upload.videoId) || present.has(upload.videoId) || dismissed.has(upload.videoId) || listed.has(upload.videoId)
      || decided.has(upload.videoId)) return;
    seen.add(upload.videoId);
    const verdict = classifyUpload(upload, creator, index);
    // An upload an earlier run read is never added by itself: not in a record's guides now, it was
    // taken out by hand, or its title reads differently since (a new name, a new rule). A state
    // file from before `decided` (the one-time backfill's) knows no guide taken out since.
    if (verdict.action === 'add' && upload.old) {
      verdicts.push({ upload, order, action: 'review', records: [verdict.record], guideLike: true, reason: `an earlier run read it and it is not in ${verdict.record.name}'s guides now` });
    // An upload only the feed lists, not the channel's Videos tab, is a past stream: the feed links
    // one as an ordinary video, with no live flag. One the tab could not be asked about tonight is
    // left for another night, undecided.
    } else if (verdict.action === 'add' && upload.unconfirmed) {
      return;
    } else if (verdict.action === 'add' && upload.feedOnly) {
      verdicts.push({ upload, order, action: 'review', records: [verdict.record], guideLike: true, reason: 'only the feed lists it, not the channel\'s Videos tab: likely a stream' });
    } else verdicts.push({ upload, order, ...verdict });
  });
  // One guide per creator per record: the chosen one, the rest suggested.
  const byRecord = new Map();
  for (const verdict of verdicts.filter(entry => entry.action === 'add')) byRecord.set(verdict.record, [...(byRecord.get(verdict.record) ?? []), verdict]);
  const chosen = [];
  for (const [record, candidates] of byRecord) {
    const theirs = (Array.isArray(record.guides) ? record.guides : []).some(guide => byCreator(guide, creator));
    const best = theirs ? null : [...candidates].sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.order - b.order)[0];
    for (const verdict of candidates) {
      if (verdict === best) { chosen.push(verdict); continue; }
      Object.assign(verdict, { action: 'review', records: [record], guideLike: true,
        reason: theirs ? `${record.name} already has a guide by ${creator.name}` : `${creator.name} has another guide to ${record.name}` });
    }
  }
  const added = [], touched = new Set();
  for (const { upload, record } of chosen.sort((a, b) => b.order - a.order)) {
    record.guides = [...(Array.isArray(record.guides) ? record.guides : []), { videoId: upload.videoId, creator: creator.name }];
    present.add(upload.videoId);
    touched.add(record);
    added.push({ videoId: upload.videoId, operator: record.name, title: upload.title });
  }
  // A stream (feedOnly) that names an operator is suggested only when it reads as a guide, too.
  const suggested = verdicts.filter(entry => entry.action === 'review' && ((!backfill && !entry.upload.old && !entry.upload.feedOnly) || entry.guideLike)).sort((a, b) => a.order - b.order)
    .map(({ upload, records, reason }) => ({ videoId: upload.videoId, creator: creator.name, title: String(upload.title).slice(0, 200),
      operators: records.map(record => record.name), reason, firstSeen: today }));
  pending.unshift(...suggested);
  return { added, suggested, touched };
}

/**
 * Whether the latest uploads (`feed`) reach back to the newest upload the last run handled. With
 * no marker, or the marker in the feed, the feed is enough (handling an upload twice changes
 * nothing). When it does not -- more uploads than the feed lists since the last good run, as after
 * a few days without one -- the caller lists the channel back to the marker (cutAtMarker).
 */
export const feedReaches = (feed, newest) => !newest || feed.some(upload => upload.videoId === newest);

/** A longer listing (newest first) cut where the last run stopped: { uploads, found }. */
export function cutAtMarker(listing, newest) {
  const at = listing.findIndex(upload => upload.videoId === newest);
  return at === -1 ? { uploads: listing, found: false } : { uploads: listing.slice(0, at), found: true };
}

/** The marker after a run that read `latest` (newest first): moved only when it has to be. */
export function nextMarker(newest, latest) {
  if (!latest.length) return newest;
  const at = newest ? latest.findIndex(upload => upload.videoId === newest) : -1;
  return at === -1 || at >= MARKER_SLACK ? latest[0].videoId : newest;
}

/** Pending suggestions still waiting: not added since, not dismissed, not older than REVIEW_DAYS. */
export function prunePending(pending, { present, dismissed = new Set(), today }) {
  const cutoff = Date.parse(`${today}T00:00:00Z`) - REVIEW_DAYS * 86_400_000;
  return pending.filter(entry => !present.has(entry.videoId) && !dismissed.has(entry.videoId) && Date.parse(`${entry.firstSeen}T00:00:00Z`) > cutoff);
}
