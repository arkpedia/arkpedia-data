import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
// @ts-expect-error Node scripts are plain JavaScript.
import { CACHE, parseStores, storeCacheFile, storePage, syncEventStores } from '../sync/sync-event-stores.mjs';
// @ts-expect-error Node scripts are plain JavaScript.
import { eventTitle, eventWindow, isRerun } from '../lib/event-records.mjs';

/*
 * Event stores from arknights.wiki.gg (scripts/sync/sync-event-stores.mjs): a rerun's from its
 * /Rerun page, every listing kind the {{Event store cell}} template takes, and what the stage
 * does with a page it cannot use. The wiki is a stub fetcher here: nothing leaves the machine.
 */
test('an original run\'s store is on its page, a rerun\'s on its /Rerun page', () => {
  assert.equal(storePage('[Side Story – Festival] Invitation to Wine'), 'Invitation to Wine');
  assert.equal(storePage('[Rerun] Path of Life Rerun'), 'Path of Life/Rerun');
  assert.equal(storePage("[Rerun] The Masses' Travels Rerun"), "The Masses' Travels/Rerun");
  // A rerun by its suffix alone is a rerun too: the rewards build and this agree (event-records.mjs).
  assert.equal(storePage('Invitation to Wine Rerun'), 'Invitation to Wine/Rerun');
  assert.deepEqual(['[Rerun] Path of Life Rerun', 'Invitation to Wine Rerun', '[Side Story] Path of Life', 'Rerunner'].map(isRerun), [true, true, false, false]);
  assert.equal(eventTitle('[Side Story – Festival] Invitation to Wine'), 'Invitation to Wine');
  // The cache file keeps wikiCacheFile's rule: '/' as '-'.
  assert.equal(path.basename(storeCacheFile('/r', 'Path of Life/Rerun')), 'Path of Life-Rerun.json');
});

test('an event\'s window, in milliseconds, from its exact instants or else the region\'s days', () => {
  // A Global date is a UTC-7 day, a CN date a UTC+8 one; a startAt or endAt is taken as it is.
  // A dateRange ends at the reset (04:00 server time) on its last date, not when that day starts.
  assert.deepEqual(eventWindow({ global: { dateRange: '2022/07/29–2022/08/12' } }, 'Global'), { start: Date.UTC(2022, 6, 29, 7), end: Date.UTC(2022, 7, 12, 11) });
  assert.deepEqual(eventWindow({ cn: { dateRange: '2026/09/04–2026/09/18', startAt: '2026-09-04T12:00:00+08:00', endAt: '2026-09-18T04:00:00+08:00' } }, 'CN'),
    { start: Date.parse('2026-09-04T04:00:00Z'), end: Date.parse('2026-09-17T20:00:00Z') });
  // The same end with or without the exact instant (both records' endAt, data/events, 2026-10-05).
  assert.equal(eventWindow({ cn: { dateRange: '2026/09/04–2026/09/18' } }, 'CN')!.end, Date.parse('2026-09-18T04:00:00+08:00'));
  assert.equal(eventWindow({ global: { dateRange: '2026/09/16–2026/09/30' } }, 'Global')!.end, Date.parse('2026-09-30T11:00:00.000Z'));
  assert.deepEqual(eventWindow({ cn: { dateRange: '2026/09/04' } }, 'CN'), { start: Date.UTC(2026, 8, 3, 16), end: Date.UTC(2026, 8, 4, 20) });
  assert.equal(eventWindow({ global: { dateRange: 'TBA' } }, 'Global'), null);
  assert.throws(() => eventWindow({}, 'TW'), /region/);
});

