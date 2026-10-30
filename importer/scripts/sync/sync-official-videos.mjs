#!/usr/bin/env node
/**
 * The official-videos refresh stage: the official Arknights channels' uploads
 * (data/official-videos.json) and, from them, each event's PVs (data/event-videos.json), which the
 * event page's PVs tab shows. event-videos.mjs says which upload goes to which event.
 *
 *   npx tsx scripts/sync/sync-official-videos.mjs               the nightly run
 *   npx tsx scripts/sync/sync-official-videos.mjs --offline     files the catalogue into events
 *                                                              again, reading nothing from YouTube:
 *                                                              a run that refreshes nothing (an
 *                                                              editorial edit) after an override
 *   npx tsx scripts/sync/sync-official-videos.mjs --backfill    run by a person, not the runner:
 *                                                              every channel's whole upload history
 *                                                              (yt-dlp's flat listing of its Videos
 *                                                              tab), each upload's day from YouTube's
 *                                                              player (one request each, no key)
 *
 * Under tsx, not node: the events' banners are found by the site's own rule
 * (lib/gacha/headhuntingBanners.ts getBannerForEvent), and their windows read by
 * lib/schedule/gameWindow.ts, so an event's videos are filed under the name its page has.
 *
 * The channels are data/official-video-channels.json, kept in arkpedia-data: only the official
 * ones (Yostar's Global channel first), each with `use` saying whether it is read. Every night the
 * stage reads each channel's Atom feed, its newest 15 uploads with their days, and adds the ones the
 * catalogue lacks; shorts are left out. A channel's older uploads are in the catalogue because a
 * person ran --backfill once, from their own machine (the runner's address is refused by YouTube's
 * player more often than not), and pushed the result to arkpedia-data's editorial branch. A
 * channel the feed cannot be read for keeps what it had, held under this stage in
 * data/quarantine.json until a run reads it. The feed is read on main's channel only
 * (ARKPEDIA_DATA_BRANCH main, or unset by hand), as the guide-videos stage reads its feeds: dev's
 * compiles data main's catalogue, which already has main's additions. Both channels file the
 * catalogue into events, so a change to the rules shows on arkpedia-dev first.
 *
 * Overrides (data/event-video-overrides.json, kept in arkpedia-data) are applied when the
 * catalogue is filed, which every content run does: a refreshing one in this stage, an editorial
 * one (no refresh) with --offline, so an override pushed to editorial shows with that run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beginStage, defaultNow, readQuarantine } from '../lib/quarantine.mjs';
import { parseFeedEntries } from '../lib/youtube-uploads.mjs';
import { resolveEventVideos } from './event-videos.mjs';

export const STAGE = 'official-videos';
export const REGISTRY_FILE = 'data/official-video-channels.json';
export const CATALOGUE_FILE = 'data/official-videos.json';
export const OVERRIDES_FILE = 'data/event-video-overrides.json';
export const EVENT_VIDEOS_FILE = 'data/event-videos.json';

const CHANNEL_ID = /^UC[\w-]{22}$/;
const VIDEO_ID = /^[\w-]{11}$/;
const FEED_TIMEOUT_MS = 20_000;
const PLAYER_TIMEOUT_MS = 20_000;
// The web client youtube.com itself sends (as scripts/sync/sync-endfield-albums.mjs does).
const CLIENT_VERSION = '2.20261020.05.00';
// A cookie that answers YouTube's consent page, which a machine in the EU is otherwise shown.
const HEADERS = { 'accept-language': 'en-US,en;q=0.8', cookie: 'SOCS=CAI', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };

const readJson = (root, file) => {
  const full = path.join(root, file);
  return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : null;
};
const writeJson = (root, file, value) => {
  const full = path.join(root, file);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(full) && fs.readFileSync(full, 'utf8') === text) return false;
  fs.writeFileSync(full, text);
  return true;
};

/** The registry, checked: [{ id, label, region, use }] in the order channels are preferred. */
export function checkRegistry(value) {
  const channels = value?.channels;
  if (!Array.isArray(channels) || !channels.length) throw new Error(`${REGISTRY_FILE} lists no channels`);
  const seen = new Set();
  for (const channel of channels) {
    if (!CHANNEL_ID.test(channel?.id ?? '')) throw new Error(`${REGISTRY_FILE}: "${channel?.id}" is not a channel id`);
    if (seen.has(channel.id)) throw new Error(`${REGISTRY_FILE} lists ${channel.id} twice`);
    seen.add(channel.id);
    if (typeof channel.label !== 'string' || !channel.label.trim()) throw new Error(`${REGISTRY_FILE}: ${channel.id} has no label`);
    if (typeof channel.use !== 'boolean') throw new Error(`${REGISTRY_FILE}: ${channel.id} says neither "use": true nor false`);
  }
  return channels;
}

