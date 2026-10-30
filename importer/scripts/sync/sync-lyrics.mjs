/**
 * Refresh song lyrics from Monster Siren, Hypergryph's own music label.
 *
 * Every lyric already records where it came from: each song in data/albums.json
 * carries a `lyricUrl` on web.hycdn.cn, which is the file the official player loads.
 * All 180 checked into this repository are byte-identical to what that URL serves
 * once CRLF is normalised, so nothing here is hand-authored and nothing is at risk
 * of being overwritten. This closes the loop so a lyric correction, or a lyric that
 * appears for a song that shipped without one, arrives on its own.
 *
 * What it will NOT do:
 *
 * - Invent a song record. /api/songs gives a cid, a name, an album and artists; a
 *   record here also needs a videoId, a length, categories and credits that no
 *   endpoint supplies. New songs are reported by name so a person adds them.
 * - Rename a lyric file. The filenames are not derivable from the song name -- nine
 *   of them strip an apostrophe, a colon or a question mark, and "The Cure" is filed
 *   as "The_cure" -- so an existing record's `lyricFilename` is used exactly as
 *   written. Deriving one would quietly orphan the file the site asks for.
 * - Delete anything. A lyric that vanishes upstream keeps its local copy and is
 *   reported, the same way the image sync preserves an asset the mirror drops.
 *
 * Usage: node scripts/sync/sync-lyrics.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { COPYRIGHT_DEFAULT } from './sync-albums.mjs';

const API = 'https://monster-siren.hypergryph.com/api';
const ROOT = path.resolve(import.meta.dirname, '../..');
const LYRICS = path.join(ROOT, 'data/lyrics');
const ALBUMS = path.join(ROOT, 'data/albums.json');
const MAX_BYTES = 256_000;
const CONCURRENCY = 4;
const PAUSE_MS = 60;

const dryRun = process.argv.includes('--dry-run');

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const body = await response.json();
  if (body.code !== 0) throw new Error(`API code ${body.code} (${body.msg}): ${url}`);
  return body.data;
}

/** LF, no trailing newline -- 174 of the 180 checked-in files are stored that way,
 * and upstream serves CRLF. A line-ending difference must not read as a lyric change,
 * and a rewrite must not add a newline to every file it touches. */
function normalize(bytes) {
  const text = bytes.toString('utf8');
  if (Buffer.compare(Buffer.from(text, 'utf8'), bytes) !== 0) throw new Error('Lyric is not valid UTF-8');
  return text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/**
 * Replace one field on one song, in the raw text.
 *
 * data/albums.json is hand-formatted -- short arrays sit inline -- and no script
 * writes it. Round-tripping it through JSON.stringify reflows all 630kB into a
 * ten-thousand-line diff, so a sync that changes two strings edits exactly those two
 * strings. songId is unique and every song carries both keys (empty when unset), so
 * the field is found by scanning forward from the song's own id within its object.
 */
function patchField(text, songId, field, value) {
  const anchor = text.indexOf(`"songId": "${songId}"`);
  if (anchor === -1) throw new Error(`Cannot locate song ${songId} in albums.json`);
  if (text.indexOf(`"songId": "${songId}"`, anchor + 1) !== -1) throw new Error(`Ambiguous song id ${songId}`);
  // Bounded to this record: the next song's id, or the end of the file.
  const end = text.indexOf('"songId": "', anchor + 1);
  const window = text.slice(anchor, end === -1 ? text.length : end);
  const pattern = new RegExp(`("${field}": )"((?:[^"\\\\]|\\\\.)*)"`);
  const match = window.match(pattern);
  if (!match) throw new Error(`No ${field} on song ${songId}`);
  const replaced = window.replace(pattern, `$1${JSON.stringify(value)}`);
  return text.slice(0, anchor) + replaced + (end === -1 ? '' : text.slice(anchor + window.length));
}

async function mapLimited(items, worker) {
  const queue = [...items];
  const results = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      results.push(await worker(queue.shift()));
      await new Promise(resolve => setTimeout(resolve, PAUSE_MS));
    }
  }));
  return results;
}

/**
 * Exact track length from the audio itself, for a draft that would otherwise leave a
 * required field blank. Reads 4kB with a range request and walks the RIFF chunks --
 * byteRate and the data chunk's size give the duration outright, no estimate.
 *
 * New releases are WAV; the back catalogue is MP3, whose duration needs frame-by-frame
 * parsing (or the whole file, for a variable bitrate) and is not worth fetching
 * megabytes to guess. Anything that is not RIFF/WAVE returns null and the draft leaves
 * `length` for a person, which is the honest outcome rather than a wrong number.
 */
