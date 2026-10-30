/**
 * Arknights: Endfield's music, in data/endfield-albums.json: the albums and songs Endfield's
 * label, Metal Scar Radio, publishes (℗ GRYPHLINE, Hypergryph's global publishing brand). It
 * runs as the release job's `endfield-albums` stage, right after Monster Siren's `albums`.
 *
 * Endfield has no Monster Siren: its music is not on monster-siren.hypergryph.com, and it has
 * no music API of its own. It reaches the streaming services through the same distributor
 * Monster Siren uses (YOYOROCK), so YouTube has every track as an auto-generated upload on the
 * label's "Metal Scar Radio - Topic" channel (CHANNEL), each description naming the song, its
 * artists, its album, the ℗ line and the day it was released. The music player plays a song by
 * its YouTube upload, as it plays any Arknights song with one, so a song here needs nothing but
 * that upload. The song guesser, which plays clips of Monster Siren's own audio files, never
 * draws from this file (lib/music-guesser/catalogue.ts reads data/albums.json alone).
 *
 * Kept apart from data/albums.json, Monster Siren's catalogue, rather than spliced into it: that
 * file is hand-formatted and its stage, its review lists and its completeness checks all speak
 * of Monster Siren's ids. Every album here carries `game: "endfield"`; an album in
 * data/albums.json carries no game and is Arknights (lib/music/albumsData.ts albumGame).
 *
 * Where it reads, the official source first:
 *
 * - The channel's Atom feed (FEED), YouTube's documented feed: the newest 15 uploads with their
 *   descriptions. A new song is here the day it is published.
 * - The channel's Albums & Singles list and each album's playlist, read the way youtube.com
 *   reads them (readReleases, readPlaylist). Only these list a whole album: a release of 26
 *   songs in one day (Sanctuary of Ink, 2026-10-19) is more than the feed carries. A song the
 *   feed does not describe is described from its upload's own page (readDescription). An
 *   album already complete costs two requests a night and no more.
 *
 * Either may fail on a given night (YouTube can refuse an unsigned request); the other still
 * adds what it reads, nothing already here is touched, and the failure is reported.
 *
 * What it writes:
 *
 * - A new album: albumId `endfield-<its name as a slug>`, its name, game, the album playlist's
 *   id (youtubePlaylistId), its release day (YYYY/MM/DD), and its cover address (coverUrl): the
 *   first song's YouTube thumbnail, which for an auto-generated upload is the album's square art
 *   centred on a plain 16:9 frame. Characters, categories and genres are editorial and start empty.
 * - A cover filename, for an album without one, once arkpedia-image-assets publishes its cover
 *   (album-covers/<albumId>_cover.webp, named by the id so no Monster Siren album's name can take
 *   it). Until then the site draws the thumbnail itself, which every cover's square crop
 *   (object-fit: cover) shows as the art (lib/music/albumsData.ts albumCoverPath). The cover is
 *   that square cut from the largest thumbnail (scripts/imports/square_album_cover.py) and staged
 *   in .cache/endfield-album-covers/ (scripts/lib/staged-art.mjs); the release's staged-art stage
 *   publishes it and runs `--adopt-covers`, which fills in the filename without asking YouTube
 *   again, as the Monster Siren stage does with its covers.
 * - A new song: songId `endfield-<videoId>` (never a Monster Siren id, which is digits, so no
 *   Monster Siren gate takes it for one), its title, its length where the playlist gives it,
 *   and its credits: every artist the description names as `artist`, then the roles it lists.
 *   Copyright "no" when the label published it (℗ GRYPHLINE), as Monster Siren's own songs are.
 * - Credits, a length or a release day for a song or album still without one, once read.
 * - The album's songs in its playlist's order, once its playlist is read.
 *
 * What it will NOT do: change anything already filled in, or drop a record the source no longer
 * lists (the same rules as scripts/sync/sync-albums.mjs).
 *
 * What it reports (data/quarantine.json, stage 'endfield-albums'), never failing the release:
 *
 * - endfield:feed / endfield:albums, kept-previous: that source could not be read tonight.
 * - album:<albumId>, published-partial: its playlist lists more songs than the file has.
 * - song:<videoId>, published-partial: added without credits (its description was not read).
 * - cover:<albumId>, published-partial: no cover in arkpedia-image-assets yet, so the album is
 *   drawn from YouTube. Cleared by `--adopt-covers` once the staged cover is published; a frame
 *   the crop refuses stays here, and the log says why.
 *
 * Usage: node scripts/sync/sync-endfield-albums.mjs [--dry-run] [--full] [--adopt-covers]
 *   --full reads every album's playlist, not only the albums that look incomplete.
 *   --adopt-covers only fills in the covers the image repository now publishes (no requests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beginStage, defaultNow, readQuarantine } from '../lib/quarantine.mjs';
import { beginStaging } from '../lib/staged-art.mjs';
import { parseFeedDescriptions, parseFeedEntries } from '../lib/youtube-uploads.mjs';
import { normalizeReleaseDate } from '../../lib/music/releaseDate.mjs';

export const GAME = 'endfield';
export const STAGE = 'endfield-albums';
export const FILE = 'data/endfield-albums.json';
/** "Metal Scar Radio - Topic", the label's auto-generated YouTube channel. */
export const CHANNEL = 'UC_wSsatRjjuF1xPlN9mtAPw';
export const FEED = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`;
const CHANNEL_PAGE = `https://www.youtube.com/channel/${CHANNEL}?hl=en`;
const YOUTUBEI = 'https://www.youtube.com/youtubei/v1';
/** The ℗ line of a song the label itself published. */
export const LABEL = 'GRYPHLINE';
/** The label's own name in an upload's artist line. */
export const LABEL_ARTIST = 'Metal Scar Radio';
// The web client youtube.com itself sends; the channel page names the current one.
const FALLBACK_CLIENT_VERSION = '2.20261020.05.00';
// A cookie that answers YouTube's consent page, which a runner in the EU is otherwise shown.
const HEADERS = { 'accept-language': 'en-US,en;q=0.8', cookie: 'SOCS=CAI', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };
const TIMEOUT = 30_000;