/** The catalogue, checked: { channels: { [id]: { uploads: [{ videoId, title, published }] } } }. */
export function checkCatalogue(value) {
  const channels = value?.channels ?? {};
  if (typeof channels !== 'object' || Array.isArray(channels)) throw new Error(`${CATALOGUE_FILE} has no channels`);
  for (const [id, channel] of Object.entries(channels)) {
    if (!CHANNEL_ID.test(id) || !Array.isArray(channel?.uploads)) throw new Error(`${CATALOGUE_FILE}: channel ${id} is malformed`);
    for (const upload of channel.uploads) {
      if (!VIDEO_ID.test(upload?.videoId ?? '') || typeof upload.title !== 'string' || !Number.isFinite(Date.parse(upload.published ?? ''))) {
        throw new Error(`${CATALOGUE_FILE}: an upload of ${id} is malformed: ${JSON.stringify(upload)}`);
      }
    }
  }
  return { channels };
}

/** An upload's day as an ISO instant in UTC. */
const instant = (text) => new Date(Date.parse(text)).toISOString().replace('.000Z', 'Z');

/** Newest first, one entry per video: `fresh` wins over what the catalogue had (a renamed title). */
export function mergeUploads(known, fresh) {
  const byId = new Map(known.map((upload) => [upload.videoId, upload]));
  for (const upload of fresh) byId.set(upload.videoId, { ...byId.get(upload.videoId), ...upload });
  return [...byId.values()].sort((a, b) => Date.parse(b.published) - Date.parse(a.published) || (a.videoId < b.videoId ? -1 : 1));
}

