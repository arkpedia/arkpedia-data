#!/usr/bin/env node
/**
 * The guide-videos refresh stage: the trusted creators' new YouTube guides, added to the
 * operator records' `guides` (guide-videos.mjs says how a title is matched and what is added;
 * docs/development/data-pipelines.md says how to trust a creator).
 *
 *   npx tsx scripts/sync/sync-guide-videos.mjs                   the nightly run
 *   npx tsx scripts/sync/sync-guide-videos.mjs --listings <dir>  the same, reading each channel's
 *                                                                upload listing from <dir>/<channelId>.json
 *                                                                (yt-dlp --dump-single-json) instead of YouTube,
 *                                                                every creator's history in one run unless
 *                                                                --max-backfills <n> says otherwise (how the
 *                                                                first creators were backfilled, 2026-10-15)
 *   ... --first-backfill                                         allows a run with no state file yet (below)
 *   npx tsx scripts/sync/sync-guide-videos.mjs --report <dir>    the 'Guide suggestions' issue: writes
 *                                                                <dir>/body.md and comment.md, prints
 *                                                                alert, clear or nodata
 *
 * Under tsx, not node: the matcher reads the site's alter map from TypeScript.
 *
 * Per trusted creator (data/guide-creators.json), one after another with a pause between them,
 * starting each night from another creator (the day's turn), so a run that runs out of time
 * leaves another creator for the next night, never always the same one:
 *
 *   - Once, the first run after the creator is added: their whole upload history, so the older
 *     operators get their guides too (yt-dlp's flat listing of the channel's Videos tab: no key,
 *     and no Shorts or streams, which have tabs of their own). The day is kept as backfilledAt
 *     in data/guide-videos-state.json and the history is never read again: videos are not
 *     uploaded into the past. At most MAX_BACKFILLS a run; the rest wait for the next.
 *   - Every other night: the latest uploads, from the channel's Atom feed (about 15), or, when
 *     the feed does not load -- on 2026-10-15 it answered 404 or 500 for most channels for hours
 *     from the NAS -- the first FALLBACK_ENTRIES of the same flat listing.
 *   - If those no longer reach back to the newest upload the last run handled (the marker: more
 *     uploads than the feed lists since then, as after a few nights without a run), the listing
 *     back to it, up to GAP_ENTRIES: not the whole channel. If the marker is not among those
 *     either (the video was deleted or made private), they are read as a backfill reads: no
 *     suggestion but a guide-like one, so a lost marker cannot fill the issue with old videos.
 *   - The feed also lists the channel's past streams, as ordinary uploads: the Videos tab does
 *     not. On a night the feed was read, an upload of it is added only when the head of the
 *     listing (FALLBACK_ENTRIES, read for that) has it too; one the head does not have goes to a
 *     person as likely a stream. The marker, too, is always an upload of the Videos tab: a stream
 *     as the marker would send the next night that reads the listing back through GAP_ENTRIES
 *     uploads, so when it has to move on a feed night, it moves to the listing's head.
 *
 * Uploads at or below the marker were decided on by an earlier run and are read as a backfill
 * reads them, and every video the stage has added, suggested, or seen in a record's guides is
 * kept in the state's `decided` list and never classified again: a guide a person took out of a
 * record, or moved to another, is not put back, and a suggestion nobody acted on does not return
 * after it dropped off the list.
 *
 * The state file is what keeps a channel from being read from the start again. With a registry
 * but no state file, no channel is read at all: every creator is held, and nothing written,
 * unless the run says --first-backfill (no creator has ever been read). Otherwise a lost file
 * would backfill every channel again, re-adding every guide a person had taken out by hand.
 *
 * Each call to YouTube gets at most the time the stage has left (BUDGET_MS, inside run-stage's
 * 15 minutes), so the stage stops before run-stage would kill it and roll back the night's work.
 * A channel that cannot be read changes nothing -- no guide, no suggestion, its state as it was
 * -- and is held under this stage in data/quarantine.json (the daily 'Content quarantined'
 * issue) until a run reads it. Writes only the records it adds a guide to, as every operator
 * sync does (two-space JSON and a newline), and the state file only when it changes.
 *
 * Only the main content channel runs it (ARKPEDIA_DATA_BRANCH main, or unset when run by hand):
 * the dev channel compiles data main's records, which already carry main's additions, and its
 * own state would be thrown away by the next hydration, so its reads would only double the
 * requests to YouTube from the same address.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { beginStage, defaultNow } from '../lib/quarantine.mjs';
import { parseFeedEntries } from '../lib/youtube-uploads.mjs';
import { cell } from '../content/quarantine-report.mjs';
import { readOperatorRecords } from './sync-kernel-pool.mjs';
import {
  applyUploads, checkGuideCreators, checkGuideState, classifyUpload, cutAtMarker, feedReaches, gameContentNames, guideIndex, markHandled, nextMarker, prunePending,
  REGISTRY_FILE, REVIEW_DAYS, STATE_FILE, VIDEO_ID,
} from './guide-videos.mjs';

export const STAGE = 'guide-videos';
export const MAX_BACKFILLS = 3;
export const BACKFILL_ENTRIES = 6000;
export const FALLBACK_ENTRIES = 30;
export const GAP_ENTRIES = 300;
export const CHANNEL_PAUSE_MS = 2000;
// Inside the stage's 15 minutes (scripts/content/run-stage.mjs): a channel not reached by then is
// held like one that could not be read, and the next run catches up from its marker.
export const BUDGET_MS = 10 * 60_000;
/** Less than this left: a channel is not started (held), a gap or a marker's listing not read. */
export const MIN_CALL_MS = 30_000;
const FEED_TIMEOUT_MS = 20_000;
const LISTING_TIMEOUT_MS = 3 * 60_000;
/** Where the event and mode names come from (gameContentNames), as the release holds them. */
export const CONTENT_NAME_FILES = { stagesContent: 'data/stages-content.json', eventRewards: 'data/event-rewards.json', eventStores: 'data/event-stores.json' };
const feedUrl = channelId => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
export const channelUrl = channelId => `https://www.youtube.com/channel/${channelId}`;