// The roles a description lists, as the catalogue names them (data/albums.json's credits).
const ROLES = new Map([
  ['composer', 'composer'], ['lyricist', 'lyrics'], ['producer', 'producer'], ['arranger', 'arranger'],
  ['associated performer', 'performer'], ['vocalist', 'performer'], ['vocals', 'performer'],
  ['mixing engineer', 'mixing engineer'], ['mastering engineer', 'mastering engineer'],
]);

/**
 * An auto-generated upload's description: "Provided to YouTube by <distributor>", then
 * "<song> · <artist> · <artist>", the album, "℗ <label>", "Released on: YYYY-MM-DD" and one
 * "<Role>: <name>" line per credit. Null for any other description.
 */
export function parseDescription(text) {
  const blocks = String(text ?? '').replace(/\r/g, '').split(/\n[ \t]*\n/).map(block => block.trim()).filter(Boolean);
  if (!/^Provided to YouTube by /i.test(blocks[0] ?? '')) return null;
  const [title, ...artists] = (blocks[1] ?? '').split(' · ').map(name => name.trim()).filter(Boolean);
  if (!title || !artists.length) return null;
  const album = blocks[2] && !/^℗|^Released on:/i.test(blocks[2]) ? blocks[2] : null;
  const label = blocks.find(block => block.startsWith('℗'))?.replace(/^℗\s*(?:\d{4}\s+)?/, '').trim() || null;
  const released = blocks.map(block => block.match(/^Released on:\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1]).find(Boolean);
  const byRole = new Map();
  for (const block of blocks.slice(3)) {
    for (const line of block.split('\n')) {
      const match = line.match(/^([^:]{2,40}):\s*(.+)$/);
      const role = match && ROLES.get(match[1].trim().toLowerCase());
      if (!role) continue;
      const names = byRole.get(role) ?? [];
      if (!names.includes(match[2].trim())) names.push(match[2].trim());
      byRole.set(role, names);
    }
  }
  return {
    title,
    artists,
    album,
    label,
    releaseDate: released ? normalizeReleaseDate(released) : null,
    credits: [...byRole].map(([role, names]) => ({ role, names })),
  };
}

