import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyUploads, checkGuideCreators, checkGuideState, classifyUpload, gameContentNames, guideIndex, matchTitle, nextMarker, prunePending, REVIEW_DAYS,
} from '../sync/guide-videos.mjs';
import {
  MIN_CALL_MS, parseListing, readingOrder, renderSuggestions, syncGuideVideos, writeSuggestionsReport, youtubeSources,
} from '../sync/sync-guide-videos.mjs';
import { parseFeed, parseFeedEntries } from '../lib/youtube-uploads.mjs';
import { readQuarantine } from '../lib/quarantine.mjs';

/*
 * The guide-videos stage over recorded inputs, no network: fifty-seven operator records as data
 * main had them on 2026-10-15 before the backfill (fixtures/guide-videos/records.json: names,
 * alters, Chinese names, guides); the game's event and mode names as data/stages-content.json had
 * them (stages-content.json, kind and name only); DragonGJY's channel listing as yt-dlp's flat
 * playlist gave it that day (dragongjy-listing.json, 214 uploads), and the channel's feed in the
 * Atom shape with the same fourteen latest uploads and a Short (dragongjy-feed.xml); the first 30
 * uploads of FrostByte262's, SharkyFerret's and Yii's listings, recorded the same way; and
 * FrostByte262's and SharkyFerret's real feeds of that day (frostbyte262-feed.xml with eleven
 * Shorts, sharkyferret-feed.xml with twelve streams the Videos tab does not list).
 */
const fixture = file => fs.readFileSync(path.join('scripts/tests/fixtures/guide-videos', file), 'utf8');
const RECORDS = JSON.parse(fixture('records.json'));
const LISTING = JSON.parse(fixture('dragongjy-listing.json'));
const FEED = fixture('dragongjy-feed.xml');
const STAGES_CONTENT = JSON.parse(fixture('stages-content.json'));
const MODES = gameContentNames({ stagesContent: STAGES_CONTENT });
const CHANNEL = 'UC4kAu36j1X8qGXys4ZEc77Q';
const DRAGON = { name: 'DragonGJY', channelId: CHANNEL, handle: '@DragonGJY', titlePatterns: ['^Operator Hindsight: § Analysis$'] };
const FROST = { name: 'FrostByte262', channelId: 'UCjmigXcFhjldwmVBpdLoARg', handle: '@FrostByte262', titlePatterns: ['^(?:\\[Arknights\\] )?(?:you )?should you (?:get|build|save for|get and build) §'] };
const SHARKY = { name: 'SharkyFerret', channelId: 'UCvoo-02rKEN1gx-LCPcBwyQ', handle: '@sharkyferret' };
const YII = { name: 'Yii', channelId: 'UCL-oKkU4QPKsW7apo5xBx7A', handle: '@HiImYii' };
const KUKKI = { name: 'kukkikaze', channelId: 'UCYKqSTaebCjNrQSPZ3_uHcw', titlePatterns: ['^How to (?:\\(\\w+\\) )?Use §', 'Operator Showcase: §$'] };
const LISTINGS = { [CHANNEL]: LISTING, [FROST.channelId]: JSON.parse(fixture('frostbyte262-listing.json')), [KUKKI.channelId]: JSON.parse(fixture('kukkikaze-listing.json')),
  [SHARKY.channelId]: JSON.parse(fixture('sharkyferret-listing.json')), [YII.channelId]: JSON.parse(fixture('yii-listing.json')) };
const records = () => structuredClone(RECORDS);
const creator = (overrides = {}) => checkGuideCreators({ version: 1, creators: [{ ...DRAGON, ...overrides }] }).creators[0];
const names = list => list.map(record => record.name);
const index = guideIndex(RECORDS, { modes: MODES });
const matched = title => names(matchTitle(title, index).operators);

test('the registry: a version 1 list of creators, each named as guides spell it, with a channel id', () => {
  const ok = checkGuideCreators({ version: 1, creators: [DRAGON, { name: 'Kay Sensei', channelId: 'UCIWl-xJkLO6bDejpL8FVHcA' }], dismissed: ['HGKEVgGLgUw'] });
  assert.deepEqual(ok.creators.map(entry => entry.name), ['DragonGJY', 'Kay Sensei']);
  assert.ok(ok.creators[0].titlePatterns[0] instanceof RegExp);
  assert.ok(ok.dismissed.has('HGKEVgGLgUw'));
  const bad = (value, why) => assert.throws(() => checkGuideCreators(value), error => error.message.startsWith('data/guide-creators.json') && why.test(error.message));
  bad({ version: 2, creators: [] }, /version 1/);
  bad({ version: 1 }, /creators list/);
  bad({ version: 1, creators: [{ name: 'DragonGJY' }] }, /channelId/);
  bad({ version: 1, creators: [{ ...DRAGON, channelId: 'UC4kAu36j1X8' }] }, /channelId/);
  bad({ version: 1, creators: [{ ...DRAGON, name: ' DragonGJY' }] }, /needs a name/);
  bad({ version: 1, creators: [DRAGON, { ...DRAGON, channelId: 'UCIWl-xJkLO6bDejpL8FVHcA', name: 'dragongjy' }] }, /names dragongjy twice/);
  bad({ version: 1, creators: [DRAGON, { ...DRAGON, name: 'Another' }] }, /twice/);
  bad({ version: 1, creators: [{ ...DRAGON, titlePatterns: ['§ ('] }] }, /not a regular expression/);
  bad({ version: 1, creators: [{ ...DRAGON, channel: CHANNEL }] }, /unknown field "channel"/);
  bad({ version: 1, creators: [DRAGON], dismissed: ['not-an-id'] }, /dismissed/);
  bad({ version: 1, creators: [DRAGON], extra: true }, /unknown field "extra"/);
  // Another spelling the curated guides credit the channel by; no two creators share one.
  const whaleyyy = { name: 'Whaleyyy', channelId: 'UCaU5Q5gOpgucuwrCkWyrhMQ', aliases: ['whaleyyy337'] };
  assert.deepEqual(checkGuideCreators({ version: 1, creators: [whaleyyy] }).creators[0].aliases, ['whaleyyy337']);
  bad({ version: 1, creators: [whaleyyy, { ...DRAGON, aliases: ['Whaleyyy337'] }] }, /names Whaleyyy337 twice/);
  bad({ version: 1, creators: [{ ...whaleyyy, aliases: 'whaleyyy337' }] }, /aliases/);
  bad({ version: 1, creators: [{ ...whaleyyy, aliases: [' whaleyyy337'] }] }, /aliases/);
  assert.deepEqual(checkGuideState(undefined), { version: 1, creators: {}, pending: [], decided: [] });
  // The file the one-time backfill wrote has no decided list: it reads as an empty one.
  assert.deepEqual(checkGuideState({ version: 1, creators: {}, pending: [] }).decided, []);
  assert.throws(() => checkGuideState({ version: 1, creators: { [CHANNEL]: { backfilledAt: 'yesterday' } }, pending: [] }), /backfilledAt/);
  assert.throws(() => checkGuideState({ version: 1, creators: {}, pending: [], decided: ['not-an-id'] }), /decided/);
});

test('a title is matched by name, former name and Chinese name, the longest name first', () => {
  // Global's "Kal'tsit Esperanta" is the record "Kal'tsit - Esperanta", and not Kal'tsit as well.
  assert.deepEqual(matched("Operator Hindsight: Kal'tsit Esperanta Analysis"), ["Kal'tsit - Esperanta"]);
  assert.deepEqual(matched('Operator Hindsight: Blaze the Igniting Spark Analysis'), ['Blaze the Igniting Spark']);
  assert.deepEqual(matched('Should You Get Skadi The Corrupting Heart? | Operator Skalter Review'), ['Skadi the Corrupting Heart']);
  assert.deepEqual(matched('Should You Pull & Build Mlynar? | Operator Mlynar Guide'), ['Młynar']);
  assert.deepEqual(matched('【明日方舟】浊心斯卡蒂 斯卡蒂'), ['Skadi the Corrupting Heart', 'Skadi']);
  assert.deepEqual(matched('Guard Amiya 50lv S1,S2 lv7'), ['Amiya (Guard)']);
  assert.deepEqual(matched('IS5 run w/ Ash'), ['Ash'], '"w/" is "with", not W');
  assert.deepEqual(matched('Should You Build W? | Operator W Review'), ['W']);
  assert.deepEqual(matched('A wall of text'), [], 'a one-letter name only as its own capital');
  assert.deepEqual(matched("Ash's S3 is SilverAsh's S3"), ['Ash', 'SilverAsh']);
});

