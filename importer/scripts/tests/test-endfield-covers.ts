/*
 * Arknights: Endfield's album covers: cut square from the label's YouTube thumbnails
 * (scripts/imports/square_album_cover.py), staged by the endfield-albums stage for
 * arkpedia-image-assets album-covers/ (config/staged-art.json, endfield-album-covers), and
 * adopted once published (--adopt-covers), as Monster Siren's are.
 * Until then the site draws an album from its thumbnail, which arkpedia-app's own
 * scripts/tests/test-endfield-covers.ts holds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/** An album record as data/endfield-albums.json holds it. */
type RawAlbum = { albumId: string; coverUrl: string; coverFilename: string; [field: string]: unknown };
// @ts-expect-error Node import scripts are plain JavaScript.
import { adoptCovers, coverEntries, coverFilenameFor, coverSource, FEED, formatAlbums, squareCover, stageCovers, syncEndfieldAlbums } from '../sync/sync-endfield-albums.mjs';
// @ts-expect-error Node publication scripts are plain JavaScript.
import { readQuarantine } from '../lib/quarantine.mjs';

const REPO = process.cwd();
const quiet = () => {};

/**
 * A YouTube art-track frame from Pillow: `width`x`height`, one plain colour, and a seeded noise
 * square of the frame's height in the middle (the art). `sides: 'busy'` fills the sides with
 * noise too; `format` JPEG is what YouTube serves.
 */
function frame(width: number, height: number, { sides = 'plain', format = 'PNG' }: { sides?: 'plain' | 'busy'; format?: string } = {}): Buffer {
  return execFileSync('python3', ['-c', [
    'import io, random, sys',
    'from PIL import Image',
    'w, h, sides, fmt = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]',
    'rng = random.Random(7)',
    'noise = lambda size: Image.frombytes("RGB", size, rng.randbytes(size[0] * size[1] * 3))',
    'image = noise((w, h)) if sides == "busy" else Image.new("RGB", (w, h), (64, 42, 45))',
    'side = min(w, h)',
    'image.paste(noise((side, side)), ((w - side) // 2, (h - side) // 2))',
    'out = io.BytesIO()',
    'image.save(out, fmt, **({"quality": 95} if fmt == "JPEG" else {}))',
    'sys.stdout.buffer.write(out.getvalue())'].join('\n'), String(width), String(height), sides, format], { maxBuffer: 64 * 1024 * 1024 });
}

