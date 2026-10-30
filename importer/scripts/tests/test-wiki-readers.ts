import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The recurring-banner sync reading its yearly wiki page, driven through its own fetch calls
// with the network replaced by fixed answers and the clock by a fixed date. It is imported
// inside each test, as an ES module, so each test's fetch mock is in place before any of its
// code runs. The shared structured-page reader itself, and the other scripts that read
// through it, are held by arkpedia-app's own scripts/tests/test-wiki-readers.ts.
// @ts-expect-error Plain Node import scripts, also run directly by the refresh job.
const recurringBannerSync = () => import('../sync/sync-recurring-banners.mjs');
// @ts-expect-error Plain Node helper shared by the importers.
const quarantine = () => import('../lib/quarantine.mjs');
// The fixed answers are for the wiki itself. A run that rehearses an outage points the
// readers elsewhere for the whole job, npm test included, and must not fail it here.
delete process.env.ARKPEDIA_WIKI_BASE;
const missing ={ error: { code: 'missingtitle', info: "The page you specified doesn't exist." } };
const doubleRedirect = { parse: { title: 'Headhunting/Banners/2027', wikitext: { '*': '#REDIRECT [[Headhunting/Banners/Former-2027]]' } } };

function answering(t: { mock: { method: Function } }, answer: (url: URL) => unknown) {
  const requested: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input);
    requested.push(url);
    return new Response(JSON.stringify(answer(url)), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return requested;
}
function temporary(run: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkpedia-wiki-'));
  return run(root).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}
const wikiRequests = (requested: URL[]) => requested.filter(url => url.hostname === 'arknights.wiki.gg');
const cacheOf = (root: string, page: string) => path.join(root, 'data/wiki-cache', `${page.replaceAll('/', '-')}.json`);
const entries = async (root: string) => (await quarantine()).readQuarantine(root).entries;

// A made-up roster and client table with one Standard banner the wiki page lists.
function bannerRepository(root: string) {
  const roster = [['Six A', 6], ['Six B', 6], ['Five A', 5], ['Five B', 5], ['Five C', 5]] as const;
  for (const [name, rarity] of roster) {
    fs.mkdirSync(path.join(root, `data/operators-${rarity}star`), { recursive: true });
    fs.writeFileSync(path.join(root, `data/operators-${rarity}star/${name}.json`), JSON.stringify({ name, rarity }));
  }
  fs.writeFileSync(path.join(root, 'data/headhunting_banners.json'), '[]\n');
  return {
    banners: () => JSON.parse(fs.readFileSync(path.join(root, 'data/headhunting_banners.json'), 'utf8')),
    answer(page: (title: string) => unknown) {
      return (url: URL) => {
        if (url.hostname === 'arknights.wiki.gg') return page(url.searchParams.get('page') ?? '');
        if (url.pathname.endsWith('/gacha_table.json')) {
          return { gachaPoolClient: [{ gachaPoolId: 'standard', gachaRuleType: 'DOUBLE', openTime: 1789124400, endTime: 1790333999 }] };
        }
        if (url.pathname.endsWith('/character_table.json')) return {};
        throw new Error(`Unexpected request: ${url}`);
      };
    },
  };
}
const standardRow = '{{Banners cell\n|type = standard\n|no = 175\n|start = 2026/09/11 04:00:00\n|end = 2026/09/25 03:59:59\n|operators = Five A, Six A, Five B, Six B, Five C}}';

test('sync-recurring-banners reads the page for its own year, following a move to the new title', async t => {
  const { syncRecurringBanners } = await recurringBannerSync();
  await temporary(async root => {
    const repository = bannerRepository(root);
    const requested = answering(t, repository.answer(title => ({
      parse: { title: 'Headhunting/Banners/2026 (Global)', redirects: [{ from: title, to: 'Headhunting/Banners/2026 (Global)' }], wikitext: { '*': standardRow } },
    })));
    assert.deepEqual(await syncRecurringBanners(root, new Date('2026-09-15T12:00:00Z')), ['Standard Pool #175 (Global)']);
    assert.deepEqual(repository.banners().map((banner: { name: string }) => banner.name), ['Standard Pool #175 (Global)']);
    const [page] = wikiRequests(requested);
    assert.equal(page.searchParams.get('page'), 'Headhunting/Banners/2026');
    assert.equal(page.searchParams.get('redirects'), '1');
  });
});

test('sync-recurring-banners excuses a missing yearly page only in January; later, and for a page that still redirects, it reports and reads the last good copy', async t => {
  const { syncRecurringBanners } = await recurringBannerSync();
  await temporary(async root => {
    const repository = bannerRepository(root);
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (message: string) => { warnings.push(message); });
    answering(t, repository.answer(() => missing));
    assert.deepEqual(await syncRecurringBanners(root, new Date('2027-01-31T23:59:59Z')), []);
    assert.match(warnings.join('\n'), /Headhunting\/Banners\/2027 does not exist on the wiki yet/);
    assert.deepEqual(await entries(root), []);
    for (const late of ['2027-02-01T00:00:00Z', '2027-06-01T00:00:00Z']) {
      assert.deepEqual(await syncRecurringBanners(root, new Date(late)), [], late);
      assert.deepEqual((await entries(root)).map((e: { key: string; stage: string; action: string }) => [e.key, e.stage, e.action]),
        [['wiki:Headhunting/Banners/2027', 'recurring-banners', 'omitted-new']], late);
    }
    t.mock.restoreAll();
    // The last good read of the page still names the Standard banner the client shipped.
    fs.mkdirSync(path.join(root, 'data/wiki-cache'), { recursive: true });
    fs.writeFileSync(cacheOf(root, 'Headhunting/Banners/2026'), JSON.stringify({ page: 'Headhunting/Banners/2026', template: 'Banners cell',
      rows: [{ type: 'standard', no: '175', start: '2026/09/11 04:00:00', end: '2026/09/25 03:59:59', operators: 'Five A, Six A, Five B, Six B, Five C' }] }));
    t.mock.method(console, 'warn', () => {});
    answering(t, repository.answer(() => doubleRedirect));
    assert.deepEqual(await syncRecurringBanners(root, new Date('2026-09-15T12:00:00Z')), ['Standard Pool #175 (Global)']);
    assert.deepEqual(repository.banners().map((banner: { name: string }) => banner.name), ['Standard Pool #175 (Global)']);
    const reported = (await entries(root)).filter((e: { stage: string }) => e.stage === 'recurring-banners');
    assert.deepEqual(reported.map((e: { key: string; action: string }) => [e.key, e.action]), [['wiki:Headhunting/Banners/2026', 'kept-previous']]);
    assert.match(reported[0].reason, /still a redirect/);
  });
});