test('a store\'s listings, as the template writes them (Path of Life Rerun)', () => {
  const wikitext = [
    '==="Emergency Supplies" Blueprint Chip===',
    '===[[Materianomicon Moderatrix]]===',
    '{{Event store head}}',
    "{{Event store cell|item=Underflow's Token,1|price=Emergency Supplies Blueprint Chip,200|stock=1}}",
    '{{Event store cell|item=Headhunting Permit,1|price=Emergency Supplies Blueprint Chip,150|stock=3}}',
    '{{Event store cell|furniture=Stable Surgical Gimbal|cert=155|price=Emergency Supplies Blueprint Chip,90|stock=1}}',
    '{{Event store cell|outfit=Unseen Terrain|price=Emergency Supplies Blueprint Chip,2000|stock=1}}',
    '{{Event store cell|item=LMD,1,000|price=Emergency Supplies Blueprint Chip,10|stock=∞}}',
    // Any kind takes a quantity; a name's own comma is not one ("Healing Hand, Evil Heart").
    '{{Event store cell|furniture=Prison Chair with Handcuffs,2|price=Emergency Supplies Blueprint Chip,60|stock=1}}',
    '{{Event store cell|outfit=Healing Hand, Evil Heart|price=Emergency Supplies Blueprint Chip,2000|stock=1}}',
    '{{Event store end}}',
  ].join('\n');
  const [store] = parseStores(wikitext);
  assert.equal(store.name, 'Materianomicon Moderatrix');
  assert.equal(store.currency, 'Emergency Supplies Blueprint Chip');
  assert.deepEqual(store.items.map((i: { name: string; type: string; quantity: number; price: number; stock: string }) => [i.name, i.type, i.quantity, i.price, i.stock]), [
    ["Underflow's Token", 'material', 1, 200, '1'],
    ['Headhunting Permit', 'material', 1, 150, '3'],
    ['Stable Surgical Gimbal', 'furniture', 1, 90, '1'],
    ['Unseen Terrain', 'skin', 1, 2000, '1'],
    ['LMD', 'material', 1000, 10, 'unlimited'],
    ['Prison Chair with Handcuffs', 'furniture', 2, 60, '1'],
    ['Healing Hand, Evil Heart', 'skin', 1, 2000, '1'],
  ]);
  assert.equal(store.items[2].ambience, 155);
  assert.deepEqual(parseStores('no store here'), []);
});

/* A refresh's world: four events around 2026-10-05, the wiki as a table of answers by page, and
   what the stage was told. */
