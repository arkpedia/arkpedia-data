/**
 * Which official uploads belong to which event: the rules of the official-videos stage
 * (scripts/sync/sync-official-videos.mjs), kept apart from its YouTube reads so the tests run them
 * on recorded data. No fs and no network.
 *
 * The uploads are the official channels' own (data/official-video-channels.json, kept in
 * arkpedia-data), never a fan's. An upload goes to an event when:
 *
 *   - its title names the event, as whole words: "Arknights Official Trailer - Critical Phase
 *     Transition", "Arknights Animation PV - When Elegies Are Ashes Rerun". Between the event's
 *     words a title may carry only a season's filler ("Contingency Contract Season #1 Operation
 *     Pyrite" names "Contingency Contract Pyrite"; FILLER), never another word. A title can name two
 *     events ("Rhodes Island Icebreaker Games #1" names "Icebreaker Games #1" too), so only events
 *     whose Global window is near the upload are asked, and of those the longest name wins: the
 *     one that carries the title's qualifier ("#1", "Rerun", "Alliance"). A title that says
 *     "<event> Rerun" never goes to the first run;
 *   - it is an operator's preview ("Arknights - Kal'tsit Esperanta Preview") or an operator EP
 *     ("Arknights EP - Innocence", whose album data/albums.json lists with its operators), and the
 *     event's banner features that operator, near the event's window. A banner with no linked
 *     event is every event's that opens the same day (getBannerForEvent): the 2025-10-14 limited
 *     banner was Duel Channel's, Integrated Lookback's and The Masses' Travels'. Then the event
 *     with PVs of its own by title takes it, and if that leaves more than one, none does.
 *
 * Anything else (lore videos, livestreams, shorts) goes to no event by itself. A person adds or
 * takes out a video for an event in data/event-video-overrides.json, which is applied last. It can
 * add only an upload of the official channels' catalogue, so nothing outside them is ever shown:
 * any other id is left out and returned as rejected, for the stage to hold in the quarantine. A
 * mistyped id costs that one video, never the release (the palette recipes of 2026-10-13 held
 * every editorial edit for nine hours by failing the compile).
 *
 * Channels are read in the registry's order, Global's first: an event shows the videos of the
 * first channel that has any for it, not the same PV again in another language.
 *
 * A rerun and its first run share their videos, each marked with the run it was released for
 * (`run`: 'launch' or 'rerun'): a rerun's page shows the launch's trailer, PVs and EPs as well as
 * its own PV, and the first run's page its rerun's PV, each page's own run first. A rerun has
 * them before its Global date is confirmed (an upcoming rerun's own PV goes up on its first day),
 * so this is by name, not window: data/event-rewards.json's inheritsFrom where the rerun has one,
 * else the first run whose name is the rerun's without " Rerun" (firstRun).
 */
import { eventTitle, isRerun } from '../../lib/events/eventName.mjs';

const DAY_MS = 86_400_000;

/** How far an upload may be from the event's Global window, in days, by how it was matched.
 *  Measured on the Global channel's 754 uploads (2019-2026, filed 2026-10-23): a title-matched
 *  video went up at most 13 days before its event (Stultifera Navis's PV) and never after it ended;
 *  an operator's preview and EP in the weeks around the banner. */
export const WINDOWS = {
  title: { before: 30, after: 14 },
  operator: { before: 30, after: 7 },
  music: { before: 21, after: 21 },
};

/** What the page calls each kind, in the order it lists them. */
export const KINDS = ['trailer', 'animation', 'teaser', 'operator', 'music', 'special', 'gameplay', 'video'];

/** The kind of an official upload, from its title. */
export function videoKind(title) {
  const text = String(title ?? '');
  if (/official trailer/i.test(text)) return 'trailer';
  if (/animation pv/i.test(text)) return 'animation';
  if (/\bteaser\b/i.test(text)) return 'teaser';
  if (OPERATOR_PREVIEW.test(text)) return 'operator';
  if (OPERATOR_EP.test(text)) return 'music';
  if (/\bspecial\b/i.test(text)) return 'special';
  if (/new gameplay of|bonus scene/i.test(text)) return 'gameplay';
  return 'video';
}

const OPERATOR_PREVIEW = /^\s*arknights\s*[-–]\s*(.+?)\s+preview\s*$/i;
const OPERATOR_EP = /^\s*arknights\s+ep\s*[-–]\s*(.+?)\s*$/i;