/**
 * A flat listing as yt-dlp --dump-single-json writes it, as uploads (newest first). A listing
 * with no usable upload is a failed read, not an empty channel: a yt-dlp that no longer
 * understands YouTube's page exits 0 with no entries (or entries without titles), and taken as
 * read, it would mark a new creator's one-time backfill done with nothing read.
 */
export function parseListing(json, channelId) {
  const listing = typeof json === 'string' ? JSON.parse(json) : json;
  if (!Array.isArray(listing?.entries)) throw new Error('the listing has no entries');
  if (listing.channel_id && listing.channel_id !== channelId) throw new Error(`the listing is of channel ${listing.channel_id}`);
  const uploads = listing.entries.filter(entry => VIDEO_ID.test(entry?.id ?? '') && typeof entry.title === 'string' && entry.title.trim()).map(entry => ({
    videoId: entry.id, title: entry.title, published: null,
    short: /\/shorts\//.test(entry.url ?? ''),
    live: ['is_live', 'is_upcoming', 'was_live', 'post_live'].includes(entry.live_status) || entry.is_live === true || entry.was_live === true,
  }));
  if (!uploads.length) throw new Error(`the listing has no usable upload (${listing.entries.length} entries)`);
  return uploads;
}

/**
 * Where the uploads come from: YouTube (the Atom feed, and yt-dlp for listings), or, with
 * `listingsDir`, recorded listings. Tests pass their own. `timeoutMs` is the most a call may
 * take: the stage passes the time it has left. Uploads the feed gave are marked `feed`.
 */
