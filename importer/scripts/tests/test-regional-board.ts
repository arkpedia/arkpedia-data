import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// @ts-expect-error Node scripts are plain JavaScript.
import { assertEventRewards, regionalBoardGroups } from '../build/build-event-rewards.mjs';
import { eventExtras, type TableRewardGroup } from '../../lib/events/tableRewards';

/*
 * JP's and KR's in-game boards built into each event's News groups, on a slice of the real
 * boards and schedules of 2026-10-19 (fixtures/regional-board.json). The application holds
 * what the boards themselves are read into (arkpedia-app scripts/tests/test-regional-board.ts).
 */
const fixture = JSON.parse(fs.readFileSync('scripts/tests/fixtures/regional-board.json', 'utf8'));
const CPT = '[Celebration] Critical Phase Transition';
const SWT = '[Celebration] Sealed With Time';
const DUEL = 'Duel Channel: Ivy Vine';
const events = [{ name: CPT }, { name: DUEL }, { name: '[Side Story] People, A People' }];
const banners = [
  { name: SWT, globalPoolId: 'LIMITED_EN_42_0_1', linked_event: CPT },
  { name: 'Standard Pool #177 (Global)', globalPoolId: 'DOUBLE_EN_41_0_9', linked_event: null },
  { name: 'Kernel #63 (Global)', globalPoolId: 'CLASSIC_DOUBLE_EN_41_0_4', linked_event: null },
];

test("each event's News gets JP's and KR's own items, tagged with the server and named in English", () => {
  const jp = regionalBoardGroups(events, banners, fixture.schedules.jp, fixture.boards.jp, 'jp');
  assert.deepEqual(jp[CPT].map((group: { subject: string; name: string; source: string }) => [group.subject, group.name, group.source]), [
    ['event', CPT, 'https://ark-jp-static-online.yo-star.com/announce/Android/announcement/1427.html'],
    ['banner', SWT, 'https://ark-jp-static-online.yo-star.com/announce/Android/announcement/1431.html'],
  ]);
  assert.ok(jp[CPT].every((group: { server: string; kind: string }) => group.server === 'jp' && group.kind === 'board'));
  const kr = regionalBoardGroups(events, banners, fixture.schedules.kr, fixture.boards.kr, 'kr');
  // Headlines are art only: the News tab is the board's.
  assert.ok(!kr[CPT].some((group: { id: string }) => group.id.startsWith('site:')));
  // Two KR items titled alike on one event pass the duplicate check: they are told apart by id.
  const twice = [...kr[CPT], { ...kr[CPT][0], id: '9999' }];
  assert.doesNotThrow(() => assertEventRewards({ [CPT]: { groups: twice } }));
  assert.throws(() => assertEventRewards({ [CPT]: { groups: [...kr[CPT], kr[CPT][0]] } }), /two "board@kr: 6889"/);
  // The page's shape: the English name, and the board's picture where it may be loaded.
  const extras = eventExtras(kr[CPT] as TableRewardGroup[], () => null).board;
  assert.deepEqual(extras.map(item => [item.server, item.name]), [['kr', CPT], ['kr', SWT]]);
  const huge = regionalBoardGroups([{ name: 'Std' }], [{ name: 'Standard Pool #177 (Global)', linked_event: 'Std' }], fixture.schedules.kr, fixture.boards.kr, 'kr');
  assert.match(huge.Std[0].image, /\?imageMogr2\/format\/webp$/, "an oversize picture is its host's smaller copy");
  const noCopy = { ...fixture.boards.kr, bulletins: fixture.boards.kr.bulletins.map((item: { image?: { small?: unknown } }) => (item.image?.small ? { ...item, image: { ...item.image, small: null } } : item)) };
  const left = regionalBoardGroups([{ name: 'Std' }], [{ name: 'Standard Pool #177 (Global)', linked_event: 'Std' }], fixture.schedules.kr, noCopy, 'kr');
  assert.equal(left.Std[0].image, undefined, 'an oversize picture with no smaller copy is left out');
  assert.equal(eventExtras(left.Std as TableRewardGroup[], () => null).board[0].image, null, 'and the notice still listed');
  assert.throws(() => regionalBoardGroups(events, banners, fixture.schedules.jp, fixture.boards.jp, 'en'), /not a regional board/);
  assert.deepEqual(regionalBoardGroups(events, banners, undefined, undefined, 'jp'), {});
});