/** A name as words: letters, digits and '#' (Vector Breakthrough #2), lower case, curly quotes
 *  straightened, every other mark a space. "Zwillingstürme im Herbst" keeps its ü. */
export function words(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .trim();
}

/** An operator's name for comparing: "Kal'tsit - Esperanta" (the album) and "Kal'tsit
 *  Esperanta" (the banner) alike. */
export function nameKey(name) {
  return String(name ?? '').normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

/** What a season's title puts between an event's words: "Season #12", "Operation", "Battleplan". */
const FILLER = /^(?:season|operation|battleplan|#\d+)$/;

/** Whether `text` names `name` (both as words()): its words in order, with nothing between them
 *  but FILLER. "#1" is filler only between the words, so "Icebreaker Games #1" is never named by
 *  a title that says "#2". */
function names(text, name) {
  const have = text.split(' ');
  const want = name.split(' ');
  if (!name) return false;
  return have.some((word, start) => {
    if (word !== want[0]) return false;
    let at = start + 1;
    for (const next of want.slice(1)) {
      while (at < have.length && have[at] !== next && FILLER.test(have[at])) at += 1;
      if (have[at] !== next) return false;
      at += 1;
    }
    return true;
  });
}

function near(published, event, { before, after }) {
  const time = Date.parse(published ?? '');
  if (!Number.isFinite(time)) return false;
  return time >= event.start - before * DAY_MS && time <= event.end + after * DAY_MS;
}

/**
 * A rerun's first run among `pages` (every event page's name), or null: `inherits` (rerun name →
 * first run, data/event-rewards.json inheritsFrom) where it has the rerun, else the first run named
 * as the rerun without its marks ("[Rerun] Under Tides Rerun" → "[Intermezzo – Celebration] Under
 * Tides"), else the one first run whose name begins with that ("[Rerun] So Long, Adele Rerun" →
 * "So Long, Adele: Home Away From Home").
 */
export function firstRun(name, pages, inherits) {
  if (!isRerun(name)) return null;
  const known = inherits.get(name);
  if (known && pages.includes(known)) return known;
  const title = words(eventTitle(name)).replace(/ rerun$/, '');
  const firsts = pages.filter((page) => !isRerun(page));
  const exact = firsts.filter((page) => words(eventTitle(page)) === title);
  if (exact.length === 1) return exact[0];
  const longer = firsts.filter((page) => words(eventTitle(page)).startsWith(`${title} `));
  return exact.length === 0 && longer.length === 1 ? longer[0] : null;
}

/** The nearest event's start to the upload: the tie-break when a rule fits two events. */
const distance = (published, event) => Math.abs(Date.parse(published) - event.start);

/**
 * The event an upload belongs to by its title, or null.
 * `events`: [{ name, start, end }] with start and end in ms, Global's confirmed windows only.
 */
export function eventByTitle(title, published, events) {
  const text = words(title);
  const fits = events.flatMap((event) => {
    const name = words(eventTitle(event.name));
    if (!names(text, name)) return [];
    // "<event> Rerun" is the rerun's PV: the first run never takes it, whether or not the rerun
    // has a record yet.
    if (!isRerun(event.name) && names(text, `${name} rerun`)) return [];
    return near(published, event, WINDOWS.title) ? [{ event, length: name.length }] : [];
  });
  fits.sort((a, b) => b.length - a.length || distance(published, a.event) - distance(published, b.event));
  return fits[0]?.event ?? null;
}

/**
 * The operators an upload is about: a preview's one operator, or the characters of the EP's
 * album (data/albums.json, by its English or own name). Empty for any other upload.
 */
export function videoOperators(title, albums) {
  const preview = String(title ?? '').match(OPERATOR_PREVIEW);
  if (preview) return [preview[1]];
  const ep = String(title ?? '').match(OPERATOR_EP);
  if (!ep) return [];
  const album = words(ep[1]);
  const found = albums.find((entry) => words(entry.albumAltName) === album || words(entry.albumName) === album);
  return Array.isArray(found?.characters) ? found.characters : [];
}

/**
 * The event whose banner features one of `operators`, near the upload, or null. Of several, the
 * ones in `titled` (events with PVs of their own by title) are asked first, then the nearest start;
 * two still level is no answer.
 */
export function eventByOperator(operators, published, kind, events, featured, titled = new Set()) {
  const keys = new Set(operators.map(nameKey));
  if (!keys.size) return null;
  const window = kind === 'music' ? WINDOWS.music : WINDOWS.operator;
  let fits = events.filter((event) => (featured.get(event.name) ?? []).some((name) => keys.has(nameKey(name))) && near(published, event, window));
  if (fits.some((event) => titled.has(event.name))) fits = fits.filter((event) => titled.has(event.name));
  const nearest = Math.min(...fits.map((event) => distance(published, event)));
  const best = fits.filter((event) => distance(published, event) === nearest);
  return best.length === 1 ? best[0] : null;
}

/**
 * Every event's official videos, `events`: { [event name]: [{ videoId, title, kind, published, run }] },
 * the page's own run first (its rerun's or first run's after), each run in KINDS order, then oldest
 * first, events with none left out; and `rejected`: the overrides' adds that name no upload of the
 * catalogue, [{ event, videoId }].
 *
 * `channels`: the registry's channels in order, each { id, uploads: [{ videoId, title, published }] }.
 * `events`: Global's confirmed windows, [{ name, start, end }]. `pages`: every event page's name,
 * confirmed or not. `inherits`: Map of rerun to first run (firstRun). `featured`: Map of event name
 * to its banner's operators. `albums`: data/albums.json. `overrides`: data/event-video-overrides.json's
 * `events`, { [event name]: { add?: [videoId], remove?: [videoId] } }.
 */
export function resolveEventVideos({ channels, events, pages, inherits, featured, albums, overrides }) {
  const byEvent = new Map();
  const official = new Map();
  for (const channel of channels) {
    const own = new Map();
    const file = (event, upload) => {
      if (!own.has(event.name)) own.set(event.name, []);
      own.get(event.name).push(upload);
    };
    // By title first, so the operator rule knows which events have PVs of their own.
    const rest = [];
    for (const upload of channel.uploads) {
      official.set(upload.videoId, upload);
      const event = eventByTitle(upload.title, upload.published, events);
      if (event) file(event, upload); else rest.push(upload);
    }
    const titled = new Set(own.keys());
    for (const upload of rest) {
      const event = eventByOperator(videoOperators(upload.title, albums), upload.published, videoKind(upload.title), events, featured, titled);
      if (event) file(event, upload);
    }
    // Global's first: a later channel fills only the events no earlier one had a video for.
    for (const [name, uploads] of own) if (!byEvent.has(name)) byEvent.set(name, uploads);
  }
  const rejected = [];
  for (const [name, { add = [], remove = [] }] of Object.entries(overrides)) {
    const dropped = new Set(remove);
    const list = (byEvent.get(name) ?? []).filter((upload) => !dropped.has(upload.videoId));
    for (const videoId of add) {
      if (!official.has(videoId)) rejected.push({ event: name, videoId });
      else if (!list.some((upload) => upload.videoId === videoId)) list.push(official.get(videoId));
    }
    if (list.length) byEvent.set(name, list); else byEvent.delete(name);
  }
  // Each run's own videos, marked with the run they were released for.
  const own = new Map([...byEvent].map(([name, uploads]) => [name, uploads
    .map((upload) => ({ videoId: upload.videoId, title: upload.title, kind: videoKind(upload.title), published: upload.published, run: isRerun(name) ? 'rerun' : 'launch' }))
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || Date.parse(a.published) - Date.parse(b.published))]));
  // Then a rerun and its first run share theirs: the page's own run first, the other's after.
  const reruns = new Map();
  for (const name of pages) {
    const first = firstRun(name, pages, inherits);
    if (first) reruns.set(first, [...(reruns.get(first) ?? []), name]);
  }
  const shown = new Map();
  for (const name of pages) {
    const first = firstRun(name, pages, inherits);
    const family = first ? [first] : (reruns.get(name) ?? []);
    const mine = own.get(name) ?? [];
    const seen = new Set(mine.map((video) => video.videoId));
    const theirs = family.flatMap((other) => own.get(other) ?? []).filter((video) => !seen.has(video.videoId) && seen.add(video.videoId));
    if (mine.length + theirs.length) shown.set(name, [...mine, ...theirs]);
  }
  const ordered = [...shown].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { events: Object.fromEntries(ordered), rejected };
}