/** A channel's newest uploads from its Atom feed, shorts left out. */
export async function readFeed(fetcher, channelId) {
  let last;
  for (const attempt of [1, 2]) {
    try {
      const response = await fetcher(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const uploads = parseFeedEntries(await response.text());
      if (!uploads.length) throw new Error('no uploads in the feed');
      return uploads.filter((upload) => !upload.short && upload.published).map(({ videoId, title, published }) => ({ videoId, title, published: instant(published) }));
    } catch (error) {
      last = error;
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw last;
}

/** One upload's day and channel from YouTube's player, as youtube.com asks for them. */
export async function readUpload(fetcher, videoId) {
  const response = await fetcher('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    signal: AbortSignal.timeout(PLAYER_TIMEOUT_MS),
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl: 'en', gl: 'US' } }, videoId }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from the player`);
  const json = await response.json();
  const details = json?.videoDetails;
  const micro = json?.microformat?.playerMicroformatRenderer;
  const published = micro?.publishDate ?? micro?.uploadDate;
  if (details?.videoId !== videoId || !published) throw new Error(`the player says nothing of ${videoId}`);
  return { videoId, title: String(details.title ?? ''), channelId: details.channelId, published: instant(published) };
}

/**
 * The events a video can go to, under the names their pages have, and their banners' operators.
 * Read from the event records as lib/home/frontPageContent.ts getEventCalendar and
 * lib/events/modeDetails.ts permanentEventListing list them, Global's confirmed windows only (a
 * predicted one is CN's moved by a guess), without importing those: a stage's imports are what a
 * production refresh reads, and the home
 * page's module changes with every home page edit.
 */
async function readEvents(root) {
  const [{ parseGameWindow }, { getBannerForEvent }, { getAllHeadhuntingBanners }, { getFeaturedOperatorRates }] = await Promise.all([
    import('../../lib/schedule/gameWindow'), import('../../lib/gacha/headhuntingBanners'), import('../../lib/gacha/headhuntingBannerData'), import('../../lib/gacha/eventBannerRates'),
  ]);
  const folder = path.join(root, 'data/events');
  const records = fs.readdirSync(folder).filter((file) => /^events_\d{4}\.json$/.test(file)).sort().flatMap((file) => JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8')));
  // Every event page's name, confirmed or not (pages/events/[slug].tsx getStaticPaths): a timed
  // event with a date on either server, a mode with a launch on either.
  const pages = records.filter((record) => (record.modeId ? record.global?.releaseDate ?? record.cn?.releaseDate : record.global?.dateRange ?? record.cn?.dateRange)).map((record) => record.name);
  const events = records.flatMap((record) => {
    const global = record.global ?? {};
    if (record.modeId) {
      // A permanent mode: its launch day, once Global's is announced.
      if (!global.releaseDate || global.note) return [];
      const start = Date.parse(`${global.releaseDate.replaceAll('/', '-')}T00:00:00Z`);
      return Number.isFinite(start) ? [{ name: record.name, start, end: start, dateRange: global.releaseDate }] : [];
    }
    if (!global.dateRange || /estimated|predicted/i.test(global.note || '')) return [];
    const window = parseGameWindow(global.dateRange, global);
    return window ? [{ name: record.name, start: window.start.getTime(), end: window.end.getTime(), dateRange: global.dateRange }] : [];
  });
  const banners = getAllHeadhuntingBanners();
  const featured = new Map(events.map((event) => {
    const banner = getBannerForEvent(event.name, event.dateRange, banners);
    return [event.name, banner ? getFeaturedOperatorRates(banner).map((operator) => operator.name) : []];
  }));
  return { events, pages, featured };
}

/**
 * The night's run: each channel's feed into the catalogue when `readFeeds`, then every event's
 * videos. `fetcher` is the network and `events` the listing ({ events, featured }); the tests pass
 * their own.
 */
export async function syncOfficialVideos(root, { fetcher = globalThis.fetch, readFeeds = true, now = defaultNow(), log = console.log, events: given = null } = {}) {
  const registry = checkRegistry(readJson(root, REGISTRY_FILE));
  const catalogue = checkCatalogue(readJson(root, CATALOGUE_FILE) ?? { channels: {} });
  const stage = beginStage(root, STAGE, now);
  // A run that reads no feeds (dev's, an editorial one) says nothing new of them: a channel main's
  // run could not read stays held until a run reads it.
  if (!readFeeds) for (const entry of readQuarantine(root).entries) if (entry.stage === STAGE && entry.key.startsWith('feed:')) stage.add(entry);
  for (const channel of registry.filter((entry) => readFeeds && entry.use)) {
    const known = catalogue.channels[channel.id]?.uploads ?? [];
    try {
      const fresh = await readFeed(fetcher, channel.id);
      const added = fresh.filter((upload) => !known.some((entry) => entry.videoId === upload.videoId));
      catalogue.channels[channel.id] = { ...catalogue.channels[channel.id], uploads: mergeUploads(known, fresh) };
      log(`${channel.label}: ${added.length} new upload(s)${added.length ? `: ${added.map((upload) => upload.title).join(' | ')}` : ''}`);
    } catch (error) {
      log(`${channel.label}: the feed did not load (${error.message}); its uploads stay as they were`);
      stage.add({ key: `feed:${channel.id}`, reason: `The official channel ${channel.label} could not be read; its newest uploads wait for the next run.`, action: 'kept-previous', sourceRef: `https://www.youtube.com/channel/${channel.id}` });
    }
  }
  writeJson(root, CATALOGUE_FILE, { channels: Object.fromEntries(Object.entries(catalogue.channels).sort(([a], [b]) => (a < b ? -1 : 1))) });
  const { events, pages, featured } = given ?? await readEvents(root);
  const overrides = readJson(root, OVERRIDES_FILE)?.events ?? {};
  const albums = readJson(root, 'data/albums.json') ?? [];
  // A rerun's first run, where the reward tables say (build-event-rewards.mjs inheritsFrom).
  const inherits = new Map(Object.entries(readJson(root, 'data/event-rewards.json')?.events ?? {}).flatMap(([name, entry]) => (typeof entry?.inheritsFrom === 'string' ? [[name, entry.inheritsFrom]] : [])));
  const { events: resolved, rejected } = resolveEventVideos({
    channels: registry.filter((entry) => entry.use).map((entry) => ({ id: entry.id, uploads: catalogue.channels[entry.id]?.uploads ?? [] })),
    events, pages, inherits, featured, albums, overrides,
  });
  // An override under a name no event page has (a typo, a renamed event) would show nowhere.
  for (const name of Object.keys(overrides).filter((key) => !pages.includes(key))) {
    log(`${OVERRIDES_FILE} names "${name}", which is no event page: nothing is filed under it`);
    stage.add({ key: `override:${name}`, reason: `${OVERRIDES_FILE} names this event, but no event page has that name, so its videos are shown nowhere. Use the event's name as its page has it.`, action: 'omitted-new' });
  }
  for (const { event, videoId } of rejected) {
    log(`${OVERRIDES_FILE} adds ${videoId} to ${event}, which no official channel in the catalogue uploaded: left out`);
    stage.add({ key: `override:${event}:${videoId}`, reason: `${OVERRIDES_FILE} adds ${videoId} to this event, but no official channel in ${CATALOGUE_FILE} uploaded it, so it is left out. Fix the id, or take it out of the overrides.`, action: 'omitted-new' });
  }
  writeJson(root, EVENT_VIDEOS_FILE, { events: resolved });
  log(`${Object.keys(resolved).length} event(s) have official videos (${Object.values(resolved).reduce((sum, list) => sum + list.length, 0)} in all).`);
  stage.commit();
  return resolved;
}

