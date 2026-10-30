import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// @ts-expect-error Node scripts are plain JavaScript.
import { assertEventRewards, boardGroups, buildEventRewards } from '../build/build-event-rewards.mjs';
import { eventExtras, type TableRewardGroup } from '../../lib/events/tableRewards';

/*
 * The event page's News tab: the sections of an event's official announcement that no other part of
 * the page shows (2026-10-14: "a News section or QOL section, with all the other changes"). The
 * fixture is the real Critical Phase Transition post (arknights.global/news/4814), as the sync caches it.
 * The application holds what its pages make of these groups (arkpedia-app scripts/tests/test-event-news.ts).
 */
const post = JSON.parse(fs.readFileSync('scripts/tests/fixtures/official-news/4814.json', 'utf8'));
const cpt = { name: '[Celebration] Critical Phase Transition', global: { dateRange: '2026/10/14–2026/10/28' } };
const empty = { activity: { basicInfo: {}, activity: {}, missionData: [] }, stages: { stages: {} }, items: { items: {} }, building: { customData: { furnitures: {}, themes: {} } }, characters: {}, skins: { charSkins: {} } };
const groupsOf = (events: unknown[], posts: unknown[]) => buildEventRewards(events, empty, posts, null);

test('an announcement\'s other changes are the event\'s news, in the post\'s order and words', () => {
  const groups = groupsOf([cpt], [post])[cpt.name].groups as TableRewardGroup[];
  const news = groups.filter(g => g.kind === 'news');
  assert.deepEqual(news.map(g => g.title), [
    'NOTICE BOARD IN ZELGRAD OPEN',
    'NEW OPERATORS NOW AVAILABLE',
    'SANITY LIMIT INCREASE',
    'CUMULATIVE SIGN-IN SYSTEM UPDATE',
    'NEW REDEEMABLES AVAILABLE IN [PURCHASE CERTIFICATES STORE]',
    'KERNEL LOCATING OPEN',
    'SPECIALIZED MODULES UPDATE',
    'RECRUIT OPERATORS UPDATE',
    'NEW REDEEMABLE AVAILABLE IN [DISTINCTIONS] AND [UNIVERSAL CERTIFICATES EXCHANGE AREA]',
    'THEMED BACKGROUND RERUN',
  ]);
  const sanity = news.find(g => g.title === 'SANITY LIMIT INCREASE')!;
  assert.equal(sanity.source, 'https://www.arknights.global/news/4814');
  assert.equal(sanity.published, new Date(post.publishTime).toISOString());
  assert.equal(sanity.lines![0], 'UPDATE TIME: October 14, 2026, 08:00 (UTC-7)');
  assert.match(sanity.lines!.join(' '), /30-point increase to max Sanity/);
  // The build's own output guard (no heading twice, no entity left) takes it.
  assert.doesNotThrow(() => assertEventRewards(groupsOf([cpt], [post])));
  const kernel = news.find(g => g.title === 'KERNEL LOCATING OPEN')!;
  assert.match(kernel.lines!.join(' '), /Goldenglow \/ Dorothy/, 'a list keeps its operators');
});

test('what the page shows elsewhere is not news again', () => {
  const titles = (groupsOf([cpt], [post])[cpt.name].groups as TableRewardGroup[]).filter(g => g.kind === 'news').map(g => g.title).join('\n');
  // The event itself (its page), the limited banner (Banner), its free rolls and sign-in (Rewards),
  // outfits and the Fashion Review (Skins), furniture and packs (their tabs).
  for (const shown of [/CRITICAL PHASE TRANSITION/, /HEADHUNTING OPEN/, /DAILY FREE ROLL/, /SIGN-IN EVENT/, /OUTFIT/, /FASHION REVIEW/, /FURNITURE/, /PACKS/]) {
    assert.doesNotMatch(titles, shown);
  }
});

test('news reaches the page\'s extras; an event without an announcement has none', () => {
  const groups = groupsOf([cpt], [post])[cpt.name].groups as TableRewardGroup[];
  const extras = eventExtras(groups, () => null);
  assert.equal(extras.news.length, 10);
  assert.equal(extras.news[0].published, new Date(post.publishTime).toISOString());
  const other = { name: '[Side Story] Elsewhere', global: { dateRange: '2026/10/14–2026/10/28' } };
  const result = groupsOf([cpt, other], [post]);
  assert.equal(result[other.name], undefined, 'a same-day event the post does not name gets nothing');
});

