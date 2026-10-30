import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWikiRows, lineupNameLookup } from '../sync/catalogue-model.mjs';
import { kernelLocatingNotices, reconcileKernelLocating } from '../sync/kernel-locating.mjs';

// Kernel Locating #13 (Global) was announced on 2026-10-09 (news 4814, section 15) and no stage
// added it: the bulk import brought #1-#12 and nothing read this kind after it.
const post = {
  id: 4814, publishTime: 1791518280809, url: 'https://www.arknights.global/news/4814',
  lines: [
    '14 STARTER SPECIAL HEADHUNTING PACK',
    'DURATION: October 14, 2026, 08:00 - October 28, 2026, 03:59 (UTC-7)',
    '15 KERNEL LOCATING OPEN',
    'DURATION: October 20, 2026, 04:00 - November 3, 2026, 03:59 (UTC-7)',
    'DETAILS: During the Kernel Locating, you can pick and lock-in two 6-star Operators and three 5-star Operators as the rated-up Operators for the current banner.',
    'All possible Operators:',
    '★★★★★★ (2%): Six A / Six B / Six C',
    '★★★★★ (8%): Five A / Five B / Five C / Five D',
    'Note: The odds of getting a 6-star Operator due to accumulated rolls in the [Kernel Headhunting] before the shift WILL carry to the [Kernel Locating] banner.',
    '16 SPECIALIZED MODULES UPDATE',
  ],
};
const roster = new Map([['Six A', 6], ['Six B', 6], ['Six C', 6], ['Five A', 5], ['Five B', 5], ['Five C', 5], ['Five D', 5]]);
const recordName = lineupNameLookup([...roster.keys()].map(name => [name, name]));
const characters = { six_a: { name: 'Six A' }, six_b: { name: 'Six B' }, six_c: { name: 'Six C' },
  five_a: { name: 'Five A' }, five_b: { name: 'Five B' }, five_c: { name: 'Five C' }, five_d: { name: 'Five D' } };
const CLIENT = 'https://raw.githubusercontent.com/ArknightsAssets/ArknightsGamedata/0123456789abcdef0123456789abcdef01234567/en/gamedata/excel/gacha_table.json';
const history = () => [{ name: 'Kernel Locating #12 (Global)', category: 'kernel', global_date: '2026/07/28–2026/08/11', pull_type: 'kernel',
  six_stars: ['Old Six'], five_stars: ['Old Five'], globalPoolId: 'FESCLASSIC_EN_40_0_3' }];
const now = Date.parse('2026-10-14T12:00:00Z');
const run = (options = {}) => {
  const banners = options.banners ?? history();
  const result = reconcileKernelLocating({ banners, gachaTable: { gachaPoolClient: options.pools ?? [] }, characters,
    notices: options.notices ?? kernelLocatingNotices([post]), wikiRows: options.wikiRows ?? [], roster, recordName, clientSource: options.clientSource ?? CLIENT, now: options.now ?? now });
  return { banners, ...result };
};

test('reads a Kernel Locating section of an official post: window and every operator', () => {
  assert.deepEqual(kernelLocatingNotices([post]), [{ start: '2026-10-20T11:00:00.000Z', end: '2026-11-03T10:59:00.000Z',
    six: ['Six A', 'Six B', 'Six C'], five: ['Five A', 'Five B', 'Five C', 'Five D'], source: post.url }]);
  assert.deepEqual(kernelLocatingNotices([{ ...post, lines: post.lines.filter(line => !line.startsWith('15 ')) }]), []);
});

test('an announced Kernel Locating is published from the post, numbered after the last one', () => {
  const { banners, additions, quarantine } = run();
  assert.deepEqual(additions, ['Kernel Locating #13 (Global)']);
  assert.deepEqual(quarantine, []);
  const banner = banners.at(-1);
  assert.equal(banner.global_date, '2026/10/20–2026/11/03');
  assert.equal(banner.pull_type, 'kernel');
  assert.equal(banner.lineupSource, 'announcement');
  assert.deepEqual(banner.six_stars, ['Six A', 'Six B', 'Six C']);
  assert.deepEqual(banner.five_stars, ['Five A', 'Five B', 'Five C', 'Five D']);
  assert.equal(banner.global_window.timingSource, post.url);
  assert.equal(banner.banner_image, '/headhunting-banner-images/Kernel Locating 13 (Global).webp');
  // The bulk import's history is left exactly as it was.
  assert.deepEqual(banners[0], history()[0]);
});

