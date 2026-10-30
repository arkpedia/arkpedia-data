import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Plain Node ingestion.
import { boardOpening, englishNoticeSkinWindows, eventActivity, noticeOpening, noticeSkinWindows, buildRegionalSchedule } from '../sync/sync-regional-schedules.mjs';

/*
 * What the regional ingestion reads out of each client's own notices and in-game board
 * (scripts/sync/sync-regional-schedules.mjs). The application reads the schedules this
 * writes and holds that side (arkpedia-app scripts/tests/test-regional-schedules.ts and
 * test-outfit-windows.ts).
 */
const time = { startAt: '2026-10-14T07:00:00.000Z', endAt: '2026-10-27T19:00:00.000Z', timingSource: 'https://www.arknights.jp/news/4805', status: 'announced' };

test('a named regional announcement corrects maintenance preloading without shifting a closing date', () => {
  const client = { ...time, startAt: '2026-10-14T02:00:00.000Z', localName: '約諾' };
  const notices = [{ title: '約諾', publishTime: Date.parse('2026-10-09T00:00Z'), url: time.timingSource, lines: ['2026年10月14日（水）16:00 ~ 2026年10月28日（水）3:59'] }];
  assert.equal(noticeOpening(client, notices, 'jp').startAt, time.startAt);
  assert.equal(noticeOpening(client, notices, 'jp').endAt, time.endAt);
  assert.equal(noticeOpening(client, [{ ...notices[0], title: '別のイベント', lines: ['2026年10月14日（水）16:00'] }], 'jp').startAt, client.startAt);
  assert.equal(noticeOpening(client, [{ ...notices[0], lines: [...notices[0].lines, '2026年10月14日（水）17:00'] }], 'jp').startAt, client.startAt);
  const korean = { ...client, localName: '서약' };
  assert.equal(noticeOpening(korean, [{ ...notices[0], title: '한정 헤드헌팅 서약', lines: ['10월 14일(수) 16:00 부터 개방'] }], 'kr').startAt, time.startAt);
});

test('the in-game board confirms a JP/KR banner by pool id on its opening day, and never moves a date', () => {
  // DOUBLE_JP_41_0_9 opens 2026-10-08T19:00Z, 04:00 on the 9th in Japan and Korea.
  const client = { startAt: '2026-10-08T19:00:00.000Z', endAt: '2026-10-22T19:00:00.000Z', timingSource: 'gacha_table.json', poolId: 'DOUBLE_JP_41_0_9', localName: '常設', status: 'datamined' };
  const item = { id: '2095', kind: 'banner', title: '常設スカウト 10.9更新', displayDate: '2026-10-09', poolId: 'DOUBLE_JP_41_0_9', firstSeen: '2026-10-18' };
  const page = { id: '1426', group: 'ACTIVITY', title: '常設スカウト 10.9更新', date: '2026-10-09', url: 'https://ark-jp-static-online.yo-star.com/announce/Android/announcement/1426.html', firstSeen: '2026-10-18' };
  const confirmed = boardOpening(client, { bulletins: [item], notices: [page] }, 'jp');
  assert.deepEqual(confirmed, { ...client, status: 'announced', timingSource: page.url });
  assert.equal(boardOpening(client, { bulletins: [item], notices: [] }, 'jp').timingSource, 'ingame-board:jp/2095', 'the board item when no page matches');
  assert.equal(boardOpening(client, { bulletins: [{ ...item, displayDate: '2026-10-10' }] }, 'jp'), client, 'a board date on another day is left for review');
  assert.equal(boardOpening(client, { bulletins: [item, { ...item, id: '9', displayDate: '2026-10-08' }] }, 'jp'), client, 'two board dates are ambiguous');
  assert.equal(boardOpening(client, { bulletins: [{ ...item, poolId: 'DOUBLE_JP_41_0_8' }] }, 'jp'), client, 'another pool');
  assert.equal(boardOpening(client, { bulletins: [{ ...item, kind: 'event' }] }, 'jp'), client, 'only banner items');
  assert.equal(boardOpening(client, null, 'jp'), client);
  const announced = { ...client, startAt: '2026-10-09T07:00:00.000Z', timingSource: 'https://www.arknights.jp/news/1', status: 'announced' };
  assert.equal(boardOpening(announced, { bulletins: [item] }, 'jp'), announced, "a notice's exact time stands");
  const korean = { ...client, poolId: 'DOUBLE_KR_41_0_9' };
  assert.equal(boardOpening(korean, { bulletins: [{ ...item, poolId: 'DOUBLE_KR_41_0_9' }] }, 'kr').status, 'announced');
  for (const result of [confirmed, boardOpening(korean, { bulletins: [{ ...item, poolId: 'DOUBLE_KR_41_0_9' }] }, 'kr')]) {
    assert.equal(result.startAt, client.startAt);
    assert.equal(result.endAt, client.endAt);
  }
});

test('shop extraction uses the sale paragraph and OP inventory, not an earlier login or stage deadline', () => {
  const skins = [{ skinId: 'paid', model: 'A', name: 'Sale', howToObtain: 'Outfit Store ( 24 Originite Prime )' }, { skinId: 'free', model: 'B', name: 'Login', howToObtain: 'Login Event' }];
  const tables = { skin: { charSkins: { paid: { isBuySkin: true, displaySkin: { skinName: '販売服', getTime: Date.parse(time.startAt) / 1000 } }, free: { isBuySkin: true, displaySkin: { skinName: '無料服' } } } } };
  const notices = [{ title: 'Notice', url: time.timingSource, publishTime: Date.parse('2026-10-09T00:00Z'), lines: ['ログイン報酬「無料服」', '2026年10月14日（水）16:00 ~ 2026年10月28日（水）3:59', '「販売服」 A専用コーデ', '▼販売期間', '2026年10月14日（水）16:00 ~ 2026年11月11日（水）3:59'] }];
  const [shop] = noticeSkinWindows(notices, tables, skins, 'jp');
  assert.deepEqual(shop.skinIds, ['A / Sale']);
  assert.equal(shop.endAt, '2026-11-10T19:00:00.000Z');
});

