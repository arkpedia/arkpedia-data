import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRecurringWikiRows, reconcileRecurringBanners } from '../sync/sync-recurring-banners.mjs';

const wiki = `
{{Banners cell
|type = standard
|no = 175
|start = 2026/09/11 04:00:00
|end = 2026/09/25 03:59:59
|operators = Five A, Six A, Five B, Six B, Five C}}
{{Banners cell
|type = kernel
|no = 61
|start = 2026/09/08 04:00:00
|end = 2026/09/22 03:59:59
|operators = Six C, Five D, Five E, Six D, Five F}}
`;

const wikiRows = parseRecurringWikiRows(wiki);
const roster = new Map([
  ['Six A', 6], ['Six B', 6], ['Six C', 6], ['Six D', 6],
  ['Five A', 5], ['Five B', 5], ['Five C', 5], ['Five D', 5], ['Five E', 5], ['Five F', 5],
]);
const characters = {
  six_c: { name: 'Six C' }, six_d: { name: 'Six D' },
  five_d: { name: 'Five D' }, five_e: { name: 'Five E' }, five_f: { name: 'Five F' },
};
const gachaTable = { gachaPoolClient: [
  { gachaPoolId: 'standard', gachaRuleType: 'DOUBLE', openTime: 1789124400, endTime: 1790333999 },
  { gachaPoolId: 'kernel', gachaRuleType: 'CLASSIC_DOUBLE', openTime: 1788865200, endTime: 1790074799,
    dynMeta: { main6RarityCharId: 'six_c', sub6RarityCharId: 'six_d', rare5CharList: ['five_d', 'five_e', 'five_f'] } },
] };

test('parses recurring rows and requires matching shipped client windows', () => {
  const result = reconcileRecurringBanners({ banners: [], gachaTable, characters, wikiRows, roster });
  assert.deepEqual(result.additions, ['Standard Pool #175 (Global)', 'Kernel #61 (Global)']);
  // A pool with a wiki row has its lineup; no art is read for it.
  assert.deepEqual(result.wantsArt, []);
  assert.deepEqual(result.banners[0].six_stars, ['Six A', 'Six B']);
  assert.equal(result.banners[0].global_window.startAt, '2026-09-11T11:00:00.000Z');
  assert.equal(result.banners[1].global_window.endAt, '2026-09-22T11:00:00.000Z');
});

test('does not add wiki rows before the Global client ships their window', () => {
  const result = reconcileRecurringBanners({ banners: [], gachaTable: { gachaPoolClient: [] }, characters, wikiRows, roster });
  assert.deepEqual(result.additions, []);
});

test('a Kernel lineup the wiki contradicts is published from the client and reported', () => {
  const changed = structuredClone(gachaTable);
  changed.gachaPoolClient[1].dynMeta.rare5CharList[0] = 'five_a';
  const result = reconcileRecurringBanners({ banners: [], gachaTable: changed, characters: { ...characters, five_a: { name: 'Five A' } }, wikiRows, roster });
  const kernel = result.banners.find((banner) => banner.name === 'Kernel #61 (Global)');
  assert.deepEqual([kernel.six_stars, kernel.five_stars, kernel.lineupSource, kernel.globalPoolId], [['Six C', 'Six D'], ['Five A', 'Five E', 'Five F'], 'client', 'kernel']);
  assert.deepEqual(result.quarantine.map((entry) => [entry.key, entry.action]), [['banner:kernel', 'published-partial']]);
  assert.match(result.quarantine[0].reason, /disagree with the client's \(Six C, Six D, Five A, Five E, Five F\); the client's are published/);
});