export function youtubeSources({ fetcher = globalThis.fetch, ytdlp = process.env.ARKPEDIA_YT_DLP || 'yt-dlp', listingsDir = null, log = console.log } = {}) {
  const listing = (channelId, { limit, timeoutMs = LISTING_TIMEOUT_MS } = {}) => {
    if (listingsDir) {
      const uploads = parseListing(fs.readFileSync(path.join(listingsDir, `${channelId}.json`), 'utf8'), channelId);
      return Promise.resolve(limit ? uploads.slice(0, limit) : uploads);
    }
    const timeout = Math.floor(Math.min(LISTING_TIMEOUT_MS, timeoutMs));
    if (!(timeout > 0)) return Promise.reject(new Error('no time left for the listing'));
    const args = ['--flat-playlist', '--dump-single-json', '--no-warnings', ...(limit ? ['--playlist-end', String(limit)] : []), `${channelUrl(channelId)}/videos`];
    return new Promise((resolve, reject) => {
      execFile(ytdlp, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout, killSignal: 'SIGKILL' }, (error, stdout) => {
        if (error) return reject(new Error(`yt-dlp failed (${error.killed ? `stopped after ${timeout} ms` : error.code ?? error.signal ?? error.message})`));
        try { resolve(parseListing(stdout, channelId)); } catch (problem) { reject(problem); }
      });
    });
  };
  const feed = async (channelId, deadline) => {
    let last = new Error('no time left for the feed');
    for (const attempt of [1, 2]) {
      const left = deadline - Date.now();
      if (left < 1000) break;
      try {
        const response = await fetcher(feedUrl(channelId), { signal: AbortSignal.timeout(Math.floor(Math.min(FEED_TIMEOUT_MS, left))) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const uploads = parseFeedEntries(await response.text());
        if (!uploads.length) throw new Error('no uploads in the feed');
        return uploads.map(upload => ({ ...upload, feed: true }));
      } catch (error) {
        last = error;
        if (attempt === 1) await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(1500, deadline - Date.now()))));
      }
    }
    throw last;
  };
  return {
    listing,
    /** The latest uploads: the feed, else the head of the listing, both within `timeoutMs`. */
    async latest(channelId, { timeoutMs = Infinity } = {}) {
      if (listingsDir) return listing(channelId, { limit: FALLBACK_ENTRIES });
      const deadline = Date.now() + Math.min(timeoutMs, FEED_TIMEOUT_MS * 2 + 1500 + LISTING_TIMEOUT_MS);
      try {
        return await feed(channelId, deadline);
      } catch (error) {
        log(`  the feed did not load (${error.message}); reading the channel's listing instead`);
        return listing(channelId, { limit: FALLBACK_ENTRIES, timeoutMs: deadline - Date.now() });
      }
    },
    // Which yt-dlp the run lists channels with: a listing that stops working after YouTube
    // changed something is then easy to tie to the version (scripts/content/requirements.txt).
    ...(listingsDir ? {} : {
      version: () => new Promise(resolve => {
        execFile(ytdlp, ['--version'], { encoding: 'utf8', timeout: 15_000 }, (error, stdout) => resolve(error ? `unavailable (${error.code ?? error.signal ?? error.message})` : stdout.trim()));
      }),
    }),
  };
}

const readJson = file => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
const sortedKeys = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** What may be the marker: an upload of the Videos tab that is not a Short or a stream. */
const markable = list => list.filter(upload => !upload.short && !upload.live);

/** The game's event and mode names this tree's release holds (gameContentNames). */
export function readContentNames(root) {
  const files = Object.fromEntries(Object.entries(CONTENT_NAME_FILES).map(([key, file]) => [key, readJson(path.join(root, file))]));
  return gameContentNames(files);
}

/** The registry's creators in the order a run reads them: from the day's turn on, round the list. */
export function readingOrder(creators, now) {
  if (!creators.length) return [];
  const turn = Math.floor(now.getTime() / 86_400_000) % creators.length;
  return [...creators.slice(turn), ...creators.slice(0, turn)];
}

/**
 * The stage. Returns { skipped } when there is no registry yet or the run is not the main
 * channel's, else { added, suggested, held, read, pending } for the log and the tests.
 */