/** A song's credits: its artists first, as the catalogue's records list them. The label is an
 * artist only of a song that credits no one else, as Monster Siren's records credit 塞壬唱片-MSR. */
export function creditsFrom(details) {
  if (!details) return [];
  const others = details.artists.filter(name => name !== LABEL_ARTIST);
  const artists = others.length ? others : [...details.artists];
  return [{ role: 'artist', names: artists }, ...details.credits.map(credit => ({ role: credit.role, names: [...credit.names] }))];
}

const fold = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** The album's id: `endfield-` and its name as a slug, made unique among `taken`. */
export function albumIdFor(name, taken = new Set()) {
  const slug = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'album';
  let id = `${GAME}-${slug}`;
  for (let n = 2; taken.has(id); n++) id = `${GAME}-${slug}-${n}`;
  return id;
}

export const songIdFor = videoId => `${GAME}-${videoId}`;

/** "3:35" or "1:02:03" as the catalogue writes a length (MM:SS), or '' for anything else. */
export function lengthFrom(text) {
  const parts = String(text ?? '').trim().split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isInteger(part) || part < 0)) return '';
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  if (!seconds) return '';
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The thumbnail an album is drawn with (see the header): its first song's. */
export const coverFor = videoId => `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

export function newAlbumRecord({ albumId, name, playlistId, releaseDate }) {
  return {
    albumId,
    albumName: name,
    albumAltName: '',
    game: GAME,
    youtubePlaylistId: playlistId ?? '',
    coverUrl: '',
    coverFilename: '',
    releaseDate: releaseDate ?? '',
    region: '',
    characters: [],
    albumCategory: [],
    albumGenre: [],
    songs: [],
  };
}

export function newSongRecord({ videoId, title, length, details, albumId }) {
  return {
    songId: songIdFor(videoId),
    songName: title,
    songAltName: '',
    albumId,
    credits: creditsFrom(details),
    lyricUrl: '',
    lyricFilename: '',
    videoId,
    length: length || '',
    songCategory: [],
    songGenre: [],
    // Stream-safe leaves out a song marked "yes" (lib/music/albumsData.ts); the label's own
    // songs are "no", as Monster Siren's are, and anything else waits for a person.
    copyright: details && details.label !== LABEL ? 'yes' : 'no',
  };
}

// ---------------------------------------------------------------------------------------
// Reading YouTube.

/** Every object under `value` that has `key`, depth first: YouTube nests its renderers deep and
 * moves them between releases, so the readers look them up by name, not by path. */
function collect(value, key, out = []) {
  if (Array.isArray(value)) for (const item of value) collect(item, key, out);
  else if (value && typeof value === 'object') {
    if (key in value) out.push(value[key]);
    for (const child of Object.values(value)) collect(child, key, out);
  }
  return out;
}

const runText = text => text?.simpleText ?? text?.content ?? (Array.isArray(text?.runs) ? text.runs.map(run => run.text).join('') : '');

/** The Albums & Singles list's albums: [{ playlistId, name, count, releaseDate }]. */
export function parseReleases(json) {
  const releases = [];
  for (const grid of collect(json, 'gridPlaylistRenderer')) {
    const playlistId = grid?.playlistId;
    const name = runText(grid?.title).trim();
    if (!/^OLAK5uy_[\w-]+$/.test(playlistId ?? '') || !name) continue;
    const count = Number.parseInt(runText(grid.videoCountText) || runText(grid.videoCountShortText), 10);
    const byline = (grid.shortBylineText?.runs ?? []).map(run => run.text);
    const date = byline.map(text => normalizeReleaseDate(text)).find(Boolean) ?? null;
    if (!releases.some(release => release.playlistId === playlistId)) releases.push({ playlistId, name, count: Number.isFinite(count) ? count : null, releaseDate: date });
  }
  return releases;
}

/**
 * An album playlist's songs in order: [{ videoId, title, length }]. Only the label channel's own
 * uploads: where its upload of a song is missing, YouTube fills the album's place with someone
 * else's upload of it ("Old Deep Water Dies..." listed a fan's re-upload of a boss theme, 2026-10).
 */
export function parsePlaylist(json) {
  const songs = [];
  for (const lockup of collect(json, 'lockupViewModel')) {
    if (lockup?.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || !/^[\w-]{11}$/.test(lockup.contentId ?? '')) continue;
    const channels = collect(lockup.metadata, 'browseEndpoint').map(endpoint => endpoint?.browseId).filter(Boolean);
    if (!channels.includes(CHANNEL)) continue;
    const title = runText(lockup.metadata?.lockupMetadataViewModel?.title).trim();
    if (!title || songs.some(song => song.videoId === lockup.contentId)) continue;
    const badge = collect(lockup.contentImage, 'thumbnailBadgeViewModel').map(view => view?.text).find(text => /^\d+(?::\d{2}){1,2}$/.test(text ?? ''));
    songs.push({ videoId: lockup.contentId, title, length: lengthFrom(badge) });
  }
  return songs;
}

const initialData = html => {
  const match = String(html).match(/var ytInitialData = (\{.*?\});<\/script>/s);
  return match ? JSON.parse(match[1]) : null;
};

async function youtubei(fetcher, endpoint, body, clientVersion) {
  const response = await fetcher(`${YOUTUBEI}/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } }, ...body }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${endpoint}`);
  return response.json();
}

/** The channel's Albums & Singles, read as youtube.com reads them, and the client version for
 * the requests after it. The channel page lists the first dozen; the shelf's panel lists all. */
export async function readReleases(fetcher) {
  const response = await fetcher(CHANNEL_PAGE, { signal: AbortSignal.timeout(TIMEOUT), headers: HEADERS });
  if (!response.ok) throw new Error(`HTTP ${response.status} from the channel page`);
  const html = await response.text();
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([\d.]+)"/)?.[1] ?? FALLBACK_CLIENT_VERSION;
  const data = initialData(html);
  if (!data) throw new Error('the channel page carries no data');
  const shelf = collect(data, 'shelfRenderer').find(item => /albums/i.test(runText(item?.title)));
  const token = shelf && collect(shelf, 'continuationCommand').map(command => command?.token).find(Boolean);
  let releases = [];
  if (token) releases = parseReleases(await youtubei(fetcher, 'browse', { continuation: token }, clientVersion));
  // The page's own first dozen, should the panel not open: still every recent album.
  if (!releases.length && shelf) {
    releases = collect(shelf, 'lockupViewModel').filter(item => item?.contentType === 'LOCKUP_CONTENT_TYPE_ALBUM').map(item => ({
      playlistId: item.contentId,
      name: runText(item.metadata?.lockupMetadataViewModel?.title).trim(),
      count: Number.parseInt(collect(item, 'thumbnailBadgeViewModel').map(view => view?.text).find(text => /songs?$/.test(text ?? '')) ?? '', 10) || null,
      releaseDate: collect(item.metadata, 'content').map(text => normalizeReleaseDate(text)).find(Boolean) ?? null,
    })).filter(release => /^OLAK5uy_[\w-]+$/.test(release.playlistId ?? '') && release.name);
  }
  if (!releases.length) throw new Error('the channel lists no albums');
  return { releases, clientVersion };
}

export async function readPlaylist(fetcher, playlistId, clientVersion = FALLBACK_CLIENT_VERSION) {
  return parsePlaylist(await youtubei(fetcher, 'browse', { browseId: `VL${playlistId}` }, clientVersion));
}

/** An upload's description, if it is one of this channel's. */
export async function readDescription(fetcher, videoId, clientVersion = FALLBACK_CLIENT_VERSION) {
  const json = await youtubei(fetcher, 'player', { videoId }, clientVersion);
  const details = json?.videoDetails;
  if (details?.videoId !== videoId || details?.channelId !== CHANNEL) throw new Error('not one of the channel\'s uploads');
  return String(details.shortDescription ?? '');
}

/** The album's cover address: the first song's largest thumbnail, if YouTube has one, else its
 * standard one (which every upload has). */
async function pickCover(fetcher, videoId) {
  try {
    const response = await fetcher(coverFor(videoId), { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT) });
    if (response.ok) return coverFor(videoId);
  } catch { /* the standard one */ }
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// ---------------------------------------------------------------------------------------
// Merging.

/**
 * Folds what the night read into the albums (a fresh copy; the input is not changed).
 *   albums:       the file's albums
 *   feed:         [{ videoId, title, details }] -- the feed's uploads, newest first, details
 *                 parsed from their descriptions (null where they are not the label's)
 *   playlists:    [{ release, songs: [{ videoId, title, length }] }] -- albums whose playlist
 *                 was read, in the channel's order
 *   descriptions: Map videoId -> details, for songs the feed did not describe
 *   releases:     the Albums & Singles list, or null when it was not read
 * Returns { albums, added: { albums, songs }, partial: [{ key, reason }] }.
 */
export function mergeEndfield({ albums, feed = [], playlists = [], descriptions = new Map(), releases = null }) {
  const next = structuredClone(albums);
  const taken = new Set(next.map(album => album.albumId));
  const known = new Map(next.flatMap(album => album.songs.map(song => [song.videoId, { album, song }])));
  const fromFeed = new Map(feed.filter(upload => upload.details).map(upload => [upload.videoId, upload]));
  const detailsOf = videoId => fromFeed.get(videoId)?.details ?? descriptions.get(videoId) ?? null;
  const added = { albums: 0, songs: 0 };

  const findAlbum = ({ playlistId, name }) => next.find(album => playlistId && album.youtubePlaylistId === playlistId)
    ?? next.find(album => fold(album.albumName) === fold(name));
  const ensureAlbum = ({ playlistId, name, releaseDate }) => {
    let album = findAlbum({ playlistId, name });
    if (!album) {
      album = newAlbumRecord({ albumId: albumIdFor(name, taken), name, playlistId, releaseDate });
      taken.add(album.albumId);
      next.push(album);
      added.albums++;
    }
    if (playlistId && !album.youtubePlaylistId) album.youtubePlaylistId = playlistId;
    if (releaseDate && !album.releaseDate) album.releaseDate = releaseDate;
    return album;
  };
  const addSong = (album, { videoId, title, length }) => {
    const existing = known.get(videoId);
    const details = detailsOf(videoId);
    if (existing) {
      // Filled in once read, never rewritten.
      if (!existing.song.length && length) existing.song.length = length;
      if (!existing.song.credits.length && details) existing.song.credits = creditsFrom(details);
      return;
    }
    const song = newSongRecord({ videoId, title: details?.title || title, length, details, albumId: album.albumId });
    album.songs.push(song);
    known.set(videoId, { album, song });
    added.songs++;
  };

  for (const { release, songs } of playlists) {
    // A playlist with none of the label's uploads makes no album: an album with no song has no
    // cover and nothing to play, and Browse by album would list an empty tile.
    if (!songs.length && !findAlbum(release)) continue;
    const album = ensureAlbum({ playlistId: release.playlistId, name: release.name, releaseDate: release.releaseDate });
    for (const song of songs) addSong(album, song);
    // The playlist's order; a song it no longer lists keeps its place after them.
    const order = new Map(songs.map((song, index) => [song.videoId, index]));
    album.songs = album.songs.map((song, index) => ({ song, index }))
      .sort((a, b) => (order.get(a.song.videoId) ?? songs.length + a.index) - (order.get(b.song.videoId) ?? songs.length + b.index))
      .map(row => row.song);
  }
  // The feed's newest first, so a single's album is created in release order: oldest first.
  for (const upload of [...feed].reverse()) {
    if (!upload.details?.album || known.has(upload.videoId)) {
      if (known.has(upload.videoId)) addSong(known.get(upload.videoId).album, upload);
      continue;
    }
    const release = releases?.find(item => fold(item.name) === fold(upload.details.album));
    const album = ensureAlbum({ playlistId: release?.playlistId, name: upload.details.album, releaseDate: release?.releaseDate ?? upload.details.releaseDate });
    addSong(album, { videoId: upload.videoId, title: upload.title, length: '' });
  }
  for (const album of next) {
    if (!album.releaseDate) {
      const days = album.songs.map(song => detailsOf(song.videoId)?.releaseDate).filter(Boolean).sort();
      if (days.length) album.releaseDate = days[0];
    }
  }

  // An album is short when it has fewer songs than its playlist: the label's own songs in it
  // when it was read tonight, else the count the album list gives (which also counts any song
  // YouTube filled from someone else's upload, so such an album is read again each night).
  const partial = [];
  const read = new Map(playlists.map(({ release, songs }) => [release.playlistId, songs.length]));
  for (const release of releases ?? []) {
    const album = findAlbum(release);
    const have = album?.songs.length ?? 0;
    const expected = read.get(release.playlistId) ?? release.count;
    if (expected && have < expected) {
      partial.push({ key: `album:${album?.albumId ?? albumIdFor(release.name)}`, reason: `its YouTube album lists ${expected} songs and the catalogue has ${have}` });
    }
  }
  for (const album of next) {
    for (const song of album.songs) {
      if (!song.credits.length) partial.push({ key: `song:${song.videoId}`, reason: 'added without credits: its YouTube description was not read' });
    }
  }
  return { albums: next, added, partial };
}

// ---------------------------------------------------------------------------------------

export function readAlbums(root) {
  const file = path.join(root, FILE);
  if (!fs.existsSync(file)) return [];
  const albums = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(albums)) throw new Error(`${FILE} is not a list of albums`);
  return albums;
}

export const formatAlbums = albums => `${JSON.stringify(albums, null, 2)}\n`;

// ---------------------------------------------------------------------------------------
// Covers.

const SQUARE = fileURLToPath(new URL('../imports/square_album_cover.py', import.meta.url));
const THUMBNAIL = /^https:\/\/i\.ytimg\.com\/vi\/([\w-]{11})\/(?:maxres|hq)default\.jpg$/;

/** Where an album's cover is published in album-covers/: by its id, unique to the album. */
export const coverFilenameFor = albumId => `${albumId}_cover.webp`;

/** The thumbnail a cover is cut from: the largest of the video the record's cover names. An album
 * whose largest was missing the night it came in names the standard one (480x360, the frame
 * letterboxed), which is too small to publish; the largest may be there by now. Null for an
 * address that is not a YouTube thumbnail, which is never fetched. */
export function coverSource(coverUrl) {
  const videoId = String(coverUrl ?? '').match(THUMBNAIL)?.[1];
  return videoId ? coverFor(videoId) : null;
}

/** The album's square art cut from a thumbnail frame (scripts/imports/square_album_cover.py), as
 * PNG bytes. Throws, saying why, for a frame the cut refuses. */
export function squareCover(data, { python = 'python3' } = {}) {
  // A 720px square is about 1 MB of PNG, the whole of spawnSync's default buffer.
  const result = spawnSync(python, [SQUARE], { input: data, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`${python} did not run (${result.error.message})`);
  if (result.status !== 0) throw new Error(String(result.stderr ?? '').trim() || `${python} exited ${result.status ?? result.signal}`);
  return result.stdout;
}

/** The image repository's paths at the adopted pins (`npm run assets:update`). */
export function readAssets(root) {
  const file = path.join(root, 'data/assets/external-asset-index.json');
  return new Set(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).files ?? [] : []);
}

/** Fills in the cover filename of every album still without one whose cover the image repository
 * publishes, in place. Returns those albums' ids. A filename already set is never changed. */
export function adoptPublishedCovers(albums, assets) {
  const adopted = [];
  for (const album of albums) {
    if (album.coverFilename || typeof album.albumId !== 'string') continue;
    const file = coverFilenameFor(album.albumId);
    if (!assets.has(`album-covers/${file}`)) continue;
    album.coverFilename = file;
    adopted.push(album.albumId);
  }
  return adopted;
}

/** The stage's entry for every album still drawn from YouTube, as the Monster Siren stage
 * reports an album without a cover. */
export function coverEntries(albums) {
  return albums.filter(album => !album.coverFilename).map(album => ({
    key: `cover:${album.albumId}`,
    action: 'published-partial',
    ...(album.coverUrl ? { sourceRef: album.coverUrl } : {}),
    reason: `${album.albumAltName || album.albumName}: no cover in arkpedia-image-assets yet (album-covers/${coverFilenameFor(album.albumId)}), so the site draws its YouTube thumbnail`,
  }));
}

/**
 * Stages the cover of every album without a published one, cut square from its largest
 * thumbnail, for the staged-art stage to publish. One that cannot be fetched or cut is logged
 * and waits for the next night; its album keeps its YouTube thumbnail and its entry either way.
 */
export async function stageCovers({ root, albums, fetcher, log = () => {}, square = squareCover }) {
  const staging = beginStaging('endfield-album-covers', root);
  let staged = 0;
  for (const album of albums) {
    if (album.coverFilename || typeof album.albumId !== 'string') continue;
    const source = coverSource(album.coverUrl);
    if (!source) {
      if (album.coverUrl) log(`  ! ${album.albumName}: its cover ${album.coverUrl} is not a YouTube thumbnail; not fetched`);
      continue;
    }
    try {
      const response = await fetcher(source, { signal: AbortSignal.timeout(TIMEOUT) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      staging.stage(`album-covers/${coverFilenameFor(album.albumId)}`, square(Buffer.from(await response.arrayBuffer())), { source });
      staged++;
    } catch (error) {
      log(`  ! ${album.albumName}: no cover staged from ${source} (${error.message})`);
    }
  }
  staging.commit();
  if (staged) log(`${staged} album cover(s) staged in .cache/endfield-album-covers/ for arkpedia-image-assets`);
  return staged;
}

/**
 * After the staged-art stage published covers: the cover filename of every album whose cover the
 * image repository now has, and the stage's entries for those covers dropped -- the rest of the
 * stage's entries as they were, and no request to YouTube.
 */
export function adoptCovers({ root = process.cwd(), now = defaultNow(), log = console.log } = {}) {
  const albums = readAlbums(root);
  const adopted = adoptPublishedCovers(albums, readAssets(root));
  if (!adopted.length) { log('No Endfield album gained a published cover.'); return []; }
  fs.writeFileSync(path.join(root, FILE), formatAlbums(albums));
  const cleared = new Set(adopted.map(albumId => `cover:${albumId}`));
  const stage = beginStage(root, STAGE, now);
  for (const entry of readQuarantine(root).entries) {
    if (entry.stage === STAGE && !cleared.has(entry.key)) stage.add(entry);
  }
  stage.commit();
  for (const albumId of adopted) log(`  ~ album ${albumId} coverFilename: "" -> ${JSON.stringify(coverFilenameFor(albumId))}`);
  return adopted;
}

/** One night's run: reads, merges, writes the file and the stage's quarantine entries. */
export async function syncEndfieldAlbums({ root = process.cwd(), fetcher = fetch, now = defaultNow(), log = console.log, dryRun = false, full = false } = {}) {
  const albums = readAlbums(root);
  const failures = [];

  let feed = [];
  try {
    const response = await fetcher(FEED, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const descriptions = parseFeedDescriptions(xml);
    feed = parseFeedEntries(xml).map(upload => ({ ...upload, details: parseDescription(descriptions.get(upload.videoId)) }));
    if (!feed.length) throw new Error('no uploads in the feed');
  } catch (error) {
    log(`  ! The Metal Scar Radio feed did not load (${error.message})`);
    failures.push({ key: 'endfield:feed', reason: 'the Metal Scar Radio YouTube feed could not be read', sourceRef: FEED });
  }

  let releases = null;
  const playlists = [];
  const descriptions = new Map();
  try {
    const listed = await readReleases(fetcher);
    releases = listed.releases;
    const { clientVersion } = listed;
    // An album is read when it is new or short of the songs its playlist lists.
    const wanted = releases.filter(release => {
      const album = albums.find(item => item.youtubePlaylistId === release.playlistId) ?? albums.find(item => fold(item.albumName) === fold(release.name));
      return full || !album || (release.count !== null && album.songs.length < release.count);
    });
    for (const release of wanted) {
      try {
        playlists.push({ release, songs: await readPlaylist(fetcher, release.playlistId, clientVersion) });
      } catch (error) {
        log(`  ! ${release.name}: its playlist did not load (${error.message})`);
      }
    }
    const described = new Set(feed.filter(upload => upload.details).map(upload => upload.videoId));
    const have = new Map(albums.flatMap(album => album.songs.map(song => [song.videoId, song])));
    const undescribed = playlists.flatMap(({ songs }) => songs)
      .filter(song => !described.has(song.videoId) && !(have.get(song.videoId)?.credits.length));
    for (const song of undescribed) {
      try {
        const details = parseDescription(await readDescription(fetcher, song.videoId, clientVersion));
        if (details) descriptions.set(song.videoId, details);
      } catch (error) {
        log(`  ! ${song.title} (${song.videoId}): its description did not load (${error.message})`);
      }
    }
  } catch (error) {
    log(`  ! The Metal Scar Radio album list did not load (${error.message})`);
    failures.push({ key: 'endfield:albums', reason: 'the Metal Scar Radio album list on YouTube could not be read', sourceRef: `https://www.youtube.com/channel/${CHANNEL}` });
  }

  const merged = mergeEndfield({ albums, feed, playlists, descriptions, releases });
  for (const album of merged.albums) {
    if (!album.coverUrl && album.songs[0]) album.coverUrl = await pickCover(fetcher, album.songs[0].videoId);
  }
  // A cover published on a night its adoption did not run (the staged-art stage failed after the push).
  const adopted = adoptPublishedCovers(merged.albums, readAssets(root));
  const songCount = merged.albums.reduce((total, album) => total + album.songs.length, 0);
  log(`Endfield: ${merged.albums.length} albums, ${songCount} songs (${merged.added.albums} albums and ${merged.added.songs} songs new tonight)`);
  for (const albumId of adopted) log(`  ~ album ${albumId} coverFilename: "" -> ${JSON.stringify(coverFilenameFor(albumId))}`);
  if (dryRun) return { ...merged, failures };

  const text = formatAlbums(merged.albums);
  const file = path.join(root, FILE);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  // Staging is best effort: a cover not staged tonight keeps the album on its thumbnail.
  try {
    await stageCovers({ root, albums: merged.albums, fetcher, log });
  } catch (error) {
    log(`  ! No cover was staged (${error.message})`);
  }
  const stage = beginStage(root, STAGE, now);
  for (const failure of failures) stage.add({ ...failure, action: 'kept-previous' });
  for (const entry of merged.partial) stage.add({ ...entry, action: 'published-partial' });
  for (const entry of coverEntries(merged.albums)) stage.add(entry);
  const written = stage.commit();
  if (written.length) log(`${written.length} record(s) flagged:\n${written.map(entry => `  ! ${entry.key} (${entry.action}): ${entry.reason}`).join('\n')}`);
  return { ...merged, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--adopt-covers')) adoptCovers();
  else {
    syncEndfieldAlbums({ dryRun: process.argv.includes('--dry-run'), full: process.argv.includes('--full') })
      .catch(error => { console.error(error); process.exitCode = 1; });
  }
}