const NOW = Date.parse('2026-10-05T12:00:00Z');
const events = [
  { name: '[Side Story] Past Story', global: { dateRange: '2025/01/01–2025/01/15' } },
  { name: '[Side Story] Running Story', global: { dateRange: '2026/10/01–2026/10/15' } },
  { name: '[Side Story] Pageless Past', global: { dateRange: '2025/02/01–2025/02/15' } },
  { name: '[Rerun] Running Story Rerun', global: { dateRange: '2026/10/01–2026/10/15' } },
];
const storeText = (item: string) => `===Store===\n{{Event store cell|item=${item},1|price=Token,10|stock=1}}`;
const page = (title: string, text: string) => ({ parse: { title, wikitext: { '*': text } } });
type Answer = object | Error;
function world(answers: Record<string, Answer>, records: object[] = events) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-event-stores-'));
  fs.mkdirSync(path.join(root, 'data/events'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/events/events_2026.json'), JSON.stringify(records));
  const asked: string[] = [];
  const reports: [string, { page: string; problem: string; kept: boolean }][] = [];
  const fetcher = async (input: string) => {
    const url = new URL(input);
    const title = url.searchParams.get('page')!;
    asked.push(title);
    assert.equal(url.searchParams.get('redirects'), '1');
    const answer = answers[title] ?? { error: { code: 'missingtitle' } };
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  const run = () => {
    asked.length = 0;
    reports.length = 0;
    return syncEventStores(root, { fetcher, now: NOW, pause: async () => {}, report: (name: string, detail: { page: string; problem: string; kept: boolean }) => reports.push([name, detail]) });
  };
  return { root, asked, reports, run, answers, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('a past event\'s page is read once and kept; a running one\'s is read every night; a page the wiki lacks is remembered', async () => {
  const w = world({
    'Past Story': page('Past Story', storeText('Past Token')),
    'Running Story': page('Running Story', storeText('Running Token')),
    'Running Story/Rerun': page('Running Story/Rerun', storeText('Rerun Token')),
  });
  try {
    const first = await w.run();
    assert.deepEqual(w.asked.sort(), ['Pageless Past', 'Past Story', 'Running Story', 'Running Story/Rerun']);
    assert.deepEqual(Object.keys(first.stores).sort(), ['[Rerun] Running Story Rerun', '[Side Story] Past Story', '[Side Story] Running Story']);
    // A past event with no page is cached as missing, and not reported: no reader is looking for it.
    assert.deepEqual(JSON.parse(fs.readFileSync(storeCacheFile(w.root, 'Pageless Past'), 'utf8')), { page: 'Pageless Past', missing: true, stores: [] });
    assert.deepEqual(w.reports, []);
    await w.run();
    // Only the running event and its rerun are asked again.
    assert.deepEqual(w.asked.sort(), ['Running Story', 'Running Story/Rerun']);
  } finally { w.done(); }
});

test('a page that cannot be used keeps the last parse with a store, and the stage is told why', async () => {
  const w = world({
    'Past Story': page('Past Story', storeText('Past Token')),
    'Running Story': page('Running Story', storeText('Running Token')),
    'Running Story/Rerun': page('Running Story/Rerun', storeText('Rerun Token')),
  });
  try {
    await w.run();
    const before = fs.readFileSync(storeCacheFile(w.root, 'Running Story'), 'utf8');
    const kept = async (answer: Answer, problem: RegExp) => {
      w.answers['Running Story'] = answer;
      const { stores } = await w.run();
      assert.equal(fs.readFileSync(storeCacheFile(w.root, 'Running Story'), 'utf8'), before, 'the last parse is not overwritten');
      assert.equal(stores['[Side Story] Running Story'].stores[0].items[0].name, 'Running Token');
      assert.deepEqual(w.reports.map(([name, detail]) => [name, detail.page, detail.kept]), [['[Side Story] Running Story', 'Running Story', true]]);
      assert.match(w.reports[0][1].problem, problem);
    };
    // A reformatted page that parses to no store: an empty parse never replaces a store.
    await kept(page('Running Story', 'The store moved into another template.'), /^no store parses from it, where its last parse had 1/);
    // The wiki down, or answering with an error that is not "no such page".
    await kept(new TypeError('fetch failed'), /^the wiki could not be reached$/);
    await kept({ error: { code: 'ratelimited', info: 'slow down' } }, /^the wiki could not be reached$/);
    // Still a redirect after redirects were followed.
    await kept(page('Running Story', '#REDIRECT [[Running Story (event)]]'), /still a redirect/);
    // Gone, where a store was parsed from it.
    await kept({ error: { code: 'missingtitle' } }, /no page by that name/);
  } finally { w.done(); }
});

test('a running event with no store page and nothing cached is reported as left out, the wiki base followed', async () => {
  const previous = process.env.ARKPEDIA_WIKI_BASE;
  process.env.ARKPEDIA_WIKI_BASE = 'http://wiki.test/';
  const w = world({ 'Past Story': page('Past Story', storeText('Past Token')) });
  const asked: string[] = [];
  try {
    const { stores } = await syncEventStores(w.root, { now: NOW, pause: async () => {},
      fetcher: async (input: string) => { asked.push(input); return new Response(JSON.stringify(input.includes('Past%20Story') ? page('Past Story', storeText('Past Token')) : { error: { code: 'missingtitle' } })); },
      report: (name: string, detail: { kept: boolean; problem: string }) => w.reports.push([name, detail as never]) });
    assert.ok(asked.every(url => url.startsWith('http://wiki.test/api.php?')), asked.join('\n'));
    assert.deepEqual(Object.keys(stores), ['[Side Story] Past Story']);
    assert.equal(stores['[Side Story] Past Story'].source, 'http://wiki.test/wiki/Past_Story');
    assert.deepEqual(w.reports.map(([name, detail]) => [name, detail.kept, detail.problem]).sort(), [
      ['[Rerun] Running Story Rerun', false, 'the wiki has no page by that name'],
      ['[Side Story] Running Story', false, 'the wiki has no page by that name'],
    ]);
  } finally {
    if (previous === undefined) delete process.env.ARKPEDIA_WIKI_BASE; else process.env.ARKPEDIA_WIKI_BASE = previous;
    w.done();
  }
});

test('an event in its last hours, before the reset on its last date, is running: a missing page is reported', async () => {
  // 02:00 UTC-7 on 2026-10-05, two hours before the event closes. Its window once ended when the
  // day started, so the stage read it as over and said nothing.
  const w = world({}, [{ name: '[Side Story] Closing Story', global: { dateRange: '2026/09/21–2026/10/05' } }]);
  try {
    await syncEventStores(w.root, { now: Date.parse('2026-10-05T09:00:00Z'), pause: async () => {},
      fetcher: async () => new Response(JSON.stringify({ error: { code: 'missingtitle' } })),
      report: (name: string, detail: { kept: boolean; problem: string }) => w.reports.push([name, detail as never]) });
    assert.deepEqual(w.reports.map(([name, detail]) => [name, detail.problem]), [['[Side Story] Closing Story', 'the wiki has no page by that name']]);
  } finally { w.done(); }
});

test('a cache file under the old naming is taken over, not fetched again or left behind', async () => {
  // The rerun is past here, so its cached parse stands without a fetch.
  const w = world({}, events.map(event => (event.name === '[Rerun] Running Story Rerun' ? { ...event, global: { dateRange: '2025/03/01–2025/03/15' } } : event)));
  try {
    const legacy = path.join(w.root, CACHE, 'Running Story_Rerun.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ page: 'Running Story/Rerun', source: 'x', stores: [{ name: 'Store', currency: 'Token', items: [] }] }));
    const { stores } = await w.run();
    assert.ok(!w.asked.includes('Running Story/Rerun'));
    assert.ok(stores['[Rerun] Running Story Rerun']);
    assert.ok(!fs.existsSync(legacy));
    assert.ok(fs.existsSync(storeCacheFile(w.root, 'Running Story/Rerun')));
  } finally { w.done(); }
});