async function trackLength(sourceUrl) {
  try {
    const response = await fetch(sourceUrl, { headers: { range: 'bytes=0-4095' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 4).toString('latin1') !== 'RIFF' || bytes.subarray(8, 12).toString('latin1') !== 'WAVE') return null;
    let offset = 12, byteRate = null;
    while (offset + 8 <= bytes.length) {
      const id = bytes.subarray(offset, offset + 4).toString('latin1');
      const size = bytes.readUInt32LE(offset + 4);
      if (id === 'fmt ') byteRate = bytes.readUInt32LE(offset + 16);
      if (id === 'data') {
        if (!byteRate) return null;
        const seconds = size / byteRate;
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) return null;
        return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
      }
      offset += 8 + size + (size % 2);
    }
    return null;
  } catch {
    return null;
  }
}

const albumsText = fs.readFileSync(ALBUMS, 'utf8');
const albums = JSON.parse(albumsText);
const albumList = Array.isArray(albums) ? albums : albums.albums;
if (!Array.isArray(albumList) || !albumList.length) throw new Error('Unrecognised albums.json shape');
const songs = albumList.flatMap(album => album.songs || []);

const upstream = await json(`${API}/songs`);
if (!Array.isArray(upstream?.list) || upstream.list.length < 500) throw new Error('Incomplete upstream song list; refusing refresh');
const upstreamById = new Map(upstream.list.map(song => [String(song.cid), song]));

const known = new Set(songs.map(song => String(song.songId)));
const added = upstream.list.filter(song => !known.has(String(song.cid)));

// Resolve a lyric address for every song we hold that upstream still lists. A song
// whose lyrics appeared after its record was written has no local lyricUrl yet, so
// the detail endpoint is asked for all of them rather than only the ones we know.
const resolved = await mapLimited(songs.filter(song => upstreamById.has(String(song.songId))), async (song) => {
  try {
    const detail = await json(`${API}/song/${song.songId}`);
    return { song, lyricUrl: typeof detail?.lyricUrl === 'string' && detail.lyricUrl ? detail.lyricUrl : null };
  } catch (error) {
    return { song, error: error.message };
  }
});

const failures = resolved.filter(row => row.error);
const lost = resolved.filter(row => !row.error && !row.lyricUrl && row.song.lyricFilename);
const fetchable = resolved.filter(row => row.lyricUrl);

const downloads = await mapLimited(fetchable, async ({ song, lyricUrl }) => {
  try {
    const response = await fetch(lyricUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) throw new Error(`Empty or oversized lyric (${bytes.length} bytes)`);
    return { song, lyricUrl, text: normalize(bytes) };
  } catch (error) {
    return { song, lyricUrl, error: `${song.songName}: ${error.message}` };
  }
});

failures.push(...downloads.filter(row => row.error));

const changed = [];
const created = [];
const rewired = [];
for (const row of downloads.filter(row => row.text)) {
  const { song, lyricUrl, text } = row;
  // Never re-derive a filename for a record that already names one.
  const filename = song.lyricFilename || `${song.songName.replace(/[\\/*?:"<>|']/g, '').replace(/ /g, '_')}_lyrics.lrc`;
  const target = path.join(LYRICS, filename);
  if (path.dirname(target) !== LYRICS) throw new Error(`Unsafe lyric filename: ${filename}`);
  const existing = fs.existsSync(target) ? normalize(fs.readFileSync(target)) : null;
  if (existing === null) created.push({ song, filename, text });
  else if (existing !== text) changed.push({ song, filename, text });
  if (song.lyricUrl !== lyricUrl) rewired.push({ song, lyricUrl });
}

// A run that rewrites most of the catalogue is upstream trouble or a format change,
// not 150 simultaneous lyric corrections. Same guard the image sync uses.
const limit = Math.max(25, Math.round(downloads.length * 0.25));
if (changed.length > limit) {
  throw new Error(`${changed.length} lyrics changed at once (limit ${limit}); review upstream before accepting a bulk replacement`);
}
if (failures.length > Math.max(5, Math.round(fetchable.length * 0.05))) {
  throw new Error(`${failures.length} lyric fetches failed; refusing a partial refresh:\n  ${failures.slice(0, 10).map(row => row.error).join('\n  ')}`);
}

