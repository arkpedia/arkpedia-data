/**
 * The structured wiki pages the daily refresh reads, as enrichment that can never hold
 * the release back. The game tables decide what exists; these pages add English names
 * and the lineups the tables leave out. So a page that cannot be used today -- the wiki
 * is down, the page moved behind a redirect, was deleted, or was reformatted so that no
 * row parses where there were rows, or too few of them (see shrinkProblem) -- is read
 * from its last good copy, and the problem is reported to the quarantine list instead of
 * thrown.
 *
 * The last good copy is the page's parsed rows, kept in data/wiki-cache/<page>.json.
 * It is a data file, published with the release and hydrated into the next run, so it
 * survives the runner. It is rewritten only when the rows change or a hold begins or ends,
 * and holds no timestamp but the day a shrink began (below): a page that did not change
 * leaves the file alone, and an unchanged day publishes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { wikiBase, wikiParseUrl, wikiText, parseWikiRows } from './catalogue-model.mjs';

export const WIKI_CACHE = 'data/wiki-cache';
// wiki.gg refuses requests that do not say who is asking. Every reader of the wiki's API says
// it the same way (sync-event-stores.mjs too).
export const USER_AGENT = 'Arkpedia-refresh/1.0 (+https://arkpedia.net)';

export const wikiCacheFile = (root, page) => path.join(root, WIKI_CACHE, `${page.replaceAll('/', '-')}.json`);
/*
 * A page that parses to fewer rows than it held has most likely been reformatted under the
 * parser -- rows moved into another template, a nested template cutting cells short -- not
 * emptied. How few is too few depends on the page:
 *
 * A year's banner page (Headhunting/Banners/<year>) only grows during its year, so ANY
 * shrink from its last good copy is suspect.
 *
 * The Upcoming pages lose rows as Global catches up: the wiki moves a banner row to the
 * yearly page once Global dates the banner, and an event row off the page once Global
 * schedules the event. So a row that left is first looked for where it went -- `movedTo`,
 * which the caller must give for these pages (sync-catalogue.mjs: the yearly page's rows,
 * the Global client's activity table) -- and a read whose every lost row turned up there is
 * taken. The rows date only the CN run, so a date accounts for nothing: a CN window long over
 * stays Upcoming until Global dates it. Otherwise the page is judged by half -- of the most
 * rows it held within PEAK_DAYS, less the rows found moved, not of yesterday's copy, or a
 * page could lose half its rows every day, each loss taken as the next day's yardstick. The
 * cache keeps that count as `peak` ({rows, since}) while it is above the rows it holds, set
 * on the day a shrink is taken and dropped once the page grows back past it. Pages this
 * small are not judged.
 *
 * A shrink is never taken silently. One held back stays held back, and reported (overdue
 * after three days, like any quarantined record), until the rows it lost are accounted for --
 * every row of the last good copy is served again or turned up where the wiki moves it -- or
 * a maintainer accepts it by deleting the page's cache file in arkpedia-data. Never because
 * the count recovered: CN announces a banner or an event every week or two, and new rows
 * would hide the lost ones, which would then leave the good copy for good without a word. So
 * the hold does not hang on the peak (which runs out) or on today's count: its first day
 * writes the words it was held back with into the cache as `held`, and every later day of it
 * reports those same words, whatever that day's read looks like (the log has the day's
 * counts), so the hold is one quarantine entry, byte for byte, from its first day to its last.
 * A row the wiki edited meanwhile is not the row the good copy kept, so it keeps the hold
 * until a maintainer accepts it. The day the hold ends rewrites the cache without the mark.
 */