test("a rerun never takes its original's run of the shared activity, which the client table still holds", () => {
  // act42side as the client has it: the 2025 run, which "[Rerun] ... Rerun" folds onto by name.
  const english = { act42side: { name: "The Masses' Travels", endTime: Date.parse('2025-11-04T10:59:59Z') / 1000 } };
  const original = { name: "[Side Story – Celebration] The Masses' Travels", global: { dateRange: '2025/10/14–2025/11/04', note: null } };
  const rerun = { name: "[Rerun] The Masses' Travels Rerun", activityId: 'act42sre', global: { dateRange: '2026/11/05–2026/11/15', note: 'ESTIMATED Global date, not officially confirmed' } };
  assert.equal(eventActivity(original, english), 'act42side');
  assert.equal(eventActivity(rerun, english), null, 'a year before its own Global close');
  assert.equal(eventActivity({ ...rerun, global: { dateRange: null, note: null } }, english), null, 'a rerun without a Global date');
  assert.equal(eventActivity({ ...rerun, global: { dateRange: '2025/10/14–2025/11/04', note: null } }, english), 'act42side', 'the run it has');
});

test('ingestion rejects truncated regional inputs instead of manufacturing schedules', () => {
  assert.throws(() => buildRegionalSchedule({ server: 'jp', tables: {}, english: {}, events: [], banners: [], skins: [], stages: [], contents: {}, base: 'https://example.test' }), /Incomplete jp/);
});

test('English official openings also outrank maintenance preloading at the same close', () => {
  const client = { ...time, startAt: '2026-10-14T12:00:00.000Z', endAt: '2026-10-28T11:00:00.000Z', localName: 'Critical Phase Transition' };
  const notices = [{ title: 'Main Theme Episode 17: Critical Phase Transition', publishTime: Date.parse('2026-10-09T00:00Z'), url: 'https://www.arknights.global/news/4814', lines: ['OPEN TIME: October 14, 2026, 08:00 (UTC-7)'] }];
  assert.equal(noticeOpening(client, notices, 'en').startAt, '2026-10-14T15:00:00.000Z');
  assert.equal(noticeOpening(client, notices, 'en').endAt, client.endAt);
});

test("Global's official post lists its Outfit Store sales, read as windows by outfit", () => {
  // News post 4814 (Critical Phase Transition, 2026-10-14), shortened to two outfits a section.
  const post = { title: 'MAIN THEME EPISODE 17: CRITICAL PHASE TRANSITION', url: 'https://www.arknights.global/news/4814', lines: [
    '10 ITERATION PROVIDENT SERIES & BLOODLINE OF COMBAT COLLECTION NEW ARRIVALS AT THE OUTFIT STORE',
    'DURATION: October 14, 2026, 08:00 - November 11, 2026, 03:59 (UTC-7)',
    'DETAILS: The following new Outfits will be available at the Outfit Store, including:',
    'Iteration Provident Series - The Spirit Farer for Nowell',
    'Iteration Provident Series - Stranded in Utopia for Haruka',
    '11 RE-EDITION OUTFITS AT THE OUTFIT STORE',
    'DURATION: October 14, 2026, 08:00 - November 11, 2026, 03:59 (UTC-7)',
    'DETAILS: The following Re-edition Outfits will be available at the Outfit Store, including:',
    'Test Collection - Glory of the Devout for Archetto',
    'Test Collection - Unknown Outfit for Nobody',
    '12 LIMITED-TIME PACKS AVAILABLE',
    'Iteration Provident Series - Red Countess for Skadi the Corrupting Heart',
  ] };
  const store = 'Outfit Store ( 18 Originite Prime )';
  const skins = [
    { model: 'Nowell', name: 'The Spirit-Farer', series: 'Iteration Provident', howToObtain: store },
    { model: 'Haruka', name: 'Stranded In Utopia', series: 'Iteration Provident', howToObtain: store },
    { model: 'Archetto', name: 'Glory to the Devout', series: 'Test Collection', howToObtain: store },
    { model: 'Archetto', name: 'Publicity Strategy', series: 'Shining Steps', howToObtain: store },
    { model: 'Skadi the Corrupting Heart', name: 'Red Countess', series: 'Iteration Provident', howToObtain: store },
  ];
  const windows = englishNoticeSkinWindows([post], skins);
  assert.deepEqual(windows.map((w: { label: string; newRelease: boolean; startAt: string; endAt: string; skinIds: string[] }) => [w.label, w.newRelease, w.startAt, w.endAt, w.skinIds]), [
    ['New outfits', true, '2026-10-14T15:00:00.000Z', '2026-11-11T11:00:00.000Z', ['Haruka / Stranded In Utopia', 'Nowell / The Spirit-Farer']],
    ['Returning outfits', false, '2026-10-14T15:00:00.000Z', '2026-11-11T11:00:00.000Z', ['Archetto / Glory to the Devout']],
  ], 'a reworded name matches by operator and series; an unknown outfit and a later section\'s line are left out');
});