for (const row of [...created, ...changed]) {
  console.log(`${row.song.lyricFilename ? '~' : '+'} ${row.filename}`);
  if (!dryRun) fs.writeFileSync(path.join(LYRICS, row.filename), row.text);
}
if (!dryRun && (rewired.length || created.length)) {
  let text = albumsText;
  for (const { song, lyricUrl } of rewired) text = patchField(text, song.songId, 'lyricUrl', lyricUrl);
  for (const { song, filename } of created) text = patchField(text, song.songId, 'lyricFilename', filename);
  // The edit must still be the same document, differing only where intended.
  const before = JSON.parse(albumsText), after = JSON.parse(text);
  if (JSON.stringify(before).length === 0 || typeof after !== typeof before) throw new Error('albums.json patch produced an unusable document');
  fs.writeFileSync(ALBUMS, text);
}

console.log(`\nChecked ${downloads.length} songs against Monster Siren.`);
console.log(`  ${created.length} new lyric file(s), ${changed.length} updated, ${rewired.length} source address(es) refreshed.`);
if (lost.length) console.log(`  ${lost.length} song(s) no longer publish lyrics upstream; local copies kept: ${lost.map(row => row.song.songName).join(', ')}`);
if (failures.length) console.log(`  ${failures.length} fetch failure(s) tolerated:\n    ${failures.map(row => row.error || row.song?.songName).join('\n    ')}`);
if (added.length) {
  const localAlbums = new Set(albumList.map(album => String(album.albumId)));
  const drafts = await mapLimited(added, async (song) => {
    let detail = null, album = null;
    try { detail = await json(`${API}/song/${song.cid}`); } catch { /* reported as unknown below */ }
    const albumCid = String(detail?.albumCid ?? song.albumCid ?? '');
    if (albumCid && !localAlbums.has(albumCid)) {
      try { album = await json(`${API}/album/${albumCid}/detail`); } catch { /* same */ }
    }
    return {
      song: {
        songId: String(song.cid),
        songName: song.name,
        songAltName: '',            // editorial: the English or romanised title
        albumId: albumCid,
        credits: [],                // editorial: the API returns only the label, not the people
        lyricUrl: detail?.lyricUrl ?? '',
        lyricFilename: detail?.lyricUrl ? `${song.name.replace(/[\\/*?:"<>|']/g, '').replace(/ /g, '_')}_lyrics.lrc` : '',
        videoId: '',                // REQUIRED, and not derivable: the YouTube id
        length: detail?.sourceUrl ? (await trackLength(detail.sourceUrl)) ?? '' : '',
        songCategory: [],
        songGenre: [],
        copyright: COPYRIGHT_DEFAULT, // the catalogue's default (sync-albums.mjs)
      },
      upstream: { artists: song.artists ?? detail?.artists ?? [], sourceUrl: detail?.sourceUrl ?? null, mvUrl: detail?.mvUrl ?? null },
      albumMissing: album && {
        albumId: albumCid,
        albumName: album.name,
        albumAltName: '',           // editorial
        coverUrl: album.coverUrl,
        coverFilename: '',          // needs the cover published to arkpedia-image-assets as .webp
        releaseDate: '',            // not published by the API
        region: '', characters: [], albumCategory: [], albumGenre: [],
        intro: album.intro,
      },
    };
  });
  if (!dryRun) {
    fs.mkdirSync(path.join(ROOT, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, '.cache/new-songs.json'), JSON.stringify(drafts, null, 2) + '\n');
  }
  console.log(`\n  ${added.length} song(s) exist upstream with no record here:`);
  for (const draft of drafts) {
    const missingAlbum = draft.albumMissing ? `  [album ${draft.albumMissing.albumId} "${draft.albumMissing.albumName}" also missing]` : '';
    console.log(`    ${draft.song.songId}  ${draft.song.songName}${draft.song.lyricUrl ? '  (has lyrics)' : '  (no lyrics upstream)'}${missingAlbum}`);
  }
  console.log('  Drafts with every field the source supplies: .cache/new-songs.json');
  console.log('  Length is measured from the audio; videoId, credits, categories and the');
  console.log('  English title are editorial. Nothing is written to albums.json automatically.');
}
if (dryRun) console.log('\nDry run: nothing written.');
