import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Plain Node ingestion.
import { newsSections, parseDuration, parseNoticeWindow, parsePacks, postWindow } from '../build/official-news.mjs';
// @ts-expect-error Plain Node ingestion.
import { globalBannerNotices } from '../sync/global-client-banners.mjs';
// @ts-expect-error Plain Node ingestion.
import { kernelLocatingNotices } from '../sync/kernel-locating.mjs';

const published = Date.parse('2026-11-03T03:00:00Z');
const line = 'DURATION: November 5, 08:00 - November 19, 03:59 (UTC-7)';
const expected = { startAt: '2026-11-05T15:00:00.000Z', endAt: '2026-11-19T11:00:00.000Z' };

test('official EN date variants share fixed-server timestamps and exclusive closes', () => {
  for (const value of [line, line.replace('November 5,', 'November 5, 2026,'), line.replace('November 19,', 'November 19, 2026,'), line.replaceAll(/(November \d+,)/g, '$1 2026,')]) assert.deepEqual(parseNoticeWindow(value, published), expected);
  assert.equal(parseDuration(line), null, 'an omitted year needs its post, never the current year');
  for (const [value, at] of [['December 28, 08:00 - January 11, 03:59 (UTC-7)', Date.parse('2026-12-20T10:00Z')], ['December 28, 08:00 - January 11, 2027, 03:59 (UTC-7)', undefined]]) assert.deepEqual(parseNoticeWindow(value, at), {
    startAt: '2026-12-28T15:00:00.000Z', endAt: '2027-01-11T11:00:00.000Z',
  });
  assert.equal(parseDuration('January 5, 08:00 (UTC-7)', Date.parse('2026-12-30T10:00Z')).start, '2027-01-05T15:00:00.000Z');
  assert.equal(parseDuration('December 28, 08:00 (UTC-7)', Date.parse('2027-01-02T10:00Z')).start, '2026-12-28T15:00:00.000Z');
  for (const bad of ['February 30, 2026, 08:00 - March 2, 2026, 03:59', 'November 5, 2026, 24:00', 'November 5, 2026, 08:60', 'November 5, 2026, 08:00 (UTC+8)', 'November 5, 2026, 08:00 - November 4, 2026, 03:59']) assert.equal(parseDuration(bad), null, bad);
});

test('banner, Kernel, pack and event readers receive the same notice context', () => {
  const post = { title: 'TEST', url: 'https://www.arknights.global/news/5045', publishTime: published, lines: [
    '01 STANDARD HEADHUNTING OPEN – TEST', line,
    '02 KERNEL LOCATING OPEN', line, '★★★★★★ (2%): A / B', '★★★★★ (8%): C / D',
    '03 LIMITED-TIME PACKS AVAILABLE', line, 'Test Pack', 'CONTENTS: Originite Prime * 18',
  ] };
  const banners = globalBannerNotices([post]);
  assert.equal(banners.length, 2);
  for (const row of banners) { assert.equal(row.startAt, expected.startAt); assert.equal(row.endAt, expected.endAt); }
  const [kernel] = kernelLocatingNotices([post]);
  assert.equal(kernel.start, expected.startAt);
  assert.equal(kernel.end, expected.endAt);
  const [pack] = parsePacks(newsSections(post.lines)[2], post.publishTime);
  assert.equal(pack.start, expected.startAt);
  assert.equal(pack.end, expected.endAt);
  assert.equal(postWindow(post.lines, post.publishTime).start, expected.startAt);
});