/**
 * Every listed channel's whole history into the catalogue: yt-dlp's flat listing for the uploads,
 * then the player for each one's day. Run by a person (see the top of this file), a channel at a
 * time with `--channel <id>`, or every channel the registry uses.
 */
export async function backfill(root, { fetcher = globalThis.fetch, channelIds = null, listing, log = console.log, pauseMs = 150 } = {}) {
  const registry = checkRegistry(readJson(root, REGISTRY_FILE));
  const catalogue = checkCatalogue(readJson(root, CATALOGUE_FILE) ?? { channels: {} });
  for (const channel of registry.filter((entry) => (channelIds ? channelIds.includes(entry.id) : entry.use))) {
    const listed = (await listing(channel.id)).filter((upload) => !upload.short && !upload.live);
    const known = new Map((catalogue.channels[channel.id]?.uploads ?? []).map((upload) => [upload.videoId, upload]));
    const fresh = [];
    for (const [index, upload] of listed.entries()) {
      if (known.has(upload.videoId)) continue;
      const details = await readUpload(fetcher, upload.videoId);
      if (details.channelId !== channel.id) throw new Error(`${upload.videoId} is not an upload of ${channel.label} (${details.channelId})`);
      fresh.push({ videoId: upload.videoId, title: upload.title, published: details.published });
      if (index % 50 === 0) log(`${channel.label}: ${index + 1}/${listed.length}`);
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    catalogue.channels[channel.id] = { uploads: mergeUploads([...known.values()], fresh) };
    log(`${channel.label}: ${fresh.length} upload(s) dated, ${catalogue.channels[channel.id].uploads.length} in all`);
  }
  writeJson(root, CATALOGUE_FILE, { channels: Object.fromEntries(Object.entries(catalogue.channels).sort(([a], [b]) => (a < b ? -1 : 1))) });
}

async function main(args) {
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  if (args.includes('--backfill')) {
    const { youtubeSources } = await import('./sync-guide-videos.mjs');
    await backfill(process.cwd(), { listing: youtubeSources().listing, channelIds: option('--channel') ? [option('--channel')] : null });
  }
  // The content run's channel (scripts/content/channel.mjs); unset when run by hand.
  const branch = process.env.ARKPEDIA_DATA_BRANCH || null;
  const readFeeds = !args.includes('--offline') && (branch === null || branch === 'main');
  if (!readFeeds) console.log(args.includes('--offline') ? 'Offline: the catalogue is filed as it is.' : `The ${branch} content channel reads no feeds: it files data main's catalogue.`);
  await syncOfficialVideos(process.cwd(), { readFeeds });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
}