export async function syncGuideVideos(root = process.cwd(), {
  now = defaultNow(), sources = youtubeSources(), log = console.log, pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxBackfills = MAX_BACKFILLS, budgetMs = BUDGET_MS, clock = () => Date.now(), firstBackfill = false, dataBranch = null,
} = {}) {
  if (dataBranch && dataBranch !== 'main') {
    log(`Skipped: this run publishes to data ${dataBranch}, which compiles data main's records and their guides; only main's run reads YouTube.`);
    return { skipped: true };
  }
  const started = clock();
  const left = () => budgetMs - (clock() - started);
  const registryValue = readJson(path.join(root, REGISTRY_FILE));
  // The registry is editorial (arkpedia-data); until it is published there is nobody to follow.
  if (!registryValue) { log(`No ${REGISTRY_FILE}: no trusted creator, so nothing to read.`); return { skipped: true }; }
  const registry = checkGuideCreators(registryValue);
  const stateFile = path.join(root, STATE_FILE);
  const stateText = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
  const state = checkGuideState(stateText === null ? null : JSON.parse(stateText));
  const today = now.toISOString().slice(0, 10);
  const alerts = beginStage(root, STAGE, now);
  const holdEvery = (why, reason) => {
    log(`! ${why}: no channel read, nothing written.`);
    for (const creator of registry.creators) {
      alerts.add({ key: `guide-channel:${creator.channelId}`, action: 'kept-previous', sourceRef: channelUrl(creator.channelId), reason: reason(creator) });
    }
    const held = alerts.commit();
    return { added: [], suggested: [], held, read: [], pending: state.pending };
  };
  if (stateText === null && !firstBackfill) {
    return holdEvery(`No ${STATE_FILE}`, creator => `${creator.name}'s channel was not read: there is no ${STATE_FILE}, which says which channels were read before and which videos were decided on, `
      + 'and without it every channel would be read from its first upload again and the guides people took out put back. Restore the file from arkpedia-data\'s history; '
      + 'only if no creator has ever been read, run the stage once with --first-backfill');
  }
  const modes = readContentNames(root);
  if (!modes.length) {
    return holdEvery(`No event or mode names in ${Object.values(CONTENT_NAME_FILES).join(', ')}`, creator => `${creator.name}'s channel was not read: the release's event and mode names `
      + `(${CONTENT_NAME_FILES.stagesContent}) are missing, and without them an event named after an operator ("Maria Nearl") would be read as that operator`);
  }
  if (sources.version) log(`yt-dlp ${await sources.version()}`);
  const files = readOperatorRecords(root);
  const fileOf = new Map(files.map(({ file, record }) => [record, file]));
  const records = files.map(({ record }) => record);
  const index = guideIndex(records, { modes });
  const present = new Set(records.flatMap(record => (Array.isArray(record.guides) ? record.guides : []).map(guide => guide?.videoId).filter(Boolean)));
  const pending = [...state.pending];
  // Every video decided on: the state's list, what any record's guides hold, what waits for a person.
  const decided = new Set([...state.decided, ...present, ...pending.map(entry => entry.videoId)]);
  const creators = { ...state.creators };
  const touched = new Set(), added = [], suggested = [], read = [];
  let backfills = 0;
  for (const [position, creator] of readingOrder(registry.creators, now).entries()) {
    if (position) await pause(CHANNEL_PAUSE_MS);
    // A channel held tonight keeps its entry as it was (none, for a creator never read).
    const memory = state.creators[creator.channelId] ?? {};
    const hold = why => alerts.add({ key: `guide-channel:${creator.channelId}`, action: 'kept-previous', sourceRef: channelUrl(creator.channelId),
      reason: `${creator.name}'s ${why}, so none of their videos was added to an operator's guides or suggested; the next run reads the channel again` });
    log(`${creator.name} (${creator.channelId})`);
    if (left() < MIN_CALL_MS) {
      log('  ! not read: the stage\'s time for YouTube has run out');
      hold('channel was not read: the stage ran out of time for YouTube');
      continue;
    }
    const timeFor = cap => Math.min(cap, left());
    let uploads, listed = null, backfill = false, keepMarker = false;
    try {
      if (!memory.backfilledAt && backfills < maxBackfills) {
        backfills++;
        backfill = true;
        uploads = listed = await sources.listing(creator.channelId, { limit: BACKFILL_ENTRIES, timeoutMs: timeFor(LISTING_TIMEOUT_MS) });
        log(`  whole history: ${uploads.length} uploads`);
      } else {
        if (!memory.backfilledAt) log(`  its whole history waits for a later run (${maxBackfills} a run)`);
        const latest = await sources.latest(creator.channelId, { timeoutMs: left() });
        if (!latest.some(upload => upload.feed)) listed = latest;
        uploads = markHandled(latest, memory.newest);
        if (!feedReaches(latest.filter(upload => !upload.short), memory.newest)) {
          if (left() < MIN_CALL_MS) {
            log(`  ! the latest uploads do not reach back to ${memory.newest}, and there is no time left to read further: the marker stays for the next run`);
            keepMarker = true;
          } else {
            const gap = await sources.listing(creator.channelId, { limit: GAP_ENTRIES, timeoutMs: timeFor(LISTING_TIMEOUT_MS) });
            const cut = cutAtMarker(gap, memory.newest);
            log(`  the latest uploads do not reach back to ${memory.newest}: ${cut.found ? `${cut.uploads.length} uploads since it` : `not among the latest ${GAP_ENTRIES} (deleted or made private?), so those are read as a backfill reads them`}`);
            uploads = [...uploads, ...(cut.found ? cut.uploads.map(upload => ({ ...upload, old: false })) : gap.map(upload => ({ ...upload, old: true })))];
            listed = gap;
          }
        }
      }
    } catch (error) {
      log(`  ! could not be read: ${error.message}`);
      hold(`${backfill ? 'upload history' : 'latest uploads'} could not be read (YouTube feed and channel listing)`);
      continue;
    }
    // The feed lists the channel's past streams as ordinary uploads, with no live flag; the Videos
    // tab does not. So on a night only the feed was read, the tab's head is read too whenever an
    // upload of the feed would be added, or the marker has to move: an upload is added only when
    // the tab has it, and the marker moves only onto one the tab has (a stream as the marker would
    // send the next night the feed fails back through GAP_ENTRIES uploads). Its uploads down to
    // the marker are read with the feed's, so everything from the new marker down is decided on.
    // A gap read is a listing of the Videos tab too, longer than the head.
    let newest = memory.newest, tab = listed;
    const fromFeed = uploads.some(upload => upload.feed);
    const markerMoves = !keepMarker && nextMarker(memory.newest, markable(uploads)) !== memory.newest;
    const wouldAdd = upload => upload.feed && !upload.old && !present.has(upload.videoId) && !decided.has(upload.videoId) && !registry.dismissed.has(upload.videoId)
      && classifyUpload(upload, creator, index).action === 'add';
    if (fromFeed && !tab && (markerMoves || uploads.some(wouldAdd))) {
      if (left() < MIN_CALL_MS) log('  no time left to read the listing\'s head: no upload of the feed is added tonight, and the marker stays');
      else {
        try {
          tab = await sources.listing(creator.channelId, { limit: FALLBACK_ENTRIES, timeoutMs: timeFor(LISTING_TIMEOUT_MS) });
          uploads = [...uploads, ...markHandled(tab, memory.newest)];
        } catch (error) {
          log(`  the listing's head did not load (${error.message}): no upload of the feed is added tonight, and the marker stays`);
        }
      }
    }
    if (!keepMarker && listed) newest = nextMarker(memory.newest, markable(listed));
    else if (!keepMarker && tab && markerMoves) newest = markable(tab)[0]?.videoId ?? memory.newest;
    if (fromFeed) {
      // feedOnly: the tab's head was read and does not have it (a stream); unconfirmed: the head
      // was not read, so it is not added tonight, nor decided on, and is read again.
      const onTab = new Map((tab ?? []).map(upload => [upload.videoId, upload]));
      uploads = uploads.map(upload => {
        if (!upload.feed) return upload;
        const confirmed = onTab.get(upload.videoId);
        // The feed omits live metadata. Keep the listing's explicit stream/Short flags
        // on the first occurrence too: applyUploads deduplicates by video ID.
        if (confirmed) return { ...upload, live: upload.live || confirmed.live, short: upload.short || confirmed.short };
        return { ...upload, ...(tab ? { feedOnly: true } : { unconfirmed: true }) };
      });
    }
    const result = applyUploads({ creator, uploads, index, present, pending, dismissed: registry.dismissed, decided, today, backfill });
    result.touched.forEach(record => touched.add(record));
    added.push(...result.added.map(entry => ({ ...entry, creator: creator.name })));
    suggested.push(...result.suggested);
    for (const entry of [...result.added, ...result.suggested]) decided.add(entry.videoId);
    read.push(creator.name);
    for (const entry of result.added) log(`  + ${entry.operator}: ${entry.title} (${entry.videoId})`);
    if (result.suggested.length) log(`  ${result.suggested.length} suggested for a person`);
    creators[creator.channelId] = { ...(memory.backfilledAt || backfill ? { backfilledAt: memory.backfilledAt ?? today } : {}), ...(newest ? { newest } : {}) };
  }
  // What a person added to a record by hand since the last run is decided too: taken out later,
  // it is not put back.
  for (const id of present) decided.add(id);
  const next = {
    version: 1,
    creators: sortedKeys(creators),
    pending: prunePending(pending, { present, dismissed: registry.dismissed, today }),
    decided: [...decided].sort(byCode),
  };
  for (const record of touched) fs.writeFileSync(fileOf.get(record), `${JSON.stringify(record, null, 2)}\n`);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (text !== stateText) fs.writeFileSync(stateFile, text);
  const held = alerts.commit();
  log(`${added.length} guide(s) added, ${suggested.length} new suggestion(s), ${next.pending.length} waiting, ${held.length} channel(s) unread.`);
  return { added, suggested, held, read, pending: next.pending };
}