test('the checked-in news fixture is what the build makes of the post', () => {
  // The application keeps a copy of this file for its browser test, which cannot load the build
  // script; regenerate both from here when the build changes.
  const built = eventExtras(groupsOf([cpt], [post])[cpt.name].groups as TableRewardGroup[], () => null).news;
  assert.deepEqual(JSON.parse(fs.readFileSync('scripts/tests/fixtures/official-news/4814-news.json', 'utf8')), built,
    'regenerate scripts/tests/fixtures/official-news/4814-news.json from the build');
});

test("the post's pictures go with its news, where the post has them, and the one it opens with is the post's own", () => {
  // Where the real post's 37 pictures stand among its lines (newsArt over arknights.global/news/4814's
  // own HTML, which gives this fixture's lines exactly).
  const art = JSON.parse(fs.readFileSync('scripts/tests/fixtures/official-news/4814-art.json', 'utf8'));
  const groups = groupsOf([cpt], [{ ...post, art }])[cpt.name].groups as TableRewardGroup[];
  const news = groups.filter(g => g.kind === 'news');
  assert.ok(news.every(g => g.postArt === art[0].url), 'the key art above the first section');
  const sanity = news.find(g => g.title === 'SANITY LIMIT INCREASE')!;
  // On the site each section's title picture stands right above its heading.
  assert.deepEqual(sanity.art, [{ url: art.find((picture: { url: string }) => picture.url.endsWith('/wwSVXZ7p.jpg')).url, at: -1 }]);
  assert.ok(news.every(g => (g.art ?? []).every(picture => picture.at >= -1 && picture.at <= g.lines!.length)));
  // A picture inside a section stays between the lines it stood between.
  const zelgrad = news.find(g => g.title === 'NOTICE BOARD IN ZELGRAD OPEN')!;
  assert.ok((zelgrad.art ?? []).some(picture => picture.at === -1));
  const extras = eventExtras(groups, () => null);
  assert.equal(extras.news[0].postArt, art[0].url);
  assert.deepEqual(extras.news.find(section => section.title === 'SANITY LIMIT INCREASE')!.art, sanity.art);
  // A post cached before its pictures were kept: none, and nothing else changes.
  const plain = (groupsOf([cpt], [post])[cpt.name].groups as TableRewardGroup[]).filter(g => g.kind === 'news');
  assert.deepEqual(plain.map(g => g.lines), news.map(g => g.lines));
  assert.ok(plain.every(g => !g.art && !g.postArt));
});

test("the board's banner items are the news of the event their banner opens with, by pool id", () => {
  const image = { url: 'https://ark-us-static-online.yo-star.com/announce/images/20261009/8aebe82a214826a0ed47455f8b70a821.jpg', sha1: 'a'.repeat(40), bytes: 1 };
  const board = {
    bulletins: [
      { id: '8360', kind: 'banner', title: 'Sealed With Time', displayDate: '2026-10-14', poolId: 'LIMITED_EN_42_0_1', image, firstSeen: '2026-10-18' },
      { id: '4944', kind: 'banner', title: 'Displayed Operators Rate Up !!!', displayDate: '2026-10-09', poolId: 'DOUBLE_EN_41_0_9', image, firstSeen: '2026-10-18' },
      { id: '1', kind: 'banner', title: 'No art', displayDate: '2026-10-14', poolId: 'LIMITED_EN_42_0_1', firstSeen: '2026-10-18' },
    ],
    notices: [{ id: '1634', group: 'ACTIVITY', title: 'Sealed With Time', date: '2026-10-14', url: 'https://ark-us-static-online.yo-star.com/announce/Android/announcement/1634.html', firstSeen: '2026-10-18' }],
  };
  const banners = [
    { name: '[Celebration] Sealed With Time', globalPoolId: 'LIMITED_EN_42_0_1', linked_event: cpt.name },
    { name: 'Standard Pool #177 (Global)', globalPoolId: 'DOUBLE_EN_41_0_9', linked_event: null },
  ];
  const result = boardGroups([cpt], banners, board);
  assert.deepEqual(result, { [cpt.name]: [{ kind: 'board', title: 'Sealed With Time', source: board.notices[0].url, published: '2026-10-14', image: image.url, items: [] }] });
  assert.deepEqual(eventExtras(result[cpt.name] as TableRewardGroup[], () => null).board, [{ server: 'en', title: 'Sealed With Time', name: null, source: board.notices[0].url, shown: '2026-10-14', image: image.url }]);
  assert.deepEqual(boardGroups([cpt], banners, undefined), {});
  assert.doesNotThrow(() => assertEventRewards({ [cpt.name]: { groups: [...result[cpt.name], ...(groupsOf([cpt], [post])[cpt.name].groups as TableRewardGroup[])] } }));
});