// Two more pools each, a fortnight on, with no wiki row: the page is down or behind.
const later = structuredClone(gachaTable);
later.gachaPoolClient.push(
  { gachaPoolId: 'standard_2', gachaRuleType: 'DOUBLE', openTime: 1789124400 + 14 * 86400, endTime: 1790333999 + 14 * 86400 },
  { gachaPoolId: 'kernel_2', gachaRuleType: 'CLASSIC_DOUBLE', openTime: 1788865200 + 14 * 86400, endTime: 1790074799 + 14 * 86400,
    dynMeta: { main6RarityCharId: 'six_d', sub6RarityCharId: 'six_c', rare5CharList: ['five_f', 'five_e', 'five_d'] } },
);
const october = Date.parse('2026-10-01T00:00:00Z');

test('a pool the wiki has no row for is still added after the recorded one: Kernel from the client, Standard with its lineup pending', () => {
  const recorded = reconcileRecurringBanners({ banners: [], gachaTable, characters, wikiRows, roster }).banners;
  const result = reconcileRecurringBanners({ banners: recorded, gachaTable: later, characters, wikiRows, roster, now: october });
  assert.deepEqual(result.additions, ['Standard Pool #176 (Global)', 'Kernel #62 (Global)']);
  const [standard, kernel] = result.banners.slice(2);
  assert.deepEqual([standard.global_date, standard.six_stars, standard.lineupSource, standard.globalPoolId], ['2026/09/25–2026/10/09', [], 'pending', 'standard_2']);
  assert.deepEqual([kernel.six_stars, kernel.five_stars, kernel.lineupSource, kernel.globalPoolId], [['Six D', 'Six C'], ['Five F', 'Five E', 'Five D'], 'client', 'kernel_2']);
  assert.deepEqual(result.quarantine.map((entry) => [entry.key, entry.action]), [['banner:standard_2', 'published-partial']]);
  assert.match(result.quarantine[0].reason, /without its rate-up lineup, which only the wiki's yearly banner page or the banner's art in the client supplies/);
  // With no row, the Standard pool's art is asked for; the Kernel pool's lineup is the client's.
  assert.deepEqual(result.wantsArt, ['standard_2']);
  // The row arrives and fills the lineup in; nothing is added twice.
  const row = { type: 'standard', number: 176, start: '2026/09/25', end: '2026/10/09', operators: ['Six A', 'Five A', 'Six B', 'Five B', 'Five C'] };
  const filled = reconcileRecurringBanners({ banners: result.banners, gachaTable: later, characters, wikiRows: [...wikiRows, row], roster, now: october });
  assert.deepEqual(filled.additions, []);
  assert.equal(filled.changed, true);
  const standardAfter = filled.banners.find((banner) => banner.name === 'Standard Pool #176 (Global)');
  assert.deepEqual([standardAfter.six_stars, standardAfter.five_stars, standardAfter.lineupSource], [['Six A', 'Six B'], ['Five A', 'Five B', 'Five C'], 'wiki']);
  assert.deepEqual(filled.quarantine, []);
});

test('with no wiki row, an old pool or one with no recorded predecessor is not added, and an unusable row is reported', () => {
  // Nothing recorded to number after: the recent pools are reported, not guessed.
  const orphan = reconcileRecurringBanners({ banners: [], gachaTable: later, characters, wikiRows: [], roster, now: october });
  assert.deepEqual(orphan.additions, []);
  assert.deepEqual(orphan.quarantine.map((entry) => [entry.key, entry.action]).sort(), [['banner:kernel', 'omitted-new'], ['banner:kernel_2', 'omitted-new'], ['banner:standard', 'omitted-new'], ['banner:standard_2', 'omitted-new']]);
  // A year on, the same pools are history.
  assert.deepEqual(reconcileRecurringBanners({ banners: [], gachaTable: later, characters, wikiRows: [], roster, now: Date.parse('2027-09-01T00:00:00Z') }).quarantine, []);
  // A Standard row naming someone no record knows publishes the banner with its lineup pending.
  const typo = parseRecurringWikiRows(wiki.replace('Six B', 'Six Bee'));
  const result = reconcileRecurringBanners({ banners: [], gachaTable, characters, wikiRows: typo, roster });
  const standard = result.banners.find((banner) => banner.name === 'Standard Pool #175 (Global)');
  assert.deepEqual([standard.six_stars, standard.lineupSource], [[], 'pending']);
  assert.match(result.quarantine.find((entry) => entry.key === 'banner:standard').reason, /names Six Bee, which no 5- or 6-star operator record matches/);
});