test('"<name> alter" is the alter the record names, and a base name does not swallow its alter', () => {
  assert.deepEqual(matched('Should You Save for Kal\'tsit alter? [Arknights]'), ["Kal'tsit - Esperanta"]);
  assert.deepEqual(matched('TRAGODIA (PHANTOM ALTER) GUIDE & REVIEW'), ['Tragodia']);
  assert.deepEqual(matched('SIEGE ALTER GUIDE & REVIEW BUT REALLY FAST (VINA VICTORIA)'), ['Vina Victoria']);
  assert.deepEqual(matched('Silence "Alters" the Meta [Arknights Guide]'), ['Silence the Paradigmatic']);
  assert.deepEqual(matched('[Arknights] Angelina the Mellow Wish (Alter Angelina) 90lv S1, S2, S3 lv7'), ['Angelina the Mellow Wish']);
  // Two alters, or a word only the alter's name has: named, but not settled.
  const chen = matchTitle('Should You Save for Ch\'en Alter?', index);
  assert.deepEqual(chen.operators, []);
  assert.deepEqual(names(chen.candidates), ["Ch'en the Holungday", "Ch'en the Dawnstreak"]);
  assert.match(chen.ambiguous[0], /could be Ch'en the Holungday or Ch'en the Dawnstreak/);
  const kirin = matchTitle('[Arknights] Kirin X Yato Skill 3 Showcase', index);
  assert.deepEqual(names(kirin.candidates), ['Yato', 'Kirin R Yato']);
  // A Chinese name two records share settles on neither.
  assert.deepEqual(names(matchTitle('阿米娅 展示', index).candidates), ['Amiya (Guard)', 'Amiya (Medic)', 'Amiya']);
});

test('only a title naming exactly one operator that reads as a guide is added; every other one naming an operator is suggested', () => {
  const dragon = creator();
  const verdict = title => classifyUpload({ videoId: 'aaaaaaaaaaa', title }, dragon, index);
  assert.equal(verdict('Operator Hindsight: Zima the Raging Tide Analysis').record.name, 'Zima the Raging Tide');
  assert.equal(verdict('Operator Hindsight: Zima the Raging Tide Analysis').preferred, true);
  assert.equal(verdict('How to Use Texas The Omertosa | Operator Showcase').record.name, 'Texas the Omertosa');
  assert.equal(verdict('Should You Get and Build Bellone? | Arknights Bellone Review').record.name, 'Bellone');
  for (const [title, reason] of [
    ['SILVERASH ALTER & LEMUEN GUIDE & REVIEW BUT REALLY FAST', /several operators/],
    ['IN-DEPTH Angelina Alter & Thumpy Early Review & Analysis', /several operators/],
    ['Chiave Siracusa Guide - Stronghold Protocol Alliance Part II', /names Stronghold Protocol.*, a game event or mode/],
    ['H12-4 Low Rarity Clear with Thumpy', /another kind of video/],
    ['Arknights Tier List: is Ray still good? Guide', /another kind of video/],
    ['Wang is a Game Design MASTERPIECE', /does not read as a guide/],
    ['Should You Save for Ch\'en Alter?', /could be/],
  ]) {
    const result = verdict(title);
    assert.equal(result.action, 'review', title);
    assert.match(result.reason, reason, title);
  }
  assert.equal(verdict('Module Review Update VOL.23 - People, A People').action, 'ignore', 'no operator named');
  assert.equal(verdict('Operator Hindsight: Wang Analysis #shorts').action, 'ignore');
  assert.equal(verdict('LIVE: Wang guide stream').action, 'ignore');
  assert.equal(classifyUpload({ videoId: 'aaaaaaaaaaa', title: 'Operator Hindsight: Wang Analysis', short: true }, dragon, index).action, 'ignore');
  // A creator's own series format makes a title a guide that the common words do not.
  const series = creator({ titlePatterns: ['^\\[Arknights\\] § \\d+lv S1, ?S2'] });
  assert.equal(classifyUpload({ videoId: 'aaaaaaaaaaa', title: '[Arknights] Bellone 90lv S1, S2, S3 lv7' }, series, index).record.name, 'Bellone');
  assert.equal(classifyUpload({ videoId: 'aaaaaaaaaaa', title: '[Arknights] Bellone 90lv S1, S2, S3 lv7' }, creator({ titlePatterns: [] }), index).action, 'review');
});

test('guides are appended after a record\'s own, once per creator, and a video already in any record is skipped', () => {
  const list = records();
  const local = guideIndex(list);
  const present = new Set(list.flatMap(record => record.guides.map(guide => guide.videoId)));
  const before = structuredClone(list.find(record => record.name === 'Bellone').guides);
  const pending = [];
  const uploads = [
    { videoId: 'bbbbbbbbbb2', title: 'Operator Hindsight: Bellone Analysis (updated)' },
    { videoId: 'bbbbbbbbbb1', title: 'Bellone Skill 3 Showcase' },
    { videoId: 'mNy4Pu9EHTY', title: 'Operator Hindsight: Wang Analysis' },
    { videoId: 'cccccccccc1', title: 'Operator Hindsight: Titi Analysis' },
  ];
  const result = applyUploads({ creator: creator(), uploads, index: local, present, pending, today: '2026-10-15' });
  const bellone = list.find(record => record.name === 'Bellone');
  assert.deepEqual(bellone.guides, [...before, { videoId: 'bbbbbbbbbb2', creator: 'DragonGJY' }], 'the series video, after the record\'s own');
  assert.deepEqual(result.added.map(entry => entry.videoId), ['bbbbbbbbbb2']);
  assert.deepEqual(pending.map(entry => [entry.videoId, entry.reason]), [
    ['bbbbbbbbbb1', 'DragonGJY has another guide to Bellone'],
    ['cccccccccc1', 'Titi already has a guide by DragonGJY'],
  ]);
  assert.equal(list.find(record => record.name === 'Wang').guides.filter(guide => guide.videoId === 'mNy4Pu9EHTY').length, 1, 'already present: untouched');
  // Again: nothing new, nothing suggested twice.
  const again = applyUploads({ creator: creator(), uploads, index: local, present, pending, today: '2026-10-16' });
  assert.deepEqual([again.added, again.suggested], [[], []]);
  // A whole channel's history suggests only what reads as a guide.
  const backfill = applyUploads({ creator: creator(), index: local, present, pending: [], today: '2026-10-15', backfill: true,
    uploads: [{ videoId: 'ddddddddddd', title: 'Bellone and Lemuen guide' }, { videoId: 'eeeeeeeeeee', title: 'Ray outfit preview' }] });
  assert.deepEqual(backfill.suggested.map(entry => entry.videoId), ['ddddddddddd']);
});