/* ---- The 'Guide suggestions' issue ---- */

export const MAX_ROWS = 150;
const watchUrl = videoId => `https://www.youtube.com/watch?v=${videoId}`;
const row = entry => `| [${cell(entry.title, 120)}](${watchUrl(entry.videoId)}) | ${cell(entry.creator, 40)} | ${cell(entry.operators.join(', '), 120)} | ${cell(entry.reason, 120)} |`;

/**
 * The issue for the suggestions still waiting: { state: 'alert', body, comment } or
 * { state: 'clear' }. The body is the list and nothing that changes by itself (no date, no
 * age), so a run with the same list edits nothing; its digest names the list, so only a new or
 * cleared suggestion is news.
 */
export function renderSuggestions(pending, { today } = {}) {
  if (!pending.length) return { state: 'clear' };
  const digest = createHash('sha256').update(JSON.stringify(pending.map(entry => [entry.videoId, entry.operators]).sort())).digest('hex').slice(0, 16);
  const lines = [`<!-- arkpedia-alert-digest:${digest} -->`,
    `Videos by the trusted creators in \`${REGISTRY_FILE}\` (arkpedia-data) that name an operator but were not added to its guides by themselves: they name several operators, name a game event or mode, read as another kind of video (a stage clear, a tier list, an outfit), do not read as a guide, or are a second guide by the same creator. `
    + 'To add one, put `{ "videoId": "...", "creator": "..." }` in the operator\'s `guides` on the editorial branch, after merging data main into it (`git fetch origin && git merge origin/main`): the nightly adds to the same `guides` lists on main, and an editorial branch behind it conflicts. '
    + 'To turn one down, add its video id to `dismissed` in that file. '
    + `Either takes it off this list on the next refresh, and one nobody acts on drops off ${REVIEW_DAYS} days after it was first listed and is never suggested again. `
    + 'A guide the nightly added wrongly is taken back by removing it from the record (on editorial, merged with main as above): the nightly never adds a video it has decided on again.',
    '', `**${pending.length} suggestion(s)**, newest first`, '', '| Video | Creator | Operators | Why |', '|---|---|---|---|'];
  const shown = pending.slice(0, MAX_ROWS);
  lines.push(...shown.map(row));
  if (pending.length > shown.length) lines.push('', `…and ${pending.length - shown.length} more in \`${STATE_FILE}\` of arkpedia-data.`);
  const fresh = today ? pending.filter(entry => entry.firstSeen === today) : [];
  const comment = fresh.length
    ? [`${fresh.length} new suggestion(s):`, '', '| Video | Creator | Operators | Why |', '|---|---|---|---|', ...fresh.slice(0, 50).map(row)].join('\n')
    : `The list changed: ${pending.length} suggestion(s) waiting.`;
  return { state: 'alert', body: `${lines.join('\n')}\n`, comment: `${comment}\n` };
}