// data/quarantine.json is a release input (export.mjs hashes data/), so a banner still
// pending the next day must be reported in the same words, or that day is a new release.
test('a banner still pending the next day is reported in the words of the day it was added', () => {
  const recorded = reconcileRecurringBanners({ banners: [], gachaTable, characters, wikiRows, roster }).banners;
  const nextDay = october + 86400000;
  // No row for the new Standard pool yet.
  const added = reconcileRecurringBanners({ banners: recorded, gachaTable: later, characters, wikiRows, roster, now: october });
  const again = reconcileRecurringBanners({ banners: added.banners, gachaTable: later, characters, wikiRows, roster, now: nextDay });
  assert.deepEqual([again.additions, again.changed], [[], false]);
  assert.deepEqual(again.quarantine, added.quarantine);
  // A row that names someone no record knows, on both days.
  const typo = parseRecurringWikiRows(wiki.replace('Six B', 'Six Bee'));
  const first = reconcileRecurringBanners({ banners: [], gachaTable, characters, wikiRows: typo, roster });
  const second = reconcileRecurringBanners({ banners: first.banners, gachaTable, characters, wikiRows: typo, roster, now: nextDay });
  assert.deepEqual(second.quarantine, first.quarantine);
});

// A Kernel lineup comes from the client, so a recorded Kernel banner is judged by the client
// every day, as on the day it was added: its report keeps its words, and it stays reported
// while the wiki still disagrees.
test('a Kernel banner is reported the next day in the words of the day it was added, and filled from the client once it can be', () => {
  const nextDay = Date.parse('2026-09-23T00:00:00Z');
  // (a) The client names an operator the catalogue has no record of yet.
  const newcomer = structuredClone(gachaTable);
  newcomer.gachaPoolClient[1].dynMeta.rare5CharList[0] = 'new_guy';
  const withNewcomer = { ...characters, new_guy: { name: 'NewGuy' } };
  const agreeing = wikiRows.map((row) => (row.type === 'kernel' ? { ...row, operators: ['Six C', 'NewGuy', 'Five E', 'Six D', 'Five F'] } : row));
  const first = reconcileRecurringBanners({ banners: [], gachaTable: newcomer, characters: withNewcomer, wikiRows: agreeing, roster });
  const kernelEntry = (result) => result.quarantine.filter((entry) => entry.key === 'banner:kernel');
  assert.match(kernelEntry(first)[0].reason, /^Kernel #61 \(Global\) is published without its rate-up lineup: the lineup names NewGuy, which no 5- or 6-star operator record matches\.$/);
  for (const rows of [agreeing, []]) {
    const second = reconcileRecurringBanners({ banners: first.banners, gachaTable: newcomer, characters: withNewcomer, wikiRows: rows, roster, now: nextDay });
    assert.deepEqual(kernelEntry(second), kernelEntry(first), rows.length ? 'with the wiki row' : 'without it');
  }
  // NewGuy's record arrives: the banner takes the client's lineup, not the wiki's, and clears.
  const filled = reconcileRecurringBanners({ banners: first.banners, gachaTable: newcomer, characters: withNewcomer,
    wikiRows: wikiRows.map((row) => (row.type === 'kernel' ? { ...row, operators: ['Six A', 'Six B', 'Five A', 'Five B', 'Five C'] } : row)),
    roster: new Map([...roster, ['NewGuy', 5]]), now: nextDay });
  const kernel = filled.banners.find((banner) => banner.globalPoolId === 'kernel');
  assert.deepEqual([kernel.six_stars, kernel.five_stars, kernel.lineupSource, filled.changed], [['Six C', 'Six D'], ['NewGuy', 'Five E', 'Five F'], 'client', true]);
  assert.match(kernelEntry(filled)[0].reason, /disagree with the client's/);
  // (b) The wiki row disagrees with the client: reported on the day after too, in the same words.
  const disagreeing = structuredClone(gachaTable);
  disagreeing.gachaPoolClient[1].dynMeta.rare5CharList[0] = 'five_a';
  const withFiveA = { ...characters, five_a: { name: 'Five A' } };
  const day1 = reconcileRecurringBanners({ banners: [], gachaTable: disagreeing, characters: withFiveA, wikiRows, roster });
  const day2 = reconcileRecurringBanners({ banners: day1.banners, gachaTable: disagreeing, characters: withFiveA, wikiRows, roster, now: nextDay });
  assert.equal(kernelEntry(day1).length, 1);
  assert.deepEqual(kernelEntry(day2), kernelEntry(day1));
  assert.equal(day2.changed, false);
  // Once the row agrees, the entry clears.
  assert.deepEqual(kernelEntry(reconcileRecurringBanners({ banners: day1.banners, gachaTable: disagreeing, characters: withFiveA,
    wikiRows: wikiRows.map((row) => (row.type === 'kernel' ? { ...row, operators: ['Six C', 'Five A', 'Five E', 'Six D', 'Five F'] } : row)), roster, now: nextDay })), []);
});

test('a wiki row naming its operators in another word order still gives the banner its lineup', () => {
  // The wiki writes Japanese collaboration names either way round (lineupNameLookup in
  // catalogue-model.mjs); the records keep one. Here the roster has the family name first.
  const named = new Map([...roster].map(([name, rarity]) => [name.split(' ').reverse().join(' '), rarity]));
  const result = reconcileRecurringBanners({ banners: [], gachaTable: { gachaPoolClient: [gachaTable.gachaPoolClient[0]] }, characters, wikiRows, roster: named });
  assert.deepEqual(result.quarantine, []);
  assert.deepEqual([result.banners[0].six_stars, result.banners[0].five_stars, result.banners[0].lineupSource], [['A Six', 'B Six'], ['A Five', 'B Five', 'C Five'], 'wiki']);
});


// A Standard pool's art (banner-art-lineup.mjs) ships with the client, about two weeks
// before the wiki's row. syncRecurringBanners reads what wantsArt asks for and reconciles
// again with it as artLineups; here the reads are given.
test('a Standard pool with no wiki row takes its lineup from its art, and a wiki row that disagrees later is reported, not applied', () => {
  const recorded = reconcileRecurringBanners({ banners: [], gachaTable, characters, wikiRows, roster }).banners;
  const artLineups = new Map([['standard_2', { sixStars: ['Six B', 'Six A'], fiveStars: ['Five C', 'Five A', 'Five B'] }]]);
  const result = reconcileRecurringBanners({ banners: recorded, gachaTable: later, characters, wikiRows, roster, artLineups, now: october });
  const standard = result.banners.find((banner) => banner.globalPoolId === 'standard_2');
  assert.deepEqual([standard.name, standard.six_stars, standard.five_stars, standard.lineupSource], ['Standard Pool #176 (Global)', ['Six B', 'Six A'], ['Five C', 'Five A', 'Five B'], 'client-art']);
  assert.deepEqual([result.quarantine, result.wantsArt], [[], []]);
  // The next day nothing is read again, and nothing changes.
  const nextDay = reconcileRecurringBanners({ banners: result.banners, gachaTable: later, characters, wikiRows, roster, now: october + 86400000 });
  assert.deepEqual([nextDay.changed, nextDay.wantsArt, nextDay.quarantine], [false, [], []]);
  // The wiki's row arrives agreeing, in its own order: still nothing to report.
  const row = (operators) => ({ type: 'standard', number: 176, start: '2026/09/25', end: '2026/10/09', operators });
  const agreeing = reconcileRecurringBanners({ banners: result.banners, gachaTable: later, characters, wikiRows: [...wikiRows, row(['Six A', 'Five A', 'Six B', 'Five B', 'Five C'])], roster, now: october });
  assert.deepEqual([agreeing.changed, agreeing.quarantine], [false, []]);
  // Or disagreeing: the art's lineup stays published, and the row is reported every day it disagrees.
  const disagreeing = reconcileRecurringBanners({ banners: result.banners, gachaTable: later, characters, wikiRows: [...wikiRows, row(['Six A', 'Five A', 'Six B', 'Five B', 'Five D'])], roster, now: october });
  assert.equal(disagreeing.changed, false);
  assert.deepEqual(disagreeing.banners.find((banner) => banner.globalPoolId === 'standard_2').five_stars, ['Five C', 'Five A', 'Five B']);
  assert.deepEqual(disagreeing.quarantine.map((entry) => [entry.key, entry.action, entry.reason]), [['banner:standard_2', 'published-partial',
    "Standard Pool #176 (Global): the wiki's rate-ups (Six A, Five A, Six B, Five B, Five D) disagree with the banner art's (Six B, Six A, Five C, Five A, Five B); the art's are published."]]);
});

test('art not out yet leaves the lineup pending, and art that cannot be read is reported in the same words every day until it can', () => {
  const recorded = reconcileRecurringBanners({ banners: [], gachaTable, characters, wikiRows, roster }).banners;
  const notOut = reconcileRecurringBanners({ banners: recorded, gachaTable: later, characters, wikiRows, roster, artLineups: new Map([['standard_2', null]]), now: october });
  const pending = notOut.banners.find((banner) => banner.globalPoolId === 'standard_2');
  assert.deepEqual([pending.six_stars, pending.lineupSource, notOut.wantsArt], [[], 'pending', []]);
  assert.match(notOut.quarantine[0].reason, /which only the wiki's yearly banner page or the banner's art in the client supplies\.$/);
  const problem = 'the banner art\'s name 3 reads "Fiv A", closest to Five A (distance 0.20, margin 0.10), which is not clearly one 5-star operator';
  const unreadable = new Map([['standard_2', { problem }]]);
  const day1 = reconcileRecurringBanners({ banners: notOut.banners, gachaTable: later, characters, wikiRows, roster, artLineups: unreadable, now: october });
  const day2 = reconcileRecurringBanners({ banners: day1.banners, gachaTable: later, characters, wikiRows, roster, artLineups: unreadable, now: october + 86400000 });
  assert.deepEqual(day1.quarantine.map((entry) => [entry.key, entry.action, entry.reason]), [['banner:standard_2', 'published-partial', `Standard Pool #176 (Global) is published without its rate-up lineup: ${problem}.`]]);
  assert.deepEqual([day2.quarantine, day2.changed], [day1.quarantine, false]);
  // Art naming someone no record knows (a read is matched against the records, so only a
  // hand-made artLineups can) is reported as the art's problem.
  const stranger = reconcileRecurringBanners({ banners: notOut.banners, gachaTable: later, characters, wikiRows, roster,
    artLineups: new Map([['standard_2', { sixStars: ['Six A', 'Six Z'], fiveStars: ['Five A', 'Five B', 'Five C'] }]]), now: october });
  assert.match(stranger.quarantine[0].reason, /lineup: the banner art names Six Z, which no 5- or 6-star operator record matches\.$/);
  // Once it reads, the pending banner takes the lineup.
  const filled = reconcileRecurringBanners({ banners: day2.banners, gachaTable: later, characters, wikiRows, roster,
    artLineups: new Map([['standard_2', { sixStars: ['Six A', 'Six B'], fiveStars: ['Five A', 'Five B', 'Five C'] }]]), now: october + 2 * 86400000 });
  const standard = filled.banners.find((banner) => banner.globalPoolId === 'standard_2');
  assert.deepEqual([standard.six_stars, standard.five_stars, standard.lineupSource, filled.changed, filled.quarantine], [['Six A', 'Six B'], ['Five A', 'Five B', 'Five C'], 'client-art', true, []]);
});