export const SHRINK_JUDGED_FROM = 6;
export const PEAK_DAYS = 7;
const onlyGrows = page => /^Headhunting\/Banners\/\d{4}$/.test(page);
const utcDay = now => now.toISOString().slice(0, 10);
const daysFrom = (since, today) => (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000;
/** The most rows the page held within PEAK_DAYS, by the last good copy, while it is more than the copy holds. */
function runningPeak(cached, today) {
  const peak = cached?.peak;
  const live = peak && Number.isInteger(peak.rows) && daysFrom(peak.since, today) <= PEAK_DAYS ? peak : null;
  return live && live.rows > cached.rows.length ? live : null;
}
/** The words a shrink held back in the last good copy was held back with, or null when none is. */
const heldBy = cached => (typeof cached?.held === 'string' && cached.held.trim() ? cached.held : null);
/** How many rows of the last good copy today's read lacks, and how many of those turned up where the wiki moves them. */
function rowsLeft(cached, rows, movedTo) {
  const kept = new Set(rows.map(row => JSON.stringify(row)));
  const left = (cached?.rows ?? []).filter(row => !kept.has(JSON.stringify(row)));
  return { left: left.length, moved: movedTo ? left.filter(row => movedTo.has(row)).length : 0 };
}
/** Why today's rows are too few to take over the last good copy, or null. The words hold no
 * count of today's rows: the reason is a release input, and the good copy stands meanwhile. */
function shrinkProblem(page, template, rows, cached, today, { left, moved }, movedTo) {
  const had = cached?.rows.length ?? 0;
  // A hold ends only when every row the good copy had is on the page again or where the wiki
  // moves it (a year's banner page moves none), in the words it began with until then.
  const held = heldBy(cached);
  if (held) return left === moved ? null : held;
  // Every row that left turned up where the wiki moves it: Global caught up on them.
  if (!onlyGrows(page) && left === moved) return null;
  if (!rows.length && had) return `it has no "${template}" row that parses, where the last good read had ${had}; the template or its fields have probably changed`;
  if (onlyGrows(page)) return rows.length < had ? `fewer "${template}" rows parse than its last good read had, and a year's banner page only grows; rows have probably moved to another template or been cut short` : null;
  const recently = Math.max(had, runningPeak(cached, today)?.rows ?? 0) - moved;
  if (recently >= SHRINK_JUDGED_FROM && rows.length < recently / 2) {
    return `fewer than half the "${template}" rows it recently held parse, not counting rows that moved ${movedTo.name}; most of the page has probably been reformatted`;
  }
  return null;
}
/** The peak a taken read leaves in the cache: the running one (less the rows that moved) while
 * it stands above the rows, else the count before today's shrink, from today. */
function nextPeak(page, rows, cached, today, moved) {
  if (onlyGrows(page) || !cached) return null;
  const top = runningPeak(cached, today) ?? { rows: cached.rows.length, since: today };
  const rest = top.rows - moved;
  return rest > rows.length && daysFrom(top.since, today) <= PEAK_DAYS ? { rows: rest, since: top.since } : null;
}
const writeCache = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
export const wikiPageUrl = page => `${wikiBase()}/wiki/${encodeURI(page.replaceAll(' ', '_'))}`;

/* Why a request for the page failed, in words that stay the same while the problem does:
   the reason is published in data/quarantine.json, a release input, so an outage that
   answers 502 one day, refuses the connection the next and serves a maintenance page (or a
   403 challenge) the day after must not read as a new problem each day. Every failure of the
   request itself -- no answer, an HTTP error of any status, an answer that is not the API's
   JSON -- is this one kind; the exact error goes to the log. A page the wiki does serve but
   that cannot be used (missing, still a redirect) keeps wikiText's own words, which name the
   page's state. */
const UNREACHABLE = 'the wiki could not be reached';
class RequestFailed extends Error {}

async function fetchWikiJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    throw new RequestFailed(UNREACHABLE, { cause: error });
  }
}

/**
 * The wikitext of one page, through the same request and the same checks as readWikiRows:
 * '' for this year's banner page before the wiki creates it (January only), else the text,
 * or an Error whose message stays the same while the problem does (the request's own error
 * is its cause, for the log). For a reader that needs more of a page than its template rows
 * (sync-kernel-pool.mjs reads a section of prose).
 */