test('the next run finds the same banner again and changes nothing', () => {
  const first = run();
  const again = run({ banners: first.banners });
  assert.deepEqual(again.additions, []);
  assert.equal(again.changed, false);
  assert.equal(first.banners.length, 2);
});

test('the wiki row gives the number; the client then takes over timing, pool and lineup', () => {
  const wikiRows = parseWikiRows(`{{Banners cell
|type = kernel locating
|no = 14
|start = 2026/10/20 04:00:00
|end = 2026/11/03 03:59:59
|operators1 = Six A, Six B, Six C
|operators2 = Five A, Five B, Five C, Five D}}`, 'Banners cell');
  const announced = run({ wikiRows });
  assert.deepEqual(announced.additions, ['Kernel Locating #14 (Global)']);
  const pool = { gachaPoolId: 'FESCLASSIC_EN_41_0_1', gachaRuleType: 'FESCLASSIC', openTime: 1792494000, endTime: 1793703599,
    dynMeta: { rarityPickCharDict: { TIER_6: ['six_a', 'six_b'], TIER_5: ['five_a', 'five_b', 'five_c'] } } };
  const shipped = run({ banners: announced.banners, pools: [pool], wikiRows });
  assert.deepEqual(shipped.additions, []);
  const banner = shipped.banners.at(-1);
  assert.equal(banner.globalPoolId, 'FESCLASSIC_EN_41_0_1');
  assert.equal(banner.global_window.timingSource, CLIENT);
  assert.equal(banner.global_window.endAt, '2026-11-03T11:00:00.000Z');
  assert.equal(banner.lineupSource, 'client');
  assert.deepEqual(banner.six_stars, ['Six A', 'Six B']);
  // A later run pinning another commit is the same client: no rewrite, no new release.
  const later = run({ banners: shipped.banners, pools: [pool], wikiRows, clientSource: CLIENT.replace('0123456789abcdef', 'fedcba9876543210') });
  assert.equal(later.changed, false);
});

test('a client window a day off the announced one takes over the announced banner, not a second one', () => {
  const announced = run();
  const pool = { gachaPoolId: 'FESCLASSIC_EN_41_0_2', gachaRuleType: 'FESCLASSIC', openTime: 1792580400, endTime: 1793789999,
    dynMeta: { rarityPickCharDict: { TIER_6: ['six_a', 'six_b'], TIER_5: ['five_a', 'five_b', 'five_c'] } } };
  const shipped = run({ banners: announced.banners, pools: [pool] });
  assert.deepEqual(shipped.additions, []);
  assert.equal(shipped.banners.length, 2);
  assert.equal(shipped.banners.at(-1).globalPoolId, 'FESCLASSIC_EN_41_0_2');
  assert.equal(shipped.banners.at(-1).global_date, '2026/10/21–2026/11/04');
});

test('a lineup naming an unknown operator is held, the banner still published', () => {
  const notices = kernelLocatingNotices([{ ...post, lines: post.lines.map(line => line.replace('Six C', 'Nobody')) }]);
  const { banners, quarantine } = run({ notices });
  assert.equal(banners.at(-1).lineupSource, 'pending');
  assert.deepEqual(banners.at(-1).six_stars, []);
  assert.equal(quarantine.length, 1);
  assert.match(quarantine[0].reason, /Nobody/);
});

test('a banner already over, or announced long ago, is not created', () => {
  assert.deepEqual(run({ now: Date.parse('2026-11-04T00:00:00Z') }).additions, []);
  const old = { gachaPoolId: 'FESCLASSIC_EN_30_0_2', gachaRuleType: 'FESCLASSIC', openTime: 1730800000, endTime: 1732000000 };
  assert.deepEqual(run({ pools: [old], notices: [] }).additions, []);
});

test('client refresh preserves a saved first-party window when the announcement cache is missing', () => {
  const first = run();
  const b = first.banners.at(-1);
  b.globalScheduleStatus = 'announced';
  b.global_window.endAt = '2026-11-03T11:00:00.000Z';
  const expected = structuredClone(b.global_window);
  const pool = { gachaPoolId: 'FESCLASSIC_EN_FIXTURE_13', gachaRuleType: 'FESCLASSIC', openTime: 1792494000, endTime: 1793703599 };
  const next = run({ banners: first.banners, pools: [pool], notices: [] });
  assert.deepEqual(next.banners.at(-1).global_window, expected);
  assert.equal(next.banners.at(-1).globalScheduleStatus, 'announced');
});