/** An image's format, size and the sha256 of its RGB pixels, optionally of a crop of it. */
function describe(data: Buffer, box?: [number, number, number, number]) {
  return JSON.parse(execFileSync('python3', ['-c', [
    'import hashlib, io, json, sys',
    'from PIL import Image',
    'image = Image.open(io.BytesIO(sys.stdin.buffer.read()))',
    'fmt = image.format',
    'image = image.convert("RGB")',
    'box = json.loads(sys.argv[1])',
    'image = image.crop(tuple(box)) if box else image',
    'print(json.dumps({"format": fmt, "size": list(image.size), "pixels": hashlib.sha256(image.tobytes()).hexdigest()}))'].join('\n'), JSON.stringify(box ?? null)],
  { input: data, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

/* ---- the cut ----------------------------------------------------------------------- */

test('a cover is the frame\'s centred square at full height, cut losslessly from what YouTube served', () => {
  for (const format of ['PNG', 'JPEG']) {
    const source = frame(1280, 720, { format });
    const cover = squareCover(source);
    const out = describe(cover);
    assert.equal(out.format, 'PNG', 'staged losslessly: the publisher does the one encode');
    assert.deepEqual(out.size, [720, 720]);
    assert.equal(out.pixels, describe(source, [280, 0, 1000, 720]).pixels, `${format}: exactly the middle square`);
  }
});

test('a frame of any other layout is refused, saying why, rather than published wrong for good', () => {
  assert.throws(() => squareCover(frame(480, 360)), /480x360, not 16:9/, 'the standard thumbnail: letterboxed 4:3');
  assert.throws(() => squareCover(frame(640, 360)), /360px high, under the 500px of a published cover/);
  assert.throws(() => squareCover(frame(1280, 720, { sides: 'busy' })), /left side is not one plain colour/, 'the art is not where the cut takes it');
  assert.throws(() => squareCover(Buffer.from('<html>consent</html>')), /not an image that decodes/);
  assert.throws(() => squareCover(frame(1280, 720), { python: 'no-such-python-arkpedia' }), /did not run/);
});

test('a cover is cut from the largest thumbnail of the video its record names, and only from YouTube', () => {
  assert.equal(coverSource('https://i.ytimg.com/vi/aaaaaaaaaa1/maxresdefault.jpg'), 'https://i.ytimg.com/vi/aaaaaaaaaa1/maxresdefault.jpg');
  assert.equal(coverSource('https://i.ytimg.com/vi/bbbbbbbbbb1/hqdefault.jpg'), 'https://i.ytimg.com/vi/bbbbbbbbbb1/maxresdefault.jpg');
  assert.equal(coverSource('https://example.com/vi/aaaaaaaaaa1/maxresdefault.jpg'), null);
  assert.equal(coverSource(''), null);
  assert.equal(coverFilenameFor('endfield-test-album'), 'endfield-test-album_cover.webp', 'named by the id, which no Monster Siren album has');
});

/* ---- staging and adoption ----------------------------------------------------------- */

const album = (albumId: string, videoId: string, size = 'maxres', extra: Partial<RawAlbum> = {}): RawAlbum => ({
  albumId, albumName: `Album ${albumId}`, albumAltName: '', game: 'endfield', youtubePlaylistId: '', coverUrl: `https://i.ytimg.com/vi/${videoId}/${size}default.jpg`,
  coverFilename: '', releaseDate: '2026/10/19', characters: [], albumCategory: [], albumGenre: [],
  songs: [{ songId: `endfield-${videoId}`, songName: 'Song', songAltName: '', albumId, credits: [{ role: 'artist', names: ['A'] }], videoId, length: '03:00', songCategory: [], songGenre: [], copyright: 'no' }],
  ...extra,
});

function tree(albums: RawAlbum[]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'endfield-covers-')));
  fs.mkdirSync(path.join(root, 'data/assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/endfield-albums.json'), formatAlbums(albums));
  fs.writeFileSync(path.join(root, 'data/assets/external-asset-index.json'), JSON.stringify({ files: [] }));
  // Another stage's entry, which nothing here may touch.
  fs.writeFileSync(path.join(root, 'data/quarantine.json'), JSON.stringify({ version: 1, entries: [{ key: 'album:0232', stage: 'albums', action: 'published-partial', reason: 'no cover yet', firstSeen: '2026-10-01' }] }));
  return {
    root,
    albums: () => JSON.parse(fs.readFileSync(path.join(root, 'data/endfield-albums.json'), 'utf8')) as RawAlbum[],
    held: () => (readQuarantine(root).entries as { key: string; stage: string; action: string; firstSeen: string }[]).map(entry => `${entry.stage} ${entry.key} ${entry.action} ${entry.firstSeen}`),
    publish: (...files: string[]) => fs.writeFileSync(path.join(root, 'data/assets/external-asset-index.json'), JSON.stringify({ files })),
    staged: () => {
      const file = path.join(root, '.cache/endfield-album-covers/staged.json');
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).files as Record<string, { file: string; source: string }> : null;
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** YouTube with the feed and the album list down (each night's run reports that and adds
 * nothing), serving `thumbnails` (url -> bytes) and a 404 for any other image. */
function youtube(thumbnails: Record<string, Buffer>, asked: string[] = []) {
  return async (url: string, init?: RequestInit) => {
    asked.push(url);
    if (init?.method === 'HEAD') return new Response(null, { status: 200 });
    if (url.startsWith('https://i.ytimg.com/')) return thumbnails[url] ? new Response(new Uint8Array(thumbnails[url])) : new Response('', { status: 404 });
    return new Response('', { status: url === FEED ? 500 : 429 });
  };
}

test('a night\'s run stages the cover of each album drawn from YouTube, and adoption fills it in once published without asking YouTube again', async () => {
  const t = tree([album('endfield-one', 'aaaaaaaaaa1'), album('endfield-two', 'bbbbbbbbbb1', 'hq'), album('endfield-done', 'ccccccccccc', 'maxres', { coverFilename: 'endfield-done_cover.webp' })]);
  try {
    const one = 'https://i.ytimg.com/vi/aaaaaaaaaa1/maxresdefault.jpg';
    const thumbnail = frame(1280, 720, { format: 'JPEG' });
    const asked: string[] = [];
    const logged: string[] = [];
    await syncEndfieldAlbums({ root: t.root, fetcher: youtube({ [one]: thumbnail }, asked), now: new Date('2026-10-23T01:00:00Z'), log: (line: string) => logged.push(line) });

    // One cover staged, cut square; the hq album's largest thumbnail is not there yet, and an
    // album with a published cover is not fetched at all.
    const staged = t.staged();
    assert.deepEqual(Object.entries(staged ?? {}).map(([target, row]) => [target, row.file, row.source]),
      [['album-covers/endfield-one_cover.webp', 'endfield-one_cover.png', one]]);
    const file = fs.readFileSync(path.join(t.root, '.cache/endfield-album-covers/endfield-one_cover.png'));
    assert.equal(describe(file).pixels, describe(thumbnail, [280, 0, 1000, 720]).pixels);
    assert.ok(asked.includes('https://i.ytimg.com/vi/bbbbbbbbbb1/maxresdefault.jpg'), 'the hq album is cut from its largest thumbnail');
    assert.ok(!asked.some(url => url.includes('ccccccccccc')));
    assert.ok(logged.some(line => /Album endfield-two: no cover staged from https:\/\/i\.ytimg\.com\/vi\/bbbbbbbbbb1\/maxresdefault\.jpg \(HTTP 404\)/.test(line)), logged.join('\n'));

    // Reported as the Monster Siren stage reports a missing cover; the file is unchanged.
    assert.deepEqual(t.held(), [
      'albums album:0232 published-partial 2026-10-01',
      'endfield-albums cover:endfield-one published-partial 2026-10-23',
      'endfield-albums cover:endfield-two published-partial 2026-10-23',
      'endfield-albums endfield:albums kept-previous 2026-10-23',
      'endfield-albums endfield:feed kept-previous 2026-10-23',
    ]);
    const entry = readQuarantine(t.root).entries.find((row: { key: string }) => row.key === 'cover:endfield-one');
    assert.equal(entry.sourceRef, one);
    assert.match(entry.reason, /no cover in arkpedia-image-assets yet \(album-covers\/endfield-one_cover\.webp\), so the site draws its YouTube thumbnail/);
    assert.deepEqual(t.albums().map(row => row.coverFilename), ['', '', 'endfield-done_cover.webp']);
    assert.equal(t.albums()[0].coverUrl, one, 'its thumbnail, which the site draws until a cover is published');

    // The staged-art stage publishes it and runs --adopt-covers, as config/staged-art.json says,
    // in the release's working tree: the one filename filled in, its entry gone, the rest kept.
    t.publish('album-covers/endfield-one_cover.webp');
    const before = t.albums();
    const adopt = spawnSync('node', [path.join(REPO, 'scripts/sync/sync-endfield-albums.mjs'), '--adopt-covers'], { cwd: t.root, encoding: 'utf8' });
    assert.equal(adopt.status, 0, adopt.stderr);
    assert.match(adopt.stdout, /album endfield-one coverFilename: "" -> "endfield-one_cover\.webp"/);
    assert.deepEqual(t.albums(), before.map(row => row.albumId === 'endfield-one' ? { ...row, coverFilename: 'endfield-one_cover.webp' } : row));
    assert.equal(t.albums()[0].coverFilename, 'endfield-one_cover.webp');
    assert.deepEqual(t.held(), [
      'albums album:0232 published-partial 2026-10-01',
      'endfield-albums cover:endfield-two published-partial 2026-10-23',
      'endfield-albums endfield:albums kept-previous 2026-10-23',
      'endfield-albums endfield:feed kept-previous 2026-10-23',
    ]);
    assert.deepEqual(adoptCovers({ root: t.root, log: quiet }), [], 'nothing more to adopt');

    // The next night stages only what is still missing, and keeps every entry's first day.
    asked.length = 0;
    const quarantine = fs.readFileSync(path.join(t.root, 'data/quarantine.json'), 'utf8');
    await syncEndfieldAlbums({ root: t.root, fetcher: youtube({ [one]: thumbnail }, asked), now: new Date('2026-10-24T01:00:00Z'), log: quiet });
    assert.ok(!asked.includes(one), 'a published cover is not fetched again');
    assert.equal(t.staged(), null, 'nothing staged, nothing to publish');
    assert.equal(fs.readFileSync(path.join(t.root, 'data/quarantine.json'), 'utf8'), quarantine);
  } finally {
    t.cleanup();
  }
});

test('a cover published on a night its adoption did not run is filled in by the next night\'s run', async () => {
  const t = tree([album('endfield-one', 'aaaaaaaaaa1')]);
  try {
    t.publish('album-covers/endfield-one_cover.webp');
    await syncEndfieldAlbums({ root: t.root, fetcher: youtube({}), now: new Date('2026-10-23T01:00:00Z'), log: quiet });
    assert.equal(t.albums()[0].coverFilename, 'endfield-one_cover.webp');
    assert.equal(t.staged(), null);
    assert.ok(!t.held().some(row => row.includes('cover:')));
  } finally {
    t.cleanup();
  }
});

test('staging never fails the stage: a refused frame, an address off YouTube or a missing python leave the album on its thumbnail', async () => {
  const t = tree([]);
  try {
    const albums = [album('endfield-one', 'aaaaaaaaaa1'), album('endfield-off', 'ddddddddddd', 'maxres', { coverUrl: 'https://example.com/cover.jpg' })];
    const busy = { 'https://i.ytimg.com/vi/aaaaaaaaaa1/maxresdefault.jpg': frame(1280, 720, { sides: 'busy', format: 'JPEG' }) };
    const logged: string[] = [];
    const asked: string[] = [];
    assert.equal(await stageCovers({ root: t.root, albums, fetcher: youtube(busy, asked), log: (line: string) => logged.push(line) }), 0);
    assert.ok(logged.some(line => /Album endfield-one: no cover staged .* left side is not one plain colour/.test(line)), logged.join('\n'));
    assert.ok(logged.some(line => /Album endfield-off: its cover https:\/\/example\.com\/cover\.jpg is not a YouTube thumbnail; not fetched/.test(line)));
    assert.ok(!asked.some(url => url.startsWith('https://example.com')));
    const good = { 'https://i.ytimg.com/vi/aaaaaaaaaa1/maxresdefault.jpg': frame(1280, 720) };
    assert.equal(await stageCovers({ root: t.root, albums, fetcher: youtube(good), log: quiet, square: (data: Buffer) => squareCover(data, { python: 'no-such-python-arkpedia' }) }), 0);
    assert.equal(t.staged(), null);
    assert.deepEqual(coverEntries(albums).map((row: { key: string }) => row.key), ['cover:endfield-one', 'cover:endfield-off']);
  } finally {
    t.cleanup();
  }
});