export async function readWikiText(page, now = new Date()) {
  return wikiText(page, await fetchWikiJson(wikiParseUrl(page)), now);
}

function lastGoodRead(file) {
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(cached?.rows) ? cached : null;
  } catch {
    return null;
  }
}

/**
 * The rows of one structured page, never throwing over anything the wiki does. `alerts` is a
 * quarantine stage (scripts/lib/quarantine.mjs); `write: false` leaves the cache untouched (dry
 * runs). A page that loses rows as Global catches up (every page but a year's banner page)
 * needs `movedTo`: { name, has(row) }, where the wiki moves a row that leaves it (see the top);
 * leaving it out is a bug in the caller, and throws.
 */
export async function readWikiRows(root, page, template, { now = new Date(), alerts, write = true, movedTo } = {}) {
  if (!onlyGrows(page) && (typeof movedTo?.name !== 'string' || typeof movedTo.has !== 'function')) {
    throw new TypeError(`readWikiRows(${page}) needs movedTo: { name, has(row) }, to tell a row Global caught up on from a row the page lost`);
  }
  const file = wikiCacheFile(root, page);
  const cached = lastGoodRead(file);
  const today = utcDay(now);
  let rows, problem;
  try {
    const text = await readWikiText(page, now);
    // The only excused absence: this year's banner page before the wiki creates it.
    if (!text) {
      console.warn(`${page} does not exist on the wiki yet; reading it as no rows until the end of January (UTC).`);
      return [];
    }
    rows = parseWikiRows(text, template);
  } catch (error) {
    const exact = error instanceof RequestFailed ? error.cause : error;
    const cause = exact.cause?.code ?? exact.cause?.message;
    console.warn(`Reading ${page} failed: ${exact.message}${cause ? ` (${cause})` : ''}`);
    problem = error.message;
  }
  if (rows) {
    const gone = rowsLeft(cached, rows, onlyGrows(page) ? null : movedTo);
    // No row where there were rows is a template or field rename, not a quiet day.
    const shrunk = shrinkProblem(page, template, rows, cached, today, gone, movedTo);
    if (!shrunk) {
      // The same rows leave the file alone, whatever became of the peak meanwhile -- unless
      // they end a hold, whose mark comes off.
      if (write && (JSON.stringify(cached?.rows) !== JSON.stringify(rows) || cached?.held !== undefined)) {
        const peak = nextPeak(page, rows, cached, today, gone.moved);
        writeCache(file, { page, template, rows, ...(peak ? { peak } : {}) });
      }
      return rows;
    }
    // Held back until the lost rows are accounted for: the first day marks the hold, in the
    // words every day of it reports. The day's counts go to the log only.
    if (write && cached && !heldBy(cached)) writeCache(file, { ...cached, held: shrunk });
    console.warn(`${page}: ${rows.length} "${template}" rows parse today; ${gone.left} of the ${cached?.rows.length ?? 0} in its last good read are not among them`
      + (onlyGrows(page) ? '.' : `, ${gone.moved} of those turned up ${movedTo.name}.`));
    problem = `${shrunk}. If it really lost them, delete source/${path.relative(root, file)} in arkpedia-data (a correction branch) and the next run takes the page as it is`;
  }
  const fallback = cached?.rows ?? [];
  const outcome = cached ? `its last good read (${fallback.length} rows) is used instead` : 'no earlier read is cached, so it reads as no rows and nothing new is discovered from it';
  console.warn(`Wiki page ${page} cannot be used: ${problem}; ${outcome}.`);
  alerts?.add({ key: `wiki:${page}`, action: cached ? 'kept-previous' : 'omitted-new', reason: `Wiki page ${page} cannot be used: ${problem}; ${outcome}.`, sourceRef: wikiPageUrl(page) });
  return fallback;
}