/** The issue as this tree's data has it: the suggestions still waiting, written to `outDir`. */
export function writeSuggestionsReport(root, outDir, { now = defaultNow() } = {}) {
  const registryValue = readJson(path.join(root, REGISTRY_FILE));
  const stateValue = readJson(path.join(root, STATE_FILE));
  if (!registryValue || !stateValue) return 'nodata';
  const registry = checkGuideCreators(registryValue);
  const state = checkGuideState(stateValue);
  const present = new Set(readOperatorRecords(root).flatMap(({ record }) => (Array.isArray(record.guides) ? record.guides : []).map(guide => guide?.videoId)));
  const today = now.toISOString().slice(0, 10);
  const report = renderSuggestions(prunePending(state.pending, { present, dismissed: registry.dismissed, today }), { today });
  if (report.state === 'alert') {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'body.md'), report.body);
    fs.writeFileSync(path.join(outDir, 'comment.md'), report.comment);
  }
  return report.state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  if (option('--report')) console.log(writeSuggestionsReport(process.cwd(), option('--report')));
  else {
    const listingsDir = option('--listings') ?? null;
    // Recorded listings are no load on YouTube: every creator's history can be read in one run.
    const maxBackfills = Number(option('--max-backfills') ?? (listingsDir ? Infinity : MAX_BACKFILLS));
    await syncGuideVideos(process.cwd(), {
      sources: youtubeSources({ listingsDir }), maxBackfills, firstBackfill: args.includes('--first-backfill'),
      // The content run's channel (scripts/content/channel.mjs); unset when run by hand.
      dataBranch: process.env.ARKPEDIA_DATA_BRANCH || null,
      ...(listingsDir ? { pause: async () => {}, budgetMs: Infinity } : {}),
    });
  }
}