test('the marker moves only when it has sunk down the feed, and a suggestion leaves the list when it is dealt with', () => {
  const feed = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(letter => ({ videoId: letter.repeat(11) }));
  assert.equal(nextMarker(undefined, feed), 'aaaaaaaaaaa');
  assert.equal(nextMarker('ccccccccccc', feed), 'ccccccccccc');
  assert.equal(nextMarker('fffffffffff', feed), 'aaaaaaaaaaa');
  assert.equal(nextMarker('zzzzzzzzzzz', feed), 'aaaaaaaaaaa');
  const entry = (videoId, firstSeen) => ({ videoId, creator: 'DragonGJY', title: 't', operators: ['Ray'], reason: 'r', firstSeen });
  const old = new Date(Date.parse('2026-10-15T00:00:00Z') - REVIEW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const kept = prunePending([entry('aaaaaaaaaaa', '2026-10-15'), entry('bbbbbbbbbbb', '2026-10-15'), entry('ccccccccccc', '2026-10-15'), entry('ddddddddddd', old)],
    { present: new Set(['aaaaaaaaaaa']), dismissed: new Set(['bbbbbbbbbbb']), today: '2026-10-15' });
  assert.deepEqual(kept.map(item => item.videoId), ['ccccccccccc']);
});

test('the feed and the listing are read the same way: newest first, Shorts marked', () => {
  const entries = parseFeedEntries(FEED);
  assert.equal(entries.length, 15);
  assert.deepEqual(entries[0], { videoId: 'HGKEVgGLgUw', title: "Operator Hindsight: Kal'tsit Esperanta Analysis", published: '2026-10-14T00:00:00+00:00', short: false });
  assert.equal(entries[1].short, true);
  assert.deepEqual(parseFeed(FEED)[0], { videoId: 'HGKEVgGLgUw', title: "Operator Hindsight: Kal'tsit Esperanta Analysis" }, 'the album stage\'s reader is unchanged');
  const listing = parseListing(LISTING, CHANNEL);
  assert.equal(listing.length, 214);
  assert.deepEqual(listing.slice(0, 14).map(upload => upload.videoId), entries.filter(upload => !upload.short).map(upload => upload.videoId));
  assert.throws(() => parseListing(LISTING, 'UCIWl-xJkLO6bDejpL8FVHcA'), /listing is of channel/);
});

/** No channel read yet: what a state file holds before the first creator is backfilled. */
const EMPTY_STATE = { version: 1, creators: {}, pending: [] };
/**
 * A content tree with the fixture records, the event and mode names and a registry, and sources
 * that count their calls. `state: null` leaves the state file out.
 */
function tree({ registry = { version: 1, creators: [DRAGON] }, state = EMPTY_STATE, contentNames = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-guide-videos-'));
  for (const record of RECORDS) {
    const file = path.join(root, `data/operators-${record.rarity}star/${record.name}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  }
  if (registry) fs.writeFileSync(path.join(root, 'data/guide-creators.json'), `${JSON.stringify(registry, null, 2)}\n`);
  if (state) fs.writeFileSync(path.join(root, 'data/guide-videos-state.json'), `${JSON.stringify(state, null, 2)}\n`);
  if (contentNames) fs.writeFileSync(path.join(root, 'data/stages-content.json'), `${JSON.stringify(STAGES_CONTENT)}\n`);
  return root;
}
/** A state as a run leaves it: every video in the fixture records' guides and on its pending list decided. */
const settled = state => ({ ...state, decided: [...new Set([...RECORDS.flatMap(record => record.guides.map(guide => guide.videoId)), ...state.pending.map(entry => entry.videoId)])].sort() });
const readState = root => JSON.parse(fs.readFileSync(path.join(root, 'data/guide-videos-state.json'), 'utf8'));
const writeRecord = (root, record) => fs.writeFileSync(path.join(root, `data/operators-${record.rarity}star/${record.name}.json`), `${JSON.stringify(record, null, 2)}\n`);
const read = (root, name) => JSON.parse(fs.readFileSync(path.join(root, `data/operators-${RECORDS.find(record => record.name === name).rarity}star/${name}.json`), 'utf8'));
const snapshot = root => {
  const files = {};
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => (entry.isDirectory() ? walk(path.join(dir, entry.name))
    : (files[path.relative(root, path.join(dir, entry.name))] = fs.readFileSync(path.join(dir, entry.name), 'utf8'))));
  walk(path.join(root, 'data'));
  return files;
};
/**
 * Sources over the recorded listings. `feed(channelId)` gives the latest uploads, marked as the
 * feed's; one that throws stands for a feed that does not load, and the latest uploads are then
 * the head of the listing, as youtubeSources reads them.
 */
function sources({ feed = channelId => (channelId === CHANNEL ? parseFeedEntries(FEED) : null), listing = (limit, channelId) => parseListing(LISTINGS[channelId], channelId).slice(0, limit) } = {}) {
  const calls = [];
  return {
    calls,
    latest: async channelId => {
      calls.push(['latest', channelId]);
      let uploads = null;
      try { uploads = feed(channelId); } catch { uploads = null; }
      return uploads ? uploads.map(upload => ({ ...upload, feed: true })) : listing(30, channelId);
    },
    listing: async (channelId, { limit } = {}) => { calls.push(['listing', channelId, limit]); return listing(limit, channelId); },
  };
}
const noFeed = () => { throw new Error('HTTP 404'); };
const run = (root, given, now = '2026-10-15T20:00:00Z', options = {}) => syncGuideVideos(root, { now: new Date(now), sources: given, log: () => {}, pause: async () => {}, ...options });

test('without a registry the stage reads nothing and writes nothing', async () => {
  const root = tree({ registry: null, state: null });
  try {
    const before = snapshot(root);
    const given = sources();
    assert.deepEqual(await run(root, given), { skipped: true });
    assert.deepEqual(given.calls, []);
    assert.deepEqual(snapshot(root), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a new creator\'s whole history is read once, then only the latest uploads, and a second run changes nothing', async () => {
  const root = tree();
  try {
    const first = sources();
    const result = await run(root, first);
    assert.deepEqual(first.calls, [['listing', CHANNEL, 6000]]);
    // The recorded history adds the Hindsight analyses the records lack, after their own guides.
    assert.ok(result.added.some(entry => entry.operator === 'Zima the Raging Tide' && entry.videoId === 'lAqKn3QimNI'));
    assert.ok(result.added.some(entry => entry.operator === 'Bellone' && entry.videoId === 'WL5Mp78tfOE'));
    assert.deepEqual(read(root, 'Zima the Raging Tide').guides.at(-1), { videoId: 'lAqKn3QimNI', creator: 'DragonGJY' });
    assert.deepEqual(read(root, 'Zima the Raging Tide').guides.slice(0, 2), RECORDS.find(record => record.name === 'Zima the Raging Tide').guides);
    assert.equal(read(root, "Kal'tsit - Esperanta").guides.filter(guide => guide.videoId === 'HGKEVgGLgUw').length, 1);
    assert.ok(!result.added.some(entry => entry.videoId === 'S5m6sXaH0V8'), 'the Stronghold guide naming Chiave is not added');
    const state = JSON.parse(fs.readFileSync(path.join(root, 'data/guide-videos-state.json'), 'utf8'));
    assert.deepEqual(state.creators, { [CHANNEL]: { backfilledAt: '2026-10-15', newest: 'HGKEVgGLgUw' } });
    assert.ok(state.pending.some(entry => entry.videoId === 'S5m6sXaH0V8' && entry.operators.includes('Chiave')));
    // The next night: the feed only, nothing new, not one byte written.
    const after = snapshot(root);
    const second = sources();
    const again = await run(root, second, '2026-10-16T20:00:00Z');
    assert.deepEqual(second.calls, [['latest', CHANNEL]]);
    assert.deepEqual(again.added, []);
    assert.deepEqual(snapshot(root), after);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a channel that cannot be read changes nothing and is held for the daily issue', async () => {
  const state = settled({ version: 1, creators: { [CHANNEL]: { backfilledAt: '2026-10-01', newest: 'pfEfIu0ofZY' } }, pending: [] });
  const root = tree({ state });
  try {
    const before = snapshot(root);
    const failing = sources({ feed: noFeed, listing: () => { throw new Error('yt-dlp failed (1)'); } });
    const result = await run(root, failing);
    assert.deepEqual(result.added, []);
    const quarantine = readQuarantine(root);
    assert.deepEqual(quarantine.entries.map(entry => [entry.key, entry.stage, entry.action]), [[`guide-channel:${CHANNEL}`, 'guide-videos', 'kept-previous']]);
    assert.doesNotMatch(quarantine.entries[0].reason, /404|yt-dlp failed/, 'the reason names no error text that changes by itself');
    const after = snapshot(root);
    delete after['data/quarantine.json'];
    assert.deepEqual(after, before);
    // Read again the next night, it clears.
    await run(root, sources(), '2026-10-16T20:00:00Z');
    assert.deepEqual(readQuarantine(root).entries, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('when the latest uploads no longer reach the marker, the listing is read back to it, not the whole channel', async () => {
  // The last good run handled the 20th upload; since then 19 more, more than the feed's 15.
  const marker = LISTING.entries[19].id;
  const state = { version: 1, creators: { [CHANNEL]: { backfilledAt: '2026-10-01', newest: marker } }, pending: [] };
  const root = tree({ state });
  // As if DragonGJY's Nasti and Pramanix the Prerita analyses had come out while no run read the channel.
  for (const name of ['Nasti', 'Pramanix the Prerita']) {
    const record = read(root, name);
    record.guides = record.guides.filter(guide => guide.creator !== 'DragonGJY');
    fs.writeFileSync(path.join(root, `data/operators-${record.rarity}star/${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }
  try {
    const given = sources();
    const result = await run(root, given);
    assert.deepEqual(given.calls, [['latest', CHANNEL], ['listing', CHANNEL, 300]]);
    // The feed reaches back to the 14th upload; the Nasti and Pramanix the Prerita analyses (16th and
    // 17th) are older than that and newer than the marker, and the Mantra one is the marker itself.
    const added = result.added.map(entry => entry.videoId);
    assert.ok(added.includes('LQY2_lo_0zw') && added.includes('6oI1KIxSgFA'), 'uploads older than the feed but newer than the marker are read');
    assert.ok(!LISTING.entries.slice(19).some(entry => added.includes(entry.id)), 'nothing from the marker back');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/guide-videos-state.json'), 'utf8')).creators[CHANNEL].newest, 'HGKEVgGLgUw');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the suggestions issue: the same list is the same body, untrusted titles render inert, and an empty list clears', () => {
  const pending = [{ videoId: 'S5m6sXaH0V8', creator: 'DragonGJY', title: 'Chiave [Guide](https://evil.example) @someone #12 <!-- arkpedia-alert:x -->', operators: ['Chiave'], reason: 'reads as another kind of video', firstSeen: '2026-10-15' }];
  const first = renderSuggestions(pending, { today: '2026-10-15' });
  const later = renderSuggestions(pending, { today: '2026-10-20' });
  assert.equal(first.state, 'alert');
  assert.equal(first.body, later.body, 'no date or age in the body: an unchanged list edits nothing');
  assert.match(first.body, /^<!-- arkpedia-alert-digest:[0-9a-f]{16} -->/);
  assert.match(first.body, /\(https:\/\/www\.youtube\.com\/watch\?v=S5m6sXaH0V8\)/);
  assert.doesNotMatch(first.body, /\]\(https:\/\/evil|@someone|<!-- arkpedia-alert:x/);
  assert.match(first.comment, /1 new suggestion/);
  assert.notEqual(renderSuggestions([{ ...pending[0], operators: ['Ray'] }]).body, first.body);
  assert.deepEqual(renderSuggestions([]), { state: 'clear' });
});

test('the report reads the tree\'s state, less what has been added or dismissed since', () => {
  const pending = [
    { videoId: 'S5m6sXaH0V8', creator: 'DragonGJY', title: 'Chiave Siracusa Guide', operators: ['Chiave'], reason: 'r', firstSeen: '2026-10-15' },
    { videoId: 'mNy4Pu9EHTY', creator: 'DragonGJY', title: 'Wang', operators: ['Wang'], reason: 'r', firstSeen: '2026-10-15' },
  ];
  const root = tree({ state: { version: 1, creators: {}, pending } });
  const out = path.join(root, 'report');
  try {
    assert.equal(writeSuggestionsReport(root, out, { now: new Date('2026-10-15T21:00:00Z') }), 'alert');
    const body = fs.readFileSync(path.join(out, 'body.md'), 'utf8');
    assert.match(body, /\*\*1 suggestion\(s\)\*\*/);
    assert.doesNotMatch(body, /mNy4Pu9EHTY/, 'already in Wang\'s guides');
    fs.writeFileSync(path.join(root, 'data/guide-creators.json'), JSON.stringify({ version: 1, creators: [DRAGON], dismissed: ['S5m6sXaH0V8'] }));
    assert.equal(writeSuggestionsReport(root, out, { now: new Date('2026-10-15T21:00:00Z') }), 'clear');
    fs.rmSync(path.join(root, 'data/guide-videos-state.json'));
    assert.equal(writeSuggestionsReport(root, out), 'nodata');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ---- Review fixes, 2026-10-15: each test below fails without its fix. ---- */

test('event, Integrated Strategies and mode names are taken out of a title: they never name the operator inside them', () => {
  // The names as the release holds them, cleaned of the wiki's marks.
  const cleaned = gameContentNames({
    stagesContent: { a: { kind: 'event', name: "Dorothy's Vision - Retrospection" }, b: { kind: 'event', name: 'Ideal City: Endless Carnival' }, c: { kind: 'annihilation', name: 'Victoria' },
      d: { kind: 'event', name: "April Fools' Day Event 2026" }, e: { kind: 'supply', name: 'Tough Siege' } },
    eventRewards: { events: { '[Side Story] Maria Nearl': {}, "[Rerun] Grani and the Knights' Treasure Rerun": {} } },
    eventStores: { events: { '[Story Collection] Rewinding Breeze': {} } },
  });
  for (const name of ["Dorothy's Vision", 'Ideal City', 'Ideal City: Endless Carnival', "April Fools' Day Event", 'Maria Nearl', "Grani and the Knights' Treasure", 'Rewinding Breeze']) assert.ok(cleaned.includes(name), name);
  assert.ok(!cleaned.includes('Victoria') && !cleaned.includes('Tough Siege'), 'not the nations of the annihilation maps, nor the supply stages');
  assert.ok(MODES.includes('Mizuki & Caerula Arbor') && MODES.includes('Phantom & Crimson Solitaire') && MODES.includes('The Great Chief Returns'));
  const verdict = (title, who = creator()) => classifyUpload({ videoId: 'aaaaaaaaaaa', title }, who, index);
  // The three titles a person caught by eye in the backfill, as their creators titled them.
  assert.equal(verdict("Arknights: An Analysis on Magic Theorem - Dorothy's Vision", creator({ name: 'Fizzyon', titlePatterns: [] })).action, 'ignore');
  assert.equal(verdict('Arknights || So you think Tomimi is bad? (Welfare Operators Showcase in MN-EX 8 CM)', creator(KUKKI)).action, 'review');
  assert.equal(verdict('THE AMIYA SHOWCASE: PART 1 | 50k Sub Special', creator({ ...YII, titlePatterns: [] })).action, 'review');
  // Event and mode guides by these creators: about the event, so no operator's guide.
  for (const title of ['Maria Nearl Guide', 'Mizuki & Caerula Arbor Beginner Guide', 'Mizuki and Caerula Arbor Beginner Guide', 'Arknights Phantom & Crimson Solitaire Guide',
    "Grani and the Knights' Treasure Guide", 'Rewinding Breeze Guide', "Ceobe's Fungimist Guide", "Magic Theorem - Dorothy's Vision Analysis", 'MN-EX-8 EASY GUIDE | Arknights Maria Nearl']) {
    const result = verdict(title);
    assert.equal(result.action, 'ignore', title);
    assert.match(result.reason, /names no operator outside/, title);
  }
  // An operator named next to an event: a person decides.
  const gavial = verdict('Gavial the Great Chief Returns Guide');
  assert.deepEqual([gavial.action, names(gavial.records)], ['review', ['Gavial']]);
  assert.match(gavial.reason, /names The Great Chief Returns, a game event or mode/);
  assert.equal(verdict('Nearl the Radiant Knight Guide | Maria Nearl Rerun').action, 'review');
  // A name the event only has a part of is untouched: Vina Victoria, Nearl.
  assert.equal(verdict('Operator Hindsight: Nearl Analysis').record.name, 'Nearl');
  assert.deepEqual(matched('SIEGE ALTER GUIDE & REVIEW BUT REALLY FAST (VINA VICTORIA)'), ['Vina Victoria']);
});

test('stage codes with a space, Challenge Mode, several operators, a channel special and a part of a series are another kind of video', () => {
  const verdict = title => classifyUpload({ videoId: 'aaaaaaaaaaa', title }, creator(), index);
  for (const title of ['Silence Showcase in MN-EX 8 CM', 'Silence Showcase in CW EX 8', 'Silence Showcase H8 4', 'Silence Showcase CM', 'Silence and the welfare operators: a review',
    'Silence Showcase | 100k Subscriber Special', 'Silence Guide Part 2']) {
    const result = verdict(title);
    assert.equal(result.action, 'review', title);
    assert.match(result.reason, /another kind of video/, title);
  }
  // A skill, elite or module level and a number is not a stage code.
  for (const title of ['Silence E2 90 Showcase', 'Silence S3 10 Hits Showcase', 'Silence M3 Showcase']) assert.equal(verdict(title).action, 'add', title);
});

test('an operator name that is an ordinary word (May, April, Ray) is a name only when capitalised, and a person decides', () => {
  const verdict = (title, who = creator()) => classifyUpload({ videoId: 'aaaaaaaaaaa', title }, who, index);
  assert.equal(verdict('You may need this guide').action, 'ignore', 'lower case: the word, not the operator');
  assert.equal(verdict('how to use ray tracing on arknights, a guide').action, 'ignore');
  for (const [title, operator] of [['What to Build in May | Arknights Beginner Guide', 'May'], ['Arknights May Roadmap Overview', 'May'], ['Arknights Global May Review', 'May'],
    ['How to use Ray tracing on Arknights', 'Ray'], ['[Arknights] Operator Profile: April', 'April'], ['Operator Hindsight: Ray Analysis', 'Ray']]) {
    const result = verdict(title);
    assert.deepEqual([result.action, names(result.records)], ['review', [operator]], title);
    assert.match(result.reason, /ordinary word/, title);
  }
  // Even in the creator's own series format: "How to Use §" also reads "How to Use Ray tracing".
  assert.equal(verdict('How to Use Ray tracing on Arknights', creator(KUKKI)).action, 'review');
  // 医生 is "doctor", Doc's Chinese name; 四月 is the month April.
  assert.equal(verdict('医生 Showcase').action, 'review');
  assert.equal(verdict('四月 Showcase').action, 'review');
  // Named another way too, the operator is matched as before.
  assert.deepEqual(matched('Ray and SilverAsh'), ['Ray', 'SilverAsh']);
});

test('Chinese mode words make a title another kind of video', () => {
  const verdict = title => classifyUpload({ videoId: 'aaaaaaaaaaa', title }, creator(), index);
  for (const title of ['[Arknights] 银灰 Showcase 危机合约#12', '【明日方舟】集成战略 傀影 Showcase', '银灰 Showcase 剿灭', '银灰 皮肤 Showcase', '银灰 模组 Review', '银灰 低配 Showcase']) {
    assert.equal(verdict(title).action, 'review', title);
  }
  assert.equal(verdict('银灰 Showcase').action, 'add');
});

test('a creator\'s aliases count as the creator: a record with a guide under one gets no second', () => {
  const list = records();
  const whaleyyy = { name: 'Whaleyyy', channelId: 'UCaU5Q5gOpgucuwrCkWyrhMQ' };
  const present = new Set(list.flatMap(record => record.guides.map(guide => guide.videoId)));
  const upload = [{ videoId: 'wwwwwwwwww1', title: 'Should you build Eunectes? | Eunectes Guide' }];
  const withAlias = applyUploads({ creator: creator({ ...whaleyyy, titlePatterns: [], aliases: ['whaleyyy337'] }), uploads: upload, index: guideIndex(list, { modes: MODES }), present, pending: [], today: '2026-10-15' });
  assert.deepEqual(withAlias.added, []);
  assert.match(withAlias.suggested[0].reason, /Eunectes already has a guide by Whaleyyy/);
  const withHandle = applyUploads({ creator: creator({ ...whaleyyy, titlePatterns: [], handle: '@whaleyyy337' }), uploads: upload, index: guideIndex(records(), { modes: MODES }), present: new Set(present), pending: [], today: '2026-10-15' });
  assert.deepEqual(withHandle.added, [], 'the published registry already holds this verified handle, even before aliases are edited');
  assert.match(withHandle.suggested[0].reason, /Eunectes already has a guide by Whaleyyy/);
  const without = applyUploads({ creator: creator({ ...whaleyyy, titlePatterns: [] }), uploads: upload, index: guideIndex(records(), { modes: MODES }), present: new Set(present), pending: [], today: '2026-10-15' });
  assert.deepEqual(without.added.map(entry => entry.operator), ['Eunectes'], 'without the alias it would be a second guide by the same channel');
});

test('with a registry but no state file, no channel is read: every creator is held, nothing is written', async () => {
  const root = tree({ state: null, registry: { version: 1, creators: [DRAGON, FROST] } });
  try {
    const before = snapshot(root);
    const given = sources();
    const result = await run(root, given);
    assert.deepEqual(given.calls, [], 'no listing, no feed: a lost state file never starts the backfill again');
    assert.deepEqual(result.added, []);
    const quarantine = readQuarantine(root);
    assert.deepEqual(quarantine.entries.map(entry => entry.key).sort(), [`guide-channel:${CHANNEL}`, `guide-channel:${FROST.channelId}`]);
    assert.match(quarantine.entries[0].reason, /no data\/guide-videos-state\.json/);
    const after = snapshot(root);
    delete after['data/quarantine.json'];
    assert.deepEqual(after, before);
    // Only a run that says so starts from nothing.
    const first = sources();
    await run(root, first, '2026-10-15T20:00:00Z', { firstBackfill: true });
    assert.deepEqual(first.calls.map(call => call[0]), ['listing', 'listing']);
    assert.equal(Object.keys(readState(root).creators).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('without the release\'s event and mode names, no channel is read', async () => {
  const root = tree({ contentNames: false });
  try {
    const given = sources();
    await run(root, given);
    assert.deepEqual(given.calls, []);
    assert.match(readQuarantine(root).entries[0].reason, /event and mode names/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a suggestion that dropped off the list after 45 days does not come back: Yii\'s Amiya special', async () => {
  // As the backfill left it: Yii read, the special moved from Amiya's guides to the list by hand,
  // and no decided list yet (the file the backfill wrote has none).
  const special = { videoId: '1nCzXGNRUO4', creator: 'Yii', title: 'THE AMIYA SHOWCASE: PART 1 | 50k Sub Special', operators: ['Amiya'], reason: 'a channel special, not a guide (moved to review by hand)', firstSeen: '2026-10-15' };
  const state = { version: 1, creators: { [YII.channelId]: { backfilledAt: '2026-10-15', newest: 'SBgXfS5gOP8' } }, pending: [special] };
  const root = tree({ registry: { version: 1, creators: [YII] }, state });
  try {
    // 2026-12-01: past its 45 days, the special drops off the list; the feed fails, so the
    // listing's first 30 uploads are read, and the special is the 26th.
    const first = await run(root, sources({ feed: noFeed }), '2026-12-01T20:00:00Z');
    assert.ok(!first.pending.some(entry => entry.videoId === '1nCzXGNRUO4'), 'pruned from the list');
    assert.ok(readState(root).decided.includes('1nCzXGNRUO4'), 'and kept as decided');
    // 2026-12-02: read again, it is neither added nor suggested.
    const second = await run(root, sources({ feed: noFeed }), '2026-12-02T20:00:00Z');
    assert.deepEqual([second.added, second.suggested], [[], []]);
    assert.ok(!read(root, 'Amiya').guides.some(guide => guide.videoId === '1nCzXGNRUO4'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a guide a person took out of a record is not put back: FrostByte262\'s Zima alter review', async () => {
  const root = tree({ registry: { version: 1, creators: [FROST] } });
  try {
    // The backfill (FrostByte262's first 30 uploads as the whole history) adds the review.
    const backfill = await run(root, sources());
    assert.ok(backfill.added.some(entry => entry.videoId === 'k1kON8aC12M' && entry.operator === 'Zima the Raging Tide'));
    // A person takes it out of the record.
    const zima = read(root, 'Zima the Raging Tide');
    zima.guides = zima.guides.filter(guide => guide.videoId !== 'k1kON8aC12M');
    writeRecord(root, zima);
    // The next night reads the listing's head again (the feed fails), with the review 6th in it.
    const next = await run(root, sources({ feed: noFeed }), '2026-10-16T20:00:00Z');
    assert.deepEqual([next.added, next.suggested], [[], []]);
    assert.ok(!read(root, 'Zima the Raging Tide').guides.some(guide => guide.videoId === 'k1kON8aC12M'));
    // And a guide a person added by hand is decided too: taken out later, it stays out.
    assert.ok(readState(root).decided.includes('l5gyZtHZRno'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('with the backfill\'s state file, which has no decided list, a guide taken out by hand before the first nightly is not put back', async () => {
  // FrostByte262 backfilled on 2026-10-15 (marker: the listing's newest), the Zima alter review
  // added, then taken out of the record by hand (the fixture records never had it), all before a
  // run that keeps a decided list.
  const state = { version: 1, creators: { [FROST.channelId]: { backfilledAt: '2026-10-15', newest: LISTINGS[FROST.channelId].entries[0].id } }, pending: [] };
  const root = tree({ registry: { version: 1, creators: [FROST] }, state });
  try {
    const night = await run(root, sources({ feed: noFeed }), '2026-10-16T20:00:00Z');
    assert.ok(!night.added.some(entry => entry.videoId === 'k1kON8aC12M'), 'below the marker: an earlier run read it');
    assert.ok(!read(root, 'Zima the Raging Tide').guides.some(guide => guide.videoId === 'k1kON8aC12M'));
    // A person decides: on the list, once, then decided.
    assert.match(night.suggested.find(entry => entry.videoId === 'k1kON8aC12M').reason, /an earlier run read it/);
    assert.ok(readState(root).decided.includes('k1kON8aC12M'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('uploads an earlier run decided on are not suggested again: the night after a backfill suggests nothing', async () => {
  const root = tree({ registry: { version: 1, creators: [SHARKY] } });
  try {
    const backfill = await run(root, sources());
    assert.ok(!backfill.suggested.some(entry => entry.title === 'Resisting the Urge to Pull for Tragodia'), 'no guide word: a whole history does not suggest it');
    // The listing's head again, all of it at or below the marker: what the backfill did not
    // suggest stays unsuggested.
    const next = await run(root, sources({ feed: noFeed }), '2026-10-16T20:00:00Z');
    assert.deepEqual(next.suggested, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a lost marker reads the listing as a backfill reads it: no flood of old videos', async () => {
  const root = tree();
  try {
    await run(root, sources());
    const backfilled = readState(root);
    // The marker is a video that was since deleted: not among the latest, nor in the listing.
    fs.writeFileSync(path.join(root, 'data/guide-videos-state.json'), `${JSON.stringify({ ...backfilled, creators: { [CHANNEL]: { ...backfilled.creators[CHANNEL], newest: 'zzzzzzzzzzz' } } }, null, 2)}\n`);
    const given = sources({ feed: noFeed });
    const result = await run(root, given, '2026-10-16T20:00:00Z');
    assert.deepEqual(given.calls, [['latest', CHANNEL], ['listing', CHANNEL, 300]]);
    assert.deepEqual([result.added, result.suggested], [[], []], 'every old upload naming an operator would otherwise be suggested');
    assert.equal(readState(root).creators[CHANNEL].newest, LISTING.entries[0].id, 'the marker moves to the newest upload');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the real feeds: Shorts are marked, and a stream the Videos tab does not list never becomes the marker', async () => {
  const frost = parseFeedEntries(fixture('frostbyte262-feed.xml'));
  assert.equal(frost.length, 15);
  assert.equal(frost.filter(upload => upload.short).length, 11);
  assert.deepEqual(frost[0], { videoId: '5ZlzxP7dWx0', title: 'Most expensive Arknights skin 🤔', published: '2026-10-13T04:26:53+00:00', short: true });
  // The feed's other uploads are the Videos tab's newest, in its order.
  assert.deepEqual(frost.filter(upload => !upload.short).map(upload => upload.videoId), LISTINGS[FROST.channelId].entries.slice(0, 4).map(entry => entry.id));
  // SharkyFerret's feed: twelve streams, three Videos-tab uploads (the 5th, 9th and 12th entries).
  const sharkyFeed = parseFeedEntries(fixture('sharkyferret-feed.xml'));
  const tab = new Set(LISTINGS[SHARKY.channelId].entries.map(entry => entry.id));
  assert.deepEqual(sharkyFeed.map((upload, at) => (tab.has(upload.videoId) ? at : -1)).filter(at => at !== -1), [4, 8, 11]);
  // The marker has sunk eight places down the feed, so it must move: to the newest upload of the
  // Videos tab, read for that, not to the stream at the top of the feed.
  const root = tree({ registry: { version: 1, creators: [SHARKY] }, state: settled({ version: 1, creators: { [SHARKY.channelId]: { backfilledAt: '2026-10-15', newest: 'FMHV_UaV3bM' } }, pending: [] }) });
  try {
    const night = sources({ feed: channelId => (channelId === SHARKY.channelId ? sharkyFeed : null) });
    await run(root, night);
    assert.deepEqual(night.calls, [['latest', SHARKY.channelId], ['listing', SHARKY.channelId, 30]]);
    assert.equal(readState(root).creators[SHARKY.channelId].newest, 'Njqwbzy79b8', 'not uuTzkapjRBs, a stream');
    // The next night the feed fails: the listing's head has the marker, so there is no long read.
    const next = sources({ feed: noFeed });
    await run(root, next, '2026-10-16T20:00:00Z');
    assert.deepEqual(next.calls, [['latest', SHARKY.channelId]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('each call to YouTube gets at most the time the stage has left, and a channel is not started without enough', async () => {
  let now = 0;
  const calls = [];
  const slow = {
    latest: async (channelId, { timeoutMs } = {}) => { calls.push(['latest', channelId, timeoutMs]); now += 40_000; return parseListing(LISTINGS[channelId], channelId).slice(0, 30); },
    listing: async (channelId, { limit, timeoutMs } = {}) => { calls.push(['listing', channelId, limit, timeoutMs]); now += 10_000; return parseListing(LISTINGS[channelId], channelId).slice(0, limit); },
  };
  // DragonGJY's marker is older than the listing's head: a gap read would be needed.
  const state = settled({ version: 1, creators: { [CHANNEL]: { backfilledAt: '2026-10-01', newest: LISTING.entries[40].id }, [FROST.channelId]: { backfilledAt: '2026-10-01', newest: LISTINGS[FROST.channelId].entries[0].id } }, pending: [] });
  const root = tree({ registry: { version: 1, creators: [DRAGON, FROST] }, state });
  try {
    // 2026-10-16 is day 20742 since 1970, an even one: DragonGJY's turn first.
    const result = await syncGuideVideos(root, { now: new Date('2026-10-16T20:00:00Z'), sources: slow, log: () => {}, pause: async () => {}, budgetMs: 60_000, clock: () => now });
    assert.deepEqual(calls, [['latest', CHANNEL, 60_000]], 'the whole budget at most, and no gap read with 20 s left');
    assert.equal(readState(root).creators[CHANNEL].newest, LISTING.entries[40].id, 'the marker stays for a run with the time to read back to it');
    assert.deepEqual(result.held.map(entry => entry.key), [`guide-channel:${FROST.channelId}`]);
    assert.match(result.held[0].reason, /ran out of time/);
    assert.ok(MIN_CALL_MS > 20_000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('yt-dlp is stopped when the time a call was given runs out, and the feed\'s fallback shares that time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-yt-dlp-'));
  const fake = path.join(dir, 'yt-dlp');
  fs.writeFileSync(fake, '#!/bin/sh\n[ "$1" = --version ] && { echo 2026.08.19; exit 0; }\nexec sleep 30\n', { mode: 0o755 });
  try {
    const youtube = youtubeSources({ ytdlp: fake, fetcher: async () => ({ ok: false, status: 404 }), log: () => {} });
    assert.equal(await youtube.version(), '2026.08.19');
    let started = Date.now();
    await assert.rejects(youtube.listing(CHANNEL, { limit: 30, timeoutMs: 300 }), /yt-dlp failed \(stopped after 300 ms\)/);
    assert.ok(Date.now() - started < 5000);
    started = Date.now();
    await assert.rejects(youtube.latest(CHANNEL, { timeoutMs: 2500 }), /yt-dlp failed/);
    assert.ok(Date.now() - started < 6000, 'the feed\'s two tries and the listing together within the time given');
    await assert.rejects(youtube.listing(CHANNEL, { timeoutMs: 0 }), /no time left/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the run starts from another creator each day, and logs which yt-dlp it lists channels with', async () => {
  const order = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  const day = n => new Date(Date.UTC(2026, 9, 15) + n * 86_400_000);
  const turns = [0, 1, 2, 3].map(n => readingOrder(order, day(n)).map(entry => entry.name).join(''));
  assert.equal(new Set(turns.slice(0, 3)).size, 3);
  assert.equal(turns[3], turns[0]);
  const root = tree({ state: settled({ version: 1, creators: { [CHANNEL]: { backfilledAt: '2026-10-01', newest: 'HGKEVgGLgUw' } }, pending: [] }) });
  try {
    const lines = [];
    await syncGuideVideos(root, { now: new Date('2026-10-16T20:00:00Z'), sources: { ...sources(), version: async () => '2026.08.19' }, log: line => lines.push(line), pause: async () => {} });
    assert.ok(lines.includes('yt-dlp 2026.08.19'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the dev channel\'s run reads no channel: dev compiles data main\'s records', async () => {
  const root = tree();
  try {
    const before = snapshot(root);
    const given = sources();
    assert.deepEqual(await run(root, given, '2026-10-15T20:00:00Z', { dataBranch: 'dev' }), { skipped: true });
    assert.deepEqual(given.calls, []);
    assert.deepEqual(snapshot(root), before);
    await run(root, given, '2026-10-15T20:00:00Z', { dataBranch: 'main' });
    assert.deepEqual(given.calls, [['listing', CHANNEL, 6000]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the import installs yt-dlp from a pinned requirements file Dependabot watches, and passes the channel to the stage', () => {
  const workflow = fs.readFileSync('../.github/workflows/import.yml', 'utf8');
  assert.match(workflow, /python -m pip install -r scripts\/content\/requirements\.txt/);
  assert.doesNotMatch(workflow, /pip install [^\n]*yt-dlp==/, 'one pin, in the requirements file');
  assert.match(fs.readFileSync('scripts/content/requirements.txt', 'utf8'), /^yt-dlp==\d{4}\.\d{1,2}\.\d{1,2}$/m);
  const dependabot = fs.readFileSync('../.github/dependabot.yml', 'utf8');
  assert.match(dependabot, /package-ecosystem: pip\n\s+directory: \/importer\/scripts\/content\n/);
  // The stage reads ARKPEDIA_DATA_BRANCH, which the channel step puts in every later step's environment.
  assert.match(workflow, /node scripts\/content\/channel\.mjs --branch main \| tee -a "\$GITHUB_ENV"/);
  assert.match(fs.readFileSync('scripts/sync/sync-guide-videos.mjs', 'utf8'), /dataBranch: process\.env\.ARKPEDIA_DATA_BRANCH \|\| null/);
});

test('the suggestions issue says to merge data main into editorial first, and how to take back an added guide', () => {
  const { body } = renderSuggestions([{ videoId: 'S5m6sXaH0V8', creator: 'DragonGJY', title: 'Chiave', operators: ['Chiave'], reason: 'r', firstSeen: '2026-10-15' }]);
  assert.match(body, /git fetch origin && git merge origin\/main/);
  assert.match(body, /taken back by removing it from the record/);
  const docs = fs.readFileSync('../docs/importer.md', 'utf8');
  assert.match(docs, /git fetch origin && git merge origin\/main/);
  assert.match(docs, /never adds or suggests a video it has decided on again/);
});

test('a listing with no usable upload is a failed read: a new creator\'s backfill is not marked done, and the channel is held', async () => {
  assert.throws(() => parseListing({ channel_id: CHANNEL, entries: [] }, CHANNEL), /no usable upload \(0 entries\)/);
  assert.throws(() => parseListing({ channel_id: CHANNEL, entries: [{ id: 'HGKEVgGLgUw', title: null }] }, CHANNEL), /no usable upload \(1 entries\)/);
  for (const title of ['', '   ']) assert.throws(() => parseListing({ entries: [{ id: 'HGKEVgGLgUw', title }] }, CHANNEL), /no usable upload/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-yt-dlp-'));
  try {
    for (const listing of [{ channel_id: CHANNEL, entries: [] }, { channel_id: CHANNEL, entries: [{ id: 'HGKEVgGLgUw', title: null }] }]) {
      // yt-dlp exits 0 with that listing, and the feed answers 404.
      const fake = path.join(dir, 'yt-dlp');
      fs.writeFileSync(fake, `#!/bin/sh\n[ "$1" = --version ] && { echo 2026.08.19; exit 0; }\necho '${JSON.stringify(listing)}'\n`, { mode: 0o755 });
      const youtube = youtubeSources({ ytdlp: fake, fetcher: async () => ({ ok: false, status: 404 }), log: () => {} });
      await assert.rejects(youtube.listing(CHANNEL, { limit: 6000 }), /no usable upload/);
      // A new creator: no backfilledAt. Held, its state as it was.
      const root = tree();
      try {
        const before = readState(root);
        const result = await syncGuideVideos(root, { now: new Date('2026-10-20T20:00:00Z'), sources: youtube, log: () => {}, pause: async () => {} });
        assert.deepEqual(result.read, []);
        assert.deepEqual(result.held.map(entry => entry.key), [`guide-channel:${CHANNEL}`]);
        assert.equal(readState(root).creators[CHANNEL], undefined, 'no backfilledAt: the history is read again once yt-dlp lists it');
        assert.deepEqual(readState(root).creators, before.creators);
        // A creator with a marker, the feed failing too: held, the marker as it was.
        const marked = tree({ state: settled({ version: 1, creators: { [CHANNEL]: { backfilledAt: '2026-10-01', newest: 'HGKEVgGLgUw' } }, pending: [] }) });
        try {
          const night = await syncGuideVideos(marked, { now: new Date('2026-10-20T20:00:00Z'), sources: youtube, log: () => {}, pause: async () => {} });
          assert.deepEqual(night.held.map(entry => entry.key), [`guide-channel:${CHANNEL}`]);
          assert.deepEqual(readState(marked).creators[CHANNEL], { backfilledAt: '2026-10-01', newest: 'HGKEVgGLgUw' });
        } finally { fs.rmSync(marked, { recursive: true, force: true }); }
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an event or theme written short or misspelt still reads as another kind of video', () => {
  const verdict = title => classifyUpload({ videoId: 'aaaaaaaaaaa', title }, creator({ titlePatterns: [] }), index);
  for (const title of ['Mizuki IS Beginner Guide', 'Mizuki Arbor Guide', 'Mizuki Roguelike Guide for New Players', 'Mizuki & Caerula Abor Guide', 'Phantom IS Guide',
    'Phantom & Crimson Solitare Beginner Guide', 'Grani Rerun Guide', 'Nearl Rerun Guide', 'Breeze Rerun Guide', 'Gavial Returns Guide']) {
    const result = verdict(title);
    assert.equal(result.action, 'review', title);
    assert.match(result.reason, /another kind of video/, title);
  }
  // "is" the word is not IS the mode, nor IS in capitals between capitals, nor a lower-case "returns".
  for (const title of ['Mizuki is a great guard: a guide', 'MIZUKI IS AMAZING!!! | Mizuki Showcase', 'IS SHE IMMORTAL?? - Arknights [Mizuki] Showcase', 'Mizuki Guide: the guard returns!']) {
    assert.equal(verdict(title).action, 'add', title);
  }
});

/* kukkikaze's real feed, with a stream recording the reviewer copied from its lGcn8pCenn0
 * ("Handling Selector Ticket Guide! | Arknights", which the Videos tab does not list) and
 * retitled as a guide to one operator: the feed gives it as an ordinary video. */
const KUKKI_FEED = fixture('kukkikaze-feed.xml');
const streamEntry = KUKKI_FEED.match(/<entry>(?:(?!<\/entry>)[\s\S])*?lGcn8pCenn0[\s\S]*?<\/entry>/)[0];
const STREAM = streamEntry.replaceAll('lGcn8pCenn0', 'STREAMVOD01').replace(/<title>[^<]*<\/title>/g, '<title>Handling Ela Guide! | Arknights</title>');
const kukkiFeed = ({ drop = [] } = {}) => parseFeedEntries(KUKKI_FEED.replace('<entry>', `${STREAM}\n <entry>`)).filter(upload => !drop.includes(upload.videoId));
const kukkiState = () => settled({ version: 1, creators: { [KUKKI.channelId]: { backfilledAt: '2026-10-15', newest: 'mrzwqHcvjOg' } }, pending: [] });

test('a stream recording the feed lists as an ordinary video is never added: the Videos tab\'s head is read, and it goes to a person', async () => {
  const feed = kukkiFeed();
  assert.deepEqual([feed[0].videoId, feed[0].short, feed[0].title], ['STREAMVOD01', false, 'Handling Ela Guide! | Arknights'], 'no Short link, no live flag');
  assert.equal(classifyUpload(feed[0], creator(KUKKI), index).action, 'add', 'by its title alone, a guide to Ela');
  const root = tree({ registry: { version: 1, creators: [KUKKI] }, state: kukkiState() });
  try {
    const night = sources({ feed: channelId => (channelId === KUKKI.channelId ? kukkiFeed() : null) });
    const result = await run(root, night, '2026-10-17T20:00:00Z');
    assert.deepEqual(night.calls, [['latest', KUKKI.channelId], ['listing', KUKKI.channelId, 30]]);
    assert.deepEqual(result.added, []);
    assert.ok(!read(root, 'Ela').guides.some(guide => guide.videoId === 'STREAMVOD01'), 'not on Ela\'s page, nor her selector\'s "How to use"');
    assert.match(result.suggested.find(entry => entry.videoId === 'STREAMVOD01').reason, /only the feed lists it, not the channel's Videos tab: likely a stream/);
    // The real streams that name an operator without reading as a guide are not suggested either.
    assert.ok(!result.suggested.some(entry => entry.videoId === 'q5ErpS-GPBY'), "1000 PULL REQUEST, ... KAL'TSIT ESPERANTA AND CLOSURE ARRIVES");
    assert.equal(readState(root).creators[KUKKI.channelId].newest, 'mrzwqHcvjOg', 'the marker stays on the Videos tab');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the head is read for a feed upload that would be added even when the marker stays, and an upload the tab has is added', async () => {
  // The four streams above the marker gone: the marker is second in the feed and stays.
  const drop = ['GXxrvlAnAew', '5yENw8W1EjI', 'q5ErpS-GPBY', 'CqasfzW5miI'];
  const root = tree({ registry: { version: 1, creators: [KUKKI] }, state: kukkiState() });
  try {
    const night = sources({ feed: channelId => (channelId === KUKKI.channelId ? kukkiFeed({ drop }) : null) });
    const result = await run(root, night, '2026-10-17T20:00:00Z');
    assert.deepEqual(night.calls, [['latest', KUKKI.channelId], ['listing', KUKKI.channelId, 30]], 'read because of the would-be guide');
    assert.deepEqual(result.added, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  // The same upload on the Videos tab too: a real upload, added.
  const real = tree({ registry: { version: 1, creators: [KUKKI] }, state: kukkiState() });
  try {
    const listing = (limit, channelId) => {
      const uploads = parseListing(LISTINGS[channelId], channelId).slice(0, limit);
      return channelId === KUKKI.channelId ? [{ videoId: 'STREAMVOD01', title: 'Handling Ela Guide! | Arknights', published: null, short: false, live: false }, ...uploads] : uploads;
    };
    const result = await run(real, sources({ feed: channelId => (channelId === KUKKI.channelId ? kukkiFeed({ drop }) : null), listing }), '2026-10-17T20:00:00Z');
    assert.deepEqual(result.added.map(entry => [entry.videoId, entry.operator]), [['STREAMVOD01', 'Ela']]);
  } finally { fs.rmSync(real, { recursive: true, force: true }); }
});

test('when the Videos tab\'s head cannot be read, no upload of the feed is added or decided on: it is read again the next night', async () => {
  const root = tree({ registry: { version: 1, creators: [KUKKI] }, state: kukkiState() });
  try {
    const failing = sources({ feed: channelId => (channelId === KUKKI.channelId ? kukkiFeed() : null), listing: () => { throw new Error('yt-dlp failed (1)'); } });
    const result = await run(root, failing, '2026-10-17T20:00:00Z');
    assert.deepEqual(result.added, []);
    assert.ok(!result.suggested.some(entry => entry.videoId === 'STREAMVOD01'));
    assert.ok(!readState(root).decided.includes('STREAMVOD01'), 'undecided');
    assert.equal(readState(root).creators[KUKKI.channelId].newest, 'mrzwqHcvjOg');
    // The next night the head loads: the stream goes to a person, as above.
    const next = await run(root, sources({ feed: channelId => (channelId === KUKKI.channelId ? kukkiFeed() : null) }), '2026-10-18T20:00:00Z');
    assert.match(next.suggested.find(entry => entry.videoId === 'STREAMVOD01').reason, /likely a stream/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('on a night the feed does not reach the marker, the gap read is the Videos tab: a stream from the feed is not added then either', async () => {
  const state = kukkiState();
  const root = tree({ registry: { version: 1, creators: [KUKKI] }, state: { ...state, creators: { [KUKKI.channelId]: { ...state.creators[KUKKI.channelId], newest: 'zzzzzzzzzzz' } } } });
  try {
    const night = sources({ feed: channelId => (channelId === KUKKI.channelId ? kukkiFeed() : null) });
    const result = await run(root, night, '2026-10-17T20:00:00Z');
    assert.deepEqual(night.calls, [['latest', KUKKI.channelId], ['listing', KUKKI.channelId, 300]]);
    assert.deepEqual(result.added, []);
    assert.match(result.suggested.find(entry => entry.videoId === 'STREAMVOD01').reason, /likely a stream/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('explicit past-stream metadata survives a duplicate feed entry without a live flag', async () => {
  for (const live of [{ live_status: 'was_live' }, { was_live: true }, { is_live: true }]) {
    const stream = parseListing({ entries: [{ id: 'STREAMVOD01', title: 'Handling Ela Guide! | Arknights', ...live }] }, KUKKI.channelId)[0];
    assert.equal(stream.live, true);
    const root = tree({ registry: { version: 1, creators: [KUKKI] }, state: kukkiState() });
    try {
      const listing = (limit, channelId) => [stream, ...parseListing(LISTINGS[channelId], channelId)].slice(0, limit);
      const result = await run(root, sources({ feed: () => kukkiFeed(), listing }), '2026-10-17T20:00:00Z');
      assert.ok(!result.added.some(entry => entry.videoId === 'STREAMVOD01'));
      assert.ok(!result.suggested.some(entry => entry.videoId === 'STREAMVOD01'), 'a known stream is ignored');
      assert.equal(readState(root).creators[KUKKI.channelId].newest, 'mrzwqHcvjOg');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
